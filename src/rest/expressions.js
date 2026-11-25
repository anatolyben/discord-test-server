// Guild emoji and stickers – https://discord.com/developers/docs/resources/emoji, /resources/sticker
import { Errors, assertValid, formError } from '../errors.js';
import { Permissions as P } from '../constants.js';
import { isSnowflake } from '../util.js';

const DOCS = 'https://discord.com/developers/docs';
const MAX_EMOJI_BYTES = 256 * 1024; // ${DOCS}/resources/emoji#create-guild-emoji
const MAX_STICKER_BYTES = 512 * 1024; // ${DOCS}/resources/sticker#create-guild-sticker
// ASSUMPTION: slots follow the guild's premium_tier (0: 50 static + 50 animated emoji and 5 stickers; 1: 100/100/15;
// 2: 150/150/30; 3: 250/250/60). A guild is at tier 0 unless its `premium_tier` is set.
const EMOJI_SLOTS = [50, 100, 150, 250];
const STICKER_SLOTS = [5, 15, 30, 60];
const IMAGE_RE = /^data:image\/(png|jpeg|jpg|gif|webp|avif);base64,([A-Za-z0-9+/=]+)$/;
const STICKER_FORMATS = { 'image/png': 1, 'image/apng': 2, 'application/json': 3, 'image/gif': 4 };

export function parseImageData(data, maxBytes = MAX_EMOJI_BYTES) {
  const m = IMAGE_RE.exec(data ?? '');
  if (!m) throw formError('image', 'IMAGE_INVALID', 'Invalid image data');
  if (Buffer.from(m[2], 'base64').length > maxBytes) throw formError('image', 'BASE_TYPE_MAX_LENGTH', 'File cannot be larger than 256.0 kb.');
  return { animated: m[1] === 'gif' };
}

export function registerExpressionRoutes(r) {
  const canCreate = (ctx, g) => ctx.requireAny(g.id, undefined, P.CREATE_GUILD_EXPRESSIONS, P.MANAGE_GUILD_EXPRESSIONS);
  const canManageOthers = (ctx, g, createdBy) => {
    if (createdBy === ctx.actorId) ctx.requireAny(g.id, undefined, P.CREATE_GUILD_EXPRESSIONS, P.MANAGE_GUILD_EXPRESSIONS);
    else ctx.require(g.id, undefined, P.MANAGE_GUILD_EXPRESSIONS);
  };
  const seesUser = (ctx, g) => !!ctx.actorId && !!(ctx.perms(g.id) & (P.CREATE_GUILD_EXPRESSIONS | P.MANAGE_GUILD_EXPRESSIONS));
  const emojiOf = (ctx, g) => {
    const e = isSnowflake(ctx.params.emoji_id) && g.emojis?.[ctx.params.emoji_id];
    if (!e) throw Errors.unknownEmoji();
    return e;
  };

  // ${DOCS}/resources/emoji#list-guild-emojis
  r.add('GET', '/guilds/:guild_id/emojis', (ctx) => {
    const g = ctx.guild();
    const withUser = seesUser(ctx, g);
    return ctx.ok(Object.values(g.emojis ?? {}).map((e) => ctx.world.emojiJSON(e, { withUser })));
  });
  r.add('GET', '/guilds/:guild_id/emojis/:emoji_id', (ctx) => {
    const g = ctx.guild();
    const e = emojiOf(ctx, g);
    return ctx.ok(ctx.world.emojiJSON(e, { withUser: seesUser(ctx, g) || e.user_id === ctx.actorId }));
  });

  // ${DOCS}/resources/emoji#create-guild-emoji – CREATE_GUILD_EXPRESSIONS, 256 KiB
  r.add('POST', '/guilds/:guild_id/emojis', (ctx) => {
    const g = ctx.guild();
    assertValid(ctx.body, { name: { type: 'string', required: true, minLength: 2, maxLength: 32 }, image: { type: 'string', required: true }, roles: { type: 'array', items: { type: 'snowflake' } } });
    if (!/^\w+$/.test(ctx.body.name)) throw formError('name', 'STRING_TYPE_REGEX', 'String value did not match validation regex.');
    canCreate(ctx, g);
    const { animated } = parseImageData(ctx.body.image);
    const slots = EMOJI_SLOTS[g.premium_tier ?? 0] ?? EMOJI_SLOTS[0];
    const existing = Object.values(g.emojis ?? {}).filter((e) => !!e.animated === animated).length;
    if (existing >= slots) throw animated ? Errors.maxAnimatedEmojis() : Errors.maxEmojis();
    const e = ctx.ops.createEmoji(g.id, { name: ctx.body.name, image: ctx.body.image, roles: ctx.body.roles ?? [], animated }, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.ok(ctx.world.emojiJSON(e, { withUser: true }), 201);
  }, { audit: true });

  // ${DOCS}/resources/emoji#modify-guild-emoji
  r.add('PATCH', '/guilds/:guild_id/emojis/:emoji_id', (ctx) => {
    const g = ctx.guild();
    assertValid(ctx.body, { name: { type: 'string', minLength: 2, maxLength: 32 }, roles: { type: 'array', nullable: true, items: { type: 'snowflake' } } });
    const e = emojiOf(ctx, g);
    canManageOthers(ctx, g, e.user_id);
    ctx.ops.updateEmoji(g.id, e.id, ctx.body, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.ok(ctx.world.emojiJSON(e, { withUser: true }));
  }, { audit: true });

  // ${DOCS}/resources/emoji#delete-guild-emoji
  r.add('DELETE', '/guilds/:guild_id/emojis/:emoji_id', (ctx) => {
    const g = ctx.guild();
    const e = emojiOf(ctx, g);
    canManageOthers(ctx, g, e.user_id);
    ctx.ops.deleteEmoji(g.id, e.id, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.noContent();
  }, { audit: true });

  // ---------------------------------------------------------------------------
  // Stickers
  // ---------------------------------------------------------------------------
  const stickerOf = (ctx, g) => {
    const s = isSnowflake(ctx.params.sticker_id) && g.stickers?.[ctx.params.sticker_id];
    if (!s) throw Errors.unknownSticker();
    return s;
  };
  r.add('GET', '/guilds/:guild_id/stickers', (ctx) => {
    const g = ctx.guild();
    const withUser = seesUser(ctx, g);
    return ctx.ok(Object.values(g.stickers ?? {}).map((s) => ctx.world.stickerJSON(s, { withUser })));
  });
  r.add('GET', '/guilds/:guild_id/stickers/:sticker_id', (ctx) => {
    const g = ctx.guild();
    const s = stickerOf(ctx, g);
    return ctx.ok(ctx.world.stickerJSON(s, { withUser: seesUser(ctx, g) || s.user_id === ctx.actorId }));
  });
  // ${DOCS}/resources/sticker#get-sticker
  r.add('GET', '/stickers/:sticker_id', (ctx) => {
    const s = isSnowflake(ctx.params.sticker_id) && Object.values(ctx.world.state.guilds).map((g) => g.stickers?.[ctx.params.sticker_id]).find(Boolean);
    if (!s) throw Errors.unknownSticker();
    return ctx.ok(ctx.world.stickerJSON(s, { withUser: false }));
  });
  // ${DOCS}/resources/sticker#list-sticker-packs – ASSUMPTION: the fake ships no standard sticker packs.
  r.add('GET', '/sticker-packs', (ctx) => ctx.ok({ sticker_packs: [] }));

  // ${DOCS}/resources/sticker#create-guild-sticker – multipart: name 2-30, description empty or 2-100, tags <=200, file <=512 KiB
  r.add('POST', '/guilds/:guild_id/stickers', (ctx) => {
    const g = ctx.guild();
    assertValid(ctx.body, {
      name: { type: 'string', required: true, minLength: 2, maxLength: 30 },
      description: { type: 'string', maxLength: 100, nullable: true },
      tags: { type: 'string', required: true, maxLength: 200 },
    });
    if (ctx.body.description && ctx.body.description.length < 2) throw formError('description', 'BASE_TYPE_BAD_LENGTH', 'Must be between 2 and 100 in length.');
    canCreate(ctx, g);
    const file = ctx.files?.[0];
    if (!file) throw formError('file', 'BASE_TYPE_REQUIRED', 'This field is required');
    const format = STICKER_FORMATS[(file.contentType ?? '').split(';')[0].trim().toLowerCase()];
    if (!format) throw formError('file', 'INVALID_FILE', 'Invalid file uploaded');
    if (file.data.length > MAX_STICKER_BYTES) throw formError('file', 'BASE_TYPE_MAX_LENGTH', 'File cannot be larger than 512.0 kb.');
    if (Object.keys(g.stickers ?? {}).length >= (STICKER_SLOTS[g.premium_tier ?? 0] ?? STICKER_SLOTS[0])) throw Errors.maxStickers();
    const s = ctx.ops.createSticker(g.id, {
      name: ctx.body.name, description: ctx.body.description, tags: ctx.body.tags, format_type: format,
      data: file.data.toString('base64'), contentType: file.contentType,
    }, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.ok(ctx.world.stickerJSON(s), 201);
  }, { audit: true });

  // ${DOCS}/resources/sticker#modify-guild-sticker
  r.add('PATCH', '/guilds/:guild_id/stickers/:sticker_id', (ctx) => {
    const g = ctx.guild();
    assertValid(ctx.body, { name: { type: 'string', minLength: 2, maxLength: 30 }, description: { type: 'string', maxLength: 100, nullable: true }, tags: { type: 'string', maxLength: 200 } });
    const s = stickerOf(ctx, g);
    canManageOthers(ctx, g, s.user_id);
    ctx.ops.updateSticker(g.id, s.id, ctx.body, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.ok(ctx.world.stickerJSON(s));
  }, { audit: true });

  // ${DOCS}/resources/sticker#delete-guild-sticker
  r.add('DELETE', '/guilds/:guild_id/stickers/:sticker_id', (ctx) => {
    const g = ctx.guild();
    const s = stickerOf(ctx, g);
    canManageOthers(ctx, g, s.user_id);
    ctx.ops.deleteSticker(g.id, s.id, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.noContent();
  }, { audit: true });
}
