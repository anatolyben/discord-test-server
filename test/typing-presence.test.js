// Typing and presence – https://discord.com/developers/docs/events/gateway-events#typing-start, #presence-update
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, GatewayClient } from './helpers.js';
import { Intents as I, } from '../src/constants.js';

describe('typing', () => {
  let w, gc;
  before(async () => {
    w = await world({ rateLimits: false });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, I.GUILDS | I.GUILD_MESSAGE_TYPING | I.DIRECT_MESSAGE_TYPING | I.DIRECT_MESSAGES);
  });
  after(async () => { gc.close(); await w.fake.close(); });

  test('control.typing -> TYPING_START with channel, guild, user, member and a unix timestamp in seconds', async () => {
    w.c.typing({ channelId: w.channelId, userId: w.alice.id });
    const ev = await gc.waitForDispatch('TYPING_START', (d) => d.user_id === w.alice.id);
    assert.equal(ev.d.channel_id, w.channelId);
    assert.equal(ev.d.guild_id, w.guildId);
    assert.equal(ev.d.timestamp, Math.floor(w.c.now().now / 1000));
    assert.ok(Array.isArray(ev.d.member.roles));
    assert.equal(ev.d.member.user.id, w.alice.id);
  });

  test('a typing indicator in a DM has no guild_id or member', async () => {
    const dm = (await w.rest.post('/users/@me/channels', { recipient_id: w.bob.id })).body;
    w.c.typing({ channelId: dm.id, userId: w.bob.id });
    const ev = await gc.waitForDispatch('TYPING_START', (d) => d.user_id === w.bob.id && d.channel_id === dm.id);
    assert.equal(ev.d.guild_id, undefined);
    assert.equal(ev.d.member, undefined);
  });

  test('a person who cannot send messages in the channel cannot type there (unless force)', () => {
    w.c.setPermissionOverwrite({ channelId: w.channelId, id: w.bob.id, type: 1, deny: ['SEND_MESSAGES'] });
    assert.throws(() => w.c.typing({ channelId: w.channelId, userId: w.bob.id }), /SEND_MESSAGES/);
    assert.equal(w.c.typing({ channelId: w.channelId, userId: w.bob.id, force: true }).ok, true);
  });

  test('without the typing intents the bot hears nothing', async () => {
    const gc2 = await GatewayClient.connect(w.fake.gatewayUrl);
    try {
      await gc2.ready(w.app.token, I.GUILDS);
      w.c.typing({ channelId: w.channelId, userId: w.alice.id });
      assert.deepEqual(await gc2.expectNone('TYPING_START'), []);
    } finally { gc2.close(); }
  });

  test('POST /channels/:id/typing -> 204; needs SEND_MESSAGES; unknown channel 404/10003', async () => {
    assert.equal((await w.rest.post(`/channels/${w.channelId}/typing`)).status, 204);
    assert.equal((await w.rest.post('/channels/1/typing')).body.code, 10003);
    const w2 = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL'] });
    try {
      w2.c.updateRole({ guildId: w2.guildId, roleId: w2.guildId, permissions: ['VIEW_CHANNEL'] });
      assert.equal((await w2.rest.post(`/channels/${w2.channelId}/typing`)).body.code, 50013);
    } finally { await w2.fake.close(); }
  });
});

describe('presence', () => {
  let w, gc;
  before(async () => {
    w = await world({ rateLimits: false, privilegedIntents: { guildMembers: true, guildPresences: true, messageContent: true } });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, I.GUILDS | I.GUILD_PRESENCES | I.GUILD_MEMBERS);
  });
  after(async () => { gc.close(); await w.fake.close(); });

  test('control.setPresence -> PRESENCE_UPDATE with a partial user, guild_id, status, activities and client_status', async () => {
    w.c.setPresence({ userId: w.alice.id, status: 'dnd', activities: [{ name: 'Chess', type: 0 }], clientStatus: { desktop: 'dnd' } });
    const ev = await gc.waitForDispatch('PRESENCE_UPDATE', (d) => d.user.id === w.alice.id);
    assert.deepEqual(Object.keys(ev.d.user), ['id']);
    assert.equal(ev.d.guild_id, w.guildId);
    assert.equal(ev.d.status, 'dnd');
    assert.equal(ev.d.activities[0].name, 'Chess');
    assert.equal(ev.d.activities[0].type, 0);
    assert.deepEqual(ev.d.client_status, { desktop: 'dnd' });
  });

  test('an unchanged presence sends nothing; going offline empties client_status and activities', async () => {
    const before = gc.dispatches('PRESENCE_UPDATE').length;
    w.c.setPresence({ userId: w.alice.id, status: 'dnd', activities: [{ name: 'Chess', type: 0 }], clientStatus: { desktop: 'dnd' } });
    w.c.setPresence({ userId: w.alice.id, status: 'offline' });
    await gc.waitFor(() => gc.dispatches('PRESENCE_UPDATE').find((f) => f.d.status === 'offline'));
    const evs = gc.dispatches('PRESENCE_UPDATE').slice(before);
    assert.equal(evs.length, 1);
    assert.deepEqual(evs[0].d.client_status, {});
    assert.deepEqual(evs[0].d.activities, []);
  });

  test('status must be online, idle, dnd, invisible or offline; the user must exist', () => {
    assert.throws(() => w.c.setPresence({ userId: w.alice.id, status: 'sleepy' }), /status/);
    assert.throws(() => w.c.setPresence({ userId: '1', status: 'online' }), /unknown user/);
  });

  test('a presence is sent once per guild the user shares with the bot', async () => {
    const g2 = w.c.createGuild({ name: 'Second', ownerId: w.owner.id });
    w.c.addMember({ guildId: g2.id, userId: w.bob.id });
    w.c.installBot({ applicationId: w.app.id, guildId: g2.id, permissions: ['ADMINISTRATOR'] });
    await gc.waitFor(() => gc.dispatches('GUILD_CREATE').find((f) => f.d.id === g2.id));
    w.c.setPresence({ userId: w.bob.id, status: 'idle' });
    await gc.waitFor(() => gc.dispatches('PRESENCE_UPDATE').filter((f) => f.d.user.id === w.bob.id).length >= 2);
    const guilds = gc.dispatches('PRESENCE_UPDATE').filter((f) => f.d.user.id === w.bob.id).map((f) => f.d.guild_id).sort();
    assert.deepEqual(guilds, [w.guildId, g2.id].sort());
  });

  test('GUILD_CREATE carries the known presences when GUILD_PRESENCES is on', async () => {
    w.c.setPresence({ userId: w.mod.id, status: 'online', clientStatus: { web: 'online' } });
    const gc2 = await GatewayClient.connect(w.fake.gatewayUrl);
    try {
      await gc2.ready(w.app.token, I.GUILDS | I.GUILD_PRESENCES | I.GUILD_MEMBERS);
      const create = gc2.dispatches('GUILD_CREATE').find((f) => f.d.id === w.guildId);
      const p = create.d.presences.find((x) => x.user.id === w.mod.id);
      assert.equal(p.status, 'online');
      assert.deepEqual(p.client_status, { web: 'online' });
    } finally { gc2.close(); }
  });

  test('without GUILD_PRESENCES the bot gets no PRESENCE_UPDATE, and no presences in GUILD_CREATE', async () => {
    const gc2 = await GatewayClient.connect(w.fake.gatewayUrl);
    try {
      await gc2.ready(w.app.token, I.GUILDS);
      assert.deepEqual(gc2.dispatches('GUILD_CREATE')[0].d.presences, []);
      w.c.setPresence({ userId: w.mod.id, status: 'idle' });
      assert.deepEqual(await gc2.expectNone('PRESENCE_UPDATE'), []);
    } finally { gc2.close(); }
  });

  test('the bot sets its own presence with opcode 3; invalid frames are ignored', async () => {
    gc.send(3, { since: null, activities: [{ name: 'Testing', type: 0 }], status: 'idle', afk: false });
    const ev = await gc.waitForDispatch('PRESENCE_UPDATE', (d) => d.user.id === w.app.bot_user_id && d.status === 'idle');
    assert.equal(ev.d.activities[0].name, 'Testing');
    assert.equal(w.c.getPresences({ guildId: w.guildId }).find((p) => p.user.id === w.app.bot_user_id).status, 'idle');
    gc.send(3, { status: 'sleepy', activities: [], afk: false, since: null });
    assert.equal(w.c.getPresences({ guildId: w.guildId }).find((p) => p.user.id === w.app.bot_user_id).status, 'idle');
  });
});
