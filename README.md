# Theta Workbench

Theta is a multi-agent AI coding workspace: Chief plans/orchestrates, Dev agents implement work through a ReAct loop, Miko is the conversational assistant, and Supabase keeps projects, files, conversations, checkpoints, commits, and execution logs persistent.

## Architecture

- **Supabase** — Auth, multi-project VFS, conversations, checkpoints, commits, file history, agent logs, and execution audit records.
- **CodeSandbox** — isolated cloud execution. The server-side Vercel API creates/reuses a sandbox per project and runs real commands, tests, background processes, preview servers, and Chromium/Playwright.
- **LocalExecutor** — handles a small allow-list of trivial browser-safe commands locally. Anything requiring a real OS process is automatically sent to CodeSandbox. Users never choose the environment.
- **Vercel** — serves the Vite app and the `/api/executor` control-plane function. The CodeSandbox API key is server-side only.

The old Render backend has been removed from the application and deployment architecture.

## Execution model

```text
Chief / Miko / Dev agents / Terminal
                 |
                 v
          unified executor
             /       \
            /         \
   LocalExecutor    CodeSandbox
   tiny safe ops    real OS/VM work
```

The strict agent loop treats real execution output as ground truth. A failed compiler/test command returns its actual stdout/stderr to the agent so it can inspect, repair, and retry.

## Deployment

All deployment instructions live in [`DEPLOY.md`](./DEPLOY.md). Do not maintain a second migration sequence or environment-variable checklist here; `DEPLOY.md` is the single source of truth.

The deployment guide covers Supabase migration order (including the required atomic-lock migration 009), Vercel secrets, CodeSandbox setup, local development, production deployment, project previews/ports, image-generation diagnostics, and rate-limit/token-budget behavior.

## Terminal

The Workbench terminal is backed by the active project's real CodeSandbox VM for commands that require an OS process. Small safe commands are handled locally. The UI displays returned stdout/stderr instead of simulating shell output.

## Behavior checks

Browser behavior checks run inside the same isolated CodeSandbox execution environment. Playwright/Chromium are installed in that sandbox when a browser entry point is detected; they are not installed into Theta itself.

## Security boundary

- Gemini keys are intentionally kept in session-only browser storage and must be re-entered after the browser session ends.
- CodeSandbox credentials are server-only.
- Every executor request carries the signed-in Supabase access token.
- The server verifies that the requested project belongs to that user before touching its sandbox.
- A sandbox is associated with one project and can be hibernated/destroyed without affecting another project.

## Adaptive Web & Design Research

Theta agents now have a live `research_web` tool. Use `tech:` for current framework/package/API documentation and release-note checks, `ui:` for UI/UX inspiration research, and `deep:` when both are needed. Research returns source URLs and is cached briefly to avoid repeated calls.

For UI/UX work, agents are instructed to study multiple public sources such as award galleries, public product/design showcases, design systems, and other accessible references. They extract transferable patterns (layout, typography, motion, interaction, accessibility, color relationships) rather than reproducing a specific page or its protected assets. High-novelty patterns are stored as global candidates; all findings remain associated with their originating sources.

For technical work, current official documentation and release notes are preferred over tutorials. When a dependency's syntax may have changed, the agent should research before editing instead of relying on model memory.

## Autonomous reasoning model

Theta agents are intentionally **scope-first, evidence-driven, and adversarially reviewed**. A user request is not a command to read the whole repository. Each task gets a relevance boundary first; agents start from the target surface and direct dependencies, expand only when evidence requires it, and prefer focused verification over ritual full-project exploration.

For non-trivial changes, the writer is reviewed by an independent critic and an additional adversarial pass that tries to falsify the result. A review that cannot be completed is treated as uncertainty, not approval. Cross-agent synthesis checks integration separately from the authors' own work.

This is designed to reduce three common autonomous-coding failures: context waste, single-model self-confirmation, and a Chief that mistakes agreement between agents for truth.


### API key storage
Gemini API keys are intentionally stored in browser `sessionStorage` only. They are cleared when the browser session ends; Theta does not persist provider secrets across restarts in this client build.
