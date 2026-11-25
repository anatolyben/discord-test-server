// Invites (get, delete, list by channel) and member prune
// https://discord.com/developers/docs/resources/invite, https://discord.com/developers/docs/resources/guild#begin-guild-prune
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, GatewayClient, DAY } from './helpers.js';
import { Intents as I } from '../src/constants.js';

const INTENTS = I.GUILDS | I.GUILD_INVITES | I.GUILD_MEMBERS | I.GUILD_MODERATION;

describe('invites', () => {
  let w, gc;
  before(async () => {
    w = await world({ rateLimits: false });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, INTENTS);
  });
  after(async () => { gc.close(); await w.fake.close(); });
  const make = (extra = {}) => w.rest.post(`/channels/${w.channelId}/invites`, { max_age: 3600, ...extra }).then((r) => r.body);

  test('GET /invites/:code -> the invite; with_counts adds approximate counts; unknown code -> 404/10006', async () => {
    const inv = await make({ max_uses: 5 });
    const r = await w.rest.get(`/invites/${inv.code}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.code, inv.code);
    assert.equal(r.body.guild.id, w.guildId);
    assert.equal(r.body.channel.id, w.channelId);
    assert.equal(r.body.approximate_member_count, undefined);
    const counts = await w.rest.get(`/invites/${inv.code}?with_counts=true`);
    assert.equal(counts.body.approximate_member_count, w.c.getMembers({ guildId: w.guildId }).length);
    assert.equal(typeof counts.body.approximate_presence_count, 'number');
    assert.equal((await w.rest.get('/invites/nope')).body.code, 10006);
  });

  test('an expired or used-up invite is unknown', async () => {
    const short = await make({ max_age: 60 });
    w.c.advance(61_000);
    assert.equal((await w.rest.get(`/invites/${short.code}`)).body.code, 10006);
    const once = await make({ max_age: 0, max_uses: 1 });
    w.c.join({ guildId: w.guildId, userId: w.c.createUser({ username: 'newcomer' }).id, inviteCode: once.code });
    assert.equal((await w.rest.get(`/invites/${once.code}`)).body.code, 10006);
  });

  test('DELETE /invites/:code -> the invite, INVITE_DELETE, audit entry 42 with the reason', async () => {
    const inv = await make();
    const r = await w.rest.delete(`/invites/${inv.code}`, { headers: { 'X-Audit-Log-Reason': 'leaked' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.code, inv.code);
    const ev = await gc.waitForDispatch('INVITE_DELETE', (d) => d.code === inv.code);
    assert.deepEqual(ev.d, { channel_id: w.channelId, guild_id: w.guildId, code: inv.code });
    const entry = (await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=42`)).body.audit_log_entries[0];
    assert.equal(entry.reason, 'leaked');
    assert.equal(entry.changes.find((c) => c.key === 'code').old_value, inv.code);
    assert.equal((await w.rest.get(`/invites/${inv.code}`)).body.code, 10006);
    assert.equal((await w.rest.delete(`/invites/${inv.code}`)).body.code, 10006);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/invites`)).body.some((i) => i.code === inv.code), false);
  });

  test('deleting needs MANAGE_CHANNELS on the invite\'s channel or MANAGE_GUILD', async () => {
    const inv = await make();
    const w2 = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL'] });
    try {
      const i2 = w2.c.createInvite({ guildId: w2.guildId, inviterId: w2.owner.id });
      assert.equal((await w2.rest.delete(`/invites/${i2.code}`)).body.code, 50013);
    } finally { await w2.fake.close(); }
    const w3 = await world({ rateLimits: false, botPermissions: ['MANAGE_GUILD'] });
    try {
      const i3 = w3.c.createInvite({ guildId: w3.guildId, inviterId: w3.owner.id });
      assert.equal((await w3.rest.delete(`/invites/${i3.code}`)).status, 200);
    } finally { await w3.fake.close(); }
    assert.ok(inv.code);
  });

  test('GET /channels/:id/invites lists that channel\'s invites and needs MANAGE_CHANNELS', async () => {
    const other = w.c.createChannel({ guildId: w.guildId, name: 'other', type: 0 });
    const inv = (await w.rest.post(`/channels/${other.id}/invites`, {})).body;
    const list = await w.rest.get(`/channels/${other.id}/invites`);
    assert.deepEqual(list.body.map((i) => i.code), [inv.code]);
    const w2 = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL', 'CREATE_INSTANT_INVITE'] });
    try {
      assert.equal((await w2.rest.get(`/channels/${w2.channelId}/invites`)).body.code, 50013);
    } finally { await w2.fake.close(); }
  });
});

describe('guild prune', () => {
  const setup = async (botPermissions) => {
    const w = await world({ rateLimits: false, botPermissions: botPermissions ?? ['ADMINISTRATOR'] });
    const quiet = w.c.createUser({ username: 'quiet' });
    const chatty = w.c.createUser({ username: 'chatty' });
    const roled = w.c.createUser({ username: 'roled' });
    w.c.addMember({ guildId: w.guildId, userId: quiet.id });
    w.c.addMember({ guildId: w.guildId, userId: chatty.id });
    w.c.addMember({ guildId: w.guildId, userId: roled.id, roles: [w.memberRole.id] });
    w.c.advance(10 * DAY);
    w.c.postMessage({ channelId: w.channelId, authorId: chatty.id, content: 'still here' });
    return { w, quiet, chatty, roled };
  };

  test('GET /prune counts members without roles who joined and stayed silent longer than `days` ago', async () => {
    const { w, quiet } = await setup();
    try {
      const r = await w.rest.get(`/guilds/${w.guildId}/prune?days=7`);
      assert.equal(r.status, 200);
      // alice, bob (no roles... alice has Member role), quiet: bob and quiet are silent without roles
      assert.equal(r.body.pruned, 2);
      assert.equal((await w.rest.get(`/guilds/${w.guildId}/prune?days=30`)).body.pruned, 0);
      assert.equal((await w.rest.get(`/guilds/${w.guildId}/prune?days=0`)).body.code, 50035);
      assert.equal((await w.rest.get(`/guilds/${w.guildId}/prune?days=31`)).body.code, 50035);
      assert.ok(quiet.id);
    } finally { await w.fake.close(); }
  });

  test('include_roles also counts members whose roles are all among them', async () => {
    const { w } = await setup();
    try {
      const r = await w.rest.get(`/guilds/${w.guildId}/prune?days=7&include_roles=${w.memberRole.id}`);
      assert.equal(r.body.pruned, 4); // + alice and roled hold only the Member role
      const other = await w.rest.get(`/guilds/${w.guildId}/prune?days=7&include_roles=${w.modRole.id}`);
      assert.equal(other.body.pruned, 3); // bob, quiet and the moderator (whose only role is Moderator); alice and roled hold Member
      assert.equal((await w.rest.get(`/guilds/${w.guildId}/prune?days=7&include_roles=abc`)).body.code, 50035);
    } finally { await w.fake.close(); }
  });

  test('POST /prune removes them: GUILD_MEMBER_REMOVE each, one MEMBER_PRUNE (21) entry with days and count, no kick entries', async () => {
    const { w, quiet, chatty } = await setup();
    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    try {
      await gc.ready(w.app.token, INTENTS);
      const r = await w.rest.post(`/guilds/${w.guildId}/prune`, { days: 7 }, { headers: { 'X-Audit-Log-Reason': 'cleanup' } });
      assert.equal(r.status, 200);
      assert.equal(r.body.pruned, 2);
      await gc.waitFor(() => gc.dispatches('GUILD_MEMBER_REMOVE').length >= 2);
      assert.ok(w.c.getMembers({ guildId: w.guildId }).some((m) => m.user.id === chatty.id));
      assert.ok(!w.c.getMembers({ guildId: w.guildId }).some((m) => m.user.id === quiet.id));
      const log = (await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=21`)).body.audit_log_entries;
      assert.equal(log.length, 1);
      assert.deepEqual(log[0].options, { delete_member_days: '7', members_removed: '2' });
      assert.equal(log[0].reason, 'cleanup');
      assert.equal((await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=20`)).body.audit_log_entries.length, 0);
    } finally { gc.close(); await w.fake.close(); }
  });

  test('compute_prune_count: false answers { pruned: null }; the owner and bots are never pruned', async () => {
    const { w } = await setup();
    try {
      const r = await w.rest.post(`/guilds/${w.guildId}/prune`, { days: 7, compute_prune_count: false });
      assert.deepEqual(r.body, { pruned: null });
      const members = w.c.getMembers({ guildId: w.guildId }).map((m) => m.user.id);
      assert.ok(members.includes(w.owner.id));
      assert.ok(members.includes(w.app.bot_user_id));
    } finally { await w.fake.close(); }
  });

  test('prune needs MANAGE_GUILD and KICK_MEMBERS (ADMINISTRATOR with PRUNE_REQUIRES_ADMIN)', async () => {
    const { w } = await setup(['KICK_MEMBERS']);
    try {
      assert.equal((await w.rest.get(`/guilds/${w.guildId}/prune`)).body.code, 50013);
      assert.equal((await w.rest.post(`/guilds/${w.guildId}/prune`, {})).body.code, 50013);
    } finally { await w.fake.close(); }
    const s2 = await setup(['KICK_MEMBERS', 'MANAGE_GUILD']);
    try {
      assert.equal((await s2.w.rest.get(`/guilds/${s2.w.guildId}/prune`)).status, 200);
      s2.w.c.updateGuild({ guildId: s2.w.guildId, features: ['PRUNE_REQUIRES_ADMIN'] });
      assert.equal((await s2.w.rest.get(`/guilds/${s2.w.guildId}/prune`)).body.code, 50013);
    } finally { await s2.w.fake.close(); }
  });
});
