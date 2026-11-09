// Guild members contract – https://discord.com/developers/docs/resources/guild (members section)
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { world, GatewayClient, DAY } from './helpers.js';
import { Intents as I, AuditLogEvent as A } from '../src/constants.js';

const INTENTS = I.GUILDS | I.GUILD_MEMBERS | I.GUILD_MODERATION;
const MOD_PERMS = ['MANAGE_NICKNAMES', 'MANAGE_ROLES', 'MODERATE_MEMBERS', 'KICK_MEMBERS', 'VIEW_AUDIT_LOG'];
const REASON = 'Spam & abuse – 2nd warning 🚫';
const withReason = (reason = REASON) => ({ headers: { 'X-Audit-Log-Reason': encodeURIComponent(reason) } });

const worlds = [];
after(() => Promise.all(worlds.map((w) => w.fake.close())));

/** opts.below: put the bot's role between Member and Moderator (so Moderator is above the bot). */
async function setup(opts = {}) {
  const w = await world({ botPermissions: MOD_PERMS, ...opts });
  worlds.push(w);
  w.bot = w.app.bot_user_id;
  if (opts.below) w.c.setBotRolePosition({ applicationId: w.app.id, guildId: w.guildId, position: 2 });
  w.member = (userId) => w.rest.get(`/guilds/${w.guildId}/members/${userId}`);
  w.patch = (userId, body, o) => w.rest.patch(`/guilds/${w.guildId}/members/${userId}`, body, o);
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

const isoIn = (w, ms) => new Date(w.c.now().now + ms).toISOString();

// https://discord.com/developers/docs/resources/guild#get-guild-member
describe('get / list / search members', () => {
  let w;
  before(async () => {
    w = await setup();
    w.c.updateMember({ guildId: w.guildId, userId: w.bob.id, nick: 'Bobby' });
  });

  test('GET member returns the guild member object', async () => {
    const res = await w.member(w.alice.id);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.id, w.alice.id);
    assert.equal(res.body.user.username, 'alice');
    assert.deepEqual(res.body.roles, [w.memberRole.id]);
    assert.equal(res.body.nick, null);
    assert.equal(res.body.communication_disabled_until, null);
    assert.equal(typeof res.body.joined_at, 'string');
    assert.equal((await w.member(w.bob.id)).body.nick, 'Bobby');
  });

  // https://discord.com/developers/docs/topics/opcodes-and-status-codes#json – 10007 Unknown member
  test('GET of a user who is not a member -> 404/10007', async () => {
    const stranger = w.c.createUser({ username: 'stranger' });
    assertError(await w.member(stranger.id), 404, 10007);
    assertError(await w.member('123456789012345678'), 404, 10007);
  });

  // https://discord.com/developers/docs/resources/guild#list-guild-members – limit 1-1000 (default 1), after
  test('list members: default limit 1, ascending user ids, `after` pagination', async () => {
    const all = w.c.getMembers({ guildId: w.guildId }).map((m) => m.user.id);
    assert.equal(all.length, 5);
    const first = await w.rest.get(`/guilds/${w.guildId}/members`);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.map((m) => m.user.id), [all[0]]);
    const page1 = await w.rest.get(`/guilds/${w.guildId}/members?limit=2`);
    assert.deepEqual(page1.body.map((m) => m.user.id), all.slice(0, 2));
    const page2 = await w.rest.get(`/guilds/${w.guildId}/members?limit=2&after=${page1.body[1].user.id}`);
    assert.deepEqual(page2.body.map((m) => m.user.id), all.slice(2, 4));
    const page3 = await w.rest.get(`/guilds/${w.guildId}/members?limit=1000&after=${page2.body[1].user.id}`);
    assert.deepEqual(page3.body.map((m) => m.user.id), all.slice(4));
    const done = await w.rest.get(`/guilds/${w.guildId}/members?limit=1000&after=${all[4]}`);
    assert.deepEqual(done.body, []);
  });

  test('list members: limit outside 1-1000 -> 400/50035', async () => {
    assertError(await w.rest.get(`/guilds/${w.guildId}/members?limit=0`), 400, 50035);
    assertError(await w.rest.get(`/guilds/${w.guildId}/members?limit=1001`), 400, 50035);
  });

  // https://discord.com/developers/docs/resources/guild#search-guild-members – username or nickname prefix
  test('search matches username and nickname prefixes', async () => {
    const byName = await w.rest.get(`/guilds/${w.guildId}/members/search?query=ali&limit=10`);
    assert.equal(byName.status, 200);
    assert.deepEqual(byName.body.map((m) => m.user.id), [w.alice.id]);
    const byNick = await w.rest.get(`/guilds/${w.guildId}/members/search?query=Bobb&limit=10`);
    assert.deepEqual(byNick.body.map((m) => m.user.id), [w.bob.id]);
    const none = await w.rest.get(`/guilds/${w.guildId}/members/search?query=zzz&limit=10`);
    assert.deepEqual(none.body, []);
    // Default limit is 1.
    const o = await w.rest.get(`/guilds/${w.guildId}/members/search?query=o`);
    assert.equal(o.body.length, 1);
    assertError(await w.rest.get(`/guilds/${w.guildId}/members/search`), 400, 50035);
  });
});

// https://discord.com/developers/docs/resources/guild#list-guild-members – "requires the GUILD_MEMBERS Privileged Intent"
test('list members without the GUILD_MEMBERS privileged intent -> 403/50001', async () => {
  const w = await setup({ privilegedIntents: { guildMembers: false, messageContent: true } });
  assertError(await w.rest.get(`/guilds/${w.guildId}/members?limit=10`), 403, 50001);
  w.c.setPrivilegedIntents({ applicationId: w.app.id, guildMembers: true });
  const res = await w.rest.get(`/guilds/${w.guildId}/members?limit=10`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 5);
});

// https://discord.com/developers/docs/resources/guild#modify-guild-member – nick needs MANAGE_NICKNAMES
describe('modify member: nick', () => {
  test('needs MANAGE_NICKNAMES', async () => {
    const w = await setup({ botPermissions: ['KICK_MEMBERS'] });
    assertError(await w.patch(w.bob.id, { nick: 'Bobby' }), 403, 50013);
    assert.equal(w.c.getMember({ guildId: w.guildId, userId: w.bob.id }).nick, null);
  });

  test('sets the nick, fires GUILD_MEMBER_UPDATE and writes MEMBER_UPDATE (24) with the reason', async () => {
    const w = await setup();
    const gc = await w.gateway();
    const res = await w.patch(w.bob.id, { nick: 'Bobby' }, withReason());
    assert.equal(res.status, 200);
    assert.equal(res.body.nick, 'Bobby');
    assert.equal(res.body.user.id, w.bob.id);
    const ev = await gc.waitForDispatch('GUILD_MEMBER_UPDATE', (d) => d.user.id === w.bob.id);
    assert.equal(ev.d.guild_id, w.guildId);
    assert.equal(ev.d.nick, 'Bobby');
    const [entry] = await w.audit(`?action_type=${A.MEMBER_UPDATE}`);
    assert.equal(entry.user_id, w.bot);
    assert.equal(entry.target_id, w.bob.id);
    assert.equal(entry.reason, REASON);
    assert.deepEqual(entry.changes, [{ key: 'nick', new_value: 'Bobby' }]);
    gc.close();
  });

  test('nick longer than 32 characters -> 400/50035', async () => {
    const w = await setup();
    assertError(await w.patch(w.bob.id, { nick: 'x'.repeat(33) }), 400, 50035);
  });

  // https://discord.com/developers/docs/topics/permissions#permission-hierarchy – "edit nicknames for users whose highest role is lower"
  test('hierarchy: cannot rename a member whose highest role is not below the bot, nor the owner', async () => {
    const w = await setup({ below: true });
    assertError(await w.patch(w.mod.id, { nick: 'nope' }), 403, 50013);
    assertError(await w.patch(w.owner.id, { nick: 'nope' }), 403, 50013);
    assert.equal((await w.patch(w.alice.id, { nick: 'Ally' })).status, 200);
  });
});

// https://discord.com/developers/docs/resources/guild#modify-guild-member – roles need MANAGE_ROLES
describe('modify member: roles', () => {
  test('needs MANAGE_ROLES', async () => {
    const w = await setup({ botPermissions: ['KICK_MEMBERS'] });
    assertError(await w.patch(w.bob.id, { roles: [w.memberRole.id] }), 403, 50013);
  });

  // https://discord.com/developers/docs/resources/audit-log#audit-log-change-object-audit-log-change-exceptions – $add / $remove
  test('replaces the roles, fires GUILD_MEMBER_UPDATE and writes MEMBER_ROLE_UPDATE (25) with $add / $remove', async () => {
    const w = await setup();
    const gc = await w.gateway();
    const res = await w.patch(w.bob.id, { roles: [w.memberRole.id] }, withReason());
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.roles, [w.memberRole.id]);
    await gc.waitForDispatch('GUILD_MEMBER_UPDATE', (d) => d.user.id === w.bob.id && d.roles.includes(w.memberRole.id));
    const rem = await w.patch(w.bob.id, { roles: [] });
    assert.deepEqual(rem.body.roles, []);
    await gc.waitForDispatch('GUILD_MEMBER_UPDATE', (d) => d.user.id === w.bob.id && d.roles.length === 0);
    const [removed, added] = await w.audit(`?action_type=${A.MEMBER_ROLE_UPDATE}`);
    assert.equal(added.user_id, w.bot);
    assert.equal(added.target_id, w.bob.id);
    assert.equal(added.reason, REASON);
    assert.deepEqual(added.changes, [{ key: '$add', new_value: [{ id: w.memberRole.id, name: 'Member' }] }]);
    assert.deepEqual(removed.changes, [{ key: '$remove', new_value: [{ id: w.memberRole.id, name: 'Member' }] }]);
    assert.equal(removed.reason, undefined);
    gc.close();
  });

  // https://discord.com/developers/docs/topics/permissions#permission-hierarchy – "grant roles ... of a lower position than its own highest role"
  test('only roles below the bot\'s highest role can be granted or removed', async () => {
    const w = await setup({ below: true });
    assertError(await w.patch(w.bob.id, { roles: [w.modRole.id] }), 403, 50013);
    assertError(await w.patch(w.mod.id, { roles: [] }), 403, 50013);
    assert.deepEqual(w.c.getMember({ guildId: w.guildId, userId: w.mod.id }).roles, [w.modRole.id]);
    assert.equal((await w.patch(w.bob.id, { roles: [w.memberRole.id] })).status, 200);
  });

  // ASSUMPTION: managed (bot/integration) roles cannot be assigned manually; Discord answers 403/50013.
  test('managed roles are refused, even for an ADMINISTRATOR bot', async () => {
    const w = await setup({ botPermissions: ['ADMINISTRATOR'] });
    const other = w.c.createApplication({ name: 'OtherBot', ownerId: w.owner.id });
    w.c.installBot({ applicationId: other.id, guildId: w.guildId, permissions: ['VIEW_CHANNEL'] });
    const managed = w.c.getRoles({ guildId: w.guildId }).find((r) => r.tags?.bot_id === other.bot_user_id);
    assertError(await w.patch(w.bob.id, { roles: [managed.id] }), 403, 50013);
    assertError(await w.rest.put(`/guilds/${w.guildId}/members/${w.bob.id}/roles/${managed.id}`), 403, 50013);
    assert.deepEqual(w.c.getMember({ guildId: w.guildId, userId: w.bob.id }).roles, []);
  });
});

// https://discord.com/developers/docs/resources/guild#modify-guild-member – communication_disabled_until (MODERATE_MEMBERS)
describe('modify member: timeout', () => {
  test('needs MODERATE_MEMBERS', async () => {
    const w = await setup({ botPermissions: ['KICK_MEMBERS'] });
    assertError(await w.patch(w.bob.id, { communication_disabled_until: isoIn(w, DAY) }), 403, 50013);
  });

  test('times out, fires GUILD_MEMBER_UPDATE and writes MEMBER_UPDATE (24) with the communication_disabled_until change', async () => {
    const w = await setup();
    const gc = await w.gateway();
    const until = isoIn(w, DAY);
    const res = await w.patch(w.bob.id, { communication_disabled_until: until }, withReason());
    assert.equal(res.status, 200);
    const stored = res.body.communication_disabled_until; // Discord formats it as ISO8601 (+00:00)
    assert.equal(Date.parse(stored), Date.parse(until));
    const ev = await gc.waitForDispatch('GUILD_MEMBER_UPDATE', (d) => d.user.id === w.bob.id);
    assert.equal(ev.d.communication_disabled_until, stored);
    const [entry] = await w.audit(`?action_type=${A.MEMBER_UPDATE}`);
    assert.equal(entry.user_id, w.bot);
    assert.equal(entry.target_id, w.bob.id);
    assert.equal(entry.reason, REASON);
    assert.deepEqual(entry.changes, [{ key: 'communication_disabled_until', new_value: stored }]);
    // Removing the timeout.
    const cleared = await w.patch(w.bob.id, { communication_disabled_until: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.communication_disabled_until, null);
    const [entry2] = await w.audit(`?action_type=${A.MEMBER_UPDATE}`);
    assert.deepEqual(entry2.changes, [{ key: 'communication_disabled_until', old_value: stored }]);
    gc.close();
  });

  // "up to 28 days in the future"
  test('more than 28 days in the future -> 400/50035', async () => {
    const w = await setup();
    assertError(await w.patch(w.bob.id, { communication_disabled_until: isoIn(w, 28 * DAY + 60_000) }), 400, 50035);
    assert.equal(w.c.getMember({ guildId: w.guildId, userId: w.bob.id }).communication_disabled_until, null);
    assert.equal((await w.patch(w.bob.id, { communication_disabled_until: isoIn(w, 28 * DAY) })).status, 200);
  });

  test('not an ISO8601 timestamp -> 400/50035', async () => {
    const w = await setup();
    assertError(await w.patch(w.bob.id, { communication_disabled_until: 'tomorrow-ish' }), 400, 50035);
  });

  // "Will throw a 403 error if the user has the ADMINISTRATOR permission or is the owner of the guild"
  test('an ADMINISTRATOR target or the owner -> 403', async () => {
    const w = await setup({ botPermissions: ['ADMINISTRATOR'] });
    const admins = w.c.createRole({ guildId: w.guildId, name: 'Admins', permissions: ['ADMINISTRATOR'] });
    w.c.updateMember({ guildId: w.guildId, userId: w.alice.id, roles: [admins.id] });
    assert.equal((await w.patch(w.alice.id, { communication_disabled_until: isoIn(w, DAY) })).status, 403);
    assert.equal((await w.patch(w.owner.id, { communication_disabled_until: isoIn(w, DAY) })).status, 403);
    assert.equal(w.c.getMember({ guildId: w.guildId, userId: w.alice.id }).communication_disabled_until, null);
  });

  test('hierarchy: cannot time out a member whose highest role is not below the bot', async () => {
    const w = await setup({ below: true });
    assertError(await w.patch(w.mod.id, { communication_disabled_until: isoIn(w, DAY) }), 403, 50013);
    assert.equal((await w.patch(w.alice.id, { communication_disabled_until: isoIn(w, DAY) })).status, 200);
  });
});

// https://discord.com/developers/docs/resources/guild#remove-guild-member – KICK_MEMBERS
describe('kick', () => {
  test('needs KICK_MEMBERS', async () => {
    const w = await setup({ botPermissions: ['MANAGE_ROLES'] });
    assertError(await w.rest.delete(`/guilds/${w.guildId}/members/${w.bob.id}`), 403, 50013);
    assert.ok(w.c.getMember({ guildId: w.guildId, userId: w.bob.id }));
  });

  test('removes the member, fires GUILD_MEMBER_REMOVE and writes MEMBER_KICK (20) with the reason', async () => {
    const w = await setup();
    const gc = await w.gateway();
    const res = await w.rest.delete(`/guilds/${w.guildId}/members/${w.bob.id}`, withReason());
    assert.equal(res.status, 204);
    const ev = await gc.waitForDispatch('GUILD_MEMBER_REMOVE', (d) => d.user.id === w.bob.id);
    assert.equal(ev.d.guild_id, w.guildId);
    assertError(await w.member(w.bob.id), 404, 10007);
    const [entry] = await w.audit(`?action_type=${A.MEMBER_KICK}`);
    assert.equal(entry.user_id, w.bot);
    assert.equal(entry.target_id, w.bob.id);
    assert.equal(entry.reason, REASON);
    // Kicking again: the user is no longer a member.
    assertError(await w.rest.delete(`/guilds/${w.guildId}/members/${w.bob.id}`), 404, 10007);
    gc.close();
  });

  // https://discord.com/developers/docs/topics/permissions#permission-hierarchy – "only kick ... users whose highest role is lower"
  test('hierarchy: higher or equal members cannot be kicked; nobody can kick the owner', async () => {
    const w = await setup({ below: true });
    assertError(await w.rest.delete(`/guilds/${w.guildId}/members/${w.mod.id}`), 403, 50013);
    assertError(await w.rest.delete(`/guilds/${w.guildId}/members/${w.owner.id}`), 403, 50013);
    const admin = await setup({ botPermissions: ['ADMINISTRATOR'] });
    assertError(await admin.rest.delete(`/guilds/${admin.guildId}/members/${admin.owner.id}`), 403, 50013);
    assert.equal((await w.rest.delete(`/guilds/${w.guildId}/members/${w.alice.id}`)).status, 204);
  });
});

// https://discord.com/developers/docs/resources/guild#add-guild-member-role / #remove-guild-member-role
describe('add / remove member role', () => {
  test('PUT and DELETE return 204, fire GUILD_MEMBER_UPDATE and write MEMBER_ROLE_UPDATE (25)', async () => {
    const w = await setup();
    const gc = await w.gateway();
    const path = `/guilds/${w.guildId}/members/${w.bob.id}/roles/${w.memberRole.id}`;
    assert.equal((await w.rest.put(path, undefined, withReason('promote'))).status, 204);
    await gc.waitForDispatch('GUILD_MEMBER_UPDATE', (d) => d.user.id === w.bob.id && d.roles.includes(w.memberRole.id));
    assert.deepEqual((await w.member(w.bob.id)).body.roles, [w.memberRole.id]);
    assert.equal((await w.rest.delete(path, withReason('demote'))).status, 204);
    await gc.waitForDispatch('GUILD_MEMBER_UPDATE', (d) => d.user.id === w.bob.id && !d.roles.includes(w.memberRole.id));
    assert.deepEqual((await w.member(w.bob.id)).body.roles, []);
    const [removed, added] = await w.audit(`?action_type=${A.MEMBER_ROLE_UPDATE}&user_id=${w.bot}`);
    assert.equal(added.reason, 'promote');
    assert.equal(added.target_id, w.bob.id);
    assert.deepEqual(added.changes, [{ key: '$add', new_value: [{ id: w.memberRole.id, name: 'Member' }] }]);
    assert.equal(removed.reason, 'demote');
    assert.deepEqual(removed.changes, [{ key: '$remove', new_value: [{ id: w.memberRole.id, name: 'Member' }] }]);
    gc.close();
  });

  test('needs MANAGE_ROLES; role must be below the bot; unknown role 10011; unknown member 10007', async () => {
    const weak = await setup({ botPermissions: ['KICK_MEMBERS'] });
    assertError(await weak.rest.put(`/guilds/${weak.guildId}/members/${weak.bob.id}/roles/${weak.memberRole.id}`), 403, 50013);
    const w = await setup({ below: true });
    assertError(await w.rest.put(`/guilds/${w.guildId}/members/${w.bob.id}/roles/${w.modRole.id}`), 403, 50013);
    assertError(await w.rest.delete(`/guilds/${w.guildId}/members/${w.mod.id}/roles/${w.modRole.id}`), 403, 50013);
    assertError(await w.rest.put(`/guilds/${w.guildId}/members/${w.bob.id}/roles/123456789012345678`), 404, 10011);
    const stranger = w.c.createUser({ username: 'stranger' });
    assertError(await w.rest.put(`/guilds/${w.guildId}/members/${stranger.id}/roles/${w.memberRole.id}`), 404, 10007);
  });
});
