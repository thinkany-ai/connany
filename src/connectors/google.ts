import { z } from 'zod';

/**
 * Google Search Console and Google Analytics tools. Google offers no hosted MCP server for them,
 * so Connany calls the REST APIs itself with the user's OAuth token. Responses are reshaped into
 * compact rows keyed by dimension and metric names, which agents read far more easily.
 */
export interface GoogleOperation {
  connector: 'google_search_console' | 'google_analytics';
  description: string;
  read_only: boolean;
  required_permissions: string[];
  schema: z.ZodObject;
  request: (input: any) => { url: string; method?: string; body?: unknown };
  response?: (raw: any, input: any) => unknown;
}
const e = encodeURIComponent;
const query = (values: Record<string, unknown>) => new URLSearchParams(Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();

// Search Console: https://developers.google.com/webmaster-tools/v1/api_reference_index
const webmasters = 'https://www.googleapis.com/webmasters/v3';
const site = z.string().max(2048).regex(/^(sc-domain:[a-z0-9.-]+|https?:\/\/\S+)$/i, 'Use a URL-prefix property such as https://example.com/ or a domain property such as sc-domain:example.com.')
  .describe('Property exactly as list_sites returns it, e.g. https://example.com/ or sc-domain:example.com.');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const gscDimension = z.enum(['date', 'hour', 'query', 'page', 'country', 'device', 'searchAppearance']);
const gscFilter = z.object({
  dimension: z.enum(['query', 'page', 'country', 'device', 'searchAppearance']),
  operator: z.enum(['equals', 'notEquals', 'contains', 'notContains', 'includingRegex', 'excludingRegex']).default('equals'),
  expression: z.string().min(1).max(4096),
}).strict();
const gsc = (description: string, shape: z.ZodRawShape, request: GoogleOperation['request'], response?: GoogleOperation['response']): GoogleOperation =>
  ({ connector: 'google_search_console', description, read_only: true, required_permissions: ['Search Console: read'], schema: z.object(shape).strict(), request, response });

export const googleSearchConsoleTools = {
  'google_search_console.list_sites': gsc('List Search Console properties (sites) the user can access, with their permission level. Call this first to get the exact site_url for other tools.',
    {}, () => ({ url: `${webmasters}/sites` }), raw => ({ sites: (raw.siteEntry || []).map((s: any) => ({ site_url: s.siteUrl, permission_level: s.permissionLevel })) })),
  'google_search_console.query_search_analytics': gsc('Query Google Search performance (clicks, impressions, CTR, average position) for a property, grouped by dimensions such as query, page, country, device or date. Data is usually 2–3 days behind; dates are in Pacific time. Page through results with start_row.',
    {
      site_url: site, start_date: day, end_date: day,
      dimensions: z.array(gscDimension).max(7).default([]).describe('Group rows by these dimensions. Empty returns one total row. "hour" requires data_state hourly_all.'),
      search_type: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).default('web'),
      filters: z.array(gscFilter).max(20).default([]).describe('All filters must match (AND).'),
      aggregation_type: z.enum(['auto', 'byPage', 'byProperty']).default('auto'),
      data_state: z.enum(['final', 'all', 'hourly_all']).default('final').describe('"all" includes fresh, not yet finalized data.'),
      row_limit: z.number().int().min(1).max(1000).default(100), start_row: z.number().int().min(0).max(1000000).default(0),
    },
    i => ({ url: `${webmasters}/sites/${e(i.site_url)}/searchAnalytics/query`, method: 'POST', body: {
      startDate: i.start_date, endDate: i.end_date, dimensions: i.dimensions, type: i.search_type, aggregationType: i.aggregation_type, dataState: i.data_state,
      rowLimit: i.row_limit, startRow: i.start_row, ...(i.filters.length ? { dimensionFilterGroups: [{ groupType: 'and', filters: i.filters }] } : {}) } }),
    (raw, i) => {
      const rows = (raw.rows || []).map((r: any) => ({ ...Object.fromEntries(i.dimensions.map((d: string, n: number) => [d, r.keys?.[n]])), clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));
      return { rows, row_count: rows.length, aggregation: raw.responseAggregationType, next_start_row: rows.length === i.row_limit ? i.start_row + i.row_limit : null };
    }),
  'google_search_console.list_sitemaps': gsc('List sitemaps submitted for a property, with last download time, warnings, errors and indexed content counts.',
    { site_url: site }, i => ({ url: `${webmasters}/sites/${e(i.site_url)}/sitemaps` }), raw => ({ sitemaps: raw.sitemap || [] })),
  'google_search_console.inspect_url': gsc('Inspect how Google indexed one URL of a property: coverage and indexing state, last crawl, Google-selected canonical, mobile usability and rich results. The URL must belong to the property.',
    { site_url: site, url: z.string().url().max(2048), language_code: z.string().max(20).default('en-US') },
    i => ({ url: 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', method: 'POST', body: { inspectionUrl: i.url, siteUrl: i.site_url, languageCode: i.language_code } }),
    raw => raw.inspectionResult ?? raw),
} as const satisfies Record<string, GoogleOperation>;

// Google Analytics 4: https://developers.google.com/analytics/devguides/reporting/data/v1
const admin = 'https://analyticsadmin.googleapis.com/v1beta';
const data = 'https://analyticsdata.googleapis.com/v1beta';
const property = z.string().regex(/^(properties\/)?\d{1,20}$/, 'Use the numeric property ID, e.g. 123456789.').describe('GA4 property ID from list_account_summaries, e.g. 123456789.');
const propertyPath = (value: string) => `properties/${value.replace(/^properties\//, '')}`;
const gaDate = z.string().regex(/^(\d{4}-\d{2}-\d{2}|today|yesterday|\d{1,4}daysAgo)$/, 'Use YYYY-MM-DD, today, yesterday or NdaysAgo.');
const names = (max: number, what: string) => z.array(z.string().regex(/^[A-Za-z0-9_:]{1,200}$/)).max(max).describe(`${what} API names, e.g. from get_metadata.`);
const expression = z.record(z.string(), z.unknown()).describe('A GA4 Data API FilterExpression object, e.g. {"filter":{"fieldName":"country","stringFilter":{"value":"Japan"}}}.');
const orderBys = z.array(z.record(z.string(), z.unknown())).max(10).describe('GA4 Data API OrderBy objects, e.g. [{"metric":{"metricName":"sessions"},"desc":true}].');
const numeric = new Set(['TYPE_INTEGER', 'TYPE_FLOAT', 'TYPE_SECONDS', 'TYPE_MILLISECONDS', 'TYPE_MINUTES', 'TYPE_HOURS', 'TYPE_STANDARD', 'TYPE_CURRENCY', 'TYPE_FEET', 'TYPE_MILES', 'TYPE_METERS', 'TYPE_KILOMETERS']);
/** Rows as objects keyed by dimension and metric names, with numeric metrics as numbers. */
function report(raw: any, input: { limit?: number; offset?: number }) {
  const dimensions: string[] = (raw.dimensionHeaders || []).map((h: any) => h.name);
  const metrics: { name: string; type: string }[] = (raw.metricHeaders || []).map((h: any) => ({ name: h.name, type: h.type }));
  const row = (r: any) => ({
    ...Object.fromEntries(dimensions.map((d, n) => [d, r.dimensionValues?.[n]?.value])),
    ...Object.fromEntries(metrics.map((m, n) => { const value = r.metricValues?.[n]?.value; return [m.name, numeric.has(m.type) && value !== undefined ? Number(value) : value]; })),
  });
  const rows = (raw.rows || []).map(row);
  const total = raw.rowCount ?? rows.length;
  const next = input.limit !== undefined && (input.offset ?? 0) + rows.length < total ? (input.offset ?? 0) + rows.length : null;
  return { rows, row_count: total, ...(raw.totals?.length ? { totals: raw.totals.map(row) } : {}), metric_types: Object.fromEntries(metrics.map(m => [m.name, m.type])),
    ...(input.offset !== undefined ? { next_offset: next } : {}), ...(raw.metadata ? { metadata: raw.metadata } : {}) };
}
const ga = (description: string, shape: z.ZodRawShape, request: GoogleOperation['request'], response?: GoogleOperation['response']): GoogleOperation =>
  ({ connector: 'google_analytics', description, read_only: true, required_permissions: ['Google Analytics: read'], schema: z.object(shape).strict(), request, response });

export const googleAnalyticsTools = {
  'google_analytics.list_account_summaries': ga('List Google Analytics accounts and the GA4 properties under each one. Call this first to find property IDs.',
    { page_size: z.number().int().min(1).max(200).default(50), page_token: z.string().max(1000).optional() },
    i => ({ url: `${admin}/accountSummaries?${query({ pageSize: i.page_size, pageToken: i.page_token })}` }),
    raw => ({ accounts: (raw.accountSummaries || []).map((a: any) => ({ account: a.account, name: a.displayName,
      properties: (a.propertySummaries || []).map((p: any) => ({ property_id: String(p.property).replace(/^properties\//, ''), name: p.displayName, type: p.propertyType })) })),
      next_page_token: raw.nextPageToken || null })),
  'google_analytics.get_property': ga('Get a GA4 property: display name, time zone, currency, industry and creation time.',
    { property_id: property }, i => ({ url: `${admin}/${propertyPath(i.property_id)}` })),
  'google_analytics.get_metadata': ga('List dimensions and metrics available for reports on a property, including its custom dimensions and metrics. Use the api_name values in run_report.',
    { property_id: property, custom_only: z.boolean().default(false).describe('Only custom dimensions and metrics of this property.') },
    i => ({ url: `${data}/${propertyPath(i.property_id)}/metadata` }),
    (raw, i) => {
      const keep = (item: any) => !i.custom_only || item.customDefinition;
      return { dimensions: (raw.dimensions || []).filter(keep).map((d: any) => ({ api_name: d.apiName, name: d.uiName, category: d.category, ...(d.customDefinition ? { custom: true } : {}) })),
        metrics: (raw.metrics || []).filter(keep).map((m: any) => ({ api_name: m.apiName, name: m.uiName, type: m.type, category: m.category, ...(m.customDefinition ? { custom: true } : {}) })) };
    }),
  'google_analytics.run_report': ga('Run a GA4 report: metrics (e.g. activeUsers, sessions, screenPageViews, conversions, totalRevenue) over date ranges, grouped by dimensions (e.g. date, country, pagePath, sessionSource, deviceCategory). Use get_metadata for valid names. Page through results with offset.',
    {
      property_id: property,
      date_ranges: z.array(z.object({ start_date: gaDate, end_date: gaDate, name: z.string().max(100).optional() }).strict()).min(1).max(4).default([{ start_date: '28daysAgo', end_date: 'yesterday' }]),
      metrics: names(10, 'Metric').min(1), dimensions: names(9, 'Dimension').default([]),
      dimension_filter: expression.optional(), metric_filter: expression.optional(), order_bys: orderBys.optional(),
      limit: z.number().int().min(1).max(1000).default(100), offset: z.number().int().min(0).max(1000000).default(0),
      keep_empty_rows: z.boolean().default(false), include_totals: z.boolean().default(false),
    },
    i => ({ url: `${data}/${propertyPath(i.property_id)}:runReport`, method: 'POST', body: {
      dateRanges: i.date_ranges.map((r: any) => ({ startDate: r.start_date, endDate: r.end_date, ...(r.name ? { name: r.name } : {}) })),
      metrics: i.metrics.map((name: string) => ({ name })), dimensions: i.dimensions.map((name: string) => ({ name })),
      dimensionFilter: i.dimension_filter, metricFilter: i.metric_filter, orderBys: i.order_bys,
      limit: i.limit, offset: i.offset, keepEmptyRows: i.keep_empty_rows, ...(i.include_totals ? { metricAggregations: ['TOTAL'] } : {}) } }),
    report),
  'google_analytics.run_realtime_report': ga('Run a GA4 realtime report on activity in the last 30 minutes (e.g. metric activeUsers by dimension country, unifiedScreenName or eventName).',
    {
      property_id: property, metrics: names(10, 'Realtime metric').min(1), dimensions: names(9, 'Realtime dimension').default([]),
      minutes_ago: z.number().int().min(0).max(29).default(29).describe('Start of the window, in minutes before now.'),
      dimension_filter: expression.optional(), metric_filter: expression.optional(), order_bys: orderBys.optional(),
      limit: z.number().int().min(1).max(1000).default(100),
    },
    i => ({ url: `${data}/${propertyPath(i.property_id)}:runRealtimeReport`, method: 'POST', body: {
      metrics: i.metrics.map((name: string) => ({ name })), dimensions: i.dimensions.map((name: string) => ({ name })),
      minuteRanges: [{ startMinutesAgo: i.minutes_ago, endMinutesAgo: 0 }],
      dimensionFilter: i.dimension_filter, metricFilter: i.metric_filter, orderBys: i.order_bys, limit: i.limit } }),
    raw => report(raw, {})),
} as const satisfies Record<string, GoogleOperation>;

export const googleTools = { ...googleSearchConsoleTools, ...googleAnalyticsTools };
