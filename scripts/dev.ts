#!/usr/bin/env bun
import { dirname, join } from 'node:path';

/**
 * Run the API and the dashboard together.
 *
 * Both are spawned with the **repository root** as their working directory.
 * `bun run --filter '*' dev` runs each workspace script in its own directory,
 * which meant the backend never saw the root `.env`, silently fell back to the
 * default `file:./ota.db`, and created an empty `backend/ota.db`. The failure
 * only surfaced later as "no such table: admins".
 *
 * Bun's script shell has no background operator (`&`), so this does the
 * supervising itself.
 */
const repoRoot = dirname(import.meta.dir);

/**
 * Only the API needs the repo root — it is the cwd-sensitive one, because Bun
 * loads `.env` from cwd. Vite resolves its own root, config and dependencies
 * relative to itself, so it runs from `dashboard/` as normal.
 */
const targets = [
  {
    name: 'api',
    cmd: ['bun', '--hot', join('backend', 'src', 'server.ts')],
    cwd: repoRoot,
    colour: '\x1b[36m',
  },
  {
    name: 'web',
    cmd: ['bun', 'x', 'vite'],
    cwd: join(repoRoot, 'dashboard'),
    colour: '\x1b[35m',
  },
] as const;

const RESET = '\x1b[0m';
const children: Bun.Subprocess[] = [];

function prefixStream(stream: ReadableStream<Uint8Array>, name: string, colour: string) {
  const label = `${colour}${name.padEnd(3)}${RESET} `;
  void (async () => {
    const decoder = new TextDecoder();
    let carry = '';
    for await (const chunk of stream) {
      carry += decoder.decode(chunk, { stream: true });
      const lines = carry.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) console.log(label + line);
    }
    if (carry) console.log(label + carry);
  })();
}

for (const target of targets) {
  const child = Bun.spawn(target.cmd, {
    cwd: target.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  children.push(child);
  prefixStream(child.stdout as ReadableStream<Uint8Array>, target.name, target.colour);
  prefixStream(child.stderr as ReadableStream<Uint8Array>, target.name, target.colour);
}

function shutdown() {
  for (const child of children) child.kill();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// If either process dies, take the other down rather than leaving half a dev
// environment running and looking healthy.
const exited = await Promise.race(children.map((child) => child.exited));
for (const child of children) child.kill();
process.exit(exited ?? 0);
