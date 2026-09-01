import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/ui/Toggle'
import { scaffoldSeed, markOnboarded, type InterviewAnswers } from '@/lib/brain-seed'
import { buildIdentityFiles, hasIdentitySignal, type IdentityInput } from '@/lib/brain-identity'
import { useUiStore } from '@/stores/ui-store'
import { useSettingsStore } from '@/stores/settings-store'
import { ApiKeyModal } from '@/components/settings/ApiKeyModal'
import { FEATURED_PROVIDERS } from './provider-cards'
import { t, tf } from '@/lib/i18n'

// First-run onboarding (rebuilt against DUIN_ONBOARDING_BENCHMARK.md).
//
// The whole flow is jargon-free (Dim 3) and collapses to ≤3 required actions to a
// first grounded answer (Dim 2): pick a folder → it auto-advances → open your
// brain. Picking a folder indexes existing files (keyless), seeds a typed concept
// skeleton for a fresh/empty vault (Dim 6), shows live index progress + a friendly
// offline message (Dim 2/5), makes the vault legible as your own Markdown files
// (Dim 7), and ends on a concrete come-back reason + a daily-digest opt-in (Dim 8).
// Connecting an AI model stays fully OPTIONAL — never a wall (Dim 5).
//
// All user-visible copy goes through t()/tf() — the coldstart is the ONE surface a
// brand-new operator is guaranteed to see, so it must render in the OS language
// (settings.language defaults to 'auto', resolved eagerly at i18n module load).
// Strings are lazy (inside functions/render), never module-const t() calls, so a
// runtime language switch re-evaluates them on the App-level keyed remount.

interface OnboardingFlowProps {
  onClose: () => void
}

type Step = 0 | 1

function openExternal(url: string): void {
  window.api?.artifact?.openExternal?.(url)
}

function interviewQuestions(): { key: keyof InterviewAnswers; label: string; placeholder: string }[] {
  return [
    { key: 'working', label: t('What are you working on right now?'), placeholder: t('One per line, e.g.\nShip the v1 launch\nClose the Q3 deal') },
    { key: 'deciding', label: t("Is there a decision you're weighing?"), placeholder: t('e.g. Whether to open the public beta in March') },
    { key: 'worried', label: t('Anything you’re worried might slip?'), placeholder: t('One per line, e.g.\nVendor SLA\nBudget overrun') }
  ]
}

function phaseLabel(phase: string | undefined): string {
  switch (phase) {
    case 'scanning': return t('Finding your files')
    case 'chunking': return t('Reading them')
    case 'embedding': return t('Building your private search index')
    case 'ready': return t('Ready')
    default: return t('Setting up your brain')
  }
}

export function OnboardingFlow({ onClose }: OnboardingFlowProps): React.ReactElement {
  const [step, setStep] = useState<Step>(0)
  // Files / index
  const [folder, setFolder] = useState<string | null>(null)
  const [indexing, setIndexing] = useState(false)
  const [indexedCount, setIndexedCount] = useState<number | null>(null)
  const [progress, setProgress] = useState<{ phase: string; done: number; total: number } | null>(null)
  const [offlineReason, setOfflineReason] = useState<string | null>(null)
  /** Setup failed outright (cold-start D3/D4) — distinct from offlineReason, which is a
   *  DEGRADED-but-working state. This one means no brain was built, so the flow must not
   *  advance and must say why. */
  const [setupError, setSetupError] = useState<string | null>(null)
  // Interview (optional)
  const [showInterview, setShowInterview] = useState(false)
  const [answers, setAnswers] = useState<InterviewAnswers>({ working: '', deciding: '', worried: '' })
  const [about, setAbout] = useState<{ name: string; role: string; workingStyle: string }>({ name: '', role: '', workingStyle: '' })
  const [seededCount, setSeededCount] = useState(0)
  const [identityWrote, setIdentityWrote] = useState<string[] | null>(null)
  // Connect-AI (optional, on the ready step)
  const [showConnect, setShowConnect] = useState(false)
  const [ollama, setOllama] = useState<{ available: boolean; models: string[] } | null>(null)
  // Key modal: `{ provider }` from a provider card (scoped), `{}` from the generic
  // "Connect a model →" banners — UNSCOPED, so the modal shows the full card grid
  // instead of pinning the user to a provider they never chose (was hardcoded 'openai').
  const [keyModal, setKeyModal] = useState<{ provider?: string } | null>(null)
  // Ready-step surfaces
  const [returnReason, setReturnReason] = useState<string | null>(null)
  const [digestOn, setDigestOn] = useState(false)
  const [showHow, setShowHow] = useState(false)
  // Full computer access — OFF by default in the public build (release D6). The ready step
  // presents the choice once, as one line + a toggle, and persists it through the same settings
  // store Settings → General → Computer access uses, so the two never disagree.
  const fullAccessOn = useSettingsStore((s) => s.settings.fullComputerAccess === true)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  // Live entity-graph build status (Dim 2): the LLM construction runs for MINUTES after indexing shows
  // "ready", so surface started/done here instead of leaving it invisible. null = no signal yet.
  const [buildState, setBuildState] = useState<{ phase: 'started' | 'done'; status?: string; entities?: number; edges?: number } | null>(null)

  // Keep the freshest interview answers available to the async folder-pick handler.
  const answersRef = useRef(answers)
  answersRef.current = answers
  const aboutRef = useRef(about)
  aboutRef.current = about

  // Escape closes the flow FOR NOW — it does NOT mark onboarding done, so the next boot
  // re-offers it. (It used to markOnboarded(): one reflex Escape — including cancelling an
  // IME conversion while typing an interview answer — permanently consumed onboarding with
  // no vault configured and no re-entry surface. Permanent dismissal is the explicit
  // "Skip for now" button's job.) Guards: IME composition, focus inside a text field
  // (Escape there means "leave the field", not "destroy the flow"), the key modal
  // (which owns its own dismissal), and mid-setup indexing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing) return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return
      if (keyModal) return
      if (indexing) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, keyModal, indexing])

  // Live indexing progress + offline model-download message (Dim 2/5).
  useEffect(() => {
    const offProgress = window.api?.rag?.onIndexProgress?.((e) => setProgress(e))
    const offDownload = window.api?.rag?.onModelDownload?.((e) => {
      if (e?.type === 'rag.model.download.failed' && e.reason) setOfflineReason(e.reason)
    })
    const offBuild = window.api?.brain?.onBuild?.((e) => setBuildState(e))
    return () => { offProgress?.(); offDownload?.(); offBuild?.() }
  }, [])

  // On reaching the ready step: fetch the come-back reason + current digest opt-in.
  useEffect(() => {
    if (step !== 1) return
    let alive = true
    void (async () => {
      try {
        const r = await window.api?.brain?.homeDigest?.()
        const d = r?.success ? (r.data as { returnReason?: string } | undefined) : undefined
        if (alive && d?.returnReason) setReturnReason(d.returnReason)
      } catch { /* non-fatal */ }
      try {
        const s = await window.api?.notifications?.getDigestSchedule?.()
        if (alive && s?.success && s.data) setDigestOn(!!s.data.enabled)
      } catch { /* non-fatal */ }
    })()
    return () => { alive = false }
  }, [step])

  // Detect a local Ollama only when the user opens the optional connect panel.
  useEffect(() => {
    if (!showConnect || ollama !== null) return
    let alive = true
    void (async () => {
      try {
        const r = await window.api?.brain?.detectOllama?.()
        if (alive) setOllama(r?.success ? (r.data ?? { available: false, models: [] }) : { available: false, models: [] })
      } catch { if (alive) setOllama({ available: false, models: [] }) }
    })()
    return () => { alive = false }
  }, [showConnect, ollama])

  const skip = (): void => { markOnboarded(); onClose() }
  const openBrain = (): void => { useUiStore.getState().setActiveTool('brain'); onClose() }

  // The single required action: point DUIN at a folder. Indexes existing files,
  // grounds the brain in WHO the user is when the optional interview carried a
  // signal, seeds a typed concept skeleton (fresh vault → real graph, not blank)
  // — then AUTO-ADVANCES (Dim 2). Onboarding is marked done ONLY on success.
  const chooseFolder = async (): Promise<void> => {
    const r = await window.api?.brain?.pickFolder?.()
    if (!r?.success || r.data == null) return
    const dir = r.data
    setFolder(dir)
    setIndexing(true)
    setProgress(null)
    setOfflineReason(null)
    setSetupError(null)
    // A re-pick must not keep showing the PREVIOUS folder's graph verdict ("graph
    // ready — N entities") while the new build runs.
    setBuildState(null)
    try {
      // A failed settings write must not fall through: reindex would then run against
      // the still-unset previous dir, index nothing, and report "✓ Read 0 files" as
      // success while the picked folder was never adopted.
      const sr = await window.api?.settings?.set?.({ localBrainNotesDir: dir })
      if (sr && sr.success === false) {
        throw new Error(sr.error || t('Could not save the folder choice.'))
      }

      // Index the user's existing files (keyless). Progress streams over the
      // rag:index:progress subscription above.
      //
      // A FAILED reindex must not render as success (cold-start D3). This used to be
      // `setIndexedCount(ri?.success ? … : 0)` and then fall through to the ready step, so a
      // reindex that errored — unreadable folder, embedder missing, locked DB — looked
      // identical to an empty vault: "0 notes indexed", brain ready, nothing wrong. The
      // operator's very first impression of the product was a silent failure they had no way
      // to distinguish from having no notes.
      const ri = await window.api?.brain?.reindex?.()
      if (!ri?.success) {
        throw new Error(ri?.error || t('Could not index that folder.'))
      }
      setIndexedCount(ri.data?.count ?? 0)

      // IDENTITY FIRST, then structure, then content — and identity must land BEFORE any
      // scaffold writes its stub ME.md/BRAIN.md. The old order ran the OKF scaffold first
      // (which creates stub identity files on a fresh vault) and then called writeIdentity
      // in no-clobber mode — so the interview the user just filled in was silently dropped
      // (`success:true, wrote:[]`) and the vault kept the generic "*(Tell DUIN who you
      // are...)*" stub forever. Both scaffolds are no-clobber, so real files written here
      // survive them; on an EXISTING vault with real identity files, everything below
      // safely skips.
      const input: IdentityInput = { ...aboutRef.current, ...answersRef.current }
      const identity = hasIdentitySignal(input) ? buildIdentityFiles(input) : null
      let identityLanded = false

      // scaffoldNewOperator stands up the vault: .brain/{memory,skills,agents,hooks,state},
      // the operator-fact store, and the per-vault cold-start marker — and, when the
      // interview carried a signal, the REAL ME.md/BRAIN.md via its identity option.
      // Runs unprompted by design: the product is autonomous, so a first run sets itself
      // up rather than asking permission to. Idempotent, no-clobber, and a true no-op once
      // markColdStarted has fired, so an existing operator's boot is untouched.
      // Non-fatal on failure: a vault that cannot be scaffolded can still be indexed and
      // searched, and failing the whole first run over the scaffold would be a worse
      // outcome than a plainer brain.
      try {
        const so = await window.api?.brain?.scaffoldNewOperator?.(
          dir,
          identity ? { identity: { meMd: identity.meMd, brainMd: identity.brainMd } } : undefined
        )
        if (identity && so?.success) identityLanded = true
      } catch { /* non-fatal — indexing already succeeded; the brain is usable */ }

      // Fallback for the scaffold having failed above: persist identity directly,
      // BEFORE the seed below can write its stubs (no-clobber — a skip here means
      // the files already exist, i.e. landed).
      if (identity) {
        try {
          const res = await window.api?.brain?.writeIdentity?.(dir, identity.meMd, identity.brainMd)
          if (res?.success) identityLanded = true
        } catch { /* non-fatal — identity can be added later in Settings */ }
        if (identityLanded) setIdentityWrote(['ME.md', 'BRAIN.md'])
      }

      // Cold-start seed (Dim 6): materialize a typed OKF concept skeleton (+ any
      // interview answers as typed project/decision/risk concepts) so even an
      // empty vault gets a real first-run graph. Its identity stubs are no-clobber,
      // so the real files above survive it.
      const seed = await scaffoldSeed(answersRef.current, dir)
      if (seed.ok) setSeededCount(seed.conceptsWritten)

      // Only a genuinely successful setup consumes onboarding. This used to fire at the
      // top of the folder pick: any failure after it (reindex error, settings write
      // error) left the operator with no vault AND no onboarding on every future boot.
      markOnboarded()
    } catch (err) {
      // `finally` with NO `catch` (cold-start D4): every failure above — a rejected reindex, a
      // settings write that threw — still fell through to setStep(1) and told the operator the
      // brain was ready. Surface it and STAY on the picker so they can retry or choose another
      // folder, rather than advancing into a brain that was never built.
      setSetupError((err as Error)?.message || t('Setup failed. Try that folder again, or pick another.'))
      setIndexing(false)
      return
    } finally {
      setIndexing(false)
    }
    setStep(1) // auto-advance to the ready step — only on a genuinely successful setup
  }

  const openVaultFolder = (): void => {
    if (folder) void window.api?.app?.openPath?.(folder)
  }

  const toggleDigest = async (): Promise<void> => {
    const next = !digestOn
    setDigestOn(next)
    try {
      const s = await window.api?.notifications?.setDigestSchedule?.({ enabled: next })
      if (s?.success && s.data) setDigestOn(!!s.data.enabled)
      else setDigestOn(!next) // {success:false} must not leave the optimistic ON standing
    } catch { setDigestOn(!next) /* revert on failure */ }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('Welcome to DUIN: set up your brain')}
        // max-h + overflow: this panel is a CENTERED flex child, so once its content outgrows the
        // viewport it overflows off BOTH ends and the top becomes unreachable — nothing scrolls.
        // Expanding the provider-card list on step 1 is enough to trigger it. Same bound the
        // ApiKeyModal already uses.
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-bg)] p-6 shadow-2xl"
      >
        <div className="mb-4 flex items-center gap-1.5">
          {[0, 1].map((s) => (
            <span key={s} className={`h-1 flex-1 rounded-full ${s <= step ? 'bg-[var(--accent)]' : 'bg-[var(--panel-border)]'}`} />
          ))}
        </div>

        {step === 0 && (
          <div>
            <h2 className="text-[20px] font-semibold text-[var(--text-primary)]">{t('Welcome to DUIN')}</h2>
            <p className="mt-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">
              {t('DUIN turns your notes into a second brain you can ask questions and see. Point it at a folder of your files — it reads them and can answer, right away, with no account and no setup. Your files and the search index stay on this computer; only a model you connect yourself is sent your questions and the relevant excerpts.')}
            </p>

            <div className="mt-5 rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" className="rounded-lg font-semibold" onClick={() => void chooseFolder()} disabled={indexing}>
                  {indexing ? t('Setting up…') : folder ? t('Choose a different folder') : t('Choose a folder')}
                </Button>
                {!indexing && indexedCount != null && (
                  <span className="text-[12px] text-[var(--accent)]">
                    {indexedCount === 1 ? tf('✓ Read {n} file', { n: indexedCount }) : tf('✓ Read {n} files', { n: indexedCount })}
                  </span>
                )}
              </div>
              <p className="mt-2 text-[12px] text-[var(--text-muted)]">
                {t('New to this? Pick any empty folder — DUIN will start your brain there as plain files you own.')}
              </p>

              {folder && <div className="mt-2 truncate font-mono text-[11px] text-[var(--text-muted)]">{folder}</div>}

              {/* Live progress — no silent multi-minute wait (Dim 2). */}
              {indexing && (
                <div className="mt-3">
                  <div className="flex items-center justify-between text-[11px] text-[var(--text-secondary)]">
                    <span>{phaseLabel(progress?.phase)}…</span>
                    {progress && progress.total > 0 && <span className="font-mono">{progress.done}/{progress.total}</span>}
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--panel-border)]">
                    <div
                      className="h-full rounded-full bg-[var(--accent)] transition-[width]"
                      style={{ width: progress && progress.total > 0 ? `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%` : '30%' }}
                    />
                  </div>
                </div>
              )}

              {/* Setup FAILED — no brain was built. Distinct from the offline notice below,
                  which is a degraded-but-working state. Shown here on the picker, because the
                  flow deliberately does not advance on failure any more. */}
              {setupError && (
                <div className="mt-3 rounded-lg border border-[var(--danger,#e0705c)]/50 bg-[var(--danger,#e0705c)]/10 p-2.5 text-[12px] leading-relaxed text-[var(--text-primary)]">
                  <div className="font-semibold">{t('Couldn’t set up that folder')}</div>
                  <div className="mt-1 text-[var(--text-secondary)]">{setupError}</div>
                  <button
                    onClick={() => void chooseFolder()}
                    className="mt-2 block rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-fg,#fff)] hover:opacity-90"
                  >
                    {t('Try another folder →')}
                  </button>
                </div>
              )}

              {/* Friendly offline message instead of a stall (Dim 2/5). */}
              {offlineReason && (
                <div className="mt-3 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-2.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                  {offlineReason}
                  <button onClick={() => setKeyModal({})}
                    className="mt-2 block rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-fg,#fff)] hover:opacity-90">
                    {t('Connect a model →')}
                  </button>
                </div>
              )}
            </div>

            {/* Optional: tell DUIN who you are (grounds every answer). */}
            <button onClick={() => setShowInterview((v) => !v)}
              className="mt-3 flex items-center gap-1.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
              <span className={`transition-transform ${showInterview ? 'rotate-90' : ''}`}>▸</span>
              {t('Tell DUIN a bit about you — optional, makes answers more relevant')}
            </button>
            {showInterview && (
              <div className="mt-2 space-y-2.5">
                <div className="space-y-2 rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-2.5">
                  <span className="text-[12px] font-medium text-[var(--text-secondary)]">{t('A bit about you')}</span>
                  <input value={about.name} onChange={(e) => setAbout((a) => ({ ...a, name: e.target.value }))}
                    placeholder={t('What should DUIN call you?')}
                    className="w-full rounded-lg border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none" />
                  <input value={about.role} onChange={(e) => setAbout((a) => ({ ...a, role: e.target.value }))}
                    placeholder={t('What you do: e.g. Game publishing lead')}
                    className="w-full rounded-lg border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none" />
                  <textarea value={about.workingStyle} onChange={(e) => setAbout((a) => ({ ...a, workingStyle: e.target.value }))}
                    placeholder={t('How to work with you: e.g. be concise, flag risks early')} rows={2}
                    className="w-full resize-none rounded-lg border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none" />
                </div>
                {interviewQuestions().map((q) => (
                  <label key={q.key} className="block">
                    <span className="text-[12px] font-medium text-[var(--text-secondary)]">{q.label}</span>
                    <textarea value={answers[q.key]} onChange={(e) => setAnswers((a) => ({ ...a, [q.key]: e.target.value }))}
                      placeholder={q.placeholder} rows={2}
                      className="mt-1 w-full resize-none rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none" />
                  </label>
                ))}
                <p className="text-[11px] text-[var(--text-muted)]">{t('Fill this in first, then choose your folder — DUIN saves it as plain notes in your brain.')}</p>
              </div>
            )}

            <div className="mt-5 flex items-center justify-between">
              <button onClick={skip} className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                {t('Skip for now')}
              </button>
              <span className="text-[11px] text-[var(--text-muted)]">{t('Files and the local index stay on this machine.')}</span>
            </div>
          </div>
        )}

        {step === 1 && (
          <div>
            <div className="text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent-dim)] text-[26px]">🧠</div>
              <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">{t('Your brain is ready')}</h2>
              <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                {[
                  indexedCount != null && indexedCount > 0
                    ? (indexedCount === 1 ? tf('Read {n} file.', { n: indexedCount }) : tf('Read {n} files.', { n: indexedCount }))
                    : null,
                  seededCount > 0
                    ? (seededCount === 1 ? tf('Started your brain with {n} concept.', { n: seededCount }) : tf('Started your brain with {n} concepts.', { n: seededCount }))
                    : null,
                  identityWrote && identityWrote.length > 0 ? t('Grounded it in who you are.') : null,
                  t('Open it to explore and ask questions — DUIN answers from your notes and gets smarter as you use it.')
                ].filter(Boolean).join(' ')}
              </p>
            </div>

            {/* If the local search model couldn't download (offline), say so plainly
                — keyless/keyword search still works, so this isn't a dead end. */}
            {offlineReason && (
              <div className="mt-3 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-2.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                {offlineReason}
                <button onClick={() => setKeyModal({})}
                  className="mt-2 block rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-fg,#fff)] hover:opacity-90">
                  {t('Connect a model →')}
                </button>
              </div>
            )}

            {/* Graph build (Dim 2): the entity-graph construction runs for MINUTES after indexing,
                invisibly. Surface started/done so "ready" doesn't imply the graph is finished — and make
                the keyless "connect a model" state prominent, not just a transient toast. */}
            {buildState?.phase === 'started' && (
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-2.5 text-[12px] text-[var(--text-secondary)]">
                <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
                {t('Building your knowledge graph from your notes… this takes a few minutes and keeps going in the background.')}
              </div>
            )}
            {buildState?.phase === 'done' && buildState.status !== 'no-model' && buildState.status !== 'model-error' && (buildState.entities ?? 0) > 0 && (
              <div className="mt-3 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent-dim)] p-2.5 text-[12px] text-[var(--text-secondary)]">
                {buildState.entities === 1
                  ? tf('✓ Knowledge graph ready — {n} entity connected from your notes.', { n: buildState.entities ?? 0 })
                  : tf('✓ Knowledge graph ready — {n} entities connected from your notes.', { n: buildState.entities ?? 0 })}
              </div>
            )}
            {/* A build that CRASHED (quota, billing, network — with a configured key) used to
                match no branch at all: the spinner vanished and nothing explained the missing
                graph. The user with a paid key saw LESS feedback than the keyless user. */}
            {buildState?.phase === 'done' && buildState.status === 'model-error' && (
              <div className="mt-3 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-2.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                {t('The knowledge graph build failed — your AI provider rejected the request. Check the account’s balance or quota; DUIN retries as your notes change.')}
              </div>
            )}
            {buildState?.phase === 'done' && buildState.status === 'no-model' && (
              <div className="mt-3 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-2.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                <strong className="text-[var(--text-primary)]">{t('Connect an AI model to build your knowledge graph.')}</strong>{' '}
                {t('DUIN indexed your notes for search, but building the entity graph — people, projects, decisions and how they connect — needs a model. Connect one and it builds automatically.')}
                <button onClick={() => setKeyModal({})}
                  className="mt-2 block rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-fg,#fff)] hover:opacity-90">
                  {t('Connect a model →')}
                </button>
              </div>
            )}

            {/* Trust / legibility (Dim 7): your brain is plain Markdown you own. */}
            {folder && (
              <div className="mt-4 rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono text-[11px] text-[var(--text-muted)]">{folder}</span>
                  <button onClick={openVaultFolder} className="shrink-0 text-[12px] font-medium text-[var(--accent)] hover:underline">
                    {t('Open folder →')}
                  </button>
                </div>
                <p className="mt-1.5 text-[12px] text-[var(--text-secondary)]">
                  {t('DUIN keeps your brain as plain Markdown files you own — open them in any editor, back them up, take them anywhere. The files and local index remain on this machine.')}
                </p>
              </div>
            )}

            {/* How DUIN answers (Dim 7): retrieval-shown, explained once. */}
            <button onClick={() => setShowHow((v) => !v)}
              className="mt-3 flex items-center gap-1.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
              <span className={`transition-transform ${showHow ? 'rotate-90' : ''}`}>▸</span>
              {t('How DUIN answers')}
            </button>
            {/* Describes what a grounded answer ACTUALLY looks like today: the
                source named in the prose (rag/context-builder.ts asks for that
                by name). It used to demo a clickable numbered CitationChip and
                promise "tap a chip to open the note" — an affordance the real
                transcript has never produced, because the chip component has no
                production caller and no sourceMap ever reaches the renderer. */}
            {showHow && (
              <div className="mt-2 rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-3">
                <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
                  {t('When you ask something, DUIN answers from the notes it finds and names the ones it used, so you can go read them yourself. For example:')}
                </p>
                <p className="mt-2 text-[12px] text-[var(--text-primary)]">
                  {t('“You planned to ship the beta in March — from Q3-planning.md”')}
                </p>
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">{t('When nothing in your notes supports an answer, DUIN says so — no guessing, no made-up answers.')}</p>
              </div>
            )}

            {/* Retention (Dim 8): a concrete reason to come back. */}
            {returnReason && (
              <div className="mt-3 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent-dim)] p-3">
                <div className="text-[12px] font-semibold text-[var(--text-primary)]">{t('Come back tomorrow')}</div>
                <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">{returnReason}</p>
              </div>
            )}

            {/* Digest opt-in (Dim 8), jargon-free. */}
            <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-3">
              <Toggle checked={digestOn} onChange={() => void toggleDigest()} aria-label={t('Send me a daily brain digest')} className="mt-0.5" />
              <span>
                <span className="text-[12px] font-medium text-[var(--text-primary)]">{t('Send me a daily brain digest')}</span>
                <span className="mt-0.5 block text-[12px] text-[var(--text-secondary)]">{t('A gentle once-a-day summary of what changed in your brain. No account — it stays on this device.')}</span>
              </span>
            </label>

            {/* Computer access — one line + a toggle, default OFF (release D6). Mirrors
                Settings → General → Computer access through the same settings store. */}
            <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-3">
              <Toggle checked={fullAccessOn} onChange={(v) => void updateSettings({ fullComputerAccess: v })} aria-label={t('Let DUIN act anywhere on this computer')} className="mt-0.5" />
              <span>
                <span className="text-[12px] font-medium text-[var(--text-primary)]">{t('Let DUIN act anywhere on this computer')}</span>
                <span className="mt-0.5 block text-[12px] text-[var(--text-secondary)]">{t('Off by default: DUIN stays inside your brain folder and asks before running commands. On: it can read, write, move and delete files anywhere and run commands without asking. Change it any time in Settings → General.')}</span>
              </span>
            </label>

            {/* Connect an AI model — fully optional (Dim 5). */}
            <button onClick={() => setShowConnect((v) => !v)}
              className="mt-3 flex items-center gap-1.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
              <span className={`transition-transform ${showConnect ? 'rotate-90' : ''}`}>▸</span>
              {t('Want fuller, conversational answers? Connect an AI model — optional')}
            </button>
            {showConnect && (
              <div className="mt-2 space-y-2.5">
                <div className="rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-medium text-[var(--text-primary)]">{t('Free local model')} <span className="text-[11px] font-normal text-[var(--text-muted)]">{t('private · no cost')}</span></span>
                    {ollama === null ? <span className="text-[11px] text-[var(--text-muted)]">{t('checking…')}</span>
                      : ollama.available ? <span className="text-[11px] font-medium text-[var(--accent)]">{tf('✓ Found on this computer ({n})', { n: ollama.models.length })}</span>
                      : <span className="text-[11px] text-[var(--text-muted)]">{t('not detected')}</span>}
                  </div>
                  {ollama?.available
                    ? <p className="mt-1.5 text-[12px] text-[var(--text-secondary)]">{t('DUIN found a free local model on your computer — it’ll use it automatically. Questions and retrieved excerpts stay on this computer.')}</p>
                    : <p className="mt-1.5 text-[12px] text-[var(--text-secondary)]">{t('Install')} <button onClick={() => openExternal('https://ollama.com')} className="text-[var(--accent)] hover:underline">{t('Ollama')}</button> {t('(free, runs on your computer, works offline) — DUIN picks it up automatically.')}</p>}
                </div>

                <div className="rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-3">
                  <span className="text-[12px] font-medium text-[var(--text-primary)]">{t('Use an online model')}</span>
                  <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">{t('Pick a service and paste a key. Most have a free tier — the link opens the page to get one. When you use an online model, DUIN sends that provider your current question plus relevant excerpts and personalization context, and — to build your knowledge graph — your notes, in batches.')}</p>
                  <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {FEATURED_PROVIDERS.map((p) => (
                      <div key={p.cardId} className="flex flex-col rounded-lg border border-[var(--panel-border)] bg-[var(--panel-bg)] p-2.5">
                        <span className="text-[12px] font-semibold text-[var(--text-primary)]">{p.name}</span>
                        <span className="mt-0.5 text-[11px] leading-snug text-[var(--text-muted)]">{t(p.blurb)}</span>
                        <div className="mt-1.5 flex items-center gap-2">
                          <button onClick={() => setKeyModal({ provider: p.providerId })} className="text-[11px] font-medium text-[var(--accent)] hover:underline">{t('Paste key')}</button>
                          <button onClick={() => openExternal(p.docsUrl)} className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:underline">{t('Get a key →')}</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="mt-5 flex items-center justify-between">
              <button onClick={skip} className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">{t('Close')}</button>
              <Button variant="primary" className="rounded-lg font-semibold" autoFocus onClick={openBrain}>{t('Open my brain →')}</Button>
            </div>
          </div>
        )}
      </div>

      {keyModal && (
        <ApiKeyModal
          required={false}
          defaultProvider={keyModal.provider}
          onDismiss={() => setKeyModal(null)}
          onComplete={() => setKeyModal(null)}
        />
      )}
    </div>
  )
}
