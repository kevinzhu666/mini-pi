/**
 * Agent — stateful wrapper around the agent loop.
 *
 * Responsibilities:
 *   - State management (systemPrompt, model, tools, messages)
 *   - Event system (subscribe/emit lifecycle events)
 *   - Message queues (steering/follow-up)
 *   - Prompt lifecycle (prompt → continue → done)
 */

import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  AssistantMessage,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
  ImageContent,
  Message,
  Model,
  TextContent,
  ThinkingLevel,
  ToolExecutionMode,
  QueueMode,
  AgentContext,
} from "./types.js";
import { runAgentLoop, runAgentLoopContinue, type AgentLoopTurnUpdate } from "./agent-loop.js";
import { streamModel } from "./provider.js";

const EMPTY_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const DEFAULT_MODEL: Model = {
  id: "unknown", name: "unknown", api: "unknown", provider: "unknown",
  baseUrl: "", reasoning: false, input: ["text"], contextWindow: 0, maxTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
  ) as Message[];
}

// ─── Pending Message Queue ───────────────────────────────────────────────────

class PendingMessageQueue {
  private messages: AgentMessage[] = [];
  public mode: QueueMode;

  constructor(mode: QueueMode) {
    this.mode = mode;
  }

  enqueue(message: AgentMessage): void {
    this.messages.push(message);
  }

  hasItems(): boolean {
    return this.messages.length > 0;
  }

  drain(): AgentMessage[] {
    if (this.mode === "all") {
      const drained = this.messages.slice();
      this.messages = [];
      return drained;
    }
    const first = this.messages[0];
    if (!first) return [];
    this.messages = this.messages.slice(1);
    return [first];
  }

  clear(): void {
    this.messages = [];
  }
}

// ─── Active Run Tracking ────────────────────────────────────────────────────

type ActiveRun = {
  promise: Promise<void>;
  resolve: () => void;
  abortController: AbortController;
};

// ─── Agent Options ──────────────────────────────────────────────────────────

export interface AgentOptions {
  systemPrompt?: string;
  model?: Model;
  thinkingLevel?: ThinkingLevel;
  tools?: AgentTool[];
  messages?: AgentMessage[];

  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  streamFn?: typeof streamModel;

  beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;

  steeringMode?: QueueMode;
  followUpMode?: QueueMode;

  sessionId?: string;
  apiKey?: string;
  maxTokens?: number;
  maxRetryDelayMs?: number;
  toolExecution?: ToolExecutionMode;
}

// ─── Agent State ─────────────────────────────────────────────────────────────

export interface AgentState {
  systemPrompt: string;
  model: Model;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool[];
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}

// ─── Agent Class ─────────────────────────────────────────────────────────────

export class Agent {
  private _systemPrompt: string;
  private _model: Model;
  private _thinkingLevel: ThinkingLevel;
  private _tools: AgentTool[];
  private _messages: AgentMessage[];
  private _isStreaming = false;
  private _streamingMessage?: AgentMessage;
  private _pendingToolCalls = new Set<string>();
  private _errorMessage?: string;
  private _activeRun?: ActiveRun;

  private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => void | Promise<void>>();
  private readonly steeringQueue: PendingMessageQueue;
  private readonly followUpQueue: PendingMessageQueue;

  public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  public streamFn: typeof streamModel;

  public beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  public afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;

  public sessionId?: string;
  public apiKey?: string;
  public maxTokens?: number;
  public maxRetryDelayMs?: number;
  public toolExecution: ToolExecutionMode;

  constructor(options: AgentOptions = {}) {
    this._systemPrompt = options.systemPrompt ?? "";
    this._model = options.model ?? DEFAULT_MODEL;
    this._thinkingLevel = options.thinkingLevel ?? "off";
    this._tools = options.tools?.slice() ?? [];
    this._messages = options.messages?.slice() ?? [];
    this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
    this.streamFn = options.streamFn ?? streamModel;
    this.beforeToolCall = options.beforeToolCall;
    this.afterToolCall = options.afterToolCall;
    this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
    this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
    this.sessionId = options.sessionId;
    this.apiKey = options.apiKey;
    this.maxTokens = options.maxTokens;
    this.maxRetryDelayMs = options.maxRetryDelayMs;
    this.toolExecution = options.toolExecution ?? "sequential";
  }

  // ─── State Accessors ───────────────────────────────────────────────────

  get state(): AgentState {
    return {
      systemPrompt: this._systemPrompt,
      model: this._model,
      thinkingLevel: this._thinkingLevel,
      tools: this._tools.slice(),
      messages: this._messages.slice(),
      isStreaming: this._isStreaming,
      streamingMessage: this._streamingMessage,
      pendingToolCalls: new Set(this._pendingToolCalls),
      errorMessage: this._errorMessage,
    };
  }

  get systemPrompt(): string { return this._systemPrompt; }
  set systemPrompt(p: string) { this._systemPrompt = p; }

  get model(): Model { return this._model; }
  set model(m: Model) { this._model = m; }

  get thinkingLevel(): ThinkingLevel { return this._thinkingLevel; }
  set thinkingLevel(t: ThinkingLevel) { this._thinkingLevel = t; }

  get tools(): AgentTool[] { return this._tools; }
  set tools(t: AgentTool[]) { this._tools = t.slice(); }

  get messages(): AgentMessage[] { return this._messages; }
  set messages(m: AgentMessage[]) { this._messages = m.slice(); }

  get isStreaming(): boolean { return this._isStreaming; }
  get streamingMessage(): AgentMessage | undefined { return this._streamingMessage; }
  get pendingToolCalls(): ReadonlySet<string> { return new Set(this._pendingToolCalls); }
  get errorMessage(): string | undefined { return this._errorMessage; }
  get signal(): AbortSignal | undefined { return this._activeRun?.abortController.signal; }

  set steeringMode(mode: QueueMode) { this.steeringQueue.mode = mode; }
  get steeringMode(): QueueMode { return this.steeringQueue.mode; }
  set followUpMode(mode: QueueMode) { this.followUpQueue.mode = mode; }
  get followUpMode(): QueueMode { return this.followUpQueue.mode; }

  // ─── Event System ─────────────────────────────────────────────────────

  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async emit(event: AgentEvent): Promise<void> {
    const signal = this._activeRun?.abortController.signal;
    if (!signal && event.type !== "agent_end") {
      // Allow agent_end without active run
    }
    const sig = signal ?? new AbortController().signal;

    for (const listener of this.listeners) {
      await listener(event, sig);
    }
  }

  // ─── Message Queues ────────────────────────────────────────────────────

  steer(message: AgentMessage): void {
    this.steeringQueue.enqueue(message);
  }

  followUp(message: AgentMessage): void {
    this.followUpQueue.enqueue(message);
  }

  clearSteeringQueue(): void { this.steeringQueue.clear(); }
  clearFollowUpQueue(): void { this.followUpQueue.clear(); }
  clearAllQueues(): void { this.clearSteeringQueue(); this.clearFollowUpQueue(); }

  hasQueuedMessages(): boolean {
    return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  abort(): void {
    this._activeRun?.abortController.abort();
  }

  async waitForIdle(): Promise<void> {
    await this._activeRun?.promise;
  }

  reset(): void {
    this._messages = [];
    this._isStreaming = false;
    this._streamingMessage = undefined;
    this._pendingToolCalls = new Set();
    this._errorMessage = undefined;
    this.clearAllQueues();
  }

  // ─── Prompt ───────────────────────────────────────────────────────────

  async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
    if (this._activeRun) {
      throw new Error("Agent is already processing. Use steer()/followUp() to queue messages.");
    }

    const messages = this.normalizeInput(input, images);
    await this.runWithLifecycle(async (signal) => {
      await runAgentLoop(
        messages,
        this.createContext(),
        this.createLoopConfig(signal),
        (event) => this.processEvent(event),
      );
    });
  }

  async continue(): Promise<void> {
    if (this._activeRun) {
      throw new Error("Agent is already processing.");
    }

    const lastMessage = this._messages[this._messages.length - 1];
    if (!lastMessage) throw new Error("No messages to continue from");

    if (lastMessage.role === "assistant") {
      // Check queues first
      const queuedSteering = this.steeringQueue.drain();
      if (queuedSteering.length > 0) {
        await this.runWithLifecycle(async (signal) => {
          await runAgentLoop(
            queuedSteering,
            this.createContext(),
            this.createLoopConfig(signal, { skipInitialSteeringPoll: true }),
            (event) => this.processEvent(event),
          );
        });
        return;
      }

      const queuedFollowUps = this.followUpQueue.drain();
      if (queuedFollowUps.length > 0) {
        await this.runWithLifecycle(async (signal) => {
          await runAgentLoop(
            queuedFollowUps,
            this.createContext(),
            this.createLoopConfig(signal),
            (event) => this.processEvent(event),
          );
        });
        return;
      }

      throw new Error("Cannot continue from assistant message without queued messages");
    }

    await this.runWithLifecycle(async (signal) => {
      await runAgentLoopContinue(
        this.createContext(),
        this.createLoopConfig(signal),
        (event) => this.processEvent(event),
      );
    });
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private normalizeInput(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): AgentMessage[] {
    if (Array.isArray(input)) return input;
    if (typeof input !== "string") return [input];

    const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
    if (images && images.length > 0) content.push(...images);
    return [{ role: "user", content, timestamp: Date.now() }];
  }

  private createContext(): AgentContext {
    return {
      systemPrompt: this._systemPrompt,
      messages: this._messages.slice(),
      tools: this._tools.slice(),
    };
  }

  private createLoopConfig(
    signal?: AbortSignal,
    options?: { skipInitialSteeringPoll?: boolean },
  ) {
    let skipSteering = options?.skipInitialSteeringPoll === true;

    return {
      model: this._model,
      reasoning: this._thinkingLevel === "off" ? undefined : this._thinkingLevel,
      signal,
      sessionId: this.sessionId,
      apiKey: this.apiKey,
      maxTokens: this.maxTokens,
      maxRetryDelayMs: this.maxRetryDelayMs,
      beforeToolCall: this.beforeToolCall,
      afterToolCall: this.afterToolCall,
      convertToLlm: this.convertToLlm,
      getSteeringMessages: async () => {
        if (skipSteering) {
          skipSteering = false;
          return [];
        }
        return this.steeringQueue.drain();
      },
      getFollowUpMessages: async () => this.followUpQueue.drain(),
      shouldStopAfterTurn: undefined,
      prepareNextTurn: undefined,
    };
  }

  private async runWithLifecycle(
    executor: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (this._activeRun) {
      throw new Error("Agent is already processing.");
    }

    const abortController = new AbortController();
    let resolvePromise = () => {};
    const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
    this._activeRun = { promise, resolve: resolvePromise, abortController };

    this._isStreaming = true;
    this._streamingMessage = undefined;
    this._errorMessage = undefined;

    try {
      await executor(abortController.signal);
    } catch (error) {
      await this.handleRunFailure(error, abortController.signal.aborted);
    } finally {
      this.finishRun();
    }
  }

  private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
    const failureMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: this._model.api,
      provider: this._model.provider,
      model: this._model.id,
      usage: EMPTY_USAGE,
      stopReason: aborted ? "aborted" : "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    };

    await this.emit({ type: "message_start", message: failureMessage });
    await this.emit({ type: "message_end", message: failureMessage });
    await this.emit({ type: "turn_end", message: failureMessage, toolResults: [] });
    await this.emit({ type: "agent_end", messages: [failureMessage] });
  }

  private finishRun(): void {
    this._isStreaming = false;
    this._streamingMessage = undefined;
    this._pendingToolCalls = new Set();
    this._activeRun?.resolve();
    this._activeRun = undefined;
  }

  private async processEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") {
          this._streamingMessage = event.message;
        }
        break;

      case "message_update":
        this._streamingMessage = event.message;
        break;

      case "message_end":
        this._streamingMessage = undefined;
        this._messages.push(event.message);
        break;

      case "tool_execution_start":
        this._pendingToolCalls.add(event.toolCallId);
        break;

      case "tool_execution_end":
        this._pendingToolCalls.delete(event.toolCallId);
        break;

      case "turn_end":
        if (event.message.role === "assistant" && event.message.errorMessage) {
          this._errorMessage = event.message.errorMessage;
        }
        break;

      case "agent_end":
        this._streamingMessage = undefined;
        break;
    }

    await this.emit(event);
  }
}
