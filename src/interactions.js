import { Errors, assertValid, formError, DiscordError } from './errors.js';
import {
  InteractionType as IT, InteractionCallbackType as CB, MessageFlags, MessageType, ChannelType,
  InteractionContextType as CTX, Permissions as P, ApplicationCommandOptionType as OT, ComponentType,
} from './constants.js';
import { computePermissions } from './permissions.js';
import { createMessageFromBody, messageBodySchema } from './rest/channels.js';
import { deepClone } from './util.js';

const DOCS = 'https://discord.com/developers/docs';
// ${DOCS}/interactions/receiving-and-responding#responding-to-an-interaction
// "you must send an initial response within 3 seconds"; "tokens are valid for 15 minutes".
export const DEFAULT_INTERACTION_TIMINGS = { callbackDeadlineMs: 3000, tokenTtlMs: 15 * 60 * 1000 };

/**
 * Interaction records live in world.state.interactions and keep everything the user would see:
 * record.view – chronological list of what appeared on the user's screen.
 */
export class Interactions {
  constructor({ world, ops, server, timings = {} }) {
    this.world = world;
    this.ops = ops;
    this.server = server;
    this.timings = { ...DEFAULT_INTERACTION_TIMINGS, ...timings };
  }

  byId(id) { return this.world.state.interactions[id]; }
  byToken(token) { return Object.values(this.world.state.interactions).find((i) => i.token === token); }

  // ---------------------------------------------------------------------------
  // Creating interactions (control API: a person uses the app)
  // ---------------------------------------------------------------------------

  /** Run a slash / user / message command. */
  runCommand({ applicationId, userId, guildId, channelId, name, type = 1, options, targetId, locale = 'en-US', commandId }) {
    const w = this.world;
    const app = w.app(applicationId);
    if (!app) throw new Error(`runCommand: unknown application ${applicationId}`);
    if (!w.user(userId)) throw new Error(`runCommand: unknown user ${userId}`);
    const cmd = commandId ? w.state.commands[commandId] : this.findCommand(applicationId, guildId, name, type);
    if (!cmd) throw new Error(`runCommand: application ${applicationId} has no ${guildId ? 'guild or global ' : 'global '}command "${name}" of type ${type}`);
    const place = this.resolvePlace({ app, userId, guildId, channelId, cmd });
    const data = { id: cmd.id, name: cmd.name, type: cmd.type };
    if (cmd.guild_id) data.guild_id = cmd.guild_id;
    const resolved = {};
    if (options !== undefined) data.options = this.buildOptions(cmd.options ?? [], options, place.guildId, resolved, userId);
    if (targetId) {
      data.target_id = targetId;
      if (cmd.type === 2) addResolvedUser(w, resolved, targetId, place.guildId);
      if (cmd.type === 3) {
        const m = w.message(place.channelId, targetId);
        if (!m) throw new Error(`runCommand: unknown target message ${targetId}`);
        (resolved.messages ??= {})[targetId] = w.messageJSON(m);
      }
    }
    if (Object.keys(resolved).length) data.resolved = resolved;
    return this.deliver({ app, type: IT.APPLICATION_COMMAND, userId, place, data, locale });
  }

  /** Press a button (or pick from a select) on a message the app sent. */
  pressButton({ applicationId, userId, channelId, messageId, customId, values, locale = 'en-US' }) {
    const w = this.world;
    const located = this.findMessage(channelId, messageId);
    if (!located) throw new Error(`pressButton: unknown message ${messageId}`);
    const { message, json, record } = located;
    const appId = applicationId ?? message.application_id ?? w.appByBotUser(message.author_id)?.id;
    const app = w.app(appId);
    if (!app) throw new Error('pressButton: the message was not sent by an application');
    const comp = findComponent(message.components ?? [], customId);
    if (!comp) throw new Error(`pressButton: no component with custom_id "${customId}" on message ${messageId}`);
    if (comp.disabled) throw new Error(`pressButton: component "${customId}" is disabled`);
    const guildId = record?.guild_id ?? message.guild_id ?? undefined;
    const place = this.resolvePlace({ app, userId, guildId, channelId: message.channel_id ?? record?.channel_id, cmd: null, component: true, record });
    const data = { custom_id: customId, component_type: comp.type };
    if (values) data.values = values;
    return this.deliver({ app, type: IT.MESSAGE_COMPONENT, userId, place, data, locale, message: json });
  }

  /** Submit the modal that the app opened in response to `interactionId`. */
  submitModal({ interactionId, userId, values = {}, locale = 'en-US' }) {
    const parent = this.byId(interactionId);
    if (!parent) throw new Error(`submitModal: unknown interaction ${interactionId}`);
    const modal = parent.modal;
    if (!modal) throw new Error(`submitModal: interaction ${interactionId} did not open a modal`);
    const app = this.world.app(parent.application_id);
    const uid = userId ?? parent.user_id;
    const place = { guildId: parent.guild_id, channelId: parent.channel_id, context: parent.context, owners: parent.authorizing_integration_owners, appInGuild: parent.app_in_guild };
    // ${DOCS}/interactions/receiving-and-responding#interaction-object-modal-submit-data-structure
    const components = [];
    for (const row of modal.components ?? []) {
      for (const c of flattenComponents([row])) {
        if (c.type !== ComponentType.TEXT_INPUT) continue;
        if (c.required !== false && (values[c.custom_id] === undefined || values[c.custom_id] === '')) {
          throw new Error(`submitModal: text input "${c.custom_id}" is required`);
        }
        const value = values[c.custom_id] ?? '';
        if (row.type === ComponentType.LABEL) components.push({ type: ComponentType.LABEL, component: { type: 4, custom_id: c.custom_id, value } });
        else components.push({ type: ComponentType.ACTION_ROW, components: [{ type: 4, custom_id: c.custom_id, value }] });
      }
    }
    const data = { custom_id: modal.custom_id, components };
    parent.view.push({ at: this.world.iso(), kind: 'modal_submitted', values: deepClone(values) });
    parent.modal_open = false;
    const message = parent.source_message ?? undefined;
    return this.deliver({ app, type: IT.MODAL_SUBMIT, userId: uid, place, data, locale, message });
  }

  findCommand(applicationId, guildId, name, type) {
    const cmds = Object.values(this.world.state.commands).filter((c) => c.application_id === applicationId && c.name === name && c.type === type);
    return cmds.find((c) => guildId && c.guild_id === guildId) ?? cmds.find((c) => !c.guild_id);
  }

  /**
   * Where the interaction happens, and whether Discord would let it happen at all.
   * ${DOCS}/interactions/application-commands#interaction-contexts
   * ${DOCS}/resources/application#installation-context
   */
  resolvePlace({ app, userId, guildId, channelId, cmd, component = false, record }) {
    const w = this.world;
    const userInstalled = !!w.state.userInstalls[app.id]?.[userId];
    const integrationTypes = cmd?.integration_types ?? [0];
    const contexts = cmd?.contexts ?? [0, 1, 2];
    if (guildId) {
      const g = w.guild(guildId);
      if (!g) throw new Error(`unknown guild ${guildId}`);
      if (!g.members[userId]) throw new Error(`user ${userId} is not a member of guild ${guildId}`);
      const ch = w.channel(channelId ?? g.system_channel_id);
      if (!ch || ch.guild_id !== guildId) throw new Error(`unknown channel ${channelId} in guild ${guildId}`);
      const appInGuild = !!g.members[app.bot_user_id];
      const owners = {};
      if (appInGuild && integrationTypes.includes(0)) owners['0'] = guildId;
      if (userInstalled && integrationTypes.includes(1)) owners['1'] = userId;
      if (!component && !Object.keys(owners).length) throw new Error(`application ${app.id} is not installed for this user or guild`);
      if (!component && !contexts.includes(CTX.GUILD)) throw new Error('command is not available in guilds');
      const perms = computePermissions(w, guildId, userId, ch.id);
      if (!component && !(perms & P.USE_APPLICATION_COMMANDS)) throw new Error('user lacks USE_APPLICATION_COMMANDS in this channel');
      if (!component && cmd?.default_member_permissions && cmd.guild_id !== undefined) {
        const need = BigInt(cmd.default_member_permissions);
        if ((perms & need) !== need) throw new Error('user lacks the command\'s default_member_permissions');
      }
      return { guildId, channelId: ch.id, context: CTX.GUILD, owners: component ? record?.authorizing_integration_owners ?? { 0: guildId } : owners, appInGuild };
    }
    // DMs
    let ch = channelId ? w.channel(channelId) : null;
    if (!ch) ch = this.ops.openDM(userId, app.bot_user_id);
    if (ch.type !== ChannelType.DM || !ch.recipients.includes(userId)) throw new Error(`channel ${ch.id} is not a DM of user ${userId}`);
    const botDm = ch.recipients.includes(app.bot_user_id);
    const context = botDm ? CTX.BOT_DM : CTX.PRIVATE_CHANNEL;
    if (!component) {
      if (!contexts.includes(context)) throw new Error(`command is not available in context ${context}`);
      const sharesGuild = w.guildsOfUser(userId).some((g) => g.members[app.bot_user_id]);
      const viaUser = userInstalled && integrationTypes.includes(1);
      const viaGuild = context === CTX.BOT_DM && sharesGuild && integrationTypes.includes(0);
      if (!viaUser && !viaGuild) throw new Error(`application ${app.id} is not available to user ${userId} in this DM`);
    }
    // ${DOCS}/interactions/receiving-and-responding#interaction-object-authorizing-integration-owners-object
    // A key is present only if the app is installed in that context and the command supports it; GUILD_INSTALL
    // is "0" only in the DM with the app's bot user.
    const owners = {};
    const cmdTypes = component ? [0, 1] : integrationTypes;
    if (context === CTX.BOT_DM && cmdTypes.includes(0) && w.guildsOfUser(userId).some((g) => g.members[app.bot_user_id])) owners['0'] = '0';
    if (userInstalled && cmdTypes.includes(1)) owners['1'] = userId;
    if (!Object.keys(owners).length) owners['0'] = '0';
    return { guildId: undefined, channelId: ch.id, context, owners, appInGuild: false };
  }

  buildOptions(defs, given, guildId, resolved, userId) {
    const list = Array.isArray(given) ? given : Object.entries(given).map(([name, value]) => ({ name, value }));
    return list.map((o) => {
      const def = defs.find((d) => d.name === o.name);
      const type = o.type ?? def?.type ?? OT.STRING;
      if (type === OT.SUB_COMMAND || type === OT.SUB_COMMAND_GROUP) {
        return { name: o.name, type, options: this.buildOptions(def?.options ?? [], o.options ?? o.value ?? [], guildId, resolved, userId) };
      }
      const value = o.value;
      if (type === OT.USER || (type === OT.MENTIONABLE && this.world.user(value))) addResolvedUser(this.world, resolved, value, guildId);
      if (type === OT.ROLE || (type === OT.MENTIONABLE && guildId && this.world.role(guildId, value))) {
        const role = this.world.role(guildId, value);
        if (role) (resolved.roles ??= {})[value] = this.world.roleJSON(role);
      }
      if (type === OT.CHANNEL) {
        const c = this.world.channel(value);
        if (c) (resolved.channels ??= {})[value] = { id: c.id, name: c.name, type: c.type, permissions: c.guild_id ? computePermissions(this.world, c.guild_id, userId, c.id).toString() : '0' };
      }
      const out = { name: o.name, type, value };
      if (o.focused) out.focused = true;
      return out;
    });
  }

  findMessage(channelId, messageId) {
    const w = this.world;
    if (channelId) {
      const m = w.message(channelId, messageId);
      if (m) return { message: m, json: w.messageJSON(m) };
    }
    for (const msgs of Object.values(w.state.messages)) if (msgs[messageId]) return { message: msgs[messageId], json: w.messageJSON(msgs[messageId]) };
    // Ephemeral messages live inside interaction records.
    for (const rec of Object.values(w.state.interactions)) {
      const m = rec.messages.find((x) => x.id === messageId);
      if (m) return { message: { ...m, author_id: m.author.id }, json: deepClone(m), record: rec };
    }
    return null;
  }

  // ${DOCS}/interactions/receiving-and-responding#interaction-object
  deliver({ app, type, userId, place, data, locale, message }) {
    const w = this.world;
    const id = w.id();
    const now = w.now();
    const rec = {
      id,
      application_id: app.id,
      type,
      token: `aW50ZXJhY3Rpb246${id}:${w.rng.b64url(96)}`,
      user_id: userId,
      guild_id: place.guildId,
      channel_id: place.channelId,
      context: place.context,
      authorizing_integration_owners: place.owners,
      app_in_guild: place.appInGuild,
      data,
      locale,
      created_at: now,
      deadline_at: now + this.timings.callbackDeadlineMs,
      expires_at: now + this.timings.tokenTtlMs,
      acknowledged: false,
      callback_type: null,
      ephemeral: false,
      original_message_id: null,
      modal: null,
      messages: [], // ephemeral messages (full JSON), only visible to the user
      view: [],
    };
    if (message) rec.source_message = message;
    w.state.interactions[id] = rec;
    rec.payload = this.payload(rec);
    // ${DOCS}/events/gateway-events#interaction-create
    this.ops.dispatch('INTERACTION_CREATE', rec.payload, { applicationId: app.id, guildId: place.guildId, appEvent: true });
    return { id, token: rec.token, payload: deepClone(rec.payload) };
  }

  payload(rec) {
    const w = this.world;
    const app = w.app(rec.application_id);
    const d = {
      app_permissions: '0',
      application_id: rec.application_id,
      attachment_size_limit: 10485760,
      authorizing_integration_owners: deepClone(rec.authorizing_integration_owners),
      channel_id: rec.channel_id,
      context: rec.context,
      data: deepClone(rec.data),
      entitlements: Object.values(w.state.entitlements)
        // https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object – "entitlements for
        // the invoking user, representing access to premium SKUs": only active ones (not deleted, not ended).
        .filter((e) => e.application_id === rec.application_id && !e.deleted && !(e.ends_at && Date.parse(e.ends_at) <= w.now())
          && (e.user_id === rec.user_id || (rec.guild_id && e.guild_id === rec.guild_id)))
        .map((e) => this.ops.entitlementJSON(e)),
      id: rec.id,
      locale: rec.locale,
      token: rec.token,
      type: rec.type,
      version: 1,
    };
    const ch = w.channel(rec.channel_id);
    if (ch) d.channel = ch.type === ChannelType.DM ? w.channelJSON(ch, { viewerId: rec.user_id }) : w.channelJSON(ch);
    if (rec.guild_id) {
      const g = w.guild(rec.guild_id);
      d.guild_id = rec.guild_id;
      d.guild = { id: g.id, locale: g.preferred_locale ?? 'en-US', features: [...(g.features ?? [])] };
      d.guild_locale = g.preferred_locale ?? 'en-US';
      d.member = w.memberJSON(rec.guild_id, rec.user_id, { permissions: computePermissions(w, rec.guild_id, rec.user_id, rec.channel_id) });
      if (g.members[app.bot_user_id]) d.app_permissions = computePermissions(w, rec.guild_id, app.bot_user_id, rec.channel_id).toString();
      else d.app_permissions = '0';
      if (ch) d.channel.permissions = computePermissions(w, rec.guild_id, rec.user_id, rec.channel_id).toString();
    } else {
      d.user = w.userJSON(rec.user_id);
      // ${DOCS}/interactions/receiving-and-responding#interaction-object – app_permissions "includes ATTACH_FILES |
      // EMBED_LINKS | MENTION_EVERYONE permissions for (G)DMs with other users, and additionally includes
      // USE_EXTERNAL_EMOJIS for DMs with the app's bot user"
      let dmPerms = P.ATTACH_FILES | P.EMBED_LINKS | P.MENTION_EVERYONE;
      if (rec.context === CTX.BOT_DM) dmPerms |= P.USE_EXTERNAL_EMOJIS;
      d.app_permissions = dmPerms.toString();
    }
    if (rec.source_message) d.message = deepClone(rec.source_message);
    return d;
  }

  // ---------------------------------------------------------------------------
  // What the user sees
  // ---------------------------------------------------------------------------
  /** Summary of an interaction from the user's point of view. */
  userView(id) {
    const rec = this.byId(id);
    if (!rec) return null;
    const now = this.world.now();
    let status;
    if (!rec.acknowledged) status = now > rec.deadline_at || rec.forced_expired ? 'failed' : 'pending';
    else if (rec.callback_type === CB.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE && this.originalLoading(rec)) status = now > rec.expires_at ? 'failed' : 'thinking';
    else if (rec.callback_type === CB.MODAL) status = rec.modal_open ? 'modal' : 'responded';
    else status = 'responded';
    const out = {
      id: rec.id,
      status,
      // The texts are the ones Discord's client shows.
      error: status === 'failed' ? (rec.acknowledged ? 'The application did not respond' : 'This interaction failed') : null,
      ephemeral: rec.ephemeral,
      modal: rec.modal_open ? deepClone(rec.modal) : null,
      messages: this.visibleMessages(rec),
      timeline: deepClone(rec.view),
    };
    return out;
  }

  originalLoading(rec) {
    const m = this.getResponseMessage(rec, rec.original_message_id);
    return !!m && ((m.flags ?? 0) & MessageFlags.LOADING) !== 0;
  }

  visibleMessages(rec) {
    const out = [];
    const ids = rec.response_message_ids ?? [];
    for (const mid of ids) {
      const m = this.getResponseMessage(rec, mid);
      if (m) out.push(m);
    }
    return out;
  }

  /** Message JSON for a response message (ephemeral or channel). */
  getResponseMessage(rec, messageId) {
    if (!messageId) return null;
    const eph = rec.messages.find((m) => m.id === messageId);
    if (eph) return deepClone(eph);
    const m = this.world.message(rec.channel_id, messageId);
    return m ? this.world.messageJSON(m) : null;
  }

  // ---------------------------------------------------------------------------
  // REST: callback, follow-ups, original response
  // ---------------------------------------------------------------------------
  register(r) {
    // ${DOCS}/interactions/receiving-and-responding#create-interaction-response
    r.add('POST', '/interactions/:interaction_id/:interaction_token/callback', (ctx) => this.callback(ctx), { auth: 'none', global: false });

    // ${DOCS}/interactions/receiving-and-responding#get-original-interaction-response
    r.add('GET', '/webhooks/:webhook_id/:webhook_token/messages/:message_id', (ctx) => {
      const rec = this.recordForWebhook(ctx);
      const mid = this.messageIdParam(rec, ctx.params.message_id);
      const m = this.getResponseMessage(rec, mid);
      if (!m) throw Errors.unknownMessage();
      return ctx.ok(m);
    }, { auth: 'none', global: false });

    // ${DOCS}/interactions/receiving-and-responding#edit-original-interaction-response
    r.add('PATCH', '/webhooks/:webhook_id/:webhook_token/messages/:message_id', (ctx) => {
      const rec = this.recordForWebhook(ctx);
      assertValid(ctx.body, { ...messageBodySchema, message_reference: { type: 'any' } });
      const mid = this.messageIdParam(rec, ctx.params.message_id);
      return ctx.ok(this.editResponse(ctx, rec, mid, ctx.body, ctx.files));
    }, { auth: 'none', global: false });

    // ${DOCS}/interactions/receiving-and-responding#delete-original-interaction-response
    r.add('DELETE', '/webhooks/:webhook_id/:webhook_token/messages/:message_id', (ctx) => {
      const rec = this.recordForWebhook(ctx);
      const mid = this.messageIdParam(rec, ctx.params.message_id);
      const idx = rec.messages.findIndex((m) => m.id === mid);
      if (idx >= 0) rec.messages.splice(idx, 1);
      else if (this.world.message(rec.channel_id, mid)) this.ops.deleteMessage(rec.channel_id, mid, {});
      else throw Errors.unknownMessage();
      rec.response_message_ids = (rec.response_message_ids ?? []).filter((x) => x !== mid);
      rec.view.push({ at: this.world.iso(), kind: 'deleted', message_id: mid });
      return ctx.noContent();
    }, { auth: 'none', global: false });

    // ${DOCS}/interactions/receiving-and-responding#create-followup-message
    r.add('POST', '/webhooks/:webhook_id/:webhook_token', (ctx) => {
      const rec = this.recordForWebhook(ctx);
      assertValid(ctx.body, messageBodySchema);
      if (!rec.acknowledged) throw Errors.unknownWebhook(); // ASSUMPTION: follow-ups need an initial response
      // "When using this endpoint directly after responding with DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, this endpoint
      // will function as Edit Original Interaction Response"
      if (rec.callback_type === CB.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE && this.originalLoading(rec)) {
        return ctx.ok(this.editResponse(ctx, rec, rec.original_message_id, ctx.body, ctx.files));
      }
      const msg = this.postResponse(ctx, rec, ctx.body, ctx.files, { followup: true });
      return ctx.ok(msg);
    }, { auth: 'none', global: false });
  }

  messageIdParam(rec, raw) {
    if (raw === '@original') {
      if (!rec.original_message_id) throw Errors.unknownMessage();
      return rec.original_message_id;
    }
    return raw;
  }

  recordForWebhook(ctx) {
    const rec = this.byToken(ctx.params.webhook_token);
    if (!rec || rec.application_id !== ctx.params.webhook_id) throw Errors.unknownWebhook();
    // "Interaction tokens are valid for 15 minutes" – afterwards: 401 Invalid Webhook Token.
    if (this.world.now() > rec.expires_at || rec.forced_expired) throw Errors.invalidWebhookToken();
    // Token invalidated when the 3 second deadline passed without a response.
    if (!rec.acknowledged && this.world.now() > rec.deadline_at) throw Errors.invalidWebhookToken();
    ctx.interaction = rec;
    return rec;
  }

  callback(ctx) {
    const rec = this.byId(ctx.params.interaction_id);
    if (!rec || rec.token !== ctx.params.interaction_token) throw Errors.unknownInteraction();
    if (rec.acknowledged) throw Errors.alreadyAcknowledged();
    if (rec.forced_expired || this.world.now() > rec.deadline_at) throw Errors.unknownInteraction();
    assertValid(ctx.body, {
      type: { type: 'int', required: true, choices: [1, 4, 5, 6, 7, 8, 9, 10, 12] },
      data: { type: 'object', nullable: true },
    });
    const { type } = ctx.body;
    const data = ctx.body.data ?? {};
    const isComponent = rec.type === IT.MESSAGE_COMPONENT || (rec.type === IT.MODAL_SUBMIT && rec.source_message);
    const invalidType = () => formError('type', 'INTERACTION_RESPONSE_TYPE_INVALID', 'Invalid interaction response type'); // ASSUMPTION: detail code
    if (type === CB.PONG && rec.type !== IT.PING) throw invalidType();
    if ((type === CB.DEFERRED_UPDATE_MESSAGE || type === CB.UPDATE_MESSAGE) && !isComponent) throw invalidType();
    if (type === CB.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT && rec.type !== IT.APPLICATION_COMMAND_AUTOCOMPLETE) throw invalidType();
    if (type === CB.MODAL && (rec.type === IT.MODAL_SUBMIT || rec.type === IT.PING)) throw invalidType();
    if (type === CB.CHANNEL_MESSAGE_WITH_SOURCE || type === CB.UPDATE_MESSAGE) assertValid(data, messageBodySchema);
    if (type === CB.MODAL) {
      assertValid(data, {
        custom_id: { type: 'string', required: true, minLength: 1, maxLength: 100 },
        title: { type: 'string', required: true, minLength: 1, maxLength: 45 },
        components: { type: 'array', required: true, minLength: 1, maxLength: 5 },
      });
    }

    rec.acknowledged = true;
    rec.callback_type = type;
    rec.acknowledged_at = this.world.now();
    let resource = { type };
    let responseMessage = null;
    switch (type) {
      case CB.CHANNEL_MESSAGE_WITH_SOURCE: {
        responseMessage = this.postResponse(ctx, rec, data, ctx.files, { original: true });
        break;
      }
      case CB.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: {
        // "the user sees a loading state"; only EPHEMERAL is a valid flag here.
        responseMessage = this.postResponse(ctx, rec, { content: '', flags: (data.flags ?? 0) & MessageFlags.EPHEMERAL }, [], { original: true, loading: true });
        break;
      }
      case CB.DEFERRED_UPDATE_MESSAGE:
        rec.view.push({ at: this.world.iso(), kind: 'deferred_update' });
        break;
      case CB.UPDATE_MESSAGE: {
        const src = rec.source_message;
        responseMessage = this.editResponse(ctx, rec, src.id, data, ctx.files, { component: true });
        rec.original_message_id = src.id;
        break;
      }
      case CB.MODAL:
        rec.modal = deepClone(data);
        rec.modal_open = true;
        rec.view.push({ at: this.world.iso(), kind: 'modal', modal: deepClone(data) });
        break;
      case CB.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT:
        rec.view.push({ at: this.world.iso(), kind: 'autocomplete', choices: deepClone(data.choices ?? []) });
        break;
      default:
        rec.view.push({ at: this.world.iso(), kind: 'callback', type });
    }
    // ${DOCS}/interactions/receiving-and-responding#interaction-callback-interaction-callback-resource-object –
    // message is "Only present if type is either CHANNEL_MESSAGE_WITH_SOURCE or UPDATE_MESSAGE".
    if (responseMessage && (type === CB.CHANNEL_MESSAGE_WITH_SOURCE || type === CB.UPDATE_MESSAGE)) resource.message = responseMessage;
    // ${DOCS}/interactions/receiving-and-responding#interaction-callback-interaction-callback-response-object
    // ${DOCS}/reference#boolean-query-strings – True, true or 1
    if (['true', 'True', '1'].includes(ctx.query.with_response)) {
      return ctx.ok({
        interaction: {
          id: rec.id,
          type: rec.type,
          response_message_id: rec.original_message_id ?? undefined,
          response_message_loading: responseMessage ? ((responseMessage.flags & MessageFlags.LOADING) !== 0) : undefined,
          response_message_ephemeral: responseMessage ? ((responseMessage.flags & MessageFlags.EPHEMERAL) !== 0) : undefined,
        },
        resource,
      });
    }
    return ctx.noContent();
  }

  /** Create a response or follow-up message. Ephemeral messages stay inside the record. */
  postResponse(ctx, rec, body, files, { original = false, loading = false, followup = false } = {}) {
    const w = this.world;
    const app = w.app(rec.application_id);
    let ephemeral = ((body.flags ?? 0) & MessageFlags.EPHEMERAL) !== 0;
    // ${DOCS}/topics/permissions – USE_EXTERNAL_APPS: when a user-installed app is not in the guild and the user
    // lacks USE_EXTERNAL_APPS, responses are forced ephemeral.
    if (rec.guild_id && !rec.app_in_guild) {
      const perms = computePermissions(w, rec.guild_id, rec.user_id, rec.channel_id);
      if (!(perms & P.USE_EXTERNAL_APPS)) ephemeral = true;
    }
    const metadata = {
      id: rec.id,
      type: rec.type,
      user: w.userJSON(rec.user_id),
      authorizing_integration_owners: deepClone(rec.authorizing_integration_owners),
    };
    if (followup && rec.original_message_id) metadata.original_response_message_id = rec.original_message_id;
    if (rec.type === IT.APPLICATION_COMMAND && rec.data?.name) metadata.name = rec.data.name; // deprecated field kept by Discord
    const msgType = followup ? MessageType.DEFAULT
      : rec.type === IT.APPLICATION_COMMAND ? (rec.data.type === 1 ? MessageType.CHAT_INPUT_COMMAND : MessageType.CONTEXT_MENU_COMMAND)
        : MessageType.DEFAULT;
    let flags = (body.flags ?? 0) & (MessageFlags.SUPPRESS_EMBEDS | MessageFlags.SUPPRESS_NOTIFICATIONS | MessageFlags.IS_COMPONENTS_V2);
    if (ephemeral) flags |= MessageFlags.EPHEMERAL;
    if (loading) flags |= MessageFlags.LOADING;
    const hasContent = loading || (body.content ?? '') !== '' || body.embeds?.length || body.components?.length || files?.length || body.poll;
    if (!hasContent) throw Errors.emptyMessage();

    let json;
    if (ephemeral || !w.channel(rec.channel_id)) {
      const id = w.id();
      const attachments = this.server.storeUploads(rec.channel_id, files, body.attachments).map((aid) => w.attachmentJSON(w.state.attachments[aid]));
      json = {
        type: msgType, channel_id: rec.channel_id, content: body.content ?? '', attachments,
        embeds: deepClone(body.embeds ?? []), timestamp: w.iso(), edited_timestamp: null, flags,
        components: deepClone(body.components ?? []), id, author: w.userJSON(app.bot_user_id),
        mentions: [], mention_roles: [], mention_everyone: false, pinned: false, tts: false,
        application_id: app.id, webhook_id: app.id, interaction_metadata: metadata,
      };
      rec.messages.push(json);
    } else {
      const channel = w.channel(rec.channel_id);
      const msgCtx = { ...ctx, actorId: app.bot_user_id, actor: { kind: 'bot', app, userId: app.bot_user_id }, world: w, ops: this.ops, server: this.server, perms: () => 0n };
      const msg = createMessageFromBody(msgCtx, channel, { ...body, flags }, files, {
        skipPermissionChecks: true, authorId: app.bot_user_id, applicationId: app.id, webhookId: app.id,
        interactionMetadata: metadata, type: msgType, rawFlags: flags, allowEmpty: loading,
      });
      json = w.messageJSON(msg);
    }
    if (original) {
      rec.original_message_id = json.id;
      rec.ephemeral = ephemeral;
    }
    (rec.response_message_ids ??= []).push(json.id);
    rec.view.push({ at: w.iso(), kind: loading ? 'thinking' : followup ? 'followup' : 'message', ephemeral, message: deepClone(json) });
    return json;
  }

  editResponse(ctx, rec, messageId, body, files, { component = false } = {}) {
    const w = this.world;
    const eph = rec.messages.find((m) => m.id === messageId) ?? this.findEphemeralAnywhere(messageId);
    let json;
    if (eph) {
      if (body.content !== undefined) eph.content = body.content ?? '';
      if (body.embeds !== undefined) eph.embeds = deepClone(body.embeds ?? []);
      if (body.components !== undefined) eph.components = deepClone(body.components ?? []);
      if (body.attachments !== undefined || files?.length) {
        const keep = (body.attachments ?? []).filter((a) => eph.attachments.some((x) => x.id === String(a.id))).map((a) => String(a.id));
        const kept = eph.attachments.filter((a) => keep.includes(a.id));
        eph.attachments = [...kept, ...this.server.storeUploads(rec.channel_id, files, body.attachments).map((aid) => w.attachmentJSON(w.state.attachments[aid]))];
      }
      eph.flags &= ~MessageFlags.LOADING;
      eph.edited_timestamp = w.iso();
      json = deepClone(eph);
    } else {
      const m = w.message(rec.channel_id, messageId) ?? (component && rec.source_message && w.message(rec.source_message.channel_id, messageId));
      if (!m) throw Errors.unknownMessage();
      const patch = {};
      if (body.content !== undefined) patch.content = body.content ?? '';
      if (body.embeds !== undefined) patch.embeds = body.embeds ?? [];
      if (body.components !== undefined) patch.components = body.components ?? [];
      if (body.attachments !== undefined || files?.length) {
        const keep = (body.attachments ?? []).filter((a) => a.id && m.attachments.includes(String(a.id))).map((a) => String(a.id));
        patch.attachments = [...keep, ...this.server.storeUploads(m.channel_id, files, body.attachments)];
      }
      patch.flags = (m.flags ?? 0) & ~MessageFlags.LOADING;
      this.ops.editMessage(m.channel_id, m.id, patch);
      json = w.messageJSON(m);
    }
    if (!(rec.response_message_ids ?? []).includes(json.id)) (rec.response_message_ids ??= []).push(json.id);
    rec.view.push({ at: w.iso(), kind: component ? 'update' : 'edit', message: deepClone(json) });
    return json;
  }

  findEphemeralAnywhere(messageId) {
    for (const rec of Object.values(this.world.state.interactions)) {
      const m = rec.messages.find((x) => x.id === messageId);
      if (m) return m;
    }
    return null;
  }

  expire(id) {
    const rec = this.byId(id);
    if (!rec) throw new Error(`unknown interaction ${id}`);
    rec.forced_expired = true;
    rec.view.push({ at: this.world.iso(), kind: 'token_expired' });
  }
}

function addResolvedUser(w, resolved, userId, guildId) {
  const u = w.userJSON(userId);
  if (!u) return;
  (resolved.users ??= {})[userId] = u;
  if (guildId && w.member(guildId, userId)) {
    (resolved.members ??= {})[userId] = { ...w.memberJSON(guildId, userId, { withUser: false }), permissions: computePermissions(w, guildId, userId).toString() };
  }
}

export function flattenComponents(list) {
  const out = [];
  for (const c of list ?? []) {
    out.push(c);
    if (c.components) out.push(...flattenComponents(c.components));
    if (c.component) out.push(...flattenComponents([c.component]));
    if (c.accessory) out.push(...flattenComponents([c.accessory]));
  }
  return out;
}

function findComponent(components, customId) {
  return flattenComponents(components).find((c) => c.custom_id === customId);
}

export { DiscordError };
