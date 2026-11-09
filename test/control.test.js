// Control API contract (test-only, /_fake and fake.control). Every test observes the effect through Discord's own
// REST API or gateway, so the Discord-facing behaviour is what is checked.
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { world, start, client, GatewayClient } from './helpers.js';
import { Intents as I, AuditLogEvent as A, MessageType } from '../src/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('snapshot, restore and reset', () => {
  let w;
  before(async () => { w = await world(); });
  after(() => w.fake.close());

  test('restore rolls back changes made through REST', async () => {
    const { id } = w.c.snapshot();
    const ch = await w.rest.post(`/guilds/${w.guildId}/channels`, { name: 'temporary', type: 0 });
    assert.equal(ch.status, 201);
    await w.rest.put(`/guilds/${w.guildId}/bans/${w.bob.id}`, {});
    assert.equal((await w.rest.get(`/channels/${ch.body.id}`)).status, 200);
    w.c.restore({ id });
    const gone = await w.rest.get(`/channels/${ch.body.id}`);
    assert.equal(gone.status, 404);
    assert.equal(gone.body.code, 10003);
    const bob = await w.rest.get(`/guilds/${w.guildId}/members/${w.bob.id}`);
    assert.equal(bob.status, 200, 'bob is a member again');
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/bans/${w.bob.id}`)).status, 404);
  });

  test('reset empties the world: the old bot token no longer authenticates', async () => {
    assert.equal((await w.rest.get('/users/@me')).status, 200);
    w.c.reset();
    const r = await w.rest.get('/users/@me');
    assert.equal(r.status, 401);
    // A fresh world can be built afterwards.
    const owner = w.c.createUser({ username: 'again' });
    const app = w.c.createApplication({ name: 'Again', ownerId: owner.id });
    const me = await client(w.fake, `Bot ${app.token}`).get('/users/@me');
    assert.equal(me.status, 200);
    assert.equal(me.body.id, app.bot_user_id);
  });
});

// https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object-audit-log-events
describe('hostile staff (control.actAs)', () => {
  let w;
  let rogue;
  let gc;
  before(async () => {
    w = await world();
    rogue = w.c.createUser({ username: 'rogue' });
    const admin = w.c.createRole({ guildId: w.guildId, name: 'Admin', permissions: ['ADMINISTRATOR'] });
    w.c.addMember({ guildId: w.guildId, userId: rogue.id, roles: [admin.id] });
    // Just below the bot's role, above everyone else.
    w.c.setRolePosition({ guildId: w.guildId, roleId: admin.id, position: 50 });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, I.GUILDS | I.GUILD_MEMBERS | I.GUILD_MODERATION);
  });
  after(() => { gc?.close(); return w.fake.close(); });

  const auditBy = async (actionType) => {
    const r = await w.rest.get(`/guilds/${w.guildId}/audit-logs?user_id=${rogue.id}&action_type=${actionType}`);
    assert.equal(r.status, 200);
    return r.body.audit_log_entries;
  };

  test('deleting a channel and a role, changing permissions: audit entries by the actor and gateway events', async () => {
    const ch = w.c.createChannel({ guildId: w.guildId, name: 'announcements' });
    w.c.deleteChannel({ channelId: ch.id, actorId: rogue.id, reason: 'oops' });
    await gc.waitForDispatch('CHANNEL_DELETE', (d) => d.id === ch.id);
    const [chEntry] = await auditBy(A.CHANNEL_DELETE);
    assert.equal(chEntry.target_id, ch.id);
    assert.equal(chEntry.reason, 'oops');
    const live = await gc.waitForDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', (d) => d.action_type === A.CHANNEL_DELETE);
    assert.equal(live.d.user_id, rogue.id);

    w.c.deleteRole({ guildId: w.guildId, roleId: w.memberRole.id, actorId: rogue.id });
    await gc.waitForDispatch('GUILD_ROLE_DELETE', (d) => d.role_id === w.memberRole.id);
    assert.equal((await auditBy(A.ROLE_DELETE))[0].target_id, w.memberRole.id);

    w.c.editRolePermissions({ actorId: rogue.id, guildId: w.guildId, roleId: w.modRole.id, permissions: ['ADMINISTRATOR'] });
    const upd = await gc.waitForDispatch('GUILD_ROLE_UPDATE', (d) => d.role.id === w.modRole.id);
    assert.equal(upd.d.role.permissions, '8');
    const roleEntry = (await auditBy(A.ROLE_UPDATE))[0];
    assert.ok(roleEntry.changes.some((c) => c.key === 'permissions' && c.new_value === '8'));
  });

  test('mass ban and mass kick', async () => {
    const victims = ['v1', 'v2', 'v3'].map((username) => w.c.createUser({ username }));
    for (const v of victims) w.c.addMember({ guildId: w.guildId, userId: v.id });
    w.c.massBan({ actorId: rogue.id, guildId: w.guildId, userIds: [w.alice.id, w.bob.id], reason: 'purge' });
    for (const u of [w.alice, w.bob]) await gc.waitForDispatch('GUILD_BAN_ADD', (d) => d.user.id === u.id);
    const bans = await w.rest.get(`/guilds/${w.guildId}/bans`);
    assert.deepEqual(bans.body.map((b) => b.user.id).sort(), [w.alice.id, w.bob.id].sort());
    const banEntries = await auditBy(A.MEMBER_BAN_ADD);
    assert.deepEqual(banEntries.map((e) => e.target_id).sort(), [w.alice.id, w.bob.id].sort());

    const results = w.c.massKick({ actorId: rogue.id, guildId: w.guildId, userIds: victims.map((v) => v.id) });
    assert.deepEqual(results.map((r) => r.status), [204, 204, 204]);
    for (const v of victims) await gc.waitForDispatch('GUILD_MEMBER_REMOVE', (d) => d.user.id === v.id);
    assert.equal((await auditBy(A.MEMBER_KICK)).length, 3);
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/members/${victims[0].id}`)).status, 404);
  });

  // https://discord.com/developers/docs/topics/permissions#permission-hierarchy
  test('actAs enforces the actor\'s permissions (403/50013) and changes nothing', async () => {
    const plain = w.c.createUser({ username: 'plain' });
    w.c.addMember({ guildId: w.guildId, userId: plain.id });
    const r = w.c.actAs({ userId: plain.id, method: 'DELETE', path: `/channels/${w.channelId}` });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 50013);
    assert.equal((await w.rest.get(`/channels/${w.channelId}`)).status, 200);
    assert.throws(() => w.c.deleteChannel({ channelId: w.channelId, actorId: plain.id }), /403/);
  });
});

describe('join with an invite', () => {
  let w;
  let gc;
  before(async () => {
    w = await world();
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, I.GUILDS | I.GUILD_MEMBERS | I.GUILD_MESSAGES | I.MESSAGE_CONTENT);
  });
  after(() => { gc?.close(); return w.fake.close(); });

  // https://discord.com/developers/docs/resources/invite#invite-metadata-object – uses
  // https://discord.com/developers/docs/resources/message#message-object-message-types – USER_JOIN 7
  test('uses are counted and USER_JOIN is posted in the system channel', async () => {
    const inv = await w.rest.post(`/channels/${w.channelId}/invites`, { max_uses: 1, max_age: 0 });
    assert.equal(inv.status, 200);
    const carol = w.c.createUser({ username: 'carol' });
    w.c.join({ guildId: w.guildId, userId: carol.id, inviteCode: inv.body.code });
    const add = await gc.waitForDispatch('GUILD_MEMBER_ADD', (d) => d.user.id === carol.id);
    assert.equal(add.d.guild_id, w.guildId);
    const join = await gc.waitForDispatch('MESSAGE_CREATE', (d) => d.type === MessageType.USER_JOIN);
    assert.equal(join.d.author.id, carol.id);
    assert.equal(join.d.channel_id, w.channelId);
    const msgs = await w.rest.get(`/channels/${w.channelId}/messages`);
    assert.ok(msgs.body.some((m) => m.type === 7 && m.author.id === carol.id));
    const invites = await w.rest.get(`/guilds/${w.guildId}/invites`);
    assert.equal(invites.body.find((i) => i.code === inv.body.code).uses, 1);
    // max_uses reached
    const dave = w.c.createUser({ username: 'dave' });
    assert.throws(() => w.c.join({ guildId: w.guildId, userId: dave.id, inviteCode: inv.body.code }));
    assert.equal((await w.rest.get(`/guilds/${w.guildId}/members/${dave.id}`)).status, 404);
  });
});

describe('HTTP control mirror', () => {
  let w;
  const ctl = async (method, pathName, body) => {
    const res = await fetch(`${w.fake.controlUrl}/${pathName}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = text;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, contentType: res.headers.get('content-type') };
  };
  before(async () => { w = await world(); });
  after(() => w.fake.close());

  test('POST /_fake/<method> drives the world; changes are visible through REST', async () => {
    const u = await ctl('POST', 'createUser', { username: 'http_user' });
    assert.equal(u.status, 200);
    const add = await ctl('POST', 'addMember', { guildId: w.guildId, userId: u.body.id });
    assert.equal(add.status, 200);
    const msg = await ctl('POST', 'postMessage', { channelId: w.channelId, authorId: u.body.id, content: 'via http' });
    assert.equal(msg.status, 200);
    const r = await w.rest.get(`/channels/${w.channelId}/messages/${msg.body.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.content, 'via http');
    assert.equal(r.body.author.id, u.body.id);
    const bad = await ctl('POST', 'noSuchMethod', {});
    assert.equal(bad.status, 404);
    const err = await ctl('POST', 'addMember', { guildId: w.guildId, userId: '1' });
    assert.equal(err.status, 400);
    assert.match(err.body.error, /unknown user/);
  });

  test('GET /_fake/state, /_fake/log, /_fake/gateway-log and /_fake/log.txt', async () => {
    const g = await w.rest.get(`/guilds/${w.guildId}`);
    assert.equal(g.status, 200);
    assert.equal(g.body.name, 'Guild A');
    const state = await ctl('GET', 'state');
    assert.equal(state.status, 200);
    assert.equal(state.body.guilds[w.guildId].name, 'Guild A');
    const log = await ctl('GET', `log?path=/guilds/${w.guildId}`);
    const entry = log.body.find((e) => e.method === 'GET' && e.path === `/api/v10/guilds/${w.guildId}`);
    assert.ok(entry, 'request logged');
    assert.equal(entry.route, 'GET /guilds/:guild_id');
    assert.equal(entry.status, 200);
    assert.equal(entry.actor.application_id, w.app.id);

    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    const ready = await gc.ready(w.app.token, I.GUILDS);
    gc.close();
    const frames = await ctl('GET', `gateway-log?session_id=${ready.session_id}`);
    assert.ok(frames.body.some((f) => f.direction === 'out' && f.t === 'READY'));
    assert.ok(frames.body.some((f) => f.direction === 'in' && f.op === 2), 'IDENTIFY logged');
    const txt = await ctl('GET', 'log.txt');
    assert.match(txt.contentType, /text\/plain/);
    assert.match(txt.body, new RegExp(`HTTP #\\d+ GET /api/v10/guilds/${w.guildId} -> 200`));
    assert.match(txt.body, /WS #\d+ out .* READY s=1/);
  });
});

describe('determinism', () => {
  // Same seed + manual clock + same script => identical ids, tokens and session ids.
  async function script() {
    const fake = await start({ seed: 42 });
    try {
      const c = fake.control;
      const owner = c.createUser({ username: 'o' });
      const app = c.createApplication({ name: 'D', ownerId: owner.id });
      const g = c.createGuild({ name: 'G', ownerId: owner.id });
      c.installBot({ applicationId: app.id, guildId: g.id, permissions: ['ADMINISTRATOR'] });
      const rest = client(fake, `Bot ${app.token}`);
      const ch = await rest.post(`/guilds/${g.id}/channels`, { name: 'det' });
      const msg = await rest.post(`/channels/${ch.body.id}/messages`, { content: 'same' });
      c.registerCommand({ applicationId: app.id, command: { name: 'd', description: 'd' } });
      const gc = await GatewayClient.connect(fake.gatewayUrl);
      const ready = await gc.ready(app.token, I.GUILDS);
      const it = c.runCommand({ applicationId: app.id, userId: owner.id, guildId: g.id, name: 'd' });
      const ic = await gc.waitForDispatch('INTERACTION_CREATE');
      gc.close();
      return {
        ids: [owner.id, app.id, g.id, ch.body.id, msg.body.id, it.id], token: app.token, secret: app.client_secret,
        session: ready.session_id, interactionToken: ic.d.token, message: msg.body,
      };
    } finally {
      await fake.close();
    }
  }

  test('two servers with the same seed and script produce identical ids and tokens', async () => {
    const a = await script();
    const b = await script();
    assert.match(a.ids[3], /^\d{17,20}$/);
    assert.match(a.session, /^[0-9a-f]{32}$/);
    assert.deepEqual(a, b);
  });
});

// The CLI: bin/discord-test-server.js --demo --port 0 --json prints one JSON line.
describe('CLI demo world', () => {
  let proc;
  let info;
  before(async () => {
    proc = spawn(process.execPath, [path.join(ROOT, 'bin/discord-test-server.js'), '--demo', '--port', '0', '--json'], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    info = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`no JSON line from the CLI: ${buf}`)), 3000);
      proc.stdout.on('data', (d) => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl >= 0) { clearTimeout(timer); try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); } }
      });
      proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`CLI exited with ${code}`)); });
    });
  });
  after(() => { proc?.kill('SIGTERM'); });

  test('prints working URLs; the demo bot sees two guilds', async () => {
    assert.match(info.restUrl, /^http:\/\/127\.0\.0\.1:\d+\/api\/v10$/);
    assert.match(info.gatewayUrl, /^ws:\/\/127\.0\.0\.1:\d+\/gateway$/);
    const bot = info.demo.applications.modbot;
    const r = await fetch(`${info.restUrl}/users/@me/guilds`, { headers: { Authorization: `Bot ${bot.token}` } });
    assert.equal(r.status, 200);
    const guilds = await r.json();
    assert.deepEqual(guilds.map((g) => g.name).sort(), ['Demo Server', 'Second Server']);
    const gw = await fetch(`${info.restUrl}/gateway/bot`, { headers: { Authorization: `Bot ${bot.token}` } });
    assert.equal((await gw.json()).url, info.gatewayUrl);
    const state = await (await fetch(`${info.controlUrl}/now`)).json();
    assert.ok(state.now > 0);
  });

  test('the demo has an owner, a moderator, members, channels, a quarantine role and a SKU', async () => {
    const d = info.demo;
    const auth = { Authorization: `Bot ${d.applications.modbot.token}` };
    const get = async (p) => { const r = await fetch(`${info.restUrl}${p}`, { headers: auth }); return { status: r.status, body: await r.json() }; };
    assert.equal(d.guilds.length, 2);
    for (const g of d.guilds) {
      const guild = await get(`/guilds/${g.id}`);
      assert.equal(guild.status, 200);
      assert.equal(guild.body.owner_id, d.users.owner.id);
      const roles = (await get(`/guilds/${g.id}/roles`)).body;
      assert.ok(roles.some((r) => r.id === g.roles.quarantine && r.name === 'Quarantine'));
      assert.ok(roles.some((r) => r.id === g.roles.moderator && r.name === 'Moderator'));
      const channels = (await get(`/guilds/${g.id}/channels`)).body.map((c) => c.name);
      for (const name of ['general', 'rules', 'mod-log', 'quarantine']) assert.ok(channels.includes(name), name);
      const members = (await get(`/guilds/${g.id}/members?limit=100`)).body;
      const mod = members.find((m) => m.user.id === d.users.moderator.id);
      assert.ok(mod.roles.includes(g.roles.moderator));
      for (const u of ['owner', 'alice', 'bob']) assert.ok(members.some((m) => m.user.id === d.users[u].id), u);
    }
    const skus = (await get(`/applications/${d.applications.modbot.id}/skus`)).body;
    assert.deepEqual(skus.map((s) => s.id), [d.sku.id]);
    const cmds = (await get(`/applications/${d.applications.modbot.id}/commands`)).body.map((c) => c.name).sort();
    assert.deepEqual(cmds, ['appeal', 'warn']);
  });
});
