// Channels – https://discord.com/developers/docs/resources/channel
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, client, GatewayClient } from './helpers.js';
import { Intents as I } from '../src/constants.js';

const A = { CHANNEL_CREATE: 10, CHANNEL_UPDATE: 11, CHANNEL_DELETE: 12, CHANNEL_OVERWRITE_CREATE: 13, CHANNEL_OVERWRITE_UPDATE: 14, CHANNEL_OVERWRITE_DELETE: 15 };
const PERM = { VIEW_CHANNEL: 1n << 10n, SEND_MESSAGES: 1n << 11n, BAN_MEMBERS: 1n << 2n, MANAGE_ROLES: 1n << 28n, MANAGE_CHANNELS: 1n << 4n };

/** Audit entries of one type, newest first, read through the Discord API. */
async function auditEntries(w, actionType) {
  const r = await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=${actionType}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.audit_log_entries;
}

const changeOf = (entry, key) => entry.changes?.find((c) => c.key === key);

describe('get / modify / delete channel', () => {
  let w, gc;
  before(async () => {
    w = await world({ rateLimits: false });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, I.GUILDS);
  });
  after(async () => { gc.close(); await w.fake.close(); });

  // https://discord.com/developers/docs/resources/channel#get-channel
  test('GET /channels/:id -> the channel object', async () => {
    const r = await w.rest.get(`/channels/${w.channelId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, w.channelId);
    assert.equal(r.body.type, 0);
    assert.equal(r.body.guild_id, w.guildId);
    assert.equal(r.body.name, 'general');
    assert.ok(Array.isArray(r.body.permission_overwrites));
    assert.equal(r.body.parent_id, null);
    assert.equal(typeof r.body.position, 'number');
  });

  // https://discord.com/developers/docs/resources/channel#modify-channel
  test('PATCH /channels/:id updates the channel, returns it, fires CHANNEL_UPDATE and logs CHANNEL_UPDATE', async () => {
    const r = await w.rest.patch(`/channels/${w.channelId}`, { name: 'lobby', topic: 'Say hi', rate_limit_per_user: 10 }, { headers: { 'X-Audit-Log-Reason': encodeURIComponent('tidy up') } });
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'lobby');
    assert.equal(r.body.topic, 'Say hi');
    assert.equal(r.body.rate_limit_per_user, 10);

    const ev = await gc.waitForDispatch('CHANNEL_UPDATE', (d) => d.id === w.channelId && d.name === 'lobby');
    assert.equal(ev.d.guild_id, w.guildId);
    assert.equal(ev.d.topic, 'Say hi');

    const [entry] = await auditEntries(w, A.CHANNEL_UPDATE);
    assert.equal(entry.target_id, w.channelId);
    assert.equal(entry.user_id, w.app.bot_user_id);
    assert.equal(entry.reason, 'tidy up');
    assert.deepEqual(changeOf(entry, 'name'), { key: 'name', old_value: 'general', new_value: 'lobby' });
    assert.equal(changeOf(entry, 'topic').new_value, 'Say hi');
    assert.equal(changeOf(entry, 'rate_limit_per_user').new_value, 10);

    assert.equal((await w.rest.get(`/channels/${w.channelId}`)).body.name, 'lobby');
  });

  test('PATCH with invalid values -> 400 / 50035 per field, nothing changes', async () => {
    const r = await w.rest.patch(`/channels/${w.channelId}`, { name: 'x'.repeat(101), rate_limit_per_user: 99999 });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 50035);
    assert.equal(r.body.errors.name._errors[0].code, 'BASE_TYPE_BAD_LENGTH');
    assert.equal(r.body.errors.rate_limit_per_user._errors[0].code, 'NUMBER_TYPE_MAX');
    assert.equal((await w.rest.get(`/channels/${w.channelId}`)).body.name, 'lobby');
  });

  test('PATCH an unknown channel -> 404 / 10003', async () => {
    const r = await w.rest.patch('/channels/1234567890123456789', { name: 'x' });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 10003);
  });

  // https://discord.com/developers/docs/resources/channel#deleteclose-channel
  test('DELETE /channels/:id returns the deleted channel, fires CHANNEL_DELETE and logs CHANNEL_DELETE', async () => {
    const c = w.c.createChannel({ guildId: w.guildId, name: 'temp' });
    const r = await w.rest.delete(`/channels/${c.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, c.id);
    assert.equal(r.body.name, 'temp');
    assert.equal(r.body.type, 0);
    const ev = await gc.waitForDispatch('CHANNEL_DELETE', (d) => d.id === c.id);
    assert.equal(ev.d.guild_id, w.guildId);
    assert.equal(ev.d.name, 'temp');
    const [entry] = await auditEntries(w, A.CHANNEL_DELETE);
    assert.equal(entry.target_id, c.id);
    assert.equal(changeOf(entry, 'name').old_value, 'temp');
    const gone = await w.rest.get(`/channels/${c.id}`);
    assert.equal(gone.status, 404);
    assert.equal(gone.body.code, 10003);
  });

  test('deleting a category keeps its children but removes their parent_id (CHANNEL_UPDATE for each)', async () => {
    const cat = w.c.createChannel({ guildId: w.guildId, name: 'Category', type: 4 });
    const a = w.c.createChannel({ guildId: w.guildId, name: 'child-a', parentId: cat.id });
    const b = w.c.createChannel({ guildId: w.guildId, name: 'child-b', parentId: cat.id });
    assert.equal((await w.rest.get(`/channels/${a.id}`)).body.parent_id, cat.id);
    const r = await w.rest.delete(`/channels/${cat.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.type, 4);
    for (const child of [a, b]) {
      const got = await w.rest.get(`/channels/${child.id}`);
      assert.equal(got.status, 200);
      assert.equal(got.body.parent_id, null);
      await gc.waitForDispatch('CHANNEL_UPDATE', (d) => d.id === child.id && d.parent_id === null);
    }
    await gc.waitForDispatch('CHANNEL_DELETE', (d) => d.id === cat.id);
  });
});

describe('MANAGE_CHANNELS is required', () => {
  // https://discord.com/developers/docs/resources/channel#modify-channel
  // https://discord.com/developers/docs/topics/opcodes-and-status-codes#json – 50013 Missing Permissions
  let w;
  before(async () => { w = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL', 'SEND_MESSAGES'] }); });
  after(() => w.fake.close());

  test('modify, delete, create and reorder without MANAGE_CHANNELS -> 403 / 50013', async () => {
    const patch = await w.rest.patch(`/channels/${w.channelId}`, { name: 'nope' });
    assert.equal(patch.status, 403);
    assert.deepEqual(patch.body, { message: 'Missing Permissions', code: 50013 });
    const del = await w.rest.delete(`/channels/${w.channelId}`);
    assert.equal(del.status, 403);
    assert.equal(del.body.code, 50013);
    const create = await w.rest.post(`/guilds/${w.guildId}/channels`, { name: 'nope' });
    assert.equal(create.status, 403);
    assert.equal(create.body.code, 50013);
    const move = await w.rest.patch(`/guilds/${w.guildId}/channels`, [{ id: w.channelId, position: 3 }]);
    assert.equal(move.status, 403);
    assert.equal(move.body.code, 50013);
    // Nothing changed.
    const got = await w.rest.get(`/channels/${w.channelId}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.name, 'general');
  });

  test('a channel-level MANAGE_CHANNELS overwrite is enough to modify that channel', async () => {
    const c = w.c.createChannel({ guildId: w.guildId, name: 'delegated', permissionOverwrites: [{ id: w.app.bot_user_id, type: 1, allow: ['MANAGE_CHANNELS'] }] });
    const r = await w.rest.patch(`/channels/${c.id}`, { name: 'renamed' });
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'renamed');
  });
});

describe('create guild channel', () => {
  // https://discord.com/developers/docs/resources/guild#create-guild-channel
  let w, gc;
  before(async () => {
    w = await world({ rateLimits: false });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, I.GUILDS);
  });
  after(async () => { gc.close(); await w.fake.close(); });

  test('POST /guilds/:id/channels -> 201 with the channel, CHANNEL_CREATE event, CHANNEL_CREATE audit entry', async () => {
    const cat = await w.rest.post(`/guilds/${w.guildId}/channels`, { name: 'Text Channels', type: 4 });
    assert.equal(cat.status, 201);
    assert.equal(cat.body.type, 4);
    const r = await w.rest.post(`/guilds/${w.guildId}/channels`, {
      name: 'mod-chat', type: 0, topic: 'staff only', parent_id: cat.body.id,
      permission_overwrites: [{ id: w.guildId, type: 0, deny: String(PERM.VIEW_CHANNEL) }, { id: w.modRole.id, type: 0, allow: String(PERM.VIEW_CHANNEL) }],
    }, { headers: { 'X-Audit-Log-Reason': 'staff room' } });
    assert.equal(r.status, 201);
    assert.match(r.body.id, /^\d+$/);
    assert.equal(r.body.name, 'mod-chat');
    assert.equal(r.body.guild_id, w.guildId);
    assert.equal(r.body.topic, 'staff only');
    assert.equal(r.body.parent_id, cat.body.id);
    assert.deepEqual(r.body.permission_overwrites, [
      { id: w.guildId, type: 0, allow: '0', deny: String(PERM.VIEW_CHANNEL) },
      { id: w.modRole.id, type: 0, allow: String(PERM.VIEW_CHANNEL), deny: '0' },
    ]);

    const ev = await gc.waitForDispatch('CHANNEL_CREATE', (d) => d.id === r.body.id);
    assert.equal(ev.d.guild_id, w.guildId);
    assert.equal(ev.d.name, 'mod-chat');
    assert.equal(ev.d.parent_id, cat.body.id);

    const [entry] = await auditEntries(w, A.CHANNEL_CREATE);
    assert.equal(entry.target_id, r.body.id);
    assert.equal(entry.user_id, w.app.bot_user_id);
    assert.equal(entry.reason, 'staff room');
    assert.equal(changeOf(entry, 'name').new_value, 'mod-chat');
    assert.equal(changeOf(entry, 'type').new_value, 0);
    assert.equal(changeOf(entry, 'permission_overwrites').new_value.length, 2);

    // It shows up in the guild's channel list.
    const list = await w.rest.get(`/guilds/${w.guildId}/channels`);
    assert.ok(list.body.some((c) => c.id === r.body.id));
  });

  test('name is required; unknown types and a parent that is not a category are rejected (400 / 50035)', async () => {
    const r = await w.rest.post(`/guilds/${w.guildId}/channels`, { type: 99 });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 50035);
    assert.equal(r.body.errors.name._errors[0].code, 'BASE_TYPE_REQUIRED');
    assert.equal(r.body.errors.type._errors[0].code, 'BASE_TYPE_CHOICES');
    const p = await w.rest.post(`/guilds/${w.guildId}/channels`, { name: 'x', parent_id: w.channelId });
    assert.equal(p.status, 400);
    assert.equal(p.body.code, 50035);
    assert.ok(p.body.errors.parent_id._errors.length);
  });
});

describe('create guild channel: overwrites and the bot\'s own permissions', () => {
  // https://discord.com/developers/docs/resources/guild#create-guild-channel – "If setting permission overwrites,
  // only permissions your bot has in the guild can be allowed/denied. Setting MANAGE_ROLES permission in channels
  // is only possible for guild administrators."
  let w;
  before(async () => { w = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'MANAGE_CHANNELS'] }); });
  after(() => w.fake.close());

  test('overwrites without MANAGE_ROLES -> 403 / 50013; without overwrites it works', async () => {
    const r = await w.rest.post(`/guilds/${w.guildId}/channels`, { name: 'x', permission_overwrites: [{ id: w.guildId, type: 0, deny: String(PERM.SEND_MESSAGES) }] });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 50013);
    assert.ok(!w.c.getChannels({ guildId: w.guildId }).some((c) => c.name === 'x'));
    const ok = await w.rest.post(`/guilds/${w.guildId}/channels`, { name: 'plain' });
    assert.equal(ok.status, 201);
  });

  test('with MANAGE_ROLES: only permissions the bot has may be allowed/denied', async () => {
    w.c.setBotPermissions({ applicationId: w.app.id, guildId: w.guildId, permissions: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'MANAGE_CHANNELS', 'MANAGE_ROLES'] });
    const bad = await w.rest.post(`/guilds/${w.guildId}/channels`, { name: 'bans', permission_overwrites: [{ id: w.memberRole.id, type: 0, allow: String(PERM.BAN_MEMBERS) }] });
    assert.equal(bad.status, 403);
    assert.equal(bad.body.code, 50013);
    const good = await w.rest.post(`/guilds/${w.guildId}/channels`, { name: 'quiet', permission_overwrites: [{ id: w.memberRole.id, type: 0, deny: String(PERM.SEND_MESSAGES) }] });
    assert.equal(good.status, 201);
    assert.equal(good.body.permission_overwrites[0].deny, String(PERM.SEND_MESSAGES));
  });

  test('setting MANAGE_ROLES in an overwrite needs ADMINISTRATOR', async () => {
    const r = await w.rest.post(`/guilds/${w.guildId}/channels`, { name: 'delegate', permission_overwrites: [{ id: w.modRole.id, type: 0, allow: String(PERM.MANAGE_ROLES) }] });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 50013);
    w.c.setBotPermissions({ applicationId: w.app.id, guildId: w.guildId, permissions: ['ADMINISTRATOR'] });
    const ok = await w.rest.post(`/guilds/${w.guildId}/channels`, { name: 'delegate', permission_overwrites: [{ id: w.modRole.id, type: 0, allow: String(PERM.MANAGE_ROLES) }] });
    assert.equal(ok.status, 201);
  });
});

describe('modify guild channel positions', () => {
  // https://discord.com/developers/docs/resources/guild#modify-guild-channel-positions
  let w, gc;
  before(async () => {
    w = await world({ rateLimits: false });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, I.GUILDS);
  });
  after(async () => { gc.close(); await w.fake.close(); });

  test('PATCH /guilds/:id/channels -> 204, positions and parents change, CHANNEL_UPDATE per moved channel', async () => {
    const cat = w.c.createChannel({ guildId: w.guildId, name: 'Cat', type: 4, permissionOverwrites: [{ id: w.guildId, type: 0, deny: ['SEND_MESSAGES'] }] });
    const a = w.c.createChannel({ guildId: w.guildId, name: 'a' });
    const b = w.c.createChannel({ guildId: w.guildId, name: 'b' });
    const r = await w.rest.patch(`/guilds/${w.guildId}/channels`, [
      { id: a.id, position: 7 },
      { id: b.id, position: 1, parent_id: cat.id, lock_permissions: true },
    ]);
    assert.equal(r.status, 204);
    const ga = (await w.rest.get(`/channels/${a.id}`)).body;
    const gb = (await w.rest.get(`/channels/${b.id}`)).body;
    assert.equal(ga.position, 7);
    assert.equal(gb.position, 1);
    assert.equal(gb.parent_id, cat.id);
    // lock_permissions syncs the overwrites with the new parent.
    assert.deepEqual(gb.permission_overwrites, (await w.rest.get(`/channels/${cat.id}`)).body.permission_overwrites);
    await gc.waitForDispatch('CHANNEL_UPDATE', (d) => d.id === a.id && d.position === 7);
    await gc.waitForDispatch('CHANNEL_UPDATE', (d) => d.id === b.id && d.parent_id === cat.id);
  });

  test('a body that is not a list, or items without id -> 400 / 50035; an unknown channel -> 10003', async () => {
    const notList = await w.rest.patch(`/guilds/${w.guildId}/channels`, { id: w.channelId });
    assert.equal(notList.status, 400);
    assert.equal(notList.body.code, 50035);
    const noId = await w.rest.patch(`/guilds/${w.guildId}/channels`, [{ id: w.channelId, position: 0 }, { position: 2 }]);
    assert.equal(noId.status, 400);
    assert.equal(noId.body.errors['1'].id._errors[0].code, 'BASE_TYPE_REQUIRED');
    const unknown = await w.rest.patch(`/guilds/${w.guildId}/channels`, [{ id: '1234567890123456789', position: 0 }]);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 10003);
  });
});

describe('permission overwrites', () => {
  // https://discord.com/developers/docs/resources/channel#edit-channel-permissions
  // https://discord.com/developers/docs/resources/channel#delete-channel-permission
  // https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object-optional-audit-entry-info
  let w, gc;
  before(async () => {
    w = await world({ rateLimits: false });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, I.GUILDS);
  });
  after(async () => { gc.close(); await w.fake.close(); });

  test('type is required and must be 0 or 1 (400 / 50035)', async () => {
    const missing = await w.rest.put(`/channels/${w.channelId}/permissions/${w.memberRole.id}`, { allow: '1024' });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 50035);
    assert.equal(missing.body.errors.type._errors[0].code, 'BASE_TYPE_REQUIRED');
    const wrong = await w.rest.put(`/channels/${w.channelId}/permissions/${w.memberRole.id}`, { allow: '1024', type: 2 });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.errors.type._errors[0].code, 'BASE_TYPE_CHOICES');
  });

  test('PUT a role overwrite -> 204, CHANNEL_UPDATE, CHANNEL_OVERWRITE_CREATE with options id/type/role_name', async () => {
    const r = await w.rest.put(`/channels/${w.channelId}/permissions/${w.memberRole.id}`, { type: 0, allow: String(PERM.SEND_MESSAGES), deny: String(PERM.BAN_MEMBERS) }, { headers: { 'X-Audit-Log-Reason': 'members talk' } });
    assert.equal(r.status, 204);
    const ch = (await w.rest.get(`/channels/${w.channelId}`)).body;
    assert.deepEqual(ch.permission_overwrites.find((o) => o.id === w.memberRole.id), { id: w.memberRole.id, type: 0, allow: String(PERM.SEND_MESSAGES), deny: String(PERM.BAN_MEMBERS) });
    await gc.waitForDispatch('CHANNEL_UPDATE', (d) => d.id === w.channelId && d.permission_overwrites.some((o) => o.id === w.memberRole.id));

    const [entry] = await auditEntries(w, A.CHANNEL_OVERWRITE_CREATE);
    assert.equal(entry.target_id, w.channelId);
    assert.equal(entry.reason, 'members talk');
    assert.deepEqual(entry.options, { id: w.memberRole.id, type: '0', role_name: 'Member' });
    assert.equal(changeOf(entry, 'allow').new_value, String(PERM.SEND_MESSAGES));
    // Editing overwrites is not also logged as a CHANNEL_UPDATE.
    assert.equal((await auditEntries(w, A.CHANNEL_UPDATE)).length, 0);
  });

  test('PUT again with different bits -> CHANNEL_OVERWRITE_UPDATE with old and new values', async () => {
    const r = await w.rest.put(`/channels/${w.channelId}/permissions/${w.memberRole.id}`, { type: 0, allow: String(PERM.SEND_MESSAGES | PERM.VIEW_CHANNEL) });
    assert.equal(r.status, 204);
    const [entry] = await auditEntries(w, A.CHANNEL_OVERWRITE_UPDATE);
    assert.deepEqual(entry.options, { id: w.memberRole.id, type: '0', role_name: 'Member' });
    assert.deepEqual(changeOf(entry, 'allow'), { key: 'allow', old_value: String(PERM.SEND_MESSAGES), new_value: String(PERM.SEND_MESSAGES | PERM.VIEW_CHANNEL) });
    assert.deepEqual(changeOf(entry, 'deny'), { key: 'deny', old_value: String(PERM.BAN_MEMBERS), new_value: '0' });
  });

  test('a member overwrite (type 1) has no role_name in the audit options', async () => {
    const r = await w.rest.put(`/channels/${w.channelId}/permissions/${w.alice.id}`, { type: 1, deny: String(PERM.SEND_MESSAGES) });
    assert.equal(r.status, 204);
    const [entry] = await auditEntries(w, A.CHANNEL_OVERWRITE_CREATE);
    assert.deepEqual(entry.options, { id: w.alice.id, type: '1' });
    // The overwrite takes effect: alice can no longer send.
    const res = w.c.actAs({ userId: w.alice.id, method: 'POST', path: `/channels/${w.channelId}/messages`, body: { content: 'hi' } });
    assert.equal(res.status, 403);
  });

  test('DELETE an overwrite -> 204 and CHANNEL_OVERWRITE_DELETE; an unknown overwrite -> 404 / 10009', async () => {
    const r = await w.rest.delete(`/channels/${w.channelId}/permissions/${w.memberRole.id}`);
    assert.equal(r.status, 204);
    const ch = (await w.rest.get(`/channels/${w.channelId}`)).body;
    assert.ok(!ch.permission_overwrites.some((o) => o.id === w.memberRole.id));
    const [entry] = await auditEntries(w, A.CHANNEL_OVERWRITE_DELETE);
    assert.deepEqual(entry.options, { id: w.memberRole.id, type: '0', role_name: 'Member' });
    assert.equal(changeOf(entry, 'allow').old_value, String(PERM.SEND_MESSAGES | PERM.VIEW_CHANNEL));

    const again = await w.rest.delete(`/channels/${w.channelId}/permissions/${w.memberRole.id}`);
    assert.equal(again.status, 404);
    assert.deepEqual(again.body, { message: 'Unknown Overwrite', code: 10009 });
  });

  test('without MANAGE_ROLES -> 403 / 50013', async () => {
    const w2 = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL', 'MANAGE_CHANNELS'] });
    try {
      const r = await w2.rest.put(`/channels/${w2.channelId}/permissions/${w2.memberRole.id}`, { type: 0, allow: '1024' });
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 50013);
      const d = await w2.rest.delete(`/channels/${w2.channelId}/permissions/${w2.guildId}`);
      assert.equal(d.status, 403);
      assert.equal(d.body.code, 50013);
    } finally {
      await w2.fake.close();
    }
  });

  test('a bot with MANAGE_ROLES can only allow/deny permissions it has', async () => {
    const w2 = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'MANAGE_ROLES'] });
    try {
      const bad = await w2.rest.put(`/channels/${w2.channelId}/permissions/${w2.memberRole.id}`, { type: 0, allow: String(PERM.BAN_MEMBERS) });
      assert.equal(bad.status, 403);
      assert.equal(bad.body.code, 50013);
      const ok = await w2.rest.put(`/channels/${w2.channelId}/permissions/${w2.memberRole.id}`, { type: 0, deny: String(PERM.SEND_MESSAGES) });
      assert.equal(ok.status, 204);
    } finally {
      await w2.fake.close();
    }
  });

  test('PATCH /channels/:id with permission_overwrites logs one overwrite entry per change', async () => {
    const r = await w.rest.patch(`/channels/${w.channelId}`, { permission_overwrites: [{ id: w.modRole.id, type: 0, allow: String(PERM.MANAGE_CHANNELS) }] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.permission_overwrites, [{ id: w.modRole.id, type: 0, allow: String(PERM.MANAGE_CHANNELS), deny: '0' }]);
    const created = await auditEntries(w, A.CHANNEL_OVERWRITE_CREATE);
    assert.equal(created[0].options.id, w.modRole.id);
    assert.equal(created[0].options.role_name, 'Moderator');
    const deleted = await auditEntries(w, A.CHANNEL_OVERWRITE_DELETE);
    // alice's member overwrite was replaced away.
    assert.equal(deleted[0].options.id, w.alice.id);
    assert.equal(deleted[0].options.type, '1');
  });
});

describe('DM channels', () => {
  // https://discord.com/developers/docs/resources/channel#deleteclose-channel – closing a DM
  let w;
  before(async () => { w = await world({ rateLimits: false }); });
  after(() => w.fake.close());

  test('modifying a DM -> 403 / 50003; deleting (closing) it returns the channel', async () => {
    const dm = (await w.rest.post('/users/@me/channels', { recipient_id: w.alice.id })).body;
    const patch = await w.rest.patch(`/channels/${dm.id}`, { name: 'x' });
    assert.equal(patch.status, 403);
    assert.equal(patch.body.code, 50003);
    const del = await w.rest.delete(`/channels/${dm.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.id, dm.id);
    assert.equal(del.body.type, 1);
    const ow = await w.rest.put(`/channels/${dm.id}/permissions/${w.alice.id}`, { type: 1 });
    assert.equal(ow.status, 400);
    assert.equal(ow.body.code, 50024);
  });

  test('a bearer token cannot use channel routes', async () => {
    const { access_token } = w.fake.control.server.oauth.issue(w.fake.world.app(w.app.id), w.owner.id, ['identify']);
    const r = await client(w.fake, `Bearer ${access_token}`).patch(`/channels/${w.channelId}`, { name: 'x' });
    assert.equal(r.status, 401);
  });
});

// https://discord.com/developers/docs/topics/permissions#channel-visibility
// "Starting November 16, 2026, [Get Guild Channels] will omit any channel your bot doesn't have permissions to view."
describe('channel visibility in Get Guild Channels', () => {
  const setup = async (opts) => {
    const w = await world({ botPermissions: ['VIEW_CHANNEL', 'SEND_MESSAGES'], ...opts });
    const cat = w.c.createChannel({ guildId: w.guildId, name: 'staff', type: 4 });
    const hidden = w.c.createChannel({ guildId: w.guildId, name: 'secret', parentId: cat.id, permissionOverwrites: [{ id: w.guildId, type: 0, deny: ['VIEW_CHANNEL'] }] });
    const emptyCat = w.c.createChannel({ guildId: w.guildId, name: 'hidden-cat', type: 4, permissionOverwrites: [{ id: w.guildId, type: 0, deny: ['VIEW_CHANNEL'] }] });
    const visibleChild = w.c.createChannel({ guildId: w.guildId, name: 'open', parentId: emptyCat.id, permissionOverwrites: [{ id: w.botRole.id, type: 0, allow: ['VIEW_CHANNEL'] }] });
    return { w, cat, hidden, emptyCat, visibleChild };
  };

  test('before 2026-11-16 every channel is listed; from that date unviewable ones are omitted', async () => {
    const { w, hidden, emptyCat, visibleChild } = await setup({ now: '2026-11-15T23:59:00Z' });
    try {
      let ids = (await w.rest.get(`/guilds/${w.guildId}/channels`)).body.map((c) => c.id);
      assert.ok(ids.includes(hidden.id), 'still listed before the change date');
      w.c.setNow({ time: '2026-11-16T00:00:01Z' });
      const res = await w.rest.get(`/guilds/${w.guildId}/channels`);
      assert.equal(res.status, 200);
      ids = res.body.map((c) => c.id);
      assert.ok(!ids.includes(hidden.id), 'channel without VIEW_CHANNEL is omitted');
      assert.ok(ids.includes(w.channelId));
      assert.ok(ids.includes(visibleChild.id));
      assert.ok(ids.includes(emptyCat.id), 'a category is viewable if any child is viewable');
    } finally {
      await w.fake.close();
    }
  });

  test('channelObfuscation: true forces it regardless of the date', async () => {
    const { w, hidden } = await setup({ channelObfuscation: true });
    try {
      const res = await w.rest.get(`/guilds/${w.guildId}/channels`);
      assert.equal(res.status, 200);
      assert.ok(res.body.some((c) => c.id === w.channelId));
      assert.ok(!res.body.some((c) => c.id === hidden.id));
    } finally {
      await w.fake.close();
    }
  });
});
