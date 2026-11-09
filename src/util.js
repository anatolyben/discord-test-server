import { createHmac } from 'node:crypto';
import { DISCORD_EPOCH } from './constants.js';

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------
// The whole server reads time from this clock, so message age, timeout expiry,
// interaction deadlines, token expiry and rate-limit windows can be driven by a test.
//   mode 'real'   – follows the wall clock, shifted by setNow/advance.
//   mode 'manual' – frozen; only setNow/advance move it (fully deterministic).
export class Clock {
  constructor({ mode = 'real', now } = {}) {
    if (mode !== 'real' && mode !== 'manual') throw new Error(`clock mode must be 'real' or 'manual', got ${mode}`);
    this.mode = mode;
    const start = now === undefined ? Date.now() : toMs(now);
    this._offset = start - Date.now();
    this._manual = start;
  }
  now() {
    return this.mode === 'manual' ? this._manual : Date.now() + this._offset;
  }
  setNow(t) {
    const ms = toMs(t);
    if (this.mode === 'manual') this._manual = ms;
    else this._offset = ms - Date.now();
    return this.now();
  }
  advance(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) throw new Error('advance(ms) needs a number');
    return this.setNow(this.now() + ms);
  }
  iso(ms = this.now()) {
    return new Date(ms).toISOString().replace('Z', '+00:00');
  }
  toJSON() {
    return { mode: this.mode, now: this.now() };
  }
}

export function toMs(t) {
  if (typeof t === 'number') return t;
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'string') {
    const ms = Date.parse(t);
    if (Number.isNaN(ms)) throw new Error(`invalid time: ${t}`);
    return ms;
  }
  throw new Error(`invalid time: ${t}`);
}

// ---------------------------------------------------------------------------
// Snowflakes – https://discord.com/developers/docs/reference#snowflakes
// (timestamp - DISCORD_EPOCH) << 22 | worker << 17 | process << 12 | increment
// ---------------------------------------------------------------------------
export class SnowflakeGenerator {
  constructor(clock, { workerId = 1, processId = 0 } = {}) {
    this.clock = clock;
    this.workerId = BigInt(workerId);
    this.processId = BigInt(processId);
    this.lastMs = 0;
    this.increment = 0;
  }
  next(atMs) {
    let ms = atMs ?? this.clock.now();
    if (atMs === undefined) {
      // Keep ids strictly increasing even with a frozen or rewound clock.
      if (ms < this.lastMs) ms = this.lastMs;
      if (ms === this.lastMs) {
        this.increment++;
        if (this.increment >= 4096) { ms = ++this.lastMs; this.increment = 0; }
      } else {
        this.increment = 0;
      }
      this.lastMs = ms;
      return build(ms, this.workerId, this.processId, this.increment);
    }
    // Explicit timestamps (backdated fixtures): use a separate counter space so they never collide.
    this._backdated = ((this._backdated ?? 0) + 1) % 4096;
    return build(ms, this.workerId, this.processId + 16n, this._backdated);
  }
  state() { return { lastMs: this.lastMs, increment: this.increment, backdated: this._backdated ?? 0 }; }
  restore(s) { this.lastMs = s.lastMs; this.increment = s.increment; this._backdated = s.backdated; }
}

function build(ms, worker, proc, inc) {
  return (((BigInt(ms) - DISCORD_EPOCH) << 22n) | (worker << 17n) | ((proc & 31n) << 12n) | BigInt(inc)).toString();
}

export function snowflakeTime(id) {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}
export function isSnowflake(v) {
  return (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') && /^\d{1,20}$/.test(String(v));
}
export function compareIds(a, b) {
  const x = BigInt(a), y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG for tokens, secrets and session ids (mulberry32).
// ---------------------------------------------------------------------------
export class Rng {
  constructor(seed = 1) { this.s = seed >>> 0; }
  nextU32() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  chars(n, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') {
    let out = '';
    for (let i = 0; i < n; i++) out += alphabet[this.nextU32() % alphabet.length];
    return out;
  }
  hex(n) { return this.chars(n, '0123456789abcdef'); }
  b64url(n) { return this.chars(n, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'); }
}

export function hmacHex(secret, data) {
  return createHmac('sha256', secret).update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Bitfield helpers. Permission bitfields travel as decimal strings in JSON.
// ---------------------------------------------------------------------------
export function toBits(v) {
  if (v === undefined || v === null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') return BigInt(v);
  throw new Error(`not a bitfield: ${v}`);
}

export function deepClone(v) {
  return structuredClone(v);
}

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
