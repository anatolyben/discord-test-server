// Autocomplete – https://discord.com/developers/docs/interactions/application-commands#autocomplete
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, client, GatewayClient } from './helpers.js';
import { Intents as I } from '../src/constants.js';

describe('autocomplete interactions', () => {
  let w, gc, anon;
  before(async () => {
    w = await world({ rateLimits: false });
    anon = client(w.fake, null);
    gc = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc.ready(w.app.token, I.GUILDS);
    w.c.registerCommand({
      applicationId: w.app.id,
      command: {
        name: 'tag', description: 'Show a tag',
        options: [
          { name: 'name', description: 'Tag name', type: 3, autocomplete: true },
          { name: 'note', description: 'A note', type: 3 },
          { name: 'sub', description: 'Sub', type: 1, options: [{ name: 'deep', description: 'Deep', type: 3, autocomplete: true }] },
        ],
      },
    });
  });
  after(async () => { gc.close(); await w.fake.close(); });

  const run = (extra) => w.c.runAutocomplete({ applicationId: w.app.id, userId: w.alice.id, guildId: w.guildId, channelId: w.channelId, name: 'tag', ...extra });

  test('runAutocomplete -> INTERACTION_CREATE type 4 with the focused option and the other options as typed so far', async () => {
    const { id } = run({ options: { name: 'wel', note: 'x' }, focused: 'name' });
    const ev = await gc.waitForDispatch('INTERACTION_CREATE', (d) => d.id === id);
    assert.equal(ev.d.type, 4);
    assert.equal(ev.d.data.name, 'tag');
    assert.equal(ev.d.data.type, 1);
    const name = ev.d.data.options.find((o) => o.name === 'name');
    assert.deepEqual(name, { name: 'name', type: 3, value: 'wel', focused: true });
    assert.equal(ev.d.data.options.find((o) => o.name === 'note').focused, undefined);
    assert.equal(ev.d.guild_id, w.guildId);
    assert.equal(ev.d.member.user.id, w.alice.id);
  });

  test('the focused option can sit inside a sub-command', async () => {
    const { id } = run({ options: [{ name: 'sub', type: 1, options: [{ name: 'deep', type: 3, value: 'ab', focused: true }] }] });
    const ev = await gc.waitForDispatch('INTERACTION_CREATE', (d) => d.id === id);
    assert.equal(ev.d.data.options[0].options[0].focused, true);
  });

  test('only options registered with autocomplete: true can be focused; unknown commands and options are refused', () => {
    assert.throws(() => run({ options: { note: 'x' }, focused: 'note' }), /autocomplete/);
    assert.throws(() => run({ options: { name: 'x' } }), /focused/);
    assert.throws(() => run({ name: 'nope', options: { name: 'x' }, focused: 'name' }), /no .*command/);
  });

  test('the bot answers with callback type 8: up to 25 choices; they are readable from the control API', async () => {
    const { id } = run({ options: { name: 'wel' }, focused: 'name' });
    const rec = w.c.getInteraction({ interactionId: id });
    const choices = [{ name: 'welcome', value: 'welcome' }, { name: 'Welcome back', value: 'welcome-back', name_localizations: { de: 'Willkommen' } }];
    const r = await anon.post(`/interactions/${id}/${rec.token}/callback`, { type: 8, data: { choices } });
    assert.equal(r.status, 204);
    assert.deepEqual(w.c.getAutocompleteChoices({ interactionId: id }), choices);
    assert.equal(w.c.getUserView({ interactionId: id }).status, 'responded');
    assert.equal((await anon.post(`/interactions/${id}/${rec.token}/callback`, { type: 8, data: { choices } })).body.code, 40060);
  });

  test('more than 25 choices, bad choice shapes and a message response to an autocomplete -> 400', async () => {
    const mk = () => { const { id } = run({ options: { name: 'a' }, focused: 'name' }); return { id, token: w.c.getInteraction({ interactionId: id }).token }; };
    const many = Array.from({ length: 26 }, (_, i) => ({ name: `c${i}`, value: `c${i}` }));
    let i = mk();
    assert.equal((await anon.post(`/interactions/${i.id}/${i.token}/callback`, { type: 8, data: { choices: many } })).body.code, 50035);
    assert.equal((await anon.post(`/interactions/${i.id}/${i.token}/callback`, { type: 8, data: { choices: [{ name: '', value: 'x' }] } })).body.code, 50035);
    assert.equal((await anon.post(`/interactions/${i.id}/${i.token}/callback`, { type: 8, data: { choices: [{ name: 'ok' }] } })).body.code, 50035);
    i = mk();
    const bad = await anon.post(`/interactions/${i.id}/${i.token}/callback`, { type: 4, data: { content: 'hi' } });
    assert.equal(bad.status, 400);
    // after the 3 second deadline the answer is too late
    i = mk();
    w.c.advance(3500);
    assert.equal((await anon.post(`/interactions/${i.id}/${i.token}/callback`, { type: 8, data: { choices: [] } })).status, 404);
  });

  test('choices are not required to be strings: integer and number values are accepted', async () => {
    const { id } = run({ options: { name: 'a' }, focused: 'name' });
    const tok = w.c.getInteraction({ interactionId: id }).token;
    const r = await anon.post(`/interactions/${id}/${tok}/callback`, { type: 8, data: { choices: [{ name: 'one', value: 1 }, { name: 'half', value: 0.5 }] } });
    assert.equal(r.status, 204);
  });
});
