// Pins – https://discord.com/developers/docs/resources/message#pin-message
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, GatewayClient } from './helpers.js';
import { Intents as I } from '../src/constants.js';

const INTENTS = I.GUILDS | I.GUILD_MESSAGES | I.GUILD_MODERATION | I.MESSAGE_CONTENT;
const say = (w, content = 'hi', authorId = w.alice.id) => w.c.postMessage({ channelId: w.channelId, authorId, content });
const pinPath = (w, m) => `/channels/${w.channelId}/messages/pins/${m.id}`;

describe('pin and unpin', () => {
  let w, gc;
  before(async () => {
    w = await world({ rateLimits: false });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, INTENTS);
  });
  after(async () => { gc.close(); await w.fake.close(); });

  test('PUT .../messages/pins/:id -> 204; the message is pinned, a CHANNEL_PINNED_MESSAGE (6) points at it, CHANNEL_PINS_UPDATE fires', async () => {
    const m = say(w);
    const r = await w.rest.put(pinPath(w, m), undefined, { headers: { 'X-Audit-Log-Reason': 'keep' } });
    assert.equal(r.status, 204);
    assert.equal((await w.rest.get(`/channels/${w.channelId}/messages/${m.id}`)).body.pinned, true);
    const ev = await gc.waitForDispatch('CHANNEL_PINS_UPDATE', (d) => d.channel_id === w.channelId);
    assert.equal(ev.d.guild_id, w.guildId);
    assert.ok(Date.parse(ev.d.last_pin_timestamp) > 0);
    const sys = (await w.rest.get(`/channels/${w.channelId}/messages?limit=5`)).body.find((x) => x.type === 6);
    assert.equal(sys.message_reference.message_id, m.id);
    assert.equal(sys.author.id, w.app.bot_user_id);
  });

  test('pinning writes MESSAGE_PIN (74) with channel_id and message_id and the reason; unpinning writes MESSAGE_UNPIN (75)', async () => {
    const m = say(w);
    await w.rest.put(pinPath(w, m), undefined, { headers: { 'X-Audit-Log-Reason': 'keep' } });
    await w.rest.delete(pinPath(w, m), { headers: { 'X-Audit-Log-Reason': 'stale' } });
    const log = (await w.rest.get(`/guilds/${w.guildId}/audit-logs?limit=10`)).body.audit_log_entries;
    const pin = log.find((e) => e.action_type === 74 && e.options.message_id === m.id);
    const unpin = log.find((e) => e.action_type === 75 && e.options.message_id === m.id);
    assert.equal(pin.user_id, w.app.bot_user_id);
    assert.equal(pin.target_id, w.alice.id);
    assert.equal(pin.options.channel_id, w.channelId);
    assert.equal(pin.reason, 'keep');
    assert.equal(unpin.reason, 'stale');
    const live = await gc.waitForDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', (d) => d.action_type === 75 && d.options.message_id === m.id);
    assert.equal(live.d.reason, 'stale');
  });

  test('DELETE .../pins/:id -> 204, pinned false, CHANNEL_PINS_UPDATE with last_pin_timestamp null when nothing is pinned', async () => {
    const w2 = await world({ rateLimits: false });
    const gc2 = await GatewayClient.connect(w2.fake.gatewayUrl);
    try {
      await gc2.ready(w2.app.token, INTENTS);
      const m = say(w2);
      await w2.rest.put(pinPath(w2, m));
      assert.equal((await w2.rest.delete(pinPath(w2, m))).status, 204);
      assert.equal((await w2.rest.get(`/channels/${w2.channelId}/messages/${m.id}`)).body.pinned, false);
      const ev = await gc2.waitFor(() => gc2.dispatches('CHANNEL_PINS_UPDATE').find((f) => f.d.last_pin_timestamp === null));
      assert.ok(ev);
    } finally { gc2.close(); await w2.fake.close(); }
  });

  test('the deprecated PUT/DELETE/GET /channels/:id/pins forms still work', async () => {
    const m = say(w);
    assert.equal((await w.rest.put(`/channels/${w.channelId}/pins/${m.id}`)).status, 204);
    const list = await w.rest.get(`/channels/${w.channelId}/pins`);
    assert.ok(Array.isArray(list.body));
    assert.ok(list.body.some((x) => x.id === m.id && x.pinned === true));
    assert.equal((await w.rest.delete(`/channels/${w.channelId}/pins/${m.id}`)).status, 204);
  });

  test('pinning twice is a no-op (204, no second system message); system messages cannot be pinned (403/50021)', async () => {
    const m = say(w);
    await w.rest.put(pinPath(w, m));
    const before = gc.dispatches('MESSAGE_CREATE').filter((f) => f.d.type === 6).length;
    assert.equal((await w.rest.put(pinPath(w, m))).status, 204);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(gc.dispatches('MESSAGE_CREATE').filter((f) => f.d.type === 6).length, before);
    const sys = w.c.postMessage({ channelId: w.channelId, authorId: w.alice.id, type: 7 });
    const r = await w.rest.put(pinPath(w, sys));
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 50021);
  });

  test('unknown message -> 404/10008; unknown channel -> 404/10003', async () => {
    assert.equal((await w.rest.put(`/channels/${w.channelId}/messages/pins/1`)).body.code, 10008);
    assert.equal((await w.rest.put('/channels/1/messages/pins/1')).body.code, 10003);
  });

  test('the 251st pin -> 400/30003', async () => {
    const w3 = await world({ rateLimits: false });
    try {
      for (let i = 0; i < 250; i++) {
        const m = w3.c.postMessage({ channelId: w3.channelId, authorId: w3.alice.id, content: `m${i}` });
        const r = await w3.rest.put(pinPath(w3, m));
        assert.equal(r.status, 204);
      }
      const extra = w3.c.postMessage({ channelId: w3.channelId, authorId: w3.alice.id, content: 'one more' });
      const r = await w3.rest.put(pinPath(w3, extra));
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 30003);
    } finally { await w3.fake.close(); }
  });
});

describe('get channel pins', () => {
  test('GET .../messages/pins -> { items: [{ pinned_at, message }], has_more }, newest pin first; limit and before page', async () => {
    const w = await world({ rateLimits: false });
    try {
      const ms = [];
      for (let i = 0; i < 3; i++) {
        const m = say(w, `m${i}`);
        ms.push(m);
        await w.rest.put(pinPath(w, m));
        w.c.advance(1000);
      }
      const r = await w.rest.get(`/channels/${w.channelId}/messages/pins`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.items.map((i) => i.message.content), ['m2', 'm1', 'm0']);
      assert.equal(r.body.has_more, false);
      assert.equal(r.body.items[0].message.pinned, true);
      assert.ok(Date.parse(r.body.items[0].pinned_at) > Date.parse(r.body.items[1].pinned_at));
      const p1 = await w.rest.get(`/channels/${w.channelId}/messages/pins?limit=2`);
      assert.deepEqual(p1.body.items.map((i) => i.message.content), ['m2', 'm1']);
      assert.equal(p1.body.has_more, true);
      const p2 = await w.rest.get(`/channels/${w.channelId}/messages/pins?before=${encodeURIComponent(p1.body.items[1].pinned_at)}`);
      assert.deepEqual(p2.body.items.map((i) => i.message.content), ['m0']);
      assert.equal((await w.rest.get(`/channels/${w.channelId}/messages/pins?limit=51`)).body.code, 50035);
    } finally { await w.fake.close(); }
  });

  test('without READ_MESSAGE_HISTORY no pins are returned', async () => {
    const w = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL'] });
    try {
      const m = say(w);
      w.c.pinMessage({ channelId: w.channelId, messageId: m.id, actorId: w.owner.id });
      w.c.updateRole({ guildId: w.guildId, roleId: w.guildId, permissions: ['VIEW_CHANNEL'] });
      const r = await w.rest.get(`/channels/${w.channelId}/messages/pins`);
      assert.deepEqual(r.body, { items: [], has_more: false });
    } finally { await w.fake.close(); }
  });
});

describe('pin permissions and DMs', () => {
  test('PIN_MESSAGES is required in a guild channel', async () => {
    const w = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY', 'MANAGE_MESSAGES'] });
    try {
      const m = say(w);
      const r = await w.rest.put(pinPath(w, m));
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 50013);
      assert.equal((await w.rest.delete(pinPath(w, m))).body.code, 50013);
    } finally { await w.fake.close(); }
  });

  test('a person pins through the control API with their own permissions (moderator without PIN_MESSAGES is refused)', async () => {
    const w = await world({ rateLimits: false });
    try {
      const m = say(w);
      assert.throws(() => w.c.pinMessage({ channelId: w.channelId, messageId: m.id, actorId: w.mod.id }), /50013/);
      w.c.updateRole({ guildId: w.guildId, roleId: w.modRole.id, permissions: ['PIN_MESSAGES', 'VIEW_AUDIT_LOG'] });
      w.c.pinMessage({ channelId: w.channelId, messageId: m.id, actorId: w.mod.id, reason: 'important' });
      const entry = (await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=74`)).body.audit_log_entries[0];
      assert.equal(entry.user_id, w.mod.id);
      assert.equal(entry.reason, 'important');
    } finally { await w.fake.close(); }
  });

  test('pinning in a DM sends CHANNEL_PINS_UPDATE without guild_id (needs DIRECT_MESSAGES)', async () => {
    const w = await world({ rateLimits: false });
    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    try {
      await gc.ready(w.app.token, INTENTS | I.DIRECT_MESSAGES);
      const dm = (await w.rest.post('/users/@me/channels', { recipient_id: w.alice.id })).body;
      const m = w.c.postMessage({ channelId: dm.id, authorId: w.alice.id, content: 'dm' });
      assert.equal((await w.rest.put(`/channels/${dm.id}/messages/pins/${m.id}`)).status, 204);
      const ev = await gc.waitForDispatch('CHANNEL_PINS_UPDATE', (d) => d.channel_id === dm.id);
      assert.equal(ev.d.guild_id, undefined);
    } finally { gc.close(); await w.fake.close(); }
  });
});

describe('crosspost', () => {
  test('POST .../crosspost works in announcement channels only, sets CROSSPOSTED, fires MESSAGE_UPDATE', async () => {
    const w = await world({ rateLimits: false });
    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    try {
      await gc.ready(w.app.token, INTENTS);
      const news = w.c.createChannel({ guildId: w.guildId, name: 'news', type: 5 });
      const m = w.c.postMessage({ channelId: news.id, authorId: w.alice.id, content: 'news', force: true });
      const r = await w.rest.post(`/channels/${news.id}/messages/${m.id}/crosspost`);
      assert.equal(r.status, 200);
      assert.equal(r.body.flags & 1, 1);
      await gc.waitForDispatch('MESSAGE_UPDATE', (d) => d.id === m.id && (d.flags & 1) === 1);
      assert.equal((await w.rest.post(`/channels/${news.id}/messages/${m.id}/crosspost`)).status, 400);
      const plain = say(w);
      const bad = await w.rest.post(`/channels/${w.channelId}/messages/${plain.id}/crosspost`);
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, 50024);
    } finally { gc.close(); await w.fake.close(); }
  });
});
