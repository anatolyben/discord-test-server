import { Errors, FormErrors, assertValid, formError, DiscordError } from '../errors.js';
import {
  Permissions as P, ChannelType, THREAD_TYPES, TEXT_BASED_GUILD_TYPES, MessageType, MessageFlags,
  DELETABLE_MESSAGE_TYPES,
} from '../constants.js';
import { compareIds, isSnowflake, snowflakeTime, toBits, deepClone } from '../util.js';
import { computePermissions } from '../permissions.js';
import { normOverwrite } from '../ops.js';

const DOCS = 'https://discord.com/developers/docs';
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

// ${DOCS}/resources/message#create-message-jsonform-params (limits)
const embedSchema = {
  type: 'object',
  fields: {
    title: { type: 'string', maxLength: 256 },
    description: { type: 'string', maxLength: 4096 },
    url: { type: 'string' },
    color: { type: 'int', min: 0, max: 0xffffff },
    fields: { type: 'array', maxLength: 25, items: { type: 'object', fields: {
      name: { type: 'string', required: true, maxLength: 256 },
      value: { type: 'string', required: true, maxLength: 1024 },
      inline: { type: 'bool' },
    } } },
    footer: { type: 'object', fields: { text: { type: 'string', required: true, maxLength: 2048 } } },
    author: { type: 'object', fields: { name: { type: 'string', required: true, maxLength: 256 } } },
  },
};

export const messageBodySchema = {
  content: { type: 'string', maxLength: 2000, nullable: true },
  nonce: { type: 'any', nullable: true },
  tts: { type: 'bool', nullable: true },
  embeds: { type: 'array', maxLength: 10, items: embedSchema, nullable: true },
  allowed_mentions: { type: 'object', nullable: true },
  message_reference: { type: 'object', nullable: true, fields: {
    type: { type: 'int', choices: [0, 1] },
    message_id: { type: 'snowflake' },
    channel_id: { type: 'snowflake' },
    guild_id: { type: 'snowflake' },
    fail_if_not_exists: { type: 'bool' },
  } },
  components: { type: 'array', maxLength: 40, nullable: true },
  sticker_ids: { type: 'array', maxLength: 3, nullable: true },
  attachments: { type: 'array', maxLength: 10, nullable: true },
  flags: { type: 'int', nullable: true },
  poll: { type: 'object', nullable: true },
};

export function registerChannelRoutes(r) {
  // ---------------------------------------------------------------------------
  // Gateway – ${DOCS}/events/gateway#get-gateway, #get-gateway-bot
  // ---------------------------------------------------------------------------
  r.add('GET', '/gateway', (ctx) => ctx.ok({ url: ctx.server.gatewayUrl }), { auth: 'none' });

  r.add('GET', '/gateway/bot', (ctx) => {
    ctx.requireBot();
    const guilds = Object.values(ctx.world.state.guilds).filter((g) => g.members[ctx.actorId]).length;
    const sl = ctx.server.gateway.sessionStartLimit(ctx.app.id);
    return ctx.ok({
      url: ctx.server.gatewayUrl,
      // "recommended number of shards" – Discord targets ~1000 guilds per shard.
      shards: Math.max(1, Math.ceil(guilds / 1000)),
      session_start_limit: sl,
    });
  });

  // ---------------------------------------------------------------------------
  // Users – ${DOCS}/resources/user
  // ---------------------------------------------------------------------------
  // ${DOCS}/resources/user#get-current-user – with OAuth2 needs `identify` (email needs `email`).
  r.add('GET', '/users/@me', (ctx) => {
    if (ctx.actor.kind === 'bearer') {
      if (!ctx.actor.scopes.includes('identify')) throw Errors.unauthorized();
      const u = ctx.world.userJSON(ctx.actorId);
      const raw = ctx.world.user(ctx.actorId);
      u.locale = raw.locale ?? 'en-US';
      u.mfa_enabled = false;
      u.premium_type = 0;
      if (ctx.actor.scopes.includes('email')) { u.email = raw.email ?? `${raw.username}@example.test`; u.verified = true; }
      return ctx.ok(u);
    }
    const u = ctx.world.userJSON(ctx.actorId);
    u.verified = true;
    u.mfa_enabled = false;
    u.locale = 'en-US';
    return ctx.ok(u);
  }, { auth: 'any' });

  // ${DOCS}/resources/user#get-user
  r.add('GET', '/users/:user_id', (ctx) => ctx.ok(ctx.world.userJSON(ctx.user(ctx.params.user_id))));

  // ${DOCS}/resources/user#get-current-user-guilds – OAuth2 needs `guilds`; limit 1-200 (default 200)
  r.add('GET', '/users/@me/guilds', (ctx) => {
    if (ctx.actor.kind === 'bearer' && !ctx.actor.scopes.includes('guilds')) throw Errors.unauthorized();
    assertValid(ctx.query, { limit: { type: 'int', min: 1, max: 200 }, before: { type: 'snowflake' }, after: { type: 'snowflake' } });
    let guilds = ctx.world.guildsOfUser(ctx.actorId).sort((a, b) => compareIds(a.id, b.id));
    const limit = Number(ctx.query.limit ?? 200);
    if (ctx.query.after) guilds = guilds.filter((g) => compareIds(g.id, ctx.query.after) > 0).slice(0, limit);
    else if (ctx.query.before) guilds = guilds.filter((g) => compareIds(g.id, ctx.query.before) < 0).slice(-limit);
    else guilds = guilds.slice(0, limit);
    const withCounts = ctx.query.with_counts === 'true';
    return ctx.ok(guilds.map((g) => {
      const out = {
        id: g.id, name: g.name, icon: g.icon ?? null, banner: null,
        owner: g.owner_id === ctx.actorId,
        permissions: computePermissions(ctx.world, g.id, ctx.actorId).toString(),
        features: [...(g.features ?? [])],
      };
      if (withCounts) { out.approximate_member_count = Object.keys(g.members).length; out.approximate_presence_count = 0; }
      return out;
    }));
  }, { auth: 'any' });

  // ${DOCS}/resources/user#get-current-user-guild-member – OAuth2 `guilds.members.read`
  r.add('GET', '/users/@me/guilds/:guild_id/member', (ctx) => {
    if (ctx.actor.kind !== 'bearer') throw Errors.unauthorized();
    if (!ctx.actor.scopes.includes('guilds.members.read')) throw Errors.unauthorized();
    const g = ctx.guild();
    return ctx.ok(ctx.world.memberJSON(g.id, ctx.actorId));
  }, { auth: 'any' });

  // ${DOCS}/resources/user#leave-guild
  r.add('DELETE', '/users/@me/guilds/:guild_id', (ctx) => {
    const g = ctx.guild();
    if (g.owner_id === ctx.actorId) throw formError('guild_id', 'INVALID_GUILD_OWNER', 'Owner cannot leave'); // ASSUMPTION
    ctx.ops.removeMember(g.id, ctx.actorId, {});
    return ctx.noContent();
  });

  // ${DOCS}/resources/user#create-dm
  r.add('POST', '/users/@me/channels', (ctx) => {
    assertValid(ctx.body, { recipient_id: { type: 'snowflake', required: true } });
    const u = ctx.user(ctx.body.recipient_id);
    const c = ctx.ops.openDM(ctx.actorId, u.id);
    return ctx.ok(ctx.world.channelJSON(c, { viewerId: ctx.actorId }));
  });

  // ---------------------------------------------------------------------------
  // Channels – ${DOCS}/resources/channel
  // ---------------------------------------------------------------------------
  // ${DOCS}/resources/channel#get-channel
  r.add('GET', '/channels/:channel_id', (ctx) => {
    const c = ctx.channel();
    return ctx.ok(ctx.world.channelJSON(c, { viewerId: ctx.actorId }));
  });

  // ${DOCS}/resources/channel#modify-channel – MANAGE_CHANNELS (threads: MANAGE_THREADS or owner);
  // changing permission_overwrites needs MANAGE_ROLES.
  r.add('PATCH', '/channels/:channel_id', (ctx) => {
    const c = ctx.channel();
    if (c.type === ChannelType.DM) throw Errors.cannotExecuteOnDM();
    assertValid(ctx.body, {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      topic: { type: 'string', maxLength: 1024, nullable: true },
      position: { type: 'int', nullable: true },
      nsfw: { type: 'bool', nullable: true },
      rate_limit_per_user: { type: 'int', min: 0, max: 21600, nullable: true },
      bitrate: { type: 'int', min: 8000, nullable: true },
      user_limit: { type: 'int', min: 0, max: 99, nullable: true },
      parent_id: { type: 'snowflake', nullable: true },
      permission_overwrites: { type: 'array', nullable: true, items: { type: 'object', fields: {
        id: { type: 'snowflake', required: true }, type: { type: 'int', required: true, choices: [0, 1] },
        allow: { type: 'bitfield', nullable: true }, deny: { type: 'bitfield', nullable: true },
      } } },
      archived: { type: 'bool' },
      locked: { type: 'bool' },
    });
    if (THREAD_TYPES.has(c.type)) {
      if (c.owner_id !== ctx.actorId) ctx.require(c.guild_id, c.id, P.MANAGE_THREADS);
      const patch = {};
      if (ctx.body.name !== undefined) patch.name = ctx.body.name;
      if (ctx.body.archived !== undefined || ctx.body.locked !== undefined) {
        c.thread_metadata = { ...c.thread_metadata };
        if (ctx.body.archived !== undefined) { c.thread_metadata.archived = ctx.body.archived; c.thread_metadata.archive_timestamp = ctx.world.iso(); }
        if (ctx.body.locked !== undefined) c.thread_metadata.locked = ctx.body.locked;
      }
      ctx.ops.updateChannel(c.id, { ...patch, rate_limit_per_user: ctx.body.rate_limit_per_user ?? undefined }, { actorId: ctx.actorId, reason: ctx.reason });
      ctx.ops.dispatch('THREAD_UPDATE', ctx.world.channelJSON(c), { guildId: c.guild_id, channelId: c.id });
      return ctx.ok(ctx.world.channelJSON(c));
    }
    ctx.require(c.guild_id, c.id, P.MANAGE_CHANNELS);
    const patch = {};
    for (const k of ['name', 'topic', 'position', 'nsfw', 'rate_limit_per_user', 'bitrate', 'user_limit', 'parent_id']) {
      if (ctx.body[k] !== undefined) patch[k] = ctx.body[k];
    }
    if (ctx.body.permission_overwrites !== undefined) {
      ctx.require(c.guild_id, c.id, P.MANAGE_ROLES);
      for (const o of ctx.body.permission_overwrites ?? []) requireGrantableInChannel(ctx, c, toBits(o.allow) | toBits(o.deny));
      patch.permission_overwrites = ctx.body.permission_overwrites ?? [];
    }
    ctx.ops.updateChannel(c.id, patch, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.ok(ctx.world.channelJSON(c));
  }, { audit: true });

  // ${DOCS}/resources/channel#deleteclose-channel – returns the channel object
  r.add('DELETE', '/channels/:channel_id', (ctx) => {
    const c = ctx.channel();
    if (c.type === ChannelType.DM) return ctx.ok(ctx.world.channelJSON(c, { viewerId: ctx.actorId }));
    if (THREAD_TYPES.has(c.type)) ctx.require(c.guild_id, c.id, P.MANAGE_THREADS);
    else ctx.require(c.guild_id, c.id, P.MANAGE_CHANNELS);
    const g = ctx.world.guild(c.guild_id);
    // "Deleting a category does not delete its child channels"; community-required channels cannot be deleted (50074).
    if (g.features?.includes('COMMUNITY') && (g.rules_channel_id === c.id || g.public_updates_channel_id === c.id)) throw Errors.communityChannel();
    const json = ctx.ops.deleteChannel(c.id, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.ok(json);
  }, { audit: true });

  // ${DOCS}/resources/channel#edit-channel-permissions – MANAGE_ROLES; only permissions the bot has
  // (or ADMINISTRATOR) can be allowed/denied.
  r.add('PUT', '/channels/:channel_id/permissions/:overwrite_id', (ctx) => {
    const c = ctx.channel();
    if (c.type === ChannelType.DM || THREAD_TYPES.has(c.type)) throw Errors.channelType();
    assertValid(ctx.body, {
      allow: { type: 'bitfield', nullable: true },
      deny: { type: 'bitfield', nullable: true },
      type: { type: 'int', required: true, choices: [0, 1] },
    });
    ctx.require(c.guild_id, c.id, P.MANAGE_ROLES);
    const id = ctx.params.overwrite_id;
    if (!isSnowflake(id)) throw formError('id', 'NUMBER_TYPE_COERCE', `Value "${id}" is not snowflake.`);
    if (ctx.body.type === 0 && !ctx.world.role(c.guild_id, id)) throw Errors.unknownRole();
    if (ctx.body.type === 1 && !ctx.world.member(c.guild_id, id)) throw Errors.unknownMember();
    requireGrantableInChannel(ctx, c, toBits(ctx.body.allow) | toBits(ctx.body.deny));
    ctx.ops.putOverwrite(c.id, { id, type: ctx.body.type, allow: ctx.body.allow ?? '0', deny: ctx.body.deny ?? '0' }, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.noContent();
  }, { audit: true });

  // ${DOCS}/resources/channel#delete-channel-permission
  r.add('DELETE', '/channels/:channel_id/permissions/:overwrite_id', (ctx) => {
    const c = ctx.channel();
    if (c.type === ChannelType.DM || THREAD_TYPES.has(c.type)) throw Errors.channelType();
    ctx.require(c.guild_id, c.id, P.MANAGE_ROLES);
    if (!(c.permission_overwrites ?? []).some((o) => o.id === ctx.params.overwrite_id)) throw Errors.unknownOverwrite();
    ctx.ops.deleteOverwrite(c.id, ctx.params.overwrite_id, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.noContent();
  }, { audit: true });

  // ${DOCS}/resources/channel#create-channel-invite
  r.add('POST', '/channels/:channel_id/invites', (ctx) => {
    const c = ctx.channel();
    if (c.type === ChannelType.DM) throw Errors.cannotExecuteOnDM();
    assertValid(ctx.body, { max_age: { type: 'int', min: 0, max: 604800 }, max_uses: { type: 'int', min: 0, max: 100 }, temporary: { type: 'bool' } });
    ctx.require(c.guild_id, c.id, P.CREATE_INSTANT_INVITE);
    const inv = ctx.ops.createInvite(c.guild_id, { channelId: c.id, inviterId: ctx.actorId, maxAge: ctx.body.max_age ?? 86400, maxUses: ctx.body.max_uses ?? 0, temporary: !!ctx.body.temporary });
    ctx.ops.audit(c.guild_id, { actorId: ctx.actorId, action_type: 40, target_id: null, reason: ctx.reason, changes: [{ key: 'code', new_value: inv.code }, { key: 'channel_id', new_value: c.id }] });
    return ctx.ok(ctx.server.inviteJSON(inv));
  }, { audit: true });

  // ${DOCS}/resources/channel#start-thread-from-message / #start-thread-without-message
  r.add('POST', '/channels/:channel_id/threads', (ctx) => {
    const c = ctx.channel();
    assertValid(ctx.body, { name: { type: 'string', required: true, minLength: 1, maxLength: 100 }, type: { type: 'int', choices: [10, 11, 12] }, auto_archive_duration: { type: 'int', choices: [60, 1440, 4320, 10080] } });
    const type = ctx.body.type ?? ChannelType.PRIVATE_THREAD;
    ctx.require(c.guild_id, c.id, type === ChannelType.PRIVATE_THREAD ? P.CREATE_PRIVATE_THREADS : P.CREATE_PUBLIC_THREADS);
    const t = ctx.ops.createChannel(c.guild_id, { name: ctx.body.name, type, parent_id: c.id, owner_id: ctx.actorId, auto_archive_duration: ctx.body.auto_archive_duration }, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.ok(ctx.world.channelJSON(t), 201);
  }, { audit: true });

  // ---------------------------------------------------------------------------
  // Messages – ${DOCS}/resources/message
  // ---------------------------------------------------------------------------
  // ${DOCS}/resources/message#get-channel-messages – READ_MESSAGE_HISTORY (otherwise an empty list);
  // limit 1-100 (default 50); around/before/after; newest first.
  r.add('GET', '/channels/:channel_id/messages', (ctx) => {
    const c = ctx.channel();
    assertValid(ctx.query, { limit: { type: 'int', min: 1, max: 100 }, around: { type: 'snowflake' }, before: { type: 'snowflake' }, after: { type: 'snowflake' } });
    if (c.guild_id && !(ctx.perms(c.guild_id, c.id) & P.READ_MESSAGE_HISTORY)) return ctx.ok([]);
    const limit = Number(ctx.query.limit ?? 50);
    let msgs = ctx.world.channelMessages(c.id); // oldest first
    if (ctx.query.before) msgs = msgs.filter((m) => compareIds(m.id, ctx.query.before) < 0).slice(-limit);
    else if (ctx.query.after) msgs = msgs.filter((m) => compareIds(m.id, ctx.query.after) > 0).slice(0, limit);
    else if (ctx.query.around) {
      const older = msgs.filter((m) => compareIds(m.id, ctx.query.around) <= 0).slice(-Math.ceil(limit / 2));
      const newer = msgs.filter((m) => compareIds(m.id, ctx.query.around) > 0).slice(0, Math.floor(limit / 2));
      msgs = [...older, ...newer];
    } else msgs = msgs.slice(-limit);
    return ctx.ok(msgs.reverse().map((m) => ctx.server.messageForApp(m, ctx)));
  });

  // ${DOCS}/resources/message#get-channel-message – READ_MESSAGE_HISTORY
  r.add('GET', '/channels/:channel_id/messages/:message_id', (ctx) => {
    const c = ctx.channel();
    if (c.guild_id) ctx.require(c.guild_id, c.id, P.READ_MESSAGE_HISTORY);
    const m = ctx.message(c.id, ctx.params.message_id);
    return ctx.ok(ctx.server.messageForApp(m, ctx));
  });

  // ${DOCS}/resources/message#create-message
  r.add('POST', '/channels/:channel_id/messages', (ctx) => {
    const c = ctx.channel();
    assertValid(ctx.body, messageBodySchema);
    const msg = createMessageFromBody(ctx, c, ctx.body, ctx.files);
    return ctx.ok(ctx.server.messageForApp(msg, ctx));
  });

  // ${DOCS}/resources/message#edit-message – only the author can edit content; others with
  // MANAGE_MESSAGES may only change flags (SUPPRESS_EMBEDS).
  r.add('PATCH', '/channels/:channel_id/messages/:message_id', (ctx) => {
    const c = ctx.channel();
    assertValid(ctx.body, { ...messageBodySchema, message_reference: { type: 'any' } });
    const m = ctx.message(c.id, ctx.params.message_id);
    const body = ctx.body;
    const patch = {};
    if (m.author_id !== ctx.actorId) {
      const onlyFlags = Object.keys(body).every((k) => k === 'flags');
      if (!onlyFlags) throw Errors.cannotEditOthersMessage();
      ctx.require(c.guild_id, c.id, P.MANAGE_MESSAGES);
    }
    if (body.content !== undefined) patch.content = body.content ?? '';
    if (body.embeds !== undefined) patch.embeds = body.embeds ?? [];
    if (body.components !== undefined) patch.components = body.components ?? [];
    if (body.flags !== undefined && body.flags !== null) patch.flags = (m.flags & ~MessageFlags.SUPPRESS_EMBEDS) | (body.flags & MessageFlags.SUPPRESS_EMBEDS);
    if (body.attachments !== undefined || ctx.files?.length) {
      const keep = (body.attachments ?? []).filter((a) => a.id && m.attachments.includes(String(a.id))).map((a) => String(a.id));
      patch.attachments = [...keep, ...ctx.server.storeUploads(c.id, ctx.files, body.attachments)];
    }
    ctx.ops.editMessage(c.id, m.id, patch);
    return ctx.ok(ctx.server.messageForApp(m, ctx));
  });

  // ${DOCS}/resources/message#delete-message – own messages, or MANAGE_MESSAGES for others'.
  r.add('DELETE', '/channels/:channel_id/messages/:message_id', (ctx) => {
    const c = ctx.channel();
    const m = ctx.message(c.id, ctx.params.message_id);
    if (!DELETABLE_MESSAGE_TYPES.has(m.type)) throw Errors.systemMessage();
    if (m.author_id !== ctx.actorId) {
      if (c.type === ChannelType.DM) throw Errors.cannotExecuteOnDM();
      ctx.require(c.guild_id, c.id, P.MANAGE_MESSAGES);
    }
    ctx.ops.deleteMessage(c.id, m.id, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.noContent();
  }, { audit: true });

  // ${DOCS}/resources/message#bulk-delete-messages – guild channels only, MANAGE_MESSAGES, 2-100 ids,
  // "will not delete messages older than 2 weeks, and will fail with a 400 BAD REQUEST if any message
  // provided is older than that or if any duplicate message IDs are provided."
  r.add('POST', '/channels/:channel_id/messages/bulk-delete', (ctx) => {
    const c = ctx.channel();
    if (c.type === ChannelType.DM) throw Errors.cannotExecuteOnDM();
    assertValid(ctx.body, { messages: { type: 'array', required: true, minLength: 2, maxLength: 100, items: { type: 'snowflake' } } });
    ctx.require(c.guild_id, c.id, P.MANAGE_MESSAGES);
    const ids = ctx.body.messages.map(String);
    // ASSUMPTION: duplicates are reported as a 50035 form error on `messages`.
    if (new Set(ids).size !== ids.length) throw formError('messages', 'BASE_TYPE_DUPLICATES', 'Duplicate message ids are not allowed.');
    const now = ctx.world.now();
    if (ids.some((id) => now - snowflakeTime(id) > FOURTEEN_DAYS_MS)) throw Errors.tooOldToBulkDelete();
    // ASSUMPTION: ids that do not exist are ignored.
    ctx.ops.bulkDelete(c.id, ids, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.noContent();
  }, { audit: true });

  // ${DOCS}/resources/message#crosspost-message, pins etc. are out of scope.
}

// ${DOCS}/resources/channel#edit-channel-permissions – "Only permissions your bot has in the guild or parent
// channel (if applicable) can be allowed/denied (unless your bot has a MANAGE_ROLES overwrite in the channel)."
function requireGrantableInChannel(ctx, c, bits) {
  if (ctx.isOwner(c.guild_id)) return;
  const guildPerms = ctx.perms(c.guild_id);
  if (guildPerms & P.ADMINISTRATOR) return;
  const own = (c.permission_overwrites ?? []).some((o) => (o.id === ctx.actorId || ctx.world.member(c.guild_id, ctx.actorId)?.roles.includes(o.id)) && (toBits(o.allow) & P.MANAGE_ROLES));
  if (own) return;
  const chanPerms = ctx.perms(c.guild_id, c.id);
  if ((bits & ~(guildPerms | chanPerms)) !== 0n) throw Errors.missingPermissions();
}

/**
 * Shared by Create Message, interaction responses and webhook follow-ups.
 * `opts.skipPermissionChecks` is used for interaction responses (they do not need SEND_MESSAGES).
 */
export function createMessageFromBody(ctx, c, body, files, opts = {}) {
  const guildId = c.guild_id ?? null;
  if (guildId && !TEXT_BASED_GUILD_TYPES.has(c.type)) throw Errors.nonTextChannel();
  let perms = 0n;
  if (guildId && !opts.skipPermissionChecks) {
    perms = ctx.perms(guildId, c.id);
    const need = THREAD_TYPES.has(c.type) ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES;
    if (!(perms & need)) throw Errors.missingPermissions();
    if (THREAD_TYPES.has(c.type) && c.thread_metadata?.archived) throw new DiscordError(400, 50083, 'Thread is archived');
    if (files?.length && !(perms & P.ATTACH_FILES)) throw Errors.missingPermissions();
  }
  if (c.type === ChannelType.DM && !opts.skipPermissionChecks) {
    const other = c.recipients.find((r) => r !== ctx.actorId);
    // Bots can only DM users that share a guild with them (otherwise 50007).
    if (other && ctx.actor?.kind === 'bot' && !ctx.world.guildsOfUser(other).some((g) => g.members[ctx.actorId])) {
      if (!ctx.world.state.userInstalls[ctx.app.id]?.[other]) throw Errors.cannotSendToUser();
    }
  }
  const hasContent = (body.content ?? '') !== '' || body.embeds?.length || body.sticker_ids?.length || body.components?.length || files?.length || body.poll;
  const isForward = body.message_reference?.type === 1;
  if (!hasContent && !isForward && !opts.allowEmpty) throw Errors.emptyMessage();

  const data = {
    authorId: opts.authorId ?? ctx.actorId,
    content: body.content ?? '',
    embeds: body.embeds ?? [],
    components: body.components ?? [],
    tts: !!body.tts,
    flags: opts.rawFlags ?? ((body.flags ?? 0) & (MessageFlags.SUPPRESS_EMBEDS | MessageFlags.SUPPRESS_NOTIFICATIONS | MessageFlags.IS_COMPONENTS_V2)),
    type: opts.type ?? MessageType.DEFAULT,
  };
  // Bots without EMBED_LINKS: embeds are dropped. ASSUMPTION (Discord suppresses them client-side).
  if (guildId && !opts.skipPermissionChecks && !(perms & P.EMBED_LINKS)) data.embeds = [];
  if (body.nonce !== undefined && body.nonce !== null) data.nonce = body.nonce;
  if (body.poll) data.poll = deepClone(body.poll);
  if (opts.applicationId) data.application_id = opts.applicationId;
  if (opts.webhookId) data.webhook_id = opts.webhookId;
  if (opts.interactionMetadata) data.interaction_metadata = opts.interactionMetadata;

  // ${DOCS}/resources/message#message-reference-structure
  const ref = body.message_reference;
  if (ref && (ref.message_id)) {
    const refChannelId = ref.channel_id ?? c.id;
    const target = ctx.world.message(refChannelId, ref.message_id);
    if (ref.type === 1) {
      // Forward: snapshot of the original message. ${DOCS}/resources/message#message-snapshot-object
      if (!target) throw formError(['message_reference', 'message_id'], 'MESSAGE_REFERENCE_UNKNOWN_MESSAGE', 'Unknown message');
      data.message_reference = { type: 1, message_id: target.id, channel_id: target.channel_id, guild_id: target.guild_id ?? undefined };
      const snap = ctx.world.messageJSON(target, { referenced: false });
      data.message_snapshots = [{ message: pickSnapshot(snap) }];
      data.flags |= MessageFlags.HAS_SNAPSHOT;
    } else if (target && target.channel_id === c.id) {
      if (guildId && !opts.skipPermissionChecks && !(perms & P.READ_MESSAGE_HISTORY)) throw Errors.missingPermissions();
      data.type = MessageType.REPLY;
      data.message_reference = { type: 0, message_id: target.id, channel_id: c.id, guild_id: guildId ?? undefined };
      data.mentionRepliedUser = body.allowed_mentions?.replied_user !== false;
    } else if (ref.fail_if_not_exists === false) {
      // Sent as a normal message.
    } else {
      throw formError(['message_reference', 'message_id'], 'MESSAGE_REFERENCE_UNKNOWN_MESSAGE', 'Unknown message');
    }
  }

  // ${DOCS}/resources/message#allowed-mentions-object
  const parsedAllowed = body.allowed_mentions;
  if (parsedAllowed) {
    const parse = parsedAllowed.parse ?? [];
    const content = data.content;
    const users = [...content.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]).filter((id) => ctx.world.user(id));
    const roles = guildId ? [...content.matchAll(/<@&(\d+)>/g)].map((m) => m[1]).filter((id) => ctx.world.role(guildId, id)) : [];
    data.mentions = users.filter((u) => parse.includes('users') || (parsedAllowed.users ?? []).includes(u));
    data.mention_roles = roles.filter((r) => parse.includes('roles') || (parsedAllowed.roles ?? []).includes(r));
    data.mention_everyone = parse.includes('everyone') && /@(everyone|here)/.test(content);
  }
  if (guildId && data.mention_everyone === undefined && /@(everyone|here)/.test(data.content) && !opts.skipPermissionChecks && !(perms & P.MENTION_EVERYONE)) {
    data.mention_everyone = false;
  }

  data.attachments = ctx.server.storeUploads(c.id, files, body.attachments);
  const msg = ctx.ops.createMessage(c.id, data);
  if (!msg) {
    // AutoMod blocked it. ASSUMPTION: Discord answers 200 for blocked user messages client-side; bots are exempt
    // from AutoMod, so this path is only reachable for control-API user messages.
    throw new DiscordError(400, 200000, 'Message was blocked by AutoMod');
  }
  return msg;
}

function pickSnapshot(m) {
  const keys = ['type', 'content', 'embeds', 'attachments', 'timestamp', 'edited_timestamp', 'flags', 'mentions', 'mention_roles', 'stickers', 'sticker_items', 'components'];
  const out = {};
  for (const k of keys) if (m[k] !== undefined) out[k] = m[k];
  return out;
}
