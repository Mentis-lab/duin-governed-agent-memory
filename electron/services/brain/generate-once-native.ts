// generate-once-native — the shared "generate via the in-process brain" helper for the
// model-backed writers (cascades / extractors). In-process equivalent of server.py's
// _duin_generate (which self-POSTed to :8799/agui) and _run_oneshot (which shelled out to
// `claude -p`): both are replaced by a direct call through the provider registry — no self-HTTP,
// no Claude Code subprocess. Routes to a keyed model for the task and collects the stream to text.
// Returns '' when no provider key is configured (callers must degrade gracefully, exactly as the
// Python paths returned '' on failure).
import { chatStream, routeModel, type RouteTask } from '../providers/registry'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'

export interface GenerateDeps {
  routeModel: typeof routeModel
  chatStream: typeof chatStream
}
const defaultDeps: GenerateDeps = { routeModel, chatStream }

/** One-shot text generation via the app's configured model. `task` picks the routing tier
 *  ('extraction' for extractor/parse jobs, 'reason' for cascades). Empty prompt or no keyed
 *  model yields ''. Never throws (mirrors the Python generate paths' best-effort contract). */
export async function generateOnce(
  prompt: string,
  task: RouteTask = 'extraction',
  signal?: AbortSignal,
  deps: GenerateDeps = defaultDeps
): Promise<string> {
  if (!prompt) return ''
  const modelId = deps.routeModel(task)
  if (!modelId) return '' // no provider key / no usable model — caller degrades
  let text = ''
  try {
    await deps.chatStream(
      [{ role: 'user', content: prompt }] as ChatCompletionMessageParam[],
      modelId,
      undefined, // no tools
      {
        onChunk: (c: string) => {
          text += c
        },
        onDone: (full: string) => {
          if (full) text = full
        },
        onError: () => {
          /* best-effort: keep whatever streamed so far */
        }
      },
      signal
    )
  } catch {
    // best-effort: return whatever streamed before the error (or '')
  }
  return text.trim()
}
