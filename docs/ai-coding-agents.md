# Building with AI coding agents

TVIC can install project-scoped guidance for Claude Code, Codex, and compatible
agents. The guidance helps an AI coding agent understand the package boundary,
provider configuration, transport authentication, lifecycle semantics, and
testing expectations.

This guide is for developers who use an AI coding assistant to build an
application. The [skills reference](./agent-skills.md) documents every install
flag. The [voice-agent guide](./building-a-voice-agent.md) explains the SDK for
human developers.

## Install the package and skill

Run this from the application directory:

```bash
npm install voice-runtime
npx voice-runtime skills install
```

The installer asks for a `y` confirmation before writing files. It does not
install provider credentials, download arbitrary code, change a home directory,
or run a background hook.

The default targets are:

| Agent                        | Project path                   |
| ---------------------------- | ------------------------------ |
| Claude Code                  | `.claude/skills/tvic/SKILL.md` |
| Codex                        | `.agents/skills/tvic/SKILL.md` |
| OpenRouter-compatible agents | `.agents/skills/tvic/SKILL.md` |

OpenRouter-compatible agents use the shared Agent Skills location. The command
does not install a separate OpenRouter SDK or provider package.

Install selected targets when needed:

```bash
npx voice-runtime skills install --agent claude
npx voice-runtime skills install --agent codex
npx voice-runtime skills install --agent openrouter
```

For automation:

```bash
npx voice-runtime skills install --dry-run
npx voice-runtime skills install --yes
```

Existing files are preserved. Use `--force` only after reviewing the current
file:

```bash
npx voice-runtime skills install --force --yes
```

## Give the agent a useful task

A good request identifies the product goal, transport, providers, and proof of
completion:

```text
Build an inbound browser voice agent for an appointment service.

Use voice-runtime's managed API. Use the Web Client Audio transport, Deepgram
for STT, Groq for the LLM, and Cartesia for TTS. Read credentials only from
environment variables. Do not place secrets in browser code.

Start with the repository's mock voice-mode path, add one appointment lookup
tool with input and output schemas, then add tests for authorization, a failed
provider call, an interrupted reply, and a clean shutdown. Run the relevant
tests, typecheck, build, and lint before reporting completion.
```

Never paste an API key into a coding-agent conversation. Tell the agent the
environment variable name instead.

## Recommended agent workflow

Ask the agent to work in this order:

1. Read `docs/getting-started.md`, `docs/building-a-voice-agent.md`, and the
   relevant transport and provider guides.
2. Inspect the installed package types and the existing example closest to the
   requested use case.
3. Create a mock or deterministic path first.
4. Add provider configuration through environment variables.
5. Add application authorization before exposing a transport.
6. Test the normal path, interruption, hangup, timeout, malformed provider
   response, and shutdown path.
7. Run the package and application checks.
8. Explain which provider calls were real and which were mocked.

The agent should not invent a transport, provider model, voice ID, or security
boundary. If the requested feature is not part of the public package, it should
say so and propose a composable implementation or an issue.

## Rules the agent must preserve

- `voice-runtime` is server-side only.
- A prompt configures behavior. It does not create a public endpoint or a call.
- Browser and phone connections must be authenticated by the host application.
- Provider credentials stay on the server.
- Tool authorization belongs inside the application's tool executor.
- A sent audio frame is not automatically proof that the caller heard it.
- A cancelled response is not the same as a completed spoken turn.
- One event iterator should consume one run.
- The final run result is the authoritative terminal outcome.
- Mock tests do not prove provider credentials or vendor availability.
- `allowUnknownModel` is an explicit catalog-check opt-out, not a compatibility
  guarantee.

## What the installed skill contains

The installed `SKILL.md` teaches the agent:

- When to use the managed API and when to use the composable API
- How a verified transport produces a `CallHandle`
- How STT, the LLM, tools, and TTS connect
- How provider models and maturity labels work
- How interruption, cancellation, and playout evidence work
- Which authorization and domain actions remain application-owned
- How to test a real transport separately from mocked providers

The skill is a pointer to the package's current guidance. It is not a substitute
for reading the source and running tests when changing a public contract.

## Review an AI-generated change

Before accepting a change, check:

- Does the code import from `voice-runtime` rather than unpublished workspace
  packages?
- Does every live connection authenticate before it reaches the runtime?
- Are API keys read only on the server?
- Does every tool validate identity and authorization?
- Are provider and model choices explicit?
- Is the event stream consumed exactly once?
- Are errors handled through normalized error fields or a deliberate boundary?
- Are timeouts and shutdown behavior tested?
- Does the documentation describe what was actually tested?

Useful repository checks are:

```bash
pnpm lint
pnpm test
pnpm build
pnpm check:public-package
```

Provider smoke tests can incur charges and require credentials. Run them only
when the task calls for a real provider check. See [Testing](./testing.md).
