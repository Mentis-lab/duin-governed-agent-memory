// Load the native tool packs once, before any IPC handler can dispatch a
// tool call. Must precede the chat handler import: chat.ts pulls in
// tool-registry, and the registry must already exist when each pack's
// top-level `toolRegistry.registerNative(...)` runs. See
// electron/services/tool-packs.ts for why this is its own module.
import '../services/tool-packs'

import { registerChatHandlers } from './chat'
import { registerConversationHandlers } from './conversation'
import { registerContractHandlers } from './contracts'
import { registerSettingsHandlers } from './settings'
import { registerModelHandlers } from './model'
import { registerSkillsHandlers } from './skills'
import { registerMethodsHandlers } from './methods'
import { registerMemoryHandlers } from './memory'
import { registerMcpHandlers } from './mcp'
import { registerArtifactHandlers } from './artifact'
import { registerCanvasHandlers } from './canvas'
import { registerFilesHandlers } from './files'
import { registerTerminalHandlers } from './terminal'
import { registerBrowserHandlers } from './browser'
import { registerReviewHandlers } from './review'
import { registerWorktreeHandlers } from './worktree'
import { registerHooksHandlers } from './hooks'
import { registerAutomationsHandlers } from './automations'
import { registerProjectsHandlers } from './projects'
import { registerToolsHandlers } from './tools'
import { registerPermissionsHandlers } from './permissions'
import { registerWebToolsHandlers } from './web-tools'
import { registerCurrentInfoHandlers } from './current-info'
import { registerImageToolsHandlers } from './image-tools'
import { registerPlanHandlers } from './plan'
import { registerGitHubHandlers } from './github'
import { registerEventsHandlers } from './events'
import { registerRagHandlers } from './rag'
import { registerSlashHandlers } from './slash'
import { registerPluginsHandlers } from './plugins'
import { registerChaptersHandlers } from './chapters'
import { registerTasksHandlers } from './tasks'
import { registerTaskGraphHandlers } from './task-graph'
import { registerWorkflowsHandlers } from './workflows'
import { registerMonitorHandlers } from './monitor'
import { registerAsyncEventHandlers } from './async-events'
import { registerLoopsHandlers } from './loops'
import { registerNotificationsHandlers } from './notifications'
import { registerNoticesHandlers } from './notices'
import { registerExecutorHandlers } from './executor'
import { registerRsiHandlers } from './rsi'
import { registerExecutiveHandlers } from './executive'
import { registerSessionsMessagingHandlers } from './sessions-messaging'
import { registerAskUserHandlers } from './ask-user'
import { registerStatusLineHandlers } from './statusline'
import { registerResearchHandlers } from './research'
import { registerSnipHandlers } from './snip'
import { registerPersistenceHandlers } from './persistence'
import { registerAfterActionHandlers } from './after-action'
import { registerHarnessRecsHandlers } from './harness-recs'
import { registerFeedbackHandlers } from './feedback'
import { registerFeedbackBridgeHandlers } from './feedback-bridge'
import { registerOnboardingHandlers } from './onboarding'
import { registerProposedEditHandlers } from './proposed-edit'

export function registerAllIpcHandlers(): void {
  registerChatHandlers()
  registerConversationHandlers()
  registerContractHandlers()
  registerSettingsHandlers()
  registerModelHandlers()
  registerSkillsHandlers()
  registerMethodsHandlers()
  registerMemoryHandlers()
  registerMcpHandlers()
  registerArtifactHandlers()
  registerCanvasHandlers()
  registerFilesHandlers()
  registerTerminalHandlers()
  registerBrowserHandlers()
  registerReviewHandlers()
  registerWorktreeHandlers()
  registerHooksHandlers()
  registerAutomationsHandlers()
  registerProjectsHandlers()
  registerToolsHandlers()
  // permissions must register after chat so its mcp:approveToolCall override
  // wins (chat.ts no longer claims that channel; see permissions.ts).
  registerPermissionsHandlers()
  registerWebToolsHandlers()
  registerCurrentInfoHandlers()
  registerImageToolsHandlers()
  registerPlanHandlers()
  registerGitHubHandlers()
  registerEventsHandlers()
  registerRagHandlers()
  registerSlashHandlers()
  registerPluginsHandlers()
  registerChaptersHandlers()
  registerTasksHandlers()
  registerTaskGraphHandlers()
  registerWorkflowsHandlers()
  registerMonitorHandlers()
  registerAsyncEventHandlers()
  registerLoopsHandlers()
  registerNotificationsHandlers()
  registerNoticesHandlers()
  registerExecutorHandlers()
  registerRsiHandlers()
  registerExecutiveHandlers()
  registerSessionsMessagingHandlers()
  registerAskUserHandlers()
  registerStatusLineHandlers()
  registerResearchHandlers()
  registerSnipHandlers()
  registerPersistenceHandlers()
  registerAfterActionHandlers()
  registerHarnessRecsHandlers()
  registerFeedbackHandlers()
  registerFeedbackBridgeHandlers()
  registerOnboardingHandlers()
  registerProposedEditHandlers()
}
