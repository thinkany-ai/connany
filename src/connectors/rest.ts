import type { z } from 'zod';

/**
 * Tools Connany implements against a service's REST API with the user's OAuth token, for
 * services without a hosted MCP server (Google, Zoho). Each tool is either one request with an
 * optional reshaping of the response, or a `run` that makes several requests through `call`.
 */
export interface RestRequest { url: string; method?: string; body?: unknown }
export interface RestContext {
  /** Accounts server the user authorized with, for services with regional data centers (Zoho). */
  server?: string;
  /** Sends a request with the user's token and returns the parsed JSON body. */
  call: (request: RestRequest) => Promise<any>;
}
export interface RestOperation {
  connector: 'google_search_console' | 'google_analytics' | 'gmail' | 'zoho_mail' | 'google_calendar' | 'google_drive' | 'google_sheets' | 'google_docs' | 'outlook' | 'microsoft_365';
  description: string;
  read_only: boolean;
  required_permissions: string[];
  schema: z.ZodObject;
  request?: (input: any, context: RestContext) => RestRequest;
  response?: (raw: any, input: any) => unknown;
  run?: (input: any, context: RestContext) => Promise<unknown>;
}

export const query = (values: Record<string, unknown>) => new URLSearchParams(Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decodeEntities = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) =>
  name[0] === '#' ? String.fromCodePoint(parseInt(name.slice(name[1] === 'x' || name[1] === 'X' ? 2 : 1), name[1] === 'x' || name[1] === 'X' ? 16 : 10) || 32) : entities[name.toLowerCase()] ?? match);
/** Readable text from an HTML email body: block elements become line breaks, everything else is dropped. */
export function htmlToText(html: string) {
  const text = html.replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n').replace(/<li\b[^>]*>/gi, '- ').replace(/<[^>]+>/g, '');
  return decodeEntities(text).replace(/[ \t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
/** Cuts long bodies so one email cannot fill the agent's context. */
export const truncate = (text: string, max: number) => text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
