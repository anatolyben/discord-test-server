import { computePermissions } from './permissions.js';
import { Permissions as P, AuditLogEvent as A } from './constants.js';
import { toBits } from './util.js';

const DOCS = 'https://discord.com/developers/docs';

// OAuth2 – ${DOCS}/topics/oauth2
// ${DOCS}/topics/oauth2#shared-resources-oauth2-scopes (only the ones the fake implements)
const KNOWN_SCOPES = new Set(['identify', 'email', 'guilds', 'guilds.members.read', 'bot', 'applications.commands', 'connections', 'role_connections.write']);
// ${DOCS}/topics/oauth2#authorization-code-grant-access-token-response – expires_in 604800
const ACCESS_TTL_MS = 604800 * 1000;
// ASSUMPTION: authorization codes live 10 minutes (not documented).
const CODE_TTL_MS = 10 * 60 * 1000;

export class OAuth {
  constructor({ world, ops, server, options }) {
    this.world = world;
    this.ops = ops;
    this.server = server;
    // mode 'auto': approve immediately as the scripted test user; 'consent': show a minimal consent page.
    this.mode = options.mode ?? 'auto';
    this.actingUserId = options.userId ?? null;
    this.defaultGuildId = options.guildId ?? null;
  }

  setUser(userId, { guildId } = {}) {
    this.actingUserId = userId;
    if (guildId !== undefined) this.defaultGuildId = guildId;
  }

  accessToken(token) {
    const g = this.world.state.oauth.access[token];
    if (!g || g.expires_at <= this.world.now()) return null;
    return g;
  }

  async handle(req, res, url) {
    const p = url.pathname;
    if (/^(\/api(\/v\d+)?)?\/oauth2\/authorize\/?$/.test(p)) {
      if (req.method === 'GET') return this.authorizeGet(req, res, url), true;
      if (req.method === 'POST') return this.authorizePost(req, res), true;
    }
    if (/^\/api(\/v\d+)?\/oauth2\/token\/?$/.test(p) && req.method === 'POST') return this.token(req, res), true;
    if (/^\/api(\/v\d+)?\/oauth2\/token\/revoke\/?$/.test(p) && req.method === 'POST') return this.revoke(req, res), true;
    if (/^\/api(\/v\d+)?\/oauth2\/@me\/?$/.test(p) && req.method === 'GET') return this.me(req, res), true;
    return false;
  }

  // ---------------------------------------------------------------------------
  // GET /oauth2/authorize – ${DOCS}/topics/oauth2#authorization-code-grant
  // ---------------------------------------------------------------------------
  authorizeGet(req, res, url) {
    const q = Object.fromEntries(url.searchParams);
    const checked = this.checkAuthorizeRequest(q);
    if (checked.page) return this.page(res, checked.status ?? 400, checked.page);
    if (checked.redirect) return this.redirect(res, checked.redirect);
    this.log(req, url.pathname, q);
    if (this.mode === 'consent') return this.page(res, 200, this.consentPage(q, checked));
    const userId = this.actingUserId;
    if (!userId || !this.world.user(userId)) {
      return this.page(res, 400, 'No OAuth2 test user is set. Call control.setOAuthUser({ userId }) or use oauth mode "consent".');
    }
    return this.approve(res, q, checked, userId, q.guild_id ?? this.defaultGuildId);
  }

  async authorizePost(req, res) {
    const raw = await new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString())); });
    const form = Object.fromEntries(new URLSearchParams(raw));
    const checked = this.checkAuthorizeRequest(form);
    if (checked.page) return this.page(res, checked.status ?? 400, checked.page);
    if (checked.redirect) return this.redirect(res, checked.redirect);
    this.log(req, '/oauth2/authorize', form);
    if (form.decision !== 'authorize') {
      if (checked.redirectUri) return this.redirect(res, withParams(checked.redirectUri, { error: 'access_denied', error_description: 'The resource owner or authorization server denied the request', state: form.state }));
      return this.page(res, 200, 'Authorization cancelled.');
    }
    return this.approve(res, form, checked, form.user_id, form.guild_id);
  }

  checkAuthorizeRequest(q) {
    const app = this.world.app(q.client_id);
    if (!app) return { page: `Unknown application (client_id=${escapeHtml(q.client_id ?? '')}).` };
    const scopes = String(q.scope ?? '').split(/[\s+]+/).filter(Boolean);
    let redirectUri = q.redirect_uri;
    // ${DOCS}/topics/oauth2#authorization-code-grant – redirect_uri must match one registered for the app.
    if (redirectUri && !app.redirect_uris.includes(redirectUri)) return { page: 'Invalid OAuth2 redirect_uri', status: 400 };
    if (!redirectUri && q.response_type === 'code') {
      if (app.redirect_uris.length === 1) redirectUri = app.redirect_uris[0];
      else return { page: 'Invalid OAuth2 redirect_uri', status: 400 };
    }
    const err = (error, description) => (redirectUri
      ? { redirect: withParams(redirectUri, { error, error_description: description, state: q.state }) }
      : { page: `${error}: ${description}` });
    if (!scopes.length) return err('invalid_scope', 'The requested scope is invalid, unknown, or malformed.');
    const unknown = scopes.filter((s) => !KNOWN_SCOPES.has(s));
    if (unknown.length) return err('invalid_scope', `The requested scope is invalid, unknown, or malformed: ${unknown.join(' ')}`);
    const onlyInstall = scopes.every((s) => s === 'bot' || s === 'applications.commands');
    if (q.response_type && q.response_type !== 'code') return err('unsupported_response_type', 'The authorization server does not support obtaining an authorization code using this method.');
    if (!q.response_type && !onlyInstall) return err('invalid_request', 'response_type is required.');
    const integrationType = q.integration_type === undefined ? 0 : Number(q.integration_type);
    // ${DOCS}/resources/application#installation-context – user installs only support applications.commands
    if (integrationType === 1 && scopes.includes('bot')) return err('invalid_scope', 'The bot scope cannot be used with a user install.');
    let permissions = 0n;
    try { permissions = toBits(q.permissions ?? 0); } catch { return err('invalid_request', 'Invalid permissions.'); }
    return { app, scopes, redirectUri, integrationType, permissions };
  }

  approve(res, q, { app, scopes, redirectUri, integrationType, permissions }, userId, guildId) {
    const user = this.world.user(userId);
    if (!user) return this.page(res, 400, 'Unknown user.');
    const deny = (description) => (redirectUri
      ? this.redirect(res, withParams(redirectUri, { error: 'access_denied', error_description: description, state: q.state }))
      : this.page(res, 403, description));
    let guild = null;
    if (scopes.includes('bot') || (scopes.includes('applications.commands') && integrationType === 0 && guildId)) {
      guild = this.world.guild(guildId);
      if (!guild) return deny('A guild must be selected (guild_id).');
      // Only users with MANAGE_GUILD can add a bot ("Manage Server" in the client).
      if (!guild.members[userId] || !(computePermissions(this.world, guild.id, userId) & P.MANAGE_GUILD)) {
        return deny('You need the Manage Server permission in this server to add this application.');
      }
      if (guild.bans[app.bot_user_id]) return deny('The bot is banned from this server.');
    }
    if (scopes.includes('bot')) this.installBot({ app, guildId: guild.id, permissions, installerId: userId });
    if (scopes.includes('applications.commands') && integrationType === 1) {
      // ${DOCS}/resources/application#installation-context – user install
      (this.world.state.userInstalls[app.id] ??= {})[userId] = { installed_at: this.world.iso(), scopes };
    }
    if (q.response_type === 'code') {
      const code = this.world.rng.chars(30);
      this.world.state.oauth.codes[code] = {
        code, application_id: app.id, user_id: userId, scopes, redirect_uri: redirectUri, guild_id: guild?.id ?? null,
        permissions: permissions.toString(), expires_at: this.world.now() + CODE_TTL_MS, integration_type: integrationType,
      };
      // ${DOCS}/topics/oauth2#advanced-bot-authorization – the redirect also carries guild_id and permissions.
      const params = { code, state: q.state };
      if (scopes.includes('bot')) { params.guild_id = guild.id; params.permissions = permissions.toString(); }
      return this.redirect(res, withParams(redirectUri, params));
    }
    if (redirectUri && guild) return this.redirect(res, withParams(redirectUri, { guild_id: guild.id, permissions: permissions.toString(), state: q.state }));
    return this.page(res, 200, guild ? `${escapeHtml(app.name)} was added to ${escapeHtml(guild.name)}.` : `${escapeHtml(app.name)} was authorized.`);
  }

  /**
   * Add the app's bot to a guild with `permissions` as its managed role.
   * Emits GUILD_ROLE_CREATE, GUILD_MEMBER_ADD and GUILD_CREATE (to the bot), and a BOT_ADD audit entry.
   * ${DOCS}/topics/oauth2#bot-authorization-flow
   */
  installBot({ app, guildId, permissions = 0n, installerId = null, rolePosition }) {
    const g = this.world.guild(guildId);
    if (g.members[app.bot_user_id]) {
      const managed = Object.values(g.roles).find((r) => r.tags?.bot_id === app.bot_user_id);
      if (managed && permissions !== 0n) this.ops.updateRole(guildId, managed.id, { permissions }, { actorId: installerId });
      return g.members[app.bot_user_id];
    }
    let roles = [];
    if (toBits(permissions) !== 0n) {
      // ASSUMPTION: the managed role is created at position 1 unless rolePosition is given.
      const role = this.ops.createRole(guildId, {
        name: app.name, permissions: toBits(permissions), managed: true, tags: { bot_id: app.bot_user_id }, position: rolePosition ?? 1,
      }, { actorId: installerId });
      roles = [role.id];
    }
    this.ops.audit(guildId, { actorId: installerId, action_type: A.BOT_ADD, target_id: app.bot_user_id });
    return this.ops.addMember(guildId, app.bot_user_id, { roles });
  }

  // ---------------------------------------------------------------------------
  // POST /oauth2/token – ${DOCS}/topics/oauth2#authorization-code-grant-access-token-exchange-example
  // ---------------------------------------------------------------------------
  async token(req, res) {
    const raw = await readAll(req);
    const form = parseForm(raw, req.headers['content-type']);
    const app = this.clientAuth(req, form);
    if (!app) return this.json(res, 401, { error: 'invalid_client' }, req, form);
    const now = this.world.now();
    const grant = form.grant_type;
    if (grant === 'authorization_code') {
      const c = this.world.state.oauth.codes[form.code];
      if (!c || c.application_id !== app.id || c.expires_at <= now) return this.json(res, 400, { error: 'invalid_grant', error_description: `Invalid "code" in request.` }, req, form);
      if (c.redirect_uri && form.redirect_uri !== c.redirect_uri) return this.json(res, 400, { error: 'invalid_grant', error_description: 'Invalid "redirect_uri" in request.' }, req, form);
      delete this.world.state.oauth.codes[form.code];
      const out = this.issue(app, c.user_id, c.scopes);
      if (c.guild_id && c.scopes.includes('bot')) out.guild = this.world.guildJSON(this.world.guild(c.guild_id));
      return this.json(res, 200, out, req, form);
    }
    if (grant === 'refresh_token') {
      const r = this.world.state.oauth.refresh[form.refresh_token];
      if (!r || r.application_id !== app.id) return this.json(res, 400, { error: 'invalid_grant' }, req, form);
      delete this.world.state.oauth.refresh[form.refresh_token];
      return this.json(res, 200, this.issue(app, r.user_id, r.scopes), req, form);
    }
    if (grant === 'client_credentials') {
      // ${DOCS}/topics/oauth2#client-credentials-grant – a token for the app owner.
      const scopes = String(form.scope ?? 'identify').split(/[\s+]+/).filter((s) => s && s !== 'bot');
      const out = this.issue(app, app.owner_id, scopes, { refresh: false });
      return this.json(res, 200, out, req, form);
    }
    return this.json(res, 400, { error: 'unsupported_grant_type' }, req, form);
  }

  issue(app, userId, scopes, { refresh = true } = {}) {
    const access = this.world.rng.chars(30);
    const out = { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, scope: scopes.join(' ') };
    this.world.state.oauth.access[access] = { application_id: app.id, user_id: userId, scopes, expires_at: this.world.now() + ACCESS_TTL_MS };
    if (refresh) {
      const r = this.world.rng.chars(30);
      out.refresh_token = r;
      this.world.state.oauth.refresh[r] = { application_id: app.id, user_id: userId, scopes, access_token: access };
      this.world.state.oauth.access[access].refresh_token = r;
    }
    return out;
  }

  // ${DOCS}/topics/oauth2#authorization-code-grant-token-revocation-example
  // "revoking either the access token or refresh token revokes both"
  async revoke(req, res) {
    const raw = await readAll(req);
    const form = parseForm(raw, req.headers['content-type']);
    const app = this.clientAuth(req, form);
    if (!app) return this.json(res, 401, { error: 'invalid_client' }, req, form);
    const st = this.world.state.oauth;
    const a = st.access[form.token];
    const r = st.refresh[form.token];
    if (a && a.application_id === app.id) { delete st.refresh[a.refresh_token]; delete st.access[form.token]; }
    if (r && r.application_id === app.id) { delete st.access[r.access_token]; delete st.refresh[form.token]; }
    return this.json(res, 200, {}, req, form);
  }

  // ${DOCS}/topics/oauth2#get-current-authorization-information
  me(req, res) {
    const [scheme, token] = String(req.headers.authorization ?? '').split(/\s+/, 2);
    const g = /^bearer$/i.test(scheme) ? this.accessToken(token) : null;
    if (!g) return this.json(res, 401, { message: '401: Unauthorized', code: 0 }, req, null);
    const app = this.world.app(g.application_id);
    const out = {
      application: { id: app.id, name: app.name, icon: null, description: app.description ?? '', bot_public: app.bot_public, bot_require_code_grant: false, verify_key: app.public_key },
      scopes: g.scopes,
      expires: this.world.iso(g.expires_at),
    };
    if (g.scopes.includes('identify')) out.user = this.world.userJSON(g.user_id);
    return this.json(res, 200, out, req, null);
  }

  clientAuth(req, form) {
    let id = form.client_id;
    let secret = form.client_secret;
    const h = req.headers.authorization;
    if (h && /^basic\s/i.test(h)) {
      const [u, pw] = Buffer.from(h.split(/\s+/)[1], 'base64').toString().split(':');
      id = decodeURIComponent(u); secret = decodeURIComponent(pw ?? '');
    }
    const app = this.world.app(id);
    return app && app.client_secret === secret ? app : null;
  }

  // ---------------------------------------------------------------------------
  json(res, status, body, req, form) {
    this.server.requestLog.push({
      seq: this.server.requestLog.length + 1, at: this.world.iso(), method: req.method, path: new URL(req.url, 'http://x').pathname,
      route: 'OAUTH2', request: form ? redactSecrets(form) : null, status, response: body,
    });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  log(req, path, q) {
    this.server.requestLog.push({ seq: this.server.requestLog.length + 1, at: this.world.iso(), method: req.method, path, route: 'OAUTH2 authorize', request: q });
  }

  redirect(res, location) {
    // ${DOCS}/topics/oauth2#issuer-identification – "Every authorization response that Discord redirects to your
    // redirect_uri includes an iss parameter set to https://discord.com" (RFC 9207).
    const u = new URL(location);
    if (!u.searchParams.has('iss')) u.searchParams.set('iss', 'https://discord.com');
    location = u.toString();
    res.writeHead(302, { Location: location });
    res.end();
  }

  page(res, status, message) {
    this.server.sendHtml(res, status, `<!doctype html><meta charset="utf-8"><title>discord-test-server OAuth2</title><body style="font:15px system-ui;margin:2rem"><p id="message">${message}</p></body>`);
  }

  consentPage(q, { app, scopes }) {
    const users = Object.values(this.world.state.users).filter((u) => !u.bot);
    const guilds = Object.values(this.world.state.guilds);
    const hidden = Object.entries(q).filter(([k]) => !['user_id', 'guild_id', 'decision'].includes(k))
      .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('');
    const opt = (id, label, sel) => `<option value="${id}"${sel ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    return `<h1>Authorize ${escapeHtml(app.name)}</h1>
<p>Scopes: <code>${escapeHtml(scopes.join(' '))}</code></p>
<form method="post" action="/oauth2/authorize">${hidden}
<label>Sign in as <select name="user_id">${users.map((u) => opt(u.id, u.username, u.id === this.actingUserId)).join('')}</select></label><br><br>
${scopes.includes('bot') || q.guild_id ? `<label>Add to server <select name="guild_id">${guilds.map((g) => opt(g.id, g.name, g.id === (q.guild_id ?? this.defaultGuildId))).join('')}</select></label><br><br>` : ''}
<button name="decision" value="authorize" id="authorize">Authorize</button>
<button name="decision" value="cancel" id="cancel">Cancel</button></form>`;
  }
}

function withParams(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return u.toString();
}

function readAll(req) {
  return new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString())); });
}

function parseForm(raw, ct = '') {
  if (String(ct).includes('application/json')) { try { return JSON.parse(raw); } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(raw));
}

function redactSecrets(form) {
  const out = { ...form };
  if (out.client_secret) out.client_secret = '[redacted]';
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
