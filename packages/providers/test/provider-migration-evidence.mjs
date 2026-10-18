import { assemblyAiHttpError } from "../src/assemblyai-http-stt.ts";
import { assemblyAiCloseError, assemblyAiProtocolError } from "../src/assemblyai-stt-protocol.ts";
import { elevenLabsBatchHttpError } from "../src/elevenlabs-batch-stt.ts";
import { providerError } from "../src/common.ts";
import { deepgramCloseError, deepgramProtocolError } from "../src/deepgram.ts";
import { elevenLabsCloseError, elevenLabsProtocolError } from "../src/elevenlabs-stt-protocol.ts";
import { sarvamProtocolError } from "../src/sarvam.ts";
import { normalizeSarvamTtsConnectionError, sarvamTtsCloseError } from "../src/sarvam-tts.ts";
import { sarvamTtsProtocolError } from "../src/sarvam-tts-protocol.ts";
import { sonioxCloseError, sonioxProtocolError } from "../src/soniox-stt.ts";
import { classifiedProviderError } from "../src/provider-error-classifier.ts";

export const evidenceSourceBindings = [
  {
    file: "packages/providers/src/assemblyai-stt-protocol.ts",
    factories: ["providerError"],
  },
  {
    file: "packages/providers/src/assemblyai-http-stt.ts",
    factories: ["providerError"],
  },
  {
    file: "packages/providers/src/common.ts",
    factories: ["providerError"],
  },
  {
    file: "packages/providers/src/deepgram.ts",
    factories: ["providerError"],
  },
  {
    file: "packages/providers/src/elevenlabs-stt-protocol.ts",
    factories: ["providerError"],
  },
  {
    file: "packages/providers/src/elevenlabs-batch-stt.ts",
    factories: ["providerError"],
  },
  {
    file: "packages/providers/src/sarvam.ts",
    factories: ["providerError"],
  },
  {
    file: "packages/providers/src/sarvam-tts.ts",
    factories: ["providerError"],
  },
  {
    file: "packages/providers/src/sarvam-tts-protocol.ts",
    factories: ["providerError"],
  },
  {
    file: "packages/providers/src/soniox-stt.ts",
    factories: ["providerError"],
  },
  {
    file: "packages/providers/src/provider-error-classifier.ts",
    factories: ["providerError"],
  },
];

export async function runErrorMigrationEvidence({
  recordFactoryCall,
  assertErrorMigrationEvidence,
}) {
  const rows = [];

  const expectedAssemblyClose = {
    code: "stt.transport.unexpected_eof",
    retriable: true,
    retryOwner: "provider-selector",
    persistedReadPolicy: "persist canonical code plus bounded legacy provider code",
  };
  const observedAssemblyClose = await recordFactoryCall(
    "packages/providers/test/error-code-evidence.test.ts#assemblyAiCloseError",
    "providerError",
    () => assemblyAiCloseError(1006),
  );
  const checkedAssemblyClose = await assertErrorMigrationEvidence({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#assemblyAiCloseError",
    factory: "providerError",
    exercise: () => observedAssemblyClose,
    expected: expectedAssemblyClose,
  });
  rows.push({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#assemblyAiCloseError",
    factory: "providerError",
    observed: checkedAssemblyClose,
  });

  const expectedAssemblyProtocol = {
    code: "provider.upstream_failed",
    retriable: true,
    retryOwner: "provider-selector",
    persistedReadPolicy: "persist canonical code plus bounded legacy provider code",
  };
  const observedAssemblyProtocol = await recordFactoryCall(
    "packages/providers/test/error-code-evidence.test.ts#assemblyAiProtocolError",
    "providerError",
    () => assemblyAiProtocolError({ code: 1011, message: "service unavailable" }),
  );
  const checkedAssemblyProtocol = await assertErrorMigrationEvidence({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#assemblyAiProtocolError",
    factory: "providerError",
    exercise: () => observedAssemblyProtocol,
    expected: expectedAssemblyProtocol,
  });
  rows.push({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#assemblyAiProtocolError",
    factory: "providerError",
    observed: checkedAssemblyProtocol,
  });

  const expectedAssemblyHttp = {
    code: "provider.rate_limited",
    retriable: true,
    retryOwner: "provider-selector",
    persistedReadPolicy: "persist canonical code plus bounded legacy provider code",
  };
  const observedAssemblyHttp = await recordFactoryCall(
    "packages/providers/test/error-code-evidence.test.ts#assemblyAiHttpError",
    "providerError",
    () => assemblyAiHttpError(429, JSON.stringify({ detail: "rate limited" }), "evidence"),
  );
  const checkedAssemblyHttp = await assertErrorMigrationEvidence({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#assemblyAiHttpError",
    factory: "providerError",
    exercise: () => observedAssemblyHttp,
    expected: expectedAssemblyHttp,
  });
  rows.push({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#assemblyAiHttpError",
    factory: "providerError",
    observed: checkedAssemblyHttp,
  });

  const expectedConnection = {
    code: "provider.upstream_failed",
    retriable: true,
    retryOwner: "provider-selector",
    persistedReadPolicy: "persist canonical code plus bounded legacy provider code",
  };
  const observedConnection = await recordFactoryCall(
    "packages/providers/test/error-code-evidence.test.ts#providerError",
    "providerError",
    () => providerError("provider.upstream_failed", "evidence"),
  );
  const checkedConnection = await assertErrorMigrationEvidence({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#providerError",
    factory: "providerError",
    exercise: () => observedConnection,
    expected: expectedConnection,
  });
  rows.push({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#providerError",
    factory: "providerError",
    observed: checkedConnection,
  });

  const expectedDeepgramClose = {
    code: "stt.transport.unexpected_eof",
    retriable: true,
    retryOwner: "provider-selector",
    persistedReadPolicy: "persist canonical code plus bounded legacy provider code",
  };
  const observedDeepgramClose = await recordFactoryCall(
    "packages/providers/test/error-code-evidence.test.ts#deepgramCloseError",
    "providerError",
    () => deepgramCloseError(1006),
  );
  const checkedDeepgramClose = await assertErrorMigrationEvidence({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#deepgramCloseError",
    factory: "providerError",
    exercise: () => observedDeepgramClose,
    expected: expectedDeepgramClose,
  });
  rows.push({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#deepgramCloseError",
    factory: "providerError",
    observed: checkedDeepgramClose,
  });

  const expectedDeepgramProtocol = {
    code: "provider.input_rejected",
    retriable: false,
    retryOwner: "provider-selector",
    persistedReadPolicy: "persist canonical code plus bounded legacy provider code",
  };
  const observedDeepgramProtocol = await recordFactoryCall(
    "packages/providers/test/error-code-evidence.test.ts#deepgramProtocolError",
    "providerError",
    () => deepgramProtocolError({ err_code: "DATA-0000", err_msg: "bad audio" }, false),
  );
  const checkedDeepgramProtocol = await assertErrorMigrationEvidence({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#deepgramProtocolError",
    factory: "providerError",
    exercise: () => observedDeepgramProtocol,
    expected: expectedDeepgramProtocol,
  });
  rows.push({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#deepgramProtocolError",
    factory: "providerError",
    observed: checkedDeepgramProtocol,
  });

  const expectedElevenClose = {
    code: "stt.transport.unexpected_eof",
    retriable: true,
    retryOwner: "provider-selector",
    persistedReadPolicy: "persist canonical code plus bounded legacy provider code",
  };
  const observedElevenClose = await recordFactoryCall(
    "packages/providers/test/error-code-evidence.test.ts#elevenLabsCloseError",
    "providerError",
    () => elevenLabsCloseError(1006),
  );
  const checkedElevenClose = await assertErrorMigrationEvidence({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#elevenLabsCloseError",
    factory: "providerError",
    exercise: () => observedElevenClose,
    expected: expectedElevenClose,
  });
  rows.push({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#elevenLabsCloseError",
    factory: "providerError",
    observed: checkedElevenClose,
  });

  const expectedElevenProtocol = {
    code: "provider.input_rejected",
    retriable: false,
    retryOwner: "provider-selector",
    persistedReadPolicy: "persist canonical code plus bounded legacy provider code",
  };
  const observedElevenProtocol = await recordFactoryCall(
    "packages/providers/test/error-code-evidence.test.ts#elevenLabsProtocolError",
    "providerError",
    () => elevenLabsProtocolError({ message_type: "input_error", error: "bad audio" }),
  );
  const checkedElevenProtocol = await assertErrorMigrationEvidence({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#elevenLabsProtocolError",
    factory: "providerError",
    exercise: () => observedElevenProtocol,
    expected: expectedElevenProtocol,
  });
  rows.push({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#elevenLabsProtocolError",
    factory: "providerError",
    observed: checkedElevenProtocol,
  });

  const expectedElevenBatch = {
    code: "provider.rate_limited",
    retriable: true,
    retryOwner: "provider-selector",
    persistedReadPolicy: "persist canonical code plus bounded legacy provider code",
  };
  const observedElevenBatch = await recordFactoryCall(
    "packages/providers/test/error-code-evidence.test.ts#elevenLabsBatchHttpError",
    "providerError",
    () => elevenLabsBatchHttpError(429, JSON.stringify({ detail: "rate limited" })),
  );
  const checkedElevenBatch = await assertErrorMigrationEvidence({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#elevenLabsBatchHttpError",
    factory: "providerError",
    exercise: () => observedElevenBatch,
    expected: expectedElevenBatch,
  });
  rows.push({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#elevenLabsBatchHttpError",
    factory: "providerError",
    observed: checkedElevenBatch,
  });

  const expectedSarvam = {
    code: "provider.invalid_request",
    retriable: false,
    retryOwner: "provider-selector",
    persistedReadPolicy: "persist canonical code plus bounded legacy provider code",
  };
  const observedSarvam = await recordFactoryCall(
    "packages/providers/test/error-code-evidence.test.ts#sarvamProtocolError",
    "providerError",
    () => sarvamProtocolError("request_invalid", "invalid request"),
  );
  const checkedSarvam = await assertErrorMigrationEvidence({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#sarvamProtocolError",
    factory: "providerError",
    exercise: () => observedSarvam,
    expected: expectedSarvam,
  });
  rows.push({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#sarvamProtocolError",
    factory: "providerError",
    observed: checkedSarvam,
  });

  const expectedSarvamTtsClose = {
    code: "provider.upstream_failed",
    retriable: true,
    retryOwner: "provider-selector",
    persistedReadPolicy: "persist canonical code plus bounded legacy provider code",
  };
  const observedSarvamTtsClose = await recordFactoryCall(
    "packages/providers/test/error-code-evidence.test.ts#sarvamTtsCloseError",
    "providerError",
    () => sarvamTtsCloseError(1006),
  );
  const checkedSarvamTtsClose = await assertErrorMigrationEvidence({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#sarvamTtsCloseError",
    factory: "providerError",
    exercise: () => observedSarvamTtsClose,
    expected: expectedSarvamTtsClose,
  });
  rows.push({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#sarvamTtsCloseError",
    factory: "providerError",
    observed: checkedSarvamTtsClose,
  });

  const expectedSarvamTtsHandshake = {
    code: "provider.rate_limited",
    retriable: true,
    retryOwner: "provider-selector",
    persistedReadPolicy: "persist canonical code plus bounded legacy provider code",
  };
  const observedSarvamTtsHandshake = await recordFactoryCall(
    "packages/providers/test/error-code-evidence.test.ts#normalizeSarvamTtsConnectionError",
    "providerError",
    () => normalizeSarvamTtsConnectionError(new Error("Unexpected server response: 429")),
  );
  const checkedSarvamTtsHandshake = await assertErrorMigrationEvidence({
    evidenceKey:
      "packages/providers/test/error-code-evidence.test.ts#normalizeSarvamTtsConnectionError",
    factory: "providerError",
    exercise: () => observedSarvamTtsHandshake,
    expected: expectedSarvamTtsHandshake,
  });
  rows.push({
    evidenceKey:
      "packages/providers/test/error-code-evidence.test.ts#normalizeSarvamTtsConnectionError",
    factory: "providerError",
    observed: checkedSarvamTtsHandshake,
  });

  const expectedSarvamTtsProtocol = {
    code: "provider.invalid_request",
    retriable: false,
    retryOwner: "provider-selector",
    persistedReadPolicy: "persist canonical code plus bounded legacy provider code",
  };
  const observedSarvamTtsProtocol = await recordFactoryCall(
    "packages/providers/test/error-code-evidence.test.ts#sarvamTtsProtocolError",
    "providerError",
    () => sarvamTtsProtocolError("request_invalid", "invalid request"),
  );
  const checkedSarvamTtsProtocol = await assertErrorMigrationEvidence({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#sarvamTtsProtocolError",
    factory: "providerError",
    exercise: () => observedSarvamTtsProtocol,
    expected: expectedSarvamTtsProtocol,
  });
  rows.push({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#sarvamTtsProtocolError",
    factory: "providerError",
    observed: checkedSarvamTtsProtocol,
  });

  const expectedSonioxClose = {
    code: "stt.transport.unexpected_eof",
    retriable: true,
    retryOwner: "provider-selector",
    persistedReadPolicy: "persist canonical code plus bounded legacy provider code",
  };
  const observedSonioxClose = await recordFactoryCall(
    "packages/providers/test/error-code-evidence.test.ts#sonioxCloseError",
    "providerError",
    () => sonioxCloseError(1006),
  );
  const checkedSonioxClose = await assertErrorMigrationEvidence({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#sonioxCloseError",
    factory: "providerError",
    exercise: () => observedSonioxClose,
    expected: expectedSonioxClose,
  });
  rows.push({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#sonioxCloseError",
    factory: "providerError",
    observed: checkedSonioxClose,
  });

  const expectedSonioxProtocol = {
    code: "provider.upstream_failed",
    retriable: true,
    retryOwner: "provider-selector",
    persistedReadPolicy: "persist canonical code plus bounded legacy provider code",
  };
  const observedSonioxProtocol = await recordFactoryCall(
    "packages/providers/test/error-code-evidence.test.ts#sonioxProtocolError",
    "providerError",
    () => sonioxProtocolError({ error_type: "service_unavailable", error_message: "offline" }),
  );
  const checkedSonioxProtocol = await assertErrorMigrationEvidence({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#sonioxProtocolError",
    factory: "providerError",
    exercise: () => observedSonioxProtocol,
    expected: expectedSonioxProtocol,
  });
  rows.push({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#sonioxProtocolError",
    factory: "providerError",
    observed: checkedSonioxProtocol,
  });

  const expectedClassifier = {
    code: "provider.quota_exceeded",
    retriable: false,
    retryOwner: "provider-selector",
    persistedReadPolicy: "persist canonical code plus bounded legacy provider code",
  };
  const observedClassifier = await recordFactoryCall(
    "packages/providers/test/error-code-evidence.test.ts#classifiedProviderError",
    "providerError",
    () =>
      classifiedProviderError("groq-chat-completions", "evidence", {
        providerCode: "insufficient_quota",
      }),
  );
  const checkedClassifier = await assertErrorMigrationEvidence({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#classifiedProviderError",
    factory: "providerError",
    exercise: () => observedClassifier,
    expected: expectedClassifier,
  });
  rows.push({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#classifiedProviderError",
    factory: "providerError",
    observed: checkedClassifier,
  });

  return rows;
}
