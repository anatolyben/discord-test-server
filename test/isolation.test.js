// Isolation between guilds and applications.
// Unknown resources answer 10xxx, resources the caller cannot access answer 50001 Missing Access and another
// application's resources answer 20012 – https://discord.com/developers/docs/topics/opcodes-and-status-codes#json
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { world, client, GatewayClient } from './helpers.js';
import { Intents as I, SkuType } from '../src/constants.js';

const INTENTS = I.GUILDS | I.GUILD_MESSAGES | I.DIRECT_MESSAGES | I.GUILD_MEMBERS | I.GUILD_MODERATION | I.MESSAGE_CONTENT;

describe('two guilds, two applications', () => {
  let w;
  let appB;
  let restB;
  let ownerB;
  let guildB;
  let gcA;
  let gcB;
  let anon;
  before(async () => {
    w = await world();
    anon = client(w.fake);
    ownerB = w.c.createUser({ username: 'ownerB' });
    appB = w.c.createApplication({ name: 'AppB', ownerId: ownerB.id, privilegedIntents: { guildMembers: true, messageContent: true } });
    guildB = w.c.createGuild({ name: 'Guild B', ownerId: ownerB.id });
    w.c.addMember({ guildId: guildB.id, userId: w.alice.id });
    w.c.installBot({ applicationId: appB.id, guildId: guildB.id, permissions: ['ADMINISTRATOR'] });
    restB = client(w.fake, `Bot ${appB.token}`);
    gcA = await GatewayClient.connect(w.fake.gatewayUrl);
    gcB = await GatewayClient.connect(w.fake.gatewayUrl);
    const readyA = await gcA.ready(w.app.token, INTENTS);
    const readyB = await gcB.ready(appB.token, INTENTS);
    assert.deepEqual(readyA.guilds.map((g) => g.id), [w.guildId]);
    assert.deepEqual(readyB.guilds.map((g) => g.id), [guildB.id]);
  });
  after(() => { gcA?.close(); gcB?.close(); return w.fake.close(); });

  test("app B's token gets 50001 on everything in app A's guild, 10004 on unknown guilds", async () => {
    for (const [method, path, body] of [
      ['get', `/guilds/${w.guildId}`],
      ['get', `/guilds/${w.guildId}/channels`],
      ['get', `/guilds/${w.guildId}/members/${w.alice.id}`],
      ['get', `/guilds/${w.guildId}/roles`],
      ['get', `/guilds/${w.guildId}/audit-logs`],
      ['put', `/guilds/${w.guildId}/bans/${w.bob.id}`, {}],
      ['delete', `/guilds/${w.guildId}/members/${w.bob.id}`],
      ['get', `/channels/${w.channelId}`],
      ['get', `/channels/${w.channelId}/messages`],
      ['post', `/channels/${w.channelId}/messages`, { content: 'intruder' }],
    ]) {
      const r = await restB[method](path, body);
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(r.body.code, 50001, `${method} ${path}`);
    }
    const unknown = await restB.get('/guilds/123456789012345678');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 10004);
    // Nothing happened in guild A.
    assert.ok((await w.rest.get(`/guilds/${w.guildId}/members/${w.bob.id}`)).status === 200);
    assert.ok(!(await w.rest.get(`/channels/${w.channelId}/messages`)).body.some((m) => m.content === 'intruder'));
  });

  // https://discord.com/developers/docs/resources/user#get-current-user-guilds
  test('each bot only lists its own guilds', async () => {
    assert.deepEqual((await w.rest.get('/users/@me/guilds')).body.map((g) => g.id), [w.guildId]);
    assert.deepEqual((await restB.get('/users/@me/guilds')).body.map((g) => g.id), [guildB.id]);
  });

  // https://discord.com/developers/docs/events/gateway#receiving-events – a bot only receives events for guilds it is in
  test('no dispatches from guilds the bot is not in', async () => {
    w.c.postMessage({ channelId: w.channelId, authorId: w.alice.id, content: 'in A' });
    w.c.postMessage({ channelId: guildB.system_channel_id, authorId: w.alice.id, content: 'in B' });
    const a = await gcA.waitForDispatch('MESSAGE_CREATE', (d) => d.content === 'in A');
    const b = await gcB.waitForDispatch('MESSAGE_CREATE', (d) => d.content === 'in B');
    assert.equal(a.d.guild_id, w.guildId);
    assert.equal(b.d.guild_id, guildB.id);
    const carol = w.c.createUser({ username: 'carol' });
    w.c.join({ guildId: w.guildId, userId: carol.id });
    await gcA.waitForDispatch('GUILD_MEMBER_ADD', (d) => d.user.id === carol.id);
    await w.rest.put(`/guilds/${w.guildId}/bans/${carol.id}`, {});
    await gcA.waitForDispatch('GUILD_BAN_ADD', (d) => d.user.id === carol.id);
    await gcA.waitForDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', (d) => d.target_id === carol.id);
    await new Promise((r) => setTimeout(r, 100));
    const leaked = gcB.dispatches().filter((f) => f.d?.guild_id === w.guildId || f.d?.id === w.guildId || f.d?.content === 'in A');
    assert.deepEqual(leaked, []);
    assert.ok(!gcA.dispatches().some((f) => f.d?.guild_id === guildB.id || f.d?.content === 'in B'));
  });

  // https://discord.com/developers/docs/interactions/application-commands
  test('commands are scoped per application', async () => {
    const created = await w.rest.post(`/applications/${w.app.id}/commands`, { name: 'secret', description: 'A only' });
    assert.equal(created.status, 201);
    const peek = await restB.get(`/applications/${w.app.id}/commands`);
    assert.equal(peek.status, 403);
    assert.equal(peek.body.code, 20012);
    const peekOne = await restB.get(`/applications/${w.app.id}/commands/${created.body.id}`);
    assert.equal(peekOne.status, 403);
    assert.equal(peekOne.body.code, 20012);
    const del = await restB.delete(`/applications/${w.app.id}/commands/${created.body.id}`);
    assert.equal(del.body.code, 20012);
    // Through its own id, B cannot reach A's command either.
    const viaOwn = await restB.get(`/applications/${appB.id}/commands/${created.body.id}`);
    assert.equal(viaOwn.status, 404);
    assert.equal(viaOwn.body.code, 10063);
    assert.deepEqual((await restB.get(`/applications/${appB.id}/commands`)).body, []);
    // Guild commands need the app in that guild.
    const guildCmd = await restB.post(`/applications/${appB.id}/guilds/${w.guildId}/commands`, { name: 'x', description: 'x' });
    assert.equal(guildCmd.status, 403);
    assert.equal(guildCmd.body.code, 50001);
    assert.equal((await w.rest.get(`/applications/${w.app.id}/commands/${created.body.id}`)).status, 200);
  });

  // https://discord.com/developers/docs/resources/entitlement, https://discord.com/developers/docs/resources/sku
  test('SKUs and entitlements are scoped per application', async () => {
    const sku = w.c.createSku({ applicationId: w.app.id, name: 'A Premium', type: SkuType.SUBSCRIPTION });
    const ent = (await w.rest.post(`/applications/${w.app.id}/entitlements`, { sku_id: sku.id, owner_id: w.alice.id, owner_type: 2 })).body;
    await gcA.waitForDispatch('ENTITLEMENT_CREATE', (d) => d.id === ent.id);
    for (const path of [`/applications/${w.app.id}/skus`, `/applications/${w.app.id}/entitlements`, `/applications/${w.app.id}/entitlements/${ent.id}`]) {
      const r = await restB.get(path);
      assert.equal(r.status, 403, path);
      assert.equal(r.body.code, 20012, path);
    }
    const viaOwn = await restB.get(`/applications/${appB.id}/entitlements/${ent.id}`);
    assert.equal(viaOwn.status, 404);
    assert.equal(viaOwn.body.code, 10029);
    assert.deepEqual((await restB.get(`/applications/${appB.id}/skus`)).body, []);
    assert.deepEqual((await restB.get(`/applications/${appB.id}/entitlements`)).body, []);
    const foreignSku = await restB.post(`/applications/${appB.id}/entitlements`, { sku_id: sku.id, owner_id: w.alice.id, owner_type: 2 });
    assert.equal(foreignSku.status, 404);
    assert.equal(foreignSku.body.code, 10027);
    assert.equal(gcB.dispatches('ENTITLEMENT_CREATE').length, 0);
  });

  // https://discord.com/developers/docs/interactions/receiving-and-responding
  test('interactions go to their application only; a webhook token is bound to its application id (10015)', async () => {
    w.c.registerCommand({ applicationId: w.app.id, command: { name: 'onlya', description: 'A' } });
    w.c.registerCommand({ applicationId: appB.id, command: { name: 'onlyb', description: 'B' } });
    const ra = w.c.runCommand({ applicationId: w.app.id, userId: w.alice.id, guildId: w.guildId, name: 'onlya' });
    const rb = w.c.runCommand({ applicationId: appB.id, userId: w.alice.id, guildId: guildB.id, name: 'onlyb' });
    const da = (await gcA.waitForDispatch('INTERACTION_CREATE', (d) => d.id === ra.id)).d;
    await gcB.waitForDispatch('INTERACTION_CREATE', (d) => d.id === rb.id);
    assert.equal(gcA.dispatches('INTERACTION_CREATE').filter((f) => f.d.id === rb.id).length, 0);
    assert.equal(gcB.dispatches('INTERACTION_CREATE').filter((f) => f.d.id === ra.id).length, 0);
    assert.throws(() => w.c.runCommand({ applicationId: appB.id, userId: w.alice.id, guildId: guildB.id, name: 'onlya' }));

    assert.equal((await anon.post(`/interactions/${da.id}/${da.token}/callback`, { type: 4, data: { content: 'A answers' } })).status, 204);
    for (const [method, path, body] of [
      ['post', `/webhooks/${appB.id}/${da.token}`, { content: 'hijack' }],
      ['get', `/webhooks/${appB.id}/${da.token}/messages/@original`],
      ['patch', `/webhooks/${appB.id}/${da.token}/messages/@original`, { content: 'hijack' }],
      ['delete', `/webhooks/${appB.id}/${da.token}/messages/@original`],
    ]) {
      const r = await anon[method](path, body);
      assert.equal(r.status, 404, `${method} ${path}`);
      assert.equal(r.body.code, 10015, `${method} ${path}`);
    }
    const orig = await anon.get(`/webhooks/${w.app.id}/${da.token}/messages/@original`);
    assert.equal(orig.body.content, 'A answers');
    // Callback with the right id but a token from the other app's interaction.
    const db = gcB.dispatches('INTERACTION_CREATE').find((f) => f.d.id === rb.id).d;
    const cross = await anon.post(`/interactions/${da.id}/${db.token}/callback`, { type: 4, data: { content: 'x' } });
    assert.equal(cross.status, 404);
    assert.equal(cross.body.code, 10062);
  });

  test("a bot cannot read another bot's DM channel", async () => {
    const dm = (await w.rest.post('/users/@me/channels', { recipient_id: w.alice.id })).body;
    w.c.postMessage({ channelId: dm.id, authorId: w.alice.id, content: 'hi A' });
    const r = await restB.get(`/channels/${dm.id}/messages`);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 50001);
    assert.equal((await gcB.expectNone('MESSAGE_CREATE', (d) => d.channel_id === dm.id)).length, 0);
    await gcA.waitForDispatch('MESSAGE_CREATE', (d) => d.channel_id === dm.id);
  });
});
