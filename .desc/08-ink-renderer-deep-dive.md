# Ink 渲染器深度解析

## 概述

`@anthropic-ai/claude-code` 的 CLI 界面并非直接使用社区版 Ink，而是在 `src/ink/` 下维护了一个高度定制化的 Ink 分支。该框架以 React 组件为起点，通过自定义 `react-reconciler` 将 JSX 映射到一颗轻量级 DOM 树；DOM 节点与 Facebook Yoga（WASM/TS 版本）布局节点一一绑定，在提交阶段同步计算 flexbox 布局；随后渲染流水线把 Yoga 计算结果转化为对终端屏幕缓冲区（Screen）的像素级操作，最终借助 `log-update` 风格的差分算法生成 CSI 转义序列输出到 stdout。整套系统同时支持主屏幕（main-screen，带滚动回显）和备用屏幕（alt-screen，全屏 TUI），并内建了鼠标追踪、文本框选、搜索高亮、IME 光标声明、软换行、双向文字（bidi）等高级终端特性。

## 架构总览

```mermaid
graph TB
    A[React Components<br/>App / Box / Text] -->|JSX| B[Custom Reconciler<br/>src/ink/reconciler.ts]
    B -->|mutate| C[DOM Tree + Yoga<br/>src/ink/dom.ts]
    C -->|calculateLayout| D[Yoga Layout Engine<br/>src/ink/layout/yoga.ts]
    D -->|computed bounds| E[Renderer<br/>src/ink/renderer.ts]
    E -->|renderNodeToOutput| F[Output Ops<br/>src/ink/output.ts]
    F -->|get()| G[Screen Buffer<br/>src/ink/screen.ts]
    G -->|diff| H[LogUpdate Diff<br/>src/ink/log-update.ts]
    H -->|CSI sequences| I[Terminal stdout]
```

## Reconciler 层：React 更新如何映射为 DOM / Yoga 变更

核心文件：`src/ink/reconciler.ts`

该文件导出一个基于 `createReconciler` 的自定义 Host Config，把 React 的 Fiber 更新翻译为对 `src/ink/dom.ts` 中 `DOMElement` / `TextNode` 的操作。Host 类型定义如下：

- **ElementNames**：`ink-root`、`ink-box`、`ink-text`、`ink-virtual-text`、`ink-link`、`ink-progress`、`ink-raw-ansi`
- **DOMElement**：对应上述 host 元素，内部持有 `yogaNode`（当需要布局时）
- **TextNode**：`#text`，仅作为 `ink-text` 的子节点存在

### 关键生命周期钩子

| 钩子 | 作用 |
|------|------|
| `createInstance` | 调用 `dom.createNode(type)` 创建 DOMElement；若 `autoFocus` 为真则返回 `true` 触发 `commitMount` |
| `createTextInstance` | 调用 `dom.createTextNode(text)` 创建 TextNode；若不在 `ink-text` 上下文则抛错 |
| `appendInitialChild` / `appendChild` | 映射为 `dom.appendChildNode` |
| `insertBefore` | 映射为 `dom.insertBeforeNode`，同时处理 Yoga 子节点索引（跳过没有 `yogaNode` 的节点） |
| `removeChild` / `removeChildFromContainer` | 映射为 `dom.removeChildNode`，随后 `cleanupYogaNode` 释放 Yoga 节点，并通知 `FocusManager` |
| `commitUpdate` | 对 `style` / `textStyles` /事件处理器/普通属性做差分更新；`style` 变化会再次调用 `applyStyles(node.yogaNode, ...)` |
| `commitTextUpdate` | 映射为 `dom.setTextNodeValue(node, newText)` |
| `finalizeInitialChildren` / `commitMount` | 当 `autoFocus === true` 时，在提交阶段调用 `FocusManager.handleAutoFocus(node)` |
| `hideInstance` / `unhideInstance` | 通过 `yogaNode.setDisplay(LayoutDisplay.None/Flex)` 配合 `markDirty` 实现显隐切换 |

### `resetAfterCommit`：提交阶段的布局与渲染触发器

```ts
resetAfterCommit(rootNode) {
  rootNode.onComputeLayout?.()   // ① 同步运行 Yoga 布局
  rootNode.onRender?.()           // ② 调度下一帧绘制
}
```

在 `src/ink/ink.tsx` 中，`rootNode.onComputeLayout` 被绑定为：

1. 设置 root Yoga 宽度为 `terminalColumns`；
2. 调用 `yogaNode.calculateLayout(terminalColumns)`；
3. 通过 `recordYogaMs` 记录本次 Yoga 耗时。

这一步**发生在 React 的 commit 阶段、layout effect 之前**，因此 `useLayoutEffect` 里读取 Yoga 尺寸是准确的。

### 调试与性能埋点

- `getOwnerChain(fiber)`：在 `createInstance` 时捕获 React 组件栈（`_debugOwner` → `return`），用于后续 full-repaint 调试归因。
- `markCommitStart()` / `getLastCommitMs()` / `recordYogaMs()`：供 `onRender` 输出 `phases.commit` 与 `phases.yoga` 指标。

## 布局层：Yoga calculateLayout 与脏标记传播

核心文件：`src/ink/dom.ts`、`src/ink/layout/yoga.ts`、`src/ink/layout/engine.ts`、`src/ink/layout/node.ts`

### DOM 与 Yoga 树的双向同步

`dom.ts` 中的 `createNode`、`appendChildNode`、`insertBeforeNode`、`removeChildNode` 在维护 DOM 父子关系的同时，也同步维护 Yoga 子树：

- `appendChildNode`：将子节点的 `yogaNode` 通过 `insertChild` 插入父节点 Yoga 的末尾；
- `insertBeforeNode`：由于 `ink-link`、`ink-progress`、`ink-virtual-text` 没有 `yogaNode`，需要单独计算 yogaIndex，保证 Yoga 子节点顺序与可见 DOM 子节点一致；
- `removeChildNode`：先从 Yoga 父节点 `removeChild`，再回收 `nodeCache` 中的旧区域（`collectRemovedRects`）。

### 脏标记传播 `markDirty`

当任何属性、文本内容、样式或子树结构发生变化时，都会调用 `markDirty(node)`：

```ts
export const markDirty = (node?: DOMNode): void => {
  let current: DOMNode | undefined = node
  let markedYoga = false
  while (current) {
    if (current.nodeName !== '#text') {
      (current as DOMElement).dirty = true
      if (!markedYoga &&
          (current.nodeName === 'ink-text' || current.nodeName === 'ink-raw-ansi') &&
          current.yogaNode) {
        current.yogaNode.markDirty()
        markedYoga = true
      }
    }
    current = current.parentNode
  }
}
```

- 仅向上遍历祖先，设置 `dirty = true`，用于渲染器做子树裁剪；
- 对含有 measure 函数的叶子节点（`ink-text`、`ink-raw-ansi`）调用 `yogaNode.markDirty()`，通知 Yoga 需要重新测量文本尺寸。

### 绕过 Reconciler 的渲染触发 `scheduleRenderFrom`

某些交互（如 ScrollBox 的 `scrollTop` 变化）只修改 DOM 状态而不产生新的 React commit。`scheduleRenderFrom(node)` 会沿 `parentNode` 走到 root，直接调用 `rootNode.onRender`（即 `Ink.scheduleRender`），从而触发一帧绘制。

## 渲染流水线：从 `onRender` 到终端输出

核心文件：`src/ink/ink.tsx`、`src/ink/renderer.ts`、`src/ink/output.ts`、`src/ink/screen.ts`

### 双缓冲帧与对象池

`Ink` 构造函数初始化两枚帧：

- `frontFrame`：上一帧已绘制到终端的屏幕状态（`screen`、`viewport`、`cursor`）
- `backFrame`：下一帧的绘制目标，其 `screen` 在每次 `onRender` 时被复用或重置

同时创建三个共享对象池：

- `StylePool`： intern ANSI SGR 样式数组，ID 的 bit 0 标记“是否在空格上可见”（背景/反色/下划线等）
- `CharPool`： intern 字符字符串，ASCII 走数组 fast-path
- `HyperlinkPool`： intern OSC 8 超链接 URL

### `scheduleRender`：微任务节流

```ts
const deferredRender = (): void => queueMicrotask(this.onRender)
this.scheduleRender = throttle(deferredRender, FRAME_INTERVAL_MS, {
  leading: true,
  trailing: true
})
```

使用 `queueMicrotask` 的原因：`resetAfterCommit` 运行在 React layout effect **之前**，如果立即渲染，则 `useDeclaredCursor` 等 layout effect 设置的 `cursorDeclaration` 会落后一帧。 defer 到微任务可在同一事件循环内、但于 layout effect 之后执行绘制。

### `onRender()` 单帧绘制流程

1. **前置清空**：取消 pending 的 `drainTimer`；`flushInteractionTime()`。
2. **调用 renderer**：
   ```ts
   const frame = this.renderer({
     frontFrame, backFrame, isTTY, terminalWidth, terminalRows,
     altScreen: this.altScreenActive,
     prevFrameContaminated: this.prevFrameContaminated
   })
   ```
3. **Follow-scroll 位移**：若 ScrollBox 发生自动跟随滚动，调用 `consumeFollowScroll()` 获取 `delta`，并通过 `shiftSelectionForFollow` / `shiftAnchor` 将选区同步上移/下移，同时 `captureScrolledRows` 把即将滚出视口的行文本保存到选区状态，保证复制内容不丢失。
4. **覆盖层绘制（仅 alt-screen）**：
   - `applySelectionOverlay(frame.screen, this.selection, this.stylePool)`：在 screen 缓冲区上直接反转（或替换背景色）选区内的 cell 样式；
   - `applySearchHighlight(frame.screen, this.searchHighlightQuery, this.stylePool)`：对所有可见匹配做反色；
   - `applyPositionedHighlight(...)`：对当前搜索匹配项做黄底+粗体+下划线高亮。
5. **全帧损伤回退**：若 `didLayoutShift()` 返回 true（任何节点 Yoga 位置/尺寸与缓存不同，或有子节点被移除），或当前帧存在选区/搜索高亮，或 `prevFrameContaminated` 为 true，则将 `frame.screen.damage` 设为全屏 `{x:0, y:0, width, height}`。
6. **差分计算**：
   ```ts
   const diff = this.log.render(prevFrame, frame, this.altScreenActive, SYNC_OUTPUT_SUPPORTED)
   ```
   - alt-screen 下，将 `prevFrame.cursor` 硬编码为 `ALT_SCREEN_ANCHOR_CURSOR`（`{x:0,y:0,visible:false}`），并在有 diff 时前置 `CSI H`，防止外部程序（tmux 等）篡改物理光标后导致相对坐标漂移。
7. **缓冲交换**：`backFrame = frontFrame; frontFrame = frame`
8. **对象池代际清理**：每 5 分钟调用 `resetPools()`，替换 `charPool`/`hyperlinkPool` 并迁移 `frontFrame.screen` 中的旧 ID。
9. **优化与写入**：`optimize(diff)` 合并相邻补丁，随后 `writeDiffToTerminal` 输出 CSI。alt-screen 下还会在 diff 末尾追加 `cursorPosition(terminalRows, 1)` 将光标停在最底行，避免 iTerm2 光标指引条乱跳。
10. **Scroll drain 续帧**：若 `frame.scrollDrainPending` 为 true（ScrollBox 还有未消费完的 `pendingScrollDelta`），用 `setTimeout(..., FRAME_INTERVAL_MS >> 2)` 预约下一帧，保证快速滚轮能平滑展示中间状态，而不是一次性跳到底。
11. **更新污染标记**：`this.prevFrameContaminated = selActive || hlActive`。

### `renderer.ts`：帧生成器

`createRenderer(rootNode, stylePool)` 返回一个闭包 `Renderer`，内部复用同一个 `Output` 实例以保留 `charCache`。

```ts
export type Renderer = (options: RenderOptions) => Frame
```

关键逻辑：

- 从 `node.yogaNode.getComputedWidth/Height` 读取布局结果；
- **alt-screen 高度截断**：若 `options.altScreen` 为 true，则 `height = terminalRows`，防止有组件错误地渲染在 `<AlternateScreen>` 之外导致 yoga 高度超出终端行数，进而破坏光标模型；
- `prevFrameContaminated` 或 `absoluteRemoved` 为真时，不向 `renderNodeToOutput` 传入 `prevScreen`，从而跳过 blit 优化，强制全量子树重绘；
- 渲染完成后，若存在 `scrollDrainNode`，调用 `markDirty(drainNode)` 为下一帧保留滚动状态。

### `output.ts`：操作收集器与执行器

`Output` 维护一个 `Operation[]` 列表，支持的操作类型：

- `write`：将带 ANSI 的字符串写入指定坐标
- `blit`：从 `prevScreen` 整块复制未变更区域
- `clear`：清除节点缩小后留下的旧区域
- `clip` / `unclip`：嵌套裁剪矩形（`overflow: hidden`）
- `shift`：行块上下滚动（模拟 DECSTBM + SU/SD）
- `noSelect`：标记不可选区域

`get()` 方法分**两趟**执行：

1. **第一趟**：仅处理 `clear`，扩展 `screen.damage`，并收集 `fromAbsolute` 的 clear 矩形（用于后续 blit 排除，防止绝对定位 overlay 移除后 ghost 像素被 sibling 的 blit 恢复）。
2. **第二趟**：依次执行 `clip/unclip/blit/shift/write/noSelect`。`blit` 会与当前 active clip 做交集，并跳过被 absolute clear 覆盖的行区间。

### `writeLineToScreen`：文本 rasterization

这是每帧最热的函数之一，负责把一行 ANSI 字符串变成屏幕上的 cell：

1. **charCache 查找**：以原始字符串为 key，缓存已完成的 `ClusteredChar[]`；
2. 若未命中，则：
   - `tokenize(line)` → `@alcalzone/ansi-tokenize`
   - `styledCharsWithGraphemeClustering`：重新按 Unicode grapheme cluster 合并可能被 tokenize 拆散的 emoji（如家庭 emoji），并按 style run 批量预计算 `styleId` 与 `hyperlink`；
   - `reorderBidi`：对阿拉伯语/希伯来语做双向重排；
3. 遍历 `ClusteredChar[]`：
   - `\t` 展开为到下一个 8 列制表位的空格；
   - `\x1b` 开头的转义序列被安全跳过（防止未识别的 cursor move、clear 等破坏坐标模型）；
   - 零宽字符直接丢弃；
   - 宽字符（CJK、emoji）在右边界若放不下，则插入 `SpacerHead`；
   - 正常宽字符占据 2 cell，并在下一列自动写入 `SpacerTail`。

### `screen.ts`：紧凑的 TypedArray 屏幕缓冲区

`Screen` 不使用对象数组，而是用 **2 个 Int32  per cell** 的打包结构：

- `word0 (cells[ci])`：`charId`（来自 `CharPool`）
- `word1 (cells[ci+1])`：`styleId[31:17] | hyperlinkId[16:2] | width[1:0]`

同一块 `ArrayBuffer` 上还覆盖了一个 `BigInt64Array`（`cells64`），用于 `resetScreen` 和 `clearRegion` 的整行 `fill(0n)`。

辅助数据结构：

- `damage: Rectangle | undefined`：记录本帧被写入（非 blit）的脏区域，供 diff 阶段限定扫描范围；
- `noSelect: Uint8Array`：按 cell 标记是否排除在文本选择之外；
- `softWrap: Int32Array`：按行记录软换行衔接点（`softWrap[r] = prevContentEnd` 表示第 r 行是上一行的自动折行延续），选区复制时据此决定要不要插入 `\n`。

#### 关键函数

- `setCellAt(screen, x, y, cell)`：写入 cell，自动处理宽字符的 `SpacerTail`、覆盖旧宽字符时清理孤儿 spacer、并扩展 `damage`；
- `blitRegion(dst, src, ...)`：用 `TypedArray.set()` 做逐行或整块内存复制，同时复制 `noSelect` 与 `softWrap`；
- `shiftRows(screen, top, bottom, n)`：用 `copyWithin` + `fill` 模拟终端滚动区域（DECSTBM），同时同步 `noSelect` 与 `softWrap`；
- `diffEach(prev, next, cb)`：只在 `damage` 并集区域内扫描差异，相同宽度时走 `diffSameWidth`（逐行 `findNextDiff` 快速跳过连续相同 cell），不同宽度时走 `diffDifferentWidth`。

## 优化策略

### 1. Blit 快速路径（子树未变更时整块复制）

`renderNodeToOutput` 在遍历 DOM 树时，若发现某个子树 `!node.dirty` 且其缓存的屏幕矩形（`nodeCache`）有效，则直接生成一个 `blit` 操作，从 `prevScreen` 复制该区域。这样大部分静态 UI（边框、标签、历史消息）在 spinner 旋转或时钟 tick 时几乎零成本重绘。

### 2. `charCache`：行级字符串缓存

`Output` 内的 `charCache: Map<string, ClusteredChar[]>` 以 ANSI 字符串为 key，缓存 tokenize + grapheme clustering + bidi reordering 的结果。稳定帧中 90% 以上的文本行不发生内容变化，因此这一热点完全命中缓存。

### 3. Grapheme 重新聚类

`ansi-tokenize` 按 ANSI SGR 代码点切分，可能把组合 emoji（如 `👨‍👩‍👧‍👦`）拆成多个 token。`styledCharsWithGraphemeClustering` 在 style run 边界处用 `Intl.Segmenter` 重新聚类，修正宽度计算。

### 4. Damage tracking 与 `prevFrameContaminated`

- 正常帧：仅 `damage` 矩形内的 cell 会被 `diffEach` 扫描，复杂度从 O(屏幕面积) 降到 O(实际变更面积)。
- `prevFrameContaminated`：当上一帧被 selection overlay、alt-screen 重置、`forceRedraw` 或 absolute 节点移除污染后，下一帧强制全屏 damage，确保不会把旧帧的反转 cell、空白或 ghost 像素通过 blit 复制回来。

### 5. 宽字符边界清理

`setCellAt` 和 `clearRegion` 都内建了宽字符的“孤儿检测”：当一个新的窄字符覆盖了一个旧宽字符的首 cell 时，会自动清除其右侧的 `SpacerTail`；反之若覆盖的是 `SpacerTail`，也会清除左侧的宽字符首 cell。这避免了终端光标模型与虚拟光标模型失步。

## Alt-screen 与 Main-screen 的差异处理

### Alt-screen（全屏 TUI）

- `altScreenActive = true` 时，Yoga 计算出的高度会被截断到 `terminalRows`；`viewport.height` 被设为 `terminalRows + 1`，从而绕过 `shouldClearScreen` 的“内容恰好填满即溢出”判断；
- 每帧 diff 前把 `prevFrame.cursor` 强制设为 `(0,0)`，并前置 `CSI H`，使 log-update 的相对光标移动从固定原点计算，具备“自修复”能力（即使 tmux 或用户按了 Cmd+K 导致物理光标偏移，下一帧也能恢复）；
- `cursor.y` 被 clamp 到 `min(screen.height, terminalRows) - 1`，防止内容恰好填满 terminalRows 时，光标 restore 触发终端自动 LF 滚动，导致顶行被推出 alt buffer；
- 进入/退出 alt-screen、resize、SIGCONT 时调用 `resetFramesForAltScreen()`：把 `frontFrame` 和 `backFrame` 都重置为 `terminalRows × terminalColumns` 的空白 screen（而非 `0×0`），避免 log-update 把高度差误判为“增长”而使用 `renderFrameSlice`（其末尾的 CR+LF 会滚动 alt buffer）。

### Main-screen（常规流式输出）

- 不使用 `CSI H`，光标位置必须跟踪已输出的内容高度（滚动回显区）；
- `cursor.y = screen.height`（内容底部），供 log-update 做相对移动；
- 支持 `displayCursor`：组件可通过 `useDeclaredCursor` 声明一个“原生光标应停放的位置”（如输入框 caret）。`onRender` 会在 diff 之后额外输出 `cursorMove(dx, dy)`，把物理光标移到输入处，使 IME 预编辑文本能内联显示，同时屏幕阅读器/放大镜能跟随输入焦点。

### `needsEraseBeforePaint` 的延迟清屏

终端 resize 时，如果旧行比新终端宽度长，右侧会残留旧文本尾巴。`handleResize` 不立即写 `ERASE_SCREEN`（那样会在 `render()` 的 ~80ms 期间留下空白），而是设置 `needsEraseBeforePaint = true`。在下一帧 `onRender` 中，该清屏指令被插入到 BSU/ESU（或等价的同步输出块）内部，与全新帧内容一起原子输出，旧内容在准备完成前始终可见。

## 交互特性

### 鼠标追踪

`App.tsx` 在 `handleSetRawMode(true)` 时向终端发送 `ENABLE_MOUSE_TRACKING`（DECSET 1003/1002，视配置而定）。鼠标事件通过 `parseMultipleKeypresses` 解析为 `ParsedMouse`，在 `processKeysInBatch` 中路由到 `handleMouseEvent`。

`handleMouseEvent` 支持：

- **单击/拖动选区**：左键按下调用 `startSelection`；拖动时根据当前选区模式（char/word/line）更新 `focus`；
- **双击/三击**：在按下时即检测（非释放），立即触发 `selectWordAt` / `selectLineAt`，支持双击后拖动按词扩展；
- **Hover**：无按钮移动事件（bit 0x20 + button=3）触发 `dispatchHover`，维护 `hoveredNodes` 集合，产生 `onMouseEnter` / `onMouseLeave`；
- **超链接点击**：释放时检查 cell 的 `hyperlink` 或扫描纯文本 URL；为避免与双击冲突，浏览器打开被延迟 500ms，若期间收到第二次点击则取消；
- **丢失释放恢复**：若鼠标在终端窗口外释放（iTerm2 不捕获），通过“无按钮 motion”或“focus-out”事件检测并调用 `finishSelection`。

### 焦点管理

`FocusManager` 与 reconciler 的 `commitMount`（`autoFocus`）以及 `tabIndex` 配合，实现 Tab / Shift+Tab 循环。键盘事件通过 `dispatcher.dispatchDiscrete(target, event)` 在 DOM 树上捕获+冒泡。若没有任何 handler 调用 `preventDefault()`，则 `dispatchKeyboardEvent` 会自动执行 `focusManager.focusNext/Previous`。

### 文本选区（Selection）

`Ink` 实例持有 `SelectionState`（`src/ink/selection.ts`），包含 `anchor`、`focus`、`isDragging`、以及 `scrolledOffAbove` / `scrolledOffBelow`（用于保存滚出视口的文本）。

- `applySelectionOverlay`：在 screen buffer 上直接修改 cell 的 `styleId`，把基础样式替换为 `stylePool.withSelectionBg(baseId)`（默认为 solid bg，fallback 到 `withInverse`）。这样 LogUpdate 仍然只做纯 diff，不需要理解“选区”概念。
- `getSelectedText`：读取 `frontFrame.screen`，结合 `softWrap` 和 `noSelect` 位图，把选区内的文本拼接成可复制字符串；滚出视口的行则从 `scrolledOffAbove/Below` 恢复。
- `copySelection` / `copySelectionNoClear`：通过 OSC 52（或 tmux DCS 包裹）把文本写入系统剪贴板，默认行为保留高亮（copy-on-select）。

### 搜索高亮

- `setSearchHighlight(query)`：设置全局搜索字符串，下一帧对所有可见匹配做反色（`stylePool.withInverse`）。
- `scanElementSubtree(el)`：把某个 DOM 子树离线渲染到一张临时 `Screen`，扫描匹配位置，返回消息相对坐标。VML（Virtual Message List）在消息首次挂载时调用一次，之后通过 `setSearchPositions({positions, rowOffset, currentIdx})` 让 `onRender` 每帧把“当前匹配”用黄底+粗体+下划线高亮（`applyPositionedHighlight`）。

### 光标声明（Cursor Declaration）

组件通过 `useDeclaredCursor` 向 `CursorDeclarationContext` 注册一个 `{node, relativeX, relativeY}`。`Ink` 在 `onRender` 末尾查询 `nodeCache.get(decl.node)` 得到该节点在屏幕上的绝对矩形，然后计算目标坐标：

- **alt-screen**：直接输出绝对 CUP `cursorPosition(row, col)`（在 `altScreenParkPatch` 之后，因此最终位置以声明位置为准）；
- **main-screen**：从 `frame.cursor` 或上一次 `displayCursor` 做相对移动 `cursorMove(dx, dy)`。

若 diff 为空且光标目标未移动，则完全跳过 CSI 写入，保留“零写优化”快速路径。

## 关键文件速查表

| 文件路径 | 核心职责 | 需重点关注的符号 |
|---------|---------|-----------------|
| `src/ink/ink.tsx` | `Ink` 类主控、双缓冲、帧调度、终端模式管理、交互 API | `Ink` 构造函数、`scheduleRender`、`onRender`、`onComputeLayout`、`resetFramesForAltScreen`、`needsEraseBeforePaint`、`prevFrameContaminated`、`cursorDeclaration`、`consumeFollowScroll` |
| `src/ink/reconciler.ts` | 自定义 `react-reconciler` Host Config | `createInstance`、`createTextInstance`、`appendInitialChild`、`insertBefore`、`removeChild`、`commitUpdate`、`commitTextUpdate`、`finalizeInitialChildren`/`commitMount`、`resetAfterCommit`、`getOwnerChain`、`markCommitStart`/`getLastCommitMs`/`recordYogaMs` |
| `src/ink/dom.ts` | 轻量 DOM 与 Yoga 树同步、脏标记 | `DOMElement`、`TextNode`、`createNode`、`appendChildNode`、`insertBeforeNode`、`removeChildNode`、`markDirty`、`scheduleRenderFrom`、`findOwnerChainAtRow`、`collectRemovedRects` |
| `src/ink/renderer.ts` | 帧渲染器入口 | `createRenderer`、`Renderer`、`renderNodeToOutput`、`getScrollDrainNode`、`altScreen` 高度 clamp |
| `src/ink/output.ts` | 操作收集与执行、文本 rasterization | `Output` 类、`Operation` 联合类型、`get()` 两趟执行、`charCache`、`writeLineToScreen`、`styledCharsWithGraphemeClustering` |
| `src/ink/screen.ts` | TypedArray 屏幕缓冲区、差分、对象池 | `Screen` 类型、`StylePool`、`CharPool`、`HyperlinkPool`、`CellWidth`、`setCellAt`、`blitRegion`、`shiftRows`、`resetScreen`、`diffEach`、`markNoSelectRegion` |
| `src/ink/components/App.tsx` | 根组件、stdin 处理、鼠标/键盘事件分发 | `App` 类、`handleMouseEvent`、`handleSetRawMode`、`processKeysInBatch`、`flushIncomplete` |
| `src/ink/components/Text.tsx` | 文本组件，映射样式到 `ink-text` | `Text` 组件、`memoizedStylesForWrap`、`textStyles` |
| `src/ink/components/Box.tsx` | 容器组件，映射 flexbox 属性到 `ink-box` | `Box` 组件、`onClick`/`onMouseEnter`/`onMouseLeave` 事件声明 |
| `src/ink/layout/yoga.ts` | Yoga WASM/TS 适配器 | `YogaLayoutNode`、`createYogaLayoutNode` |
| `src/ink/layout/engine.ts` | 布局节点工厂 | `createLayoutNode` |
| `src/ink/layout/node.ts` | 布局引擎抽象接口与枚举 | `LayoutNode`、`LayoutDisplay`、`LayoutMeasureMode`、`LayoutEdge` 等 |
