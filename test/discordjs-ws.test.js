// A real @discordjs/ws (v2) client against the fake gateway – https://discord.com/developers/docs/events/gateway
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketManager, WebSocketShardEvents } from '@discordjs/ws';
import { REST } from '@discordjs/rest';
import { world } from './helpers.js';
import { Intents as I, GatewayOp as OP } from '../src/constants.js';

const TIMEOUT = 3000;

describe('@discordjs/ws WebSocketManager', () => {
  let w;
  let manager;
  const dispatches = [];
  const events = [];
  const waiters = new Set();
  const check = () => { for (const wt of [...waiters]) { const hit = wt.pred(); if (hit) { waiters.delete(wt); clearTimeout(wt.timer); wt.resolve(hit); } } };
  const waitFor = (pred, label, ms = TIMEOUT) => new Promise((resolve, reject) => {
    const wt = { pred, resolve };
    // Also poll, for predicates on the fake's logs.
    const poll = setInterval(check, 25);
    const done = resolve;
    wt.resolve = (v) => { clearInterval(poll); done(v); };
    wt.timer = setTimeout(() => { clearInterval(poll); waiters.delete(wt); reject(new Error(`timed out waiting for ${label}; dispatches: ${dispatches.map((d) => d.t).join(',')}; events: ${events.join(',')}`)); }, ms);
    waiters.add(wt);
    check();
  });
  const waitForDispatch = (t, pred = () => true, from = 0) => waitFor(() => dispatches.slice(from).find((p) => p.t === t && pred(p.d)), `dispatch ${t}`);
  const waitForEvent = (name, from) => waitFor(() => events.slice(from).includes(name), `event ${name}`);
  const sessions = new Map();

  before(async () => {
    // Real time, fast heartbeats: the library's own timers drive the connection.
    w = await world({ clock: 'real', gateway: { heartbeatIntervalMs: 1000 } });
    const rest = new REST({ api: w.fake.apiUrl, version: '10', hashSweepInterval: 0, handlerSweepInterval: 0 }).setToken(w.app.token);
    manager = new WebSocketManager({
      token: w.app.token,
      intents: I.GUILDS | I.GUILD_MESSAGES | I.MESSAGE_CONTENT,
      rest,
      // No 5 s identify spacing (the fake reports max_concurrency 1) and a private session store per manager.
      buildIdentifyThrottler: () => ({ waitForIdentify: async () => {} }),
      retrieveSessionInfo: (id) => sessions.get(id) ?? null,
      updateSessionInfo: (id, info) => { if (info) sessions.set(id, info); else sessions.delete(id); },
      helloTimeout: TIMEOUT,
      readyTimeout: TIMEOUT,
      handshakeTimeout: TIMEOUT,
    });
    manager.on(WebSocketShardEvents.Dispatch, (payload) => { dispatches.push(payload); check(); });
    for (const name of [WebSocketShardEvents.Ready, WebSocketShardEvents.Resumed, WebSocketShardEvents.Closed]) {
      manager.on(name, (...args) => { events.push(name === WebSocketShardEvents.Closed ? `closed:${args[0]}` : name); check(); });
    }
    await manager.connect();
  });
  after(async () => {
    try { await manager?.destroy(); } catch {}
    await w?.fake.close();
  });

  // https://discord.com/developers/docs/events/gateway#identifying
  test('identifies and receives READY, GUILD_CREATE and MESSAGE_CREATE', async () => {
    const ready = await waitForDispatch('READY');
    assert.equal(ready.d.user.id, w.app.bot_user_id);
    assert.deepEqual(ready.d.guilds, [{ id: w.guildId, unavailable: true }]);
    const gc = await waitForDispatch('GUILD_CREATE', (d) => d.id === w.guildId);
    assert.equal(gc.d.unavailable, false);
    w.c.postMessage({ channelId: w.channelId, authorId: w.alice.id, content: 'hello discord.js' });
    const msg = await waitForDispatch('MESSAGE_CREATE', (d) => d.content === 'hello discord.js');
    assert.equal(msg.d.author.id, w.alice.id);
    assert.equal(msg.d.guild_id, w.guildId);
    // The library heartbeats on its own.
    await waitFor(() => w.c.getGatewayLog({ direction: 'in' }).some((f) => f.op === OP.HEARTBEAT), 'a heartbeat from the client');
  });

  // https://discord.com/developers/docs/events/gateway#resuming
  test('resumes after a server-side close with 4000 and replays what it missed', async () => {
    const ready = await waitForDispatch('READY');
    const fromEvents = events.length;
    const resumesBefore = w.c.getGatewayLog({ direction: 'in' }).filter((f) => f.op === OP.RESUME).length;
    assert.equal(w.c.closeGatewaySession({ sessionId: ready.d.session_id, code: 4000 }).closed, 1);
    await waitForEvent('closed:4000', fromEvents);
    w.c.postMessage({ channelId: w.channelId, authorId: w.bob.id, content: 'while disconnected' });
    await waitForEvent(WebSocketShardEvents.Resumed, fromEvents);
    const missed = await waitForDispatch('MESSAGE_CREATE', (d) => d.content === 'while disconnected');
    assert.equal(missed.d.author.id, w.bob.id);
    const resumes = w.c.getGatewayLog({ direction: 'in' }).filter((f) => f.op === OP.RESUME);
    assert.equal(resumes.length, resumesBefore + 1);
    const resume = resumes.at(-1);
    assert.equal(resume.d.session_id, ready.d.session_id);
    assert.ok(resume.d.seq < missed.s, 'resumed from a sequence before the missed message');
    // Same session: no new READY.
    assert.equal(dispatches.filter((p) => p.t === 'READY').length, 1);
  });

  // https://discord.com/developers/docs/events/gateway-events#reconnect
  test('survives RECONNECT (op 7) by resuming', async () => {
    const ready = await waitForDispatch('READY');
    const fromEvents = events.length;
    const resumesBefore = w.c.getGatewayLog({ direction: 'in' }).filter((f) => f.op === OP.RESUME).length;
    assert.equal(w.c.requestGatewayReconnect({ sessionId: ready.d.session_id }).sent, 1);
    await waitForEvent(WebSocketShardEvents.Resumed, fromEvents);
    assert.equal(w.c.getGatewayLog({ direction: 'in' }).filter((f) => f.op === OP.RESUME).length, resumesBefore + 1);
    w.c.postMessage({ channelId: w.channelId, authorId: w.alice.id, content: 'after reconnect' });
    await waitForDispatch('MESSAGE_CREATE', (d) => d.content === 'after reconnect');
    assert.equal(w.c.gatewaySessions().filter((s) => s.connected).length, 1);
  });

  // https://discord.com/developers/docs/events/gateway-events#invalid-session
  test('re-identifies with a new session after a non-resumable INVALID_SESSION', async () => {
    const first = await waitForDispatch('READY');
    const from = dispatches.length;
    assert.equal(w.c.invalidateGatewaySession({ sessionId: first.d.session_id, resumable: false }).invalidated, 1);
    const second = await waitForDispatch('READY', () => true, from);
    assert.notEqual(second.d.session_id, first.d.session_id);
    await waitForDispatch('GUILD_CREATE', (d) => d.id === w.guildId, from);
    w.c.postMessage({ channelId: w.channelId, authorId: w.bob.id, content: 'new session' });
    const m = await waitForDispatch('MESSAGE_CREATE', (d) => d.content === 'new session', from);
    assert.equal(m.d.author.id, w.bob.id);
    const live = w.c.gatewaySessions();
    assert.deepEqual(live.map((s) => s.session_id), [second.d.session_id]);
  });
});
