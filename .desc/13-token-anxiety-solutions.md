# 长任务中模型“偷懒”问题的详细解决方案

> 目标：解释 `claude-code` 如何通过工程化手段，防止模型在长任务中过早总结、提前停手（token anxiety）。

## 1. 问题定义：什么是 token anxiety？

在长任务（如大规模重构、多文件分析、批量处理）中，模型容易出现以下行为：
- **过早总结**：只完成了一小部分工作，就开始写 "In summary..."
- **假装完成**：修改几个 todo 状态后就宣布任务结束
- **被截断后放弃**：因为 `max_output_tokens` 限制导致输出中断，随后不再继续
- **上下文压力下收缩**：当对话历史变长时，回复质量明显下降，倾向于用更短的回答搪塞

本项目没有直接使用 `token anxiety` 这个词汇，但设计了一整套**多层防御机制**来系统性地解决这些问题。

---

## 2. 核心防线：TOKEN_BUDGET 系统

这是项目中最具针对性的反“偷懒”工程方案。

### 2.1 用户如何指定 token 目标

`src/utils/tokenBudget.ts` 支持两种语法：
- **简写**：`+500k`、 `+2M`、 `+1B`（放在消息开头或结尾）
- **自然语言**：`use 2M tokens`、 `spend 500k tokens`

```ts
// src/utils/tokenBudget.ts
const SHORTHAND_START_RE = /^\s*\+(\d+(?:\.\d+)?)\s*(k|m|b)\b/i
const VERBOSE_RE = /\b(?:use|spend)\s+(\d+(?:\.\d+)?)\s*(k|m|b)\s*tokens?\b/i
```

### 2.2 系统提示：把目标设定为“硬下限”

在 `src/constants/prompts.ts:538-550`，只要 `feature('TOKEN_BUDGET')` 开启，就会无条件注入一段系统提示：

> *"When the user specifies a token target (e.g., '+500k', 'spend 2M tokens', 'use 1B tokens'), your output token count will be shown each turn. **Keep working until you approach the target** — plan your work to fill it productively. **The target is a hard minimum, not a suggestion. If you stop early, the system will automatically continue you.**"*

关键点：
- **hard minimum**：明确告诉模型这不是建议，是必须达到的底线。
- **automatically continue you**：预先告知模型“提前停也没用，系统会把你拉回来继续干”，降低其尝试偷懒的动机。
- 这段提示被标记为 **unconditionally cached**，避免频繁切换导致 cache miss。

### 2.3 自动 Nudge：模型一停就塞“催工消息”

在 `src/query.ts:1309-1357`，每次模型没有调用工具（`!needsFollowUp`，即模型试图直接结束本轮）时，都会调用 `checkTokenBudget`：

```ts
const decision = checkTokenBudget(
  budgetTracker!,
  toolUseContext.agentId,
  getCurrentTurnTokenBudget(),
  getTurnOutputTokens(),
)

if (decision.action === 'continue') {
  incrementBudgetContinuationCount()
  state = {
    messages: [
      ...messagesForQuery,
      ...assistantMessages,
      createUserMessage({
        content: decision.nudgeMessage,
        isMeta: true,
      }),
    ],
    // ...
    transition: { reason: 'token_budget_continuation' },
  }
  continue  // 强制回到 while(true) 顶部，不进入 stop hooks
}
```

生成的 nudge message 示例（`src/utils/tokenBudget.ts:72`）：

> `Stopped at 47% of token target (470,000 / 1,000,000). Keep working — do not summarize.`

这意味着：
- 模型一旦试图停手，系统会**自动**在下一轮塞一条用户消息，命令它继续。
- 该路径**跳过 stop hooks**，不给模型任何通过总结、反思等手段结束对话的机会。

### 2.4 Diminishing Returns 保护（避免死循环）

`src/query/tokenBudget.ts:59-62`：

```ts
const isDiminishing =
  tracker.continuationCount >= 3 &&
  deltaSinceLastCheck < 500 &&
  tracker.lastDeltaTokens < 500
```

如果已经连续 nudge 了 **3 次以上**，但最近两次的 token 增量都 **< 500**，说明：
- 模型确实已经没活可干；或
- 陷入了死循环/无法推进的僵局

此时系统停止 nudge，标记 `diminishingReturns: true`，正常结束并打 telemetry 点 `tengu_token_budget_completed`。

### 2.5 UI 实时反馈

- `src/components/Spinner.tsx:263`：显示当前 budget 进度百分比。
- `src/screens/REPL.tsx:2990`：在 turn 结束时把 `budgetNudges` 计数展示给用户，让用户知道“系统已经催了模型 X 次”。

---

## 3. max_output_tokens 截断恢复（防止“被砍后放弃”）

长任务中如果模型回复被 `max_tokens` 截断，很容易把截断误当成“任务结束信号”。项目为此设计了两级恢复：

### 3.1 默认 cap + 自动 escalation

`src/services/api/claude.ts:3400-3420` 和 `src/utils/context.ts`：

```ts
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000
```

- 默认把 `max_tokens` **cap 到 8k**，避免 slot over-reserve（注释说明 BQ p99 output 只有 ~4.9k tokens）。
- 但如果真的触顶，且启用了 `ESCALATED_MAX_TOKENS`，直接把上限提升到 **64k**。

在 `src/query.ts:1203-1218`：

```ts
if (feature('ESCALATED_MAX_TOKENS')) {
  const nextMax = getNextMaxOutputTokens(maxOutputTokensOverride, currentModel)
  if (nextMax) {
    state = {
      ...state,
      maxOutputTokensOverride: nextMax,
      transition: { reason: 'max_output_tokens_escalate' },
    }
    continue
  }
}
```

### 3.2 无 escalation 时的 recovery message（最多 3 次）

如果无法 escalation，系统会注入一条 recovery 系统提示，要求模型“在更短篇幅内继续当前任务”（`src/query.ts:1224-1255`）。

```ts
if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) { // limit = 3
  state = {
    ...state,
    maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
    messages: [
      ...messages,
      ...assistantMessages,
      buildSystemWarningMessage('The model response was cut off... Please continue.'),
    ],
    transition: { reason: 'max_output_tokens_recovery' },
  }
  continue
}
```

超过 3 次才向用户暴露 `max_output_tokens` 错误。

---

## 4. Stop Hooks / Blocking Errors 的“修正后继续”机制

在 `src/query.ts:1268-1306`，如果 stop hooks（如 `/think` 总结、subagent 收尾检查）产生了 `blockingErrors`，系统**不会直接返回终端状态**，而是：

```ts
if (stopResult.blockingErrors.length > 0) {
  const next: State = {
    ...state,
    messages: [...messages, ...assistantMessages, ...stopResult.blockingErrors],
    stopHookActive: undefined,
  }
  state = next
  continue
}
```

把错误消息追加到历史中，让模型在下一轮看到并修正。这打击了模型在 stop hook 里耍小聪明、给出不合格答案后提前溜号的行为。

---

## 5. 结构化 Nudge：防止任务“伪完成”

### 5.1 TodoWriteTool / TaskUpdateTool 的 Verification Nudge

`src/tools/TodoWriteTool/TodoWriteTool.ts:72-86`：

当主线程 agent 一次性关闭 **3 个及以上任务**，且其中**没有任何一个是 verification 步骤**时，工具结果中会追加一段强硬提示：

> *"You just closed out 3+ tasks and none of them was a verification step. Before writing your final summary, **spawn the verification agent** (subagent_type="..."). You cannot self-assign PARTIAL by listing caveats in your summary — **only the verifier issues a verdict.**"*

`src/tools/TaskUpdateTool/TaskUpdateTool.ts` 也有镜像逻辑。

这直接打击了模型“随便改几个 todo 状态就写总结交差”的行为。

### 5.2 Context Efficiency Nudge

`src/utils/attachments.ts:3958-3984`：

当上下文增长超过一定阈值（约 10k tokens）但还没有触发 `HISTORY_SNIP` 时，系统会注入一个 `context_efficiency` 附件，提醒模型主动使用 snip 工具管理历史。

这减轻了模型因为“感觉上下文快满了”而开始收缩回复质量的焦虑。

---

## 6. 上下文压缩分层栈（解决焦虑的“根因”）

模型“偷懒”很多时候是**对上下文长度压力的本能反应**。项目通过五级压缩策略，在每次 API 调用前主动释放压力（`src/query.ts:397-544`）：

| 层级 | 策略 | 作用 | 开销 |
|------|------|------|------|
| 1 | **Snip** (`HISTORY_SNIP`) | 把旧消息替换为占位标记 | 零模型开销 |
| 2 | **Microcompact** | 对工具链做局部摘要 | 低 |
| 3 | **Context Collapse** | 投影式折叠历史视图 | 中 |
| 4 | **Reactive Compact** | 413 / 图片过大时的激进压缩 | 中-高 |
| 5 | **Autocompact** | 用轻量模型做全局摘要 | 高 |

这些压缩按**由廉价到昂贵**的顺序执行，确保：
- 模型很少真的需要面对“上下文快炸了”的局面；
- 即使面对长任务，系统也能通过 `autocompact` 把历史摘要成一条 compact message，为后续工作腾出足够空间。

---

## 7. 总结：五层防御体系

| 防线 | 解决的问题 | 关键代码位置 |
|------|-----------|-------------|
| **系统提示** | 模型不知道“不能停” | `src/constants/prompts.ts:538-550` |
| **TOKEN_BUDGET + Nudge** | 模型提前总结/停手 | `src/query/tokenBudget.ts`、`src/query.ts:1309-1357` |
| **Diminishing Returns** | 无限 nudge 死循环 | `src/query/tokenBudget.ts:59-62` |
| **max_output_tokens 恢复** | 截断后放弃 | `src/query.ts:1186-1255`、`src/services/api/claude.ts:3400` |
| **Stop Hook Blocking Errors** | 在 hook 里浑水摸鱼 | `src/query.ts:1268-1306` |
| **Verification Nudge** | 伪完成 todo/task | `src/tools/TodoWriteTool/TodoWriteTool.ts:72-86` |
| **五级压缩栈** | 上下文压力导致回复收缩 | `src/query.ts:397-544` |

整个方案的核心思想是：**不依赖模型自觉，而是通过系统级循环控制（`while(true) + continue`）和消息注入，把“完成任务”变成模型唯一的退出路径。**
