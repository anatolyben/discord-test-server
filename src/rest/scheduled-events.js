// Guild scheduled events – https://discord.com/developers/docs/resources/guild-scheduled-event
import { Errors, DiscordError, assertValid, formError } from '../errors.js';
import { ChannelType, Permissions as P } from '../constants.js';
import { isSnowflake, compareIds } from '../util.js';

const DOCS = 'https://discord.com/developers/docs';
const MAX_UNCOMPLETED = 100; // 30038
const SCHEDULED = 1, ACTIVE = 2, COMPLETED = 3, CANCELED = 4;
const VOICE = 2, STAGE = 1, EXTERNAL = 3;
// ${DOCS}/resources/guild-scheduled-event#guild-scheduled-event-object-valid-guild-scheduled-event-status-transitions
const TRANSITIONS = { [SCHEDULED]: [ACTIVE, CANCELED], [ACTIVE]: [COMPLETED], [COMPLETED]: [], [CANCELED]: [] };

const schema = {
  name: { type: 'string', minLength: 1, maxLength: 100 },
  description: { type: 'string', maxLength: 1000, nullable: true },
  privacy_level: { type: 'int', choices: [2] },
  scheduled_start_time: { type: 'iso8601' },
  scheduled_end_time: { type: 'iso8601', nullable: true },
  entity_type: { type: 'int', choices: [STAGE, VOICE, EXTERNAL] },
  entity_metadata: { type: 'object', nullable: true },
  channel_id: { type: 'snowflake', nullable: true },
  status: { type: 'int', choices: [SCHEDULED, ACTIVE, COMPLETED, CANCELED] },
  image: { type: 'string', nullable: true },
  recurrence_rule: { type: 'object', nullable: true },
};

export function registerScheduledEventRoutes(r) {
  const eventOf = (ctx, g) => {
    const ev = isSnowflake(ctx.params.event_id) && g.scheduled_events?.[ctx.params.event_id];
    if (!ev) throw Errors.unknownScheduledEvent();
    return ev;
  };

  /** Rules from "Field Requirements By Entity Type": returns the normalised event fields or throws a form error. */
  const normalise = (ctx, g, c) => {
    if (c.entity_type === EXTERNAL) {
      if (c.channel_id) throw formError('channel_id', 'GUILD_SCHEDULED_EVENT_CHANNEL_ID_MUST_BE_NULL', 'Channel id must be null for external events.'); // ASSUMPTION: detail codes
      if (!c.entity_metadata?.location) throw formError(['entity_metadata', 'location'], 'BASE_TYPE_REQUIRED', 'This field is required');
      if (!c.end) throw formError('scheduled_end_time', 'BASE_TYPE_REQUIRED', 'This field is required');
    } else {
      if (!c.channel_id) throw formError('channel_id', 'BASE_TYPE_REQUIRED', 'This field is required');
      const ch = ctx.channel(c.channel_id);
      const want = c.entity_type === STAGE ? ChannelType.GUILD_STAGE_VOICE : ChannelType.GUILD_VOICE;
      if (ch.guild_id !== g.id || ch.type !== want) throw formError('channel_id', 'GUILD_SCHEDULED_EVENT_CHANNEL_TYPE_INVALID', 'Channel type does not match the entity type.');
      c.entity_metadata = null; // "silently discards entity_metadata for non-EXTERNAL events"
    }
    if (c.end !== null && c.end <= c.start) throw formError('scheduled_end_time', 'GUILD_SCHEDULED_EVENT_END_BEFORE_START', 'Scheduled end time must be after the start time.');
    return c;
  };

  /** ${DOCS}/resources/guild-scheduled-event#guild-scheduled-event-permissions-requirements */
  const requireRights = (ctx, g, c, { create, createdBy }) => {
    const own = create || createdBy === ctx.actorId;
    if (create) ctx.require(g.id, c.channel_id ?? undefined, P.CREATE_EVENTS);
    else if (own) ctx.requireAny(g.id, c.channel_id ?? undefined, P.CREATE_EVENTS, P.MANAGE_EVENTS);
    else ctx.require(g.id, c.channel_id ?? undefined, P.MANAGE_EVENTS);
    if (c.entity_type === VOICE) ctx.require(g.id, c.channel_id, P.VIEW_CHANNEL, P.CONNECT);
    if (c.entity_type === STAGE) ctx.require(g.id, c.channel_id, P.VIEW_CHANNEL, P.MANAGE_CHANNELS, P.MUTE_MEMBERS, P.MOVE_MEMBERS);
  };

  r.add('GET', '/guilds/:guild_id/scheduled-events', (ctx) => {
    const g = ctx.guild();
    const withCount = ctx.query.with_user_count === 'true';
    return ctx.ok(Object.values(g.scheduled_events ?? {}).map((e) => ctx.world.scheduledEventJSON(e, { withUserCount: withCount })));
  });
  r.add('GET', '/guilds/:guild_id/scheduled-events/:event_id', (ctx) => {
    const g = ctx.guild();
    return ctx.ok(ctx.world.scheduledEventJSON(eventOf(ctx, g), { withUserCount: ctx.query.with_user_count === 'true' }));
  });

  r.add('POST', '/guilds/:guild_id/scheduled-events', (ctx) => {
    const g = ctx.guild();
    assertValid(ctx.body, { ...schema, name: { ...schema.name, required: true }, privacy_level: { ...schema.privacy_level, required: true }, scheduled_start_time: { type: 'iso8601', required: true }, entity_type: { ...schema.entity_type, required: true } });
    const b = ctx.body;
    const c = {
      name: b.name, description: b.description ?? null, start: Date.parse(b.scheduled_start_time), end: b.scheduled_end_time ? Date.parse(b.scheduled_end_time) : null,
      entity_type: b.entity_type, channel_id: b.channel_id ?? null, entity_metadata: b.entity_metadata ?? null, image: b.image ?? null, recurrence_rule: b.recurrence_rule ?? null,
    };
    // ASSUMPTION: the start time must not be in the past (400/50035 on scheduled_start_time).
    if (c.start < ctx.world.now()) throw formError('scheduled_start_time', 'DATE_RANGE_PAST', 'Scheduled start time must be in the future.');
    normalise(ctx, g, c);
    requireRights(ctx, g, c, { create: true });
    if (Object.values(g.scheduled_events ?? {}).filter((e) => e.status === SCHEDULED || e.status === ACTIVE).length >= MAX_UNCOMPLETED) throw new DiscordError(400, 30038, 'Maximum number of uncompleted guild scheduled events reached (100)');
    const ev = ctx.ops.createScheduledEvent(g.id, c, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.ok(ctx.world.scheduledEventJSON(ev));
  }, { audit: true });

  r.add('PATCH', '/guilds/:guild_id/scheduled-events/:event_id', (ctx) => {
    const g = ctx.guild();
    assertValid(ctx.body, schema);
    const ev = eventOf(ctx, g);
    const b = ctx.body;
    if (b.status !== undefined && b.status !== ev.status && !TRANSITIONS[ev.status].includes(b.status)) {
      throw formError('status', 'GUILD_SCHEDULED_EVENT_INVALID_STATUS_TRANSITION', 'Invalid status transition.'); // ASSUMPTION: detail code
    }
    const merged = {
      name: b.name ?? ev.name, description: b.description !== undefined ? b.description : ev.description,
      start: b.scheduled_start_time ? Date.parse(b.scheduled_start_time) : ev.start,
      end: b.scheduled_end_time !== undefined ? (b.scheduled_end_time ? Date.parse(b.scheduled_end_time) : null) : ev.end,
      entity_type: b.entity_type ?? ev.entity_type,
      channel_id: b.channel_id !== undefined ? b.channel_id : ev.channel_id,
      entity_metadata: b.entity_metadata !== undefined ? b.entity_metadata : ev.entity_metadata,
    };
    if (b.entity_type === EXTERNAL && ev.entity_type !== EXTERNAL) {
      // "If updating entity_type to EXTERNAL: channel_id is required and must be set to null; entity_metadata with a location and scheduled_end_time must be provided"
      if (b.channel_id !== null) throw formError('channel_id', 'GUILD_SCHEDULED_EVENT_CHANNEL_ID_MUST_BE_NULL', 'Channel id must be null for external events.');
      if (!b.entity_metadata?.location) throw formError(['entity_metadata', 'location'], 'BASE_TYPE_REQUIRED', 'This field is required');
      if (!b.scheduled_end_time) throw formError('scheduled_end_time', 'BASE_TYPE_REQUIRED', 'This field is required');
    }
    if (b.scheduled_start_time && merged.start < ctx.world.now()) throw formError('scheduled_start_time', 'DATE_RANGE_PAST', 'Scheduled start time must be in the future.');
    normalise(ctx, g, merged);
    requireRights(ctx, g, merged, { create: false, createdBy: ev.creator_id });
    const patch = { ...merged };
    if (b.status !== undefined) patch.status = b.status;
    if (b.image !== undefined) patch.image = b.image;
    if (b.recurrence_rule !== undefined) patch.recurrence_rule = b.recurrence_rule;
    ctx.ops.updateScheduledEvent(g.id, ev.id, patch, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.ok(ctx.world.scheduledEventJSON(ev));
  }, { audit: true });

  r.add('DELETE', '/guilds/:guild_id/scheduled-events/:event_id', (ctx) => {
    const g = ctx.guild();
    const ev = eventOf(ctx, g);
    requireRights(ctx, g, ev, { create: false, createdBy: ev.creator_id });
    ctx.ops.deleteScheduledEvent(g.id, ev.id, { actorId: ctx.actorId, reason: ctx.reason });
    return ctx.noContent();
  }, { audit: true });

  // ${DOCS}/resources/guild-scheduled-event#get-guild-scheduled-event-users – ascending by user id; before wins over after
  r.add('GET', '/guilds/:guild_id/scheduled-events/:event_id/users', (ctx) => {
    const g = ctx.guild();
    assertValid(ctx.query, { limit: { type: 'int', min: 1, max: 100 }, before: { type: 'snowflake' }, after: { type: 'snowflake' } });
    const ev = eventOf(ctx, g);
    let ids = [...ev.users].sort(compareIds);
    const limit = Number(ctx.query.limit ?? 100);
    if (ctx.query.before) ids = ids.filter((u) => compareIds(u, ctx.query.before) < 0).slice(-limit);
    else {
      if (ctx.query.after) ids = ids.filter((u) => compareIds(u, ctx.query.after) > 0);
      ids = ids.slice(0, limit);
    }
    return ctx.ok(ids.map((uid) => {
      const out = { guild_scheduled_event_id: ev.id, user: ctx.world.userJSON(uid) };
      if (ctx.query.with_member === 'true' && ctx.world.member(g.id, uid)) out.member = ctx.world.memberJSON(g.id, uid, { withUser: false });
      return out;
    }));
  });
}
