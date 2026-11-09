import { EventEmitter } from 'node:events';
import {
  ChannelType, DEFAULT_EVERYONE_PERMISSIONS, ApplicationFlags, MessageFlags, THREAD_TYPES,
} from './constants.js';
import { Clock, Rng, SnowflakeGenerator, snowflakeTime, compareIds, deepClone, toBits } from './util.js';

// The world: every Discord object the fake knows about, as plain JSON-able data,
// so snapshot/restore is a deep copy. Mutations go through ops.js, which also writes
// the audit log and emits gateway dispatches through `world.emit('dispatch', …)`.
export function emptyState() {
  return {
    applications: {},
    users: {},
    guilds: {},
    channels: {},
    messages: {}, // channelId -> { messageId -> message }
    invites: {}, // code -> invite
    commands: {}, // commandId -> command
    interactions: {}, // interactionId -> interaction record (incl. what the user saw)
    skus: {},
    entitlements: {},
    subscriptions: {},
    attachments: {}, // attachmentId -> { …, data: base64 }
    oauth: { codes: {}, access: {}, refresh: {} },
    userInstalls: {}, // applicationId -> { userId -> { installed_at, scopes } }
  };
}

export class World extends EventEmitter {
  constructor({ clock, seed = 1, options = {} } = {}) {
    super();
    this.setMaxListeners(0);
    this.clock = clock ?? new Clock();
    this.ids = new SnowflakeGenerator(this.clock);
    this.seed = seed;
    this.rng = new Rng(seed);
    this.options = options;
    this.state = emptyState();
  }

  // ---- lifecycle -------------------------------------------------------------
  reset() {
    this.state = emptyState();
    this.ids = new SnowflakeGenerator(this.clock);
    this.rng = new Rng(this.seed);
    this.emit('reset');
  }
  snapshot() {
    return deepClone({ state: this.state, ids: this.ids.state(), rng: this.rng.s });
  }
  restore(snap) {
    const s = deepClone(snap);
    this.state = s.state;
    this.ids.restore(s.ids);
    this.rng.s = s.rng;
    this.emit('restore');
  }

  id(atMs) { return this.ids.next(atMs); }
  now() { return this.clock.now(); }
  iso(ms) { return this.clock.iso(ms); }

  // ---- lookups ---------------------------------------------------------------
  app(id) { return this.state.applications[id]; }
  appByToken(token) {
    for (const a of Object.values(this.state.applications)) if (a.token === token) return a;
    return undefined;
  }
  appByBotUser(userId) {
    for (const a of Object.values(this.state.applications)) if (a.bot_user_id === userId) return a;
    return undefined;
  }
  user(id) { return this.state.users[id]; }
  guild(id) { return this.state.guilds[id]; }
  channel(id) { return this.state.channels[id]; }
  member(guildId, userId) { return this.state.guilds[guildId]?.members[userId]; }
  role(guildId, roleId) { return this.state.guilds[guildId]?.roles[roleId]; }
  message(channelId, messageId) { return this.state.messages[channelId]?.[messageId]; }
  guildChannels(guildId) {
    return Object.values(this.state.channels).filter((c) => c.guild_id === guildId);
  }
  channelMessages(channelId) {
    return Object.values(this.state.messages[channelId] ?? {}).sort((a, b) => compareIds(a.id, b.id));
  }
  guildsOfUser(userId) {
    return Object.values(this.state.guilds).filter((g) => g.members[userId]);
  }
  sortedRoles(guildId) {
    // Highest first. https://discord.com/developers/docs/topics/permissions#permission-hierarchy
    // Ties on position are broken by id: the older (lower id) role ranks higher.
    return Object.values(this.guild(guildId).roles).sort((a, b) => b.position - a.position || compareIds(a.id, b.id));
  }
  /** Rank of a role: larger = higher. */
  roleRank(guildId, roleId) {
    const sorted = this.sortedRoles(guildId);
    return sorted.length - sorted.findIndex((r) => r.id === roleId);
  }
  highestRoleRank(guildId, userId) {
    const m = this.member(guildId, userId);
    if (!m) return 0;
    let best = this.roleRank(guildId, guildId); // @everyone
    for (const r of m.roles) best = Math.max(best, this.roleRank(guildId, r));
    return best;
  }
  botMember(guildId, applicationId) {
    const app = this.app(applicationId);
    return app && this.member(guildId, app.bot_user_id);
  }
  dmChannelBetween(a, b) {
    return Object.values(this.state.channels).find(
      (c) => c.type === ChannelType.DM && c.recipients.includes(a) && c.recipients.includes(b),
    );
  }
  isTimedOut(member) {
    return !!member?.communication_disabled_until && Date.parse(member.communication_disabled_until) > this.now();
  }

  // ---- token helpers ---------------------------------------------------------
  // Bot tokens look like Discord's: base64(user id).timestamp.hmac (format is not part of the API contract).
  makeBotToken(userId) {
    return `${Buffer.from(userId).toString('base64url')}.${this.rng.b64url(6)}.${this.rng.b64url(38)}`;
  }
  secret(n = 32) { return this.rng.b64url(n); }

  // ---- serializers (Discord JSON shapes) -------------------------------------
  // https://discord.com/developers/docs/resources/user#user-object
  userJSON(userOrId) {
    const u = typeof userOrId === 'string' ? this.user(userOrId) : userOrId;
    if (!u) return null;
    const out = {
      id: u.id,
      username: u.username,
      discriminator: u.discriminator ?? '0',
      global_name: u.global_name ?? null,
      avatar: u.avatar ?? null,
      public_flags: u.public_flags ?? 0,
      flags: u.flags ?? 0,
      banner: null,
      accent_color: null,
      avatar_decoration_data: null,
      collectibles: null,
      primary_guild: null,
    };
    if (u.bot) out.bot = true;
    if (u.system) out.system = true;
    return out;
  }

  // https://discord.com/developers/docs/resources/guild#guild-member-object
  memberJSON(guildId, userId, { withUser = true, permissions } = {}) {
    const m = this.member(guildId, userId);
    if (!m) return null;
    const out = {
      avatar: m.avatar ?? null,
      banner: null,
      communication_disabled_until: this.isTimedOut(m) ? m.communication_disabled_until : (m.communication_disabled_until ?? null),
      deaf: !!m.deaf,
      flags: m.flags ?? 0,
      joined_at: m.joined_at,
      mute: !!m.mute,
      nick: m.nick ?? null,
      pending: !!m.pending,
      premium_since: m.premium_since ?? null,
      roles: [...m.roles],
    };
    if (withUser) out.user = this.userJSON(userId);
    if (permissions !== undefined) out.permissions = permissions.toString();
    return out;
  }

  // https://discord.com/developers/docs/topics/permissions#role-object
  roleJSON(role) {
    const out = {
      id: role.id,
      name: role.name,
      color: role.color ?? 0,
      colors: { primary_color: role.color ?? 0, secondary_color: null, tertiary_color: null },
      hoist: !!role.hoist,
      icon: role.icon ?? null,
      unicode_emoji: role.unicode_emoji ?? null,
      position: role.position,
      permissions: toBits(role.permissions).toString(),
      managed: !!role.managed,
      mentionable: !!role.mentionable,
      flags: role.flags ?? 0,
    };
    if (role.tags) out.tags = { ...role.tags };
    return out;
  }

  // https://discord.com/developers/docs/resources/channel#channel-object
  channelJSON(c, { viewerId } = {}) {
    if (!c) return null;
    if (c.type === ChannelType.DM) {
      // Recipients exclude the user looking at the channel.
      const others = c.recipients.filter((r) => r !== viewerId);
      return {
        id: c.id, type: c.type, last_message_id: c.last_message_id ?? null, flags: 0,
        recipients: (others.length ? others : c.recipients).map((r) => this.userJSON(r)),
      };
    }
    const out = {
      id: c.id,
      type: c.type,
      guild_id: c.guild_id,
      name: c.name,
      position: c.position ?? 0,
      permission_overwrites: (c.permission_overwrites ?? []).map((o) => ({
        id: o.id, type: o.type, allow: toBits(o.allow).toString(), deny: toBits(o.deny).toString(),
      })),
      parent_id: c.parent_id ?? null,
      flags: c.flags ?? 0,
    };
    if (c.type !== ChannelType.GUILD_CATEGORY) {
      out.nsfw = !!c.nsfw;
      out.last_message_id = c.last_message_id ?? null;
      out.rate_limit_per_user = c.rate_limit_per_user ?? 0;
    }
    if (c.type === ChannelType.GUILD_TEXT || c.type === ChannelType.GUILD_ANNOUNCEMENT || c.type === ChannelType.GUILD_FORUM) {
      out.topic = c.topic ?? null;
      out.default_auto_archive_duration = c.default_auto_archive_duration ?? 1440;
    }
    if (c.type === ChannelType.GUILD_VOICE || c.type === ChannelType.GUILD_STAGE_VOICE) {
      out.bitrate = c.bitrate ?? 64000;
      out.user_limit = c.user_limit ?? 0;
      out.rtc_region = c.rtc_region ?? null;
    }
    if (THREAD_TYPES.has(c.type)) {
      delete out.permission_overwrites;
      delete out.position;
      out.owner_id = c.owner_id;
      out.message_count = c.message_count ?? 0;
      out.member_count = c.member_count ?? 1;
      out.total_message_sent = c.total_message_sent ?? 0;
      out.thread_metadata = {
        archived: !!c.thread_metadata?.archived,
        auto_archive_duration: c.thread_metadata?.auto_archive_duration ?? 1440,
        archive_timestamp: c.thread_metadata?.archive_timestamp ?? this.iso(snowflakeTime(c.id)),
        locked: !!c.thread_metadata?.locked,
        create_timestamp: this.iso(snowflakeTime(c.id)),
      };
      if (c.type === ChannelType.PRIVATE_THREAD) out.thread_metadata.invitable = c.thread_metadata?.invitable ?? true;
    }
    return out;
  }

  attachmentJSON(a) {
    // https://discord.com/developers/docs/resources/message#attachment-object
    const url = this.cdnSign?.(a) ?? null;
    const out = {
      id: a.id,
      filename: a.filename,
      size: a.size,
      url,
      proxy_url: url && url.replace('/attachments/', '/media-proxy/attachments/'),
      content_type: a.content_type,
    };
    if (a.description) out.description = a.description;
    if (a.width) { out.width = a.width; out.height = a.height; }
    if (a.ephemeral) out.ephemeral = true;
    return out;
  }

  // https://discord.com/developers/docs/resources/message#message-object
  messageJSON(msg, { referenced = true } = {}) {
    const out = {
      type: msg.type,
      channel_id: msg.channel_id,
      content: msg.content ?? '',
      attachments: (msg.attachments ?? []).map((id) => this.state.attachments[id]).filter(Boolean).map((a) => this.attachmentJSON(a)),
      embeds: deepClone(msg.embeds ?? []),
      timestamp: this.iso(snowflakeTime(msg.id)),
      edited_timestamp: msg.edited_timestamp ?? null,
      flags: msg.flags ?? 0,
      components: deepClone(msg.components ?? []),
      id: msg.id,
      author: this.userJSON(msg.author_id),
      mentions: (msg.mentions ?? []).map((uid) => {
        const u = this.userJSON(uid);
        if (u && msg.guild_id && this.member(msg.guild_id, uid)) u.member = this.memberJSON(msg.guild_id, uid, { withUser: false });
        return u;
      }).filter(Boolean),
      mention_roles: [...(msg.mention_roles ?? [])],
      mention_everyone: !!msg.mention_everyone,
      pinned: !!msg.pinned,
      tts: !!msg.tts,
    };
    if (msg.webhook_id) out.webhook_id = msg.webhook_id;
    if (msg.application_id) out.application_id = msg.application_id;
    if (msg.nonce !== undefined) out.nonce = msg.nonce;
    if (msg.poll) out.poll = deepClone(msg.poll);
    if (msg.sticker_items) out.sticker_items = deepClone(msg.sticker_items);
    if (msg.interaction_metadata) out.interaction_metadata = deepClone(msg.interaction_metadata);
    if (msg.message_reference) {
      out.message_reference = { ...msg.message_reference };
      if (msg.message_reference.type === 1) {
        out.message_snapshots = deepClone(msg.message_snapshots ?? []);
      } else if (referenced && msg.type === 19) {
        // https://discord.com/developers/docs/resources/message#message-object – referenced_message:
        // null if the referenced message was deleted, absent if not fetched.
        const ref = this.message(msg.message_reference.channel_id, msg.message_reference.message_id);
        out.referenced_message = ref ? this.messageJSON(ref, { referenced: false }) : null;
      }
    }
    if (msg.thread_id) out.thread = this.channelJSON(this.channel(msg.thread_id));
    if (msg.position !== undefined) out.position = msg.position;
    return out;
  }

  // https://discord.com/developers/docs/resources/guild#guild-object
  guildJSON(g, { withCounts = false } = {}) {
    const out = {
      id: g.id,
      name: g.name,
      icon: g.icon ?? null,
      description: g.description ?? null,
      home_header: null,
      splash: null,
      discovery_splash: null,
      features: [...(g.features ?? [])],
      banner: null,
      owner_id: g.owner_id,
      application_id: null,
      region: 'deprecated',
      afk_channel_id: g.afk_channel_id ?? null,
      afk_timeout: g.afk_timeout ?? 300,
      system_channel_id: g.system_channel_id ?? null,
      system_channel_flags: g.system_channel_flags ?? 0,
      widget_enabled: false,
      widget_channel_id: null,
      verification_level: g.verification_level ?? 0,
      roles: this.sortedRoles(g.id).reverse().map((r) => this.roleJSON(r)),
      default_message_notifications: g.default_message_notifications ?? 0,
      mfa_level: g.mfa_level ?? 0,
      explicit_content_filter: g.explicit_content_filter ?? 0,
      max_presences: null,
      max_members: g.max_members ?? 500000,
      max_stage_video_channel_users: 50,
      max_video_channel_users: 25,
      vanity_url_code: g.vanity_url_code ?? null,
      premium_tier: g.premium_tier ?? 0,
      premium_subscription_count: g.premium_subscription_count ?? 0,
      preferred_locale: g.preferred_locale ?? 'en-US',
      rules_channel_id: g.rules_channel_id ?? null,
      safety_alerts_channel_id: g.safety_alerts_channel_id ?? null,
      public_updates_channel_id: g.public_updates_channel_id ?? null,
      hub_type: null,
      premium_progress_bar_enabled: false,
      latest_onboarding_question_id: null,
      nsfw: false,
      nsfw_level: g.nsfw_level ?? 0,
      emojis: [],
      stickers: [],
      incidents_data: null,
      inventory_settings: null,
      embed_enabled: false,
      embed_channel_id: null,
    };
    if (withCounts) {
      out.approximate_member_count = Object.keys(g.members).length;
      out.approximate_presence_count = 0;
    }
    return out;
  }

  // https://discord.com/developers/docs/resources/application#application-object
  applicationJSON(a) {
    return {
      id: a.id,
      name: a.name,
      icon: null,
      description: a.description ?? '',
      type: null,
      bot: this.userJSON(a.bot_user_id),
      summary: '',
      bot_public: a.bot_public ?? true,
      bot_require_code_grant: false,
      verify_key: a.public_key,
      flags: this.appFlags(a),
      redirect_uris: [...(a.redirect_uris ?? [])],
      interactions_endpoint_url: null,
      install_params: a.install_params ?? undefined,
      integration_types_config: { 0: {}, 1: {} },
      owner: this.userJSON(a.owner_id),
      team: null,
      approximate_guild_count: Object.values(this.state.guilds).filter((g) => g.members[a.bot_user_id]).length,
      approximate_user_install_count: Object.keys(this.state.userInstalls[a.id] ?? {}).length,
    };
  }

  appFlags(a) {
    let f = a.flags ?? 0;
    if (a.privileged.guild_presences) f |= ApplicationFlags.GATEWAY_PRESENCE;
    if (a.privileged.guild_members) f |= ApplicationFlags.GATEWAY_GUILD_MEMBERS;
    if (a.privileged.message_content) f |= ApplicationFlags.GATEWAY_MESSAGE_CONTENT;
    return f;
  }

  // https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object
  auditEntryJSON(e) {
    const out = { id: e.id, user_id: e.user_id, target_id: e.target_id ?? null, action_type: e.action_type };
    if (e.changes?.length) out.changes = deepClone(e.changes);
    if (e.options) out.options = deepClone(e.options);
    if (e.reason !== undefined) out.reason = e.reason;
    return out;
  }

  // ---- message-content gating ------------------------------------------------
  // https://discord.com/developers/docs/events/gateway#message-content-intent
  // Without MESSAGE_CONTENT, content/embeds/attachments/components/poll are empty, except:
  // messages the app sent, DMs with the app, and messages that mention the app.
  redactMessage(json, botUserId) {
    if (json.author?.id === botUserId) return json;
    const ch = this.channel(json.channel_id);
    if (ch?.type === ChannelType.DM) return json;
    if (json.mentions?.some((m) => m.id === botUserId)) return json;
    const out = { ...json, content: '', embeds: [], attachments: [], components: [] };
    if (json.poll) out.poll = undefined;
    delete out.poll;
    if (out.referenced_message) out.referenced_message = this.redactMessage(out.referenced_message, botUserId);
    if (out.message_snapshots) out.message_snapshots = out.message_snapshots.map((s) => ({ message: { ...s.message, content: '', embeds: [], attachments: [], components: [] } }));
    return out;
  }

  isEphemeral(msg) { return ((msg.flags ?? 0) & MessageFlags.EPHEMERAL) !== 0; }

  // ---- factories used by ops/control -----------------------------------------
  newGuildDefaults({ name, ownerId, id, everyonePermissions }) {
    const gid = id ?? this.id();
    return {
      id: gid,
      name,
      owner_id: ownerId,
      features: [],
      preferred_locale: 'en-US',
      system_channel_flags: 0,
      roles: {
        [gid]: {
          id: gid, name: '@everyone', position: 0, color: 0, hoist: false, managed: false, mentionable: false,
          permissions: toBits(everyonePermissions ?? DEFAULT_EVERYONE_PERMISSIONS).toString(), flags: 0,
        },
      },
      members: {},
      bans: {},
      audit_log: [],
      automod_rules: {},
    };
  }
}
