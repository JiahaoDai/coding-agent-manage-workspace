# Coding Agent Dashboard

[English README](./README.md)

Coding Agent Dashboard 是一个本地单用户 Web 界面，用来统一管理多个 coding agent 会话和 agent team。目前通过统一的 adapter 接口支持 Claude Code、OpenCode 和 Pi。

这个项目面向本地开发工作流：agent 可以在指定项目目录中流式输出、请求工具权限、保留原生会话历史，并以 leader-driven 的方式组成 team 协同工作。

## 功能概览

- 按项目目录创建和恢复 coding-agent 会话。
- 与 Claude Code、OpenCode、Pi 会话聊天，支持文本流、thinking、状态提示、工具调用和 Markdown 渲染。
- adapter 支持时，可以在会话中选择模型。
- 支持最多两个 session 的分屏工作区。
- 通过全局弹窗处理 agent 工具权限请求。
- 软删除 dashboard 中的 session 记录，不删除 agent 原生会话历史。
- 创建自定义 agent team，包括角色、共享 cwd、leader 规划、worker delivery、review/fix 循环、最终答复和用户补充信息请求。
- 查看 team run activity、delivery stream、member 状态、持久化 run 历史和权限上下文。

## 架构

```text
client/ React + Vite
  - UI、浏览器本地工作区状态、SSE 消费
  - session chat、分屏、team chat、权限弹窗

server/ Hono + Node
  - REST API 和复用 SSE stream
  - Claude Code、OpenCode、Pi 的 adapter registry
  - permission broker
  - SQLite 元数据存储
  - 用于选择 cwd 的文件树 API

shared/
  - client/server 共享的 TypeScript 类型契约
  - session、team、event、adapter 类型
```

运行时流程：

```text
浏览器 UI
  ├─ REST /api/... ───────────────► Node server
  ├─ SSE /api/events ◄──────────── Node server
  │
Node server
  ├─ SQLite 元数据：sessions、teams、runs、messages、deliveries
  ├─ AgentAdapter：Claude/OpenCode/Pi SDK 集成
  └─ Agent 原生存储：消息正文和原生 session 历史
```

dashboard 会把自己的元数据存到 SQLite；普通 session 的消息正文不复制入库，而是通过 adapter 从 agent 原生存储读取。Team 协作所需的 message/delivery/run 会持久化，以便刷新页面后重新加载历史。

## 目录结构

```text
client/
  index.html
  src/
    App.tsx                  主 UI 和 SSE 路由
    components/              session、team、permission UI
    conversation.ts          普通会话流式状态 reducer
    workspace.ts             分屏工作区状态
    styles.css               全局样式

server/
  index.ts                   server 启动入口
  app.ts                     REST 路由、SSE 事件、team orchestration
  db.ts                      SQLite schema 和 store
  permission.ts              权限 broker
  sse.ts                     SSE hub
  adapters/                  Claude/OpenCode/Pi adapter 实现
  fs/tree.ts                 限制在 FS_ROOT 下的安全文件树

shared/
  adapter.ts                 AgentAdapter 契约
  events.ts                  SSE event 契约
  session.ts                 session 类型
  team.ts                    team/run/delivery 类型

docs/
  design.md                  产品和架构设计
  agent-team-prd.md          agent team PRD
  specs/                     版本化功能规格
```

## 环境要求

- Node.js，需兼容当前依赖。
- npm。
- 你想使用的 agent 需要在本机已有可用凭据/配置：
  - Claude Code
  - OpenCode
  - Pi coding agent

dashboard 不负责提供 agent 凭据，它会在本地环境中调用对应 adapter/SDK。

## 快速开始

安装依赖：

```bash
npm install
```

开发模式运行：

```bash
npm run dev
```

这会启动：

- API/SSE server：`http://localhost:4000`
- Vite client：`http://localhost:5173`

浏览器打开 `http://localhost:5173` 即可。

构建前端：

```bash
npm run build
```

检查和测试：

```bash
npm run typecheck
npm test
```

## 配置项

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `4000` | Node API/SSE server 端口。 |
| `DB_PATH` | `data/sessions.db` | SQLite 元数据数据库路径。测试/实验可用 `:memory:`。 |
| `FS_ROOT` | 用户 home 目录 | 应用内文件树暴露的根目录。超出该目录的路径会被拒绝。 |
| `OPENCODE_MODEL` | `deepseek/deepseek-v4-flash` | OpenCode adapter 默认模型。 |
| `OPENCODE_URL` | 未设置 | 可选 OpenCode server URL。 |
| `PI_MODEL` | 未设置 | 可选 Pi 模型覆盖；不设置时由 Pi 自己解析默认模型。 |

示例：

```bash
FS_ROOT=/Users/me/github DB_PATH=data/dev.db OPENCODE_MODEL=deepseek/deepseek-v4-flash npm run dev
```

## 使用普通 Session

1. 新建 session。
2. 从文件树选择项目目录。
3. 选择 agent。
4. 如果该目录和 agent 下有可恢复的原生 session，可以选择 resume。
5. 为 dashboard session 命名。
6. 在 composer 中发送消息。

Session 支持：

- assistant 流式输出
- Markdown/GFM 渲染和代码高亮
- thinking/status/tool-call 展示
- adapter 支持时的模型选择
- 两栏分屏工作区
- 软删除 dashboard 元数据

## 使用 Agent Team

创建 team 时需要配置：

- team 名称
- 共享项目目录 `cwd`
- members：角色、agent、模型、职责 prompt

Team run 流程：

1. 用户向 team 发送请求。
2. 请求先投递给 leader。
3. leader 返回严格 JSON：计划、最终结果或需要用户补充信息。
4. 计划中的 assignment 会变成 worker/reviewer 的 delivery。
5. v1 中 delivery 全局串行执行，避免同一项目目录下并发改动。
6. worker 结果会路由回 leader。
7. leader 可以重新规划、要求 review/fix、向用户询问信息，或者输出最终答复。

Team UI 包含：

- member roster：成员状态和当前 delivery
- run activity timeline：Markdown 渲染的协作消息
- delivery streams：流式 transcript 和过程事件
- waiting user banner：team 等待用户输入时的醒目提示
- 权限弹窗：展示 team/member/delivery 上下文

## 数据模型

SQLite 中主要包含：

- `session`：dashboard 元数据，以及到 agent 原生 session id 的映射
- `team`：team 记录
- `team_member`：team 角色和背后的 dashboard session
- `team_run`：一次用户请求及其协作生命周期
- `team_message`：message bus 消息，例如 user request、assignment、result、review、need_info、final
- `team_message_delivery`：实际调度执行的 delivery
- `team_delivery_dependency`：delivery 依赖关系

普通 session 消息正文仍保留在 agent 原生存储中。Team message content 会持久化，因为 team orchestration 需要 reload run history 和 delivery context。

## 扩展新的 Agent

新增 coding agent 的步骤：

1. 实现 [`shared/adapter.ts`](./shared/adapter.ts) 中的 `AgentAdapter`。
2. 把实现放到 `server/adapters/`。
3. 在 [`server/index.ts`](./server/index.ts) 中注册 adapter。
4. 补充 adapter 测试，覆盖 session 创建、prompt streaming、权限处理、消息读取、模型发现和错误行为。

server 只通过 `AgentAdapter` 和 agent 交互，因此 UI 和 orchestration 逻辑原则上不需要新增 agent-specific 分支。

## 开发说明

- REST 和 SSE endpoint 都在 `/api` 下。
- Vite dev server 会把 `/api` 代理到 `http://localhost:4000`。
- SSE 是复用流：普通 session 事件和 team 事件共用 `/api/events`。
- dashboard 不会静默接受 agent 工具权限。adapter 必须通过共享 prompt handlers 把权限请求传上来。
- 部分集成测试需要正常的本地进程/端口访问。

## 当前限制

- 这是本地单用户工具，不是多用户服务。
- Team v1 为避免同一项目目录并发修改，delivery 全局串行执行。
- Team member 创建时使用 fresh session，不跨 team 共享。
- Agent 原生行为、认证、可用模型和历史消息读取能力取决于各 agent SDK/CLI。
