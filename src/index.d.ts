// Type definitions for discord-test-server.
// Discord objects are returned in Discord's own JSON shapes (see https://discord.com/developers/docs);
// they are typed loosely here as `DiscordObject`.

export type Snowflake = string;
export type DiscordObject = Record<string, any>;
/** Permission names such as 'BAN_MEMBERS', or a Discord bitfield (decimal string, number or bigint). */
export type PermissionInput = string | number | bigint | string[];
export type TimeInput = number | string | Date;

export interface RateLimitBucket { limit: number; windowMs: number }

export interface FakeDiscordOptions {
  port?: number;
  host?: string;
  /** 'real' follows the wall clock (shiftable); 'manual' is frozen and deterministic. */
  clock?: 'real' | 'manual' | { mode: 'real' | 'manual'; now?: TimeInput };
  now?: TimeInput;
  seed?: number;
  rateLimits?: false | {
    enabled?: boolean;
    global?: RateLimitBucket | null;
    default?: RateLimitBucket;
    routes?: Record<string, RateLimitBucket>;
  };
  gateway?: {
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number | null;
    heartbeatTimeoutCloseCode?: number;
    maxGuildsPerShard?: number;
    maxBufferedDispatches?: number;
    resumeWindowMs?: number;
    acceptedVersions?: number[];
    sessionStartLimit?: { total: number; max_concurrency: number; resetAfterMs: number };
  };
  interactions?: { callbackDeadlineMs?: number; tokenTtlMs?: number };
  cdn?: { attachmentTtlMs?: number; maxUploadBytes?: number };
  oauth?: { mode?: 'auto' | 'consent'; userId?: Snowflake; guildId?: Snowflake };
  demo?: boolean | { botPermissions?: PermissionInput };
  setup?: (control: Control) => void | Promise<void>;
  /** Replace every Discord-facing handler with a stub (used to prove contract tests can fail). */
  stub?: boolean;
  publicHost?: string;
}

export interface ApplicationSummary {
  id: Snowflake;
  name: string;
  bot_user_id: Snowflake;
  token: string;
  client_id: Snowflake;
  client_secret: string;
  public_key: string;
  privileged_intents: { guild_members: boolean; guild_presences: boolean; message_content: boolean };
}

export interface UserView {
  id: Snowflake;
  status: 'pending' | 'responded' | 'thinking' | 'modal' | 'failed';
  error: string | null;
  ephemeral: boolean;
  modal: DiscordObject | null;
  messages: DiscordObject[];
  timeline: Array<{ at: string; kind: string; [k: string]: any }>;
}

export interface FaultMatch { route?: string; path?: string | RegExp; method?: string; count?: number }

export interface ActResult { status: number; body: any }

export declare class ControlError extends Error {
  status?: number;
  body?: any;
}

export interface Control {
  // clock
  now(): { now: number; iso: string };
  setNow(arg: { time: TimeInput } | TimeInput): { now: number; iso: string };
  advance(arg: { ms: number } | number): { now: number; iso: string };

  // setup
  createApplication(o: { name: string; id?: Snowflake; botUsername?: string; ownerId?: Snowflake; description?: string; redirectUris?: string[]; privilegedIntents?: { guildMembers?: boolean; guildPresences?: boolean; messageContent?: boolean }; flags?: number; token?: string; clientSecret?: string }): ApplicationSummary;
  setPrivilegedIntents(o: { applicationId: Snowflake; guildMembers?: boolean; guildPresences?: boolean; messageContent?: boolean }): DiscordObject;
  setRedirectUris(o: { applicationId: Snowflake; redirectUris: string[] }): DiscordObject;
  createUser(o: { username: string; global_name?: string; bot?: boolean; id?: Snowflake; locale?: string; email?: string }): DiscordObject;
  createGuild(o: { name: string; ownerId: Snowflake; id?: Snowflake; everyonePermissions?: PermissionInput; features?: string[]; systemChannel?: boolean; preferredLocale?: string }): { id: Snowflake; name: string; owner_id: Snowflake; everyone_role_id: Snowflake; system_channel_id: Snowflake | null };
  updateGuild(o: { guildId: Snowflake; name?: string; systemChannelId?: Snowflake | null; rulesChannelId?: Snowflake | null; publicUpdatesChannelId?: Snowflake | null; features?: string[]; preferredLocale?: string; ownerId?: Snowflake; systemChannelFlags?: number }): DiscordObject;
  createRole(o: { guildId: Snowflake; name: string; permissions?: PermissionInput; position?: number; color?: number; hoist?: boolean; mentionable?: boolean; actorId?: Snowflake; reason?: string }): DiscordObject;
  updateRole(o: { guildId: Snowflake; roleId: Snowflake; actorId?: Snowflake; reason?: string; name?: string; permissions?: PermissionInput; color?: number; hoist?: boolean; mentionable?: boolean }): DiscordObject;
  setRolePosition(o: { guildId: Snowflake; roleId: Snowflake; position: number; actorId?: Snowflake; reason?: string }): DiscordObject;
  createChannel(o: { guildId: Snowflake; name: string; type?: number; parentId?: Snowflake; topic?: string; position?: number; permissionOverwrites?: Array<{ id: Snowflake; type: 0 | 1; allow?: PermissionInput; deny?: PermissionInput }>; nsfw?: boolean; rateLimitPerUser?: number; ownerId?: Snowflake; actorId?: Snowflake; reason?: string }): DiscordObject;
  updateChannel(o: { channelId: Snowflake; actorId?: Snowflake; reason?: string; name?: string; topic?: string; position?: number; parentId?: Snowflake | null; nsfw?: boolean; rateLimitPerUser?: number; permissionOverwrites?: Array<{ id: Snowflake; type: 0 | 1; allow?: PermissionInput; deny?: PermissionInput }> }): DiscordObject;
  setPermissionOverwrite(o: { channelId: Snowflake; id: Snowflake; type: 0 | 1; allow?: PermissionInput; deny?: PermissionInput; actorId?: Snowflake; reason?: string }): DiscordObject;
  addMember(o: { guildId: Snowflake; userId: Snowflake; roles?: Snowflake[]; nick?: string; pending?: boolean; joinedAt?: TimeInput; communicationDisabledUntil?: string | null; inviteCode?: string }): DiscordObject;
  updateMember(o: { guildId: Snowflake; userId: Snowflake; actorId?: Snowflake; reason?: string; roles?: Snowflake[]; nick?: string | null; communicationDisabledUntil?: string | null; pending?: boolean; flags?: number }): DiscordObject;
  setMemberRoles(o: { guildId: Snowflake; userId: Snowflake; roles: Snowflake[]; actorId?: Snowflake; reason?: string }): DiscordObject;
  installBot(o: { applicationId: Snowflake; guildId: Snowflake; permissions?: PermissionInput; installerId?: Snowflake; rolePosition?: number }): DiscordObject;
  setBotPermissions(o: { applicationId: Snowflake; guildId: Snowflake; permissions: PermissionInput; actorId?: Snowflake }): { role: DiscordObject; permissions: string };
  setBotRolePosition(o: { applicationId: Snowflake; guildId: Snowflake; position: number; actorId?: Snowflake }): DiscordObject;
  createInvite(o: { guildId: Snowflake; channelId?: Snowflake; inviterId?: Snowflake; code?: string; maxUses?: number; maxAge?: number }): DiscordObject;
  registerCommand(o: { applicationId: Snowflake; guildId?: Snowflake; command: DiscordObject }): DiscordObject;
  listCommands(o: { applicationId: Snowflake; guildId?: Snowflake | null }): DiscordObject[];
  installForUser(o: { applicationId: Snowflake; userId: Snowflake }): { ok: true };
  uninstallForUser(o: { applicationId: Snowflake; userId: Snowflake }): { ok: true };
  setOAuthUser(o: { userId: Snowflake | null; guildId?: Snowflake | null }): DiscordObject;
  setOAuthMode(o: { mode: 'auto' | 'consent' }): DiscordObject;
  createSku(o: { applicationId: Snowflake; name: string; type?: number; slug?: string; flags?: number }): DiscordObject;
  grantEntitlement(o: { applicationId: Snowflake; skuId: Snowflake; userId?: Snowflake; guildId?: Snowflake; type?: number; startsAt?: string; endsAt?: string }): DiscordObject;
  updateEntitlement(o: { entitlementId: Snowflake; startsAt?: string | null; endsAt?: string | null; consumed?: boolean }): DiscordObject;
  deleteEntitlement(o: { entitlementId: Snowflake }): DiscordObject;
  createSubscription(o: { applicationId: Snowflake; userId: Snowflake; guildId?: Snowflake; skuIds: Snowflake[]; status?: number; currentPeriodStart?: string; currentPeriodEnd?: string }): DiscordObject;

  // people
  postMessage(o: {
    channelId: Snowflake; authorId: Snowflake; content?: string; embeds?: DiscordObject[]; components?: DiscordObject[];
    attachments?: Array<{ filename: string; contentType?: string; data: string | Uint8Array; base64?: boolean; description?: string }>;
    replyTo?: Snowflake; forward?: { channelId: Snowflake; messageId: Snowflake }; type?: number; flags?: number;
    timestamp?: TimeInput; force?: boolean; mentionRepliedUser?: boolean; poll?: DiscordObject; webhookId?: Snowflake; applicationId?: Snowflake;
  }): DiscordObject | { blocked: true; by: 'automod' };
  editMessage(o: { channelId: Snowflake; messageId: Snowflake; content?: string; embeds?: DiscordObject[]; components?: DiscordObject[] }): DiscordObject;
  deleteMessage(o: { channelId: Snowflake; messageId: Snowflake; actorId?: Snowflake; reason?: string; force?: boolean }): any;
  join(o: { guildId: Snowflake; userId: Snowflake; inviteCode?: string; pending?: boolean }): DiscordObject;
  leave(o: { guildId: Snowflake; userId: Snowflake }): { ok: true };
  runCommand(o: { applicationId: Snowflake; userId: Snowflake; guildId?: Snowflake; channelId?: Snowflake; name: string; type?: 1 | 2 | 3; options?: Record<string, any> | DiscordObject[]; targetId?: Snowflake; locale?: string; commandId?: Snowflake }): { id: Snowflake; token: string; payload: DiscordObject };
  pressButton(o: { applicationId?: Snowflake; userId: Snowflake; channelId?: Snowflake; messageId: Snowflake; customId: string; values?: string[]; locale?: string }): { id: Snowflake; token: string; payload: DiscordObject };
  submitModal(o: { interactionId: Snowflake; userId?: Snowflake; values?: Record<string, string>; locale?: string }): { id: Snowflake; token: string; payload: DiscordObject };
  actAs(o: { userId: Snowflake; method: string; path: string; body?: any; query?: Record<string, string>; reason?: string }): ActResult;

  // staff
  kickMember(o: { actorId: Snowflake; guildId: Snowflake; userId: Snowflake; reason?: string }): any;
  banMember(o: { actorId: Snowflake; guildId: Snowflake; userId: Snowflake; reason?: string; deleteMessageSeconds?: number }): any;
  unbanMember(o: { actorId: Snowflake; guildId: Snowflake; userId: Snowflake; reason?: string }): any;
  massBan(o: { actorId: Snowflake; guildId: Snowflake; userIds: Snowflake[]; reason?: string; deleteMessageSeconds?: number }): { banned_users: Snowflake[]; failed_users: Snowflake[] };
  massKick(o: { actorId: Snowflake; guildId: Snowflake; userIds: Snowflake[]; reason?: string }): ActResult[];
  timeoutMember(o: { actorId: Snowflake; guildId: Snowflake; userId: Snowflake; until: string | null; reason?: string }): DiscordObject;
  deleteChannel(o: { channelId: Snowflake; actorId?: Snowflake; reason?: string }): DiscordObject;
  deleteRole(o: { guildId: Snowflake; roleId: Snowflake; actorId?: Snowflake; reason?: string }): any;
  editRolePermissions(o: { actorId: Snowflake; guildId: Snowflake; roleId: Snowflake; permissions: PermissionInput; reason?: string }): DiscordObject;

  // faults
  injectRateLimit(o?: FaultMatch & { retryAfter?: number; global?: boolean; scope?: 'user' | 'global' | 'shared' }): { id: string };
  injectError(o?: FaultMatch & { status?: number; body?: any }): { id: string };
  injectDrop(o?: FaultMatch): { id: string };
  injectDelay(o?: FaultMatch & { ms?: number }): { id: string };
  injectDrift(o: FaultMatch & { action?: { method: string; args?: any }; fn?: (ctx: { world: any; control: Control; method: string; path: string }) => void | Promise<void> }): { id: string };
  clearFaults(): { ok: true };
  removeFault(o: { id: string }): { ok: true };
  listFaults(): any[];
  setRateLimit(o: { route: string | 'global' | 'default'; limit: number | null; windowMs?: number }): { ok: true };
  setRateLimitsEnabled(o: { enabled: boolean }): { ok: true };
  resetRateLimits(): { ok: true };
  gatewaySessions(): Array<{ session_id: string; application_id: Snowflake; shard: [number, number]; intents: number; seq: number; connected: boolean; invalidated: boolean }>;
  closeGatewaySession(o?: { sessionId?: string; applicationId?: Snowflake; shard?: number; code?: number; reason?: string }): { closed: number };
  invalidateGatewaySession(o?: { sessionId?: string; applicationId?: Snowflake; shard?: number; resumable?: boolean }): { invalidated: number };
  requestGatewayReconnect(o?: { sessionId?: string; applicationId?: Snowflake; shard?: number }): { sent: number };
  requestHeartbeat(o?: { sessionId?: string; applicationId?: Snowflake; shard?: number }): { sent: number };
  expireInteraction(o: { interactionId: Snowflake }): { ok: true };

  // read
  getState(): DiscordObject;
  getGuild(o: { guildId: Snowflake }): DiscordObject;
  getMember(o: { guildId: Snowflake; userId: Snowflake }): DiscordObject;
  getMembers(o: { guildId: Snowflake }): DiscordObject[];
  getRoles(o: { guildId: Snowflake }): DiscordObject[];
  getChannels(o: { guildId: Snowflake }): DiscordObject[];
  getBans(o: { guildId: Snowflake }): Array<{ reason: string | null; user: DiscordObject }>;
  getMessages(o: { channelId: Snowflake }): DiscordObject[];
  getMessage(o: { channelId: Snowflake; messageId: Snowflake }): DiscordObject;
  getPermissions(o: { guildId: Snowflake; userId: Snowflake; channelId?: Snowflake }): { permissions: string };
  getAuditLog(o: { guildId: Snowflake }): DiscordObject[];
  getInvite(o: { code: string }): DiscordObject;
  getRequestLog(o?: { since?: number; route?: string; method?: string; path?: string }): DiscordObject[];
  getGatewayLog(o?: { sessionId?: string; applicationId?: Snowflake; shard?: number; direction?: 'in' | 'out' | 'buffered' | 'close'; t?: string; since?: number }): DiscordObject[];
  getGatewayFramesByShard(o?: { applicationId?: Snowflake }): Record<string, Array<{ s: number; t: string; d: any }>>;
  getInteraction(o: { interactionId: Snowflake }): DiscordObject & { user_view: UserView };
  listInteractions(o?: { applicationId?: Snowflake }): DiscordObject[];
  getUserView(o: { interactionId: Snowflake }): UserView | null;
  formatLog(): string;

  // lifecycle
  reset(o?: { keepLogs?: boolean }): { ok: true };
  snapshot(): { id: string };
  restore(o: { id: string }): { ok: true };
  call(method: string, args?: any): any;
}

export interface DemoWorld {
  users: { owner: DiscordObject; moderator: DiscordObject; alice: DiscordObject; bob: DiscordObject; spammer: DiscordObject };
  applications: { modbot: ApplicationSummary; otherApp: ApplicationSummary };
  guilds: Array<{
    id: Snowflake; name: string; systemChannelId: Snowflake; rulesChannelId: Snowflake; modLogChannelId: Snowflake;
    quarantineChannelId: Snowflake; voiceChannelId: Snowflake; categoryId: Snowflake; inviteCode: string;
    roles: { everyone: Snowflake; moderator: Snowflake; member: Snowflake; quarantine: Snowflake };
  }>;
  sku: DiscordObject;
}

export interface FakeDiscord {
  url: string;
  apiUrl: string;
  restUrl: string;
  gatewayUrl: string;
  oauthUrl: string;
  cdnUrl: string;
  controlUrl: string;
  control: Control;
  demo: DemoWorld | null;
  world: any;
  close(): Promise<void>;
}

export declare function createFakeDiscord(options?: FakeDiscordOptions): Promise<FakeDiscord>;
export default createFakeDiscord;
export declare function seedDemoWorld(control: Control, options?: { botPermissions?: PermissionInput }): DemoWorld;
export declare function computePermissions(world: any, guildId: Snowflake, userId: Snowflake, channelId?: Snowflake): bigint;
export declare function parsePermissions(v: PermissionInput): bigint;
export declare function permissionNames(bits: string | number | bigint): string[];
export declare function snowflakeTime(id: Snowflake): number;
export declare class Clock {
  constructor(o?: { mode?: 'real' | 'manual'; now?: TimeInput });
  mode: 'real' | 'manual';
  now(): number;
  setNow(t: TimeInput): number;
  advance(ms: number): number;
  iso(ms?: number): string;
}
export declare const constants: {
  Permissions: Record<string, bigint>;
  Intents: Record<string, number>;
  GatewayOp: Record<string, number>;
  GatewayClose: Record<string, number>;
  ChannelType: Record<string, number>;
  MessageType: Record<string, number>;
  MessageFlags: Record<string, number>;
  AuditLogEvent: Record<string, number>;
  InteractionType: Record<string, number>;
  InteractionCallbackType: Record<string, number>;
  ErrorCode: Record<string, number>;
  [name: string]: any;
};
