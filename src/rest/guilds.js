import { Errors, FormErrors, assertValid, formError, DiscordError } from '../errors.js';
import {
  Permissions as P, ChannelType, THREAD_TYPES, AuditLogEvent as A, AUTOMOD_MAX_RULES_PER_TRIGGER,
} from '../constants.js';
import { compareIds, isSnowflake, toBits, deepClone } from '../util.js';

const DOCS = 'https://discord.com/developers/docs';
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

export function registerGuildRoutes(r) {
  // ---------------------------------------------------------------------------
  // Guild
  // ---------------------------------------------------------------------------
  // ${DOCS}/resources/guild#get-guild
  r.add('GET', '/guilds/:guild_id', (ctx) => {
    const g = ctx.guild();
    return ctx.ok(ctx.world.guildJSON(g, { withCounts: ctx.query.with_counts === 'true' }));
  });

  // ${DOCS}/resources/guild#get-guild-preview is out of scope.

  // ---------------------------------------------------------------------------
  // Roles
  // ---------------------------------------------------------------------------
  // ${DOCS}/resources/guild#get-guild-roles
  r.add('GET', '/guilds/:guild_id/roles', (ctx) => {
    const g = ctx.guild();
    return ctx.ok(ctx.world.sortedRoles(g.id).reverse().map((x) => ctx.world.roleJSON(x)));
  });

  // ${DOCS}/resources/guild#get-guild-role
  r.add('GET', '/guilds/:guild_id/roles/:role_id', (ctx) => {
    const g = ctx.guild();
    return ctx.ok(ctx.world.roleJSON(ctx.role(g.id, ctx.params.role_id)));
  });

  const roleSchema = {
    name: { type: 'string', maxLength: 100, nullable: true },
    permissions: { type: 'bitfield', nullable: true },
    color: { type: 'int', min: 0, max: 0xffffff, nullable: true },
    hoist: { type: 'bool', nullable: true },
    icon: { type: 'string', nullable: true },
    unicode_emoji: { type: 'string', nullable: true },
    mentionable: { type: 'bool', nullable: true },
  };

  // ${DOCS}/resources/guild#create-guild-role – requires MANAGE_ROLES; max 250 roles (30005).
  r.add('POST', '/guilds/:guild_id/roles', (ctx) => {
    const g = ctx.guild();
    assertValid(ctx.body, roleSchema);
    ctx.require(g.id, null, P.MANAGE_ROLES);
    if (Object.keys(g.roles).length >= 250) throw Errors.maxRoles();
    const bits = toBits(ctx.body.permissions ?? g.roles[g.id].permissions);
    // ${DOCS}/topics/permissions#permission-hierarchy – "it can only grant permissions it has"
    if (ctx.body.permissions !== undefined && ctx.body.permissions !== null) ctx.requireGrantable(g.id, bits);
    const role = ctx.ops.createRole(g.id, { ...stripNull(ctx.body), permissions: bits }, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.ok(ctx.world.roleJSON(role));
  }, { audit: true });

  // ${DOCS}/resources/guild#modify-guild-role-positions – "A bot can only sort roles lower than its highest role."
  r.add('PATCH', '/guilds/:guild_id/roles', (ctx) => {
    const g = ctx.guild();
    const body = ctx.body;
    const fe = new FormErrors();
    if (!Array.isArray(body)) fe.add([], 'BASE_TYPE_LIST', 'Must be a list.');
    else body.forEach((p, i) => {
      if (!p || !isSnowflake(p.id)) fe.add([String(i), 'id'], 'BASE_TYPE_REQUIRED', 'This field is required');
      if (p?.position !== undefined && p.position !== null && !Number.isInteger(p.position)) fe.add([String(i), 'position'], 'NUMBER_TYPE_COERCE', `Value "${p.position}" is not int.`);
    });
    fe.throwIfAny();
    ctx.require(g.id, null, P.MANAGE_ROLES);
    const myTop = positionOfRank(ctx.world, g.id, ctx.world.highestRoleRank(g.id, ctx.actorId));
    const moves = [];
    for (const p of body) {
      const role = ctx.role(g.id, p.id);
      if (role.id === g.id) throw Errors.invalidRole();
      ctx.requireRoleBelow(g.id, role.id);
      // Cannot move a role to or above the actor's own highest role.
      if (!ctx.isOwner(g.id) && p.position !== undefined && p.position !== null && p.position >= myTop) {
        throw Errors.missingPermissions();
      }
      if (p.position !== undefined && p.position !== null) moves.push({ id: role.id, position: p.position });
    }
    const roles = ctx.ops.setRolePositions(g.id, moves, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.ok(roles.map((x) => ctx.world.roleJSON(x)));
  }, { audit: true });

  // ${DOCS}/resources/guild#modify-guild-role
  r.add('PATCH', '/guilds/:guild_id/roles/:role_id', (ctx) => {
    const g = ctx.guild();
    assertValid(ctx.body, roleSchema);
    ctx.require(g.id, null, P.MANAGE_ROLES);
    const role = ctx.role(g.id, ctx.params.role_id);
    ctx.requireRoleBelow(g.id, role.id);
    const patch = stripNull(ctx.body);
    if (patch.permissions !== undefined) {
      const bits = toBits(patch.permissions);
      // Only permissions the actor has can be added.
      ctx.requireGrantable(g.id, bits & ~toBits(role.permissions));
      patch.permissions = bits;
    }
    if (role.id === g.id) { delete patch.name; delete patch.hoist; delete patch.mentionable; }
    ctx.ops.updateRole(g.id, role.id, patch, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.ok(ctx.world.roleJSON(role));
  }, { audit: true });

  // ${DOCS}/resources/guild#delete-guild-role
  r.add('DELETE', '/guilds/:guild_id/roles/:role_id', (ctx) => {
    const g = ctx.guild();
    ctx.require(g.id, null, P.MANAGE_ROLES);
    const role = ctx.role(g.id, ctx.params.role_id);
    // @everyone and managed (integration/bot) roles cannot be deleted.
    if (role.id === g.id || role.managed) throw Errors.invalidRole();
    ctx.requireRoleBelow(g.id, role.id);
    ctx.ops.deleteRole(g.id, role.id, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.noContent();
  }, { audit: true });

  // ---------------------------------------------------------------------------
  // Channels
  // ---------------------------------------------------------------------------
  // ${DOCS}/resources/guild#get-guild-channels – does not include threads.
  // ${DOCS}/topics/permissions#channel-visibility – "Starting November 16, 2026, this endpoint will omit any channel your
  // bot doesn't have permissions to view … Channel categories are viewable if any of their child channels are viewable."
  // options.channelObfuscation: 'auto' (default: from that date on the fake clock), true or false.
  r.add('GET', '/guilds/:guild_id/channels', (ctx) => {
    const g = ctx.guild();
    let channels = ctx.world.guildChannels(g.id).filter((c) => !THREAD_TYPES.has(c.type));
    if (channelObfuscation(ctx) && ctx.actorId) {
      const canView = (c) => (ctx.perms(g.id, c.id) & P.VIEW_CHANNEL) !== 0n;
      channels = channels.filter((c) => (c.type === ChannelType.GUILD_CATEGORY
        ? canView(c) || channels.some((x) => x.parent_id === c.id && canView(x))
        : canView(c)));
    }
    return ctx.ok(channels.map((c) => ctx.world.channelJSON(c)));
  });

  // ${DOCS}/resources/guild#list-active-guild-threads
  r.add('GET', '/guilds/:guild_id/threads/active', (ctx) => {
    const g = ctx.guild();
    const threads = ctx.world.guildChannels(g.id).filter((c) => THREAD_TYPES.has(c.type) && !c.thread_metadata?.archived);
    return ctx.ok({ threads: threads.map((c) => ctx.world.channelJSON(c)), members: [] });
  });

  const overwriteSchema = {
    type: 'object',
    fields: {
      id: { type: 'snowflake', required: true },
      type: { type: 'int', required: true, choices: [0, 1] },
      allow: { type: 'bitfield', nullable: true },
      deny: { type: 'bitfield', nullable: true },
    },
  };

  // ${DOCS}/resources/guild#create-guild-channel – requires MANAGE_CHANNELS; overwrites need MANAGE_ROLES
  // and can only allow/deny permissions the bot has (unless ADMINISTRATOR).
  r.add('POST', '/guilds/:guild_id/channels', (ctx) => {
    const g = ctx.guild();
    assertValid(ctx.body, {
      name: { type: 'string', required: true, minLength: 1, maxLength: 100 },
      type: { type: 'int', nullable: true, choices: [0, 2, 4, 5, 13, 14, 15, 16] },
      topic: { type: 'string', maxLength: 1024, nullable: true },
      bitrate: { type: 'int', min: 8000, nullable: true },
      user_limit: { type: 'int', min: 0, max: 99, nullable: true },
      rate_limit_per_user: { type: 'int', min: 0, max: 21600, nullable: true },
      position: { type: 'int', nullable: true },
      permission_overwrites: { type: 'array', items: overwriteSchema, nullable: true },
      parent_id: { type: 'snowflake', nullable: true },
      nsfw: { type: 'bool', nullable: true },
    });
    ctx.require(g.id, null, P.MANAGE_CHANNELS);
    if (ctx.world.guildChannels(g.id).filter((c) => !THREAD_TYPES.has(c.type)).length >= 500) throw Errors.maxChannels();
    if (ctx.body.parent_id) {
      const parent = ctx.world.channel(ctx.body.parent_id);
      if (!parent || parent.guild_id !== g.id || parent.type !== ChannelType.GUILD_CATEGORY) {
        throw formError('parent_id', 'CHANNEL_PARENT_INVALID_TYPE', 'Not a category'); // ASSUMPTION: error code name
      }
    }
    if (ctx.body.permission_overwrites?.length) {
      ctx.require(g.id, null, P.MANAGE_ROLES);
      for (const o of ctx.body.permission_overwrites) ctx.requireGrantable(g.id, toBits(o.allow) | toBits(o.deny));
      // ${DOCS}/resources/guild#create-guild-channel – "Setting MANAGE_ROLES permission in channels is only possible for guild administrators."
      const admin = ctx.isOwner(g.id) || (ctx.perms(g.id) & P.ADMINISTRATOR) !== 0n;
      if (!admin && ctx.body.permission_overwrites.some((o) => ((toBits(o.allow) | toBits(o.deny)) & P.MANAGE_ROLES) !== 0n)) throw Errors.missingPermissions();
    }
    const c = ctx.ops.createChannel(g.id, { ...stripNull(ctx.body), type: ctx.body.type ?? 0 }, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.ok(ctx.world.channelJSON(c), 201);
  }, { audit: true });

  // ${DOCS}/resources/guild#modify-guild-channel-positions
  r.add('PATCH', '/guilds/:guild_id/channels', (ctx) => {
    const g = ctx.guild();
    const fe = new FormErrors();
    if (!Array.isArray(ctx.body)) fe.add([], 'BASE_TYPE_LIST', 'Must be a list.');
    else ctx.body.forEach((p, i) => { if (!p || !isSnowflake(p.id)) fe.add([String(i), 'id'], 'BASE_TYPE_REQUIRED', 'This field is required'); });
    fe.throwIfAny();
    ctx.require(g.id, null, P.MANAGE_CHANNELS);
    for (const p of ctx.body) {
      const c = ctx.world.channel(p.id);
      if (!c || c.guild_id !== g.id) throw Errors.unknownChannel();
    }
    for (const p of ctx.body) {
      const patch = {};
      if (p.position !== undefined && p.position !== null) patch.position = p.position;
      if (p.parent_id !== undefined) patch.parent_id = p.parent_id;
      if (p.lock_permissions && p.parent_id) {
        patch.permission_overwrites = deepClone(ctx.world.channel(p.parent_id)?.permission_overwrites ?? []);
      }
      ctx.ops.updateChannel(p.id, patch, { actorId: ctx.actorId, reason: ctx.reason });
    }
    return ctx.noContent();
  }, { audit: true });

  // ---------------------------------------------------------------------------
  // Members
  // ---------------------------------------------------------------------------
  // ${DOCS}/resources/guild#get-guild-member
  r.add('GET', '/guilds/:guild_id/members/:user_id', (ctx) => {
    const g = ctx.guild();
    ctx.member(g.id, ctx.params.user_id);
    return ctx.ok(ctx.world.memberJSON(g.id, ctx.params.user_id));
  });

  // ${DOCS}/resources/guild#list-guild-members – requires the GUILD_MEMBERS privileged intent.
  r.add('GET', '/guilds/:guild_id/members', (ctx) => {
    const g = ctx.guild();
    assertValid(ctx.query, { limit: { type: 'int', min: 1, max: 1000 }, after: { type: 'snowflake' } });
    if (ctx.app && !ctx.app.privileged.guild_members) throw Errors.missingAccess();
    const limit = Number(ctx.query.limit ?? 1);
    const after = ctx.query.after ?? '0';
    const ids = Object.keys(g.members).filter((id) => compareIds(id, after) > 0).sort(compareIds).slice(0, limit);
    return ctx.ok(ids.map((id) => ctx.world.memberJSON(g.id, id)));
  });

  // ${DOCS}/resources/guild#search-guild-members – query matches username or nickname prefix.
  r.add('GET', '/guilds/:guild_id/members/search', (ctx) => {
    const g = ctx.guild();
    assertValid(ctx.query, { query: { type: 'string', required: true }, limit: { type: 'int', min: 1, max: 1000 } });
    const q = ctx.query.query.toLowerCase();
    const limit = Number(ctx.query.limit ?? 1);
    const hits = Object.values(g.members).filter((m) => {
      const u = ctx.world.user(m.user_id);
      return [u.username, u.global_name, m.nick].some((s) => s && s.toLowerCase().startsWith(q));
    }).sort((a, b) => compareIds(a.user_id, b.user_id)).slice(0, limit);
    return ctx.ok(hits.map((m) => ctx.world.memberJSON(g.id, m.user_id)));
  });

  // ${DOCS}/resources/guild#modify-current-member – CHANGE_NICKNAME
  r.add('PATCH', '/guilds/:guild_id/members/@me', (ctx) => {
    const g = ctx.guild();
    assertValid(ctx.body, { nick: { type: 'string', maxLength: 32, nullable: true } });
    if (ctx.body.nick !== undefined) ctx.require(g.id, null, P.CHANGE_NICKNAME);
    ctx.ops.updateMember(g.id, ctx.actorId, { nick: ctx.body.nick ?? null }, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.ok(ctx.world.memberJSON(g.id, ctx.actorId));
  }, { audit: true });

  // ${DOCS}/resources/guild#modify-guild-member
  r.add('PATCH', '/guilds/:guild_id/members/:user_id', (ctx) => {
    const g = ctx.guild();
    const userId = ctx.params.user_id;
    assertValid(ctx.body, {
      nick: { type: 'string', maxLength: 32, nullable: true },
      roles: { type: 'array', items: { type: 'snowflake' }, nullable: true },
      mute: { type: 'bool', nullable: true },
      deaf: { type: 'bool', nullable: true },
      channel_id: { type: 'snowflake', nullable: true },
      communication_disabled_until: { type: 'iso8601', nullable: true },
      flags: { type: 'int', nullable: true },
    });
    const member = ctx.member(g.id, userId);
    const body = ctx.body;
    const patch = {};
    const isSelf = userId === ctx.actorId;

    if (body.nick !== undefined) {
      if (isSelf) ctx.require(g.id, null, P.CHANGE_NICKNAME);
      else {
        ctx.require(g.id, null, P.MANAGE_NICKNAMES);
        ctx.requireAbove(g.id, userId); // hierarchy: "edit nicknames for users whose highest role is lower"
      }
      patch.nick = body.nick;
    }
    if (body.roles !== undefined) {
      ctx.require(g.id, null, P.MANAGE_ROLES);
      const next = body.roles ?? [];
      for (const rid of next) if (!ctx.world.role(g.id, rid)) throw Errors.unknownRole();
      const changed = [...next.filter((x) => !member.roles.includes(x)), ...member.roles.filter((x) => !next.includes(x))];
      for (const rid of changed) {
        // "A bot can grant roles to other users that are of a lower position than its own highest role."
        ctx.requireRoleBelow(g.id, rid);
        // Managed roles (bot / integration roles) cannot be granted or removed manually.
        if (ctx.world.role(g.id, rid).managed) throw Errors.missingPermissions();
      }
      patch.roles = next;
    }
    if (body.communication_disabled_until !== undefined) {
      ctx.require(g.id, null, P.MODERATE_MEMBERS);
      if (body.communication_disabled_until !== null) {
        const until = Date.parse(body.communication_disabled_until);
        // "up to 28 days in the future"
        if (until - ctx.world.now() > MAX_TIMEOUT_MS) {
          throw formError('communication_disabled_until', 'BASE_TYPE_BAD_TIME', 'Timeout duration must be at most 28 days.'); // ASSUMPTION: detail code
        }
        // "Will throw a 403 error if the user has the ADMINISTRATOR permission or is the owner of the guild"
        if (g.owner_id === userId) throw Errors.missingPermissions();
        if (baseAdminBits(ctx.world, g, userId) & P.ADMINISTRATOR) throw Errors.missingPermissions();
      }
      // Timeouts follow the role hierarchy like kick/ban (observed Discord behaviour, required by the spec).
      ctx.requireAbove(g.id, userId);
      patch.communication_disabled_until = body.communication_disabled_until;
    }
    if (body.mute !== undefined || body.deaf !== undefined || body.channel_id !== undefined) {
      // "Will throw a 400 error if the user is not in a voice channel" – the fake has no voice states.
      throw new DiscordError(400, 40032, 'Target user is not connected to voice');
    }
    if (body.flags !== undefined) {
      ctx.requireAny(g.id, null, P.MANAGE_GUILD, P.MANAGE_ROLES, P.MODERATE_MEMBERS | P.KICK_MEMBERS | P.BAN_MEMBERS);
      patch.flags = body.flags;
    }
    ctx.ops.updateMember(g.id, userId, patch, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.ok(ctx.world.memberJSON(g.id, userId));
  }, { audit: true });

  // ${DOCS}/resources/guild#add-guild-member-role
  r.add('PUT', '/guilds/:guild_id/members/:user_id/roles/:role_id', (ctx) => {
    const g = ctx.guild();
    ctx.require(g.id, null, P.MANAGE_ROLES);
    const m = ctx.member(g.id, ctx.params.user_id);
    const role = ctx.role(g.id, ctx.params.role_id);
    ctx.requireRoleBelow(g.id, role.id);
    if (role.managed || role.id === g.id) throw Errors.missingPermissions();
    if (!m.roles.includes(role.id)) {
      ctx.ops.updateMember(g.id, m.user_id, { roles: [...m.roles, role.id] }, { actorId: ctx.actorId, reason: ctx.reason });
    }
    return ctx.noContent();
  }, { audit: true });

  // ${DOCS}/resources/guild#remove-guild-member-role
  r.add('DELETE', '/guilds/:guild_id/members/:user_id/roles/:role_id', (ctx) => {
    const g = ctx.guild();
    ctx.require(g.id, null, P.MANAGE_ROLES);
    const m = ctx.member(g.id, ctx.params.user_id);
    const role = ctx.role(g.id, ctx.params.role_id);
    ctx.requireRoleBelow(g.id, role.id);
    if (role.managed) throw Errors.missingPermissions();
    if (m.roles.includes(role.id)) {
      ctx.ops.updateMember(g.id, m.user_id, { roles: m.roles.filter((x) => x !== role.id) }, { actorId: ctx.actorId, reason: ctx.reason });
    }
    return ctx.noContent();
  }, { audit: true });

  // ${DOCS}/resources/guild#remove-guild-member (kick) – KICK_MEMBERS + hierarchy
  r.add('DELETE', '/guilds/:guild_id/members/:user_id', (ctx) => {
    const g = ctx.guild();
    ctx.require(g.id, null, P.KICK_MEMBERS);
    ctx.member(g.id, ctx.params.user_id);
    ctx.requireAbove(g.id, ctx.params.user_id);
    ctx.ops.removeMember(g.id, ctx.params.user_id, { actorId: ctx.actorId, reason: ctx.reason, kick: true });
    return ctx.noContent();
  }, { audit: true });

  // ---------------------------------------------------------------------------
  // Bans
  // ---------------------------------------------------------------------------
  // ${DOCS}/resources/guild#get-guild-bans – BAN_MEMBERS or VIEW_AUDIT_LOG; limit 1-1000 (default 1000), before/after
  // "If both before and after are provided, only before is respected."
  r.add('GET', '/guilds/:guild_id/bans', (ctx) => {
    const g = ctx.guild();
    assertValid(ctx.query, { limit: { type: 'int', min: 1, max: 1000 }, before: { type: 'snowflake' }, after: { type: 'snowflake' } });
    ctx.requireAny(g.id, null, P.BAN_MEMBERS, P.VIEW_AUDIT_LOG);
    let ids = Object.keys(g.bans).sort(compareIds);
    const limit = Number(ctx.query.limit ?? 1000);
    if (ctx.query.before) ids = ids.filter((id) => compareIds(id, ctx.query.before) < 0).slice(-limit);
    else if (ctx.query.after) ids = ids.filter((id) => compareIds(id, ctx.query.after) > 0).slice(0, limit);
    else ids = ids.slice(0, limit);
    return ctx.ok(ids.map((id) => ({ reason: g.bans[id].reason, user: ctx.world.userJSON(id) })));
  });

  // ${DOCS}/resources/guild#get-guild-ban – "Requires the BAN_MEMBERS or VIEW_AUDIT_LOG permission."
  r.add('GET', '/guilds/:guild_id/bans/:user_id', (ctx) => {
    const g = ctx.guild();
    ctx.requireAny(g.id, null, P.BAN_MEMBERS, P.VIEW_AUDIT_LOG);
    const ban = g.bans[ctx.params.user_id];
    if (!ban) throw Errors.unknownBan();
    return ctx.ok({ reason: ban.reason, user: ctx.world.userJSON(ctx.params.user_id) });
  });

  // ${DOCS}/resources/guild#create-guild-ban – BAN_MEMBERS; delete_message_seconds 0-604800
  r.add('PUT', '/guilds/:guild_id/bans/:user_id', (ctx) => {
    const g = ctx.guild();
    assertValid(ctx.body, {
      delete_message_days: { type: 'int', min: 0, max: 7, nullable: true }, // deprecated
      delete_message_seconds: { type: 'int', min: 0, max: 604800, nullable: true },
    });
    ctx.require(g.id, null, P.BAN_MEMBERS);
    const userId = ctx.params.user_id;
    ctx.user(userId);
    if (g.members[userId] || userId === g.owner_id) ctx.requireAbove(g.id, userId);
    const seconds = ctx.body.delete_message_seconds ?? (ctx.body.delete_message_days ?? 0) * 86400;
    ctx.ops.ban(g.id, userId, { actorId: ctx.actorId, reason: ctx.reason, deleteMessageSeconds: seconds });
    return ctx.noContent();
  }, { audit: true });

  // ${DOCS}/resources/guild#remove-guild-ban
  r.add('DELETE', '/guilds/:guild_id/bans/:user_id', (ctx) => {
    const g = ctx.guild();
    ctx.require(g.id, null, P.BAN_MEMBERS);
    if (!g.bans[ctx.params.user_id]) throw Errors.unknownBan();
    ctx.ops.unban(g.id, ctx.params.user_id, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.noContent();
  }, { audit: true });

  // ${DOCS}/resources/guild#bulk-guild-ban – BAN_MEMBERS and MANAGE_GUILD; max 200 ids;
  // failed_users = could not be banned or already banned; 500000 if none banned.
  r.add('POST', '/guilds/:guild_id/bulk-ban', (ctx) => {
    const g = ctx.guild();
    assertValid(ctx.body, {
      user_ids: { type: 'array', required: true, maxLength: 200, items: { type: 'snowflake' } },
      delete_message_seconds: { type: 'int', min: 0, max: 604800, nullable: true },
    });
    ctx.require(g.id, null, P.BAN_MEMBERS, P.MANAGE_GUILD);
    const banned = [];
    const failed = [];
    for (const userId of [...new Set(ctx.body.user_ids)]) {
      let ok = !!ctx.world.user(userId) && !g.bans[userId] && userId !== g.owner_id && userId !== ctx.actorId;
      if (ok && g.members[userId] && !ctx.isOwner(g.id)) {
        ok = ctx.world.highestRoleRank(g.id, ctx.actorId) > ctx.world.highestRoleRank(g.id, userId);
      }
      if (!ok) { failed.push(userId); continue; }
      // ASSUMPTION: each user gets its own MEMBER_BAN_ADD audit entry.
      ctx.ops.ban(g.id, userId, { actorId: ctx.actorId, reason: ctx.reason, deleteMessageSeconds: ctx.body.delete_message_seconds ?? 0 });
      banned.push(userId);
    }
    if (!banned.length) throw Errors.failedToBan();
    return ctx.ok({ banned_users: banned, failed_users: failed });
  }, { audit: true });

  // ---------------------------------------------------------------------------
  // Audit log – ${DOCS}/resources/audit-log#get-guild-audit-log
  // VIEW_AUDIT_LOG; filters user_id, action_type, before, after, limit (1-100, default 50).
  // ---------------------------------------------------------------------------
  r.add('GET', '/guilds/:guild_id/audit-logs', (ctx) => {
    const g = ctx.guild();
    assertValid(ctx.query, {
      user_id: { type: 'snowflake' }, action_type: { type: 'int' }, before: { type: 'snowflake' },
      after: { type: 'snowflake' }, limit: { type: 'int', min: 1, max: 100 },
    });
    ctx.require(g.id, null, P.VIEW_AUDIT_LOG);
    const { user_id, action_type, before, after } = ctx.query;
    const limit = Number(ctx.query.limit ?? 50);
    let entries = g.audit_log.filter((e) => (!user_id || e.user_id === user_id) && (!action_type || e.action_type === Number(action_type)));
    // "When using before, the list is ordered by the audit log entry ID descending (newer entries first).
    // If after is used, the list is reversed and appears in ascending order (older entries first)."
    // ASSUMPTION: with both, `before` wins (as for bans and messages).
    entries = entries.sort((a, b) => compareIds(b.id, a.id));
    if (before) entries = entries.filter((e) => compareIds(e.id, before) < 0).slice(0, limit);
    else if (after !== undefined) entries = entries.filter((e) => compareIds(e.id, after) > 0).reverse().slice(0, limit);
    else entries = entries.slice(0, limit);
    const userIds = new Set();
    for (const e of entries) {
      if (e.user_id) userIds.add(e.user_id);
      if (e.target_id && ctx.world.user(e.target_id)) userIds.add(e.target_id);
    }
    const ruleIds = new Set(entries.filter((e) => e.action_type >= 140 && e.action_type <= 145).map((e) => e.target_id));
    return ctx.ok({
      application_commands: [],
      audit_log_entries: entries.map((e) => ctx.world.auditEntryJSON(e)),
      auto_moderation_rules: Object.values(g.automod_rules).filter((r) => ruleIds.has(r.id)).map(autoModJSON),
      guild_scheduled_events: [],
      integrations: [],
      threads: [],
      users: [...userIds].map((id) => ctx.world.userJSON(id)).filter(Boolean),
      webhooks: [],
    });
  });

  // ---------------------------------------------------------------------------
  // AutoMod – ${DOCS}/resources/auto-moderation – all endpoints need MANAGE_GUILD
  // ---------------------------------------------------------------------------
  r.add('GET', '/guilds/:guild_id/auto-moderation/rules', (ctx) => {
    const g = ctx.guild();
    ctx.require(g.id, null, P.MANAGE_GUILD);
    return ctx.ok(Object.values(g.automod_rules).sort((a, b) => compareIds(a.id, b.id)).map(autoModJSON));
  });

  r.add('GET', '/guilds/:guild_id/auto-moderation/rules/:rule_id', (ctx) => {
    const g = ctx.guild();
    ctx.require(g.id, null, P.MANAGE_GUILD);
    const rule = g.automod_rules[ctx.params.rule_id];
    if (!rule) throw Errors.unknownAutoModRule();
    return ctx.ok(autoModJSON(rule));
  });

  const actionSchema = {
    type: 'object',
    fields: {
      type: { type: 'int', required: true, choices: [1, 2, 3, 4] },
      metadata: { type: 'object', nullable: true, fields: {
        channel_id: { type: 'snowflake' },
        duration_seconds: { type: 'int', min: 0, max: 2419200 },
        custom_message: { type: 'string', maxLength: 150 },
      } },
    },
  };
  const triggerMetaSchema = {
    type: 'object',
    nullable: true,
    fields: {
      // ${DOCS}/resources/auto-moderation#auto-moderation-rule-object-trigger-metadata-field-limits
      keyword_filter: { type: 'array', maxLength: 1000, items: { type: 'string', maxLength: 60 } },
      regex_patterns: { type: 'array', maxLength: 10, items: { type: 'string', maxLength: 260 } },
      presets: { type: 'array', items: { type: 'int', choices: [1, 2, 3] } },
      allow_list: { type: 'array', maxLength: 1000, items: { type: 'string', maxLength: 60 } },
      mention_total_limit: { type: 'int', min: 0, max: 50 },
      mention_raid_protection_enabled: { type: 'bool' },
    },
  };

  // ${DOCS}/resources/auto-moderation#create-auto-moderation-rule
  r.add('POST', '/guilds/:guild_id/auto-moderation/rules', (ctx) => {
    const g = ctx.guild();
    assertValid(ctx.body, {
      name: { type: 'string', required: true, minLength: 1, maxLength: 100 },
      event_type: { type: 'int', required: true, choices: [1, 2] },
      trigger_type: { type: 'int', required: true, choices: [1, 3, 4, 5, 6] },
      trigger_metadata: triggerMetaSchema,
      actions: { type: 'array', required: true, minLength: 1, items: actionSchema },
      enabled: { type: 'bool', nullable: true },
      exempt_roles: { type: 'array', maxLength: 20, items: { type: 'snowflake' }, nullable: true },
      exempt_channels: { type: 'array', maxLength: 50, items: { type: 'snowflake' }, nullable: true },
    });
    ctx.require(g.id, null, P.MANAGE_GUILD);
    checkAutoModActions(ctx, g, ctx.body.trigger_type, ctx.body.actions);
    const count = Object.values(g.automod_rules).filter((r) => r.trigger_type === ctx.body.trigger_type).length;
    if (count >= (AUTOMOD_MAX_RULES_PER_TRIGGER[ctx.body.trigger_type] ?? 1)) {
      throw formError('trigger_type', 'AUTO_MODERATION_MAX_RULES_OF_TYPE_EXCEEDED', 'Maximum number of rules of this type exceeded'); // ASSUMPTION: detail code
    }
    const rule = {
      id: ctx.world.id(),
      guild_id: g.id,
      name: ctx.body.name,
      creator_id: ctx.actorId,
      event_type: ctx.body.event_type,
      trigger_type: ctx.body.trigger_type,
      trigger_metadata: ctx.body.trigger_metadata ?? {},
      actions: ctx.body.actions.map((a) => ({ type: a.type, metadata: a.metadata ?? {} })),
      enabled: ctx.body.enabled ?? false,
      exempt_roles: ctx.body.exempt_roles ?? [],
      exempt_channels: ctx.body.exempt_channels ?? [],
    };
    g.automod_rules[rule.id] = rule;
    ctx.ops.audit(g.id, { actorId: ctx.actorId, action_type: A.AUTO_MODERATION_RULE_CREATE, target_id: rule.id, reason: ctx.reason,
      changes: ['name', 'event_type', 'trigger_type', 'enabled'].map((k) => ({ key: k, new_value: rule[k] })) });
    // ${DOCS}/events/gateway-events#auto-moderation-rule-create
    ctx.ops.dispatch('AUTO_MODERATION_RULE_CREATE', autoModJSON(rule), { guildId: g.id, autoModConfig: true });
    return ctx.ok(autoModJSON(rule));
  }, { audit: true });

  // ${DOCS}/resources/auto-moderation#modify-auto-moderation-rule
  r.add('PATCH', '/guilds/:guild_id/auto-moderation/rules/:rule_id', (ctx) => {
    const g = ctx.guild();
    assertValid(ctx.body, {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      event_type: { type: 'int', choices: [1, 2] },
      trigger_metadata: triggerMetaSchema,
      actions: { type: 'array', minLength: 1, items: actionSchema },
      enabled: { type: 'bool' },
      exempt_roles: { type: 'array', maxLength: 20, items: { type: 'snowflake' } },
      exempt_channels: { type: 'array', maxLength: 50, items: { type: 'snowflake' } },
    });
    ctx.require(g.id, null, P.MANAGE_GUILD);
    const rule = g.automod_rules[ctx.params.rule_id];
    if (!rule) throw Errors.unknownAutoModRule();
    if (ctx.body.actions !== undefined) checkAutoModActions(ctx, g, rule.trigger_type, ctx.body.actions);
    const changes = [];
    for (const k of ['name', 'event_type', 'trigger_metadata', 'actions', 'enabled', 'exempt_roles', 'exempt_channels']) {
      if (ctx.body[k] === undefined) continue;
      if (JSON.stringify(rule[k]) !== JSON.stringify(ctx.body[k])) changes.push({ key: k, old_value: rule[k], new_value: ctx.body[k] });
      rule[k] = deepClone(ctx.body[k]);
    }
    if (changes.length) ctx.ops.audit(g.id, { actorId: ctx.actorId, action_type: A.AUTO_MODERATION_RULE_UPDATE, target_id: rule.id, changes, reason: ctx.reason });
    ctx.ops.dispatch('AUTO_MODERATION_RULE_UPDATE', autoModJSON(rule), { guildId: g.id, autoModConfig: true });
    return ctx.ok(autoModJSON(rule));
  }, { audit: true });

  // ${DOCS}/resources/auto-moderation#delete-auto-moderation-rule
  r.add('DELETE', '/guilds/:guild_id/auto-moderation/rules/:rule_id', (ctx) => {
    const g = ctx.guild();
    ctx.require(g.id, null, P.MANAGE_GUILD);
    const rule = g.automod_rules[ctx.params.rule_id];
    if (!rule) throw Errors.unknownAutoModRule();
    delete g.automod_rules[rule.id];
    ctx.ops.audit(g.id, { actorId: ctx.actorId, action_type: A.AUTO_MODERATION_RULE_DELETE, target_id: rule.id, reason: ctx.reason,
      changes: [{ key: 'name', old_value: rule.name }] });
    ctx.ops.dispatch('AUTO_MODERATION_RULE_DELETE', autoModJSON(rule), { guildId: g.id, autoModConfig: true });
    return ctx.noContent();
  }, { audit: true });

  // ---------------------------------------------------------------------------
  // Invites – ${DOCS}/resources/guild#get-guild-invites
  // ---------------------------------------------------------------------------
  r.add('GET', '/guilds/:guild_id/invites', (ctx) => {
    const g = ctx.guild();
    ctx.require(g.id, null, P.MANAGE_GUILD);
    return ctx.ok(Object.values(ctx.world.state.invites).filter((i) => i.guild_id === g.id).map((i) => inviteJSON(ctx.world, i)));
  });
}

// ${DOCS}/resources/auto-moderation#auto-moderation-action-object-action-types and #…-action-metadata:
// "A TIMEOUT action can only be set up for KEYWORD and MENTION_SPAM rules. The MODERATE_MEMBERS permission is
// required to use the TIMEOUT action type."; SEND_ALERT_MESSAGE needs channel_id (an existing channel),
// TIMEOUT needs duration_seconds.
// ASSUMPTION: violations are form errors (50035); the detail codes are not documented.
function checkAutoModActions(ctx, g, triggerType, actions) {
  const fe = new FormErrors();
  actions.forEach((a, i) => {
    if (a.type === 3 && triggerType !== 1 && triggerType !== 5) fe.add(['actions', String(i), 'type'], 'AUTO_MODERATION_INVALID_ACTION_FOR_TRIGGER', 'TIMEOUT can only be used with KEYWORD and MENTION_SPAM rules');
    if (a.type === 3 && a.metadata?.duration_seconds == null) fe.add(['actions', String(i), 'metadata', 'duration_seconds'], 'BASE_TYPE_REQUIRED', 'This field is required');
    if (a.type === 2) {
      const ch = a.metadata?.channel_id && ctx.world.channel(a.metadata.channel_id);
      if (!ch || ch.guild_id !== g.id) fe.add(['actions', String(i), 'metadata', 'channel_id'], 'BASE_TYPE_REQUIRED', 'This field is required');
    }
  });
  fe.throwIfAny();
  if (actions.some((a) => a.type === 3)) ctx.require(g.id, null, P.MODERATE_MEMBERS);
}

// ${DOCS}/resources/auto-moderation#auto-moderation-rule-object
export function autoModJSON(rule) {
  return deepClone(rule);
}

// ${DOCS}/resources/invite#invite-object
export function inviteJSON(world, inv) {
  const g = world.guild(inv.guild_id);
  return {
    type: 0,
    code: inv.code,
    guild: g ? { id: g.id, name: g.name, icon: g.icon ?? null, features: g.features ?? [] } : undefined,
    channel: world.channel(inv.channel_id) ? { id: inv.channel_id, name: world.channel(inv.channel_id).name, type: world.channel(inv.channel_id).type } : null,
    inviter: inv.inviter_id ? world.userJSON(inv.inviter_id) : undefined,
    uses: inv.uses,
    max_uses: inv.max_uses,
    max_age: inv.max_age,
    temporary: inv.temporary,
    created_at: inv.created_at,
    expires_at: inv.max_age ? world.iso(Date.parse(inv.created_at) + inv.max_age * 1000) : null,
  };
}

function stripNull(o) {
  const out = {};
  for (const [k, v] of Object.entries(o ?? {})) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

function positionOfRank(world, guildId, rank) {
  const sorted = world.sortedRoles(guildId);
  return sorted[sorted.length - rank]?.position ?? 0;
}

function baseAdminBits(world, g, userId) {
  const m = g.members[userId];
  let bits = toBits(g.roles[g.id].permissions);
  for (const rid of m?.roles ?? []) bits |= toBits(g.roles[rid]?.permissions);
  return bits;
}

const OBFUSCATION_START = Date.parse('2026-11-16T00:00:00Z');
function channelObfuscation(ctx) {
  const opt = ctx.world.options.channelObfuscation ?? 'auto';
  return opt === 'auto' ? ctx.world.now() >= OBFUSCATION_START : !!opt;
}
