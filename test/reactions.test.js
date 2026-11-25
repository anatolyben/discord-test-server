// Reactions – https://discord.com/developers/docs/resources/message#create-reaction
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, GatewayClient } from './helpers.js';
import { Intents as I } from '../src/constants.js';

const INTENTS = I.GUILDS | I.GUILD_MESSAGES | I.GUILD_MESSAGE_REACTIONS | I.DIRECT_MESSAGE_REACTIONS | I.MESSAGE_CONTENT;
const THUMBS = encodeURIComponent('👍');
const FIRE = encodeURIComponent('🔥');
const path = (w, m, emoji, tail = '@me') => `/channels/${w.channelId}/messages/${m.id}/reactions/${emoji}${tail === null ? '' : `/${tail}`}`;
const say = (w, content = 'hi', authorId = w.alice.id) => w.c.postMessage({ channelId: w.channelId, authorId, content });

describe('add and remove reactions', () => {
  let w, gc;
  before(async () => {
    w = await world({ rateLimits: false });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, INTENTS);
  });
  after(async () => { gc.close(); await w.fake.close(); });

  test('PUT .../reactions/:emoji/@me -> 204, MESSAGE_REACTION_ADD with member, emoji and message_author_id', async () => {
    const m = say(w);
    const r = await w.rest.put(path(w, m, THUMBS));
    assert.equal(r.status, 204);
    const ev = await gc.waitForDispatch('MESSAGE_REACTION_ADD', (d) => d.message_id === m.id);
    assert.equal(ev.d.user_id, w.app.bot_user_id);
    assert.equal(ev.d.channel_id, w.channelId);
    assert.equal(ev.d.guild_id, w.guildId);
    assert.deepEqual(ev.d.emoji, { id: null, name: '👍' });
    assert.equal(ev.d.message_author_id, w.alice.id);
    assert.equal(ev.d.burst, false);
    assert.equal(ev.d.type, 0);
    assert.ok(ev.d.member && Array.isArray(ev.d.member.roles));
  });

  test('the message object lists reactions with count, count_details and me (true only for the caller)', async () => {
    const m = say(w);
    await w.rest.put(path(w, m, THUMBS));
    w.c.addReaction({ channelId: w.channelId, messageId: m.id, userId: w.bob.id, emoji: '👍' });
    w.c.addReaction({ channelId: w.channelId, messageId: m.id, userId: w.bob.id, emoji: '🔥' });
    const got = await w.rest.get(`/channels/${w.channelId}/messages/${m.id}`);
    assert.equal(got.body.reactions.length, 2);
    const up = got.body.reactions.find((x) => x.emoji.name === '👍');
    assert.deepEqual(up, { count: 2, count_details: { burst: 0, normal: 2 }, me: true, me_burst: false, emoji: { id: null, name: '👍' }, burst_colors: [] });
    const fire = got.body.reactions.find((x) => x.emoji.name === '🔥');
    assert.equal(fire.me, false);
    assert.equal(fire.count, 1);
  });

  test('a message without reactions has no reactions field; adding twice is idempotent (one event, count 1)', async () => {
    const m = say(w);
    assert.equal((await w.rest.get(`/channels/${w.channelId}/messages/${m.id}`)).body.reactions, undefined);
    assert.equal((await w.rest.put(path(w, m, FIRE))).status, 204);
    assert.equal((await w.rest.put(path(w, m, FIRE))).status, 204);
    const got = await w.rest.get(`/channels/${w.channelId}/messages/${m.id}`);
    assert.equal(got.body.reactions[0].count, 1);
    assert.equal(gc.dispatches('MESSAGE_REACTION_ADD').filter((f) => f.d.message_id === m.id).length, 1);
  });

  test('DELETE .../@me -> 204 and MESSAGE_REACTION_REMOVE; the reaction disappears when its count reaches 0', async () => {
    const m = say(w);
    await w.rest.put(path(w, m, THUMBS));
    const r = await w.rest.delete(path(w, m, THUMBS));
    assert.equal(r.status, 204);
    const ev = await gc.waitForDispatch('MESSAGE_REACTION_REMOVE', (d) => d.message_id === m.id);
    assert.deepEqual(ev.d.emoji, { id: null, name: '👍' });
    assert.equal(ev.d.user_id, w.app.bot_user_id);
    assert.equal((await w.rest.get(`/channels/${w.channelId}/messages/${m.id}`)).body.reactions, undefined);
  });

  test('removing a reaction that is not there -> 404/10014 Unknown Emoji', async () => {
    const m = say(w);
    const r = await w.rest.delete(path(w, m, THUMBS));
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 10014);
  });

  test('DELETE .../:user_id removes another user\'s reaction and sends MESSAGE_REACTION_REMOVE for that user', async () => {
    const m = say(w);
    w.c.addReaction({ channelId: w.channelId, messageId: m.id, userId: w.bob.id, emoji: '🔥' });
    const r = await w.rest.delete(path(w, m, FIRE, w.bob.id));
    assert.equal(r.status, 204);
    const ev = await gc.waitForDispatch('MESSAGE_REACTION_REMOVE', (d) => d.message_id === m.id && d.user_id === w.bob.id);
    assert.equal(ev.d.emoji.name, '🔥');
  });

  test('unknown message -> 404/10008; unknown channel -> 404/10003', async () => {
    const r = await w.rest.put(`/channels/${w.channelId}/messages/1/reactions/${THUMBS}/@me`);
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 10008);
    const r2 = await w.rest.put(`/channels/1/messages/1/reactions/${THUMBS}/@me`);
    assert.equal(r2.body.code, 10003);
  });

  test('an unknown emoji (plain text, or a custom emoji that does not exist) -> 404/10014', async () => {
    const m = say(w);
    assert.equal((await w.rest.put(path(w, m, 'notanemoji'))).body.code, 10014);
    assert.equal((await w.rest.put(path(w, m, encodeURIComponent('ghost:123456789012345678')))).body.code, 10014);
  });

  test('the 21st distinct emoji on one message -> 400/30010', async () => {
    const m = say(w);
    const emojis = ['😀', '😁', '😂', '😃', '😄', '😅', '😆', '😇', '😈', '😉', '😊', '😋', '😌', '😍', '😎', '😏', '😐', '😑', '😒', '😓'];
    for (const e of emojis) assert.equal((await w.rest.put(path(w, m, encodeURIComponent(e)))).status, 204);
    const r = await w.rest.put(path(w, m, encodeURIComponent('😔')));
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 30010);
    // another user can still react with an emoji that is already there
    assert.equal((await w.rest.put(path(w, m, encodeURIComponent('😀')))).status, 204);
  });
});

describe('reaction permissions', () => {
  test('READ_MESSAGE_HISTORY is required; ADD_REACTIONS only for the first reaction with an emoji', async () => {
    const w = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY'] });
    try {
      // @everyone has ADD_REACTIONS by default; take it away to test the rule.
      w.c.updateRole({ guildId: w.guildId, roleId: w.guildId, permissions: ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY'] });
      const m = w.c.postMessage({ channelId: w.channelId, authorId: w.alice.id, content: 'x', force: true });
      assert.equal((await w.rest.put(path(w, m, THUMBS))).body.code, 50013); // first use of the emoji -> needs ADD_REACTIONS
      w.c.addReaction({ channelId: w.channelId, messageId: m.id, userId: w.bob.id, emoji: '👍', force: true });
      assert.equal((await w.rest.put(path(w, m, THUMBS))).status, 204); // somebody already used it
    } finally { await w.fake.close(); }
  });

  test('without READ_MESSAGE_HISTORY the reaction is refused with 403/50013', async () => {
    const w = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL', 'ADD_REACTIONS'] });
    try {
      w.c.updateRole({ guildId: w.guildId, roleId: w.guildId, permissions: ['VIEW_CHANNEL'] });
      const m = w.c.postMessage({ channelId: w.channelId, authorId: w.alice.id, content: 'x', force: true });
      const r = await w.rest.put(path(w, m, THUMBS));
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 50013);
    } finally { await w.fake.close(); }
  });

  test('removing someone else\'s reaction, all reactions or one emoji needs MANAGE_MESSAGES', async () => {
    const w = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY', 'ADD_REACTIONS'] });
    try {
      const m = say(w);
      w.c.addReaction({ channelId: w.channelId, messageId: m.id, userId: w.bob.id, emoji: '👍' });
      assert.equal((await w.rest.delete(path(w, m, THUMBS, w.bob.id))).body.code, 50013);
      assert.equal((await w.rest.delete(`/channels/${w.channelId}/messages/${m.id}/reactions`)).body.code, 50013);
      assert.equal((await w.rest.delete(path(w, m, THUMBS, null))).body.code, 50013);
    } finally { await w.fake.close(); }
  });
});

describe('list and clear reactions', () => {
  let w, gc;
  before(async () => {
    w = await world({ rateLimits: false });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, INTENTS);
  });
  after(async () => { gc.close(); await w.fake.close(); });

  test('GET .../reactions/:emoji lists users in id order; limit and after paginate', async () => {
    const m = say(w);
    for (const u of [w.alice, w.bob, w.mod]) w.c.addReaction({ channelId: w.channelId, messageId: m.id, userId: u.id, emoji: '👍' });
    const all = await w.rest.get(path(w, m, THUMBS, null));
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.map((u) => u.id), [w.mod.id, w.alice.id, w.bob.id].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)));
    assert.equal(all.body[0].username !== undefined, true);
    const page = await w.rest.get(`${path(w, m, THUMBS, null)}?limit=2`);
    assert.equal(page.body.length, 2);
    const next = await w.rest.get(`${path(w, m, THUMBS, null)}?after=${page.body[1].id}`);
    assert.deepEqual(next.body.map((u) => u.id), [all.body[2].id]);
    assert.equal((await w.rest.get(`${path(w, m, THUMBS, null)}?limit=101`)).body.code, 50035);
  });

  test('DELETE .../reactions -> 204, MESSAGE_REACTION_REMOVE_ALL', async () => {
    const m = say(w);
    w.c.addReaction({ channelId: w.channelId, messageId: m.id, userId: w.bob.id, emoji: '👍' });
    w.c.addReaction({ channelId: w.channelId, messageId: m.id, userId: w.bob.id, emoji: '🔥' });
    const r = await w.rest.delete(`/channels/${w.channelId}/messages/${m.id}/reactions`);
    assert.equal(r.status, 204);
    const ev = await gc.waitForDispatch('MESSAGE_REACTION_REMOVE_ALL', (d) => d.message_id === m.id);
    assert.deepEqual(Object.keys(ev.d).sort(), ['channel_id', 'guild_id', 'message_id']);
    assert.equal((await w.rest.get(`/channels/${w.channelId}/messages/${m.id}`)).body.reactions, undefined);
  });

  test('DELETE .../reactions/:emoji -> 204, MESSAGE_REACTION_REMOVE_EMOJI; other emojis stay', async () => {
    const m = say(w);
    w.c.addReaction({ channelId: w.channelId, messageId: m.id, userId: w.bob.id, emoji: '👍' });
    w.c.addReaction({ channelId: w.channelId, messageId: m.id, userId: w.alice.id, emoji: '👍' });
    w.c.addReaction({ channelId: w.channelId, messageId: m.id, userId: w.bob.id, emoji: '🔥' });
    const r = await w.rest.delete(path(w, m, THUMBS, null));
    assert.equal(r.status, 204);
    const ev = await gc.waitForDispatch('MESSAGE_REACTION_REMOVE_EMOJI', (d) => d.message_id === m.id);
    assert.deepEqual(ev.d.emoji, { id: null, name: '👍' });
    const got = await w.rest.get(`/channels/${w.channelId}/messages/${m.id}`);
    assert.deepEqual(got.body.reactions.map((x) => x.emoji.name), ['🔥']);
  });
});

describe('intents and DMs', () => {
  test('without GUILD_MESSAGE_REACTIONS the bot gets no reaction events', async () => {
    const w = await world({ rateLimits: false });
    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    try {
      await gc.ready(w.app.token, I.GUILDS | I.GUILD_MESSAGES);
      const m = say(w);
      w.c.addReaction({ channelId: w.channelId, messageId: m.id, userId: w.bob.id, emoji: '👍' });
      assert.deepEqual(await gc.expectNone('MESSAGE_REACTION_ADD'), []);
    } finally { gc.close(); await w.fake.close(); }
  });

  test('a reaction in a DM reaches the bot with DIRECT_MESSAGE_REACTIONS and has no guild_id', async () => {
    const w = await world({ rateLimits: false });
    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    try {
      await gc.ready(w.app.token, INTENTS | I.DIRECT_MESSAGES);
      const dm = (await w.rest.post('/users/@me/channels', { recipient_id: w.alice.id })).body;
      const m = w.c.postMessage({ channelId: dm.id, authorId: w.alice.id, content: 'dm' });
      w.c.addReaction({ channelId: dm.id, messageId: m.id, userId: w.alice.id, emoji: '👍' });
      const ev = await gc.waitForDispatch('MESSAGE_REACTION_ADD', (d) => d.message_id === m.id);
      assert.equal(ev.d.guild_id, undefined);
      assert.equal(ev.d.member, undefined);
    } finally { gc.close(); await w.fake.close(); }
  });
});
