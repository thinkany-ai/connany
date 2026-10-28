import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConnectorRuntime,toolNamePattern} from '../src/connectors/index.js';
import {config,connectorClients} from './support.js';

const clients=connectorClients({gmail:{clientId:'gc',clientSecret:'gs'},zoho_mail:{clientId:'zc',clientSecret:'zs'}});
const calls:{url:string;init:RequestInit}[]=[];
const runtimeWith=(respond:(url:string,init:RequestInit)=>Response)=>{calls.length=0;return new ConnectorRuntime({...config,connectors:clients},async(url,init)=>{calls.push({url:String(url),init:init!});return respond(String(url),init!);});};
const credential={accessToken:'at',refreshToken:'rt'};
const b64=(text:string)=>Buffer.from(text).toString('base64url');
const raw=(call:{init:RequestInit})=>{const body=JSON.parse(String(call.init.body));return Buffer.from(body.raw??body.message.raw,'base64url').toString('utf8');};

test('mail tool catalogs are built in and mark writes',async()=>{
 const runtime=runtimeWith(()=>{throw new Error('no network');});
 const gmail=await runtime.tools('gmail',credential);const zoho=await runtime.tools('zoho_mail',credential);
 assert.deepEqual(gmail.filter(t=>!t.read_only).map(t=>t.name),['gmail.create_draft','gmail.send_draft','gmail.send_message','gmail.modify_labels']);
 assert.deepEqual(zoho.filter(t=>!t.read_only).map(t=>t.name),['zoho_mail.send_message','zoho_mail.reply_message','zoho_mail.create_draft','zoho_mail.mark_messages','zoho_mail.move_messages','zoho_mail.delete_message']);
 for(const tool of [...gmail,...zoho]){assert(toolNamePattern.test(tool.name),tool.name);assert.equal(tool.input_schema.type,'object');}
 assert.equal(calls.length,0);
 const auth=new URL(runtime.authorizeUrl('gmail','state','verifier'));
 assert.equal(auth.searchParams.get('scope'),'openid email https://www.googleapis.com/auth/gmail.modify');assert.equal(auth.searchParams.get('access_type'),'offline');
});

test('Gmail search returns summaries and reads decode the text body',async()=>{
 const message={id:'m1',threadId:'t1',labelIds:['INBOX','UNREAD'],snippet:'Hi',payload:{headers:[{name:'From',value:'Alice <alice@example.com>'},{name:'Subject',value:'Plan'},{name:'Date',value:'Thu, 15 Oct 2026 09:00:00 +0800'}],mimeType:'multipart/mixed',parts:[
  {mimeType:'multipart/alternative',parts:[{mimeType:'text/plain',body:{data:b64('Hello 世界\nBye')}},{mimeType:'text/html',body:{data:b64('<p>Hello</p>')}}]},
  {mimeType:'application/pdf',filename:'plan.pdf',body:{attachmentId:'a1',size:2048}}]}};
 const runtime=runtimeWith(url=>url.includes('/messages?')?Response.json({messages:[{id:'m1',threadId:'t1'}],nextPageToken:'p2',resultSizeEstimate:9}):Response.json(message));
 const found:any=await runtime.execute('gmail.search_messages',{query:'from:alice is:unread',label_ids:['INBOX'],max_results:5},credential);
 const list=new URL(calls[0].url);assert.equal(list.searchParams.get('q'),'from:alice is:unread');assert.deepEqual(list.searchParams.getAll('labelIds'),['INBOX']);assert.equal(list.searchParams.get('maxResults'),'5');
 assert.match(calls[1].url,/\/messages\/m1\?format=metadata&metadataHeaders=From/);
 assert.deepEqual(found.messages[0],{id:'m1',thread_id:'t1',from:'Alice <alice@example.com>',to:undefined,subject:'Plan',date:'Thu, 15 Oct 2026 09:00:00 +0800',snippet:'Hi',label_ids:['INBOX','UNREAD'],unread:true});
 assert.equal(found.next_page_token,'p2');
 const read:any=await runtime.execute('gmail.get_message',{message_id:'m1',max_body_chars:100},credential);
 assert.equal(read.body,'Hello 世界\nBye');assert.deepEqual(read.attachments,[{filename:'plan.pdf',mime_type:'application/pdf',size:2048}]);
 const html:any=runtimeWith(()=>Response.json({...message,payload:{mimeType:'text/html',body:{data:b64('<style>p{}</style><p>One &amp; two</p><p>Three</p>')}}}));
 assert.equal(((await html.execute('gmail.get_message',{message_id:'m1'},credential)) as any).body,'One & two\nThree');
});

test('Gmail sends RFC 5322 messages, threads replies and rejects header injection',async()=>{
 const runtime=runtimeWith(url=>url.includes('format=metadata')?Response.json({id:'m1',threadId:'t1',payload:{headers:[{name:'Message-ID',value:'<abc@mail.gmail.com>'},{name:'Subject',value:'Plan'}]}}):Response.json({id:'m2',threadId:'t1',labelIds:['SENT'],message:{id:'m2',threadId:'t1'}}));
 assert.deepEqual(await runtime.execute('gmail.send_message',{to:['bob@example.com'],subject:'季度计划',body:'Hello'},credential),{message_id:'m2',thread_id:'t1',label_ids:['SENT']});
 assert.equal(calls[0].url,'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
 const sent=raw(calls[0]);
 assert.match(sent,/^To: bob@example.com\r\n/);assert.match(sent,new RegExp(`Subject: =\\?UTF-8\\?B\\?${Buffer.from('季度计划').toString('base64').replace(/[+/=]/g,'\\$&')}\\?=`));
 assert.equal(Buffer.from(sent.split('\r\n\r\n')[1],'base64').toString(),'Hello');
 await runtime.execute('gmail.create_draft',{to:['bob@example.com'],body:'Sounds good',reply_to_message_id:'m1'},credential);
 const draft=JSON.parse(String(calls[2].init.body));assert.equal(calls[2].url,'https://gmail.googleapis.com/gmail/v1/users/me/drafts');assert.equal(draft.message.threadId,'t1');
 assert.match(raw(calls[2]),/In-Reply-To: <abc@mail.gmail.com>\r\nReferences: <abc@mail.gmail.com>\r\nSubject: Re: Plan\r\n/);
 calls.length=0;
 await assert.rejects(()=>runtime.execute('gmail.send_message',{to:['bob@example.com'],body:'x'},credential),{name:'ZodError'});
 await assert.rejects(()=>runtime.execute('gmail.send_message',{to:['bob@example.com\r\nBcc: eve@example.com'],subject:'x',body:'x'},credential));
 await assert.rejects(()=>runtime.execute('gmail.send_message',{to:['bob@example.com'],subject:'x\r\nBcc: eve@example.com',body:'x'},credential));
 assert.equal(calls.length,0);
});

test('Zoho Mail authorizes at the user data center and keeps it for refresh, identity, tools and revocation',async()=>{
 const runtime=runtimeWith(url=>url.includes('/oauth/v2/token/revoke')?Response.json({status:'success'}):url.endsWith('/token')?Response.json({access_token:'zat',refresh_token:'zrt',expires_in:3600,api_domain:'https://www.zohoapis.eu',token_type:'Bearer'})
  :url.includes('/oauth/user/info')?Response.json({ZUID:778,Email:'kim@example.eu',Display_Name:'Kim'})
  :url.endsWith('/api/accounts')?Response.json({status:{code:200,description:'success'},data:[{accountId:'1234',primaryEmailAddress:'kim@example.eu',displayName:'Kim',sendMailDetails:[{fromAddress:'kim@example.eu'},{fromAddress:'kim@example.eu'}]}]})
  :Response.json({status:{code:200},data:[]}));
 const auth=new URL(runtime.authorizeUrl('zoho_mail','state','verifier'));
 assert.equal(auth.origin+auth.pathname,'https://accounts.zoho.com/oauth/v2/auth');assert.equal(auth.searchParams.get('access_type'),'offline');assert.match(auth.searchParams.get('scope')!,/^ZohoMail\.accounts\.READ,/);
 const {credential:fresh}=await runtime.exchange('zoho_mail','code','verifier','https://accounts.zoho.eu');
 assert.equal(calls[0].url,'https://accounts.zoho.eu/oauth/v2/token');assert.equal(new URLSearchParams(String(calls[0].init.body)).get('client_secret'),'zs');
 assert.equal(fresh.server,'https://accounts.zoho.eu');
 assert.deepEqual(await runtime.identify('zoho_mail',fresh,{}),{account_id:'778',account_name:'kim@example.eu',email:'kim@example.eu'});
 assert.equal(calls[1].url,'https://accounts.zoho.eu/oauth/user/info');assert.equal(new Headers(calls[1].init.headers).get('Authorization'),'Zoho-oauthtoken zat');
 const refreshed=await runtime.refresh('zoho_mail',fresh);assert.equal(calls[2].url,'https://accounts.zoho.eu/oauth/v2/token');assert.equal(refreshed.server,'https://accounts.zoho.eu');assert.equal(refreshed.refreshToken,'zrt');
 assert.deepEqual(await runtime.execute('zoho_mail.list_accounts',{},fresh),{accounts:[{account_id:'1234',email:'kim@example.eu',display_name:'Kim',send_from:['kim@example.eu']}]});
 assert.equal(calls[3].url,'https://mail.zoho.eu/api/accounts');
 await runtime.revoke('zoho_mail',fresh);assert.equal(calls[4].url,'https://accounts.zoho.eu/oauth/v2/token/revoke?token=zrt');assert.equal(calls[4].init.body,undefined);
 // Without a data center Zoho's US servers apply; unknown servers are refused before any request.
 await runtime.exchange('zoho_mail','code','verifier');assert.equal(calls.at(-1)!.url,'https://accounts.zoho.com/oauth/v2/token');
 calls.length=0;
 await assert.rejects(()=>runtime.exchange('zoho_mail','code','verifier','https://evil.example'),{code:'invalid_accounts_server'});
 await assert.rejects(()=>runtime.execute('zoho_mail.list_accounts',{},{accessToken:'x',server:'https://evil.example'}),{code:'invalid_accounts_server'});
 assert.equal(calls.length,0);
 // Other connectors ignore the parameter.
 await runtime.exchange('gmail','code','verifier','https://accounts.zoho.eu');assert.equal(calls.at(-1)!.url,'https://oauth2.googleapis.com/token');
});

test('Zoho Mail lists, reads and sends with the account address and explains errors',async()=>{
 const server='https://accounts.zoho.com.au';const zoho={accessToken:'zat',server};
 const runtime=runtimeWith(url=>{
  if(url.endsWith('/folders/77/messages/9001/content'))return Response.json({status:{code:404,description:'Invalid Input'},data:{errorCode:'INVALID_FOLDER',moreInfo:'Folder does not exist'}},{status:404});
  if(url.includes('/messages/view')||url.includes('/messages/search'))return Response.json({data:[{messageId:'9001',folderId:'55',threadId:'9000',subject:'Q3 &amp; Q4',fromAddress:'alice@example.com',toAddress:'&lt;kim@example.com&gt;',summary:'See attached',receivedTime:'1760500000000',hasAttachment:'1'}]});
  if(url.endsWith('/details'))return Response.json({data:{subject:'Q3',fromAddress:'alice@example.com',toAddress:'&lt;kim@example.com&gt;',receivedTime:'1760500000000'}});
  if(url.endsWith('/content'))return Response.json({data:{messageId:'9001',content:'<div>Hi Kim,<br>numbers below.</div>'}});
  if(url.endsWith('/api/accounts/1234'))return Response.json({data:{accountId:'1234',primaryEmailAddress:'kim@example.com'}});
  return Response.json({status:{code:200,description:'success'},data:{messageId:9002}});
 });
 const list:any=await runtime.execute('zoho_mail.list_messages',{account_id:'1234',status:'unread',limit:1},zoho);
 const view=new URL(calls[0].url);assert.equal(view.origin+view.pathname,'https://mail.zoho.com.au/api/accounts/1234/messages/view');assert.equal(view.searchParams.get('status'),'unread');assert.equal(view.searchParams.get('folderId'),null);
 assert.deepEqual(list.messages[0],{message_id:'9001',folder_id:'55',thread_id:'9000',from:'alice@example.com',sender:undefined,to:'<kim@example.com>',subject:'Q3 & Q4',summary:'See attached',received_at:new Date(1760500000000).toISOString(),has_attachment:true});
 assert.equal(list.next_start,2);
 await runtime.execute('zoho_mail.search_messages',{account_id:'1234',search_key:'sender:alice@example.com::has:attachment'},zoho);
 assert.equal(new URL(calls[1].url).searchParams.get('searchKey'),'sender:alice@example.com::has:attachment');
 const read:any=await runtime.execute('zoho_mail.get_message',{account_id:'1234',folder_id:'55',message_id:'9001'},zoho);
 assert.equal(read.body,'Hi Kim,\nnumbers below.');assert.equal(read.subject,'Q3');assert.equal(read.message_id,'9001');
 calls.length=0;
 assert.deepEqual(await runtime.execute('zoho_mail.send_message',{account_id:'1234',to:['alice@example.com','bob@example.com'],subject:'Re: Q3',body:'Thanks'},zoho),{message_id:'9002',status:'success'});
 assert.equal(calls[0].url,'https://mail.zoho.com.au/api/accounts/1234');
 assert.deepEqual(JSON.parse(String(calls[1].init.body)),{fromAddress:'kim@example.com',toAddress:'alice@example.com,bob@example.com',subject:'Re: Q3',content:'Thanks',mailFormat:'plaintext'});
 await runtime.execute('zoho_mail.reply_message',{account_id:'1234',message_id:'9001',from_address:'kim@example.com',to:['alice@example.com'],subject:'Re: Q3',body:'Ok',reply_all:true},zoho);
 assert.equal(calls[2].url,'https://mail.zoho.com.au/api/accounts/1234/messages/9001');assert.equal(JSON.parse(String(calls[2].init.body)).action,'replyall');
 await runtime.execute('zoho_mail.create_draft',{account_id:'1234',from_address:'kim@example.com',to:['alice@example.com'],subject:'Draft',body:'<b>x</b>',html:true},zoho);
 const draft=JSON.parse(String(calls[3].init.body));assert.equal(draft.mode,'draft');assert.equal(draft.mailFormat,'html');
 calls.length=0;
 assert.deepEqual(await runtime.execute('zoho_mail.mark_messages',{account_id:'1234',message_ids:['1716466818827107400','9001'],action:'spam'},zoho),{updated:2});
 assert.equal(calls[0].url,'https://mail.zoho.com.au/api/accounts/1234/updatemessage');assert.equal(calls[0].init.method,'PUT');
 assert.deepEqual(JSON.parse(String(calls[0].init.body)),{mode:'moveToSpam',messageId:['1716466818827107400','9001']});
 await runtime.execute('zoho_mail.mark_messages',{account_id:'1234',message_ids:['9001'],action:'read'},zoho);assert.equal(JSON.parse(String(calls[1].init.body)).mode,'markAsRead');
 assert.deepEqual(await runtime.execute('zoho_mail.move_messages',{account_id:'1234',message_ids:['9001'],destination_folder_id:'55'},zoho),{moved:1});
 assert.deepEqual(JSON.parse(String(calls[2].init.body)),{mode:'moveMessage',destfolderId:'55',messageId:['9001']});
 assert.deepEqual(await runtime.execute('zoho_mail.delete_message',{account_id:'1234',folder_id:'55',message_id:'9001'},zoho),{message_id:'9001',deleted:'moved_to_trash'});
 assert.equal(calls[3].url,'https://mail.zoho.com.au/api/accounts/1234/folders/55/messages/9001');assert.equal(calls[3].init.method,'DELETE');
 await runtime.execute('zoho_mail.delete_message',{account_id:'1234',folder_id:'55',message_id:'9001',permanent:true},zoho);assert.equal(calls[4].url,'https://mail.zoho.com.au/api/accounts/1234/folders/55/messages/9001?expunge=true');
 await assert.rejects(()=>runtime.execute('zoho_mail.mark_messages',{account_id:'1234',message_ids:['9001'],action:'delete'},zoho));
 await assert.rejects(()=>runtime.execute('zoho_mail.get_message',{account_id:'1234',folder_id:'77',message_id:'9001'},zoho),(error:any)=>{assert.equal(error.details.upstream_message,'Folder does not exist');return true;});
 await assert.rejects(()=>runtime.execute('zoho_mail.send_message',{account_id:'1234',to:['a@example.com,b@example.com'],subject:'x',body:'x'},zoho));
});
