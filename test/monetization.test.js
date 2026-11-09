// Monetization contract – https://discord.com/developers/docs/resources/sku,
// https://discord.com/developers/docs/resources/entitlement, https://discord.com/developers/docs/resources/subscription
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { world, client, GatewayClient, DAY } from './helpers.js';
import { Intents as I, SkuType, EntitlementType as ET } from '../src/constants.js';

describe('SKUs and entitlements', () => {
  let w;
  let appB;
  let restB;
  let premium;
  let coins;
  let lifetime;
  let skuB;
  let gcA;
  let gcB;
  const base = () => `/applications/${w.app.id}`;
  before(async () => {
    w = await world();
    appB = w.c.createApplication({ name: 'AppB', ownerId: w.owner.id });
    w.c.installBot({ applicationId: appB.id, guildId: w.guildId, permissions: ['VIEW_CHANNEL'] });
    restB = client(w.fake, `Bot ${appB.token}`);
    premium = w.c.createSku({ applicationId: w.app.id, name: 'Premium', type: SkuType.SUBSCRIPTION });
    coins = w.c.createSku({ applicationId: w.app.id, name: 'Coins', type: SkuType.CONSUMABLE });
    lifetime = w.c.createSku({ applicationId: w.app.id, name: 'Lifetime', type: SkuType.DURABLE });
    skuB = w.c.createSku({ applicationId: appB.id, name: 'B Premium', type: SkuType.SUBSCRIPTION });
    gcA = await GatewayClient.connect(w.fake.gatewayUrl);
    await gcA.ready(w.app.token, I.GUILDS);
    gcB = await GatewayClient.connect(w.fake.gatewayUrl);
    await gcB.ready(appB.token, I.GUILDS);
  });
  after(() => { gcA?.close(); gcB?.close(); return w.fake.close(); });

  // https://discord.com/developers/docs/resources/sku#list-skus
  test('GET /applications/{id}/skus lists only this application\'s SKUs', async () => {
    const r = await w.rest.get(`${base()}/skus`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map((s) => s.id).sort(), [premium.id, coins.id, lifetime.id].sort());
    const p = r.body.find((s) => s.id === premium.id);
    assert.equal(p.type, 5);
    assert.equal(p.application_id, w.app.id);
    assert.equal(p.name, 'Premium');
    assert.equal(typeof p.slug, 'string');
    assert.equal(typeof p.flags, 'number');
    const other = await w.rest.get(`/applications/${appB.id}/skus`);
    assert.equal(other.status, 403);
    assert.equal(other.body.code, 20012);
  });

  // https://discord.com/developers/docs/resources/entitlement#create-test-entitlement
  test('POST test entitlement for a user (owner_type 2) returns a partial object and dispatches ENTITLEMENT_CREATE to this app only', async () => {
    const r = await w.rest.post(`${base()}/entitlements`, { sku_id: premium.id, owner_id: w.alice.id, owner_type: 2 });
    assert.equal(r.status, 200);
    assert.equal(r.body.sku_id, premium.id);
    assert.equal(r.body.user_id, w.alice.id);
    assert.equal(r.body.guild_id, undefined);
    assert.equal(r.body.application_id, w.app.id);
    assert.equal(r.body.type, ET.TEST_MODE_PURCHASE);
    assert.equal(r.body.deleted, false);
    // "It will not contain subscription_id, starts_at, or ends_at, as it's valid in perpetuity."
    assert.ok(!('starts_at' in r.body));
    assert.ok(!('ends_at' in r.body));
    assert.ok(!('subscription_id' in r.body));
    // https://discord.com/developers/docs/events/gateway-events#entitlement-create
    const ev = await gcA.waitForDispatch('ENTITLEMENT_CREATE', (d) => d.id === r.body.id);
    assert.equal(ev.d.user_id, w.alice.id);
    assert.equal((await gcB.expectNone('ENTITLEMENT_CREATE')).length, 0);
    const got = await w.rest.get(`${base()}/entitlements/${r.body.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.id, r.body.id);
    assert.equal(got.body.starts_at, null);
  });

  test('POST test entitlement for a guild (owner_type 1)', async () => {
    const r = await w.rest.post(`${base()}/entitlements`, { sku_id: lifetime.id, owner_id: w.guildId, owner_type: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.body.guild_id, w.guildId);
    assert.equal(r.body.user_id, undefined);
    await gcA.waitForDispatch('ENTITLEMENT_CREATE', (d) => d.id === r.body.id);
    assert.equal((await gcB.expectNone('ENTITLEMENT_CREATE')).length, 0);
  });

  test('test entitlement validation: bad owner_type, unknown or foreign SKU', async () => {
    const bad = await w.rest.post(`${base()}/entitlements`, { sku_id: premium.id, owner_id: w.alice.id, owner_type: 3 });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 50035);
    const foreign = await w.rest.post(`${base()}/entitlements`, { sku_id: skuB.id, owner_id: w.alice.id, owner_type: 2 });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.code, 10027);
    const unknown = await w.rest.get(`${base()}/entitlements/123456789012345678`);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 10029);
  });

  // https://discord.com/developers/docs/resources/entitlement#list-entitlements
  test('list entitlements: user_id, guild_id, sku_ids, exclude_ended, before/after/limit', async () => {
    const bob1 = (await w.rest.post(`${base()}/entitlements`, { sku_id: premium.id, owner_id: w.bob.id, owner_type: 2 })).body;
    const bob2 = (await w.rest.post(`${base()}/entitlements`, { sku_id: coins.id, owner_id: w.bob.id, owner_type: 2 })).body;
    const ended = w.c.grantEntitlement({ applicationId: w.app.id, skuId: lifetime.id, userId: w.bob.id, type: ET.PURCHASE, startsAt: '2025-01-01T00:00:00.000Z', endsAt: '2025-02-01T00:00:00.000Z' });
    // Another app's entitlement for the same user is never listed.
    w.c.grantEntitlement({ applicationId: appB.id, skuId: skuB.id, userId: w.bob.id });

    const byUser = await w.rest.get(`${base()}/entitlements?user_id=${w.bob.id}`);
    assert.equal(byUser.status, 200);
    assert.deepEqual(byUser.body.map((e) => e.id), [bob1.id, bob2.id, ended.id]);
    const notEnded = await w.rest.get(`${base()}/entitlements?user_id=${w.bob.id}&exclude_ended=true`);
    assert.deepEqual(notEnded.body.map((e) => e.id), [bob1.id, bob2.id]);
    const bySku = await w.rest.get(`${base()}/entitlements?user_id=${w.bob.id}&sku_ids=${coins.id},${lifetime.id}`);
    assert.deepEqual(bySku.body.map((e) => e.id), [bob2.id, ended.id]);
    const byGuild = await w.rest.get(`${base()}/entitlements?guild_id=${w.guildId}`);
    assert.ok(byGuild.body.length >= 1);
    assert.ok(byGuild.body.every((e) => e.guild_id === w.guildId));
    const after = await w.rest.get(`${base()}/entitlements?user_id=${w.bob.id}&after=${bob1.id}&limit=1`);
    assert.deepEqual(after.body.map((e) => e.id), [bob2.id]);
    const before = await w.rest.get(`${base()}/entitlements?user_id=${w.bob.id}&before=${ended.id}&limit=1`);
    assert.deepEqual(before.body.map((e) => e.id), [bob2.id]);
    const tooMany = await w.rest.get(`${base()}/entitlements?limit=101`);
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.code, 50035);
    const foreign = await restB.get(`${base()}/entitlements`);
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.code, 20012);
  });

  // https://discord.com/developers/docs/resources/entitlement#delete-test-entitlement
  test('DELETE test entitlement: 204, ENTITLEMENT_DELETE, hidden unless exclude_deleted=false', async () => {
    const e = (await w.rest.post(`${base()}/entitlements`, { sku_id: premium.id, owner_id: w.mod.id, owner_type: 2 })).body;
    const del = await w.rest.delete(`${base()}/entitlements/${e.id}`);
    assert.equal(del.status, 204);
    const ev = await gcA.waitForDispatch('ENTITLEMENT_DELETE', (d) => d.id === e.id);
    assert.equal(ev.d.deleted, true);
    assert.equal((await gcB.expectNone('ENTITLEMENT_DELETE')).length, 0);
    const list = await w.rest.get(`${base()}/entitlements?user_id=${w.mod.id}`);
    assert.deepEqual(list.body, []);
    const withDeleted = await w.rest.get(`${base()}/entitlements?user_id=${w.mod.id}&exclude_deleted=false`);
    assert.deepEqual(withDeleted.body.map((x) => [x.id, x.deleted]), [[e.id, true]]);
    // A real purchase is not a test entitlement.
    const real = w.c.grantEntitlement({ applicationId: w.app.id, skuId: premium.id, userId: w.mod.id });
    const notTest = await w.rest.delete(`${base()}/entitlements/${real.id}`);
    assert.equal(notTest.status, 404);
    assert.equal(notTest.body.code, 10029);
  });

  // https://discord.com/developers/docs/resources/entitlement#consume-an-entitlement
  test('consume: only consumable SKUs; ENTITLEMENT_UPDATE with consumed true', async () => {
    const c = (await w.rest.post(`${base()}/entitlements`, { sku_id: coins.id, owner_id: w.alice.id, owner_type: 2 })).body;
    const r = await w.rest.post(`${base()}/entitlements/${c.id}/consume`);
    assert.equal(r.status, 204);
    const ev = await gcA.waitForDispatch('ENTITLEMENT_UPDATE', (d) => d.id === c.id);
    assert.equal(ev.d.consumed, true);
    assert.equal((await gcB.expectNone('ENTITLEMENT_UPDATE')).length, 0);
    assert.equal((await w.rest.get(`${base()}/entitlements/${c.id}`)).body.consumed, true);
    const durable = (await w.rest.post(`${base()}/entitlements`, { sku_id: lifetime.id, owner_id: w.alice.id, owner_type: 2 })).body;
    const notConsumable = await w.rest.post(`${base()}/entitlements/${durable.id}/consume`);
    assert.equal(notConsumable.status, 400);
  });

  // https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object – entitlements
  test('entitlements appear in INTERACTION_CREATE for the invoking user', async () => {
    w.c.registerCommand({ applicationId: w.app.id, command: { name: 'perks', description: 'Perks' } });
    const ent = w.c.grantEntitlement({ applicationId: w.app.id, skuId: premium.id, userId: w.mod.id });
    const r = w.c.runCommand({ applicationId: w.app.id, userId: w.mod.id, guildId: w.guildId, name: 'perks' });
    const d = (await gcA.waitForDispatch('INTERACTION_CREATE', (x) => x.id === r.id)).d;
    const ids = d.entitlements.map((e) => e.id);
    assert.ok(ids.includes(ent.id));
    assert.ok(d.entitlements.every((e) => e.application_id === w.app.id && (e.user_id === w.mod.id || e.guild_id === w.guildId)));
    assert.ok(d.entitlements.every((e) => !e.deleted), 'deleted entitlements are not included');
    const r2 = w.c.runCommand({ applicationId: w.app.id, userId: w.alice.id, guildId: w.guildId, name: 'perks' });
    const d2 = (await gcA.waitForDispatch('INTERACTION_CREATE', (x) => x.id === r2.id)).d;
    assert.ok(!d2.entitlements.some((e) => e.id === ent.id));
  });

  // https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object – entitlements
  // "representing access to premium SKUs": an entitlement whose ends_at has passed no longer grants access.
  test('ended entitlements are not in INTERACTION_CREATE', async () => {
    const ent = w.c.grantEntitlement({ applicationId: w.app.id, skuId: lifetime.id, userId: w.bob.id, endsAt: new Date(w.c.now().now + 60_000).toISOString() });
    const r1 = w.c.runCommand({ applicationId: w.app.id, userId: w.bob.id, guildId: w.guildId, name: 'perks' });
    const d1 = (await gcA.waitForDispatch('INTERACTION_CREATE', (x) => x.id === r1.id)).d;
    assert.ok(d1.entitlements.some((e) => e.id === ent.id), 'active before ends_at');
    w.c.advance(60_001);
    const r2 = w.c.runCommand({ applicationId: w.app.id, userId: w.bob.id, guildId: w.guildId, name: 'perks' });
    const d2 = (await gcA.waitForDispatch('INTERACTION_CREATE', (x) => x.id === r2.id)).d;
    assert.ok(!d2.entitlements.some((e) => e.id === ent.id), 'gone after ends_at');
  });
});

// https://discord.com/developers/docs/resources/subscription
describe('subscriptions', () => {
  let w;
  let appB;
  let premium;
  let sub;
  before(async () => {
    w = await world();
    appB = w.c.createApplication({ name: 'AppB', ownerId: w.owner.id });
    premium = w.c.createSku({ applicationId: w.app.id, name: 'Premium', type: SkuType.SUBSCRIPTION });
    sub = w.c.createSubscription({ applicationId: w.app.id, userId: w.alice.id, skuIds: [premium.id] });
    w.c.createSubscription({ applicationId: w.app.id, userId: w.bob.id, skuIds: [premium.id] });
  });
  after(() => w.fake.close());

  // https://discord.com/developers/docs/resources/subscription#list-sku-subscriptions – "user_id … Required except for OAuth queries."
  test('GET /skus/{id}/subscriptions requires user_id for bots and filters by it', async () => {
    const missing = await w.rest.get(`/skus/${premium.id}/subscriptions`);
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 50035);
    const r = await w.rest.get(`/skus/${premium.id}/subscriptions?user_id=${w.alice.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);
    const s = r.body[0];
    assert.equal(s.id, sub.id);
    assert.equal(s.user_id, w.alice.id);
    assert.deepEqual(s.sku_ids, [premium.id]);
    assert.equal(s.entitlement_ids.length, 1);
    assert.equal(s.status, 0);
    assert.ok(Date.parse(s.current_period_end) - Date.parse(s.current_period_start) >= 28 * DAY);
    // The subscription's entitlement is an APPLICATION_SUBSCRIPTION entitlement with a period.
    const ent = await w.rest.get(`/applications/${w.app.id}/entitlements/${s.entitlement_ids[0]}`);
    assert.equal(ent.body.type, ET.APPLICATION_SUBSCRIPTION);
    assert.equal(ent.body.subscription_id, sub.id);
    assert.equal(ent.body.ends_at, s.current_period_end);
  });

  // https://discord.com/developers/docs/resources/subscription#get-sku-subscription
  test('GET /skus/{id}/subscriptions/{id}', async () => {
    const r = await w.rest.get(`/skus/${premium.id}/subscriptions/${sub.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, sub.id);
    const unknown = await w.rest.get(`/skus/${premium.id}/subscriptions/123456789012345678`);
    assert.equal(unknown.status, 404);
  });

  test("another application cannot read this application's SKU subscriptions", async () => {
    const b = client(w.fake, `Bot ${appB.token}`);
    const r = await b.get(`/skus/${premium.id}/subscriptions?user_id=${w.alice.id}`);
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 10027);
    const one = await b.get(`/skus/${premium.id}/subscriptions/${sub.id}`);
    assert.equal(one.status, 404);
  });
});
