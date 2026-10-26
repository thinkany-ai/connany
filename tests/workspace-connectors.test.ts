import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectorRuntime, restToolCatalog, toolNamePattern } from '../src/connectors/index.js';
import { connector } from '../src/connectors/catalog.js';
import { config, connectorClients } from './support.js';

const names = ['google_calendar','google_drive','google_sheets','google_docs','outlook'] as const;
const credential = { accessToken: 'access', refreshToken: 'refresh' };
function setup(respond: (url: string, init: RequestInit) => Response = () => Response.json({})) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const runtime = new ConnectorRuntime({ ...config, connectors: connectorClients(Object.fromEntries(names.map(n => [n, { clientId:'client', clientSecret:'secret' }]))) }, async (url, init) => {
    calls.push({ url: String(url), init: init!, body: init?.body && String(init.body).startsWith('{') ? JSON.parse(String(init.body)) : init?.body });
    return respond(String(url), init!);
  });
  return { runtime, calls };
}

test('all five connectors expose local tools with read/write metadata and JSON schemas', async () => {
  const { runtime, calls } = setup();
  const expected = [6,5,6,4,16];
  for (const [index, name] of names.entries()) {
    assert.equal(connector(name).auth, 'oauth');
    const tools = await runtime.tools(name, credential);
    assert.equal(tools.length, expected[index]);
    assert(tools.some(t => t.read_only)); assert(tools.some(t => !t.read_only));
    for (const t of tools) { assert(toolNamePattern.test(t.name)); assert.equal(t.input_schema.type, 'object'); assert(t.required_permissions?.length); }
  }
  assert.equal(calls.length, 0);
  assert.equal(restToolCatalog('google_drive').find(t => t.name.endsWith('trash_file'))?.read_only, false);
});

test('Google Workspace authorization requests service scopes, PKCE, offline access and distinct callbacks', async () => {
  const { runtime, calls } = setup(url => url.includes('userinfo') ? Response.json({ sub:'123',email:'me@example.com' }) : Response.json({ access_token:'new',expires_in:3600 }));
  const scopes = ['calendar.events','drive','spreadsheets','documents'];
  for (const [index, name] of names.slice(0,4).entries()) {
    const auth = new URL(runtime.authorizeUrl(name, 'state', 'verifier'));
    assert(auth.searchParams.get('scope')!.includes(`https://www.googleapis.com/auth/${scopes[index]}`));
    assert.equal(auth.searchParams.get('access_type'),'offline');
    assert.equal(auth.searchParams.get('code_challenge_method'),'S256');
    assert.equal(auth.searchParams.get('redirect_uri'),`http://localhost:3000/oauth/${name}/callback`);
    await runtime.exchange(name,'code','verifier');
    assert.equal(new URLSearchParams(String(calls.at(-1)!.body)).get('client_secret'),'secret');
    assert.equal((await runtime.refresh(name,credential)).refreshToken,'refresh');
    assert.equal((await runtime.identify(name,credential,{})).account_id,'123');
  }
});

test('Outlook auth, token refresh and profile handle personal and organizational email fields', async () => {
  const { runtime, calls } = setup(url => url.endsWith('/me') ? Response.json({ id:'ms1',mail:null,userPrincipalName:'me@example.com',displayName:'Me' }) : Response.json({ access_token:'new',refresh_token:'rotated',expires_in:3600 }));
  const auth = new URL(runtime.authorizeUrl('outlook','state','verifier'));
  assert.equal(auth.pathname,'/common/oauth2/v2.0/authorize');
  for (const scope of ['offline_access','User.Read','Mail.ReadWrite','Mail.Send','Calendars.ReadWrite']) assert(auth.searchParams.get('scope')!.includes(scope));
  await runtime.exchange('outlook','code','verifier');
  assert.equal(new URLSearchParams(String(calls[0].body)).get('code_verifier'),'verifier');
  assert.equal((await runtime.refresh('outlook',credential)).refreshToken,'rotated');
  assert.deepEqual(await runtime.identify('outlook',credential,{}),{ account_id:'ms1',account_name:'me@example.com',email:'me@example.com' });
  const before=calls.length; await runtime.revoke('outlook',credential); assert.equal(calls.length,before);
});

test('Calendar expands recurring events, preserves pagination and sends event updates', async () => {
  const { runtime, calls } = setup(() => Response.json({items:[],nextPageToken:'next'}));
  const result = await runtime.execute('google_calendar.list_events',{calendar_id:'me@example.com',page_token:'cursor',time_min:'2026-10-26T00:00:00+08:00'},credential);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('singleEvents'),'true'); assert.equal(url.searchParams.get('pageToken'),'cursor'); assert(url.pathname.includes('me%40example.com'));
  assert.deepEqual(result,{items:[],nextPageToken:'next'});
  const event={summary:'Meeting',start:{date:'2026-10-27'},end:{date:'2026-10-28'}};
  await runtime.execute('google_calendar.create_event',{event},credential);
  assert.deepEqual(calls[1].body,event);assert.equal(new URL(calls[1].url).searchParams.get('sendUpdates'),'all');
  await runtime.execute('google_calendar.update_event',{event_id:'event1',event:{summary:'Changed'}},credential);
  assert.equal(calls[2].init.method,'PATCH');assert.deepEqual(calls[2].body,{summary:'Changed'});
  await assert.rejects(() => runtime.execute('google_calendar.create_event',{event:{...event,start:{date:'invalid'}}},credential));
});

test('Drive queries encode user input, support shared drives and use trash rather than permanent deletion', async () => {
  const { runtime, calls } = setup();
  await runtime.execute('google_drive.list_files',{query:"name contains 'Q&A'",page_token:'a+b'},credential);
  const url = new URL(calls[0].url); assert.equal(url.searchParams.get('q'),"name contains 'Q&A'"); assert.equal(url.searchParams.get('pageToken'),'a+b'); assert.equal(url.searchParams.get('includeItemsFromAllDrives'),'true');
  await runtime.execute('google_drive.create_folder',{name:'Plans',parent_id:'root'},credential);
  assert.deepEqual(calls[1].body,{name:'Plans',mimeType:'application/vnd.google-apps.folder',parents:['root']});
  await runtime.execute('google_drive.trash_file',{file_id:'file1',trashed:false},credential);
  assert.equal(calls[2].init.method,'PATCH'); assert.deepEqual(calls[2].body,{trashed:false});
  await assert.rejects(() => runtime.execute('google_drive.get_file',{file_id:'../other'},credential));
});

test('Sheets writes preserve scalar types, default to RAW and correctly encode A1 ranges', async () => {
  const { runtime, calls } = setup();
  const input={spreadsheet_id:'sheet1',range:"'Q 1'!A1:C2",values:[['=1+1',2,true],[null,'你好',3]]};
  await runtime.execute('google_sheets.update_values',input,credential);
  assert.equal(calls[0].init.method,'PUT'); assert.equal(new URL(calls[0].url).searchParams.get('valueInputOption'),'RAW');
  assert.equal(decodeURIComponent(new URL(calls[0].url).pathname),"/v4/spreadsheets/sheet1/values/'Q 1'!A1:C2");
  assert.deepEqual(calls[0].body.values,input.values);
  await runtime.execute('google_sheets.append_values',{...input,value_input_option:'USER_ENTERED'},credential);
  assert.equal(calls[1].init.method,'POST');assert(calls[1].url.includes(':append?')); assert.equal(new URL(calls[1].url).searchParams.get('insertDataOption'),'INSERT_ROWS');
  await runtime.execute('google_sheets.clear_values',{spreadsheet_id:'sheet1',range:'A1'},credential);assert.deepEqual(calls[2].body,{});
  await assert.rejects(() => runtime.execute('google_sheets.update_values',{...input,values:[[{bad:true}]]},credential));
});

test('Docs supports tab-specific insertion and optimistic revision control', async () => {
  const { runtime, calls } = setup();
  await runtime.execute('google_docs.get_document',{document_id:'doc1'},credential);assert(calls[0].url.endsWith('?includeTabsContent=true'));
  await runtime.execute('google_docs.insert_text',{document_id:'doc1',tab_id:'t.0',text:'Hello',required_revision_id:'rev1'},credential);
  assert.deepEqual(calls[1].body,{requests:[{insertText:{text:'Hello',endOfSegmentLocation:{tabId:'t.0'}}}],writeControl:{requiredRevisionId:'rev1'}});
  await runtime.execute('google_docs.insert_text',{document_id:'doc1',text:'Hello',index:1},credential);
  assert.deepEqual(calls[2].body.requests,[{insertText:{text:'Hello',location:{index:1}}}]);
  await runtime.execute('google_docs.replace_text',{document_id:'doc1',find:'old',replace:'new',tab_ids:['t.0']},credential);
  assert.deepEqual(calls[3].body.requests,[{replaceAllText:{containsText:{text:'old',matchCase:true},replaceText:'new',tabsCriteria:{tabIds:['t.0']}}}]);
});

test('Outlook pagination accepts only the same Graph resource and never leaks bearer tokens', async () => {
  const next='https://graph.microsoft.com/v1.0/me/messages?$skip=25';
  const { runtime, calls } = setup(() => Response.json({value:[{id:'m1'}],'@odata.nextLink':next}));
  assert.deepEqual(await runtime.execute('outlook.list_messages',{},credential),{items:[{id:'m1'}],next_page_url:next});
  await runtime.execute('outlook.list_messages',{page_url:next},credential); assert.equal(calls[1].url,next);
  for (const page_url of ['https://evil.example/me/messages','https://graph.microsoft.com.evil.example/v1.0/me/messages','http://graph.microsoft.com/v1.0/me/messages','https://user@graph.microsoft.com/v1.0/me/messages','https://graph.microsoft.com/v1.0/users','https://graph.microsoft.com/v1.0/me/messages#x']) {
    await assert.rejects(() => runtime.execute('outlook.list_messages',{page_url},credential));
  }
  assert.equal(calls.length,2); assert.equal(new Headers(calls[1].init.headers).get('Authorization'),'Bearer access');
});

test('Outlook mail handles HTML, empty 202 responses, drafts and replies', async () => {
  const { runtime, calls } = setup(url => url.endsWith('/sendMail') || url.endsWith('/replyAll') ? new Response(null,{status:202}) : Response.json({body:{contentType:'html',content:'<p>Hello &amp; welcome</p>'}}));
  assert.equal((await runtime.execute('outlook.get_message',{message_id:'m1'},credential) as any).body,'Hello & welcome');
  const input={to:['a@example.com'],subject:'Hello',body:'世界'};
  assert.deepEqual(await runtime.execute('outlook.send_message',input,credential),{accepted:true});
  assert.deepEqual(calls[1].body.message.toRecipients,[{emailAddress:{address:'a@example.com'}}]);assert.equal(calls[1].body.message.body.contentType,'Text');
  await runtime.execute('outlook.create_draft',input,credential);assert(calls[2].url.endsWith('/messages')); assert.equal(calls[2].body.subject,'Hello');
  await runtime.execute('outlook.reply_message',{message_id:'m1',comment:'Thanks',reply_all:true},credential);assert(calls[3].url.endsWith('/replyAll'));assert.deepEqual(calls[3].body,{comment:'Thanks'});
  await assert.rejects(() => runtime.execute('outlook.send_message',{...input,to:['bad\r\naddress']},credential));
  await assert.rejects(() => runtime.execute('outlook.get_message',{message_id:'..'},credential));
});

test('Outlook calendar windows and event writes use Graph time zones; upstream errors survive', async () => {
  const { runtime, calls } = setup(() => new Response(null,{status:204}));
  await runtime.execute('outlook.list_events',{start_date_time:'2026-10-26T00:00:00Z',end_date_time:'2026-10-27T00:00:00Z'},credential);
  assert.equal(new URL(calls[0].url).searchParams.get('startDateTime'),'2026-10-26T00:00:00Z');
  const event={subject:'Meeting',start:{dateTime:'2026-10-26T10:00:00',timeZone:'China Standard Time'},end:{dateTime:'2026-10-26T11:00:00',timeZone:'China Standard Time'}};
  await runtime.execute('outlook.create_event',{event},credential);assert.deepEqual(calls[1].body,event);
  await runtime.execute('outlook.delete_event',{event_id:'event1'},credential);assert.equal(calls[2].init.method,'DELETE');
  const failed=setup(() => Response.json({error:{code:'ErrorAccessDenied',message:'Access is denied.'}},{status:403}));
  await assert.rejects(() => failed.runtime.execute('outlook.get_profile',{},credential),(error:any) => error.details.upstream_message === 'Access is denied.');
});
