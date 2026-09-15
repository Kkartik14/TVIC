// Compatibility re-export: single source of truth lives in
// `../async-control.js`. Kept so older deep imports keep
// working; new code imports from `../async-control.js` directly.
export {
  abortPromise,
  cancelWithTimeout,
  raceStartup,
  stallTimer,
  waitUntil,
  withTimeout,
} from "../async-control.js";
