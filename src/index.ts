/**
 * Mini Pi Agent - Public API
 *
 * Export all public types and factories for programmatic use.
 */

// Types
export type {
  AgentMessage,
  AgentEvent,
  AgentTool,
  AgentToolResult,
  AssistantMessage,
  UserMessage,
  ToolResultMessage,
  Message,
  Model,
  ContentBlock,
  TextContent,
  ImageContent,
  ThinkingContent,
  ToolCall,
  ToolParameterSchema,
  Context,
  StreamOptions,
  StopReason,
  Usage,
  ThinkingLevel,
  SessionMeta,
  SessionFile,
  ToolExecutionMode,
  QueueMode,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
} from "./types.js";

// Agent
export { Agent } from "./agent.js";
export type { AgentOptions, AgentState } from "./agent.js";

// Agent Loop
export { runAgentLoop, runAgentLoopContinue } from "./agent-loop.js";
export type { AgentLoopConfig, AgentLoopTurnUpdate } from "./agent-loop.js";

// Event Stream
export { EventStream, AssistantMessageEventStream, lazyStream } from "./event-stream.js";

// Provider
export {
  createOpenAIProvider,
  createFauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  registerProvider,
  getProvider,
  getProviders,
  clearProviders,
  resolveProvider,
  streamModel,
} from "./provider.js";
export type { Provider, FauxResponse } from "./provider.js";

// Tools
export {
  createDefaultTools,
  createCodingTools,
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
  createGlobTool,
  createGrepTool,
  readToolSchema,
  writeToolSchema,
  editToolSchema,
  bashToolSchema,
  globToolSchema,
  grepToolSchema,
} from "./tools.js";

// Config
export {
  ConfigManager,
  BUILTIN_MODELS,
  findBuiltinModel,
  getModelsByProvider,
} from "./config.js";

// Session
export { SessionManager } from "./session.js";

// REPL
export { MiniPiREPL } from "./repl.js";
