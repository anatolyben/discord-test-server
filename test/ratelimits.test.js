// HTTP rate limits – https://discord.com/developers/docs/topics/rate-limits
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, client, START } from './helpers.js';

const ROUTE = 'POST /channels/:channel_id/messages';
const h = (r, name) => r.headers[name.toLowerCase()];

describe('per-route buckets', () => {
  // https://discord.com/developers/docs/topics/rate-limits#header-format-rate-limit-header-examples
  let w, other;
  before(async () => {
    w = await world({ rateLimits: { routes: { [ROUTE]: { limit: 3, windowMs: 10_000 } } } });
    other = w.c.createChannel({ guildId: w.guildId, name: 'other' });
  });
  after(() => w.fake.close());

  const send = (channelId, content = 'x') => w.rest.post(`/channels/${channelId}/messages`, { content });

  test('successful responses carry X-RateLimit-Limit/Remaining/Reset/Reset-After/Bucket', async () => {
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const r = await send(w.channelId, `m${i}`);
      assert.equal(r.status, 200);
      seen.push(r);
    }
    assert.deepEqual(seen.map((r) => h(r, 'X-RateLimit-Limit')), ['3', '3', '3']);
    assert.deepEqual(seen.map((r) => h(r, 'X-RateLimit-Remaining')), ['2', '1', '0']);
    assert.equal(h(seen[0], 'X-RateLimit-Reset'), ((START + 10_000) / 1000).toFixed(3));
    assert.equal(Number(h(seen[0], 'X-RateLimit-Reset-After')), 10);
    const bucket = h(seen[0], 'X-RateLimit-Bucket');
    assert.match(bucket, /^[0-9a-f]+$/);
    assert.ok(seen.every((r) => h(r, 'X-RateLimit-Bucket') === bucket));
    // Not sent on success: these are 429-only headers.
    assert.equal(h(seen[0], 'X-RateLimit-Scope'), undefined);
    assert.equal(h(seen[0], 'X-RateLimit-Global'), undefined);
  });

  // https://discord.com/developers/docs/topics/rate-limits#exceeding-a-rate-limit
  test('exceeding the bucket -> 429 { message, retry_after (float seconds), global: false } with Retry-After and X-RateLimit-Scope', async () => {
    w.c.advance(2_500);
    const before = w.c.getMessages({ channelId: w.channelId }).length;
    const r = await send(w.channelId, 'too many');
    assert.equal(r.status, 429);
    assert.equal(typeof r.body.message, 'string');
    assert.equal(r.body.retry_after, 7.5);
    assert.equal(r.body.global, false);
    assert.equal(h(r, 'Retry-After'), '8');
    assert.equal(h(r, 'X-RateLimit-Scope'), 'user');
    assert.equal(h(r, 'X-RateLimit-Global'), undefined);
    // Normal route headers are also sent with the 429.
    assert.equal(h(r, 'X-RateLimit-Limit'), '3');
    assert.equal(h(r, 'X-RateLimit-Remaining'), '0');
    assert.equal(Number(h(r, 'X-RateLimit-Reset-After')), 7.5);
    assert.ok(h(r, 'X-RateLimit-Bucket'));
    // The rejected request had no effect.
    assert.equal(w.c.getMessages({ channelId: w.channelId }).length, before);
  });

  test('another channel (a different major parameter) has its own bucket, with the same bucket id', async () => {
    const r = await send(other.id, 'elsewhere');
    assert.equal(r.status, 200);
    assert.equal(h(r, 'X-RateLimit-Remaining'), '2');
    const first = await send(w.channelId);
    assert.equal(first.status, 429);
    assert.equal(h(r, 'X-RateLimit-Bucket'), h(first, 'X-RateLimit-Bucket'));
  });

  test('other routes are not affected by the exhausted bucket', async () => {
    const r = await w.rest.get(`/channels/${w.channelId}/messages`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
    assert.notEqual(h(r, 'X-RateLimit-Bucket'), undefined);
    assert.equal(h(r, 'X-RateLimit-Remaining'), String(Number(h(r, 'X-RateLimit-Limit')) - 1));
  });

  test('the window resets once retry_after has passed on the clock', async () => {
    const limited = await send(w.channelId);
    assert.equal(limited.status, 429);
    w.c.advance(limited.body.retry_after * 1000);
    const r = await send(w.channelId, 'after reset');
    assert.equal(r.status, 200);
    assert.equal(r.body.content, 'after reset');
    assert.equal(h(r, 'X-RateLimit-Remaining'), '2');
  });

  test('another bot has its own buckets', async () => {
    const app2 = w.c.createApplication({ name: 'Other', ownerId: w.owner.id });
    w.c.installBot({ applicationId: app2.id, guildId: w.guildId, permissions: ['ADMINISTRATOR'] });
    w.c.advance(10_000);
    for (let i = 0; i < 3; i++) assert.equal((await send(w.channelId)).status, 200);
    assert.equal((await send(w.channelId)).status, 429);
    const r = await client(w.fake, `Bot ${app2.token}`).post(`/channels/${w.channelId}/messages`, { content: 'me too' });
    assert.equal(r.status, 200);
    assert.equal(r.body.author.id, app2.bot_user_id);
  });

  test('control.setRateLimit reconfigures a route at runtime', async () => {
    w.c.setRateLimit({ route: ROUTE, limit: 1, windowMs: 60_000 });
    const r1 = await send(other.id);
    assert.equal(r1.status, 200);
    assert.equal(h(r1, 'X-RateLimit-Limit'), '1');
    assert.equal(h(r1, 'X-RateLimit-Remaining'), '0');
    const r2 = await send(other.id);
    assert.equal(r2.status, 429);
    assert.equal(r2.body.retry_after, 60);
  });
});

describe('global rate limit', () => {
  // https://discord.com/developers/docs/topics/rate-limits#global-rate-limit
  let w;
  before(async () => {
    w = await world();
    w.c.setRateLimit({ route: 'global', limit: 4, windowMs: 1000 });
    w.c.registerCommand({ applicationId: w.app.id, command: { name: 'ping', description: 'Ping' } });
  });
  after(() => w.fake.close());

  test('exceeding the global limit -> 429 with global: true, X-RateLimit-Global and scope global, across routes', async () => {
    const paths = ['/users/@me', `/channels/${w.channelId}`, `/guilds/${w.guildId}`, '/gateway/bot'];
    for (const p of paths) assert.equal((await w.rest.get(p)).status, 200, p);
    const r = await w.rest.get(`/channels/${w.channelId}/messages`);
    assert.equal(r.status, 429);
    assert.equal(r.body.global, true);
    assert.equal(r.body.retry_after, 1);
    assert.equal(typeof r.body.message, 'string');
    assert.equal(h(r, 'X-RateLimit-Global'), 'true');
    assert.equal(h(r, 'X-RateLimit-Scope'), 'global');
    assert.equal(h(r, 'Retry-After'), '1');
  });

  // https://discord.com/developers/docs/topics/rate-limits#global-rate-limit – "Interaction endpoints are not bound to the bot's Global Rate Limit."
  test('interaction callbacks are not bound by the global limit', async () => {
    assert.equal((await w.rest.get('/users/@me')).status, 429);
    const it = w.c.runCommand({ applicationId: w.app.id, userId: w.alice.id, guildId: w.guildId, channelId: w.channelId, name: 'ping' });
    const r = await w.rest.post(`/interactions/${it.id}/${it.token}/callback`, { type: 4, data: { content: 'pong' } });
    assert.ok(r.status === 204 || r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.global, undefined);
    w.c.advance(1000);
    const msgs = await w.rest.get(`/channels/${w.channelId}/messages`);
    assert.equal(msgs.status, 200);
    assert.ok(msgs.body.some((m) => m.content === 'pong'));
  });

  test('the global window resets with the clock', async () => {
    w.c.advance(1000);
    const r = await w.rest.get('/users/@me');
    assert.equal(r.status, 200);
    assert.equal(r.body.id, w.app.bot_user_id);
  });
});

describe('default limits', () => {
  // https://discord.com/developers/docs/topics/rate-limits#global-rate-limit – 50 requests per second per bot
  let w;
  // `rateLimits: {}` = the default limits, switched on explicitly (a manual clock turns them off by default).
  before(async () => { w = await world({ rateLimits: {} }); });
  after(() => w.fake.close());

  test('50 requests per second globally by default', async () => {
    for (let i = 0; i < 50; i++) {
      const r = await w.rest.get(i % 2 ? '/users/@me' : `/guilds/${w.guildId}`);
      assert.equal(r.status, 200, `request ${i}`);
    }
    const r = await w.rest.get(`/channels/${w.channelId}`);
    assert.equal(r.status, 429);
    assert.equal(r.body.global, true);
  });

  test('a manual clock without rateLimits has no automatic limits (windows would never reset)', async () => {
    const w2 = await world();
    try {
      for (let i = 0; i < 60; i++) assert.equal((await w2.rest.post(`/channels/${w2.channelId}/messages`, { content: `m${i}` })).status, 200);
      // Configuring a limit switches limiting on.
      w2.c.setRateLimit({ route: 'GET /users/@me', limit: 1, windowMs: 1000 });
      assert.equal((await w2.rest.get('/users/@me')).body.id, w2.app.bot_user_id);
      assert.equal((await w2.rest.get('/users/@me')).status, 429);
    } finally {
      await w2.fake.close();
    }
  });

  test('rateLimits: false disables limiting', async () => {
    const w2 = await world({ rateLimits: false });
    try {
      for (let i = 0; i < 60; i++) assert.equal((await w2.rest.get('/users/@me')).status, 200);
      const r = await w2.rest.get('/users/@me');
      assert.equal(r.body.id, w2.app.bot_user_id);
    } finally {
      await w2.fake.close();
    }
  });
});
