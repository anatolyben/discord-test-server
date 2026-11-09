import { createHash } from 'node:crypto';

// HTTP rate limits – https://discord.com/developers/docs/topics/rate-limits
//
// Documented: per-route buckets identified by X-RateLimit-Bucket, keyed together with the
// "top-level resource" (channel_id, guild_id, webhook_id + webhook_token); a global limit of
// 50 requests per second per bot; interaction endpoints are not bound to the global limit;
// the headers X-RateLimit-Limit/Remaining/Reset/Reset-After/Bucket and, on 429,
// X-RateLimit-Global, X-RateLimit-Scope and Retry-After; the 429 body
// { message, retry_after (seconds, float), global, code? }.
//
// ASSUMPTION: Discord does not publish per-route limits (they are dynamic). Limits are
// configured with options.rateLimits.routes['METHOD /template'] = { limit, windowMs }, falling
// back to options.rateLimits.default. Windows are fixed windows measured on the fake clock.

export const DEFAULT_RATE_LIMITS = {
  enabled: true,
  global: { limit: 50, windowMs: 1000 },
  default: { limit: 50, windowMs: 1000 },
  routes: {
    // ASSUMPTION: commonly observed message-send limit.
    'POST /channels/:channel_id/messages': { limit: 5, windowMs: 5000 },
  },
};

const MAJOR_PARAMS = ['channel_id', 'guild_id', 'webhook_id', 'webhook_token', 'application_id', 'interaction_token'];

export class RateLimiter {
  constructor(clock, config = {}) {
    this.clock = clock;
    this.configure(config);
    this.buckets = new Map();
    this.globals = new Map();
  }

  configure(config = {}) {
    if (config === false) config = { enabled: false };
    this.config = {
      ...DEFAULT_RATE_LIMITS,
      ...config,
      routes: { ...DEFAULT_RATE_LIMITS.routes, ...(config.routes ?? {}) },
    };
  }

  setRoute(routeKey, limits) {
    if (limits === null) delete this.config.routes[routeKey];
    else this.config.routes[routeKey] = limits;
    this.buckets.clear();
  }

  reset() {
    this.buckets.clear();
    this.globals.clear();
  }

  bucketHash(routeKey) {
    return createHash('sha1').update(routeKey).digest('hex').slice(0, 32);
  }

  /**
   * @param identity  string identifying the caller (bot application id, bearer token, interaction token)
   * @param route     { method, template, params, global: bool }
   * @returns { headers, limited?: { retryAfter, global, scope } }
   */
  check(identity, route) {
    const now = this.clock.now();
    const routeKey = `${route.method} ${route.template}`;
    const cfg = this.config.routes[routeKey] ?? this.config.default;
    const hash = this.bucketHash(routeKey);
    const headers = {};
    if (!this.config.enabled) return { headers };

    // Global limit first.
    if (route.global && this.config.global) {
      const g = window(this.globals, identity, now, this.config.global.windowMs);
      if (g.count >= this.config.global.limit) {
        const retryAfter = (g.resetAt - now) / 1000;
        return { headers, limited: { retryAfter, global: true, scope: 'global' } };
      }
      g.count++;
    }

    const major = MAJOR_PARAMS.filter((p) => route.params[p]).map((p) => route.params[p]).join(':');
    const key = `${identity}|${hash}|${major}`;
    const b = window(this.buckets, key, now, cfg.windowMs);
    const resetAfter = (b.resetAt - now) / 1000;
    Object.assign(headers, {
      'X-RateLimit-Limit': String(cfg.limit),
      'X-RateLimit-Remaining': String(Math.max(0, cfg.limit - b.count - 1)),
      'X-RateLimit-Reset': (b.resetAt / 1000).toFixed(3),
      'X-RateLimit-Reset-After': resetAfter.toFixed(3),
      'X-RateLimit-Bucket': hash,
    });
    if (b.count >= cfg.limit) {
      headers['X-RateLimit-Remaining'] = '0';
      return { headers, limited: { retryAfter: resetAfter, global: false, scope: 'user' } };
    }
    b.count++;
    return { headers };
  }
}

function window(map, key, now, windowMs) {
  let w = map.get(key);
  if (!w || now >= w.resetAt) {
    w = { count: 0, resetAt: now + windowMs };
    map.set(key, w);
  }
  return w;
}

/** Build the 429 response pieces. */
export function rateLimitResponse({ retryAfter, global, scope }, baseHeaders = {}) {
  const headers = {
    ...baseHeaders,
    'Retry-After': String(Math.max(0, Math.ceil(retryAfter))),
    'X-RateLimit-Scope': scope,
  };
  if (global) headers['X-RateLimit-Global'] = 'true';
  return {
    status: 429,
    headers,
    body: { message: 'You are being rate limited.', retry_after: Number(retryAfter.toFixed(3)), global },
  };
}
