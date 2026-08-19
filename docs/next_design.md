## claude code
### /command命令问题

**What to build:** Slash commands typed into the composer run their real effect instead of being sent to the model as literal text. `/model <name>` switches the session's model for subsequent turns. Commands the headless SDK can't honour answer with a clear session-local message rather than being silently passed through.

**Blocked by:** #9 — Claude Code adapter

**Status:** ready-for-agent

- [ ] A message starting with `/` is intercepted at the adapter before it reaches the model as text.
- [ ] `/model <name>` switches the session's model (via `Options.model`) and sticks for later turns; bare `/model` lists the available models.
- [ ] Slash commands with no headless equivalent answer with a clear message instead of being sent to the model as text.
- [ ] Each supported and unsupported command is documented so the behaviour is discover

### 终端交互 !xxx无法直接执行命令

### markdown展示存在问题

### UI界面的滑动较丑

### 历史会话加载


创建session的UI问题，找不到确认按钮了