import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import type { SpeechToTextProvider, SttLanguagePolicy } from "@tvic/core";
import { PCM16_16K_MONO } from "@tvic/core";
import {
  AssemblyAiSttProvider,
  CartesiaSttProvider,
  DeepgramSttProvider,
  ElevenLabsSttProvider,
  SarvamSttProvider,
  SonioxSttProvider,
} from "../src/index.js";

class PolicySocket extends EventEmitter {
  readonly sent: string[] = [];
  readyState: number = WebSocket.OPEN;

  send(data: string | Buffer, callback?: (error?: Error) => void): void {
    if (typeof data === "string") this.sent.push(data);
    callback?.();
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1000, Buffer.alloc(0));
  }
}

interface LanguagePolicyAdapter {
  readonly name: string;
  readonly model: string;
  create(socket: PolicySocket, onUrl: (url: string) => void): SpeechToTextProvider;
  assertFixedLanguage(socket: PolicySocket, url: string): void;
  assertAutoLanguage(socket: PolicySocket, url: string): void;
  assertLegacyLanguage(socket: PolicySocket, url: string): void;
  readonly supportsHints: boolean;
  assertHints?(socket: PolicySocket, url: string): void;
}

const adapters: readonly LanguagePolicyAdapter[] = [
  {
    name: "Deepgram",
    model: "nova-3",
    create: (socket, onUrl) =>
      new DeepgramSttProvider({
        apiKey: "test",
        webSocketFactory: (url) => {
          onUrl(url);
          return socket as never;
        },
      }),
    assertFixedLanguage: (_socket, url) => {
      expect(new URL(url).searchParams.get("language")).toBe("hi-IN");
    },
    assertLegacyLanguage: (_socket, url) => {
      expect(new URL(url).searchParams.get("language")).toBe("hi_IN");
    },
    assertAutoLanguage: (_socket, url) => {
      expect(new URL(url).searchParams.get("language")).toBe("multi");
    },
    supportsHints: true,
    assertHints: (_socket, url) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get("language")).toBe("multi");
      expect(parsed.searchParams.getAll("language_hint")).toEqual(["en", "hi"]);
    },
  },
  {
    name: "Cartesia",
    model: "ink-2",
    create: (socket, onUrl) =>
      new CartesiaSttProvider({
        apiKey: "test",
        webSocketFactory: (url) => {
          onUrl(url);
          return socket as never;
        },
      }),
    assertFixedLanguage: (_socket, url) => {
      expect(new URL(url).searchParams.get("language")).toBe("hi");
    },
    assertLegacyLanguage: (_socket, url) => {
      expect(new URL(url).searchParams.get("language")).toBe("hi_IN");
    },
    assertAutoLanguage: (_socket, url) => {
      expect(new URL(url).searchParams.has("language")).toBe(false);
    },
    supportsHints: false,
  },
  {
    name: "Sarvam",
    model: "saaras:v4",
    create: (socket, onUrl) =>
      new SarvamSttProvider({
        apiKey: "test",
        webSocketFactory: (url) => {
          onUrl(url);
          return socket as never;
        },
      }),
    assertFixedLanguage: (_socket, url) => {
      expect(new URL(url).searchParams.get("language-code")).toBe("hi-IN");
    },
    assertLegacyLanguage: (_socket, url) => {
      expect(new URL(url).searchParams.get("language-code")).toBe("hi_IN");
    },
    assertAutoLanguage: (_socket, url) => {
      expect(new URL(url).searchParams.get("language-code")).toBe("unknown");
    },
    supportsHints: false,
  },
  {
    name: "ElevenLabs",
    model: "scribe_v2_realtime",
    create: (socket, onUrl) =>
      new ElevenLabsSttProvider({
        apiKey: "test",
        webSocketFactory: (url) => {
          onUrl(url);
          return socket as never;
        },
      }),
    assertFixedLanguage: (_socket, url) => {
      expect(new URL(url).searchParams.get("language_code")).toBe("hi");
    },
    assertLegacyLanguage: (_socket, url) => {
      expect(new URL(url).searchParams.get("language_code")).toBe("hi_IN");
    },
    assertAutoLanguage: (_socket, url) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.has("language_code")).toBe(false);
      expect(parsed.searchParams.has("secondary_languages")).toBe(false);
    },
    supportsHints: true,
    assertHints: (_socket, url) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get("language_code")).toBe("en");
      expect(parsed.searchParams.getAll("secondary_languages")).toEqual(["hi"]);
    },
  },
  {
    name: "AssemblyAI",
    model: "universal-3-6-pro",
    create: (socket, onUrl) =>
      new AssemblyAiSttProvider({
        apiKey: "test",
        webSocketFactory: (url) => {
          onUrl(url);
          queueMicrotask(() =>
            socket.emit("message", Buffer.from('{"type":"Begin","id":"policy"}')),
          );
          return socket as never;
        },
      }),
    assertFixedLanguage: (_socket, url) => {
      expect(new URL(url).searchParams.get("language_codes")).toBe(JSON.stringify(["hi"]));
    },
    assertLegacyLanguage: (_socket, url) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get("prompt")).toBe("Transcribe hi_IN.");
      expect(parsed.searchParams.has("language_codes")).toBe(false);
    },
    assertAutoLanguage: (_socket, url) => {
      expect(new URL(url).searchParams.has("language_codes")).toBe(false);
    },
    supportsHints: true,
    assertHints: (_socket, url) => {
      expect(new URL(url).searchParams.get("language_codes")).toBe(JSON.stringify(["en", "hi"]));
    },
  },
  {
    name: "Soniox",
    model: "stt-rt-v5",
    create: (socket, onUrl) =>
      new SonioxSttProvider({
        apiKey: "test",
        webSocketFactory: (url) => {
          onUrl(url);
          return socket as never;
        },
      }),
    assertFixedLanguage: (socket) => {
      expect(JSON.parse(socket.sent[0] ?? "{}")).toMatchObject({
        language_hints: ["hi"],
      });
    },
    assertLegacyLanguage: (socket) => {
      const config = JSON.parse(socket.sent[0] ?? "{}");
      expect(config.language_hints).toEqual(["hi_IN"]);
      expect(config).not.toHaveProperty("language_hints_strict");
    },
    assertAutoLanguage: (socket) => {
      expect(JSON.parse(socket.sent[0] ?? "{}")).not.toHaveProperty("language_hints");
    },
    supportsHints: true,
    assertHints: (socket) => {
      expect(JSON.parse(socket.sent[0] ?? "{}")).toMatchObject({
        language_hints: ["en", "hi"],
      });
    },
  },
];

const fixedHindi: SttLanguagePolicy = { mode: "fixed", language: "hi-IN" };
const automaticLanguage: SttLanguagePolicy = { mode: "auto" };
const languageHints: SttLanguagePolicy = { mode: "hints", languages: ["en-US", "hi-IN"] };
const bestEffortLanguageHints: SttLanguagePolicy = {
  mode: "hints",
  languages: ["en-US", "hi-IN"],
  strictness: "best_effort",
};
const assemblyAiMaximumLanguageHints: SttLanguagePolicy = {
  mode: "hints",
  languages: [
    "af",
    "ar",
    "ca",
    "da",
    "de",
    "en",
    "es",
    "et",
    "fa",
    "fi",
    "fr",
    "gl",
    "he",
    "hi",
    "it",
    "ja",
  ],
};

async function openWithPolicy(
  adapter: LanguagePolicyAdapter,
  policy: SttLanguagePolicy,
): Promise<{ socket: PolicySocket; url: string }> {
  const socket = new PolicySocket();
  let url = "";
  const provider = adapter.create(socket, (value) => {
    url = value;
  });
  await provider.open({
    sessionId: "stt_language_policy" as never,
    format: PCM16_16K_MONO,
    model: adapter.model,
    interimResults: true,
    languagePolicy: policy,
  });
  return { socket, url };
}

async function openWithLegacyLanguage(
  adapter: LanguagePolicyAdapter,
  language: string,
): Promise<{ socket: PolicySocket; url: string }> {
  const socket = new PolicySocket();
  let url = "";
  const provider = adapter.create(socket, (value) => {
    url = value;
  });
  await provider.open({
    sessionId: "stt_legacy_language" as never,
    format: PCM16_16K_MONO,
    model: adapter.model,
    interimResults: true,
    language,
  });
  return { socket, url };
}

describe("STT language policy declarations and wire mapping", () => {
  it.each(adapters)("$name preserves the legacy raw STT language field", async (adapter) => {
    const { socket, url } = await openWithLegacyLanguage(adapter, "hi_IN");
    adapter.assertLegacyLanguage(socket, url);
    socket.close();
  });

  it.each(adapters)("$name declares fixed Hindi and vocabulary support", ({ create, model }) => {
    const provider = create(new PolicySocket(), () => undefined);
    expect(provider.supportsSttLanguagePolicy?.(fixedHindi, model)).toBe(true);
    expect(provider.supportsSttVocabulary?.(["TVIC"], model)).toBe(true);
  });

  it.each(adapters)("$name serializes fixed Hindi to its native request field", async (adapter) => {
    const { socket, url } = await openWithPolicy(adapter, fixedHindi);
    adapter.assertFixedLanguage(socket, url);
    socket.close();
  });

  it.each(adapters)(
    "$name applies auto language policy according to its protocol",
    async (adapter) => {
      const { socket, url } = await openWithPolicy(adapter, automaticLanguage);
      adapter.assertAutoLanguage(socket, url);
      socket.close();
    },
  );

  it.each(adapters)(
    "$name declares whether language hints are supported",
    ({ create, model, supportsHints }) => {
      const provider = create(new PolicySocket(), () => undefined);
      expect(provider.supportsSttLanguagePolicy?.(languageHints, model)).toBe(supportsHints);
    },
  );

  it.each(adapters.filter((adapter) => adapter.supportsHints))(
    "$name maps language hints into its native protocol",
    async (adapter) => {
      const { socket, url } = await openWithPolicy(adapter, languageHints);
      adapter.assertHints?.(socket, url);
      socket.close();
    },
  );

  it("sends the full TVIC language-hint limit to AssemblyAI", async () => {
    const assemblyAi = adapters.find((adapter) => adapter.name === "AssemblyAI");
    expect(assemblyAi).toBeDefined();
    const { socket, url } = await openWithPolicy(assemblyAi!, assemblyAiMaximumLanguageHints);

    expect(new URL(url).searchParams.get("language_codes")).toBe(
      JSON.stringify(assemblyAiMaximumLanguageHints.languages),
    );
    socket.close();
  });

  it.each(adapters)(
    "$name only accepts Soniox best-effort hint strictness when supported",
    async (adapter) => {
      const provider = adapter.create(new PolicySocket(), () => undefined);
      const supported = adapter.name === "Soniox";
      expect(provider.supportsSttLanguagePolicy?.(bestEffortLanguageHints, adapter.model)).toBe(
        supported,
      );
      if (supported) {
        const { socket } = await openWithPolicy(adapter, bestEffortLanguageHints);
        expect(JSON.parse(socket.sent[0] ?? "{}")).toMatchObject({
          language_hints: ["en", "hi"],
          language_hints_strict: false,
        });
        socket.close();
        return;
      }
      let socketFactoryCalls = 0;
      const rejectingProvider = adapter.create(new PolicySocket(), () => {
        socketFactoryCalls += 1;
      });
      await expect(
        rejectingProvider.open({
          sessionId: "stt_language_policy" as never,
          format: PCM16_16K_MONO,
          model: adapter.model,
          interimResults: true,
          languagePolicy: bestEffortLanguageHints,
        }),
      ).rejects.toMatchObject({ category: "validation" });
      expect(socketFactoryCalls).toBe(0);
    },
  );

  it("maps public Odia BCP-47 to Sarvam's vendor-specific code", async () => {
    const socket = new PolicySocket();
    let openedUrl = "";
    const provider = new SarvamSttProvider({
      apiKey: "test",
      webSocketFactory: (url) => {
        openedUrl = url;
        return socket as never;
      },
    });
    await provider.open({
      sessionId: "stt_language_policy" as never,
      format: PCM16_16K_MONO,
      model: "saaras:v4",
      interimResults: true,
      languagePolicy: { mode: "fixed", language: "or-IN" },
    });
    expect(new URL(openedUrl).searchParams.get("language-code")).toBe("od-IN");
    socket.close();
  });

  it("passes Deepgram's legacy language through with an explicitly unknown model", async () => {
    const socket = new PolicySocket();
    let openedUrl = "";
    const provider = new DeepgramSttProvider({
      apiKey: "test",
      allowUnknownModel: true,
      webSocketFactory: (url) => {
        openedUrl = url;
        return socket as never;
      },
    });
    await provider.open({
      sessionId: "stt_unknown_model_language" as never,
      format: PCM16_16K_MONO,
      model: "host-model",
      allowUnknownModel: true,
      interimResults: true,
      language: "es",
    });
    expect(new URL(openedUrl).searchParams.get("model")).toBe("host-model");
    expect(new URL(openedUrl).searchParams.get("language")).toBe("es");
    socket.close();
  });

  it("uses AssemblyAI's legacy prompt hint on a non-Universal-3 model", async () => {
    const socket = new PolicySocket();
    let openedUrl = "";
    const provider = new AssemblyAiSttProvider({
      apiKey: "test",
      webSocketFactory: (url) => {
        openedUrl = url;
        queueMicrotask(() => socket.emit("message", Buffer.from('{"type":"Begin"}')));
        return socket as never;
      },
    });
    await provider.open({
      sessionId: "stt_legacy_assemblyai_language" as never,
      format: PCM16_16K_MONO,
      model: "universal-streaming-english",
      interimResults: true,
      language: "fr",
    });
    expect(new URL(openedUrl).searchParams.get("prompt")).toBe("Transcribe fr.");
    expect(new URL(openedUrl).searchParams.has("language_codes")).toBe(false);
    socket.close();
  });

  it("declares model-specific limits instead of advertising ignored controls", () => {
    const deepgram = new DeepgramSttProvider({ apiKey: "test" });
    const cartesia = new CartesiaSttProvider({ apiKey: "test" });
    const sarvam = new SarvamSttProvider({ apiKey: "test" });
    const assemblyAi = new AssemblyAiSttProvider({ apiKey: "test" });

    expect(
      deepgram.supportsSttLanguagePolicy?.({ mode: "hints", languages: ["en", "hi"] }, "nova-2"),
    ).toBe(false);
    expect(
      cartesia.supportsSttLanguagePolicy?.({ mode: "hints", languages: ["en", "hi"] }, "ink-2"),
    ).toBe(false);
    expect(sarvam.supportsSttVocabulary?.(["TVIC"], "saaras:v3")).toBe(false);
    expect(assemblyAi.supportsSttLanguagePolicy?.(fixedHindi, "universal-streaming-english")).toBe(
      false,
    );
  });
});
