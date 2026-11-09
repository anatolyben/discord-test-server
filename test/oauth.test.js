// OAuth2 contract – https://discord.com/developers/docs/topics/oauth2
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { world, client, GatewayClient } from './helpers.js';
import { Intents as I, Permissions as P, ALL_PERMISSIONS } from '../src/constants.js';

const REDIRECT = 'http://localhost:3000/cb';

function authorizeUrl(fake, params) {
  const u = new URL(`${fake.url}/oauth2/authorize`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

async function authorize(fake, params) {
  const res = await fetch(authorizeUrl(fake, params), { redirect: 'manual' });
  const location = res.headers.get('location');
  return { status: res.status, location: location ? new URL(location) : null, text: await res.text(), contentType: res.headers.get('content-type') };
}

async function token(fake, form, { basic, url = `${fake.restUrl}/oauth2/token` } = {}) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (basic) headers.Authorization = `Basic ${Buffer.from(`${basic[0]}:${basic[1]}`).toString('base64')}`;
  const res = await fetch(url, { method: 'POST', headers, body: new URLSearchParams(form).toString() });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function codeFor(w, scope = 'identify guilds', extra = {}) {
  const r = await authorize(w.fake, { response_type: 'code', client_id: w.app.id, scope, redirect_uri: REDIRECT, state: 's1', ...extra });
  assert.equal(r.status, 302, r.text);
  return r.location.searchParams.get('code');
}

// https://discord.com/developers/docs/topics/oauth2#authorization-code-grant
describe('authorize', () => {
  let w;
  before(async () => {
    w = await world();
    w.c.setOAuthUser({ userId: w.alice.id });
  });
  after(() => w.fake.close());

  test('auto-approves as the OAuth test user and redirects with code, state and iss', async () => {
    const r = await authorize(w.fake, { response_type: 'code', client_id: w.app.id, scope: 'identify guilds', redirect_uri: REDIRECT, state: 'xyz' });
    assert.equal(r.status, 302);
    assert.equal(`${r.location.origin}${r.location.pathname}`, REDIRECT);
    assert.match(r.location.searchParams.get('code'), /^\w{10,}$/);
    assert.equal(r.location.searchParams.get('state'), 'xyz');
    // https://discord.com/developers/docs/topics/oauth2#issuer-identification
    assert.equal(r.location.searchParams.get('iss'), 'https://discord.com');
    assert.equal(r.location.searchParams.get('guild_id'), null);
  });

  test('unknown client_id -> error page, no redirect', async () => {
    const r = await authorize(w.fake, { response_type: 'code', client_id: '123456789012345678', scope: 'identify', redirect_uri: REDIRECT });
    assert.equal(r.status, 400);
    assert.equal(r.location, null);
    assert.match(r.contentType, /text\/html/);
  });

  test('unregistered redirect_uri -> error page, never redirects there', async () => {
    const r = await authorize(w.fake, { response_type: 'code', client_id: w.app.id, scope: 'identify', redirect_uri: 'http://evil.example/cb' });
    assert.equal(r.status, 400);
    assert.equal(r.location, null);
    assert.match(r.text, /redirect_uri/);
  });

  // RFC 6749 §4.1.2.1 error responses (Discord follows them).
  test('unknown scope -> redirect with error=invalid_scope and state', async () => {
    const r = await authorize(w.fake, { response_type: 'code', client_id: w.app.id, scope: 'identify nonsense', redirect_uri: REDIRECT, state: 'st' });
    assert.equal(r.status, 302);
    assert.equal(r.location.searchParams.get('error'), 'invalid_scope');
    assert.equal(r.location.searchParams.get('state'), 'st');
    assert.equal(r.location.searchParams.get('code'), null);
  });

  test('consent mode shows a form; POST /oauth2/authorize completes or cancels', async () => {
    w.c.setOAuthMode({ mode: 'consent' });
    try {
      const page = await authorize(w.fake, { response_type: 'code', client_id: w.app.id, scope: 'identify', redirect_uri: REDIRECT, state: 'c1' });
      assert.equal(page.status, 200);
      assert.match(page.contentType, /text\/html/);
      assert.match(page.text, /<form method="post" action="\/oauth2\/authorize">/);
      assert.match(page.text, /name="decision" value="authorize"/);
      const hidden = Object.fromEntries([...page.text.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&')]));
      assert.equal(hidden.client_id, w.app.id);
      const post = (decision) => fetch(`${w.fake.url}/oauth2/authorize`, {
        method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...hidden, user_id: w.bob.id, decision }).toString(),
      });
      const ok = await post('authorize');
      assert.equal(ok.status, 302);
      const loc = new URL(ok.headers.get('location'));
      assert.equal(loc.searchParams.get('state'), 'c1');
      const tok = await token(w.fake, { grant_type: 'authorization_code', code: loc.searchParams.get('code'), redirect_uri: REDIRECT }, { basic: [w.app.id, w.app.client_secret] });
      assert.equal(tok.status, 200);
      const me = await client(w.fake, `Bearer ${tok.body.access_token}`).get('/users/@me');
      assert.equal(me.body.id, w.bob.id, 'signed in as the user picked on the consent page');
      const cancel = await post('cancel');
      assert.equal(cancel.status, 302);
      assert.equal(new URL(cancel.headers.get('location')).searchParams.get('error'), 'access_denied');
    } finally {
      w.c.setOAuthMode({ mode: 'auto' });
    }
  });
});

// https://discord.com/developers/docs/topics/oauth2#authorization-code-grant-access-token-exchange-example
describe('token endpoint', () => {
  let w;
  before(async () => {
    w = await world();
    w.c.setOAuthUser({ userId: w.alice.id });
  });
  after(() => w.fake.close());

  test('code exchange with HTTP Basic client auth returns the access token response', async () => {
    const code = await codeFor(w);
    const r = await token(w.fake, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT }, { basic: [w.app.id, w.app.client_secret] });
    assert.equal(r.status, 200);
    assert.equal(r.body.token_type, 'Bearer');
    assert.equal(r.body.expires_in, 604800);
    assert.equal(r.body.scope, 'identify guilds');
    assert.equal(typeof r.body.access_token, 'string');
    assert.equal(typeof r.body.refresh_token, 'string');
  });

  // "All calls to the OAuth2 endpoints require either HTTP Basic authentication or client_id and client_secret supplied in the form data body."
  test('client credentials in the form body work too (on /api/oauth2/token)', async () => {
    const code = await codeFor(w);
    const r = await token(w.fake, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: w.app.id, client_secret: w.app.client_secret }, { url: `${w.fake.apiUrl}/oauth2/token` });
    assert.equal(r.status, 200);
    assert.ok(r.body.access_token);
  });

  test('wrong client secret -> 401 invalid_client', async () => {
    const code = await codeFor(w);
    const r = await token(w.fake, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT }, { basic: [w.app.id, 'wrong'] });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'invalid_client');
  });

  test('a reused, expired or mismatched code -> 400 invalid_grant', async () => {
    const basic = [w.app.id, w.app.client_secret];
    const code = await codeFor(w);
    assert.equal((await token(w.fake, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT }, { basic })).status, 200);
    const reused = await token(w.fake, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT }, { basic });
    assert.equal(reused.status, 400);
    assert.equal(reused.body.error, 'invalid_grant');

    const mismatched = await token(w.fake, { grant_type: 'authorization_code', code: await codeFor(w), redirect_uri: 'http://localhost:3000/other' }, { basic });
    assert.equal(mismatched.status, 400);
    assert.equal(mismatched.body.error, 'invalid_grant');

    const old = await codeFor(w);
    w.c.advance(60 * 60 * 1000);
    const expired = await token(w.fake, { grant_type: 'authorization_code', code: old, redirect_uri: REDIRECT }, { basic });
    assert.equal(expired.status, 400);
    assert.equal(expired.body.error, 'invalid_grant');
  });

  // https://discord.com/developers/docs/topics/oauth2#authorization-code-grant-refresh-token-exchange-example
  test('refresh_token grant rotates the refresh token', async () => {
    const basic = [w.app.id, w.app.client_secret];
    const first = (await token(w.fake, { grant_type: 'authorization_code', code: await codeFor(w), redirect_uri: REDIRECT }, { basic })).body;
    const refreshed = await token(w.fake, { grant_type: 'refresh_token', refresh_token: first.refresh_token }, { basic });
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshed.body.access_token, first.access_token);
    assert.notEqual(refreshed.body.refresh_token, first.refresh_token);
    assert.equal(refreshed.body.scope, 'identify guilds');
    const me = await client(w.fake, `Bearer ${refreshed.body.access_token}`).get('/users/@me');
    assert.equal(me.body.id, w.alice.id);
    const replay = await token(w.fake, { grant_type: 'refresh_token', refresh_token: first.refresh_token }, { basic });
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error, 'invalid_grant');
  });

  // "When you revoke a token, any active access or refresh tokens associated with that authorization will be revoked"
  // https://discord.com/developers/docs/topics/oauth2#authorization-code-grant-token-revocation-example
  test('revoking the access token (or the refresh token) revokes both', async () => {
    const basic = [w.app.id, w.app.client_secret];
    for (const which of ['access_token', 'refresh_token']) {
      const t = (await token(w.fake, { grant_type: 'authorization_code', code: await codeFor(w), redirect_uri: REDIRECT }, { basic })).body;
      const bearer = client(w.fake, `Bearer ${t.access_token}`);
      assert.equal((await bearer.get('/users/@me')).status, 200);
      const rv = await token(w.fake, { token: t[which], token_type_hint: which }, { basic, url: `${w.fake.restUrl}/oauth2/token/revoke` });
      assert.equal(rv.status, 200, which);
      assert.equal((await bearer.get('/users/@me')).status, 401, which);
      const refresh = await token(w.fake, { grant_type: 'refresh_token', refresh_token: t.refresh_token }, { basic });
      assert.equal(refresh.status, 400, which);
      assert.equal(refresh.body.error, 'invalid_grant');
    }
  });
});

// https://discord.com/developers/docs/resources/user#get-current-user
// https://discord.com/developers/docs/resources/user#get-current-user-guilds
describe('Bearer tokens', () => {
  let w;
  const basic = () => [w.app.id, w.app.client_secret];
  const bearerFor = async (userId, scope) => {
    w.c.setOAuthUser({ userId });
    const code = await codeFor(w, scope);
    const t = await token(w.fake, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT }, { basic: basic() });
    return client(w.fake, `Bearer ${t.body.access_token}`);
  };
  before(async () => { w = await world(); });
  after(() => w.fake.close());

  test('GET /users/@me needs identify', async () => {
    const b = await bearerFor(w.alice.id, 'identify');
    const me = await b.get('/users/@me');
    assert.equal(me.status, 200);
    assert.equal(me.body.id, w.alice.id);
    assert.equal(me.body.username, 'alice');
    assert.equal(me.body.email, undefined, 'email needs the email scope');
    const noIdentify = await bearerFor(w.alice.id, 'guilds');
    assert.equal((await noIdentify.get('/users/@me')).status, 401);
  });

  test('GET /users/@me/guilds needs guilds and returns partial guilds with owner and permissions', async () => {
    const b = await bearerFor(w.alice.id, 'identify guilds');
    const r = await b.get('/users/@me/guilds');
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);
    const g = r.body[0];
    assert.equal(g.id, w.guildId);
    assert.equal(g.name, 'Guild A');
    assert.equal(g.owner, false);
    assert.equal(BigInt(g.permissions) & P.MANAGE_GUILD, 0n);
    assert.ok(Array.isArray(g.features));
    assert.equal(g.channels, undefined, 'partial guild');

    const owner = await bearerFor(w.owner.id, 'guilds');
    const og = (await owner.get('/users/@me/guilds')).body[0];
    assert.equal(og.owner, true);
    assert.equal(BigInt(og.permissions), ALL_PERMISSIONS);

    const noGuilds = await bearerFor(w.alice.id, 'identify');
    assert.equal((await noGuilds.get('/users/@me/guilds')).status, 401);
  });

  test('Bearer tokens cannot call bot-only routes, and expire after expires_in', async () => {
    const b = await bearerFor(w.alice.id, 'identify guilds');
    assert.equal((await b.get(`/guilds/${w.guildId}/channels`)).status, 401);
    w.c.advance(604800 * 1000 + 1);
    assert.equal((await b.get('/users/@me')).status, 401);
  });
});

// https://discord.com/developers/docs/topics/oauth2#bot-authorization-flow
// https://discord.com/developers/docs/topics/oauth2#advanced-bot-authorization
describe('bot install', () => {
  let w;
  let app2;
  let gc1;
  let gc2;
  before(async () => {
    w = await world();
    app2 = w.c.createApplication({ name: 'Installer', ownerId: w.owner.id, redirectUris: [REDIRECT] });
    gc1 = await GatewayClient.connect(w.fake.gatewayUrl);
    await gc1.ready(w.app.token, I.GUILDS | I.GUILD_MEMBERS | I.GUILD_MODERATION);
    gc2 = await GatewayClient.connect(w.fake.gatewayUrl);
    const ready = await gc2.ready(app2.token, I.GUILDS);
    assert.deepEqual(ready.guilds, []);
  });
  after(() => { gc1?.close(); gc2?.close(); return w.fake.close(); });

  test('a user without MANAGE_GUILD is refused with access_denied', async () => {
    w.c.setOAuthUser({ userId: w.alice.id });
    const r = await authorize(w.fake, { client_id: app2.id, scope: 'bot', permissions: '8', guild_id: w.guildId, redirect_uri: REDIRECT, state: 'b0' });
    assert.equal(r.status, 302);
    assert.equal(r.location.searchParams.get('error'), 'access_denied');
    assert.equal(r.location.searchParams.get('state'), 'b0');
    const members = await w.rest.get(`/guilds/${w.guildId}/members/${app2.bot_user_id}`);
    assert.equal(members.status, 404);
  });

  test('scope bot adds the bot with a managed role, GUILD_CREATE, GUILD_MEMBER_ADD and a BOT_ADD audit entry', async () => {
    w.c.setOAuthUser({ userId: w.owner.id });
    const perms = (P.KICK_MEMBERS | P.BAN_MEMBERS | P.VIEW_CHANNEL).toString();
    const r = await authorize(w.fake, { response_type: 'code', client_id: app2.id, scope: 'bot identify', permissions: perms, guild_id: w.guildId, redirect_uri: REDIRECT, state: 'b1' });
    assert.equal(r.status, 302);
    assert.equal(r.location.searchParams.get('guild_id'), w.guildId);
    assert.equal(r.location.searchParams.get('permissions'), perms);
    assert.equal(r.location.searchParams.get('state'), 'b1');

    const created = await gc2.waitForDispatch('GUILD_CREATE', (d) => d.id === w.guildId);
    assert.equal(created.d.unavailable, false);
    const add = await gc1.waitForDispatch('GUILD_MEMBER_ADD', (d) => d.user.id === app2.bot_user_id);
    assert.equal(add.d.guild_id, w.guildId);
    assert.equal(add.d.user.bot, true);

    const member = await w.rest.get(`/guilds/${w.guildId}/members/${app2.bot_user_id}`);
    assert.equal(member.status, 200);
    const roles = (await w.rest.get(`/guilds/${w.guildId}/roles`)).body;
    const managed = roles.find((x) => member.body.roles.includes(x.id));
    assert.ok(managed, 'bot has a role');
    assert.equal(managed.managed, true);
    assert.equal(managed.tags.bot_id, app2.bot_user_id);
    assert.equal(managed.permissions, perms);
    assert.equal(managed.name, 'Installer');

    const audit = await w.rest.get(`/guilds/${w.guildId}/audit-logs?action_type=28`);
    assert.equal(audit.status, 200);
    const entry = audit.body.audit_log_entries.find((e) => e.target_id === app2.bot_user_id);
    assert.ok(entry, 'BOT_ADD entry');
    assert.equal(entry.user_id, w.owner.id);

    // The code exchange returns the guild ("Extended Bot Authorization Access Token Example").
    const t = await token(w.fake, { grant_type: 'authorization_code', code: r.location.searchParams.get('code'), redirect_uri: REDIRECT }, { basic: [app2.id, app2.client_secret] });
    assert.equal(t.status, 200);
    assert.equal(t.body.guild.id, w.guildId);
    assert.equal(t.body.scope, 'bot identify');

    // The newly installed bot can now use REST in that guild.
    const asBot = client(w.fake, `Bot ${app2.token}`);
    assert.equal((await asBot.get(`/guilds/${w.guildId}/channels`)).status, 200);
  });
});
