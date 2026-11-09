// Permission computation contract – https://discord.com/developers/docs/topics/permissions
// Observed through the bot's REST calls (403/50013 Missing Permissions, 403/50001 Missing Access)
// and cross-checked with control.getPermissions.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './helpers.js';
import { Permissions as P, ALL_PERMISSIONS } from '../src/constants.js';

const worlds = [];
after(() => Promise.all(worlds.map((w) => w.fake.close())));

/** A world whose bot has only CREATE_INSTANT_INVITE on its managed role (plus @everyone). */
async function setup(opts = {}) {
  const w = await world({ botPermissions: ['CREATE_INSTANT_INVITE'], ...opts });
  worlds.push(w);
  w.bot = w.app.bot_user_id;
  w.perms = (userId = w.bot, channelId = w.channelId) => BigInt(w.c.getPermissions({ guildId: w.guildId, userId, channelId }).permissions);
  w.send = (content = 'hi', channelId = w.channelId) => w.rest.post(`/channels/${channelId}/messages`, { content });
  w.addBotRole = (name, permissions) => {
    const role = w.c.createRole({ guildId: w.guildId, name, permissions });
    const m = w.c.getMember({ guildId: w.guildId, userId: w.bot });
    w.c.updateMember({ guildId: w.guildId, userId: w.bot, roles: [...m.roles, role.id] });
    return role;
  };
  w.overwrite = (id, type, { allow = [], deny = [] }, channelId = w.channelId) => w.c.setPermissionOverwrite({ channelId, id, type, allow, deny });
  return w;
}

function assertError(res, status, code) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body?.code, code, JSON.stringify(res.body));
}

// https://discord.com/developers/docs/topics/permissions#permission-overwrites (compute_base_permissions)
describe('base permissions', () => {
  // https://discord.com/developers/docs/topics/permissions#permission-overwrites – "Base permissions given to @everyone are applied at a guild level"
  test('@everyone role permissions are the base for every member', async () => {
    const w = await setup();
    assert.equal((await w.send()).status, 200);
    const everyone = w.c.getRoles({ guildId: w.guildId }).find((r) => r.id === w.guildId);
    const without = BigInt(everyone.permissions) & ~P.SEND_MESSAGES;
    w.c.updateRole({ guildId: w.guildId, roleId: w.guildId, permissions: without.toString() });
    assertError(await w.send(), 403, 50013);
    assert.equal(w.perms() & P.SEND_MESSAGES, 0n);
    assert.equal(w.perms() & P.VIEW_CHANNEL, P.VIEW_CHANNEL);
  });

  // https://discord.com/developers/docs/topics/permissions#permission-overwrites – "Permissions allowed to a user by their roles are applied at a guild level"
  test('role permissions are OR-ed together', async () => {
    const w = await setup();
    assertError(await w.rest.delete(`/guilds/${w.guildId}/members/${w.bob.id}`), 403, 50013);
    assertError(await w.rest.get(`/guilds/${w.guildId}/audit-logs`), 403, 50013);
    w.addBotRole('Kickers', ['KICK_MEMBERS']);
    w.addBotRole('Auditors', ['VIEW_AUDIT_LOG']);
    const base = w.perms(w.bot, undefined);
    assert.equal(base & (P.KICK_MEMBERS | P.VIEW_AUDIT_LOG | P.CREATE_INSTANT_INVITE), P.KICK_MEMBERS | P.VIEW_AUDIT_LOG | P.CREATE_INSTANT_INVITE);
    assert.equal(base & P.BAN_MEMBERS, 0n);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/audit-logs`)).status, 200);
    assert.equal((await w.rest.delete(`/guilds/${w.guildId}/members/${w.bob.id}`)).status, 204);
    assertError(await w.rest.put(`/guilds/${w.guildId}/bans/${w.alice.id}`, {}), 403, 50013);
  });

  // https://discord.com/developers/docs/topics/permissions#permission-overwrites – ADMINISTRATOR returns ALL in compute_base_permissions
  test('ADMINISTRATOR (from any role) grants every permission and ignores channel overwrites', async () => {
    const w = await setup();
    w.overwrite(w.guildId, 0, { deny: ['VIEW_CHANNEL', 'SEND_MESSAGES'] });
    w.overwrite(w.bot, 1, { deny: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY'] });
    assertError(await w.rest.get(`/channels/${w.channelId}`), 403, 50001);
    w.addBotRole('Admins', ['ADMINISTRATOR']);
    assert.equal(w.perms(), ALL_PERMISSIONS);
    assert.equal((await w.rest.get(`/channels/${w.channelId}`)).status, 200);
    assert.equal((await w.send()).status, 200);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/audit-logs`)).status, 200);
  });

  // https://discord.com/developers/docs/topics/permissions#permission-overwrites – compute_base_permissions: "if guild.is_owner(member): return ALL"
  test('the guild owner has every permission, even against overwrites', async () => {
    const w = await setup();
    w.overwrite(w.guildId, 0, { deny: ['VIEW_CHANNEL'] });
    assertError(await w.rest.get(`/channels/${w.channelId}`), 403, 50001);
    assertError(await w.rest.get(`/guilds/${w.guildId}/audit-logs`), 403, 50013);
    w.c.updateGuild({ guildId: w.guildId, ownerId: w.bot });
    assert.equal(w.perms(), ALL_PERMISSIONS);
    assert.equal((await w.rest.get(`/channels/${w.channelId}`)).status, 200);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/audit-logs`)).status, 200);
  });
});

// https://discord.com/developers/docs/topics/permissions#permission-overwrites – overwrite order
describe('channel overwrites', () => {
  test('the @everyone overwrite is applied to the base', async () => {
    const w = await setup();
    w.overwrite(w.guildId, 0, { deny: ['SEND_MESSAGES'] });
    assertError(await w.send(), 403, 50013);
    assert.equal((await w.rest.get(`/channels/${w.channelId}`)).status, 200);
    assert.equal(w.perms() & P.SEND_MESSAGES, 0n);
    // Other channels are unaffected.
    const other = w.c.createChannel({ guildId: w.guildId, name: 'other' });
    assert.equal((await w.send('hi', other.id)).status, 200);
  });

  test('a role overwrite allow beats the @everyone overwrite deny', async () => {
    const w = await setup();
    w.overwrite(w.guildId, 0, { deny: ['SEND_MESSAGES'] });
    assertError(await w.send(), 403, 50013);
    w.overwrite(w.botRole.id, 0, { allow: ['SEND_MESSAGES'] });
    assert.equal((await w.send()).status, 200);
  });

  test('a role overwrite deny beats the @everyone overwrite allow', async () => {
    const w = await setup();
    w.overwrite(w.guildId, 0, { allow: ['SEND_MESSAGES'] });
    w.overwrite(w.botRole.id, 0, { deny: ['SEND_MESSAGES'] });
    assertError(await w.send(), 403, 50013);
  });

  // "Overwrites that deny permissions for specific roles are applied", then "Overwrites that allow permissions for specific roles are applied"
  test('role overwrites are aggregated: an allow on one role wins over a deny on another, regardless of role position', async () => {
    const w = await setup();
    const other = w.addBotRole('Other', []);
    w.overwrite(w.botRole.id, 0, { deny: ['SEND_MESSAGES'] }); // the higher role denies
    w.overwrite(other.id, 0, { allow: ['SEND_MESSAGES'] }); // the lower role allows
    assert.equal((await w.send()).status, 200);
    w.overwrite(w.botRole.id, 0, { allow: ['SEND_MESSAGES'] });
    w.overwrite(other.id, 0, { deny: ['SEND_MESSAGES'] });
    assert.equal((await w.send()).status, 200);
    // A role the member does not have does not count.
    w.overwrite(w.botRole.id, 0, {});
    w.overwrite(w.memberRole.id, 0, { allow: ['SEND_MESSAGES'] });
    assertError(await w.send(), 403, 50013);
  });

  test('the member overwrite is applied last', async () => {
    const w = await setup();
    w.overwrite(w.botRole.id, 0, { allow: ['SEND_MESSAGES'] });
    w.overwrite(w.bot, 1, { deny: ['SEND_MESSAGES'] });
    assertError(await w.send(), 403, 50013);
    w.overwrite(w.botRole.id, 0, { deny: ['SEND_MESSAGES'] });
    w.overwrite(w.bot, 1, { allow: ['SEND_MESSAGES'] });
    assert.equal((await w.send()).status, 200);
  });

  test('a member overwrite can grant a guild-level permission the roles lack', async () => {
    const w = await setup();
    const msg = w.c.postMessage({ channelId: w.channelId, authorId: w.alice.id, content: 'x' });
    assertError(await w.rest.delete(`/channels/${w.channelId}/messages/${msg.id}`), 403, 50013);
    w.overwrite(w.bot, 1, { allow: ['MANAGE_MESSAGES'] });
    assert.equal(w.perms() & P.MANAGE_MESSAGES, P.MANAGE_MESSAGES);
    assert.equal((await w.rest.delete(`/channels/${w.channelId}/messages/${msg.id}`)).status, 204);
  });
});

// https://discord.com/developers/docs/topics/permissions#implicit-permissions
describe('implicit permissions', () => {
  test('without VIEW_CHANNEL every other channel permission is ignored (403/50001)', async () => {
    const w = await setup();
    w.overwrite(w.guildId, 0, { deny: ['VIEW_CHANNEL'] });
    w.overwrite(w.bot, 1, { allow: ['SEND_MESSAGES', 'MANAGE_MESSAGES', 'READ_MESSAGE_HISTORY'] });
    assert.equal(w.perms(), 0n);
    assertError(await w.rest.get(`/channels/${w.channelId}`), 403, 50001);
    assertError(await w.send(), 403, 50001);
    assertError(await w.rest.get(`/channels/${w.channelId}/messages`), 403, 50001);
    // Granting VIEW_CHANNEL on the member overwrite restores access.
    w.overwrite(w.bot, 1, { allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'] });
    assert.equal((await w.send()).status, 200);
  });

  test('without SEND_MESSAGES, MENTION_EVERYONE / SEND_TTS_MESSAGES / ATTACH_FILES / EMBED_LINKS are implicitly denied', async () => {
    const w = await setup();
    const implied = P.MENTION_EVERYONE | P.SEND_TTS_MESSAGES | P.ATTACH_FILES | P.EMBED_LINKS;
    w.overwrite(w.bot, 1, { allow: ['MENTION_EVERYONE', 'SEND_TTS_MESSAGES', 'ATTACH_FILES', 'EMBED_LINKS'], deny: ['SEND_MESSAGES'] });
    assert.equal(w.perms() & implied, 0n);
    assert.equal(w.perms() & P.VIEW_CHANNEL, P.VIEW_CHANNEL);
    assertError(await w.send(), 403, 50013);
    w.overwrite(w.bot, 1, { allow: ['MENTION_EVERYONE', 'SEND_TTS_MESSAGES', 'ATTACH_FILES', 'EMBED_LINKS', 'SEND_MESSAGES'] });
    assert.equal(w.perms() & implied, implied);
    assert.equal((await w.send()).status, 200);
  });
});

// https://discord.com/developers/docs/topics/permissions#permissions-for-timed-out-members
describe('timed-out members', () => {
  test('a timed-out member keeps only VIEW_CHANNEL and READ_MESSAGE_HISTORY until the timeout ends', async () => {
    const w = await setup({ botPermissions: ['KICK_MEMBERS', 'MANAGE_MESSAGES', 'VIEW_AUDIT_LOG'] });
    w.c.postMessage({ channelId: w.channelId, authorId: w.alice.id, content: 'before the timeout' });
    const until = new Date(w.c.now().now + 60 * 60 * 1000).toISOString();
    w.c.updateMember({ guildId: w.guildId, userId: w.bot, communicationDisabledUntil: until });
    w.overwrite(w.bot, 1, { allow: ['SEND_MESSAGES', 'MANAGE_MESSAGES'] }); // overwrites cannot lift a timeout
    assert.equal(w.perms(), P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY);
    assert.equal((await w.rest.get(`/channels/${w.channelId}`)).status, 200);
    const msgs = await w.rest.get(`/channels/${w.channelId}/messages`);
    assert.equal(msgs.status, 200);
    assert.deepEqual(msgs.body.map((m) => m.content), ['before the timeout']);
    assertError(await w.send(), 403, 50013);
    assertError(await w.rest.delete(`/guilds/${w.guildId}/members/${w.bob.id}`), 403, 50013);
    assertError(await w.rest.get(`/guilds/${w.guildId}/audit-logs`), 403, 50013);
    // The timeout expires.
    w.c.advance(60 * 60 * 1000 + 1000);
    assert.equal((await w.send()).status, 200);
    assert.equal((await w.rest.delete(`/guilds/${w.guildId}/members/${w.bob.id}`)).status, 204);
  });

  test('ADMINISTRATOR members and the owner are exempt from timeout restrictions', async () => {
    const w = await setup({ botPermissions: ['ADMINISTRATOR'] });
    const until = new Date(w.c.now().now + 60 * 60 * 1000).toISOString();
    w.c.updateMember({ guildId: w.guildId, userId: w.bot, communicationDisabledUntil: until });
    assert.equal(w.perms(), ALL_PERMISSIONS);
    assert.equal((await w.send()).status, 200);

    const w2 = await setup();
    w2.c.updateMember({ guildId: w2.guildId, userId: w2.bot, communicationDisabledUntil: until });
    assertError(await w2.send(), 403, 50013);
    w2.c.updateGuild({ guildId: w2.guildId, ownerId: w2.bot });
    assert.equal(w2.perms(), ALL_PERMISSIONS);
    assert.equal((await w2.send()).status, 200);
  });
});
