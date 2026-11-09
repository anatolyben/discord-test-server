// Messages – https://discord.com/developers/docs/resources/message
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, GatewayClient, DAY, START } from './helpers.js';
import { Intents as I } from '../src/constants.js';
import { snowflakeTime } from '../src/index.js';

const MSG_INTENTS = I.GUILDS | I.GUILD_MESSAGES | I.DIRECT_MESSAGES | I.MESSAGE_CONTENT;
const A = { MESSAGE_DELETE: 72, MESSAGE_BULK_DELETE: 73 };
const SUPPRESS_EMBEDS = 1 << 2;
const HAS_SNAPSHOT = 1 << 14;

const post = (w, content, channelId = w.channelId) => w.rest.post(`/channels/${channelId}/messages`, typeof content === 'string' ? { content } : content);
const say = (w, authorId, content, extra = {}) => w.c.postMessage({ channelId: w.channelId, authorId, content, ...extra });
async function auditEntries(w, actionType) {
  const r = await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=${actionType}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.audit_log_entries;
}

describe('create message', () => {
  // https://discord.com/developers/docs/resources/message#create-message
  let w, gc;
  before(async () => {
    w = await world({ rateLimits: false });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, MSG_INTENTS);
  });
  after(async () => { gc.close(); await w.fake.close(); });

  test('POST /channels/:id/messages -> the message object, and a MESSAGE_CREATE with guild_id, member, channel_type', async () => {
    const r = await post(w, { content: 'hello world', nonce: 'n-1', tts: false });
    assert.equal(r.status, 200);
    const m = r.body;
    assert.equal(m.type, 0);
    assert.equal(m.content, 'hello world');
    assert.equal(m.channel_id, w.channelId);
    assert.equal(m.author.id, w.app.bot_user_id);
    assert.equal(m.author.bot, true);
    assert.equal(m.nonce, 'n-1');
    assert.equal(m.timestamp, new Date(START).toISOString().replace('Z', '+00:00'));
    assert.equal(m.edited_timestamp, null);
    assert.deepEqual(m.attachments, []);
    assert.deepEqual(m.embeds, []);
    assert.deepEqual(m.mentions, []);
    assert.equal(m.pinned, false);

    const ev = await gc.waitForDispatch('MESSAGE_CREATE', (d) => d.id === m.id);
    assert.equal(ev.d.guild_id, w.guildId);
    assert.equal(ev.d.channel_type, 0);
    assert.equal(ev.d.content, 'hello world');
    assert.ok(ev.d.member && Array.isArray(ev.d.member.roles));
    assert.equal(ev.d.member.user, undefined);
    assert.ok(ev.d.member.roles.includes(w.botRole.id));

    // The message is now readable through the API.
    const got = await w.rest.get(`/channels/${w.channelId}/messages/${m.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.content, 'hello world');
  });

  // https://discord.com/developers/docs/topics/opcodes-and-status-codes#json – 50006 Cannot send an empty message
  test('an empty message -> 400 / 50006', async () => {
    for (const body of [{}, { content: '' }, { content: '', embeds: [] }]) {
      const r = await post(w, body);
      assert.equal(r.status, 400);
      assert.deepEqual(r.body, { message: 'Cannot send an empty message', code: 50006 });
    }
  });

  test('content over 2000 characters -> 400 / 50035 on content', async () => {
    const r = await post(w, 'x'.repeat(2001));
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 50035);
    assert.equal(r.body.errors.content._errors[0].code, 'BASE_TYPE_MAX_LENGTH');
    const ok = await post(w, 'x'.repeat(2000));
    assert.equal(ok.status, 200);
  });

  // https://discord.com/developers/docs/resources/message#embed-object-embed-limits
  test('embeds are stored and returned; invalid embeds -> 50035 keyed by index', async () => {
    const embed = { title: 'Report', description: 'All good', color: 0x00ff00, fields: [{ name: 'a', value: '1', inline: true }] };
    const r = await post(w, { embeds: [embed] });
    assert.equal(r.status, 200);
    assert.equal(r.body.content, '');
    assert.equal(r.body.embeds.length, 1);
    assert.equal(r.body.embeds[0].title, 'Report');
    assert.deepEqual(r.body.embeds[0].fields, embed.fields);
    const bad = await post(w, { embeds: [embed, { title: 't'.repeat(257) }] });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 50035);
    assert.deepEqual(Object.keys(bad.body.errors.embeds), ['1']);
    assert.equal(bad.body.errors.embeds['1'].title._errors[0].code, 'BASE_TYPE_MAX_LENGTH');
  });

  // https://discord.com/developers/docs/resources/message#message-reference-types – DEFAULT (reply)
  test('a reply (message_reference) -> type 19 with message_reference and referenced_message; event carries them', async () => {
    const orig = say(w, w.alice.id, 'question?');
    const r = await post(w, { content: 'answer', message_reference: { message_id: orig.id } });
    assert.equal(r.status, 200);
    assert.equal(r.body.type, 19);
    assert.equal(r.body.message_reference.message_id, orig.id);
    assert.equal(r.body.message_reference.channel_id, w.channelId);
    assert.equal(r.body.message_reference.guild_id, w.guildId);
    assert.equal(r.body.referenced_message.id, orig.id);
    assert.equal(r.body.referenced_message.content, 'question?');
    // Replies mention the replied-to author by default.
    assert.ok(r.body.mentions.some((u) => u.id === w.alice.id));
    const ev = await gc.waitForDispatch('MESSAGE_CREATE', (d) => d.id === r.body.id);
    assert.equal(ev.d.message_reference.message_id, orig.id);
    assert.equal(ev.d.referenced_message.id, orig.id);

    // allowed_mentions.replied_user: false -> no mention of the author.
    const quiet = await post(w, { content: 'quiet answer', message_reference: { message_id: orig.id }, allowed_mentions: { replied_user: false, parse: [] } });
    assert.equal(quiet.body.type, 19);
    assert.deepEqual(quiet.body.mentions, []);

    // Unknown referenced message -> 50035 unless fail_if_not_exists is false.
    const unknown = await post(w, { content: 'x', message_reference: { message_id: '1234567890123456789' } });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, 50035);
    assert.ok(unknown.body.errors.message_reference);
    const lenient = await post(w, { content: 'x', message_reference: { message_id: '1234567890123456789', fail_if_not_exists: false } });
    assert.equal(lenient.status, 200);
    assert.equal(lenient.body.type, 0);
  });

  // https://discord.com/developers/docs/resources/message#message-snapshot-object
  test('a forward (message_reference type 1) -> message_snapshots and the HAS_SNAPSHOT flag', async () => {
    const other = w.c.createChannel({ guildId: w.guildId, name: 'news' });
    const orig = w.c.postMessage({ channelId: other.id, authorId: w.alice.id, content: 'big news', embeds: [{ title: 'Headline' }] });
    const r = await post(w, { message_reference: { type: 1, message_id: orig.id, channel_id: other.id } });
    assert.equal(r.status, 200);
    assert.equal(r.body.type, 0);
    assert.equal(r.body.content, '');
    assert.equal(r.body.message_reference.type, 1);
    assert.equal(r.body.message_reference.message_id, orig.id);
    assert.equal(r.body.message_reference.channel_id, other.id);
    assert.equal(r.body.message_snapshots.length, 1);
    assert.equal(r.body.message_snapshots[0].message.content, 'big news');
    assert.equal(r.body.message_snapshots[0].message.embeds[0].title, 'Headline');
    assert.equal(r.body.flags & HAS_SNAPSHOT, HAS_SNAPSHOT);
    assert.equal(r.body.referenced_message, undefined);
  });

  // https://discord.com/developers/docs/resources/message#allowed-mentions-object
  test('allowed_mentions controls who is mentioned', async () => {
    const content = `<@${w.alice.id}> <@${w.bob.id}> <@&${w.memberRole.id}>`;
    const none = await post(w, { content, allowed_mentions: { parse: [] } });
    assert.deepEqual(none.body.mentions, []);
    assert.deepEqual(none.body.mention_roles, []);
    const onlyAlice = await post(w, { content, allowed_mentions: { users: [w.alice.id] } });
    assert.deepEqual(onlyAlice.body.mentions.map((u) => u.id), [w.alice.id]);
    assert.deepEqual(onlyAlice.body.mention_roles, []);
    const all = await post(w, { content, allowed_mentions: { parse: ['users', 'roles'] } });
    assert.deepEqual(all.body.mentions.map((u) => u.id).sort(), [w.alice.id, w.bob.id].sort());
    assert.deepEqual(all.body.mention_roles, [w.memberRole.id]);
    // Without allowed_mentions, mentions are parsed from the content.
    const parsed = await post(w, content);
    assert.equal(parsed.body.mentions.length, 2);
  });
});

describe('create message: permissions', () => {
  // https://discord.com/developers/docs/resources/message#create-message – SEND_MESSAGES
  let w;
  before(async () => {
    w = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY'] });
    // @everyone can send by default; take it away in this channel.
    w.c.setPermissionOverwrite({ channelId: w.channelId, id: w.guildId, type: 0, deny: ['SEND_MESSAGES'] });
  });
  after(() => w.fake.close());

  test('without SEND_MESSAGES -> 403 / 50013 and nothing is posted', async () => {
    const r = await post(w, 'hi');
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { message: 'Missing Permissions', code: 50013 });
    assert.equal(w.c.getMessages({ channelId: w.channelId }).length, 0);
  });

  test('a channel overwrite granting SEND_MESSAGES is enough', async () => {
    w.c.setPermissionOverwrite({ channelId: w.channelId, id: w.botRole.id, type: 0, allow: ['SEND_MESSAGES'] });
    const r = await post(w, 'hi');
    assert.equal(r.status, 200);
    assert.equal(r.body.content, 'hi');
    assert.equal(r.body.author.id, w.app.bot_user_id);
  });
});

describe('get and list messages', () => {
  // https://discord.com/developers/docs/resources/message#get-channel-messages
  let w, ids;
  before(async () => {
    w = await world({ rateLimits: false });
    ids = [];
    for (let i = 0; i < 10; i++) { w.c.advance(1000); ids.push(say(w, w.alice.id, `m${i}`).id); }
  });
  after(() => w.fake.close());

  test('newest first, default limit 50', async () => {
    const r = await w.rest.get(`/channels/${w.channelId}/messages`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map((m) => m.id), [...ids].reverse());
    assert.equal(r.body[0].content, 'm9');
  });

  test('limit, before, after, around', async () => {
    const limited = await w.rest.get(`/channels/${w.channelId}/messages?limit=3`);
    assert.deepEqual(limited.body.map((m) => m.content), ['m9', 'm8', 'm7']);
    const before = await w.rest.get(`/channels/${w.channelId}/messages?before=${ids[5]}&limit=2`);
    assert.deepEqual(before.body.map((m) => m.content), ['m4', 'm3']);
    const after = await w.rest.get(`/channels/${w.channelId}/messages?after=${ids[5]}&limit=2`);
    assert.deepEqual(after.body.map((m) => m.content), ['m7', 'm6']);
    const around = await w.rest.get(`/channels/${w.channelId}/messages?around=${ids[5]}&limit=3`);
    assert.deepEqual(around.body.map((m) => m.content), ['m6', 'm5', 'm4']);
  });

  test('limit outside 1-100 -> 400 / 50035', async () => {
    for (const l of [0, 101]) {
      const r = await w.rest.get(`/channels/${w.channelId}/messages?limit=${l}`);
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 50035);
      assert.ok(r.body.errors.limit._errors.length);
    }
  });

  // https://discord.com/developers/docs/resources/message#get-channel-messages – "If the current user is missing the
  // READ_MESSAGE_HISTORY permission in the channel, then no messages will be returned."
  // https://discord.com/developers/docs/resources/message#get-channel-message – needs VIEW_CHANNEL and READ_MESSAGE_HISTORY
  test('without READ_MESSAGE_HISTORY: an empty list, and a single message -> 403 / 50013', async () => {
    w.c.setPermissionOverwrite({ channelId: w.channelId, id: w.botRole.id, type: 0, deny: ['READ_MESSAGE_HISTORY'] });
    w.c.setBotPermissions({ applicationId: w.app.id, guildId: w.guildId, permissions: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY'] });
    try {
      const list = await w.rest.get(`/channels/${w.channelId}/messages`);
      assert.equal(list.status, 200);
      assert.deepEqual(list.body, []);
      const one = await w.rest.get(`/channels/${w.channelId}/messages/${ids[0]}`);
      assert.equal(one.status, 403);
      assert.equal(one.body.code, 50013);
    } finally {
      w.c.setBotPermissions({ applicationId: w.app.id, guildId: w.guildId, permissions: ['ADMINISTRATOR'] });
    }
  });

  test('an unknown message -> 404 / 10008', async () => {
    const r = await w.rest.get(`/channels/${w.channelId}/messages/1234567890123456789`);
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { message: 'Unknown Message', code: 10008 });
  });
});

describe('edit message', () => {
  // https://discord.com/developers/docs/resources/message#edit-message
  let w, gc;
  before(async () => {
    w = await world({ rateLimits: false });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, MSG_INTENTS);
  });
  after(async () => { gc.close(); await w.fake.close(); });

  test('the author edits content -> edited_timestamp set, MESSAGE_UPDATE with guild_id, member, channel_type', async () => {
    const m = (await post(w, 'draft')).body;
    w.c.advance(5000);
    const r = await w.rest.patch(`/channels/${w.channelId}/messages/${m.id}`, { content: 'final', embeds: [{ title: 'E' }] });
    assert.equal(r.status, 200);
    assert.equal(r.body.id, m.id);
    assert.equal(r.body.content, 'final');
    assert.equal(r.body.embeds[0].title, 'E');
    assert.equal(Date.parse(r.body.edited_timestamp), START + 5000);
    assert.equal(r.body.timestamp, m.timestamp);
    const ev = await gc.waitForDispatch('MESSAGE_UPDATE', (d) => d.id === m.id);
    assert.equal(ev.d.content, 'final');
    assert.equal(ev.d.guild_id, w.guildId);
    assert.equal(ev.d.channel_type, 0);
    assert.ok(ev.d.member);
  });

  // https://discord.com/developers/docs/topics/opcodes-and-status-codes#json – 50005 Cannot edit a message authored by another user
  test('editing someone else\'s content -> 403 / 50005; flags (SUPPRESS_EMBEDS) are allowed with MANAGE_MESSAGES', async () => {
    const theirs = say(w, w.alice.id, 'mine', { embeds: [{ title: 'x' }] });
    const r = await w.rest.patch(`/channels/${w.channelId}/messages/${theirs.id}`, { content: 'hacked' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 50005);
    assert.equal(w.c.getMessage({ channelId: w.channelId, messageId: theirs.id }).content, 'mine');
    const flags = await w.rest.patch(`/channels/${w.channelId}/messages/${theirs.id}`, { flags: SUPPRESS_EMBEDS });
    assert.equal(flags.status, 200);
    assert.equal(flags.body.flags & SUPPRESS_EMBEDS, SUPPRESS_EMBEDS);
    assert.equal(flags.body.content, 'mine');
  });

  test('editing an unknown message -> 404 / 10008', async () => {
    const r = await w.rest.patch(`/channels/${w.channelId}/messages/1234567890123456789`, { content: 'x' });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 10008);
  });
});

describe('delete message', () => {
  // https://discord.com/developers/docs/resources/message#delete-message
  let w, gc;
  before(async () => {
    w = await world({ rateLimits: false });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, MSG_INTENTS | I.GUILD_MODERATION);
  });
  after(async () => { gc.close(); await w.fake.close(); });

  test('deleting an own message -> 204, MESSAGE_DELETE event, no audit entry', async () => {
    const m = (await post(w, 'oops')).body;
    const r = await w.rest.delete(`/channels/${w.channelId}/messages/${m.id}`);
    assert.equal(r.status, 204);
    assert.equal(r.body, null);
    const ev = await gc.waitForDispatch('MESSAGE_DELETE', (d) => d.id === m.id);
    assert.deepEqual(ev.d, { id: m.id, channel_id: w.channelId, guild_id: w.guildId });
    assert.equal((await auditEntries(w, A.MESSAGE_DELETE)).length, 0);
    const gone = await w.rest.get(`/channels/${w.channelId}/messages/${m.id}`);
    assert.equal(gone.body.code, 10008);
  });

  // https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object-audit-log-events – MESSAGE_DELETE
  test('deleting someone else\'s message (MANAGE_MESSAGES) -> 204, MESSAGE_DELETE event and a MESSAGE_DELETE audit entry', async () => {
    const m = say(w, w.alice.id, 'spam');
    const r = await w.rest.delete(`/channels/${w.channelId}/messages/${m.id}`, { headers: { 'X-Audit-Log-Reason': 'spam' } });
    assert.equal(r.status, 204);
    await gc.waitForDispatch('MESSAGE_DELETE', (d) => d.id === m.id && d.guild_id === w.guildId);
    const [entry] = await auditEntries(w, A.MESSAGE_DELETE);
    assert.equal(entry.target_id, w.alice.id);
    assert.equal(entry.user_id, w.app.bot_user_id);
    assert.equal(entry.reason, 'spam');
    assert.deepEqual(entry.options, { channel_id: w.channelId, count: '1' });
  });

  // https://discord.com/developers/docs/resources/message#message-object-message-types – Deletable column
  // https://discord.com/developers/docs/topics/opcodes-and-status-codes#json – 50021 Cannot execute action on a system message
  test('a non-deletable system message -> 403 / 50021; a deletable system message (USER_JOIN) can be deleted', async () => {
    const sys = w.c.postMessage({ channelId: w.channelId, authorId: w.alice.id, type: 21, force: true });
    const r = await w.rest.delete(`/channels/${w.channelId}/messages/${sys.id}`);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 50021);
    const carol = w.c.createUser({ username: 'carol' });
    w.c.join({ guildId: w.guildId, userId: carol.id });
    const join = w.c.getMessages({ channelId: w.channelId }).find((m) => m.type === 7 && m.author.id === carol.id);
    assert.ok(join);
    const d = await w.rest.delete(`/channels/${w.channelId}/messages/${join.id}`);
    assert.equal(d.status, 204);
    // Other deletable types from the table, e.g. GUILD_DISCOVERY_DISQUALIFIED (14) and PURCHASE_NOTIFICATION (44).
    for (const type of [14, 44]) {
      const m = w.c.postMessage({ channelId: w.channelId, authorId: w.alice.id, type, force: true });
      assert.equal((await w.rest.delete(`/channels/${w.channelId}/messages/${m.id}`)).status, 204, `type ${type}`);
    }
  });

  test('without MANAGE_MESSAGES, someone else\'s message -> 403 / 50013; own messages still work', async () => {
    const w2 = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY'] });
    try {
      const theirs = w2.c.postMessage({ channelId: w2.channelId, authorId: w2.alice.id, content: 'hi' });
      const r = await w2.rest.delete(`/channels/${w2.channelId}/messages/${theirs.id}`);
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 50013);
      const own = (await w2.rest.post(`/channels/${w2.channelId}/messages`, { content: 'mine' })).body;
      assert.equal((await w2.rest.delete(`/channels/${w2.channelId}/messages/${own.id}`)).status, 204);
    } finally {
      await w2.fake.close();
    }
  });
});

describe('bulk delete', () => {
  // https://discord.com/developers/docs/resources/message#bulk-delete-messages
  let w, gc;
  const bulk = (w, messages, headers) => w.rest.post(`/channels/${w.channelId}/messages/bulk-delete`, { messages }, headers ? { headers } : undefined);
  before(async () => {
    w = await world({ rateLimits: false });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, MSG_INTENTS);
  });
  after(async () => { gc.close(); await w.fake.close(); });

  test('deletes 2-100 messages -> 204, MESSAGE_DELETE_BULK event, MESSAGE_BULK_DELETE audit entry', async () => {
    const ids = [say(w, w.alice.id, 'a').id, say(w, w.bob.id, 'b').id, (await post(w, 'c')).body.id];
    const keep = say(w, w.alice.id, 'keep');
    const r = await bulk(w, ids, { 'X-Audit-Log-Reason': 'cleanup' });
    assert.equal(r.status, 204);
    const ev = await gc.waitForDispatch('MESSAGE_DELETE_BULK', (d) => d.ids.includes(ids[0]));
    assert.deepEqual([...ev.d.ids].sort(), [...ids].sort());
    assert.equal(ev.d.channel_id, w.channelId);
    assert.equal(ev.d.guild_id, w.guildId);
    const left = await w.rest.get(`/channels/${w.channelId}/messages`);
    assert.deepEqual(left.body.map((m) => m.id), [keep.id]);
    const [entry] = await auditEntries(w, A.MESSAGE_BULK_DELETE);
    assert.equal(entry.target_id, w.channelId);
    assert.equal(entry.reason, 'cleanup');
    assert.deepEqual(entry.options, { count: '3' });
  });

  test('fewer than 2 or more than 100 ids, or a missing list -> 400 / 50035', async () => {
    const one = say(w, w.alice.id, 'one');
    for (const messages of [[one.id], Array.from({ length: 101 }, (_, i) => String(BigInt(one.id) + BigInt(i)))]) {
      const r = await bulk(w, messages);
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 50035);
      assert.ok(r.body.errors.messages._errors.length);
    }
    const missing = await w.rest.post(`/channels/${w.channelId}/messages/bulk-delete`, {});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.errors.messages._errors[0].code, 'BASE_TYPE_REQUIRED');
    assert.ok(w.c.getMessage({ channelId: w.channelId, messageId: one.id }));
  });

  test('duplicate ids -> 400 / 50035 and nothing is deleted', async () => {
    const a = say(w, w.alice.id, 'dup');
    const b = say(w, w.alice.id, 'dup2');
    const r = await bulk(w, [a.id, b.id, a.id]);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 50035);
    assert.ok(r.body.errors.messages);
    assert.ok(w.c.getMessage({ channelId: w.channelId, messageId: b.id }));
  });

  // https://discord.com/developers/docs/topics/opcodes-and-status-codes#json – 50034 A message provided was too old to bulk delete
  test('any message older than 14 days -> 400 / 50034 and nothing is deleted', async () => {
    const old = w.c.postMessage({ channelId: w.channelId, authorId: w.alice.id, content: 'ancient', timestamp: w.c.now().now - 15 * DAY });
    assert.equal(snowflakeTime(old.id), w.c.now().now - 15 * DAY);
    const fresh = say(w, w.alice.id, 'fresh');
    const r = await bulk(w, [old.id, fresh.id]);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { message: 'A message provided was too old to bulk delete', code: 50034 });
    assert.ok(w.c.getMessage({ channelId: w.channelId, messageId: fresh.id }));

    // Messages age with the clock: 13 days later they are still deletable, 15 days later they are not.
    const x = say(w, w.alice.id, 'x');
    const y = say(w, w.alice.id, 'y');
    w.c.advance(13 * DAY);
    const z = say(w, w.alice.id, 'z');
    const zz = say(w, w.alice.id, 'zz');
    w.c.advance(2 * DAY);
    const tooOld = await bulk(w, [x.id, y.id]);
    assert.equal(tooOld.status, 400);
    assert.equal(tooOld.body.code, 50034);
    const ok = await bulk(w, [z.id, zz.id, fresh.id].slice(0, 2));
    assert.equal(ok.status, 204);
  });

  test('without MANAGE_MESSAGES -> 403 / 50013', async () => {
    const w2 = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY'] });
    try {
      const a = w2.c.postMessage({ channelId: w2.channelId, authorId: w2.alice.id, content: 'a' });
      const b = w2.c.postMessage({ channelId: w2.channelId, authorId: w2.alice.id, content: 'b' });
      const r = await bulk(w2, [a.id, b.id]);
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 50013);
    } finally {
      await w2.fake.close();
    }
  });

  test('a DM channel -> 403 / 50003', async () => {
    const dm = (await w.rest.post('/users/@me/channels', { recipient_id: w.alice.id })).body;
    const a = (await post(w, 'a', dm.id)).body;
    const b = (await post(w, 'b', dm.id)).body;
    const r = await w.rest.post(`/channels/${dm.id}/messages/bulk-delete`, { messages: [a.id, b.id] });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 50003);
  });
});

describe('file uploads and the CDN', () => {
  // https://discord.com/developers/docs/reference#uploading-files
  // https://discord.com/developers/docs/resources/message#attachment-object
  const TTL = 60_000;
  let w;
  before(async () => { w = await world({ rateLimits: false, cdn: { attachmentTtlMs: TTL } }); });
  after(() => w.fake.close());

  async function upload(content, files) {
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify({ content, attachments: files.map((f, i) => ({ id: i, filename: f.name, description: f.description })) }));
    files.forEach((f, i) => fd.append(`files[${i}]`, new Blob([f.data], { type: f.type }), f.name));
    const res = await fetch(`${w.fake.restUrl}/channels/${w.channelId}/messages`, { method: 'POST', headers: { Authorization: `Bot ${w.app.token}` }, body: fd });
    return { status: res.status, body: await res.json() };
  }

  test('multipart payload_json + files[n] -> attachments with signed CDN urls that serve the bytes', async () => {
    const r = await upload('see attached', [
      { name: 'hello.txt', type: 'text/plain', data: 'hello world', description: 'a greeting' },
      { name: 'data.bin', type: 'application/octet-stream', data: new Uint8Array([0, 1, 2, 255]) },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.body.content, 'see attached');
    assert.equal(r.body.attachments.length, 2);
    const [a, b] = r.body.attachments;
    assert.match(a.id, /^\d+$/);
    assert.equal(a.filename, 'hello.txt');
    assert.equal(a.description, 'a greeting');
    assert.equal(a.size, 11);
    assert.match(a.content_type, /^text\/plain/);
    assert.equal(b.size, 4);
    const u = new URL(a.url);
    assert.ok(a.url.startsWith(`${w.fake.cdnUrl}/attachments/${w.channelId}/${a.id}/hello.txt?`));
    assert.match(u.searchParams.get('ex'), /^[0-9a-f]+$/);
    assert.match(u.searchParams.get('is'), /^[0-9a-f]+$/);
    assert.match(u.searchParams.get('hm'), /^[0-9a-f]+$/);
    assert.equal(parseInt(u.searchParams.get('ex'), 16) - parseInt(u.searchParams.get('is'), 16), TTL / 1000);
    assert.ok(a.proxy_url);

    const res = await fetch(a.url);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'hello world');
    const bin = Buffer.from(await (await fetch(b.url)).arrayBuffer());
    assert.deepEqual([...bin], [0, 1, 2, 255]);
  });

  test('a tampered url -> 404; after expiry -> 404, and re-fetching the message gives a fresh url', async () => {
    const r = await upload('', [{ name: 'secret.txt', type: 'text/plain', data: 'top secret' }]);
    assert.equal(r.status, 200);
    const url = r.body.attachments[0].url;
    const tampered = url.replace(/hm=([0-9a-f])/, (_, c) => `hm=${c === '0' ? '1' : '0'}`);
    assert.equal((await fetch(tampered)).status, 404);
    const longer = url.replace(/ex=[0-9a-f]+/, `ex=${(Math.floor(w.c.now().now / 1000) + 10 * 365 * 86400).toString(16)}`);
    assert.equal((await fetch(longer)).status, 404);
    assert.equal((await fetch(url.replace('/secret.txt', '/other.txt'))).status, 404);
    assert.equal((await fetch(url)).status, 200);

    w.c.advance(TTL + 1000);
    assert.equal((await fetch(url)).status, 404);
    const again = await w.rest.get(`/channels/${w.channelId}/messages/${r.body.id}`);
    const fresh = again.body.attachments[0].url;
    assert.notEqual(fresh, url);
    const res = await fetch(fresh);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'top secret');
  });

  test('a file alone is a valid (non-empty) message; invalid payload_json -> 400 / 50109', async () => {
    const r = await upload(undefined, [{ name: 'only.txt', type: 'text/plain', data: 'x' }]);
    assert.equal(r.status, 200);
    assert.equal(r.body.attachments.length, 1);
    const fd = new FormData();
    fd.append('payload_json', '{nope');
    const bad = await fetch(`${w.fake.restUrl}/channels/${w.channelId}/messages`, { method: 'POST', headers: { Authorization: `Bot ${w.app.token}` }, body: fd });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 50109);
  });
});

describe('message content privilege over REST', () => {
  // https://discord.com/developers/docs/events/gateway#message-content-intent – applies to messages received over the API too;
  // apps still get content of their own messages, DMs, and messages that mention them.
  let w, theirs, mentioning, own, dmMsg, withFile;
  before(async () => {
    w = await world({ rateLimits: false, privilegedIntents: { guildMembers: true, messageContent: false } });
    theirs = say(w, w.alice.id, 'secret plans', { embeds: [{ title: 'E' }], attachments: [{ filename: 'a.txt', data: 'x' }] });
    mentioning = say(w, w.alice.id, `hey <@${w.app.bot_user_id}> look`);
    own = (await post(w, { content: 'from the bot', embeds: [{ title: 'mine' }] })).body;
    const dm = (await w.rest.post('/users/@me/channels', { recipient_id: w.alice.id })).body;
    dmMsg = w.c.postMessage({ channelId: dm.id, authorId: w.alice.id, content: 'private hello' });
    withFile = dm.id;
  });
  after(() => w.fake.close());

  test('other users\' guild messages have content, embeds and attachments blanked', async () => {
    const r = await w.rest.get(`/channels/${w.channelId}/messages/${theirs.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, theirs.id);
    assert.equal(r.body.author.id, w.alice.id);
    assert.equal(r.body.content, '');
    assert.deepEqual(r.body.embeds, []);
    assert.deepEqual(r.body.attachments, []);
    const list = await w.rest.get(`/channels/${w.channelId}/messages`);
    assert.equal(list.body.find((m) => m.id === theirs.id).content, '');
  });

  test('own messages, messages mentioning the app, and DMs keep their content', async () => {
    const list = (await w.rest.get(`/channels/${w.channelId}/messages`)).body;
    assert.equal(list.find((m) => m.id === own.id).content, 'from the bot');
    assert.equal(list.find((m) => m.id === own.id).embeds[0].title, 'mine');
    assert.equal(list.find((m) => m.id === mentioning.id).content, `hey <@${w.app.bot_user_id}> look`);
    const dm = await w.rest.get(`/channels/${withFile}/messages/${dmMsg.id}`);
    assert.equal(dm.status, 200);
    assert.equal(dm.body.content, 'private hello');
  });

  test('with the privilege enabled, content is visible', async () => {
    w.c.setPrivilegedIntents({ applicationId: w.app.id, messageContent: true });
    try {
      const r = await w.rest.get(`/channels/${w.channelId}/messages/${theirs.id}`);
      assert.equal(r.body.content, 'secret plans');
      assert.equal(r.body.attachments.length, 1);
    } finally {
      w.c.setPrivilegedIntents({ applicationId: w.app.id, messageContent: false });
    }
  });
});
