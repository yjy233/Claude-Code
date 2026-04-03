/**
 * Type declarations for internal modules that were not recovered from source maps.
 * These are feature-gated modules (DAEMON, BG_SESSIONS, TEMPLATES, etc.)
 * that only exist in internal/ant builds.
 */

// ============================================================================
// Commands (feature-gated)
// ============================================================================

declare module '*/commands/workflows/index.js' {
  const command: { default: (...args: unknown[]) => unknown }
  export default command.default
}

declare module '*/commands/peers/index.js' {
  const command: { default: (...args: unknown[]) => unknown }
  export default command.default
}

declare module '*/commands/fork/index.js' {
  const command: { default: (...args: unknown[]) => unknown }
  export default command.default
}

declare module '*/commands/buddy/index.js' {
  const command: { default: (...args: unknown[]) => unknown }
  export default command.default
}

declare module '*/commands/assistant/assistant.js' {
  export const NewInstallWizard: React.FC<any>
  export function computeDefaultInstallDir(): string
}

// ============================================================================
// Server modules
// ============================================================================

declare module '*/server/parseConnectUrl.js' {
  export function parseConnectUrl(url: string): { host: string; port: number; sessionId?: string }
}

declare module '*/server/lockfile.js' {
  export function writeServerLock(opts: Record<string, unknown>): Promise<void>
  export function removeServerLock(opts: Record<string, unknown>): Promise<void>
  export function probeRunningServer(opts: Record<string, unknown>): Promise<unknown>
}

declare module '*/server/server.js' {
  export function startServer(opts: Record<string, unknown>): Promise<unknown>
}

declare module '*/server/serverBanner.js' {
  export function printBanner(opts: Record<string, unknown>): void
}

declare module '*/server/serverLog.js' {
  export function createServerLogger(opts: Record<string, unknown>): unknown
}

declare module '*/server/sessionManager.js' {
  export class SessionManager {
    constructor(opts?: Record<string, unknown>)
    [key: string]: unknown
  }
}

declare module '*/server/connectHeadless.js' {
  export function runConnectHeadless(opts: Record<string, unknown>): Promise<void>
}

declare module '*/server/backends/dangerousBackend.js' {
  export class DangerousBackend {
    constructor(opts?: Record<string, unknown>)
    [key: string]: unknown
  }
}

// ============================================================================
// Daemon / Runner modules
// ============================================================================

declare module '*/daemon/main.js' {
  export function daemonMain(opts?: Record<string, unknown>): Promise<void>
}

declare module '*/daemon/workerRegistry.js' {
  export function runDaemonWorker(opts?: Record<string, unknown>): Promise<void>
}

declare module '*/environment-runner/main.js' {
  export function environmentRunnerMain(opts?: Record<string, unknown>): Promise<void>
}

declare module '*/self-hosted-runner/main.js' {
  export function selfHostedRunnerMain(opts?: Record<string, unknown>): Promise<void>
}

// ============================================================================
// CLI handlers (feature-gated)
// ============================================================================

declare module '*/cli/bg.js' {
  export function psHandler(opts?: Record<string, unknown>): Promise<void>
  export function logsHandler(opts?: Record<string, unknown>): Promise<void>
  export function attachHandler(opts?: Record<string, unknown>): Promise<void>
  export function killHandler(opts?: Record<string, unknown>): Promise<void>
}

declare module '*/cli/handlers/templateJobs.js' {
  export function templatesMain(opts?: Record<string, unknown>): Promise<void>
}

declare module '*/cli/handlers/ant.js' {
  export function logHandler(opts?: Record<string, unknown>): Promise<void>
  export function errorHandler(opts?: Record<string, unknown>): Promise<void>
  export function exportHandler(opts?: Record<string, unknown>): Promise<void>
  export function taskCreateHandler(opts?: Record<string, unknown>): Promise<void>
  export function taskListHandler(opts?: Record<string, unknown>): Promise<void>
  export function taskGetHandler(opts?: Record<string, unknown>): Promise<void>
  export function taskUpdateHandler(opts?: Record<string, unknown>): Promise<void>
  export function taskDirHandler(opts?: Record<string, unknown>): Promise<void>
  export function completionHandler(opts?: Record<string, unknown>): Promise<void>
}

// ============================================================================
// Utils (feature-gated)
// ============================================================================

declare module '*/utils/attributionHooks.js' {
  export function registerAttributionHooks(opts?: Record<string, unknown>): void
  export function sweepFileContentCache(): void
  export function clearAttributionCaches(): void
}

declare module '*/utils/systemThemeWatcher.js' {
  export function watchSystemTheme(callback: (theme: string) => void): () => void
}

declare module '*/utils/eventLoopStallDetector.js' {
  export function startEventLoopStallDetector(): void
}

declare module '*/utils/ccshareResume.js' {
  export function parseCcshareId(id: string): { sessionId: string }
  export function loadCcshare(opts: Record<string, unknown>): Promise<unknown>
}

declare module '*/utils/sdkHeapDumpMonitor.js' {
  export function startSdkMemoryMonitor(): void
}

declare module '*/utils/sessionDataUploader.js' {
  export function createSessionTurnUploader(opts: Record<string, unknown>): unknown
}

declare module '*/postCommitAttribution.js' {
  export function installPrepareCommitMsgHook(opts: Record<string, unknown>): Promise<void>
}

declare module '*/attributionTrailer.js' {
  export function buildPRTrailers(opts: Record<string, unknown>): Promise<string>
}

// ============================================================================
// Components (feature-gated)
// ============================================================================

declare module '*/components/agents/SnapshotUpdateDialog.js' {
  export const SnapshotUpdateDialog: React.FC<any>
  export function buildMergePrompt(opts: Record<string, unknown>): string
}

declare module '*/assistant/gate.js' {
  const mod: Record<string, unknown>
  export default mod
}

declare module '*/assistant/AssistantSessionChooser.js' {
  export const AssistantSessionChooser: React.FC<any>
}

// ============================================================================
// Ink / Reconciler
// ============================================================================

declare module '*/devtools.js' {
  const mod: Record<string, unknown>
  export default mod
}

// ============================================================================
// Services (feature-gated)
// ============================================================================

declare module '*/sessionTranscript/sessionTranscript.js' {
  const mod: Record<string, unknown>
  export default mod
}

declare module '*/compact/cachedMicrocompact.js' {
  export function isCachedMicrocompactEnabled(): boolean
  export function isModelSupportedForCacheEditing(model: string): boolean
  export function getCachedMCConfig(opts: Record<string, unknown>): unknown
  export function createCachedMCState(opts: Record<string, unknown>): unknown
}

// ============================================================================
// Rollback / Up (CLI subcommands)
// ============================================================================

declare module 'src/cli/rollback.js' {
  export function rollback(opts: Record<string, unknown>): Promise<void>
}

declare module 'src/cli/up.js' {
  export function up(opts: Record<string, unknown>): Promise<void>
}
