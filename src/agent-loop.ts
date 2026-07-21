/**
 * Agent Loop — the core execution engine.
 *
 * Flow:
 *   1. Convert AgentMessage[] to LLM Message[]
 *   2. Stream assistant response from LLM
 *   3. Execute tool calls (sequential)
 *   4. Check for steering messages
 *   5. Repeat until stop condition
 */

import type {
  AgentContext,
  AgentEvent,
  AgentEventSink,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  AssistantMessage,
  Model,
  StreamOptions,
  ToolCall,
  ToolResultMessage,
} from "./types.js";
import { AssistantMessageEventStream } from "./event-stream.js";
import { streamModel } from "./provider.js";

// ─── Agent Loop Config ───────────────────────────────────────────────────────

export interface AgentLoopConfig {
  model: Model;
  reasoning?: string;
  signal?: AbortSignal;
  sessionId?: string;
  apiKey?: string;
  maxTokens?: number;
  maxRetryDelayMs?: number;
  beforeToolCall?: (context: {
    assistantMessage: AssistantMessage;
    toolCall: ToolCall;
    args: unknown;
    context: AgentContext;
  }, signal?: AbortSignal) => Promise<{ block?: boolean; reason?: string } | undefined>;
  afterToolCall?: (context: {
    assistantMessage: AssistantMessage;
    toolCall: ToolCall;
    args: unknown;
    result: AgentToolResult<any>;
    isError: boolean;
    context: AgentContext;
  }, signal?: AbortSignal) => Promise<{ content?: any; details?: any; isError?: boolean; terminate?: boolean } | undefined>;
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
  shouldStopAfterTurn?: (context: {
    message: AssistantMessage;
    toolResults: ToolResultMessage[];
    context: AgentContext;
    newMessages: AgentMessage[];
  }) => boolean | Promise<boolean>;
  prepareNextTurn?: (context: {
    message: AssistantMessage;
    toolResults: ToolResultMessage[];
    context: AgentContext;
    newMessages: AgentMessage[];
  }) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;
}

export interface AgentLoopTurnUpdate {
  context?: AgentContext;
  model?: any;
  thinkingLevel?: string;
}

// ─── Shared Empties ──────────────────────────────────────────────────────────

const EMPTY_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// ─── Default Message Converter ───────────────────────────────────────────────

import type { Message, TextContent as TC, ImageContent as IC, UserMessage, ToolResultMessage as TRM } from "./types.js";

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
  ) as Message[];
}

// ─── Error Tool Result ───────────────────────────────────────────────────────

function createErrorToolResult(message: string): AgentToolResult<any> {
  return { content: [{ type: "text", text: message }], details: {} };
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

/**
 * Start an agent loop with new prompt messages.
 */
export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  await runLoop(currentContext, newMessages, config, emit);
  return newMessages;
}

/**
 * Continue an agent loop from the current context (e.g., after tool results).
 */
export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [];
  const currentContext: AgentContext = { ...context };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  await runLoop(currentContext, newMessages, config, emit);
  return newMessages;
}

/**
 * Core loop: inner loop handles tool calls + steering, outer handles follow-up.
 */
async function runLoop(
  initialContext: AgentContext,
  newMessages: AgentMessage[],
  initialConfig: AgentLoopConfig,
  emit: AgentEventSink,
): Promise<void> {
  let currentContext = initialContext;
  let config = initialConfig;
  let firstTurn = true;
  let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

  while (true) {
    let hasMoreToolCalls = true;
    let hasExecutedToolCalls = false;

    // Inner loop: process tool calls and steering messages
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (!firstTurn) {
        await emit({ type: "turn_start" });
      } else {
        firstTurn = false;
      }

      // Inject pending messages before next LLM call
      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          await emit({ type: "message_start", message });
          await emit({ type: "message_end", message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
      }

      // Stream assistant response from LLM
      const message = await streamAssistantResponse(currentContext, config, emit);
      newMessages.push(message);

      // Handle errors / aborts
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // Extract tool calls
      const toolCalls = message.content.filter((c): c is ToolCall & { type: "toolCall" } => c.type === "toolCall");

      const toolResults: ToolResultMessage[] = [];
      hasMoreToolCalls = false;

      if (toolCalls.length > 0) {
        // Handle truncated output (length stop) — fail all tool calls
        if (message.stopReason === "length") {
          for (const tc of toolCalls) {
            await emit({
              type: "tool_execution_start",
              toolCallId: tc.id,
              toolName: tc.name,
              args: tc.arguments,
            });
            const result = createErrorToolResult(
              `Tool call "${tc.name}" was not executed: the response hit the output token limit.`,
            );
            await emit({
              type: "tool_execution_end",
              toolCallId: tc.id,
              toolName: tc.name,
              result,
              isError: true,
            });
            const trm: ToolResultMessage = {
              role: "toolResult",
              toolCallId: tc.id,
              toolName: tc.name,
              content: result.content,
              isError: true,
              timestamp: Date.now(),
            };
            await emit({ type: "message_start", message: trm });
            await emit({ type: "message_end", message: trm });
            toolResults.push(trm);
            newMessages.push(trm);
          }
          hasExecutedToolCalls = true;
        } else {
          // Execute tool calls sequentially
          const batch = await executeToolCallsSequential(currentContext, message, toolCalls, config, emit);
          toolResults.push(...batch.messages);
          hasMoreToolCalls = !batch.terminate;
          hasExecutedToolCalls = true;

          for (const result of toolResults) {
            currentContext.messages.push(result);
            newMessages.push(result);
          }
        }
      }

      // Emit turn end
      await emit({ type: "turn_end", message, toolResults });

      // Check prepareNextTurn
      const turnContext = { message, toolResults, context: currentContext, newMessages };
      const nextTurn = await config.prepareNextTurn?.(turnContext);
      if (nextTurn) {
        if (nextTurn.context) currentContext = nextTurn.context;
        if (nextTurn.model) {
          config = { ...config, model: nextTurn.model };
        }
      }

      // Check shouldStopAfterTurn
      if (await config.shouldStopAfterTurn?.(turnContext)) {
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // Check for steering messages
      pendingMessages = (await config.getSteeringMessages?.()) || [];
    }

    // Outer loop: check for follow-up messages
    const followUpMessages = (await config.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }

    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}

// ─── Stream Assistant Response ───────────────────────────────────────────────

async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
): Promise<AssistantMessage> {
  // Convert to LLM messages
  const convertFn = config.convertToLlm ?? defaultConvertToLlm;
  const llmMessages = await convertFn(context.messages);

  // Build context for provider
  const llmContext = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools,
  };

  // Stream from provider
  const streamOpts: StreamOptions = {
    signal: config.signal,
    apiKey: config.apiKey,
    reasoning: config.reasoning,
    maxTokens: config.maxTokens,
    sessionId: config.sessionId,
  };

  const response = streamModel(
    config.model,
    llmContext,
    streamOpts,
  );

  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;

  for await (const event of response) {
    switch (event.type) {
      case "start":
        partialMessage = event.partial;
        context.messages.push(partialMessage);
        addedPartial = true;
        await emit({ type: "message_start", message: { ...partialMessage } });
        break;

      case "text_start":
      case "text_delta":
      case "text_end":
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        if (partialMessage) {
          partialMessage = event.partial;
          context.messages[context.messages.length - 1] = partialMessage;
          await emit({
            type: "message_update",
            event: event,
            message: { ...partialMessage },
          });
        }
        break;

      case "done":
      case "error": {
        const finalMessage = event.type === "done" ? event.message : event.error;
        if (addedPartial) {
          context.messages[context.messages.length - 1] = finalMessage;
        } else {
          context.messages.push(finalMessage);
          await emit({ type: "message_start", message: { ...finalMessage } });
        }
        await emit({ type: "message_end", message: finalMessage });
        return finalMessage;
      }
    }
  }

  // Fallback: get result from stream
  const finalMessage = await response.result();
  if (addedPartial) {
    context.messages[context.messages.length - 1] = finalMessage;
  } else {
    context.messages.push(finalMessage);
    await emit({ type: "message_start", message: { ...finalMessage } });
  }
  await emit({ type: "message_end", message: finalMessage });
  return finalMessage;
}

// ─── Tool Execution ──────────────────────────────────────────────────────────

type FinalizedToolCall = {
  toolCall: ToolCall;
  result: AgentToolResult<any>;
  isError: boolean;
};

async function executeToolCallsSequential(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: ToolCall[],
  config: AgentLoopConfig,
  emit: AgentEventSink,
): Promise<{ messages: ToolResultMessage[]; terminate: boolean }> {
  const finalizedCalls: FinalizedToolCall[] = [];
  const messages: ToolResultMessage[] = [];

  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config);
    let finalized: FinalizedToolCall;

    if (preparation.kind === "immediate") {
      finalized = {
        toolCall,
        result: preparation.result,
        isError: preparation.isError,
      };
    } else {
      const executed = await executePreparedToolCall(preparation, config.signal, emit);
      finalized = await finalizeExecutedToolCall(currentContext, assistantMessage, preparation, executed, config);
    }

    await emit({
      type: "tool_execution_end",
      toolCallId: finalized.toolCall.id,
      toolName: finalized.toolCall.name,
      result: finalized.result,
      isError: finalized.isError,
    });

    const toolResultMessage: ToolResultMessage = {
      role: "toolResult",
      toolCallId: finalized.toolCall.id,
      toolName: finalized.toolCall.name,
      content: finalized.result.content,
      details: finalized.result.details,
      isError: finalized.isError,
      timestamp: Date.now(),
    };

    await emit({ type: "message_start", message: toolResultMessage });
    await emit({ type: "message_end", message: toolResultMessage });

    finalizedCalls.push(finalized);
    messages.push(toolResultMessage);

    if (config.signal?.aborted) break;
  }

  return {
    messages,
    terminate: finalizedCalls.length > 0 && finalizedCalls.every((f) => f.result.terminate === true),
  };
}

// ─── Tool Preparation ────────────────────────────────────────────────────────

type PreparedToolCall = {
  kind: "prepared";
  toolCall: ToolCall;
  tool: AgentTool<any>;
  args: unknown;
};

type ImmediateToolOutcome = {
  kind: "immediate";
  result: AgentToolResult<any>;
  isError: boolean;
};

async function prepareToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: ToolCall,
  config: AgentLoopConfig,
): Promise<PreparedToolCall | ImmediateToolOutcome> {
  const tool = currentContext.tools?.find((t) => t.name === toolCall.name);

  if (!tool) {
    return {
      kind: "immediate",
      result: createErrorToolResult(`Tool "${toolCall.name}" not found. Available tools: ${currentContext.tools?.map((t) => t.name).join(", ") ?? "none"}`),
      isError: true,
    };
  }

  // Validate arguments against schema
  const schema = tool.parameters;
  const args = toolCall.arguments;

  if (schema.required) {
    for (const key of schema.required) {
      if (args[key] === undefined) {
        return {
          kind: "immediate",
          result: createErrorToolResult(`Tool "${toolCall.name}" missing required parameter: "${key}"`),
          isError: true,
        };
      }
    }
  }

  // Run beforeToolCall hook
  if (config.beforeToolCall) {
    try {
      const beforeResult = await config.beforeToolCall(
        { assistantMessage, toolCall, args, context: currentContext },
        config.signal,
      );
      if (config.signal?.aborted) {
        return { kind: "immediate", result: createErrorToolResult("Operation aborted"), isError: true };
      }
      if (beforeResult?.block) {
        return {
          kind: "immediate",
          result: createErrorToolResult(beforeResult.reason ?? `Tool "${toolCall.name}" execution was blocked`),
          isError: true,
        };
      }
    } catch (err) {
      return {
        kind: "immediate",
        result: createErrorToolResult(`BeforeToolCall hook error: ${err instanceof Error ? err.message : String(err)}`),
        isError: true,
      };
    }
  }

  if (config.signal?.aborted) {
    return { kind: "immediate", result: createErrorToolResult("Operation aborted"), isError: true };
  }

  return {
    kind: "prepared",
    toolCall,
    tool,
    args,
  };
}

// ─── Tool Execution ──────────────────────────────────────────────────────────

async function executePreparedToolCall(
  prepared: PreparedToolCall,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<{ result: AgentToolResult<any>; isError: boolean }> {
  const updateEvents: Promise<void>[] = [];
  let acceptingUpdates = true;

  try {
    const result = await prepared.tool.execute(
      prepared.toolCall.id,
      prepared.args as Record<string, unknown>,
      signal,
      (partialResult) => {
        if (!acceptingUpdates) return;
        updateEvents.push(
          Promise.resolve(
            emit({
              type: "tool_execution_update",
              toolCallId: prepared.toolCall.id,
              toolName: prepared.toolCall.name,
              args: prepared.toolCall.arguments,
              partialResult,
            }),
          ),
        );
      },
    );
    acceptingUpdates = false;
    await Promise.all(updateEvents);
    return { result, isError: false };
  } catch (err) {
    acceptingUpdates = false;
    await Promise.all(updateEvents);
    return {
      result: createErrorToolResult(err instanceof Error ? err.message : String(err)),
      isError: true,
    };
  }
}

// ─── Tool Finalization ───────────────────────────────────────────────────────

async function finalizeExecutedToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  prepared: PreparedToolCall,
  executed: { result: AgentToolResult<any>; isError: boolean },
  config: AgentLoopConfig,
): Promise<FinalizedToolCall> {
  let result = executed.result;
  let isError = executed.isError;

  if (config.afterToolCall) {
    try {
      const afterResult = await config.afterToolCall(
        {
          assistantMessage,
          toolCall: prepared.toolCall,
          args: prepared.args,
          result,
          isError,
          context: currentContext,
        },
        config.signal,
      );
      if (afterResult) {
        result = {
          ...result,
          content: afterResult.content ?? result.content,
          details: afterResult.details ?? result.details,
          terminate: afterResult.terminate ?? result.terminate,
        };
        isError = afterResult.isError ?? isError;
      }
    } catch (err) {
      result = createErrorToolResult(err instanceof Error ? err.message : String(err));
      isError = true;
    }
  }

  return { toolCall: prepared.toolCall, result, isError };
}
