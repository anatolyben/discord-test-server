// Shared helpers for the contract tests.
//
// Set DTS_STUB=1 to run every test against stubbed handlers (REST answers 200 {}, the gateway
// ignores everything after HELLO). `npm run test:red` does that and checks that every test fails.
import WebSocket from 'ws';
import { createFakeDiscord } from '../src/index.js';

export const STUB = process.env.DTS_STUB === '1';
export const START = Date.parse('2026-03-01T12:00:00.000Z');

/** Start a server with a manual clock (deterministic) unless overridden. */
export async function start(options = {}) {
  return createFakeDiscord({ clock: 'manual', now: START, stub: STUB, ...options, gateway: { heartbeatIntervalMs: 2000, ...(options.gateway ?? {}) } });
}

/**
 * A small world: owner, moderator (Moderator role), two members, a bot app installed with `botPermissions`
 * whose role sits above Moderator. Returns ids and handy clients.
 */
export async function world(options = {}) {
  const fake = await start(options);
  const c = fake.control;
  const owner = c.createUser({ username: 'owner' });
  const mod = c.createUser({ username: 'mod' });
  const alice = c.createUser({ username: 'alice' });
  const bob = c.createUser({ username: 'bob' });
  const app = c.createApplication({
    name: 'TestBot', ownerId: owner.id, redirectUris: ['http://localhost:3000/cb'],
    privilegedIntents: options.privilegedIntents ?? { guildMembers: true, messageContent: true },
  });
  const g = c.createGuild({ name: 'Guild A', ownerId: owner.id });
  const modRole = c.createRole({ guildId: g.id, name: 'Moderator', permissions: ['KICK_MEMBERS', 'BAN_MEMBERS', 'MODERATE_MEMBERS', 'MANAGE_MESSAGES', 'VIEW_AUDIT_LOG', 'MANAGE_ROLES'] });
  const memberRole = c.createRole({ guildId: g.id, name: 'Member', permissions: [] });
  c.addMember({ guildId: g.id, userId: mod.id, roles: [modRole.id] });
  c.addMember({ guildId: g.id, userId: alice.id, roles: [memberRole.id] });
  c.addMember({ guildId: g.id, userId: bob.id, roles: [] });
  c.installBot({ applicationId: app.id, guildId: g.id, permissions: options.botPermissions ?? ['ADMINISTRATOR'] });
  c.setBotRolePosition({ applicationId: app.id, guildId: g.id, position: 100 });
  const botRole = c.getRoles({ guildId: g.id }).find((r) => r.tags?.bot_id === app.bot_user_id);
  const rest = client(fake, `Bot ${app.token}`);
  return { fake, c, owner, mod, alice, bob, app, g, guildId: g.id, channelId: g.system_channel_id, modRole, memberRole, botRole, rest };
}

/** fetch-based REST client: returns { status, headers, body }. */
export function client(fake, authorization) {
  const call = async (method, path, body, { headers = {}, raw } = {}) => {
    const h = { ...headers };
    if (authorization) h.Authorization = authorization;
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(`${fake.restUrl}${path}`, { method, headers: h, body: payload });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, headers: Object.fromEntries(res.headers), body: json };
  };
  return {
    get: (p, o) => call('GET', p, undefined, o),
    post: (p, b, o) => call('POST', p, b, o),
    patch: (p, b, o) => call('PATCH', p, b, o),
    put: (p, b, o) => call('PUT', p, b, o),
    delete: (p, o) => call('DELETE', p, undefined, o),
    call,
  };
}

/** Raw gateway client that records every frame. */
export class GatewayClient {
  constructor(url) {
    this.url = url;
    this.frames = [];
    this.waiters = [];
    this.closed = null;
  }

  static async connect(url, query = '?v=10&encoding=json') {
    const gc = new GatewayClient(url);
    await gc.open(query);
    return gc;
  }

  open(query) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${this.url}${query}`);
      this.ws.on('message', (data) => {
        const f = JSON.parse(data.toString());
        this.frames.push(f);
        if (f.s) this.seq = f.s;
        this.check();
      });
      this.ws.on('close', (code, reason) => { this.closed = { code, reason: reason.toString() }; this.check(); });
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
  }

  send(op, d) { this.ws.send(JSON.stringify({ op, d })); }
  sendRaw(s) { this.ws.send(s); }

  identify(token, intents, extra = {}) {
    this.send(2, { token, intents, properties: { os: 'linux', browser: 'test', device: 'test' }, ...extra });
  }

  check() {
    this.waiters = this.waiters.filter((w) => {
      const hit = w.pred();
      if (hit !== undefined && hit !== false) { clearTimeout(w.timer); w.resolve(hit); return false; }
      return true;
    });
  }

  waitFor(pred, timeoutMs = 1500, label = 'condition') {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`timed out waiting for ${label}; got ${this.frames.map((f) => f.t ?? `op${f.op}`).join(',')}${this.closed ? ` closed=${this.closed.code}` : ''}`));
      }, timeoutMs);
      this.waiters.push(w);
      this.check();
    });
  }

  waitForOp(op, timeoutMs) { return this.waitFor(() => this.frames.find((f) => f.op === op), timeoutMs, `op ${op}`); }
  waitForDispatch(t, pred = () => true, timeoutMs) {
    return this.waitFor(() => this.frames.find((f) => f.t === t && pred(f.d)), timeoutMs, `dispatch ${t}`);
  }
  waitForClose(timeoutMs) { return this.waitFor(() => this.closed ?? undefined, timeoutMs, 'close'); }
  dispatches(t) { return this.frames.filter((f) => f.op === 0 && (!t || f.t === t)); }

  /** Identify and wait for READY plus all GUILD_CREATEs. */
  async ready(token, intents, extra = {}) {
    await this.waitForOp(10);
    this.identify(token, intents, extra);
    const ready = await this.waitForDispatch('READY');
    const ids = ready.d.guilds.map((g) => g.id);
    if (intents & 1) await this.waitFor(() => ids.every((id) => this.dispatches('GUILD_CREATE').some((f) => f.d.id === id)) || undefined, 1500, 'GUILD_CREATEs');
    return ready.d;
  }

  /** Wait a little and assert nothing matching arrived. */
  async expectNone(t, pred = () => true, ms = 150) {
    await new Promise((r) => setTimeout(r, ms));
    return this.frames.filter((f) => f.t === t && pred(f.d));
  }

  close(code = 1000) { try { this.ws.close(code); } catch {} }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const DAY = 24 * 60 * 60 * 1000;
