# discord-test-server

**A local fake Discord for end-to-end tests: API v10 REST, the Gateway, OAuth2, interactions and the CDN.**\
Test your bot and your dashboard offline: no Discord account, no real servers, no tokens to leak.

[![Discord API v10](https://img.shields.io/badge/Discord%20API-v10-5865f2?logo=discord&logoColor=white)](https://discord.com/developers/docs)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

[Install](#install) · [Quick start](#quick-start) · [Recipes](#recipes) · [Control API](#control-api) ·
[What matches Discord](#what-matches-discord) · [Assumptions](#assumptions)

---

## What you can test

- **Moderation**: kicks, bans with message deletion, bulk bans, timeouts up to 28 days, role
  changes, bulk message deletion, with Discord's permission maths, role hierarchy and error codes
  (`50013`, `50001`, `10007`, `50034`, `50035`, `500000`, …).
- **The audit log**: every write leaves the entry Discord would leave, with the actor and the
  `X-Audit-Log-Reason`, and sends `GUILD_AUDIT_LOG_ENTRY_CREATE`.
- **The gateway**: `HELLO`, `IDENTIFY`, `READY`, `GUILD_CREATE`, heartbeats, close codes, sharding,
  `RESUME` with replay, `RECONNECT`, `INVALID_SESSION`, intent filtering and the message-content
  rules. A real `@discordjs/ws` client connects to it unchanged.
- **Interactions**: slash commands, buttons and modals delivered as `INTERACTION_CREATE`, the
  3-second deadline, 15-minute follow-ups, ephemeral replies, guild and user installs, and a record
  of what the user saw ("This interaction failed" included).
- **Sign-in and install**: `/oauth2/authorize` (auto-approve or a consent page), code exchange,
  refresh, revoke, and bot install with the requested permissions.
- **Monetization**: SKUs, entitlements (incl. test entitlements), subscriptions and their events.
- **Bad days**: rate limits (per route and global), 5xx, dropped responses after a write, slow
  responses, closed or invalidated gateway sessions, expired interaction tokens, permissions that
  change between two calls, and a staff member who deletes the channels.
- **Time**: a clock the test controls, so message age, timeouts, token expiry and rate-limit windows
  are testable.

It never talks to Discord. Everything is in memory and gone when the process ends.

## Install

```sh
npm install --save-dev discord-test-server
```

Node 20 or newer. One dependency (`ws`).

## Quick start

From the command line, with a seeded demo world:

```sh
npx discord-test-server --demo
```

```
discord-test-server listening on http://127.0.0.1:8787
  REST     http://127.0.0.1:8787/api/v10      (discord.js: rest.api = http://127.0.0.1:8787/api)
  Gateway  ws://127.0.0.1:8787/gateway
  OAuth2   http://127.0.0.1:8787/oauth2/authorize
  CDN      http://127.0.0.1:8787/cdn
  Control  http://127.0.0.1:8787/_fake
Demo world
  ModBot    app 1569…  token MTU2…
  ...
```

From code, in a test:

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDiscord } from 'discord-test-server';

const fake = await createFakeDiscord({ port: 0, clock: 'manual' });
after(() => fake.close());

test('the bot bans a spammer', async () => {
  const c = fake.control;
  const owner = c.createUser({ username: 'owner' });
  const spammer = c.createUser({ username: 'spammer' });
  const app = c.createApplication({ name: 'ModBot', privilegedIntents: { guildMembers: true, messageContent: true } });
  const guild = c.createGuild({ name: 'Test', ownerId: owner.id });
  c.addMember({ guildId: guild.id, userId: spammer.id });
  c.installBot({ applicationId: app.id, guildId: guild.id, permissions: ['BAN_MEMBERS', 'VIEW_AUDIT_LOG'] });

  await startMyBot({ token: app.token, api: fake.apiUrl, gateway: fake.gatewayUrl }); // your code
  c.postMessage({ channelId: guild.system_channel_id, authorId: spammer.id, content: 'free nitro http://x.y' });

  // …wait for your bot, then look at the world:
  assert.equal(c.getBans({ guildId: guild.id })[0].user.id, spammer.id);
  assert.equal(c.getAuditLog({ guildId: guild.id }).at(-1).action_type, 22); // MEMBER_BAN_ADD
});
```

`createFakeDiscord()` resolves to:

| field | what |
|---|---|
| `restUrl` | `http://127.0.0.1:<port>/api/v10` |
| `apiUrl` | `http://127.0.0.1:<port>/api` – what `@discordjs/rest` calls `api` |
| `gatewayUrl` | `ws://127.0.0.1:<port>/gateway` (also returned by `GET /gateway/bot`) |
| `oauthUrl` | `http://127.0.0.1:<port>/oauth2` |
| `cdnUrl` | `http://127.0.0.1:<port>/cdn` – what `@discordjs/rest` calls `cdn` |
| `controlUrl` | `http://127.0.0.1:<port>/_fake` – the test-only control API over HTTP |
| `control` | the same control API in code |
| `close()` | stops the server |

### Pointing discord.js at it

```js
import { Client, GatewayIntentBits } from 'discord.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  rest: { api: fake.apiUrl, cdn: fake.cdnUrl },
});
await client.login(app.token); // the gateway URL comes from GET /gateway/bot
```

With `@discordjs/ws` directly: `new WebSocketManager({ token, intents, rest: new REST({ api: fake.apiUrl }).setToken(token) })`.

### Pointing a dashboard at it

Send people to `${fake.oauthUrl}/authorize?client_id=…&scope=identify%20guilds%20bot&permissions=…&redirect_uri=…&response_type=code&state=…`
and exchange the code at `${fake.apiUrl}/oauth2/token`. The fake auto-approves as the user set with
`control.setOAuthUser({ userId, guildId })`, or shows a small consent page in `oauth: { mode: 'consent' }`.

## How it works

- **One process, one port.** REST, gateway, OAuth2, CDN and the control API share a port; the
  control API lives under `/_fake` and never mixes with Discord paths.
- **A world model** of applications (each with a bot user, token, client secret and public key),
  users, guilds, roles, members, channels and threads, messages, bans, invites, AutoMod rules, the
  audit log, application commands, interactions, SKUs, entitlements and subscriptions. Several
  guilds and applications coexist and are isolated as on Discord.
- **IDs are snowflakes** (strings) that encode their creation time against the Discord epoch.
- **The clock** is `'real'` (wall clock, shiftable) or `'manual'` (frozen; only `control.setNow` /
  `control.advance` move it). With `'manual'` and the same `seed`, the same script gives the same
  ids, tokens and logs.
- **Every write** updates the world, appends the audit-log entry and sends the gateway dispatches,
  whether it came from your bot or from a person scripted through the control API.
- **Logs**: every REST request and every gateway frame (in and out, per session and shard) is kept;
  `GET /_fake/log.txt` prints them readably.

## Recipes

### A message the bot should moderate

```js
const msg = c.postMessage({ channelId, authorId: alice.id, content: 'buy followers', attachments: [{ filename: 'a.png', contentType: 'image/png', data: pngBase64, base64: true }] });
// replies, forwards and service messages:
c.postMessage({ channelId, authorId: bob.id, content: 'source?', replyTo: msg.id });
c.postMessage({ channelId: otherChannel, authorId: bob.id, forward: { channelId, messageId: msg.id } });
c.postMessage({ channelId, authorId: alice.id, type: 7 /* USER_JOIN */ });
// backdate to test the 14-day bulk-delete rule:
c.postMessage({ channelId, authorId: alice.id, content: 'old', timestamp: Date.now() - 15 * 86400_000 });
```

### Members joining with an invite

```js
const invite = c.createInvite({ guildId, inviterId: owner.id, maxUses: 1 });
c.join({ guildId, userId: newbie.id, inviteCode: invite.code }); // GUILD_MEMBER_ADD + USER_JOIN message
c.leave({ guildId, userId: newbie.id });
```

### A slash command, a button, a modal

```js
c.registerCommand({ applicationId: app.id, command: { name: 'warn', description: 'Warn', options: [{ name: 'user', description: 'who', type: 6 }] } });
const { id } = c.runCommand({ applicationId: app.id, userId: mod.id, guildId, channelId, name: 'warn', options: { user: alice.id } });
// …your bot answers through POST /interactions/{id}/{token}/callback…
c.getUserView({ interactionId: id });
// { status: 'responded' | 'thinking' | 'modal' | 'failed' | 'pending', error: 'This interaction failed' | null, messages: […], timeline: […] }

c.pressButton({ userId: mod.id, channelId, messageId: botMessage.id, customId: 'confirm' });
c.submitModal({ interactionId: id, values: { reason: 'spam' } });
```

A user-installed app works in DMs for someone banned from the guild:

```js
c.installForUser({ applicationId: app.id, userId: alice.id });
c.runCommand({ applicationId: app.id, userId: alice.id, name: 'appeal' }); // context 1 (BOT_DM)
```

### A hostile or careless staff member

These go through the real Discord route as that person, so permissions and hierarchy apply and the
audit log names them:

```js
c.deleteChannel({ actorId: rogueAdmin.id, channelId, reason: 'cleanup' });
c.massBan({ actorId: rogueAdmin.id, guildId, userIds: [a.id, b.id, c.id] });
c.editRolePermissions({ actorId: rogueAdmin.id, guildId, roleId: everyone, permissions: ['ADMINISTRATOR'] });
c.actAs({ userId: rogueAdmin.id, method: 'PATCH', path: `/channels/${channelId}`, body: { name: 'pwned' } });
```

### Faults

```js
c.injectRateLimit({ route: 'PUT /guilds/:guild_id/bans/:user_id', count: 2, retryAfter: 0.5 });
c.injectRateLimit({ global: true, count: 1 });
c.injectError({ route: 'DELETE /channels/:channel_id/messages/:message_id', status: 502 });
c.injectDrop({ route: 'PUT /guilds/:guild_id/bans/:user_id' });   // applied, but the client never hears back
c.injectDelay({ path: '/guilds/', ms: 2000 });
c.injectDrift({ route: 'PATCH /guilds/:guild_id/members/:user_id', fn: () => c.setBotPermissions({ applicationId, guildId, permissions: [] }) });
c.closeGatewaySession({ applicationId, code: 4000 });               // client should RESUME
c.invalidateGatewaySession({ applicationId, resumable: false });     // client should IDENTIFY again
c.requestGatewayReconnect({ applicationId });                        // op 7
c.expireInteraction({ interactionId });
```

`route` is the method plus Discord's path template with parameter names as in the docs
(`/channels/:channel_id/messages/:message_id`); `path` is a prefix (or `/regex/`) of the concrete path
after `/api/v10`.

### Time

```js
const fake = await createFakeDiscord({ clock: 'manual', now: '2026-01-01T00:00:00Z' });
fake.control.advance(28 * 86400_000); // the timeout has ended, the bulk-delete window has passed
```

### Snapshots

```js
const { id } = c.snapshot();
// …a test that wrecks the guild…
c.restore({ id });
c.reset(); // empty world, logs cleared
```

## Control API

Every method takes one object and returns JSON. Over HTTP: `POST /_fake/<method>` with that object
as the body (`GET /_fake` lists them).

| Area | Methods |
|---|---|
| Clock | `now`, `setNow({ time })`, `advance({ ms })` |
| Setup | `createApplication`, `setPrivilegedIntents`, `setRedirectUris`, `createUser`, `createGuild`, `updateGuild`, `createRole`, `updateRole`, `setRolePosition`, `createChannel`, `updateChannel`, `setPermissionOverwrite`, `addMember`, `updateMember`, `setMemberRoles`, `installBot`, `setBotPermissions`, `setBotRolePosition`, `createInvite`, `registerCommand`, `listCommands`, `installForUser`, `uninstallForUser`, `setOAuthUser`, `setOAuthMode`, `createSku`, `grantEntitlement`, `updateEntitlement`, `deleteEntitlement`, `createSubscription` |
| People | `postMessage`, `editMessage`, `deleteMessage`, `join`, `leave`, `runCommand`, `pressButton`, `submitModal`, `actAs` |
| Staff | `kickMember`, `banMember`, `unbanMember`, `massBan`, `massKick`, `timeoutMember`, `deleteChannel`, `deleteRole`, `editRolePermissions` |
| Faults | `injectRateLimit`, `injectError`, `injectDrop`, `injectDelay`, `injectDrift`, `clearFaults`, `removeFault`, `listFaults`, `setRateLimit`, `setRateLimitsEnabled`, `resetRateLimits`, `closeGatewaySession`, `invalidateGatewaySession`, `requestGatewayReconnect`, `requestHeartbeat`, `gatewaySessions`, `expireInteraction` |
| Read | `getState`, `getGuild`, `getMember`, `getMembers`, `getRoles`, `getChannels`, `getBans`, `getMessages`, `getMessage`, `getPermissions`, `getAuditLog`, `getInvite`, `getRequestLog`, `getGatewayLog`, `getGatewayFramesByShard`, `getInteraction`, `listInteractions`, `getUserView`, `formatLog` |
| Lifecycle | `reset`, `snapshot`, `restore` |

Permissions are accepted as names (`['BAN_MEMBERS']`) or Discord bitfield strings (`'4'`).

## Options

```js
createFakeDiscord({
  port: 0, host: '127.0.0.1',
  clock: 'real',            // or 'manual'
  now: undefined,           // start time
  seed: 1,                  // tokens, secrets, session ids
  demo: false,              // seed the demo world
  rateLimits: {             // or false
    global: { limit: 50, windowMs: 1000 },
    default: { limit: 50, windowMs: 1000 },
    routes: { 'POST /channels/:channel_id/messages': { limit: 5, windowMs: 5000 } },
  },
  gateway: { heartbeatIntervalMs: 41250, heartbeatTimeoutMs: null, resumeWindowMs: Infinity, maxGuildsPerShard: 2500 },
  interactions: { callbackDeadlineMs: 3000, tokenTtlMs: 900000 },
  cdn: { attachmentTtlMs: 86400000, maxUploadBytes: 10485760 },
  oauth: { mode: 'auto', userId: undefined, guildId: undefined },
  channelObfuscation: 'auto', // Get Guild Channels omits unviewable channels from 2026-11-16 (fake clock); true/false to force
});
```

CLI: `discord-test-server [--port 8787] [--demo] [--clock real|manual] [--seed 1] [--oauth-mode auto|consent] [--heartbeat-ms N] [--no-rate-limits] [--verbose] [--json]`.

## What matches Discord

Every route and rule carries a comment with the page of
[Discord's developer docs](https://discord.com/developers/docs) it comes from.

**REST** (`/api/v10`, `Bot` or `Bearer` auth): gateway (`/gateway`, `/gateway/bot`); users (`@me`,
`@me/guilds`, `@me/channels`, leave guild); guilds, roles (create, modify, positions, delete),
channels (create, positions), members (get, list, search, modify, kick, add/remove role), bans (put,
delete, get, list, bulk-ban), audit logs (filters, pagination), AutoMod rules, invites; channels
(get, modify, delete, permission overwrites, invites, threads); messages (create incl. multipart
uploads, replies, forwards, allowed mentions; get, list, edit, delete, bulk-delete); application
commands (global and guild, bulk overwrite); interaction callbacks, follow-ups and original-response
edits; SKUs, entitlements (list, get, consume, test create/delete), SKU subscriptions;
`/applications/@me`.

**Rules**: permissions computed as in the docs' pseudo-code (base, `ADMINISTRATOR`, owner, overwrites
for `@everyone`, roles, member), implicit permissions, timed-out members; role hierarchy for kick,
ban, timeout, nickname, role assignment, role editing and sorting; nobody acts on the owner; timeouts
up to 28 days and never on administrators or the owner; form errors in Discord's nested shape; rate
limits with Discord's headers and 429 body; message content redacted without the intent.

**Gateway**: `HELLO`, `IDENTIFY` (token, intents, shard, `large_threshold`, `compress`),
`READY`, lazy `GUILD_CREATE`, `HEARTBEAT`/`ACK`, `RESUME` with replay, `RECONNECT`,
`INVALID_SESSION`, `REQUEST_GUILD_MEMBERS`, close codes 4001–4014, shard routing
`(guild_id >> 22) % shard_count`, DMs on shard 0, `zlib-stream` transport compression, intent
filtering (incl. privileged intents per application and the `MESSAGE_CONTENT` exceptions).

**Dispatches**: `MESSAGE_CREATE/UPDATE/DELETE/DELETE_BULK`, `GUILD_MEMBER_ADD/UPDATE/REMOVE`,
`GUILD_BAN_ADD/REMOVE`, `GUILD_ROLE_CREATE/UPDATE/DELETE`, `CHANNEL_CREATE/UPDATE/DELETE`,
`THREAD_CREATE/UPDATE/DELETE`, `GUILD_CREATE/UPDATE/DELETE`, `GUILD_AUDIT_LOG_ENTRY_CREATE`,
`AUTO_MODERATION_RULE_CREATE/UPDATE/DELETE`, `AUTO_MODERATION_ACTION_EXECUTION`, `INVITE_CREATE`,
`INTERACTION_CREATE`, `ENTITLEMENT_CREATE/UPDATE/DELETE`, `SUBSCRIPTION_CREATE`.

## Assumptions

Where the docs are silent the fake picks a behaviour, marks it `// ASSUMPTION:` in the source and,
where it matters, makes it configurable. The main ones:

- Per-route rate limits are not published: defaults are 50 requests/second per route and 5 per 5
  seconds for sending messages; configure with `rateLimits`. With `clock: 'manual'` windows only
  reset when you advance time, so automatic limits are off unless you pass `rateLimits` or call
  `control.setRateLimit` (injected 429s always work).
- A guild the bot is not in answers `403/50001 Missing Access`; an unknown id answers `404/10004`.
- Server-side heartbeat timeout: 1.5 × the interval, then close code `4009`.
- Attachment URLs expire after 24 hours; the signature is an HMAC of our own.
- Bulk-ban logs one `MEMBER_BAN_ADD` entry per user; its "none banned" error uses HTTP 400.
- Duplicate ids in bulk-delete are a `50035` form error; unknown ids are ignored.
- Ban message deletion is announced as one `MESSAGE_DELETE_BULK` per channel.
- New roles are created at position 1; a bot's managed role too, unless you move it.
- Deleting a message logs one `MESSAGE_DELETE` entry each time (Discord merges recent ones).
- AutoMod's spam, preset and profile triggers use Discord's classifiers; here they fire only on the
  literal marker `[automod:<trigger_type>]` in the content.
- There is no error code for an unknown AutoMod rule or subscription: `404` with code `0`.
- Discord starts hiding unviewable channels on 16 November 2026. Get Guild Channels follows that
  date on the fake clock (`channelObfuscation`); obfuscated channel metadata over the gateway is not
  modelled.

## Not covered

Voice, presences, stickers, emojis, scheduled events, stage instances, webhooks other than
interaction webhooks, threads beyond create/modify/delete, reactions and pins. Requests to them
answer `404`.

## Testing this package

```sh
npm test            # contract tests against the real handlers
npm run test:red    # also runs every test against stubbed handlers and checks each one fails there
```

Not affiliated with or endorsed by Discord.

## License

MIT
