# discord-test-server

**A local Discord API server for end-to-end tests.**\
Develop and test your bot or dashboard offline: no Discord account, no real servers, no tokens to leak.

[![Discord API v10](https://img.shields.io/badge/Discord%20API-v10-5865f2?logo=discord&logoColor=white)](https://discord.com/developers/docs)
[![npm](https://img.shields.io/npm/v/discord-test-server)](https://www.npmjs.com/package/discord-test-server)
[![Dependencies: 1](https://img.shields.io/badge/dependencies-1-brightgreen)](package.json)
[![License: MIT](https://img.shields.io/npm/l/discord-test-server)](LICENSE)
[![Node >= 20](https://img.shields.io/node/v/discord-test-server)](package.json)

[Install](#install) · [Quick start](#quick-start) · [Guide](#in-a-test-suite) ·
[Recipes](#recipes) · [Reference](#control-api)

---

## What you can test

- **Moderation**: kicks, bans with message deletion, bulk bans, timeouts up to 28 days, role
  changes and bulk message deletion, with Discord's permission maths, role hierarchy and error codes.
- **The audit log**: every write leaves the entry Discord would, with the actor and the
  `X-Audit-Log-Reason`.
- **The gateway**: `READY`, `GUILD_CREATE`, heartbeats, close codes, sharding, `RESUME`, `RECONNECT`,
  intents and the message-content rules. A real `@discordjs/ws` client connects unchanged.
- **Interactions**: slash commands, buttons and modals, the 3-second deadline, follow-ups, ephemeral
  replies, and a record of what the user saw.
- **Messages**: reactions (with custom emoji), pins, crossposting, stickers, and webhooks that
  create, execute and edit messages.
- **Threads and forums**: threads from messages, forum posts, thread members, and archived lists.
- **Server features**: emoji and stickers, scheduled events, invites (look up, delete), and member
  prune.
- **Voice and presence**: voice-state events and moving or muting people, typing, and presence.
- **Sign-in and install**: OAuth2 authorize, code exchange, refresh, revoke and bot install.
- **Monetization**: SKUs, entitlements and subscriptions.
- **Bad days**: rate limits, 5xx errors, dropped responses, slow responses, closed or invalidated
  gateway sessions, permissions that change between two calls, and a staff member who deletes the
  channels.
- **Time**: a clock your test controls.

It never talks to Discord and runs as often as you like in CI.

<details>
<summary><b>All sections</b></summary>

**Start:** [Install](#install) · [Quick start](#quick-start) · [How it works](#how-it-works)

**Guide:** [Run it from the command line](#run-it-from-the-command-line) ·
[In a test suite](#in-a-test-suite) · [Pointing discord.js at it](#pointing-discordjs-at-it) ·
[Pointing a dashboard at it](#pointing-a-dashboard-at-it) · [Recipes](#recipes)

**Reference:** [Control API](#control-api) · [Options](#options) ·
[What matches Discord](#what-matches-discord) · [Assumptions](#assumptions)

**More:** [Testing this package](#testing-this-package)

</details>

## Install

```sh
npm install --save-dev discord-test-server
```

Requires Node.js 20 or newer. One runtime dependency (`ws`). Everything lives in memory and is gone
when the server stops. The control API answers anyone who can reach its port, so keep it on localhost.

## Quick start

A discord.js bot that deletes links and bans whoever posted them, tested end to end:

```js
import { createFakeDiscord } from 'discord-test-server';
import { Client, GatewayIntentBits, Events } from 'discord.js';

const fake = await createFakeDiscord({ port: 0 });
const c = fake.control;
const owner = c.createUser({ username: 'owner' });
const ann = c.createUser({ username: 'ann' });
const app = c.createApplication({ name: 'ModBot', privilegedIntents: { messageContent: true } });
const guild = c.createGuild({ name: 'Test', ownerId: owner.id });
c.addMember({ guildId: guild.id, userId: ann.id });
c.installBot({ applicationId: app.id, guildId: guild.id, permissions: ['MANAGE_MESSAGES', 'BAN_MEMBERS'] });

// Your bot, unchanged except for where it sends its API calls.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  rest: { api: fake.apiUrl, cdn: fake.cdnUrl },
});
client.on(Events.MessageCreate, async (message) => {
  if (/https?:\/\//.test(message.content)) {
    await message.delete();
    await message.member.ban({ reason: 'link spam' });
  }
});
await client.login(app.token);

// Discord's side, played by the test.
const spam = c.postMessage({ channelId: guild.system_channel_id, authorId: ann.id, content: 'cheap followers http://example.com' });

// Then wait for what the bot did: it runs asynchronously.
while (!c.getBans({ guildId: guild.id }).length) await new Promise((r) => setTimeout(r, 25));

console.log('message deleted:', !c.getMessages({ channelId: guild.system_channel_id }).some((m) => m.id === spam.id));
console.log('banned:', c.getBans({ guildId: guild.id }).map((b) => b.user.username));
console.log('audit log:', c.getAuditLog({ guildId: guild.id }).slice(-2).map((e) => e.action_type));

await client.destroy();
await fake.close();
```

With `discord.js` installed, save it as `quickstart.mjs` and run `node quickstart.mjs`. It prints
that the message is deleted, that `ann` is banned, and the last two audit-log entries (`72`, the
deleted message, and `22`, the ban). Like every example here, it is an ES module: use `.mjs`, or
`"type": "module"` in your `package.json`.

Your own bot needs two changes: log in with `app.token`, and pass `rest: { api: fake.apiUrl, cdn: fake.cdnUrl }`.
The gateway address comes from the fake. Other libraries only need their API base URL set to `fake.apiUrl`.

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

## Run it from the command line

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

## In a test suite

With `node:test` (any runner works):

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

### Reactions, pins, typing, presence and voice

People act through the control API; their calls use the same routes as your bot, so permissions apply
(`pinMessage` needs `PIN_MESSAGES`; pass `force: true` to `addReaction` or `joinVoice` to skip the checks).

```js
c.addReaction({ channelId, messageId: msg.id, userId: bob.id, emoji: '👍' }); // MESSAGE_REACTION_ADD
c.pinMessage({ channelId, messageId: msg.id, actorId: owner.id });            // CHANNEL_PINS_UPDATE + audit entry 74
c.typing({ channelId, userId: alice.id });                                    // TYPING_START
c.setPresence({ userId: alice.id, status: 'dnd', activities: [{ name: 'Chess', type: 0 }] }); // PRESENCE_UPDATE
c.joinVoice({ channelId: lounge.id, userId: alice.id });                      // VOICE_STATE_UPDATE
c.leaveVoice({ guildId, userId: alice.id });
```

### Webhooks, threads and scheduled events

```js
const hook = c.createWebhook({ channelId, name: 'Deploys' });                  // has .id and .token
await fetch(`${fake.restUrl}/webhooks/${hook.id}/${hook.token}?wait=true`, {  // executes like Discord's
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'deployed v2' }),
});
c.joinThread({ threadId: thread.id, userId: bob.id });                         // THREAD_MEMBERS_UPDATE
const event = c.createScheduledEvent({ guildId, name: 'Meetup', startTime: Date.now() + 86_400_000, endTime: Date.now() + 90_000_000, location: 'Cafe' });
c.subscribeToEvent({ eventId: event.id, userId: alice.id });                   // GUILD_SCHEDULED_EVENT_USER_ADD
```

### Autocomplete

```js
c.registerCommand({ applicationId: app.id, command: { name: 'tag', description: 'Show a tag', options: [{ name: 'name', description: 'Tag', type: 3, autocomplete: true }] } });
const { id } = c.runAutocomplete({ applicationId: app.id, userId: alice.id, guildId, channelId, name: 'tag', options: { name: 'wel' }, focused: 'name' });
// …your bot answers with callback type 8…
c.getAutocompleteChoices({ interactionId: id }); // [{ name: 'welcome', value: 'welcome' }]
```

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
| Setup | `createApplication`, `setPrivilegedIntents`, `setRedirectUris`, `createUser`, `createGuild`, `updateGuild`, `createRole`, `updateRole`, `setRolePosition`, `createChannel`, `updateChannel`, `setPermissionOverwrite`, `addMember`, `updateMember`, `setMemberRoles`, `installBot`, `setBotPermissions`, `setBotRolePosition`, `createInvite`, `createEmoji`, `createSticker`, `createWebhook`, `createScheduledEvent`, `registerCommand`, `listCommands`, `installForUser`, `uninstallForUser`, `setOAuthUser`, `setOAuthMode`, `createSku`, `grantEntitlement`, `updateEntitlement`, `deleteEntitlement`, `createSubscription` |
| People | `postMessage`, `editMessage`, `deleteMessage`, `join`, `leave`, `runCommand`, `runAutocomplete`, `pressButton`, `submitModal`, `addReaction`, `removeReaction`, `pinMessage`, `unpinMessage`, `typing`, `setPresence`, `joinVoice`, `leaveVoice`, `joinThread`, `leaveThread`, `addThreadMember`, `removeThreadMember`, `updateThreadMember`, `subscribeToEvent`, `unsubscribeFromEvent`, `actAs` |
| Staff | `kickMember`, `banMember`, `unbanMember`, `massBan`, `massKick`, `timeoutMember`, `deleteChannel`, `deleteRole`, `editRolePermissions` |
| Faults | `injectRateLimit`, `injectError`, `injectDrop`, `injectDelay`, `injectDrift`, `clearFaults`, `removeFault`, `listFaults`, `setRateLimit`, `setRateLimitsEnabled`, `resetRateLimits`, `closeGatewaySession`, `invalidateGatewaySession`, `requestGatewayReconnect`, `requestHeartbeat`, `gatewaySessions`, `expireInteraction` |
| Read | `getState`, `getGuild`, `getMember`, `getMembers`, `getRoles`, `getChannels`, `getBans`, `getMessages`, `getMessage`, `getPermissions`, `getAuditLog`, `getInvite`, `getRequestLog`, `getGatewayLog`, `getGatewayFramesByShard`, `getInteraction`, `listInteractions`, `getUserView`, `getAutocompleteChoices`, `getVoiceStates`, `getPresences`, `formatLog` |
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
`/applications/@me`. Added in 0.2: reactions (create, delete own and user, list, delete all and per
emoji), pins (`/messages/pins` and the deprecated `/pins`), crosspost, typing indicator, guild emoji
and stickers (`/stickers`, `/sticker-packs`), webhooks (create, list, get, modify, delete, execute,
get/edit/delete message), scheduled events (CRUD, users), voice states (get, and `mute`, `deaf` and
`channel_id` on Modify Guild Member), threads (from a message, forum posts, members, public, private
and joined archived lists), invites (get, delete, list by channel) and prune (count, begin).

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
`INTERACTION_CREATE` (slash commands, buttons, modals and autocomplete), `ENTITLEMENT_CREATE/UPDATE/DELETE`,
`SUBSCRIPTION_CREATE`, `MESSAGE_REACTION_ADD/REMOVE/REMOVE_ALL/REMOVE_EMOJI`, `CHANNEL_PINS_UPDATE`,
`GUILD_EMOJIS_UPDATE`, `GUILD_STICKERS_UPDATE`, `WEBHOOKS_UPDATE`, `GUILD_SCHEDULED_EVENT_CREATE/UPDATE/DELETE`,
`GUILD_SCHEDULED_EVENT_USER_ADD/REMOVE`, `VOICE_STATE_UPDATE`, `TYPING_START`, `PRESENCE_UPDATE`,
`THREAD_MEMBERS_UPDATE`, `THREAD_MEMBER_UPDATE`, `INVITE_DELETE`.

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
- Reactions: any string with a non-ASCII character counts as a unicode emoji (Discord does not publish the list);
  removing a reaction that is not there answers `404/10014`.
- Pins: the limit is 250 per channel (the docs' current figure); pinning twice is a `204` no-op.
- Emoji and stickers: slot limits follow the guild's `premium_tier` (50 static and 50 animated emoji, 5 stickers at tier 0);
  only a guild's own stickers can be sent in its messages. The fake ships no standard sticker packs.
- Webhooks: `avatar_url` overrides are not resolved to an avatar; the username override is. Forum posts through
  `thread_name` are not modelled (`220001`). Components are ignored unless `with_components=true`.
- Scheduled events: nothing starts, ends or cancels by itself when the clock passes their times; change `status` through the API.
- Voice: only people (through the control API) and moderation routes change voice state. There is no voice server, so a bot
  cannot connect to audio, and gateway opcode 4 is not handled.
- Presence: a bot's opcode 3 sets its own presence (invalid statuses are ignored). `invisible` is stored as `offline`.
  A REST typing indicator from a bot is not echoed to other bots.
- Threads: removing a user who is not a member answers `204`; getting one answers `404/10007`. Auto-archive timers do not run.
  Thread starter messages are not created.
- Prune: Discord uses online history; the fake counts members who joined more than `days` ago and posted nothing since.
  Bots, the owner and the caller are never pruned.
- Discord starts hiding unviewable channels on 16 November 2026. Get Guild Channels follows that
  date on the fake clock (`channelObfuscation`); obfuscated channel metadata over the gateway is not
  modelled.

## Testing this package

```sh
npm test            # contract tests against the real handlers
npm run test:red    # also runs every test against stubbed handlers and checks each one fails there
```

Not affiliated with or endorsed by Discord.

## License

MIT
