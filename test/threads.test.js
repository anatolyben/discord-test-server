// Threads, forum posts and thread members – https://discord.com/developers/docs/resources/channel#start-thread-from-message
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, GatewayClient } from './helpers.js';
import { Intents as I } from '../src/constants.js';

const INTENTS = I.GUILDS | I.GUILD_MEMBERS | I.GUILD_MESSAGES | I.MESSAGE_CONTENT | I.GUILD_MODERATION;
const say = (w, content = 'hi', channelId = w.channelId, authorId = w.alice.id) => w.c.postMessage({ channelId, authorId, content });

describe('start a thread from a message', () => {
  let w, gc;
  before(async () => {
    w = await world({ rateLimits: false });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, INTENTS);
  });
  after(async () => { gc.close(); await w.fake.close(); });

  test('POST /channels/:id/messages/:id/threads -> a public thread with the message id; THREAD_CREATE and MESSAGE_UPDATE; the starter is a member', async () => {
    const m = say(w, 'discuss this');
    const r = await w.rest.post(`/channels/${w.channelId}/messages/${m.id}/threads`, { name: 'Discussion', auto_archive_duration: 60 }, { headers: { 'X-Audit-Log-Reason': 'topic' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.id, m.id);
    assert.equal(r.body.type, 11);
    assert.equal(r.body.parent_id, w.channelId);
    assert.equal(r.body.owner_id, w.app.bot_user_id);
    assert.equal(r.body.thread_metadata.auto_archive_duration, 60);
    assert.equal(r.body.member_count, 1);
    const ev = await gc.waitForDispatch('THREAD_CREATE', (d) => d.id === m.id);
    assert.equal(ev.d.newly_created, true);
    const upd = await gc.waitForDispatch('MESSAGE_UPDATE', (d) => d.id === m.id && d.thread);
    assert.equal(upd.d.thread.id, m.id);
    assert.equal(upd.d.flags & (1 << 5), 1 << 5); // HAS_THREAD
    const got = await w.rest.get(`/channels/${w.channelId}/messages/${m.id}`);
    assert.equal(got.body.thread.name, 'Discussion');
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=110`)).body.audit_log_entries[0].reason, 'topic');
  });

  test('a second thread for the same message -> 400/160004; unknown message -> 404/10008', async () => {
    const m = say(w);
    await w.rest.post(`/channels/${w.channelId}/messages/${m.id}/threads`, { name: 'one' });
    const r = await w.rest.post(`/channels/${w.channelId}/messages/${m.id}/threads`, { name: 'two' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 160004);
    assert.equal((await w.rest.post(`/channels/${w.channelId}/messages/1/threads`, { name: 'x' })).body.code, 10008);
  });

  test('announcement channels get ANNOUNCEMENT_THREAD (10); forum channels and DMs refuse; the name is required', async () => {
    const news = w.c.createChannel({ guildId: w.guildId, name: 'news', type: 5 });
    const m = w.c.postMessage({ channelId: news.id, authorId: w.alice.id, content: 'n', force: true });
    assert.equal((await w.rest.post(`/channels/${news.id}/messages/${m.id}/threads`, { name: 'news thread' })).body.type, 10);
    const forum = w.c.createChannel({ guildId: w.guildId, name: 'forum', type: 15 });
    const fm = w.c.postMessage({ channelId: forum.id, authorId: w.alice.id, content: 'x', force: true });
    assert.equal((await w.rest.post(`/channels/${forum.id}/messages/${fm.id}/threads`, { name: 'x' })).body.code, 50024);
    assert.equal((await w.rest.post(`/channels/${w.channelId}/messages/${say(w).id}/threads`, {})).body.code, 50035);
  });

  test('CREATE_PUBLIC_THREADS is required', async () => {
    const w2 = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY'] });
    try {
      w2.c.updateRole({ guildId: w2.guildId, roleId: w2.guildId, permissions: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY'] });
      const m = w2.c.postMessage({ channelId: w2.channelId, authorId: w2.alice.id, content: 'x' });
      assert.equal((await w2.rest.post(`/channels/${w2.channelId}/messages/${m.id}/threads`, { name: 'x' })).body.code, 50013);
    } finally { await w2.fake.close(); }
  });
});

describe('forum posts', () => {
  test('POST /channels/:forum/threads with a message -> the thread with a nested message that shares its id; applied_tags are kept', async () => {
    const w = await world({ rateLimits: false });
    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    try {
      await gc.ready(w.app.token, INTENTS);
      const forum = w.c.createChannel({ guildId: w.guildId, name: 'help', type: 15 });
      const r = await w.rest.post(`/channels/${forum.id}/threads`, { name: 'Bug report', message: { content: 'it broke' }, applied_tags: ['123456789012345678'] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.type, 11);
      assert.equal(r.body.parent_id, forum.id);
      assert.deepEqual(r.body.applied_tags, ['123456789012345678']);
      assert.equal(r.body.message.id, r.body.id);
      assert.equal(r.body.message.content, 'it broke');
      assert.equal(r.body.message.channel_id, r.body.id);
      assert.equal(r.body.message_count, 1);
      await gc.waitForDispatch('THREAD_CREATE', (d) => d.id === r.body.id);
      const created = await gc.waitForDispatch('MESSAGE_CREATE', (d) => d.id === r.body.id);
      assert.equal(created.d.content, 'it broke');
      assert.equal((await w.rest.get(`/channels/${r.body.id}/messages/${r.body.id}`)).body.content, 'it broke');
    } finally { gc.close(); await w.fake.close(); }
  });

  test('a forum post needs a message with content; a plain thread in a forum is refused', async () => {
    const w = await world({ rateLimits: false });
    try {
      const forum = w.c.createChannel({ guildId: w.guildId, name: 'help', type: 15 });
      assert.equal((await w.rest.post(`/channels/${forum.id}/threads`, { name: 'no message' })).body.code, 50035);
      assert.equal((await w.rest.post(`/channels/${forum.id}/threads`, { name: 'empty', message: {} })).body.code, 50006);
    } finally { await w.fake.close(); }
  });
});

describe('thread members', () => {
  let w, gc, gcNoMembers, thread;
  before(async () => {
    w = await world({ rateLimits: false });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, INTENTS);
    gcNoMembers = await GatewayClient.connect(w.fake.gatewayUrl);
    await gcNoMembers.ready(w.app.token, I.GUILDS);
    thread = (await w.rest.post(`/channels/${w.channelId}/threads`, { name: 'room', type: 11 })).body;
  });
  after(async () => { gc.close(); gcNoMembers.close(); await w.fake.close(); });
  const tm = (uid = '@me') => `/channels/${thread.id}/thread-members/${uid}`;

  test('PUT .../thread-members/:user adds someone: 204, THREAD_MEMBERS_UPDATE with added_members (incl. member) and member_count', async () => {
    assert.equal((await w.rest.put(tm(w.alice.id))).status, 204);
    const ev = await gc.waitForDispatch('THREAD_MEMBERS_UPDATE', (d) => d.id === thread.id && d.added_members?.some((m) => m.user_id === w.alice.id));
    assert.equal(ev.d.guild_id, w.guildId);
    assert.equal(ev.d.member_count, 2);
    const added = ev.d.added_members[0];
    assert.equal(added.id, thread.id);
    assert.equal(added.flags, 0);
    assert.ok(Date.parse(added.join_timestamp) > 0);
    assert.equal(added.member.user.id, w.alice.id);
    assert.equal((await w.rest.put(tm(w.alice.id))).status, 204); // already a member
    assert.equal(gc.dispatches('THREAD_MEMBERS_UPDATE').filter((f) => f.d.added_members?.some((m) => m.user_id === w.alice.id)).length, 1);
  });

  test('without GUILD_MEMBERS the bot only hears about changes that involve itself', async () => {
    await w.rest.put(tm(w.bob.id));
    assert.deepEqual(await gcNoMembers.expectNone('THREAD_MEMBERS_UPDATE', (d) => d.added_members?.some((m) => m.user_id === w.bob.id)), []);
    await w.rest.delete(tm('@me')); // the bot leaves: it hears about itself
    const ev = await gcNoMembers.waitForDispatch('THREAD_MEMBERS_UPDATE', (d) => d.removed_member_ids?.includes(w.app.bot_user_id));
    assert.equal(ev.d.id, thread.id);
    assert.equal((await w.rest.put(tm('@me'))).status, 204);
    await gcNoMembers.waitForDispatch('THREAD_MEMBERS_UPDATE', (d) => d.added_members?.some((m) => m.user_id === w.app.bot_user_id));
  });

  test('GET .../thread-members/:user (with_member) and the list (with_member paginates by user id)', async () => {
    const one = await w.rest.get(`${tm(w.alice.id)}?with_member=true`);
    assert.equal(one.status, 200);
    assert.equal(one.body.user_id, w.alice.id);
    assert.equal(one.body.id, thread.id);
    assert.ok(one.body.member.roles);
    assert.equal((await w.rest.get(tm(w.mod.id))).status, 404);
    const all = await w.rest.get(`/channels/${thread.id}/thread-members`);
    assert.deepEqual(all.body.map((m) => m.user_id).sort(), [w.alice.id, w.bob.id, w.app.bot_user_id].sort());
    assert.equal(all.body[0].member, undefined);
    const page = await w.rest.get(`/channels/${thread.id}/thread-members?with_member=true&limit=2`);
    assert.equal(page.body.length, 2);
    assert.ok(page.body[0].member);
    const next = await w.rest.get(`/channels/${thread.id}/thread-members?with_member=true&after=${page.body[1].user_id}`);
    assert.equal(next.body.length, 1);
  });

  test('DELETE .../thread-members/:user removes (MANAGE_THREADS, or the creator of a private thread); THREAD_MEMBERS_UPDATE has removed_member_ids', async () => {
    assert.equal((await w.rest.delete(tm(w.bob.id))).status, 204);
    const ev = await gc.waitForDispatch('THREAD_MEMBERS_UPDATE', (d) => d.removed_member_ids?.includes(w.bob.id));
    assert.equal(ev.d.member_count, 2);
    assert.equal((await w.rest.get(tm(w.bob.id))).status, 404);
    const w2 = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL', 'SEND_MESSAGES_IN_THREADS', 'READ_MESSAGE_HISTORY'] });
    try {
      const t = w2.c.createChannel({ guildId: w2.guildId, name: 't', type: 11, parentId: w2.channelId, ownerId: w2.alice.id });
      w2.c.joinThread({ threadId: t.id, userId: w2.bob.id });
      assert.equal((await w2.rest.delete(`/channels/${t.id}/thread-members/${w2.bob.id}`)).body.code, 50013);
    } finally { await w2.fake.close(); }
  });

  test('archived threads refuse membership changes with 400/50083; non-threads with 400/50024', async () => {
    const t = (await w.rest.post(`/channels/${w.channelId}/threads`, { name: 'old', type: 11 })).body;
    await w.rest.patch(`/channels/${t.id}`, { archived: true });
    assert.equal((await w.rest.put(`/channels/${t.id}/thread-members/@me`)).body.code, 50083);
    assert.equal((await w.rest.put(`/channels/${t.id}/thread-members/${w.alice.id}`)).body.code, 50083);
    assert.equal((await w.rest.put(`/channels/${w.channelId}/thread-members/@me`)).body.code, 50024);
  });

  test('control.joinThread / leaveThread act as a person; updateThreadMember sends THREAD_MEMBER_UPDATE to the bot only for its own membership', async () => {
    w.c.joinThread({ threadId: thread.id, userId: w.mod.id });
    assert.ok((await w.rest.get(tm(w.mod.id))).body.user_id);
    w.c.leaveThread({ threadId: thread.id, userId: w.mod.id });
    assert.equal((await w.rest.get(tm(w.mod.id))).status, 404);
    w.c.updateThreadMember({ threadId: thread.id, userId: w.app.bot_user_id, flags: 2 });
    const ev = await gc.waitForDispatch('THREAD_MEMBER_UPDATE', (d) => d.id === thread.id);
    assert.equal(ev.d.flags, 2);
    assert.equal(ev.d.guild_id, w.guildId);
    assert.equal(ev.d.user_id, w.app.bot_user_id);
    w.c.updateThreadMember({ threadId: thread.id, userId: w.alice.id, flags: 2 });
    assert.equal(gc.dispatches('THREAD_MEMBER_UPDATE').length, 1);
  });

  test('the active threads list reports the bot\'s own thread member objects', async () => {
    const r = await w.rest.get(`/guilds/${w.guildId}/threads/active`);
    assert.ok(r.body.threads.some((t) => t.id === thread.id));
    assert.ok(r.body.members.some((m) => m.id === thread.id && m.user_id === w.app.bot_user_id));
  });
});

describe('archived thread lists and private threads', () => {
  test('public archived threads: newest archive first, before and limit page, has_more', async () => {
    const w = await world({ rateLimits: false });
    try {
      const ids = [];
      for (const name of ['a', 'b', 'c']) {
        const t = (await w.rest.post(`/channels/${w.channelId}/threads`, { name, type: 11 })).body;
        await w.rest.patch(`/channels/${t.id}`, { archived: true });
        ids.push(t.id);
        w.c.advance(60_000);
      }
      const all = await w.rest.get(`/channels/${w.channelId}/threads/archived/public`);
      assert.deepEqual(all.body.threads.map((t) => t.id), [...ids].reverse());
      assert.equal(all.body.has_more, false);
      assert.equal(all.body.members.length, 3);
      const page = await w.rest.get(`/channels/${w.channelId}/threads/archived/public?limit=2`);
      assert.equal(page.body.threads.length, 2);
      assert.equal(page.body.has_more, true);
      const before = await w.rest.get(`/channels/${w.channelId}/threads/archived/public?before=${encodeURIComponent(page.body.threads[1].thread_metadata.archive_timestamp)}`);
      assert.deepEqual(before.body.threads.map((t) => t.id), [ids[0]]);
      const priv = (await w.rest.post(`/channels/${w.channelId}/threads`, { name: 'secret', type: 12 })).body;
      await w.rest.patch(`/channels/${priv.id}`, { archived: true });
      assert.ok(!(await w.rest.get(`/channels/${w.channelId}/threads/archived/public`)).body.threads.some((t) => t.id === priv.id));
      assert.ok((await w.rest.get(`/channels/${w.channelId}/threads/archived/private`)).body.threads.some((t) => t.id === priv.id));
      assert.ok((await w.rest.get(`/channels/${w.channelId}/users/@me/threads/archived/private`)).body.threads.some((t) => t.id === priv.id));
    } finally { await w.fake.close(); }
  });

  test('private archived threads need READ_MESSAGE_HISTORY and MANAGE_THREADS; the joined list only READ_MESSAGE_HISTORY', async () => {
    const w = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY'] });
    try {
      assert.equal((await w.rest.get(`/channels/${w.channelId}/threads/archived/private`)).body.code, 50013);
      assert.equal((await w.rest.get(`/channels/${w.channelId}/users/@me/threads/archived/private`)).status, 200);
      assert.equal((await w.rest.get(`/channels/${w.channelId}/threads/archived/public`)).status, 200);
    } finally { await w.fake.close(); }
  });

  test('a private thread is only visible to its members and to MANAGE_THREADS', async () => {
    const w = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL', 'SEND_MESSAGES_IN_THREADS', 'READ_MESSAGE_HISTORY'] });
    try {
      const t = w.c.createChannel({ guildId: w.guildId, name: 'secret', type: 12, parentId: w.channelId, ownerId: w.alice.id });
      w.c.postMessage({ channelId: t.id, authorId: w.alice.id, content: 'private talk', force: true });
      assert.equal((await w.rest.get(`/channels/${t.id}/messages`)).body.code, 50001);
      w.c.joinThread({ threadId: t.id, userId: w.app.bot_user_id, force: true });
      assert.equal((await w.rest.get(`/channels/${t.id}/messages`)).body[0].content.length >= 0, true);
    } finally { await w.fake.close(); }
  });
});
