import http from 'node:http';
import { Router, Ctx } from './rest/context.js';
import { registerGuildRoutes, inviteJSON } from './rest/guilds.js';
import { registerChannelRoutes } from './rest/channels.js';
import { registerAppRoutes } from './rest/apps.js';
import { Interactions } from './interactions.js';
import { Gateway } from './gateway.js';
import { OAuth } from './oauth.js';
import { RateLimiter, rateLimitResponse } from './ratelimit.js';
import { Faults } from './faults.js';
import { DiscordError, Errors, formError } from './errors.js';
import { hmacHex, deepClone } from './util.js';

const DOCS = 'https://discord.com/developers/docs';

// ASSUMPTION: Discord's attachment links expire after ~24h; the exact policy is undocumented.
export const DEFAULT_CDN = { attachmentTtlMs: 24 * 60 * 60 * 1000, maxUploadBytes: 10 * 1024 * 1024 };

export class FakeServer {
  constructor({ world, ops, options }) {
    this.world = world;
    this.ops = ops;
    this.options = options;
    this.stub = !!options.stub;
    this.router = new Router();
    this.rateLimiter = new RateLimiter(world.clock, options.rateLimits);
    this.faults = new Faults();
    this.requestLog = [];
    this.cdnSecret = `cdn-${world.seed}`;
    this.cdn = { ...DEFAULT_CDN, ...(options.cdn ?? {}) };
    this.interactions = new Interactions({ world, ops, server: this, timings: options.interactions });
    this.gateway = new Gateway({ world, ops, server: this, options: options.gateway, stub: this.stub });
    this.oauth = new OAuth({ world, ops, server: this, options: options.oauth ?? {} });
    registerGuildRoutes(this.router);
    registerChannelRoutes(this.router);
    registerAppRoutes(this.router);
    this.interactions.register(this.router);
    world.cdnSign = (a) => this.signAttachment(a);
    this.http = http.createServer((req, res) => this.onRequest(req, res).catch((err) => this.internalError(res, err)));
    this.http.on('upgrade', (req, socket, head) => {
      if (req.url.startsWith('/_fake')) return socket.destroy();
      this.gateway.handleUpgrade(req, socket, head);
    });
    this.sockets = new Set();
    this.http.on('connection', (s) => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); });
  }

  async listen(port = 0, host = '127.0.0.1') {
    await new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(port, host, resolve);
    });
    const addr = this.http.address();
    const shownHost = this.options.publicHost ?? (host === '0.0.0.0' ? '127.0.0.1' : host);
    this.baseUrl = `http://${shownHost}:${addr.port}`;
    this.apiUrl = `${this.baseUrl}/api`;
    this.restUrl = `${this.baseUrl}/api/v10`;
    this.gatewayUrl = `ws://${shownHost}:${addr.port}/gateway`;
    this.oauthUrl = `${this.baseUrl}/oauth2`;
    this.cdnUrl = `${this.baseUrl}/cdn`;
    this.controlUrl = `${this.baseUrl}/_fake`;
    return addr.port;
  }

  async close() {
    this.gateway.closeAll(1001, 'Server shutting down', true);
    this.gateway.wss.close();
    for (const s of this.sockets) s.destroy();
    await new Promise((resolve) => this.http.close(() => resolve()));
  }

  // ---------------------------------------------------------------------------
  // HTTP entry point
  // ---------------------------------------------------------------------------
  async onRequest(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    if (path.startsWith('/_fake')) return this.control.handleHttp(req, res, url);
    if (this.stub) {
      // Stubbed handlers (contract-test red check): every Discord-facing request answers 200 {}.
      await readBody(req);
      this.requestLog.push({ seq: this.requestLog.length + 1, at: this.world.iso(), method: req.method, path, route: 'STUB', status: 200 });
      return this.send(res, { status: 200, body: {} });
    }
    if (path === '/' || path === '') return this.sendHtml(res, 200, this.indexPage());
    if (path.startsWith('/cdn/') || path.startsWith('/media-proxy/')) return this.serveCdn(req, res, url);
    if (await this.oauth.handle(req, res, url)) return;
    const m = path.match(/^\/api(?:\/v(\d+))?(\/.*)$/);
    if (!m) return this.send(res, { status: 404, body: Errors.notFound().toJSON() });
    return this.handleRest(req, res, url, m[1] ? Number(m[1]) : null, m[2]);
  }

  async handleRest(req, res, url, version, path) {
    const started = Date.now();
    const entry = {
      seq: this.requestLog.length + 1,
      at: this.world.iso(),
      method: req.method,
      path: `/api/v${version ?? ''}${path}`.replace('/api/v/', '/api/'),
      query: Object.fromEntries(url.searchParams),
      route: null,
      actor: null,
      reason: null,
      request: null,
      status: null,
      response: null,
      fault: null,
    };
    this.requestLog.push(entry);
    const finish = (out) => {
      entry.status = out.status;
      entry.response = out.body === undefined ? null : summarize(out.body);
      entry.duration_ms = Date.now() - started;
      if (out.drop) {
        entry.fault = 'drop';
        res.socket?.destroy();
        return;
      }
      this.send(res, out);
    };

    // ${DOCS}/reference#api-versioning
    if (version !== 10 && version !== 9) return finish({ status: 400, body: Errors.invalidApiVersion().toJSON() });

    let raw;
    try {
      raw = await readBody(req);
    } catch {
      return finish({ status: 400, body: Errors.invalidJson().toJSON() });
    }
    const matched = this.router.match(req.method, path);
    if (!matched) return finish({ status: 404, body: Errors.notFound().toJSON() });
    if (matched.methodNotAllowed) return finish({ status: 405, body: Errors.methodNotAllowed().toJSON() });
    const { route, params } = matched;
    entry.route = `${route.method} ${route.template}`;

    // ${DOCS}/reference#authentication
    const auth = this.authenticate(req.headers.authorization, route);
    if (auth.error) return finish(auth.error);
    const actor = auth.actor;
    entry.actor = actor ? describeActor(actor) : null;

    let parsed;
    try {
      parsed = parseBody(raw, req.headers['content-type']);
    } catch (err) {
      return finish(errorResponse(err));
    }
    entry.request = summarize(parsed.body ?? null, parsed.files);

    const faultReq = { method: req.method, template: route.template, path };
    // Drift hooks: change the world right before this request is handled.
    for (const h of this.faults.take('hook', faultReq)) {
      try { await h.fn?.({ world: this.world, control: this.control, method: req.method, path }); } catch (err) { entry.hook_error = String(err); }
      if (h.action) await this.control.call(h.action.method, h.action.args ?? {});
    }
    for (const d of this.faults.take('delay', faultReq)) await sleep(d.ms ?? 1000);
    const forcedError = this.faults.take('error', faultReq)[0];
    if (forcedError) {
      entry.fault = 'error';
      const status = forcedError.status ?? 500;
      return finish({ status, body: forcedError.body ?? { message: status >= 500 ? '500: Internal Server Error' : 'Injected error', code: 0 } });
    }
    const forcedLimit = this.faults.take('rateLimit', faultReq)[0];
    if (forcedLimit) {
      entry.fault = 'rateLimit';
      return finish(rateLimitResponse({ retryAfter: forcedLimit.retryAfter ?? 1, global: !!forcedLimit.global, scope: forcedLimit.scope ?? (forcedLimit.global ? 'global' : 'user') }));
    }

    // ${DOCS}/topics/rate-limits
    const identity = actor?.kind === 'bot' ? `app:${actor.app.id}` : actor?.kind === 'bearer' ? `bearer:${actor.token}` : `anon:${params.interaction_token ?? params.webhook_token ?? req.socket.remoteAddress}`;
    const rl = this.rateLimiter.check(identity, { method: req.method, template: route.template, params, global: route.global !== false && actor?.kind === 'bot' });
    if (rl.limited) {
      entry.fault = 'rateLimited';
      return finish(rateLimitResponse(rl.limited, rl.headers));
    }

    const dropFault = this.faults.take('drop', faultReq)[0];
    const out = this.execute({ route, params, query: Object.fromEntries(url.searchParams), body: parsed.body, files: parsed.files, actor, headers: req.headers, method: req.method, path });
    entry.reason = out.reason ?? null;
    out.headers = { ...rl.headers, ...(out.headers ?? {}) };
    if (dropFault) out.drop = true;
    finish(out);
  }

  authenticate(header, route) {
    const mode = route.auth ?? 'bot';
    if (mode === 'none') return { actor: null };
    if (!header) return { error: { status: 401, body: Errors.unauthorized().toJSON() } };
    const [scheme, token] = header.split(/\s+/, 2);
    if (/^bot$/i.test(scheme)) {
      const app = this.world.appByToken(token);
      if (!app) return { error: { status: 401, body: Errors.unauthorized().toJSON() } };
      return { actor: { kind: 'bot', app, userId: app.bot_user_id } };
    }
    if (/^bearer$/i.test(scheme)) {
      const grant = this.oauth.accessToken(token);
      if (!grant) return { error: { status: 401, body: Errors.unauthorized().toJSON() } };
      // Bearer tokens only work on routes that accept OAuth2 users.
      if (mode !== 'any') return { error: { status: 401, body: Errors.unauthorized().toJSON() } };
      return { actor: { kind: 'bearer', token, userId: grant.user_id, app: this.world.app(grant.application_id), scopes: grant.scopes } };
    }
    return { error: { status: 401, body: Errors.unauthorized().toJSON() } };
  }

  /** Run a matched route. Also used by control.actAs (no rate limits / faults). */
  execute({ route, params, query, body, files, actor, headers = {}, method, path }) {
    let reason;
    try {
      // ${DOCS}/resources/audit-log#audit-log-entry-object – X-Audit-Log-Reason, URL-encoded, 1-512 characters
      const rawReason = headers['x-audit-log-reason'];
      if (rawReason !== undefined && route.audit) {
        try { reason = decodeURIComponent(String(rawReason)); } catch { reason = String(rawReason); }
        // ASSUMPTION: an over-long reason is rejected as a form error rather than truncated.
        if ([...reason].length > 512) throw formError('reason', 'BASE_TYPE_MAX_LENGTH', 'Must be 512 or fewer in length.');
        if (reason.length === 0) reason = undefined;
      }
      const ctx = new Ctx({
        world: this.world, ops: this.ops, server: this, params, query: query ?? {}, body: body ?? {}, files: files ?? [],
        actor, reason, method, path, template: route.template,
      });
      const out = route.handler(ctx) ?? { status: 204 };
      return { ...out, reason };
    } catch (err) {
      return { ...errorResponse(err), reason };
    }
  }

  /** Execute a REST call as someone, bypassing HTTP (used by the control API). */
  executeAs(actor, method, path, { body, query, reason, files } = {}) {
    const p = path.replace(/^\/api(\/v\d+)?/, '');
    const matched = this.router.match(method, p.split('?')[0]);
    if (!matched || matched.methodNotAllowed) throw new Error(`no route for ${method} ${path}`);
    const headers = reason ? { 'x-audit-log-reason': encodeURIComponent(reason) } : {};
    const out = this.execute({ route: matched.route, params: matched.params, query, body, files, actor, headers, method, path: p });
    this.requestLog.push({
      seq: this.requestLog.length + 1, at: this.world.iso(), method, path: `/api/v10${p}`, route: `${matched.route.method} ${matched.route.template}`,
      actor: describeActor(actor), via: 'control', reason: reason ?? null, request: summarize(body ?? null), status: out.status, response: summarize(out.body ?? null),
    });
    return out;
  }

  send(res, { status, headers = {}, body }) {
    if (res.headersSent) return;
    const h = { ...headers };
    let payload = '';
    if (body !== undefined && status !== 204) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    res.writeHead(status, h);
    res.end(payload);
  }

  sendHtml(res, status, html) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  internalError(res, err) {
    console.error('[discord-test-server] internal error', err);
    if (!res.headersSent) this.send(res, { status: 500, body: { message: '500: Internal Server Error', code: 0, error: String(err?.stack ?? err) } });
  }

  // ---------------------------------------------------------------------------
  // Messages, attachments, CDN
  // ---------------------------------------------------------------------------
  /** Message JSON as an app sees it over REST: no MESSAGE_CONTENT privilege -> content redacted. */
  messageForApp(msg, ctx) {
    const json = this.world.messageJSON(msg);
    if (ctx.actor?.kind === 'bot' && !ctx.actor.app.privileged.message_content) {
      // ${DOCS}/events/gateway#message-content-intent – applies "across the APIs"
      return this.world.redactMessage(json, ctx.actor.app.bot_user_id);
    }
    return json;
  }

  inviteJSON(inv) { return inviteJSON(this.world, inv); }

  /** Store uploaded files; returns attachment ids. meta = body.attachments ([{ id: index, filename, description }]). */
  storeUploads(channelId, files, meta = []) {
    const ids = [];
    for (const f of files ?? []) {
      const idx = Number((f.field.match(/files\[(\d+)\]/) ?? [])[1] ?? ids.length);
      const m = (meta ?? []).find((a) => String(a.id) === String(idx)) ?? {};
      if (f.data.length > this.cdn.maxUploadBytes) throw Errors.entityTooLarge();
      const id = this.world.id();
      this.world.state.attachments[id] = {
        id, channel_id: channelId, filename: m.filename ?? f.filename ?? 'file', description: m.description,
        content_type: f.contentType ?? 'application/octet-stream', size: f.data.length, data: f.data.toString('base64'),
        issued_at: this.world.now(),
      };
      ids.push(id);
    }
    return ids;
  }

  /** Attachment from the control API: { filename, contentType, data: string|Buffer, base64?: bool } */
  storeAttachment(channelId, { filename, contentType = 'application/octet-stream', data = '', base64 = false, description }) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), base64 ? 'base64' : 'utf8');
    const id = this.world.id();
    this.world.state.attachments[id] = {
      id, channel_id: channelId, filename, description, content_type: contentType, size: buf.length, data: buf.toString('base64'), issued_at: this.world.now(),
    };
    return id;
  }

  // Signed-looking URLs: ?ex=<expiry hex>&is=<issued hex>&hm=<hmac>& (Discord's format since 2023; the exact
  // signing scheme is private – ours is an HMAC of path + ex + is).
  signAttachment(a) {
    if (!this.cdnUrl) return null;
    const issued = Math.floor(this.world.now() / 1000);
    const expiry = Math.floor((this.world.now() + this.cdn.attachmentTtlMs) / 1000);
    const path = `/attachments/${a.channel_id}/${a.id}/${encodeURIComponent(a.filename)}`;
    const ex = expiry.toString(16);
    const is = issued.toString(16);
    const hm = hmacHex(this.cdnSecret, `${path}|${ex}|${is}`);
    return `${this.cdnUrl}${path}?ex=${ex}&is=${is}&hm=${hm}&`;
  }

  serveCdn(req, res, url) {
    const path = url.pathname.replace(/^\/cdn/, '').replace(/^\/media-proxy/, '');
    const gone = () => { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('This content is no longer available.'); };
    const am = path.match(/^\/attachments\/(\d+)\/(\d+)\/([^/]+)$/);
    if (am) {
      const a = this.world.state.attachments[am[2]];
      if (!a || a.channel_id !== am[1]) return gone();
      const ex = url.searchParams.get('ex');
      const is = url.searchParams.get('is');
      const hm = url.searchParams.get('hm');
      if (!ex || !is || !hm) return gone();
      if (hmacHex(this.cdnSecret, `${path}|${ex}|${is}`) !== hm) return gone();
      if (parseInt(ex, 16) * 1000 < this.world.now()) return gone();
      const buf = Buffer.from(a.data, 'base64');
      res.writeHead(200, { 'Content-Type': a.content_type, 'Content-Length': buf.length });
      return res.end(buf);
    }
    // Avatars and other images: a 1x1 PNG.
    if (/^\/(avatars|icons|embed\/avatars|banners|role-icons)\//.test(path)) {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      return res.end(png);
    }
    return gone();
  }

  indexPage() {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const apps = Object.values(this.world.state.applications);
    const guilds = Object.values(this.world.state.guilds);
    return `<!doctype html><meta charset="utf-8"><title>discord-test-server</title>
<style>body{font:14px system-ui;margin:2rem;max-width:60rem}code{background:#eee;padding:0 .2rem}td,th{text-align:left;padding:.2rem .6rem}</style>
<h1>discord-test-server</h1><p>A fake Discord for tests. Not affiliated with Discord.</p>
<ul><li>REST: <code>${esc(this.restUrl)}</code></li><li>Gateway: <code>${esc(this.gatewayUrl)}</code></li>
<li>OAuth2: <code>${esc(this.oauthUrl)}/authorize</code></li><li>CDN: <code>${esc(this.cdnUrl)}</code></li>
<li>Control: <code>${esc(this.controlUrl)}</code> (<a href="/_fake/state">state</a>, <a href="/_fake/log">request log</a>, <a href="/_fake/gateway-log">gateway log</a>)</li></ul>
<h2>Applications</h2><table><tr><th>name</th><th>id</th></tr>${apps.map((a) => `<tr><td>${esc(a.name)}</td><td>${a.id}</td></tr>`).join('')}</table>
<h2>Guilds</h2><table><tr><th>name</th><th>id</th><th>members</th></tr>${guilds.map((g) => `<tr><td>${esc(g.name)}</td><td>${g.id}</td><td>${Object.keys(g.members).length}</td></tr>`).join('')}</table>`;
  }
}

// ---------------------------------------------------------------------------
function errorResponse(err) {
  if (err instanceof DiscordError) return { status: err.status, body: err.toJSON() };
  throw err;
}

function describeActor(a) {
  if (!a) return null;
  if (a.kind === 'bot') return { kind: 'bot', application_id: a.app.id, user_id: a.userId };
  if (a.kind === 'bearer') return { kind: 'bearer', application_id: a.app?.id, user_id: a.userId, scopes: a.scopes };
  return { kind: a.kind, user_id: a.userId };
}

function summarize(body, files) {
  const out = body === null || body === undefined ? null : deepClone(body);
  if (files?.length) return { body: out, files: files.map((f) => ({ field: f.field, filename: f.filename, content_type: f.contentType, size: f.data.length })) };
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ${DOCS}/reference#uploading-files – multipart/form-data with payload_json and files[n]
export function parseBody(raw, contentType = '') {
  if (!raw.length) return { body: undefined, files: [] };
  const ct = contentType.toLowerCase();
  if (ct.startsWith('multipart/form-data')) {
    const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!boundary) throw Errors.invalidFormBody();
    const parts = parseMultipart(raw, boundary[1] ?? boundary[2]);
    let body = {};
    const files = [];
    for (const p of parts) {
      if (p.name === 'payload_json') {
        try { body = JSON.parse(p.data.toString('utf8')); } catch { throw Errors.invalidJson(); }
      } else if (p.filename !== undefined) {
        files.push({ field: p.name, filename: p.filename, contentType: p.contentType, data: p.data });
      } else {
        body[p.name] = p.data.toString('utf8');
      }
    }
    return { body, files };
  }
  if (ct.startsWith('application/x-www-form-urlencoded')) {
    return { body: Object.fromEntries(new URLSearchParams(raw.toString('utf8'))), files: [] };
  }
  try {
    return { body: JSON.parse(raw.toString('utf8')), files: [] };
  } catch {
    throw Errors.invalidJson();
  }
}

function parseMultipart(buf, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    const start = pos + delim.length;
    if (buf.slice(start, start + 2).toString() === '--') break;
    const next = buf.indexOf(delim, start);
    if (next === -1) break;
    let chunk = buf.slice(start, next);
    if (chunk.slice(0, 2).toString() === '\r\n') chunk = chunk.slice(2);
    if (chunk.slice(-2).toString() === '\r\n') chunk = chunk.slice(0, -2);
    const headerEnd = chunk.indexOf('\r\n\r\n');
    const headerText = chunk.slice(0, headerEnd).toString('utf8');
    const data = chunk.slice(headerEnd + 4);
    const disp = headerText.match(/content-disposition:[^\r\n]*/i)?.[0] ?? '';
    const name = disp.match(/\bname="([^"]*)"/i)?.[1];
    const filename = disp.match(/\bfilename="([^"]*)"/i)?.[1];
    const contentType = headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1];
    parts.push({ name, filename, contentType, data });
    pos = next;
  }
  return parts;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
