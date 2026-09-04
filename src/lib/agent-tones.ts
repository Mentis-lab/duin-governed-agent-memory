// Voice/tone picker metadata (renderer). The directives themselves live in
// electron/services/agent-tones.ts (injected into the system prompt); keep the
// ids here in lockstep. `agentTone` in AppSettings stores the chosen id.
//
// Label, hint and sample resolve lazily (inside render) so they follow the UI
// language: a module-level string would be translated once, at import, in
// whatever language was active before settings loaded.

import { t, tc } from '@/lib/i18n'

export interface AgentToneOption {
  id: string
  label: () => string
  /** One-line hint shown under the label in the picker. */
  hint: () => string
  /** A short sample of how a reply sounds in this voice. Empty for `custom`. */
  sample: () => string
}

export const AGENT_TONES: AgentToneOption[] = [
  {
    id: 'balanced',
    label: () => t('Balanced'),
    hint: () => t('DUIN’s natural voice: clear and helpful, no strong slant.'),
    sample: () => t('Done — I moved the file and updated the two references. Want me to run the tests?')
  },
  {
    id: 'warm',
    // `voice|Warm` — the Appearance page has a colour preset named Warm, and the two
    // words do not share a translation.
    label: () => tc('voice', 'Warm'),
    hint: () => t('Personable and encouraging.'),
    sample: () => t('Nice — that’s sorted! I moved the file and fixed the references for you. Happy to run the tests next if you’d like.')
  },
  {
    id: 'concise',
    label: () => t('Concise'),
    hint: () => t('Answer first, short and direct.'),
    sample: () => t('Moved the file, updated 2 references. Run tests?')
  },
  {
    // The id stays `caveman` (the main-side directive map keys on it); only the label moved.
    id: 'caveman',
    label: () => t('Terse'),
    hint: () => t('Shortest replies, lowest cost: about half the words.'),
    sample: () => t('File moved. 2 refs fixed. Run tests?')
  },
  {
    id: 'professional',
    label: () => t('Professional'),
    hint: () => t('Precise, measured, business-appropriate.'),
    sample: () => t('The file has been relocated and both references updated. Shall I proceed with the test suite?')
  },
  {
    id: 'playful',
    label: () => t('Playful'),
    hint: () => t('Witty with personality, still sharp.'),
    sample: () => t('Boom — file relocated, references wrangled into place. Tests next, or are we living dangerously?')
  },
  {
    id: 'custom',
    label: () => t('Custom'),
    hint: () => t('Write your own voice directive.'),
    sample: () => ''
  }
]
