# Session Persistence（会话持久化）设计文档 — Layer 3

> 日期：2026-08-10
> 项目：Mini Pi Agent（mini-pi）
> 状态：已批准

## 1. 背景与目标

Mini Pi Agent 已具备记忆系统（Layer 1 显式记忆 + Layer 2 自动注入）。Layer 3 的目标是**会话持久化**：把对话历史自动保存到磁盘，让用户能随时恢复之前的工作上下文，跨启动继续对话。

对应 README Roadmap：

- [x] Layer 1 / Layer 2 记忆系统
- [ ] **Layer 3：会话持久化**（本次实现）
- [ ] Layer 4：自动事实提取（后续）

## 2. 关键决策

| 决策点 | 选择 |
|--------|------|
| 保存内容范围 | **完整保存**（user + assistant + toolResult，含工具结果） |
| 保存时机 | **每轮结束（agent_end）+ 退出时** |
| 启动策略 | **默认全新会话**，用 `/resume <id>` 或 `-s/--session <id>` 手动恢复 |
| 会话命名 | **时间戳自动 ID**（`YYYYMMDD-HHMMSS`）+ 可选别名 |
| 实现架构 | **方案 A：独立 `SessionManager` 模块**（镜像 `MemoryManager` 模式） |
| `/clear` 与 `/reset` | **合并为 `/clear`**，`/reset` 彻底删除 |
| `--sessions` CLI 参数 | **不加**，只在 REPL 内用 `/sessions` |

## 3. 文件格式与存储布局

**存储目录**：`~/.mini-pi/sessions/`（与 `memory/` 同级，REPL 启动时自动创建）

**每个会话一个 JSON 文件**：`<时间戳ID>.json`，如 `20260810-152030.json`

```jsonc
{
  "version": 1,
  "id": "20260810-152030",
  "alias": "优化登录流程",
  "cwd": "c:/Users/zlk/Desktop/piworkspace",
  "provider": "deepseek",
  "model": "deepseek-chat",
  "thinkingLevel": "off",
  "createdAt": 1721558400000,
  "updatedAt": 1721558700000,
  "messageCount": 12,
  "messages": []
}
```

**TypeScript 类型**（新增到 `src/types.ts`）：

```ts
export interface SessionMeta {
  version: number;
  id: string;
  alias?: string;
  cwd: string;
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface SessionFile extends SessionMeta {
  messages: AgentMessage[];   // 与 Agent 内部类型完全对齐，保存/恢复对称往返
}
```

**要点**：
- `messages` 直接复用 `AgentMessage[]`（`UserMessage | AssistantMessage | ToolResultMessage`），纯 JSON 可序列化，`JSON.stringify`/`JSON.parse` 无损往返，不需要转换层。
- **不保存 systemPrompt**：它是派生状态（`config.systemPrompt` + 工具描述 + 记忆），每次 `sendPrompt` 前由 `buildSystemPromptWithMemories()` 重新生成；恢复时走当前配置即可。
- 恢复时用 `messages` 还原上下文，用 `model`/`provider`/`thinkingLevel` 还原模型设置；`cwd` 仅作元数据展示。

## 4. SessionManager API（`src/session.ts`）

复用 MemoryManager 的模式：构造可注入目录（便于测试），`node:fs` 同步操作，静默容错。

```ts
export class SessionManager {
  constructor(dir?: string);          // 默认 ~/.mini-pi/sessions/

  /** 生成时间戳 ID：YYYYMMDD-HHMMSS；同秒冲突则追加 -1、-2 … */
  generateId(): string;

  /** 保存会话（覆盖写 <id>.json，mkdir 递归保证目录存在） */
  save(session: SessionFile): void;

  /** 按 id 加载完整会话（含 messages）；找不到或损坏返回 null */
  load(id: string): SessionFile | null;

  /** 列出所有会话元数据（不含 messages），按 updatedAt 倒序；损坏跳过 */
  list(): SessionMeta[];

  /** 删除会话文件；成功返回 true */
  delete(id: string): boolean;
}
```

**职责划分**：
- `SessionManager` 只管文件 I/O（目录、ID、增删改查），不碰 Agent / Config / REPL。
- 组装 `SessionFile`（把 `agent.messages` 填进去）由 REPL 负责。

**关键实现细节**：
1. `list()` 解析每个完整 JSON 但只返回 `SessionMeta`（丢弃 `messages`）。
2. `generateId()` 检测文件已存在即追加 `-1`、`-2` 兜底。
3. 容错与 MemoryManager 一致：目录自动建；损坏 → `load` 返回 null、`list` 跳过；`save` 不抛异常，但 REPL 层会打 dim 提示（会话数据比记忆更易丢，需要一层可见性）。

## 5. REPL 命令面

### 新增命令

| 命令 | 作用 |
|------|------|
| `/sessions` | 列出所有会话：`[▶] <id> <别名/自动标题> · <模型> · <N> msgs · <更新时间>`，最近在前，当前会话标 ▶ |
| `/resume <id>` | 载入会话：还原 messages + model/provider/thinkingLevel，之后自动保存继续写回该文件 |
| `/session name <名字>` | 给当前会话设别名 |
| `/session delete <id>` | 删除指定会话文件（拒绝删除当前会话） |

**自动标题**：无别名时，`/sessions` 用第一条用户消息截断 24 字符作标题。

### 变更：`/clear` 与 `/reset`

- `/clear` 合并为**完整重置**：`agent.reset()` + `console.clear()` + **轮换到新会话**（生成新 ID，旧会话文件保留），提示 `Started new session <新id> (previous: <旧id>)`。
- `/reset` **彻底删除**（代码、`/help`、README 同步移除）。
- **空会话不立即写盘**：新会话等第一轮 `agent_end` 才落文件，避免磁盘堆满空文件。

### CLI 新参数

```
-s, --session <id>   启动时恢复该会话
```

- 无 `-s` → 全新会话，banner 显示 `Session: <id> (new)`
- 有 `-s <id>` → 载入，banner 显示 `Session: <id> resumed · N messages`

## 6. REPL 集成与生命周期

**构造签名**：`new MiniPiREPL(cwd, config, { autoRun?, sessionId? })`（从裸 `autoRun` 改为 options 对象，cli.ts 三处调用点同步改）。

**REPL 新增状态**：`currentSessionId`、`currentAlias`、`sessionCreatedAt`。

**自动保存**（两个触发点）：
1. `handleAgentEvent` 监听 `agent_end` → `saveCurrentSession()`，从 `agent.messages` 现取现存，不维护重复引用。
2. `/quit` / `/exit` 分支先保存再关。

**`saveCurrentSession()`**：用 `agent.messages` + config + REPL 状态组装 `SessionFile` 后调用 `sessionManager.save()`。

**`/resume` 实现**：`load()` → `agent.messages = sf.messages`、`agent.thinkingLevel = sf.thinkingLevel`、`agent.model = findBuiltinModel(sf.provider, sf.model) ?? 回退当前 config`；更新 `currentSessionId/currentAlias/sessionCreatedAt`。

**隔离决策**：不把本地会话 ID 塞进 `agent.sessionId`——该字段会透传到 provider 请求的 `sessionId`（API 层概念），与文件会话不同。

## 7. 边界情况与容错

| 场景 | 处理 |
|------|------|
| 会话文件损坏 / 解析失败 | `load` → null；`list` → 跳过并附 `(N corrupted file(s) skipped)` |
| `version` 非 1 | 视为损坏跳过，为格式迁移留口子 |
| `/resume` 模型不在内置表 | 回退当前 config 模型，提示 `Model X not found, using current` |
| 同秒撞 ID | `generateId()` 追加 `-1`、`-2` |
| 退出前未对话 | 新会话从未写盘，无空文件 |
| 删除当前会话 | 拒绝并提示 |
| `toolResult.details` 不可序列化 | `save` 包 try/catch，失败跳过本轮保存并提示（v1 已知限制） |
| 会话文件很大 | 接受不截断；`/sessions` 全量解析耗时随文件增大（已知权衡） |
| 会话很多 | v1 不做分页 |

## 8. 测试

项目目前无测试框架。v1 以手动冒烟验证为主（`faux provider`），不引入框架：

- `SessionManager` 指向临时目录：generateId / save / load / list / delete 往返
- 完整保存含工具结果 → `/resume` 后上下文一致
- `/clear` 轮换新会话且旧文件保留
- 损坏文件跳过、模型回退等边界

## 9. 不做的（YAGNI）

- 不做 `--sessions` CLI 参数
- 不做 `/session save`、`/session load`（自动保存已覆盖）
- 不做 index.json 索引 / 分页 / 会话搜索
- 不截断工具结果
- 不引入测试框架
