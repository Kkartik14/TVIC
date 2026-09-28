import type { SessionId } from "@tvic/core";
import type { PipelineVoiceLoopResult, VoiceEvent } from "@tvic/runtime";

export interface ManagedRunClaim {
  readonly completion: Promise<PipelineVoiceLoopResult>;
  readonly iterator?: AsyncIterator<VoiceEvent>;
}

class ManagedVoiceEventIterator implements AsyncIterator<VoiceEvent>, AsyncIterable<VoiceEvent> {
  #done = false;
  readonly #raw: AsyncIterator<VoiceEvent>;
  readonly #completion: Promise<PipelineVoiceLoopResult>;
  readonly #cancel: () => void;

  constructor(
    raw: AsyncIterator<VoiceEvent>,
    completion: Promise<PipelineVoiceLoopResult>,
    cancel: () => void,
  ) {
    this.#raw = raw;
    this.#completion = completion;
    this.#cancel = cancel;
  }

  async next(...args: [] | [undefined]): Promise<IteratorResult<VoiceEvent>> {
    if (this.#done) return { done: true, value: undefined };
    const step = await this.#raw.next(...args);
    if (!step.done) return step;
    this.#done = true;
    await this.#completion;
    return { done: true, value: undefined };
  }

  async return(value?: unknown): Promise<IteratorResult<VoiceEvent>> {
    if (this.#done) return { done: true, value };
    this.#done = true;
    this.#cancel();
    try {
      await this.#raw.return?.(value);
    } finally {
      await this.#completion.catch(() => undefined);
    }
    return { done: true, value };
  }

  async throw(error?: unknown): Promise<IteratorResult<VoiceEvent>> {
    if (this.#done) throw error;
    this.#done = true;
    this.#cancel();
    try {
      await this.#raw.throw?.(error);
    } finally {
      await this.#completion.catch(() => undefined);
    }
    throw error;
  }

  [Symbol.asyncIterator](): AsyncIterator<VoiceEvent> {
    return this;
  }
}

class RejectedVoiceEventIterator implements AsyncIterator<VoiceEvent>, AsyncIterable<VoiceEvent> {
  readonly #error: unknown;

  constructor(error: unknown) {
    this.#error = error;
  }

  next(): Promise<IteratorResult<VoiceEvent>> {
    return Promise.reject(this.#error);
  }

  return(): Promise<IteratorResult<VoiceEvent>> {
    return Promise.reject(this.#error);
  }

  [Symbol.asyncIterator](): AsyncIterator<VoiceEvent> {
    return this;
  }
}

export interface ManagedRunController {
  claim(kind: "internal" | "public"): ManagedRunClaim;
  cancel(): void;
}

export class ManagedVoiceAgentRun {
  readonly #sessionId: SessionId;
  readonly #controller: ManagedRunController;

  constructor(sessionId: SessionId, controller: ManagedRunController) {
    this.#sessionId = sessionId;
    this.#controller = controller;
  }

  get sessionId(): SessionId {
    return this.#sessionId;
  }

  then<TResult1 = PipelineVoiceLoopResult, TResult2 = never>(
    onfulfilled?:
      | ((value: PipelineVoiceLoopResult) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): PromiseLike<TResult1 | TResult2> {
    try {
      return this.#controller.claim("internal").completion.then(onfulfilled, onrejected);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null | undefined,
  ): PromiseLike<PipelineVoiceLoopResult | TResult> {
    try {
      return this.#controller.claim("internal").completion.catch(onrejected);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  finally(onfinally?: (() => void) | null | undefined): PromiseLike<PipelineVoiceLoopResult> {
    try {
      return this.#controller.claim("internal").completion.finally(onfinally);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<VoiceEvent> {
    const claim = this.#controller.claim("public");
    if (!claim.iterator) return new RejectedVoiceEventIterator(claim.completion);
    return new ManagedVoiceEventIterator(claim.iterator, claim.completion, () =>
      this.#controller.cancel(),
    );
  }
}
