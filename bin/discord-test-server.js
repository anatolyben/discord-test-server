#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createFakeDiscord } from '../src/index.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string', short: 'p', default: '8787' },
    host: { type: 'string', default: '127.0.0.1' },
    demo: { type: 'boolean', default: false },
    clock: { type: 'string', default: 'real' },
    seed: { type: 'string', default: '1' },
    'oauth-mode': { type: 'string', default: 'auto' },
    'heartbeat-ms': { type: 'string' },
    'no-rate-limits': { type: 'boolean', default: false },
    verbose: { type: 'boolean', short: 'v', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`discord-test-server – a fake Discord for local tests

Usage: discord-test-server [--port 8787] [--demo] [--clock real|manual] [--seed 1]
                           [--oauth-mode auto|consent] [--heartbeat-ms 41250] [--no-rate-limits] [--verbose] [--json]

  --demo       seed two guilds, an owner, a moderator, members, channels, a quarantine role and a SKU
  --json       print the URLs and demo ids as one JSON line (for scripts)
  --verbose    print every REST request and gateway dispatch`);
  process.exit(0);
}

const fake = await createFakeDiscord({
  port: Number(values.port),
  host: values.host,
  clock: values.clock,
  seed: Number(values.seed),
  demo: values.demo,
  oauth: { mode: values['oauth-mode'] },
  gateway: values['heartbeat-ms'] ? { heartbeatIntervalMs: Number(values['heartbeat-ms']) } : undefined,
  rateLimits: values['no-rate-limits'] ? false : undefined,
  // Contract-test red check (scripts/verify-red.js): DTS_STUB=1 stubs every Discord-facing handler.
  stub: process.env.DTS_STUB === '1',
});

const info = {
  restUrl: fake.restUrl, apiUrl: fake.apiUrl, gatewayUrl: fake.gatewayUrl, oauthUrl: fake.oauthUrl,
  cdnUrl: fake.cdnUrl, controlUrl: fake.controlUrl,
};

if (values.json) {
  console.log(JSON.stringify({ ...info, demo: fake.demo }));
} else {
  console.log(`discord-test-server listening on ${fake.url}
  REST     ${fake.restUrl}      (discord.js: rest.api = ${fake.apiUrl})
  Gateway  ${fake.gatewayUrl}
  OAuth2   ${fake.oauthUrl}/authorize
  CDN      ${fake.cdnUrl}
  Control  ${fake.controlUrl}          (GET /_fake for the method list)`);
  if (fake.demo) {
    const d = fake.demo;
    console.log(`
Demo world
  ModBot    app ${d.applications.modbot.id}  token ${d.applications.modbot.token}
            client secret ${d.applications.modbot.client_secret}
  OtherBot  app ${d.applications.otherApp.id}  token ${d.applications.otherApp.token}
  Users     owner ${d.users.owner.id}, moderator ${d.users.moderator.id}, alice ${d.users.alice.id}, bob ${d.users.bob.id}, spammer ${d.users.spammer.id}`);
    for (const g of d.guilds) {
      console.log(`  Guild     ${g.name} ${g.id}  #general ${g.systemChannelId}  #mod-log ${g.modLogChannelId}  quarantine role ${g.roles.quarantine}  invite ${g.inviteCode}`);
    }
    console.log(`  SKU       ${d.sku.name} ${d.sku.id}`);
  }
}

if (values.verbose) {
  let lastReq = 0;
  let lastFrame = 0;
  setInterval(() => {
    for (const e of fake.control.getRequestLog({ since: lastReq })) {
      lastReq = e.seq;
      console.log(`HTTP ${e.method} ${e.path} -> ${e.status}${e.fault ? ` [${e.fault}]` : ''}`);
    }
    for (const f of fake.control.getGatewayLog({ since: lastFrame })) {
      lastFrame = f.seq;
      if (f.t || f.op !== 11) console.log(`WS   ${f.direction} ${f.application_id ?? '-'} ${f.t ?? `op ${f.op}`}`);
    }
  }, 250).unref();
}

const shutdown = async () => { await fake.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
