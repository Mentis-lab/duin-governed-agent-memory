// Framework-agnostic AG-UI client — the swappable seam to the harness brain.
// POSTs a RunAgentInput and parses the SSE event stream (`data: {json}\n\n`) into AG-UI events.
// No Vercel/Next/AI-SDK coupling: talks to ANY AG-UI endpoint (our Python stub, or the
// production harness via the official ag-ui SDK).

import { isLoopbackHttpUrl, rendererToken } from "./loopback-auth";

export type AguiEvent = { type: string; [k: string]: unknown };

export interface RunAgentOpts {
  url: string;
  threadId: string;
  runId: string;
  messages: { role: string; content: string }[];
  onEvent: (e: AguiEvent) => void;
  signal?: AbortSignal;
  /** Scope the run to what the user is looking at, e.g. { decisionId }. */
  context?: Record<string, unknown>;
}

/** The per-launch /agui execution token, from the trusted preload bridge. Empty when unavailable
 *  (e.g. browser/dev without preload) — the deny-first gate then simply refuses host-exec tools. */
async function execToken(): Promise<string> {
  return rendererToken("execToken");
}

export async function runAgent(opts: RunAgentOpts): Promise<void> {
  const isLocal = isLoopbackHttpUrl(opts.url);
  const [token, controlToken] = isLocal
    ? await Promise.all([execToken(), rendererToken("controlToken")])
    : ["", ""];
  // Resume state: on a mid-stream drop, reconnect with resume:true + Last-Event-ID to replay missed
  // frames — but ONLY if the brain echoed a runId on RUN_STARTED (DUIN_TURN_RESUME on); otherwise a
  // reconnect would start a duplicate fresh turn, so we don't.
  let lastEventId = 0;
  let serverResumable = false;
  const MAX_RECONNECTS = 4;

  // Stop beacon: a deliberate Stop aborts the run now instead of leaving the brain to grace-wait a
  // reconnect. Fire-once + fire-and-forget, and only meaningful once the brain proved resume-capable.
  let beaconSent = false;
  opts.signal?.addEventListener?.("abort", () => {
    if (beaconSent || !serverResumable) return;
    beaconSent = true;
    void fetch(opts.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(controlToken ? { "x-duin-control": controlToken } : {}),
      },
      redirect: isLocal ? "error" : "follow",
      body: JSON.stringify({ runId: opts.runId, abort: true }),
    }).catch(() => {});
  }, { once: true });

  for (let attempt = 0; attempt <= MAX_RECONNECTS; attempt++) {
    if (opts.signal?.aborted) return;
    const isReconnect = attempt > 0;
    let res: Response;
    try {
      res = await fetch(opts.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "x-duin-exec": token } : {}),
          ...(controlToken ? { "x-duin-control": controlToken } : {}),
          ...(isReconnect && lastEventId > 0 ? { "Last-Event-ID": String(lastEventId) } : {}),
        },
        body: JSON.stringify({
          threadId: opts.threadId,
          runId: opts.runId,
          messages: opts.messages,
          ...(isReconnect ? { resume: true } : {}),
          ...(opts.context ? { context: opts.context } : {}),
        }),
        signal: opts.signal,
        redirect: isLocal ? "error" : "follow",
      });
    } catch (err) {
      if (opts.signal?.aborted || attempt >= MAX_RECONNECTS) throw err;
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    if (!res.ok || !res.body) {
      if (attempt === 0) throw new Error(`AG-UI request failed: ${res.status}`);
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = frame.split("\n");
          const idLine = lines.find((l) => l.startsWith("id:"));
          if (idLine) {
            const n = Number(idLine.slice(3).trim());
            if (Number.isFinite(n) && n > lastEventId) lastEventId = n;
          }
          const dataLine = lines.find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          let ev: AguiEvent | null = null;
          try {
            ev = JSON.parse(dataLine.slice("data: ".length)) as AguiEvent;
          } catch {
            /* ignore malformed frame */
          }
          if (ev) {
            if (ev.type === "RUN_STARTED" && typeof (ev as { runId?: unknown }).runId === "string") serverResumable = true;
            opts.onEvent(ev);
            // CLI-style turn end: stop the moment the brain signals done — don't wait for the socket
            // to close (the warm SDK session keeps it open). Lets `busy` flip so a queued message sends.
            if (ev.type === "RUN_FINISHED" || ev.type === "RUN_ERROR") {
              try { await reader.cancel(); } catch { /* already closing */ }
              return;
            }
          }
        }
      }
    } finally {
      try { await reader.cancel(); } catch { /* ignore */ }
    }

    // Stream ended without a terminal frame. Reconnect only on a resume-capable brain; otherwise
    // stop (matches the prior behavior of returning when the stream closes).
    if (opts.signal?.aborted || !serverResumable) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}
