export type DurableErrorCode =
  | "RECORD_NOT_FOUND"
  | "RECORD_CONFLICT"
  | "LEASE_UNAVAILABLE"
  | "LEASE_LOST"
  | "BACKEND_UNAVAILABLE"
  | "CORRUPT_RECORD"
  | "INVALID_ARGUMENT"
  | "MEMORY_BACKEND_UNAVAILABLE"
  | "MEMORY_ENTRY_TOO_LARGE"
  | "MEMORY_SESSION_QUOTA_EXCEEDED";

export class DurableError extends Error {
  readonly code: DurableErrorCode;
  readonly retriable: boolean;

  constructor(code: DurableErrorCode, message: string, retriable: boolean) {
    super(message);
    this.name = "DurableError";
    this.code = code;
    this.retriable = retriable;
  }
}

export class RecordNotFoundError extends DurableError {
  constructor(key: string) {
    super("RECORD_NOT_FOUND", `Record not found: ${key}`, false);
    this.name = "RecordNotFoundError";
  }
}

export class RecordConflictError extends DurableError {
  constructor(key: string) {
    super("RECORD_CONFLICT", `Record conflict: ${key}`, false);
    this.name = "RecordConflictError";
  }
}

export class LeaseUnavailableError extends DurableError {
  constructor(sessionId: string) {
    super("LEASE_UNAVAILABLE", `Lease unavailable: ${sessionId}`, true);
    this.name = "LeaseUnavailableError";
  }
}

export class LeaseLostError extends DurableError {
  constructor(sessionId: string) {
    super("LEASE_LOST", `Lease lost: ${sessionId}`, false);
    this.name = "LeaseLostError";
  }
}

export class BackendUnavailableError extends DurableError {
  constructor(message: string) {
    super("BACKEND_UNAVAILABLE", message, true);
    this.name = "BackendUnavailableError";
  }
}

export class CorruptRecordError extends DurableError {
  readonly key: string;
  readonly schemaVersion: number | undefined;

  constructor(key: string, message: string, schemaVersion?: number) {
    super("CORRUPT_RECORD", `${key}: ${message}`, false);
    this.name = "CorruptRecordError";
    this.key = key;
    this.schemaVersion = schemaVersion;
  }
}

export class InvalidArgumentError extends DurableError {
  constructor(message: string) {
    super("INVALID_ARGUMENT", message, false);
    this.name = "InvalidArgumentError";
  }
}

export class MemoryBackendUnavailableError extends DurableError {
  constructor(message: string) {
    super("MEMORY_BACKEND_UNAVAILABLE", message, true);
    this.name = "MemoryBackendUnavailableError";
  }
}

export class MemoryEntryTooLargeError extends DurableError {
  readonly key: string;
  readonly sizeBytes: number;
  readonly maxBytes: number;

  constructor(key: string, sizeBytes: number, maxBytes: number) {
    super(
      "MEMORY_ENTRY_TOO_LARGE",
      `Memory entry ${key} exceeds cap (${sizeBytes} > ${maxBytes} bytes)`,
      false,
    );
    this.name = "MemoryEntryTooLargeError";
    this.key = key;
    this.sizeBytes = sizeBytes;
    this.maxBytes = maxBytes;
  }
}

export class MemorySessionQuotaExceededError extends DurableError {
  readonly sessionId: string;
  readonly usedBytes: number;
  readonly requestedBytes: number;
  readonly maxBytes: number;

  constructor(sessionId: string, usedBytes: number, requestedBytes: number, maxBytes: number) {
    super(
      "MEMORY_SESSION_QUOTA_EXCEEDED",
      `Session memory quota exceeded for ${sessionId} (${usedBytes + requestedBytes} > ${maxBytes} bytes)`,
      false,
    );
    this.name = "MemorySessionQuotaExceededError";
    this.sessionId = sessionId;
    this.usedBytes = usedBytes;
    this.requestedBytes = requestedBytes;
    this.maxBytes = maxBytes;
  }
}
