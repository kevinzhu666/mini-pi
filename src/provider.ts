/**
 * LLM Provider abstraction layer.
 * Supports OpenAI-compatible chat completions API and a faux test provider.
 */

import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
  StreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from "./types.js";
import { AssistantMessageEventStream } from "./event-stream.js";

// ─── Provider Interface ──────────────────────────────────────────────────────

export interface Provider {
  readonly id: string;
  readonly name: string;
  stream(model: Model, context: Context, options?: StreamOptions): AssistantMessageEventStream;
}

// ─── Cost Calculation ────────────────────────────────────────────────────────

const EMPTY_USAGE: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function calculateUsage(promptText: string, outputText: string, modelCost: Model["cost"]): Usage {
  const input = estimateTokens(promptText);
  const output = estimateTokens(outputText);
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: {
      input: (modelCost.input / 1_000_000) * input,
      output: (modelCost.output / 1_000_000) * output,
      cacheRead: 0,
      cacheWrite: 0,
      total: (modelCost.input / 1_000_000) * input + (modelCost.output / 1_000_000) * output,
    },
  };
}

function contentToText(content: string | Array<TextContent | { type: string; text?: string; data?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => {
      if (b.type === "text") return (b as TextContent).text;
      if (b.type === "image") return `[image: ${(b as { mimeType?: string }).mimeType ?? "unknown"}]`;
      return `[${b.type}]`;
    })
    .join("\n");
}

function serializeContext(context: Context): string {
  const parts: string[] = [];
  if (context.systemPrompt) parts.push(`system: ${context.systemPrompt}`);
  for (const msg of context.messages) {
    if (msg.role === "user") parts.push(`user: ${contentToText(msg.content)}`);
    else if (msg.role === "assistant") parts.push(`assistant: ${msg.content.map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "thinking") return b.thinking;
      if (b.type === "toolCall") return `${b.name}(${JSON.stringify(b.arguments)})`;
      return "";
    }).join("\n")}`);
    else if (msg.role === "toolResult") parts.push(`toolResult(${msg.toolName}): ${contentToText(msg.content)}`);
  }
  if (context.tools?.length) {
    parts.push(`tools: ${context.tools.map((t) => t.name).join(", ")}`);
  }
  return parts.join("\n\n");
}

// ─── OpenAI-Compatible Provider ──────────────────────────────────────────────

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAICompletionContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

interface OpenAICompletionContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: "auto" | "low" | "high" };
}

interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

type OpenAIChoice = NonNullable<OpenAIStreamChunk["choices"]>[number];

function messageToOpenAI(msg: Message): OpenAIMessage[] {
  if (msg.role === "user") {
    if (typeof msg.content === "string") {
      return [{ role: "user", content: msg.content }];
    }
    const parts: OpenAICompletionContentPart[] = msg.content.map((block) => {
      if (block.type === "image") {
        return { type: "image_url" as const, image_url: { url: `data:${block.mimeType};base64,${block.data}` } };
      }
      return { type: "text" as const, text: (block as TextContent).text };
    });
    return [{ role: "user", content: parts }];
  }

  if (msg.role === "assistant") {
    const textParts = msg.content.filter((b): b is TextContent => b.type === "text");
    const thinkingParts = msg.content.filter((b): b is ThinkingContent => b.type === "thinking");
    const toolCalls = msg.content.filter((b): b is ToolCall => b.type === "toolCall");

    let content = "";
    if (textParts.length > 0) {
      content = textParts.map((t) => t.text).join("\n");
    }
    // Append thinking as text for non-reasoning models
    if (thinkingParts.length > 0 && textParts.length === 0) {
      content = thinkingParts.map((t) => t.thinking).join("\n");
    }

    const result: OpenAIMessage = { role: "assistant", content };

    if (toolCalls.length > 0) {
      result.tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));
    }

    return [result];
  }

  if (msg.role === "toolResult") {
    return [{
      role: "tool",
      content: contentToText(msg.content),
      tool_call_id: msg.toolCallId,
      name: msg.toolName,
    }];
  }

  return [];
}

function openAIToolDef(tool: { name: string; description: string; parameters: Record<string, unknown> }): OpenAIToolDef {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  };
}

function parseToolCallArgs(args: string): Record<string, unknown> {
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch {
    return { _raw: args };
  }
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function messageFromOpenAI(
  content: string,
  toolCalls: OpenAIChoice["delta"]["tool_calls"] | undefined,
  finishReason: string | null | undefined,
  model: Model,
): AssistantMessage {
  const blocks: (TextContent | ToolCall)[] = [];

  if (content) {
    blocks.push({ type: "text", text: content });
  }

  // Accumulate tool calls across chunks
  if (toolCalls && toolCalls.length > 0) {
    // Group by index and merge
    const merged = new Map<number, { id?: string; name?: string; args: string }>();
    for (const tc of toolCalls) {
      if (tc.index === undefined) continue;
      const existing = merged.get(tc.index) ?? { args: "" };
      if (tc.id) existing.id = tc.id;
      if (tc.function?.name) existing.name = tc.function.name;
      if (tc.function?.arguments) existing.args += tc.function.arguments;
      merged.set(tc.index, existing);
    }

    for (const [, tc] of merged) {
      blocks.push({
        type: "toolCall",
        id: tc.id ?? generateId("tc"),
        name: tc.name ?? "unknown",
        arguments: parseToolCallArgs(tc.args),
      });
    }
  }

  const stopReasonMap: Record<string, "stop" | "length" | "toolUse" | "error"> = {
    stop: "stop",
    length: "length",
    tool_calls: "toolUse",
  };

  return {
    role: "assistant",
    content: blocks,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { ...EMPTY_USAGE },
    stopReason: finishReason ? (stopReasonMap[finishReason] ?? "stop") : "stop",
    timestamp: Date.now(),
  };
}

/**
 * OpenAI-compatible chat completions provider.
 * Works with OpenAI, Anthropic (via compat), DeepSeek, OpenRouter, etc.
 */
export function createOpenAIProvider(
  options: {
    id?: string;
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    models?: Model[];
  } = {},
): Provider {
  const id = options.id ?? "openai";
  const baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? "";

  const providerModels = options.models?.length
    ? options.models
    : [
        {
          id: "gpt-4o",
          name: "GPT-4o",
          api: "openai-completions",
          provider: id,
          baseUrl,
          reasoning: false,
          input: ["text", "image"] as ("text" | "image")[],
          cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
      ];

  return {
    id,
    name: options.name ?? "OpenAI",
    stream(model, context, options) {
      const stream = new AssistantMessageEventStream();

      (async () => {
        try {
          // Build messages
          const openaiMessages: OpenAIMessage[] = [];

          if (context.systemPrompt) {
            openaiMessages.push({ role: "system", content: context.systemPrompt });
          }

          for (const msg of context.messages) {
            openaiMessages.push(...messageToOpenAI(msg));
          }

          // Build request body
          const body: Record<string, unknown> = {
            model: model.id,
            messages: openaiMessages,
            stream: true,
            stream_options: { include_usage: true },
          };

          if (options?.maxTokens) body.max_tokens = options.maxTokens;
          if (options?.temperature !== undefined) body.temperature = options.temperature;
          if (options?.reasoning) body.reasoning_effort = options.reasoning;

          // Add tools if present
          if (context.tools && context.tools.length > 0) {
            body.tools = context.tools.map(openAIToolDef);
            body.parallel_tool_calls = true;
          }

          const resolvedApiKey = options?.apiKey ?? apiKey;

          // Create a combined signal with 60s timeout
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(new Error("Request timed out after 60s")), 60_000);
          const combinedSignal = options?.signal
            ? AbortSignal.any ? AbortSignal.any([options.signal, controller.signal]) : options.signal
            : controller.signal;

          const response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${resolvedApiKey}`,
            },
            body: JSON.stringify(body),
            signal: combinedSignal,
          });
          clearTimeout(timeoutId);

          if (!response.ok) {
            const errorText = await response.text().catch(() => "Unknown error");
            const errMsg = `OpenAI API error ${response.status}: ${errorText}`;
            const errorMsg: AssistantMessage = {
              role: "assistant",
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: { ...EMPTY_USAGE },
              stopReason: "error",
              errorMessage: errMsg,
              timestamp: Date.now(),
            };
            stream.push({ type: "error", reason: "error", error: errorMsg });
            stream.end(errorMsg);
            return;
          }

          const reader = response.body?.getReader();
          if (!reader) {
            const errorMsg: AssistantMessage = {
              role: "assistant", content: [], api: model.api, provider: model.provider,
              model: model.id, usage: { ...EMPTY_USAGE }, stopReason: "error",
              errorMessage: "No response body", timestamp: Date.now(),
            };
            stream.push({ type: "error", reason: "error", error: errorMsg });
            stream.end(errorMsg);
            return;
          }

          // Stream SSE events
          const decoder = new TextDecoder();
          let buffer = "";
          let accumulatedContent = "";
          let accumulatedToolCalls: NonNullable<OpenAIChoice["delta"]["tool_calls"]> = [];
          let partialMessage: AssistantMessage | null = null;
          let started = false;

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith("data: ")) continue;

                const data = trimmed.slice(6);
                if (data === "[DONE]") continue;

                try {
                  const chunk = JSON.parse(data) as OpenAIStreamChunk;
                  const choice = chunk.choices?.[0];
                  if (!choice) continue;

                  const delta = choice.delta;

                  // Start event
                  if (!started) {
                    const partial: AssistantMessage = {
                      role: "assistant", content: [], api: model.api, provider: model.provider,
                      model: model.id, usage: { ...EMPTY_USAGE }, stopReason: "stop", timestamp: Date.now(),
                    };
                    partialMessage = partial;
                    started = true;
                    stream.push({ type: "start", partial: { ...partial } });
                  }

                  // Accumulate content for text_start/text_delta/text_end
                  if (delta.content) {
                    if (accumulatedContent === "") {
                      stream.push({
                        type: "text_start",
                        contentIndex: (partialMessage?.content.length ?? 0),
                        partial: { ...partialMessage! },
                      });
                    }
                    accumulatedContent += delta.content;
                    stream.push({
                      type: "text_delta",
                      contentIndex: (partialMessage?.content.length ?? 0),
                      delta: delta.content,
                      partial: { ...partialMessage! },
                    });
                  }

                  // Accumulate reasoning content (thinking)
                  if ((delta as Record<string, unknown>).reasoning_content) {
                    const rc = (delta as Record<string, unknown>).reasoning_content as string;
                    // Find existing thinking block or create one
                    if (partialMessage) {
                      const thinkingIdx = partialMessage.content.findIndex((b) => b.type === "thinking");
                      if (thinkingIdx === -1) {
                        partialMessage.content.push({ type: "thinking", thinking: rc } as ThinkingContent);
                        stream.push({
                          type: "thinking_start",
                          contentIndex: partialMessage.content.length - 1,
                          partial: { ...partialMessage },
                        });
                      } else {
                        (partialMessage.content[thinkingIdx] as ThinkingContent).thinking += rc;
                        stream.push({
                          type: "thinking_delta",
                          contentIndex: thinkingIdx,
                          delta: rc,
                          partial: { ...partialMessage },
                        });
                      }
                    }
                  }

                  // Accumulate tool calls
                  if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                      if (tc.function?.name) {
                        // New tool call started
                        if (tc.id) {
                          accumulatedToolCalls.push(tc);
                          stream.push({
                            type: "toolcall_start",
                            contentIndex: partialMessage?.content.length ?? 0,
                            partial: { ...partialMessage! },
                          });
                        }
                      }
                      if (tc.function?.arguments) {
                        // Find matching tool call in accumulated
                        const existing = accumulatedToolCalls.find((atc) => atc.index === tc.index);
                        if (!existing) {
                          accumulatedToolCalls.push(tc);
                        } else {
                          existing.function = existing.function ?? { name: "", arguments: "" };
                          existing.function.arguments = (existing.function.arguments ?? "") + tc.function.arguments;
                        }
                        stream.push({
                          type: "toolcall_delta",
                          contentIndex: partialMessage?.content.length ?? 0,
                          delta: tc.function.arguments,
                          partial: { ...partialMessage! },
                        });
                      }
                    }
                  }

                  // On content_end or finish, flush accumulated text
                  if (choice.finish_reason || (!delta.content && !delta.tool_calls && accumulatedContent)) {
                    if (accumulatedContent && partialMessage) {
                      partialMessage.content.push({ type: "text", text: accumulatedContent } as TextContent);
                      stream.push({
                        type: "text_end",
                        contentIndex: partialMessage.content.length - 1,
                        content: accumulatedContent,
                        partial: { ...partialMessage },
                      });
                      accumulatedContent = "";
                    }
                  }

                  // On finish, add tool calls and finalize
                  if (choice.finish_reason) {
                    if (partialMessage) {
                      // Add accumulated tool calls as final tool calls
                      const finalToolCalls = new Map<number, ToolCall>();
                      for (const tc of accumulatedToolCalls) {
                        const args = tc.function?.arguments ? parseToolCallArgs(tc.function.arguments) : {};
                        finalToolCalls.set(tc.index ?? 0, {
                          type: "toolCall",
                          id: tc.id ?? generateId("tc"),
                          name: tc.function?.name ?? "unknown",
                          arguments: args,
                        });
                      }
                      for (const [, tc] of finalToolCalls) {
                        partialMessage.content.push(tc);
                        stream.push({
                          type: "toolcall_end",
                          contentIndex: partialMessage.content.length - 1,
                          toolCall: tc,
                          partial: { ...partialMessage },
                        });
                      }

                      const finishMap: Record<string, "stop" | "length" | "toolUse"> = {
                        stop: "stop", length: "length", tool_calls: "toolUse",
                      };
                      const final: AssistantMessage = {
                        ...partialMessage,
                        stopReason: finishMap[choice.finish_reason] ?? "stop",
                      };

                      // If usage is available in stream
                      if (chunk.usage) {
                        final.usage = {
                          input: chunk.usage.prompt_tokens ?? 0,
                          output: chunk.usage.completion_tokens ?? 0,
                          cacheRead: 0, cacheWrite: 0,
                          totalTokens: chunk.usage.total_tokens ?? 0,
                          cost: {
                            input: ((model.cost.input ?? 0) / 1_000_000) * (chunk.usage.prompt_tokens ?? 0),
                            output: ((model.cost.output ?? 0) / 1_000_000) * (chunk.usage.completion_tokens ?? 0),
                            cacheRead: 0, cacheWrite: 0,
                            total: ((model.cost.input ?? 0) / 1_000_000) * (chunk.usage.prompt_tokens ?? 0)
                                  + ((model.cost.output ?? 0) / 1_000_000) * (chunk.usage.completion_tokens ?? 0),
                          },
                        };
                      }

                      if (final.stopReason === "toolUse") {
                        stream.push({ type: "done", reason: "toolUse", message: final });
                      } else {
                        stream.push({ type: "done", reason: final.stopReason === "length" ? "length" : "stop", message: final });
                      }
                    }
                  }
                } catch {
                  // Skip unparseable chunks
                }
              }
            }
          } catch (err) {
            const aborted = options?.signal?.aborted;
            if (partialMessage) {
              const finalMsg: AssistantMessage = {
                ...partialMessage,
                stopReason: aborted ? "aborted" : "error",
                errorMessage: aborted ? "Request was aborted" : (err instanceof Error ? err.message : String(err)),
                timestamp: Date.now(),
              };
              stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: finalMsg });
              stream.end(finalMsg);
            }
            reader.releaseLock();
            return;
          }

          // If we got here without a finish_reason, create a stop message
          if (!started) {
            const finalMsg = messageFromOpenAI("", [], "stop", model);
            stream.push({ type: "start", partial: { ...finalMsg } });
            stream.push({ type: "done", reason: "stop", message: finalMsg });
          } else if (partialMessage && !partialMessage.stopReason) {
            // Add accumulated content as text
            if (accumulatedContent && partialMessage) {
              partialMessage.content.push({ type: "text", text: accumulatedContent } as TextContent);
            }
            const final: AssistantMessage = { ...partialMessage, stopReason: "stop" };
            stream.push({ type: "done", reason: "stop", message: final });
          }

          stream.end();
        } catch (err) {
          const aborted = options?.signal?.aborted;
          const errorMsg: AssistantMessage = {
            role: "assistant", content: [], api: model.api, provider: model.provider,
            model: model.id, usage: { ...EMPTY_USAGE },
            stopReason: aborted ? "aborted" : "error",
            errorMessage: err instanceof Error ? err.message : String(err),
            timestamp: Date.now(),
          };
          stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: errorMsg });
          stream.end(errorMsg);
        }
      })();

      return stream;
    },
  };
}

// ─── Faux Test Provider ──────────────────────────────────────────────────────

export type FauxResponse = AssistantMessage | ((ctx: Context, opts: StreamOptions | undefined, callCount: number) => AssistantMessage | Promise<AssistantMessage>);

export function fauxAssistantMessage(
  content: string | (TextContent | ToolCall)[],
  options?: { stopReason?: AssistantMessage["stopReason"]; errorMessage?: string },
): AssistantMessage {
  const blocks = Array.isArray(content) ? content : [{ type: "text" as const, text: content }] as (TextContent | ToolCall)[];
  return {
    role: "assistant",
    content: blocks as (TextContent | ToolCall)[],
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: { ...EMPTY_USAGE },
    stopReason: options?.stopReason ?? "stop",
    errorMessage: options?.errorMessage,
    timestamp: Date.now(),
  };
}

export function fauxToolCall(name: string, args: Record<string, unknown>, id?: string): ToolCall {
  return { type: "toolCall", id: id ?? generateId("tc"), name, arguments: args };
}

export function createFauxProvider(
  options: {
    id?: string;
    name?: string;
    models?: Model[];
    tokensPerSecond?: number;
  } = {},
): Provider & {
  setResponses: (responses: FauxResponse[]) => void;
  appendResponses: (responses: FauxResponse[]) => void;
  state: { callCount: number };
} {
  const id = options.id ?? "faux";
  let pendingResponses: FauxResponse[] = [];
  const state = { callCount: 0 };
  const tokensPerSecond = options.tokensPerSecond;

  const providerModels = options.models?.length
    ? options.models
    : [{
        id: "faux-1", name: "Faux Model", api: "faux", provider: id,
        baseUrl: "http://localhost:0", reasoning: false, input: ["text", "image"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000, maxTokens: 16384,
      }];

  function splitByTokens(text: string, min: number, max: number): string[] {
    const chunks: string[] = [];
    let idx = 0;
    while (idx < text.length) {
      const size = Math.max(1, (min + Math.floor(Math.random() * (max - min + 1))) * 4);
      chunks.push(text.slice(idx, idx + size));
      idx += size;
    }
    return chunks.length > 0 ? chunks : [""];
  }

  function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function streamMessage(
    stream: AssistantMessageEventStream,
    msg: AssistantMessage,
    signal?: AbortSignal,
  ): Promise<void> {
    const partial: AssistantMessage = { ...msg, content: [] };

    if (signal?.aborted) {
      const abortMsg = { ...partial, stopReason: "aborted" as const, errorMessage: "Aborted", timestamp: Date.now() };
      stream.push({ type: "error", reason: "aborted", error: abortMsg });
      stream.end(abortMsg);
      return;
    }

    stream.push({ type: "start", partial: { ...partial } });

    for (let idx = 0; idx < msg.content.length; idx++) {
      if (signal?.aborted) return;

      const block = msg.content[idx];

      if (block.type === "thinking") {
        partial.content = [...partial.content, { type: "thinking", thinking: "" }];
        stream.push({ type: "thinking_start", contentIndex: idx, partial: { ...partial } });
        for (const chunk of splitByTokens(block.thinking, 2, 4)) {
          if (tokensPerSecond) await delay((estimateTokens(chunk) / tokensPerSecond) * 1000);
          if (signal?.aborted) return;
          (partial.content[idx] as { thinking: string }).thinking += chunk;
          stream.push({ type: "thinking_delta", contentIndex: idx, delta: chunk, partial: { ...partial } });
        }
        stream.push({ type: "thinking_end", contentIndex: idx, content: block.thinking, partial: { ...partial } });
        continue;
      }

      if (block.type === "text") {
        partial.content = [...partial.content, { type: "text", text: "" }];
        stream.push({ type: "text_start", contentIndex: idx, partial: { ...partial } });
        for (const chunk of splitByTokens(block.text, 2, 4)) {
          if (tokensPerSecond) await delay((estimateTokens(chunk) / tokensPerSecond) * 1000);
          if (signal?.aborted) return;
          (partial.content[idx] as TextContent).text += chunk;
          stream.push({ type: "text_delta", contentIndex: idx, delta: chunk, partial: { ...partial } });
        }
        stream.push({ type: "text_end", contentIndex: idx, content: block.text, partial: { ...partial } });
        continue;
      }

      if (block.type === "toolCall") {
        partial.content = [...partial.content, block];
        stream.push({ type: "toolcall_start", contentIndex: idx, partial: { ...partial } });
        const argsStr = JSON.stringify(block.arguments);
        for (const chunk of splitByTokens(argsStr, 2, 4)) {
          if (tokensPerSecond) await delay((estimateTokens(chunk) / tokensPerSecond) * 1000);
          if (signal?.aborted) return;
          stream.push({ type: "toolcall_delta", contentIndex: idx, delta: chunk, partial: { ...partial } });
        }
        stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: { ...partial } });
      }
    }

    stream.push({ type: "done", reason: msg.stopReason === "toolUse" ? "toolUse" : "stop", message: msg });
    stream.end(msg);
  }

  return {
    id,
    name: options.name ?? "Faux Provider",
    stream(model, context, options) {
      const stream = new AssistantMessageEventStream();
      state.callCount++;

      queueMicrotask(async () => {
        const step = pendingResponses.shift();
        if (!step) {
          const err = fauxAssistantMessage("", { stopReason: "error", errorMessage: "No more faux responses" });
          stream.push({ type: "error", reason: "error", error: err });
          stream.end(err);
          return;
        }

        try {
          const resolved = typeof step === "function" ? await step(context, options, state.callCount) : step;
          const msg: AssistantMessage = {
            ...resolved,
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: calculateUsage(serializeContext(context), JSON.stringify(resolved.content), model.cost),
            timestamp: Date.now(),
          };
          await streamMessage(stream, msg, options?.signal);
        } catch (err) {
          const errMsg = fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: err instanceof Error ? err.message : String(err),
          });
          stream.push({ type: "error", reason: "error", error: errMsg });
          stream.end(errMsg);
        }
      });

      return stream;
    },
    setResponses(responses: FauxResponse[]) {
      pendingResponses = [...responses];
    },
    appendResponses(responses: FauxResponse[]) {
      pendingResponses.push(...responses);
    },
    state,
  };
}

// ─── Provider Registry ───────────────────────────────────────────────────────

const providerRegistry = new Map<string, Provider>();

export function registerProvider(provider: Provider): void {
  providerRegistry.set(provider.id, provider);
}

export function getProvider(id: string): Provider | undefined {
  return providerRegistry.get(id);
}

export function getProviders(): Provider[] {
  return Array.from(providerRegistry.values());
}

export function clearProviders(): void {
  providerRegistry.clear();
}

export function resolveProvider(
  model: Model,
  options?: { apiKey?: string },
): Provider | undefined {
  // Find provider by model.provider
  const provider = getProvider(model.provider);
  if (provider) return provider;

  // Fallback: try to match by known patterns
  if (model.api === "openai-completions" || model.baseUrl.includes("openai")) {
    return createOpenAIProvider({
      id: model.provider,
      apiKey: options?.apiKey,
      baseUrl: model.baseUrl,
      models: [model],
    });
  }

  return undefined;
}

/**
 * Unified streaming function: resolves provider and streams a response.
 */
export function streamModel(
  model: Model,
  context: Context,
  options?: StreamOptions,
): AssistantMessageEventStream {
  const provider = resolveProvider(model, options);

  if (!provider) {
    return new AssistantMessageEventStream(); // empty error stream
  }

  return provider.stream(model, context, options);
}
