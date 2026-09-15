# Providers, models, and API keys

TVIC separates the four live stages. You choose one provider for each required
role:

| Role      | Built-in options                                        | 1.0.0 maturity |
| --------- | ------------------------------------------------------- | -------------- |
| Transport | Web Client Audio, inbound Twilio Media Streams          | Stable         |
| STT       | Deepgram, Sarvam, ElevenLabs Scribe, AssemblyAI, Soniox | Experimental   |
| LLM       | OpenAI Responses                                        | Experimental   |
| TTS       | Cartesia, ElevenLabs                                    | Experimental   |

`experimental` means TVIC has deterministic contract coverage, but the adapter has
not yet received enough credentialed live-service evidence for TVIC to call it
stable. The machine-readable labels are exported as `PROVIDER_STABILITY`.

## Credentials

Pass a key explicitly or set the provider's environment variable:

| Provider           | Environment variable                    |
| ------------------ | --------------------------------------- |
| Deepgram           | `DEEPGRAM_API_KEY`                      |
| Sarvam             | `SARVAM_API_KEY`                        |
| ElevenLabs STT/TTS | `ELEVENLABS_API_KEY`                    |
| AssemblyAI         | `ASSEMBLYAI_API_KEY`                    |
| Soniox             | `SONIOX_API_KEY`                        |
| OpenAI Responses   | `OPENAI_API_KEY`                        |
| Cartesia           | `CARTESIA_API_KEY`, `CARTESIA_VOICE_ID` |

Explicit credentials take precedence over environment variables. Missing or
whitespace-only credentials fail during agent configuration, before a live session
is created. TVIC does not load `.env` files itself; use your application's config
loader or export the variables before starting Node.

Keep credentials on the server. Never put provider keys in browser JavaScript,
browser session tokens, event payloads, or logs.

## Models and voices

Models are selected independently for STT, LLM, and TTS. TTS also requires a voice
ID. Current catalog defaults are:

| Provider          | Default model        | Optional voice        |
| ----------------- | -------------------- | --------------------- |
| Deepgram          | `nova-3`             | None                  |
| Sarvam            | `saaras:v3`          | None                  |
| ElevenLabs Scribe | `scribe_v2_realtime` | None                  |
| AssemblyAI        | `u3-rt-pro`          | None                  |
| Soniox            | `stt-rt-v5`          | None                  |
| OpenAI Responses  | `gpt-4.1-mini`       | None                  |
| Cartesia          | `sonic-3`            | `CARTESIA_VOICE_ID`   |
| ElevenLabs TTS    | `eleven_flash_v2_5`  | `ELEVENLABS_VOICE_ID` |

For a credentialed local check of all listed adapters, use the [local live testing
guide](./local-live-testing.md). A voice ID is account data, so resolve it from the
provider's voice list rather than copying a voice that is unavailable to your
account.

The catalog is dated evidence about what TVIC has tested, not a promise that it is
the vendor's complete current catalog. Built-in adapters reject unknown models by
default. Use the explicit `allowUnknownModel: true` option only for a deliberate
custom or self-hosted deployment.

## Managed configuration

The prompt-first API selects built-in providers like this:

```ts
import { createVoiceAgent } from "voice-runtime";

const agent = createVoiceAgent({
  prompt: "You are a concise scheduling assistant.",
  providers: {
    telephony: { provider: "web-client-audio" },
    stt: { provider: "deepgram", apiKey: process.env.DEEPGRAM_API_KEY },
    llm: { provider: "openai", apiKey: process.env.OPENAI_API_KEY },
    tts: {
      provider: "cartesia",
      apiKey: process.env.CARTESIA_API_KEY,
      voiceId: process.env.CARTESIA_VOICE_ID,
    },
  },
});
```

The agent configuration does not create a transport endpoint. See [Start here](./start-here.md)
and the browser or Twilio examples for the connection lifecycle.

### OpenAI-compatible Responses endpoints

TVIC uses the same OpenAI Responses adapter for an official OpenAI-compatible
endpoint when its request and streaming events match the adapter contract. Groq's
Responses endpoint is one tested example:

```ts
llm: {
  provider: "openai",
  apiKey: process.env.GROQ_API_KEY,
  url: "https://api.groq.com/openai/v1/responses",
  model: "openai/gpt-oss-20b",
  allowUnknownModel: true,
}
```

The `allowUnknownModel` flag is required here because Groq's model catalog is not
TVIC's OpenAI catalog. It opts out of TVIC's dated model-name check; it does not
claim that every model at the endpoint is compatible. See the [local live testing
guide](./local-live-testing.md) for the credentialed check.

## Custom providers

You can pass a constructed provider instance instead of a built-in configuration.
This is the escape hatch for:

- a vendor not included in the catalog;
- a self-hosted or OpenAI-compatible endpoint;
- custom clocks, sockets, or retry behavior;
- provider-specific options not represented by the managed config.

The custom provider must implement TVIC's provider contract and accurately declare
its capabilities. Capability negotiation is part of agent construction so an
unsupported combination fails before a live call starts.
