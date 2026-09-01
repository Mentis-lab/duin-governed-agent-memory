export type LearningLoadState<T> =
  | { status: 'loading' }
  | { status: 'ready'; facts: T[] }
  | { status: 'stale'; facts: T[]; error: string }
  | { status: 'unavailable'; error: string }

export interface LearningResult<T> {
  success: boolean
  data?: T[]
  error?: string
}

export function learningLoadSucceeded<T>(facts: T[]): LearningLoadState<T> {
  return { status: 'ready', facts }
}

export function learningLoadFailed<T>(
  previous: LearningLoadState<T>,
  error = 'Learning data is unavailable.'
): LearningLoadState<T> {
  if (previous.status === 'ready' || previous.status === 'stale') {
    return { status: 'stale', facts: previous.facts, error }
  }
  return { status: 'unavailable', error }
}

export function requireLearningSuccess<T>(
  result: LearningResult<T> | null | undefined,
  fallback: string
): T[] {
  if (!result?.success) throw new Error(result?.error || fallback)
  return result.data ?? []
}

export function requireMutationSuccess(
  result: { success: boolean; error?: string } | null | undefined,
  fallback: string
): void {
  if (!result?.success) throw new Error(result?.error || fallback)
}
