import {
  CorruptRecordError,
  decodeDurableErrorRecord,
  decodeEnvelope,
  readPersistedError,
} from "../packages/dal-codec/src/index.ts";

type ErrorPayload = {
  readonly name: string;
  readonly code: string;
  readonly category: string;
  readonly message: string;
  readonly retriable: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
};

const knownError: ErrorPayload = {
  name: "ProviderError",
  code: "provider.upstream_failed",
  category: "provider",
  message: "upstream failed",
  retriable: true,
};
const unknownError: ErrorPayload = {
  ...knownError,
  code: "future.provider_code",
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isErrorPayload(value: unknown): value is { error: ErrorPayload } {
  return typeof value === "object" && value !== null && "error" in value;
}

function assertUnknownRead(value: unknown): void {
  const result = readPersistedError(value);
  assert(result !== null, "unknown persisted error must remain structurally readable");
  assert(result.knownCode === false, "unknown persisted error must set knownCode=false");
  assert(result.migratedAlias === false, "unknown persisted error cannot claim an alias migration");
  assert(result.error.code === unknownError.code, "unknown persisted code must be preserved");
  assert(result.error.retriable === false, "unknown persisted error must disable retry");
}

for (const schemaVersion of [1, 2] as const) {
  for (const kind of ["session", "turn", "tool_call"] as const) {
    const statuses =
      kind === "tool_call"
        ? (["failed", "timed_out", "cancelled"] as const)
        : (["failed"] as const);
    for (const status of statuses) {
      const decoded = decodeEnvelope(
        {
          kind,
          schemaVersion,
          payload: { status, error: unknownError },
        },
        kind,
        `${kind}-${schemaVersion}-${status}`,
        isErrorPayload,
      );
      assert(
        decoded.payload.error.retriable === false,
        `${kind} schema ${schemaVersion} unknown code selected retry`,
      );
      assertUnknownRead(decoded.payload.error);
    }
  }
}

const aliasEnvelope = decodeEnvelope(
  {
    kind: "turn",
    schemaVersion: 1,
    payload: { status: "failed", error: { ...knownError, code: "stt.provider.internal" } },
  },
  "turn",
  "legacy-alias-envelope",
  isErrorPayload,
);
assert(
  aliasEnvelope.payload.error.code === "provider.upstream_failed",
  "legacy alias was not migrated inside an envelope",
);
assert(
  aliasEnvelope.payload.error.metadata?.legacyCode === "stt.provider.internal",
  "legacy alias metadata was lost inside an envelope",
);

const canonical = readPersistedError(knownError);
assert(canonical !== null, "canonical persisted error was rejected");
assert(canonical.knownCode === true, "canonical persisted error must set knownCode=true");
assert(canonical.migratedAlias === false, "canonical persisted error cannot claim alias migration");
assert(canonical.error.retriable === true, "canonical retry policy was changed");

const migratedAlias = readPersistedError({ ...knownError, code: "stt.provider.internal" });
assert(migratedAlias !== null, "registered legacy alias was rejected");
assert(migratedAlias.knownCode === true, "registered legacy alias must remain known");
assert(migratedAlias.migratedAlias === true, "registered legacy alias was not marked migrated");
assert(
  migratedAlias.error.code === "provider.upstream_failed",
  "registered legacy alias did not map to its canonical code",
);
assert(
  migratedAlias.error.metadata?.legacyCode === "stt.provider.internal",
  "registered legacy alias was not retained in bounded metadata",
);

const secretRead = readPersistedError({
  ...knownError,
  metadata: {
    authorization: "Bearer provider-secret",
    apiKey: "provider-secret",
    endpoint: "https://user:password@example.test/path",
    token: Buffer.from("provider-secret").toString("base64"),
  },
});
assert(secretRead !== null, "bounded secret metadata was rejected instead of sanitized");
const serializedSecretRead = JSON.stringify(secretRead);
for (const secret of ["provider-secret", "password", "cHJvdmlkZXItc2VjcmV0"]) {
  assert(!serializedSecretRead.includes(secret), `persisted parser exposed a secret: ${secret}`);
}

const cyclic = { ...unknownError } as { code: string; cause?: unknown };
cyclic.cause = cyclic;
try {
  decodeEnvelope(
    { kind: "session", schemaVersion: 2, payload: { status: "failed", error: cyclic } },
    "session",
    "cyclic-cause",
    isErrorPayload,
  );
  throw new Error("cyclic persisted cause was accepted");
} catch (error) {
  assert(error instanceof CorruptRecordError, "cyclic cause must raise CorruptRecordError");
}

let getterReads = 0;
const accessorCause = { ...unknownError } as { code: string; cause?: unknown };
Object.defineProperty(accessorCause, "cause", {
  configurable: true,
  get() {
    getterReads += 1;
    throw new Error("cause getter invoked");
  },
});
try {
  decodeEnvelope(
    { kind: "turn", schemaVersion: 2, payload: { status: "failed", error: accessorCause } },
    "turn",
    "accessor-cause",
    isErrorPayload,
  );
  throw new Error("accessor persisted cause was accepted");
} catch (error) {
  assert(error instanceof CorruptRecordError, "accessor cause must raise CorruptRecordError");
}
assert(getterReads === 0, "persisted parser invoked an accessor-bearing cause");

const oversizedRead = readPersistedError({ ...knownError, code: "a".repeat(129) });
assert(oversizedRead === null, "oversized persisted code must return null at the parser boundary");

try {
  decodeEnvelope(
    {
      kind: "session",
      schemaVersion: 2,
      payload: { status: "failed", error: { ...knownError, code: "UNKNOWN_DURABLE" } },
    },
    "session",
    "unknown-durable-code",
    isErrorPayload,
  );
  throw new Error("unknown durable code was accepted");
} catch (error) {
  assert(error instanceof CorruptRecordError, "unknown durable code must raise CorruptRecordError");
}

const knownDurableRecord = {
  kind: "durable_error",
  schemaVersion: 1,
  error: {
    name: "RecordConflictError",
    code: "RECORD_CONFLICT",
    message: "Record conflict: tool-key",
    retriable: false,
  },
};
const decodedDurable = decodeDurableErrorRecord(knownDurableRecord, "known-durable-record");
assert(decodedDurable.code === "RECORD_CONFLICT", "known durable code did not decode");
assert(decodedDurable.retriable === false, "known durable retry policy changed");

try {
  decodeDurableErrorRecord(
    {
      kind: "durable_error",
      schemaVersion: 1,
      error: {
        name: "DurableError",
        code: "UNKNOWN_DURABLE",
        message: "future durable code",
        retriable: true,
      },
    },
    "unknown-durable-record",
  );
  throw new Error("unknown serialized durable code was accepted");
} catch (error) {
  assert(
    error instanceof CorruptRecordError,
    "unknown serialized durable code must raise CorruptRecordError",
  );
}

for (const [label, record] of [
  [
    "durable retry mismatch",
    { ...knownDurableRecord, error: { ...knownDurableRecord.error, retriable: true } },
  ],
  [
    "durable name mismatch",
    {
      ...knownDurableRecord,
      error: { ...knownDurableRecord.error, name: "BackendUnavailableError" },
    },
  ],
  ["durable schema mismatch", { ...knownDurableRecord, schemaVersion: 2 }],
  [
    "durable missing message",
    { ...knownDurableRecord, error: { ...knownDurableRecord.error, message: undefined } },
  ],
  ["durable malformed error", { ...knownDurableRecord, error: "not-an-error" }],
] as const) {
  try {
    decodeDurableErrorRecord(record, label);
    throw new Error(`${label} was accepted`);
  } catch (error) {
    assert(error instanceof CorruptRecordError, `${label} must raise CorruptRecordError`);
  }
}

try {
  decodeEnvelope(
    {
      kind: "tool_call",
      schemaVersion: 2,
      payload: {
        status: "failed",
        error: { ...knownError, message: 42 },
      },
    },
    "tool_call",
    "malformed-error",
    isErrorPayload,
  );
  throw new Error("malformed persisted error was accepted");
} catch (error) {
  assert(error instanceof CorruptRecordError, "malformed error must raise CorruptRecordError");
}

try {
  decodeEnvelope(
    {
      kind: "session",
      schemaVersion: 2,
      payload: {
        status: "failed",
        error: {
          ...knownError,
          metadata: { providerCode: "Basic " + "a".repeat(300) },
        },
      },
    },
    "session",
    "oversized-secret-metadata",
    isErrorPayload,
  );
  throw new Error("oversized secret metadata was accepted");
} catch (error) {
  assert(error instanceof CorruptRecordError, "oversized metadata must raise CorruptRecordError");
}

process.stdout.write("persisted error contract ok: schema v1/v2, unknown, cause, and bounds\n");
