// Voice states – https://discord.com/developers/docs/resources/voice#voice-state-object
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, GatewayClient } from './helpers.js';
import { Intents as I } from '../src/constants.js';

const INTENTS = I.GUILDS | I.GUILD_VOICE_STATES | I.GUILD_MEMBERS | I.GUILD_MODERATION;
const voiceStates = (w, guildId = w.guildId) => w.rest.get(`/guilds/${guildId}/voice-states/${w.alice.id}`);

describe('people joining and leaving voice channels', () => {
  let w, gc, lounge, stage;
  before(async () => {
    w = await world({ rateLimits: false });
    lounge = w.c.createChannel({ guildId: w.guildId, name: 'lounge', type: 2 });
    stage = w.c.createChannel({ guildId: w.guildId, name: 'stage', type: 13 });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, INTENTS);
  });
  after(async () => { gc.close(); await w.fake.close(); });

  test('joinVoice -> VOICE_STATE_UPDATE with the voice state object and the member', async () => {
    const vs = w.c.joinVoice({ channelId: lounge.id, userId: w.alice.id, selfMute: true });
    assert.equal(vs.channel_id, lounge.id);
    const ev = await gc.waitForDispatch('VOICE_STATE_UPDATE', (d) => d.user_id === w.alice.id && d.channel_id === lounge.id);
    assert.equal(ev.d.guild_id, w.guildId);
    assert.equal(ev.d.self_mute, true);
    for (const k of ['deaf', 'mute', 'self_deaf', 'self_video', 'suppress']) assert.equal(ev.d[k], false, k);
    assert.equal(ev.d.request_to_speak_timestamp, null);
    assert.ok(ev.d.session_id.length >= 16);
    assert.equal(ev.d.member.user.id, w.alice.id);
    assert.equal(ev.d.member.joined_at !== undefined, true);
  });

  test('GET /guilds/:id/voice-states/:user -> the state; /@me for the bot; not connected -> 404/10065', async () => {
    const r = await voiceStates(w);
    assert.equal(r.status, 200);
    assert.equal(r.body.channel_id, lounge.id);
    assert.equal(r.body.guild_id, w.guildId);
    const me = await w.rest.get(`/guilds/${w.guildId}/voice-states/@me`);
    assert.equal(me.status, 404);
    assert.equal(me.body.code, 10065);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/voice-states/${w.bob.id}`)).body.code, 10065);
  });

  test('switching channel and changing self flags each send VOICE_STATE_UPDATE; leaving sends channel_id null', async () => {
    const before = gc.dispatches('VOICE_STATE_UPDATE').length;
    w.c.joinVoice({ channelId: stage.id, userId: w.alice.id });
    w.c.joinVoice({ channelId: stage.id, userId: w.alice.id, selfDeaf: true });
    w.c.joinVoice({ channelId: stage.id, userId: w.alice.id, selfDeaf: true }); // unchanged: no event
    w.c.leaveVoice({ userId: w.alice.id, guildId: w.guildId });
    await gc.waitFor(() => gc.dispatches('VOICE_STATE_UPDATE').find((f) => f.d.user_id === w.alice.id && f.d.channel_id === null));
    const evs = gc.dispatches('VOICE_STATE_UPDATE').slice(before);
    assert.deepEqual(evs.map((f) => [f.d.channel_id, f.d.self_deaf]), [[stage.id, false], [stage.id, true], [null, true]]);
    assert.equal((await voiceStates(w)).body.code, 10065);
    assert.equal(w.c.leaveVoice({ userId: w.alice.id, guildId: w.guildId }).left, false);
  });

  test('only voice and stage channels can be joined; a person needs CONNECT unless force', async () => {
    assert.throws(() => w.c.joinVoice({ channelId: w.channelId, userId: w.alice.id }), /voice/);
    const locked = w.c.createChannel({ guildId: w.guildId, name: 'locked', type: 2 });
    w.c.setPermissionOverwrite({ channelId: locked.id, id: w.guildId, type: 0, deny: ['CONNECT'] });
    assert.throws(() => w.c.joinVoice({ channelId: locked.id, userId: w.bob.id }), /CONNECT/);
    assert.equal(w.c.joinVoice({ channelId: locked.id, userId: w.bob.id, force: true }).channel_id, locked.id);
    w.c.leaveVoice({ userId: w.bob.id, guildId: w.guildId });
  });

  test('a kicked member, or a deleted voice channel, disconnects whoever was in it', async () => {
    const room = w.c.createChannel({ guildId: w.guildId, name: 'room', type: 2 });
    w.c.joinVoice({ channelId: room.id, userId: w.bob.id });
    w.c.joinVoice({ channelId: room.id, userId: w.alice.id });
    w.c.deleteChannel({ channelId: room.id });
    await gc.waitFor(() => gc.dispatches('VOICE_STATE_UPDATE').filter((f) => f.d.channel_id === null && [w.bob.id, w.alice.id].includes(f.d.user_id)).length >= 2);
    w.c.joinVoice({ channelId: lounge.id, userId: w.bob.id });
    w.c.kickMember({ actorId: w.owner.id, guildId: w.guildId, userId: w.bob.id });
    await gc.waitFor(() => gc.dispatches('VOICE_STATE_UPDATE').filter((f) => f.d.channel_id === null && f.d.user_id === w.bob.id).length >= 2);
    assert.deepEqual(w.c.getVoiceStates({ guildId: w.guildId }), []);
  });

  test('without GUILD_VOICE_STATES the bot receives nothing; GUILD_CREATE carries the current voice_states', async () => {
    w.c.joinVoice({ channelId: lounge.id, userId: w.alice.id });
    const gc2 = await GatewayClient.connect(w.fake.gatewayUrl);
    try {
      await gc2.ready(w.app.token, I.GUILDS);
      const gcr = gc2.dispatches('GUILD_CREATE')[0];
      assert.equal(gcr.d.voice_states.length, 1);
      assert.equal(gcr.d.voice_states[0].user_id, w.alice.id);
      assert.equal(gcr.d.voice_states[0].guild_id, undefined);
      w.c.leaveVoice({ userId: w.alice.id, guildId: w.guildId });
      assert.deepEqual(await gc2.expectNone('VOICE_STATE_UPDATE'), []);
    } finally { gc2.close(); }
  });
});

describe('moderating voice through the API', () => {
  let w, gc, a, b;
  before(async () => {
    w = await world({ rateLimits: false });
    a = w.c.createChannel({ guildId: w.guildId, name: 'a', type: 2 });
    b = w.c.createChannel({ guildId: w.guildId, name: 'b', type: 2 });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, INTENTS);
  });
  after(async () => { gc.close(); await w.fake.close(); });
  const patch = (body, headers) => w.rest.patch(`/guilds/${w.guildId}/members/${w.alice.id}`, body, { headers });

  test('a member who is not in voice cannot be muted, deafened or moved -> 400/40032', async () => {
    for (const body of [{ mute: true }, { deaf: true }, { channel_id: a.id }]) {
      const r = await patch(body);
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 40032);
    }
  });

  test('PATCH channel_id moves the member: VOICE_STATE_UPDATE and MEMBER_MOVE (26) with channel_id and count', async () => {
    w.c.joinVoice({ channelId: a.id, userId: w.alice.id });
    const r = await patch({ channel_id: b.id }, { 'X-Audit-Log-Reason': 'wrong room' });
    assert.equal(r.status, 200);
    await gc.waitForDispatch('VOICE_STATE_UPDATE', (d) => d.user_id === w.alice.id && d.channel_id === b.id);
    const e = (await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=26`)).body.audit_log_entries[0];
    assert.deepEqual(e.options, { channel_id: b.id, count: '1' });
    assert.equal(e.reason, 'wrong room');
    assert.equal(e.user_id, w.app.bot_user_id);
  });

  test('PATCH mute/deaf sets the server flags on the voice state and the member; the audit log records MEMBER_UPDATE', async () => {
    const r = await patch({ mute: true, deaf: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.mute, true);
    assert.equal(r.body.deaf, true);
    const ev = await gc.waitForDispatch('VOICE_STATE_UPDATE', (d) => d.user_id === w.alice.id && d.mute === true);
    assert.equal(ev.d.deaf, true);
    assert.equal((await voiceStates(w)).body.mute, true);
    await patch({ mute: false, deaf: false });
    assert.equal((await voiceStates(w)).body.mute, false);
  });

  test('PATCH channel_id null disconnects: VOICE_STATE_UPDATE channel_id null and MEMBER_DISCONNECT (27) with count', async () => {
    const r = await patch({ channel_id: null });
    assert.equal(r.status, 200);
    await gc.waitFor(() => gc.dispatches('VOICE_STATE_UPDATE').find((f) => f.d.user_id === w.alice.id && f.d.channel_id === null));
    const e = (await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=27`)).body.audit_log_entries[0];
    assert.deepEqual(e.options, { count: '1' });
    assert.equal((await voiceStates(w)).body.code, 10065);
  });

  test('MOVE_MEMBERS, MUTE_MEMBERS and DEAFEN_MEMBERS are required; moving also needs CONNECT on the target', async () => {
    const w2 = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL', 'CONNECT'] });
    try {
      const c1 = w2.c.createChannel({ guildId: w2.guildId, name: 'c1', type: 2 });
      w2.c.joinVoice({ channelId: c1.id, userId: w2.alice.id });
      const p = (body) => w2.rest.patch(`/guilds/${w2.guildId}/members/${w2.alice.id}`, body);
      assert.equal((await p({ mute: true })).body.code, 50013);
      assert.equal((await p({ deaf: true })).body.code, 50013);
      assert.equal((await p({ channel_id: null })).body.code, 50013);
    } finally { await w2.fake.close(); }
    const w3 = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL', 'MOVE_MEMBERS'] });
    try {
      w3.c.updateRole({ guildId: w3.guildId, roleId: w3.guildId, permissions: ['VIEW_CHANNEL'] });
      const c1 = w3.c.createChannel({ guildId: w3.guildId, name: 'c1', type: 2 });
      const c2 = w3.c.createChannel({ guildId: w3.guildId, name: 'c2', type: 2 });
      w3.c.joinVoice({ channelId: c1.id, userId: w3.alice.id, force: true });
      const r = await w3.rest.patch(`/guilds/${w3.guildId}/members/${w3.alice.id}`, { channel_id: c2.id });
      assert.equal(r.body.code, 50013); // the bot cannot CONNECT to c2
    } finally { await w3.fake.close(); }
  });

  test('moving to a text channel -> 400/50024', async () => {
    w.c.joinVoice({ channelId: a.id, userId: w.alice.id });
    const r = await patch({ channel_id: w.channelId });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 50024);
  });
});
