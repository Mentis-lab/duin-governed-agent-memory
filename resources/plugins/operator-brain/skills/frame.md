---
name: frame
description: Before producing a make-or-break output (a decision, a message that will be sent, a plan, a piece of writing), pull the user's accumulated taste from DUIN's learn loop and frame the work through it. Use for high-stakes or forwardable outputs. Not for quick factual answers or throwaway drafts.
autoInvoke: true
allowedTools:
  - Read
  - shell_command
---

# frame

Accumulated judgment is worthless if it never touches new work. This skill closes the front half of the
loop: it reads the taste DUIN has computed from the user's corrections and uses it to *angle* the
output — so the result reflects how this user actually decides, not the model's default. This is the
litmus that matters: does the accumulated operator-state make the output fit the user better than the
same model would cold?

## When this skill activates

Before an output that is high-stakes, outward-facing, or hard to reverse: a decision recommendation, a
message that will be sent, a plan, a forwardable artifact, a judgment call between options.

## How it works (wired to DUIN's learn loop)

1. **Read the context** — domain, audience, artifact type of what you're about to produce.
2. **Pull computed taste** from the brain:
   ```
   shell_command: curl -s http://127.0.0.1:8799/learn/taste
   ```
   This returns the taste the loop has learned from promoted/positive corrections (the FAST arrow —
   behavior shifts from taste before any vault rule is promoted). Treat higher-weight entries as the
   user's stronger preferences.
3. **Build a small frame set** (don't over-retrieve — 2-4 frames):
   - **Lead lens** — the top-weighted taste entry relevant to this context; produce primarily through it.
   - **Baseline floor** — any always-on preference (the user's non-negotiables); carried, never diverged.
   - **One wild frame** — deliberately rotate in one off-axis angle (the counterparty's view,
     first-principles, "what would make this wrong") so the output has range, not just conformity.
4. **Produce, then self-check** — before finishing, verify the output honors the lead lens and violates
   no baseline. If two taste entries conflict, surface the conflict rather than silently picking one.

## Hard rules
- Apply taste as *framing*, not as quoted instructions — the goal is fit, not parroting.
- If taste is empty or nothing matches, say so and proceed with the model's own judgment — don't
  manufacture a fit. (An empty taste block is the honest state of a brand-new brain; **capture** fills it.)

## Hand-offs
- Recording new judgment from the user's reaction → **capture**.
- Deciding whether accumulated judgment deserves to keep informing work → **audit**.
