import { z } from 'zod';
import { htmlToText, query, truncate, type RestContext, type RestOperation } from './rest.js';

/**
 * Gmail tools. Google offers no hosted Gmail MCP server, so Connany calls the Gmail API with the
 * user's token: search returns compact message summaries, reads decode the MIME body to text,
 * and drafts and sends are built as RFC 5322 messages here.
 * https://developers.google.com/workspace/gmail/api/reference/rest
 */
const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
const e = encodeURIComponent;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Use an ID returned by another Gmail tool.');
const labelIds = z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).max(20);
// Line breaks would let a value inject headers into the message.
const address = z.string().min(3).max(320).regex(/^[^\r\n]*@[^\r\n]*$/, 'Use an email address such as alice@example.com or "Alice <alice@example.com>".');
const maxBody = z.number().int().min(100).max(100000).default(20000).describe('Body characters to return; longer bodies are cut and marked truncated.');
const summaryHeaders = ['From', 'To', 'Cc', 'Subject', 'Date'];

const header = (message: any, name: string): string | undefined => message.payload?.headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value;
const parts = (part: any): any[] => part ? [part, ...(part.parts || []).flatMap(parts)] : [];
const decode = (data: string) => Buffer.from(data, 'base64url').toString('utf8');
function summary(message: any) {
  const labels: string[] = message.labelIds || [];
  return { id: message.id, thread_id: message.threadId, from: header(message, 'From'), to: header(message, 'To'), ...(header(message, 'Cc') ? { cc: header(message, 'Cc') } : {}),
    subject: header(message, 'Subject'), date: header(message, 'Date'), snippet: message.snippet, label_ids: labels, unread: labels.includes('UNREAD') };
}
/** Summary plus the text body (text/plain, otherwise text/html converted to text) and attachment metadata. */
function full(message: any, max: number) {
  const all = parts(message.payload);
  const plain = all.find(p => p.mimeType === 'text/plain' && p.body?.data && !p.filename);
  const html = all.find(p => p.mimeType === 'text/html' && p.body?.data && !p.filename);
  const { text, truncated } = truncate(plain ? decode(plain.body.data) : html ? htmlToText(decode(html.body.data)) : '', max);
  return { ...summary(message), body: text, ...(truncated ? { body_truncated: true } : {}),
    attachments: all.filter(p => p.filename && p.body?.attachmentId).map(p => ({ filename: p.filename, mime_type: p.mimeType, size: p.body.size })) };
}

/** RFC 2047 encoded-word for non-ASCII header text. */
const word = (text: string) => /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text).toString('base64')}?=`;
const compose = {
  to: z.array(address).min(1).max(100), cc: z.array(address).max(100).default([]), bcc: z.array(address).max(100).default([]),
  subject: z.string().max(998).regex(/^[^\r\n]*$/).optional().describe('Required unless replying; a reply defaults to "Re: <original subject>".'),
  body: z.string().max(500000), html: z.boolean().default(false).describe('Send body as HTML instead of plain text.'),
  reply_to_message_id: id.optional().describe('Reply to this message: keeps it in the same thread with In-Reply-To and References.'),
};
/** Builds the raw message, threading it under the original when replying. */
async function message(i: any, { call }: RestContext) {
  const headers: [string, string | undefined][] = [['To', i.to.join(', ')], ['Cc', i.cc.join(', ') || undefined], ['Bcc', i.bcc.join(', ') || undefined]];
  let subject = i.subject, threadId: string | undefined;
  if (i.reply_to_message_id) {
    const original = await call({ url: `${base}/messages/${e(i.reply_to_message_id)}?${['Message-ID', 'References', 'Subject'].map(h => `metadataHeaders=${h}`).join('&')}&format=metadata` });
    const messageId = header(original, 'Message-ID');
    threadId = original.threadId;
    if (messageId) headers.push(['In-Reply-To', messageId], ['References', [header(original, 'References'), messageId].filter(Boolean).join(' ')]);
    subject ??= /^re:/i.test(header(original, 'Subject') || '') ? header(original, 'Subject') : `Re: ${header(original, 'Subject') || ''}`.trim();
  }
  if (subject === undefined) throw new z.ZodError([{ code: 'custom', path: ['subject'], message: 'Subject is required unless replying.', input: undefined }]);
  headers.push(['Subject', word(subject)], ['MIME-Version', '1.0'], ['Content-Type', `text/${i.html ? 'html' : 'plain'}; charset=UTF-8`], ['Content-Transfer-Encoding', 'base64']);
  const body = Buffer.from(i.body).toString('base64').replace(/.{76}/g, '$&\r\n');
  const raw = Buffer.from(`${headers.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${body}`).toString('base64url');
  return { raw, ...(threadId ? { threadId } : {}) };
}

const tool = (description: string, read_only: boolean, shape: z.ZodRawShape, rest: Pick<RestOperation, 'request' | 'response' | 'run'>): RestOperation =>
  ({ connector: 'gmail', description, read_only, required_permissions: [read_only ? 'Gmail: read' : 'Gmail: compose and modify'], schema: z.object(shape).strict(), ...rest });

export const gmailTools = {
  'gmail.get_profile': tool('Get the Gmail address of the connected account with its total message and thread counts.', true, {},
    { request: () => ({ url: `${base}/profile` }), response: raw => ({ email_address: raw.emailAddress, messages_total: raw.messagesTotal, threads_total: raw.threadsTotal }) }),
  'gmail.list_labels': tool('List Gmail labels: system labels (INBOX, UNREAD, STARRED, SENT, DRAFT, SPAM, TRASH, IMPORTANT, CATEGORY_*) and the user\'s own labels with their IDs.', true, {},
    { request: () => ({ url: `${base}/labels` }), response: raw => ({ labels: (raw.labels || []).map((l: any) => ({ id: l.id, name: l.name, type: l.type })) }) }),
  'gmail.search_messages': tool('Search messages with Gmail search syntax (e.g. "from:alice is:unread newer_than:7d", "subject:invoice has:attachment") and return sender, recipients, subject, date, snippet and labels for each. Use get_message or get_thread for the full body. Page through results with page_token.', true,
    {
      query: z.string().max(2000).default('').describe('Gmail search query, as in the Gmail search box. Empty lists the newest messages.'),
      label_ids: labelIds.default([]).describe('Only messages with all of these label IDs, e.g. ["INBOX"].'),
      max_results: z.number().int().min(1).max(50).default(20), page_token: z.string().max(1000).optional(),
      include_spam_trash: z.boolean().default(false),
    },
    { async run(i, { call }) {
      const params = new URLSearchParams(query({ q: i.query || undefined, maxResults: i.max_results, pageToken: i.page_token, includeSpamTrash: i.include_spam_trash }));
      for (const label of i.label_ids) params.append('labelIds', label);
      const list = await call({ url: `${base}/messages?${params}` });
      const fields = summaryHeaders.map(h => `metadataHeaders=${h}`).join('&');
      const messages = await Promise.all((list.messages || []).map((m: any) => call({ url: `${base}/messages/${e(m.id)}?format=metadata&${fields}` })));
      return { messages: messages.map(summary), next_page_token: list.nextPageToken || null, result_size_estimate: list.resultSizeEstimate ?? messages.length };
    } }),
  'gmail.get_message': tool('Read one message: headers, labels, the body as text and attachment names.', true,
    { message_id: id, max_body_chars: maxBody }, { request: i => ({ url: `${base}/messages/${e(i.message_id)}?format=full` }), response: (raw, i) => full(raw, i.max_body_chars) }),
  'gmail.get_thread': tool('Read a whole conversation: every message in the thread, oldest first, with bodies as text.', true,
    { thread_id: id, max_body_chars: maxBody.describe('Body characters to return per message.') },
    { request: i => ({ url: `${base}/threads/${e(i.thread_id)}?format=full` }), response: (raw, i) => ({ thread_id: raw.id, messages: (raw.messages || []).map((m: any) => full(m, i.max_body_chars)) }) }),
  'gmail.create_draft': tool('Save a draft without sending it, optionally as a reply in an existing thread. The user can review it in Gmail; send it later with send_draft.', false, compose,
    { async run(i, context) { const raw = await context.call({ url: `${base}/drafts`, method: 'POST', body: { message: await message(i, context) } }); return { draft_id: raw.id, message_id: raw.message?.id, thread_id: raw.message?.threadId }; } }),
  'gmail.send_draft': tool('Send an existing draft.', false, { draft_id: id },
    { request: i => ({ url: `${base}/drafts/send`, method: 'POST', body: { id: i.draft_id } }), response: raw => ({ message_id: raw.id, thread_id: raw.threadId, label_ids: raw.labelIds }) }),
  'gmail.send_message': tool('Send an email from the user\'s Gmail address, optionally as a reply in an existing thread. Sending cannot be undone: confirm recipients and content with the user first.', false, compose,
    { async run(i, context) { const raw = await context.call({ url: `${base}/messages/send`, method: 'POST', body: await message(i, context) }); return { message_id: raw.id, thread_id: raw.threadId, label_ids: raw.labelIds }; } }),
  'gmail.modify_labels': tool('Add or remove labels on messages: mark read (remove UNREAD), archive (remove INBOX), star (add STARRED) or apply the user\'s labels by ID.', false,
    { message_ids: z.array(id).min(1).max(100), add_label_ids: labelIds.default([]), remove_label_ids: labelIds.default([]) },
    { request: i => ({ url: `${base}/messages/batchModify`, method: 'POST', body: { ids: i.message_ids, addLabelIds: i.add_label_ids, removeLabelIds: i.remove_label_ids } }),
      response: (_raw, i) => ({ modified: i.message_ids.length }) }),
} as const satisfies Record<string, RestOperation>;
