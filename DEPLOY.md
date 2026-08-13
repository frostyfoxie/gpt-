# Theta Workbench deployment guide

This is the **single source of truth** for deployment. Do not copy the migration sequence or environment-variable checklist into other docs. `README.md` intentionally links here instead.

## 1. Architecture and prerequisites

Theta uses three deployed services:

- **Supabase** for authentication, project/VFS persistence, history, checkpoints, commits, conversations, locks, and execution telemetry.
- **Vercel** for the Vite frontend and the same-origin `/api/executor` control plane.
- **CodeSandbox SDK** for isolated project execution, terminal commands, background processes, browser checks, and preview servers. CodeSandbox describes its SDK as isolated development environments for running code.

There is no Render service in the current architecture.

Before starting, have a Supabase project, a Vercel project connected to this repository, and a CodeSandbox SDK/API credential available to the server deployment.

## 2. Supabase: apply the database schema and migrations

The SQL files in `Supabase/migrations/` are **not optional documentation**. They are executable database changes. A fresh deployment needs the base `Supabase/schema.sql` followed by every numbered migration, in numeric order.

In the Supabase dashboard:

1. Open **SQL Editor** and create a new query.
2. Paste and run `Supabase/schema.sql`.
3. Then run these migrations in this exact order, one file at a time:

```text
002_auth_and_projects.sql
003_project_scoped_unique_keys.sql
004_project_scoped_sequences.sql
005_execution_sandbox.sql
006_execution_auth_hardening.sql
007_upsert_conflict_indexes.sql
008_execution_observability.sql
009_atomic_file_locks.sql
010_research_memory.sql
011_execution_rate_limits.sql
012_execution_sandbox_locks.sql
```

Migration **009 is required**. It creates the `acquire_project_file_lock` PostgreSQL RPC used by `src/engine/state-lock.ts`. Without 009, file-lock acquisition cannot succeed and Theta now reports a direct, actionable migration error instead of silently treating missing infrastructure as normal lock contention.

### What each migration provides

- `002_auth_and_projects.sql` — authenticated project ownership and project-scoped RLS.
- `003_project_scoped_unique_keys.sql` — project-safe uniqueness constraints.
- `004_project_scoped_sequences.sql` — project-safe sequence behavior.
- `005_execution_sandbox.sql` — the `projects.execution_sandbox_id` field used to reuse a project sandbox.
- `006_execution_auth_hardening.sql` — additional execution/auth protections.
- `007_upsert_conflict_indexes.sql` — indexes required for safe conflict-aware writes.
- `008_execution_observability.sql` — execution history/realtime indexes and publication configuration.
- `009_atomic_file_locks.sql` — atomic per-file locking for parallel dev agents.
- `010_research_memory.sql` — project-scoped adaptive web-research memory.
- `011_execution_rate_limits.sql` — distributed request/concurrency limiting for the serverless executor.
- `012_execution_sandbox_locks.sql` — distributed project-scoped lease preventing duplicate CodeSandbox creation.

### Updating an existing Theta deployment

Do **not** rerun `schema.sql` on a live installation just because a new migration exists. Run only the new numbered migration(s) that have not yet been applied.

If your Supabase project already has migrations 002–010, run only:

```sql
-- Supabase SQL Editor
-- paste the full contents of:
-- Supabase/migrations/011_execution_rate_limits.sql
012_execution_sandbox_locks.sql
```

After the migration finishes successfully, refresh Theta and test executor requests while two agents run in parallel.

## 3. Supabase Auth and API settings

Enable the sign-in providers you intend to use in Supabase Auth. The browser needs the project URL and publishable/anon key; the Vercel API additionally needs the server-side service-role key.

Never put the service-role key or CodeSandbox credential in a `VITE_` variable. Vite variables beginning with `VITE_` are eligible for the browser bundle.

## 4. Vercel environment variables

Set these in the Vercel project environment for the environments where Theta runs:

```text
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable-or-anon-key>
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=<publishable-or-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<server-side-service-role-key>
CODESANDBOX_API_KEY=<server-side-CodeSandbox-key>
VITE_CODESANDBOX_EXECUTOR_ENABLED=true
```

`SUPABASE_SERVICE_ROLE_KEY` is used only by `/api/executor` for reliable project-row lookup. The API still verifies the authenticated Supabase user and project ownership before touching a sandbox.

**Function timeout.** `vercel.json` sets `functions["api/executor/index.js"].maxDuration` to `60` (the safe value on every Vercel plan, including Hobby). Without an explicit `maxDuration`, Vercel falls back to its platform default — **10 seconds on Hobby** — which is not enough time for `/api/executor` to create/resume a CodeSandbox, sync files, and run `npm install` before Vercel kills the request with a `504 FUNCTION_INVOCATION_TIMEOUT`. If that happens, the terminal, previews, and every agent tool that depends on the real executor (`run_tests`, `run_behavior_check`, `run_command`) will all appear to silently fail even though `CODESANDBOX_API_KEY` is configured correctly — the request never got the time to complete, not that it errored. If you're on Vercel Pro/Enterprise, raise `maxDuration` further (e.g. `120`–`300`) for headroom on larger `npm install`s and preview boots.

## 5. Local development

Create `.env.local` from `.env.example` for the browser values. Then:

```bash
npm install
npm run dev
```

For real CodeSandbox execution during local development, use a Vercel-compatible local runtime for `/api/executor` with the server-side environment variables from section 4. The frontend itself must never receive the CodeSandbox credential.

## 6. Production build and deployment

Run locally before deployment:

```bash
npm install
npm test
npm run build
```

Then deploy the repository to Vercel. Vercel serves both the Vite frontend and `/api/executor` from the same project.

The current repository also contains focused source-level security/regression tests. A successful `npm test` is a real regression signal; a successful production build is required before calling a release build-verified.

## 7. User-facing preview ports

Theta includes a VS Code-style **project preview by port** backed by the same isolated CodeSandbox environment as the terminal. The editor toolbar exposes:

- **Open project preview** for browser projects with a normal entry point.
- **Open port preview** for a project that has a server listening on a chosen port.

The `/api/executor` actions are:

```text
previewStart   start/detect a server and bind a port
preview        resolve the public sandbox URL for a port
previewStop    stop Theta's managed preview process for that port
```

The preview launcher detects common stacks instead of assuming one language: static HTML, Vite/npm, Next.js, Angular, Django, FastAPI, Flask, PHP, Go, Rust, .NET, Maven Spring Boot, and Gradle Spring Boot. Other languages are not “magically universal”: the project must provide a runnable server command or a supported runtime. This is intentionally better than claiming every language can expose HTTP just because a port exists.

A preview runs in the project's isolated sandbox, so users can keep the platform open and test the generated application simultaneously. CodeSandbox advertises isolated sandboxes capable of running many code types and concurrent environments.

## 8. Image generation: what Theta expects

Image models use the Gemini image-generation API path and must return image data in the model response. Theta now requests `responseModalities: ['IMAGE']` explicitly and uses a standard `2K` image configuration. This matters because image-generation responses can differ from text responses, and community reports have specifically identified response-modality configuration as a factor in Gemini image output behavior.

When diagnosing image generation, check these in order:

1. Confirm Miko/Chief is actually set to an image-capable model.
2. Confirm the selected key has permission/quota for that model.
3. Confirm the response contains `inlineData` image bytes rather than only text.
4. Confirm the chat UI receives the `__IMAGE__:` sentinel and renders an `<img>`.
5. Check the browser console/network tab for the first failing request rather than repeatedly retrying the same model.

Theta does not claim that one fixed model is permanently available or that a rate-limit is caused by Gemini alone; model availability, tier, project configuration and service-side behavior can change.

## 9. Rate limits and token limits

Theta deliberately does **not** assume a fake hard limit such as “20 requests/day”. Gemini quotas are multidimensional: RPM, TPM and RPD can all matter, and limits vary by model, usage tier and project. Google guidance explicitly points users to the Usage/Quota dashboards and recommends backoff for RPM/TPM exhaustion.

The request governor therefore uses an **adaptive observed model**:

- It records actual calls per key/model.
- It learns provider-provided cooldowns from 429 responses and waits for that observed delay.
- It never presents an invented exact daily allowance as if it were authoritative.
- It uses pooled keys/models to avoid unnecessarily spending an exhausted key when another configured key has room.
- Retry behavior uses jitter and avoids blindly multiplying retries when the provider is already returning failures.

There is no client-only algorithm that can know Google's hidden/current RPM/TPM/RPD ceiling with certainty when the provider does not expose it to the application. The honest design is therefore “observed limits + provider retry telemetry + conservative scheduling”, not a fabricated prediction number.

For context/token exhaustion, Theta now collapses the user-facing failure to:

```text
Token limit reached.
```

The detailed provider payload remains available to internal diagnostics, but it should not spam chat or the terminal. Token-limit detection is intentionally a last-resort failure state; prompt compaction, context truncation, model routing, and bounded retries should be preferred before reaching it.

## 10. Deployment verification

After deployment, run this sequence:

```text
1. Sign in.
2. Create/open a project.
3. Confirm Supabase-backed files persist after refresh.
4. Open Terminal and run a harmless command.
5. Run a generated HTML project and open its preview port.
6. Start two dev-agent writes against different files and confirm both can proceed.
7. Start two writes against the same file and confirm one waits for the lock.
8. Select an image model and run one small image generation request.
9. Inspect the quota badge: it should show observed usage/cooldown, not a made-up 20/day limit.
10. Run `npm test` and `npm run build` for the shipped commit.
```

## 11. Troubleshooting

**“File-lock service unavailable … apply 009_atomic_file_locks.sql

10. `010_research_memory.sql` — project-scoped research memory.
11. `011_execution_rate_limits.sql` — distributed executor request/concurrency limiting for serverless deployments.”**

Your Supabase database is missing migration 009. Apply it in SQL Editor, then retry the agent write.

**Preview starts but the page does not load**

Confirm the generated application actually starts an HTTP server on the requested port and binds to `0.0.0.0`, not only `127.0.0.1`. For a static HTML project, the preview launcher can use a simple HTTP server. For frameworks, use the framework's development/start command.

**Image generation returns text instead of an image**

Confirm an image-capable model is selected, that the key can call it, and that the provider response contains image `inlineData`. The application now explicitly requests image response modality.

**429/rate limit**

Do not increase a fake daily counter. Let the adaptive governor honor the provider's observed cooldown, reduce prompt size/concurrency, and use another configured model/key when genuinely available. Google notes that RPM, TPM and RPD can independently trigger quota errors.

**Token limit reached**

Theta should display only `Token limit reached.` to the user. The engine should then compact/truncate context or route to an appropriate model before retrying a bounded number of times.

## Adaptive research and internet references

After applying migration `010_research_memory.sql`, agents can persist live research findings in Supabase. The feature is still usable without that migration because memory writes are best-effort.

Agent research commands:
- `tech: <question>` — current packages, APIs, changelogs and migration guidance.
- `ui: <brief>` — UI/UX reference study, including public award galleries, product showcases, design systems and accessible inspiration pages.
- `deep: <brief>` — combines both.

Research results keep source URLs and observation timestamps. The implementation is deliberately evidence-first: official/primary technical sources are preferred; visual inspiration is synthesized across multiple sources rather than copied. Pinterest access should use an authorized API/integration where available rather than scraping protected content. Pinterest's developer API exposes board/pin data through authenticated scopes, and its developer guidelines govern use of Pinterest materials. 
