# Claude Code CLI 启动与主流程分析

本文档详细梳理 Claude Code CLI 从进程启动到进入交互式 REPL 或非交互式打印模式的完整链路。涉及的关键文件包括：`src/dev-entry.ts`、`src/entrypoints/cli.tsx`、`src/main.tsx`、`src/entrypoints/init.ts` 以及 `src/replLauncher.tsx`。

---

## 1. 开发入口：`src/dev-entry.ts`

`src/dev-entry.ts` 是还原后的开发工作区入口，负责在加载完整 CLI 之前进行快速健康检查。

### 1.1 设置 `globalThis.MACRO` 默认值

```ts
const defaultMacro = {
  VERSION: pkg.version,
  BUILD_TIME: '',
  PACKAGE_URL: pkg.name,
  NATIVE_PACKAGE_URL: pkg.name,
  VERSION_CHANGELOG: '',
  ISSUES_EXPLAINER: '...',
  FEEDBACK_CHANNEL: 'github',
}
if (!('MACRO' in globalThis)) {
  (globalThis as any).MACRO = defaultMacro
}
```

模块顶层将 `package.json` 中的基础元数据注入到 `globalThis.MACRO`，为后续版本输出和构建信息占位。

### 1.2 扫描缺失的相对导入

`collectMissingRelativeImports()` 递归扫描 `src/` 和 `vendor/` 目录下的 `.ts/.tsx/.js/.jsx/.mjs/.cjs` 文件，通过正则：

```regex
/(?:import|export)\s+[\s\S]*?from\s+['"](\.\.?\/[^'"]+)['"]|require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g
```

提取所有相对路径导入/导出，并检查目标文件是否真实存在（含 `index.ts/index.tsx/index.js` 回退）。若发现缺失导入，按字典序排序后输出前 20 条，随后 `process.exit(0)` 拦截启动，防止在源码不完整时进入主流程。

### 1.3 `--version` 与 `--help` 快速路径

- `--version`：直接打印 `pkg.version`（若存在缺失导入则附加 `missing_relative_imports=N`）。
- `--help`：输出精简帮助信息；若存在缺失导入，同样附加统计信息。

### 1.4 转发到正式 CLI 入口

当 `missingImports.length === 0` 时，执行动态导入：

```ts
await import('./entrypoints/cli.tsx')
```

---

## 2. 正式快速路径入口：`src/entrypoints/cli.tsx`

`cli.tsx` 的设计目标是最小化冷启动模块加载：所有非零成本的导入均采用动态 `import()`，仅在被命中的分支才加载。

### 2.1 顶层环境修正

```ts
process.env.COREPACK_ENABLE_AUTO_PIN = '0';
```

在模块最顶部即禁用 corepack 自动 pinning，避免其篡改用户 `package.json`。

### 2.2 `main()` 中的多分支快速路径

函数 `main()` 读取 `process.argv.slice(2)` 后按优先级进行字符串匹配与分发：

| 条件 | 行为 | 动态加载的模块 |
|------|------|----------------|
| `--version` / `-v` / `-V` | 直接 `console.log(MACRO.VERSION)` 返回 | 无（零成本） |
| `--dump-system-prompt` | 渲染并打印系统提示后退出 | `utils/config.js`, `utils/model/model.js`, `constants/prompts.js` |
| `--claude-in-chrome-mcp` | 启动 Chrome MCP 服务 | `utils/claudeInChrome/mcpServer.js` |
| `--chrome-native-host` | 启动 Chrome Native Host | `utils/claudeInChrome/chromeNativeHost.js` |
| `--computer-use-mcp` | 启动 Computer Use MCP 服务 | `utils/computerUse/mcpServer.js` |
| `--daemon-worker=<kind>` | 守护进程工作子进程 | `daemon/workerRegistry.js` |
| `remote-control` / `rc` / `remote` / `sync` / `bridge` | 启动桥接/远程控制模式 | `utils/config.js`, `bridge/bridgeEnabled.js`, `bridge/bridgeMain.js`, `services/policyLimits/index.js` 等 |
| `daemon` | 守护进程主控 | `utils/config.js`, `utils/sinks.js`, `daemon/main.js` |
| `ps` / `logs` / `attach` / `kill` / `--bg` / `--background` | 后台会话管理 | `utils/config.js`, `cli/bg.js` |
| `new` / `list` / `reply` | 模板任务命令 | `cli/handlers/templateJobs.js` |
| `environment-runner` | BYOC 无头运行器 | `environment-runner/main.js` |
| `self-hosted-runner` | 自托管运行器 | `self-hosted-runner/main.js` |
| `--tmux` + `--worktree` | 若启用 worktree 模式则先 `exec` 进 tmux | `utils/config.js`, `utils/worktreeModeEnabled.js`, `utils/worktree.js` |

### 2.3 常规路径：进入完整 CLI

若未命中任何快速路径：

1. `--bare` 检测：若存在，提前设置 `process.env.CLAUDE_CODE_SIMPLE = '1'`，使后续 feature gate 和 Commander 选项构建时即可感知。
2. 启动早期输入捕获：
   ```ts
   const { startCapturingEarlyInput } = await import('../utils/earlyInput.js');
   startCapturingEarlyInput();
   ```
3. 动态导入 `src/main.js`，调用导出的 `cliMain()`：
   ```ts
   const { main: cliMain } = await import('../main.js');
   await cliMain();
   ```

---

## 3. 主控逻辑：`src/main.tsx`

`src/main.tsx` 导出 `main()` 与 `run()`，是 CLI 的核心 orchestrator。

### 3.1 `main()`：启动前的全局准备

`main()` 在调用 `run()` 之前完成以下工作（按代码顺序）：

1. **别名转换**：若 `process.argv` 包含 `-d2e`，将其替换为 `--debug-to-stderr`，绕过 Commander 对多字符短标志的限制。
2. **Windows 安全加固**：
   ```ts
   process.env.NoDefaultCurrentDirectoryInExePath = '1';
   ```
   防止当前目录 PATH 劫持攻击。
3. **警告处理器与退出钩子**：调用 `initializeWarningHandler()`；注册 `process.on('exit', ...)` 恢复光标；注册 `SIGINT` 处理器（`-p` 模式下跳过，避免抢占 `print.ts` 自身的优雅关闭逻辑）。
4. **深度链接 URI 处理**（`DIRECT_CONNECT`）：检测 `cc://` 或 `cc+unix://` URL，重写 `process.argv` 为 `open` 子命令或直接剥离 URL 进入主命令。
5. **macOS 协议处理器**（`LODESTONE`）：检测 `--handle-uri <uri>` 或 `__CFBundleIdentifier` 为 URL handler bundle ID，动态导入 `utils/deepLink/protocolHandler.js` 处理完后直接 `process.exit`。
6. **KAIROS assistant 参数剥离**：`claude assistant [sessionId]` 被识别后，从 `argv` 中移除并暂存到 `_pendingAssistantChat`，使主命令获得完整 TUI。
7. **SSH 远程参数剥离**：`claude ssh <host> [dir]` 被识别后，提取 `--permission-mode`、`--local`、`-c/--continue`、`--resume`、`--model` 等标志并暂存到 `_pendingSSH`，同时拒绝与 `-p/--print` 联用。
8. **交互模式判定**：
   ```ts
   const hasPrintFlag = cliArgs.includes('-p') || cliArgs.includes('--print');
   const hasInitOnlyFlag = cliArgs.includes('--init-only');
   const hasSdkUrl = cliArgs.some(arg => arg.startsWith('--sdk-url'));
   const isNonInteractive = hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !process.stdout.isTTY;
   ```
   若为非交互模式，调用 `stopCapturingEarlyInput()` 停止早期输入捕获；调用 `setIsInteractive(!isNonInteractive)`。
9. **入口点与客户类型设置**：
   - `initializeEntrypoint(isNonInteractive)` 设置环境变量 `CLAUDE_CODE_ENTRYPOINT`（如 `cli`、`sdk-cli`、`mcp`、`claude-code-github-action`、`remote` 等）。
   - 根据环境变量推断 `clientType`（`cli`、`sdk-typescript`、`sdk-python`、`github-action`、`remote`、`claude-vscode`、`local-agent`、`claude-desktop`），写入全局状态 `setClientType(clientType)`。
10. **提前加载设置**：调用 `eagerLoadSettings()` 解析 `--settings` 和 `--setting-sources` 标志，在 `init()` 之前完成，以便后续初始化能按用户指定的设置过滤源。
11. 最后调用 `await run()`。

### 3.2 `run()`：Commander 初始化与命令分发

`run()` 负责构建 Commander.js 程序、挂载 `preAction` 钩子、注册子命令，并在 `program.parseAsync()` 之后按交互/非交互分支执行。

#### 3.2.1 Commander 程序构建

- 使用 `@commander-js/extra-typings` 的 `CommanderCommand`。
- 通过 `createSortedHelpConfig()` 启用**选项与子命令按字母排序**的 help：
  ```ts
  const program = new CommanderCommand()
    .configureHelp(createSortedHelpConfig())
    .enablePositionalOptions();
  ```

#### 3.2.2 `preAction` 钩子

该钩子在任意命令（含默认命令）实际执行前触发，完成重初始化：

```ts
program.hook('preAction', async thisCommand => {
  await Promise.all([
    ensureMdmSettingsLoaded(),      // MDM 设置子进程结果
    ensureKeychainPrefetchCompleted() // Keychain 预读取结果
  ]);
  await init();                      // 核心初始化（见第 4 节）
  process.title = 'claude';          // 终端标题
  const { initSinks } = await import('./utils/sinks.js');
  initSinks();                       // 附加日志 sink
  // --plugin-dir 内联插件处理
  const pluginDir = thisCommand.getOptionValue('pluginDir');
  if (Array.isArray(pluginDir) && pluginDir.length > 0) {
    setInlinePlugins(pluginDir);
    clearPluginCache('preAction: --plugin-dir inline plugins');
  }
  runMigrations();                   // 数据迁移
  void loadRemoteManagedSettings();  // 企业远程设置（非阻塞）
  void loadPolicyLimits();           // 策略限制（非阻塞）
  if (feature('UPLOAD_USER_SETTINGS')) {
    void import('./services/settingsSync/index.js')
      .then(m => m.uploadUserSettingsInBackground());
  }
});
```

#### 3.2.3 顶层选项概览

`run()` 中为默认命令注册了大量选项，关键选项包括：

- `-p, --print`：非交互模式，打印结果后退出。
- `--bare`：极简模式，跳过 hooks、LSP、插件同步、自动内存、背景预取等。
- `--init` / `--init-only` / `--maintenance`：仅运行初始化/设置钩子。
- `--output-format <format>`：`text`（默认）、`json`、`stream-json`。
- `--json-schema <schema>`：结构化输出 JSON Schema。
- `--allowedTools / --allowed-tools <tools...>`：允许的工具白名单。
- `--tools <tools...>`：可用内置工具列表。
- `--mcp-config <configs...>`：动态加载 MCP 服务器配置。
- `--permission-mode <mode>`：权限模式（`auto`、`ask`、`plan`、`bypassPermissions` 等）。
- `-c, --continue`：继续当前目录最近会话。
- `-r, --resume [value]`：按 ID 或搜索词恢复会话。
- `--fork-session`：恢复时创建分支会话。
- `--model <model>`：指定模型。
- `--effort <level>`：努力程度（`low`、`medium`、`high`、`max`）。
- `-d, --debug [filter]` / `--debug-to-stderr` / `--debug-file <path>`：调试输出。
- `--tmux` / `--worktree [-w]`：worktree + tmux 会话支持。
- `--settings <file-or-json>` / `--setting-sources <sources>`：临时设置注入与源过滤。
- `--system-prompt <prompt>` / `--append-system-prompt <prompt>` / `--system-prompt-file <file>`：自定义系统提示。
- `--remote [description]` / `--teleport [session]`：远程会话（CCR）。
- `--remote-control [name]` / `--rc [name]`：远程控制（桥接模式）。
- `--chrome` / `--no-chrome`：Claude in Chrome 集成开关。

#### 3.2.4 子命令注册优化

若检测到 `-p/--print` 模式且不是 `cc://` URL，则**跳过所有子命令注册**（如 `mcp`、`auth`、`plugin`、`doctor` 等），直接 `await program.parseAsync(process.argv)` 后返回，节省约 65ms 启动时间。

---

## 4. 核心初始化：`src/entrypoints/init.ts`

`init()` 被 `memoize` 包裹，确保整个进程生命周期仅执行一次。其职责包括：

1. **启用配置系统**：`enableConfigs()`。
2. **安全环境变量预应用**：`applySafeConfigEnvironmentVariables()`——在用户尚未通过信任对话框前，仅应用安全的环境变量覆盖。
3. **CA 证书早注入**：`applyExtraCACertsFromConfig()`——在首次 TLS 握手前将 `NODE_EXTRA_CA_CERTS` 写入 `process.env`。
4. **优雅关闭注册**：`setupGracefulShutdown()`。
5. **1P 事件日志与 GrowthBook**：动态导入并初始化 `firstPartyEventLogger.js` 和 `growthbook.js`。
6. **OAuth 账户信息补全**：`populateOAuthAccountInfoIfNeeded()`。
7. **JetBrains 检测与仓库检测**：异步启动 `initJetBrainsDetection()` 和 `detectCurrentRepository()`。
8. **远程管理设置与策略限制 Promise 预初始化**：为后续异步加载创建可等待的 Promise。
9. **mTLS 与全局代理配置**：`configureGlobalMTLS()`、`configureGlobalAgents()`。
10. **Anthropic API 预连接**：`preconnectAnthropicApi()`——在动作处理器工作前提前发起 TCP+TLS 握手。
11. **上游代理（CCR）**：若 `CLAUDE_CODE_REMOTE=true`，初始化 `upstreamproxy`。
12. **Windows Shell 设置**：`setShellIfWindows()`。
13. **LSP 与 Swarm 清理注册**：通过 `registerCleanup()` 注册 `shutdownLspServerManager` 和 `cleanupSessionTeams`。
14. **Scratchpad 目录初始化**：若功能开启，创建暂存目录。

### `initializeTelemetryAfterTrust()`

在信任对话框被接受后调用。对于具备远程管理设置资格的用户，会先 `waitForRemoteManagedSettingsToLoad()`，再重新应用完整环境变量 `applyConfigEnvironmentVariables()`，然后调用 `doInitializeTelemetry()` 启动 OpenTelemetry 指标/日志/追踪。非资格用户则直接初始化。

---

## 5. 默认动作处理器：交互 vs 非交互分支

`program.action(async (prompt, options) => { ... })` 是默认命令的处理器。它在完成 `preAction` 后进入大约 3800 行的动作逻辑。以下按阶段拆解：

### 5.1 通用准备阶段（两条分支共享）

- **`-d2e` 转换回顾**：已在 `main()` 处理。
- **`--bare` 再确认**：再次设置 `CLAUDE_CODE_SIMPLE`。
- **Agent/KAIROS 相关激活**：解析 `--agent`、KAIROS assistant 模式、teammate 选项、proactive 模式、brief 模式等，构建 `appendSystemPrompt`。
- **权限上下文初始化**：调用 `initializeToolPermissionContext({ allowedToolsCli, disallowedToolsCli, baseToolsCli, permissionMode, ... })` 得到 `toolPermissionContext`。
- **MCP 配置加载**：
  - 解析 `--mcp-config` 动态配置，进行策略过滤 `filterMcpServersByPolicy()`。
  - 调用 `getClaudeCodeMcpConfigs(dynamicMcpConfig)` 加载本地/项目/用户配置（该 Promise 被提前 kick off，与 setup 重叠执行）。
  - 分离 `sdk` 类型 MCP 与普通 MCP。
- **Claude in Chrome / Computer Use MCP**：根据平台和 entitlement 动态注入 MCP 配置与工具。
- **设置验证错误对话框**：交互模式下若有非 MCP 的设置错误，弹出 `InvalidSettingsDialog`。
- **setup() 调用**：
  ```ts
  const { setup } = await import('./setup.js');
  await setup(preSetupCwd, permissionMode, ...);
  ```
  处理 worktree 切换、tmux 准备、会话目录创建等。
- **命令与 Agent 定义加载**：并行调用 `getCommands(currentCwd)` 和 `getAgentDefinitionsWithOverrides(currentCwd)`。
- **模型解析**：解析 `--model`、agent 指定模型、默认模型，调用 `setMainLoopModelOverride()` 与 `setInitialMainLoopModel()`。

### 5.2 非交互分支（`-p` / `--print`）

当 `getIsNonInteractiveSession()` 为真时，进入以下路径：

1. **输出格式标记**：若 `stream-json` 或 `json`，调用 `setHasFormattedOutput(true)`。
2. **完整环境变量应用**：`applyConfigEnvironmentVariables()`（因为 `-p` 模式隐式信任）。
3. **遥测初始化**：`initializeTelemetryAfterTrust()`。
4. **SessionStart hooks**：非 resume/continue/teleport 时启动 `processSessionStartHooks('startup')`。
5. **组织强制登录校验**：`validateForceLoginOrg()`。
6. **创建 headless store**：
   ```ts
   const headlessStore = createStore(headlessInitialState, onChangeAppState);
   ```
7. **MCP 连接**：对常规 MCP 与 claude.ai MCP 执行阻塞式 `connectMcpBatch()`，确保单轮 `-p` 调用在首 turn 即可看到全部工具；对 claude.ai 连接器设有 5 秒超时兜底。
8. **延迟预取启动**：调用 `startDeferredPrefetches()` 与后台内务 `startBackgroundHousekeeping()`。
9. **进入无头执行**：
   ```ts
   const { runHeadless } = await import('src/cli/print.js');
   void runHeadless(inputPrompt, () => headlessStore.getState(), headlessStore.setState, commandsHeadless, tools, sdkMcpConfigs, agentDefinitions.activeAgents, { ...options });
   ```

### 5.3 交互分支（REPL）

1. **Ink root 创建**：
   ```ts
   const { createRoot } = await import('./ink.js');
   root = await createRoot(ctx.renderOptions);
   ```
2. **启动屏幕与信任对话框**：`showSetupScreens(root, permissionMode, ...)` 处理首次启动信任、OAuth 登录、onboarding 等。若用户拒绝信任，后续检测到 `process.exitCode !== undefined` 则提前返回。
3. **LSP 管理器初始化**：`initializeLspServerManager()` 在信任确立后启动，防止不可信目录中的插件 LSP 提前执行代码。
4. **启动后台刷新**：
   - `checkQuotaStatus()`、`fetchBootstrapData()`、`prefetchPassesEligibility()`、`prefetchFastModeStatus()` 等。
   - `refreshExampleCommands()` 预取示例命令。
5. **MCP 资源预取**：`prefetchAllMcpResources(regularMcpConfigs)` 与 claude.ai 配置的预取并发执行，结果合并去重后暂存到 `mcpPromise`。交互模式下不阻塞 REPL 渲染。
6. **SessionStart hooks**：同样并发启动，但结果（`hookMessages`）以 pending 形式传递给 REPL，在首 turn API 调用前确保模型可见。
7. **会话恢复逻辑**：根据 `--continue`、`-r/--resume`、`--teleport`、`--remote`、`--from-pr`、`_pendingConnect`、`_pendingSSH`、`_pendingAssistantChat` 等进入多条子分支，最终都收敛到 `launchRepl()` 调用。
8. **默认新会话**：无恢复标志时，直接：
   ```ts
   await launchRepl(root, { getFpsMetrics, stats, initialState }, {
     ...sessionConfig,
     initialMessages,
     pendingHookMessages
   }, renderAndRun);
   ```

---

## 6. REPL 启动器：`src/replLauncher.tsx`

`launchRepl()` 是一个极薄的包装函数，负责在已创建的 Ink `root` 上渲染 React 树：

```ts
export async function launchRepl(
  root: Root,
  appProps: AppWrapperProps,
  replProps: REPLProps,
  renderAndRun: (root: Root, element: React.ReactNode) => Promise<void>
): Promise<void> {
  const { App } = await import('./components/App.js');
  const { REPL } = await import('./screens/REPL.js');
  await renderAndRun(root, <App {...appProps}><REPL {...replProps} /></App>);
}
```

- `App` 提供全局状态、FPS 统计、TUI 上下文。
- `REPL`（位于 `src/screens/REPL.js`）是交互式主界面，接收命令列表、MCP 客户端、初始消息、权限上下文、系统提示等配置。

---

## 7. 主流程 Mermaid 图

```mermaid
flowchart TD
    A[src/dev-entry.ts] -->|设置 MACRO 默认值| B[扫描 src/ + vendor/ 缺失相对导入]
    B -->|缺失 > 0| C[打印缺失统计并退出]
    B -->|缺失 == 0| D[src/entrypoints/cli.tsx]
    D -->|--version / --help / 各快速路径| E[直接处理并退出]
    D -->|常规路径| F[startCapturingEarlyInput]
    F --> G[动态导入 src/main.js 调用 cliMain()]
    G --> H[src/main.tsx main()]
    H -->|安全加固 / SIGINT / 深度链接 / SSH / 模式判定| I[设置 clientType + eagerLoadSettings]
    I --> J[调用 run()]
    J --> K[构建 Commander program + preAction 钩子]
    K -->|preAction| L[ensureMdmSettingsLoaded + ensureKeychainPrefetchCompleted]
    L --> M[init() 来自 src/entrypoints/init.ts]
    M --> N[配置 / 安全 env / mTLS / 代理 / 预连接 / 迁移]
    N --> O[program.parseAsync]
    O --> P{isNonInteractiveSession?}
    P -->|是 (-p / --print / --sdk-url)| Q[创建 headlessStore]
    Q --> R[连接 MCP + 启动后台预取]
    R --> S[import src/cli/print.js 调用 runHeadless]
    P -->|否| T[创建 Ink root + showSetupScreens]
    T --> U[信任通过后初始化 LSP + 后台刷新 + MCP 预取]
    U --> V{恢复标志? continue / resume / teleport / remote / ssh / assistant}
    V -->|是| W[加载会话 / 建立远程连接]
    V -->|否| X[新会话]
    W --> Y[launchRepl via src/replLauncher.tsx]
    X --> Y
    Y --> Z[渲染 App + REPL 进入交互式 TUI]
```

---

## 8. 关键设计要点总结

1. **多层快速路径**：从 `dev-entry.ts` 到 `cli.tsx` 再到 `main.tsx`，每一步都尽可能在加载重模块前拦截，降低 `--version`、后台命令、MCP 服务等的启动时延。
2. **动态导入优先**：所有非通用路径（MCP、桥接、守护进程、打印模式、遥测等）均使用 `await import()`，配合 `feature()` 构建时死代码消除。
3. **信任边界清晰**：`init.ts` 中仅应用 `safe` 环境变量；LSP 初始化、完整 env 应用、API 预连接、远程设置加载均推迟到 `showSetupScreens()` 信任对话框之后。
4. **并行化最大化**：keychain 预读、MDM 设置、MCP 配置 I/O、命令加载、setup() 等工作大量通过提前 kick-off Promise 再 `await` 汇合的方式重叠执行。
5. **状态统一**：无论是交互式 `REPL` 还是非交互式 `runHeadless`，最终都基于同一套 `toolPermissionContext`、模型解析、系统提示构建逻辑，保证行为一致。
