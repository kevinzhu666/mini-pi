/**
 * Event stream with async iteration, inspired by pi-ai's EventStream.
 */

import type { AssistantMessage, AssistantMessageEvent } from "./types.js";

/**
 * Generic event stream that supports push-based events and async iteration.
 * Consumers can either `for await...of` or call `.result()` for the final value.
 */
export class EventStream<T, R = T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: Array<(value: IteratorResult<T>) => void> = [];
  private done = false;
  private finalPromise: Promise<R>;
  private resolveFinal!: (result: R) => void;
  private isComplete: (event: T) => boolean;
  private extractResult: (event: T) => R;

  constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
    this.isComplete = isComplete;
    this.extractResult = extractResult;
    this.finalPromise = new Promise((resolve) => {
      this.resolveFinal = resolve;
    });
  }

  push(event: T): void {
    if (this.done) return;

    if (this.isComplete(event)) {
      this.done = true;
      this.resolveFinal(this.extractResult(event));
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  end(result?: R): void {
    if (this.done) return;
    this.done = true;
    if (result !== undefined) {
      this.resolveFinal(result);
    }
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      waiter({ value: undefined as T, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.done) {
        return;
      } else {
        const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
        if (result.done) return;
        yield result.value;
      }
    }
  }

  result(): Promise<R> {
    return this.finalPromise;
  }
}

/**
 * Specialized event stream for LLM assistant responses.
 * Terminal events: "done" (success) or "error" (failure/abort).
 */
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Unexpected terminal event");
      },
    );
  }
}

/**
 * Create a lazy stream that performs async setup before forwarding events.
 * Setup failures produce an error-terminated stream.
 */
export function lazyStream(
  model: { api: string; provider: string; id: string },
  setup: () => Promise<AsyncIterable<AssistantMessageEvent>>,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();

  setup()
    .then((inner) => {
      (async () => {
        for await (const event of inner) {
          stream.push(event);
        }
        stream.end();
      })();
    })
    .catch((error) => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      };
      stream.push({ type: "error", reason: "error", error: msg });
      stream.end(msg);
    });

  return stream;
}
