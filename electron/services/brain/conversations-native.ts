// conversations-native — TS port of server.py:list_conversations. Your people
// (conversation subjects), each with the open follow-ups that reference them + a link to
// their profile note. Whoever you owe the most surfaces first. Pure read: task scan
// (taskFiles + parseTaskFull) × vault people (listVaultEntities).
import { readFileSync } from 'fs'
import { relative } from 'path'
import { taskFiles } from './throughput'
import { parseTaskFull, type TaskFull } from './causal-substrate'
import { listVaultEntities } from './entities-native'

interface Conversation {
  person: string
  org: string
  profile: string
  open: number
  total: number
  followups: TaskFull[]
}

export function listConversations(vaultDir: string | null): { conversations: Conversation[] } {
  if (!vaultDir) return { conversations: [] }
  // all task lines (open + done), parsed once
  const tasks: TaskFull[] = []
  for (const fp of taskFiles(vaultDir)) {
    const rel = relative(vaultDir, fp).replace(/\\/g, '/')
    let lines: string[]
    try {
      lines = readFileSync(fp, 'utf-8').replace(/\r\n?/g, '\n').split('\n')
    } catch {
      continue
    }
    lines.forEach((line, i) => {
      const t = parseTaskFull(line, rel, i)
      if (t) tasks.push(t)
    })
  }

  const { people } = listVaultEntities(vaultDir)
  const convos: Conversation[] = people.map((p) => {
    const name = p.name
    const relTasks = tasks.filter((t) => t.people.includes(name) || (name.length >= 2 && t.text.includes(name)))
    const openTasks = relTasks.filter((t) => !t.done)
    const base = openTasks.length ? openTasks : relTasks
    const followups = [...base]
      .sort((a, b) => {
        const pa = a.priority || '9'
        const pb = b.priority || '9'
        if (pa !== pb) return pa < pb ? -1 : 1
        const da = a.due || '~'
        const db = b.due || '~'
        return da < db ? -1 : da > db ? 1 : 0
      })
      .slice(0, 8)
    return {
      person: name,
      org: p.org || '',
      profile: p.id && p.id.startsWith('vault:') ? p.id.slice('vault:'.length) : '',
      open: openTasks.length,
      total: relTasks.length,
      followups
    }
  })

  convos.sort((a, b) => {
    if (a.open !== b.open) return b.open - a.open
    if (a.total !== b.total) return b.total - a.total
    return a.person < b.person ? -1 : a.person > b.person ? 1 : 0
  })
  return { conversations: convos }
}
