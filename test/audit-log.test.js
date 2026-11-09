// Audit log contract – https://discord.com/developers/docs/resources/audit-log
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { world, GatewayClient } from './helpers.js';
import { Intents as I, AuditLogEvent as A } from '../src/constants.js';

const INTENTS = I.GUILDS | I.GUILD_MEMBERS | I.GUILD_MODERATION;
const reasonHeader = (r) => ({ headers: { 'X-Audit-Log-Reason': encodeURIComponent(r) } });

const worlds = [];
after(() => Promise.all(worlds.map((w) => w.fake.close())));

async function setup(opts = {}) {
  const w = await world(opts);
  worlds.push(w);
  w.bot = w.app.bot_user_id;
  w.log = (q = '') => w.rest.get(`/guilds/${w.guildId}/audit-logs${q}`);
  w.entries = async (q = '') => {
    const res = await w.log(q);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.audit_log_entries;
  };
  w.gateway = async (intents = INTENTS) => {
    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, intents);
    return gc;
  };
  return w;
}

function assertError(res, status, code) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body?.code, code, JSON.stringify(res.body));
}
const byIdDesc = (a, b) => (BigInt(b) > BigInt(a) ? 1 : -1);

// https://discord.com/developers/docs/resources/audit-log#get-guild-audit-log – "Requires the VIEW_AUDIT_LOG permission"
test('GET audit-logs needs VIEW_AUDIT_LOG', async () => {
  const w = await setup({ botPermissions: ['KICK_MEMBERS', 'BAN_MEMBERS'] });
  assertError(await w.log(), 403, 50013);
  w.c.setBotPermissions({ applicationId: w.app.id, guildId: w.guildId, permissions: ['VIEW_AUDIT_LOG'] });
  assert.equal((await w.log()).status, 200);
});

// https://discord.com/developers/docs/resources/audit-log#get-guild-audit-log
describe('listing, filters and pagination', () => {
  let w;
  let created;
  before(async () => {
    w = await setup();
    // The install already wrote ROLE_CREATE (managed role) and BOT_ADD, both by the installing owner.
    created = (await w.rest.post(`/guilds/${w.guildId}/roles`, { name: 'Helpers' })).body;
    w.c.kickMember({ actorId: w.mod.id, guildId: w.guildId, userId: w.bob.id, reason: 'by mod' });
    await w.rest.put(`/guilds/${w.guildId}/bans/${w.alice.id}`, {});
  });

  test('the audit log object: entries newest first plus the referenced users', async () => {
    const res = await w.log();
    assert.equal(res.status, 200);
    for (const k of ['audit_log_entries', 'users', 'integrations', 'webhooks', 'threads', 'application_commands', 'auto_moderation_rules', 'guild_scheduled_events']) {
      assert.ok(Array.isArray(res.body[k]), k);
    }
    const entries = res.body.audit_log_entries;
    assert.deepEqual(entries.map((e) => e.action_type), [A.MEMBER_BAN_ADD, A.MEMBER_KICK, A.ROLE_CREATE, A.BOT_ADD, A.ROLE_CREATE]);
    assert.deepEqual(entries.map((e) => e.id), [...entries.map((e) => e.id)].sort(byIdDesc));
    assert.deepEqual(entries.map((e) => e.user_id), [w.bot, w.mod.id, w.bot, w.owner.id, w.owner.id]);
    assert.equal(entries[4].target_id, w.botRole.id);
    assert.equal(entries[3].target_id, w.bot);
    assert.equal(entries[2].target_id, created.id);
    const users = res.body.users.map((u) => u.id);
    for (const id of [w.bot, w.mod.id, w.owner.id, w.bob.id, w.alice.id]) assert.ok(users.includes(id), id);
  });

  test('user_id and action_type filters', async () => {
    assert.deepEqual((await w.entries(`?user_id=${w.mod.id}`)).map((e) => e.action_type), [A.MEMBER_KICK]);
    assert.deepEqual((await w.entries(`?action_type=${A.ROLE_CREATE}`)).map((e) => e.target_id), [created.id, w.botRole.id]);
    assert.deepEqual((await w.entries(`?action_type=${A.ROLE_CREATE}&user_id=${w.bot}`)).map((e) => e.target_id), [created.id]);
    assert.deepEqual((await w.entries(`?user_id=${w.bot}&action_type=${A.MEMBER_BAN_ADD}`)).map((e) => e.target_id), [w.alice.id]);
    assert.deepEqual(await w.entries(`?user_id=${w.alice.id}`), []);
    const filtered = await w.log(`?user_id=${w.mod.id}`);
    assert.ok(filtered.body.users.some((u) => u.id === w.mod.id));
  });

  // "When using before, the list is ordered by the audit log entry ID descending ... If after is used, the list is reversed and appears in ascending order"
  test('limit / before (descending) / after (ascending)', async () => {
    const all = (await w.entries()).map((e) => e.id); // newest first
    assert.deepEqual((await w.entries('?limit=2')).map((e) => e.id), all.slice(0, 2));
    assert.deepEqual((await w.entries(`?limit=2&before=${all[1]}`)).map((e) => e.id), all.slice(2, 4));
    assert.deepEqual((await w.entries(`?before=${all[3]}`)).map((e) => e.id), [all[4]]);
    const oldestFirst = [...all].reverse();
    assert.deepEqual((await w.entries('?after=0&limit=2')).map((e) => e.id), oldestFirst.slice(0, 2));
    assert.deepEqual((await w.entries(`?after=${oldestFirst[1]}`)).map((e) => e.id), oldestFirst.slice(2));
    assert.deepEqual((await w.entries(`?after=${all[0]}`)).map((e) => e.id), []);
  });

  test('limit outside 1-100 -> 400/50035; bad filters -> 400/50035', async () => {
    assertError(await w.log('?limit=0'), 400, 50035);
    assertError(await w.log('?limit=101'), 400, 50035);
    assertError(await w.log('?user_id=abc'), 400, 50035);
    assertError(await w.log('?action_type=x'), 400, 50035);
    assert.equal((await w.log('?limit=100')).status, 200);
  });
});

// "limit ... defaults to 50"
test('the default page size is 50', async () => {
  const w = await setup();
  for (let i = 0; i < 55; i++) w.c.createRole({ guildId: w.guildId, name: `r${i}`, actorId: w.owner.id });
  assert.equal((await w.entries()).length, 50);
  assert.equal((await w.entries('?limit=100')).length, 57);
});

// https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object – "X-Audit-Log-Reason header supports 1-512 URL-encoded UTF-8 characters"
describe('X-Audit-Log-Reason', () => {
  test('the reason is URL-decoded and recorded; entries without the header have no reason', async () => {
    const w = await setup();
    const reason = 'Ünïcödé reason / 100% sure – spam & raid 🚫';
    const a = (await w.rest.post(`/guilds/${w.guildId}/roles`, { name: 'with' }, reasonHeader(reason))).body;
    const b = (await w.rest.post(`/guilds/${w.guildId}/roles`, { name: 'without' })).body;
    const c = (await w.rest.post(`/guilds/${w.guildId}/roles`, { name: 'plain' }, { headers: { 'X-Audit-Log-Reason': 'plain words' } })).body;
    const entries = await w.entries(`?action_type=${A.ROLE_CREATE}`);
    const of = (id) => entries.find((e) => e.target_id === id);
    assert.equal(of(a.id).reason, reason);
    assert.equal('reason' in of(b.id), false);
    assert.equal(of(c.id).reason, 'plain words');
  });

  test('a reason of 512 characters is accepted; 513 -> 400/50035 and nothing happens', async () => {
    const w = await setup();
    const ok = await w.rest.post(`/guilds/${w.guildId}/roles`, { name: 'ok' }, reasonHeader('é'.repeat(512)));
    assert.equal(ok.status, 200);
    const before = (await w.rest.get(`/guilds/${w.guildId}/roles`)).body.length;
    assertError(await w.rest.post(`/guilds/${w.guildId}/roles`, { name: 'too long' }, reasonHeader('x'.repeat(513))), 400, 50035);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/roles`)).body.length, before);
    assertError(await w.rest.delete(`/guilds/${w.guildId}/members/${w.bob.id}`, reasonHeader('x'.repeat(513))), 400, 50035);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/members/${w.bob.id}`)).status, 200);
    const [entry] = await w.entries(`?action_type=${A.ROLE_CREATE}`);
    assert.equal(entry.reason, 'é'.repeat(512));
  });
});

// https://discord.com/developers/docs/events/gateway-events#guild-audit-log-entry-create
describe('actors and GUILD_AUDIT_LOG_ENTRY_CREATE', () => {
  test('bot writes are attributed to the bot user and announced with guild_id', async () => {
    const w = await setup();
    const gc = await w.gateway();
    await w.rest.delete(`/guilds/${w.guildId}/members/${w.bob.id}`, reasonHeader('cleanup'));
    const ev = await gc.waitForDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', (d) => d.action_type === A.MEMBER_KICK);
    const [entry] = await w.entries(`?action_type=${A.MEMBER_KICK}`);
    assert.deepEqual(ev.d, { ...entry, guild_id: w.guildId });
    assert.equal(entry.user_id, w.bot);
    assert.equal(entry.reason, 'cleanup');
    gc.close();
  });

  test('hostile staff (control.actAs / kickMember / banMember) produce real entries and events, attributed to the human', async () => {
    const w = await setup();
    const gc = await w.gateway();
    const kicked = w.c.actAs({ userId: w.mod.id, method: 'DELETE', path: `/guilds/${w.guildId}/members/${w.bob.id}`, reason: 'go away' });
    assert.equal(kicked.status, 204);
    await gc.waitForDispatch('GUILD_MEMBER_REMOVE', (d) => d.user.id === w.bob.id);
    await gc.waitForDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', (d) => d.action_type === A.MEMBER_KICK && d.user_id === w.mod.id && d.reason === 'go away');
    w.c.banMember({ actorId: w.mod.id, guildId: w.guildId, userId: w.alice.id, reason: 'rogue mod' });
    await gc.waitForDispatch('GUILD_BAN_ADD', (d) => d.user.id === w.alice.id);
    await gc.waitForDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', (d) => d.action_type === A.MEMBER_BAN_ADD && d.user_id === w.mod.id);
    const mine = await w.entries(`?user_id=${w.mod.id}`);
    assert.deepEqual(mine.map((e) => [e.action_type, e.target_id, e.reason]), [
      [A.MEMBER_BAN_ADD, w.alice.id, 'rogue mod'],
      [A.MEMBER_KICK, w.bob.id, 'go away'],
    ]);
    // A human without the permission gets Discord's error and leaves no trace.
    const denied = w.c.actAs({ userId: w.bob.id, method: 'POST', path: `/guilds/${w.guildId}/roles`, body: { name: 'x' } });
    assert.equal(denied.status, 403);
    assert.deepEqual(await w.entries(`?user_id=${w.bob.id}`), []);
    gc.close();
  });

  // "This event is only sent to bots with the VIEW_AUDIT_LOG permission."
  test('the event is not sent to a bot without VIEW_AUDIT_LOG', async () => {
    const w = await setup({ botPermissions: ['BAN_MEMBERS'] });
    const gc = await w.gateway();
    w.c.banMember({ actorId: w.owner.id, guildId: w.guildId, userId: w.alice.id });
    await gc.waitForDispatch('GUILD_BAN_ADD', (d) => d.user.id === w.alice.id);
    assert.deepEqual(await gc.expectNone('GUILD_AUDIT_LOG_ENTRY_CREATE'), []);
    gc.close();
  });
});
