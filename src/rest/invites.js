// Invites by code, invites by channel and member prune
// https://discord.com/developers/docs/resources/invite, https://discord.com/developers/docs/resources/guild#begin-guild-prune
import { Errors, assertValid, formError } from '../errors.js';
import { Permissions as P, AuditLogEvent as A } from '../constants.js';
import { isSnowflake } from '../util.js';
import { inviteJSON } from './guilds.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** An invite stops working when it expires or reaches max_uses. */
function gone(world, inv) {
  if (inv.max_age && world.now() > Date.parse(inv.created_at) + inv.max_age * 1000) return true;
  return !!inv.max_uses && inv.uses >= inv.max_uses;
}

export function registerInviteRoutes(r) {
  // ${DOCS}/resources/invite#get-invite – public; with_counts adds approximate_member_count and approximate_presence_count
  r.add('GET', '/invites/:code', (ctx) => {
    const inv = ctx.world.state.invites[ctx.params.code];
    if (!inv || gone(ctx.world, inv)) throw Errors.unknownInvite();
    const out = inviteJSON(ctx.world, inv);
    if (ctx.query.with_counts === 'true') {
      const g = ctx.world.guild(inv.guild_id);
      out.approximate_member_count = Object.keys(g.members).length;
      out.approximate_presence_count = Object.keys(g.members).filter((uid) => { const p = ctx.world.state.presences[uid]; return p && p.status !== 'offline'; }).length;
    }
    return ctx.ok(out);
  }, { auth: 'none', global: false });

  // ${DOCS}/resources/invite#delete-invite – MANAGE_CHANNELS on the invite's channel, or MANAGE_GUILD
  r.add('DELETE', '/invites/:code', (ctx) => {
    const inv = ctx.world.state.invites[ctx.params.code];
    if (!inv) throw Errors.unknownInvite();
    ctx.guild(inv.guild_id);
    ctx.requireAny(inv.guild_id, inv.channel_id, P.MANAGE_CHANNELS, P.MANAGE_GUILD);
    const json = inviteJSON(ctx.world, inv);
    ctx.ops.deleteInvite(inv.code, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.ok(json);
  }, { audit: true });

  // ${DOCS}/resources/channel#get-channel-invites – MANAGE_CHANNELS
  r.add('GET', '/channels/:channel_id/invites', (ctx) => {
    const c = ctx.channel();
    if (!c.guild_id) throw Errors.cannotExecuteOnDM();
    ctx.require(c.guild_id, c.id, P.MANAGE_CHANNELS);
    return ctx.ok(Object.values(ctx.world.state.invites).filter((i) => i.channel_id === c.id && !gone(ctx.world, i)).map((i) => inviteJSON(ctx.world, i)));
  });

  // ---------------------------------------------------------------------------
  // Prune
  // ---------------------------------------------------------------------------
  // ASSUMPTION: Discord prunes members who have not been online for `days` days; the fake has no online history, so
  // "inactive" means: joined more than `days` days ago and posted no message in the guild since. Bots, the guild
  // owner and the caller are never pruned.
  const candidates = (ctx, g, days, includeRoles) => {
    const cutoff = ctx.world.now() - days * DAY_MS;
    const lastPost = new Map();
    for (const c of ctx.world.guildChannels(g.id)) {
      for (const m of Object.values(ctx.world.state.messages[c.id] ?? {})) {
        const at = Number(BigInt(m.id) >> 22n) + 1420070400000;
        if (at > (lastPost.get(m.author_id) ?? 0)) lastPost.set(m.author_id, at);
      }
    }
    return Object.values(g.members).filter((m) => {
      if (m.user_id === g.owner_id || m.user_id === ctx.actorId || ctx.world.user(m.user_id)?.bot) return false;
      // "By default, prune will not remove users with roles ... any inactive user that has a subset of the provided role(s)"
      if (!m.roles.every((role) => includeRoles.includes(role))) return false;
      return Math.max(Date.parse(m.joined_at), lastPost.get(m.user_id) ?? 0) < cutoff;
    }).map((m) => m.user_id);
  };
  const requirePrune = (ctx, g) => {
    if (g.features?.includes('PRUNE_REQUIRES_ADMIN')) ctx.require(g.id, undefined, P.ADMINISTRATOR);
    else ctx.require(g.id, undefined, P.MANAGE_GUILD, P.KICK_MEMBERS);
  };
  const roles = (ctx, raw) => {
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',').filter(Boolean);
    if (list.some((x) => !isSnowflake(String(x)))) throw formError('include_roles', 'SNOWFLAKE_TYPE_INVALID', 'Value is not snowflake.');
    return list.map(String);
  };

  r.add('GET', '/guilds/:guild_id/prune', (ctx) => {
    const g = ctx.guild();
    assertValid(ctx.query, { days: { type: 'int', min: 1, max: 30 } });
    requirePrune(ctx, g);
    return ctx.ok({ pruned: candidates(ctx, g, Number(ctx.query.days ?? 7), roles(ctx, ctx.query.include_roles)).length });
  });

  r.add('POST', '/guilds/:guild_id/prune', (ctx) => {
    const g = ctx.guild();
    assertValid(ctx.body, { days: { type: 'int', min: 1, max: 30 }, compute_prune_count: { type: 'bool' }, include_roles: { type: 'array', items: { type: 'snowflake' } }, reason: { type: 'string' } });
    requirePrune(ctx, g);
    const days = ctx.body.days ?? 7;
    const ids = candidates(ctx, g, days, roles(ctx, ctx.body.include_roles));
    for (const uid of ids) ctx.ops.removeMember(g.id, uid, { actorId: ctx.actorId, kick: false });
    ctx.ops.audit(g.id, { actorId: ctx.actorId, action_type: A.MEMBER_PRUNE, target_id: null, options: { delete_member_days: String(days), members_removed: String(ids.length) }, reason: ctx.reason ?? ctx.body.reason });
    return ctx.ok({ pruned: ctx.body.compute_prune_count === false ? null : ids.length });
  }, { audit: true });
}
