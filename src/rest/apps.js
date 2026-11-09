import { Errors, FormErrors, assertValid, formError, checkField } from '../errors.js';
import { EntitlementType, ApplicationCommandType } from '../constants.js';
import { compareIds, deepClone } from '../util.js';

const DOCS = 'https://discord.com/developers/docs';

// ${DOCS}/interactions/application-commands#application-command-object-application-command-naming
const CHAT_INPUT_NAME = /^[-_'\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;

export function registerAppRoutes(r) {
  const requireOwnApp = (ctx) => {
    ctx.requireBot();
    if (ctx.params.application_id !== ctx.app.id) throw Errors.notAuthorizedForApp();
  };

  // ${DOCS}/resources/application#get-current-application
  r.add('GET', '/applications/@me', (ctx) => {
    ctx.requireBot();
    return ctx.ok(ctx.world.applicationJSON(ctx.app));
  });
  // ${DOCS}/topics/oauth2#get-current-bot-application-information
  r.add('GET', '/oauth2/applications/@me', (ctx) => {
    ctx.requireBot();
    return ctx.ok(ctx.world.applicationJSON(ctx.app));
  });

  // ---------------------------------------------------------------------------
  // Application commands – ${DOCS}/interactions/application-commands
  // ---------------------------------------------------------------------------
  const list = (ctx, guildId) => Object.values(ctx.world.state.commands)
    .filter((c) => c.application_id === ctx.app.id && (c.guild_id ?? null) === (guildId ?? null))
    .sort((a, b) => compareIds(a.id, b.id));

  const guildScope = (ctx) => {
    // Guild commands need the app in that guild (bot or applications.commands scope).
    const g = ctx.world.guild(ctx.params.guild_id);
    if (!g) throw Errors.unknownGuild();
    if (!g.members[ctx.app.bot_user_id]) throw Errors.missingAccess();
    return g.id;
  };

  const scopes = [
    { prefix: '/applications/:application_id/commands', guild: false },
    { prefix: '/applications/:application_id/guilds/:guild_id/commands', guild: true },
  ];

  for (const { prefix, guild } of scopes) {
    const gid = (ctx) => (guild ? guildScope(ctx) : null);

    // ${DOCS}/interactions/application-commands#get-global-application-commands
    r.add('GET', prefix, (ctx) => {
      requireOwnApp(ctx);
      const withLoc = ctx.query.with_localizations === 'true';
      return ctx.ok(list(ctx, gid(ctx)).map((c) => commandJSON(c, withLoc)));
    });

    // ${DOCS}/interactions/application-commands#create-global-application-command
    // "Creating a command with the same name as an existing command for your application will overwrite the old command."
    // Returns 201 when new, 200 when it replaced an existing one.
    r.add('POST', prefix, (ctx) => {
      requireOwnApp(ctx);
      const g = gid(ctx);
      validateCommand(ctx.body);
      const existing = list(ctx, g).find((c) => c.name === ctx.body.name && c.type === (ctx.body.type ?? 1));
      if (!existing && list(ctx, g).filter((c) => c.type === (ctx.body.type ?? 1)).length >= ((ctx.body.type ?? 1) === 1 ? 100 : 15)) {
        throw formError('name', 'APPLICATION_COMMANDS_DUPLICATE_NAME', 'Maximum number of application commands reached'); // ASSUMPTION
      }
      const cmd = upsertCommand(ctx, g, ctx.body, existing);
      return ctx.ok(commandJSON(cmd), existing ? 200 : 201);
    });

    // ${DOCS}/interactions/application-commands#bulk-overwrite-global-application-commands
    // Commands that are not in the list are deleted; existing ones keep their ids.
    r.add('PUT', prefix, (ctx) => {
      requireOwnApp(ctx);
      const g = gid(ctx);
      if (!Array.isArray(ctx.body)) throw formError([], 'BASE_TYPE_LIST', 'Must be a list.');
      const fe = new FormErrors();
      ctx.body.forEach((c, i) => validateCommand(c, fe, [String(i)]));
      const seen = new Set();
      ctx.body.forEach((c, i) => {
        const key = `${c.type ?? 1}:${c.name}`;
        if (seen.has(key)) fe.add([String(i), 'name'], 'APPLICATION_COMMANDS_DUPLICATE_NAME', `Application command names must be unique`);
        seen.add(key);
      });
      fe.throwIfAny();
      const current = list(ctx, g);
      const kept = [];
      for (const body of ctx.body) {
        const existing = current.find((c) => c.name === body.name && c.type === (body.type ?? 1));
        kept.push(upsertCommand(ctx, g, body, existing));
      }
      for (const c of current) if (!kept.includes(c)) delete ctx.world.state.commands[c.id];
      return ctx.ok(kept.map((c) => commandJSON(c)));
    });

    // ${DOCS}/interactions/application-commands#get-global-application-command
    r.add('GET', `${prefix}/:command_id`, (ctx) => {
      requireOwnApp(ctx);
      return ctx.ok(commandJSON(findCommand(ctx, gid(ctx))));
    });

    // ${DOCS}/interactions/application-commands#edit-global-application-command
    r.add('PATCH', `${prefix}/:command_id`, (ctx) => {
      requireOwnApp(ctx);
      const cmd = findCommand(ctx, gid(ctx));
      validateCommand({ ...commandJSON(cmd), ...ctx.body });
      Object.assign(cmd, normalizeCommand({ ...cmd, ...ctx.body }));
      cmd.version = ctx.world.id();
      return ctx.ok(commandJSON(cmd));
    });

    // ${DOCS}/interactions/application-commands#delete-global-application-command
    r.add('DELETE', `${prefix}/:command_id`, (ctx) => {
      requireOwnApp(ctx);
      const cmd = findCommand(ctx, gid(ctx));
      delete ctx.world.state.commands[cmd.id];
      return ctx.noContent();
    });
  }

  // ---------------------------------------------------------------------------
  // Monetization
  // ---------------------------------------------------------------------------
  // ${DOCS}/resources/sku#list-skus
  r.add('GET', '/applications/:application_id/skus', (ctx) => {
    requireOwnApp(ctx);
    return ctx.ok(Object.values(ctx.world.state.skus).filter((s) => s.application_id === ctx.app.id).sort((a, b) => compareIds(a.id, b.id)).map(skuJSON));
  });

  // ${DOCS}/resources/entitlement#list-entitlements
  r.add('GET', '/applications/:application_id/entitlements', (ctx) => {
    requireOwnApp(ctx);
    assertValid(ctx.query, {
      user_id: { type: 'snowflake' }, guild_id: { type: 'snowflake' }, before: { type: 'snowflake' }, after: { type: 'snowflake' },
      limit: { type: 'int', min: 1, max: 100 }, sku_ids: { type: 'string' },
    });
    const q = ctx.query;
    const skuIds = q.sku_ids ? q.sku_ids.split(',').map((s) => s.trim()) : null;
    // ${DOCS}/reference#boolean-query-strings – "True, true, or 1 as true, False, false or 0 as false"
    const excludeEnded = ['true', 'True', '1'].includes(q.exclude_ended);
    // "exclude_deleted … Defaults to true"
    const excludeDeleted = !['false', 'False', '0'].includes(q.exclude_deleted);
    const now = ctx.world.now();
    let ents = Object.values(ctx.world.state.entitlements).filter((e) => e.application_id === ctx.app.id
      && (!q.user_id || e.user_id === q.user_id)
      && (!q.guild_id || e.guild_id === q.guild_id)
      && (!skuIds || skuIds.includes(e.sku_id))
      && (!excludeDeleted || !e.deleted)
      && (!excludeEnded || !e.ends_at || Date.parse(e.ends_at) > now));
    ents.sort((a, b) => compareIds(a.id, b.id));
    const limit = Number(q.limit ?? 100);
    if (q.after) ents = ents.filter((e) => compareIds(e.id, q.after) > 0).slice(0, limit);
    else if (q.before) ents = ents.filter((e) => compareIds(e.id, q.before) < 0).slice(-limit);
    else ents = ents.slice(0, limit);
    return ctx.ok(ents.map((e) => ctx.ops.entitlementJSON(e)));
  });

  // ${DOCS}/resources/entitlement#get-entitlement
  r.add('GET', '/applications/:application_id/entitlements/:entitlement_id', (ctx) => {
    requireOwnApp(ctx);
    const e = ctx.world.state.entitlements[ctx.params.entitlement_id];
    if (!e || e.application_id !== ctx.app.id) throw Errors.unknownEntitlement();
    return ctx.ok(ctx.ops.entitlementJSON(e));
  });

  // ${DOCS}/resources/entitlement#consume-an-entitlement – one-time consumable SKUs only
  r.add('POST', '/applications/:application_id/entitlements/:entitlement_id/consume', (ctx) => {
    requireOwnApp(ctx);
    const e = ctx.world.state.entitlements[ctx.params.entitlement_id];
    if (!e || e.application_id !== ctx.app.id || e.deleted) throw Errors.unknownEntitlement();
    const sku = ctx.world.state.skus[e.sku_id];
    if (sku?.type !== 3) throw formError('entitlement_id', 'ENTITLEMENT_NOT_CONSUMABLE', 'Entitlement is not consumable'); // ASSUMPTION
    ctx.ops.updateEntitlement(e.id, { consumed: true });
    return ctx.noContent();
  });

  // ${DOCS}/resources/entitlement#create-test-entitlement – owner_type 1 = guild, 2 = user.
  // "returns a partial entitlement object. It will not contain subscription_id, starts_at, or ends_at"
  r.add('POST', '/applications/:application_id/entitlements', (ctx) => {
    requireOwnApp(ctx);
    assertValid(ctx.body, {
      sku_id: { type: 'snowflake', required: true },
      owner_id: { type: 'snowflake', required: true },
      owner_type: { type: 'int', required: true, choices: [1, 2] },
    });
    const sku = ctx.world.state.skus[ctx.body.sku_id];
    if (!sku || sku.application_id !== ctx.app.id) throw Errors.unknownSku();
    if (ctx.body.owner_type === 1 && !ctx.world.guild(ctx.body.owner_id)) throw Errors.unknownGuild();
    if (ctx.body.owner_type === 2 && !ctx.world.user(ctx.body.owner_id)) throw Errors.unknownUser();
    const e = ctx.ops.createEntitlement({
      applicationId: ctx.app.id, skuId: sku.id, type: EntitlementType.TEST_MODE_PURCHASE,
      guildId: ctx.body.owner_type === 1 ? ctx.body.owner_id : undefined,
      userId: ctx.body.owner_type === 2 ? ctx.body.owner_id : undefined,
    });
    const json = ctx.ops.entitlementJSON(e);
    delete json.starts_at;
    delete json.ends_at;
    delete json.subscription_id;
    return ctx.ok(json);
  });

  // ${DOCS}/resources/entitlement#delete-test-entitlement
  r.add('DELETE', '/applications/:application_id/entitlements/:entitlement_id', (ctx) => {
    requireOwnApp(ctx);
    const e = ctx.world.state.entitlements[ctx.params.entitlement_id];
    if (!e || e.application_id !== ctx.app.id || e.deleted || e.type !== EntitlementType.TEST_MODE_PURCHASE) throw Errors.unknownEntitlement();
    ctx.ops.deleteEntitlement(e.id);
    return ctx.noContent();
  });

  // ${DOCS}/resources/subscription#list-sku-subscriptions – user_id required except for OAuth queries.
  r.add('GET', '/skus/:sku_id/subscriptions', (ctx) => {
    const sku = ctx.world.state.skus[ctx.params.sku_id];
    if (!sku || (ctx.app && sku.application_id !== ctx.app.id)) throw Errors.unknownSku();
    assertValid(ctx.query, {
      user_id: { type: 'snowflake', required: ctx.actor.kind === 'bot' }, before: { type: 'snowflake' },
      after: { type: 'snowflake' }, limit: { type: 'int', min: 1, max: 100 },
    });
    const userId = ctx.query.user_id ?? (ctx.actor.kind === 'bearer' ? ctx.actorId : undefined);
    let subs = Object.values(ctx.world.state.subscriptions).filter((s) => s.sku_ids.includes(sku.id) && (!userId || s.user_id === userId))
      .sort((a, b) => compareIds(a.id, b.id));
    const limit = Number(ctx.query.limit ?? 50);
    if (ctx.query.after) subs = subs.filter((s) => compareIds(s.id, ctx.query.after) > 0).slice(0, limit);
    else if (ctx.query.before) subs = subs.filter((s) => compareIds(s.id, ctx.query.before) < 0).slice(-limit);
    else subs = subs.slice(0, limit);
    return ctx.ok(subs.map(subscriptionJSON));
  }, { auth: 'any' });

  // ${DOCS}/resources/subscription#get-sku-subscription
  r.add('GET', '/skus/:sku_id/subscriptions/:subscription_id', (ctx) => {
    const sku = ctx.world.state.skus[ctx.params.sku_id];
    if (!sku || (ctx.app && sku.application_id !== ctx.app.id)) throw Errors.unknownSku();
    const s = ctx.world.state.subscriptions[ctx.params.subscription_id];
    if (!s || !s.sku_ids.includes(sku.id)) throw Errors.unknownSubscription();
    return ctx.ok(subscriptionJSON(s));
  }, { auth: 'any' });
}

// ---------------------------------------------------------------------------
function findCommand(ctx, guildId) {
  const c = ctx.world.state.commands[ctx.params.command_id];
  if (!c || c.application_id !== ctx.app.id || (c.guild_id ?? null) !== (guildId ?? null)) throw Errors.unknownCommand();
  return c;
}

function validateCommand(body, fe = new FormErrors(), path = []) {
  if (!body || typeof body !== 'object') { fe.add(path, 'DICT_TYPE_CONVERT', 'Only dictionaries may be used in a DictType'); fe.throwIfAny(); }
  const type = body.type ?? ApplicationCommandType.CHAT_INPUT;
  checkField(body.type, { type: 'int', choices: [1, 2, 3, 4] }, fe, [...path, 'type']);
  checkField(body.name, { type: 'string', required: true, minLength: 1, maxLength: 32 }, fe, [...path, 'name']);
  if (type === 1 && typeof body.name === 'string' && (!CHAT_INPUT_NAME.test(body.name) || body.name !== body.name.toLowerCase())) {
    fe.add([...path, 'name'], 'APPLICATION_COMMAND_INVALID_NAME', 'Command name is invalid');
  }
  if (type === 1) checkField(body.description, { type: 'string', required: true, minLength: 1, maxLength: 100 }, fe, [...path, 'description']);
  checkField(body.options, { type: 'array', maxLength: 25, nullable: true }, fe, [...path, 'options']);
  checkField(body.default_member_permissions, { type: 'bitfield', nullable: true }, fe, [...path, 'default_member_permissions']);
  checkField(body.integration_types, { type: 'array', nullable: true, items: { type: 'int', choices: [0, 1] } }, fe, [...path, 'integration_types']);
  checkField(body.contexts, { type: 'array', nullable: true, items: { type: 'int', choices: [0, 1, 2] } }, fe, [...path, 'contexts']);
  checkField(body.nsfw, { type: 'bool', nullable: true }, fe, [...path, 'nsfw']);
  (body.options ?? []).forEach?.((o, i) => {
    checkField(o?.name, { type: 'string', required: true, minLength: 1, maxLength: 32 }, fe, [...path, 'options', String(i), 'name']);
    checkField(o?.type, { type: 'int', required: true, choices: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }, fe, [...path, 'options', String(i), 'type']);
    checkField(o?.description, { type: 'string', required: true, minLength: 1, maxLength: 100 }, fe, [...path, 'options', String(i), 'description']);
  });
  if (!path.length) fe.throwIfAny();
  return fe;
}

function normalizeCommand(b) {
  return {
    type: b.type ?? 1,
    name: b.name,
    name_localizations: b.name_localizations ?? null,
    description: b.description ?? '',
    description_localizations: b.description_localizations ?? null,
    options: deepClone(b.options ?? []),
    default_member_permissions: b.default_member_permissions ?? null,
    nsfw: !!b.nsfw,
    integration_types: b.integration_types ?? [0],
    contexts: b.contexts ?? null,
  };
}

function upsertCommand(ctx, guildId, body, existing) {
  if (existing) {
    Object.assign(existing, normalizeCommand(body));
    existing.version = ctx.world.id();
    return existing;
  }
  const id = ctx.world.id();
  const cmd = { id, application_id: ctx.app.id, version: id, ...normalizeCommand(body) };
  if (guildId) cmd.guild_id = guildId;
  ctx.world.state.commands[id] = cmd;
  return cmd;
}

// ${DOCS}/interactions/application-commands#application-command-object
export function commandJSON(c, withLocalizations = true) {
  const out = {
    id: c.id, application_id: c.application_id, version: c.version, default_member_permissions: c.default_member_permissions,
    type: c.type, name: c.name, description: c.description, options: deepClone(c.options), nsfw: c.nsfw,
    integration_types: [...c.integration_types], contexts: c.contexts ? [...c.contexts] : null,
  };
  if (c.guild_id) out.guild_id = c.guild_id;
  if (withLocalizations) { out.name_localizations = c.name_localizations; out.description_localizations = c.description_localizations; }
  if (!c.guild_id) out.dm_permission = !c.contexts || c.contexts.includes(1);
  return out;
}

// ${DOCS}/resources/sku#sku-object
export function skuJSON(s) {
  return { id: s.id, type: s.type, application_id: s.application_id, name: s.name, slug: s.slug, flags: s.flags };
}

// ${DOCS}/resources/subscription#subscription-object
export function subscriptionJSON(s) {
  return {
    id: s.id, user_id: s.user_id, sku_ids: [...s.sku_ids], entitlement_ids: [...s.entitlement_ids],
    renewal_sku_ids: s.renewal_sku_ids ?? null, current_period_start: s.current_period_start,
    current_period_end: s.current_period_end, status: s.status, canceled_at: s.canceled_at ?? null,
  };
}
