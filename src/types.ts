/**
 * Core types for Mini Pi Agent.
 */

// ─── Content Blocks ──────────────────────────────────────────────────────────

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;       // base64
  mimeType: string;   // e.g. "image/jpeg"
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ContentBlock = TextContent | ImageContent | ThinkingContent | ToolCall;

// ─── Usage & Cost ────────────────────────────────────────────────────────────

export interface Cost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: Cost;
}

// ─── Stop Reason ─────────────────────────────────────────────────────────────

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

// ─── Messages ────────────────────────────────────────────────────────────────

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ─── Tool Definition ─────────────────────────────────────────────────────────

export interface ToolParameterSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

// ─── Model ───────────────────────────────────────────────────────────────────

export interface ModelCostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Model<TApi extends string = string> {
  id: string;
  name: string;
  api: TApi;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: ModelCostRates;
  contextWindow: number;
  maxTokens: number;
}

// ─── Context ─────────────────────────────────────────────────────────────────

export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}

// ─── Stream Options ──────────────────────────────────────────────────────────

export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  reasoning?: string;
  sessionId?: string;
}

export type ThinkingLevel = "off" | "low" | "medium" | "high";

// ─── Stream Events ───────────────────────────────────────────────────────────

export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };

// ─── Agent-Specific Types ────────────────────────────────────────────────────

export interface AgentToolResult<T = unknown> {
  content: (TextContent | ImageContent)[];
  details: T;
  terminate?: boolean;
}

export interface AgentTool<TParams extends ToolParameterSchema = ToolParameterSchema, TDetails = unknown> extends Tool {
  /** Human-readable label for UI display */
  label: string;
  /** Execute the tool call */
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (partial: AgentToolResult<TDetails>) => void,
  ) => Promise<AgentToolResult<TDetails>>;
}

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: Message[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: Message }
  | { type: "message_update"; message: AssistantMessage; event: AssistantMessageEvent }
  | { type: "message_end"; message: Message }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean };

export type ToolExecutionMode = "sequential" | "parallel";
export type QueueMode = "all" | "one-at-a-time";

// ─── Agent Runtime Types (aliases & extras) ─────────────────────────────────

/** AgentMessage is the runtime message type (same as Message in mini-pi) */
export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

/** AgentContext is the runtime context (same as Context) */
export interface AgentContext {
  systemPrompt?: string;
  messages: AgentMessage[];
  tools?: AgentTool[];
}

/** Event sink function for agent lifecycle events */
export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;

/** Context passed to beforeToolCall hook */
export interface BeforeToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: ToolCall;
  args: unknown;
  context: AgentContext;
}

/** Result from beforeToolCall hook */
export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
}

/** Context passed to afterToolCall hook */
export interface AfterToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: ToolCall;
  args: unknown;
  result: AgentToolResult<any>;
  isError: boolean;
  context: AgentContext;
}

/** Result from afterToolCall hook */
export interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
  terminate?: boolean;
}
