// Bans contract – https://discord.com/developers/docs/resources/guild#create-guild-ban (and the other ban endpoints)
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, GatewayClient } from './helpers.js';
import { Intents as I, AuditLogEvent as A } from '../src/constants.js';

const INTENTS = I.GUILDS | I.GUILD_MEMBERS | I.GUILD_MODERATION | I.GUILD_MESSAGES | I.MESSAGE_CONTENT;
const BOT_PERMS = ['BAN_MEMBERS', 'MANAGE_GUILD', 'VIEW_AUDIT_LOG', 'READ_MESSAGE_HISTORY'];
const HOUR = 60 * 60 * 1000;
const reasonHeader = (r) => ({ headers: { 'X-Audit-Log-Reason': encodeURIComponent(r) } });

const worlds = [];
after(() => Promise.all(worlds.map((w) => w.fake.close())));

async function setup(opts = {}) {
  const w = await world({ botPermissions: BOT_PERMS, ...opts });
  worlds.push(w);
  w.bot = w.app.bot_user_id;
  if (opts.below) w.c.setBotRolePosition({ applicationId: w.app.id, guildId: w.guildId, position: 2 });
  w.ban = (userId, body = {}, o) => w.rest.put(`/guilds/${w.guildId}/bans/${userId}`, body, o);
  w.audit = async (q = '') => {
    const res = await w.rest.get(`/guilds/${w.guildId}/audit-logs${q}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.audit_log_entries;
  };
  w.gateway = async (intents = INTENTS) => {
    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, intents);
    return gc;
  };
  w.users = (n) => Array.from({ length: n }, (_, i) => w.c.createUser({ username: `user${i}` }));
  return w;
}

function assertError(res, status, code) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body?.code, code, JSON.stringify(res.body));
}

// https://discord.com/developers/docs/resources/guild#create-guild-ban
describe('create / get / remove ban', () => {
  test('PUT ban -> 204: member removed, GUILD_BAN_ADD + GUILD_MEMBER_REMOVE, MEMBER_BAN_ADD (22) with the reason', async () => {
    const w = await setup();
    const gc = await w.gateway();
    const res = await w.ban(w.alice.id, {}, reasonHeader('raiding / spam'));
    assert.equal(res.status, 204);
    const ev = await gc.waitForDispatch('GUILD_BAN_ADD', (d) => d.user.id === w.alice.id);
    assert.equal(ev.d.guild_id, w.guildId);
    await gc.waitForDispatch('GUILD_MEMBER_REMOVE', (d) => d.user.id === w.alice.id);
    assertError(await w.rest.get(`/guilds/${w.guildId}/members/${w.alice.id}`), 404, 10007);
    // https://discord.com/developers/docs/resources/guild#get-guild-ban
    const ban = await w.rest.get(`/guilds/${w.guildId}/bans/${w.alice.id}`);
    assert.equal(ban.status, 200);
    assert.equal(ban.body.reason, 'raiding / spam');
    assert.equal(ban.body.user.id, w.alice.id);
    const [entry] = await w.audit(`?action_type=${A.MEMBER_BAN_ADD}`);
    assert.equal(entry.user_id, w.bot);
    assert.equal(entry.target_id, w.alice.id);
    assert.equal(entry.reason, 'raiding / spam');
    // A ban is not a kick.
    assert.deepEqual(await w.audit(`?action_type=${A.MEMBER_KICK}`), []);
    gc.close();
  });

  test('a user who is not a member can be banned; an unknown user -> 404/10013', async () => {
    const w = await setup();
    const stranger = w.c.createUser({ username: 'stranger' });
    assert.equal((await w.ban(stranger.id)).status, 204);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/bans/${stranger.id}`)).body.user.id, stranger.id);
    assertError(await w.ban('123456789012345678'), 404, 10013);
  });

  // https://discord.com/developers/docs/resources/guild#remove-guild-ban
  test('DELETE ban -> 204, GUILD_BAN_REMOVE, MEMBER_BAN_REMOVE (23); afterwards GET/DELETE -> 404/10026', async () => {
    const w = await setup();
    await w.ban(w.bob.id);
    const gc = await w.gateway();
    const res = await w.rest.delete(`/guilds/${w.guildId}/bans/${w.bob.id}`, reasonHeader('appeal accepted'));
    assert.equal(res.status, 204);
    const ev = await gc.waitForDispatch('GUILD_BAN_REMOVE', (d) => d.user.id === w.bob.id);
    assert.equal(ev.d.guild_id, w.guildId);
    const [entry] = await w.audit(`?action_type=${A.MEMBER_BAN_REMOVE}`);
    assert.equal(entry.user_id, w.bot);
    assert.equal(entry.target_id, w.bob.id);
    assert.equal(entry.reason, 'appeal accepted');
    assertError(await w.rest.get(`/guilds/${w.guildId}/bans/${w.bob.id}`), 404, 10026);
    assertError(await w.rest.delete(`/guilds/${w.guildId}/bans/${w.bob.id}`), 404, 10026);
    gc.close();
  });

  // https://discord.com/developers/docs/topics/opcodes-and-status-codes#json – 10026 Unknown ban
  test('GET of a user who is not banned -> 404/10026', async () => {
    const w = await setup();
    assertError(await w.rest.get(`/guilds/${w.guildId}/bans/${w.alice.id}`), 404, 10026);
  });
});

describe('ban permissions', () => {
  // "Requires the BAN_MEMBERS permission"
  test('PUT / DELETE ban need BAN_MEMBERS', async () => {
    const w = await setup({ botPermissions: ['KICK_MEMBERS'] });
    assertError(await w.ban(w.alice.id), 403, 50013);
    w.c.banMember({ actorId: w.owner.id, guildId: w.guildId, userId: w.bob.id });
    assertError(await w.rest.delete(`/guilds/${w.guildId}/bans/${w.bob.id}`), 403, 50013);
    assertError(await w.rest.get(`/guilds/${w.guildId}/bans`), 403, 50013);
    assertError(await w.rest.get(`/guilds/${w.guildId}/bans/${w.bob.id}`), 403, 50013);
  });

  // https://discord.com/developers/docs/resources/guild#get-guild-bans – "Requires the BAN_MEMBERS or VIEW_AUDIT_LOG permission"
  test('GET bans / GET ban accept VIEW_AUDIT_LOG instead of BAN_MEMBERS', async () => {
    const w = await setup({ botPermissions: ['VIEW_AUDIT_LOG'] });
    w.c.banMember({ actorId: w.owner.id, guildId: w.guildId, userId: w.bob.id, reason: 'x' });
    const list = await w.rest.get(`/guilds/${w.guildId}/bans`);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.map((b) => b.user.id), [w.bob.id]);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/bans/${w.bob.id}`)).body.reason, 'x');
    assertError(await w.ban(w.alice.id), 403, 50013);
  });

  // https://discord.com/developers/docs/events/gateway-events#guild-ban-add – "only sent to bots with the BAN_MEMBERS or VIEW_AUDIT_LOG permission"
  test('GUILD_BAN_ADD / GUILD_BAN_REMOVE are not sent to a bot without BAN_MEMBERS or VIEW_AUDIT_LOG', async () => {
    const w = await setup({ botPermissions: ['KICK_MEMBERS'] });
    const gc = await w.gateway();
    w.c.banMember({ actorId: w.owner.id, guildId: w.guildId, userId: w.alice.id });
    await gc.waitForDispatch('GUILD_MEMBER_REMOVE', (d) => d.user.id === w.alice.id);
    w.c.unbanMember({ actorId: w.owner.id, guildId: w.guildId, userId: w.alice.id });
    assert.deepEqual(await gc.expectNone('GUILD_BAN_ADD'), []);
    assert.deepEqual(await gc.expectNone('GUILD_BAN_REMOVE'), []);
    // With VIEW_AUDIT_LOG they arrive.
    w.c.setBotPermissions({ applicationId: w.app.id, guildId: w.guildId, permissions: ['VIEW_AUDIT_LOG'] });
    w.c.banMember({ actorId: w.owner.id, guildId: w.guildId, userId: w.bob.id });
    await gc.waitForDispatch('GUILD_BAN_ADD', (d) => d.user.id === w.bob.id);
    gc.close();
  });

  // https://discord.com/developers/docs/topics/permissions#permission-hierarchy – "only kick, ban ... users whose highest role is lower"
  test('hierarchy: members at or above the bot\'s highest role and the owner cannot be banned', async () => {
    const w = await setup({ below: true });
    assertError(await w.ban(w.mod.id), 403, 50013);
    assertError(await w.ban(w.owner.id), 403, 50013);
    const admin = await setup({ botPermissions: ['ADMINISTRATOR'] });
    assertError(await admin.ban(admin.owner.id), 403, 50013);
    assert.equal((await w.ban(w.alice.id)).status, 204);
  });
});

// https://discord.com/developers/docs/resources/guild#get-guild-bans – limit (max 1000), before/after, ascending user ids
describe('list bans', () => {
  test('ascending by user id, limit / after / before pagination; before wins over after', async () => {
    const w = await setup();
    const users = w.users(5);
    for (const u of [...users].reverse()) assert.equal((await w.ban(u.id)).status, 204);
    const ids = users.map((u) => u.id).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const all = await w.rest.get(`/guilds/${w.guildId}/bans`);
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.map((b) => b.user.id), ids);
    assert.equal(all.body[0].reason, null);
    const first = await w.rest.get(`/guilds/${w.guildId}/bans?limit=2`);
    assert.deepEqual(first.body.map((b) => b.user.id), ids.slice(0, 2));
    const next = await w.rest.get(`/guilds/${w.guildId}/bans?limit=2&after=${ids[1]}`);
    assert.deepEqual(next.body.map((b) => b.user.id), ids.slice(2, 4));
    const prev = await w.rest.get(`/guilds/${w.guildId}/bans?limit=2&before=${ids[4]}`);
    assert.deepEqual(prev.body.map((b) => b.user.id), ids.slice(2, 4));
    // "If both before and after are provided, only before is respected."
    const both = await w.rest.get(`/guilds/${w.guildId}/bans?before=${ids[2]}&after=${ids[3]}`);
    assert.deepEqual(both.body.map((b) => b.user.id), ids.slice(0, 2));
  });

  test('limit outside 1-1000 -> 400/50035', async () => {
    const w = await setup();
    assertError(await w.rest.get(`/guilds/${w.guildId}/bans?limit=0`), 400, 50035);
    assertError(await w.rest.get(`/guilds/${w.guildId}/bans?limit=1001`), 400, 50035);
  });
});

// https://discord.com/developers/docs/resources/guild#create-guild-ban-json-params – delete_message_seconds 0-604800
describe('delete_message_seconds', () => {
  test('values outside 0..604800 -> 400/50035 and nobody is banned', async () => {
    const w = await setup();
    assertError(await w.ban(w.alice.id, { delete_message_seconds: -1 }), 400, 50035);
    assertError(await w.ban(w.alice.id, { delete_message_seconds: 604801 }), 400, 50035);
    assertError(await w.ban(w.alice.id, { delete_message_seconds: 'lots' }), 400, 50035);
    assertError(await w.ban(w.alice.id, { delete_message_days: 8 }), 400, 50035);
    assertError(await w.rest.get(`/guilds/${w.guildId}/bans/${w.alice.id}`), 404, 10026);
    assert.equal((await w.ban(w.alice.id, { delete_message_seconds: 604800 })).status, 204);
  });

  test('deletes only that user\'s messages inside the window, in every channel, with MESSAGE_DELETE_BULK', async () => {
    const w = await setup();
    const other = w.c.createChannel({ guildId: w.guildId, name: 'other' });
    const now = w.c.now().now;
    const old = w.c.postMessage({ channelId: w.channelId, authorId: w.alice.id, content: 'two hours ago', timestamp: now - 2 * HOUR });
    const recent = w.c.postMessage({ channelId: w.channelId, authorId: w.alice.id, content: 'ten minutes ago', timestamp: now - 10 * 60 * 1000 });
    const recentOther = w.c.postMessage({ channelId: other.id, authorId: w.alice.id, content: 'elsewhere', timestamp: now - 5 * 60 * 1000 });
    const bobs = w.c.postMessage({ channelId: w.channelId, authorId: w.bob.id, content: 'bob, recent', timestamp: now - 60 * 1000 });
    const gc = await w.gateway();
    assert.equal((await w.ban(w.alice.id, { delete_message_seconds: 3600 })).status, 204);
    const bulk = await gc.waitForDispatch('MESSAGE_DELETE_BULK', (d) => d.channel_id === w.channelId);
    assert.deepEqual(bulk.d.ids, [recent.id]);
    assert.equal(bulk.d.guild_id, w.guildId);
    await gc.waitForDispatch('MESSAGE_DELETE_BULK', (d) => d.channel_id === other.id && d.ids.includes(recentOther.id));
    const left = await w.rest.get(`/channels/${w.channelId}/messages`);
    assert.equal(left.status, 200);
    assert.deepEqual(left.body.map((m) => m.id).sort(), [old.id, bobs.id].sort());
    assert.deepEqual((await w.rest.get(`/channels/${other.id}/messages`)).body, []);
    gc.close();
  });

  test('delete_message_seconds 0 (the default) keeps every message', async () => {
    const w = await setup();
    const m = w.c.postMessage({ channelId: w.channelId, authorId: w.alice.id, content: 'just now' });
    assert.equal((await w.ban(w.alice.id)).status, 204);
    const left = await w.rest.get(`/channels/${w.channelId}/messages`);
    assert.deepEqual(left.body.map((x) => x.id), [m.id]);
  });
});

// https://discord.com/developers/docs/resources/guild#bulk-guild-ban
describe('bulk ban', () => {
  test('needs both BAN_MEMBERS and MANAGE_GUILD', async () => {
    for (const perms of [['BAN_MEMBERS'], ['MANAGE_GUILD']]) {
      const w = await setup({ botPermissions: perms });
      assertError(await w.rest.post(`/guilds/${w.guildId}/bulk-ban`, { user_ids: [w.alice.id] }), 403, 50013);
    }
  });

  test('more than 200 ids, or no user_ids -> 400/50035', async () => {
    const w = await setup();
    const ids = Array.from({ length: 201 }, (_, i) => String(100000000000000000n + BigInt(i)));
    assertError(await w.rest.post(`/guilds/${w.guildId}/bulk-ban`, { user_ids: ids }), 400, 50035);
    assertError(await w.rest.post(`/guilds/${w.guildId}/bulk-ban`, {}), 400, 50035);
    assertError(await w.rest.post(`/guilds/${w.guildId}/bulk-ban`, { user_ids: [w.alice.id], delete_message_seconds: 604801 }), 400, 50035);
  });

  test('banned_users / failed_users: already banned, owner and higher-role members fail', async () => {
    const w = await setup({ below: true });
    const [pre, nonMember] = w.users(2);
    await w.ban(pre.id);
    const gc = await w.gateway();
    const res = await w.rest.post(`/guilds/${w.guildId}/bulk-ban`, { user_ids: [w.alice.id, pre.id, w.owner.id, w.bob.id, w.mod.id, nonMember.id] }, reasonHeader('raid'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([...res.body.banned_users].sort(), [w.alice.id, w.bob.id, nonMember.id].sort());
    assert.deepEqual([...res.body.failed_users].sort(), [pre.id, w.owner.id, w.mod.id].sort());
    for (const id of [w.alice.id, w.bob.id, nonMember.id]) await gc.waitForDispatch('GUILD_BAN_ADD', (d) => d.user.id === id);
    const bans = await w.rest.get(`/guilds/${w.guildId}/bans`);
    assert.deepEqual(bans.body.map((b) => b.user.id).sort(), [pre.id, w.alice.id, w.bob.id, nonMember.id].sort());
    const entries = (await w.audit(`?action_type=${A.MEMBER_BAN_ADD}`)).filter((e) => e.reason === 'raid');
    assert.deepEqual(entries.map((e) => e.target_id).sort(), [w.alice.id, w.bob.id, nonMember.id].sort());
    assert.ok(entries.every((e) => e.user_id === w.bot));
    gc.close();
  });

  // "If none of the users could be banned, an error response code 500000: Failed to ban users is returned instead."
  test('when nobody could be banned -> error 500000', async () => {
    const w = await setup({ below: true });
    const res = await w.rest.post(`/guilds/${w.guildId}/bulk-ban`, { user_ids: [w.owner.id, w.mod.id] });
    assert.ok(res.status >= 400, String(res.status));
    assert.equal(res.body.code, 500000);
    assertError(await w.rest.get(`/guilds/${w.guildId}/bans/${w.mod.id}`), 404, 10026);
  });

  test('delete_message_seconds also applies to bulk bans', async () => {
    const w = await setup();
    w.c.postMessage({ channelId: w.channelId, authorId: w.alice.id, content: 'spam' });
    const keep = w.c.postMessage({ channelId: w.channelId, authorId: w.mod.id, content: 'mod here' });
    const res = await w.rest.post(`/guilds/${w.guildId}/bulk-ban`, { user_ids: [w.alice.id], delete_message_seconds: 60 });
    assert.equal(res.status, 200);
    assert.deepEqual((await w.rest.get(`/channels/${w.channelId}/messages`)).body.map((m) => m.id), [keep.id]);
  });
});
