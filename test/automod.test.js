// AutoMod contract – https://discord.com/developers/docs/resources/auto-moderation
// Events – https://discord.com/developers/docs/events/gateway-events#auto-moderation
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, GatewayClient } from './helpers.js';
import { Intents as I, AuditLogEvent as A } from '../src/constants.js';

const BOT_PERMS = ['MANAGE_GUILD', 'VIEW_AUDIT_LOG', 'MODERATE_MEMBERS'];
const EXEC = I.GUILDS | I.GUILD_MESSAGES | I.MESSAGE_CONTENT | I.AUTO_MODERATION_EXECUTION | I.GUILD_MEMBERS;
const CONFIG = I.GUILDS | I.GUILD_MODERATION | I.AUTO_MODERATION_CONFIGURATION;

const worlds = [];
after(() => Promise.all(worlds.map((w) => w.fake.close())));

async function setup(opts = {}) {
  const w = await world({ botPermissions: BOT_PERMS, ...opts });
  worlds.push(w);
  w.bot = w.app.bot_user_id;
  w.rules = `/guilds/${w.guildId}/auto-moderation/rules`;
  w.create = (body, o) => w.rest.post(w.rules, body, o);
  w.createOk = async (body) => {
    const res = await w.create(body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };
  w.audit = async (q = '') => {
    const res = await w.rest.get(`/guilds/${w.guildId}/audit-logs${q}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };
  w.gateway = async (intents) => {
    const gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, intents);
    return gc;
  };
  w.post = (authorId, content, channelId = w.channelId) => w.c.postMessage({ channelId, authorId, content });
  w.messages = async (channelId = w.channelId) => {
    const res = await w.rest.get(`/channels/${channelId}/messages`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };
  return w;
}

const keywordRule = (actions, extra = {}) => ({
  name: 'No bad words', event_type: 1, trigger_type: 1, trigger_metadata: { keyword_filter: ['badword'] }, actions, enabled: true, ...extra,
});
const BLOCK = { type: 1, metadata: { custom_message: 'Please be nice' } };

function assertError(res, status, code) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  if (code !== undefined) assert.equal(res.body?.code, code, JSON.stringify(res.body));
}

// https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-permission-requirements
describe('rule management', () => {
  test('every rule endpoint needs MANAGE_GUILD', async () => {
    const w = await setup({ botPermissions: ['KICK_MEMBERS', 'MODERATE_MEMBERS'] });
    const rule = w.c.actAs({ userId: w.owner.id, method: 'POST', path: w.rules, body: keywordRule([BLOCK]) }).body;
    assertError(await w.rest.get(w.rules), 403, 50013);
    assertError(await w.rest.get(`${w.rules}/${rule.id}`), 403, 50013);
    assertError(await w.create(keywordRule([BLOCK], { name: 'x' })), 403, 50013);
    assertError(await w.rest.patch(`${w.rules}/${rule.id}`, { name: 'y' }), 403, 50013);
    assertError(await w.rest.delete(`${w.rules}/${rule.id}`), 403, 50013);
  });

  // https://discord.com/developers/docs/resources/auto-moderation#create-auto-moderation-rule
  test('create: returns the rule (enabled false by default), GET/list return it, audit 140 with the reason', async () => {
    const w = await setup();
    assert.deepEqual((await w.rest.get(w.rules)).body, []);
    const res = await w.create({ name: 'Links', event_type: 1, trigger_type: 1, trigger_metadata: { keyword_filter: ['*discord.gg*'] }, actions: [BLOCK] },
      { headers: { 'X-Audit-Log-Reason': encodeURIComponent('stop invites') } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rule = res.body;
    assert.match(rule.id, /^\d+$/);
    assert.equal(rule.guild_id, w.guildId);
    assert.equal(rule.creator_id, w.bot);
    assert.equal(rule.name, 'Links');
    assert.equal(rule.event_type, 1);
    assert.equal(rule.trigger_type, 1);
    assert.deepEqual(rule.trigger_metadata.keyword_filter, ['*discord.gg*']);
    assert.deepEqual(rule.actions.map((a) => a.type), [1]);
    assert.equal(rule.enabled, false);
    assert.deepEqual(rule.exempt_roles, []);
    assert.deepEqual(rule.exempt_channels, []);
    assert.deepEqual((await w.rest.get(`${w.rules}/${rule.id}`)).body, rule);
    assert.deepEqual((await w.rest.get(w.rules)).body, [rule]);
    const log = await w.audit(`?action_type=${A.AUTO_MODERATION_RULE_CREATE}`);
    assert.equal(log.audit_log_entries[0].target_id, rule.id);
    assert.equal(log.audit_log_entries[0].user_id, w.bot);
    assert.equal(log.audit_log_entries[0].reason, 'stop invites');
    assert.deepEqual(log.auto_moderation_rules.map((r) => r.id), [rule.id]);
  });

  test('unknown rule -> 404', async () => {
    const w = await setup();
    assertError(await w.rest.get(`${w.rules}/123456789012345678`), 404);
    assertError(await w.rest.patch(`${w.rules}/123456789012345678`, { name: 'x' }), 404);
    assertError(await w.rest.delete(`${w.rules}/123456789012345678`), 404);
  });

  test('invalid bodies -> 400/50035', async () => {
    const w = await setup();
    const bad = [
      { ...keywordRule([BLOCK]), name: undefined },
      { ...keywordRule([BLOCK]), name: 'x'.repeat(101) },
      { ...keywordRule([BLOCK]), event_type: 3 },
      { ...keywordRule([BLOCK]), trigger_type: 2 },
      keywordRule([]),
      keywordRule([{ type: 9 }]),
      keywordRule([BLOCK], { trigger_metadata: { keyword_filter: Array.from({ length: 1001 }, (_, i) => `w${i}`) } }),
      keywordRule([BLOCK], { trigger_metadata: { keyword_filter: ['x'.repeat(61)] } }),
      keywordRule([BLOCK], { trigger_metadata: { regex_patterns: Array.from({ length: 11 }, () => 'a+') } }),
      keywordRule([BLOCK], { exempt_roles: Array.from({ length: 21 }, (_, i) => String(100000000000000000n + BigInt(i))) }),
      keywordRule([BLOCK], { exempt_channels: Array.from({ length: 51 }, (_, i) => String(100000000000000000n + BigInt(i))) }),
      keywordRule([{ type: 1, metadata: { custom_message: 'x'.repeat(151) } }]),
      // Action metadata – https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-action-object-action-metadata
      keywordRule([{ type: 3, metadata: { duration_seconds: 2419201 } }]),
      keywordRule([{ type: 3 }]),
      keywordRule([{ type: 2 }]),
      keywordRule([{ type: 2, metadata: { channel_id: '123456789012345678' } }]),
      // "A TIMEOUT action can only be set up for KEYWORD and MENTION_SPAM rules."
      { name: 'spam', event_type: 1, trigger_type: 3, actions: [{ type: 3, metadata: { duration_seconds: 60 } }] },
    ];
    for (const body of bad) assertError(await w.create(body), 400, 50035);
    assert.deepEqual((await w.rest.get(w.rules)).body, []);
  });

  // "The MODERATE_MEMBERS permission is required to use the TIMEOUT action type."
  test('a TIMEOUT action needs MODERATE_MEMBERS', async () => {
    const w = await setup({ botPermissions: ['MANAGE_GUILD'] });
    assertError(await w.create(keywordRule([{ type: 3, metadata: { duration_seconds: 60 } }])), 403, 50013);
    const rule = await w.createOk(keywordRule([BLOCK]));
    assertError(await w.rest.patch(`${w.rules}/${rule.id}`, { actions: [{ type: 3, metadata: { duration_seconds: 60 } }] }), 403, 50013);
  });

  // https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-rule-object-trigger-types – Max per Guild
  test('max rules per trigger type: KEYWORD 6, SPAM / KEYWORD_PRESET / MENTION_SPAM 1', async () => {
    const w = await setup();
    for (let i = 0; i < 6; i++) await w.createOk(keywordRule([BLOCK], { name: `k${i}` }));
    assertError(await w.create(keywordRule([BLOCK], { name: 'k7' })), 400, 50035);
    const spam = { name: 'spam', event_type: 1, trigger_type: 3, actions: [BLOCK] };
    await w.createOk(spam);
    assertError(await w.create(spam), 400, 50035);
    const preset = { name: 'preset', event_type: 1, trigger_type: 4, trigger_metadata: { presets: [1] }, actions: [BLOCK] };
    await w.createOk(preset);
    assertError(await w.create(preset), 400, 50035);
    const mentions = { name: 'mentions', event_type: 1, trigger_type: 5, trigger_metadata: { mention_total_limit: 5 }, actions: [BLOCK] };
    await w.createOk(mentions);
    assertError(await w.create(mentions), 400, 50035);
    assert.equal((await w.rest.get(w.rules)).body.length, 9);
  });

  // https://discord.com/developers/docs/resources/auto-moderation#modify-auto-moderation-rule / #delete-auto-moderation-rule
  test('modify and delete write 141 / 142 audit entries', async () => {
    const w = await setup();
    const rule = await w.createOk(keywordRule([BLOCK]));
    const res = await w.rest.patch(`${w.rules}/${rule.id}`, { name: 'Renamed', enabled: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.name, 'Renamed');
    assert.equal(res.body.enabled, false);
    assert.equal((await w.rest.get(`${w.rules}/${rule.id}`)).body.name, 'Renamed');
    const [upd] = (await w.audit(`?action_type=${A.AUTO_MODERATION_RULE_UPDATE}`)).audit_log_entries;
    assert.equal(upd.target_id, rule.id);
    assert.deepEqual(upd.changes.find((c) => c.key === 'name'), { key: 'name', old_value: 'No bad words', new_value: 'Renamed' });
    assertError(await w.rest.patch(`${w.rules}/${rule.id}`, { name: '' }), 400, 50035);
    assert.equal((await w.rest.delete(`${w.rules}/${rule.id}`)).status, 204);
    assertError(await w.rest.get(`${w.rules}/${rule.id}`), 404);
    const [del] = (await w.audit(`?action_type=${A.AUTO_MODERATION_RULE_DELETE}`)).audit_log_entries;
    assert.equal(del.target_id, rule.id);
    assert.equal(del.user_id, w.bot);
  });

  // https://discord.com/developers/docs/events/gateway#list-of-intents – AUTO_MODERATION_CONFIGURATION (1 << 20)
  test('AUTO_MODERATION_RULE_CREATE/UPDATE/DELETE need the AUTO_MODERATION_CONFIGURATION intent', async () => {
    const w = await setup();
    const withIntent = await w.gateway(CONFIG);
    const without = await w.gateway(I.GUILDS | I.GUILD_MODERATION);
    const rule = await w.createOk(keywordRule([BLOCK]));
    const created = await withIntent.waitForDispatch('AUTO_MODERATION_RULE_CREATE', (d) => d.id === rule.id);
    assert.deepEqual(created.d, rule);
    await w.rest.patch(`${w.rules}/${rule.id}`, { name: 'v2' });
    const updated = await withIntent.waitForDispatch('AUTO_MODERATION_RULE_UPDATE', (d) => d.id === rule.id);
    assert.equal(updated.d.name, 'v2');
    await w.rest.delete(`${w.rules}/${rule.id}`);
    await withIntent.waitForDispatch('AUTO_MODERATION_RULE_DELETE', (d) => d.id === rule.id);
    // The other session saw the audit entries but no rule events.
    await without.waitForDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', (d) => d.action_type === A.AUTO_MODERATION_RULE_DELETE);
    assert.deepEqual(without.dispatches().filter((f) => f.t.startsWith('AUTO_MODERATION')), []);
    withIntent.close(); without.close();
  });
});

// https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-action-object-action-types
describe('rule execution', () => {
  test('BLOCK_MESSAGE: message not posted, AUTO_MODERATION_ACTION_EXECUTION, audit 143', async () => {
    const w = await setup();
    const rule = await w.createOk(keywordRule([BLOCK]));
    const full = await w.gateway(EXEC);
    const noContent = await w.gateway(I.GUILDS | I.GUILD_MESSAGES | I.AUTO_MODERATION_EXECUTION);
    const noIntent = await w.gateway(I.GUILDS | I.GUILD_MESSAGES | I.MESSAGE_CONTENT);
    assert.deepEqual(w.post(w.alice.id, 'what a BadWord, really'), { blocked: true, by: 'automod' });
    const ev = await full.waitForDispatch('AUTO_MODERATION_ACTION_EXECUTION');
    assert.equal(ev.d.guild_id, w.guildId);
    assert.equal(ev.d.rule_id, rule.id);
    assert.equal(ev.d.rule_trigger_type, 1);
    assert.equal(ev.d.user_id, w.alice.id);
    assert.equal(ev.d.channel_id, w.channelId);
    assert.deepEqual(ev.d.action, BLOCK);
    assert.equal(ev.d.content, 'what a BadWord, really');
    assert.equal(ev.d.matched_keyword, 'badword');
    assert.equal(ev.d.matched_content, 'BadWord');
    // "message_id will not exist if message was blocked"
    assert.equal('message_id' in ev.d, false);
    // "MESSAGE_CONTENT (1 << 15) gateway intent is required to receive the content and matched_content fields"
    const redacted = await noContent.waitForDispatch('AUTO_MODERATION_ACTION_EXECUTION');
    assert.equal(redacted.d.content, '');
    assert.ok(!redacted.d.matched_content);
    assert.equal(redacted.d.matched_keyword, 'badword');
    // Not posted: no MESSAGE_CREATE, not in the channel.
    assert.deepEqual(await w.messages(), []);
    assert.deepEqual(full.dispatches('MESSAGE_CREATE'), []);
    assert.deepEqual(await noIntent.expectNone('AUTO_MODERATION_ACTION_EXECUTION'), []);
    const log = await w.audit(`?action_type=${A.AUTO_MODERATION_BLOCK_MESSAGE}`);
    const [entry] = log.audit_log_entries;
    assert.equal(entry.user_id, w.alice.id);
    assert.equal(entry.target_id, w.alice.id);
    assert.deepEqual(entry.options, { auto_moderation_rule_name: 'No bad words', auto_moderation_rule_trigger_type: '1', channel_id: w.channelId });
    // A clean message goes through.
    const ok = w.post(w.alice.id, 'bad words are fine');
    await full.waitForDispatch('MESSAGE_CREATE', (d) => d.id === ok.id);
    full.close(); noContent.close(); noIntent.close();
  });

  test('SEND_ALERT_MESSAGE: message posted, alert (type 24) in the alert channel, event with both ids, audit 144', async () => {
    const w = await setup();
    const modLog = w.c.createChannel({ guildId: w.guildId, name: 'mod-log' });
    const rule = await w.createOk(keywordRule([{ type: 2, metadata: { channel_id: modLog.id } }]));
    const gc = await w.gateway(EXEC);
    const msg = w.post(w.bob.id, 'badword!');
    assert.match(msg.id, /^\d+$/);
    await gc.waitForDispatch('MESSAGE_CREATE', (d) => d.id === msg.id);
    const ev = await gc.waitForDispatch('AUTO_MODERATION_ACTION_EXECUTION', (d) => d.rule_id === rule.id);
    assert.equal(ev.d.action.type, 2);
    assert.equal(ev.d.message_id, msg.id);
    const alerts = await w.messages(modLog.id);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, 24);
    assert.equal(ev.d.alert_system_message_id, alerts[0].id);
    assert.deepEqual((await w.messages()).map((m) => m.id), [msg.id]);
    const [entry] = (await w.audit(`?action_type=${A.AUTO_MODERATION_FLAG_TO_CHANNEL}`)).audit_log_entries;
    assert.equal(entry.user_id, w.bob.id);
    assert.equal(entry.options.auto_moderation_rule_name, 'No bad words');
    assert.equal(entry.options.channel_id, w.channelId);
    gc.close();
  });

  test('TIMEOUT: the author is timed out for duration_seconds, GUILD_MEMBER_UPDATE, audit 145', async () => {
    const w = await setup();
    const rule = await w.createOk(keywordRule([{ type: 3, metadata: { duration_seconds: 600 } }]));
    const gc = await w.gateway(EXEC);
    const msg = w.post(w.alice.id, 'badword');
    assert.match(msg.id, /^\d+$/);
    const ev = await gc.waitForDispatch('AUTO_MODERATION_ACTION_EXECUTION', (d) => d.rule_id === rule.id);
    assert.deepEqual(ev.d.action, { type: 3, metadata: { duration_seconds: 600 } });
    const upd = await gc.waitForDispatch('GUILD_MEMBER_UPDATE', (d) => d.user.id === w.alice.id);
    const expected = w.c.now().now + 600_000;
    assert.equal(Date.parse(upd.d.communication_disabled_until), expected);
    const member = await w.rest.get(`/guilds/${w.guildId}/members/${w.alice.id}`);
    assert.equal(Date.parse(member.body.communication_disabled_until), expected);
    const [entry] = (await w.audit(`?action_type=${A.AUTO_MODERATION_USER_COMMUNICATION_DISABLED}`)).audit_log_entries;
    assert.equal(entry.target_id, w.alice.id);
    assert.equal(entry.options.auto_moderation_rule_trigger_type, '1');
    gc.close();
  });

  // https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-rule-object – exempt_roles / exempt_channels
  test('exempt roles and exempt channels are not affected', async () => {
    const w = await setup();
    const quiet = w.c.createChannel({ guildId: w.guildId, name: 'anything-goes' });
    const rule = await w.createOk(keywordRule([BLOCK], { exempt_roles: [w.memberRole.id], exempt_channels: [quiet.id] }));
    const gc = await w.gateway(EXEC);
    const fromAlice = w.post(w.alice.id, 'badword'); // alice has the Member role
    const inQuiet = w.post(w.bob.id, 'badword', quiet.id);
    assert.deepEqual(w.post(w.bob.id, 'badword'), { blocked: true, by: 'automod' });
    const ev = await gc.waitForDispatch('AUTO_MODERATION_ACTION_EXECUTION', (d) => d.rule_id === rule.id);
    assert.equal(ev.d.user_id, w.bob.id);
    assert.equal(ev.d.channel_id, w.channelId);
    assert.deepEqual((await w.messages()).map((m) => m.id), [fromAlice.id]);
    assert.deepEqual((await w.messages(quiet.id)).map((m) => m.id), [inQuiet.id]);
    assert.equal(gc.dispatches('AUTO_MODERATION_ACTION_EXECUTION').length, 1);
    gc.close();
  });

  // ASSUMPTION (not in the auto-moderation page): members with MANAGE_GUILD (or ADMINISTRATOR) are exempt, as in the Discord client.
  test('members with MANAGE_GUILD are exempt; disabled rules never trigger', async () => {
    const w = await setup();
    const managers = w.c.createRole({ guildId: w.guildId, name: 'Managers', permissions: ['MANAGE_GUILD'] });
    w.c.updateMember({ guildId: w.guildId, userId: w.bob.id, roles: [managers.id] });
    const rule = await w.createOk(keywordRule([BLOCK]));
    const gc = await w.gateway(EXEC);
    const fromBob = w.post(w.bob.id, 'badword');
    await gc.waitForDispatch('MESSAGE_CREATE', (d) => d.id === fromBob.id);
    assert.deepEqual(w.post(w.alice.id, 'badword'), { blocked: true, by: 'automod' });
    await gc.waitForDispatch('AUTO_MODERATION_ACTION_EXECUTION', (d) => d.user_id === w.alice.id);
    assert.equal(gc.dispatches('AUTO_MODERATION_ACTION_EXECUTION').length, 1);
    await w.rest.patch(`${w.rules}/${rule.id}`, { enabled: false });
    const later = w.post(w.alice.id, 'badword again');
    assert.match(later.id, /^\d+$/);
    assert.deepEqual((await w.messages()).map((m) => m.id).sort(), [fromBob.id, later.id].sort());
    gc.close();
  });

  // https://discord.com/developers/docs/events/gateway-events#auto-moderation – "only sent to bot users which have the MANAGE_GUILD permission"
  test('execution events are not sent to a bot without MANAGE_GUILD', async () => {
    const w = await setup({ botPermissions: ['VIEW_AUDIT_LOG'] });
    const modLog = w.c.createChannel({ guildId: w.guildId, name: 'mod-log' });
    w.c.actAs({ userId: w.owner.id, method: 'POST', path: w.rules, body: keywordRule([{ type: 2, metadata: { channel_id: modLog.id } }]) });
    const gc = await w.gateway(EXEC);
    const msg = w.post(w.alice.id, 'badword');
    await gc.waitForDispatch('MESSAGE_CREATE', (d) => d.id === msg.id);
    await gc.waitForDispatch('MESSAGE_CREATE', (d) => d.channel_id === modLog.id && d.type === 24);
    assert.deepEqual(await gc.expectNone('AUTO_MODERATION_ACTION_EXECUTION'), []);
    gc.close();
  });
});
