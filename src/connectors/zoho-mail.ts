import { z } from 'zod';
import { UpstreamError } from '../errors.js';
import { decodeEntities, htmlToText, query, truncate, type RestContext, type RestOperation } from './rest.js';

/**
 * Zoho Mail tools, against the Mail REST API of the data center the user's account lives in.
 * https://www.zoho.com/mail/help/api/
 */
/** Accounts servers of Zoho's data centers, as Zoho reports them in the `accounts-server` callback parameter. */
export const zohoAccountsServers = ['https://accounts.zoho.com', 'https://accounts.zoho.eu', 'https://accounts.zoho.in', 'https://accounts.zoho.com.au',
  'https://accounts.zoho.jp', 'https://accounts.zoho.uk', 'https://accounts.zoho.sa', 'https://accounts.zohocloud.ca', 'https://accounts.zoho.com.cn'];
/** Each data center serves Mail next to its accounts server: accounts.zoho.eu → mail.zoho.eu. */
function api({ server = zohoAccountsServers[0] }: RestContext) {
  if (!zohoAccountsServers.includes(server)) throw new UpstreamError('invalid_accounts_server');
  return `${server.replace('://accounts.', '://mail.')}/api`;
}
const e = encodeURIComponent;
const id = z.string().regex(/^\d{1,30}$/, 'Use a numeric ID returned by another Zoho Mail tool.');
const account = id.describe('Mail account ID from list_accounts.');
const address = z.string().min(3).max(320).regex(/^[^\r\n,;]*@[^\r\n,;]*$/, 'Use one email address per item, e.g. alice@example.com.');
const page = { start: z.number().int().min(1).max(100000).default(1).describe('1-based position of the first message.'), limit: z.number().int().min(1).max(200).default(20) };

/** Zoho escapes addresses as HTML (&lt;alice@example.com&gt;); times are epoch milliseconds. */
const text = (value: unknown) => typeof value === 'string' && value ? decodeEntities(value) : undefined;
const time = (value: unknown) => value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) ? new Date(Number(value)).toISOString() : undefined;
const summary = (m: any) => ({ message_id: String(m.messageId), folder_id: m.folderId === undefined ? undefined : String(m.folderId), thread_id: m.threadId === undefined ? undefined : String(m.threadId),
  from: text(m.fromAddress), sender: text(m.sender), to: text(m.toAddress), ...(text(m.ccAddress) ? { cc: text(m.ccAddress) } : {}), subject: text(m.subject), summary: text(m.summary),
  received_at: time(m.receivedTime ?? m.sentDateInGMT), has_attachment: m.hasAttachment === '1' || m.hasAttachment === true });
const messages = (raw: any, i: any) => {
  const rows = (Array.isArray(raw.data) ? raw.data : []).map(summary);
  return { messages: rows, next_start: rows.length === i.limit ? i.start + i.limit : null };
};
const compose = {
  account_id: account,
  from_address: address.optional().describe('Sender address of this account; defaults to its primary address.'),
  to: z.array(address).min(1).max(100), cc: z.array(address).max(100).default([]), bcc: z.array(address).max(100).default([]),
  subject: z.string().max(998).regex(/^[^\r\n]*$/), body: z.string().max(500000), html: z.boolean().default(false).describe('Send body as HTML instead of plain text.'),
};
async function mail(i: any, context: RestContext, extra: Record<string, unknown> = {}) {
  const from = i.from_address ?? (await context.call({ url: `${api(context)}/accounts/${e(i.account_id)}` })).data?.primaryEmailAddress;
  return { fromAddress: from, toAddress: i.to.join(','), ...(i.cc.length ? { ccAddress: i.cc.join(',') } : {}), ...(i.bcc.length ? { bccAddress: i.bcc.join(',') } : {}),
    subject: i.subject, content: i.body, mailFormat: i.html ? 'html' : 'plaintext', ...extra };
}
const sent = (raw: any) => ({ message_id: raw.data?.messageId === undefined ? undefined : String(raw.data.messageId), status: raw.status?.description });

const tool = (description: string, read_only: boolean, shape: z.ZodRawShape, rest: Pick<RestOperation, 'request' | 'response' | 'run'>, permission = read_only ? 'Zoho Mail: read' : 'Zoho Mail: send'): RestOperation =>
  ({ connector: 'zoho_mail', description, read_only, required_permissions: [permission], schema: z.object(shape).strict(), ...rest });
/** Read state, spam, archive and moves share one endpoint, picked by `mode`. IDs stay strings: they exceed JavaScript's safe integers. */
const update = (i: any, context: RestContext, body: Record<string, unknown>) =>
  ({ url: `${api(context)}/accounts/${e(i.account_id)}/updatemessage`, method: 'PUT', body: { ...body, messageId: i.message_ids } });
const modes = { read: 'markAsRead', unread: 'markAsUnread', spam: 'moveToSpam', archive: 'archiveMails' } as const;
const messageIds = z.array(id).min(1).max(100).describe('Message IDs from list_messages or search_messages.');

export const zohoMailTools = {
  'zoho_mail.list_accounts': tool('List the Zoho Mail accounts of the user with their account IDs and addresses. Call this first: every other tool needs an account_id.', true, {},
    { request: (_i, context) => ({ url: `${api(context)}/accounts` }),
      response: raw => ({ accounts: (raw.data || []).map((a: any) => ({ account_id: String(a.accountId), email: a.primaryEmailAddress ?? a.mailboxAddress, display_name: a.displayName ?? a.accountDisplayName,
        send_from: [...new Set((a.sendMailDetails || []).map((s: any) => s.fromAddress).filter(Boolean))] })) }) }),
  'zoho_mail.list_folders': tool('List the folders of a mail account (Inbox, Sent, Drafts, Spam, Trash and the user\'s own) with their folder IDs.', true, { account_id: account },
    { request: (i, context) => ({ url: `${api(context)}/accounts/${e(i.account_id)}/folders` }),
      response: raw => ({ folders: (raw.data || []).map((f: any) => ({ folder_id: String(f.folderId), name: f.folderName, type: f.folderType, path: f.path })) }) }),
  'zoho_mail.list_messages': tool('List messages in a folder, newest first, with sender, subject, summary and time. Without folder_id lists the Inbox. Page with start.', true,
    { account_id: account, folder_id: id.optional().describe('Folder ID from list_folders.'), status: z.enum(['all', 'read', 'unread']).default('all'), ...page },
    { request: (i, context) => ({ url: `${api(context)}/accounts/${e(i.account_id)}/messages/view?${query({ folderId: i.folder_id, status: i.status, start: i.start, limit: i.limit, includeto: true })}` }), response: messages }),
  'zoho_mail.search_messages': tool('Search messages with Zoho Mail search syntax: "entire:<words>" for any field, or fields such as "subject:invoice", "sender:alice@example.com", "has:attachment", "in:Inbox", combined with "::" (e.g. "sender:alice@example.com::has:attachment"). Page with start.', true,
    { account_id: account, search_key: z.string().min(1).max(2000), ...page },
    { request: (i, context) => ({ url: `${api(context)}/accounts/${e(i.account_id)}/messages/search?${query({ searchKey: i.search_key, start: i.start, limit: i.limit, includeto: true })}` }), response: messages }),
  'zoho_mail.get_message': tool('Read one message: sender, recipients, subject, time and the body as text (or HTML).', true,
    { account_id: account, folder_id: id.describe('Folder ID of the message, from list_messages or search_messages.'), message_id: id,
      format: z.enum(['text', 'html']).default('text'), max_body_chars: z.number().int().min(100).max(100000).default(20000).describe('Body characters to return; longer bodies are cut and marked truncated.') },
    { async run(i, context) {
      const path = `${api(context)}/accounts/${e(i.account_id)}/folders/${e(i.folder_id)}/messages/${e(i.message_id)}`;
      const [details, content] = await Promise.all([context.call({ url: `${path}/details` }), context.call({ url: `${path}/content` })]);
      const html = String(content.data?.content ?? '');
      const { text: body, truncated } = truncate(i.format === 'html' ? html : htmlToText(html), i.max_body_chars);
      return { ...summary({ messageId: i.message_id, folderId: i.folder_id, ...details.data }), body, ...(truncated ? { body_truncated: true } : {}) };
    } }),
  'zoho_mail.send_message': tool('Send an email from a Zoho Mail account. Sending cannot be undone: confirm recipients and content with the user first.', false, compose,
    { async run(i, context) { return sent(await context.call({ url: `${api(context)}/accounts/${e(i.account_id)}/messages`, method: 'POST', body: await mail(i, context) })); } }),
  'zoho_mail.reply_message': tool('Reply to a message from a Zoho Mail account; the reply stays in the same conversation. Confirm recipients and content with the user first.', false,
    { ...compose, message_id: id.describe('Message to reply to.'), reply_all: z.boolean().default(false) },
    { async run(i, context) { return sent(await context.call({ url: `${api(context)}/accounts/${e(i.account_id)}/messages/${e(i.message_id)}`, method: 'POST', body: await mail(i, context, { action: i.reply_all ? 'replyall' : 'reply' }) })); } }),
  'zoho_mail.create_draft': tool('Save an email to the Drafts folder without sending it, for the user to review in Zoho Mail.', false, compose,
    { async run(i, context) { return sent(await context.call({ url: `${api(context)}/accounts/${e(i.account_id)}/messages`, method: 'POST', body: await mail(i, context, { mode: 'draft' }) })); } }),
  'zoho_mail.mark_messages': tool('Mark messages as read or unread, report them as spam (moves them to the Spam folder) or archive them.', false,
    { account_id: account, message_ids: messageIds, action: z.enum(['read', 'unread', 'spam', 'archive']) },
    { request: (i, context) => update(i, context, { mode: modes[i.action as keyof typeof modes] }), response: (_raw, i) => ({ updated: i.message_ids.length }) }, 'Zoho Mail: modify'),
  'zoho_mail.move_messages': tool('Move messages to another folder, e.g. back to the Inbox from Spam. Folder IDs come from list_folders.', false,
    { account_id: account, message_ids: messageIds, destination_folder_id: id.describe('Folder ID from list_folders.') },
    { request: (i, context) => update(i, context, { mode: 'moveMessage', destfolderId: i.destination_folder_id }), response: (_raw, i) => ({ moved: i.message_ids.length }) }, 'Zoho Mail: modify'),
  'zoho_mail.delete_message': tool('Delete a message: moves it to Trash, where the user can still restore it. permanent skips Trash and cannot be undone: confirm with the user first.', false,
    { account_id: account, folder_id: id.describe('Folder ID of the message, from list_messages or search_messages.'), message_id: id, permanent: z.boolean().default(false) },
    { request: (i, context) => ({ url: `${api(context)}/accounts/${e(i.account_id)}/folders/${e(i.folder_id)}/messages/${e(i.message_id)}${i.permanent ? '?expunge=true' : ''}`, method: 'DELETE' }),
      response: (_raw, i) => ({ message_id: i.message_id, deleted: i.permanent ? 'permanently' : 'moved_to_trash' }) }, 'Zoho Mail: delete'),
} as const satisfies Record<string, RestOperation>;
