# Agent Team 协同工作 PRD

> 状态：草案
> 日期：2026-08-23
> 范围：在现有 coding-agent dashboard 上新增多 agent team、自定义角色、消息总线、任务调度与协同展示能力。

---

## 1. 背景

当前项目已经支持加载 Claude Code、OpenCode、Pi agent 的原生会话，也支持普通聊天、模型选择、流式输出、权限确认和分屏工作区。下一阶段的核心目标是让多个 coding agent 组成一个自定义 team，在同一个项目目录下协同完成任务。

目标形态示例：

```text
team: Product Builder
cwd: /path/to/project

members:
  leader         claude    opus-4.8
  backend-coder  opencode  deepseek-v4-flash
  reviewer       pi        deepseek-v4-flash
```

用户在 team chat 中发送一句需求后，team 内部可以由 leader 分配任务，其他 member 执行、反馈、review，最终由 leader 汇总给用户。

---

## 2. 产品目标

- 用户可以自定义 agent team，包括 team 名称、工作目录、成员角色、agent 类型、模型和角色说明。
- 用户可以在一个 team chat 中向整个 team 发起任务，而不是逐个 agent 手动发送提示词。
- team 内部通过 message bus 传递消息，消息有明确发送方、接收方、内容、任务状态和审计记录。
- Team Orchestrator 根据 message bus、member inbox、依赖关系和 V1 全局串行策略自动调度 agent 执行。
- 页面能清楚展示 team 正在工作：哪个 member 在规划、哪个在执行、哪个在等待依赖、哪个已经完成。
- 每个 member 的执行过程可以展开查看，并支持流式展示文本、工具调用、思考过程、权限请求和错误。
- 第一版 team run 全局串行执行 delivery，避免多个 member 同时修改同一项目目录；后续版本再开放跨 member 并发。

---

## 3. 非目标

- 第一版不做完全无约束的 agent 自主互相喊话。
- 第一版不允许同一个 member 同时处理多个 delivery。
- 第一版不做跨浏览器或多用户协同。
- 第一版不把 agent 原生消息正文完整复制到 team 数据库。
- 第一版不让 worker 默认无限制互相派发任务；worker 之间通信应由 leader 允许或通过明确规则控制。
- 第一版不自动绕过现有权限确认。agent 工具调用仍必须走现有 permission broker。

---

## 4. 核心概念

### 4.1 Team

Team 是一个协作单元，绑定一个项目目录和多个 member。

```text
Team = cwd + members + collaboration rules + runs
```

### 4.2 Member

Member 是 team 中的一个角色。每个 member 背后对应一个 dashboard session；该 session 在创建 team 时新建，因此仍然复用已有 agent adapter、模型选择、权限确认和 SSE 流式输出能力，但不会复用已有普通聊天 session。

### 4.3 Message

Message 是 team message bus 中的协作内容，例如用户请求、leader 分配、worker 结果、reviewer 意见、leader 最终总结。

### 4.4 Delivery

Delivery 是某条 message 投递给某个 member 后形成的任务实例。

同一条 message 可以发给多个 member，因此应拆成多条 delivery。真正被调度执行的是 delivery，而不是 message 本身。

### 4.5 Inbox

逻辑上每个 member 都有自己的 inbox。实现上不需要为每个 member 建单独的表，而是通过统一的 `team_message_delivery` 表查询：

```sql
SELECT *
FROM team_message_delivery
WHERE to_member_id = ?
  AND status IN ('pending', 'blocked');
```

### 4.6 Run

Run 表示用户在 team chat 中发起的一次完整协作任务。一个 run 下可以产生多条 message、多条 delivery、多个 member 的接力执行和最终汇总。

### 4.7 Attempt

Attempt 表示某个 delivery 的一次执行尝试。若 delivery 失败后重试，新的输出应进入新的 attempt，避免和上一次失败的流式输出混在一起。

---

## 5. 推荐协作模式

第一版建议采用 leader-driven orchestration。

流程：

1. 用户向 team 发送请求。
2. Orchestrator 创建 team run。
3. 请求先投递给 leader。
4. leader 产出结构化计划或任务分配。
5. Orchestrator 根据 leader 的计划创建 worker/reviewer 的 delivery。
6. worker 执行后把结果写回 message bus。
7. Orchestrator 默认把 worker/reviewer 的结果投递回 leader。
8. leader 重新审视结果后，可以追加任务、要求其他 member 处理、要求返工，或生成最终答复。
9. reviewer 根据依赖关系等待 worker 完成后执行 review。
10. leader 等待必要结果后生成最终答复。

不建议第一版采用全员广播后完全自主抢答，因为它容易导致重复工作、上下文污染、任务无限循环、文件修改冲突和权限请求过载。

---

## 6. 已确认产品决策

- Team 创建时必须为每个 member 新建 session，不复用已有普通 session。
- 一个 team 下的所有 member 都运行在同一个项目目录 `cwd` 下。
- 一个 member 背后对应一个 agent 原生 session；该 member 不允许加入另一个 team。
- Team run 完成后，leader final 只需要写入 leader 的原生 session；team 数据库只保留 team message/delivery/run 等协作元数据。
- 创建 team 时可以提供预设角色模板，例如 `leader`、`backend-coder`、`reviewer`、`tester`。
- 第一版不支持用户手动插队，也不支持手动提高某个 delivery 的优先级。
- 第一版不支持用户在 run 中途直接向某个 member 补充消息，后续再考虑。
- Leader 的 assignment 输出第一版使用 JSON contract，通过 prompt 和 few-shot 约束 leader 输出结构化计划。
- Leader 的 assignment 只能投递给当前 team 中已经存在的 member role。第一版不允许 leader 在 plan 中发明新 role，也不会因为 plan 里出现未知 role 自动创建 member；例如 team 没有 `architect` 时，`"to": "architect"` 会被视为规划错误。
- 第一版采用全局串行 delivery 执行策略：同一个 team run 中任意时刻最多只有一个 delivery running。
- `max_parallel_members` 可以保留在 schema 中，但第一版固定为 `1`，跨 member 并发留到后续版本。
- Member 可以发送受控 message；V1 默认只能发送给 leader，由 leader 决定是否继续分配新任务、要求 review/fix 或结束 run。
- 后续迭代可以允许 leader 提出“需要新增 member”的计划，例如建议创建 `architect`、`security-reviewer` 等角色，但这应作为显式 proposal 进入 UI，由用户确认后再创建 fresh member session，而不是在 assignment validation 中隐式创建。

---

## 7. 数据模型草案

### 7.1 team

```ts
interface TeamRecord {
  team_id: string;
  name: string;
  cwd: string;
  status: 'idle' | 'running' | 'error' | 'archived';
  /** Reserved for later parallel execution. V1 is fixed to 1. */
  max_parallel_members: number;
  create_time: number;
  modify_time: number;
}
```

### 7.2 team_member

```ts
interface TeamMemberRecord {
  member_id: string;
  team_id: string;
  role: string;
  coding_agent: string;
  session_id: string;
  model: string | null;
  responsibility_prompt: string;
  status: 'idle' | 'running' | 'waiting_permission' | 'error';
  current_delivery_id: string | null;
  create_time: number;
  modify_time: number;
}
```

说明：

- `session_id` 指向创建 team 时为该 member 新建的 dashboard session。
- 一个 member 背后有一个真实 agent session。
- 一个 member 只能属于一个 team。
- 同一个 member 同一时间最多只能有一个 `current_delivery_id`。

### 7.3 team_run

```ts
interface TeamRunRecord {
  run_id: string;
  team_id: string;
  root_user_message_id: string;
  status: 'running' | 'waiting_user' | 'completed' | 'failed' | 'cancelled';
  max_rounds: number;
  current_round: number;
  create_time: number;
  finish_time: number | null;
}
```

说明：

- 每次用户向 team 发送一条请求，创建一个 run。
- `max_rounds` 用于防止 agent 之间无限传消息。

### 7.4 team_message

```ts
interface TeamMessageRecord {
  message_id: string;
  team_id: string;
  run_id: string;
  from_member_id: string | null;
  from_kind: 'user' | 'member' | 'system';
  kind:
    | 'user_request'
    | 'assignment'
    | 'result'
    | 'review'
    | 'need_info'
    | 'proposal'
    | 'final'
    | 'status'
    | 'error';
  content: string;
  create_time: number;
}
```

说明：

- message 表达协作内容。
- message 不直接表示“谁已经处理过”，处理状态在 delivery 表中。

### 7.5 team_message_delivery

```ts
interface TeamMessageDeliveryRecord {
  delivery_id: string;
  message_id: string;
  team_id: string;
  run_id: string;
  to_member_id: string;
  status: 'blocked' | 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  enqueue_seq: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
}
```

说明：

- 每个 member 的 inbox 顺序由 `enqueue_seq` 控制。
- `enqueue_seq` 是按 `to_member_id` 独立递增的单 member 队列序号。
- 调度顺序默认使用：

```sql
ORDER BY enqueue_seq ASC
```

第一版不提供手动插队或 priority 调整。

### 7.6 team_member_queue

```ts
interface TeamMemberQueueRecord {
  member_id: string;
  next_seq: number;
}
```

说明：

- 每次向某个 member 投递 delivery 时，在数据库事务里读取并递增 `next_seq`。
- 不建议只用 `MAX(enqueue_seq) + 1`，因为并发投递时容易拿到重复序号。

### 7.7 team_delivery_dependency

```ts
interface TeamDeliveryDependencyRecord {
  delivery_id: string;
  depends_on_delivery_id: string;
  dependency_type: 'success' | 'finished';
}
```

依赖语义：

- `success`：上游 delivery 必须 `done`，当前 delivery 才能开始。
- `finished`：上游 delivery 只要进入终态即可，包括 `done`、`failed`、`cancelled`。

典型用法：

```text
reviewer delivery depends_on backend delivery success
leader final delivery depends_on backend delivery finished
leader final delivery depends_on reviewer delivery finished
```

### 7.8 team_delivery_attempt

```ts
interface TeamDeliveryAttemptRecord {
  attempt_id: string;
  delivery_id: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  started_at: number;
  finished_at: number | null;
  error: string | null;
}
```

说明：

- 第一版如果不支持 retry，可以暂缓实现 attempt 表。
- 若支持 retry，流式事件必须带 `attempt_id`，避免不同尝试的输出混合。

---

## 8. Orchestrator 调度机制

### 8.1 接收消息的触发方式

Agent SDK 本身不会被动监听 message bus。接收方的触发由 Team Orchestrator 完成。

流程：

```text
message bus 写入 message
        ↓
创建一条或多条 delivery
        ↓
orchestrator 扫描 pending/blocked delivery
        ↓
依赖满足且 member idle
        ↓
把 member inbox 转换成 prompt
        ↓
调用对应 adapter.prompt(...)
        ↓
流式输出进入 delivery attempt
        ↓
执行结果写回 team_message
        ↓
继续调度下一轮
```

### 8.2 单 member 串行

同一个 member 背后是同一个 agent session。为了避免上下文顺序错乱、工具调用交叉和权限请求归属混乱，必须保证同一个 member 同时只处理一个 delivery。

```text
backend-coder Delivery #12 running
backend-coder Delivery #18 queued
backend-coder Delivery #23 blocked
```

### 8.3 V1 全局串行执行

第一版采用全局串行 delivery 执行策略。

这意味着不只是同一个 member 串行，而是同一个 team run 中任意时刻最多只有一个 delivery 在执行：

```text
leader plan
  ↓
backend-coder implement
  ↓
reviewer review
  ↓
backend-coder fix
  ↓
leader final
```

V1 调度约束：

- `max_parallel_members` 固定为 `1`。
- Orchestrator 每次只启动一个 runnable delivery。
- 即使多个 member 都有 pending delivery，也按依赖关系和队列顺序逐个执行。
- 保留 dependency、blocked/pending/running/done 状态，为后续并发版本打基础。
- 保留 per-member inbox 和 `enqueue_seq`，但全局调度层会保证任意时刻只有一个 running delivery。

这样可以先把 message bus、delivery、dependency、leader plan、UI 展示和权限链路跑通，同时基本避开多个 agent 同时修改同一批文件导致的冲突。

### 8.4 后续跨 member 并发

不同 member 背后是不同 agent session，因此可以并发执行。

广播示例：

```text
leader -> broadcast -> backend, reviewer, tester

backend   running
reviewer  running
tester    running
```

后续版本可以开放 team 最大并发数：

```ts
team.max_parallel_members = 3;
```

避免一个 team 中大量 member 同时改文件、跑命令、触发权限请求。

### 8.5 依赖调度

一个 delivery 能运行，需要满足：

```text
status = pending
member status = idle
team running count = 0 in V1
所有 success 依赖都是 done
所有 finished 依赖都是 done/failed/cancelled
```

创建时依赖未满足的 delivery 应为 `blocked`。当上游 delivery 进入终态后，orchestrator 检查下游依赖，满足后转为 `pending`。

### 8.6 Member Outbound Message 与 Leader Re-plan

V1 不是一次性静态流水线。某个 member 完成 delivery 后，可以把执行结果、问题、建议或失败原因写回 message bus。Orchestrator 默认把这些 outbound message 投递给 leader，让 leader 重新审视当前 run。

允许的 member outbound message 类型：

```text
result       完成任务后的结果摘要
review       review 意见
need_info    需要 leader 或用户补充信息
failed       当前任务失败及原因
proposal     建议追加任务或交给其他 member 处理
```

V1 路由规则：

- worker/reviewer 默认只能向 leader 发送 outbound message。
- worker 不直接给其他 worker 派任务。
- worker-to-worker message 需要 leader 在下一轮 plan 中显式创建。
- Orchestrator 收到 member outbound message 后，为 leader 创建一个 follow-up delivery。
- leader follow-up delivery 可以输出新的 `plan` JSON、`need_user_input` 或 `final`。

闭环示例：

```text
leader plan
  ↓
backend-coder implement
  ↓
backend-coder result -> leader
  ↓
leader re-plan: ask reviewer to review
  ↓
reviewer review
  ↓
reviewer proposal: backend should fix missing test
  ↓
leader re-plan: ask backend-coder to fix
  ↓
backend-coder fix
  ↓
backend-coder result -> leader
  ↓
leader final
```

这样即使 leader 第一次 plan 没有覆盖所有后续动作，team run 也可以根据 member 的实际执行结果继续推进。

### 8.7 防止死锁和无限循环

- 创建 dependency 时检查同一 run 内是否形成环。
- 每个 run 设置 `max_rounds`。
- worker 默认只把结果回给 leader。
- worker 之间互发消息需要 leader 指令或明确规则。
- leader 必须在 run 结束前生成 `final` 类型 message。

---

## 9. Leader JSON Contract

Leader 的 planning 和 re-plan 阶段应输出结构化 JSON，用于 Orchestrator 创建 message、delivery 和 dependency，或者结束 run。

在组装 leader prompt 时，Orchestrator 必须列出当前 team 可用的 member roles，并要求 `assignments[].to` 精确匹配其中一个 role。这样 leader 只能把任务分给已经存在的 member，避免把任务投递给不存在的 `architect`、`designer` 等临时想出的角色。

Plan 示例：

```json
{
  "type": "plan",
  "summary": "Implement the first version of agent team message bus.",
  "assignments": [
    {
      "id": "backend-message-bus",
      "to": "backend-coder",
      "task": "Implement SQLite tables and server APIs for team messages and deliveries.",
      "context": "Use the existing session store and SSE patterns.",
      "depends_on": []
    },
    {
      "id": "review-backend-message-bus",
      "to": "reviewer",
      "task": "Review the backend-coder implementation and report risks.",
      "context": "Focus on queue ordering, dependency handling, and tests.",
      "depends_on": ["backend-message-bus"],
      "dependency_type": "success"
    }
  ]
}
```

Final 示例：

```json
{
  "type": "final",
  "summary": "Implemented the requested message bus design and reviewed the result.",
  "result": "The team message bus PRD is updated with sequential delivery, dependency handling, and member outbound message routing."
}
```

Need user input 示例：

```json
{
  "type": "need_user_input",
  "question": "The backend implementation found an ambiguous storage choice. Should team messages be stored in the existing sessions.db or a separate teams.db?"
}
```

Server 处理流程：

1. `JSON.parse` leader 输出。
2. 使用 schema 校验 `type`。
3. 如果 `type = "plan"`，校验 `summary`、`assignments`、`to`、`depends_on`。
4. 校验 `to` 必须是当前 team 的 member role。
   - 如果 `to` 不是当前 team 的 member role，run 进入规划失败，不创建 assignment delivery。
   - 错误信息应包含未知 role 和当前可用 roles，例如：`unknown assignment target role: architect. Available roles: leader, backend-coder, reviewer`。
5. 校验 `depends_on` 必须指向同一 plan 中存在的 assignment id，或已经存在的 delivery/message 引用。
6. 解析成功后创建 assignment message、delivery 和 dependency。
7. 如果 `type = "final"`，创建 final message 并完成 run。
8. 如果 `type = "need_user_input"`，创建 need_info message，并让 run 进入等待用户状态。
9. 解析失败时不创建 delivery，展示 leader 原始输出和错误，让 run 进入需要处理的规划失败状态。

Leader 输出给机器，UI 负责把 JSON 渲染成用户友好的计划视图。不要要求 leader 同时输出自然语言和 JSON，避免解析不稳定。

未来如果要让 agent 自己参与 team 结构规划，应新增单独 contract，例如：

```json
{
  "type": "team_member_proposal",
  "summary": "The task would benefit from a dedicated architecture reviewer.",
  "proposed_members": [
    {
      "role": "architect",
      "agent": "claude",
      "model": null,
      "responsibility_prompt": "Review architecture decisions and split work into implementable tasks."
    }
  ]
}
```

该 proposal 只表达“建议新增成员”，不直接创建 delivery；UI 应展示建议，让用户确认、编辑 agent/model/prompt 后再创建 fresh member session。确认之前，leader plan 仍必须只使用现有 member roles。

---

## 10. Prompt 组装策略

Member 背后的原生 agent session 会保留自己的对话历史。创建 team 后，如果每次 delivery 都重复发送角色人设、完整 run 背景和历史消息，会造成上下文重复、token 浪费，甚至让 agent 误以为旧任务又被重新分配。

因此 prompt 分为两类：

1. `member initialization prompt`：只在 member session 创建后发送一次，用于建立角色、人设、协作协议和输出规范。
2. `delivery prompt`：每次执行 delivery 时发送，只包含本次新增任务、必要引用、依赖结果摘要和本次期望输出。

### 10.1 Member Initialization Prompt

初始化 prompt 在创建 team member 的原生 session 后发送一次。它可以包含稳定信息：

```text
You are backend-coder in an agent team.

Your role:
- Implement backend changes.
- Keep changes focused.
- Report concise progress and final result to leader.

Collaboration rules:
- You receive tasks from the team orchestrator.
- Treat each incoming delivery as the next task in this same team session.
- Do not assume a previous task should be repeated unless the new delivery says so.
- Report results concisely for the leader.

Output format:
- RESULT: ...
- NEED_INFO: ...
- MESSAGE_TO reviewer: ...
- PROPOSAL: ...
- FAILED: ...
```

该 prompt 进入 member 的原生 session 历史，后续不再重复发送。

### 10.2 Delivery Prompt

Delivery prompt 只发送增量信息。它不重复 role 人设，不重复完整历史，不重复已经在原生 session 中出现过的固定协作规则。

示例：

```text
New delivery: delivery-12
Run: run-42

Task:
Implement SQLite tables and server APIs for team message delivery.

Context:
- User request: Add an agent team message bus.
- Leader plan summary: Build message, delivery, dependency, and sequential scheduler primitives.

Expected output:
- Code changes.
- Tests.
- Concise result summary.

Use the output format already established for your role.
```

如果该 delivery 依赖上游 delivery，prompt 只包含上游结果摘要，而不是复制上游完整流式过程：

```text
Dependency results:
- backend-coder delivery-12: done. Summary: Added team_message and team_message_delivery tables; tests passed.
```

### 10.3 Prompt 去重原则

- 固定角色说明只进 initialization prompt。
- 每次 delivery 只发送新增任务和必要摘要。
- 不从 team database 复制 member 原生 session 的完整历史。
- 不把同一个 message 的完整内容反复塞给同一个 member；通过 delivery status 和 `enqueue_seq` 保证只处理一次。
- 如果需要提醒角色边界，只发送短提醒，例如 `Reminder: respond as reviewer, focus on risks and tests.`，不要重复整段 role prompt。
- Team message bus 保存协作元数据和摘要，原生 agent session 保存成员自己的对话上下文。

Worker/reviewer 的结果输出后续也可以改进为结构化 JSON。第一版可以先用受约束文本格式，再由 server 做简单解析或让 leader 负责解释 worker 输出。

V1 中 worker/reviewer 输出会被 Orchestrator 转成 outbound team message，并默认投递给 leader：

```text
RESULT    -> team_message.kind = result
REVIEW    -> team_message.kind = review
NEED_INFO -> team_message.kind = need_info
PROPOSAL  -> team_message.kind = proposal
FAILED    -> team_message.kind = error
```

如果 worker 输出 `MESSAGE_TO reviewer`，V1 不直接投递给 reviewer，而是转给 leader 审视；leader 可以在下一轮 plan 中显式创建给 reviewer 的 assignment。

---

## 11. 文件修改冲突策略

第一版 team 的所有 member 都在同一个项目目录 `cwd` 下运行，并采用全局串行 delivery 执行策略。因此 V1 基本不需要解决多个 member 同时修改同一批文件的问题。

但后续一旦开放跨 member 并发，就需要重新处理文件冲突风险。

可选方案：

### 11.1 同目录 + 调度约束

所有 member 使用同一个 `cwd`，通过 leader planning、delivery dependency 和角色约束减少冲突。

建议第一版采用这个方案，并加入保守规则：

- 全局任意时刻只有一个 delivery running。
- 默认只有一个实现型 member 在执行写代码任务。
- reviewer/tester 默认依赖 coder 完成后再运行。
- broadcast 更适合发给只读分析、review、测试计划等角色，不适合同时广播给多个写代码角色。
- leader 的 assignment 中可以包含 `expected_files` 或 `scope`，用于 UI 提示潜在重叠，但第一版不强制锁定。
- 权限弹窗中继续清晰展示来源 member、cwd、tool input，让用户在高风险修改前能人工判断。

优点：

- 实现最简单。
- 符合当前“一个 team 一个项目目录”的产品决定。
- 能复用现有 adapter、session、permission 体系。

V1 限制：

- 如果后续开放并发，该方案无法从文件系统层面阻止两个 member 修改同一文件。
- 如果用户手动在外部改文件，team 内部无法自动感知所有冲突。

### 11.2 Advisory File Lock

在 server 层维护软锁，例如 `team_file_lock`，当某个 delivery 声明或实际触碰某些文件时，对这些路径加锁。

这个方案可以后续考虑，但第一版不建议立即实现，因为：

- agent 的真实修改路径不一定能提前知道。
- 有些修改通过 shell command 完成，难以稳定识别影响文件。
- 软锁只能提示和阻止 orchestrator 调度，不能阻止 agent 已经执行的命令直接改文件。

### 11.3 Git Worktree 隔离

为每个 member 创建独立 git worktree，让 member 在自己的分支上工作，最后由 leader 或 orchestrator 合并结果。

这是更强的隔离方案，但复杂度明显更高：

- team member 的 `cwd` 需要指向各自 worktree，而不是完全相同的物理目录。
- 需要管理 worktree 创建、分支命名、清理、状态展示。
- 需要设计 merge/rebase/cherry-pick 流程。
- 合并冲突需要新的 UI 和人工处理流程。
- 某些项目不是 git repo，或当前工作区有未提交变更时，行为需要额外定义。

结论：

第一版采用“同目录 + 全局串行调度”。文档中明确不承诺自动解决外部文件冲突。后续如果 agent team 进入高并发代码修改场景，再设计可选的 worktree isolation mode 或 advisory file lock。

---

## 12. UI 展示设计

### 12.1 Team Chat 主时间线

用户发送请求后，页面生成一个 team run 块。所有 member 的工作都挂在这个 run 下。

示例：

```text
User
帮我实现 agent team message bus

Team Run #42
  leader          planning...
  backend-coder   running...
  reviewer        blocked: waiting for backend-coder
  leader          waiting for workers
```

完成后展示：

```text
Team Run #42

leader
Planning:
- backend-coder 实现数据库和 API
- reviewer 等 backend 完成后 review

backend-coder
Result:
- Added team_message table
- Added delivery queue
- Added scheduler tests

reviewer
Review:
- Found missing dependency cycle check

leader
Final:
已完成 message bus 基础设计，下一步建议实现 dependency DAG check。
```

### 12.2 Member 输出按 delivery 隔离

不要只按 member 聚合流式输出。必须按：

```text
run_id -> member_id -> delivery_id -> attempt_id
```

展示。

示例：

```text
backend-coder

▶ Delivery #12  running
  Task: 实现 message bus
  live stream...

⏸ Delivery #18  queued
  Task: 根据 reviewer 意见补 DAG cycle check

⏸ Delivery #23  blocked
  Task: review fix 后整理最终实现
  Waiting for: reviewer Delivery #19
```

这样即使 backend-coder 正在执行时 leader 又派来新任务，两个任务的 UI 状态也不会混在一起。

### 12.3 展开过程必须流式

某个 member 正在执行 delivery 时，展开面板应实时显示：

- assistant text delta
- thinking delta
- tool call start/end
- status note
- permission request
- error

默认视图展示 summary/result，展开视图展示完整过程。

### 12.4 Activity Stream

可提供右侧或底部 activity stream：

```text
10:01 leader          started planning
10:02 leader          assigned task to backend-coder
10:02 backend-coder   running
10:03 backend-coder   tool: Edit server/db.ts
10:05 backend-coder   done
10:05 reviewer        unblocked
10:06 reviewer        running
10:08 leader          finalizing
```

Activity stream 用于快速理解 team 当前状态，不替代每个 delivery 的详细流式输出。

---

## 13. SSE 事件草案

Team 事件可以复用现有 `/api/events` 的 multiplexed SSE，也可以新增 team-specific event type。关键是所有流式事件必须携带 `team_id`、`run_id`、`member_id`、`delivery_id`，支持前端准确归档。

```ts
type TeamEvent =
  | {
      type: 'team_run_started';
      team_id: string;
      run_id: string;
      user_message: TeamMessageRecord;
    }
  | {
      type: 'team_member_status';
      team_id: string;
      run_id: string;
      member_id: string;
      status: TeamMemberRecord['status'];
    }
  | {
      type: 'team_delivery_status';
      team_id: string;
      run_id: string;
      member_id: string;
      delivery_id: string;
      status: TeamMessageDeliveryRecord['status'];
    }
  | {
      type: 'team_delivery_text_delta';
      team_id: string;
      run_id: string;
      member_id: string;
      delivery_id: string;
      attempt_id: string | null;
      text: string;
    }
  | {
      type: 'team_delivery_thinking_delta';
      team_id: string;
      run_id: string;
      member_id: string;
      delivery_id: string;
      attempt_id: string | null;
      text: string;
    }
  | {
      type: 'team_delivery_tool_call_start';
      team_id: string;
      run_id: string;
      member_id: string;
      delivery_id: string;
      attempt_id: string | null;
      tool_call_id: string;
      name: string;
      input: unknown;
    }
  | {
      type: 'team_delivery_tool_call_end';
      team_id: string;
      run_id: string;
      member_id: string;
      delivery_id: string;
      attempt_id: string | null;
      tool_call_id: string;
    }
  | {
      type: 'team_message_created';
      team_id: string;
      run_id: string;
      message: TeamMessageRecord;
    }
  | {
      type: 'team_run_completed';
      team_id: string;
      run_id: string;
      final_message: TeamMessageRecord;
    }
  | {
      type: 'team_run_failed';
      team_id: string;
      run_id: string;
      error: string;
    };
```

---

## 14. REST API 草案

### Team 管理

```text
GET    /api/teams
POST   /api/teams
GET    /api/teams/:team_id
PATCH  /api/teams/:team_id
DELETE /api/teams/:team_id
```

### Member 管理

```text
POST   /api/teams/:team_id/members
PATCH  /api/teams/:team_id/members/:member_id
DELETE /api/teams/:team_id/members/:member_id
```

创建 member 时可以：

- 根据 team 的 `cwd`、agent、model 和 role 创建新 session。
- 不复用已有普通 session。

### Team Run

```text
GET  /api/teams/:team_id/runs
POST /api/teams/:team_id/runs
GET  /api/teams/:team_id/runs/:run_id
POST /api/teams/:team_id/runs/:run_id/cancel
```

### Message / Delivery

```text
GET /api/teams/:team_id/runs/:run_id/messages
GET /api/teams/:team_id/runs/:run_id/deliveries
GET /api/teams/:team_id/deliveries/:delivery_id
```

第一版可以不开放手动创建 message/delivery 的公共 API，由 orchestrator 内部创建。

---

## 15. 权限处理

成员执行时仍然复用现有 adapter 的 `onPermissionRequest`。

Team UI 中的权限弹窗必须展示：

- team name
- run id 或用户请求摘要
- member role
- agent 类型
- session 名称
- cwd
- tool name
- tool input

如果权限请求来自某个展开的 delivery，应高亮对应 member 和 delivery。

权限响应仍然按原 session permission broker 回传，team 层只负责补充上下文展示和状态标记。

---

## 16. 状态与错误处理

### Delivery 状态

```text
blocked -> pending -> running -> done
blocked -> cancelled
pending -> running -> failed
running -> failed
running -> cancelled
```

### Run 状态

```text
running -> completed
running -> waiting_user -> running
running -> failed
running -> cancelled
```

### 错误策略

- 单个 worker failed 不一定导致 run failed。
- leader final delivery 可以依赖 worker `finished`，这样即使 worker 失败，leader 也能总结失败原因。
- 如果 leader 自身 failed，run 可以进入 failed，除非后续支持备用 leader。
- 所有 failed delivery 应记录 error，并在 UI 中可展开查看。

---

## 17. 实施阶段建议

### Phase 1：Team 数据模型和管理 UI

- 新增 team/member/run/message/delivery 表。
- 支持创建 team。
- 支持添加 member，选择预设角色模板或自定义 role prompt。
- 创建 team 时为每个 member 创建新的 dashboard session。
- UI 展示 team list 和 member list。

### Phase 2：Leader-only Run

- 用户在 team chat 中发送请求。
- Orchestrator 只调用 leader。
- leader 输出最终回答。
- 页面展示 team run 块和 leader 流式输出。

### Phase 3：Message Bus 和 Delivery 调度

- leader 可以生成 assignment。
- Orchestrator 创建 worker delivery。
- 支持 per-member inbox、enqueue_seq、member lock。
- 支持 team-level 全局串行调度。
- `max_parallel_members` 固定为 `1`，暂不开放跨 member 并发。
- 支持 member outbound message 默认回到 leader。
- 支持 leader 根据 member 结果进行 re-plan。

### Phase 4：Dependency

- 新增 delivery dependency。
- 支持 blocked/pending 转换。
- 支持 `success` 和 `finished` 两种依赖。
- 增加 DAG cycle 检查。

### Phase 5：完整 Team UI

- run 下展示 member progress rows。
- member 下按 delivery 展示 queued/running/blocked/done。
- delivery 展开后显示流式过程。
- activity stream 展示 team 事件。

### Phase 6：Retry 和高级协作规则

- 新增 delivery attempt。
- 支持 failed delivery retry。
- 支持 worker 请求信息、worker-to-worker message、leader 审批广播。
- 支持可配置协作策略。

### Phase 7：并发与文件隔离

- 开放 `max_parallel_members > 1` 的跨 member 并发。
- 引入并发风险提示，例如多个 pending/running delivery 的 `expected_files` 重叠。
- 评估 advisory file lock，避免 orchestrator 同时调度明显冲突的写任务。
- 评估 git worktree isolation mode，让不同 member 在独立分支/worktree 中执行。
- 设计 worktree 合并、冲突展示、用户确认和清理流程。

---

## 18. 测试建议

- Store 测试：team/member/message/delivery/dependency 的 CRUD、迁移，以及 member/session/team 唯一性约束。
- Queue 测试：同一 member 的 `enqueue_seq` 在事务中单调递增。
- Scheduler 测试：V1 全局串行、同 member 串行、team 任意时刻最多一个 running delivery。
- Dependency 测试：`success`、`finished`、blocked -> pending、环依赖拒绝。
- Re-plan 测试：worker result/proposal/failed 后创建 leader follow-up delivery，leader 可继续 plan 或 final。
- SSE 测试：流式事件带完整 `team_id/run_id/member_id/delivery_id/attempt_id`。
- UI 测试：run 块展示、member 状态展示、delivery 隔离展示、展开流式输出。
- Permission 测试：team permission modal 能正确标识来源 member 和 delivery。
- Failure 测试：worker failed 后 leader final 仍可运行并总结错误。

---

## 19. 后续开放问题

- 什么时候从 V1 全局串行调度开放到 `max_parallel_members > 1`？
- 什么时候引入可选的 git worktree isolation mode？
- 如果引入 worktree mode，合并冲突由 UI 处理、leader 处理，还是交给用户手动处理？
- 是否需要在 leader assignment 中加入 `expected_files`，用于提前提示多个 delivery 的潜在文件范围重叠？
- 是否需要在工具调用层根据 `Edit`、`Write`、`Bash` 等事件推断实际 touched files，作为 activity 和风险提示？

---

## 20. 总结

Agent Team 的核心不是多个聊天窗口，而是一个由 message bus、delivery queue、dependency graph 和 orchestrator 组成的协作系统。

推荐的第一版原则：

- 每个 member 一个逻辑 inbox。
- 统一 delivery 表实现 inbox。
- 全局串行执行 delivery。
- `max_parallel_members` V1 固定为 `1`，后续再开放跨 member 并发。
- delivery 之间显式依赖。
- 所有流式输出按 `run_id -> member_id -> delivery_id -> attempt_id` 隔离展示。
- leader-driven orchestration 先落地，再逐步开放更自主的协作方式。

下个版本优先优化：

- 跨 member 并发执行。
- 并发任务的文件范围提示。
- advisory file lock。
- git worktree isolation mode。
- delivery retry 和 attempt 展示。
- worker-to-worker message 和 run 中途用户补充消息。
