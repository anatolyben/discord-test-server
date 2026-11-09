#!/usr/bin/env node
// Runs the contract tests twice:
//   1. against the real handlers  -> every test must pass (green)
//   2. against stubbed handlers   -> every test must fail (red)
// A test that passes against the stub proves nothing, so it is reported and the script exits 1.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => path.join('test', f));
const only = process.argv.slice(2);
const targets = only.length ? only : files;

function run(stub) {
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...targets], {
    cwd: root, env: { ...process.env, DTS_STUB: stub ? '1' : '0' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return parseTap(r.stdout);
}

// Collect leaf test results as "file > suite > test".
function parseTap(out) {
  const results = [];
  const stack = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(\s*)(not ok|ok) \d+ - (.*?)(\s+#\s*(SKIP|TODO).*)?$/);
    if (m) {
      const depth = m[1].length / 4;
      stack.length = depth;
      results.push({ depth, ok: m[2] === 'ok', name: m[3], skip: !!m[5] });
      continue;
    }
    const s = line.match(/^(\s*)# Subtest: (.*)$/);
    if (s) {
      const depth = s[1].length / 4;
      stack.length = depth;
      stack[depth] = s[2];
    }
  }
  // Leaves: a result is a leaf if the next result is not deeper (TAP prints children before the parent).
  const leaves = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const prev = results[i - 1];
    const isParent = prev && prev.depth > r.depth;
    if (!isParent && !r.skip) leaves.push(r);
  }
  return leaves;
}

const green = run(false);
const red = run(true);
const failingGreen = green.filter((t) => !t.ok);
const passingRed = red.filter((t) => t.ok);

console.log(`real handlers : ${green.length - failingGreen.length}/${green.length} passed`);
console.log(`stub handlers : ${red.length - passingRed.length}/${red.length} failed (expected all)`);
if (failingGreen.length) console.log(`\nFailing against the real server:\n${failingGreen.map((t) => `  - ${t.name}`).join('\n')}`);
if (passingRed.length) console.log(`\nPassing against the stub (not proving anything):\n${passingRed.map((t) => `  - ${t.name}`).join('\n')}`);
process.exit(failingGreen.length || passingRed.length || !green.length ? 1 : 0);
