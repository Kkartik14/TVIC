# TVIC examples

The examples are small applications that show one boundary at a time. Run them
from the repository root after `pnpm install`.

| Example                                                        | Purpose                                           | External services                                            |
| -------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| [Voice mode](./voice-mode/README.md)                           | Browser WebSocket gateway and complete voice loop | None in mock mode; Deepgram, Groq, and Cartesia in live mode |
| [Live call](./live-call/README.md)                             | Inbound Twilio Media Streams gateway              | Twilio and live STT, LLM, and TTS providers                  |
| [STT only](./stt-only/README.md)                               | Standalone STT session over a WAV file            | One STT provider for a smoke test                            |
| [Memory demo](./memory-demo/README.md)                         | Cross-call memory and retention scopes            | None for in-memory mode; PostgreSQL for durable mode         |
| [Persona](./persona/README.md)                                 | Tenant-specific instructions and context          | Mock CRM only                                                |
| [Post-call summarization](./post-call-summarization/README.md) | Work performed after session terminalization      | Offline summarizer in the example                            |
| [Reconnect](./reconnect/README.md)                             | Durable session attachment after reconnect        | In-memory token store in the example                         |

## Which example should I run?

- Start with **voice mode** to see a complete browser loop without provider
  accounts.
- Use **live call** when the user experience must be a phone call.
- Use **STT only** to debug one speech provider without the rest of the pipeline.
- Use **memory demo** before adding cross-call data to a real agent.
- Use **persona** for tenant-specific prompts and context.
- Use **post-call summarization** for CRM or memory work after a call.
- Use **reconnect** when a connection can move between transport instances.

All examples keep credentials and application authorization outside the browser.
The mock examples prove runtime behavior, not paid provider availability.
