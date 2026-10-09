import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConnectorRuntime,restToolCatalog,toolNamePattern} from '../src/connectors/index.js';
import {config,connectorClients} from './support.js';

const clients=connectorClients({google_search_console:{clientId:'gc',clientSecret:'gs'},google_analytics:{clientId:'gc',clientSecret:'gs'},github:{clientId:'g-client',clientSecret:'g-secret'}});
const calls:{url:string;init:RequestInit}[]=[];
const runtimeWith=(respond:(url:string,init:RequestInit)=>Response)=>{calls.length=0;return new ConnectorRuntime({...config,connectors:clients},async(url,init)=>{calls.push({url:String(url),init:init!});return respond(String(url),init!);});};
const credential={accessToken:'at',refreshToken:'rt'};

test('Google connectors authorize offline with PKCE, read-only scopes and no resource indicator',()=>{
 const runtime=runtimeWith(()=>Response.json({}));
 const gsc=new URL(runtime.authorizeUrl('google_search_console','state','verifier'));
 assert.equal(gsc.origin+gsc.pathname,'https://accounts.google.com/o/oauth2/v2/auth');
 assert.equal(gsc.searchParams.get('scope'),'openid email https://www.googleapis.com/auth/webmasters.readonly');
 assert.equal(gsc.searchParams.get('access_type'),'offline');assert.equal(gsc.searchParams.get('prompt'),'consent');
 assert.equal(gsc.searchParams.get('code_challenge_method'),'S256');assert.equal(gsc.searchParams.get('redirect_uri'),'http://localhost:3000/oauth/google_search_console/callback');
 assert.equal(gsc.searchParams.get('resource'),null);
 assert.match(new URL(runtime.authorizeUrl('google_analytics','s','v')).searchParams.get('scope')!,/analytics\.readonly$/);
 // GitHub moved to the same catalog-driven path and keeps account selection.
 const github=new URL(runtime.authorizeUrl('github','s','v'));
 assert.equal(github.origin+github.pathname,'https://github.com/login/oauth/authorize');assert.equal(github.searchParams.get('prompt'),'select_account');assert.equal(github.searchParams.get('scope'),null);
});

test('Google tokens exchange with the client secret, keep the refresh token on refresh, identify by userinfo and revoke',async()=>{
 const runtime=runtimeWith(url=>url.includes('userinfo')?Response.json({sub:'1099',email:'mike@example.com'}):url.includes('/token')?Response.json({access_token:'at2',expires_in:3599,scope:'openid https://www.googleapis.com/auth/webmasters.readonly',token_type:'Bearer'}):new Response(null,{status:200}));
 const {credential:fresh}=await runtime.exchange('google_search_console','code','verifier');
 const fields=new URLSearchParams(String(calls[0].init.body));
 assert.equal(calls[0].url,'https://oauth2.googleapis.com/token');assert.equal(fields.get('client_secret'),'gs');assert.equal(fields.get('code_verifier'),'verifier');
 assert.equal(fresh.accessToken,'at2');assert(fresh.expiresAt);
 assert.equal((await runtime.refresh('google_search_console',credential)).refreshToken,'rt');
 assert.deepEqual(await runtime.identify('google_search_console',credential,{}),{account_id:'1099',account_name:'mike@example.com',email:'mike@example.com'});
 await runtime.revoke('google_analytics',credential);
 assert.equal(calls.at(-1)!.url,'https://oauth2.googleapis.com/revoke');assert.equal(String(calls.at(-1)!.init.body),'token=rt');
 await assert.rejects(()=>runtimeWith(()=>Response.json({email:'x@example.com'})).identify('google_analytics',credential,{}),{code:'invalid_upstream_identity'});
});

test('Google tool catalogs are built in, read-only and addressable by the MCP server',async()=>{
 const runtime=runtimeWith(()=>{throw new Error('no network');});
 const gsc=await runtime.tools('google_search_console',credential);
 assert.deepEqual(gsc.map(t=>t.name),['google_search_console.list_sites','google_search_console.query_search_analytics','google_search_console.list_sitemaps','google_search_console.inspect_url']);
 const ga=await runtime.tools('google_analytics',credential);
 assert.equal(ga.length,5);
 for(const tool of [...gsc,...ga]){assert(toolNamePattern.test(tool.name),tool.name);assert.equal(tool.read_only,true);assert.equal(tool.input_schema.type,'object');}
 assert.equal(calls.length,0);
 assert.equal(restToolCatalog('github').length,18);
});

test('Search Console tools encode properties, send filters and return rows keyed by dimension',async()=>{
 const runtime=runtimeWith(url=>url.endsWith('/sites')?Response.json({siteEntry:[{siteUrl:'sc-domain:example.com',permissionLevel:'siteOwner'}]}):Response.json({rows:[{keys:['connany','https://example.com/'],clicks:3,impressions:40,ctr:0.075,position:4.2}],responseAggregationType:'byPage'}));
 assert.deepEqual(await runtime.execute('google_search_console.list_sites',{},credential),{sites:[{site_url:'sc-domain:example.com',permission_level:'siteOwner'}]});
 assert.equal(new Headers(calls[0].init.headers).get('Authorization'),'Bearer at');
 const result:any=await runtime.execute('google_search_console.query_search_analytics',{site_url:'sc-domain:example.com',start_date:'2026-09-01',end_date:'2026-09-30',dimensions:['query','page'],filters:[{dimension:'country',expression:'jpn'}],row_limit:1},credential);
 assert.equal(calls[1].url,'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query');
 const body=JSON.parse(String(calls[1].init.body));
 assert.deepEqual(body.dimensionFilterGroups,[{groupType:'and',filters:[{dimension:'country',operator:'equals',expression:'jpn'}]}]);
 assert.equal(body.type,'web');assert.equal(body.rowLimit,1);
 assert.deepEqual(result.rows,[{query:'connany',page:'https://example.com/',clicks:3,impressions:40,ctr:0.075,position:4.2}]);
 assert.equal(result.next_start_row,1);
 await runtime.execute('google_search_console.inspect_url',{site_url:'https://example.com/',url:'https://example.com/a'},credential);
 assert.deepEqual(JSON.parse(String(calls[2].init.body)),{inspectionUrl:'https://example.com/a',siteUrl:'https://example.com/',languageCode:'en-US'});
 // Invalid input never reaches Google.
 await assert.rejects(()=>runtime.execute('google_search_console.query_search_analytics',{site_url:'example.com',start_date:'2026-09-01',end_date:'2026-09-30'},credential));
 await assert.rejects(()=>runtime.execute('google_search_console.query_search_analytics',{site_url:'sc-domain:example.com',start_date:'last week',end_date:'2026-09-30'},credential));
 assert.equal(calls.length,3);
});

test('Analytics reports normalize property IDs, convert numeric metrics and page with offset',async()=>{
 const runtime=runtimeWith(url=>url.endsWith('/metadata')?Response.json({dimensions:[{apiName:'country',uiName:'Country',category:'Geography'},{apiName:'customEvent:plan',uiName:'Plan',customDefinition:true}],metrics:[{apiName:'sessions',uiName:'Sessions',type:'TYPE_INTEGER'}]})
  :Response.json({dimensionHeaders:[{name:'country'}],metricHeaders:[{name:'sessions',type:'TYPE_INTEGER'},{name:'bounceRate',type:'TYPE_FLOAT'}],rows:[{dimensionValues:[{value:'Japan'}],metricValues:[{value:'120'},{value:'0.42'}]}],rowCount:5,metadata:{currencyCode:'USD',timeZone:'Asia/Tokyo'}}));
 const report:any=await runtime.execute('google_analytics.run_report',{property_id:'properties/123',metrics:['sessions','bounceRate'],dimensions:['country'],limit:1},credential);
 assert.equal(calls[0].url,'https://analyticsdata.googleapis.com/v1beta/properties/123:runReport');
 const body=JSON.parse(String(calls[0].init.body));
 assert.deepEqual(body.dateRanges,[{startDate:'28daysAgo',endDate:'yesterday'}]);assert.deepEqual(body.metrics,[{name:'sessions'},{name:'bounceRate'}]);assert.equal(body.metricAggregations,undefined);
 assert.deepEqual(report.rows,[{country:'Japan',sessions:120,bounceRate:0.42}]);assert.equal(report.row_count,5);assert.equal(report.next_offset,1);
 const custom:any=await runtime.execute('google_analytics.get_metadata',{property_id:'123',custom_only:true},credential);
 assert.deepEqual(custom,{dimensions:[{api_name:'customEvent:plan',name:'Plan',category:undefined,custom:true}],metrics:[]});
 await runtime.execute('google_analytics.run_realtime_report',{property_id:'123',metrics:['activeUsers']},credential);
 assert.deepEqual(JSON.parse(String(calls[2].init.body)).minuteRanges,[{startMinutesAgo:29,endMinutesAgo:0}]);
 await assert.rejects(()=>runtime.execute('google_analytics.run_report',{property_id:'abc',metrics:['sessions']},credential));
 await assert.rejects(()=>runtime.execute('google_analytics.run_report',{property_id:'123',metrics:[]},credential));
});

test('Google API errors keep their explanation for the agent',async()=>{
 const runtime=runtimeWith(()=>Response.json({error:{code:403,message:'User does not have sufficient permissions for this property.',status:'PERMISSION_DENIED'}},{status:403}));
 await assert.rejects(()=>runtime.execute('google_analytics.get_property',{property_id:'123'},credential),(error:any)=>{
  assert.equal(error.code,'upstream_error');assert.equal(error.details.upstream_status,403);
  assert.equal(error.details.upstream_message,'User does not have sufficient permissions for this property.');return true;
 });
 await assert.rejects(()=>runtimeWith(()=>Response.json({error:{code:401,message:'Invalid Credentials'}},{status:401})).execute('google_search_console.list_sites',{},credential),{status:401});
});
