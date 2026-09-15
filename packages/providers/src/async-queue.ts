// Single-implementation rule: the canonical `AsyncQueue` lives in
// `@tvic/media` (single-consumer claim, finite default bound, normative
// close/fail/return semantics). This module re-exports it so provider code
// shares one implementation and one overflow contract.
export { ASYNC_QUEUE_DEFAULT_MAX_BUFFERED, AsyncQueue, AsyncQueueConsumerError } from "@tvic/media";
