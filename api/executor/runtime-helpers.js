import crypto from 'node:crypto';
import { safeRelativePath } from './path-safety.js';

const MIN_PORT = 1024;
const MAX_PORT = 65535;
const MAX_TIMEOUT = 45_000;
const DEFAULT_TIMEOUT = 30_000;
const MAX_BACKGROUND_PROCESSES_PER_PROJECT = 4;
const THETA_WORKSPACE = '/tmp/theta-project';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function parsePort(value, fallback = 4173) {
  if (value === undefined || value === null || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    const err = new Error(`Port must be an integer between ${MIN_PORT} and ${MAX_PORT}.`);
    err.code = 'INVALID_PORT';
    throw err;
  }
  return port;
}

function processKey(name) {
  return crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, 24);
}

function projectKey(projectId) {
  return crypto.createHash('sha256').update(String(projectId)).digest('hex').slice(0, 24);
}

async function startManagedBackground(client, command, name, projectId) {
  const key = processKey(name);
  const project = projectKey(projectId);
  const pidFile = `/tmp/theta-bg-${project}-${key}.pid`;
  const metaFile = `/tmp/theta-bg-${project}-${key}.meta`;
  const lockDir = `/tmp/theta-bg-${project}-lock`;
  const inner = `echo $$ > ${shellQuote(pidFile)}; printf '%s' ${shellQuote(name)} > ${shellQuote(metaFile)}; bash -lc ${shellQuote(command)}; code=$?; rm -f ${pidFile} ${metaFile}; exit $code`;
  const wrapper = `if mkdir ${shellQuote(lockDir)} 2>/dev/null; then trap 'rmdir ${lockDir} 2>/dev/null || true' EXIT; if [ -f ${shellQuote(pidFile)} ]; then existing=$(cat ${shellQuote(pidFile)} 2>/dev/null || true); if [ -n "$existing" ] && kill -0 "$existing" 2>/dev/null; then echo 'THETA_BACKGROUND_NAME_BUSY'; exit 0; fi; rm -f ${shellQuote(pidFile)} ${shellQuote(metaFile)}; fi; count=0; for f in /tmp/theta-bg-${project}-*.meta; do [ -f "$f" ] || continue; pidFile="\${f%.meta}.pid"; if [ -f "$pidFile" ]; then p=$(cat "$pidFile" 2>/dev/null || true); else p=''; fi; if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then count=$((count+1)); else rm -f "$f" "$pidFile"; fi; done; if [ "$count" -ge ${MAX_BACKGROUND_PROCESSES_PER_PROJECT} ]; then echo 'THETA_BACKGROUND_LIMIT'; exit 0; fi; else echo 'THETA_BACKGROUND_LOCK_BUSY'; exit 0; fi; setsid bash -lc ${shellQuote(inner)} >/dev/null 2>&1 & echo $!`;
  const result = String(await client.commands.run(wrapper) ?? '').trim();
  if (result.includes('THETA_BACKGROUND_LIMIT')) {
    const err = new Error(`A project may run at most ${MAX_BACKGROUND_PROCESSES_PER_PROJECT} background processes.`);
    err.code = 'EXECUTOR_BACKGROUND_LIMIT';
    throw err;
  }
  if (result.includes('THETA_BACKGROUND_NAME_BUSY')) {
    const err = new Error(`A background process named "${name}" is already running for this project.`);
    err.code = 'EXECUTOR_BACKGROUND_NAME_BUSY';
    throw err;
  }
  if (result.includes('THETA_BACKGROUND_LOCK_BUSY')) {
    const err = new Error('Another background-process operation is in progress for this project. Please retry shortly.');
    err.code = 'EXECUTOR_BACKGROUND_LOCK_BUSY';
    err.retryAfter = 1;
    throw err;
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const check = String(await client.commands.run(`test -s ${shellQuote(pidFile)} && test -s ${shellQuote(metaFile)} && printf ready || printf pending`) ?? '').trim();
    if (check === 'ready') return { name, pidFile, metaFile };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const err = new Error('Background process failed to initialize.');
  err.code = 'EXECUTOR_BACKGROUND_START_FAILED';
  throw err;
}

async function stopManagedBackground(client, name, projectId) {
  const pidFile = `/tmp/theta-bg-${projectKey(projectId)}-${processKey(name)}.pid`;
  return client.commands.run(`if [ -f ${shellQuote(pidFile)} ]; then pid=$(cat ${shellQuote(pidFile)} 2>/dev/null || true); if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then kill -TERM -- -$pid 2>/dev/null || kill -TERM $pid 2>/dev/null || true; fi; rm -f ${shellQuote(pidFile)} ${shellQuote(pidFile.replace('.pid', '.meta'))}; fi`);
}

async function findAvailablePort(client, preferred = 4173) {
  const candidates = [preferred, ...Array.from({ length: 50 }, (_, i) => 49152 + ((preferred + i * 37) % 1000))];
  const used = new Set(String(await client.commands.run(`ss -ltnH 2>/dev/null | awk '{print $4}' | sed 's/.*://' || true`) ?? '').split(/\s+/).map(Number).filter(Boolean));
  for (const port of candidates) if (port >= MIN_PORT && port <= MAX_PORT && !used.has(port)) return port;
  throw new Error('No available preview port was found.');
}

async function syncFiles(client, files, deletedPaths = [], workspace = THETA_WORKSPACE) {
  const normalized = Array.isArray(files) ? files : [];
  const manifestPath = `${workspace}/.theta-manifest.json`;
  let previous = {};
  try {
    const raw = String(await client.commands.run(`cat ${shellQuote(manifestPath)} 2>/dev/null || printf '{}'`) ?? '{}');
    previous = JSON.parse(raw || '{}');
  } catch { previous = {}; }

  const next = { ...previous };
  const toWrite = [];
  for (const file of normalized) {
    const content = String(file.content ?? '');
    const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    next[file.path] = hash;
    if (previous[file.path] !== hash) toWrite.push(file);
  }
  const deleted = Array.isArray(deletedPaths)
    ? deletedPaths.filter((path) => typeof path === 'string' && path.length > 0).map((path) => safeRelativePath(path))
    : [];
  for (const path of deleted) delete next[path];

  const stage = `${workspace}/.theta-stage-${crypto.randomUUID()}`;
  const backup = `${stage}/.theta-backup`;
  await client.commands.run(`mkdir -p ${shellQuote(stage)} ${shellQuote(backup)}`);
  try {
    let commands = [];
    let bytes = 0;
    const flush = async () => {
      if (!commands.length) return;
      await client.commands.run(commands.join(' && '));
      commands = [];
      bytes = 0;
    };
    for (const file of toWrite) {
      const encoded = Buffer.from(String(file.content ?? ''), 'utf8').toString('base64');
      const target = `${stage}/${file.path}`;
      const command = `mkdir -p $(dirname ${shellQuote(target)}) && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(target)}`;
      const commandBytes = Buffer.byteLength(command, 'utf8');
      if (commands.length && bytes + commandBytes > 700_000) await flush();
      commands.push(command);
      bytes += commandBytes;
    }
    await flush();

    const manifest = Buffer.from(JSON.stringify(next), 'utf8').toString('base64');
    const stagedManifest = `${stage}/.theta-manifest.json`;
    await client.commands.run(`printf %s ${shellQuote(manifest)} | base64 -d > ${shellQuote(stagedManifest)}`);

    const affectedPaths = [...new Set([...toWrite.map((file) => file.path), ...deleted])];
    const backupCommands = affectedPaths.map((path) => {
      const target = `${workspace}/${path}`;
      const saved = `${backup}/${path}`;
      return `if [ -e ${shellQuote(target)} ] || [ -L ${shellQuote(target)} ]; then mkdir -p $(dirname ${shellQuote(saved)}) && cp -a ${shellQuote(target)} ${shellQuote(saved)}; fi`;
    });
    if (backupCommands.length) await client.commands.run(backupCommands.join(' && '));

    const commitCommands = [];
    for (const file of toWrite) {
      const source = `${stage}/${file.path}`;
      const target = `${workspace}/${file.path}`;
      commitCommands.push(`mkdir -p $(dirname ${shellQuote(target)}) && cp ${shellQuote(source)} ${shellQuote(target)}`);
    }
    for (const path of deleted) commitCommands.push(`rm -f ${shellQuote(`${workspace}/${path}`)}`);
    commitCommands.push(`mv ${shellQuote(stagedManifest)} ${shellQuote(manifestPath)}`);

    try {
      if (commitCommands.length) await client.commands.run(commitCommands.join(' && '));
    } catch (commitError) {
      const rollbackCommands = affectedPaths.map((path) => {
        const target = `${workspace}/${path}`;
        const saved = `${backup}/${path}`;
        return `rm -rf ${shellQuote(target)}; if [ -e ${shellQuote(saved)} ] || [ -L ${shellQuote(saved)} ]; then mkdir -p $(dirname ${shellQuote(target)}) && cp -a ${shellQuote(saved)} ${shellQuote(target)}; fi`;
      });
      try {
        if (rollbackCommands.length) await client.commands.run(rollbackCommands.join(' && '));
      } catch (rollbackError) {
        const err = new Error(`File sync commit failed and rollback also failed: ${commitError?.message || commitError}`);
        err.code = 'EXECUTOR_SYNC_ROLLBACK_FAILED';
        err.cause = rollbackError;
        throw err;
      }
      const err = new Error(`File sync commit failed; all changes were rolled back: ${commitError?.message || commitError}`);
      err.code = 'EXECUTOR_SYNC_ROLLED_BACK';
      throw err;
    }

    for (const path of deleted) {
      const target = `${workspace}/${path}`;
      const parent = target.replace(/\/[^\/]*$/, '');
      await client.commands.run(`d=${shellQuote(parent)}; while [ "$d" != ${shellQuote(workspace)} ] && [ "$d" != / ] && [ -d "$d" ]; do rmdir "$d" 2>/dev/null || break; d=$(dirname "$d"); done`);
    }
  } finally {
    try { await client.commands.run(`rm -rf ${shellQuote(stage)}`); } catch {}
  }
}

async function runCommandWithStatus(client, command, timeoutMs = DEFAULT_TIMEOUT, persistCwd = false) {
  const id = `theta-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const out = `/tmp/${id}.out`;
  const err = `/tmp/${id}.err`;
  const timeoutMarker = `/tmp/${id}.timedout`;
  const pidFile = `/tmp/${id}.pid`;
  const seconds = Math.max(1, Math.ceil(Math.min(timeoutMs, MAX_TIMEOUT) / 1000));
  const cwdFile = '/tmp/theta-terminal-cwd';
  const terminalScript = persistCwd
    ? `cd "$(cat ${cwdFile} 2>/dev/null || pwd)" 2>/dev/null || cd "$(pwd)"; ${command}; code=$?; pwd > ${cwdFile}; exit $code`
    : command;
  const wrapper = `set +e; rm -f ${shellQuote(timeoutMarker)}; setsid bash -lc ${shellQuote(terminalScript)} > ${shellQuote(out)} 2> ${shellQuote(err)} & pid=$!; echo $pid > ${shellQuote(pidFile)}; (sleep ${seconds}; if kill -0 $pid 2>/dev/null; then printf '1' > ${shellQuote(timeoutMarker)}; kill -- -$pid 2>/dev/null || true; fi) & watchdog=$!; wait $pid; code=$?; kill $watchdog 2>/dev/null || true; rm -f ${shellQuote(pidFile)}; printf '__THETA_EXIT__%s\n' "$code"`;
  let wrapperOutput = '';
  try { wrapperOutput = String(await client.commands.run(wrapper) ?? ''); }
  catch (error) { return { success: false, stdout: '', stderr: error?.message || String(error), exitCode: null, timedOut: false, error: error?.message || String(error), pidFile }; }
  let stdout = '', stderr = '';
  try { stdout = String(await client.commands.run(`cat ${shellQuote(out)} 2>/dev/null || true`) ?? ''); } catch {}
  try { stderr = String(await client.commands.run(`cat ${shellQuote(err)} 2>/dev/null || true`) ?? ''); } catch {}
  let timedOut = false;
  try { timedOut = String(await client.commands.run(`test -f ${shellQuote(timeoutMarker)} && printf 1 || printf 0`) ?? '').trim() === '1'; } catch {}
  const match = wrapperOutput.match(/__THETA_EXIT__(\d+)/);
  const exitCode = match ? Number(match[1]) : null;
  try { await client.commands.run(`rm -f ${shellQuote(out)} ${shellQuote(err)} ${shellQuote(timeoutMarker)} ${shellQuote(pidFile)}`); } catch {}
  return { success: exitCode === 0 && !timedOut, stdout, stderr, exitCode, timedOut, error: timedOut ? `Command timed out after ${Math.min(timeoutMs, MAX_TIMEOUT)}ms.` : (exitCode === null ? 'Could not determine command exit status.' : undefined), pidFile };
}

export { parsePort, processKey, projectKey, startManagedBackground, stopManagedBackground, findAvailablePort, syncFiles, runCommandWithStatus };