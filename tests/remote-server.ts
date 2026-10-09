import type {HostLookup} from '../src/connectors/remote-mcp.js';

export const publicLookup:HostLookup=async()=>[{address:'93.184.216.34',family:4}];

/** A standard OAuth-protected MCP server, the shape of the ones users bring (resource on /mcp, AS on the origin). */
export function fakeServer(overrides:{probe?:()=>Response;resource?:object|null;auth?:object|null}={}){
 const seen:string[]=[];
 const fetcher:typeof fetch=async(input,init)=>{
  const url=String(input);seen.push(`${init?.method||'GET'} ${url}`);
  if(url==='https://feeds.example/mcp'&&!new Headers(init?.headers).get('Authorization'))
   return overrides.probe?.()??new Response('{}',{status:401,headers:{'WWW-Authenticate':'Bearer resource_metadata="https://feeds.example/.well-known/oauth-protected-resource/mcp"'}});
  if(url==='https://feeds.example/.well-known/oauth-protected-resource/mcp')
   return overrides.resource===null?new Response('',{status:404}):Response.json(overrides.resource??{resource:'https://feeds.example/mcp',authorization_servers:['https://feeds.example'],scopes_supported:['feeds'],resource_name:'Feeds'});
  if(url==='https://feeds.example/.well-known/oauth-authorization-server')
   return overrides.auth===null?new Response('',{status:404}):Response.json(overrides.auth??{issuer:'https://feeds.example',authorization_endpoint:'https://feeds.example/oauth/authorize',token_endpoint:'https://feeds.example/oauth/token',registration_endpoint:'https://feeds.example/oauth/register',code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none']});
  if(url==='https://feeds.example/oauth/register')return Response.json({client_id:'feeds-client',token_endpoint_auth_method:'none'},{status:201});
  if(url==='https://feeds.example/oauth/token')return Response.json({access_token:'at',refresh_token:'rt',expires_in:3600});
  if(url==='https://feeds.example/mcp'){
   const body=JSON.parse(String(init?.body));
   if(body.method==='initialize')return Response.json({jsonrpc:'2.0',id:body.id,result:{protocolVersion:'2025-06-18'}});
   if(body.method==='notifications/initialized')return new Response(null,{status:202});
   if(body.method==='tools/list')return Response.json({jsonrpc:'2.0',id:body.id,result:{tools:[{name:'list_feeds',description:'List feeds',inputSchema:{type:'object'},annotations:{readOnlyHint:true}},{name:'add_feed',description:'Add a feed',inputSchema:{type:'object'}}]}});
   if(body.method==='tools/call')return Response.json({jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:`called ${body.params.name}`}]}});
  }
  return new Response('',{status:404});
 };
 return {fetcher,seen};
}

