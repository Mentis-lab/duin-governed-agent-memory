// Agent voice/tone presets. DUIN is a very PERSONAL agent, so how it talks is
// part of the product — a warm, GPT-4-ish voice for engagement; a terse
// "caveman" voice to cut output tokens; etc. The chosen preset is injected as a
// <voice> directive into the system prompt on BOTH chat paths — which takes two
// injection sites, because they compose their prompts in different processes:
//   - raw:-bypass + headless runs  → system-prompt-builder.buildSystemPrompt
//   - the DEFAULT brain path       → ipc/chat.ts resolves the directive, forwards
//     it on the /agui body as `voice`, and agui-grounding renders the same block.
// The second site was missing until 2026-08: buildSystemPrompt is unreachable from
// the brain branch (it returns ~500 lines earlier), so the picker was inert on the
// path essentially every turn takes, with no error to notice.
//
// Keep the ids in sync with src/lib/agent-tones.ts (the picker metadata).

export const AGENT_TONE_DIRECTIVES: Record<string, string> = {
  // Default — DUIN's natural voice; no override.
  balanced: '',

  // Warm / personal (the GPT-4-ish voice people report liking).
  warm:
    'Voice: warm, personable, and encouraging — like a thoughtful companion who knows the user well. ' +
    'Be genuinely friendly and conversational, show interest in what they are doing, and be supportive. ' +
    'Favor natural human language over corporate phrasing. Never saccharine, never sycophantic — warmth with substance.',

  // Concise — answer-first, minimal fluff.
  concise:
    'Voice: concise and direct. Lead with the answer, then only the essential detail. ' +
    'Cut preamble, filler, and hedging. Short sentences. Skip pleasantries unless asked.',

  // Caveman — minimize output tokens (JuliusBrussee/caveman style).
  caveman:
    'Voice: caveman mode — minimize output tokens. Short, broken sentences. ' +
    'Drop articles (a/an/the), most pronouns, and filler words (is/are/that/which). ' +
    'No politeness, no preamble, no restating the question. Keep only meaningful words. ' +
    'Prefer symbols: → for causality, = for equals, vs for versus. ' +
    'Still fully accurate — give the answer in the fewest words possible. Expand only if the user asks.',

  // Professional — precise, measured, business-appropriate.
  professional:
    'Voice: professional and precise. Clear structure, measured tone, no slang or emoji. ' +
    'Business-appropriate and unambiguous.',

  // Playful — witty with personality, still sharp.
  playful:
    'Voice: playful and witty, with a bit of personality and light humor — but still sharp, accurate, and helpful. ' +
    'Keep jokes light; never let them get in the way of the substance.'
}

/** Resolve the active tone to a directive string ('' = no override). */
export function resolveToneDirective(tone?: string, custom?: string): string {
  if (tone === 'custom') return (custom ?? '').trim()
  return AGENT_TONE_DIRECTIVES[tone ?? 'balanced'] ?? ''
}
