// Voice/tone picker metadata (renderer). The directives themselves live in
// electron/services/agent-tones.ts (injected into the system prompt); keep the
// ids here in lockstep. `agentTone` in AppSettings stores the chosen id.

export interface AgentToneOption {
  id: string
  label: string
  /** One-line hint shown under the label in the picker. */
  hint: string
  /** A short sample of how a reply sounds in this voice. */
  sample: string
}

export const AGENT_TONES: AgentToneOption[] = [
  {
    id: 'balanced',
    label: 'Balanced',
    hint: "DUIN's natural voice — clear and helpful, no strong slant.",
    sample: 'Done — I moved the file and updated the two references. Want me to run the tests?'
  },
  {
    id: 'warm',
    label: 'Warm',
    hint: 'Personable and encouraging — the friendly, GPT-4-ish voice.',
    sample: "Nice — that's sorted! I moved the file and fixed the references for you. Happy to run the tests next if you'd like."
  },
  {
    id: 'concise',
    label: 'Concise',
    hint: 'Answer-first, minimal fluff. Short and direct.',
    sample: 'Moved the file, updated 2 references. Run tests?'
  },
  {
    id: 'caveman',
    label: 'Caveman',
    hint: 'Terse token-saver — drops filler, ~50% fewer output tokens.',
    sample: 'File moved. 2 refs fixed. Run tests?'
  },
  {
    id: 'professional',
    label: 'Professional',
    hint: 'Precise, measured, business-appropriate.',
    sample: 'The file has been relocated and both references updated. Shall I proceed with the test suite?'
  },
  {
    id: 'playful',
    label: 'Playful',
    hint: 'Witty with personality — still sharp.',
    sample: "Boom — file relocated, references wrangled into place. Tests next, or are we living dangerously?"
  },
  {
    id: 'custom',
    label: 'Custom',
    hint: 'Write your own voice directive.',
    sample: ''
  }
]
