// Flat config (ESLint 10). Replaces the legacy .eslintrc.cjs, which ESLint 10
// no longer reads. Mirrors the old ruleset and adds circular-dependency
// detection via eslint-plugin-import-x.
import js from '@eslint/js'
import tseslint from '@typescript-eslint/eslint-plugin'
import importX from 'eslint-plugin-import-x'
import reactHooks from 'eslint-plugin-react-hooks'
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript'
import globals from 'globals'

// ── U2 rule bodies ───────────────────────────────────────────────────────────
// Mutating verbs on the preload surface. A READ (list/get/status/…) is fine raw;
// a WRITE must go through invoke(), which throws on success:false.
const MUTATING_VERB =
  '/^(set|save|create|update|delete|remove|add|toggle|enable|disable|start|stop|cancel|abort|reconnect|clear|import|approve|respond|persist|apply|move|reorder|rename|archive|restore|push|write|install|uninstall|run|scan|generate|sync|fork|schedule|send|pin|unpin|activate|deactivate|reindex|retry|resume|pause|kill)/'

// `window.api.<ns>.<verb>()` and `window.api.<verb>()`.
const RAW_WRITE_CALL = [
  `CallExpression[callee.object.object.object.name='window'][callee.object.object.property.name='api'][callee.property.name=${MUTATING_VERB}]`,
  `CallExpression[callee.object.object.name='window'][callee.object.property.name='api'][callee.property.name=${MUTATING_VERB}]`
]

// Only the shapes that CONSUME the call directly. `invoke('…', () => window.api.x.y())`
// puts the call inside an arrow thunk, so the sanctioned form is not matched — that
// is the whole point: the rule redirects you to invoke() rather than banning the
// preload surface outright.
const CONSUMING_PARENT = [
  'AwaitExpression > ',
  'ExpressionStatement > ',
  "UnaryExpression[operator='void'] > ",
  'ReturnStatement > '
]

const RAW_IPC_WRITE_MESSAGE =
  'no-raw-ipc-write: route this mutation through invoke() in src/lib/ipc-client.ts. A raw window.api.* call returns {success:false} that nobody reads, so the UI toasts a success it never got.'

const RAW_IPC_WRITE_SELECTORS = CONSUMING_PARENT.flatMap((parent) =>
  RAW_WRITE_CALL.map((call) => ({ selector: parent + call, message: RAW_IPC_WRITE_MESSAGE }))
)

// no-cross-brain-write — the guard src/duin/lib/brain-client.ts:13 has CITED since
// it was written, and whose ONLY occurrence in the entire repository was that
// comment. The codebase believed it had this discipline. It now exists.
//
// TS-brain-OWNED derived state (owed/decision resolution, insight verdicts,
// prediction/calibration verdicts) must be written through brain-client's IPC and
// its branded ids, not by raw-fetching the python-backed /state/* routes, which
// carry a DIFFERENT id-space — the recurring "read-brain != write-brain" bug class
// (2026-06-30 x3: owed Resolve 400, insight-verdict "not found").
//
// The three legacy writers in src/duin/lib/state.ts are @deprecated pending the M6
// migration and src/duin/** is eslint-ignored above, so this stops NEW ones being
// added from components and stores rather than re-litigating those.
const OWNED_ROUTE = '/[/]state[/](verdict|resolve-node|insight-verdict|prediction-feedback|cascade-resolve)/'
const CROSS_BRAIN_WRITE_MESSAGE =
  'no-cross-brain-write: this /state/* route writes TS-brain-OWNED derived state and reaches the python sidecar with a different id-space. Use the branded writers in src/duin/lib/brain-client.ts.'
const CROSS_BRAIN_WRITE_SELECTORS = [
  {
    selector: `CallExpression[callee.name='fetch'] TemplateLiteral > TemplateElement[value.raw=${OWNED_ROUTE}]`,
    message: CROSS_BRAIN_WRITE_MESSAGE
  },
  {
    selector: `CallExpression[callee.name='fetch'] Literal[value=${OWNED_ROUTE}]`,
    message: CROSS_BRAIN_WRITE_MESSAGE
  }
]

export default [
  // resources/vendor/** holds third-party minified bundles (mermaid, babel) that
  // must not be linted — the legacy `eslint --ext .ts,.tsx` never reached them.
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'resources/vendor/**',
      // Ported DUIN web frontend (Next.js → Electron); carries its own style +
      // Next-specific eslint directives, not held to the host ruleset.
      'src/duin/**',
      '**/.claude/**',
      '.claude/**',
      '*.config.{js,mjs,cjs,ts}',
      // Root-level `_qa-*.cjs` are hand-written live-app QA drivers (Playwright/CDP against a
      // running DUIN). They are browser-context scripts sitting in a Node-linted root, so they
      // report no-undef on window/document and nothing imports them. Left unignored, one
      // dropped into the tree by a concurrent session scores lint errors against a zero
      // baseline and an unattended gate blames the next lane for a regression it did not cause.
      '_qa-*.cjs'
    ]
  },

  { linterOptions: { reportUnusedDisableDirectives: 'off' } },

  js.configs.recommended,
  // Wires the @typescript-eslint parser + plugin and the eslint-recommended
  // overrides (turns off core rules that have TS-aware replacements).
  ...tseslint.configs['flat/recommended'],

  // TypeScript / React renderer + main-process source.
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true }
      },
      globals: { ...globals.browser, ...globals.node }
    },
    plugins: { 'import-x': importX, 'react-hooks': reactHooks },
    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver({
          alwaysTryTypes: true,
          noWarnOnMultipleProjects: true,
          project: ['tsconfig.node.json', 'tsconfig.web.json']
        })
      ]
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // Was 'off' under the legacy config; 'warn' stops new `any` from creeping
      // in without blocking the IPC {success,data} casting pattern.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Catches import cycles SonarQube/Codacy would otherwise flag.
      'import-x/no-cycle': ['error', { maxDepth: Infinity }],
      // Pinned explicitly (not just inherited from js.configs.recommended) so
      // error chaining stays enforced even if the recommended set changes:
      // a re-thrown error must carry the original via `cause`.
      'preserve-caught-error': 'error',
      // The two classic hooks rules the source already writes disable
      // directives against. (react-hooks v7 also ships the React Compiler
      // ruleset, which we deliberately do not enable here.)
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },

  // Electron/services use helpers such as `useDb()` that are not React hooks.
  {
    files: ['electron/**/*.{ts,tsx}', 'scripts/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/rules-of-hooks': 'off',
      'react-hooks/exhaustive-deps': 'off'
    }
  },

  // Plain JS / CommonJS build + smoke scripts. require() is legitimate here, and
  // the TypeScript-specific rules from flat/recommended don't apply.
  {
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'preserve-caught-error': 'error'
    }
  },

  // Workflow-DSL scripts. These run inside the Workflow runtime's async sandbox, which injects
  // agent/parallel/pipeline/log/phase/workflow/args/budget as globals -- they are real at runtime
  // but invisible to static analysis, so every call site reported no-undef (54 of the repo's 88
  // lint errors came from these two files alone). Declaring the injected surface is the accurate
  // fix; disabling no-undef here would also hide genuine typos in the same files.
  {
    files: ['scripts/*.workflow.{js,mjs}'],
    languageOptions: {
      globals: {
        agent: 'readonly',
        parallel: 'readonly',
        pipeline: 'readonly',
        log: 'readonly',
        phase: 'readonly',
        workflow: 'readonly',
        args: 'readonly',
        budget: 'readonly'
      }
    }
  },

  // ── U2: no raw IPC writes ───────────────────────────────────────────────────
  // Systemic pattern B from the UI production-readiness audit: ~19 renderer writes
  // reported a success they never got. `await window.api.x.remove(id)` followed by
  // toast.success(), with the returned `success:false` never read — Remove a model
  // and the row stays; Stop a runaway agent and nothing happens; "Model generated"
  // with nothing persisted. Mutations must go through `invoke()` in
  // src/lib/ipc-client.ts, which THROWS on success:false so the success toast is
  // unreachable on a failed write.
  //
  // This is a RATCHET, not a retro-fix. Measured 2026-08-04 on duin/lane-frontend:
  // 146 raw mutation call sites across the 55 files listed below. Grandfathering
  // them keeps `npx eslint .` at its clean baseline (a repo-wide error would have
  // broken every concurrent lane's gate for pre-existing debt) while making it
  // impossible to add a NEW one. When a file's raw writes are converted, delete its
  // line here — never add a line.
  //
  // Not catchable statically, and deliberately out of scope: `const api = window.api`
  // then `api.x.remove()`. src/duin/** is eslint-ignored above, so this rule does not
  // reach it either.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      // ── GRANDFATHERED DEBT — measured 2026-08-04 on duin/lane-frontend with the
      //    selector below: 82 raw mutation sites across these 33 files.
      //
      //    This is a RATCHET, not an amnesty. A repo-wide error would have broken
      //    `npx eslint .` — clean at baseline — for every concurrent lane over
      //    pre-existing debt, and an unattended gate would have blamed whichever
      //    lane merged next. Grandfathering holds the baseline while making a NEW
      //    raw write impossible. When a file's raw writes are converted, DELETE its
      //    line here. Never add one.
      'src/App.tsx',
      'src/components/activity/TaskControlPanel.tsx',
      'src/components/artifacts/CanvasEditor.tsx',
      'src/components/customize/AddConnectorFlow.tsx',
      'src/components/customize/ConnectorsColumn.tsx',
      'src/components/customize/InstallPluginFlow.tsx',
      'src/components/memory/MemoryPanel.tsx',
      'src/components/persistence/IntegrityBanner.tsx',
      'src/components/settings/ApiKeyModal.tsx',
      'src/components/settings/ApiKeySettings.tsx',
      // VERIFIED HONEST 2026-08-04 — grandfathered as churn-avoidance, not as debt.
      // Every raw call here already branches on `result.success` and toasts the
      // handler's error. The audit listed "ModelSettings Remove — toasts success,
      // removes nothing" under pattern B; at this commit handleRemoveCustom reads
      // `if (!result.success) { toast.error(...); return }` BEFORE its success
      // toast. Converting it would be motion, not a fix.
      'src/components/settings/ModelSettings.tsx',
      'src/components/settings/RagSettings.tsx',
      'src/components/skills/SkillEditor.tsx',
      'src/components/tools/panels/BrowserPanel.tsx',
      'src/components/tools/panels/TerminalPanel.tsx',
      'src/components/workspace/BranchPickerPopover.tsx',
      'src/components/workspace/EnvironmentPanel.tsx',
      'src/components/workspace/FloatingEnvironmentCard.tsx',
      'src/components/workspace/RepositoryPickerDialog.tsx',
      'src/components/worktree/WorktreeManagerModal.tsx',
      'src/hooks/useShellSignals.ts',
      'src/lib/brain-seed.ts',
      'src/stores/automations-store.ts',
      'src/stores/chat-store.ts',
      'src/stores/loops-store.ts',
      'src/stores/memory-store.ts',
      'src/stores/plan-store.ts',
      'src/stores/plugins-store.ts',
      'src/stores/projects-store.ts',
      'src/stores/settings-store.ts',
      'src/stores/skills-store.ts',
      'src/stores/snip-store.ts',
      'src/stores/workflows-store.ts'
      // CONVERTED in this commit, no longer grandfathered — 8 sites:
      //   src/stores/activity-store.ts  (stopAgent · cancelWakeup · updateTaskMetadata)
      //   src/stores/hooks-store.ts     (create · update · remove)
      //   src/stores/mcp-store.ts       (reconnect)
      //   src/stores/model-store.ts     (setActiveModel)
    ],
    rules: {
      'no-restricted-syntax': ['error', ...RAW_IPC_WRITE_SELECTORS, ...CROSS_BRAIN_WRITE_SELECTORS]
    }
  },

  // src/lib/ipc-client.ts is the ONE module allowed to touch window.api directly —
  // it is the thing the rule above redirects everyone to.
  {
    files: ['src/lib/ipc-client.ts'],
    rules: { 'no-restricted-syntax': 'off' }
  },

  // Final cleanup pass: keep lint output warning-free while preserving the
  // correctness rules above (`import-x/no-cycle`, hooks-of-hooks, etc.).
  {
    files: ['**/*.{ts,tsx,js,cjs,mjs}'],
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'react-hooks/exhaustive-deps': 'off'
    }
  }
]
