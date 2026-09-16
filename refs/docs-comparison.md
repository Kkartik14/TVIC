# Documentation comparison

This note records the documentation patterns reviewed while shaping TVIC's
public documentation.

## Sources reviewed

### LiveKit Agents

- Official quickstart: <https://docs.livekit.io/agents/start/voice-ai/>
- Building agents overview: <https://docs.livekit.io/intro/basics/agents/>
- Logic and workflows: <https://docs.livekit.io/agents/logic/>
- Local research README: [livekit-agents README](../local/research/livekit-agents/README.md)
- Local coding-agent instructions: [livekit-agents AGENTS.md](../local/research/livekit-agents/AGENTS.md)

Useful patterns:

- Start with a concrete result and a time expectation.
- Offer a starter project that is complete enough to run.
- Show prerequisites and credentials before the first command that needs them.
- Keep the quickstart separate from concepts, testing, deployment, and API detail.
- Provide separate instructions for coding agents.
- Include tests and operational modes in the main learning path.

### Pipecat

- Official overview: <https://docs.pipecat.ai/overview/introduction>
- Official quickstart: <https://docs.pipecat.ai/pipecat/get-started/quickstart>
- Local research README: [pipecat README](../local/research/pipecat/README.md)
- Local coding-agent instructions: [pipecat AGENTS.md](../local/research/pipecat/AGENTS.md)

Useful patterns:

- The landing page gives users a small number of paths: quickstart, concepts,
  client, and deployment.
- The quickstart includes local development and production deployment.
- Provider credentials, generated project files, and expected output are shown
  before deeper explanations.
- The reference is separate from learning guides.
- Troubleshooting and next steps are part of the quickstart rather than an
  afterthought.
- AI coding-agent files are generated alongside a starter project.

### AI SDK

- Provider selection: <https://ai-sdk.dev/docs/getting-started/choosing-a-provider>
- Provider architecture: <https://ai-sdk.dev/docs/foundations/providers-and-models>

Useful patterns:

- Provider choice is documented as a first-class decision.
- A common interface is explained before provider-specific details.
- Custom provider behavior and compatibility limits are stated explicitly.
- Capability tables make differences visible without requiring source inspection.

## TVIC decisions

TVIC should use the following structure:

1. README for orientation and a short package promise.
2. Beginner guide for a complete first path.
3. Task guides for providers, transports, tools, persistence, testing, and
   deployment.
4. Concepts guide for the runtime model and failure semantics.
5. API reference for exported types and functions.
6. Example READMEs for runnable applications.
7. Separate AI coding-agent instructions.
8. Separate maintainer and release documentation.

The first page must state the server boundary clearly. A prompt configures
behavior, but it does not create a public endpoint, phone number, user identity,
provider credentials, or browser microphone access.

## Documentation quality rules

- Prefer plain words and define STT, LLM, TTS, and transport on first use.
- Lead with an observable result.
- Keep every important code sample tied to a real public export or example.
- State whether a command uses mock services, Docker services, or paid providers.
- Put cost, credential, security, and production warnings next to the command
  that needs them.
- Keep provider maturity labels dated and sourced.
- Keep one canonical source for provider models and stability labels.
- Do not claim browser imports when the package is server-side only.
- Do not claim outbound calls or provider failover when the runtime does not
  execute them.
- Test code examples in CI when practical.
- Scan documentation for em dash characters before merging.
