export type TaskFocus = 'ui' | 'backend' | 'data' | 'logic' | 'docs' | 'full-stack' | 'unknown';

export interface TaskScope {
  focus: TaskFocus;
  reason: string;
  mustInspect: string[];
  likelyRelevantGlobs: string[];
  likelyIrrelevantAreas: string[];
  readBudget: number;
  verification: string[];
  researchNeeded: 'never' | 'when-current' | 'recommended';
}

/**
 * Cheap first-pass task triage. This is deliberately deterministic: it gives every model
 * the same relevance boundary and prevents a planner from spending most of its context on
 * unrelated subsystems before it has earned evidence that they matter.
 */
export function deriveTaskScope(task: string, targetFile: string): TaskScope {
  const text = `${task} ${targetFile}`.toLowerCase();
  const scores: Record<TaskFocus, number> = { ui: 0, backend: 0, data: 0, logic: 0, docs: 0, 'full-stack': 0, unknown: 0 };

  const matches = (patterns: RegExp[]) => patterns.reduce((n, pattern) => n + (pattern.test(text) ? 1 : 0), 0);
  scores.ui += matches([/\bui\b/, /\bux\b/, /user interface/, /user experience/, /design system/, /layout/, /styling/, /visual/, /responsive/, /animation/, /hover state/, /theme/, /color palette/, /colour palette/, /typography/, /component/, /landing page/, /dashboard/, /modal/, /navbar/, /button styling/, /form ui/, /accessibility/] ) * 2;
  scores.backend += matches([/\bapi\b/, /backend/, /server/, /endpoint/, /route handler/, /database connection/, /database/, /supabase auth/, /rpc/, /webhook/, /queue/, /worker/, /middleware/, /rate limit/] ) * 2;
  scores.data += matches([/schema/, /migration/, /data model/, /sql/, /query/, /database migration/, /optimize (?:the )?database/, /row level security/, /rls/, /table/, /indexing/, /foreign key/] ) * 2;
  scores.docs += matches([/readme/, /documentation/, /deploy/, /deployment guide/, /release notes/, /user guide/]) * 2;
  scores.logic += matches([/algorithm/, /business logic/, /logic bug/, /function bug/, /refactor/, /performance/, /unit test/, /integration test/, /race condition/, /concurrency/]) * 2;

  // Explicit task framing gets a bonus and resolves common overlap such as schema + API.
  if (/\b(frontend|front-end)\b/.test(text)) scores.ui += 3;
  if (/\b(full[- ]?stack|end[- ]to[- ]end)\b/.test(text)) scores['full-stack'] += 8;
  if (/\b(api|backend|server)\b/.test(text) && /\b(schema|migration|sql|rls)\b/.test(text)) scores['full-stack'] += 4;

  // Avoid false-positive UI classification from ordinary English "form".
  const uiFormOnly = /\bform\b/.test(text) && !/\b(form ui|form styling|form layout|form design|form component|input styling|validation ui)\b/.test(text);
  if (uiFormOnly && scores.ui > 0) scores.ui = Math.max(0, scores.ui - 2);

  const ranked = (Object.keys(scores) as TaskFocus[])
    .filter((focus) => focus !== 'unknown' && focus !== 'full-stack')
    .sort((a, b) => scores[b] - scores[a]);
  const top = ranked[0] ?? 'unknown';
  const second = ranked[1] ?? 'unknown';
  const topScore = scores[top];
  const secondScore = scores[second];

  let focus: TaskFocus = 'unknown';
  if (scores['full-stack'] >= 8 || (topScore >= 4 && secondScore >= 4 && topScore - secondScore <= 2)) focus = 'full-stack';
  else if (topScore >= 2) focus = top;

  const base = (overrides: Omit<TaskScope, 'focus' | 'reason'>): TaskScope => ({ focus, ...overrides, reason: '' });

  if (focus === 'ui') {
    return {
      ...base({
        mustInspect: [targetFile],
        likelyRelevantGlobs: ['src/**/*.{tsx,ts,jsx,js,css,scss}', '**/*.{html,css,scss}', 'public/**/*.{svg,png,jpg,jpeg,webp}', 'index.html'],
        likelyIrrelevantAreas: ['api/**', 'supabase/**', '**/*migration*.sql', 'scripts/**', 'server/**'],
        readBudget: 6,
        verification: ['Build/syntax', 'Rendered/browser behavior for affected surface', 'Accessibility and responsive behavior when relevant'],
        researchNeeded: 'recommended',
      }),
      reason: 'The request is primarily visual/interaction work. Inspect the rendered surface and immediate UI dependencies before widening into backend or infrastructure.',
    };
  }

  if (focus === 'backend' || focus === 'data') {
    return {
      ...base({
        mustInspect: [targetFile],
        likelyRelevantGlobs: ['api/**/*', 'src/**/*.{ts,tsx,js,jsx}', 'supabase/**/*.sql', '**/*.sql'],
        likelyIrrelevantAreas: ['public/**', 'assets/**'],
        readBudget: 8,
        verification: ['Syntax/typecheck', 'Focused tests', 'Integration checks for touched contracts'],
        researchNeeded: 'when-current',
      }),
      reason: 'The request is primarily service/data work. Inspect the target and direct callers/dependencies first; UI should only be read when evidence shows a contract or behavior change reaches it.',
    };
  }

  return {
    ...base({
      mustInspect: [targetFile],
      likelyRelevantGlobs: ['src/**/*', 'api/**/*', 'supabase/**/*', 'public/**/*', 'index.html'],
      likelyIrrelevantAreas: [],
      readBudget: focus === 'full-stack' ? 10 : 7,
      verification: ['Targeted verification first', 'Broader project checks only when the change can affect them'],
      researchNeeded: focus === 'docs' ? 'when-current' : 'when-current',
    }),
    reason: 'Start narrow. Expand only when an observed dependency, failing check, contract, or user requirement proves the extra files matter.',
  };
}

export function formatTaskScope(scope: TaskScope): string {
  return `TASK SCOPE — focus: ${scope.focus}\n` +
    `Why: ${scope.reason}\n` +
    `Initial read budget: at most ${scope.readBudget} non-trivial files before the first implementation attempt unless evidence demands expansion.\n` +
    `Start with: ${scope.mustInspect.join(', ')}\n` +
    `Likely relevant areas: ${scope.likelyRelevantGlobs.join(', ')}\n` +
    (scope.likelyIrrelevantAreas.length ? `Do not read by default: ${scope.likelyIrrelevantAreas.join(', ')}\n` : '') +
    `Verification: ${scope.verification.join('; ')}\n` +
    `Research: ${scope.researchNeeded}.\n` +
    `RULE: relevance beats completeness. Expand scope only when a concrete dependency, failing test, contract, or user requirement proves the extra files matter.`;
}
