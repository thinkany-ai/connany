/** CLI integration demo: opens no fake accounts; requires real configured OAuth apps. */
import { Connany, type ConnectorName } from '../sdk/client.js';
const connector = process.argv[2] as ConnectorName;
if (!['notion','github','linear'].includes(connector)) throw new Error('Usage: npm run example:agent -- notion|github|linear');
if (!process.env.CONNANY_API_KEY) throw new Error('Set CONNANY_API_KEY to your project key.');
const connany = new Connany({ baseUrl: process.env.CONNANY_BASE_URL || 'http://localhost:3000', apiKey: process.env.CONNANY_API_KEY });
// In a real product, derive this from the authenticated server-side user session.
const user = process.env.CONNANY_USER_ID || 'demo-user';
const session = await connany.createSession(connector, { external_user_id: user });
console.log(`Open this URL in your browser (expires in 15 minutes):\n${session.connect_url}`);
while (Date.now() < Date.parse(session.expires_at)) {
  await new Promise(resolve => setTimeout(resolve, 5000));
  const status = await connany.getSession(connector, session.id, user);
  if (status.status === 'error' || status.status === 'expired') throw new Error(`Connection failed: ${status.error_code || status.status}`);
  if (status.status !== 'connected' || !status.connection_id) continue;
  const connection = await connany.getConnection(status.connection_id, user);
  console.log(`Connected: ${connection.identity.account_name}`);
  if(connector !== 'github') {
    console.log(JSON.stringify(await connany.listTools(connection.id, user),null,2));
    process.exit(0);
  }
  const result = await connany.callTool(connection.id, user, 'github.installations.list', { limit: 5 });
  console.log(JSON.stringify(result.data, null, 2));
  if (connection.needs_access) console.log(`Grant resource access at ${(await connany.listAccess(connection.id, user)).add_url}, then list access again.`);
  process.exit(0);
}
throw new Error('Connection session expired. Run this command again.');
