// Constants taken from Discord's developer documentation (API v10).
// Each block cites the page it comes from.

export const API_VERSION = 10;

// https://discord.com/developers/docs/reference#snowflakes
export const DISCORD_EPOCH = 1420070400000n;

// https://discord.com/developers/docs/topics/permissions#permissions-bitwise-permission-flags
export const Permissions = Object.freeze({
  CREATE_INSTANT_INVITE: 1n << 0n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_AUDIT_LOG: 1n << 7n,
  PRIORITY_SPEAKER: 1n << 8n,
  STREAM: 1n << 9n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  SEND_TTS_MESSAGES: 1n << 12n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  USE_EXTERNAL_EMOJIS: 1n << 18n,
  VIEW_GUILD_INSIGHTS: 1n << 19n,
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  MUTE_MEMBERS: 1n << 22n,
  DEAFEN_MEMBERS: 1n << 23n,
  MOVE_MEMBERS: 1n << 24n,
  USE_VAD: 1n << 25n,
  CHANGE_NICKNAME: 1n << 26n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_WEBHOOKS: 1n << 29n,
  MANAGE_GUILD_EXPRESSIONS: 1n << 30n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  REQUEST_TO_SPEAK: 1n << 32n,
  MANAGE_EVENTS: 1n << 33n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  CREATE_PRIVATE_THREADS: 1n << 36n,
  USE_EXTERNAL_STICKERS: 1n << 37n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  USE_EMBEDDED_ACTIVITIES: 1n << 39n,
  MODERATE_MEMBERS: 1n << 40n,
  VIEW_CREATOR_MONETIZATION_ANALYTICS: 1n << 41n,
  USE_SOUNDBOARD: 1n << 42n,
  CREATE_GUILD_EXPRESSIONS: 1n << 43n,
  CREATE_EVENTS: 1n << 44n,
  USE_EXTERNAL_SOUNDS: 1n << 45n,
  SEND_VOICE_MESSAGES: 1n << 46n,
  SEND_POLLS: 1n << 49n,
  USE_EXTERNAL_APPS: 1n << 50n,
  PIN_MESSAGES: 1n << 51n,
  BYPASS_SLOWMODE: 1n << 52n,
});

export const ALL_PERMISSIONS = Object.values(Permissions).reduce((a, b) => a | b, 0n);

// https://discord.com/developers/docs/topics/permissions#permissions-for-timed-out-members
// "timed out members will temporarily lose all permissions except VIEW_CHANNEL and READ_MESSAGE_HISTORY"
export const TIMED_OUT_ALLOWED = Permissions.VIEW_CHANNEL | Permissions.READ_MESSAGE_HISTORY;

// ASSUMPTION: the docs do not publish the default @everyone permission set of a new guild.
// This is a plausible default and can be overridden per guild (control.createGuild({ everyonePermissions })).
export const DEFAULT_EVERYONE_PERMISSIONS =
  Permissions.CREATE_INSTANT_INVITE | Permissions.ADD_REACTIONS | Permissions.STREAM |
  Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.EMBED_LINKS |
  Permissions.ATTACH_FILES | Permissions.READ_MESSAGE_HISTORY | Permissions.MENTION_EVERYONE |
  Permissions.USE_EXTERNAL_EMOJIS | Permissions.CONNECT | Permissions.SPEAK | Permissions.USE_VAD |
  Permissions.CHANGE_NICKNAME | Permissions.USE_APPLICATION_COMMANDS | Permissions.REQUEST_TO_SPEAK |
  Permissions.CREATE_PUBLIC_THREADS | Permissions.CREATE_PRIVATE_THREADS |
  Permissions.USE_EXTERNAL_STICKERS | Permissions.SEND_MESSAGES_IN_THREADS |
  Permissions.USE_EMBEDDED_ACTIVITIES | Permissions.SEND_VOICE_MESSAGES | Permissions.SEND_POLLS |
  Permissions.USE_EXTERNAL_APPS;

// https://discord.com/developers/docs/events/gateway#list-of-intents
export const Intents = Object.freeze({
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MODERATION: 1 << 2,
  GUILD_EXPRESSIONS: 1 << 3,
  GUILD_INTEGRATIONS: 1 << 4,
  GUILD_WEBHOOKS: 1 << 5,
  GUILD_INVITES: 1 << 6,
  GUILD_VOICE_STATES: 1 << 7,
  GUILD_PRESENCES: 1 << 8,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  GUILD_MESSAGE_TYPING: 1 << 11,
  DIRECT_MESSAGES: 1 << 12,
  DIRECT_MESSAGE_REACTIONS: 1 << 13,
  DIRECT_MESSAGE_TYPING: 1 << 14,
  MESSAGE_CONTENT: 1 << 15,
  GUILD_SCHEDULED_EVENTS: 1 << 16,
  AUTO_MODERATION_CONFIGURATION: 1 << 20,
  AUTO_MODERATION_EXECUTION: 1 << 21,
  GUILD_MESSAGE_POLLS: 1 << 24,
  DIRECT_MESSAGE_POLLS: 1 << 25,
});
export const ALL_INTENTS = Object.values(Intents).reduce((a, b) => a | b, 0);
// https://discord.com/developers/docs/events/gateway#privileged-intents
export const PRIVILEGED_INTENTS = Intents.GUILD_MEMBERS | Intents.GUILD_PRESENCES | Intents.MESSAGE_CONTENT;

// https://discord.com/developers/docs/resources/application#application-object-application-flags
export const ApplicationFlags = Object.freeze({
  GATEWAY_PRESENCE: 1 << 12,
  GATEWAY_PRESENCE_LIMITED: 1 << 13,
  GATEWAY_GUILD_MEMBERS: 1 << 14,
  GATEWAY_GUILD_MEMBERS_LIMITED: 1 << 15,
  GATEWAY_MESSAGE_CONTENT: 1 << 18,
  GATEWAY_MESSAGE_CONTENT_LIMITED: 1 << 19,
  APPLICATION_COMMAND_BADGE: 1 << 23,
});

// https://discord.com/developers/docs/topics/opcodes-and-status-codes#gateway-gateway-opcodes
export const GatewayOp = Object.freeze({
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  VOICE_STATE_UPDATE: 4,
  RESUME: 6,
  RECONNECT: 7,
  REQUEST_GUILD_MEMBERS: 8,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
  REQUEST_SOUNDBOARD_SOUNDS: 31,
});

// https://discord.com/developers/docs/topics/opcodes-and-status-codes#gateway-gateway-close-event-codes
export const GatewayClose = Object.freeze({
  UNKNOWN_ERROR: 4000,
  UNKNOWN_OPCODE: 4001,
  DECODE_ERROR: 4002,
  NOT_AUTHENTICATED: 4003,
  AUTHENTICATION_FAILED: 4004,
  ALREADY_AUTHENTICATED: 4005,
  INVALID_SEQ: 4007,
  RATE_LIMITED: 4008,
  SESSION_TIMED_OUT: 4009,
  INVALID_SHARD: 4010,
  SHARDING_REQUIRED: 4011,
  INVALID_API_VERSION: 4012,
  INVALID_INTENTS: 4013,
  DISALLOWED_INTENTS: 4014,
});

// https://discord.com/developers/docs/resources/channel#channel-object-channel-types
export const ChannelType = Object.freeze({
  GUILD_TEXT: 0,
  DM: 1,
  GUILD_VOICE: 2,
  GROUP_DM: 3,
  GUILD_CATEGORY: 4,
  GUILD_ANNOUNCEMENT: 5,
  ANNOUNCEMENT_THREAD: 10,
  PUBLIC_THREAD: 11,
  PRIVATE_THREAD: 12,
  GUILD_STAGE_VOICE: 13,
  GUILD_DIRECTORY: 14,
  GUILD_FORUM: 15,
  GUILD_MEDIA: 16,
});
export const THREAD_TYPES = new Set([10, 11, 12]);
export const TEXT_BASED_GUILD_TYPES = new Set([0, 2, 5, 10, 11, 12, 13]);

// https://discord.com/developers/docs/resources/message#message-object-message-types
export const MessageType = Object.freeze({
  DEFAULT: 0,
  RECIPIENT_ADD: 1,
  RECIPIENT_REMOVE: 2,
  CALL: 3,
  CHANNEL_NAME_CHANGE: 4,
  CHANNEL_ICON_CHANGE: 5,
  CHANNEL_PINNED_MESSAGE: 6,
  USER_JOIN: 7,
  GUILD_BOOST: 8,
  GUILD_BOOST_TIER_1: 9,
  GUILD_BOOST_TIER_2: 10,
  GUILD_BOOST_TIER_3: 11,
  CHANNEL_FOLLOW_ADD: 12,
  GUILD_DISCOVERY_DISQUALIFIED: 14,
  GUILD_DISCOVERY_REQUALIFIED: 15,
  THREAD_CREATED: 18,
  REPLY: 19,
  CHAT_INPUT_COMMAND: 20,
  THREAD_STARTER_MESSAGE: 21,
  GUILD_INVITE_REMINDER: 22,
  CONTEXT_MENU_COMMAND: 23,
  AUTO_MODERATION_ACTION: 24,
  ROLE_SUBSCRIPTION_PURCHASE: 25,
  INTERACTION_PREMIUM_UPSELL: 26,
  STAGE_START: 27,
  STAGE_END: 28,
  STAGE_SPEAKER: 29,
  STAGE_TOPIC: 31,
  GUILD_APPLICATION_PREMIUM_SUBSCRIPTION: 32,
  POLL_RESULT: 46,
});
// https://discord.com/developers/docs/resources/message#message-object-message-types
// "Type 19 and 20 are only in API v8+ ... deletable: true for these types"; system messages are not deletable.
// (Deletable column of the table: 14-17, 36-39 and 44 are deletable too.)
export const DELETABLE_MESSAGE_TYPES = new Set([0, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25, 26, 27, 28, 29, 31, 32, 36, 37, 38, 39, 44, 46]);

// https://discord.com/developers/docs/resources/message#message-object-message-flags
export const MessageFlags = Object.freeze({
  CROSSPOSTED: 1 << 0,
  IS_CROSSPOST: 1 << 1,
  SUPPRESS_EMBEDS: 1 << 2,
  SOURCE_MESSAGE_DELETED: 1 << 3,
  URGENT: 1 << 4,
  HAS_THREAD: 1 << 5,
  EPHEMERAL: 1 << 6,
  LOADING: 1 << 7,
  FAILED_TO_MENTION_SOME_ROLES_IN_THREAD: 1 << 8,
  SUPPRESS_NOTIFICATIONS: 1 << 12,
  IS_VOICE_MESSAGE: 1 << 13,
  HAS_SNAPSHOT: 1 << 14,
  IS_COMPONENTS_V2: 1 << 15,
});

// https://discord.com/developers/docs/resources/message#message-reference-types
export const MessageReferenceType = Object.freeze({ DEFAULT: 0, FORWARD: 1 });

// https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object-audit-log-events
export const AuditLogEvent = Object.freeze({
  GUILD_UPDATE: 1,
  CHANNEL_CREATE: 10,
  CHANNEL_UPDATE: 11,
  CHANNEL_DELETE: 12,
  CHANNEL_OVERWRITE_CREATE: 13,
  CHANNEL_OVERWRITE_UPDATE: 14,
  CHANNEL_OVERWRITE_DELETE: 15,
  MEMBER_KICK: 20,
  MEMBER_PRUNE: 21,
  MEMBER_BAN_ADD: 22,
  MEMBER_BAN_REMOVE: 23,
  MEMBER_UPDATE: 24,
  MEMBER_ROLE_UPDATE: 25,
  MEMBER_MOVE: 26,
  MEMBER_DISCONNECT: 27,
  BOT_ADD: 28,
  ROLE_CREATE: 30,
  ROLE_UPDATE: 31,
  ROLE_DELETE: 32,
  INVITE_CREATE: 40,
  INVITE_UPDATE: 41,
  INVITE_DELETE: 42,
  WEBHOOK_CREATE: 50,
  MESSAGE_DELETE: 72,
  MESSAGE_BULK_DELETE: 73,
  MESSAGE_PIN: 74,
  MESSAGE_UNPIN: 75,
  INTEGRATION_CREATE: 80,
  INTEGRATION_UPDATE: 81,
  INTEGRATION_DELETE: 82,
  THREAD_CREATE: 110,
  THREAD_UPDATE: 111,
  THREAD_DELETE: 112,
  APPLICATION_COMMAND_PERMISSION_UPDATE: 121,
  AUTO_MODERATION_RULE_CREATE: 140,
  AUTO_MODERATION_RULE_UPDATE: 141,
  AUTO_MODERATION_RULE_DELETE: 142,
  AUTO_MODERATION_BLOCK_MESSAGE: 143,
  AUTO_MODERATION_FLAG_TO_CHANNEL: 144,
  AUTO_MODERATION_USER_COMMUNICATION_DISABLED: 145,
});

// https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-interaction-type
export const InteractionType = Object.freeze({
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
});

// https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-response-object-interaction-callback-type
export const InteractionCallbackType = Object.freeze({
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
  MODAL: 9,
  PREMIUM_REQUIRED: 10,
  LAUNCH_ACTIVITY: 12,
});

// https://discord.com/developers/docs/resources/application#application-object-application-integration-types
export const IntegrationType = Object.freeze({ GUILD_INSTALL: 0, USER_INSTALL: 1 });
// https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-interaction-context-types
export const InteractionContextType = Object.freeze({ GUILD: 0, BOT_DM: 1, PRIVATE_CHANNEL: 2 });

// https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-types
export const ApplicationCommandType = Object.freeze({ CHAT_INPUT: 1, USER: 2, MESSAGE: 3, PRIMARY_ENTRY_POINT: 4 });
// https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-option-type
export const ApplicationCommandOptionType = Object.freeze({
  SUB_COMMAND: 1, SUB_COMMAND_GROUP: 2, STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6,
  CHANNEL: 7, ROLE: 8, MENTIONABLE: 9, NUMBER: 10, ATTACHMENT: 11,
});

// https://discord.com/developers/docs/components/reference#component-object-component-types
export const ComponentType = Object.freeze({
  ACTION_ROW: 1, BUTTON: 2, STRING_SELECT: 3, TEXT_INPUT: 4, USER_SELECT: 5, ROLE_SELECT: 6,
  MENTIONABLE_SELECT: 7, CHANNEL_SELECT: 8, SECTION: 9, TEXT_DISPLAY: 10, THUMBNAIL: 11,
  MEDIA_GALLERY: 12, FILE: 13, SEPARATOR: 14, CONTAINER: 17, LABEL: 18,
});

// https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-rule-object
export const AutoModTriggerType = Object.freeze({ KEYWORD: 1, SPAM: 3, KEYWORD_PRESET: 4, MENTION_SPAM: 5, MEMBER_PROFILE: 6 });
export const AutoModEventType = Object.freeze({ MESSAGE_SEND: 1, MEMBER_UPDATE: 2 });
export const AutoModActionType = Object.freeze({ BLOCK_MESSAGE: 1, SEND_ALERT_MESSAGE: 2, TIMEOUT: 3, BLOCK_MEMBER_INTERACTION: 4 });
// https://discord.com/developers/docs/resources/auto-moderation#auto-moderation-rule-object-trigger-metadata-field-limits
export const AUTOMOD_MAX_RULES_PER_TRIGGER = { 1: 6, 3: 1, 4: 1, 5: 1, 6: 1 };

// https://discord.com/developers/docs/resources/sku#sku-object-sku-types
export const SkuType = Object.freeze({ DURABLE: 2, CONSUMABLE: 3, SUBSCRIPTION: 5, SUBSCRIPTION_GROUP: 6 });
// https://discord.com/developers/docs/resources/entitlement#entitlement-object-entitlement-types
export const EntitlementType = Object.freeze({
  PURCHASE: 1, PREMIUM_SUBSCRIPTION: 2, DEVELOPER_GIFT: 3, TEST_MODE_PURCHASE: 4,
  FREE_PURCHASE: 5, USER_GIFT: 6, PREMIUM_PURCHASE: 7, APPLICATION_SUBSCRIPTION: 8,
});
// https://discord.com/developers/docs/resources/subscription#subscription-statuses
export const SubscriptionStatus = Object.freeze({ ACTIVE: 0, ENDING: 1, INACTIVE: 2 });

// https://discord.com/developers/docs/resources/guild#guild-member-object-guild-member-flags
export const GuildMemberFlags = Object.freeze({
  DID_REJOIN: 1 << 0, COMPLETED_ONBOARDING: 1 << 1, BYPASSES_VERIFICATION: 1 << 2, STARTED_ONBOARDING: 1 << 3,
});

// https://discord.com/developers/docs/topics/opcodes-and-status-codes#json-json-error-codes
export const ErrorCode = Object.freeze({
  GENERAL: 0,
  UNKNOWN_ACCOUNT: 10001,
  UNKNOWN_APPLICATION: 10002,
  UNKNOWN_CHANNEL: 10003,
  UNKNOWN_GUILD: 10004,
  UNKNOWN_INTEGRATION: 10005,
  UNKNOWN_INVITE: 10006,
  UNKNOWN_MEMBER: 10007,
  UNKNOWN_MESSAGE: 10008,
  UNKNOWN_OVERWRITE: 10009,
  UNKNOWN_ROLE: 10011,
  UNKNOWN_TOKEN: 10012,
  UNKNOWN_USER: 10013,
  UNKNOWN_WEBHOOK: 10015,
  UNKNOWN_BAN: 10026,
  UNKNOWN_SKU: 10027,
  UNKNOWN_ENTITLEMENT: 10029,
  UNKNOWN_INTERACTION: 10062,
  UNKNOWN_APPLICATION_COMMAND: 10063,
  // ASSUMPTION: the JSON error code table has no entry for an unknown AutoMod rule or an unknown
  // subscription. We answer 404 with code 0 ("General error"); override with options.errorCodes.
  UNKNOWN_AUTOMOD_RULE: 0,
  UNKNOWN_SUBSCRIPTION: 0,
  BOTS_CANNOT_USE_ENDPOINT: 20001,
  ONLY_BOTS_CAN_USE_ENDPOINT: 20002,
  NOT_AUTHORIZED_FOR_APPLICATION: 20012,
  MAX_ROLES: 30005,
  MAX_CHANNELS: 30013,
  UNAUTHORIZED: 40001,
  INTERACTION_ALREADY_ACKNOWLEDGED: 40060,
  MISSING_ACCESS: 50001,
  INVALID_ACCOUNT_TYPE: 50002,
  CANNOT_EXECUTE_ON_DM: 50003,
  CANNOT_SEND_EMPTY_MESSAGE: 50006,
  CANNOT_SEND_TO_USER: 50007,
  CANNOT_SEND_IN_NON_TEXT: 50008,
  INVALID_OAUTH2_STATE: 50012,
  MISSING_PERMISSIONS: 50013,
  INVALID_AUTH_TOKEN: 50014,
  INVALID_BULK_DELETE_COUNT: 50016,
  CANNOT_EXECUTE_ON_SYSTEM_MESSAGE: 50021,
  CANNOT_EXECUTE_ON_CHANNEL_TYPE: 50024,
  INVALID_OAUTH2_ACCESS_TOKEN: 50025,
  INVALID_WEBHOOK_TOKEN: 50027,
  INVALID_ROLE: 50028,
  INVALID_RECIPIENTS: 50033,
  MESSAGE_TOO_OLD_TO_BULK_DELETE: 50034,
  INVALID_FORM_BODY: 50035,
  INVALID_API_VERSION: 50041,
  INVALID_JSON: 50109,
  FAILED_TO_BAN_USERS: 500000,
});
