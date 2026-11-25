// Threads, forum posts and thread members – https://discord.com/developers/docs/resources/channel#start-thread-from-message
import { Errors, DiscordError, assertValid, formError } from '../errors.js';
import { ChannelType, Permissions as P, THREAD_TYPES, MessageFlags } from '../constants.js';
import { isSnowflake, compareIds } from '../util.js';
import { createMessageFromBody } from './channels.js';

const DOCS = 'https://discord.com/developers/docs';
const MAX_PARTICIPANTS = 1000; // 30033
const AUTO_ARCHIVE = [60, 1440, 4320, 10080];

export function registerThreadRoutes(r) {
  const threadChannel = (ctx) => {
    const c = ctx.channel();
    if (!THREAD_TYPES.has(c.type)) throw Errors.channelType();
    return c;
  };
  const unarchived = (c) => { if (c.thread_metadata?.archived) throw Errors.threadArchived(); };
  const nameSchema = { type: 'string', required: true, minLength: 1, maxLength: 100 };

  // ${DOCS}/resources/channel#start-thread-from-message – the thread gets the message's id
  r.add('POST', '/channels/:channel_id/messages/:message_id/threads', (ctx) => {
    const c = ctx.channel();
    assertValid(ctx.body, { name: nameSchema, auto_archive_duration: { type: 'int', choices: AUTO_ARCHIVE }, rate_limit_per_user: { type: 'int', min: 0, max: 21600, nullable: true } });
    if (c.type !== ChannelType.GUILD_TEXT && c.type !== ChannelType.GUILD_ANNOUNCEMENT) throw Errors.channelType();
    const m = ctx.message(c.id, ctx.params.message_id);
    ctx.require(c.guild_id, c.id, P.CREATE_PUBLIC_THREADS);
    if (m.thread_id || ctx.world.channel(m.id)) throw new DiscordError(400, 160004, 'A thread has already been created for this message');
    const type = c.type === ChannelType.GUILD_ANNOUNCEMENT ? ChannelType.ANNOUNCEMENT_THREAD : ChannelType.PUBLIC_THREAD;
    const t = ctx.ops.createChannel(c.guild_id, { id: m.id, name: ctx.body.name, type, parent_id: c.id, owner_id: ctx.actorId, auto_archive_duration: ctx.body.auto_archive_duration, rate_limit_per_user: ctx.body.rate_limit_per_user ?? 0 }, { actorId: ctx.actorId, reason: ctx.reason });
    m.thread_id = t.id;
    m.flags = (m.flags ?? 0) | MessageFlags.HAS_THREAD;
    ctx.ops.dispatchMessage('MESSAGE_UPDATE', m);
    return ctx.ok(ctx.world.channelJSON(t), 201);
  }, { audit: true });

  // ${DOCS}/resources/channel#start-thread-without-message and #start-thread-in-forum-or-media-channel
  r.add('POST', '/channels/:channel_id/threads', (ctx) => {
    const c = ctx.channel();
    const forum = c.type === ChannelType.GUILD_FORUM || c.type === ChannelType.GUILD_MEDIA;
    if (!forum && c.type !== ChannelType.GUILD_TEXT && c.type !== ChannelType.GUILD_ANNOUNCEMENT) throw Errors.channelType();
    assertValid(ctx.body, {
      name: nameSchema, type: { type: 'int', choices: [10, 11, 12] }, auto_archive_duration: { type: 'int', choices: AUTO_ARCHIVE },
      invitable: { type: 'bool' }, rate_limit_per_user: { type: 'int', min: 0, max: 21600, nullable: true },
      applied_tags: { type: 'array', items: { type: 'snowflake' } }, message: { type: 'object' },
    });
    if (forum) {
      // "The current user must have the SEND_MESSAGES permission (CREATE_PUBLIC_THREADS is ignored)."
      if (!ctx.body.message) throw formError('message', 'BASE_TYPE_REQUIRED', 'This field is required');
      ctx.require(c.guild_id, c.id, P.SEND_MESSAGES);
      const msg = ctx.body.message;
      if (!((msg.content ?? '') !== '' || msg.embeds?.length || msg.sticker_ids?.length || msg.components?.length || ctx.files?.length)) throw Errors.emptyMessage();
      const t = ctx.ops.createChannel(c.guild_id, { name: ctx.body.name, type: ChannelType.PUBLIC_THREAD, parent_id: c.id, owner_id: ctx.actorId, auto_archive_duration: ctx.body.auto_archive_duration, rate_limit_per_user: ctx.body.rate_limit_per_user ?? 0, applied_tags: ctx.body.applied_tags }, { actorId: ctx.actorId, reason: ctx.reason });
      // The first message of a forum post shares the thread's id.
      const first = createMessageFromBody(ctx, t, msg, ctx.files, { skipPermissionChecks: true, messageId: t.id });
      return ctx.ok({ ...ctx.world.channelJSON(t), message: ctx.server.messageForApp(first, ctx) }, 201);
    }
    if (ctx.body.message) throw Errors.channelType();
    const type = ctx.body.type ?? ChannelType.PRIVATE_THREAD; // "currently defaults to PRIVATE_THREAD"
    ctx.require(c.guild_id, c.id, type === ChannelType.PRIVATE_THREAD ? P.CREATE_PRIVATE_THREADS : P.CREATE_PUBLIC_THREADS);
    const t = ctx.ops.createChannel(c.guild_id, { name: ctx.body.name, type, parent_id: c.id, owner_id: ctx.actorId, auto_archive_duration: ctx.body.auto_archive_duration, rate_limit_per_user: ctx.body.rate_limit_per_user ?? 0 }, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.ok(ctx.world.channelJSON(t), 201);
  }, { audit: true });

  // ---------------------------------------------------------------------------
  // Thread members – ${DOCS}/resources/channel#join-thread
  // ---------------------------------------------------------------------------
  const targetOf = (ctx) => (ctx.params.user_id === '@me' ? ctx.actorId : ctx.params.user_id);
  const addMember = (ctx) => {
    const t = threadChannel(ctx);
    unarchived(t);
    const uid = targetOf(ctx);
    if (uid !== ctx.actorId) ctx.require(t.guild_id, t.id, P.SEND_MESSAGES_IN_THREADS);
    if (!ctx.world.member(t.guild_id, uid)) throw Errors.unknownMember();
    // ASSUMPTION: a private thread can only be joined by being added, or with MANAGE_THREADS; ctx.channel() already hides it otherwise.
    if (!t.thread_members?.[uid] && Object.keys(t.thread_members ?? {}).length >= MAX_PARTICIPANTS) throw new DiscordError(400, 30033, 'Maximum number of thread participants has been reached (1000)');
    ctx.ops.addThreadMember(t.id, uid);
    return ctx.noContent();
  };
  const removeMember = (ctx) => {
    const t = threadChannel(ctx);
    unarchived(t);
    const uid = targetOf(ctx);
    // "Requires the MANAGE_THREADS permission, or the creator of the thread if it is a PRIVATE_THREAD."
    if (uid !== ctx.actorId && !(t.type === ChannelType.PRIVATE_THREAD && t.owner_id === ctx.actorId)) ctx.require(t.guild_id, t.id, P.MANAGE_THREADS);
    // ASSUMPTION: removing someone who is not a member answers 204 and changes nothing.
    ctx.ops.removeThreadMember(t.id, uid);
    return ctx.noContent();
  };
  r.add('PUT', '/channels/:channel_id/thread-members/@me', (ctx) => { ctx.params.user_id = '@me'; return addMember(ctx); });
  r.add('PUT', '/channels/:channel_id/thread-members/:user_id', addMember);
  r.add('DELETE', '/channels/:channel_id/thread-members/@me', (ctx) => { ctx.params.user_id = '@me'; return removeMember(ctx); });
  r.add('DELETE', '/channels/:channel_id/thread-members/:user_id', removeMember);

  // ${DOCS}/resources/channel#get-thread-member – ASSUMPTION: a non-member answers 404/10007 Unknown Member
  r.add('GET', '/channels/:channel_id/thread-members/:user_id', (ctx) => {
    const t = threadChannel(ctx);
    const uid = targetOf(ctx);
    const out = isSnowflake(uid) && ctx.ops.threadMemberJSON(t, uid, { withMember: ctx.query.with_member === 'true' });
    if (!out) throw Errors.unknownMember();
    return ctx.ok(out);
  });
  // ${DOCS}/resources/channel#list-thread-members – with_member paginates (after, limit 1-100)
  r.add('GET', '/channels/:channel_id/thread-members', (ctx) => {
    const t = threadChannel(ctx);
    assertValid(ctx.query, { limit: { type: 'int', min: 1, max: 100 }, after: { type: 'snowflake' } });
    const withMember = ctx.query.with_member === 'true';
    let ids = Object.keys(t.thread_members ?? {}).sort(compareIds);
    if (withMember) {
      if (ctx.query.after) ids = ids.filter((u) => compareIds(u, ctx.query.after) > 0);
      ids = ids.slice(0, Number(ctx.query.limit ?? 100));
    }
    return ctx.ok(ids.map((uid) => ctx.ops.threadMemberJSON(t, uid, { withMember })));
  });

  // ---------------------------------------------------------------------------
  // Archived thread lists
  // ---------------------------------------------------------------------------
  const archivedAt = (c) => Date.parse(c.thread_metadata?.archive_timestamp ?? '') || Number(BigInt(c.id) >> 22n) + 1420070400000;
  const archivedList = (ctx, { types, byId = false, joinedOnly = false }) => {
    const c = ctx.channel();
    if (![ChannelType.GUILD_TEXT, ChannelType.GUILD_ANNOUNCEMENT, ChannelType.GUILD_FORUM, ChannelType.GUILD_MEDIA].includes(c.type)) throw Errors.channelType();
    assertValid(ctx.query, { limit: { type: 'int', min: 1, max: 100 } });
    let list = ctx.world.guildChannels(c.guild_id).filter((t) => THREAD_TYPES.has(t.type) && t.parent_id === c.id && t.thread_metadata?.archived && types.includes(t.type));
    if (joinedOnly) list = list.filter((t) => t.thread_members?.[ctx.actorId]);
    if (byId) {
      list.sort((a, b) => compareIds(b.id, a.id));
      if (ctx.query.before) list = list.filter((t) => compareIds(t.id, ctx.query.before) < 0);
    } else {
      list.sort((a, b) => archivedAt(b) - archivedAt(a) || compareIds(b.id, a.id));
      if (ctx.query.before !== undefined) {
        const before = Date.parse(ctx.query.before);
        if (Number.isNaN(before)) throw formError('before', 'DATE_TIME_TYPE_CONVERT', 'Could not parse a date-time.');
        list = list.filter((t) => archivedAt(t) < before);
      }
    }
    const limit = Number(ctx.query.limit ?? 100);
    const page = list.slice(0, limit);
    return ctx.ok({
      threads: page.map((t) => ctx.world.channelJSON(t)),
      members: page.map((t) => ctx.ops.threadMemberJSON(t, ctx.actorId)).filter(Boolean),
      has_more: list.length > limit,
    });
  };
  // ${DOCS}/resources/channel#list-public-archived-threads – READ_MESSAGE_HISTORY
  r.add('GET', '/channels/:channel_id/threads/archived/public', (ctx) => {
    const c = ctx.channel();
    ctx.require(c.guild_id, c.id, P.READ_MESSAGE_HISTORY);
    return archivedList(ctx, { types: [ChannelType.PUBLIC_THREAD, ChannelType.ANNOUNCEMENT_THREAD] });
  });
  // ${DOCS}/resources/channel#list-private-archived-threads – READ_MESSAGE_HISTORY and MANAGE_THREADS
  r.add('GET', '/channels/:channel_id/threads/archived/private', (ctx) => {
    const c = ctx.channel();
    ctx.require(c.guild_id, c.id, P.READ_MESSAGE_HISTORY, P.MANAGE_THREADS);
    return archivedList(ctx, { types: [ChannelType.PRIVATE_THREAD] });
  });
  // ${DOCS}/resources/channel#list-joined-private-archived-threads – READ_MESSAGE_HISTORY; ordered by id, `before` is a snowflake
  r.add('GET', '/channels/:channel_id/users/@me/threads/archived/private', (ctx) => {
    const c = ctx.channel();
    ctx.require(c.guild_id, c.id, P.READ_MESSAGE_HISTORY);
    return archivedList(ctx, { types: [ChannelType.PRIVATE_THREAD], byId: true, joinedOnly: true });
  });
}
