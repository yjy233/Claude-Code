# Claude Code 的上下文工程（Context Engineering）深度解析

本文档分析 `@anthropic-ai/claude-code` 恢复版源码中，**系统提示（System Prompt）的构造与上下文组装机制**。由于 CLI 在每次调用大模型前都需要拼接一份极长的 system prompt + user context + system context，如何高效利用 Anthropic API 的 **prompt caching**（提示缓存）成为设计的核心考量：静态内容应尽量标记为 `scope: 'global'`（跨组织可缓存），而动态/会话专属内容则必须隔离，避免无谓的 cache bust。

---

## 1. 概述（Overview）

在这个代码库中，**Context Engineering** 指的是：

> 在每次 API 请求前，将代码、环境、用户指令、工具定义、MCP 服务器说明等海量信息，组装成一段结构化的系统提示，并与 `userContext`、`systemContext` 一起构成 **API cache-key prefix** 的全过程。

主要涉及三个层次：

1. **System Prompt（系统提示）**：由 `src/constants/prompts.ts` 中的 `getSystemPrompt()` 生成，是最庞大、最复杂的部分。
2. **User Context（用户上下文）**：由 `src/context.ts` 中的 `getUserContext()` 生成，主要是 `CLAUDE.md` 文件内容和当前日期。
3. **System Context（系统上下文）**：由 `src/context.ts` 中的 `getSystemContext()` 生成，主要是 Git 状态和调试用的 cache breaker。

这三者通过 `src/utils/queryContext.ts` 的 `fetchSystemPromptParts()` 并行拉取，再经 `src/utils/systemPrompt.ts` 的 `buildEffectiveSystemPrompt()` 按优先级合并，最终成为发送给模型的前缀上下文。

---

## 2. 上下文组装流程图

```mermaid
flowchart TD
    A[main.tsx / QueryEngine] -->|每轮对话前调用| B(fetchSystemPromptParts)
    B --> C{customSystemPrompt?}
    C -->|有| D[返回 []<br/>跳过默认 prompt]
    C -->|无| E[getSystemPrompt<br/>src/constants/prompts.ts]
    B --> F[getUserContext<br/>src/context.ts]
    B --> G[getSystemContext<br/>src/context.ts]
    D --> H[buildEffectiveSystemPrompt<br/>src/utils/systemPrompt.ts]
    E --> H
    F --> H
    G --> H
    H --> I[API Request Cache Prefix<br/>systemPrompt + userContext + systemContext]
```

**说明**：

- `fetchSystemPromptParts` 内部使用 `Promise.all` 并行获取三个上下文片段，减少 I/O 等待。
- 如果用户通过 `--system-prompt` 指定了自定义提示，`defaultSystemPrompt` 和 `systemContext` 会被跳过（分别返回 `[]` 和 `{}`），避免浪费计算资源。

---

## 3. System Prompt 解剖（System Prompt Anatomy）

`src/constants/prompts.ts` 中的核心函数：

```ts
export async function getSystemPrompt(
  tools: Tools,
  model: string,
  additionalWorkingDirectories?: string[],
  mcpClients?: MCPServerConnection[],
): Promise<string[]>
```

返回一个字符串数组，每个元素代表一个 prompt section。构造逻辑分为三条路径：

### 3.1 极简模式（`CLAUDE_CODE_SIMPLE`）

当环境变量 `CLAUDE_CODE_SIMPLE` 为真时，直接返回一句极简提示，跳过所有复杂分段。

### 3.2 主动模式（Proactive Mode）

当 `isProactiveActive()` 返回 true 时（`feature('PROACTIVE') || feature('KAIROS')`），返回一份精简的自主代理提示，包含：

- 自主代理身份声明
- `getSystemRemindersSection()`
- `loadMemoryPrompt()`（动态记忆）
- `computeSimpleEnvInfo()`（环境信息）
- 语言、MCP 指令、Scratchpad、FRC、 summarize tool results、Proactive Section 等

### 3.3 正常模式（Normal Path）

这是最常用的路径，输出被明确划分为 **Static（静态）** 和 **Dynamic（动态）** 两部分。

#### 3.3.1 静态分段（Static Segments）—— 可全局缓存

这些分段在绝大多数会话中是恒定的，因此可以安全地使用 `scope: 'global'` 进行跨组织缓存：

| 分段函数 | 作用 |
|---------|------|
| `getSimpleIntroSection(outputStyleConfig)` | 身份介绍 + 网络安全警告 + URL 生成约束 |
| `getSimpleSystemSection()` | 系统行为总则（工具执行权限、system-reminder 说明、自动压缩等） |
| `getSimpleDoingTasksSection()` | 任务执行规范（代码风格、用户帮助、bug 处理等），当 `outputStyleConfig.keepCodingInstructions === false` 时会被省略 |
| `getActionsSection()` | 高风险操作确认原则（reversibility & blast radius） |
| `getUsingYourToolsSection(enabledTools)` | 工具使用指南（优先用专用工具而非 Bash、并行调用建议等） |
| `getSimpleToneAndStyleSection()` | 语气和格式（禁用 emoji、引用代码位置格式、GitHub PR 格式等） |
| `getOutputEfficiencySection()` | 输出效率要求（ant 用户为详细 prose，外部用户为极简版） |

#### 3.3.2 边界标记（Boundary Marker）

```ts
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY =
  '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
```

**作用**：

- 它是静态内容与动态内容之间的硬边界。
- 当 `shouldUseGlobalCacheScope()` 为 true 时，该标记会被插入到数组中。
- **标记之前**的所有内容可以标记为 `scope: 'global'`（跨组织缓存）。
- **标记之后**的所有内容属于会话专属，不应被全局缓存。

> ⚠️ **警告**：移动或删除此标记必须同步更新 `src/utils/api.ts`（`splitSysPromptPrefix`）和 `src/services/api/claude.ts`（`buildSystemPromptBlocks`）中的缓存拆分逻辑。

#### 3.3.3 动态分段（Dynamic Segments）—— 会话专属

动态部分通过 `src/constants/systemPromptSections.ts` 中的注册表机制管理：

```ts
const dynamicSections = [
  systemPromptSection('session_guidance', () => ...),
  systemPromptSection('memory', () => loadMemoryPrompt()),
  systemPromptSection('ant_model_override', () => ...),
  systemPromptSection('env_info_simple', () => computeSimpleEnvInfo(...)),
  systemPromptSection('language', () => getLanguageSection(...)),
  systemPromptSection('output_style', () => getOutputStyleSection(...)),
  DANGEROUS_uncachedSystemPromptSection('mcp_instructions', () => ..., 'MCP servers connect/disconnect between turns'),
  systemPromptSection('scratchpad', () => getScratchpadInstructions()),
  systemPromptSection('frc', () => getFunctionResultClearingSection(model)),
  systemPromptSection('summarize_tool_results', () => SUMMARIZE_TOOL_RESULTS_SECTION),
  // ant-only 数字长度锚点
  systemPromptSection('numeric_length_anchors', () => 'Length limits: ...'),
  // TOKEN_BUDGET 功能
  systemPromptSection('token_budget', () => 'When the user specifies a token target...'),
  // KAIROS BRIEF
  systemPromptSection('brief', () => getBriefSection()),
]
```

这些 section 由 `resolveSystemPromptSections(dynamicSections)` 统一解析。解析逻辑：

- 对于普通的 `systemPromptSection(name, compute)`：
  - 首次计算后结果会被缓存在一个全局 registry（`getSystemPromptSectionCache()`）中。
  - 直到用户执行 `/clear` 或 `/compact` 前都不会重新计算。
- 对于 `DANGEROUS_uncachedSystemPromptSection(name, compute, reason)`：
  - **每轮都会重新计算**。
  - 如果其返回值发生变化，会直接 **bust prompt cache**，导致下一次 API 调用无法命中缓存。

各动态分段的具体含义：

| 分段名 | 来源/函数 | 说明 |
|--------|-----------|------|
| `session_guidance` | `getSessionSpecificGuidanceSection(enabledTools, skillToolCommands)` | 根据当前启用的工具集和 skill 命令注入的会话级指导。例如：Agent 工具使用说明、skill 快捷命令说明、验证代理（Verification Agent）规则等。 |
| `memory` | `loadMemoryPrompt()` | 从 `src/memdir/` 加载的自动记忆（`MEMORY.md`）和团队记忆（TeamMem）内容。 |
| `ant_model_override` | `getAntModelOverrideSection()` | 仅 `USER_TYPE === 'ant'` 且非 undercover 时生效的模型覆盖后缀。 |
| `env_info_simple` | `computeSimpleEnvInfo(model, additionalWorkingDirectories)` | 环境信息：CWD、是否为 git 仓库、平台、Shell、OS 版本、模型名称、知识截止日期、Claude Code 可用渠道等。 |
| `language` | `getLanguageSection(settings.language)` | 用户的语言偏好设置。 |
| `output_style` | `getOutputStyleSection(outputStyleConfig)` | 输出风格配置（如 `concise`、`thorough` 等）。 |
| `mcp_instructions` | `getMcpInstructionsSection(mcpClients)` | 已连接 MCP 服务器提供的 instructions。这是一个 **DANGEROUS_uncached** section，因为服务器可能在任意 turn 连接/断开。 |
| `scratchpad` | `getScratchpadInstructions()` | Scratchpad 目录使用说明（当功能开启时）。 |
| `frc` | `getFunctionResultClearingSection(model)` | Function Result Clearing（自动清理旧工具结果以释放上下文空间）的说明。 |
| `summarize_tool_results` | 常量 `SUMMARIZE_TOOL_RESULTS_SECTION` | 提醒模型把重要信息写入回复，因为原始工具结果可能会被清除。 |
| `token_budget` | 常量字符串 | 当 `feature('TOKEN_BUDGET')` 开启时，告诉模型如何处理用户指定的 token 目标。 |
| `brief` | `getBriefSection()` | KAIROS 功能下的 Brief 工具相关提示。 |
| `numeric_length_anchors` | 常量字符串 | ant-only 实验：用具体数字限制文本长度（≤25 词/≤100 词）。 |

---

## 4. 上下文来源（Context Sources）

### 4.1 `getSystemContext` — 系统级动态信息

文件：`src/context.ts`

```ts
export const getSystemContext = memoize(async () => {
  const gitStatus = /* ... */
  const injection = feature('BREAK_CACHE_COMMAND')
    ? getSystemPromptInjection()
    : null
  return {
    ...(gitStatus && { gitStatus }),
    ...(injection && { cacheBreaker: `[CACHE_BREAKER: ${injection}]` }),
  }
})
```

- **Git 状态**：通过 `getGitStatus()` 获取当前分支、默认分支、git user name、`git status --short`（截断至 2000 字符）、最近 5 条 commit。
  - 在远程模式（`CLAUDE_CODE_REMOTE`）或用户禁用 git instructions 时跳过。
- **Cache Breaker**：`feature('BREAK_CACHE_COMMAND')` 开启时，可注入一个 ephemeral 字符串 `cacheBreaker` 用于强制 bust cache（主要用于 ant 内部调试）。
- 使用 `lodash-es/memoize` 缓存，整个会话只计算一次。

### 4.2 `getUserContext` — 用户级持久信息

文件：`src/context.ts`

```ts
export const getUserContext = memoize(async () => {
  const claudeMd = shouldDisableClaudeMd
    ? null
    : getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))
  return {
    ...(claudeMd && { claudeMd }),
    currentDate: `Today's date is ${getLocalISODate()}.`,
  }
})
```

- **CLAUDE.md**：调用 `getMemoryFiles()` 发现所有 memory 文件，经 `filterInjectedMemoryFiles` 过滤后，由 `getClaudeMds()` 格式化成一个大字符串注入。
  - `CLAUDE_CODE_DISABLE_CLAUDE_MDS` 可硬关闭。
  - `--bare` 模式下，如果没有显式 `--add-dir`，则跳过自动发现。
- **currentDate**：注入当前本地 ISO 日期，帮助模型判断时间。
- 同样使用 `memoize` 缓存。

### 4.3 `getSystemPrompt` — 核心系统提示

文件：`src/constants/prompts.ts`

这是最主要的上下文来源，内容如第 3 节所述，综合了：

- 工具列表（`enabledTools`）
- 当前模型（`model`）
- 额外工作目录（`additionalWorkingDirectories`）
- 已连接的 MCP 服务器（`mcpClients`）
- Skill 命令（`getSkillToolCommands`）
- 输出风格（`getOutputStyleConfig`）
- 环境信息（`computeSimpleEnvInfo`）

---

## 5. Prompt Override 优先级链

文件：`src/utils/systemPrompt.ts`

```ts
export function buildEffectiveSystemPrompt({
  mainThreadAgentDefinition,
  toolUseContext,
  customSystemPrompt,
  defaultSystemPrompt,
  appendSystemPrompt,
  overrideSystemPrompt,
}): SystemPrompt
```

优先级从高到低如下（数字越小优先级越高）：

1. **`overrideSystemPrompt`**（如果设置，例如通过 loop mode）—— **完全替换**所有其他提示。
2. **Coordinator Mode**（`COORDINATOR_MODE`）—— 当 `CLAUDE_CODE_COORDINATOR_MODE` 为真且没有设置主线程 agent 时，使用 `getCoordinatorSystemPrompt()` 替代默认提示。
3. **`mainThreadAgentDefinition`**（主线程 Agent 定义）——
   - **Proactive 模式下**：agent 的 system prompt **追加**在默认 prompt 之后（`# Custom Agent Instructions\n${agentSystemPrompt}`），类似于 teammate 的行为。
   - **普通模式下**：agent 的 system prompt **完全替换**默认 prompt。
4. **`customSystemPrompt`**（用户通过 `--system-prompt` 指定）—— 替换默认提示。
5. **`defaultSystemPrompt`**（标准的 Claude Code 提示，即 `getSystemPrompt()` 的输出）。

**附加规则**：`appendSystemPrompt`（如果提供）几乎总是在末尾追加（`overrideSystemPrompt` 生效时除外）。

**观测点**：如果 `mainThreadAgentDefinition.memory` 存在，会记录 `tengu_agent_memory_loaded` 分析事件。

---

## 6. 记忆系统（Memory System）

记忆系统主要由 `src/utils/claudemd.ts` 和 `src/memdir/` 两个模块协同完成。

### 6.1 CLAUDE.md 发现与加载（`claudemd.ts`）

`getMemoryFiles()` 是一个 `memoize` 包装的异步函数，负责按优先级遍历并加载以下记忆文件：

1. **Managed memory**（`/etc/claude-code/CLAUDE.md`）—— 全局策略，最高优先级基础层。
2. **User memory**（`~/.claude/CLAUDE.md`）—— 用户私有全局指令。
3. **Project memory**（`CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md`）—— 项目级指令，从根目录向当前目录遍历，**越靠近 CWD 优先级越高**。
4. **Local memory**（`CLAUDE.local.md`）—— 本地私有项目指令。
5. **AutoMem**（`MEMORY.md`）—— 自动记忆，跨会话持久化。
6. **TeamMem**（`team/memory.md`）—— 团队共享记忆（`TEAMMEM` feature）。

**特性**：

- **`@include` 嵌套加载**：记忆文件可以通过 `@path`、`@./relative`、`@~/home`、`@/absolute` 语法引用其他文件。`processMemoryFile` 会递归解析，最大深度为 5，并防止循环引用。
- **Frontmatter 条件规则**：`.claude/rules/*.md` 可以通过 YAML frontmatter 中的 `paths` 字段指定 glob 匹配模式，实现按文件路径条件注入。
- **HTML 注释剥离**：使用 `marked` Lexer 只剥离块级 HTML 注释（`<!-- ... -->`），保留代码块内的注释。
- **外部 include 审批**：User memory 中的 `@include` 如果指向项目外部路径，需要用户审批（`hasClaudeMdExternalIncludesApproved`）。

### 6.2 动态系统提示中的记忆（`memdir/memdir.ts`）

`loadMemoryPrompt()` 被 `getSystemPrompt()` 注册在动态 section 中：

```ts
systemPromptSection('memory', () => loadMemoryPrompt())
```

其行为：

- 如果 `feature('KAIROS')` 且 `autoEnabled`，进入 **daily-log** 模式，构建基于日期的日志提示。
- 如果 `feature('TEAMMEM')` 且团队记忆开启，构建 **Combined Memory Prompt**（融合 AutoMem 与 TeamMem）。
- 否则，如果 `autoEnabled`，加载标准 AutoMem 提示。
- `skipIndex`（由 `tengu_moth_copse` feature 控制）为 true 时，可以跳过 MEMORY.md 索引的注入，改为通过附件形式提供。

这些记忆内容都是 **会话可能变化** 的（用户可能在对话中编辑 `CLAUDE.md` 或 `MEMORY.md`），因此放在动态部分，但通过 `systemPromptSection` 的缓存机制，在同一会话内不会重复 I/O。

---

## 7. MCP Instructions Delta — 防止缓存失效

文件：`src/utils/mcpInstructionsDelta.ts`

### 7.1 问题

MCP 服务器可能在会话进行中随时连接或断开。如果每轮都在 `getSystemPrompt` 中重新渲染 `getMcpInstructionsSection`，该 section 被标记为 `DANGEROUS_uncachedSystemPromptSection`，**任何 MCP 连接状态的变化都会 bust 整个 prompt cache**，导致后续 API 调用无法命中昂贵的全局缓存前缀。

### 7.2 解决方案

当 `isMcpInstructionsDeltaEnabled()` 返回 true 时：

- `getSystemPrompt` 中的 `mcp_instructions` **动态 section 被跳过**（返回 `null`）。
- MCP 服务器的 instructions 不再通过 system prompt 传递，而是通过 ** persisted `mcp_instructions_delta` attachments** 增量式地追加到对话历史中。

`getMcpInstructionsDelta(mcpClients, messages, clientSideInstructions)` 的核心逻辑：

1. 扫描 `messages` 中所有类型为 `mcp_instructions_delta` 的 attachment，构建一个已 announce 的服务器名称集合 `announced`。
2. 根据当前实际连接的 MCP 服务器（`mcpClients.filter(c => c.type === 'connected')`）以及 `clientSideInstructions`，计算 `added`（新连接且有 instructions 未 announce）和 `removed`（已 announce 但当前未连接）。
3. 如果 `added` 或 `removed` 非空，返回一个 `McpInstructionsDelta` 对象，由上层（如 `attachments.ts`）将其包装成 `attachment` 消息插入到对话流中。

**好处**：

- system prompt 中不再需要包含易变的 MCP instructions，静态前缀可以完全命中 global cache。
- 新增/断开的 MCP 服务器只产生一个轻量级的 delta attachment，不会影响前缀缓存。

---

## 8. 性能与缓存要点（Performance & Caching Notes）

### 8.1 并行拉取

`src/utils/queryContext.ts` 中的 `fetchSystemPromptParts` 使用 `Promise.all` 同时发起：

```ts
const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
  getSystemPrompt(...),
  getUserContext(),
  getSystemContext(),
])
```

这最大程度减少了同步 I/O（文件读取、git 命令执行）带来的延迟。

### 8.2 Memoization（记忆化）

以下关键函数均使用 `lodash-es/memoize` 包装，保证在同一会话内只计算一次：

- `src/context.ts`：`getSystemContext`、`getUserContext`
- `src/context.ts`：`getGitStatus`
- `src/utils/claudemd.ts`：`getMemoryFiles`

缓存会在用户执行 `/clear` 或 `/compact` 时被清空（通过 `clearSystemPromptSections()` 和 `resetGetMemoryFilesCache()` 等显式调用）。

### 8.3 Global Cache Scope vs Session Scope

- **Global scope**：`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 之前的静态分段。由于这些内容在绝大多数会话中完全一致，API 层面可以标记为 `scope: 'global'`，实现**跨用户/跨组织的缓存命中**。
- **Session scope**：边界之后的动态分段，以及 `userContext` 和 `systemContext`。这些内容包含当前目录、Git 状态、`CLAUDE.md`、日期等，只能在本会话内缓存。

### 8.4 自定义提示优化

当 `customSystemPrompt !== undefined` 时：

- `fetchSystemPromptParts` 直接返回 `defaultSystemPrompt = []` 和 `systemContext = {}`。
- 跳过了 `getSystemPrompt()` 的全部计算和 `getSystemContext()` 的 git 调用。
- 这是性能上的重要 short-circuit。

### 8.5 缓存破坏（Cache Breaking）

`src/context.ts` 提供了：

```ts
let systemPromptInjection: string | null = null
export function setSystemPromptInjection(value: string | null): void
export function getSystemPromptInjection(): string | null
```

- 仅当 `feature('BREAK_CACHE_COMMAND')` 开启时生效（ant-only 调试功能）。
- 设置 injection 时会立即清空 `getUserContext` 和 `getSystemContext` 的 memoize cache，确保下一次请求带上新的 `cacheBreaker`。

---

## 9. 关键文件速查表

| 文件路径 | 核心导出/函数 | 职责 |
|---------|--------------|------|
| `src/constants/prompts.ts` | `getSystemPrompt()` | 组装核心系统提示，区分 static/dynamic segments，管理 boundary marker。 |
| `src/constants/systemPromptSections.ts` | `systemPromptSection()`、`DANGEROUS_uncachedSystemPromptSection()`、`resolveSystemPromptSections()` | 动态 section 的注册表与缓存解析器。 |
| `src/utils/systemPrompt.ts` | `buildEffectiveSystemPrompt()` | 按优先级链合并 override/coordinator/agent/custom/default/append 提示。 |
| `src/utils/queryContext.ts` | `fetchSystemPromptParts()`、`buildSideQuestionFallbackParams()` | 并行拉取三大上下文片段，构建 API cache-key prefix；为 side-question 提供 fallback 参数重建。 |
| `src/context.ts` | `getSystemContext()`、`getUserContext()`、`getGitStatus()`、`setSystemPromptInjection()` | 提供系统上下文（git、cache breaker）和用户上下文（CLAUDE.md、日期）。 |
| `src/utils/messages.ts` | `createUserMessage()`、`createSystemMessage()`、`countToolCalls()` | 消息工厂与消息分析工具。 |
| `src/utils/messages/systemInit.ts` | `buildSystemInitMessage()` | 每轮 yield 的 `system/init` SDKMessage，携带工具/命令/Agent/Skill 等元数据。 |
| `src/utils/claudemd.ts` | `getMemoryFiles()`、`getClaudeMds()`、`filterInjectedMemoryFiles()`、`processMemoryFile()` | CLAUDE.md 的发现、解析、嵌套 include、条件规则、格式化。 |
| `src/memdir/memdir.ts` | `loadMemoryPrompt()` | 加载 AutoMem / TeamMem / KAIROS daily-log 到动态 system prompt。 |
| `src/utils/mcpInstructionsDelta.ts` | `isMcpInstructionsDeltaEnabled()`、`getMcpInstructionsDelta()` | 控制 MCP instructions 是通过 delta attachment 还是 system prompt 传递，防止 cache bust。 |

---

## 10. 结语

Claude Code 的 Context Engineering 是一个在**提示质量**、**功能灵活性**与**缓存性能**之间精心权衡的系统。通过：

- 明确的 **Static / Dynamic 边界**（`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`）
- 分层的 **Override 优先级链**（`buildEffectiveSystemPrompt`）
- 细粒度的 **Section 缓存策略**（`systemPromptSection` vs `DANGEROUS_uncached`）
- 巧妙的 **MCP Delta Attachments** 机制
- 全面的 **Memoization** 与 **并行 I/O**

整个 CLI 得以在毫秒级组装出动辄数万 token 的系统提示，并最大化 Anthropic API prompt cache 的命中率，从而提供快速、连贯且成本可控的交互体验。
