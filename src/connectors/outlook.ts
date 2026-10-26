import { z } from 'zod';
import { query, htmlToText, truncate, type RestOperation } from './rest.js';

const base = 'https://graph.microsoft.com/v1.0/me';
const e = encodeURIComponent;
// Graph IDs are opaque; reject path segments and encode all remaining special characters.
const id = z.string().min(1).max(2048).refine(v => v !== '.' && v !== '..' && !/[\x00-\x20/\\?#]/.test(v), 'Use an ID returned by Outlook.');
const paging = { page_size: z.number().int().min(1).max(100).default(25), page_url: z.string().url().max(12000).optional().describe('The next_page_url from the same listing tool. Do not construct this URL.') };
/** Never forward the bearer token to an arbitrary nextLink, or to a different Graph resource. */
function pageUrl(value: string | undefined, path: string, params: Record<string, unknown>) {
  const expected = new URL(base + path);
  if (!value) return `${expected}?${query(params)}`;
  const url = new URL(value);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash) throw new Error('Invalid Outlook pagination URL.');
  return url.toString();
}
const list = (raw: any) => ({ items: raw.value || [], next_page_url: raw['@odata.nextLink'] || null });
const tool = (description: string, read_only: boolean, permission: string, shape: z.ZodRawShape, request: RestOperation['request'], response?: RestOperation['response']): RestOperation =>
  ({ connector: 'outlook', description, read_only, required_permissions: [permission], schema: z.object(shape).strict(), request, response });
const recipients = z.array(z.email()).min(1).max(100);
const compose = { to: recipients, cc: recipients.optional(), bcc: recipients.optional(), subject: z.string().min(1).max(1000), body: z.string().max(50000), html: z.boolean().default(false) };
const addresses = (values?: string[]) => values?.map(address => ({ emailAddress: { address } }));
const message = (i: any) => ({ subject: i.subject, body: { contentType: i.html ? 'HTML' : 'Text', content: i.body }, toRecipients: addresses(i.to), ccRecipients: addresses(i.cc), bccRecipients: addresses(i.bcc) });
const accepted = () => ({ accepted: true });
const date = z.iso.datetime({ offset: true });
const eventTime = z.object({ dateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?$/), timeZone: z.string().min(1).max(100).default('UTC') }).strict();
const event = z.object({ subject: z.string().min(1).max(1000), start: eventTime, end: eventTime, body: z.object({ contentType: z.enum(['Text','HTML']), content: z.string().max(50000) }).strict().optional(),
  location: z.object({ displayName: z.string().max(1000) }).strict().optional(),
  attendees: z.array(z.object({ emailAddress: z.object({ address: z.email(), name: z.string().max(200).optional() }).strict(), type: z.enum(['required','optional','resource']).default('required') }).strict()).max(100).optional(), isAllDay: z.boolean().optional() }).strict();
export const outlookTools = {
  'outlook.get_profile': tool('Get the connected Microsoft account profile.', true, 'User.Read', {}, () => ({ url: `${base}?$select=id,displayName,mail,userPrincipalName` })),
  'outlook.list_folders': tool('List top-level mail folders and message counts.', true, 'Mail.ReadWrite', paging, i => ({ url: pageUrl(i.page_url, '/mailFolders', { $top: i.page_size }) }), list),
  'outlook.list_messages': tool('List mail, optionally in a folder. query uses Outlook mail search syntax (e.g. from:alice@example.com). Follow next_page_url with the same folder_id.', true, 'Mail.ReadWrite', { ...paging, folder_id: id.optional(), query: z.string().max(2000).optional() }, i => ({ url: pageUrl(i.page_url, i.folder_id ? `/mailFolders/${e(i.folder_id)}/messages` : '/messages', { $top: i.page_size, $select: 'id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments,conversationId', ...(i.query ? { $search: JSON.stringify(i.query) } : { $orderby: 'receivedDateTime desc' }) }) }), list),
  'outlook.get_message': tool('Read a message, returning its body as bounded plain text.', true, 'Mail.ReadWrite', { message_id: id, max_body_chars: z.number().int().min(100).max(50000).default(20000) }, i => ({ url: `${base}/messages/${e(i.message_id)}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,isRead,hasAttachments,conversationId` }), (raw, i) => {
    const body = truncate(raw.body?.contentType?.toLowerCase() === 'html' ? htmlToText(raw.body?.content || '') : raw.body?.content || '', i.max_body_chars);
    return { ...raw, body: body.text, body_truncated: body.truncated };
  }),
  'outlook.create_draft': tool('Create an email draft without sending it.', false, 'Mail.ReadWrite', compose, i => ({ url: `${base}/messages`, method: 'POST', body: message(i) })),
  'outlook.send_draft': tool('Send an existing draft. Verify recipients and content before sending.', false, 'Mail.Send', { message_id: id }, i => ({ url: `${base}/messages/${e(i.message_id)}/send`, method: 'POST' }), accepted),
  'outlook.send_message': tool('Send email. Verify recipients and content before sending. Accepted does not mean delivered.', false, 'Mail.Send', compose, i => ({ url: `${base}/sendMail`, method: 'POST', body: { message: message(i), saveToSentItems: true } }), accepted),
  'outlook.reply_message': tool('Reply to a message with a comment; optionally reply to everyone.', false, 'Mail.Send', { message_id: id, comment: z.string().min(1).max(50000), reply_all: z.boolean().default(false) }, i => ({ url: `${base}/messages/${e(i.message_id)}/${i.reply_all ? 'replyAll' : 'reply'}`, method: 'POST', body: { comment: i.comment } }), accepted),
  'outlook.mark_read': tool('Mark a message read or unread.', false, 'Mail.ReadWrite', { message_id: id, is_read: z.boolean() }, i => ({ url: `${base}/messages/${e(i.message_id)}`, method: 'PATCH', body: { isRead: i.is_read } })),
  'outlook.move_message': tool('Move a message to a folder, e.g. archive or deleteditems. Returns a new message ID.', false, 'Mail.ReadWrite', { message_id: id, destination_id: id }, i => ({ url: `${base}/messages/${e(i.message_id)}/move`, method: 'POST', body: { destinationId: i.destination_id } })),
  'outlook.list_calendars': tool('List calendars.', true, 'Calendars.ReadWrite', paging, i => ({ url: pageUrl(i.page_url, '/calendars', { $top: i.page_size }) }), list),
  'outlook.list_events': tool('List events and recurring occurrences in a time window. Omitted calendar_id uses the default calendar.', true, 'Calendars.ReadWrite', { ...paging, calendar_id: id.optional(), start_date_time: date, end_date_time: date }, i => ({ url: pageUrl(i.page_url, i.calendar_id ? `/calendars/${e(i.calendar_id)}/calendarView` : '/calendarView', { startDateTime: i.start_date_time, endDateTime: i.end_date_time, $top: i.page_size }) }), list),
  'outlook.get_event': tool('Read an event.', true, 'Calendars.ReadWrite', { event_id: id }, i => ({ url: `${base}/events/${e(i.event_id)}` })),
  'outlook.create_event': tool('Create an event and send invitations to attendees. dateTime is local to timeZone (default UTC).', false, 'Calendars.ReadWrite', { calendar_id: id.optional(), event }, i => ({ url: i.calendar_id ? `${base}/calendars/${e(i.calendar_id)}/events` : `${base}/events`, method: 'POST', body: i.event })),
  'outlook.update_event': tool('Patch an event. Supplied attendees replace the list and may send meeting updates.', false, 'Calendars.ReadWrite', { event_id: id, event: event.partial() }, i => ({ url: `${base}/events/${e(i.event_id)}`, method: 'PATCH', body: i.event })),
  'outlook.delete_event': tool('Delete an event; deleting an organized meeting sends cancellations.', false, 'Calendars.ReadWrite', { event_id: id }, i => ({ url: `${base}/events/${e(i.event_id)}`, method: 'DELETE' })),
};
