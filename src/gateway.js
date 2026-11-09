import { WebSocketServer } from 'ws';
import zlib from 'node:zlib';
import {
  GatewayOp as OP, GatewayClose as CLOSE, Intents as I, ALL_INTENTS, PRIVILEGED_INTENTS, Permissions as P,
  ChannelType, THREAD_TYPES,
} from './constants.js';
import { computePermissions } from './permissions.js';
import { deepClone } from './util.js';

const DOCS = 'https://discord.com/developers/docs';

// ${DOCS}/events/gateway – connection lifecycle, sharding, intents, resuming.
export const DEFAULT_GATEWAY_OPTIONS = {
  // ${DOCS}/events/gateway-events#hello – Discord currently sends 41250 ms.
  heartbeatIntervalMs: 41250,
  // ASSUMPTION: the docs do not say how long Discord waits for a heartbeat before closing a zombie
  // connection, nor with which code. Defaults: interval * 1.5, close code 4009 (Session timed out).
  heartbeatTimeoutMs: null,
  heartbeatTimeoutCloseCode: CLOSE.SESSION_TIMED_OUT,
  // ${DOCS}/events/gateway#sharding-max-concurrency – "Each shard can only be in 2500 guilds".
  maxGuildsPerShard: 2500,
  // ${DOCS}/events/gateway#session-start-limit-object
  sessionStartLimit: { total: 1000, max_concurrency: 1, resetAfterMs: 24 * 60 * 60 * 1000 },
  // ASSUMPTION: how many dispatches are kept for RESUME, and how long a disconnected session stays resumable.
  maxBufferedDispatches: 5000,
  resumeWindowMs: Infinity,
  // ${DOCS}/events/gateway#connecting – v must be 10 here; ASSUMPTION: v9 is also accepted (still served by Discord).
  acceptedVersions: [9, 10],
};

// Intent required for each dispatch – ${DOCS}/events/gateway#list-of-intents
const GUILD_INTENT = {
  GUILD_CREATE: I.GUILDS, GUILD_UPDATE: I.GUILDS, GUILD_DELETE: I.GUILDS,
  GUILD_ROLE_CREATE: I.GUILDS, GUILD_ROLE_UPDATE: I.GUILDS, GUILD_ROLE_DELETE: I.GUILDS,
  CHANNEL_CREATE: I.GUILDS, CHANNEL_UPDATE: I.GUILDS, CHANNEL_DELETE: I.GUILDS, CHANNEL_PINS_UPDATE: I.GUILDS,
  THREAD_CREATE: I.GUILDS, THREAD_UPDATE: I.GUILDS, THREAD_DELETE: I.GUILDS, THREAD_LIST_SYNC: I.GUILDS,
  GUILD_MEMBER_ADD: I.GUILD_MEMBERS, GUILD_MEMBER_UPDATE: I.GUILD_MEMBERS, GUILD_MEMBER_REMOVE: I.GUILD_MEMBERS,
  GUILD_AUDIT_LOG_ENTRY_CREATE: I.GUILD_MODERATION, GUILD_BAN_ADD: I.GUILD_MODERATION, GUILD_BAN_REMOVE: I.GUILD_MODERATION,
  INVITE_CREATE: I.GUILD_INVITES, INVITE_DELETE: I.GUILD_INVITES,
  MESSAGE_CREATE: I.GUILD_MESSAGES, MESSAGE_UPDATE: I.GUILD_MESSAGES, MESSAGE_DELETE: I.GUILD_MESSAGES, MESSAGE_DELETE_BULK: I.GUILD_MESSAGES,
  AUTO_MODERATION_RULE_CREATE: I.AUTO_MODERATION_CONFIGURATION, AUTO_MODERATION_RULE_UPDATE: I.AUTO_MODERATION_CONFIGURATION,
  AUTO_MODERATION_RULE_DELETE: I.AUTO_MODERATION_CONFIGURATION, AUTO_MODERATION_ACTION_EXECUTION: I.AUTO_MODERATION_EXECUTION,
};
const DM_INTENT = {
  MESSAGE_CREATE: I.DIRECT_MESSAGES, MESSAGE_UPDATE: I.DIRECT_MESSAGES, MESSAGE_DELETE: I.DIRECT_MESSAGES, CHANNEL_PINS_UPDATE: I.DIRECT_MESSAGES,
};

export class Gateway {
  constructor({ world, ops, server, options = {}, stub = false }) {
    this.world = world;
    this.ops = ops;
    this.server = server;
    this.opts = { ...DEFAULT_GATEWAY_OPTIONS, ...options };
    this.stub = stub;
    this.sessions = new Map(); // sessionId -> session
    this.connections = new Set();
    this.frames = []; // readable log of every frame in and out
    this.frameSeq = 0;
    this.startLimits = new Map(); // applicationId -> { remaining, resetAt }
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    world.on('dispatch', (ev) => this.onDispatch(ev));
    world.on('bot-joined', ({ guildId, applicationId }) => this.onBotJoined(guildId, applicationId));
    world.on('reset', () => this.closeAll(CLOSE.UNKNOWN_ERROR, 'world reset', true));
  }

  handleUpgrade(req, socket, head) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }

  // ---------------------------------------------------------------------------
  // Connections
  // ---------------------------------------------------------------------------
  onConnection(ws, req) {
    const url = new URL(req.url, 'http://x');
    const conn = {
      id: `conn_${++this.frameSeq}`,
      ws,
      session: null,
      identified: false,
      lastHeartbeat: Date.now(),
      timer: null,
      zlibStream: null,
      payloadCompression: false,
      closed: false,
    };
    this.connections.add(conn);
    if (this.stub) {
      // Stubbed handler (contract-test red check): accept the socket and do nothing at all.
      ws.on('message', (data) => this.logFrame(conn, 'in', { op: null, d: data.toString().slice(0, 200) }));
      ws.on('close', () => this.connections.delete(conn));
      ws.on('error', () => {});
      return;
    }
    const v = Number(url.searchParams.get('v') ?? 10);
    const encoding = url.searchParams.get('encoding') ?? 'json';
    const compress = url.searchParams.get('compress');
    ws.on('close', (code) => this.onClose(conn, code));
    ws.on('error', () => {});
    // ${DOCS}/events/gateway#connecting – query params v, encoding, compress
    if (!this.opts.acceptedVersions.includes(v)) return this.close(conn, CLOSE.INVALID_API_VERSION, 'Invalid API version');
    if (encoding !== 'json') return this.close(conn, CLOSE.DECODE_ERROR, 'Only encoding=json is supported by the fake');
    if (compress === 'zlib-stream') {
      conn.zlibStream = zlib.createDeflate({ flush: zlib.constants.Z_SYNC_FLUSH });
      conn.zlibChunks = [];
      conn.zlibStream.on('data', (c) => conn.zlibChunks.push(c));
    } else if (compress) {
      return this.close(conn, CLOSE.DECODE_ERROR, `Unsupported compression ${compress}`);
    }
    ws.on('message', (data) => this.onMessage(conn, data));
    // ${DOCS}/events/gateway-events#hello
    this.send(conn, { op: OP.HELLO, d: { heartbeat_interval: this.opts.heartbeatIntervalMs, _trace: ['["discord-test-server"]'] } });
    this.armHeartbeat(conn);
  }

  armHeartbeat(conn) {
    clearTimeout(conn.timer);
    const timeout = this.opts.heartbeatTimeoutMs ?? Math.round(this.opts.heartbeatIntervalMs * 1.5);
    conn.timer = setTimeout(() => {
      this.close(conn, this.opts.heartbeatTimeoutCloseCode, 'Missed heartbeat');
    }, timeout);
    conn.timer.unref?.();
  }

  onClose(conn, code) {
    conn.closed = true;
    clearTimeout(conn.timer);
    this.connections.delete(conn);
    this.logFrame(conn, 'close', { op: null, d: { code } });
    const s = conn.session;
    if (s && s.conn === conn) {
      s.conn = null;
      s.disconnectedAt = this.world.now();
      // ${DOCS}/events/gateway#disconnecting – "If you close with 1000 or 1001, your session will be invalidated"
      if (code === 1000 || code === 1001 || s.invalidated) this.sessions.delete(s.id);
    }
  }

  close(conn, code, reason) {
    if (conn.closed) return;
    this.logFrame(conn, 'out', { op: null, d: { close: code, reason } });
    if (conn.session && NON_RESUMABLE.has(code)) conn.session.invalidated = true;
    try { conn.ws.close(code, reason); } catch { conn.ws.terminate(); }
  }

  onMessage(conn, raw) {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      this.logFrame(conn, 'in', { op: null, d: raw.toString().slice(0, 200) });
      return this.close(conn, CLOSE.DECODE_ERROR, 'Error while decoding payload.');
    }
    this.logFrame(conn, 'in', payload);
    const { op, d } = payload ?? {};
    switch (op) {
      case OP.HEARTBEAT:
        conn.lastHeartbeat = Date.now();
        this.armHeartbeat(conn);
        // ${DOCS}/events/gateway#sending-heartbeats – answer with HEARTBEAT_ACK
        this.send(conn, { op: OP.HEARTBEAT_ACK });
        return;
      case OP.IDENTIFY:
        return this.identify(conn, d);
      case OP.RESUME:
        return this.resume(conn, d);
      case OP.PRESENCE_UPDATE:
      case OP.VOICE_STATE_UPDATE:
      case OP.REQUEST_GUILD_MEMBERS:
      case OP.REQUEST_SOUNDBOARD_SOUNDS:
        if (!conn.identified) return this.close(conn, CLOSE.NOT_AUTHENTICATED, 'Not authenticated.');
        if (op === OP.REQUEST_GUILD_MEMBERS) return this.requestGuildMembers(conn, d);
        return;
      default:
        return this.close(conn, CLOSE.UNKNOWN_OPCODE, 'Unknown opcode.');
    }
  }

  // ${DOCS}/events/gateway-events#identify
  identify(conn, d) {
    if (conn.identified) return this.close(conn, CLOSE.ALREADY_AUTHENTICATED, 'Already authenticated.');
    if (!d || typeof d !== 'object') return this.close(conn, CLOSE.DECODE_ERROR, 'Error while decoding payload.');
    const token = String(d.token ?? '').replace(/^Bot\s+/i, '');
    const app = this.world.appByToken(token);
    if (!app) return this.close(conn, CLOSE.AUTHENTICATION_FAILED, 'Authentication failed.');
    const intents = d.intents;
    // ${DOCS}/events/gateway#gateway-intents – intents are required in v10; unknown bits are invalid (4013).
    if (!Number.isInteger(intents) || intents < 0 || (intents & ~ALL_INTENTS) !== 0) {
      return this.close(conn, CLOSE.INVALID_INTENTS, 'Invalid intent(s).');
    }
    // ${DOCS}/events/gateway#privileged-intents – 4014 when a privileged intent isn't enabled.
    const allowed = (app.privileged.guild_members ? I.GUILD_MEMBERS : 0)
      | (app.privileged.guild_presences ? I.GUILD_PRESENCES : 0)
      | (app.privileged.message_content ? I.MESSAGE_CONTENT : 0);
    if ((intents & PRIVILEGED_INTENTS & ~allowed) !== 0) return this.close(conn, CLOSE.DISALLOWED_INTENTS, 'Disallowed intent(s).');
    const shard = d.shard ?? [0, 1];
    if (!Array.isArray(shard) || shard.length !== 2 || !Number.isInteger(shard[0]) || !Number.isInteger(shard[1])
      || shard[1] < 1 || shard[0] < 0 || shard[0] >= shard[1]) {
      return this.close(conn, CLOSE.INVALID_SHARD, 'Invalid shard.');
    }
    const guilds = this.guildsForShard(app, shard);
    if (guilds.length > this.opts.maxGuildsPerShard) return this.close(conn, CLOSE.SHARDING_REQUIRED, 'Sharding required.');
    const limit = this.sessionStartLimit(app.id);
    if (limit.remaining <= 0) return this.close(conn, CLOSE.AUTHENTICATION_FAILED, 'Session start limit reached.'); // ASSUMPTION
    this.startLimits.get(app.id).remaining--;

    const session = {
      id: this.world.rng.hex(32),
      app,
      intents,
      shard,
      seq: 0,
      buffer: [],
      conn,
      largeThreshold: Math.min(250, Math.max(50, d.large_threshold ?? 50)),
      properties: d.properties ?? {},
      createdAt: this.world.now(),
      invalidated: false,
    };
    this.sessions.set(session.id, session);
    conn.session = session;
    conn.identified = true;
    if (d.compress === true && !conn.zlibStream) conn.payloadCompression = true;
    // ${DOCS}/events/gateway-events#ready
    const user = this.world.userJSON(app.bot_user_id);
    user.verified = true;
    user.mfa_enabled = false;
    this.dispatchTo(session, 'READY', {
      v: 10,
      user_settings: {},
      user,
      guilds: guilds.map((g) => ({ id: g.id, unavailable: true })),
      session_type: 'normal',
      session_id: session.id,
      resume_gateway_url: this.server.gatewayUrl,
      shard,
      application: { id: app.id, flags: this.world.appFlags(app) },
      private_channels: [],
      presences: [],
      relationships: [],
      guild_join_requests: [],
      geo_ordered_rtc_regions: ['fake'],
      _trace: ['["discord-test-server"]'],
    });
    // ${DOCS}/events/gateway-events#guild-create – lazily backfills the unavailable guilds from READY.
    for (const g of guilds) this.sendGuildCreate(session, g.id);
  }

  // ${DOCS}/events/gateway-events#resume
  resume(conn, d) {
    if (conn.identified) return this.close(conn, CLOSE.ALREADY_AUTHENTICATED, 'Already authenticated.');
    const token = String(d?.token ?? '').replace(/^Bot\s+/i, '');
    const app = this.world.appByToken(token);
    if (!app) return this.close(conn, CLOSE.AUTHENTICATION_FAILED, 'Authentication failed.');
    const s = this.sessions.get(d?.session_id);
    const expired = s && s.disconnectedAt !== undefined && s.conn === null && this.world.now() - s.disconnectedAt > this.opts.resumeWindowMs;
    if (!s || s.app.id !== app.id || s.invalidated || expired) {
      // ${DOCS}/events/gateway-events#invalid-session – d: whether the session may be resumable
      this.sessions.delete(d?.session_id);
      return this.send(conn, { op: OP.INVALID_SESSION, d: false });
    }
    const seq = Number(d.seq ?? 0);
    if (!Number.isInteger(seq) || seq > s.seq) return this.close(conn, CLOSE.INVALID_SEQ, 'Invalid seq.');
    const oldest = s.buffer[0]?.s ?? s.seq + 1;
    if (seq + 1 < oldest) {
      this.sessions.delete(s.id);
      return this.send(conn, { op: OP.INVALID_SESSION, d: false });
    }
    if (s.conn && s.conn !== conn) this.close(s.conn, CLOSE.UNKNOWN_ERROR, 'Session resumed elsewhere');
    s.conn = conn;
    s.disconnectedAt = undefined;
    conn.session = s;
    conn.identified = true;
    // Replay everything after `seq`, then RESUMED.
    for (const entry of s.buffer) if (entry.s > seq) this.send(conn, entry.frame);
    this.dispatchTo(s, 'RESUMED', { _trace: ['["discord-test-server"]'] });
  }

  // ${DOCS}/events/gateway-events#request-guild-members (minimal: query prefix / user_ids)
  requestGuildMembers(conn, d) {
    const s = conn.session;
    const g = this.world.guild(d?.guild_id);
    if (!g || !g.members[s.app.bot_user_id]) return;
    if (!(s.intents & I.GUILD_MEMBERS) && (d.query === '' || !d.user_ids)) {
      return this.close(conn, CLOSE.DISALLOWED_INTENTS, 'Disallowed intent(s).');
    }
    let ids = Object.keys(g.members);
    if (d.user_ids) ids = ids.filter((id) => [].concat(d.user_ids).includes(id));
    else if (d.query) ids = ids.filter((id) => this.world.user(id).username.toLowerCase().startsWith(String(d.query).toLowerCase()));
    if (d.limit) ids = ids.slice(0, d.limit);
    this.dispatchTo(s, 'GUILD_MEMBERS_CHUNK', {
      guild_id: g.id, members: ids.map((id) => this.world.memberJSON(g.id, id)), chunk_index: 0, chunk_count: 1, nonce: d.nonce,
    });
  }

  // ---------------------------------------------------------------------------
  // Dispatch routing
  // ---------------------------------------------------------------------------
  shardOf(guildId, count) {
    // ${DOCS}/events/gateway#sharding – shard_id = (guild_id >> 22) % num_shards
    return Number((BigInt(guildId) >> 22n) % BigInt(count));
  }

  guildsForShard(app, shard) {
    return Object.values(this.world.state.guilds)
      .filter((g) => g.members[app.bot_user_id] && this.shardOf(g.id, shard[1]) === shard[0]);
  }

  sendGuildCreate(session, guildId) {
    if (!(session.intents & I.GUILDS)) return;
    const w = this.world;
    const g = w.guild(guildId);
    const bot = session.app.bot_user_id;
    const all = Object.keys(g.members);
    const large = all.length > session.largeThreshold;
    // "If your bot does not have the GUILD_PRESENCES Gateway Intent, or if the guild has over 75k members,
    // members and presences returned in this event will only contain your bot and users in voice channels."
    const memberIds = session.intents & I.GUILD_PRESENCES && !large ? all : [bot];
    const d = {
      ...w.guildJSON(g),
      joined_at: g.members[bot].joined_at,
      large,
      unavailable: false,
      member_count: all.length,
      voice_states: [],
      members: memberIds.map((id) => w.memberJSON(g.id, id)),
      channels: w.guildChannels(g.id).filter((c) => !THREAD_TYPES.has(c.type)).map((c) => w.channelJSON(c)),
      threads: w.guildChannels(g.id).filter((c) => THREAD_TYPES.has(c.type) && !c.thread_metadata?.archived
        && (computePermissions(w, g.id, bot, c.id) & P.VIEW_CHANNEL)).map((c) => w.channelJSON(c)),
      presences: [],
      stage_instances: [],
      guild_scheduled_events: [],
      soundboard_sounds: [],
      embedded_activities: [],
      application_command_counts: {},
      activity_instances: [],
    };
    this.dispatchTo(session, 'GUILD_CREATE', d);
  }

  onBotJoined(guildId, applicationId) {
    for (const s of this.sessions.values()) {
      if (s.app.id !== applicationId || s.invalidated) continue;
      if (this.shardOf(guildId, s.shard[1]) !== s.shard[0]) continue;
      this.sendGuildCreate(s, guildId);
    }
  }

  onDispatch(ev) {
    for (const s of this.sessions.values()) {
      if (s.invalidated) continue;
      const d = this.filterFor(s, ev);
      if (d !== undefined) this.dispatchTo(s, ev.t, d);
    }
  }

  /** Returns the payload this session should receive, or undefined if it receives nothing. */
  filterFor(s, ev) {
    const w = this.world;
    const app = s.app;
    const bot = app.bot_user_id;
    if (ev.applicationId && ev.applicationId !== app.id) return undefined;

    // DMs: shard 0 only – ${DOCS}/events/gateway#sharding ("DMs will only be sent to shard 0")
    if (ev.dmUserIds) {
      if (!ev.dmUserIds.includes(bot) || s.shard[0] !== 0) return undefined;
      const intent = DM_INTENT[ev.t];
      if (intent && !(s.intents & intent)) return undefined;
      return deepClone(ev.d); // DM content is never redacted
    }

    if (ev.guildId) {
      if (this.shardOf(ev.guildId, s.shard[1]) !== s.shard[0]) return undefined;
      const g = w.guild(ev.guildId);
      const inGuild = !!g?.members[bot];
      if (!inGuild && !ev.toRemovedBot && !ev.appEvent) return undefined;
    } else if (ev.applicationId && s.shard[0] !== 0) {
      // App-level events without a guild go to shard 0.
      return undefined;
    } else if (!ev.applicationId) {
      return undefined;
    }

    const intent = GUILD_INTENT[ev.t];
    if (intent) {
      // ${DOCS}/events/gateway#caveats – GUILD_MEMBER_UPDATE for the current user is sent regardless of GUILD_MEMBERS.
      const selfUpdate = ev.t === 'GUILD_MEMBER_UPDATE' && ev.subjectUserId === bot;
      if (!selfUpdate && !(s.intents & intent)) return undefined;
    }
    if (ev.guildId && !ev.toRemovedBot && !ev.appEvent) {
      const perms = computePermissions(w, ev.guildId, bot);
      // ${DOCS}/events/gateway-events#guild-audit-log-entry-create – requires VIEW_AUDIT_LOG
      if (ev.auditLog && !(perms & P.VIEW_AUDIT_LOG)) return undefined;
      // ${DOCS}/events/gateway-events#guild-ban-add / #guild-ban-remove – "only sent to bots with the BAN_MEMBERS or VIEW_AUDIT_LOG permission"
      if ((ev.t === 'GUILD_BAN_ADD' || ev.t === 'GUILD_BAN_REMOVE') && !(perms & (P.BAN_MEMBERS | P.VIEW_AUDIT_LOG))) return undefined;
      // ${DOCS}/events/gateway-events#auto-moderation-* – "sent to bot users which have the MANAGE_GUILD permission"
      if ((ev.autoModConfig || ev.autoModExecution) && !(perms & P.MANAGE_GUILD)) return undefined;
      // ASSUMPTION: message events are only delivered for channels the bot can view.
      if (ev.message && ev.channelId && w.channel(ev.channelId) && !(computePermissions(w, ev.guildId, bot, ev.channelId) & P.VIEW_CHANNEL)) return undefined;
    }

    let d = deepClone(ev.d);
    const hasContentIntent = (s.intents & I.MESSAGE_CONTENT) !== 0;
    if (ev.message && !hasContentIntent && (ev.t === 'MESSAGE_CREATE' || ev.t === 'MESSAGE_UPDATE')) {
      const extra = { guild_id: d.guild_id, member: d.member, channel_type: d.channel_type };
      d = { ...w.redactMessage(d, bot) };
      for (const [k, v] of Object.entries(extra)) if (v !== undefined) d[k] = v;
    }
    // ${DOCS}/events/gateway-events#auto-moderation-action-execution – content and matched_content need MESSAGE_CONTENT
    if (ev.t === 'AUTO_MODERATION_ACTION_EXECUTION' && !hasContentIntent) {
      d.content = '';
      d.matched_content = null;
    }
    return d;
  }

  dispatchTo(session, t, d) {
    session.seq++;
    const frame = { op: OP.DISPATCH, t, s: session.seq, d };
    session.buffer.push({ s: session.seq, frame });
    if (session.buffer.length > this.opts.maxBufferedDispatches) session.buffer.shift();
    if (session.conn && !session.conn.closed) this.send(session.conn, frame);
    else this.logFrame({ id: null, session }, 'buffered', frame);
  }

  send(conn, payload) {
    if (conn.closed || conn.ws.readyState !== 1) return;
    this.logFrame(conn, 'out', payload);
    const json = JSON.stringify(payload);
    if (conn.zlibStream) {
      conn.zlibStream.write(json);
      conn.zlibStream.flush(zlib.constants.Z_SYNC_FLUSH, () => {
        const buf = Buffer.concat(conn.zlibChunks);
        conn.zlibChunks = [];
        if (!conn.closed && conn.ws.readyState === 1) conn.ws.send(buf);
      });
    } else if (conn.payloadCompression && payload.op === OP.DISPATCH) {
      conn.ws.send(zlib.deflateSync(json));
    } else {
      conn.ws.send(json);
    }
  }

  logFrame(conn, direction, payload) {
    const s = conn.session;
    this.frames.push({
      seq: this.frames.length + 1,
      at: this.world.iso(),
      direction,
      connection: conn.id,
      session_id: s?.id ?? null,
      application_id: s?.app.id ?? null,
      shard: s?.shard ?? null,
      op: payload.op,
      t: payload.t ?? null,
      s: payload.s ?? null,
      d: payload.d === undefined ? null : deepClone(payload.d),
    });
  }

  // ---------------------------------------------------------------------------
  // Control hooks
  // ---------------------------------------------------------------------------
  sessionStartLimit(applicationId) {
    const now = this.world.now();
    let l = this.startLimits.get(applicationId);
    if (!l || now >= l.resetAt) {
      l = { remaining: this.opts.sessionStartLimit.total, resetAt: now + this.opts.sessionStartLimit.resetAfterMs };
      this.startLimits.set(applicationId, l);
    }
    return {
      total: this.opts.sessionStartLimit.total,
      remaining: l.remaining,
      reset_after: l.resetAt - now,
      max_concurrency: this.opts.sessionStartLimit.max_concurrency,
    };
  }

  findSessions({ sessionId, applicationId, shard } = {}) {
    return [...this.sessions.values()].filter((s) => (!sessionId || s.id === sessionId)
      && (!applicationId || s.app.id === applicationId)
      && (shard === undefined || s.shard[0] === shard));
  }

  listSessions() {
    return [...this.sessions.values()].map((s) => ({
      session_id: s.id, application_id: s.app.id, shard: s.shard, intents: s.intents, seq: s.seq,
      connected: !!s.conn && !s.conn.closed, invalidated: s.invalidated,
    }));
  }

  /** Close the WebSocket with `code`; the session stays resumable unless the code says otherwise. */
  closeSessions(filter, code = CLOSE.UNKNOWN_ERROR, reason = 'Closed by test') {
    const hit = this.findSessions(filter);
    for (const s of hit) if (s.conn) this.close(s.conn, code, reason);
    return hit.length;
  }

  /** Send INVALID_SESSION (op 9). With resumable=false the session is gone. */
  invalidateSessions(filter, resumable = false) {
    const hit = this.findSessions(filter);
    for (const s of hit) {
      if (!resumable) s.invalidated = true;
      if (s.conn) {
        this.send(s.conn, { op: OP.INVALID_SESSION, d: resumable });
        if (!resumable) { s.conn.identified = false; s.conn.session = null; s.conn = null; }
      }
      if (!resumable) this.sessions.delete(s.id);
    }
    return hit.length;
  }

  /** Send RECONNECT (op 7); the client is expected to reconnect and resume. */
  requestReconnect(filter) {
    const hit = this.findSessions(filter);
    for (const s of hit) if (s.conn) this.send(s.conn, { op: OP.RECONNECT, d: null });
    return hit.length;
  }

  /** Ask clients to heartbeat now (op 1 from the server). */
  requestHeartbeat(filter) {
    const hit = this.findSessions(filter);
    for (const s of hit) if (s.conn) this.send(s.conn, { op: OP.HEARTBEAT, d: s.seq });
    return hit.length;
  }

  closeAll(code = 1001, reason = 'Server shutting down', dropSessions = false) {
    for (const c of [...this.connections]) this.close(c, code, reason);
    if (dropSessions) this.sessions.clear();
  }

  resetLog() { this.frames = []; }
}

// ${DOCS}/topics/opcodes-and-status-codes#gateway-gateway-close-event-codes – "Reconnect" column false.
const NON_RESUMABLE = new Set([CLOSE.AUTHENTICATION_FAILED, CLOSE.INVALID_SHARD, CLOSE.SHARDING_REQUIRED,
  CLOSE.INVALID_API_VERSION, CLOSE.INVALID_INTENTS, CLOSE.DISALLOWED_INTENTS, CLOSE.INVALID_SEQ, CLOSE.SESSION_TIMED_OUT]);
