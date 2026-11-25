import {
  AuditLogEvent as A, ChannelType, MessageType, MessageFlags, AutoModActionType, AutoModTriggerType,
  Permissions as P, THREAD_TYPES,
} from './constants.js';
import { computePermissions } from './permissions.js';
import { snowflakeTime, toBits, deepClone } from './util.js';

// Domain operations. Each one mutates the world and produces the side effects Discord
// produces: gateway dispatches (via world.emit('dispatch', …)) and audit-log entries.
// Permission and hierarchy checks are done by the callers (REST handlers), so the
// control API can also use these to set up state.

export class Ops {
  constructor(world) {
    this.w = world;
  }

  // ---- plumbing --------------------------------------------------------------
  /**
   * routing: { guildId?, channelId?, applicationId?, dmUserIds?, message?: bool }
   * The gateway decides per session (intents, shard, permissions) whether to deliver.
   */
  dispatch(t, d, routing = {}) {
    this.w.emit('dispatch', { t, d, ...routing });
  }

  // https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object
  // https://discord.com/developers/docs/events/gateway-events#guild-audit-log-entry-create
  audit(guildId, { actorId, action_type, target_id, changes, options, reason }) {
    const g = this.w.guild(guildId);
    if (!g || !actorId) return null;
    const entry = { id: this.w.id(), guild_id: guildId, user_id: actorId, target_id: target_id ?? null, action_type };
    if (changes?.length) entry.changes = changes;
    if (options) entry.options = options;
    if (reason !== undefined && reason !== null) entry.reason = reason;
    g.audit_log.push(entry);
    this.dispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', { ...this.w.auditEntryJSON(entry), guild_id: guildId }, { guildId, auditLog: true });
    return entry;
  }

  // ---- users & applications --------------------------------------------------
  createUser({ id, username, global_name = null, bot = false, system = false, avatar = null, locale = 'en-US', email } = {}) {
    if (!username) throw new Error('createUser: username is required');
    const uid = id ?? this.w.id();
    const user = { id: uid, username, discriminator: '0', global_name, avatar, bot, system, locale, public_flags: 0, flags: 0 };
    if (email) user.email = email;
    this.w.state.users[uid] = user;
    return user;
  }

  createApplication({
    id, name, botUsername, ownerId, description = '', redirectUris = [], privilegedIntents = {}, flags = 0,
    botPublic = true, clientSecret, token,
  } = {}) {
    if (!name) throw new Error('createApplication: name is required');
    const appId = id ?? this.w.id();
    const botUser = this.createUser({ id: appId, username: botUsername ?? name, bot: true });
    // Bot user id equals the application id for apps created since 2018 (common, not guaranteed).
    let owner = ownerId;
    if (!owner) owner = this.createUser({ username: `${name.toLowerCase().replace(/\W+/g, '')}_owner` }).id;
    const app = {
      id: appId,
      name,
      description,
      bot_user_id: botUser.id,
      owner_id: owner,
      token: token ?? this.w.makeBotToken(botUser.id),
      client_secret: clientSecret ?? this.w.secret(32),
      public_key: this.w.rng.hex(64),
      flags,
      bot_public: botPublic,
      redirect_uris: [...redirectUris],
      privileged: {
        guild_members: !!(privilegedIntents.guildMembers ?? privilegedIntents.guild_members),
        guild_presences: !!(privilegedIntents.guildPresences ?? privilegedIntents.presences ?? privilegedIntents.guild_presences),
        message_content: !!(privilegedIntents.messageContent ?? privilegedIntents.message_content),
      },
    };
    this.w.state.applications[appId] = app;
    return app;
  }

  // ---- guilds ----------------------------------------------------------------
  createGuild({ id, name, ownerId, everyonePermissions, features, systemChannel = true, preferredLocale, joinedAt } = {}) {
    if (!name) throw new Error('createGuild: name is required');
    if (!ownerId || !this.w.user(ownerId)) throw new Error('createGuild: ownerId must be an existing user');
    const g = this.w.newGuildDefaults({ id, name, ownerId, everyonePermissions });
    if (features) g.features = [...features];
    if (preferredLocale) g.preferred_locale = preferredLocale;
    this.w.state.guilds[g.id] = g;
    g.members[ownerId] = this.newMember(ownerId, { joinedAt });
    if (systemChannel) {
      const general = this.createChannel(g.id, { name: 'general', type: ChannelType.GUILD_TEXT });
      g.system_channel_id = general.id;
    }
    return g;
  }

  newMember(userId, { roles = [], nick = null, pending = false, joinedAt, flags = 0, communicationDisabledUntil = null } = {}) {
    return {
      user_id: userId,
      nick,
      avatar: null,
      roles: [...roles],
      joined_at: this.w.iso(joinedAt === undefined ? this.w.now() : toTime(joinedAt)),
      premium_since: null,
      deaf: false,
      mute: false,
      flags,
      pending,
      communication_disabled_until: communicationDisabledUntil,
    };
  }

  // ---- members ---------------------------------------------------------------
  /** Adds a member (a join). If the member is an application's bot, the app gets GUILD_CREATE. */
  addMember(guildId, userId, opts = {}) {
    const g = this.w.guild(guildId);
    const user = this.w.user(userId);
    if (!g || !user) throw new Error('addMember: unknown guild or user');
    if (g.members[userId]) return g.members[userId];
    const member = this.newMember(userId, opts);
    g.members[userId] = member;
    if (opts.inviteCode) member.invite_code = opts.inviteCode;
    // https://discord.com/developers/docs/events/gateway-events#guild-member-add
    this.dispatch('GUILD_MEMBER_ADD', { ...this.w.memberJSON(guildId, userId), guild_id: guildId }, { guildId });
    const app = this.w.appByBotUser(userId);
    if (app) this.w.emit('bot-joined', { guildId, applicationId: app.id });
    return member;
  }

  /** Removes a member (leave or kick). */
  removeMember(guildId, userId, { actorId, reason, kick = false } = {}) {
    const g = this.w.guild(guildId);
    if (!g?.members[userId]) return false;
    const app = this.w.appByBotUser(userId);
    if (kick) this.audit(guildId, { actorId, action_type: A.MEMBER_KICK, target_id: userId, reason });
    this.setVoiceState(guildId, userId, { channelId: null });
    delete g.members[userId];
    // https://discord.com/developers/docs/events/gateway-events#guild-member-remove
    this.dispatch('GUILD_MEMBER_REMOVE', { guild_id: guildId, user: this.w.userJSON(userId) }, { guildId });
    if (app) {
      // https://discord.com/developers/docs/events/gateway-events#guild-delete – "If the unavailable field is not set, the user was removed from the guild."
      this.dispatch('GUILD_DELETE', { id: guildId }, { applicationId: app.id, guildId, toRemovedBot: true });
      this.w.emit('bot-left', { guildId, applicationId: app.id });
    }
    return true;
  }

  /**
   * patch keys: nick, roles, communication_disabled_until, mute, deaf, flags, pending.
   * Audit: MEMBER_UPDATE for nick/timeout/mute/deaf, MEMBER_ROLE_UPDATE for roles.
   */
  updateMember(guildId, userId, patch, { actorId, reason } = {}) {
    const m = this.w.member(guildId, userId);
    const before = deepClone(m);
    const changes = [];
    for (const key of ['nick', 'communication_disabled_until', 'mute', 'deaf', 'flags', 'pending']) {
      if (patch[key] === undefined) continue;
      let v = patch[key];
      if (key === 'communication_disabled_until' && v !== null) v = this.w.iso(Date.parse(v));
      if (key === 'nick' && v === '') v = null;
      if (m[key] !== v) {
        if (['nick', 'communication_disabled_until', 'mute', 'deaf'].includes(key)) {
          changes.push(change(key, m[key], v));
        }
        m[key] = v;
      }
    }
    if (changes.length) {
      this.audit(guildId, { actorId, action_type: A.MEMBER_UPDATE, target_id: userId, changes, reason });
    }
    if (patch.roles !== undefined) {
      const next = [...new Set(patch.roles)].filter((r) => r !== guildId);
      const added = next.filter((r) => !m.roles.includes(r));
      const removed = m.roles.filter((r) => !next.includes(r));
      m.roles = next;
      // https://discord.com/developers/docs/resources/audit-log#audit-log-change-object-audit-log-change-exceptions ($add / $remove)
      const roleChanges = [];
      const partial = (id) => ({ id, name: this.w.role(guildId, id)?.name });
      if (added.length) roleChanges.push({ key: '$add', new_value: added.map(partial) });
      if (removed.length) roleChanges.push({ key: '$remove', new_value: removed.map(partial) });
      if (roleChanges.length) this.audit(guildId, { actorId, action_type: A.MEMBER_ROLE_UPDATE, target_id: userId, changes: roleChanges, reason });
    }
    if (JSON.stringify(before) !== JSON.stringify(m)) {
      // https://discord.com/developers/docs/events/gateway-events#guild-member-update
      this.dispatch('GUILD_MEMBER_UPDATE', { ...this.w.memberJSON(guildId, userId), guild_id: guildId }, { guildId, subjectUserId: userId });
    }
    return m;
  }

  // ---- bans ------------------------------------------------------------------
  ban(guildId, userId, { actorId, reason, deleteMessageSeconds = 0 } = {}) {
    const g = this.w.guild(guildId);
    if (g.members[userId]) {
      // Not a kick: no MEMBER_KICK entry, just the removal.
      this.removeMember(guildId, userId, {});
    }
    g.bans[userId] = { user_id: userId, reason: reason ?? null };
    this.audit(guildId, { actorId, action_type: A.MEMBER_BAN_ADD, target_id: userId, reason });
    // https://discord.com/developers/docs/events/gateway-events#guild-ban-add
    this.dispatch('GUILD_BAN_ADD', { guild_id: guildId, user: this.w.userJSON(userId) }, { guildId });
    if (deleteMessageSeconds > 0) this.deleteRecentMessagesOf(guildId, userId, deleteMessageSeconds);
  }

  // https://discord.com/developers/docs/resources/guild#create-guild-ban – delete_message_seconds
  // ASSUMPTION: deletions are announced as one MESSAGE_DELETE_BULK per channel and are not audit-logged.
  deleteRecentMessagesOf(guildId, userId, seconds) {
    const cutoff = this.w.now() - seconds * 1000;
    for (const ch of this.w.guildChannels(guildId)) {
      const ids = this.w.channelMessages(ch.id)
        .filter((m) => m.author_id === userId && snowflakeTime(m.id) >= cutoff)
        .map((m) => m.id);
      if (!ids.length) continue;
      for (const id of ids) delete this.w.state.messages[ch.id][id];
      this.dispatch('MESSAGE_DELETE_BULK', { ids, channel_id: ch.id, guild_id: guildId }, { guildId, channelId: ch.id });
    }
  }

  unban(guildId, userId, { actorId, reason } = {}) {
    const g = this.w.guild(guildId);
    delete g.bans[userId];
    this.audit(guildId, { actorId, action_type: A.MEMBER_BAN_REMOVE, target_id: userId, reason });
    // https://discord.com/developers/docs/events/gateway-events#guild-ban-remove
    this.dispatch('GUILD_BAN_REMOVE', { guild_id: guildId, user: this.w.userJSON(userId) }, { guildId });
  }

  // ---- roles -----------------------------------------------------------------
  createRole(guildId, data = {}, { actorId, reason } = {}) {
    const g = this.w.guild(guildId);
    const id = data.id ?? this.w.id();
    // ASSUMPTION: a new role is placed at position 1 (just above @everyone), others shift up,
    // unless `position` is given (control API only).
    const position = data.position ?? 1;
    for (const r of Object.values(g.roles)) if (r.id !== guildId && r.position >= position) r.position++;
    const role = {
      id,
      name: data.name ?? 'new role',
      color: data.color ?? 0,
      hoist: !!data.hoist,
      mentionable: !!data.mentionable,
      permissions: toBits(data.permissions ?? g.roles[guildId].permissions).toString(),
      position,
      managed: !!data.managed,
      icon: data.icon ?? null,
      unicode_emoji: data.unicode_emoji ?? null,
      flags: 0,
    };
    if (data.tags) role.tags = data.tags;
    g.roles[id] = role;
    this.normalizeRolePositions(guildId, { silent: true });
    this.audit(guildId, {
      actorId, action_type: A.ROLE_CREATE, target_id: id, reason,
      changes: ['name', 'permissions', 'color', 'hoist', 'mentionable'].map((k) => ({ key: k, new_value: role[k] })),
    });
    // https://discord.com/developers/docs/events/gateway-events#guild-role-create
    this.dispatch('GUILD_ROLE_CREATE', { guild_id: guildId, role: this.w.roleJSON(role) }, { guildId });
    return role;
  }

  updateRole(guildId, roleId, patch, { actorId, reason } = {}) {
    const role = this.w.role(guildId, roleId);
    const changes = [];
    for (const key of ['name', 'permissions', 'color', 'hoist', 'mentionable', 'icon', 'unicode_emoji']) {
      if (patch[key] === undefined) continue;
      const v = key === 'permissions' ? toBits(patch[key]).toString() : patch[key];
      if (role[key] !== v) {
        changes.push(change(key, role[key], v));
        role[key] = v;
      }
    }
    if (changes.length) {
      this.audit(guildId, { actorId, action_type: A.ROLE_UPDATE, target_id: roleId, changes, reason });
      // https://discord.com/developers/docs/events/gateway-events#guild-role-update
      this.dispatch('GUILD_ROLE_UPDATE', { guild_id: guildId, role: this.w.roleJSON(role) }, { guildId });
    }
    return role;
  }

  /** positions: [{ id, position }]. Re-numbers to contiguous positions and emits updates for moved roles. */
  setRolePositions(guildId, positions, { actorId, reason } = {}) {
    const g = this.w.guild(guildId);
    const before = Object.fromEntries(Object.values(g.roles).map((r) => [r.id, r.position]));
    const requested = new Map(positions.map((p) => [p.id, p.position]));
    for (const [id, pos] of requested) if (g.roles[id] && id !== guildId) g.roles[id].position = pos;
    // Direction of each requested move (+1 up, -1 down), so a moved role lands exactly on the requested slot.
    const dir = new Map([...requested].map(([id, pos]) => [id, Math.sign(pos - (before[id] ?? pos))]));
    this.normalizeRolePositions(guildId, { prefer: dir });
    for (const r of Object.values(g.roles)) {
      if (r.position !== before[r.id]) {
        // ASSUMPTION: each moved role gets a ROLE_UPDATE audit entry with a `position` change.
        this.audit(guildId, { actorId, action_type: A.ROLE_UPDATE, target_id: r.id, changes: [change('position', before[r.id], r.position)], reason });
        this.dispatch('GUILD_ROLE_UPDATE', { guild_id: guildId, role: this.w.roleJSON(r) }, { guildId });
      }
    }
    return this.w.sortedRoles(guildId).reverse();
  }

  normalizeRolePositions(guildId, { prefer } = {}) {
    const g = this.w.guild(guildId);
    const roles = Object.values(g.roles).filter((r) => r.id !== guildId);
    roles.sort((a, b) => a.position - b.position
      // On ties, a role the caller explicitly moved wins the requested slot: moved up -> it sorts above
      // the role already there (which shifts down), moved down -> below it (which shifts up).
      || (prefer ? (prefer.get(a.id) ?? 0) - (prefer.get(b.id) ?? 0) : 0)
      || (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
    roles.forEach((r, i) => { r.position = i + 1; });
    g.roles[guildId].position = 0;
  }

  deleteRole(guildId, roleId, { actorId, reason } = {}) {
    const g = this.w.guild(guildId);
    const role = g.roles[roleId];
    delete g.roles[roleId];
    for (const m of Object.values(g.members)) m.roles = m.roles.filter((r) => r !== roleId);
    this.normalizeRolePositions(guildId);
    this.audit(guildId, {
      actorId, action_type: A.ROLE_DELETE, target_id: roleId, reason,
      changes: ['name', 'permissions', 'color', 'hoist', 'mentionable'].map((k) => ({ key: k, old_value: role[k] })),
    });
    // https://discord.com/developers/docs/events/gateway-events#guild-role-delete
    this.dispatch('GUILD_ROLE_DELETE', { guild_id: guildId, role_id: roleId }, { guildId });
  }

  // ---- channels --------------------------------------------------------------
  createChannel(guildId, data = {}, { actorId, reason } = {}) {
    const id = data.id ?? this.w.id();
    const type = data.type ?? ChannelType.GUILD_TEXT;
    const siblings = this.w.guildChannels(guildId).filter((c) => !THREAD_TYPES.has(c.type));
    const channel = {
      id,
      type,
      guild_id: guildId,
      name: data.name,
      position: data.position ?? siblings.length,
      parent_id: data.parent_id ?? null,
      permission_overwrites: (data.permission_overwrites ?? []).map(normOverwrite),
      topic: data.topic ?? null,
      nsfw: !!data.nsfw,
      rate_limit_per_user: data.rate_limit_per_user ?? 0,
      last_message_id: null,
      flags: 0,
    };
    if (THREAD_TYPES.has(type)) {
      channel.owner_id = data.owner_id;
      channel.thread_members = data.owner_id ? { [data.owner_id]: { join_timestamp: this.w.now(), flags: 0 } } : {};
      if (data.applied_tags) channel.applied_tags = [...data.applied_tags];
      channel.thread_metadata = { archived: false, auto_archive_duration: data.auto_archive_duration ?? 1440, locked: false };
      delete channel.permission_overwrites;
    }
    if (type === ChannelType.GUILD_VOICE || type === ChannelType.GUILD_STAGE_VOICE) {
      channel.bitrate = data.bitrate ?? 64000;
      channel.user_limit = data.user_limit ?? 0;
    }
    this.w.state.channels[id] = channel;
    this.w.state.messages[id] = {};
    if (THREAD_TYPES.has(type)) {
      this.audit(guildId, { actorId, action_type: A.THREAD_CREATE, target_id: id, reason, changes: [{ key: 'name', new_value: channel.name }, { key: 'type', new_value: type }] });
      // https://discord.com/developers/docs/events/gateway-events#thread-create
      this.dispatch('THREAD_CREATE', { ...this.w.channelJSON(channel), newly_created: true }, { guildId, channelId: id });
      return channel;
    }
    this.audit(guildId, {
      actorId, action_type: A.CHANNEL_CREATE, target_id: id, reason,
      changes: [
        { key: 'name', new_value: channel.name },
        { key: 'type', new_value: type },
        { key: 'permission_overwrites', new_value: this.w.channelJSON(channel).permission_overwrites },
        { key: 'nsfw', new_value: channel.nsfw },
        { key: 'rate_limit_per_user', new_value: channel.rate_limit_per_user },
      ],
    });
    // https://discord.com/developers/docs/events/gateway-events#channel-create
    this.dispatch('CHANNEL_CREATE', this.w.channelJSON(channel), { guildId, channelId: id });
    return channel;
  }

  updateChannel(channelId, patch, { actorId, reason, silentAudit = false } = {}) {
    const c = this.w.channel(channelId);
    const changes = [];
    for (const key of ['name', 'topic', 'nsfw', 'rate_limit_per_user', 'position', 'parent_id', 'bitrate', 'user_limit', 'type']) {
      if (patch[key] === undefined || patch[key] === c[key]) continue;
      changes.push(change(key, c[key], patch[key]));
      c[key] = patch[key];
    }
    if (patch.permission_overwrites !== undefined) {
      const next = patch.permission_overwrites.map(normOverwrite);
      const prev = c.permission_overwrites ?? [];
      for (const o of next) {
        const old = prev.find((p) => p.id === o.id);
        if (!old) this.auditOverwrite(c, A.CHANNEL_OVERWRITE_CREATE, o, null, { actorId, reason });
        else if (old.allow !== o.allow || old.deny !== o.deny) this.auditOverwrite(c, A.CHANNEL_OVERWRITE_UPDATE, o, old, { actorId, reason });
      }
      for (const old of prev) if (!next.some((o) => o.id === old.id)) this.auditOverwrite(c, A.CHANNEL_OVERWRITE_DELETE, null, old, { actorId, reason });
      c.permission_overwrites = next;
      if (JSON.stringify(prev) !== JSON.stringify(next)) changes.push(null); // marks "changed" for the event
    }
    const real = changes.filter(Boolean);
    if (real.length && !silentAudit) {
      this.audit(c.guild_id, { actorId, action_type: THREAD_TYPES.has(c.type) ? A.THREAD_UPDATE : A.CHANNEL_UPDATE, target_id: channelId, changes: real, reason });
    }
    if (changes.length) {
      // https://discord.com/developers/docs/events/gateway-events#channel-update
      this.dispatch(THREAD_TYPES.has(c.type) ? 'THREAD_UPDATE' : 'CHANNEL_UPDATE', this.w.channelJSON(c), { guildId: c.guild_id, channelId });
    }
    return c;
  }

  // https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object-optional-audit-entry-info
  auditOverwrite(channel, action, now, old, { actorId, reason }) {
    const o = now ?? old;
    const options = { id: o.id, type: String(o.type) };
    if (o.type === 0) options.role_name = this.w.role(channel.guild_id, o.id)?.name;
    const changes = [];
    if (action === A.CHANNEL_OVERWRITE_CREATE) {
      changes.push({ key: 'id', new_value: o.id }, { key: 'type', new_value: o.type }, { key: 'allow', new_value: o.allow }, { key: 'deny', new_value: o.deny });
    } else if (action === A.CHANNEL_OVERWRITE_UPDATE) {
      if (old.allow !== now.allow) changes.push(change('allow', old.allow, now.allow));
      if (old.deny !== now.deny) changes.push(change('deny', old.deny, now.deny));
    } else {
      changes.push({ key: 'id', old_value: o.id }, { key: 'type', old_value: o.type }, { key: 'allow', old_value: o.allow }, { key: 'deny', old_value: o.deny });
    }
    this.audit(channel.guild_id, { actorId, action_type: action, target_id: channel.id, changes, options, reason });
  }

  putOverwrite(channelId, ow, opts) {
    const c = this.w.channel(channelId);
    const next = (c.permission_overwrites ?? []).filter((o) => o.id !== ow.id).concat(normOverwrite(ow));
    // Keep the original order when updating an existing overwrite.
    const idx = (c.permission_overwrites ?? []).findIndex((o) => o.id === ow.id);
    if (idx >= 0) { next.pop(); next.splice(idx, 0, normOverwrite(ow)); }
    return this.updateChannel(channelId, { permission_overwrites: next }, { ...opts, silentAudit: true });
  }

  deleteOverwrite(channelId, overwriteId, opts) {
    const c = this.w.channel(channelId);
    return this.updateChannel(channelId, { permission_overwrites: (c.permission_overwrites ?? []).filter((o) => o.id !== overwriteId) }, { ...opts, silentAudit: true });
  }

  deleteChannel(channelId, { actorId, reason } = {}) {
    const c = this.w.channel(channelId);
    const json = this.w.channelJSON(c);
    const guildId = c.guild_id;
    for (const [uid, vs] of Object.entries(this.w.guild(guildId)?.voice_states ?? {})) if (vs.channel_id === channelId) this.setVoiceState(guildId, uid, { channelId: null });
    // Children of a deleted category lose their parent.
    if (c.type === ChannelType.GUILD_CATEGORY) {
      for (const child of this.w.guildChannels(guildId).filter((x) => x.parent_id === channelId)) {
        child.parent_id = null;
        this.dispatch('CHANNEL_UPDATE', this.w.channelJSON(child), { guildId, channelId: child.id });
      }
    }
    // Threads under the channel go with it.
    for (const t of this.w.guildChannels(guildId).filter((x) => THREAD_TYPES.has(x.type) && x.parent_id === channelId)) {
      delete this.w.state.channels[t.id];
      delete this.w.state.messages[t.id];
    }
    delete this.w.state.channels[channelId];
    delete this.w.state.messages[channelId];
    const g = this.w.guild(guildId);
    if (g.system_channel_id === channelId) g.system_channel_id = null;
    const thread = THREAD_TYPES.has(c.type);
    this.audit(guildId, {
      actorId, action_type: thread ? A.THREAD_DELETE : A.CHANNEL_DELETE, target_id: channelId, reason,
      changes: [{ key: 'name', old_value: c.name }, { key: 'type', old_value: c.type }],
    });
    // https://discord.com/developers/docs/events/gateway-events#channel-delete
    if (thread) this.dispatch('THREAD_DELETE', { id: channelId, guild_id: guildId, parent_id: c.parent_id, type: c.type }, { guildId });
    else this.dispatch('CHANNEL_DELETE', json, { guildId });
    return json;
  }

  // ---- messages --------------------------------------------------------------
  /**
   * data: { authorId, content, embeds, components, attachments (ids), type, flags, message_reference,
   *         message_snapshots, mentions, mention_roles, mention_everyone, application_id, webhook_id,
   *         interaction_metadata, nonce, tts, poll }
   * Returns the stored message (or null if AutoMod blocked it).
   */
  createMessage(channelId, data, { skipAutoMod = false } = {}) {
    const c = this.w.channel(channelId);
    const id = data.id ?? this.w.id(data.timestampMs);
    const guildId = c.guild_id ?? null;
    const parsed = parseMentions(this.w, data.content ?? '', guildId);
    const msg = {
      id,
      channel_id: channelId,
      guild_id: guildId,
      author_id: data.authorId,
      content: data.content ?? '',
      embeds: data.embeds ?? [],
      components: data.components ?? [],
      attachments: data.attachments ?? [],
      type: data.type ?? MessageType.DEFAULT,
      flags: data.flags ?? 0,
      tts: !!data.tts,
      pinned: false,
      edited_timestamp: null,
      mentions: data.mentions ?? parsed.users,
      mention_roles: data.mention_roles ?? parsed.roles,
      mention_everyone: data.mention_everyone ?? parsed.everyone,
    };
    for (const k of ['message_reference', 'message_snapshots', 'application_id', 'webhook_id', 'webhook_username', 'interaction_metadata', 'nonce', 'poll', 'sticker_items']) {
      if (data[k] !== undefined) msg[k] = data[k];
    }
    // Replies mention the replied-to author unless allowed_mentions.replied_user is false.
    if (msg.type === MessageType.REPLY && data.mentionRepliedUser !== false) {
      const ref = this.w.message(msg.message_reference.channel_id, msg.message_reference.message_id);
      if (ref && !msg.mentions.includes(ref.author_id)) msg.mentions.push(ref.author_id);
    }
    let automod = null;
    if (guildId && !skipAutoMod) {
      automod = this.runAutoMod(guildId, channelId, msg);
      if (automod.blocked) return null;
    }
    this.w.state.messages[channelId] ??= {};
    this.w.state.messages[channelId][id] = msg;
    if (BigInt(id) > BigInt(c.last_message_id ?? 0)) c.last_message_id = id;
    if (THREAD_TYPES.has(c.type)) { c.message_count = (c.message_count ?? 0) + 1; c.total_message_sent = (c.total_message_sent ?? 0) + 1; }
    this.dispatchMessage('MESSAGE_CREATE', msg);
    if (automod?.alerts.length) this.flushAutoModAlerts(msg, automod.alerts, false);
    return msg;
  }

  // https://discord.com/developers/docs/events/gateway-events#message-create – extra fields guild_id, member, mentions[].member
  dispatchMessage(t, msg) {
    const d = this.w.messageJSON(msg);
    if (msg.guild_id) {
      d.guild_id = msg.guild_id;
      if (this.w.member(msg.guild_id, msg.author_id) && !msg.webhook_id) d.member = this.w.memberJSON(msg.guild_id, msg.author_id, { withUser: false });
    }
    // ASSUMPTION (prompt asks for it; not in the docs table): channel_type of the channel the message is in.
    d.channel_type = this.w.channel(msg.channel_id)?.type;
    const c = this.w.channel(msg.channel_id);
    const dmUserIds = c?.type === ChannelType.DM ? c.recipients : undefined;
    this.dispatch(t, d, { guildId: msg.guild_id ?? undefined, channelId: msg.channel_id, message: true, dmUserIds });
  }

  editMessage(channelId, messageId, patch) {
    const msg = this.w.message(channelId, messageId);
    for (const k of ['content', 'embeds', 'components', 'flags', 'attachments']) if (patch[k] !== undefined) msg[k] = patch[k];
    if (patch.content !== undefined) {
      const parsed = parseMentions(this.w, msg.content, msg.guild_id);
      msg.mentions = parsed.users;
      msg.mention_roles = parsed.roles;
      msg.mention_everyone = parsed.everyone;
    }
    msg.edited_timestamp = this.w.iso();
    // https://discord.com/developers/docs/events/gateway-events#message-update – full message object since 2024
    this.dispatchMessage('MESSAGE_UPDATE', msg);
    return msg;
  }

  deleteMessage(channelId, messageId, { actorId, reason } = {}) {
    const msg = this.w.message(channelId, messageId);
    delete this.w.state.messages[channelId][messageId];
    if (msg.guild_id && actorId && actorId !== msg.author_id) {
      // https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object-audit-log-events – MESSAGE_DELETE
      // target_id is the author; options carry channel_id and count.
      // ASSUMPTION: Discord merges consecutive deletes into one entry with a growing count; we log one entry per delete.
      this.audit(msg.guild_id, { actorId, action_type: A.MESSAGE_DELETE, target_id: msg.author_id, options: { channel_id: channelId, count: '1' }, reason });
    }
    const d = { id: messageId, channel_id: channelId };
    if (msg.guild_id) d.guild_id = msg.guild_id;
    const c = this.w.channel(channelId);
    // https://discord.com/developers/docs/events/gateway-events#message-delete
    this.dispatch('MESSAGE_DELETE', d, { guildId: msg.guild_id ?? undefined, channelId, dmUserIds: c?.type === ChannelType.DM ? c.recipients : undefined });
  }

  bulkDelete(channelId, ids, { actorId, reason } = {}) {
    const c = this.w.channel(channelId);
    const existing = ids.filter((id) => this.w.message(channelId, id));
    for (const id of existing) delete this.w.state.messages[channelId][id];
    this.audit(c.guild_id, { actorId, action_type: A.MESSAGE_BULK_DELETE, target_id: channelId, options: { count: String(existing.length) }, reason });
    // https://discord.com/developers/docs/events/gateway-events#message-delete-bulk
    this.dispatch('MESSAGE_DELETE_BULK', { ids: existing, channel_id: channelId, guild_id: c.guild_id }, { guildId: c.guild_id, channelId });
    return existing;
  }

  // ---- thread members --------------------------------------------------------
  // https://discord.com/developers/docs/resources/channel#thread-member-object
  threadMemberJSON(thread, userId, { withMember = false } = {}) {
    const tm = thread.thread_members?.[userId];
    if (!tm) return null;
    const out = { id: thread.id, user_id: userId, join_timestamp: this.w.iso(tm.join_timestamp), flags: tm.flags ?? 0 };
    if (withMember) { const m = this.w.memberJSON(thread.guild_id, userId); if (m) out.member = m; }
    return out;
  }

  /** Returns false if the user already was a member. THREAD_MEMBERS_UPDATE: https://discord.com/developers/docs/events/gateway-events#thread-members-update */
  addThreadMember(threadId, userId) {
    const c = this.w.channel(threadId);
    c.thread_members ??= {};
    if (c.thread_members[userId]) return false;
    c.thread_members[userId] = { join_timestamp: this.w.now(), flags: 0 };
    this.dispatch('THREAD_MEMBERS_UPDATE', {
      id: threadId, guild_id: c.guild_id, member_count: Math.min(50, Object.keys(c.thread_members).length),
      added_members: [this.threadMemberJSON(c, userId, { withMember: true })],
    }, { guildId: c.guild_id, channelId: threadId, threadUserIds: [userId] });
    return true;
  }

  removeThreadMember(threadId, userId) {
    const c = this.w.channel(threadId);
    if (!c.thread_members?.[userId]) return false;
    delete c.thread_members[userId];
    this.dispatch('THREAD_MEMBERS_UPDATE', {
      id: threadId, guild_id: c.guild_id, member_count: Math.min(50, Object.keys(c.thread_members).length), removed_member_ids: [userId],
    }, { guildId: c.guild_id, channelId: threadId, threadUserIds: [userId] });
    return true;
  }

  /** Changes a member's settings; THREAD_MEMBER_UPDATE goes only to the bot that is that member. */
  updateThreadMember(threadId, userId, { flags }) {
    const c = this.w.channel(threadId);
    const tm = c.thread_members?.[userId];
    if (!tm) return false;
    if (flags !== undefined) tm.flags = flags;
    this.dispatch('THREAD_MEMBER_UPDATE', { ...this.threadMemberJSON(c, userId, { withMember: true }), guild_id: c.guild_id }, { guildId: c.guild_id, onlyBotUserId: userId });
    return true;
  }

  // ---- typing and presence ---------------------------------------------------
  // https://discord.com/developers/docs/events/gateway-events#typing-start
  typing(channelId, userId) {
    const c = this.w.channel(channelId);
    const d = { channel_id: channelId, user_id: userId, timestamp: Math.floor(this.w.now() / 1000) };
    if (c.guild_id) {
      d.guild_id = c.guild_id;
      const m = this.w.memberJSON(c.guild_id, userId);
      if (m) d.member = m;
    }
    this.dispatch('TYPING_START', d, { guildId: c.guild_id ?? undefined, channelId, message: true, dmUserIds: c.type === ChannelType.DM ? c.recipients : undefined });
  }

  /**
   * Stores a user's presence and sends PRESENCE_UPDATE in every guild they share. `invisible` is stored as `offline`.
   * Returns false when nothing changed. https://discord.com/developers/docs/events/gateway-events#presence-update
   */
  setPresence(userId, { status = 'online', activities = [], clientStatus } = {}) {
    const offline = status === 'offline' || status === 'invisible';
    const next = {
      status: offline ? 'offline' : status,
      activities: offline ? [] : activities.map((a) => ({ created_at: this.w.now(), ...a })),
      client_status: offline ? {} : (clientStatus ?? { desktop: status }),
    };
    const cur = this.w.state.presences[userId];
    // created_at differs on every call, so compare without it
    const strip = (p) => p && JSON.stringify({ ...p, activities: p.activities.map(({ created_at, ...rest }) => rest) });
    if (strip(cur) === strip(next)) return false;
    this.w.state.presences[userId] = next;
    for (const g of this.w.guildsOfUser(userId)) this.dispatch('PRESENCE_UPDATE', this.presenceJSON(userId, g.id), { guildId: g.id });
    return true;
  }

  presenceJSON(userId, guildId) {
    const p = this.w.state.presences[userId];
    return { user: { id: userId }, guild_id: guildId, status: p.status, activities: deepClone(p.activities), client_status: { ...p.client_status } };
  }

  // ---- scheduled events ------------------------------------------------------
  // https://discord.com/developers/docs/resources/guild-scheduled-event
  createScheduledEvent(guildId, data, { actorId, reason } = {}) {
    const g = this.w.guild(guildId);
    g.scheduled_events ??= {};
    const ev = {
      id: data.id ?? this.w.id(), guild_id: guildId, channel_id: data.channel_id ?? null, creator_id: data.creator_id ?? actorId ?? null,
      name: data.name, description: data.description ?? null, start: data.start, end: data.end ?? null, status: 1,
      entity_type: data.entity_type, entity_metadata: data.entity_metadata ?? null, image: data.image ?? null, recurrence_rule: data.recurrence_rule ?? null, users: [],
    };
    g.scheduled_events[ev.id] = ev;
    this.audit(guildId, { actorId: actorId ?? ev.creator_id, action_type: A.GUILD_SCHEDULED_EVENT_CREATE, target_id: ev.id, reason, changes: [
      { key: 'name', new_value: ev.name }, { key: 'entity_type', new_value: ev.entity_type }, { key: 'privacy_level', new_value: 2 }, { key: 'status', new_value: 1 },
      ...(ev.channel_id ? [{ key: 'channel_id', new_value: ev.channel_id }] : []),
    ] });
    this.dispatch('GUILD_SCHEDULED_EVENT_CREATE', this.w.scheduledEventJSON(ev, { withUserCount: true }), { guildId });
    return ev;
  }

  updateScheduledEvent(guildId, eventId, patch, { actorId, reason } = {}) {
    const ev = this.w.guild(guildId).scheduled_events[eventId];
    const changes = [];
    const set = (key, field, value, norm = (x) => x) => {
      if (value === undefined || JSON.stringify(ev[field]) === JSON.stringify(value)) return;
      changes.push({ key, old_value: norm(ev[field]), new_value: norm(value) });
      ev[field] = value;
    };
    const iso = (ms) => (ms == null ? ms : this.w.iso(ms));
    set('name', 'name', patch.name);
    set('description', 'description', patch.description);
    set('scheduled_start_time', 'start', patch.start, iso);
    set('scheduled_end_time', 'end', patch.end, iso);
    set('entity_type', 'entity_type', patch.entity_type);
    set('channel_id', 'channel_id', patch.channel_id);
    set('entity_metadata', 'entity_metadata', patch.entity_metadata);
    set('status', 'status', patch.status);
    if (patch.image !== undefined) ev.image = patch.image;
    if (patch.recurrence_rule !== undefined) ev.recurrence_rule = patch.recurrence_rule;
    this.audit(guildId, { actorId, action_type: A.GUILD_SCHEDULED_EVENT_UPDATE, target_id: eventId, reason, changes });
    this.dispatch('GUILD_SCHEDULED_EVENT_UPDATE', this.w.scheduledEventJSON(ev, { withUserCount: true }), { guildId });
    return ev;
  }

  deleteScheduledEvent(guildId, eventId, { actorId, reason } = {}) {
    const g = this.w.guild(guildId);
    const ev = g.scheduled_events[eventId];
    delete g.scheduled_events[eventId];
    this.audit(guildId, { actorId, action_type: A.GUILD_SCHEDULED_EVENT_DELETE, target_id: eventId, reason, changes: [{ key: 'name', old_value: ev.name }] });
    this.dispatch('GUILD_SCHEDULED_EVENT_DELETE', this.w.scheduledEventJSON(ev, { withUserCount: true }), { guildId });
  }

  /** Returns false if the user was already (not) subscribed. https://discord.com/developers/docs/events/gateway-events#guild-scheduled-event-user-add */
  setEventSubscription(guildId, eventId, userId, subscribed) {
    const ev = this.w.guild(guildId).scheduled_events[eventId];
    const has = ev.users.includes(userId);
    if (has === subscribed) return false;
    ev.users = subscribed ? [...ev.users, userId] : ev.users.filter((u) => u !== userId);
    this.dispatch(subscribed ? 'GUILD_SCHEDULED_EVENT_USER_ADD' : 'GUILD_SCHEDULED_EVENT_USER_REMOVE', { guild_scheduled_event_id: eventId, user_id: userId, guild_id: guildId }, { guildId });
    return true;
  }

  // ---- voice states ----------------------------------------------------------
  // https://discord.com/developers/docs/resources/voice#voice-state-object
  voiceState(guildId, userId) { return this.w.guild(guildId)?.voice_states?.[userId]; }

  voiceStateJSON(guildId, userId, vs = this.voiceState(guildId, userId), { withMember = true, withGuild = true } = {}) {
    const m = this.w.member(guildId, userId);
    const out = {
      channel_id: vs.channel_id, user_id: userId, session_id: vs.session_id,
      deaf: !!m?.deaf, mute: !!m?.mute, self_deaf: !!vs.self_deaf, self_mute: !!vs.self_mute, self_video: !!vs.self_video,
      suppress: !!vs.suppress, request_to_speak_timestamp: vs.request_to_speak_timestamp ?? null,
    };
    if (vs.self_stream) out.self_stream = true;
    if (withGuild) out.guild_id = guildId;
    if (withMember && m) out.member = this.w.memberJSON(guildId, userId);
    return out;
  }

  /**
   * Join, move, change flags of, or (channelId: null) leave a voice channel. Sends VOICE_STATE_UPDATE when something changed.
   * Returns the voice state JSON (or null after leaving / when there was nothing to leave).
   * https://discord.com/developers/docs/events/gateway-events#voice-state-update
   */
  setVoiceState(guildId, userId, { channelId, selfMute, selfDeaf, selfVideo, selfStream, suppress } = {}) {
    const g = this.w.guild(guildId);
    if (!g) return null;
    g.voice_states ??= {};
    const cur = g.voice_states[userId];
    const routing = { guildId };
    if (channelId === null) {
      if (!cur) return null;
      delete g.voice_states[userId];
      this.dispatch('VOICE_STATE_UPDATE', this.voiceStateJSON(guildId, userId, { ...cur, channel_id: null }), routing);
      return null;
    }
    const next = {
      channel_id: channelId ?? cur?.channel_id,
      session_id: cur?.session_id ?? this.w.rng.hex(32),
      self_mute: selfMute ?? cur?.self_mute ?? false,
      self_deaf: selfDeaf ?? cur?.self_deaf ?? false,
      self_video: selfVideo ?? cur?.self_video ?? false,
      self_stream: selfStream ?? cur?.self_stream ?? false,
      suppress: suppress ?? cur?.suppress ?? false,
      request_to_speak_timestamp: cur?.request_to_speak_timestamp ?? null,
      server_mute: !!this.w.member(guildId, userId)?.mute,
      server_deaf: !!this.w.member(guildId, userId)?.deaf,
    };
    if (!next.channel_id) return null;
    if (cur && JSON.stringify(cur) === JSON.stringify(next)) return this.voiceStateJSON(guildId, userId);
    g.voice_states[userId] = next;
    const json = this.voiceStateJSON(guildId, userId);
    this.dispatch('VOICE_STATE_UPDATE', json, routing);
    return json;
  }

  /** A moderator moves (channelId) or disconnects (null) a member: MEMBER_MOVE / MEMBER_DISCONNECT. */
  moveMemberVoice(guildId, userId, channelId, { actorId, reason } = {}) {
    if (channelId === null) {
      this.audit(guildId, { actorId, action_type: A.MEMBER_DISCONNECT, options: { count: '1' }, reason });
    } else {
      this.audit(guildId, { actorId, action_type: A.MEMBER_MOVE, options: { channel_id: channelId, count: '1' }, reason });
    }
    return this.setVoiceState(guildId, userId, { channelId });
  }

  // ---- webhooks --------------------------------------------------------------
  // https://discord.com/developers/docs/events/gateway-events#webhooks-update
  dispatchWebhooksUpdate(guildId, channelId) {
    this.dispatch('WEBHOOKS_UPDATE', { guild_id: guildId, channel_id: channelId }, { guildId });
  }

  createWebhook(channelId, { name, avatar = null, creatorId, id }, { actorId, reason } = {}) {
    const c = this.w.channel(channelId);
    const wid = id ?? this.w.id();
    const wh = { id: wid, guild_id: c.guild_id, channel_id: channelId, name, avatar, token: this.w.secret(48), creator_id: creatorId ?? actorId ?? null };
    this.w.state.webhooks[wid] = wh;
    // Messages are authored by a user-shaped object with the webhook's id: https://discord.com/developers/docs/resources/message#message-object
    this.w.state.users[wid] = { id: wid, username: name, discriminator: '0000', global_name: null, avatar, bot: true, system: false, public_flags: 0, flags: 0 };
    this.audit(c.guild_id, { actorId: actorId ?? creatorId, action_type: A.WEBHOOK_CREATE, target_id: wid, reason, changes: [{ key: 'name', new_value: name }, { key: 'type', new_value: 1 }, { key: 'channel_id', new_value: channelId }] });
    this.dispatchWebhooksUpdate(c.guild_id, channelId);
    return wh;
  }

  updateWebhook(webhookId, patch, { actorId, reason } = {}) {
    const wh = this.w.state.webhooks[webhookId];
    const oldChannel = wh.channel_id;
    const changes = [];
    if (patch.name !== undefined && patch.name !== wh.name) { changes.push({ key: 'name', old_value: wh.name, new_value: patch.name }); wh.name = patch.name; }
    if (patch.avatar !== undefined) { wh.avatar = patch.avatar; changes.push({ key: 'avatar_hash', new_value: patch.avatar }); }
    if (patch.channel_id !== undefined && patch.channel_id !== wh.channel_id) { changes.push({ key: 'channel_id', old_value: wh.channel_id, new_value: patch.channel_id }); wh.channel_id = patch.channel_id; }
    if (this.w.state.users[webhookId]) { this.w.state.users[webhookId].username = wh.name; this.w.state.users[webhookId].avatar = wh.avatar; }
    this.audit(wh.guild_id, { actorId, action_type: A.WEBHOOK_UPDATE, target_id: webhookId, reason, changes });
    this.dispatchWebhooksUpdate(wh.guild_id, wh.channel_id);
    if (oldChannel !== wh.channel_id) this.dispatchWebhooksUpdate(wh.guild_id, oldChannel);
    return wh;
  }

  deleteWebhook(webhookId, { actorId, reason } = {}) {
    const wh = this.w.state.webhooks[webhookId];
    delete this.w.state.webhooks[webhookId];
    // The webhook's user stays so that its old messages keep their author.
    this.audit(wh.guild_id, { actorId, action_type: A.WEBHOOK_DELETE, target_id: webhookId, reason, changes: [{ key: 'name', old_value: wh.name }, { key: 'type', old_value: 1 }, { key: 'channel_id', old_value: wh.channel_id }] });
    this.dispatchWebhooksUpdate(wh.guild_id, wh.channel_id);
  }

  // ---- emoji and stickers ----------------------------------------------------
  // https://discord.com/developers/docs/resources/emoji#create-guild-emoji
  dispatchEmojis(guildId) {
    const g = this.w.guild(guildId);
    this.dispatch('GUILD_EMOJIS_UPDATE', { guild_id: guildId, emojis: Object.values(g.emojis ?? {}).map((e) => this.w.emojiJSON(e, { withUser: true })) }, { guildId });
  }

  createEmoji(guildId, { name, image, roles = [], animated = false, userId, id }, { actorId, reason } = {}) {
    const g = this.w.guild(guildId);
    g.emojis ??= {};
    const e = { id: id ?? this.w.id(), name, roles, animated, user_id: userId ?? actorId ?? null, image };
    g.emojis[e.id] = e;
    this.audit(guildId, { actorId: actorId ?? userId, action_type: A.EMOJI_CREATE, target_id: e.id, reason, changes: [{ key: 'name', new_value: name }] });
    this.dispatchEmojis(guildId);
    return e;
  }

  updateEmoji(guildId, emojiId, patch, { actorId, reason } = {}) {
    const e = this.w.guild(guildId).emojis[emojiId];
    const changes = [];
    if (patch.name !== undefined && patch.name !== e.name) { changes.push({ key: 'name', old_value: e.name, new_value: patch.name }); e.name = patch.name; }
    if (patch.roles !== undefined) { changes.push({ key: 'roles', old_value: [...e.roles], new_value: [...(patch.roles ?? [])] }); e.roles = patch.roles ?? []; }
    this.audit(guildId, { actorId, action_type: A.EMOJI_UPDATE, target_id: emojiId, reason, changes });
    this.dispatchEmojis(guildId);
    return e;
  }

  deleteEmoji(guildId, emojiId, { actorId, reason } = {}) {
    const g = this.w.guild(guildId);
    const e = g.emojis[emojiId];
    delete g.emojis[emojiId];
    this.audit(guildId, { actorId, action_type: A.EMOJI_DELETE, target_id: emojiId, reason, changes: [{ key: 'name', old_value: e.name }] });
    this.dispatchEmojis(guildId);
  }

  dispatchStickers(guildId) {
    const g = this.w.guild(guildId);
    this.dispatch('GUILD_STICKERS_UPDATE', { guild_id: guildId, stickers: Object.values(g.stickers ?? {}).map((s) => this.w.stickerJSON(s)) }, { guildId });
  }

  createSticker(guildId, { name, description, tags, format_type = 1, userId, data, contentType, id }, { actorId, reason } = {}) {
    const g = this.w.guild(guildId);
    g.stickers ??= {};
    const s = { id: id ?? this.w.id(), name, description: description || null, tags, format_type, guild_id: guildId, user_id: userId ?? actorId ?? null, content_type: contentType, data };
    g.stickers[s.id] = s;
    this.audit(guildId, { actorId: actorId ?? userId, action_type: A.STICKER_CREATE, target_id: s.id, reason, changes: [{ key: 'name', new_value: name }, { key: 'tags', new_value: tags }, { key: 'description', new_value: s.description ?? '' }] });
    this.dispatchStickers(guildId);
    return s;
  }

  updateSticker(guildId, stickerId, patch, { actorId, reason } = {}) {
    const s = this.w.guild(guildId).stickers[stickerId];
    const changes = [];
    for (const k of ['name', 'description', 'tags']) {
      if (patch[k] !== undefined && patch[k] !== s[k]) { changes.push({ key: k, old_value: s[k] ?? '', new_value: patch[k] ?? '' }); s[k] = patch[k]; }
    }
    this.audit(guildId, { actorId, action_type: A.STICKER_UPDATE, target_id: stickerId, reason, changes });
    this.dispatchStickers(guildId);
    return s;
  }

  deleteSticker(guildId, stickerId, { actorId, reason } = {}) {
    const g = this.w.guild(guildId);
    const s = g.stickers[stickerId];
    delete g.stickers[stickerId];
    this.audit(guildId, { actorId, action_type: A.STICKER_DELETE, target_id: stickerId, reason, changes: [{ key: 'name', old_value: s.name }] });
    this.dispatchStickers(guildId);
  }

  // ---- pins ------------------------------------------------------------------
  // https://discord.com/developers/docs/resources/message#pin-message
  pinnedMessages(channelId) {
    return this.w.channelMessages(channelId).filter((m) => m.pinned).sort((a, b) => (b.pinned_at - a.pinned_at) || (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
  }

  dispatchPinsUpdate(channelId) {
    const c = this.w.channel(channelId);
    const latest = this.pinnedMessages(channelId)[0];
    const d = { channel_id: channelId, last_pin_timestamp: latest ? this.w.iso(latest.pinned_at) : null };
    if (c.guild_id) d.guild_id = c.guild_id;
    // https://discord.com/developers/docs/events/gateway-events#channel-pins-update
    this.dispatch('CHANNEL_PINS_UPDATE', d, { guildId: c.guild_id ?? undefined, channelId, dmUserIds: c.type === ChannelType.DM ? c.recipients : undefined });
  }

  /** Pins a message: writes the CHANNEL_PINNED_MESSAGE system message, the MESSAGE_PIN audit entry and CHANNEL_PINS_UPDATE. */
  pinMessage(channelId, messageId, { actorId, reason } = {}) {
    const msg = this.w.message(channelId, messageId);
    if (msg.pinned) return false;
    msg.pinned = true;
    msg.pinned_at = this.w.now();
    const c = this.w.channel(channelId);
    this.createMessage(channelId, {
      authorId: actorId, type: MessageType.CHANNEL_PINNED_MESSAGE, content: '',
      message_reference: { type: 0, message_id: messageId, channel_id: channelId, guild_id: c.guild_id ?? undefined },
    }, { skipAutoMod: true });
    if (c.guild_id) this.audit(c.guild_id, { actorId, action_type: A.MESSAGE_PIN, target_id: msg.author_id, options: { channel_id: channelId, message_id: messageId }, reason });
    this.dispatchPinsUpdate(channelId);
    return true;
  }

  unpinMessage(channelId, messageId, { actorId, reason } = {}) {
    const msg = this.w.message(channelId, messageId);
    if (!msg.pinned) return false;
    msg.pinned = false;
    delete msg.pinned_at;
    const c = this.w.channel(channelId);
    if (c.guild_id) this.audit(c.guild_id, { actorId, action_type: A.MESSAGE_UNPIN, target_id: msg.author_id, options: { channel_id: channelId, message_id: messageId }, reason });
    this.dispatchPinsUpdate(channelId);
    return true;
  }

  // https://discord.com/developers/docs/resources/message#crosspost-message – sets CROSSPOSTED and fires MESSAGE_UPDATE. The fake has no followed channels.
  crosspostMessage(channelId, messageId) {
    const msg = this.w.message(channelId, messageId);
    msg.flags = (msg.flags ?? 0) | MessageFlags.CROSSPOSTED;
    this.dispatchMessage('MESSAGE_UPDATE', msg);
    return msg;
  }

  // ---- reactions -------------------------------------------------------------
  // https://discord.com/developers/docs/resources/message#create-reaction
  reactionTarget(msg) {
    const c = this.w.channel(msg.channel_id);
    return { guildId: msg.guild_id ?? undefined, channelId: msg.channel_id, message: true, dmUserIds: c?.type === ChannelType.DM ? c.recipients : undefined };
  }

  /** emoji: { id, name } (id null for unicode). Returns false if the user had already reacted. */
  addReaction(channelId, messageId, userId, emoji) {
    const msg = this.w.message(channelId, messageId);
    msg.reactions ??= [];
    const key = emoji.id ?? emoji.name;
    let r = msg.reactions.find((x) => (x.emoji.id ?? x.emoji.name) === key);
    if (!r) { r = { emoji: { id: emoji.id ?? null, name: emoji.name }, users: [] }; if (emoji.animated) r.emoji.animated = true; msg.reactions.push(r); }
    if (r.users.includes(userId)) return false;
    r.users.push(userId);
    const d = { user_id: userId, channel_id: channelId, message_id: messageId, emoji: { ...r.emoji }, message_author_id: msg.author_id, burst: false, type: 0 };
    if (msg.guild_id) { d.guild_id = msg.guild_id; const m = this.w.memberJSON(msg.guild_id, userId); if (m) d.member = m; }
    // https://discord.com/developers/docs/events/gateway-events#message-reaction-add
    this.dispatch('MESSAGE_REACTION_ADD', d, this.reactionTarget(msg));
    return true;
  }

  removeReaction(channelId, messageId, userId, emoji) {
    const msg = this.w.message(channelId, messageId);
    const key = emoji.id ?? emoji.name;
    const r = msg.reactions?.find((x) => (x.emoji.id ?? x.emoji.name) === key);
    if (!r || !r.users.includes(userId)) return false;
    r.users = r.users.filter((u) => u !== userId);
    if (!r.users.length) msg.reactions = msg.reactions.filter((x) => x !== r);
    const d = { user_id: userId, channel_id: channelId, message_id: messageId, emoji: { ...r.emoji }, burst: false, type: 0 };
    if (msg.guild_id) d.guild_id = msg.guild_id;
    this.dispatch('MESSAGE_REACTION_REMOVE', d, this.reactionTarget(msg));
    return true;
  }

  removeAllReactions(channelId, messageId) {
    const msg = this.w.message(channelId, messageId);
    msg.reactions = [];
    const d = { channel_id: channelId, message_id: messageId };
    if (msg.guild_id) d.guild_id = msg.guild_id;
    this.dispatch('MESSAGE_REACTION_REMOVE_ALL', d, this.reactionTarget(msg));
  }

  removeEmojiReactions(channelId, messageId, emoji) {
    const msg = this.w.message(channelId, messageId);
    const key = emoji.id ?? emoji.name;
    const r = msg.reactions?.find((x) => (x.emoji.id ?? x.emoji.name) === key);
    if (!r) return false;
    msg.reactions = msg.reactions.filter((x) => x !== r);
    const d = { channel_id: channelId, message_id: messageId, emoji: { ...r.emoji } };
    if (msg.guild_id) d.guild_id = msg.guild_id;
    this.dispatch('MESSAGE_REACTION_REMOVE_EMOJI', d, this.reactionTarget(msg));
    return true;
  }

  openDM(userA, userB) {
    let c = this.w.dmChannelBetween(userA, userB);
    if (c) return c;
    c = { id: this.w.id(), type: ChannelType.DM, recipients: [userA, userB], last_message_id: null };
    this.w.state.channels[c.id] = c;
    this.w.state.messages[c.id] = {};
    return c;
  }

  // ---- invites ---------------------------------------------------------------
  createInvite(guildId, { channelId, inviterId, code, maxUses = 0, maxAge = 86400, temporary = false } = {}) {
    const inv = {
      code: code ?? this.w.rng.chars(8),
      guild_id: guildId,
      channel_id: channelId ?? this.w.guild(guildId).system_channel_id,
      inviter_id: inviterId ?? null,
      uses: 0,
      max_uses: maxUses,
      max_age: maxAge,
      temporary,
      created_at: this.w.iso(),
    };
    this.w.state.invites[inv.code] = inv;
    // https://discord.com/developers/docs/events/gateway-events#invite-create
    this.dispatch('INVITE_CREATE', {
      channel_id: inv.channel_id, code: inv.code, created_at: inv.created_at, guild_id: guildId,
      inviter: inv.inviter_id ? this.w.userJSON(inv.inviter_id) : undefined, max_age: maxAge, max_uses: maxUses, temporary, uses: 0,
    }, { guildId, channelId: inv.channel_id });
    return inv;
  }

  deleteInvite(code, { actorId, reason } = {}) {
    const inv = this.w.state.invites[code];
    delete this.w.state.invites[code];
    this.audit(inv.guild_id, { actorId, action_type: A.INVITE_DELETE, target_id: null, reason, changes: [
      { key: 'code', old_value: inv.code }, { key: 'channel_id', old_value: inv.channel_id },
      ...(inv.inviter_id ? [{ key: 'inviter_id', old_value: inv.inviter_id }] : []),
      { key: 'max_uses', old_value: inv.max_uses }, { key: 'uses', old_value: inv.uses }, { key: 'max_age', old_value: inv.max_age }, { key: 'temporary', old_value: inv.temporary },
    ] });
    // https://discord.com/developers/docs/events/gateway-events#invite-delete
    this.dispatch('INVITE_DELETE', { channel_id: inv.channel_id, guild_id: inv.guild_id, code }, { guildId: inv.guild_id, channelId: inv.channel_id });
    return inv;
  }

  // ---- AutoMod ---------------------------------------------------------------
  // https://discord.com/developers/docs/resources/auto-moderation
  runAutoMod(guildId, channelId, msg) {
    const g = this.w.guild(guildId);
    const author = this.w.user(msg.author_id);
    const alerts = [];
    if (!author || author.bot || msg.webhook_id) return { blocked: false, alerts };
    const member = g.members[msg.author_id];
    const channel = this.w.channel(channelId);
    // Members with MANAGE_GUILD or ADMINISTRATOR are exempt from AutoMod.
    // https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-rule-object (exempt_roles note)
    const perms = computePermissions(this.w, guildId, msg.author_id);
    if (perms & (P.MANAGE_GUILD | P.ADMINISTRATOR)) return { blocked: false, alerts };
    let blocked = false;
    for (const rule of Object.values(g.automod_rules)) {
      if (!rule.enabled || rule.event_type !== 1) continue;
      if (rule.exempt_roles?.some((r) => member?.roles.includes(r))) continue;
      if (rule.exempt_channels?.includes(channelId) || (channel?.parent_id && rule.exempt_channels?.includes(channel.parent_id))) continue;
      const match = matchRule(rule, msg);
      if (!match) continue;
      for (const action of rule.actions) {
        const exec = {
          guild_id: guildId, action: deepClone(action), rule_id: rule.id, rule_trigger_type: rule.trigger_type,
          user_id: msg.author_id, channel_id: channelId, content: msg.content,
          matched_keyword: match.keyword ?? null, matched_content: match.content ?? null,
        };
        if (action.type === AutoModActionType.BLOCK_MESSAGE) {
          blocked = true;
          this.audit(guildId, {
            actorId: msg.author_id, action_type: A.AUTO_MODERATION_BLOCK_MESSAGE, target_id: msg.author_id,
            options: { auto_moderation_rule_name: rule.name, auto_moderation_rule_trigger_type: String(rule.trigger_type), channel_id: channelId },
          });
          this.dispatch('AUTO_MODERATION_ACTION_EXECUTION', exec, { guildId, autoModExecution: true });
          this.w.emit('automod-blocked', { guildId, channelId, userId: msg.author_id, ruleId: rule.id, content: msg.content, customMessage: action.metadata?.custom_message });
        } else if (action.type === AutoModActionType.SEND_ALERT_MESSAGE) {
          alerts.push({ rule, action, exec });
        } else if (action.type === AutoModActionType.TIMEOUT && member) {
          const until = this.w.iso(this.w.now() + (action.metadata?.duration_seconds ?? 60) * 1000);
          member.communication_disabled_until = until;
          this.audit(guildId, {
            actorId: msg.author_id, action_type: A.AUTO_MODERATION_USER_COMMUNICATION_DISABLED, target_id: msg.author_id,
            options: { auto_moderation_rule_name: rule.name, auto_moderation_rule_trigger_type: String(rule.trigger_type), channel_id: channelId },
          });
          this.dispatch('GUILD_MEMBER_UPDATE', { ...this.w.memberJSON(guildId, msg.author_id), guild_id: guildId }, { guildId, subjectUserId: msg.author_id });
          this.dispatch('AUTO_MODERATION_ACTION_EXECUTION', exec, { guildId, autoModExecution: true });
        }
      }
    }
    if (blocked && alerts.length) this.flushAutoModAlerts(msg, alerts, true);
    return { blocked, alerts: blocked ? [] : alerts };
  }

  flushAutoModAlerts(msg, alerts, blocked) {
    for (const { rule, action, exec } of alerts) {
      const alertChannel = action.metadata?.channel_id;
      let alert = null;
      if (alertChannel && this.w.channel(alertChannel)) {
        // https://discord.com/developers/docs/resources/message#message-object-message-types – AUTO_MODERATION_ACTION (24)
        alert = this.createMessage(alertChannel, {
          authorId: msg.author_id, type: MessageType.AUTO_MODERATION_ACTION, content: '',
          embeds: [{ type: 'auto_moderation_message', description: msg.content, fields: [
            { name: 'rule_name', value: rule.name, inline: false },
            { name: 'channel_id', value: msg.channel_id, inline: false },
            { name: 'keyword', value: exec.matched_keyword ?? '', inline: false },
            { name: 'keyword_matched_content', value: exec.matched_content ?? '', inline: false },
          ] }],
        }, { skipAutoMod: true });
        this.audit(msg.guild_id, {
          actorId: msg.author_id, action_type: A.AUTO_MODERATION_FLAG_TO_CHANNEL, target_id: msg.author_id,
          options: { auto_moderation_rule_name: rule.name, auto_moderation_rule_trigger_type: String(rule.trigger_type), channel_id: msg.channel_id },
        });
      }
      const d = { ...exec };
      if (!blocked) d.message_id = msg.id;
      if (alert) d.alert_system_message_id = alert.id;
      this.dispatch('AUTO_MODERATION_ACTION_EXECUTION', d, { guildId: msg.guild_id, autoModExecution: true });
    }
  }

  // ---- monetization ----------------------------------------------------------
  // https://discord.com/developers/docs/resources/entitlement#entitlement-object
  entitlementJSON(e) {
    const out = {
      id: e.id, sku_id: e.sku_id, application_id: e.application_id, type: e.type, deleted: !!e.deleted,
      starts_at: e.starts_at ?? null, ends_at: e.ends_at ?? null, consumed: !!e.consumed,
    };
    if (e.user_id) out.user_id = e.user_id;
    if (e.guild_id) out.guild_id = e.guild_id;
    if (e.subscription_id) out.subscription_id = e.subscription_id;
    return out;
  }

  createEntitlement({ applicationId, skuId, userId, guildId, type, startsAt, endsAt, subscriptionId }) {
    const e = {
      id: this.w.id(), sku_id: skuId, application_id: applicationId, type, deleted: false, consumed: false,
      starts_at: startsAt ?? null, ends_at: endsAt ?? null,
    };
    if (userId) e.user_id = userId;
    if (guildId) e.guild_id = guildId;
    if (subscriptionId) e.subscription_id = subscriptionId;
    this.w.state.entitlements[e.id] = e;
    // https://discord.com/developers/docs/events/gateway-events#entitlement-create
    this.dispatch('ENTITLEMENT_CREATE', this.entitlementJSON(e), { applicationId, guildId: guildId ?? undefined, appEvent: true });
    return e;
  }

  updateEntitlement(id, patch) {
    const e = this.w.state.entitlements[id];
    Object.assign(e, patch);
    // https://discord.com/developers/docs/events/gateway-events#entitlement-update
    this.dispatch('ENTITLEMENT_UPDATE', this.entitlementJSON(e), { applicationId: e.application_id, guildId: e.guild_id, appEvent: true });
    return e;
  }

  deleteEntitlement(id) {
    const e = this.w.state.entitlements[id];
    e.deleted = true;
    // https://discord.com/developers/docs/events/gateway-events#entitlement-delete
    this.dispatch('ENTITLEMENT_DELETE', this.entitlementJSON(e), { applicationId: e.application_id, guildId: e.guild_id, appEvent: true });
    return e;
  }
}

// ---- helpers -----------------------------------------------------------------
function change(key, oldValue, newValue) {
  const c = { key };
  if (oldValue !== undefined && oldValue !== null) c.old_value = oldValue;
  if (newValue !== undefined && newValue !== null) c.new_value = newValue;
  return c;
}

export function normOverwrite(o) {
  return { id: String(o.id), type: Number(o.type), allow: toBits(o.allow ?? 0).toString(), deny: toBits(o.deny ?? 0).toString() };
}

function toTime(t) {
  return typeof t === 'number' ? t : Date.parse(t);
}

// https://discord.com/developers/docs/reference#message-formatting
export function parseMentions(world, content, guildId) {
  const users = [];
  const roles = [];
  for (const m of content.matchAll(/<@!?(\d{15,21})>/g)) if (world.user(m[1]) && !users.includes(m[1])) users.push(m[1]);
  if (guildId) for (const m of content.matchAll(/<@&(\d{15,21})>/g)) if (world.role(guildId, m[1]) && !roles.includes(m[1])) roles.push(m[1]);
  const everyone = /@(everyone|here)\b/.test(content);
  return { users, roles, everyone };
}

// https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-rule-object-keyword-matching-strategies
function matchRule(rule, msg) {
  const content = msg.content ?? '';
  const md = rule.trigger_metadata ?? {};
  if (rule.trigger_type === AutoModTriggerType.KEYWORD) {
    const allowed = (md.allow_list ?? []).map((a) => keywordRegex(a));
    for (const kw of md.keyword_filter ?? []) {
      const m = content.match(keywordRegex(kw));
      if (m && !allowed.some((re) => re.test(m[0]))) return { keyword: kw, content: m[0].trim() };
    }
    for (const pattern of md.regex_patterns ?? []) {
      let re;
      try { re = new RegExp(pattern, 'iu'); } catch { continue; }
      const m = content.match(re);
      if (m) return { keyword: pattern, content: m[0] };
    }
    return null;
  }
  if (rule.trigger_type === AutoModTriggerType.MENTION_SPAM) {
    const total = (msg.mentions?.length ?? 0) + (msg.mention_roles?.length ?? 0);
    if (md.mention_total_limit && total > md.mention_total_limit) return { keyword: null, content: null };
    return null;
  }
  // ASSUMPTION: SPAM, KEYWORD_PRESET and MEMBER_PROFILE use Discord-internal classifiers; they never match here
  // unless the message content contains the literal marker "[automod:<trigger_type>]".
  if (content.includes(`[automod:${rule.trigger_type}]`)) return { keyword: null, content: null };
  return null;
}

// Keyword wildcards: "*cat*" anywhere, "cat*" prefix, "*cat" suffix, "cat" whole word.
function keywordRegex(kw) {
  const pre = kw.startsWith('*');
  const post = kw.endsWith('*');
  const core = kw.replace(/^\*|\*$/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${pre ? '\\S*' : '(?<![\\p{L}\\p{N}_])'}${core}${post ? '\\S*' : '(?![\\p{L}\\p{N}_])'}`, 'iu');
}
