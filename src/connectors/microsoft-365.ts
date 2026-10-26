import { z } from 'zod';
import { AppError } from '../errors.js';
import { query, type RestOperation } from './rest.js';
import { outlookTools } from './outlook.js';

const base = 'https://graph.microsoft.com/v1.0';
const e = encodeURIComponent;
const id = z.string().min(1).max(2048).refine(v => v !== '.' && v !== '..' && !/[\x00-\x20/\\?#]/.test(v), 'Use an ID returned by Microsoft Graph.');
const paging = { page_size: z.number().int().min(1).max(100).default(25), page_url: z.string().url().max(12000).optional().describe('Pass next_page_url from this listing, keeping the same resource IDs.') };
function page(path: string, input: any, params: Record<string, unknown> = {}) {
  const expected = new URL(base + path);
  if (!input.page_url) return `${expected}?${query({ $top: input.page_size, ...params })}`;
  const url = new URL(input.page_url);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash) throw new AppError('invalid_page_url', 'Use the next_page_url returned by the same listing.');
  return url.toString();
}
const list = (raw: any) => ({ items: raw.value || [], next_page_url: raw['@odata.nextLink'] || null });
const tool = (description: string, read_only: boolean, permission: string, shape: z.ZodRawShape, request: RestOperation['request'], response?: RestOperation['response']): RestOperation =>
  ({ connector: 'microsoft_365', description, read_only, required_permissions: [permission], schema: z.object(shape).strict(), request, response });
const drive = (i: any) => i.drive_id ? `/drives/${e(i.drive_id)}` : '/me/drive';
const item = (i: any) => `${drive(i)}/items/${e(i.item_id)}`;
const driveId = { drive_id: id.optional().describe('Omit to use your own OneDrive. Use list_drives for a SharePoint document library.') };
const itemId = { ...driveId, item_id: id };
const channelId = { team_id: id, channel_id: id };
const channel = (i: any) => `/teams/${e(i.team_id)}/channels/${e(i.channel_id)}`;
const body = z.object({ contentType: z.enum(['text','html']).default('text'), content: z.string().min(1).max(20000) }).strict();

// The Outlook and M365 connectors remain separate grants, with identical mail/calendar behavior.
const mailTools: Record<string, RestOperation> = Object.fromEntries(Object.entries(outlookTools).map(([name, operation]) =>
  [name.replace(/^outlook\./, 'microsoft_365.'), { ...operation, connector: 'microsoft_365' as const }]));
export const microsoft365Tools: Record<string, RestOperation> = {
  ...mailTools,
  'microsoft_365.search': tool('Search Microsoft 365 files, sites, mail or Teams messages using Microsoft Search KQL. Organizational accounts only. Search one entity type per request; results include summaries and resource IDs.', true, 'Files.Read.All / Sites.Read.All / Mail.ReadWrite / Chat.Read / ChannelMessage.Read.All (by entity)',
    { query: z.string().min(1).max(2000), entity_type: z.enum(['driveItem','site','message','chatMessage']).default('driveItem'), from: z.number().int().min(0).max(100000).default(0), size: z.number().int().min(1).max(100).default(25) },
    i => ({ url: `${base}/search/query`, method: 'POST', body: { requests: [{ entityTypes: [i.entity_type], query: { queryString: i.query }, from: i.from, size: i.size }] } })),
  'microsoft_365.list_drives': tool('List your OneDrive drives or a SharePoint site’s document libraries.', true, 'Files.Read.All', { ...paging, site_id: id.optional() }, i => ({ url: page(i.site_id ? `/sites/${e(i.site_id)}/drives` : '/me/drives', i) }), list),
  'microsoft_365.list_files': tool('List files/folders in OneDrive or a SharePoint document library. Omit folder_id for the drive root.', true, 'Files.Read.All', { ...paging, ...driveId, folder_id: id.optional() }, i => ({ url: page(`${drive(i)}/${i.folder_id ? 'items/' + e(i.folder_id) : 'root'}/children`, i, { $select: 'id,name,size,webUrl,file,folder,parentReference,lastModifiedDateTime' }) }), list),
  'microsoft_365.get_file': tool('Get file metadata and its browser link. For matching content use search; this tool does not download file bytes.', true, 'Files.Read.All', itemId, i => ({ url: `${base}${item(i)}?$select=id,name,size,webUrl,file,folder,parentReference,lastModifiedDateTime,description` })),
  'microsoft_365.search_sites': tool('Find SharePoint sites by name or keywords.', true, 'Sites.Read.All', { ...paging, query: z.string().min(1).max(1000) }, i => ({ url: page('/sites', i, { search: i.query }) }), list),
  'microsoft_365.get_site': tool('Get a SharePoint site and its browser URL.', true, 'Sites.Read.All', { site_id: id }, i => ({ url: `${base}/sites/${e(i.site_id)}` })),
  'microsoft_365.list_site_lists': tool('List SharePoint lists in a site.', true, 'Sites.Read.All', { ...paging, site_id: id }, i => ({ url: page(`/sites/${e(i.site_id)}/lists`, i) }), list),
  'microsoft_365.list_list_items': tool('Read SharePoint list rows, including their fields.', true, 'Sites.Read.All', { ...paging, site_id: id, list_id: id }, i => ({ url: page(`/sites/${e(i.site_id)}/lists/${e(i.list_id)}/items`, i, { $expand: 'fields' }) }), list),
  'microsoft_365.list_teams': tool('List Teams teams you have joined.', true, 'Team.ReadBasic.All', {}, () => ({ url: `${base}/me/joinedTeams` }), list),
  'microsoft_365.list_channels': tool('List channels in a team.', true, 'Channel.ReadBasic.All', { team_id: id }, i => ({ url: `${base}/teams/${e(i.team_id)}/channels` }), list),
  'microsoft_365.list_channel_messages': tool('Read top-level channel messages. Use list_channel_replies for thread replies.', true, 'ChannelMessage.Read.All', { ...paging, ...channelId, page_size: z.number().int().min(1).max(50).default(25) }, i => ({ url: page(`${channel(i)}/messages`, i) }), list),
  'microsoft_365.list_channel_replies': tool('Read replies to a Teams channel message.', true, 'ChannelMessage.Read.All', { ...paging, ...channelId, message_id: id, page_size: z.number().int().min(1).max(50).default(25) }, i => ({ url: page(`${channel(i)}/messages/${e(i.message_id)}/replies`, i) }), list),
  'microsoft_365.list_chats': tool('List your Teams chats.', true, 'Chat.Read', paging, i => ({ url: page('/me/chats', i) }), list),
  'microsoft_365.list_chat_messages': tool('Read messages in a Teams chat.', true, 'Chat.Read', { ...paging, chat_id: id, page_size: z.number().int().min(1).max(50).default(25) }, i => ({ url: page(`/chats/${e(i.chat_id)}/messages`, i) }), list),
  'microsoft_365.send_chat_message': tool('Send a message to an existing Teams chat. Verify the chat and content before sending.', false, 'ChatMessage.Send', { chat_id: id, body }, i => ({ url: `${base}/chats/${e(i.chat_id)}/messages`, method: 'POST', body: { body: i.body } })),
  'microsoft_365.send_channel_message': tool('Post a channel message or reply to a thread. Verify destination and content before sending.', false, 'ChannelMessage.Send', { ...channelId, message_id: id.optional(), body }, i => ({ url: `${base}${channel(i)}/messages${i.message_id ? '/' + e(i.message_id) + '/replies' : ''}`, method: 'POST', body: { body: i.body } })),
};
