import { World } from './world.js';
import { Ops } from './ops.js';
import { FakeServer } from './server.js';
import { Control, ControlError } from './control.js';
import { Clock } from './util.js';
import { seedDemoWorld } from './demo.js';

export * as constants from './constants.js';
export { computePermissions, parsePermissions, permissionNames } from './permissions.js';
export { snowflakeTime, Clock } from './util.js';
export { ControlError, seedDemoWorld };

/**
 * Start a fake Discord.
 *
 * @param {object} [options]
 * @param {number} [options.port=0]            0 picks a free port
 * @param {string} [options.host='127.0.0.1']
 * @param {'real'|'manual'|{mode,now}} [options.clock='real']  'manual' freezes time (fully deterministic)
 * @param {number|string|Date} [options.now]   start time
 * @param {number} [options.seed=1]            seed for tokens, secrets and session ids
 * @param {object|false} [options.rateLimits]  { enabled, global: {limit, windowMs}, default: {...}, routes: { 'METHOD /template': {...} } }
 * @param {object} [options.gateway]           { heartbeatIntervalMs, heartbeatTimeoutMs, resumeWindowMs, maxGuildsPerShard, ... }
 * @param {object} [options.interactions]      { callbackDeadlineMs, tokenTtlMs }
 * @param {object} [options.cdn]               { attachmentTtlMs, maxUploadBytes }
 * @param {object} [options.oauth]             { mode: 'auto'|'consent', userId, guildId }
 * @param {boolean|object} [options.demo]      seed the demo world (true or seedDemoWorld options)
 * @param {(control) => void} [options.setup]  build the world before the server starts listening
 * @param {boolean} [options.stub]             replace every Discord-facing handler with a stub (for contract-test red checks)
 */
export async function createFakeDiscord(options = {}) {
  const clockOpt = typeof options.clock === 'object' ? options.clock : { mode: options.clock ?? 'real', now: options.now };
  const clock = new Clock(clockOpt);
  // With a frozen clock, rate-limit windows only reset when the test advances time, so automatic
  // limits would turn every long test into a stream of 429s. They are off by default in 'manual'
  // mode and on in 'real' mode; pass `rateLimits` explicitly to choose. Injected 429s always work.
  if (options.rateLimits === undefined && clock.mode === 'manual') options = { ...options, rateLimits: false };
  const world = new World({ clock, seed: options.seed ?? 1, options });
  const ops = new Ops(world);
  const server = new FakeServer({ world, ops, options });
  const control = new Control({ world, ops, server });
  await server.listen(options.port ?? 0, options.host ?? '127.0.0.1');

  let demo = null;
  if (options.demo) demo = seedDemoWorld(control, typeof options.demo === 'object' ? options.demo : {});
  if (options.setup) await options.setup(control);

  return {
    url: server.baseUrl,
    apiUrl: server.apiUrl,
    restUrl: server.restUrl,
    gatewayUrl: server.gatewayUrl,
    oauthUrl: server.oauthUrl,
    cdnUrl: server.cdnUrl,
    controlUrl: server.controlUrl,
    control,
    demo,
    world,
    close: () => server.close(),
  };
}

export default createFakeDiscord;
