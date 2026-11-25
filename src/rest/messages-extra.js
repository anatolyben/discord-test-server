// Reactions, pins and crossposting – https://discord.com/developers/docs/resources/message
import { Errors, assertValid, DiscordError } from '../errors.js';
import { ChannelType, Permissions as P, MessageType, MessageFlags } from '../constants.js';
import { compareIds } from '../util.js';

const DOCS = 'https://discord.com/developers/docs';
const MAX_REACTIONS = 20; // ${DOCS}/topics/opcodes-and-status-codes – 30010
const MAX_PINS = 250; // ${DOCS}/topics/opcodes-and-status-codes – 30003 ("Maximum number of pins reached for the channel (250)")
const PINNABLE_TYPES = new Set([MessageType.DEFAULT, MessageType.REPLY, MessageType.CHAT_INPUT_COMMAND, MessageType.CONTEXT_MENU_COMMAND]);

/**
 * Parses the :emoji path segment (already percent-decoded by the router): a unicode emoji, or `name:id` for a custom one.
 * ASSUMPTION: Discord does not publish its list of unicode emoji; any string with a non-ASCII character counts as one
 * (plus the digits, `#` and `*` that start keycap sequences). Anything else answers 404/10014.
 */
export function parseEmoji(world, raw) {
  const custom = /^(?:a:)?([\w]{1,32}):(\d{15,25})$/.exec(raw ?? '');
  if (custom) {
    const e = world.findEmoji(custom[2]);
    if (!e) throw Errors.unknownEmoji();
    return { id: e.id, name: e.name, animated: !!e.animated };
  }
  if (!raw || !/[^\x00-\x7f]/.test(raw)) {
    if (!/^[0-9#*]$/.test(raw ?? '')) throw Errors.unknownEmoji();
  }
  return { id: null, name: raw };
}

export function registerMessageExtras(r) {
  const reactionRoute = '/channels/:channel_id/messages/:message_id/reactions';

  // ${DOCS}/resources/message#create-reaction – READ_MESSAGE_HISTORY, plus ADD_REACTIONS if nobody used the emoji yet.
  r.add('PUT', `${reactionRoute}/:emoji/@me`, (ctx) => {
    const c = ctx.channel();
    const m = ctx.message(c.id, ctx.params.message_id);
    const emoji = parseEmoji(ctx.world, ctx.params.emoji);
    if (c.guild_id) {
      ctx.require(c.guild_id, c.id, P.READ_MESSAGE_HISTORY);
      const key = emoji.id ?? emoji.name;
      const existing = m.reactions?.find((x) => (x.emoji.id ?? x.emoji.name) === key);
      if (!existing) {
        ctx.require(c.guild_id, c.id, P.ADD_REACTIONS);
        if ((m.reactions?.length ?? 0) >= MAX_REACTIONS) throw Errors.maxReactions();
      }
    } else if ((m.reactions?.length ?? 0) >= MAX_REACTIONS && !m.reactions.some((x) => (x.emoji.id ?? x.emoji.name) === (emoji.id ?? emoji.name))) throw Errors.maxReactions();
    ctx.ops.addReaction(c.id, m.id, ctx.actorId, emoji);
    return ctx.noContent();
  });

  // ${DOCS}/resources/message#delete-own-reaction
  r.add('DELETE', `${reactionRoute}/:emoji/@me`, (ctx) => {
    const c = ctx.channel();
    const m = ctx.message(c.id, ctx.params.message_id);
    const emoji = parseEmoji(ctx.world, ctx.params.emoji);
    // ASSUMPTION: removing a reaction that is not there answers 404/10014 Unknown Emoji.
    if (!ctx.ops.removeReaction(c.id, m.id, ctx.actorId, emoji)) throw Errors.unknownEmoji();
    return ctx.noContent();
  });

  // ${DOCS}/resources/message#delete-user-reaction – MANAGE_MESSAGES
  r.add('DELETE', `${reactionRoute}/:emoji/:user_id`, (ctx) => {
    const c = ctx.channel();
    const m = ctx.message(c.id, ctx.params.message_id);
    const emoji = parseEmoji(ctx.world, ctx.params.emoji);
    if (c.guild_id) ctx.require(c.guild_id, c.id, P.MANAGE_MESSAGES);
    else if (ctx.params.user_id !== ctx.actorId) throw Errors.cannotExecuteOnDM();
    if (!ctx.ops.removeReaction(c.id, m.id, ctx.params.user_id, emoji)) throw Errors.unknownEmoji();
    return ctx.noContent();
  });

  // ${DOCS}/resources/message#get-reactions – users in id order; type 0, after, limit 1-100 (25)
  r.add('GET', `${reactionRoute}/:emoji`, (ctx) => {
    const c = ctx.channel();
    const m = ctx.message(c.id, ctx.params.message_id);
    const emoji = parseEmoji(ctx.world, ctx.params.emoji);
    assertValid(ctx.query, { limit: { type: 'int', min: 1, max: 100 }, after: { type: 'snowflake' }, type: { type: 'int', choices: [0, 1] } });
    if (c.guild_id) ctx.require(c.guild_id, c.id, P.READ_MESSAGE_HISTORY);
    const key = emoji.id ?? emoji.name;
    const rx = m.reactions?.find((x) => (x.emoji.id ?? x.emoji.name) === key);
    let users = Number(ctx.query.type ?? 0) === 1 || !rx ? [] : [...rx.users].sort(compareIds);
    if (ctx.query.after) users = users.filter((u) => compareIds(u, ctx.query.after) > 0);
    return ctx.ok(users.slice(0, Number(ctx.query.limit ?? 25)).map((id) => ctx.world.userJSON(id)));
  });

  // ${DOCS}/resources/message#delete-all-reactions – MANAGE_MESSAGES
  r.add('DELETE', reactionRoute, (ctx) => {
    const c = ctx.channel();
    const m = ctx.message(c.id, ctx.params.message_id);
    if (c.guild_id) ctx.require(c.guild_id, c.id, P.MANAGE_MESSAGES);
    else throw Errors.cannotExecuteOnDM();
    ctx.ops.removeAllReactions(c.id, m.id);
    return ctx.noContent();
  });

  // ${DOCS}/resources/message#delete-all-reactions-for-emoji – MANAGE_MESSAGES
  r.add('DELETE', `${reactionRoute}/:emoji`, (ctx) => {
    const c = ctx.channel();
    const m = ctx.message(c.id, ctx.params.message_id);
    const emoji = parseEmoji(ctx.world, ctx.params.emoji);
    if (c.guild_id) ctx.require(c.guild_id, c.id, P.MANAGE_MESSAGES);
    else throw Errors.cannotExecuteOnDM();
    // ASSUMPTION: no reactions with that emoji -> 404/10014, as for the single-user routes.
    if (!ctx.ops.removeEmojiReactions(c.id, m.id, emoji)) throw Errors.unknownEmoji();
    return ctx.noContent();
  });

  // ---------------------------------------------------------------------------
  // Pins
  // ---------------------------------------------------------------------------
  const requirePinRights = (ctx, c) => {
    if (c.guild_id) ctx.require(c.guild_id, c.id, P.PIN_MESSAGES);
  };
  const pin = (ctx) => {
    const c = ctx.channel();
    requirePinRights(ctx, c);
    const m = ctx.message(c.id, ctx.params.message_id);
    if (!PINNABLE_TYPES.has(m.type)) throw Errors.systemMessage();
    // ASSUMPTION: pinning an already pinned message answers 204 and changes nothing.
    if (!m.pinned && ctx.ops.pinnedMessages(c.id).length >= MAX_PINS) throw Errors.maxPins();
    ctx.ops.pinMessage(c.id, m.id, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.noContent();
  };
  const unpin = (ctx) => {
    const c = ctx.channel();
    requirePinRights(ctx, c);
    const m = ctx.message(c.id, ctx.params.message_id);
    ctx.ops.unpinMessage(c.id, m.id, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.noContent();
  };
  // ${DOCS}/resources/message#pin-message, #unpin-message (and the deprecated /pins/ forms)
  r.add('PUT', '/channels/:channel_id/messages/pins/:message_id', pin, { audit: true });
  r.add('DELETE', '/channels/:channel_id/messages/pins/:message_id', unpin, { audit: true });
  r.add('PUT', '/channels/:channel_id/pins/:message_id', pin, { audit: true });
  r.add('DELETE', '/channels/:channel_id/pins/:message_id', unpin, { audit: true });

  // ${DOCS}/resources/message#get-channel-pins – VIEW_CHANNEL; without READ_MESSAGE_HISTORY nothing is returned.
  const visiblePins = (ctx, c) => {
    if (c.guild_id && !(ctx.perms(c.guild_id, c.id) & P.READ_MESSAGE_HISTORY)) return [];
    return ctx.ops.pinnedMessages(c.id);
  };
  r.add('GET', '/channels/:channel_id/messages/pins', (ctx) => {
    const c = ctx.channel();
    assertValid(ctx.query, { limit: { type: 'int', min: 1, max: 50 } });
    let pins = visiblePins(ctx, c);
    if (ctx.query.before !== undefined) {
      const before = Date.parse(ctx.query.before);
      if (Number.isNaN(before)) throw new DiscordError(400, 50035, 'Invalid Form Body', { before: { _errors: [{ code: 'DATE_TIME_TYPE_CONVERT', message: 'Could not parse a date-time.' }] } });
      pins = pins.filter((m) => m.pinned_at < before);
    }
    const limit = Number(ctx.query.limit ?? 50);
    const items = pins.slice(0, limit).map((m) => ({ pinned_at: ctx.world.iso(m.pinned_at), message: ctx.server.messageForApp(m, ctx) }));
    return ctx.ok({ items, has_more: pins.length > limit });
  });
  r.add('GET', '/channels/:channel_id/pins', (ctx) => {
    const c = ctx.channel();
    return ctx.ok(visiblePins(ctx, c).slice(0, 50).map((m) => ctx.server.messageForApp(m, ctx)));
  });

  // ---------------------------------------------------------------------------
  // Crosspost – ${DOCS}/resources/message#crosspost-message
  // ---------------------------------------------------------------------------
  r.add('POST', '/channels/:channel_id/messages/:message_id/crosspost', (ctx) => {
    const c = ctx.channel();
    if (c.type !== ChannelType.GUILD_ANNOUNCEMENT) throw Errors.channelType();
    const m = ctx.message(c.id, ctx.params.message_id);
    ctx.require(c.guild_id, c.id, P.SEND_MESSAGES);
    if (m.author_id !== ctx.actorId) ctx.require(c.guild_id, c.id, P.MANAGE_MESSAGES);
    // ASSUMPTION: an already crossposted message answers 400/40033 "This message has already been crossposted".
    if (m.flags & MessageFlags.CROSSPOSTED) throw new DiscordError(400, 40033, 'This message has already been crossposted');
    ctx.ops.crosspostMessage(c.id, m.id);
    return ctx.ok(ctx.server.messageForApp(m, ctx));
  });
}
