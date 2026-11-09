// The real @discordjs/rest client against the fake – https://discord.com/developers/docs/reference
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { REST, DiscordAPIError, RESTEvents } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import { world, client } from './helpers.js';

const SEND = 'POST /channels/:channel_id/messages';

function makeRest(w, extra = {}) {
  return new REST({ api: w.fake.apiUrl, cdn: w.fake.cdnUrl, version: '10', ...extra }).setToken(w.app.token);
}
function dispose(rest) {
  rest.clearHashSweeper();
  rest.clearHandlerSweeper();
}

describe('@discordjs/rest: basic calls and errors', () => {
  let w, rest;
  before(async () => { w = await world({ rateLimits: false }); rest = makeRest(w); });
  after(async () => { dispose(rest); await w.fake.close(); });

  test('GET /users/@me and POST a message', async () => {
    const me = await rest.get(Routes.user('@me'));
    assert.equal(me.id, w.app.bot_user_id);
    const msg = await rest.post(Routes.channelMessages(w.channelId), { body: { content: 'from discord.js' } });
    assert.equal(msg.content, 'from discord.js');
    assert.equal(msg.author.id, w.app.bot_user_id);
    assert.equal(w.c.getMessage({ channelId: w.channelId, messageId: msg.id }).content, 'from discord.js');
  });

  // https://discord.com/developers/docs/topics/opcodes-and-status-codes#json
  test('an unknown member -> DiscordAPIError 404 / 10007', async () => {
    const stranger = w.c.createUser({ username: 'stranger' });
    await assert.rejects(rest.get(Routes.guildMember(w.guildId, stranger.id)), (err) => {
      assert.ok(err instanceof DiscordAPIError);
      assert.equal(err.status, 404);
      assert.equal(err.code, 10007);
      assert.equal(err.message, 'Unknown Member');
      assert.equal(err.method, 'GET');
      return true;
    });
  });

  test('a form error -> DiscordAPIError 400 / 50035 with rawError.errors', async () => {
    await assert.rejects(rest.post(Routes.channelMessages(w.channelId), { body: { content: 'x'.repeat(2001) } }), (err) => {
      assert.ok(err instanceof DiscordAPIError);
      assert.equal(err.status, 400);
      assert.equal(err.code, 50035);
      assert.equal(err.rawError.errors.content._errors[0].code, 'BASE_TYPE_MAX_LENGTH');
      return true;
    });
  });

  test('missing permissions -> DiscordAPIError 403 / 50013', async () => {
    w.c.setBotPermissions({ applicationId: w.app.id, guildId: w.guildId, permissions: ['VIEW_CHANNEL', 'SEND_MESSAGES'] });
    try {
      await assert.rejects(rest.put(Routes.guildBan(w.guildId, w.bob.id), { body: {} }), (err) => {
        assert.ok(err instanceof DiscordAPIError);
        assert.equal(err.status, 403);
        assert.equal(err.code, 50013);
        return true;
      });
      assert.deepEqual(w.c.getBans({ guildId: w.guildId }), []);
    } finally {
      w.c.setBotPermissions({ applicationId: w.app.id, guildId: w.guildId, permissions: ['ADMINISTRATOR'] });
    }
  });

  // https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object – X-Audit-Log-Reason
  test('the reason option becomes the audit-log reason', async () => {
    await rest.put(Routes.guildBan(w.guildId, w.bob.id), { body: { delete_message_seconds: 0 }, reason: 'raid, sorry' });
    const ban = await rest.get(Routes.guildBan(w.guildId, w.bob.id));
    assert.equal(ban.user.id, w.bob.id);
    const log = await rest.get(Routes.guildAuditLog(w.guildId), { query: new URLSearchParams({ action_type: '22' }) });
    assert.equal(log.audit_log_entries[0].target_id, w.bob.id);
    assert.equal(log.audit_log_entries[0].reason, 'raid, sorry');
  });

  // https://discord.com/developers/docs/reference#uploading-files
  test('file uploads work and the attachment is served by the CDN', async () => {
    const msg = await rest.post(Routes.channelMessages(w.channelId), {
      body: { content: 'with file' },
      files: [{ name: 'notes.txt', data: Buffer.from('some notes'), contentType: 'text/plain' }],
    });
    assert.equal(msg.attachments.length, 1);
    const a = msg.attachments[0];
    assert.equal(a.filename, 'notes.txt');
    assert.equal(a.size, 10);
    assert.match(a.url, /\?ex=[0-9a-f]+&is=[0-9a-f]+&hm=[0-9a-f]+/);
    const res = await fetch(a.url);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'some notes');
    assert.equal(w.c.getMessage({ channelId: w.channelId, messageId: msg.id }).attachments.length, 1);
  });

  test('5xx answers are retried; the write lands exactly once', async () => {
    const before = w.c.getMessages({ channelId: w.channelId }).length;
    w.c.injectError({ route: SEND, status: 502 });
    const msg = await rest.post(Routes.channelMessages(w.channelId), { body: { content: 'after a 502' } });
    assert.equal(msg.content, 'after a 502');
    const after = w.c.getMessages({ channelId: w.channelId });
    assert.equal(after.length, before + 1);
    const log = w.c.getRequestLog({ route: SEND }).filter((e) => e.request?.content === 'after a 502');
    assert.deepEqual(log.map((e) => e.status), [502, 200]);
  });
});

describe('@discordjs/rest: rate limits', () => {
  // https://discord.com/developers/docs/topics/rate-limits#exceeding-a-rate-limit
  let w, rest;
  before(async () => {
    w = await world({ clock: 'real', rateLimits: { routes: { [SEND]: { limit: 1, windowMs: 300 } } } });
    rest = makeRest(w);
  });
  after(async () => { dispose(rest); await w.fake.close(); });

  test('a 429 from an exhausted bucket is waited out and retried; the write happens once', async () => {
    // Exhaust the bucket behind the client's back (same bot token, same bucket).
    const raw = client(w.fake, `Bot ${w.app.token}`);
    assert.equal((await raw.post(`/channels/${w.channelId}/messages`, { content: 'first' })).status, 200);
    const limited = [];
    rest.on(RESTEvents.Response, (req, res) => { if (res.status === 429) limited.push(req.path); });
    const msg = await rest.post(Routes.channelMessages(w.channelId), { body: { content: 'retried' } });
    assert.equal(msg.content, 'retried');
    const log = w.c.getRequestLog({ route: SEND });
    const mine = log.filter((e) => e.request?.content === 'retried');
    assert.equal(mine[0].status, 429);
    assert.equal(mine.at(-1).status, 200);
    assert.ok(limited.length >= 1, 'the client saw the 429');
    assert.equal(w.c.getMessages({ channelId: w.channelId }).filter((m) => m.content === 'retried').length, 1);
  });

  test('an injected 429 (short retry_after) is retried transparently', async () => {
    w.c.injectRateLimit({ route: 'GET /channels/:channel_id', retryAfter: 0.1 });
    const ch = await rest.get(Routes.channel(w.channelId));
    assert.equal(ch.id, w.channelId);
    const statuses = w.c.getRequestLog({ route: 'GET /channels/:channel_id' }).map((e) => e.status);
    assert.deepEqual(statuses.slice(-2), [429, 200]);
  });

  test('the client honours X-RateLimit-Remaining: 0 and waits for the reset (no 429 needed)', async () => {
    await new Promise((r) => setTimeout(r, 350));
    const other = w.c.createChannel({ guildId: w.guildId, name: 'burst' });
    const results = await Promise.all([1, 2, 3].map((i) => rest.post(Routes.channelMessages(other.id), { body: { content: `burst ${i}` } })));
    assert.deepEqual(results.map((m) => m.content), ['burst 1', 'burst 2', 'burst 3']);
    const msgs = (await rest.get(Routes.channelMessages(other.id))).map((m) => m.content);
    assert.deepEqual(msgs, ['burst 3', 'burst 2', 'burst 1']);
  });
});
