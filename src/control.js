import { parsePermissions } from './permissions.js';
import { computePermissions } from './permissions.js';
import {
  ChannelType, MessageType, Permissions as P, EntitlementType, SubscriptionStatus, THREAD_TYPES,
} from './constants.js';
import { toBits, deepClone, compareIds } from './util.js';
import { commandJSON, skuJSON, subscriptionJSON } from './rest/apps.js';

// The control API is test-only. It lives under /_fake on HTTP and on `fake.control` in code,
// and never shares paths with the Discord API.
//
// Every method takes one options object and returns JSON-able data, so the HTTP mirror is
// simply POST /_fake/<method> with that object as the JSON body.

export class ControlError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class Control {
  constructor({ world, ops, server }) {
    this.world = world;
    this.ops = ops;
    this.server = server;
    this.snapshots = new Map();
    this.snapshotSeq = 0;
    server.control = this;
  }

  // ===========================================================================
  // Clock
  // ===========================================================================
  now() { return { now: this.world.now(), iso: this.world.iso() }; }
  setNow(arg) {
    const time = typeof arg === 'object' && arg !== null && !(arg instanceof Date) ? arg.time : arg;
    this.world.clock.setNow(time);
    return this.now();
  }
  advance(arg) {
    const ms = typeof arg === 'object' ? arg.ms : arg;
    this.world.clock.advance(ms);
    return this.now();
  }

  // ===========================================================================
  // World setup
  // ===========================================================================
  createApplication(opts = {}) {
    const app = this.ops.createApplication(opts);
    return appSummary(app);
  }

  setPrivilegedIntents({ applicationId, guildMembers, guildPresences, messageContent }) {
    const app = this.mustApp(applicationId);
    if (guildMembers !== undefined) app.privileged.guild_members = !!guildMembers;
    if (guildPresences !== undefined) app.privileged.guild_presences = !!guildPresences;
    if (messageContent !== undefined) app.privileged.message_content = !!messageContent;
    return { ...app.privileged };
  }

  setRedirectUris({ applicationId, redirectUris }) {
    this.mustApp(applicationId).redirect_uris = [...redirectUris];
    return { redirect_uris: [...redirectUris] };
  }

  createUser(opts = {}) {
    return this.world.userJSON(this.ops.createUser(opts));
  }

  createGuild(opts = {}) {
    const g = this.ops.createGuild({ ...opts, everyonePermissions: opts.everyonePermissions !== undefined ? parsePermissions(opts.everyonePermissions) : undefined });
    return { id: g.id, name: g.name, owner_id: g.owner_id, everyone_role_id: g.id, system_channel_id: g.system_channel_id ?? null };
  }

  updateGuild({ guildId, ...patch }) {
    const g = this.mustGuild(guildId);
    const map = { systemChannelId: 'system_channel_id', rulesChannelId: 'rules_channel_id', publicUpdatesChannelId: 'public_updates_channel_id', features: 'features', name: 'name', preferredLocale: 'preferred_locale', ownerId: 'owner_id', systemChannelFlags: 'system_channel_flags' };
    for (const [k, v] of Object.entries(patch)) if (map[k]) g[map[k]] = v;
    this.ops.dispatch('GUILD_UPDATE', this.world.guildJSON(g), { guildId });
    return this.world.guildJSON(g);
  }

  createRole({ guildId, name, permissions, position, color, hoist, mentionable, actorId, reason, id }) {
    this.mustGuild(guildId);
    const role = this.ops.createRole(guildId, {
      id, name, color, hoist, mentionable, position,
      permissions: permissions === undefined ? undefined : parsePermissions(permissions),
    }, { actorId, reason });
    return this.world.roleJSON(role);
  }

  updateRole({ guildId, roleId, actorId, reason, ...patch }) {
    this.mustRole(guildId, roleId);
    if (patch.permissions !== undefined) patch.permissions = parsePermissions(patch.permissions);
    return this.world.roleJSON(this.ops.updateRole(guildId, roleId, patch, { actorId, reason }));
  }

  setRolePosition({ guildId, roleId, position, actorId, reason }) {
    this.mustRole(guildId, roleId);
    this.ops.setRolePositions(guildId, [{ id: roleId, position }], { actorId, reason });
    return this.world.roleJSON(this.world.role(guildId, roleId));
  }

  createChannel({ guildId, name, type = ChannelType.GUILD_TEXT, parentId, topic, position, permissionOverwrites, nsfw, rateLimitPerUser, ownerId, actorId, reason, id }) {
    this.mustGuild(guildId);
    const c = this.ops.createChannel(guildId, {
      id, name, type, parent_id: parentId, topic, position, nsfw, rate_limit_per_user: rateLimitPerUser, owner_id: ownerId,
      permission_overwrites: (permissionOverwrites ?? []).map(normOw),
    }, { actorId, reason });
    return this.world.channelJSON(c);
  }

  updateChannel({ channelId, actorId, reason, ...patch }) {
    this.mustChannel(channelId);
    const p = {};
    const map = { name: 'name', topic: 'topic', position: 'position', parentId: 'parent_id', nsfw: 'nsfw', rateLimitPerUser: 'rate_limit_per_user' };
    for (const [k, v] of Object.entries(patch)) if (map[k]) p[map[k]] = v;
    if (patch.permissionOverwrites) p.permission_overwrites = patch.permissionOverwrites.map(normOw);
    return this.world.channelJSON(this.ops.updateChannel(channelId, p, { actorId, reason }));
  }

  setPermissionOverwrite({ channelId, id, type, allow = 0, deny = 0, actorId, reason }) {
    this.mustChannel(channelId);
    if (actorId) return this.actAsOrThrow(actorId, 'PUT', `/channels/${channelId}/permissions/${id}`, { body: { type, allow: parsePermissions(allow).toString(), deny: parsePermissions(deny).toString() }, reason });
    this.ops.putOverwrite(channelId, normOw({ id, type, allow, deny }), {});
    return this.world.channelJSON(this.world.channel(channelId));
  }

  addMember({ guildId, userId, roles = [], nick, pending, joinedAt, communicationDisabledUntil, inviteCode }) {
    const g = this.mustGuild(guildId);
    this.mustUser(userId);
    if (g.bans[userId]) throw new ControlError(`user ${userId} is banned from guild ${guildId}`);
    for (const r of roles) this.mustRole(guildId, r);
    this.ops.addMember(guildId, userId, { roles, nick, pending, joinedAt, communicationDisabledUntil: communicationDisabledUntil ?? null, inviteCode });
    return this.world.memberJSON(guildId, userId);
  }

  updateMember({ guildId, userId, actorId, reason, roles, nick, communicationDisabledUntil, pending, flags }) {
    this.mustMember(guildId, userId);
    const patch = {};
    if (roles !== undefined) patch.roles = roles;
    if (nick !== undefined) patch.nick = nick;
    if (communicationDisabledUntil !== undefined) patch.communication_disabled_until = communicationDisabledUntil;
    if (pending !== undefined) patch.pending = pending;
    if (flags !== undefined) patch.flags = flags;
    this.ops.updateMember(guildId, userId, patch, { actorId, reason });
    return this.world.memberJSON(guildId, userId);
  }

  setMemberRoles({ guildId, userId, roles, actorId, reason }) {
    return this.updateMember({ guildId, userId, roles, actorId, reason });
  }

  /** Add the bot like the OAuth2 install would (managed role with `permissions`). */
  installBot({ applicationId, guildId, permissions = 0, installerId, rolePosition }) {
    const app = this.mustApp(applicationId);
    const g = this.mustGuild(guildId);
    this.server.oauth.installBot({ app, guildId, permissions: parsePermissions(permissions), installerId: installerId ?? g.owner_id, rolePosition });
    return this.world.memberJSON(guildId, app.bot_user_id);
  }

  /** Set the permissions of the bot's managed role (creating it if needed). */
  setBotPermissions({ applicationId, guildId, permissions, actorId }) {
    const app = this.mustApp(applicationId);
    this.mustMember(guildId, app.bot_user_id);
    const bits = parsePermissions(permissions);
    let role = this.botRole(guildId, app);
    if (!role) {
      role = this.ops.createRole(guildId, { name: app.name, permissions: bits, managed: true, tags: { bot_id: app.bot_user_id } }, { actorId });
      const m = this.world.member(guildId, app.bot_user_id);
      this.ops.updateMember(guildId, app.bot_user_id, { roles: [...m.roles, role.id] }, {});
    } else {
      this.ops.updateRole(guildId, role.id, { permissions: bits }, { actorId });
    }
    return { role: this.world.roleJSON(role), permissions: computePermissions(this.world, guildId, app.bot_user_id).toString() };
  }

  /** Move the bot's managed role (its highest role) to `position`. */
  setBotRolePosition({ applicationId, guildId, position, actorId }) {
    const app = this.mustApp(applicationId);
    const role = this.botRole(guildId, app);
    if (!role) throw new ControlError('the bot has no managed role in this guild; call setBotPermissions first');
    this.ops.setRolePositions(guildId, [{ id: role.id, position }], { actorId });
    return this.world.roleJSON(role);
  }

  botRole(guildId, app) {
    return Object.values(this.mustGuild(guildId).roles).find((r) => r.tags?.bot_id === app.bot_user_id);
  }

  createInvite({ guildId, channelId, inviterId, code, maxUses, maxAge }) {
    this.mustGuild(guildId);
    return this.server.inviteJSON(this.ops.createInvite(guildId, { channelId, inviterId, code, maxUses, maxAge }));
  }

  registerCommand({ applicationId, guildId, command }) {
    const app = this.mustApp(applicationId);
    const out = this.server.executeAs({ kind: 'bot', app, userId: app.bot_user_id }, 'POST',
      guildId ? `/applications/${app.id}/guilds/${guildId}/commands` : `/applications/${app.id}/commands`, { body: command });
    if (out.status >= 400) throw new ControlError(`registerCommand failed: ${JSON.stringify(out.body)}`, out);
    return out.body;
  }

  listCommands({ applicationId, guildId }) {
    return Object.values(this.world.state.commands).filter((c) => c.application_id === applicationId && (guildId === undefined || (c.guild_id ?? null) === (guildId ?? null))).map((c) => commandJSON(c));
  }

  /** User-install the app (integration_type 1) for a user. */
  installForUser({ applicationId, userId }) {
    this.mustApp(applicationId);
    this.mustUser(userId);
    (this.world.state.userInstalls[applicationId] ??= {})[userId] = { installed_at: this.world.iso(), scopes: ['applications.commands'] };
    return { ok: true };
  }

  uninstallForUser({ applicationId, userId }) {
    delete this.world.state.userInstalls[applicationId]?.[userId];
    return { ok: true };
  }

  setOAuthUser({ userId, guildId } = {}) {
    if (userId) this.mustUser(userId);
    this.server.oauth.setUser(userId, { guildId });
    return { userId, guildId: guildId ?? this.server.oauth.defaultGuildId };
  }

  setOAuthMode({ mode }) {
    if (!['auto', 'consent'].includes(mode)) throw new ControlError(`unknown oauth mode ${mode}`);
    this.server.oauth.mode = mode;
    return { mode };
  }

  // ---- monetization ----------------------------------------------------------
  // https://discord.com/developers/docs/resources/sku#sku-object
  createSku({ applicationId, name, type = 5, slug, flags = 1 << 7 }) {
    this.mustApp(applicationId);
    const id = this.world.id();
    const sku = { id, application_id: applicationId, name, type, slug: slug ?? name.toLowerCase().replace(/\W+/g, '-'), flags };
    this.world.state.skus[id] = sku;
    return skuJSON(sku);
  }

  grantEntitlement({ applicationId, skuId, userId, guildId, type = EntitlementType.PURCHASE, startsAt, endsAt }) {
    this.mustApp(applicationId);
    if (!this.world.state.skus[skuId]) throw new ControlError(`unknown sku ${skuId}`);
    return this.ops.entitlementJSON(this.ops.createEntitlement({ applicationId, skuId, userId, guildId, type, startsAt, endsAt }));
  }

  updateEntitlement({ entitlementId, endsAt, startsAt, consumed }) {
    const patch = {};
    if (endsAt !== undefined) patch.ends_at = endsAt;
    if (startsAt !== undefined) patch.starts_at = startsAt;
    if (consumed !== undefined) patch.consumed = consumed;
    return this.ops.entitlementJSON(this.ops.updateEntitlement(entitlementId, patch));
  }

  deleteEntitlement({ entitlementId }) {
    return this.ops.entitlementJSON(this.ops.deleteEntitlement(entitlementId));
  }

  /** A user subscription (also grants an APPLICATION_SUBSCRIPTION entitlement, like Discord). */
  createSubscription({ applicationId, userId, guildId, skuIds, status = SubscriptionStatus.ACTIVE, currentPeriodStart, currentPeriodEnd }) {
    this.mustUser(userId);
    const start = currentPeriodStart ?? this.world.iso();
    const end = currentPeriodEnd ?? this.world.iso(this.world.now() + 30 * 24 * 3600 * 1000);
    const ents = skuIds.map((skuId) => this.ops.createEntitlement({
      applicationId, skuId, userId, guildId, type: EntitlementType.APPLICATION_SUBSCRIPTION, startsAt: start, endsAt: end,
    }));
    const id = this.world.id();
    const sub = {
      id, user_id: userId, sku_ids: [...skuIds], entitlement_ids: ents.map((e) => e.id), renewal_sku_ids: null,
      current_period_start: start, current_period_end: end, status, canceled_at: null,
    };
    for (const e of ents) e.subscription_id = id;
    this.world.state.subscriptions[id] = sub;
    // https://discord.com/developers/docs/events/gateway-events#subscription-create
    this.ops.dispatch('SUBSCRIPTION_CREATE', subscriptionJSON(sub), { applicationId, appEvent: true });
    return subscriptionJSON(sub);
  }

  // ===========================================================================
  // Acting as people
  // ===========================================================================
  /**
   * Post a message as a user.
   * attachments: [{ filename, contentType, data, base64 }]; replyTo: messageId; forward: { channelId, messageId };
   * type: a service message type (e.g. 7 USER_JOIN); timestamp: backdate the message (its id encodes it).
   * Permissions (SEND_MESSAGES, timeout) are enforced unless force: true.
   */
  postMessage({ channelId, authorId, content = '', embeds, components, attachments, replyTo, forward, type, flags, timestamp, force = false, mentionRepliedUser, poll, webhookId, applicationId }) {
    const c = this.mustChannel(channelId);
    this.mustUser(authorId);
    if (c.guild_id) {
      if (!force) {
        if (!this.world.member(c.guild_id, authorId)) throw new ControlError(`user ${authorId} is not a member of guild ${c.guild_id}`);
        const perms = computePermissions(this.world, c.guild_id, authorId, c.id);
        const need = THREAD_TYPES.has(c.type) ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES;
        if (!(perms & need)) throw new ControlError(`user ${authorId} cannot send messages in ${channelId} (missing permission or timed out)`, { status: 403, body: { code: 50013 } });
      }
    } else if (!c.recipients?.includes(authorId) && !force) {
      throw new ControlError(`user ${authorId} is not in DM ${channelId}`);
    }
    const data = {
      authorId, content, embeds, components, poll, type, flags,
      timestampMs: timestamp !== undefined ? new Date(timestamp).getTime() : undefined,
      attachments: (attachments ?? []).map((a) => this.server.storeAttachment(channelId, a)),
      mentionRepliedUser,
      webhook_id: webhookId,
      application_id: applicationId,
    };
    if (replyTo) {
      const ref = this.world.message(channelId, replyTo);
      if (!ref) throw new ControlError(`unknown message ${replyTo}`);
      data.type = type ?? MessageType.REPLY;
      data.message_reference = { type: 0, message_id: replyTo, channel_id: channelId, guild_id: c.guild_id ?? undefined };
    }
    if (forward) {
      const src = this.world.message(forward.channelId, forward.messageId);
      if (!src) throw new ControlError(`unknown message ${forward.messageId}`);
      const snap = this.world.messageJSON(src, { referenced: false });
      data.message_reference = { type: 1, message_id: src.id, channel_id: src.channel_id, guild_id: src.guild_id ?? undefined };
      data.message_snapshots = [{ message: { type: snap.type, content: snap.content, embeds: snap.embeds, attachments: snap.attachments, timestamp: snap.timestamp, edited_timestamp: snap.edited_timestamp, flags: snap.flags, mentions: snap.mentions, mention_roles: snap.mention_roles, components: snap.components } }];
      data.flags = (data.flags ?? 0) | (1 << 14);
    }
    const msg = this.ops.createMessage(channelId, data);
    if (!msg) return { blocked: true, by: 'automod' };
    return this.world.messageJSON(msg);
  }

  editMessage({ channelId, messageId, content, embeds, components }) {
    this.mustMessage(channelId, messageId);
    const patch = {};
    if (content !== undefined) patch.content = content;
    if (embeds !== undefined) patch.embeds = embeds;
    if (components !== undefined) patch.components = components;
    return this.world.messageJSON(this.ops.editMessage(channelId, messageId, patch));
  }

  /** Delete a message. With actorId ≠ author, the actor needs MANAGE_MESSAGES (unless force) and it is audit-logged. */
  deleteMessage({ channelId, messageId, actorId, reason, force = false }) {
    const m = this.mustMessage(channelId, messageId);
    const actor = actorId ?? m.author_id;
    if (!force && actor !== m.author_id) return this.actAsOrThrow(actor, 'DELETE', `/channels/${channelId}/messages/${messageId}`, { reason });
    this.ops.deleteMessage(channelId, messageId, { actorId: actor, reason });
    return { ok: true };
  }

  /** A user joins a guild (optionally with an invite code). Posts the USER_JOIN system message. */
  join({ guildId, userId, inviteCode, pending = false }) {
    const g = this.mustGuild(guildId);
    this.mustUser(userId);
    if (g.bans[userId]) throw new ControlError(`user ${userId} is banned from guild ${guildId}`, { status: 403 });
    if (g.members[userId]) throw new ControlError(`user ${userId} is already a member of guild ${guildId}`);
    if (inviteCode) {
      const inv = this.world.state.invites[inviteCode];
      if (!inv || inv.guild_id !== guildId) throw new ControlError(`unknown invite ${inviteCode}`, { status: 404, body: { code: 10006 } });
      if (inv.max_uses && inv.uses >= inv.max_uses) throw new ControlError(`invite ${inviteCode} has no uses left`, { status: 404, body: { code: 10006 } });
      inv.uses++;
    }
    this.ops.addMember(guildId, userId, { pending, inviteCode });
    // https://discord.com/developers/docs/resources/guild#guild-object-system-channel-flags – SUPPRESS_JOIN_NOTIFICATIONS (1 << 0)
    if (g.system_channel_id && !((g.system_channel_flags ?? 0) & 1) && !this.world.user(userId).bot) {
      this.ops.createMessage(g.system_channel_id, { authorId: userId, type: MessageType.USER_JOIN, content: '' }, { skipAutoMod: true });
    }
    return this.world.memberJSON(guildId, userId);
  }

  leave({ guildId, userId }) {
    this.mustMember(guildId, userId);
    if (this.world.guild(guildId).owner_id === userId) throw new ControlError('the owner cannot leave the guild');
    this.ops.removeMember(guildId, userId, {});
    return { ok: true };
  }

  runCommand(opts) { return this.server.interactions.runCommand(opts); }
  pressButton(opts) { return this.server.interactions.pressButton(opts); }
  submitModal(opts) { return this.server.interactions.submitModal(opts); }

  /**
   * Perform a Discord REST call as a person (with that person's permissions and hierarchy).
   * Returns { status, body }; produces the same audit entries and gateway events as a bot call.
   */
  actAs({ userId, method, path, body, query, reason }) {
    this.mustUser(userId);
    const out = this.server.executeAs({ kind: 'user', userId }, method.toUpperCase(), path, { body, query, reason });
    return { status: out.status, body: out.body ?? null };
  }

  actAsOrThrow(userId, method, path, { body, query, reason } = {}) {
    const out = this.actAs({ userId, method, path, body, query, reason });
    if (out.status >= 400) throw new ControlError(`${method} ${path} as ${userId} failed with ${out.status}: ${JSON.stringify(out.body)}`, out);
    return out.body ?? { ok: true };
  }

  // ---- hostile or careless staff (each goes through the real route as that actor) ----
  kickMember({ actorId, guildId, userId, reason }) { return this.actAsOrThrow(actorId, 'DELETE', `/guilds/${guildId}/members/${userId}`, { reason }); }
  banMember({ actorId, guildId, userId, reason, deleteMessageSeconds }) {
    return this.actAsOrThrow(actorId, 'PUT', `/guilds/${guildId}/bans/${userId}`, { body: deleteMessageSeconds ? { delete_message_seconds: deleteMessageSeconds } : {}, reason });
  }
  unbanMember({ actorId, guildId, userId, reason }) { return this.actAsOrThrow(actorId, 'DELETE', `/guilds/${guildId}/bans/${userId}`, { reason }); }
  massBan({ actorId, guildId, userIds, reason, deleteMessageSeconds }) {
    return this.actAsOrThrow(actorId, 'POST', `/guilds/${guildId}/bulk-ban`, { body: { user_ids: userIds, delete_message_seconds: deleteMessageSeconds }, reason });
  }
  massKick({ actorId, guildId, userIds, reason }) {
    return userIds.map((userId) => this.actAs({ userId: actorId, method: 'DELETE', path: `/guilds/${guildId}/members/${userId}`, reason }));
  }
  timeoutMember({ actorId, guildId, userId, until, reason }) {
    return this.actAsOrThrow(actorId, 'PATCH', `/guilds/${guildId}/members/${userId}`, { body: { communication_disabled_until: until }, reason });
  }
  deleteChannel({ channelId, actorId, reason }) {
    if (actorId) return this.actAsOrThrow(actorId, 'DELETE', `/channels/${channelId}`, { reason });
    this.mustChannel(channelId);
    return this.ops.deleteChannel(channelId, {});
  }
  deleteRole({ guildId, roleId, actorId, reason }) {
    if (actorId) return this.actAsOrThrow(actorId, 'DELETE', `/guilds/${guildId}/roles/${roleId}`, { reason });
    this.mustRole(guildId, roleId);
    this.ops.deleteRole(guildId, roleId, {});
    return { ok: true };
  }
  editRolePermissions({ actorId, guildId, roleId, permissions, reason }) {
    return this.actAsOrThrow(actorId, 'PATCH', `/guilds/${guildId}/roles/${roleId}`, { body: { permissions: parsePermissions(permissions).toString() }, reason });
  }

  // ===========================================================================
  // Faults
  // ===========================================================================
  injectRateLimit({ route, path, method, count = 1, retryAfter = 1, global = false, scope } = {}) {
    return { id: this.server.faults.add('rateLimit', { route, path: toPath(path), method, count, retryAfter, global, scope }) };
  }
  injectError({ route, path, method, count = 1, status = 500, body } = {}) {
    return { id: this.server.faults.add('error', { route, path: toPath(path), method, count, status, body }) };
  }
  /** Apply the write, then drop the connection: the client sees an unknown outcome. */
  injectDrop({ route, path, method, count = 1 } = {}) {
    return { id: this.server.faults.add('drop', { route, path: toPath(path), method, count }) };
  }
  injectDelay({ route, path, method, count = 1, ms = 1000 } = {}) {
    return { id: this.server.faults.add('delay', { route, path: toPath(path), method, count, ms }) };
  }
  /**
   * Change the world right before a matching request (drift between two calls).
   * action: { method: '<control method>', args: {...} } (HTTP) or fn(ctx) (code).
   */
  injectDrift({ route, path, method, count = 1, action, fn } = {}) {
    return { id: this.server.faults.add('hook', { route, path: toPath(path), method, count, action, fn }) };
  }
  clearFaults() { this.server.faults.clear(); return { ok: true }; }
  removeFault({ id }) { this.server.faults.remove(id); return { ok: true }; }
  listFaults() { return this.server.faults.list(); }

  /** Configure a per-route bucket: route 'POST /channels/:channel_id/messages'. limit null removes it. */
  setRateLimit({ route, limit, windowMs = 1000 }) {
    // Configuring a limit turns automatic rate limiting on (it starts off with a manual clock).
    this.server.rateLimiter.config.enabled = true;
    if (route === 'global') this.server.rateLimiter.config.global = limit === null ? null : { limit, windowMs };
    else if (route === 'default') this.server.rateLimiter.config.default = { limit, windowMs };
    else this.server.rateLimiter.setRoute(route, limit === null ? null : { limit, windowMs });
    this.server.rateLimiter.reset();
    return { ok: true };
  }
  setRateLimitsEnabled({ enabled }) { this.server.rateLimiter.config.enabled = !!enabled; return { ok: true }; }
  resetRateLimits() { this.server.rateLimiter.reset(); return { ok: true }; }

  gatewaySessions() { return this.server.gateway.listSessions(); }
  closeGatewaySession({ sessionId, applicationId, shard, code = 4000, reason } = {}) {
    return { closed: this.server.gateway.closeSessions({ sessionId, applicationId, shard }, code, reason) };
  }
  invalidateGatewaySession({ sessionId, applicationId, shard, resumable = false } = {}) {
    return { invalidated: this.server.gateway.invalidateSessions({ sessionId, applicationId, shard }, resumable) };
  }
  requestGatewayReconnect({ sessionId, applicationId, shard } = {}) {
    return { sent: this.server.gateway.requestReconnect({ sessionId, applicationId, shard }) };
  }
  requestHeartbeat({ sessionId, applicationId, shard } = {}) {
    return { sent: this.server.gateway.requestHeartbeat({ sessionId, applicationId, shard }) };
  }

  expireInteraction({ interactionId }) {
    this.server.interactions.expire(interactionId);
    return { ok: true };
  }

  // ===========================================================================
  // Reading state
  // ===========================================================================
  getState() { return deepClone(this.world.state); }
  getGuild({ guildId }) { return this.world.guildJSON(this.mustGuild(guildId), { withCounts: true }); }
  getMember({ guildId, userId }) { this.mustMember(guildId, userId); return this.world.memberJSON(guildId, userId); }
  getMembers({ guildId }) { return Object.keys(this.mustGuild(guildId).members).sort(compareIds).map((id) => this.world.memberJSON(guildId, id)); }
  getRoles({ guildId }) { this.mustGuild(guildId); return this.world.sortedRoles(guildId).map((r) => this.world.roleJSON(r)); }
  getChannels({ guildId }) { this.mustGuild(guildId); return this.world.guildChannels(guildId).map((c) => this.world.channelJSON(c)); }
  getBans({ guildId }) { return Object.values(this.mustGuild(guildId).bans).map((b) => ({ reason: b.reason, user: this.world.userJSON(b.user_id) })); }
  getMessages({ channelId }) { this.mustChannel(channelId); return this.world.channelMessages(channelId).map((m) => this.world.messageJSON(m)); }
  getMessage({ channelId, messageId }) { return this.world.messageJSON(this.mustMessage(channelId, messageId)); }
  getPermissions({ guildId, userId, channelId }) { return { permissions: computePermissions(this.world, guildId, userId, channelId).toString() }; }
  getAuditLog({ guildId }) { return this.mustGuild(guildId).audit_log.map((e) => this.world.auditEntryJSON(e)); }
  getInvite({ code }) { const inv = this.world.state.invites[code]; if (!inv) throw new ControlError(`unknown invite ${code}`); return this.server.inviteJSON(inv); }

  getRequestLog({ since = 0, route, method, path } = {}) {
    return this.server.requestLog.filter((e) => e.seq > since && (!route || e.route === route) && (!method || e.method === method) && (!path || e.path.includes(path)));
  }
  getGatewayLog({ sessionId, applicationId, shard, direction, t, since = 0 } = {}) {
    return this.server.gateway.frames.filter((f) => f.seq > since
      && (!sessionId || f.session_id === sessionId)
      && (!applicationId || f.application_id === applicationId)
      && (shard === undefined || (f.shard && f.shard[0] === shard))
      && (!direction || f.direction === direction)
      && (!t || f.t === t));
  }
  /** Dispatches sent, grouped by "<applicationId>/<shard>". */
  getGatewayFramesByShard({ applicationId } = {}) {
    const out = {};
    for (const f of this.server.gateway.frames) {
      if (f.direction !== 'out' || f.op !== 0 || (applicationId && f.application_id !== applicationId)) continue;
      const key = `${f.application_id}/${f.shard?.[0] ?? 0}`;
      (out[key] ??= []).push({ s: f.s, t: f.t, d: f.d });
    }
    return out;
  }
  getInteraction({ interactionId }) {
    const rec = this.server.interactions.byId(interactionId);
    if (!rec) throw new ControlError(`unknown interaction ${interactionId}`);
    return { ...deepClone(rec), user_view: this.server.interactions.userView(interactionId) };
  }
  listInteractions({ applicationId } = {}) {
    return Object.values(this.world.state.interactions).filter((i) => !applicationId || i.application_id === applicationId)
      .map((i) => ({ id: i.id, type: i.type, application_id: i.application_id, user_id: i.user_id, guild_id: i.guild_id ?? null, data: i.data, user_view: this.server.interactions.userView(i.id) }));
  }
  getUserView({ interactionId }) { return this.server.interactions.userView(interactionId); }

  /** A human-readable log of REST requests and gateway frames, in order. */
  formatLog() {
    const lines = [];
    for (const e of this.server.requestLog) {
      lines.push(`${e.at} HTTP #${e.seq} ${e.method} ${e.path} -> ${e.status ?? '…'}${e.fault ? ` [${e.fault}]` : ''}${e.actor ? ` as ${e.actor.kind}:${e.actor.user_id}` : ''}${e.reason ? ` reason=${JSON.stringify(e.reason)}` : ''}`);
    }
    for (const f of this.server.gateway.frames) {
      const what = f.t ? `${f.t} s=${f.s}` : `op=${f.op}`;
      lines.push(`${f.at} WS #${f.seq} ${f.direction} ${f.application_id ?? '-'}/${f.shard?.[0] ?? '-'} ${what}`);
    }
    return lines.join('\n');
  }

  // ===========================================================================
  // Reset / snapshot
  // ===========================================================================
  reset({ keepLogs = false } = {}) {
    this.world.reset();
    this.server.faults.clear();
    this.server.rateLimiter.reset();
    this.server.oauth.setUser(null, { guildId: null });
    if (!keepLogs) { this.server.requestLog.length = 0; this.server.gateway.resetLog(); }
    return { ok: true };
  }
  snapshot() {
    const id = `snap_${++this.snapshotSeq}`;
    this.snapshots.set(id, this.world.snapshot());
    return { id };
  }
  restore({ id }) {
    const snap = this.snapshots.get(id);
    if (!snap) throw new ControlError(`unknown snapshot ${id}`);
    this.world.restore(snap);
    this.server.rateLimiter.reset();
    return { ok: true };
  }

  // ===========================================================================
  // HTTP mirror
  // ===========================================================================
  call(method, args) {
    if (!CALLABLE.has(method)) throw new ControlError(`unknown control method ${method}`, { status: 404 });
    return this[method](args ?? {});
  }

  async handleHttp(req, res, url) {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    };
    const sub = url.pathname.replace(/^\/_fake\/?/, '');
    try {
      if (req.method === 'GET') {
        const q = Object.fromEntries(url.searchParams);
        if (sub === '' ) return send(200, { methods: [...CALLABLE].sort() });
        if (sub === 'state') return send(200, this.getState());
        if (sub === 'log') return send(200, this.getRequestLog({ since: Number(q.since ?? 0), route: q.route, method: q.method, path: q.path }));
        if (sub === 'log.txt') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(this.formatLog()); }
        if (sub === 'gateway-log') return send(200, this.getGatewayLog({ ...q, shard: q.shard === undefined ? undefined : Number(q.shard), since: Number(q.since ?? 0) }));
        if (sub === 'gateway-sessions') return send(200, this.gatewaySessions());
        if (sub === 'audit-log') return send(200, this.getAuditLog({ guildId: q.guild_id }));
        if (sub === 'interactions') return send(200, this.listInteractions({ applicationId: q.application_id }));
        const im = sub.match(/^interactions\/(\d+)$/);
        if (im) return send(200, this.getInteraction({ interactionId: im[1] }));
        if (sub === 'faults') return send(200, this.listFaults());
        if (sub === 'now') return send(200, this.now());
        return send(404, { error: `unknown control resource ${sub}` });
      }
      if (req.method === 'POST') {
        const raw = await new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString())); });
        let args = {};
        if (raw.trim()) {
          try { args = JSON.parse(raw); } catch { return send(400, { error: 'invalid JSON' }); }
        }
        return send(200, this.call(sub, args) ?? { ok: true });
      }
      return send(405, { error: 'use GET or POST' });
    } catch (err) {
      const status = err instanceof ControlError ? (err.status && err.status >= 400 ? err.status : 400) : 500;
      return send(status, { error: err.message, status: err.status, body: err.body });
    }
  }

  // ---- guards ------------------------------------------------------------------
  mustApp(id) { const a = this.world.app(id); if (!a) throw new ControlError(`unknown application ${id}`); return a; }
  mustUser(id) { const u = this.world.user(id); if (!u) throw new ControlError(`unknown user ${id}`); return u; }
  mustGuild(id) { const g = this.world.guild(id); if (!g) throw new ControlError(`unknown guild ${id}`); return g; }
  mustChannel(id) { const c = this.world.channel(id); if (!c) throw new ControlError(`unknown channel ${id}`); return c; }
  mustRole(g, r) { const x = this.world.role(g, r); if (!x) throw new ControlError(`unknown role ${r} in guild ${g}`); return x; }
  mustMember(g, u) { const m = this.world.member(g, u); if (!m) throw new ControlError(`user ${u} is not a member of guild ${g}`); return m; }
  mustMessage(c, m) { const x = this.world.message(c, m); if (!x) throw new ControlError(`unknown message ${m} in channel ${c}`); return x; }
}

const NOT_CALLABLE = new Set(['constructor', 'call', 'handleHttp', 'actAsOrThrow', 'botRole', 'mustApp', 'mustUser', 'mustGuild', 'mustChannel', 'mustRole', 'mustMember', 'mustMessage']);
const CALLABLE = new Set(Object.getOwnPropertyNames(Control.prototype).filter((n) => !NOT_CALLABLE.has(n)));

function appSummary(app) {
  return {
    id: app.id, name: app.name, bot_user_id: app.bot_user_id, token: app.token, client_id: app.id,
    client_secret: app.client_secret, public_key: app.public_key, privileged_intents: { ...app.privileged },
  };
}

function normOw(o) {
  return { id: String(o.id), type: Number(o.type ?? 0), allow: parsePermissions(o.allow ?? 0).toString(), deny: parsePermissions(o.deny ?? 0).toString() };
}

function toPath(p) {
  if (typeof p === 'string' && p.startsWith('/') && p.endsWith('/') && p.length > 2 && /[\^$*+?()[\]{}|\\]/.test(p)) return new RegExp(p.slice(1, -1));
  return p;
}

export { toBits };
