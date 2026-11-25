// Webhooks – https://discord.com/developers/docs/resources/webhook
import { Errors, assertValid, formError } from '../errors.js';
import { ChannelType, Permissions as P, THREAD_TYPES, MessageFlags } from '../constants.js';
import { isSnowflake } from '../util.js';
import { messageBodySchema, createMessageFromBody } from './channels.js';
import { parseImageData } from './expressions.js';

const DOCS = 'https://discord.com/developers/docs';
const MAX_PER_CHANNEL = 15; // ${DOCS}/topics/opcodes-and-status-codes – 30007
const WEBHOOK_CHANNEL_TYPES = new Set([ChannelType.GUILD_TEXT, ChannelType.GUILD_VOICE, ChannelType.GUILD_ANNOUNCEMENT, ChannelType.GUILD_STAGE_VOICE, ChannelType.GUILD_FORUM, ChannelType.GUILD_MEDIA]);

export function registerWebhookRoutes(r) {
  const known = (ctx) => (isSnowflake(ctx.params.webhook_id) ? ctx.world.state.webhooks[ctx.params.webhook_id] : undefined);
  /** Webhook addressed by id + token (no authorization). */
  const byToken = (ctx) => {
    const wh = known(ctx);
    if (!wh) throw Errors.unknownWebhook();
    if (wh.token !== ctx.params.webhook_token) throw Errors.invalidWebhookToken();
    return wh;
  };
  /** Webhook addressed by id with a bot token: MANAGE_WEBHOOKS in its channel. */
  const byId = (ctx) => {
    const wh = known(ctx);
    if (!wh) throw Errors.unknownWebhook();
    ctx.guild(wh.guild_id);
    ctx.require(wh.guild_id, wh.channel_id, P.MANAGE_WEBHOOKS);
    return wh;
  };
  const webhookChannel = (ctx) => {
    const c = ctx.channel();
    if (!WEBHOOK_CHANNEL_TYPES.has(c.type)) throw Errors.channelType();
    return c;
  };
  /** Interaction webhooks use the same URL shape: ids that are not webhooks fall through to them. */
  const interactionRoute = (method, template, handler, meta = { auth: 'none', global: false }) => {
    const self = (ctx) => {
      if (!known(ctx)) {
        const other = r.routes.find((x) => x.method === method && x.template === template && x.handler !== self);
        if (!other) throw Errors.unknownWebhook();
        return other.handler(ctx);
      }
      return handler(ctx);
    };
    r.add(method, template, self, meta);
  };

  // ${DOCS}/resources/webhook#create-webhook – MANAGE_WEBHOOKS; name 1-80 characters
  r.add('POST', '/channels/:channel_id/webhooks', (ctx) => {
    const c = webhookChannel(ctx);
    assertValid(ctx.body, { name: { type: 'string', required: true, minLength: 1, maxLength: 80 }, avatar: { type: 'string', nullable: true } });
    ctx.require(c.guild_id, c.id, P.MANAGE_WEBHOOKS);
    if (ctx.body.avatar) parseImageData(ctx.body.avatar);
    if (Object.values(ctx.world.state.webhooks).filter((x) => x.channel_id === c.id).length >= MAX_PER_CHANNEL) throw Errors.maxWebhooks();
    const wh = ctx.ops.createWebhook(c.id, { name: ctx.body.name, avatar: ctx.body.avatar ?? null }, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.ok(ctx.world.webhookJSON(wh));
  }, { audit: true });

  // ${DOCS}/resources/webhook#get-channel-webhooks, #get-guild-webhooks
  r.add('GET', '/channels/:channel_id/webhooks', (ctx) => {
    const c = webhookChannel(ctx);
    ctx.require(c.guild_id, c.id, P.MANAGE_WEBHOOKS);
    return ctx.ok(Object.values(ctx.world.state.webhooks).filter((x) => x.channel_id === c.id).map((x) => ctx.world.webhookJSON(x)));
  });
  r.add('GET', '/guilds/:guild_id/webhooks', (ctx) => {
    const g = ctx.guild();
    ctx.require(g.id, undefined, P.MANAGE_WEBHOOKS);
    return ctx.ok(Object.values(ctx.world.state.webhooks).filter((x) => x.guild_id === g.id).map((x) => ctx.world.webhookJSON(x)));
  });

  // ${DOCS}/resources/webhook#get-webhook, #get-webhook-with-token
  r.add('GET', '/webhooks/:webhook_id', (ctx) => ctx.ok(ctx.world.webhookJSON(byId(ctx))));
  r.add('GET', '/webhooks/:webhook_id/:webhook_token', (ctx) => ctx.ok(ctx.world.webhookJSON(byToken(ctx), { withUser: false })), { auth: 'none', global: false });

  // ${DOCS}/resources/webhook#modify-webhook, #modify-webhook-with-token ("does not accept a channel_id parameter")
  const patchSchema = { name: { type: 'string', minLength: 1, maxLength: 80 }, avatar: { type: 'string', nullable: true }, channel_id: { type: 'snowflake', nullable: true } };
  r.add('PATCH', '/webhooks/:webhook_id', (ctx) => {
    const wh = byId(ctx);
    assertValid(ctx.body, patchSchema);
    const patch = { ...ctx.body };
    if (patch.channel_id) {
      const target = ctx.channel(patch.channel_id);
      if (target.guild_id !== wh.guild_id || !WEBHOOK_CHANNEL_TYPES.has(target.type)) throw Errors.channelType();
      ctx.require(wh.guild_id, target.id, P.MANAGE_WEBHOOKS);
    }
    if (patch.avatar) parseImageData(patch.avatar);
    return ctx.ok(ctx.world.webhookJSON(ctx.ops.updateWebhook(wh.id, patch, { actorId: ctx.actorId, reason: ctx.reason })));
  }, { audit: true });
  r.add('PATCH', '/webhooks/:webhook_id/:webhook_token', (ctx) => {
    const wh = byToken(ctx);
    assertValid(ctx.body, patchSchema);
    const { channel_id: _ignored, ...patch } = ctx.body;
    if (patch.avatar) parseImageData(patch.avatar);
    return ctx.ok(ctx.world.webhookJSON(ctx.ops.updateWebhook(wh.id, patch, {}), { withUser: false }));
  }, { auth: 'none', global: false });

  // ${DOCS}/resources/webhook#delete-webhook, #delete-webhook-with-token
  r.add('DELETE', '/webhooks/:webhook_id', (ctx) => {
    const wh = byId(ctx);
    ctx.ops.deleteWebhook(wh.id, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.noContent();
  }, { audit: true });
  interactionRoute('DELETE', '/webhooks/:webhook_id/:webhook_token', (ctx) => {
    const wh = byToken(ctx);
    ctx.ops.deleteWebhook(wh.id, {});
    return ctx.noContent();
  });

  // ${DOCS}/resources/webhook#execute-webhook – no authorization; ?wait, ?thread_id, ?with_components
  interactionRoute('POST', '/webhooks/:webhook_id/:webhook_token', (ctx) => {
    const wh = byToken(ctx);
    assertValid(ctx.body, { ...messageBodySchema, username: { type: 'string', minLength: 1, maxLength: 80 }, avatar_url: { type: 'string' }, thread_name: { type: 'string', maxLength: 100 } });
    let c = ctx.world.channel(wh.channel_id);
    if (ctx.query.thread_id !== undefined) {
      const t = isSnowflake(ctx.query.thread_id) && ctx.world.channel(ctx.query.thread_id);
      if (!t || !THREAD_TYPES.has(t.type) || t.parent_id !== wh.channel_id) throw Errors.unknownChannel();
      c = t;
      // "The thread will automatically be unarchived."
      if (t.thread_metadata?.archived) t.thread_metadata.archived = false;
    } else if (c.type === ChannelType.GUILD_FORUM || c.type === ChannelType.GUILD_MEDIA) {
      throw formError('thread_name', 'BASE_TYPE_REQUIRED', 'Webhooks can only create threads in forum channels'); // ASSUMPTION: forum posts through webhooks are not modelled
    }
    const body = { ...ctx.body };
    // "Non-application-owned webhooks cannot send interactive components, and the components field will be ignored unless they set with_components."
    if (ctx.query.with_components !== 'true') delete body.components;
    const msg = createMessageFromBody(ctx, c, body, ctx.files, { skipPermissionChecks: true, authorId: wh.id, webhookId: wh.id, webhookUsername: body.username });
    if (ctx.query.wait === 'true') return ctx.ok(ctx.world.messageJSON(msg));
    return ctx.noContent();
  });

  // ${DOCS}/resources/webhook#get-webhook-message, #edit-webhook-message, #delete-webhook-message – only the webhook's own messages
  const ownMessage = (ctx, wh) => {
    const channelId = ctx.query.thread_id ?? wh.channel_id;
    const m = isSnowflake(ctx.params.message_id) && ctx.world.message(channelId, ctx.params.message_id);
    if (!m || m.webhook_id !== wh.id) throw Errors.unknownMessage();
    return m;
  };
  interactionRoute('GET', '/webhooks/:webhook_id/:webhook_token/messages/:message_id', (ctx) => {
    const wh = byToken(ctx);
    return ctx.ok(ctx.world.messageJSON(ownMessage(ctx, wh)));
  });
  interactionRoute('PATCH', '/webhooks/:webhook_id/:webhook_token/messages/:message_id', (ctx) => {
    const wh = byToken(ctx);
    assertValid(ctx.body, { ...messageBodySchema, message_reference: { type: 'any' } });
    const m = ownMessage(ctx, wh);
    const patch = {};
    if (ctx.body.content !== undefined) patch.content = ctx.body.content ?? '';
    if (ctx.body.embeds !== undefined) patch.embeds = ctx.body.embeds ?? [];
    if (ctx.body.flags !== undefined && ctx.body.flags !== null) patch.flags = (m.flags & ~MessageFlags.SUPPRESS_EMBEDS) | (ctx.body.flags & MessageFlags.SUPPRESS_EMBEDS);
    if (ctx.body.attachments !== undefined || ctx.files?.length) {
      const keep = (ctx.body.attachments ?? []).filter((a) => a.id && m.attachments.includes(String(a.id))).map((a) => String(a.id));
      patch.attachments = [...keep, ...ctx.server.storeUploads(m.channel_id, ctx.files, ctx.body.attachments)];
    }
    ctx.ops.editMessage(m.channel_id, m.id, patch);
    return ctx.ok(ctx.world.messageJSON(m));
  });
  interactionRoute('DELETE', '/webhooks/:webhook_id/:webhook_token/messages/:message_id', (ctx) => {
    const wh = byToken(ctx);
    const m = ownMessage(ctx, wh);
    ctx.ops.deleteMessage(m.channel_id, m.id, {});
    return ctx.noContent();
  });
}
