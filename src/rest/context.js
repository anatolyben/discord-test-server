import { Errors, DiscordError } from '../errors.js';
import { computePermissions, has } from '../permissions.js';
import { ChannelType, Permissions as P } from '../constants.js';
import { isSnowflake } from '../util.js';

// A tiny router: routes are 'METHOD /path/:param'. Templates use Discord's parameter names.
export class Router {
  constructor() {
    this.routes = [];
  }
  add(method, template, handler, meta = {}) {
    const parts = template.split('/').filter(Boolean);
    this.routes.push({ method, template, parts, handler, ...meta });
  }
  match(method, path) {
    // Segments are compared decoded: clients percent-encode them (discord-api-types sends /users/%40me).
    const segs = path.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
    let pathMatched = false;
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = r.parts[i];
        if (p.startsWith(':')) params[p.slice(1)] = segs[i];
        else if (p !== segs[i]) { ok = false; break; }
      }
      if (!ok) continue;
      // Literal segments must win over params (e.g. /members/search vs /members/:user_id).
      const literalScore = r.parts.filter((p) => !p.startsWith(':')).length;
      if (r.method !== method) { pathMatched = true; continue; }
      const best = this._best;
      if (!best || literalScore > best.score) this._best = { route: r, params, score: literalScore };
    }
    const found = this._best;
    this._best = null;
    if (found) return { route: found.route, params: found.params };
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

/**
 * Request context passed to every REST handler.
 * actor: { kind: 'bot', app, userId } | { kind: 'bearer', token, userId, app } | { kind: 'user', userId } (control actAs) | null
 */
export class Ctx {
  constructor({ world, ops, server, params, query, body, files, actor, reason, method, path, template }) {
    Object.assign(this, { world, ops, server, params, query, body, files, actor, reason, method, path, template });
  }

  get actorId() { return this.actor?.userId; }
  get app() { return this.actor?.app; }

  // ---- lookups that throw Discord's errors -----------------------------------
  // Unknown ids -> 10xxx (https://discord.com/developers/docs/topics/opcodes-and-status-codes#json)
  snowflakeParam(name, err) {
    const v = this.params[name];
    if (!isSnowflake(v)) throw err();
    return v;
  }

  /**
   * Guild the actor can see. Unknown guild -> 404/10004.
   * ASSUMPTION: a guild that exists but the caller is not in answers 403/50001 Missing Access
   * (what bots observe in practice; the docs do not spell it out).
   */
  guild(guildId = this.params.guild_id) {
    const g = isSnowflake(guildId) && this.world.guild(guildId);
    if (!g) throw Errors.unknownGuild();
    if (this.actorId && !g.members[this.actorId]) throw Errors.missingAccess();
    return g;
  }

  /** Channel the actor can view. Unknown -> 10003; not visible -> 50001. */
  channel(channelId = this.params.channel_id, { requireView = true } = {}) {
    const c = isSnowflake(channelId) && this.world.channel(channelId);
    if (!c) throw Errors.unknownChannel();
    if (c.type === ChannelType.DM) {
      if (this.actorId && !c.recipients.includes(this.actorId)) throw Errors.missingAccess();
      return c;
    }
    const g = this.world.guild(c.guild_id);
    if (this.actorId && !g.members[this.actorId]) throw Errors.missingAccess();
    if (requireView && this.actorId && !has(this.perms(c.guild_id, c.id), P.VIEW_CHANNEL)) throw Errors.missingAccess();
    return c;
  }

  member(guildId, userId) {
    const m = isSnowflake(userId) && this.world.member(guildId, userId);
    if (!m) throw Errors.unknownMember();
    return m;
  }

  user(userId) {
    const u = isSnowflake(userId) && this.world.user(userId);
    if (!u) throw Errors.unknownUser();
    return u;
  }

  role(guildId, roleId) {
    const r = isSnowflake(roleId) && this.world.role(guildId, roleId);
    if (!r) throw Errors.unknownRole();
    return r;
  }

  message(channelId, messageId) {
    const m = isSnowflake(messageId) && this.world.message(channelId, messageId);
    if (!m) throw Errors.unknownMessage();
    return m;
  }

  // ---- permissions -----------------------------------------------------------
  perms(guildId, channelId) {
    if (!this.actorId) return 0n;
    return computePermissions(this.world, guildId, this.actorId, channelId);
  }

  /** Throws 403/50013 unless the actor has every permission in `flags`. */
  require(guildId, channelId, ...flags) {
    const p = this.perms(guildId, channelId);
    for (const f of flags) if ((p & f) !== f) throw Errors.missingPermissions();
    return p;
  }

  /** Throws 403/50013 unless the actor has at least one of `flags`. */
  requireAny(guildId, channelId, ...flags) {
    const p = this.perms(guildId, channelId);
    if (!flags.some((f) => (p & f) === f)) throw Errors.missingPermissions();
    return p;
  }

  isOwner(guildId) {
    return this.world.guild(guildId)?.owner_id === this.actorId;
  }

  /**
   * Role hierarchy – https://discord.com/developers/docs/topics/permissions#permission-hierarchy
   * The actor can act on a member only if its highest role is above the member's highest role.
   * Nobody acts on the owner. The owner acts on everyone else.
   */
  requireAbove(guildId, targetUserId) {
    const g = this.world.guild(guildId);
    if (targetUserId === g.owner_id) throw Errors.missingPermissions();
    if (this.isOwner(guildId)) return;
    if (this.world.highestRoleRank(guildId, this.actorId) <= this.world.highestRoleRank(guildId, targetUserId)) {
      throw Errors.missingPermissions();
    }
  }

  /** The actor can only manage (assign, edit, delete, move) roles below its own highest role. */
  requireRoleBelow(guildId, roleId) {
    if (this.isOwner(guildId)) return;
    if (this.world.roleRank(guildId, roleId) >= this.world.highestRoleRank(guildId, this.actorId)) {
      throw Errors.missingPermissions();
    }
  }

  /** Bots can only grant permissions they have themselves (unless ADMINISTRATOR / owner). */
  requireGrantable(guildId, bits) {
    if (this.isOwner(guildId)) return;
    const mine = this.perms(guildId);
    if ((bits & ~mine) !== 0n) throw Errors.missingPermissions();
  }

  requireBot() {
    if (this.actor?.kind === 'bearer') throw Errors.unauthorized();
  }

  ok(body, status = 200) { return { status, body }; }
  noContent() { return { status: 204 }; }
}

export { DiscordError };
