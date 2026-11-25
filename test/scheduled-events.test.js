// Guild scheduled events – https://discord.com/developers/docs/resources/guild-scheduled-event
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, GatewayClient, START, DAY } from './helpers.js';
import { Intents as I } from '../src/constants.js';

const INTENTS = I.GUILDS | I.GUILD_SCHEDULED_EVENTS | I.GUILD_MODERATION;
const inDays = (n) => new Date(START + n * DAY).toISOString();

describe('scheduled events', () => {
  let w, gc, voice;
  before(async () => {
    w = await world({ rateLimits: false });
    voice = w.c.createChannel({ guildId: w.guildId, name: 'town hall', type: 2 });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, INTENTS);
  });
  after(async () => { gc.close(); await w.fake.close(); });
  const base = () => `/guilds/${w.guildId}/scheduled-events`;
  const voiceEvent = (extra = {}) => ({ name: 'Town hall', privacy_level: 2, scheduled_start_time: inDays(1), entity_type: 2, channel_id: voice.id, ...extra });

  test('POST creates a voice event: object shape, GUILD_SCHEDULED_EVENT_CREATE, audit entry 100', async () => {
    const r = await w.rest.post(base(), voiceEvent({ description: 'Monthly' }), { headers: { 'X-Audit-Log-Reason': 'monthly' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.guild_id, w.guildId);
    assert.equal(r.body.channel_id, voice.id);
    assert.equal(r.body.creator_id, w.app.bot_user_id);
    assert.equal(r.body.creator.id, w.app.bot_user_id);
    assert.equal(r.body.status, 1);
    assert.equal(r.body.entity_type, 2);
    assert.equal(r.body.entity_id, null);
    assert.equal(r.body.entity_metadata, null);
    assert.equal(r.body.scheduled_end_time, null);
    assert.equal(r.body.privacy_level, 2);
    assert.equal(r.body.description, 'Monthly');
    assert.equal(r.body.recurrence_rule, null);
    assert.equal(r.body.scheduled_start_time, inDays(1).replace('Z', '+00:00'));
    const ev = await gc.waitForDispatch('GUILD_SCHEDULED_EVENT_CREATE', (d) => d.id === r.body.id);
    assert.equal(ev.d.name, 'Town hall');
    const log = (await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=100`)).body.audit_log_entries[0];
    assert.equal(log.target_id, r.body.id);
    assert.equal(log.reason, 'monthly');
  });

  test('an external event needs entity_metadata.location, an end time and no channel', async () => {
    const ok = await w.rest.post(base(), { name: 'Meetup', privacy_level: 2, scheduled_start_time: inDays(2), scheduled_end_time: inDays(3), entity_type: 3, entity_metadata: { location: 'Cafe' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.channel_id, null);
    assert.deepEqual(ok.body.entity_metadata, { location: 'Cafe' });
    const noLoc = await w.rest.post(base(), { name: 'Meetup', privacy_level: 2, scheduled_start_time: inDays(2), scheduled_end_time: inDays(3), entity_type: 3 });
    assert.equal(noLoc.body.code, 50035);
    const noEnd = await w.rest.post(base(), { name: 'Meetup', privacy_level: 2, scheduled_start_time: inDays(2), entity_type: 3, entity_metadata: { location: 'x' } });
    assert.equal(noEnd.body.code, 50035);
    const withChannel = await w.rest.post(base(), { name: 'Meetup', privacy_level: 2, scheduled_start_time: inDays(2), scheduled_end_time: inDays(3), entity_type: 3, entity_metadata: { location: 'x' }, channel_id: voice.id });
    assert.equal(withChannel.body.code, 50035);
  });

  test('validation: voice events need a voice channel; the start must be in the future and before the end; name 1-100', async () => {
    assert.equal((await w.rest.post(base(), voiceEvent({ channel_id: w.channelId }))).body.code, 50035);
    assert.equal((await w.rest.post(base(), voiceEvent({ channel_id: undefined }))).body.code, 50035);
    assert.equal((await w.rest.post(base(), voiceEvent({ scheduled_start_time: inDays(-1) }))).body.code, 50035);
    assert.equal((await w.rest.post(base(), voiceEvent({ scheduled_end_time: inDays(0.5) }))).body.code, 50035);
    assert.equal((await w.rest.post(base(), voiceEvent({ name: '' }))).body.code, 50035);
    assert.equal((await w.rest.post(base(), voiceEvent({ privacy_level: 1 }))).body.code, 50035);
    assert.equal((await w.rest.post(base(), voiceEvent({ channel_id: '1' }))).body.code, 10003);
  });

  test('list (with_user_count), get, modify (GUILD_SCHEDULED_EVENT_UPDATE, audit 101) and delete (…DELETE, audit 102)', async () => {
    const e = (await w.rest.post(base(), voiceEvent({ name: 'Edit me' }))).body;
    assert.ok((await w.rest.get(base())).body.some((x) => x.id === e.id));
    assert.equal((await w.rest.get(base())).body.find((x) => x.id === e.id).user_count, undefined);
    assert.equal((await w.rest.get(`${base()}?with_user_count=true`)).body.find((x) => x.id === e.id).user_count, 0);
    assert.equal((await w.rest.get(`${base()}/${e.id}`)).body.name, 'Edit me');
    const up = await w.rest.patch(`${base()}/${e.id}`, { name: 'Edited', description: 'now with text' });
    assert.equal(up.body.name, 'Edited');
    await gc.waitForDispatch('GUILD_SCHEDULED_EVENT_UPDATE', (d) => d.id === e.id && d.name === 'Edited');
    const log = (await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=101`)).body.audit_log_entries[0];
    assert.deepEqual(log.changes.find((c) => c.key === 'name'), { key: 'name', old_value: 'Edit me', new_value: 'Edited' });
    assert.equal((await w.rest.delete(`${base()}/${e.id}`)).status, 204);
    await gc.waitForDispatch('GUILD_SCHEDULED_EVENT_DELETE', (d) => d.id === e.id);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=102`)).body.audit_log_entries[0].target_id, e.id);
    assert.equal((await w.rest.get(`${base()}/${e.id}`)).body.code, 10070);
  });

  test('status moves SCHEDULED -> ACTIVE -> COMPLETED or SCHEDULED -> CANCELED; anything else is refused', async () => {
    const e = (await w.rest.post(base(), voiceEvent({ name: 'Lifecycle' }))).body;
    assert.equal((await w.rest.patch(`${base()}/${e.id}`, { status: 3 })).body.code, 50035); // SCHEDULED -> COMPLETED
    assert.equal((await w.rest.patch(`${base()}/${e.id}`, { status: 2 })).body.status, 2);
    assert.equal((await w.rest.patch(`${base()}/${e.id}`, { status: 4 })).body.code, 50035); // ACTIVE -> CANCELED
    assert.equal((await w.rest.patch(`${base()}/${e.id}`, { status: 3 })).body.status, 3);
    assert.equal((await w.rest.patch(`${base()}/${e.id}`, { status: 2 })).body.code, 50035); // COMPLETED is final
    const c = (await w.rest.post(base(), voiceEvent({ name: 'Cancelled' }))).body;
    assert.equal((await w.rest.patch(`${base()}/${c.id}`, { status: 4 })).body.status, 4);
  });

  test('changing a voice event to EXTERNAL needs channel_id null, a location and an end time', async () => {
    const e = (await w.rest.post(base(), voiceEvent({ name: 'Switch' }))).body;
    assert.equal((await w.rest.patch(`${base()}/${e.id}`, { entity_type: 3 })).body.code, 50035);
    const r = await w.rest.patch(`${base()}/${e.id}`, { entity_type: 3, channel_id: null, entity_metadata: { location: 'Park' }, scheduled_end_time: inDays(5) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.entity_type, 3);
    assert.equal(r.body.channel_id, null);
    // entity_metadata is silently discarded for non-external events
    const v = (await w.rest.post(base(), voiceEvent({ name: 'NoMeta' }))).body;
    assert.equal((await w.rest.patch(`${base()}/${v.id}`, { entity_metadata: { location: 'x' } })).body.entity_metadata, null);
  });

  test('subscribers: control.subscribeToEvent -> …USER_ADD, GET .../users lists them in id order with paging and members', async () => {
    const e = (await w.rest.post(base(), voiceEvent({ name: 'RSVP' }))).body;
    w.c.subscribeToEvent({ eventId: e.id, userId: w.alice.id });
    w.c.subscribeToEvent({ eventId: e.id, userId: w.bob.id });
    w.c.subscribeToEvent({ eventId: e.id, userId: w.bob.id }); // already subscribed: no second event
    const add = await gc.waitForDispatch('GUILD_SCHEDULED_EVENT_USER_ADD', (d) => d.guild_scheduled_event_id === e.id && d.user_id === w.alice.id);
    assert.equal(add.d.guild_id, w.guildId);
    assert.equal(gc.dispatches('GUILD_SCHEDULED_EVENT_USER_ADD').filter((f) => f.d.guild_scheduled_event_id === e.id).length, 2);
    const list = await w.rest.get(`${base()}/${e.id}/users`);
    const ids = [w.alice.id, w.bob.id].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    assert.deepEqual(list.body.map((u) => u.user.id), ids);
    assert.equal(list.body[0].guild_scheduled_event_id, e.id);
    assert.equal(list.body[0].member, undefined);
    assert.ok((await w.rest.get(`${base()}/${e.id}/users?with_member=true`)).body[0].member.roles);
    assert.deepEqual((await w.rest.get(`${base()}/${e.id}/users?after=${ids[0]}`)).body.map((u) => u.user.id), [ids[1]]);
    assert.equal((await w.rest.get(`${base()}/${e.id}?with_user_count=true`)).body.user_count, 2);
    w.c.unsubscribeFromEvent({ eventId: e.id, userId: w.alice.id });
    await gc.waitForDispatch('GUILD_SCHEDULED_EVENT_USER_REMOVE', (d) => d.user_id === w.alice.id);
    assert.equal((await w.rest.get(`${base()}/${e.id}/users`)).body.length, 1);
    assert.equal((await w.rest.get(`${base()}/1/users`)).body.code, 10070);
  });

  test('without GUILD_SCHEDULED_EVENTS the bot gets no event dispatches; GUILD_CREATE lists the events', async () => {
    const gc2 = await GatewayClient.connect(w.fake.gatewayUrl);
    try {
      await gc2.ready(w.app.token, I.GUILDS);
      assert.ok(gc2.dispatches('GUILD_CREATE')[0].d.guild_scheduled_events.length >= 1);
      await w.rest.post(base(), voiceEvent({ name: 'Quiet' }));
      assert.deepEqual(await gc2.expectNone('GUILD_SCHEDULED_EVENT_CREATE'), []);
    } finally { gc2.close(); }
  });

  test('permissions: CREATE_EVENTS (voice events also VIEW_CHANNEL and CONNECT); MANAGE_EVENTS for other people\'s events', async () => {
    const w2 = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL'] });
    try {
      const vc = w2.c.createChannel({ guildId: w2.guildId, name: 'v', type: 2 });
      const body = { name: 'x', privacy_level: 2, scheduled_start_time: inDays(1), entity_type: 2, channel_id: vc.id };
      assert.equal((await w2.rest.post(`/guilds/${w2.guildId}/scheduled-events`, body)).body.code, 50013);
    } finally { await w2.fake.close(); }
    const w3 = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL', 'CONNECT', 'CREATE_EVENTS'] });
    try {
      const vc = w3.c.createChannel({ guildId: w3.guildId, name: 'v', type: 2 });
      const mine = await w3.rest.post(`/guilds/${w3.guildId}/scheduled-events`, { name: 'mine', privacy_level: 2, scheduled_start_time: inDays(1), entity_type: 2, channel_id: vc.id });
      assert.equal(mine.status, 200);
      assert.equal((await w3.rest.patch(`/guilds/${w3.guildId}/scheduled-events/${mine.body.id}`, { name: 'still mine' })).status, 200);
      const theirs = w3.c.createScheduledEvent({ guildId: w3.guildId, name: 'theirs', startTime: inDays(2), entityType: 2, channelId: vc.id, creatorId: w3.owner.id });
      assert.equal((await w3.rest.patch(`/guilds/${w3.guildId}/scheduled-events/${theirs.id}`, { name: 'hijack' })).body.code, 50013);
      assert.equal((await w3.rest.delete(`/guilds/${w3.guildId}/scheduled-events/${theirs.id}`)).body.code, 50013);
    } finally { await w3.fake.close(); }
  });

  test('100 uncompleted events per guild -> 400/30038', async () => {
    const w2 = await world({ rateLimits: false });
    try {
      for (let i = 0; i < 100; i++) w2.c.createScheduledEvent({ guildId: w2.guildId, name: `e${i}`, startTime: inDays(1), entityType: 3, endTime: inDays(2), location: 'x' });
      const r = await w2.rest.post(`/guilds/${w2.guildId}/scheduled-events`, { name: 'one more', privacy_level: 2, scheduled_start_time: inDays(1), scheduled_end_time: inDays(2), entity_type: 3, entity_metadata: { location: 'x' } });
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 30038);
    } finally { await w2.fake.close(); }
  });
});
