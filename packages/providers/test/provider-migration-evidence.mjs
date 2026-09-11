import { assemblyAiCloseError, assemblyAiProtocolError } from "../src/assemblyai-stt.ts";
import { providerError } from "../src/common.ts";
import { deepgramCloseError, deepgramProtocolError } from "../src/deepgram.ts";
import { elevenLabsCloseError, elevenLabsProtocolError } from "../src/elevenlabs-stt.ts";
import { sarvamProtocolError } from "../src/sarvam.ts";
import { sonioxCloseError, sonioxProtocolError } from "../src/soniox-stt.ts";

export const evidenceSourceBindings = [
  {
    file: "packages/providers/src/assemblyai-stt.ts",
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
    file: "packages/providers/src/elevenlabs-stt.ts",
    factories: ["providerError"],
  },
  {
    file: "packages/providers/src/sarvam.ts",
    factories: ["providerError"],
  },
  {
    file: "packages/providers/src/soniox-stt.ts",
    factories: ["providerError"],
  },
];

function annotate(value, expected) {
  Object.assign(value, {
    retryOwner: expected.retryOwner,
    persistedReadPolicy: expected.persistedReadPolicy,
  });
  return value;
}

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
    "packages/providers/src/assemblyai-stt.ts:673:10:providerError",
    "providerError",
    () => assemblyAiCloseError(1006),
  );
  annotate(observedAssemblyClose, expectedAssemblyClose);
  const checkedAssemblyClose = await assertErrorMigrationEvidence({
    sourceLocation: "packages/providers/src/assemblyai-stt.ts:673:10:providerError",
    factory: "providerError",
    exercise: () => observedAssemblyClose,
    expected: expectedAssemblyClose,
  });
  rows.push({
    sourceLocation: "packages/providers/src/assemblyai-stt.ts:673:10:providerError",
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
    "packages/providers/src/assemblyai-stt.ts:707:10:providerError",
    "providerError",
    () => assemblyAiProtocolError({ code: 1011, message: "service unavailable" }),
  );
  annotate(observedAssemblyProtocol, expectedAssemblyProtocol);
  const checkedAssemblyProtocol = await assertErrorMigrationEvidence({
    sourceLocation: "packages/providers/src/assemblyai-stt.ts:707:10:providerError",
    factory: "providerError",
    exercise: () => observedAssemblyProtocol,
    expected: expectedAssemblyProtocol,
  });
  rows.push({
    sourceLocation: "packages/providers/src/assemblyai-stt.ts:707:10:providerError",
    factory: "providerError",
    observed: checkedAssemblyProtocol,
  });

  const expectedConnection = {
    code: "provider.upstream_failed",
    retriable: true,
    retryOwner: "provider-selector",
    persistedReadPolicy: "persist canonical code plus bounded legacy provider code",
  };
  const observedConnection = await recordFactoryCall(
    "packages/providers/src/common.ts:66:10:providerError",
    "providerError",
    () => providerError("provider.upstream_failed", "evidence"),
  );
  annotate(observedConnection, expectedConnection);
  const checkedConnection = await assertErrorMigrationEvidence({
    sourceLocation: "packages/providers/src/common.ts:66:10:providerError",
    factory: "providerError",
    exercise: () => observedConnection,
    expected: expectedConnection,
  });
  rows.push({
    sourceLocation: "packages/providers/src/common.ts:66:10:providerError",
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
    "packages/providers/src/deepgram.ts:368:10:providerError",
    "providerError",
    () => deepgramCloseError(1006),
  );
  annotate(observedDeepgramClose, expectedDeepgramClose);
  const checkedDeepgramClose = await assertErrorMigrationEvidence({
    sourceLocation: "packages/providers/src/deepgram.ts:368:10:providerError",
    factory: "providerError",
    exercise: () => observedDeepgramClose,
    expected: expectedDeepgramClose,
  });
  rows.push({
    sourceLocation: "packages/providers/src/deepgram.ts:368:10:providerError",
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
    "packages/providers/src/deepgram.ts:391:10:providerError",
    "providerError",
    () => deepgramProtocolError({ err_code: "DATA-0000", err_msg: "bad audio" }, false),
  );
  annotate(observedDeepgramProtocol, expectedDeepgramProtocol);
  const checkedDeepgramProtocol = await assertErrorMigrationEvidence({
    sourceLocation: "packages/providers/src/deepgram.ts:391:10:providerError",
    factory: "providerError",
    exercise: () => observedDeepgramProtocol,
    expected: expectedDeepgramProtocol,
  });
  rows.push({
    sourceLocation: "packages/providers/src/deepgram.ts:391:10:providerError",
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
    "packages/providers/src/elevenlabs-stt.ts:414:10:providerError",
    "providerError",
    () => elevenLabsCloseError(1006),
  );
  annotate(observedElevenClose, expectedElevenClose);
  const checkedElevenClose = await assertErrorMigrationEvidence({
    sourceLocation: "packages/providers/src/elevenlabs-stt.ts:414:10:providerError",
    factory: "providerError",
    exercise: () => observedElevenClose,
    expected: expectedElevenClose,
  });
  rows.push({
    sourceLocation: "packages/providers/src/elevenlabs-stt.ts:414:10:providerError",
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
    "packages/providers/src/elevenlabs-stt.ts:445:10:providerError",
    "providerError",
    () => elevenLabsProtocolError({ message_type: "input_error", error: "bad audio" }),
  );
  annotate(observedElevenProtocol, expectedElevenProtocol);
  const checkedElevenProtocol = await assertErrorMigrationEvidence({
    sourceLocation: "packages/providers/src/elevenlabs-stt.ts:445:10:providerError",
    factory: "providerError",
    exercise: () => observedElevenProtocol,
    expected: expectedElevenProtocol,
  });
  rows.push({
    sourceLocation: "packages/providers/src/elevenlabs-stt.ts:445:10:providerError",
    factory: "providerError",
    observed: checkedElevenProtocol,
  });

  const expectedSarvam = {
    code: "provider.invalid_request",
    retriable: false,
    retryOwner: "provider-selector",
    persistedReadPolicy: "persist canonical code plus bounded legacy provider code",
  };
  const observedSarvam = await recordFactoryCall(
    "packages/providers/src/sarvam.ts:443:10:providerError",
    "providerError",
    () => sarvamProtocolError("request_invalid", "invalid request"),
  );
  annotate(observedSarvam, expectedSarvam);
  const checkedSarvam = await assertErrorMigrationEvidence({
    sourceLocation: "packages/providers/src/sarvam.ts:443:10:providerError",
    factory: "providerError",
    exercise: () => observedSarvam,
    expected: expectedSarvam,
  });
  rows.push({
    sourceLocation: "packages/providers/src/sarvam.ts:443:10:providerError",
    factory: "providerError",
    observed: checkedSarvam,
  });

  const expectedSonioxClose = {
    code: "stt.transport.unexpected_eof",
    retriable: true,
    retryOwner: "provider-selector",
    persistedReadPolicy: "persist canonical code plus bounded legacy provider code",
  };
  const observedSonioxClose = await recordFactoryCall(
    "packages/providers/src/soniox-stt.ts:659:10:providerError",
    "providerError",
    () => sonioxCloseError(1006),
  );
  annotate(observedSonioxClose, expectedSonioxClose);
  const checkedSonioxClose = await assertErrorMigrationEvidence({
    sourceLocation: "packages/providers/src/soniox-stt.ts:659:10:providerError",
    factory: "providerError",
    exercise: () => observedSonioxClose,
    expected: expectedSonioxClose,
  });
  rows.push({
    sourceLocation: "packages/providers/src/soniox-stt.ts:659:10:providerError",
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
    "packages/providers/src/soniox-stt.ts:693:10:providerError",
    "providerError",
    () => sonioxProtocolError({ error_type: "service_unavailable", error_message: "offline" }),
  );
  annotate(observedSonioxProtocol, expectedSonioxProtocol);
  const checkedSonioxProtocol = await assertErrorMigrationEvidence({
    sourceLocation: "packages/providers/src/soniox-stt.ts:693:10:providerError",
    factory: "providerError",
    exercise: () => observedSonioxProtocol,
    expected: expectedSonioxProtocol,
  });
  rows.push({
    sourceLocation: "packages/providers/src/soniox-stt.ts:693:10:providerError",
    factory: "providerError",
    observed: checkedSonioxProtocol,
  });

  return rows;
}
