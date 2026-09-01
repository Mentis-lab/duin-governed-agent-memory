import { StreamingTimeoutsSettings } from './StreamingTimeoutsSettings'
import { ReasoningAuditSettings } from './ReasoningAuditSettings'
import { SeedBudgetSettings } from './SeedBudgetSettings'

// Engine — one home for the small engine-level knobs that each used to occupy
// their own near-empty Advanced tab (Streaming & Timeouts, Reasoning Audit,
// Seed budget). Each child panel renders its OWN header, so this wrapper only
// stacks them with separators — no wrapper headings, to avoid double titles.
export function EngineSettings() {
  return (
    <div className="flex flex-col gap-10">
      <section>
        <StreamingTimeoutsSettings />
      </section>
      <section className="border-t border-[var(--panel-border)] pt-8">
        <ReasoningAuditSettings />
      </section>
      <section className="border-t border-[var(--panel-border)] pt-8">
        <SeedBudgetSettings />
      </section>
    </div>
  )
}
