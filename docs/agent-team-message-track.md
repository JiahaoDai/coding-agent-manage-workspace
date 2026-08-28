# Agent Team Message Track 导出设计

> 状态：草案
> 日期：2026-08-28
> 范围：为 agent-team 新增 HTML 导出能力，将 team 下所有 runs 按 delivery/message 的真实传递顺序展示。

---

## 1. 核心定义

一轮对话指一次 root user input 触发的完整 `team_run`。

一次导出默认包含当前 team 下的全部 runs，而不是只导出最近一次 run。导出 HTML 中每个 `team_run` 渲染为一个独立的 `Conversation N` section：

```text
Conversation 1
  delivery sequence diagram for run A

Conversation 2
  delivery sequence diagram for run B
```

这样同一个 team 下多次 user input 产生的多轮对话都能在同一个 HTML 文件里复盘。

这轮对话内部不固定为：

```text
user -> leader -> agents -> leader -> final
```

真实结构可能包含多次 leader 重新分发、member 返工、review、need_info 等循环：

```text
user -> leader
leader -> agent A
agent A -> leader
leader -> agent B
agent B -> leader
leader -> agent A
agent A -> leader
leader -> final
```

`need_info` 是同一个 run 内的暂停点。用户补充信息后，应继续展示在同一条 message track 中，而不是被当成新的普通 run。

---

## 2. 导出目标

导出 HTML 应按 run 展示多张 delivery sequence diagram：

- 每个 participant 是一列：`User`、`leader`、各 team member、必要时 `System`。
- 每条 `team_message_delivery` 是一条真实箭头。
- 箭头方向来自 message sender 到 delivery receiver。
- 纵向顺序按 delivery 的 `created_at/enqueue_seq` 展示。
- `final` 若没有 delivery 给 user，则作为特殊事件画成 `leader -> User`。
- 点击消息事件打开详情浮层，查看 message、delivery、attempt。

每个 `Conversation N` 不是固定模板流程图，而是对应 run 内所有 delivery 的事实视图。

---

## 3. 数据映射

### 3.1 Participant

```text
User
leader
team members...
System (only when needed)
```

成员顺序：

1. `User`
2. `leader`
3. 其他 member，按创建时间
4. `System`，仅当出现 system message 时追加

### 3.2 Event

每条 delivery 生成一个 event：

```text
from = message.from_kind/from_member_id
to = delivery.to_member_id
label = message.kind + short delivery id
detail = message + delivery + attempts
```

用户输入通过 delivery 表达：

```text
user_request message -> delivery to leader
```

member 回传也通过 delivery 表达：

```text
result/review/need_info message -> delivery to leader
```

final 特判：

```text
final message from leader -> User
```

### 3.3 Team Export

Team 级导出使用完整 runs 列表：

```text
GET /api/teams/:team_id/runs
```

前端导出逻辑：

1. 重新读取当前 team 的全部 runs，避免使用旧的本地 timeline 缓存。
2. 按 `run.create_time ASC` 排序。
3. 对每个 run 调用 delivery sequence projection。
4. 每个 run 渲染为独立 `Conversation N` section。
5. 文件名使用 team 级命名，例如：

```text
agent-team-flow-team-translator-2-runs.html
```

单 run helper 可保留用于测试或未来“导出当前 run”，但 UI 上的 `Export Flow` 默认导出全部 runs。

---

## 4. 视觉设计

第一版使用自包含 HTML + SVG，不引入外部依赖：

- participant、lifeline、message arrows、event labels 全部在同一个 SVG 坐标系里。
- 缩放页面时节点和线一起缩放，不会出现 HTML 节点和 SVG 线分离。
- 图容器只允许横向滚动，用于 member 很多时查看；不需要无意义的内部纵向滚轮。
- event detail 使用固定浮层展示，不撑开 SVG 布局。
- 样式参考 ChatGPT 风格：浅色背景、低噪音、清晰层级、柔和状态色。

---

## 5. 为什么不继续使用固定 flowchart

固定 flowchart 只能表达 happy path：

```text
user -> leader -> agents -> leader -> final
```

但 agent-team 的真实 run 是 message/delivery 链：

- leader 可能多次分发给同一个 member。
- leader 可能等待 user 补充信息后继续分发。
- reviewer 可能要求返工。
- delivery 失败后可能重试。
- final 只是链路的终态之一。

因此导出应以 `team_message_delivery` 为主数据，而不是以预设图形结构为主数据。

---

## 6. 后续可选：流程图库

如果后续需要更强交互能力，可以评估引入流程图库：

- `@xyflow/react`：适合可交互节点图，但若要导出离线 HTML，需要打包 viewer runtime。
- Mermaid sequence diagram：适合文本驱动 sequence 图，但长 message/detail 展示较弱。

当前 V1 先使用自包含 SVG sequence diagram，避免 CDN 依赖和离线导出复杂度。
