/**
 * lib/__mocks__/llm.ts — a stand-in for Gemini.
 *
 * Left alone it plays a well-behaved model: it returns seeds/osaka-trip.json
 * reshaped as a draft, which is known to satisfy every hard rule. Give it a
 * `responses` queue and it plays whatever you need instead — malformed JSON, an
 * invented placeId, an over-budget plan, or a thrown error.
 *
 * The real client is the AI role's job.
 */

import { seedAsDraft } from '../seed';
import type { LLMClient } from '../generate';

/** One scripted reply: a value to return, a function to call, or an error to throw. */
export type MockLLMResponse = unknown | (() => unknown) | Error;

export interface MockLLMClientOptions {
  /** Consumed in order, one per call. When it runs out, the default reply is used. */
  responses?: readonly MockLLMResponse[];
  /** What to return once the queue is empty; defaults to the seed as a draft. */
  fallback?: unknown;
}

export class MockLLMClient implements LLMClient {
  /** Every prompt it was handed, in order — assert the retry used the stricter one. */
  readonly prompts: string[] = [];

  private readonly responses: readonly MockLLMResponse[];
  private readonly fallback: unknown;

  constructor(options: MockLLMClientOptions = {}) {
    this.responses = options.responses ?? [];
    this.fallback = 'fallback' in options ? options.fallback : undefined;
  }

  get callCount(): number {
    return this.prompts.length;
  }

  async generate(prompt: string): Promise<unknown> {
    const index = this.prompts.length;
    this.prompts.push(prompt);

    if (index < this.responses.length) {
      const scripted = this.responses[index];
      if (scripted instanceof Error) throw scripted;
      if (typeof scripted === 'function') return (scripted as () => unknown)();
      return scripted;
    }
    return this.fallback === undefined ? seedAsDraft() : this.fallback;
  }
}
