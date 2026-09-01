import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => 'C:/tmp/lamprey-test-user-data' }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { spawnTask } from './spawn-task'
import { subscribeTaskChanges } from './task-wait-signal'

describe('spawnTask', () => {
  it('creates a linked child conversation with a seeded prompt and worktree metadata', async () => {
    const messages: Array<{ conversationId: string; role: string; content: string }> = []
    const enqueued: unknown[] = []
    const result = await spawnTask(
      {
        sourceConversationId: 'conv-source',
        title: 'Investigate flaky test',
        prompt: 'Find the flaky test and propose a fix.',
        tldr: 'Look at the CI-only failure.',
        cwd: 'C:/repo',
        model: 'deepseek-v4-pro'
      },
      {
        getConversation: () =>
          ({
            id: 'conv-source',
            title: 'Source',
            model: 'deepseek-v4-flash',
            createdAt: 1,
            updatedAt: 1,
            messageCount: 0,
            projectId: 'project-1'
          }) as any,
        createConversation: (model, opts) =>
          ({
            id: 'conv-child',
            title: null,
            model,
            createdAt: 2,
            updatedAt: 2,
            messageCount: 0,
            kind: opts?.kind ?? 'local',
            worktreePath: opts?.worktreePath ?? null,
            projectId: opts?.projectId ?? null
          }) as any,
        updateConversationTitle: vi.fn(),
        saveMessage: (msg) => {
          messages.push({
            conversationId: msg.conversationId,
            role: msg.role,
            content: msg.content
          })
          return msg as any
        },
        enqueue: (input) => {
          enqueued.push(input)
          return {
            id: 'evt-1',
            conversationId: input.conversationId,
            kind: input.kind,
            payload: input.payload ?? {},
            createdAt: input.createdAt ?? 0,
            deliveredAt: null
          }
        },
        worktreeManager: {
          create: async () => ({ path: 'C:/repo-worktrees/task-1', branch: 'lamprey-agent/task-1' }),
          finalize: async () => ({
            keep: true,
            hasChanges: false,
            path: 'C:/repo-worktrees/task-1',
            branch: 'lamprey-agent/task-1',
            removed: false
          })
        }
      }
    )

    expect(result.conversationId).toBe('conv-child')
    expect(result.worktreePath).toBe('C:/repo-worktrees/task-1')
    expect(result.branch).toBe('lamprey-agent/task-1')
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationId: 'conv-source',
          role: 'system',
          content: expect.stringContaining('conv-child')
        }),
        expect.objectContaining({
          conversationId: 'conv-child',
          role: 'system',
          content: expect.stringContaining('conv-source')
        }),
        expect.objectContaining({
          conversationId: 'conv-child',
          role: 'user',
          content: 'Find the flaky test and propose a fix.'
        })
      ])
    )
    expect(enqueued).toEqual([
      expect.objectContaining({
        conversationId: 'conv-source',
        kind: 'tasks:spawn-completed'
      })
    ])
  })

  it('sets forkedFromId so the child links into the task graph, and wakes wait_tasks', async () => {
    // Regression: createConversation's forkedFromId defaults to null when
    // omitted, so a spawn that forgets to pass it still succeeds -- the child
    // conversation is created, titled, and seeded normally. The only symptom
    // is that task-graph.ts never draws a parent edge for it (buildTaskGraph
    // reads forkedFromId straight off the conversation row), so read_task and
    // wait_tasks on the source conversation can't see the child at all.
    let capturedOpts: { forkedFromId?: string | null } | undefined
    const signals: Array<{ conversationId: string | null; entityId: string | null; kind: string }> =
      []
    const unsubscribe = subscribeTaskChanges((signal) => signals.push(signal))

    let result: Awaited<ReturnType<typeof spawnTask>>
    try {
      result = await spawnTask(
        {
          sourceConversationId: 'conv-source',
          title: 'Investigate flaky test',
          prompt: 'Find the flaky test and propose a fix.'
        },
        {
          getConversation: () =>
            ({
              id: 'conv-source',
              title: 'Source',
              model: 'deepseek-v4-flash',
              createdAt: 1,
              updatedAt: 1,
              messageCount: 0,
              projectId: null
            }) as any,
          createConversation: (model, opts) => {
            capturedOpts = opts
            return {
              id: 'conv-child',
              title: null,
              model,
              createdAt: 2,
              updatedAt: 2,
              messageCount: 0,
              kind: opts?.kind ?? 'local',
              worktreePath: opts?.worktreePath ?? null,
              projectId: opts?.projectId ?? null
            } as any
          },
          updateConversationTitle: vi.fn(),
          saveMessage: (msg) => msg as any,
          enqueue: (input) =>
            ({
              id: 'evt-1',
              conversationId: input.conversationId,
              kind: input.kind,
              payload: input.payload ?? {},
              createdAt: input.createdAt ?? 0,
              deliveredAt: null
            }) as any,
          worktreeManager: null
        }
      )
    } finally {
      unsubscribe()
    }

    expect(capturedOpts?.forkedFromId).toBe('conv-source')
    expect(signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationId: 'conv-source',
          entityId: result.conversationId,
          kind: 'fork'
        })
      ])
    )
  })

  it('registers spawn_task as a mutating native tool', async () => {
    await import('./spawn-task-tool-pack')
    const { toolRegistry } = await import('./tool-registry')
    const descriptor = toolRegistry.getById('spawn_task')
    expect(descriptor?.name).toBe('spawn_task')
    expect(descriptor?.mutates).toBe(true)
    expect(descriptor?.risks).toContain('write')
  })
})

// ── backlog finding 36 ──────────────────────────────────────────────────────

describe('spawnTask — a non-git workspace degrades instead of hard-failing', () => {
  const deps = (worktreeManager: unknown): Parameters<typeof spawnTask>[1] =>
    ({
      getConversation: () =>
        ({ id: 'conv-1', model: 'm', kind: 'local', title: 'S' }) as never,
      createConversation: () =>
        ({ id: 'conv-child', model: 'm', kind: 'local', worktreePath: null }) as never,
      updateConversationTitle: vi.fn(),
      saveMessage: (m: unknown) => m as never,
      enqueue: (i: { conversationId: string }) =>
        ({ id: 'evt-1', conversationId: i.conversationId, deliveredAt: null }) as never,
      worktreeManager
    }) as never

  it('continues without a worktree when create() throws', async () => {
    // defaultWorktreeManager hands back a real manager for ANY non-empty cwd, and
    // create() throws when that cwd is not a git repo — with no catch anywhere in
    // spawnTask. DUIN's default workspace is the notes vault, which is not a repo, so
    // spawn_task hard-failed there on every call, while its own description says worktree
    // creation is conditional.
    const r = await spawnTask(
      { sourceConversationId: 'conv-1', title: 'T', prompt: 'do it' },
      deps({
        create: async () => {
          throw new Error('not a git repository')
        }
      })
    )
    expect(r.conversationId).toBe('conv-child')
    expect(r.worktreePath).toBeFalsy()
  })

  it('still uses a worktree when one can be created', async () => {
    const r = await spawnTask(
      { sourceConversationId: 'conv-1', title: 'T', prompt: 'do it' },
      deps({
        create: async () => ({ path: 'C:/wt', branch: 'b' }),
        finalize: async () => ({ keep: true, hasChanges: false, path: 'C:/wt', branch: 'b', removed: false })
      })
    )
    expect(r.worktreePath).toBe('C:/wt')
  })
})
