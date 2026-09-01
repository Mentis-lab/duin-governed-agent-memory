// Vault-nature classifier — the control that keeps identity inference SAFE.
//
// A second brain is not always about its owner. A STUDY vault holds notes ABOUT a subject
// (organic chemistry, a language, a course) — inferring identity from it would fabricate
// "you are an organic chemist", the opposite of grounding. So before any model drafts ME.md
// we classify the vault: self-work (notes about the owner's projects/decisions/people) vs
// study-reference (expository notes about external subjects) vs mixed/unknown.
//
// The rule this enforces downstream: only draft OWNER-IDENTITY from notes when the vault is
// clearly self-work. For study-reference we infer TOPICS only ("your vault covers X") and take
// identity from the interview — never assert a subject as the person. Keyless + deterministic
// (no LLM, no network) so it's a reliable gate even before a model is connected, and unit-tests
// against temp fixtures. Biased to safety: when unsure -> 'unknown' -> caller asks, doesn't infer.

import { readdirSync, statSync } from 'fs'
import { join, basename } from 'path'
import { isDirSafe, readSafe } from '../fs-tree'

export type VaultKind = 'self-work' | 'study-reference' | 'mixed' | 'unknown'

export interface VaultSample {
  /** Notable top-level + second-level folder names (structural noise filtered). */
  folders: string[]
  /** How many markdown files were seen (bounded scan). */
  fileCount: number
  /** frontmatter `type:` value -> count, across the sampled files. */
  frontmatterTypes: Record<string, number>
  /** Signal counts used by the classifier. */
  markers: {
    selfFolders: number
    studyFolders: number
    firstPerson: number
    studyContent: number
    personalArtifacts: number
  }
}

export interface VaultNature {
  kind: VaultKind
  /** 0..1 — margin-based; low confidence should make the caller prefer the interview. */
  confidence: number
  /** Domain/topic labels safe to *describe* (never asserted as the owner's identity). */
  topics: string[]
  /** Human-readable signals behind the verdict. */
  rationale: string[]
}

// Folder-name signals (lowercased substring match). Structural vault folders are ignored.
const SELF_FOLDER = /(decision|owed|people|person|project|daily|journal|task|action|card|meeting|1-on-1|okr|goal|10 action|05 decision|02 card|04 note)/i
const STUDY_FOLDER = /(course|class|lecture|chapter|subject|textbook|exam|revision|flashcard|anki|study|复习|课程|讲义|章节|课堂|考试|习题|学习)/i
const STRUCTURAL = /^(notes?|raw|memos?|attachments?|assets?|images?|files?|\.obsidian|\.brain|_.*|templates?)$/i

// Content signals.
const FIRST_PERSON = /\b(i|i'm|i've|my|mine|we|our|me)\b|我(们|的)?|自己/gi
const STUDY_CONTENT =
  /\b(chapter|lecture|theorem|definition|proof|example|exercise|problem set|syllabus|midterm|quiz|flashcard|q:|a:)\b|定义|定理|证明|例题|习题|公式|概念|考点|知识点/gi
// Personal artifacts = strong self-work evidence (a subject vault has none of these).
const PERSONAL_ARTIFACT = /\b(decision|owed|reviewOn|attendee|deadline|stakeholder|1:1)\b|决策|待办|复盘|会议纪要/gi

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => {
      try {
        return statSync(join(dir, n)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

/** Bounded, high-signal sample of a vault: folder skeleton + frontmatter types + content
 *  markers over the first `opts.maxFiles` markdown files. Pure fs; never mutates. */
export function sampleVault(notesDir: string, opts?: { maxFiles?: number }): VaultSample {
  const maxFiles = opts?.maxFiles ?? 120
  const sample: VaultSample = {
    folders: [],
    fileCount: 0,
    frontmatterTypes: {},
    markers: { selfFolders: 0, studyFolders: 0, firstPerson: 0, studyContent: 0, personalArtifacts: 0 }
  }
  if (!isDirSafe(notesDir)) return sample

  // Folder skeleton (top + one level down), structural names filtered out.
  const topDirs = listDirs(notesDir)
  const notable = new Set<string>()
  for (const d of topDirs) {
    if (!STRUCTURAL.test(d)) notable.add(d)
    if (SELF_FOLDER.test(d)) sample.markers.selfFolders++
    if (STUDY_FOLDER.test(d)) sample.markers.studyFolders++
    for (const sub of listDirs(join(notesDir, d))) {
      if (!STRUCTURAL.test(sub)) notable.add(sub)
      if (SELF_FOLDER.test(sub)) sample.markers.selfFolders++
      if (STUDY_FOLDER.test(sub)) sample.markers.studyFolders++
    }
  }
  sample.folders = [...notable].slice(0, 40)

  // Walk markdown (bounded), collect frontmatter types + content markers.
  const walk = (d: string): void => {
    if (sample.fileCount >= maxFiles) return
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const name of entries) {
      if (sample.fileCount >= maxFiles) return
      const full = join(d, name)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (!/^\.(obsidian|brain|git)$/i.test(name)) walk(full)
      } else if (name.toLowerCase().endsWith('.md')) {
        sample.fileCount++
        const body = readSafe(full).slice(0, 4000)
        const fm = body.match(/^---\n([\s\S]*?)\n---/)
        if (fm) {
          const t = fm[1].match(/^type:\s*(.+)$/m)
          if (t) {
            const key = t[1].trim().toLowerCase()
            sample.frontmatterTypes[key] = (sample.frontmatterTypes[key] ?? 0) + 1
          }
        }
        sample.markers.firstPerson += (body.match(FIRST_PERSON) ?? []).length
        sample.markers.studyContent += (body.match(STUDY_CONTENT) ?? []).length
        sample.markers.personalArtifacts += (body.match(PERSONAL_ARTIFACT) ?? []).length
      }
    }
  }
  walk(notesDir)
  return sample
}

/** Classify vault nature from a sample. Deterministic heuristic; margin -> confidence. */
export function classifyVaultNature(sample: VaultSample): VaultNature {
  const m = sample.markers
  const rationale: string[] = []

  // Weighted scores. Personal artifacts + self folders + frontmatter (decision/person/card)
  // are strong self-work evidence; study folders + expository markers are study evidence.
  const fmSelf =
    (sample.frontmatterTypes['decision'] ?? 0) +
    (sample.frontmatterTypes['person'] ?? 0) +
    (sample.frontmatterTypes['card'] ?? 0) +
    (sample.frontmatterTypes['meeting'] ?? 0) +
    (sample.frontmatterTypes['task'] ?? 0)
  const fmStudy =
    (sample.frontmatterTypes['flashcard'] ?? 0) +
    (sample.frontmatterTypes['concept'] ?? 0) +
    (sample.frontmatterTypes['reference'] ?? 0) +
    (sample.frontmatterTypes['source'] ?? 0)

  const perFile = Math.max(1, sample.fileCount)
  const selfScore = m.selfFolders * 2 + m.personalArtifacts * 1.5 + fmSelf * 2 + (m.firstPerson / perFile) * 3
  const studyScore = m.studyFolders * 2 + m.studyContent * 1.2 + fmStudy * 2

  if (m.selfFolders) rationale.push(`${m.selfFolders} self/work folder(s)`)
  if (m.personalArtifacts) rationale.push(`${m.personalArtifacts} personal-artifact marker(s)`)
  if (fmSelf) rationale.push(`${fmSelf} decision/person/card/meeting note(s)`)
  if (m.studyFolders) rationale.push(`${m.studyFolders} study/course folder(s)`)
  if (m.studyContent) rationale.push(`${m.studyContent} expository/study marker(s)`)

  const total = selfScore + studyScore
  let kind: VaultKind
  let confidence: number
  if (total < 3) {
    kind = 'unknown'
    confidence = 0.2
    rationale.push('weak signal — prefer the interview, do not infer identity')
  } else {
    const ratio = selfScore / total
    if (ratio >= 0.66) {
      kind = 'self-work'
    } else if (ratio <= 0.34) {
      kind = 'study-reference'
    } else {
      kind = 'mixed'
    }
    // Confidence = how far from the 0.5 midpoint (0 at 50/50, 1 at a clean sweep).
    confidence = Math.min(1, Math.abs(ratio - 0.5) * 2 + 0.15)
  }

  // Topics = notable folder names (safe to describe as material, never as identity).
  const topics = sample.folders.filter((f) => !SELF_FOLDER.test(f)).slice(0, 12)

  return { kind, confidence: Number(confidence.toFixed(2)), topics, rationale }
}
