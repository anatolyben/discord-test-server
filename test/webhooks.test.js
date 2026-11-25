// Webhooks – https://discord.com/developers/docs/resources/webhook
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, client, GatewayClient } from './helpers.js';
import { Intents as I } from '../src/constants.js';

const INTENTS = I.GUILDS | I.GUILD_MESSAGES | I.GUILD_WEBHOOKS | I.GUILD_MODERATION | I.MESSAGE_CONTENT;

describe('manage webhooks', () => {
  let w, gc, anon;
  before(async () => {
    w = await world({ rateLimits: false });
    anon = client(w.fake, null);
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, INTENTS);
  });
  after(async () => { gc.close(); await w.fake.close(); });

  const create = (name = 'Hook', extra = {}) => w.rest.post(`/channels/${w.channelId}/webhooks`, { name, ...extra }, { headers: { 'X-Audit-Log-Reason': 'logs' } });

  test('POST /channels/:id/webhooks -> the webhook with token and url; WEBHOOKS_UPDATE; WEBHOOK_CREATE (50) in the audit log', async () => {
    const r = await create('Logger');
    assert.equal(r.status, 200);
    assert.equal(r.body.type, 1);
    assert.equal(r.body.name, 'Logger');
    assert.equal(r.body.channel_id, w.channelId);
    assert.equal(r.body.guild_id, w.guildId);
    assert.equal(r.body.application_id, null);
    assert.equal(r.body.user.id, w.app.bot_user_id);
    assert.ok(r.body.token.length > 20);
    const ev = await gc.waitForDispatch('WEBHOOKS_UPDATE', (d) => d.channel_id === w.channelId);
    assert.equal(ev.d.guild_id, w.guildId);
    const entry = (await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=50`)).body.audit_log_entries[0];
    assert.equal(entry.target_id, r.body.id);
    assert.equal(entry.reason, 'logs');
  });

  test('list by channel and by guild; get by id (with user) and by id+token (without user)', async () => {
    const h = (await create('Listed')).body;
    assert.ok((await w.rest.get(`/channels/${w.channelId}/webhooks`)).body.some((x) => x.id === h.id));
    assert.ok((await w.rest.get(`/guilds/${w.guildId}/webhooks`)).body.some((x) => x.id === h.id));
    const byId = await w.rest.get(`/webhooks/${h.id}`);
    assert.equal(byId.body.name, 'Listed');
    assert.equal(byId.body.user.id, w.app.bot_user_id);
    const byToken = await anon.get(`/webhooks/${h.id}/${h.token}`);
    assert.equal(byToken.status, 200);
    assert.equal(byToken.body.user, undefined);
    assert.equal((await anon.get(`/webhooks/${h.id}/wrong-token`)).status, 401);
    assert.equal((await anon.get(`/webhooks/${h.id}/wrong-token`)).body.code, 50027);
    assert.equal((await w.rest.get('/webhooks/1')).body.code, 10015);
  });

  test('PATCH renames and moves (WEBHOOK_UPDATE 51); DELETE removes (WEBHOOK_DELETE 52) with and without the token', async () => {
    const other = w.c.createChannel({ guildId: w.guildId, name: 'other', type: 0 });
    const h = (await create('Mover')).body;
    const up = await w.rest.patch(`/webhooks/${h.id}`, { name: 'Moved', channel_id: other.id });
    assert.equal(up.status, 200);
    assert.equal(up.body.name, 'Moved');
    assert.equal(up.body.channel_id, other.id);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=51`)).body.audit_log_entries[0].target_id, h.id);
    const viaToken = await anon.patch(`/webhooks/${h.id}/${h.token}`, { name: 'ByToken' });
    assert.equal(viaToken.body.name, 'ByToken');
    assert.equal((await anon.patch(`/webhooks/${h.id}/${h.token}`, { name: 'x', channel_id: w.channelId })).body.channel_id, other.id); // channel_id is ignored with a token
    assert.equal((await anon.delete(`/webhooks/${h.id}/${h.token}`)).status, 204);
    assert.equal((await w.rest.get(`/webhooks/${h.id}`)).body.code, 10015);
    const h2 = (await create('Gone')).body;
    assert.equal((await w.rest.delete(`/webhooks/${h2.id}`)).status, 204);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=52`)).body.audit_log_entries[0].target_id, h2.id);
  });

  test('MANAGE_WEBHOOKS is required; the name is 1-80 characters; threads and categories cannot own webhooks; 15 per channel', async () => {
    const w2 = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL'] });
    try {
      assert.equal((await w2.rest.post(`/channels/${w2.channelId}/webhooks`, { name: 'x' })).body.code, 50013);
      assert.equal((await w2.rest.get(`/guilds/${w2.guildId}/webhooks`)).body.code, 50013);
    } finally { await w2.fake.close(); }
    assert.equal((await w.rest.post(`/channels/${w.channelId}/webhooks`, { name: '' })).body.code, 50035);
    assert.equal((await w.rest.post(`/channels/${w.channelId}/webhooks`, {})).body.code, 50035);
    const cat = w.c.createChannel({ guildId: w.guildId, name: 'cat', type: 4 });
    assert.equal((await w.rest.post(`/channels/${cat.id}/webhooks`, { name: 'x' })).body.code, 50024);
    const w3 = await world({ rateLimits: false });
    try {
      for (let i = 0; i < 15; i++) assert.equal((await w3.rest.post(`/channels/${w3.channelId}/webhooks`, { name: `h${i}` })).status, 200);
      const r = await w3.rest.post(`/channels/${w3.channelId}/webhooks`, { name: 'sixteenth' });
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 30007);
    } finally { await w3.fake.close(); }
  });
});

describe('execute a webhook', () => {
  let w, gc, anon, hook;
  before(async () => {
    w = await world({ rateLimits: false });
    anon = client(w.fake, null);
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, INTENTS);
    hook = (await w.rest.post(`/channels/${w.channelId}/webhooks`, { name: 'Deploys' })).body;
  });
  after(async () => { gc.close(); await w.fake.close(); });
  const exec = (body, query = '') => anon.post(`/webhooks/${hook.id}/${hook.token}${query}`, body);

  test('POST /webhooks/:id/:token -> 204 and a MESSAGE_CREATE authored by the webhook (bot, webhook_id, no member)', async () => {
    const r = await exec({ content: 'deployed v1' });
    assert.equal(r.status, 204);
    const ev = await gc.waitForDispatch('MESSAGE_CREATE', (d) => d.content === 'deployed v1');
    assert.equal(ev.d.webhook_id, hook.id);
    assert.equal(ev.d.author.id, hook.id);
    assert.equal(ev.d.author.bot, true);
    assert.equal(ev.d.author.username, 'Deploys');
    assert.equal(ev.d.author.discriminator, '0000');
    assert.equal(ev.d.type, 0);
    assert.equal(ev.d.member, undefined);
  });

  test('?wait=true returns the message; username overrides the author name; embeds work', async () => {
    const r = await exec({ content: 'with embed', username: 'Release Bot', embeds: [{ title: 'v2', color: 5793266 }] }, '?wait=true');
    assert.equal(r.status, 200);
    assert.equal(r.body.author.username, 'Release Bot');
    assert.equal(r.body.webhook_id, hook.id);
    assert.equal(r.body.embeds[0].title, 'v2');
    assert.equal(r.body.channel_id, w.channelId);
    const got = await w.rest.get(`/channels/${w.channelId}/messages/${r.body.id}`);
    assert.equal(got.body.author.username, 'Release Bot');
  });

  test('empty body -> 400/50006; content over 2000 characters -> 400/50035; wrong token -> 401/50027; unknown id -> 404/10015', async () => {
    assert.equal((await exec({})).body.code, 50006);
    assert.equal((await exec({ content: 'x'.repeat(2001) })).body.code, 50035);
    assert.equal((await anon.post(`/webhooks/${hook.id}/nope`, { content: 'x' })).body.code, 50027);
    assert.equal((await anon.post('/webhooks/1/nope', { content: 'x' })).body.code, 10015);
  });

  test('webhook messages can be fetched, edited and deleted with the token; other messages cannot', async () => {
    const msg = (await exec({ content: 'v1' }, '?wait=true')).body;
    const base = `/webhooks/${hook.id}/${hook.token}/messages/${msg.id}`;
    assert.equal((await anon.get(base)).body.content, 'v1');
    const edited = await anon.patch(base, { content: 'v2' });
    assert.equal(edited.body.content, 'v2');
    assert.ok(edited.body.edited_timestamp);
    await gc.waitForDispatch('MESSAGE_UPDATE', (d) => d.id === msg.id && d.content === 'v2');
    assert.equal((await anon.delete(base)).status, 204);
    await gc.waitForDispatch('MESSAGE_DELETE', (d) => d.id === msg.id);
    assert.equal((await anon.get(base)).body.code, 10008);
    const foreign = w.c.postMessage({ channelId: w.channelId, authorId: w.alice.id, content: 'not mine' });
    assert.equal((await anon.get(`/webhooks/${hook.id}/${hook.token}/messages/${foreign.id}`)).body.code, 10008);
  });

  test('thread_id sends into a thread of the channel; a thread of another channel is refused', async () => {
    const thread = w.c.createChannel({ guildId: w.guildId, name: 't', type: 11, parentId: w.channelId });
    const r = await exec({ content: 'in thread' }, `?wait=true&thread_id=${thread.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.channel_id, thread.id);
    const other = w.c.createChannel({ guildId: w.guildId, name: 'o', type: 0 });
    const otherThread = w.c.createChannel({ guildId: w.guildId, name: 'ot', type: 11, parentId: other.id });
    assert.equal((await exec({ content: 'x' }, `?thread_id=${otherThread.id}`)).body.code, 10003);
  });

  test('multipart uploads attach files; deleting the webhook stops execution and keeps its messages', async () => {
    const b = '----w';
    const raw = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="payload_json"\r\n\r\n${JSON.stringify({ content: 'file', attachments: [{ id: 0, filename: 'a.txt' }] })}\r\n--${b}\r\nContent-Disposition: form-data; name="files[0]"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${b}--\r\n`);
    const r = await anon.call('POST', `/webhooks/${hook.id}/${hook.token}?wait=true`, undefined, { raw, headers: { 'Content-Type': `multipart/form-data; boundary=${b}` } });
    assert.equal(r.status, 200);
    assert.equal(r.body.attachments[0].filename, 'a.txt');
    const h2 = (await w.rest.post(`/channels/${w.channelId}/webhooks`, { name: 'Temp' })).body;
    const m = (await anon.post(`/webhooks/${h2.id}/${h2.token}?wait=true`, { content: 'bye' })).body;
    await w.rest.delete(`/webhooks/${h2.id}`);
    assert.equal((await anon.post(`/webhooks/${h2.id}/${h2.token}`, { content: 'x' })).body.code, 10015);
    assert.equal((await w.rest.get(`/channels/${w.channelId}/messages/${m.id}`)).status, 200);
  });
});

describe('webhooks share a URL shape with interaction follow-ups', () => {
  test('an interaction follow-up still works next to real webhooks', async () => {
    const w = await world({ rateLimits: false });
    try {
      const anon = client(w.fake, null);
      const hook = (await w.rest.post(`/channels/${w.channelId}/webhooks`, { name: 'Side' })).body;
      assert.equal((await anon.post(`/webhooks/${hook.id}/${hook.token}`, { content: 'hook' })).status, 204);
      w.c.registerCommand({ applicationId: w.app.id, command: { name: 'ping', description: 'Ping' } });
      const { id, token } = w.c.runCommand({ applicationId: w.app.id, userId: w.alice.id, guildId: w.guildId, channelId: w.channelId, name: 'ping' });
      const interaction = w.c.getInteraction({ interactionId: id });
      const tok = interaction.token ?? token;
      assert.equal((await anon.post(`/interactions/${id}/${tok}/callback`, { type: 5 })).status, 204);
      const follow = await anon.post(`/webhooks/${w.app.id}/${tok}`, { content: 'follow-up' });
      assert.equal(follow.status, 200);
      assert.equal(follow.body.content, 'follow-up');
    } finally { await w.fake.close(); }
  });
});
