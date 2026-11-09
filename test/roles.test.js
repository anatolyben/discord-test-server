// Roles contract – https://discord.com/developers/docs/resources/guild#create-guild-role (and the other role endpoints)
// Hierarchy – https://discord.com/developers/docs/topics/permissions#permission-hierarchy
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, GatewayClient } from './helpers.js';
import { Intents as I, AuditLogEvent as A, Permissions as P } from '../src/constants.js';

const INTENTS = I.GUILDS | I.GUILD_MODERATION;
const BOT_PERMS = ['MANAGE_ROLES', 'VIEW_AUDIT_LOG', 'KICK_MEMBERS'];
const reasonHeader = (r) => ({ headers: { 'X-Audit-Log-Reason': encodeURIComponent(r) } });

const worlds = [];
after(() => Promise.all(worlds.map((w) => w.fake.close())));

/** opts.below: the bot's role sits between Member (1) and Moderator (3). */
async function setup(opts = {}) {
  const w = await world({ botPermissions: BOT_PERMS, ...opts });
  worlds.push(w);
  w.bot = w.app.bot_user_id;
  if (opts.below) w.c.setBotRolePosition({ applicationId: w.app.id, guildId: w.guildId, position: 2 });
  w.roles = () => w.rest.get(`/guilds/${w.guildId}/roles`);
  w.audit = async (q = '') => {
    const res = await w.rest.get(`/guilds/${w.guildId}/audit-logs${q}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.audit_log_entries;
  };
  w.gateway = async () => {
    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, INTENTS);
    return gc;
  };
  return w;
}

function assertError(res, status, code) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body?.code, code, JSON.stringify(res.body));
}

// https://discord.com/developers/docs/resources/guild#get-guild-roles / #get-guild-role
describe('read roles', () => {
  test('GET roles lists every role incl. @everyone; GET role returns one; unknown -> 404/10011', async () => {
    const w = await setup();
    const res = await w.roles();
    assert.equal(res.status, 200);
    const ids = res.body.map((r) => r.id);
    for (const id of [w.guildId, w.modRole.id, w.memberRole.id, w.botRole.id]) assert.ok(ids.includes(id), id);
    const one = await w.rest.get(`/guilds/${w.guildId}/roles/${w.modRole.id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.name, 'Moderator');
    assert.equal(one.body.managed, false);
    assert.equal(BigInt(one.body.permissions) & P.BAN_MEMBERS, P.BAN_MEMBERS);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/roles/${w.botRole.id}`)).body.managed, true);
    assertError(await w.rest.get(`/guilds/${w.guildId}/roles/123456789012345678`), 404, 10011);
  });
});

// https://discord.com/developers/docs/resources/guild#create-guild-role
describe('create role', () => {
  test('needs MANAGE_ROLES', async () => {
    const w = await setup({ botPermissions: ['KICK_MEMBERS'] });
    assertError(await w.rest.post(`/guilds/${w.guildId}/roles`, { name: 'x' }), 403, 50013);
  });

  test('creates the role, fires GUILD_ROLE_CREATE and writes ROLE_CREATE (30) with the reason', async () => {
    const w = await setup();
    const gc = await w.gateway();
    const res = await w.rest.post(`/guilds/${w.guildId}/roles`, {
      name: 'Helpers', permissions: String(P.KICK_MEMBERS), color: 0xff0000, hoist: true, mentionable: true,
    }, reasonHeader('new team'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const role = res.body;
    assert.equal(role.name, 'Helpers');
    assert.equal(role.permissions, String(P.KICK_MEMBERS));
    assert.equal(role.color, 0xff0000);
    assert.equal(role.hoist, true);
    assert.equal(role.mentionable, true);
    assert.equal(role.managed, false);
    const ev = await gc.waitForDispatch('GUILD_ROLE_CREATE', (d) => d.role.id === role.id);
    assert.equal(ev.d.guild_id, w.guildId);
    assert.equal(ev.d.role.name, 'Helpers');
    assert.ok((await w.roles()).body.some((r) => r.id === role.id));
    const [entry] = await w.audit(`?action_type=${A.ROLE_CREATE}`);
    assert.equal(entry.user_id, w.bot);
    assert.equal(entry.target_id, role.id);
    assert.equal(entry.reason, 'new team');
    assert.ok(entry.changes.some((c) => c.key === 'name' && c.new_value === 'Helpers'));
    gc.close();
  });

  // Defaults: name "new role", permissions = @everyone permissions, color 0, hoist/mentionable false
  test('all params are optional and default like Discord', async () => {
    const w = await setup();
    const everyone = (await w.rest.get(`/guilds/${w.guildId}/roles/${w.guildId}`)).body;
    const res = await w.rest.post(`/guilds/${w.guildId}/roles`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'new role');
    assert.equal(res.body.permissions, everyone.permissions);
    assert.equal(res.body.color, 0);
    assert.equal(res.body.hoist, false);
    assert.equal(res.body.mentionable, false);
  });

  // "it can only grant permissions it has"
  test('cannot create a role with permissions the bot lacks; an ADMINISTRATOR bot can', async () => {
    const w = await setup();
    const before = (await w.roles()).body.length;
    assertError(await w.rest.post(`/guilds/${w.guildId}/roles`, { name: 'Banners', permissions: String(P.BAN_MEMBERS) }), 403, 50013);
    assert.equal((await w.roles()).body.length, before);
    assert.equal((await w.rest.post(`/guilds/${w.guildId}/roles`, { name: 'Kickers', permissions: String(P.KICK_MEMBERS) })).status, 200);
    const admin = await setup({ botPermissions: ['ADMINISTRATOR'] });
    assert.equal((await admin.rest.post(`/guilds/${admin.guildId}/roles`, { name: 'Banners', permissions: String(P.BAN_MEMBERS) })).status, 200);
  });

  test('invalid fields -> 400/50035', async () => {
    const w = await setup();
    assertError(await w.rest.post(`/guilds/${w.guildId}/roles`, { name: 'x'.repeat(101) }), 400, 50035);
    assertError(await w.rest.post(`/guilds/${w.guildId}/roles`, { color: 0x1000000 }), 400, 50035);
    assertError(await w.rest.post(`/guilds/${w.guildId}/roles`, { permissions: 'lots' }), 400, 50035);
    assertError(await w.rest.post(`/guilds/${w.guildId}/roles`, { hoist: 'yes' }), 400, 50035);
  });
});

// https://discord.com/developers/docs/resources/guild#modify-guild-role
describe('modify role', () => {
  test('updates the role, fires GUILD_ROLE_UPDATE and writes ROLE_UPDATE (31) with old/new values', async () => {
    const w = await setup();
    const gc = await w.gateway();
    const res = await w.rest.patch(`/guilds/${w.guildId}/roles/${w.memberRole.id}`, { name: 'Members', color: 0x00ff00 }, reasonHeader('rename'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.name, 'Members');
    assert.equal(res.body.color, 0x00ff00);
    const ev = await gc.waitForDispatch('GUILD_ROLE_UPDATE', (d) => d.role.id === w.memberRole.id);
    assert.equal(ev.d.guild_id, w.guildId);
    assert.equal(ev.d.role.name, 'Members');
    const [entry] = await w.audit(`?action_type=${A.ROLE_UPDATE}`);
    assert.equal(entry.user_id, w.bot);
    assert.equal(entry.target_id, w.memberRole.id);
    assert.equal(entry.reason, 'rename');
    assert.deepEqual(entry.changes.find((c) => c.key === 'name'), { key: 'name', old_value: 'Member', new_value: 'Members' });
    assert.deepEqual(entry.changes.find((c) => c.key === 'color'), { key: 'color', old_value: 0, new_value: 0x00ff00 });
    gc.close();
  });

  test('needs MANAGE_ROLES; unknown role -> 404/10011', async () => {
    const weak = await setup({ botPermissions: ['KICK_MEMBERS'] });
    assertError(await weak.rest.patch(`/guilds/${weak.guildId}/roles/${weak.memberRole.id}`, { name: 'x' }), 403, 50013);
    const w = await setup();
    assertError(await w.rest.patch(`/guilds/${w.guildId}/roles/123456789012345678`, { name: 'x' }), 404, 10011);
  });

  // "A bot can edit roles of a lower position than its highest role"
  test('hierarchy: only roles below the bot\'s highest role can be edited', async () => {
    const w = await setup({ below: true });
    assertError(await w.rest.patch(`/guilds/${w.guildId}/roles/${w.modRole.id}`, { name: 'x' }), 403, 50013);
    assertError(await w.rest.patch(`/guilds/${w.guildId}/roles/${w.botRole.id}`, { name: 'x' }), 403, 50013);
    assert.equal(w.c.getRoles({ guildId: w.guildId }).find((r) => r.id === w.modRole.id).name, 'Moderator');
    assert.equal((await w.rest.patch(`/guilds/${w.guildId}/roles/${w.memberRole.id}`, { name: 'ok' })).status, 200);
  });

  // "... but it can only grant permissions it has to those roles"
  test('cannot add permissions the bot lacks', async () => {
    const w = await setup();
    assertError(await w.rest.patch(`/guilds/${w.guildId}/roles/${w.memberRole.id}`, { permissions: String(P.BAN_MEMBERS) }), 403, 50013);
    const ok = await w.rest.patch(`/guilds/${w.guildId}/roles/${w.memberRole.id}`, { permissions: String(P.KICK_MEMBERS) });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.permissions, String(P.KICK_MEMBERS));
  });
});

// https://discord.com/developers/docs/resources/guild#modify-guild-role-positions
describe('modify role positions', () => {
  test('reorders roles below the bot, returns every role and fires GUILD_ROLE_UPDATE for the moved roles', async () => {
    const w = await setup(); // Member 1, Moderator 2, bot 3
    const gc = await w.gateway();
    const res = await w.rest.patch(`/guilds/${w.guildId}/roles`, [{ id: w.memberRole.id, position: 2 }]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.length, 4);
    const pos = Object.fromEntries(res.body.map((r) => [r.id, r.position]));
    assert.equal(pos[w.memberRole.id], 2);
    assert.equal(pos[w.modRole.id], 1);
    assert.equal(pos[w.botRole.id], 3);
    assert.equal(pos[w.guildId], 0);
    await gc.waitForDispatch('GUILD_ROLE_UPDATE', (d) => d.role.id === w.memberRole.id && d.role.position === 2);
    await gc.waitForDispatch('GUILD_ROLE_UPDATE', (d) => d.role.id === w.modRole.id && d.role.position === 1);
    gc.close();
  });

  // "A bot can only sort roles lower than its highest role."
  test('cannot move a role at/above its own highest role, nor move a role up to it', async () => {
    const w = await setup({ below: true }); // Member 1, bot 2, Moderator 3
    assertError(await w.rest.patch(`/guilds/${w.guildId}/roles`, [{ id: w.modRole.id, position: 1 }]), 403, 50013);
    assertError(await w.rest.patch(`/guilds/${w.guildId}/roles`, [{ id: w.memberRole.id, position: 3 }]), 403, 50013);
    assertError(await w.rest.patch(`/guilds/${w.guildId}/roles`, [{ id: w.botRole.id, position: 1 }]), 403, 50013);
    const roles = w.c.getRoles({ guildId: w.guildId });
    assert.equal(roles.find((r) => r.id === w.modRole.id).position, 3);
    assert.equal(roles.find((r) => r.id === w.memberRole.id).position, 1);
  });

  test('needs MANAGE_ROLES; body must be a list of {id}; unknown role -> 10011', async () => {
    const weak = await setup({ botPermissions: ['KICK_MEMBERS'] });
    assertError(await weak.rest.patch(`/guilds/${weak.guildId}/roles`, [{ id: weak.memberRole.id, position: 1 }]), 403, 50013);
    const w = await setup();
    assertError(await w.rest.patch(`/guilds/${w.guildId}/roles`, { id: w.memberRole.id }), 400, 50035);
    assertError(await w.rest.patch(`/guilds/${w.guildId}/roles`, [{ position: 1 }]), 400, 50035);
    assertError(await w.rest.patch(`/guilds/${w.guildId}/roles`, [{ id: '123456789012345678', position: 1 }]), 404, 10011);
  });
});

// https://discord.com/developers/docs/resources/guild#delete-guild-role
describe('delete role', () => {
  test('-> 204, fires GUILD_ROLE_DELETE, writes ROLE_DELETE (32) and strips the role from members', async () => {
    const w = await setup();
    const gc = await w.gateway();
    const res = await w.rest.delete(`/guilds/${w.guildId}/roles/${w.memberRole.id}`, reasonHeader('cleanup'));
    assert.equal(res.status, 204);
    const ev = await gc.waitForDispatch('GUILD_ROLE_DELETE', (d) => d.role_id === w.memberRole.id);
    assert.equal(ev.d.guild_id, w.guildId);
    assertError(await w.rest.get(`/guilds/${w.guildId}/roles/${w.memberRole.id}`), 404, 10011);
    assert.deepEqual(w.c.getMember({ guildId: w.guildId, userId: w.alice.id }).roles, []);
    const [entry] = await w.audit(`?action_type=${A.ROLE_DELETE}`);
    assert.equal(entry.user_id, w.bot);
    assert.equal(entry.target_id, w.memberRole.id);
    assert.equal(entry.reason, 'cleanup');
    assert.ok(entry.changes.some((c) => c.key === 'name' && c.old_value === 'Member'));
    assertError(await w.rest.delete(`/guilds/${w.guildId}/roles/${w.memberRole.id}`), 404, 10011);
    gc.close();
  });

  test('@everyone cannot be deleted (400/50028); managed roles cannot be deleted', async () => {
    const w = await setup({ botPermissions: ['ADMINISTRATOR'] });
    assertError(await w.rest.delete(`/guilds/${w.guildId}/roles/${w.guildId}`), 400, 50028);
    const other = w.c.createApplication({ name: 'OtherBot', ownerId: w.owner.id });
    w.c.installBot({ applicationId: other.id, guildId: w.guildId, permissions: ['VIEW_CHANNEL'] });
    const managed = w.c.getRoles({ guildId: w.guildId }).find((r) => r.tags?.bot_id === other.bot_user_id);
    const res = await w.rest.delete(`/guilds/${w.guildId}/roles/${managed.id}`);
    assert.ok(res.status === 400 || res.status === 403, `${res.status} ${JSON.stringify(res.body)}`);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/roles/${managed.id}`)).status, 200);
  });

  test('needs MANAGE_ROLES and the role must be below the bot\'s highest role', async () => {
    const weak = await setup({ botPermissions: ['KICK_MEMBERS'] });
    assertError(await weak.rest.delete(`/guilds/${weak.guildId}/roles/${weak.memberRole.id}`), 403, 50013);
    const w = await setup({ below: true });
    assertError(await w.rest.delete(`/guilds/${w.guildId}/roles/${w.modRole.id}`), 403, 50013);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/roles/${w.modRole.id}`)).status, 200);
  });
});
