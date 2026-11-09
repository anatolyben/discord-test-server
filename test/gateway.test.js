// Gateway contract – https://discord.com/developers/docs/events/gateway
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { world, GatewayClient, sleep } from './helpers.js';
import { Intents as I, GatewayOp as OP } from '../src/constants.js';

const ALL_NON_PRIVILEGED = I.GUILDS | I.GUILD_MODERATION | I.GUILD_MESSAGES | I.DIRECT_MESSAGES | I.AUTO_MODERATION_EXECUTION | I.AUTO_MODERATION_CONFIGURATION | I.GUILD_INVITES;
const ALL = ALL_NON_PRIVILEGED | I.GUILD_MEMBERS | I.MESSAGE_CONTENT;

describe('session lifecycle', () => {
  let w;
  before(async () => { w = await world(); });
  after(() => w.fake.close());

  test('HELLO carries heartbeat_interval', async () => {
    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    const hello = await gc.waitForOp(OP.HELLO);
    assert.equal(hello.d.heartbeat_interval, 2000);
    gc.close();
  });

  test('IDENTIFY -> READY with session id, resume url, unavailable guilds, then GUILD_CREATE', async () => {
    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    const ready = await gc.ready(w.app.token, ALL);
    assert.equal(ready.v, 10);
    assert.equal(ready.user.id, w.app.bot_user_id);
    assert.equal(ready.user.bot, true);
    assert.match(ready.session_id, /^[0-9a-f]{32}$/);
    assert.equal(ready.resume_gateway_url, w.fake.gatewayUrl);
    assert.deepEqual(ready.guilds, [{ id: w.guildId, unavailable: true }]);
    assert.deepEqual(ready.shard, [0, 1]);
    assert.equal(ready.application.id, w.app.id);
    const gcreate = gc.dispatches('GUILD_CREATE')[0];
    assert.equal(gcreate.d.id, w.guildId);
    assert.equal(gcreate.d.unavailable, false);
    assert.equal(gcreate.d.member_count, 5);
    assert.ok(gcreate.d.channels.some((c) => c.id === w.channelId));
    assert.ok(gcreate.d.roles.some((r) => r.id === w.guildId));
    assert.ok(gcreate.d.joined_at);
    // Sequence numbers increase by one per dispatch.
    const seqs = gc.dispatches().map((f) => f.s);
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
    gc.close();
  });

  test('HEARTBEAT is answered with HEARTBEAT_ACK', async () => {
    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.waitForOp(OP.HELLO);
    gc.send(OP.HEARTBEAT, null);
    await gc.waitForOp(OP.HEARTBEAT_ACK);
    gc.close();
  });

  test('a missed heartbeat closes the connection', async () => {
    const fake = w.fake;
    fake.control.server.gateway.opts.heartbeatTimeoutMs = 150;
    try {
      const gc = await GatewayClient.connect(fake.gatewayUrl);
      await gc.waitForOp(OP.HELLO);
      const closed = await gc.waitForClose(1500);
      assert.equal(closed.code, 4009);
    } finally {
      fake.control.server.gateway.opts.heartbeatTimeoutMs = null;
    }
  });

  for (const [name, setup, code] of [
    ['invalid token -> 4004', (gc) => gc.identify('nope', ALL_NON_PRIVILEGED), 4004],
    ['unknown intent bits -> 4013', (gc) => gc.identify(w.app.token, 1 << 30), 4013],
    ['invalid shard -> 4010', (gc) => gc.identify(w.app.token, ALL_NON_PRIVILEGED, { shard: [2, 2] }), 4010],
    ['payload before identify -> 4003', (gc) => gc.send(OP.REQUEST_GUILD_MEMBERS, { guild_id: w.guildId }), 4003],
    ['unknown opcode -> 4001', (gc) => gc.send(99, {}), 4001],
    ['undecodable payload -> 4002', (gc) => gc.sendRaw('{nope'), 4002],
  ]) {
    test(`close codes: ${name}`, async () => {
      const gc = await GatewayClient.connect(w.fake.gatewayUrl);
      await gc.waitForOp(OP.HELLO);
      setup(gc);
      const closed = await gc.waitForClose();
      assert.equal(closed.code, code);
    });
  }

  test('close codes: second IDENTIFY -> 4005', async () => {
    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, ALL_NON_PRIVILEGED);
    gc.identify(w.app.token, ALL_NON_PRIVILEGED);
    assert.equal((await gc.waitForClose()).code, 4005);
  });

  test('close codes: unsupported API version -> 4012', async () => {
    const gc = await GatewayClient.connect(w.fake.gatewayUrl, '?v=6&encoding=json');
    assert.equal((await gc.waitForClose()).code, 4012);
  });
});

describe('privileged intents', () => {
  test('a privileged intent not enabled for the application -> 4014; enabling it allows identify', async () => {
    const w = await world({ privilegedIntents: { guildMembers: false, messageContent: false } });
    try {
      const gc = await GatewayClient.connect(w.fake.gatewayUrl);
      await gc.waitForOp(OP.HELLO);
      gc.identify(w.app.token, I.GUILDS | I.GUILD_MEMBERS);
      assert.equal((await gc.waitForClose()).code, 4014);

      w.c.setPrivilegedIntents({ applicationId: w.app.id, guildMembers: true });
      const gc2 = await GatewayClient.connect(w.fake.gatewayUrl);
      const ready = await gc2.ready(w.app.token, I.GUILDS | I.GUILD_MEMBERS);
      assert.equal(ready.user.id, w.app.bot_user_id);
      gc2.close();

      const gc3 = await GatewayClient.connect(w.fake.gatewayUrl);
      await gc3.waitForOp(OP.HELLO);
      gc3.identify(w.app.token, I.GUILDS | I.MESSAGE_CONTENT);
      assert.equal((await gc3.waitForClose()).code, 4014);
    } finally {
      await w.fake.close();
    }
  });
});

describe('sharding', () => {
  test('a guild goes to shard (guild_id >> 22) % shard_count', async () => {
    const w = await world();
    try {
      // Add guilds until both shards of 2 have one.
      const ids = [w.guildId];
      for (let i = 0; i < 6; i++) {
        const g = w.c.createGuild({ name: `G${i}`, ownerId: w.owner.id });
        w.c.installBot({ applicationId: w.app.id, guildId: g.id, permissions: ['ADMINISTRATOR'] });
        ids.push(g.id);
        w.c.advance(1);
      }
      const shardOf = (id) => Number((BigInt(id) >> 22n) % 2n);
      const s0 = await GatewayClient.connect(w.fake.gatewayUrl);
      const s1 = await GatewayClient.connect(w.fake.gatewayUrl);
      const r0 = await s0.ready(w.app.token, I.GUILDS | I.GUILD_MESSAGES, { shard: [0, 2] });
      const r1 = await s1.ready(w.app.token, I.GUILDS | I.GUILD_MESSAGES, { shard: [1, 2] });
      assert.deepEqual(r0.guilds.map((g) => g.id).sort(), ids.filter((id) => shardOf(id) === 0).sort());
      assert.deepEqual(r1.guilds.map((g) => g.id).sort(), ids.filter((id) => shardOf(id) === 1).sort());
      assert.ok(r0.guilds.length > 0 && r1.guilds.length > 0, 'both shards got guilds');
      // A message in a shard-1 guild only reaches shard 1.
      const g1 = ids.find((id) => shardOf(id) === 1);
      const ch = w.c.getGuild({ guildId: g1 }) && w.fake.world.guild(g1).system_channel_id;
      w.c.postMessage({ channelId: ch, authorId: w.owner.id, content: 'hi shard 1' });
      await s1.waitForDispatch('MESSAGE_CREATE', (d) => d.guild_id === g1);
      assert.equal((await s0.expectNone('MESSAGE_CREATE')).length, 0);
      s0.close(); s1.close();
    } finally {
      await w.fake.close();
    }
  });
});

describe('resume and reconnect', () => {
  let w;
  before(async () => { w = await world(); });
  after(() => w.fake.close());

  test('RESUME replays dispatches missed after the given sequence, then RESUMED', async () => {
    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    const ready = await gc.ready(w.app.token, ALL);
    const lastSeq = gc.seq;
    gc.close(4000);
    await gc.waitForClose();
    w.c.postMessage({ channelId: w.channelId, authorId: w.alice.id, content: 'while you were away' });
    w.c.postMessage({ channelId: w.channelId, authorId: w.bob.id, content: 'second' });
    const gc2 = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc2.waitForOp(OP.HELLO);
    gc2.send(OP.RESUME, { token: w.app.token, session_id: ready.session_id, seq: lastSeq });
    await gc2.waitForDispatch('RESUMED');
    const replayed = gc2.dispatches('MESSAGE_CREATE');
    assert.deepEqual(replayed.map((f) => f.d.content), ['while you were away', 'second']);
    assert.deepEqual(replayed.map((f) => f.s), [lastSeq + 1, lastSeq + 2]);
    gc2.close();
  });

  test('RESUME of an unknown session -> INVALID_SESSION (d: false)', async () => {
    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.waitForOp(OP.HELLO);
    gc.send(OP.RESUME, { token: w.app.token, session_id: 'deadbeef', seq: 1 });
    const inv = await gc.waitForOp(OP.INVALID_SESSION);
    assert.equal(inv.d, false);
    gc.close();
  });

  test('closing with 1000 invalidates the session', async () => {
    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    const ready = await gc.ready(w.app.token, ALL);
    gc.close(1000);
    await gc.waitForClose();
    const gc2 = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc2.waitForOp(OP.HELLO);
    gc2.send(OP.RESUME, { token: w.app.token, session_id: ready.session_id, seq: gc.seq });
    assert.equal((await gc2.waitForOp(OP.INVALID_SESSION)).d, false);
    gc2.close();
  });

  test('control can trigger RECONNECT, INVALID_SESSION and a server-side close', async () => {
    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    const ready = await gc.ready(w.app.token, ALL);
    assert.equal(w.c.requestGatewayReconnect({ sessionId: ready.session_id }).sent, 1);
    await gc.waitForOp(OP.RECONNECT);
    w.c.invalidateGatewaySession({ sessionId: ready.session_id, resumable: true });
    assert.equal((await gc.waitForOp(OP.INVALID_SESSION)).d, true);
    w.c.closeGatewaySession({ sessionId: ready.session_id, code: 4000 });
    assert.equal((await gc.waitForClose()).code, 4000);
    // Still resumable after a 4000 close.
    const gc2 = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc2.waitForOp(OP.HELLO);
    gc2.send(OP.RESUME, { token: w.app.token, session_id: ready.session_id, seq: gc.seq });
    await gc2.waitForDispatch('RESUMED');
    w.c.invalidateGatewaySession({ sessionId: ready.session_id, resumable: false });
    assert.equal((await gc2.waitFor(() => gc2.frames.find((f) => f.op === OP.INVALID_SESSION))).d, false);
    gc2.close();
  });
});

describe('intent filtering', () => {
  let w;
  before(async () => { w = await world(); });
  after(() => w.fake.close());

  test('message events need GUILD_MESSAGES', async () => {
    const yes = await GatewayClient.connect(w.fake.gatewayUrl);
    const no = await GatewayClient.connect(w.fake.gatewayUrl);
    await yes.ready(w.app.token, I.GUILDS | I.GUILD_MESSAGES);
    await no.ready(w.app.token, I.GUILDS);
    w.c.postMessage({ channelId: w.channelId, authorId: w.alice.id, content: 'hello' });
    const f = await yes.waitForDispatch('MESSAGE_CREATE');
    assert.equal(f.d.guild_id, w.guildId);
    assert.equal(f.d.channel_type, 0);
    assert.equal(f.d.member.roles[0], w.memberRole.id);
    assert.equal(f.d.author.id, w.alice.id);
    assert.equal((await no.expectNone('MESSAGE_CREATE')).length, 0);
    yes.close(); no.close();
  });

  test('member events need GUILD_MEMBERS', async () => {
    const yes = await GatewayClient.connect(w.fake.gatewayUrl);
    const no = await GatewayClient.connect(w.fake.gatewayUrl);
    await yes.ready(w.app.token, I.GUILDS | I.GUILD_MEMBERS);
    await no.ready(w.app.token, I.GUILDS);
    const carol = w.c.createUser({ username: 'carol' });
    w.c.join({ guildId: w.guildId, userId: carol.id });
    const add = await yes.waitForDispatch('GUILD_MEMBER_ADD');
    assert.equal(add.d.user.id, carol.id);
    assert.equal(add.d.guild_id, w.guildId);
    w.c.leave({ guildId: w.guildId, userId: carol.id });
    const rem = await yes.waitForDispatch('GUILD_MEMBER_REMOVE');
    assert.deepEqual(rem.d, { guild_id: w.guildId, user: add.d.user });
    assert.equal((await no.expectNone('GUILD_MEMBER_ADD')).length, 0);
    yes.close(); no.close();
  });

  test('audit-log events need GUILD_MODERATION and VIEW_AUDIT_LOG', async () => {
    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, I.GUILDS | I.GUILD_MODERATION);
    const noIntent = await GatewayClient.connect(w.fake.gatewayUrl);
    await noIntent.ready(w.app.token, I.GUILDS);
    await w.rest.put(`/guilds/${w.guildId}/bans/${w.bob.id}`, {}, { headers: { 'X-Audit-Log-Reason': 'spam' } });
    const entry = await gc.waitForDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE');
    assert.equal(entry.d.action_type, 22);
    assert.equal(entry.d.reason, 'spam');
    assert.equal(entry.d.guild_id, w.guildId);
    await gc.waitForDispatch('GUILD_BAN_ADD', (d) => d.user.id === w.bob.id);
    assert.equal((await noIntent.expectNone('GUILD_AUDIT_LOG_ENTRY_CREATE')).length, 0);

    // Without VIEW_AUDIT_LOG the entry is not delivered.
    w.c.setBotPermissions({ applicationId: w.app.id, guildId: w.guildId, permissions: ['BAN_MEMBERS'] });
    const before = gc.dispatches('GUILD_AUDIT_LOG_ENTRY_CREATE').length;
    await w.rest.delete(`/guilds/${w.guildId}/bans/${w.bob.id}`);
    await gc.waitForDispatch('GUILD_BAN_REMOVE');
    await sleep(100);
    assert.equal(gc.dispatches('GUILD_AUDIT_LOG_ENTRY_CREATE').length, before);
    gc.close(); noIntent.close();
  });

  test('without MESSAGE_CONTENT, content fields are empty except DMs, mentions and own messages', async () => {
    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, I.GUILDS | I.GUILD_MESSAGES | I.DIRECT_MESSAGES);
    w.c.setBotPermissions({ applicationId: w.app.id, guildId: w.guildId, permissions: ['ADMINISTRATOR'] });
    w.c.postMessage({ channelId: w.channelId, authorId: w.alice.id, content: 'secret', embeds: [{ title: 'x' }] });
    const plain = await gc.waitForDispatch('MESSAGE_CREATE', (d) => d.author.id === w.alice.id && d.id);
    assert.equal(plain.d.content, '');
    assert.deepEqual(plain.d.embeds, []);
    assert.deepEqual(plain.d.attachments, []);
    w.c.postMessage({ channelId: w.channelId, authorId: w.alice.id, content: `hey <@${w.app.bot_user_id}>` });
    const mention = await gc.waitForDispatch('MESSAGE_CREATE', (d) => d.mentions?.length);
    assert.equal(mention.d.content, `hey <@${w.app.bot_user_id}>`);
    const dm = (await w.rest.post('/users/@me/channels', { recipient_id: w.alice.id })).body;
    w.c.postMessage({ channelId: dm.id, authorId: w.alice.id, content: 'private hello' });
    const dmMsg = await gc.waitForDispatch('MESSAGE_CREATE', (d) => d.channel_id === dm.id);
    assert.equal(dmMsg.d.content, 'private hello');
    assert.equal(dmMsg.d.guild_id, undefined);
    const own = await w.rest.post(`/channels/${w.channelId}/messages`, { content: 'from the bot' });
    assert.equal(own.status, 200);
    const ownMsg = await gc.waitForDispatch('MESSAGE_CREATE', (d) => d.id === own.body.id);
    assert.equal(ownMsg.d.content, 'from the bot');

    const withIntent = await GatewayClient.connect(w.fake.gatewayUrl);
    await withIntent.ready(w.app.token, I.GUILDS | I.GUILD_MESSAGES | I.MESSAGE_CONTENT);
    w.c.postMessage({ channelId: w.channelId, authorId: w.mod.id, content: 'visible' });
    assert.equal((await withIntent.waitForDispatch('MESSAGE_CREATE', (d) => d.author.id === w.mod.id)).d.content, 'visible');
    gc.close(); withIntent.close();
  });

  test('GUILD_CREATE / GUILD_DELETE when the bot is added to or removed from a guild', async () => {
    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, I.GUILDS);
    const g2 = w.c.createGuild({ name: 'New Guild', ownerId: w.owner.id });
    w.c.installBot({ applicationId: w.app.id, guildId: g2.id, permissions: ['VIEW_CHANNEL'] });
    const created = await gc.waitForDispatch('GUILD_CREATE', (d) => d.id === g2.id);
    assert.equal(created.d.name, 'New Guild');
    w.c.kickMember({ actorId: w.owner.id, guildId: g2.id, userId: w.app.bot_user_id });
    const del = await gc.waitForDispatch('GUILD_DELETE', (d) => d.id === g2.id);
    assert.deepEqual(del.d, { id: g2.id });
    gc.close();
  });
});
