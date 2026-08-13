import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { parsePort, syncFiles, runCommandWithStatus, startManagedBackground, stopManagedBackground, findAvailablePort } from './runtime-helpers.js';

const execAsync = promisify(exec);

function fakeClient(cwd) {
  return { commands: { run: async (command) => (await execAsync(command, { cwd, shell: '/bin/bash', maxBuffer: 4 * 1024 * 1024 })).stdout } };
}

test('syncFiles stages all writes before touching the live workspace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'theta-sync-'));
  const workspace = path.join(root, 'project');
  const calls = [];
  const client = { commands: { run: async (command) => {
    calls.push(command);
    if (command.includes('.theta-stage-') && command.includes('second.txt')) throw new Error('simulated second stage batch failure');
    return (await execAsync(command, { shell: '/bin/bash', maxBuffer: 4 * 1024 * 1024 })).stdout;
  } } };
  await assert.rejects(() => syncFiles(client, [
    { path: 'first.txt', content: 'a'.repeat(400_000) },
    { path: 'second.txt', content: 'b'.repeat(400_000) },
  ], [], workspace));
  await assert.rejects(() => fs.access(path.join(workspace, 'first.txt')));
  await assert.rejects(() => fs.access(path.join(workspace, 'second.txt')));
  assert.equal(calls.some(c => c.includes('.theta-manifest.json') && c.includes('mv')), false);
  await fs.rm(root, { recursive: true, force: true });
});

test('runCommandWithStatus reports watchdog termination explicitly', async () => {
  const client = fakeClient('/tmp');
  const result = await runCommandWithStatus(client, 'sleep 3', 1000);
  assert.equal(result.timedOut, true);
  assert.equal(result.success, false);
  assert.match(result.error, /timed out/i);
});

test('parsePort rejects invalid preview ports and accepts the valid range', () => {
  assert.equal(parsePort(undefined), 4173);
  assert.equal(parsePort('1024'), 1024);
  assert.equal(parsePort(65535), 65535);
  assert.throws(() => parsePort(1023), /between 1024 and 65535/);
  assert.throws(() => parsePort(65536), /between 1024 and 65535/);
  assert.throws(() => parsePort('not-a-port'), /between 1024 and 65535/);
});


test('behavior preview allocation does not reuse the default preview port', async () => {
  const client = { commands: { run: async () => '' } };
  assert.equal(await findAvailablePort(client, 49152), 49152);
});

test('managed process stop targets the exact project/name PID rather than a substring', async () => {
  const client = fakeClient('/tmp');
  const project = `test-project-${Date.now()}-${Math.random()}`;
  const one = `theta-exact-${Date.now()}`;
  const two = `${one}-suffix`;
  await startManagedBackground(client, 'sleep 20', one, project);
  await startManagedBackground(client, 'sleep 20', two, project);
  await stopManagedBackground(client, one, project);
  await new Promise(r => setTimeout(r, 100));
  const pidOne = await fs.readFile(`/tmp/theta-bg-${(await import('node:crypto')).createHash('sha256').update(project).digest('hex').slice(0,24)}-${(await import('node:crypto')).createHash('sha256').update(one).digest('hex').slice(0,24)}.pid`, 'utf8').catch(() => '');
  assert.equal(pidOne, '');
  const projectKey = (await import('node:crypto')).createHash('sha256').update(project).digest('hex').slice(0,24);
  const nameKey = (await import('node:crypto')).createHash('sha256').update(two).digest('hex').slice(0,24);
  const pid = Number(await fs.readFile(`/tmp/theta-bg-${projectKey}-${nameKey}.pid`, 'utf8'));
  assert.ok(pid > 0);
  process.kill(pid, 0);
  process.kill(pid, 'SIGTERM');
  await new Promise(r => setTimeout(r, 100));
  await fs.rm(`/tmp/theta-bg-${projectKey}-lock`, { recursive: true, force: true }).catch(() => {});
  await fs.rm(`/tmp/theta-bg-${projectKey}-${nameKey}.pid`, { force: true }).catch(() => {});
  await fs.rm(`/tmp/theta-bg-${projectKey}-${nameKey}.meta`, { force: true }).catch(() => {});
});


test('managed background process names cannot be silently reused', async () => {
  const client = fakeClient('/tmp');
  const project = `name-project-${Date.now()}-${Math.random()}`;
  const name = `theta-name-${Date.now()}`;
  try {
    await startManagedBackground(client, 'sleep 20', name, project);
    await assert.rejects(() => startManagedBackground(client, 'sleep 20', name, project), /already running/);
  } finally {
    await stopManagedBackground(client, name, project).catch(() => {});
  }
});

test('managed background processes enforce the per-project cap', async () => {
  const client = fakeClient('/tmp');
  const project = `cap-project-${Date.now()}-${Math.random()}`;
  const names = Array.from({ length: 4 }, (_, i) => `theta-cap-${i}-${Date.now()}`);
  try {
    for (const name of names) await startManagedBackground(client, 'sleep 20', name, project);
    await assert.rejects(() => startManagedBackground(client, 'sleep 20', `theta-cap-over-${Date.now()}`, project), /at most 4/);
  } finally {
    const projectKey = (await import('node:crypto')).createHash('sha256').update(project).digest('hex').slice(0,24);
    for (const name of names) {
      await stopManagedBackground(client, name, project).catch(() => {});
      const nameKey = (await import('node:crypto')).createHash('sha256').update(name).digest('hex').slice(0,24);
      await fs.rm(`/tmp/theta-bg-${projectKey}-${nameKey}.pid`, { force: true }).catch(() => {});
      await fs.rm(`/tmp/theta-bg-${projectKey}-${nameKey}.meta`, { force: true }).catch(() => {});
    }
    await fs.rm(`/tmp/theta-bg-${projectKey}-lock`, { recursive: true, force: true }).catch(() => {});
  }
});
