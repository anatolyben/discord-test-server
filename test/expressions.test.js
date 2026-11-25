// Emoji and stickers – https://discord.com/developers/docs/resources/emoji, /resources/sticker
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, GatewayClient } from './helpers.js';
import { Intents as I } from '../src/constants.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const INTENTS = I.GUILDS | I.GUILD_EXPRESSIONS | I.GUILD_MESSAGES | I.GUILD_MESSAGE_REACTIONS | I.GUILD_MODERATION;

function multipart(fields, file) {
  const b = '----dts';
  let out = '';
  for (const [k, v] of Object.entries(fields)) out += `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  out += `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n${file.data}\r\n--${b}--\r\n`;
  return { raw: Buffer.from(out, 'latin1'), headers: { 'Content-Type': `multipart/form-data; boundary=${b}` } };
}

describe('guild emoji', () => {
  let w, gc;
  before(async () => {
    w = await world({ rateLimits: false });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, INTENTS);
  });
  after(async () => { gc.close(); await w.fake.close(); });

  test('POST /guilds/:id/emojis -> the emoji (with user), GUILD_EMOJIS_UPDATE, EMOJI_CREATE (60) in the audit log', async () => {
    const r = await w.rest.post(`/guilds/${w.guildId}/emojis`, { name: 'party', image: PNG, roles: [] }, { headers: { 'X-Audit-Log-Reason': 'fun' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.name, 'party');
    assert.equal(r.body.animated, false);
    assert.equal(r.body.managed, false);
    assert.equal(r.body.available, true);
    assert.equal(r.body.require_colons, true);
    assert.deepEqual(r.body.roles, []);
    assert.equal(r.body.user.id, w.app.bot_user_id);
    const ev = await gc.waitForDispatch('GUILD_EMOJIS_UPDATE', (d) => d.emojis.some((e) => e.id === r.body.id));
    assert.equal(ev.d.guild_id, w.guildId);
    const log = (await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=60`)).body.audit_log_entries[0];
    assert.equal(log.target_id, r.body.id);
    assert.equal(log.reason, 'fun');
    assert.deepEqual(log.changes.find((c) => c.key === 'name'), { key: 'name', new_value: 'party' });
  });

  test('a GIF is animated; list, get, and the guild object include the emojis', async () => {
    const gif = await w.rest.post(`/guilds/${w.guildId}/emojis`, { name: 'wave', image: PNG.replace('image/png', 'image/gif') });
    assert.equal(gif.body.animated, true);
    const list = await w.rest.get(`/guilds/${w.guildId}/emojis`);
    assert.ok(list.body.some((e) => e.id === gif.body.id));
    const one = await w.rest.get(`/guilds/${w.guildId}/emojis/${gif.body.id}`);
    assert.equal(one.body.name, 'wave');
    const g = await w.rest.get(`/guilds/${w.guildId}`);
    assert.ok(g.body.emojis.some((e) => e.id === gif.body.id));
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/emojis/1`)).body.code, 10014);
  });

  test('PATCH renames (EMOJI_UPDATE 61) and DELETE removes (EMOJI_DELETE 62); both fire GUILD_EMOJIS_UPDATE', async () => {
    const e = (await w.rest.post(`/guilds/${w.guildId}/emojis`, { name: 'temp', image: PNG })).body;
    const up = await w.rest.patch(`/guilds/${w.guildId}/emojis/${e.id}`, { name: 'temp2' });
    assert.equal(up.status, 200);
    assert.equal(up.body.name, 'temp2');
    const upd = (await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=61`)).body.audit_log_entries[0];
    assert.deepEqual(upd.changes, [{ key: 'name', old_value: 'temp', new_value: 'temp2' }]);
    assert.equal((await w.rest.delete(`/guilds/${w.guildId}/emojis/${e.id}`)).status, 204);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=62`)).body.audit_log_entries[0].target_id, e.id);
    await gc.waitFor(() => gc.dispatches('GUILD_EMOJIS_UPDATE').find((f) => !f.d.emojis.some((x) => x.id === e.id) && gc.dispatches('GUILD_EMOJIS_UPDATE').length > 2));
    assert.equal((await w.rest.delete(`/guilds/${w.guildId}/emojis/${e.id}`)).body.code, 10014);
  });

  test('validation: name 2-32 word characters, a real image data URI', async () => {
    assert.equal((await w.rest.post(`/guilds/${w.guildId}/emojis`, { name: 'x', image: PNG })).body.code, 50035);
    assert.equal((await w.rest.post(`/guilds/${w.guildId}/emojis`, { name: 'ok_name', image: 'not-an-image' })).body.code, 50035);
    assert.equal((await w.rest.post(`/guilds/${w.guildId}/emojis`, { name: 'ok_name' })).body.code, 50035);
  });

  test('a custom emoji can be used as a reaction (name:id)', async () => {
    const e = (await w.rest.post(`/guilds/${w.guildId}/emojis`, { name: 'custom', image: PNG })).body;
    const m = w.c.postMessage({ channelId: w.channelId, authorId: w.alice.id, content: 'x' });
    const r = await w.rest.put(`/channels/${w.channelId}/messages/${m.id}/reactions/${encodeURIComponent(`custom:${e.id}`)}/@me`);
    assert.equal(r.status, 204);
    const got = (await w.rest.get(`/channels/${w.channelId}/messages/${m.id}`)).body;
    assert.deepEqual(got.reactions[0].emoji, { id: e.id, name: 'custom' });
    const ev = await gc.waitForDispatch('MESSAGE_REACTION_ADD', (d) => d.message_id === m.id);
    assert.deepEqual(ev.d.emoji, { id: e.id, name: 'custom' });
  });

  test('the 51st static emoji -> 400/30008 at boost level 0', async () => {
    const w2 = await world({ rateLimits: false });
    try {
      for (let i = 0; i < 50; i++) assert.equal((await w2.rest.post(`/guilds/${w2.guildId}/emojis`, { name: `e${String(i).padStart(2, '0')}`, image: PNG })).status, 201);
      const r = await w2.rest.post(`/guilds/${w2.guildId}/emojis`, { name: 'one_more', image: PNG });
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 30008);
    } finally { await w2.fake.close(); }
  });

  test('CREATE_GUILD_EXPRESSIONS creates; editing or deleting someone else\'s emoji needs MANAGE_GUILD_EXPRESSIONS', async () => {
    const w2 = await world({ rateLimits: false, botPermissions: ['CREATE_GUILD_EXPRESSIONS'] });
    try {
      const mine = (await w2.rest.post(`/guilds/${w2.guildId}/emojis`, { name: 'mine', image: PNG })).body;
      assert.equal((await w2.rest.patch(`/guilds/${w2.guildId}/emojis/${mine.id}`, { name: 'mine2' })).status, 200);
      const theirs = w2.c.createEmoji({ guildId: w2.guildId, name: 'theirs', image: PNG, userId: w2.owner.id });
      assert.equal((await w2.rest.patch(`/guilds/${w2.guildId}/emojis/${theirs.id}`, { name: 'nope' })).body.code, 50013);
      assert.equal((await w2.rest.delete(`/guilds/${w2.guildId}/emojis/${theirs.id}`)).body.code, 50013);
    } finally { await w2.fake.close(); }
    const w3 = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL'] });
    try {
      assert.equal((await w3.rest.post(`/guilds/${w3.guildId}/emojis`, { name: 'denied', image: PNG })).body.code, 50013);
    } finally { await w3.fake.close(); }
  });
});

describe('guild stickers', () => {
  let w, gc;
  before(async () => {
    w = await world({ rateLimits: false });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, INTENTS);
  });
  after(async () => { gc.close(); await w.fake.close(); });

  const upload = (w, name = 'wink', extra = {}) => {
    const mp = multipart({ name, description: 'a wink', tags: 'wink,face', ...extra }, { name: 'wink.png', type: 'image/png', data: 'PNGDATA' });
    return w.rest.call('POST', `/guilds/${w.guildId}/stickers`, undefined, { raw: mp.raw, headers: mp.headers });
  };

  test('POST /guilds/:id/stickers (multipart) -> the sticker, GUILD_STICKERS_UPDATE, STICKER_CREATE (90)', async () => {
    const r = await upload(w);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.name, 'wink');
    assert.equal(r.body.type, 2);
    assert.equal(r.body.format_type, 1);
    assert.equal(r.body.guild_id, w.guildId);
    assert.equal(r.body.tags, 'wink,face');
    assert.equal(r.body.available, true);
    assert.equal(r.body.user.id, w.app.bot_user_id);
    const ev = await gc.waitForDispatch('GUILD_STICKERS_UPDATE', (d) => d.stickers.some((s) => s.id === r.body.id));
    assert.equal(ev.d.guild_id, w.guildId);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=90`)).body.audit_log_entries[0].target_id, r.body.id);
  });

  test('list, get (guild and global), patch (STICKER_UPDATE 91) and delete (STICKER_DELETE 92)', async () => {
    const s = (await upload(w, 'hello')).body;
    assert.ok((await w.rest.get(`/guilds/${w.guildId}/stickers`)).body.some((x) => x.id === s.id));
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/stickers/${s.id}`)).body.name, 'hello');
    assert.equal((await w.rest.get(`/stickers/${s.id}`)).body.id, s.id);
    assert.ok((await w.rest.get(`/guilds/${w.guildId}`)).body.stickers.some((x) => x.id === s.id));
    const up = await w.rest.patch(`/guilds/${w.guildId}/stickers/${s.id}`, { name: 'hello2', description: 'changed' });
    assert.equal(up.body.name, 'hello2');
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=91`)).body.audit_log_entries[0].target_id, s.id);
    assert.equal((await w.rest.delete(`/guilds/${w.guildId}/stickers/${s.id}`)).status, 204);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=92`)).body.audit_log_entries[0].target_id, s.id);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/stickers/${s.id}`)).body.code, 10060);
  });

  test('validation: name 2-30 characters, a file is required, 5 free slots -> 400/30039', async () => {
    assert.equal((await upload(w, 'x')).body.code, 50035);
    const noFile = await w.rest.post(`/guilds/${w.guildId}/stickers`, { name: 'nofile' });
    assert.equal(noFile.status, 400);
    const w2 = await world({ rateLimits: false });
    try {
      for (let i = 0; i < 5; i++) assert.equal((await upload(w2, `sticker${i}`)).status, 201);
      const r = await upload(w2, 'sixth');
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 30039);
    } finally { await w2.fake.close(); }
  });

  test('a sticker can be sent with sticker_ids; unknown ids -> 400/50081', async () => {
    const s = (await upload(w, 'sendme')).body;
    const sent = await w.rest.post(`/channels/${w.channelId}/messages`, { sticker_ids: [s.id] });
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body.sticker_items, [{ id: s.id, name: 'sendme', format_type: 1 }]);
    const bad = await w.rest.post(`/channels/${w.channelId}/messages`, { sticker_ids: ['123456789012345678'] });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 50081);
  });

  test('GET /sticker-packs -> { sticker_packs: [] } (the fake ships no standard packs); permissions are enforced', async () => {
    assert.deepEqual((await w.rest.get('/sticker-packs')).body, { sticker_packs: [] });
    const w2 = await world({ rateLimits: false, botPermissions: ['VIEW_CHANNEL'] });
    try {
      assert.equal((await upload(w2)).body.code, 50013);
    } finally { await w2.fake.close(); }
  });
});
