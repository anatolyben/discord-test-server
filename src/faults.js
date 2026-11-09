// Fault injection for REST requests. Every rule matches requests and fires `count` times.
//
// match: { route?: 'PUT /guilds/:guild_id/bans/:user_id' | '*', path?: string|RegExp, method?: string }
// kinds:
//   rateLimit { retryAfter = 1, global = false, scope = 'user' }   – answer 429
//   error     { status = 500, body }                                – answer 5xx (or any status) without applying
//   drop      {}                                                    – apply the write, then destroy the socket (unknown outcome)
//   delay     { ms }                                                – wait (real time) before handling
//   hook      { fn }                                                – run fn(ctx) before handling (state drift between calls)

export class Faults {
  constructor() {
    this.rules = [];
    this.nextId = 1;
  }

  add(kind, { route, path, method, count = 1, ...params } = {}) {
    const rule = { id: `fault_${this.nextId++}`, kind, match: { route, path, method }, remaining: count, fired: 0, ...params };
    this.rules.push(rule);
    return rule.id;
  }

  remove(id) {
    this.rules = this.rules.filter((r) => r.id !== id);
  }

  clear() {
    this.rules = [];
  }

  /** Take every rule of `kind` that matches (decrementing). */
  take(kind, req) {
    const out = [];
    for (const r of this.rules) {
      if (r.kind !== kind || r.remaining <= 0) continue;
      if (!matches(r.match, req)) continue;
      r.remaining--;
      r.fired++;
      out.push(r);
    }
    this.rules = this.rules.filter((r) => r.remaining > 0);
    return out;
  }

  list() {
    return this.rules.map(({ fn, ...r }) => ({ ...r, match: { ...r.match, path: r.match.path?.toString() } }));
  }
}

export function matches(match, req) {
  if (match.method && match.method.toUpperCase() !== req.method) return false;
  if (match.route && match.route !== '*' && match.route !== `${req.method} ${req.template}` && match.route !== req.template) return false;
  if (match.path) {
    if (match.path instanceof RegExp) {
      if (!match.path.test(req.path)) return false;
    } else if (!req.path.startsWith(match.path)) return false;
  }
  return true;
}
