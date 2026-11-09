// Interactions contract – https://discord.com/developers/docs/interactions/receiving-and-responding
// and application commands – https://discord.com/developers/docs/interactions/application-commands
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { world, client, GatewayClient } from './helpers.js';
import { Intents as I, MessageFlags as MF, Permissions as P } from '../src/constants.js';

const CMD = {
  name: 'warn', description: 'Warn a member', integration_types: [0, 1], contexts: [0, 1, 2],
  options: [{ name: 'user', description: 'Who', type: 6, required: true }, { name: 'reason', description: 'Why', type: 3 }],
};

// https://discord.com/developers/docs/interactions/application-commands#registering-a-command
describe('command registration', () => {
  let w;
  let other;
  before(async () => {
    w = await world();
    other = w.c.createApplication({ name: 'Other', ownerId: w.owner.id });
  });
  after(() => w.fake.close());

  // https://discord.com/developers/docs/interactions/application-commands#create-global-application-command
  test('POST global command: 201 when new, 200 with the same id when upserted by name', async () => {
    const created = await w.rest.post(`/applications/${w.app.id}/commands`, { name: 'ping', description: 'Ping' });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'ping');
    assert.equal(created.body.application_id, w.app.id);
    assert.equal(created.body.type, 1);
    assert.match(created.body.id, /^\d+$/);
    const again = await w.rest.post(`/applications/${w.app.id}/commands`, { name: 'ping', description: 'Ping v2' });
    assert.equal(again.status, 200);
    assert.equal(again.body.id, created.body.id);
    assert.equal(again.body.description, 'Ping v2');
    const list = await w.rest.get(`/applications/${w.app.id}/commands`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.map((c) => c.name), ['ping']);
    const one = await w.rest.get(`/applications/${w.app.id}/commands/${created.body.id}`);
    assert.equal(one.body.description, 'Ping v2');
  });

  // https://discord.com/developers/docs/interactions/application-commands#create-guild-application-command
  test('guild commands are listed per guild and not globally', async () => {
    const g = await w.rest.post(`/applications/${w.app.id}/guilds/${w.guildId}/commands`, { name: 'guildonly', description: 'Only here' });
    assert.equal(g.status, 201);
    assert.equal(g.body.guild_id, w.guildId);
    const guildList = await w.rest.get(`/applications/${w.app.id}/guilds/${w.guildId}/commands`);
    assert.deepEqual(guildList.body.map((c) => c.name), ['guildonly']);
    const globalList = await w.rest.get(`/applications/${w.app.id}/commands`);
    assert.ok(!globalList.body.some((c) => c.name === 'guildonly'));
    // Fetching a guild command through the global route is unknown (10063).
    const wrongScope = await w.rest.get(`/applications/${w.app.id}/commands/${g.body.id}`);
    assert.equal(wrongScope.status, 404);
    assert.equal(wrongScope.body.code, 10063);
  });

  // https://discord.com/developers/docs/interactions/application-commands#bulk-overwrite-global-application-commands
  test('PUT bulk overwrite keeps ids of existing names, creates new ones and deletes the rest', async () => {
    const a = (await w.rest.post(`/applications/${w.app.id}/commands`, { name: 'alpha', description: 'A' })).body;
    const b = (await w.rest.post(`/applications/${w.app.id}/commands`, { name: 'beta', description: 'B' })).body;
    const put = await w.rest.put(`/applications/${w.app.id}/commands`, [
      { name: 'alpha', description: 'A2' },
      { name: 'gamma', description: 'G' },
    ]);
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.map((c) => c.name), ['alpha', 'gamma']);
    assert.equal(put.body[0].id, a.id);
    assert.equal(put.body[0].description, 'A2');
    assert.notEqual(put.body[1].id, b.id);
    const list = await w.rest.get(`/applications/${w.app.id}/commands`);
    assert.deepEqual(list.body.map((c) => c.name).sort(), ['alpha', 'gamma']);
    const gone = await w.rest.get(`/applications/${w.app.id}/commands/${b.id}`);
    assert.equal(gone.status, 404);
    assert.equal(gone.body.code, 10063);
  });

  // https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-naming
  test('invalid names are rejected with 50035 Invalid Form Body', async () => {
    for (const name of ['Has Space', 'UPPER', '', 'x'.repeat(33)]) {
      const r = await w.rest.post(`/applications/${w.app.id}/commands`, { name, description: 'd' });
      assert.equal(r.status, 400, name);
      assert.equal(r.body.code, 50035, name);
      assert.ok(r.body.errors.name, `errors.name for ${JSON.stringify(name)}`);
    }
    const missingDesc = await w.rest.post(`/applications/${w.app.id}/commands`, { name: 'nodesc' });
    assert.equal(missingDesc.status, 400);
    assert.ok(missingDesc.body.errors.description);
    // Bulk overwrite reports the index of the bad command.
    const bulk = await w.rest.put(`/applications/${w.app.id}/commands`, [{ name: 'fine', description: 'ok' }, { name: 'Bad Name', description: 'x' }]);
    assert.equal(bulk.status, 400);
    assert.equal(bulk.body.code, 50035);
    assert.ok(bulk.body.errors['1'].name);
  });

  // https://discord.com/developers/docs/topics/opcodes-and-status-codes#json – 20012
  test("another application's id -> 403/20012", async () => {
    for (const [method, body] of [['get'], ['post', { name: 'x', description: 'x' }], ['put', []]]) {
      const r = await w.rest[method](`/applications/${other.id}/commands`, body);
      assert.equal(r.status, 403, method);
      assert.equal(r.body.code, 20012, method);
    }
    const g = await w.rest.get(`/applications/${other.id}/guilds/${w.guildId}/commands`);
    assert.equal(g.status, 403);
    assert.equal(g.body.code, 20012);
  });
});

// https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object
describe('INTERACTION_CREATE over the gateway', () => {
  let w;
  let gc;
  let anon;
  before(async () => {
    w = await world();
    anon = client(w.fake);
    w.c.registerCommand({ applicationId: w.app.id, command: CMD });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, I.GUILDS);
  });
  after(() => { gc?.close(); return w.fake.close(); });

  test('a slash command in a guild carries member, permissions, options, resolved, owners and app_permissions', async () => {
    const { id } = w.c.runCommand({ applicationId: w.app.id, userId: w.mod.id, guildId: w.guildId, channelId: w.channelId, name: 'warn', options: { user: w.bob.id, reason: 'spam' }, locale: 'de' });
    const f = await gc.waitForDispatch('INTERACTION_CREATE', (d) => d.id === id);
    const d = f.d;
    assert.equal(d.type, 2);
    assert.equal(d.application_id, w.app.id);
    assert.equal(typeof d.token, 'string');
    assert.ok(d.token.length > 20);
    assert.equal(d.version, 1);
    assert.equal(d.guild_id, w.guildId);
    assert.equal(d.channel_id, w.channelId);
    assert.equal(d.context, 0);
    assert.equal(d.locale, 'de');
    assert.equal(d.guild_locale, 'en-US');
    assert.equal(d.user, undefined, 'user is only sent in DMs');
    assert.equal(d.member.user.id, w.mod.id);
    assert.deepEqual(d.member.roles, [w.modRole.id]);
    const perms = BigInt(d.member.permissions);
    assert.ok(perms & P.KICK_MEMBERS);
    assert.ok(!(perms & P.ADMINISTRATOR));
    assert.deepEqual(d.authorizing_integration_owners, { 0: w.guildId });
    assert.ok(BigInt(d.app_permissions) & P.ADMINISTRATOR);
    assert.equal(d.data.name, 'warn');
    assert.equal(d.data.type, 1);
    assert.deepEqual(d.data.options, [{ name: 'user', type: 6, value: w.bob.id }, { name: 'reason', type: 3, value: 'spam' }]);
    assert.equal(d.data.resolved.users[w.bob.id].id, w.bob.id);
    assert.ok(d.data.resolved.members[w.bob.id].joined_at);
    assert.equal(d.data.resolved.members[w.bob.id].user, undefined, 'resolved members omit user');
    assert.deepEqual(d.entitlements, []);
    assert.equal(typeof d.attachment_size_limit, 'number');
  });

  // https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-interaction-context-types
  test('a command in the bot DM carries user (not member), context 1 and owners {"0": "0"}', async () => {
    const { id } = w.c.runCommand({ applicationId: w.app.id, userId: w.alice.id, name: 'warn', options: { user: w.bob.id } });
    const d = (await gc.waitForDispatch('INTERACTION_CREATE', (x) => x.id === id)).d;
    assert.equal(d.context, 1);
    assert.equal(d.guild_id, undefined);
    assert.equal(d.member, undefined);
    assert.equal(d.user.id, w.alice.id);
    assert.equal(d.channel.type, 1);
    // "The value will be "0" if the interaction is triggered from a DM with the app's bot user"
    assert.deepEqual(d.authorizing_integration_owners, { 0: '0' });
    // app_permissions in a DM with the bot: ATTACH_FILES | EMBED_LINKS | MENTION_EVERYONE | USE_EXTERNAL_EMOJIS
    assert.equal(BigInt(d.app_permissions), P.ATTACH_FILES | P.EMBED_LINKS | P.MENTION_EVERYONE | P.USE_EXTERNAL_EMOJIS);
    // Installed both ways and the command supports both: both keys.
    w.c.installForUser({ applicationId: w.app.id, userId: w.alice.id });
    const both = w.c.runCommand({ applicationId: w.app.id, userId: w.alice.id, name: 'warn', options: { user: w.bob.id } });
    const d2 = (await gc.waitForDispatch('INTERACTION_CREATE', (x) => x.id === both.id)).d;
    assert.deepEqual(d2.authorizing_integration_owners, { 0: '0', 1: w.alice.id });
  });
});

// https://discord.com/developers/docs/interactions/receiving-and-responding#responding-to-an-interaction
describe('responding', () => {
  let w;
  let gc;
  let anon;
  const run = async (userId = w.alice.id, extra = {}) => {
    const r = w.c.runCommand({ applicationId: w.app.id, userId, guildId: w.guildId, channelId: w.channelId, name: 'warn', options: { user: w.bob.id }, ...extra });
    const f = await gc.waitForDispatch('INTERACTION_CREATE', (d) => d.id === r.id);
    return f.d;
  };
  const cb = (i, body, q = '') => anon.post(`/interactions/${i.id}/${i.token}/callback${q}`, body);
  before(async () => {
    w = await world();
    anon = client(w.fake);
    w.c.registerCommand({ applicationId: w.app.id, command: CMD });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, I.GUILDS | I.GUILD_MESSAGES);
  });
  after(() => { gc?.close(); return w.fake.close(); });

  // https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-response-object-interaction-callback-type
  test('type 4 creates a channel message with interaction_metadata', async () => {
    const i = await run();
    const r = await cb(i, { type: 4, data: { content: 'Warned bob' } });
    assert.equal(r.status, 204);
    const orig = await anon.get(`/webhooks/${w.app.id}/${i.token}/messages/@original`);
    assert.equal(orig.status, 200);
    assert.equal(orig.body.content, 'Warned bob');
    assert.equal(orig.body.author.id, w.app.bot_user_id);
    assert.equal(orig.body.type, 20, 'CHAT_INPUT_COMMAND');
    assert.equal(orig.body.interaction_metadata.id, i.id);
    assert.equal(orig.body.interaction_metadata.type, 2);
    assert.equal(orig.body.interaction_metadata.user.id, w.alice.id);
    assert.deepEqual(orig.body.interaction_metadata.authorizing_integration_owners, { 0: w.guildId });
    // Visible to everyone in the channel.
    const inChannel = await w.rest.get(`/channels/${w.channelId}/messages/${orig.body.id}`);
    assert.equal(inChannel.status, 200);
    assert.equal(inChannel.body.content, 'Warned bob');
    await gc.waitForDispatch('MESSAGE_CREATE', (d) => d.id === orig.body.id);
    const view = w.c.getUserView({ interactionId: i.id });
    assert.equal(view.status, 'responded');
    assert.equal(view.ephemeral, false);
    assert.equal(view.messages[0].content, 'Warned bob');
  });

  // https://discord.com/developers/docs/resources/message#message-object-message-flags – EPHEMERAL 1 << 6
  test('type 4 with flags 64 is ephemeral: only the user sees it', async () => {
    const i = await run();
    assert.equal((await cb(i, { type: 4, data: { content: 'only you', flags: MF.EPHEMERAL } })).status, 204);
    const orig = await anon.get(`/webhooks/${w.app.id}/${i.token}/messages/@original`);
    assert.equal(orig.status, 200);
    assert.equal(orig.body.content, 'only you');
    assert.ok(orig.body.flags & MF.EPHEMERAL);
    const channel = await w.rest.get(`/channels/${w.channelId}/messages?limit=100`);
    assert.equal(channel.status, 200);
    assert.ok(!channel.body.some((m) => m.content === 'only you'));
    const direct = await w.rest.get(`/channels/${w.channelId}/messages/${orig.body.id}`);
    assert.equal(direct.status, 404);
    const view = w.c.getUserView({ interactionId: i.id });
    assert.equal(view.ephemeral, true);
    assert.equal(view.messages[0].content, 'only you');
  });

  // https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-response-object-interaction-callback-type – 5
  test('type 5 shows a loading state until PATCH @original', async () => {
    const i = await run();
    assert.equal((await cb(i, { type: 5 })).status, 204);
    const loading = await anon.get(`/webhooks/${w.app.id}/${i.token}/messages/@original`);
    assert.equal(loading.status, 200);
    assert.ok(loading.body.flags & MF.LOADING);
    assert.equal(w.c.getUserView({ interactionId: i.id }).status, 'thinking');
    const edit = await anon.patch(`/webhooks/${w.app.id}/${i.token}/messages/@original`, { content: 'done thinking' });
    assert.equal(edit.status, 200);
    assert.equal(edit.body.content, 'done thinking');
    assert.equal(edit.body.flags & MF.LOADING, 0);
    const view = w.c.getUserView({ interactionId: i.id });
    assert.equal(view.status, 'responded');
    assert.equal(view.messages[0].content, 'done thinking');
  });

  // https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-response-object-interaction-callback-type – 6, 7
  test('components: type 7 edits the message, type 6 acknowledges silently; 7 on a command is invalid', async () => {
    const sent = await w.rest.post(`/channels/${w.channelId}/messages`, {
      content: 'Pick one',
      components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Yes', custom_id: 'yes' }, { type: 2, style: 2, label: 'No', custom_id: 'no' }] }],
    });
    assert.equal(sent.status, 200);
    const p = w.c.pressButton({ userId: w.alice.id, channelId: w.channelId, messageId: sent.body.id, customId: 'yes' });
    const d = (await gc.waitForDispatch('INTERACTION_CREATE', (x) => x.id === p.id)).d;
    assert.equal(d.type, 3);
    assert.deepEqual(d.data, { custom_id: 'yes', component_type: 2 });
    assert.equal(d.message.id, sent.body.id);
    assert.equal(d.member.user.id, w.alice.id);
    assert.equal((await cb(d, { type: 7, data: { content: 'You picked yes', components: [] } })).status, 204);
    const updated = await w.rest.get(`/channels/${w.channelId}/messages/${sent.body.id}`);
    assert.equal(updated.body.content, 'You picked yes');
    assert.deepEqual(updated.body.components, []);
    assert.equal(w.c.getUserView({ interactionId: d.id }).status, 'responded');

    const sent2 = await w.rest.post(`/channels/${w.channelId}/messages`, { content: 'Again', components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Go', custom_id: 'go' }] }] });
    const p2 = w.c.pressButton({ userId: w.bob.id, channelId: w.channelId, messageId: sent2.body.id, customId: 'go' });
    const d2 = (await gc.waitForDispatch('INTERACTION_CREATE', (x) => x.id === p2.id)).d;
    assert.equal((await cb(d2, { type: 6 })).status, 204);
    assert.equal((await w.rest.get(`/channels/${w.channelId}/messages/${sent2.body.id}`)).body.content, 'Again');
    assert.equal(w.c.getUserView({ interactionId: d2.id }).status, 'responded');

    const i = await run();
    const bad = await cb(i, { type: 7, data: { content: 'nope' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 50035);
  });

  // https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-modal-submit-data-structure
  test('type 9 opens a modal; submitModal delivers MODAL_SUBMIT with the values', async () => {
    const i = await run();
    const modal = {
      custom_id: 'appeal', title: 'Appeal',
      components: [{ type: 1, components: [{ type: 4, custom_id: 'why', label: 'Why?', style: 2, required: true }] }],
    };
    assert.equal((await cb(i, { type: 9, data: modal })).status, 204);
    const view = w.c.getUserView({ interactionId: i.id });
    assert.equal(view.status, 'modal');
    assert.equal(view.modal.custom_id, 'appeal');
    const s = w.c.submitModal({ interactionId: i.id, values: { why: 'I was framed' } });
    const d = (await gc.waitForDispatch('INTERACTION_CREATE', (x) => x.id === s.id)).d;
    assert.equal(d.type, 5);
    assert.equal(d.data.custom_id, 'appeal');
    assert.deepEqual(d.data.components, [{ type: 1, components: [{ type: 4, custom_id: 'why', value: 'I was framed' }] }]);
    assert.equal(d.member.user.id, w.alice.id);
    // A modal cannot answer a modal submit.
    const again = await cb(d, { type: 9, data: modal });
    assert.equal(again.status, 400);
    assert.equal((await cb(d, { type: 4, data: { content: 'Appeal received', flags: 64 } })).status, 204);
    assert.equal(w.c.getUserView({ interactionId: i.id }).status, 'responded');
  });

  // https://discord.com/developers/docs/topics/opcodes-and-status-codes#json – 40060
  test('a second callback -> 400/40060', async () => {
    const i = await run();
    assert.equal((await cb(i, { type: 4, data: { content: 'first' } })).status, 204);
    const second = await cb(i, { type: 4, data: { content: 'second' } });
    assert.equal(second.status, 400);
    assert.equal(second.body.code, 40060);
  });

  test('a wrong token or unknown interaction -> 404/10062', async () => {
    const i = await run();
    const r = await anon.post(`/interactions/${i.id}/not-the-token/callback`, { type: 4, data: { content: 'x' } });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 10062);
  });

  // "you must send an initial response within 3 seconds of receiving the event. If the 3 second deadline is exceeded,
  // the token will be invalidated." https://discord.com/developers/docs/interactions/receiving-and-responding#responding-to-an-interaction
  test('callback after the 3 second deadline -> 404/10062 and the user sees "This interaction failed"', async () => {
    const i = await run();
    w.c.advance(3001);
    const late = await cb(i, { type: 4, data: { content: 'too late' } });
    assert.equal(late.status, 404);
    assert.equal(late.body.code, 10062);
    const view = w.c.getUserView({ interactionId: i.id });
    assert.equal(view.status, 'failed');
    assert.equal(view.error, 'This interaction failed');
    assert.equal(w.c.getInteraction({ interactionId: i.id }).user_view.error, 'This interaction failed');
    // The token was invalidated: follow-ups fail too.
    const fu = await anon.post(`/webhooks/${w.app.id}/${i.token}`, { content: 'late follow-up' });
    assert.equal(fu.status, 401);
    assert.equal(fu.body.code, 50027);
  });

  // "Interaction tokens are valid for 15 minutes" https://discord.com/developers/docs/interactions/receiving-and-responding#followup-messages
  test('follow-ups work for 15 minutes, then 401/50027', async () => {
    const i = await run();
    await cb(i, { type: 4, data: { content: 'initial' } });
    w.c.advance(14 * 60 * 1000);
    const fu = await anon.post(`/webhooks/${w.app.id}/${i.token}`, { content: 'follow-up' });
    assert.equal(fu.status, 200);
    assert.equal(fu.body.content, 'follow-up');
    assert.notEqual(fu.body.id, (await anon.get(`/webhooks/${w.app.id}/${i.token}/messages/@original`)).body.id);
    assert.ok(w.c.getUserView({ interactionId: i.id }).messages.some((m) => m.content === 'follow-up'));
    w.c.advance(60 * 1000 + 1);
    const expired = await anon.post(`/webhooks/${w.app.id}/${i.token}`, { content: 'too late' });
    assert.equal(expired.status, 401);
    assert.equal(expired.body.code, 50027);
    const editExpired = await anon.patch(`/webhooks/${w.app.id}/${i.token}/messages/@original`, { content: 'x' });
    assert.equal(editExpired.status, 401);
  });

  test('control.expireInteraction invalidates the token', async () => {
    const i = await run();
    await cb(i, { type: 4, data: { content: 'initial' } });
    w.c.expireInteraction({ interactionId: i.id });
    const fu = await anon.post(`/webhooks/${w.app.id}/${i.token}`, { content: 'follow-up' });
    assert.equal(fu.status, 401);
    assert.equal(fu.body.code, 50027);
  });

  // https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-callback-interaction-callback-response-object
  test('?with_response=true returns the interaction callback response', async () => {
    const i = await run();
    const r = await cb(i, { type: 4, data: { content: 'with response' } }, '?with_response=true');
    assert.equal(r.status, 200);
    assert.equal(r.body.interaction.id, i.id);
    assert.equal(r.body.interaction.type, 2);
    assert.equal(r.body.interaction.response_message_loading, false);
    assert.equal(r.body.interaction.response_message_ephemeral, false);
    assert.equal(r.body.resource.type, 4);
    assert.equal(r.body.resource.message.content, 'with response');
    assert.equal(r.body.interaction.response_message_id, r.body.resource.message.id);

    // resource.message is "Only present if type is either CHANNEL_MESSAGE_WITH_SOURCE or UPDATE_MESSAGE".
    const i2 = await run();
    const r2 = await cb(i2, { type: 5, data: { flags: 64 } }, '?with_response=true');
    assert.equal(r2.status, 200);
    assert.equal(r2.body.resource.type, 5);
    assert.equal(r2.body.resource.message, undefined);
    assert.equal(r2.body.interaction.response_message_loading, true);
    assert.equal(r2.body.interaction.response_message_ephemeral, true);
  });

  test('the user view records the timeline', async () => {
    const i = await run();
    assert.equal(w.c.getUserView({ interactionId: i.id }).status, 'pending');
    await cb(i, { type: 5 });
    await anon.post(`/webhooks/${w.app.id}/${i.token}`, { content: 'answer' });
    const rec = w.c.getInteraction({ interactionId: i.id });
    assert.equal(rec.callback_type, 5);
    assert.deepEqual(rec.user_view.timeline.map((e) => e.kind), ['thinking', 'edit']);
    assert.equal(rec.user_view.messages[0].content, 'answer');
  });
});

// https://discord.com/developers/docs/resources/application#installation-context
// https://discord.com/developers/docs/interactions/application-commands#interaction-contexts
describe('install contexts', () => {
  let w;
  let gc;
  let anon;
  before(async () => {
    w = await world();
    anon = client(w.fake);
    w.c.registerCommand({ applicationId: w.app.id, command: { name: 'appeal', description: 'Appeal a ban', integration_types: [1], contexts: [1, 2] } });
    w.c.installForUser({ applicationId: w.app.id, userId: w.bob.id });
    w.c.banMember({ actorId: w.owner.id, guildId: w.guildId, userId: w.bob.id, reason: 'test' });
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, I.GUILDS);
  });
  after(() => { gc?.close(); return w.fake.close(); });

  test('a banned user runs a user-installed command in the bot DM (context 1)', async () => {
    const r = w.c.runCommand({ applicationId: w.app.id, userId: w.bob.id, name: 'appeal' });
    const d = (await gc.waitForDispatch('INTERACTION_CREATE', (x) => x.id === r.id)).d;
    assert.equal(d.context, 1);
    assert.equal(d.user.id, w.bob.id);
    assert.equal(d.guild_id, undefined);
    assert.deepEqual(d.authorizing_integration_owners, { 1: w.bob.id });
    const res = await anon.post(`/interactions/${d.id}/${d.token}/callback`, { type: 4, data: { content: 'Appeal noted' } });
    assert.equal(res.status, 204);
    const msg = (await anon.get(`/webhooks/${w.app.id}/${d.token}/messages/@original`)).body;
    assert.equal(msg.channel_id, d.channel_id);
    assert.deepEqual(msg.interaction_metadata.authorizing_integration_owners, { 1: w.bob.id });
  });

  test('and in a DM with another user (context 2 PRIVATE_CHANNEL)', async () => {
    const dm = w.c.actAs({ userId: w.bob.id, method: 'POST', path: '/users/@me/channels', body: { recipient_id: w.alice.id } });
    assert.equal(dm.status, 200);
    const r = w.c.runCommand({ applicationId: w.app.id, userId: w.bob.id, channelId: dm.body.id, name: 'appeal' });
    const d = (await gc.waitForDispatch('INTERACTION_CREATE', (x) => x.id === r.id)).d;
    assert.equal(d.context, 2);
    assert.equal(d.channel_id, dm.body.id);
    assert.deepEqual(d.authorizing_integration_owners, { 1: w.bob.id });
    // ATTACH_FILES | EMBED_LINKS | MENTION_EVERYONE for DMs with other users
    assert.equal(BigInt(d.app_permissions), P.ATTACH_FILES | P.EMBED_LINKS | P.MENTION_EVERYONE);
    const res = await anon.post(`/interactions/${d.id}/${d.token}/callback`, { type: 4, data: { content: 'ephemeral here', flags: 64 } });
    assert.equal(res.status, 204);
  });

  test('a guild-only command is not offered to the banned user', async () => {
    w.c.registerCommand({ applicationId: w.app.id, command: { name: 'guildy', description: 'g', integration_types: [0], contexts: [0] } });
    assert.throws(() => w.c.runCommand({ applicationId: w.app.id, userId: w.bob.id, guildId: w.guildId, name: 'guildy' }));
    // And the user-installed command still reaches the bot afterwards.
    const r = w.c.runCommand({ applicationId: w.app.id, userId: w.bob.id, name: 'appeal' });
    await gc.waitForDispatch('INTERACTION_CREATE', (x) => x.id === r.id);
  });
});
