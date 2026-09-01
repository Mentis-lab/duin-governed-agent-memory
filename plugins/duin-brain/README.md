# DUIN Brain — MCP plugin

Mounts a running DUIN as an MCP server so another agent can borrow its
executive function: operator-calibrated context and beliefs, plus a shared
fleet goal state with write leases and operator-gated completion.

```
/plugin marketplace add https://github.com/Mentis-lab/DUIN
/plugin install duin-brain@duin
```

## Before it will connect

The endpoint is loopback-only and every agent authenticates as its own
**principal**. There are two ways to get one.

### The short way: the operator mints a token

In DUIN, open **Settings → Agents → Add an agent**. Name it, tick what it may
do, and you get a token once. Set it where the agent runs:

```powershell
[Environment]::SetEnvironmentVariable('DUIN_BRAIN_TOKEN', '<token>', 'User')
```

Nothing stores that token in readable form, so a lost token is reissued rather
than looked up. This is the path to use when *you* decide to connect something.

### The long way: the agent asks

Use this when an agent you did not configure wants in — it never holds a
credential until you say so:

1. DUIN must be running (the brain is in-process — no app, no mount).
2. With no token set, the server exposes exactly two tools: `duin_pair` and
   `duin_pair_claim`. Call `duin_pair` with a name and the planes you want.
3. The operator approves it in **Settings → Agents**, where the request appears
   with every requested plane spelled out and individually tickable. Approval
   can hand back *less* than was asked for, never more. A notice also lands
   under **Needs you** so nothing waits unseen; requests expire after 15
   minutes, and ignoring one is a safe way to decline, since asking again is
   cheap.
4. Call `duin_pair_claim` with the `pairingId`. It returns the token **once**,
   then scrubs it. The claim window is 15 minutes.
5. Put that token in `DUIN_BRAIN_TOKEN` and restart the client — MCP servers
   connect at session start, so the variable must exist beforehand.

```powershell
[Environment]::SetEnvironmentVariable('DUIN_BRAIN_TOKEN', '<token>', 'User')
```

`DUIN_BRAIN_URL` overrides the endpoint if DUIN's brain is not on the default
`http://127.0.0.1:8799/exec/mcp`.

## The planes

A plane is a verb you are granted, and the toolset you see is computed from the
planes you hold — a tool you were not granted does not appear in `tools/list`
at all. Ask for the narrowest set that does your job; the operator sees exactly
what you asked for and can trim it.

| Plane | What it buys |
| --- | --- |
| `context.read` | `duin_brief`, `duin_retrieve`, `duin_context` |
| `beliefs.read` | `duin_beliefs`, and the belief half of `duin_context` |
| `goals.read` / `goals.write` | fleet goal state; writes go through leases |
| `judgment.precheck` | `duin_forecast` |
| `learning.submit` | `duin_teach` |
| `memory.write` | `duin_memory_write` |

The first four are what a fresh pairing requests by default. **Writes are never
in the default grant** — `goals.write`, `learning.submit` and `memory.write`
have to be asked for by name, so they stand out on the approval card.

## Reading like a DUIN chat turn

`duin_context` returns, in one call, the same material a DUIN chat turn is
built from: the operator's identity files, the memory index, relevance-ranked
beliefs, and scoped retrieval hits. Prefer it over stitching `duin_brief` +
`duin_retrieve` + `duin_beliefs` together when you are about to reason *about
the operator* rather than look one thing up.

If you hold `context.read` but not `beliefs.read`, the beliefs come back `null`
alongside a `beliefsNote` saying so. That distinction matters: it means "you
were not granted this", not "the operator believes nothing."

## Writing without self-certifying

Two different powers, deliberately kept apart:

- **`duin_teach`** offers a durable claim about the operator. It is recorded as
  an **external, unpromoted candidate** — it does not influence DUIN's answers,
  and it never will unless the operator promotes it in the Learning panel. Your
  provenance is stamped server-side; you cannot submit a claim as though the
  operator said it. The response tells you this plainly
  (`influencesAnswers: false`), so don't assume you taught the answer.
- **`duin_memory_write`** leaves a note in the vault, inside your granted write
  scope (default `.brain/agent-inbox/`). Notes are stamped with your principal,
  never overwrite silently (use `mode: "append"`), and identity files are
  refused by name at any depth.

  A note is **not** memory and **not** retrievable. The default write scope sits
  outside the retrieval index on purpose: an indexed agent write would be a back
  door around the quarantine above — write "the operator prefers X" as a note,
  have it grounded next turn, and `duin_teach`'s promotion gate is worth nothing.
  So documents stay out of retrieval and claims go through promotion. Think of
  this as leaving something on the operator's desk; DUIN flags it for them.

## Know your own bounds

Call `duin_whoami`. It reports your planes, your read scope, your write scope,
and your hourly budget with the remainder left on it. The grant carries limits
you cannot widen by asking differently:

- **Read scope** — a set of vault subtrees. Retrieval outside it returns
  nothing rather than falling back to the whole vault, so an empty result may
  mean "outside your scope", not "not in the vault."
- **Quota** — a rolling hourly ceiling on calls and on retrieved characters. A
  refusal names the limit and when the window rolls; back off and resume rather
  than retrying, or ask the operator to raise it.

  Both are set per-agent in **Settings → Agents → Limits**, so "ask the operator
  to widen it" is a real request they can act on, not a shrug.
- **Audit** — every call is logged with the query and the result *size*. Bodies
  are never logged.

## Using it well

Terminal judgment stays with the operator by design. An agent registers goals,
claims a lease, writes against the returned `epoch`, and **proposes**
completion — `duin_goal_propose_transition` parks the decision for a human
rather than applying it. Leases coordinate agents with each other; they never
block the operator.

The same principle runs through the memory tools: you can read what DUIN knows,
offer what you learned, and leave a note — but promoting a claim into the
beliefs that shape DUIN's answers stays a human act.
