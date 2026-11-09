// REST basics – https://discord.com/developers/docs/reference
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, client, START } from './helpers.js';
import { snowflakeTime } from '../src/index.js';

const DISCORD_EPOCH = 1420070400000; // 2015-01-01T00:00:00.000Z

describe('snowflakes', () => {
  // https://discord.com/developers/docs/reference#snowflakes
  let w;
  before(async () => { w = await world({ rateLimits: false }); });
  after(() => w.fake.close());

  test('ids are strings that encode their creation time (ms since the Discord epoch << 22)', async () => {
    w.c.setNow('2026-04-01T00:00:00.000Z');
    const r = await w.rest.post(`/channels/${w.channelId}/messages`, { content: 'hi' });
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.id, 'string');
    assert.match(r.body.id, /^\d{17,20}$/);
    const t = Date.parse('2026-04-01T00:00:00.000Z');
    assert.equal(snowflakeTime(r.body.id), t);
    assert.equal(Number(BigInt(r.body.id) >> 22n) + DISCORD_EPOCH, t);
    assert.equal(Date.parse(r.body.timestamp), t);

    w.c.advance(90_000);
    const r2 = await w.rest.post(`/channels/${w.channelId}/messages`, { content: 'later' });
    assert.equal(snowflakeTime(r2.body.id), t + 90_000);
    assert.ok(BigInt(r2.body.id) > BigInt(r.body.id));
    // Every id in the payload is a string, too.
    assert.equal(typeof r2.body.channel_id, 'string');
    assert.equal(typeof r2.body.author.id, 'string');
  });

  test('ids created within the same millisecond are still unique and increasing', async () => {
    const a = await w.rest.post(`/channels/${w.channelId}/messages`, { content: 'a' });
    const b = await w.rest.post(`/channels/${w.channelId}/messages`, { content: 'b' });
    assert.equal(snowflakeTime(a.body.id), snowflakeTime(b.body.id));
    assert.ok(BigInt(b.body.id) > BigInt(a.body.id));
  });
});

describe('authentication', () => {
  // https://discord.com/developers/docs/reference#authentication
  // https://discord.com/developers/docs/topics/opcodes-and-status-codes#http – 401 UNAUTHORIZED
  let w;
  before(async () => { w = await world({ rateLimits: false }); });
  after(() => w.fake.close());

  test('Authorization: Bot <token> is accepted', async () => {
    const r = await w.rest.get('/users/@me');
    assert.equal(r.status, 200);
    assert.equal(r.body.id, w.app.bot_user_id);
  });

  test('missing Authorization header -> 401 with code 0', async () => {
    const r = await client(w.fake).get(`/channels/${w.channelId}`);
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { message: '401: Unauthorized', code: 0 });
  });

  test('invalid bot token -> 401 with code 0', async () => {
    const r = await client(w.fake, 'Bot not-a-real-token').get(`/channels/${w.channelId}`);
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 0);
  });

  test('a token without a scheme -> 401', async () => {
    const r = await client(w.fake, w.app.token).get('/users/@me');
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 0);
  });

  test('an OAuth2 Bearer token on a bot-only route -> 401; on a user route it works', async () => {
    const app = w.fake.world.app(w.app.id);
    const { access_token } = w.fake.control.server.oauth.issue(app, w.owner.id, ['identify', 'guilds']);
    const bearer = client(w.fake, `Bearer ${access_token}`);
    const r = await bearer.get(`/channels/${w.channelId}`);
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 0);
    const me = await bearer.get('/users/@me');
    assert.equal(me.status, 200);
    assert.equal(me.body.id, w.owner.id);
  });
});

describe('versions, routes, methods, bodies', () => {
  let w;
  before(async () => { w = await world({ rateLimits: false }); });
  after(() => w.fake.close());

  test('/api/v10 is served', async () => {
    const r = await w.rest.get(`/channels/${w.channelId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, w.channelId);
  });

  // https://discord.com/developers/docs/reference#api-versioning
  // https://discord.com/developers/docs/topics/opcodes-and-status-codes#json – 50041 Invalid API version provided
  test('an unsupported API version -> 400 / 50041', async () => {
    const res = await fetch(`${w.fake.apiUrl}/v8/channels/${w.channelId}`, { headers: { Authorization: `Bot ${w.app.token}` } });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 50041);
    assert.equal(typeof body.message, 'string');
  });

  // https://discord.com/developers/docs/topics/opcodes-and-status-codes#http – 404 NOT FOUND, 405 METHOD NOT ALLOWED
  test('an unknown route -> 404 with code 0', async () => {
    const r = await w.rest.get('/definitely/not/a/route');
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { message: '404: Not Found', code: 0 });
  });

  test('a known path with the wrong method -> 405 with code 0', async () => {
    const r = await w.rest.put(`/channels/${w.channelId}/messages`, {});
    assert.equal(r.status, 405);
    assert.deepEqual(r.body, { message: '405: Method Not Allowed', code: 0 });
  });

  // https://discord.com/developers/docs/topics/opcodes-and-status-codes#json – 50109 The request body contains invalid JSON.
  test('a body that is not valid JSON -> 400 / 50109', async () => {
    const r = await w.rest.call('POST', `/channels/${w.channelId}/messages`, undefined, { raw: '{"content": ', headers: { 'Content-Type': 'application/json' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 50109);
  });

  // https://discord.com/developers/docs/reference#error-messages
  test('form errors -> 400 / 50035 with Discord\'s nested errors shape (arrays keyed by index)', async () => {
    const r = await w.rest.post(`/guilds/${w.guildId}/channels`, {
      name: '',
      permission_overwrites: [{ id: w.memberRole.id, type: 0 }, { id: w.alice.id, type: 7 }],
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 50035);
    assert.equal(r.body.message, 'Invalid Form Body');
    const nameErr = r.body.errors.name._errors;
    assert.ok(Array.isArray(nameErr) && nameErr.length === 1);
    assert.equal(nameErr[0].code, 'BASE_TYPE_BAD_LENGTH');
    assert.equal(typeof nameErr[0].message, 'string');
    // Array items are keyed by their index; valid items are absent.
    assert.deepEqual(Object.keys(r.body.errors.permission_overwrites), ['1']);
    assert.equal(r.body.errors.permission_overwrites['1'].type._errors[0].code, 'BASE_TYPE_CHOICES');
    // Nothing was created.
    assert.ok(!w.c.getChannels({ guildId: w.guildId }).some((c) => c.name === ''));
  });

  test('a missing required field -> BASE_TYPE_REQUIRED', async () => {
    const r = await w.rest.post('/users/@me/channels', {});
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 50035);
    assert.deepEqual(r.body.errors, { recipient_id: { _errors: [{ code: 'BASE_TYPE_REQUIRED', message: 'This field is required' }] } });
  });
});

describe('unknown entities and access', () => {
  // https://discord.com/developers/docs/topics/opcodes-and-status-codes#json
  let w, otherGuild, hidden;
  before(async () => {
    w = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY', 'BAN_MEMBERS'] });
    otherGuild = w.c.createGuild({ name: 'No bot here', ownerId: w.owner.id });
    hidden = w.c.createChannel({ guildId: w.guildId, name: 'staff', permissionOverwrites: [{ id: w.guildId, type: 0, deny: ['VIEW_CHANNEL'] }] });
  });
  after(() => w.fake.close());

  const unknownId = '1234567890123456789';
  for (const [name, path, code] of [
    ['guild -> 10004', () => `/guilds/${unknownId}`, 10004],
    ['channel -> 10003', () => `/channels/${unknownId}`, 10003],
    ['member -> 10007', () => `/guilds/${w.guildId}/members/${w.c.createUser({ username: 'stranger' }).id}`, 10007],
    ['message -> 10008', () => `/channels/${w.channelId}/messages/${unknownId}`, 10008],
    ['role -> 10011', () => `/guilds/${w.guildId}/roles/${unknownId}`, 10011],
    ['user -> 10013', () => `/users/${unknownId}`, 10013],
    ['ban -> 10026', () => `/guilds/${w.guildId}/bans/${w.alice.id}`, 10026],
  ]) {
    test(`unknown ${name} (404)`, async () => {
      const r = await w.rest.get(path());
      assert.equal(r.status, 404);
      assert.equal(r.body.code, code);
      assert.equal(typeof r.body.message, 'string');
    });
  }

  test('a guild the bot is not in -> 403 / 50001 Missing Access', async () => {
    const r = await w.rest.get(`/guilds/${otherGuild.id}`);
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { message: 'Missing Access', code: 50001 });
    const ch = await w.rest.get(`/channels/${otherGuild.system_channel_id}`);
    assert.equal(ch.status, 403);
    assert.equal(ch.body.code, 50001);
  });

  // https://discord.com/developers/docs/topics/permissions – VIEW_CHANNEL
  test('a channel without VIEW_CHANNEL -> 403 / 50001', async () => {
    const r = await w.rest.get(`/channels/${hidden.id}`);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 50001);
    const m = await w.rest.post(`/channels/${hidden.id}/messages`, { content: 'x' });
    assert.equal(m.status, 403);
    assert.equal(m.body.code, 50001);
    // The visible channel works.
    assert.equal((await w.rest.get(`/channels/${w.channelId}`)).status, 200);
  });
});

describe('gateway and users', () => {
  let w;
  before(async () => { w = await world({ rateLimits: false }); });
  after(() => w.fake.close());

  // https://discord.com/developers/docs/events/gateway#get-gateway-bot
  test('GET /gateway/bot -> url, shards, session_start_limit', async () => {
    const r = await w.rest.get('/gateway/bot');
    assert.equal(r.status, 200);
    assert.equal(r.body.url, w.fake.gatewayUrl);
    assert.equal(r.body.shards, 1);
    const sl = r.body.session_start_limit;
    assert.equal(typeof sl.total, 'number');
    assert.equal(typeof sl.remaining, 'number');
    assert.ok(sl.remaining <= sl.total && sl.remaining > 0);
    assert.equal(typeof sl.reset_after, 'number');
    assert.equal(sl.max_concurrency, 1);
  });

  test('GET /gateway/bot without a token -> 401', async () => {
    const r = await client(w.fake).get('/gateway/bot');
    assert.equal(r.status, 401);
  });

  // https://discord.com/developers/docs/resources/user#get-current-user
  test('GET /users/@me -> the bot user', async () => {
    const r = await w.rest.get('/users/@me');
    assert.equal(r.status, 200);
    assert.equal(r.body.id, w.app.bot_user_id);
    assert.equal(r.body.bot, true);
    assert.equal(typeof r.body.username, 'string');
    assert.ok('discriminator' in r.body && 'avatar' in r.body && 'global_name' in r.body);
    // Percent-encoded path segments are decoded (discord-api-types' Routes.user('@me') is /users/%40me).
    const enc = await w.rest.get('/users/%40me');
    assert.equal(enc.status, 200);
    assert.equal(enc.body.id, w.app.bot_user_id);
  });

  // https://discord.com/developers/docs/resources/user#get-user
  test('GET /users/:id -> a user object', async () => {
    const r = await w.rest.get(`/users/${w.alice.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, w.alice.id);
    assert.equal(r.body.username, 'alice');
  });

  // https://discord.com/developers/docs/resources/user#get-current-user-guilds
  test('GET /users/@me/guilds -> partial guilds with permissions string and owner flag, paginated', async () => {
    const extra = [];
    for (let i = 0; i < 3; i++) {
      const g = w.c.createGuild({ name: `Extra ${i}`, ownerId: w.owner.id });
      w.c.installBot({ applicationId: w.app.id, guildId: g.id, permissions: ['VIEW_CHANNEL', 'SEND_MESSAGES'] });
      extra.push(g);
    }
    const all = await w.rest.get('/users/@me/guilds');
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.map((g) => g.id), [w.guildId, ...extra.map((g) => g.id)]);
    const first = all.body[0];
    assert.equal(first.name, 'Guild A');
    assert.equal(first.owner, false);
    assert.equal(typeof first.permissions, 'string');
    assert.equal(BigInt(first.permissions) & 8n, 8n); // ADMINISTRATOR
    assert.ok(Array.isArray(first.features));
    // Total permissions of the bot in that guild (@everyone + its role), no ADMINISTRATOR.
    const p1 = BigInt(all.body[1].permissions);
    assert.equal(p1 & ((1n << 10n) | (1n << 11n)), (1n << 10n) | (1n << 11n));
    assert.equal(p1 & 8n, 0n);

    const page1 = await w.rest.get('/users/@me/guilds?limit=2');
    assert.deepEqual(page1.body.map((g) => g.id), [w.guildId, extra[0].id]);
    const page2 = await w.rest.get(`/users/@me/guilds?limit=2&after=${extra[0].id}`);
    assert.deepEqual(page2.body.map((g) => g.id), [extra[1].id, extra[2].id]);
    const before = await w.rest.get(`/users/@me/guilds?limit=1&before=${extra[1].id}`);
    assert.deepEqual(before.body.map((g) => g.id), [extra[0].id]);

    const bad = await w.rest.get('/users/@me/guilds?limit=500');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 50035);
    assert.ok(bad.body.errors.limit._errors[0].code);

    // The owner (OAuth2 `guilds` scope) sees owner: true.
    const { access_token } = w.fake.control.server.oauth.issue(w.fake.world.app(w.app.id), w.owner.id, ['identify', 'guilds']);
    const mine = await client(w.fake, `Bearer ${access_token}`).get('/users/@me/guilds');
    assert.equal(mine.status, 200);
    assert.ok(mine.body.length >= 4 && mine.body.every((g) => g.owner === true));
  });

  // https://discord.com/developers/docs/resources/user#create-dm
  test('POST /users/@me/channels -> a DM channel (type 1) with the recipient; repeated calls reuse it', async () => {
    const r = await w.rest.post('/users/@me/channels', { recipient_id: w.alice.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.type, 1);
    assert.deepEqual(r.body.recipients.map((u) => u.id), [w.alice.id]);
    const again = await w.rest.post('/users/@me/channels', { recipient_id: w.alice.id });
    assert.equal(again.body.id, r.body.id);
    const msg = await w.rest.post(`/channels/${r.body.id}/messages`, { content: 'hello alice' });
    assert.equal(msg.status, 200);
    assert.equal(msg.body.channel_id, r.body.id);
    assert.equal(msg.body.guild_id, undefined);

    const unknown = await w.rest.post('/users/@me/channels', { recipient_id: '1234567890123456789' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 10013);
  });
});

describe('time-sensitive state follows the control clock', () => {
  let w;
  before(async () => { w = await world({ rateLimits: false }); });
  after(() => w.fake.close());

  test('the clock starts at the configured time; ids from REST reflect setNow', async () => {
    const r = await w.rest.post(`/channels/${w.channelId}/messages`, { content: 'now' });
    assert.equal(snowflakeTime(r.body.id), START);
    w.c.setNow(START + 3_600_000);
    const r2 = await w.rest.post(`/channels/${w.channelId}/messages`, { content: 'an hour later' });
    assert.equal(snowflakeTime(r2.body.id), START + 3_600_000);
  });
});
