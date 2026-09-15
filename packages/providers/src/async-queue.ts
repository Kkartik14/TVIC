// Single-implementation rule: the canonical `AsyncQueue` lives in
// `@tvic/media`. This module re-exports it so provider code shares one
// implementation and one overflow contract.
export {
  ASYNC_QUEUE_DEFAULT_MAX_BUFFERED,
  AsyncQueue,
  AsyncQueueConsumerError,
  type AsyncQueueOptions,
} from "@tvic/media";
