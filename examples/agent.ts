/** CLI integration demo: opens no fake accounts; requires real configured OAuth apps. */
import { Connany, type Provider } from '../sdk/client.js';
const provider = process.argv[2] as Provider;
if (!['notion','github','linear'].includes(provider)) throw new Error('Usage: npm run example:agent -- notion|github|linear');
if (!process.env.CONNANY_API_KEY) throw new Error('Set CONNANY_API_KEY to your project key.');
const connany = new Connany({ baseUrl: process.env.CONNANY_BASE_URL || 'http://localhost:3000', apiKey: process.env.CONNANY_API_KEY });
// In a real product, derive this from the authenticated server-side user session.
const user = process.env.CONNANY_USER_ID || 'demo-user';
const session = await connany.createSession({ external_user_id: user, provider });
console.log(`Open this URL in your browser (expires in 15 minutes):\n${session.connect_url}`);
while (Date.now() < Date.parse(session.expires_at)) {
  await new Promise(resolve => setTimeout(resolve, 5000));
  const status = await connany.getSession(session.id, user);
  if (status.status === 'error' || status.status === 'expired') throw new Error(`Connection failed: ${status.error_code || status.status}`);
  if (status.status !== 'connected' || !status.connection_id) continue;
  const connection = await connany.getConnection(status.connection_id, user);
  console.log(`Connected: ${connection.identity.account_name}`);
  if(provider !== 'github') {
    console.log(JSON.stringify(await connany.discoverActions({provider,external_user_id:user,connection_id:connection.id}),null,2));
    process.exit(0);
  }
  const action = { github: 'github.installations.list' }[provider];
  const result = await connany.execute({ external_user_id: user, connection_id: connection.id, action, input: { limit: 5 } });
  console.log(JSON.stringify(result.data, null, 2));
  if (provider === 'github' && connection.identity.needs_installation) console.log('Install the GitHub App and select repositories, then list installations again.');
  process.exit(0);
}
throw new Error('Connection session expired. Run this command again.');
