// Fault injection (test-only control API) – the Discord-facing behaviour it produces follows
// https://discord.com/developers/docs/topics/rate-limits and https://discord.com/developers/docs/topics/opcodes-and-status-codes#http
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './helpers.js';

const SEND = 'POST /channels/:channel_id/messages';
const BAN = 'PUT /guilds/:guild_id/bans/:user_id';
const KICK = 'DELETE /guilds/:guild_id/members/:user_id';
const h = (r, name) => r.headers[name.toLowerCase()];

describe('fault injection', () => {
  let w;
  const send = (content) => w.rest.post(`/channels/${w.channelId}/messages`, { content });
  const count = () => w.c.getMessages({ channelId: w.channelId }).length;
  before(async () => { w = await world({ rateLimits: false }); });
  afterEach(() => { w.c.clearFaults(); w.c.setBotPermissions({ applicationId: w.app.id, guildId: w.guildId, permissions: ['ADMINISTRATOR'] }); });
  after(() => w.fake.close());

  // https://discord.com/developers/docs/topics/rate-limits#exceeding-a-rate-limit
  test('injectRateLimit: the next N matching calls answer 429 without applying, then calls succeed', async () => {
    const before = count();
    w.c.injectRateLimit({ route: SEND, count: 2, retryAfter: 0.25 });
    for (let i = 0; i < 2; i++) {
      const r = await send(`limited ${i}`);
      assert.equal(r.status, 429);
      assert.deepEqual(r.body, { message: 'You are being rate limited.', retry_after: 0.25, global: false });
      assert.equal(h(r, 'X-RateLimit-Scope'), 'user');
      assert.equal(h(r, 'Retry-After'), '1');
      assert.equal(h(r, 'X-RateLimit-Global'), undefined);
    }
    // Other routes are untouched.
    assert.equal((await w.rest.get(`/channels/${w.channelId}`)).status, 200);
    assert.equal(count(), before);
    const ok = await send('through');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.content, 'through');
    assert.equal(count(), before + 1);
  });

  test('injectRateLimit with global: true limits every route', async () => {
    w.c.injectRateLimit({ global: true, count: 2, retryAfter: 2 });
    const a = await w.rest.get('/users/@me');
    const b = await w.rest.get(`/guilds/${w.guildId}`);
    for (const r of [a, b]) {
      assert.equal(r.status, 429);
      assert.equal(r.body.global, true);
      assert.equal(r.body.retry_after, 2);
      assert.equal(h(r, 'X-RateLimit-Global'), 'true');
      assert.equal(h(r, 'X-RateLimit-Scope'), 'global');
    }
    assert.equal((await w.rest.get('/users/@me')).status, 200);
  });

  // https://discord.com/developers/docs/topics/opcodes-and-status-codes#http – 5xx: "The server had an error processing your request"
  test('injectError: a 5xx answer and the write is NOT applied', async () => {
    w.c.injectError({ route: BAN, status: 503 });
    const r = await w.rest.put(`/guilds/${w.guildId}/bans/${w.bob.id}`, {});
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 0);
    const ban = await w.rest.get(`/guilds/${w.guildId}/bans/${w.bob.id}`);
    assert.equal(ban.status, 404);
    assert.equal(ban.body.code, 10026);
    const member = await w.rest.get(`/guilds/${w.guildId}/members/${w.bob.id}`);
    assert.equal(member.status, 200);
    // Retrying succeeds.
    assert.equal((await w.rest.put(`/guilds/${w.guildId}/bans/${w.bob.id}`, {})).status, 204);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/bans/${w.bob.id}`)).status, 200);
  });

  test('injectError defaults to 500 and can match by path prefix', async () => {
    w.c.injectError({ path: `/channels/${w.channelId}/messages` });
    const r = await send('x');
    assert.equal(r.status, 500);
    assert.equal(r.body.message, '500: Internal Server Error');
    assert.equal((await send('y')).status, 200);
  });

  test('injectDrop: the write is applied but the connection drops (fetch rejects)', async () => {
    const before = count();
    w.c.injectDrop({ route: SEND });
    await assert.rejects(() => send('maybe sent'));
    // The world did change: the message exists and is visible to the bot.
    assert.equal(count(), before + 1);
    const list = await w.rest.get(`/channels/${w.channelId}/messages?limit=1`);
    assert.equal(list.status, 200);
    assert.equal(list.body[0].content, 'maybe sent');
  });

  test('injectDelay: the answer arrives late but correct', async () => {
    w.c.injectDelay({ route: 'GET /users/@me', ms: 250 });
    const t0 = Date.now();
    const r = await w.rest.get('/users/@me');
    assert.ok(Date.now() - t0 >= 200, `took ${Date.now() - t0}ms`);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, w.app.bot_user_id);
    const t1 = Date.now();
    await w.rest.get('/users/@me');
    assert.ok(Date.now() - t1 < 200);
  });

  // https://discord.com/developers/docs/topics/opcodes-and-status-codes#json – 50013 Missing Permissions
  test('injectDrift (fn): the bot loses its permissions between two calls, so the second one 403s', async () => {
    const first = await w.rest.get(`/guilds/${w.guildId}/members/${w.alice.id}`);
    assert.equal(first.status, 200);
    w.c.injectDrift({ route: KICK, fn: ({ control }) => control.setBotPermissions({ applicationId: w.app.id, guildId: w.guildId, permissions: ['VIEW_CHANNEL'] }) });
    const second = await w.rest.delete(`/guilds/${w.guildId}/members/${w.alice.id}`);
    assert.equal(second.status, 403);
    assert.equal(second.body.code, 50013);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/members/${w.alice.id}`)).status, 200);
  });

  test('injectDrift (action): a control method runs right before the matching request', async () => {
    const victim = w.c.createUser({ username: 'leaver' });
    w.c.addMember({ guildId: w.guildId, userId: victim.id });
    w.c.injectDrift({ route: KICK, action: { method: 'leave', args: { guildId: w.guildId, userId: victim.id } } });
    const r = await w.rest.delete(`/guilds/${w.guildId}/members/${victim.id}`);
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 10007);
  });

  test('clearFaults removes pending faults', async () => {
    w.c.injectError({ route: SEND, count: 5 });
    w.c.injectRateLimit({ route: 'GET /users/@me', count: 5 });
    assert.equal(w.c.listFaults().length, 2);
    w.c.clearFaults();
    assert.equal(w.c.listFaults().length, 0);
    const r = await send('clear');
    assert.equal(r.status, 200);
    assert.equal(r.body.content, 'clear');
    const me = await w.rest.get('/users/@me');
    assert.equal(me.status, 200);
    assert.equal(me.body.id, w.app.bot_user_id);
  });

  test('removeFault removes one fault by id', async () => {
    const { id } = w.c.injectError({ route: SEND, status: 502 });
    w.c.injectError({ route: 'GET /users/@me', status: 502 });
    w.c.removeFault({ id });
    assert.equal((await send('kept')).status, 200);
    assert.equal((await w.rest.get('/users/@me')).status, 502);
  });
});

describe('HTTP control mirror', () => {
  let w;
  const ctl = async (method, args) => {
    const res = await fetch(`${w.fake.controlUrl}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args ?? {}) });
    return { status: res.status, body: await res.json() };
  };
  before(async () => { w = await world({ rateLimits: false }); });
  after(() => w.fake.close());

  test('POST /_fake/injectError, /_fake/injectRateLimit, GET /_fake/faults, POST /_fake/clearFaults', async () => {
    const e = await ctl('injectError', { route: SEND, status: 502, count: 1 });
    assert.equal(e.status, 200);
    assert.match(e.body.id, /^fault_/);
    const rl = await ctl('injectRateLimit', { route: 'GET /users/@me', retryAfter: 1.5 });
    assert.equal(rl.status, 200);
    const list = await (await fetch(`${w.fake.controlUrl}/faults`)).json();
    assert.equal(list.length, 2);

    const r = await w.rest.post(`/channels/${w.channelId}/messages`, { content: 'x' });
    assert.equal(r.status, 502);
    const me = await w.rest.get('/users/@me');
    assert.equal(me.status, 429);
    assert.equal(me.body.retry_after, 1.5);

    await ctl('injectError', { route: 'GET /users/@me', status: 500, count: 3 });
    assert.equal((await ctl('clearFaults')).status, 200);
    assert.equal((await w.rest.get('/users/@me')).status, 200);
  });

  test('POST /_fake/injectDrop and /_fake/injectDrift (action form)', async () => {
    await ctl('injectDrop', { route: SEND });
    await assert.rejects(() => w.rest.post(`/channels/${w.channelId}/messages`, { content: 'dropped but saved' }));
    const list = await w.rest.get(`/channels/${w.channelId}/messages?limit=1`);
    assert.equal(list.body[0].content, 'dropped but saved');

    await ctl('injectDrift', { route: 'GET /channels/:channel_id', action: { method: 'updateChannel', args: { channelId: w.channelId, name: 'drifted' } } });
    const ch = await w.rest.get(`/channels/${w.channelId}`);
    assert.equal(ch.status, 200);
    assert.equal(ch.body.name, 'drifted');
  });

  test('an unknown control method -> 404', async () => {
    const r = await ctl('nope', {});
    assert.equal(r.status, 404);
    // ...and the control API never shadows Discord routes.
    const d = await w.rest.get(`/channels/${w.channelId}`);
    assert.equal(d.status, 200);
    assert.equal(d.body.id, w.channelId);
  });
});
