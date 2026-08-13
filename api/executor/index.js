import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import { CodeSandbox } from '@codesandbox/sdk';
import { MAX_FILES, MAX_FILE_BYTES, safeFiles } from './path-safety.js';
import { parsePort, syncFiles, runCommandWithStatus, startManagedBackground, stopManagedBackground, findAvailablePort } from './runtime-helpers.js';

const DEFAULT_TIMEOUT = 30_000;
// vercel.json caps this whole function at maxDuration: 60 (documented in DEPLOY.md as the
// safe value for every Vercel plan, including Hobby). MAX_TIMEOUT bounds how long any single
// wrapped/watchdog'd command is allowed to run — it must stay safely UNDER that 60s wall
// clock, not just under some larger number, because the sandbox-connect, file-sync, and
// output-read calls that happen before/after the timed command in the SAME request also eat
// into that budget. This used to be 180_000 (3x the actual function budget), and the
// 'behavior' action's own default (90_000) was 1.5x over budget before even reaching this
// clamp — so any run_tests/run_command/run_behavior_check whose command took anywhere near a
// minute got silently killed by Vercel's platform-level cutoff (a bare 504, no JSON) instead
// of hitting the graceful timeout path below. 45s leaves ~15s of headroom in the 60s budget.
const MAX_TIMEOUT = 45_000;
const THETA_WORKSPACE = '/tmp/theta-project';

const REQUEST_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;
const MAX_CONCURRENT_PER_USER = 2;
async function enforceServerRateLimit(supabase, userId) {
  // This limiter must be distributed. A per-instance fallback is not a valid
  // security boundary on serverless infrastructure, so fail closed if the
  // atomic database limiter cannot be reached.
  let data;
  let error;
  try {
    ({ data, error } = await supabase.rpc('acquire_execution_rate_limit', {
      p_user_id: userId,
      p_window_seconds: 60,
      p_max_requests: MAX_REQUESTS_PER_WINDOW,
      p_max_concurrent: MAX_CONCURRENT_PER_USER,
    }));
  } catch (rpcError) {
    error = rpcError;
  }
  if (error || !data) {
    const err = new Error('Execution rate limiter is temporarily unavailable. Please retry shortly.');
    err.code = 'EXECUTOR_RATE_LIMIT_UNAVAILABLE';
    err.retryAfter = 5;
    throw err;
  }
  if (!data.allowed) {
    const retryAfter = Math.max(1, Number(data.retry_after) || 1);
    const code = data.reason === 'concurrency' ? 'EXECUTOR_CONCURRENCY_LIMIT' : 'EXECUTOR_RATE_LIMIT';
    const message = code === 'EXECUTOR_CONCURRENCY_LIMIT'
      ? 'Too many concurrent execution requests for this account.'
      : `Execution rate limit reached. Retry in about ${retryAfter}s.`;
    const err = new Error(message);
    err.code = code;
    err.retryAfter = retryAfter;
    throw err;
  }
  return async () => {
    try { await supabase.rpc('release_execution_rate_limit', { p_user_id: userId }); } catch (releaseError) {
      console.warn('[Theta Executor] Failed to release distributed execution slot.', releaseError?.message || releaseError);
    }
  };
}

function json(res, status, body) { return res.status(status).json(body); }
function config() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
  const anon = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
  const key = process.env.CODESANDBOX_API_KEY || process.env.CSB_API_KEY || '';
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return { url, anon, key, serviceRole };
}

async function authUser(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new Error('Missing Supabase access token.');
  const cfg = config();
  if (!cfg.url || !cfg.anon) throw new Error('Server Supabase configuration is missing.');
  const authClient = createClient(cfg.url, cfg.anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data?.user) throw new Error('Your session is invalid or expired.');

  // The access-token client is used for caller authentication. Project ownership
  // lookups use the server-only service-role client when available so a missing
  // or stale client-side RLS policy cannot make a valid owned project appear to
  // be missing. The service-role key is NEVER sent to the browser.
  const dataClient = cfg.serviceRole
    ? createClient(cfg.url, cfg.serviceRole, { auth: { persistSession: false, autoRefreshToken: false } })
    : authClient;
  return { user: data.user, supabase: dataClient }; 
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function projectRow(supabase, userId, projectId) {
  const { data, error } = await supabase
    .from('projects')
    .select('id, user_id, execution_sandbox_id')
    .eq('id', projectId)
    .eq('user_id', userId)
    .single();
  if (error || !data) throw new Error('Project not found or not owned by the current user.');
  return data;
}

async function getSandbox(sdk, sandboxId) {
  if (!sandboxId) return null;
  // Only an explicit not-found response means the sandbox is gone. Network,
  // authentication, quota, and other transient SDK failures must propagate so
  // ensureSandbox never creates a replacement and orphans a live sandbox.
  try {
    return await sdk.sandboxes.resume(sandboxId);
  } catch (error) {
    const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
    const code = String(error?.code ?? error?.errorCode ?? '').toLowerCase();
    const message = String(error?.message ?? '').toLowerCase();
    const notFound = status === 404 || code === 'not_found' || code === 'sandbox_not_found' || /sandbox.*not.?found/.test(message);
    if (notFound) return null;
    throw error;
  }
}

async function ensureSandbox(sdk, supabase, userId, projectId) {
  const project = await projectRow(supabase, userId, projectId);
  let sandbox = await getSandbox(sdk, project.execution_sandbox_id);
  if (sandbox) return sandbox;

  const lock = await supabase.rpc('acquire_execution_sandbox_lock', {
    p_project_id: projectId,
    p_user_id: userId,
    p_lock_token: crypto.randomUUID(),
    p_stale_after_seconds: 120,
  });
  if (lock.error || !lock.data?.acquired) {
    const err = new Error('Another request is initializing this project execution environment. Please retry shortly.');
    err.code = 'EXECUTOR_SANDBOX_INIT_BUSY';
    err.retryAfter = 2;
    throw err;
  }

  const lockToken = lock.data.lock_token;
  try {
    // Re-read after claiming the lock: another request may have completed the
    // initialization immediately before this request acquired the lease.
    const lockedProject = await projectRow(supabase, userId, projectId);
    sandbox = await getSandbox(sdk, lockedProject.execution_sandbox_id);
    if (sandbox) return sandbox;

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        sandbox = await sdk.sandboxes.create();
        if (sandbox) break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
    if (!sandbox) throw new Error(`CodeSandbox could not create an execution environment after 3 attempts${lastError ? `: ${lastError.message || lastError}` : '.'}`);
    const { error } = await supabase
      .from('projects')
      .update({ execution_sandbox_id: sandbox.id, updated_at: new Date().toISOString() })
      .eq('id', projectId).eq('user_id', userId);
    if (error) {
      try { await sdk.sandboxes.delete?.(sandbox.id); } catch {}
      throw error;
    }
    return sandbox;
  } finally {
    try { await supabase.rpc('release_execution_sandbox_lock', { p_project_id: projectId, p_user_id: userId, p_lock_token: lockToken }); } catch (error) {
      console.warn('[Theta Executor] Failed to release sandbox initialization lock.', error?.message || error);
    }
  }
}

async function connectProject(sdk, supabase, userId, projectId) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const sandbox = await ensureSandbox(sdk, supabase, userId, projectId);
      const client = await sandbox.connect();
      return { sandbox, client };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw new Error(`CodeSandbox execution environment unavailable after 3 connection attempts: ${lastError?.message || lastError || 'unknown error'}`);
}


async function commandPlan(client, files) {
  const names = files.map(f => f.path.toLowerCase());
  let pkg = files.find(f => f.path.toLowerCase() === 'package.json');
  if (!pkg) {
    try {
      const raw = String(await client.commands.run(`cat ${shellQuote(`${THETA_WORKSPACE}/package.json`)} 2>/dev/null || printf ''`) ?? '');
      if (raw.trim()) pkg = { path: 'package.json', content: raw };
    } catch {}
  }
  if (pkg) {
    try {
      const scripts = JSON.parse(pkg.content).scripts || {};
      if (scripts.test && !/no test specified/i.test(String(scripts.test))) return ['npm install --no-audit --no-fund', 'npm test'];
      if (scripts.build) return ['npm install --no-audit --no-fund', 'npm run build'];
      return ['npm install --no-audit --no-fund'];
    } catch { return ['npm install --no-audit --no-fund']; }
  }
  let sandboxNames = names;
  if (!sandboxNames.length) {
    try { sandboxNames = String(await client.commands.run(`find ${shellQuote(THETA_WORKSPACE)} -type f -not -path '*/node_modules/*' -printf '%P\n' 2>/dev/null || true`) ?? '').split('\n').filter(Boolean).map(f => f.toLowerCase()); } catch {}
  }
  const py = sandboxNames.filter(f => /\.py$/i.test(f));
  if (py.length) return [`(${py.map(f => `python3 -m py_compile ${shellQuote(f)}`).join(' && ')})`];
  const ts = sandboxNames.filter(f => /\.(ts|tsx)$/i.test(f));
  if (ts.length) return ['npx --yes typescript@5.5.4 tsc --noEmit --skipLibCheck'];
  const js = sandboxNames.filter(f => /\.(js|mjs|cjs|jsx)$/i.test(f));
  if (js.length) return [`(${js.map(f => `node --check ${shellQuote(f)}`).join(' && ')})`];
  return [];
}

async function runTest(client, files, deletedPaths, timeoutMs) {
  await syncFiles(client, files, deletedPaths);
  const commands = await commandPlan(client, files);
  if (!commands.length) return { success: true, stdout: 'No runnable/compilable test command was needed.', stderr: '', exitCode: 0, commandsRun: [], durationMs: 0, executor: 'codesandbox' };
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  for (const command of commands) {
    const result = await runCommandWithStatus(client, `cd ${shellQuote(THETA_WORKSPACE)} && ${command}`, timeoutMs);
    stdout += result.stdout || '';
    stderr += result.stderr || '';
    if (!result.success) {
      return { success: false, stdout, stderr, exitCode: result.exitCode, commandsRun: commands, durationMs: Date.now() - started, error: result.error || `Command failed with exit code ${result.exitCode}.`, executor: 'codesandbox' };
    }
    if (Date.now() - started > timeoutMs) return { success: false, stdout, stderr, exitCode: null, commandsRun: commands, durationMs: Date.now() - started, error: 'Execution timed out.', executor: 'codesandbox' };
  }
  return { success: true, stdout, stderr, exitCode: 0, commandsRun: commands, durationMs: Date.now() - started, executor: 'codesandbox' };
}

async function runBehavior(client, files, deletedPaths, acceptanceCriteria, timeoutMs) {
  await syncFiles(client, files, deletedPaths);
  let names = files.map(f => f.path.toLowerCase());
  if (!names.length) {
    try { names = String(await client.commands.run(`find ${shellQuote(THETA_WORKSPACE)} -type f -not -path '*/node_modules/*' -printf '%P\n' 2>/dev/null || true`) ?? '').split('\n').filter(Boolean).map(f => f.toLowerCase()); } catch {}
  }
  let pkg = files.find(f => f.path.toLowerCase() === 'package.json');
  if (!pkg) { try { const raw = String(await client.commands.run(`cat ${shellQuote(`${THETA_WORKSPACE}/package.json`)} 2>/dev/null || printf ''`) ?? ''); if (raw.trim()) pkg = { path: 'package.json', content: raw }; } catch {} }
  if (!pkg || !names.some(n => n === 'index.html' || n.endsWith('/index.html'))) {
    return { success: true, servable: false, consoleErrors: [], pageErrors: [], interactions: [], note: 'No browser entry point detected.', executor: 'codesandbox' };
  }
  const started = Date.now();
  const packageJson = JSON.parse(pkg.content);
  const scripts = packageJson.scripts || {};
  const port = await findAvailablePort(client, 49152);
  const install = await client.commands.run(`cd ${THETA_WORKSPACE} && npm install --no-audit --no-fund`);
  if (Date.now() - started > timeoutMs) throw new Error('Behavior check timed out during npm install.');
  // Install the browser dependency inside the isolated sandbox, not in Theta itself.
  await client.commands.run(`cd ${THETA_WORKSPACE} && npm install --no-save playwright --no-audit --no-fund`);
  await client.commands.run(`cd ${THETA_WORKSPACE} && npx playwright install chromium`);
  let serveCommand;
  if (scripts.dev) {
    serveCommand = `cd ${THETA_WORKSPACE} && npm run dev -- --host 0.0.0.0 --port ${port}`;
  } else if (scripts.start) {
    serveCommand = `cd ${THETA_WORKSPACE} && PORT=${port} npm start`;
  } else {
    serveCommand = `cd ${THETA_WORKSPACE} && python3 -m http.server ${port} --bind 0.0.0.0`;
  }
  const server = await client.commands.runBackground(serveCommand, { name: `theta-preview-${Date.now()}` });
  await client.ports.waitForPort(port);
  const browserScript = `const { chromium } = require('playwright'); (async()=>{const b=await chromium.launch({headless:true});const p=await b.newPage();const errors=[];p.on('pageerror',e=>errors.push(String(e)));const r=await p.goto('http://127.0.0.1:${port}',{waitUntil:'domcontentloaded'});const body=await p.textContent('body');console.log(JSON.stringify({status:r?.status()||null,body,errors}));await p.screenshot({path:'/tmp/theta-behavior.png',fullPage:true});await b.close();if(!r||r.status()!==200||errors.length)process.exit(2)})().catch(e=>{console.error(e.stack||e);process.exit(1)})`;
  const encoded = Buffer.from(browserScript).toString('base64');
  const result = await client.commands.run(`echo ${encoded} | base64 -d > /tmp/theta-browser.cjs && cd ${THETA_WORKSPACE} && node /tmp/theta-browser.cjs`);
  try { await server.kill(); } catch {}
  const line = String(result || '').match(/\{.*\}/s);
  const parsed = line ? JSON.parse(line[0]) : null;
  return { success: Boolean(parsed?.status === 200 && !(parsed?.errors || []).length), servable: true, consoleErrors: [], pageErrors: parsed?.errors || [], interactions: [], buildOutput: String(install || ''), note: acceptanceCriteria.length ? `Browser run completed; ${acceptanceCriteria.length} acceptance criteria supplied.` : undefined, executor: 'codesandbox' };
}


async function recordExecutionRun(supabase, projectId, payload) {
  try {
    await supabase.from('execution_runs').insert({
      project_id: projectId,
      step_id: Number(payload.stepId) || 0,
      agent_id: String(payload.agentId || 'terminal'),
      command: String(payload.command || ''),
      success: Boolean(payload.success),
      stdout: String(payload.stdout || '').slice(0, 20000),
      stderr: `${String(payload.stderr || '').slice(0, 19000)}${payload.exitCode != null ? `\n[exit code ${payload.exitCode}]` : ''}`.slice(0, 20000),
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    console.warn('[Theta Executor] Failed to write execution_runs audit row:', error);
  }
}

async function snapshotTerminalFiles(client) {
  const script = `cd ${shellQuote(THETA_WORKSPACE)} && find . -type f -not -path './node_modules/*' -not -path './.git/*' -print0 | head -z -n ${MAX_FILES} | while IFS= read -r -d '' f; do rel="\${f#./}"; bytes=$(wc -c < "$f" 2>/dev/null || echo 0); case "$rel" in *.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.pdf|*.zip|*.woff|*.woff2|*.ttf|*.mp4|*.mov) continue;; esac; if [ "$bytes" -gt ${MAX_FILE_BYTES} ]; then continue; fi; printf 'THETA_FILE:%s\\n' "$rel"; base64 "$f"; printf '\\nTHETA_END\\n'; done`;
  try {
    const raw = String(await client.commands.run(script) ?? '');
    const files = [];
    const re = /THETA_FILE:([^\n]+)\n([A-Za-z0-9+/=\n]+?)\nTHETA_END\n/g;
    let total = 0;
    let match;
    while ((match = re.exec(raw)) && files.length < 400) {
      try {
        const content = Buffer.from(match[2].replace(/\s/g, ''), 'base64').toString('utf8');
        total += Buffer.byteLength(content, 'utf8');
        if (total > MAX_TOTAL_BYTES) break;
        files.push({ path: match[1], content });
      } catch {}
    }
    return files;
  } catch { return []; }
}

function terminalToken() {
  return `theta-terminal-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
}

export default async function handler(req, res) {
  let releaseRateLimit = null;

  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
  try {
    const cfg = config();
    if (!cfg.key) return json(res, 500, { error: 'CODESANDBOX_API_KEY is not configured on the server.' });
    const { user, supabase } = await authUser(req);
    releaseRateLimit = await enforceServerRateLimit(supabase, user.id);
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const projectId = String(body.projectId || '');
    if (!projectId) return json(res, 400, { error: 'projectId is required.' });
    const sdk = new CodeSandbox(cfg.key);
    const action = body.action;

    if (action === 'ensure') {
      const sandbox = await ensureSandbox(sdk, supabase, user.id, projectId);
      return json(res, 200, { sandboxId: sandbox.id, executor: 'codesandbox' });
    }

    if (action === 'destroy') {
      const project = await projectRow(supabase, user.id, projectId);
      if (project.execution_sandbox_id) {
        try { await sdk.sandboxes.shutdown(project.execution_sandbox_id); } catch {}
        await supabase.from('projects').update({ execution_sandbox_id: null }).eq('id', projectId).eq('user_id', user.id);
      }
      return json(res, 200, { success: true });
    }

    const { client } = await connectProject(sdk, supabase, user.id, projectId);

    if (action === 'terminalStart' || action === 'terminal_start') {
      const files = safeFiles(body.files || []);
      if (body.syncFiles !== false) await syncFiles(client, files, body.deletedPaths || []);
      const token = terminalToken();
      const cwdFile = '/tmp/theta-terminal-cwd';
      const out = `/tmp/${token}.out`;
      const err = `/tmp/${token}.err`;
      const status = `/tmp/${token}.status`;
      const pid = `/tmp/${token}.pid`;
      const command = String(body.command || '');
      const wrapped = `set +e; cd "$(cat ${cwdFile} 2>/dev/null || printf %s ${shellQuote(THETA_WORKSPACE)})" 2>/dev/null || cd ${shellQuote(THETA_WORKSPACE)}; setsid bash -lc ${shellQuote(command)} > ${shellQuote(out)} 2> ${shellQuote(err)} & child=$!; echo $child > ${shellQuote(pid)}; wait $child; code=$?; pwd > ${shellQuote(cwdFile)}; printf '%s' "$code" > ${shellQuote(status)}`;
      const process = await client.commands.runBackground(wrapped, { name: token });
      return json(res, 200, { success: true, processName: process.name || token, runId: process.name || token, executor: 'codesandbox' });
    }
    if (action === 'terminalPoll' || action === 'terminal_poll') {
      const name = String(body.processName || '').replace(/[^a-zA-Z0-9._-]/g, '-');
      if (!name.startsWith('theta-terminal-')) return json(res, 400, { error: 'Invalid terminal process.' });
      const out = `/tmp/${name}.out`, err = `/tmp/${name}.err`, status = `/tmp/${name}.status`, pid = `/tmp/${name}.pid`, cwdFile = '/tmp/theta-terminal-cwd';
      const stdoutAll = String(await client.commands.run(`cat ${shellQuote(out)} 2>/dev/null || true`) ?? '');
      const stderrAll = String(await client.commands.run(`cat ${shellQuote(err)} 2>/dev/null || true`) ?? '');
      const stdoutOffset = Math.max(0, Number(body.stdoutOffset) || 0);
      const stderrOffset = Math.max(0, Number(body.stderrOffset) || 0);
      const stdout = stdoutAll.slice(Math.min(stdoutOffset, stdoutAll.length));
      const stderr = stderrAll.slice(Math.min(stderrOffset, stderrAll.length));
      const statusText = String(await client.commands.run(`cat ${shellQuote(status)} 2>/dev/null || true`) ?? '').trim();
      const cwd = String(await client.commands.run(`cat ${shellQuote(cwdFile)} 2>/dev/null || pwd`) ?? '').trim();
      const running = !/^\d+$/.test(statusText);
      if (running) return json(res, 200, { running: true, stdout, stderr, stdoutOffset: stdoutAll.length, stderrOffset: stderrAll.length, cwd, executor: 'codesandbox' });
      const exitCode = Number(statusText);
      const success = exitCode === 0;
      let files = [];
      if (!running) {
        await recordExecutionRun(supabase, projectId, { command: body.command, success, stdout: stdoutAll, stderr: stderrAll, agentId: body.agentId || 'terminal', stepId: body.stepId || 0 });
        files = await snapshotTerminalFiles(client);
        try { await client.commands.run(`rm -f ${shellQuote(out)} ${shellQuote(err)} ${shellQuote(status)} ${shellQuote(pid)}`); } catch {}
      }
      return json(res, 200, { running: false, success, stdout, stderr, stdoutOffset: stdoutAll.length, stderrOffset: stderrAll.length, exitCode, cwd, files, executor: 'codesandbox' });
    }
    if (action === 'run' || action === 'terminal') {
      const files = safeFiles(body.files || []);
      await syncFiles(client, files, body.deletedPaths || []);
      const started = Date.now();
      const terminalCommand = `cd ${shellQuote(THETA_WORKSPACE)} && ${String(body.command || '')}`;
      const result = await runCommandWithStatus(client, terminalCommand, Math.min(Number(body.timeoutMs) || DEFAULT_TIMEOUT, MAX_TIMEOUT), action === 'terminal');
      const cwd = action === 'terminal' ? String(await client.commands.run('cat /tmp/theta-terminal-cwd 2>/dev/null || pwd') ?? '').trim() : undefined;
      await recordExecutionRun(supabase, projectId, { command: body.command, success: result.success, stdout: result.stdout, stderr: result.stderr, agentId: body.agentId || 'terminal', stepId: body.stepId || 0 });
      return json(res, 200, { ...result, cwd, durationMs: Date.now() - started, executor: 'codesandbox' });
    }
    if (action === 'test') {
      return json(res, 200, await runTest(client, safeFiles(body.files || []), body.deletedPaths || [], Math.min(Number(body.timeoutMs) || DEFAULT_TIMEOUT, MAX_TIMEOUT)));
    }
    if (action === 'background') {
      const files = safeFiles(body.files || []);
      await syncFiles(client, files, body.deletedPaths || []);
      const name = String(body.name || `theta-process-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '-');
      const process = await startManagedBackground(client, String(body.command || ''), name, projectId);
      return json(res, 200, { success: true, processName: process.name, executor: 'codesandbox' });
    }
    if (action === 'stop') {
      const name = String(body.name || '').replace(/[^a-zA-Z0-9._-]/g, '-');
      if (!name) return json(res, 400, { error: 'Process name is required.' });
      const result = await stopManagedBackground(client, name, projectId);
      return json(res, 200, { success: true, stdout: String(result ?? ''), stderr: '', exitCode: 0, executor: 'codesandbox' });
    }
    if (action === 'interrupt') {
      const name = String(body.processName || '').replace(/[^a-zA-Z0-9._-]/g, '-');
      const result = name.startsWith('theta-terminal-')
        ? await client.commands.run(`if [ -f /tmp/${name}.pid ]; then pid=$(cat /tmp/${name}.pid); kill -TERM -- -$pid 2>/dev/null || kill -TERM $pid 2>/dev/null || true; sleep 0.05; kill -KILL -- -$pid 2>/dev/null || kill -KILL $pid 2>/dev/null || true; printf '130' > /tmp/${name}.status; fi`)
        : await client.commands.run('if [ -f /tmp/theta-current-command.pid ]; then pid=$(cat /tmp/theta-current-command.pid); kill -TERM -- -$pid 2>/dev/null || kill -TERM $pid 2>/dev/null || true; fi');
      return json(res, 200, { success: true, stdout: String(result ?? ''), stderr: 'Process interrupted by user.', exitCode: 130, executor: 'codesandbox' });
    }
    if (action === 'preview') {
      const url = client.hosts.getUrl(parsePort(body.port));
      return json(res, 200, { url, executor: 'codesandbox' });
    }
    if (action === 'previewStart' || action === 'preview_start') {
      const files = safeFiles(body.files || []);
      await syncFiles(client, files, body.deletedPaths || []);
      const port = parsePort(body.port);
      const project = await projectRow(supabase, user.id, projectId);
      const processName = `theta-preview-${port}`;
      // Replace only the exact Theta-managed preview process for this project.
      try { await stopManagedBackground(client, processName, projectId); } catch {}

      const names = files.map(f => f.path.toLowerCase());
      const pkg = files.find(f => f.path.toLowerCase() === 'package.json');
      let packageJson = null;
      try { packageJson = pkg ? JSON.parse(pkg.content) : null; } catch {}
      const scripts = packageJson?.scripts || {};
      const has = (name) => names.some(n => n === name || n.endsWith(`/${name}`));
      let framework = 'static';
      let command = `cd ${shellQuote(THETA_WORKSPACE)} && python3 -m http.server ${port} --bind 0.0.0.0`;

      const depText = JSON.stringify({ ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) });
      if (names.some(n => n === 'angular.json')) {
        framework = 'angular';
        command = `cd ${shellQuote(THETA_WORKSPACE)} && npx ng serve --host 0.0.0.0 --port ${port}`;
      } else if (/\"next\"/i.test(depText)) {
        framework = 'next';
        command = `cd ${shellQuote(THETA_WORKSPACE)} && npx next dev -H 0.0.0.0 -p ${port}`;
      } else if (scripts.dev) {
        framework = /vite/i.test(depText) || /vite/i.test(String(scripts.dev)) ? 'vite' : 'node-dev';
        command = `cd ${shellQuote(THETA_WORKSPACE)} && npm run dev -- --host 0.0.0.0 --port ${port}`;
      } else if (scripts.serve) {
        framework = 'web-server';
        command = `cd ${shellQuote(THETA_WORKSPACE)} && npm run serve -- --host 0.0.0.0 --port ${port}`;
      } else if (scripts.start) {
        framework = 'node';
        command = `cd ${shellQuote(THETA_WORKSPACE)} && PORT=${port} HOST=0.0.0.0 npm start`;
      } else if (scripts.preview) {
        framework = 'vite-preview';
        command = `cd ${shellQuote(THETA_WORKSPACE)} && npm run preview -- --host 0.0.0.0 --port ${port}`;
      } else if (has('manage.py')) {
        framework = 'django';
        command = `cd ${shellQuote(THETA_WORKSPACE)} && python3 manage.py runserver 0.0.0.0:${port}`;
      } else if (names.some(n => /(^|\/)(main|app|server)\.py$/.test(n)) && names.some(n => /requirements\.txt$/.test(n))) {
        const req = files.find(f => /(^|\/)requirements\.txt$/i.test(f.path));
        const reqText = String(req?.content || '');
        if (/fastapi/i.test(reqText)) {
          framework = 'fastapi';
          const entry = has('main.py') ? 'main:app' : 'app:app';
          command = `cd ${shellQuote(THETA_WORKSPACE)} && uvicorn ${entry} --host 0.0.0.0 --port ${port}`;
        } else if (/flask/i.test(reqText)) {
          framework = 'flask';
          const module = has('app.py') ? 'app' : 'main';
          command = `cd ${shellQuote(THETA_WORKSPACE)} && FLASK_APP=${module} python3 -m flask run --host 0.0.0.0 --port ${port}`;
        } else {
          framework = 'python';
          command = `cd ${shellQuote(THETA_WORKSPACE)} && python3 -m http.server ${port} --bind 0.0.0.0`;
        }
      } else if (has('index.php') || names.some(n => /\.php$/i.test(n))) {
        framework = 'php';
        command = `cd ${shellQuote(THETA_WORKSPACE)} && php -S 0.0.0.0:${port}`;
      } else if (has('go.mod')) {
        framework = 'go';
        command = `cd ${shellQuote(THETA_WORKSPACE)} && PORT=${port} go run .`;
      } else if (has('Cargo.toml')) {
        framework = 'rust';
        command = `cd ${shellQuote(THETA_WORKSPACE)} && PORT=${port} cargo run`;
      } else if (has('Program.cs') || names.some(n => n.endsWith('.csproj'))) {
        framework = 'dotnet';
        command = `cd ${shellQuote(THETA_WORKSPACE)} && ASPNETCORE_URLS=http://0.0.0.0:${port} dotnet run`;
      } else if (has('pom.xml')) {
        framework = 'java-maven';
        command = `cd ${shellQuote(THETA_WORKSPACE)} && mvn spring-boot:run -Dspring-boot.run.arguments=--server.port=${port}`;
      } else if (has('build.gradle') || has('build.gradle.kts')) {
        framework = 'java-gradle';
        command = `cd ${shellQuote(THETA_WORKSPACE)} && ./gradlew bootRun --args=--server.port=${port}`;
      }

      // npm install is intentionally done only for npm-based projects. Static/Python previews
      // should be available without introducing an unnecessary dependency-install delay.
      if (pkg) {
        await client.commands.run(`cd ${shellQuote(THETA_WORKSPACE)} && npm install --no-audit --no-fund`);
      }
      const process = await startManagedBackground(client, command, processName, projectId);
      await client.ports.waitForPort(port);
      const url = client.hosts.getUrl(port);
      return json(res, 200, { success: true, url, port, processName: process.name || processName, framework, sandboxId: project.execution_sandbox_id, executor: 'codesandbox' });
    }
    if (action === 'previewStop' || action === 'preview_stop') {
      const port = parsePort(body.port);
      const processName = `theta-preview-${port}`;
      try { await stopManagedBackground(client, processName, projectId); } catch {}
      return json(res, 200, { success: true, port, executor: 'codesandbox' });
    }
    if (action === 'behavior') {
      return json(res, 200, await runBehavior(client, safeFiles(body.files || []), body.deletedPaths || [], Array.isArray(body.acceptanceCriteria) ? body.acceptanceCriteria.slice(0, 30) : [], Math.min(Number(body.timeoutMs) || MAX_TIMEOUT, MAX_TIMEOUT)));
    }

    return json(res, 400, { error: `Unknown executor action: ${action}` });
  } catch (error) {
    console.error('[Theta Executor]', error);
    const status = error?.code === 'EXECUTOR_RATE_LIMIT' || error?.code === 'EXECUTOR_CONCURRENCY_LIMIT' ? 429 : error?.code === 'EXECUTOR_RATE_LIMIT_UNAVAILABLE' || error?.code === 'EXECUTOR_SANDBOX_INIT_BUSY' || error?.code === 'EXECUTOR_BACKGROUND_LIMIT' || error?.code === 'EXECUTOR_BACKGROUND_LOCK_BUSY' ? 503 : error?.code === 'EXECUTOR_BACKGROUND_NAME_BUSY' ? 409 : error?.code === 'INVALID_PORT' ? 400 : 500;
    const body = { error: error?.message || String(error) };
    if (error?.retryAfter) body.retryAfter = error.retryAfter;
    if (error?.code) body.code = error.code;
    return json(res, status, body);
  } finally {
    try { releaseRateLimit?.(); } catch {}
  }
}
