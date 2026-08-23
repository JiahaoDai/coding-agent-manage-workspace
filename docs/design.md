# Coding Agent 管理界面 — 设计文档

> 状态：草稿（待最终确认）
> 日期：2026-08-17
> 工作名：**coding-agent-dashboard**（占位，待命名）

---

## 1. 概述

一个**本地单用户工具**，用于统一管理本机的多个 coding-agent（首批：Claude Code、OpenCode、Pi）。前端负责展示与交互，Node 后端通过各 agent 的官方 SDK 以无头（headless）方式驱动 agent。

**核心能力：**

- 会话管理（列表、按 agent 分类、状态展示、过滤/搜索）
- 会话创建（选目录 + 选 agent + 指定名称）
- 多轮对话（流式展示文本、工具调用、思考过程）
- 多 agent 并发，各自独立流式输出、状态实时可见
- 交互式权限确认（agent 要跑命令/改文件时，界面弹窗同意/拒绝）
- 软删除（删界面记录，不碰 agent 原生 session）

**设计原则：**

1. **可扩展** — 通过适配器接口统一不同 agent，新增 agent 只需新增一个 adapter。
2. **安全** — agent 能真实执行命令、改文件，危险操作走交互式确认。
3. **不重复存储** — 消息正文以 agent 原生存储为准，界面只存元数据与映射关系。

---

## 2. 架构总览

```
┌─────────────────────┐   SSE(下行)   ┌──────────────────────────┐         ┌──────────────────────┐
│   client/            │◄─────────────│   server/                │         │  各 agent 原生存储    │
│   React + Vite       │              │   Node 后端               │         │  ~/.claude/projects/  │
│   （浏览器 UI）       │  REST POST   │  ┌────────────────────┐ │   SDK   │  ~/.pi/agent/sessions/│
│                     │──────────────►│  │  Agent 适配器层      │ │────────►│  OpenCode 存储        │
│   · 会话列表         │   (上行)      │  │  claude / opencode  │ │ headless│                      │
│   · 对话窗口         │              │  │  / pi adapter       │ │         └──────────────────────┘
│   · 权限弹窗         │              │  └────────────────────┘ │
│   · 文件树           │              │           │              │
└─────────────────────┘              │           ▼              │
                                     │   SQLite（session 表）    │
                                     └──────────────────────────┘

        shared/  — 共享类型 + 适配器接口定义（前后端共用）
```

- **client**：纯展示与交互，不直接接触任何 agent SDK 或文件系统。
- **server**：唯一的 SDK 调用方，也是唯一读写 SQLite、唯一访问文件系统（文件树）的一方。
- **shared**：定义 session 类型、事件类型、适配器接口等前后端共用的类型契约。
- **通信**：下行（server → client）走 **SSE** 复用流；上行（client → server）走 **REST POST**。详见 [§11](#11-通信协议)。

---

## 3. 支持的 agents 与 SDK 能力矩阵

| 能力 | Claude Code | OpenCode | Pi |
|---|---|---|---|
| 官方 SDK | `@anthropic-ai/claude-agent-sdk` | `@opencode-ai/sdk` | `@earendil-works/pi-coding-agent` |
| 绑定语言 | TS / Python | TS | TS（另有 stdio RPC） |
| 启动会话 | `query({ options: { cwd } })` | `session.create({ title })` + `session.prompt` | `createAgentSession({ cwd })` / `SessionManager.create(cwd)` |
| 流式消息 | SDKMessage 异步迭代（system/user/assistant/result/stream_event） | SSE：`event.subscribe()`，`message.part.delta` 等 | `session.subscribe()`：`message_update` / `tool_execution_*` |
| 中断/取消 | `Query.interrupt()` / abortController | `session.abort({ id })` | `session.abort()` |
| 列出会话 | `listSessions({ dir })` | `session.list()` | `SessionManager.list(cwd)` / `listAll` |
| 读历史消息 | `getSessionMessages(id, { dir })` | `session.messages({ id })` | `session.messages` |
| 恢复/继续 | ✅ `resume` / `continue` / `forkSession` | ✅ 无原生 resume；同一 id 再 `prompt`（re-prompt，已核实） | ✅ `continueRecent` / `open` / `fork` / `clone` |
| 权限交互 | ✅ `canUseTool` 回调（async，可挂起等待） | ✅ `permission.asked` 事件 + `POST /session/{id}/permissions/{permissionID}`，body `{ response: "once" \| "always" \| "reject" }`（已核实） | ✅ `tool_call` 扩展拦截 + `{ block }` 结果（已核实，见 §9） |

**关键差异（影响设计）：**

- **恢复会话**：Claude Code 与 Pi 原生支持；OpenCode 需特判（向同一 session id 再发 `prompt`，或 `fork`）。
- **目录绑定**：Claude Code / Pi 在创建时指定 `cwd`；OpenCode 以启动时的目录为 project 上下文，需按其 project 概念映射目录。
- **权限链路**：Claude Code 的 `canUseTool` 已逐字核实可行；OpenCode 的 `permission.asked` 事件 + `{ response: "once"|"always"|"reject" }` 回传已核实（ticket #10）；Pi 在实现前需确认。

---

## 4. 数据模型

SQLite 数据库，核心表 `session`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `session_id` | TEXT (PK) | 界面自己的会话 ID（UUID） |
| `coding_agent` | TEXT | 属于哪个 agent（`claude` / `opencode` / `pi` …） |
| `real_session_id` | TEXT | 该 agent 自己的真实 session id |
| `name` | TEXT | 用户创建时指定的名称（展示用） |
| `cwd` | TEXT | 项目目录（绝对路径） |
| `status` | TEXT | `running` / `completed` / `error` / `cancelled` |
| `create_time` | INTEGER | 创建时间戳 |
| `modify_time` | INTEGER | 最后修改时间戳 |

- **消息正文不入库**。展示对话内容时，用 `real_session_id` 去对应 agent 的原生存储读取。
- 索引：`(coding_agent, status, cwd)`，支撑分类、状态过滤与搜索。
- **删除** = 物理 `DELETE` 该行，**不删除** agent 原生 session（因此可重新导入）。

---

## 5. 功能范围

### v1（本次实现）

- 创建会话（选目录 + 选 agent + 指定 name）
- 多轮对话（流式：文本 + 工具调用 + 思考，折叠展示）
- 会话列表（按 agent 分类 + 状态徽标 + 过滤/搜索）
- 软删除会话
- 多会话并发运行、各自状态实时可见
- 分屏工作区（同一页面最多并排展示两个 session，均可独立输入）
- 交互式权限确认

### 以后再做

- 中断/取消运行中的 agent
- 恢复/继续历史会话（统一入口）
- 文件 diff 可视化展示
- 会话重命名、自定义标签
- 跨 agent 交接（把对话上下文迁移到另一个 agent）
- 桌面壳（Tauri，原生目录选择、托盘）

---

## 6. 核心流程

### 6.1 创建会话

1. 用户点"新建会话"。
2. 通过**文件树**选择项目目录（`cwd`）。
3. 选择 coding-agent（claude / opencode / pi）。
4. 后端**查该 agent 原生存储中该目录下已有的会话**：
   - 有 → 列出，让用户"选已有的（resume）"或"新建"。
   - 无 → 直接新建。
5. 用户指定 `name`（resume 时可用原生 summary/首条提示词预填）。
6. 后端创建/打开会话，向 SQLite 写入一条 `session` 记录，返回给前端进入对话窗口。

### 6.2 多轮对话

1. 用户在对话窗口发消息（**POST**）。
2. 后端调用对应 agent 的 prompt/query，把事件经 **SSE 流**推给前端。
3. 前端渲染：文本增量、工具调用（命令/文件读写，可折叠）、思考过程（可折叠）。
4. 一轮跑完 → `status = completed`，回到空闲，等待下一条。

### 6.3 会话列表

- 从 SQLite 查询。
- 按 `coding_agent` 分类/分组，展示 `name`、`status` 徽标、目录、时间。
- 支持按 agent、状态、关键字过滤/搜索。

### 6.4 删除

- 物理删除 SQLite 中该 `session` 记录。
- agent 原生 session 保留。
- （待定）删除**正在运行**的会话时，是否顺带终止后端子进程。

### 6.5 权限确认

以 Claude Code 为例（已核实）：

1. 后端以 `permissionMode: 'default'` + `canUseTool` 回调启动。
2. agent 要执行未被自动放行的工具（如 `Bash`、`Write`）时触发回调，拿到 `(toolName, input)`。
3. 后端把请求经 **SSE 流**推给前端弹窗（展示工具名 + 参数）。
4. 用户点同意/拒绝 → 前端**POST** 回传 → 后端回调返回 `{ behavior: "allow" | "deny", ... }`。
5. agent 继续执行或收到拒绝消息后调整。

### 6.6 分屏工作区

目标是提供类似 VS Code split editor 的对话工作区：同一个页面可并排展示两个 session，每个 panel 都能独立输入、查看流式输出、选择模型，并可同时运行。

**工作区模型：**

- 前端维护最多两个 panel：`paneId -> session_id`，另有 `activePane` 表示当前操作目标。
- `Open` = 打开到 `activePane`；`Open in Split` = 打开到非 active panel。若当前只有一个 panel，则创建第二个 panel。
- 同一 session 不允许在两个 panel 中重复打开；如果目标 session 已经打开，则只切换 `activePane` 到所在 panel。
- 关闭 panel 后，剩余 panel 自动占满主区域；关闭最后一个 panel 后回到空状态。
- 新建会话完成后默认放入 `activePane`，与 `Open` 行为保持一致。
- panel 布局属于浏览器 UI 偏好，存 `localStorage`（open panels、`activePane`、split ratio），不写入 SQLite。

**交互：**

- 左侧 session 列表项支持右键菜单，仅包含 `Open` 和 `Open in Split`。
- 删除仍沿用现有删除按钮，不放进右键菜单。
- 两个 panel 中间有可拖拽分割线，用于调整左右比例；不提供额外的恢复比例按钮。
- 每个 panel 标题栏都有关闭按钮。
- 点击某个 panel 任意区域会激活该 panel；active panel 用轻量 accent 状态标识。

**布局与内容换行：**

- 分屏后不出现页面级横向滚动条；两个 panel 在主区域内自适应收缩。
- 普通 Markdown 文本在 panel 内自动换行。
- 代码块、命令输出、JSON 工具参数等保留块级内部横向滚动，避免破坏缩进与可读性。
- panel 采用弱最小宽度：正常桌面宽度下尽量保持可用阅读宽度；窗口极窄时允许继续收缩，composer 内部自适应换行，发送按钮保持固定图标尺寸。
- 每个 panel 的消息区独立纵向滚动。

**权限请求：**

- 权限请求仍使用全局 modal，避免请求被缩小 panel 或滚动区域遮住。
- modal 必须明确展示来源 session（名称、agent，必要时包含 cwd）。
- 如果请求来源 session 正在某个 panel 中打开，对应 panel 做轻微高亮，帮助用户定位。

---

## 7. 关键设计决策（附理由）

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| 1 | 谁驱动 agent | 界面 headless 驱动 | 界面是唯一入口与聊天窗口 |
| 2 | 形态 | 本地 Web 应用 | 流式/多面板 UI 浏览器最方便 |
| 3 | 用户规模 | 单用户本地 | 避免认证/多租户复杂度 |
| 4 | 统一方式 | 适配器接口 | 三套 SDK 本就要统一，接口最干净、可扩展 |
| 5 | v1 范围 | 创建/对话/列表/删除 | 中断/恢复等留以后 |
| 6 | 存储 | SQLite 元数据 + 原生存正文 | 界面自有概念需自有存储，正文不重复落库 |
| 7 | 技术栈 | React+Vite / Node / SQLite | 三套 SDK 均 TS 优先 |
| 8 | 并发 | 多会话并发 | 核心价值，子进程隔离天然支持 |
| 9 | 权限 | 交互式确认 | 能真改文件跑命令，安全优先 |
| 10 | 删除 | 删 SQLite 行、留原生 session | SDK 删原生支持度不一，误删不可恢复 |
| 11 | 对话形态 | 多轮对话 | 用户核心诉求 |
| 12 | 展示内容 | 文本+工具调用+思考（折叠） | 工具调用是 coding-agent 的核心信息 |
| 13 | 状态 | running/completed/error/cancelled | 简单直接 |
| 14 | 列表来源 | SQLite；创建时查原生 | 管理与发现分离 |
| 15 | 选目录 | 应用内文件树 | 浏览器拿不到绝对路径，需后端读文件系统 |
| 16 | 工程结构 | 单仓库 package 下 client/server/shared | 本地工具无需 monorepo 重量 |
| 17 | 列表管理 | 分类+状态+过滤/搜索，name 展示 | 字段已具备，过滤近乎免费 |
| 18 | 通信 | SSE（下行）+ REST POST（上行） | 下行是单向流，SSE 自动重连；上行是离散请求 |
| 19 | 分屏工作区 | 最多两个 panel，右键打开，拖拽分割线 | 满足同时观察/输入两个 session 的核心诉求，同时控制 v1 复杂度 |

---

## 8. 状态模型

会话级状态，由后端 adapter 监听各 agent 生命周期事件实时更新：

| 状态 | 含义 | 触发 |
|---|---|---|
| `running` | 进行中 | agent 开始执行一轮 |
| `completed` | 已完成 | 一轮成功跑完、回到空闲 |
| `error` | 出错 | agent 崩溃/异常退出 |
| `cancelled` | 已取消 | 预留，配合以后的中断功能 |

软删除用"物理删行"表达，不设单独状态。

---

## 9. 权限模型

- 默认 `permissionMode: 'default'`，配合 `canUseTool` 回调实现交互式确认。
- **不使用** `bypassPermissions` / `acceptEdits`，避免静默绕过弹窗。
- 各 agent 差异：
  - Claude Code：`canUseTool`（已核实，含 `AskUserQuestion` 澄清问题也走此回调）。
  - OpenCode：`permission.asked` 事件（approve/deny 形状已核实：回传 `POST /session/{id}/permissions/{permissionID}`，body `{ response: "once" | "always" | "reject" }`，`once`/`always`=允许、`reject`=拒绝；实现走 `once`，杜绝越权自动放行）。
  - Pi：**无原生权限模式**（没有 `canUseTool`，也没有 `permission.asked` 事件）。审批走**扩展**：inline 扩展监听 `tool_call` 事件（工具执行前触发），返回 `undefined` 放行、`{ block: true, reason }` 阻断（阻断后 agent 收到该工具的错误结果并自行调整）。是否询问由扩展内 resolver 决定，resolver 指向界面的 `onPermissionRequest`（ticket #11 已核实）。默认对副作用工具 `bash`/`write`/`edit` 询问，只读工具（`read`/`grep`/`find`/`ls`）自动放行，与 Claude Code 默认权限集一致。
- 对不支持实时权限的 agent，降级为**每 agent 预设固定权限模式**。

---

## 10. 目录选择

- 应用内**文件树**，后端读文件系统并渲染。
- **根目录限定在可配置范围**（默认 `~` 家目录），避免全盘爬取（慢且危险）。
- 根目录范围可配置（添加/移除）。

---

## 11. 通信协议

- **下行（server → client）**：**SSE**（Server-Sent Events）。一条复用流，后端把所有会话的事件都推送到这一条流上，每条事件带 `session_id` 标签，前端按 `session_id` 分发到对应窗口。
- **上行（client → server）**：**REST POST**。发消息、回答权限、创建/删除/列出会话等全部走普通 HTTP POST。
- **连接管理**：SSE 由 `EventSource` 自动重连，无需手写心跳/断线探测。断流/刷新后从 SQLite 重读会话状态并重新订阅（SQLite 是状态的唯一事实源）。
- 事件类型在 `shared/` 中定义，前后端共用。

---

## 12. 工程结构

```
coding-agent-manage-workspace/
└── <package-name>/            # 待命名
    ├── client/                # React + Vite
    ├── server/                # Node 后端
    │   ├── adapters/          # 每 agent 一个 adapter
    │   ├── db/                # SQLite 访问
    │   ├── fs/                # 文件树（限定根目录）
    │   ├── routes/            # REST POST 接口（发消息/权限/增删改）
    │   └── sse/               # SSE 下行流（复用一条，事件带 session_id）
    └── shared/                # 共享类型 + 适配器接口
```

---

## 13. 技术栈

| 层 | 选型 |
|---|---|
| 前端 | React + Vite + TypeScript |
| 后端 | Node.js + TypeScript |
| 存储 | SQLite |
| 通信 | SSE（下行流）+ REST POST（上行） |
| agent 接入 | 官方 SDK（headless 子进程 / 进程内 SDK） |

---

## 14. 未决事项 / 待确认

1. **App / package 目录名** — 待定。
2. **删除正在运行的会话** — 是否顺带终止后端子进程，待定。
3. **Pi 权限 approve/deny 的精确形状** — ✅ 已核实（ticket #11）：Pi 无原生权限模式，审批走 `tool_call` 扩展 + `{ block }` 结果，resolver 对接界面 `onPermissionRequest`。见 §9。
4. **文件树根目录的默认范围** — 建议默认 `~`，是否需额外配置。
5. **resume 已有会话时的 name 预填** — 用原生 summary/首条提示词，可改。

---

## 15. 后续路线（v2+）

- 中断/取消运行中的 agent（统一"取消"入口）
- 恢复/继续历史会话（统一入口，含 OpenCode 特判）
- 文件 diff 可视化
- 会话重命名、自定义标签
- 跨 agent 交接（上下文迁移）
- 桌面壳（Tauri）：原生目录选择、系统托盘
