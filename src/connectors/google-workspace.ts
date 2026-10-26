import { z } from 'zod';
import { query, type RestOperation } from './rest.js';

const e = encodeURIComponent;
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/);
const title = z.string().min(1).max(1000);
const paging = { page_size: z.number().int().min(1).max(100).default(50), page_token: z.string().max(4096).optional() };
const tool = (connector: RestOperation['connector'], description: string, read_only: boolean, shape: z.ZodRawShape, request: RestOperation['request']): RestOperation =>
  ({ connector, description, read_only, required_permissions: [`${connector}: ${read_only ? 'read' : 'write'}`], schema: z.object(shape).strict(), request });
const calendar = 'https://www.googleapis.com/calendar/v3';
const cal = { calendar_id: z.string().min(1).max(1024).default('primary') };
const eventId = { ...cal, event_id: id };
const time = z.iso.datetime({ offset: true });
const eventTime = z.union([z.object({ date: z.iso.date() }).strict(), z.object({ dateTime: time, timeZone: z.string().max(100).optional() }).strict()]);
const event = z.object({ summary: title, description: z.string().max(20000).optional(), location: title.optional(), start: eventTime, end: eventTime,
  attendees: z.array(z.object({ email: z.email() }).strict()).max(100).optional(), recurrence: z.array(z.string().max(1000)).max(10).optional() }).strict();
const updates = { send_updates: z.enum(['all', 'externalOnly', 'none']).default('all') };
const eventPath = (i: any) => `${calendar}/calendars/${e(i.calendar_id)}/events${i.event_id ? '/' + e(i.event_id) : ''}`;
const c = (description: string, read: boolean, shape: z.ZodRawShape, request: RestOperation['request']) => tool('google_calendar', description, read, shape, request);
export const googleCalendarTools = {
  'google_calendar.list_calendars': c('List calendars accessible to the connected user; returns nextPageToken.', true, paging, i => ({ url: `${calendar}/users/me/calendarList?${query({ maxResults: i.page_size, pageToken: i.page_token })}` })),
  'google_calendar.list_events': c('List and search events, expanding recurring events. Use time_min/time_max for a window and page_token for more results.', true, { ...cal, ...paging, time_min: time.optional(), time_max: time.optional(), query: z.string().max(2000).optional() }, i => ({ url: `${eventPath(i)}?${query({ maxResults: i.page_size, pageToken: i.page_token, timeMin: i.time_min, timeMax: i.time_max, q: i.query, singleEvents: true, orderBy: 'startTime' })}` })),
  'google_calendar.get_event': c('Read one event.', true, eventId, i => ({ url: eventPath(i) })),
  'google_calendar.create_event': c('Create an event; attendees receive invitations by default. All-day end dates are exclusive.', false, { ...cal, ...updates, event }, i => ({ url: `${eventPath(i)}?${query({ sendUpdates: i.send_updates })}`, method: 'POST', body: i.event })),
  'google_calendar.update_event': c('Patch an event. Supplied attendees replace the full attendee list; attendees receive updates by default.', false, { ...eventId, ...updates, event: event.partial() }, i => ({ url: `${eventPath(i)}?${query({ sendUpdates: i.send_updates })}`, method: 'PATCH', body: i.event })),
  'google_calendar.delete_event': c('Delete an event and notify attendees by default.', false, { ...eventId, ...updates }, i => ({ url: `${eventPath(i)}?${query({ sendUpdates: i.send_updates })}`, method: 'DELETE' })),
};

const drive = 'https://www.googleapis.com/drive/v3';
const fileFields = 'id,name,mimeType,description,parents,webViewLink,modifiedTime,size,trashed';
const d = (description: string, read: boolean, shape: z.ZodRawShape, request: RestOperation['request']) => tool('google_drive', description, read, shape, request);
export const googleDriveTools = {
  'google_drive.list_files': d('Search Drive files with Drive query syntax, e.g. name contains \'plan\'. Returns metadata and nextPageToken. Use Docs/Sheets tools for document contents.', true, { ...paging, query: z.string().max(4000).default('trashed = false') }, i => ({ url: `${drive}/files?${query({ q: i.query, pageSize: i.page_size, pageToken: i.page_token, fields: `nextPageToken,incompleteSearch,files(${fileFields})`, supportsAllDrives: true, includeItemsFromAllDrives: true })}` })),
  'google_drive.get_file': d('Get file metadata, parents and a link to open it.', true, { file_id: id }, i => ({ url: `${drive}/files/${e(i.file_id)}?${query({ fields: fileFields, supportsAllDrives: true })}` })),
  'google_drive.create_folder': d('Create a Drive folder, optionally inside a parent folder.', false, { name: title, parent_id: id.optional() }, i => ({ url: `${drive}/files?${query({ fields: fileFields, supportsAllDrives: true })}`, method: 'POST', body: { name: i.name, mimeType: 'application/vnd.google-apps.folder', ...(i.parent_id ? { parents: [i.parent_id] } : {}) } })),
  'google_drive.update_file': d('Rename a file, change its description, or move it by adding/removing parent folder IDs.', false, { file_id: id, name: title.optional(), description: z.string().max(20000).optional(), add_parent: id.optional(), remove_parent: id.optional() }, i => ({ url: `${drive}/files/${e(i.file_id)}?${query({ fields: fileFields, supportsAllDrives: true, addParents: i.add_parent, removeParents: i.remove_parent })}`, method: 'PATCH', body: { name: i.name, description: i.description } })),
  'google_drive.trash_file': d('Move a file to trash or restore it. Does not permanently delete it.', false, { file_id: id, trashed: z.boolean().default(true) }, i => ({ url: `${drive}/files/${e(i.file_id)}?${query({ fields: fileFields, supportsAllDrives: true })}`, method: 'PATCH', body: { trashed: i.trashed } })),
};

const sheets = 'https://sheets.googleapis.com/v4/spreadsheets';
const sheetId = { spreadsheet_id: id };
const range = { ...sheetId, range: z.string().min(1).max(1000).describe('A1 notation, e.g. Sheet1!A1:D20. Read only a bounded range to keep responses small.') };
const values = z.array(z.array(z.union([z.string().max(50000), z.number(), z.boolean(), z.null()])).max(100)).min(1).max(1000);
const write = { ...range, values, value_input_option: z.enum(['RAW', 'USER_ENTERED']).default('RAW') };
const s = (description: string, read: boolean, shape: z.ZodRawShape, request: RestOperation['request']) => tool('google_sheets', description, read, shape, request);
export const googleSheetsTools = {
  'google_sheets.get_spreadsheet': s('Get spreadsheet title, URL and sheet properties (no cell data).', true, sheetId, i => ({ url: `${sheets}/${e(i.spreadsheet_id)}?fields=spreadsheetId,spreadsheetUrl,properties,sheets.properties` })),
  'google_sheets.read_values': s('Read a cell range. FORMATTED_VALUE returns displayed text; FORMULA returns formulas.', true, { ...range, value_render_option: z.enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA']).default('FORMATTED_VALUE') }, i => ({ url: `${sheets}/${e(i.spreadsheet_id)}/values/${e(i.range)}?${query({ valueRenderOption: i.value_render_option })}` })),
  'google_sheets.update_values': s('Overwrite cells in a range. RAW treats strings literally; USER_ENTERED interprets formulas and dates.', false, write, i => ({ url: `${sheets}/${e(i.spreadsheet_id)}/values/${e(i.range)}?${query({ valueInputOption: i.value_input_option })}`, method: 'PUT', body: { range: i.range, majorDimension: 'ROWS', values: i.values } })),
  'google_sheets.append_values': s('Append rows after the logical table in a range.', false, write, i => ({ url: `${sheets}/${e(i.spreadsheet_id)}/values/${e(i.range)}:append?${query({ valueInputOption: i.value_input_option, insertDataOption: 'INSERT_ROWS' })}`, method: 'POST', body: { majorDimension: 'ROWS', values: i.values } })),
  'google_sheets.clear_values': s('Clear values in a range while retaining formatting.', false, range, i => ({ url: `${sheets}/${e(i.spreadsheet_id)}/values/${e(i.range)}:clear`, method: 'POST', body: {} })),
  'google_sheets.create_spreadsheet': s('Create a spreadsheet with optional named sheets.', false, { title, sheet_titles: z.array(title).min(1).max(50).optional() }, i => ({ url: sheets, method: 'POST', body: { properties: { title: i.title }, sheets: i.sheet_titles?.map((name: string) => ({ properties: { title: name } })) } })),
};

const docs = 'https://docs.googleapis.com/v1/documents';
const docId = { document_id: id };
const tabId = z.string().regex(/^[a-zA-Z0-9_.-]{1,256}$/);
const text = z.string().min(1).max(50000);
const doc = (description: string, read: boolean, shape: z.ZodRawShape, request: RestOperation['request']) => tool('google_docs', description, read, shape, request);
const revision = { required_revision_id: z.string().max(1024).optional().describe('Revision from get_document to reject conflicting edits.') };
const batch = (i: any, requests: unknown[]) => ({ url: `${docs}/${e(i.document_id)}:batchUpdate`, method: 'POST', body: { requests, ...(i.required_revision_id ? { writeControl: { requiredRevisionId: i.required_revision_id } } : {}) } });
export const googleDocsTools = {
  'google_docs.get_document': doc('Read a Google document with all tabs, structured body and revision ID.', true, docId, i => ({ url: `${docs}/${e(i.document_id)}?includeTabsContent=true` })),
  'google_docs.create_document': doc('Create a blank Google document with a title.', false, { title }, i => ({ url: docs, method: 'POST', body: { title: i.title } })),
  'google_docs.insert_text': doc('Insert text at a UTF-16 index (>=1), or append to the end of a tab when index is omitted. Omitted tab_id targets the first tab.', false, { ...docId, ...revision, text, index: z.number().int().min(1).optional(), tab_id: tabId.optional() }, i => batch(i, [{ insertText: { text: i.text, ...(i.index === undefined ? { endOfSegmentLocation: { tabId: i.tab_id } } : { location: { index: i.index, tabId: i.tab_id } }) } }])),
  'google_docs.replace_text': doc('Replace literal matching text, across all tabs unless tab_ids is supplied.', false, { ...docId, ...revision, find: text, replace: z.string().max(50000), match_case: z.boolean().default(true), tab_ids: z.array(tabId).min(1).max(100).optional() }, i => batch(i, [{ replaceAllText: { containsText: { text: i.find, matchCase: i.match_case }, replaceText: i.replace, ...(i.tab_ids ? { tabsCriteria: { tabIds: i.tab_ids } } : {}) } }])),
};
export const googleWorkspaceTools = { ...googleCalendarTools, ...googleDriveTools, ...googleSheetsTools, ...googleDocsTools };
