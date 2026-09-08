---
name: tvic
description: Use when building, configuring, testing, or debugging a voice agent with voice-runtime or TVIC. Covers the prompt-first API, composable runtime, providers, transports, events, persistence, and security boundaries.
---

# TVIC development guidance

Use this skill when the project uses `voice-runtime` or the TVIC runtime. It is
guidance for the coding agent, not a replacement for the host application's
authorization or business rules.

## Start with the installed package

Before suggesting code, inspect the installed `voice-runtime` version and read
`node_modules/voice-runtime/README.md` when it exists. Prefer APIs exported from
the package root. Do not invent exports or copy repository-only imports into a
consumer application.

## Core model

TVIC runs a server-side cascaded voice pipeline:

```text
transport -> speech to text -> turn handling -> language model and tools -> text to speech -> transport
```

The host application supplies an authenticated `CallHandle`, chooses providers,
and owns the HTTP or WebSocket lifecycle. A prompt configures behavior, but a
prompt does not create a phone call, public endpoint, user authentication, or
permission to change business data.

## Managed API

Use `createVoiceAgent` when the application wants TVIC to assemble the standard
speech to text, language model, and text to speech pipeline. Configure every
required provider explicitly. Start a session only after the host has
authenticated the connection and created or received its `CallHandle`.

The managed run is both an event stream and an awaitable final result. Consume
events for live UI, transcripts, errors, and audio state, then await the same run
for the final outcome. Do not assume that audio sent to a socket was heard. Use
the transport's playout acknowledgement when deciding whether a response was
delivered.

## Composable API

Use the lower-level root exports when the application needs to own part of the
pipeline or provide a custom STT, language model, text to speech, telephony,
memory, or durable-store implementation. Preserve TVIC's normalized contracts,
capability declarations, cancellation behavior, and event semantics.

## Providers and models

Use built-in adapters only with their documented provider names, credentials,
models, and maturity labels. Do not describe an experimental adapter as stable.
If a provider or model is not in the built-in catalog, prefer a constructed
custom provider or the explicit unknown-model option rather than silently
changing the user's selection.

## Tools and security

Tools belong to the host application. Validate their inputs and outputs, enforce
authorization and confirmation for irreversible actions, and make retries safe
when an action can be performed twice. Keep provider keys, signing secrets,
database URLs, transcripts, and recordings on the server. Treat caller speech,
transcripts, prompts, tool arguments, and external controller data as untrusted.

## Testing and troubleshooting

For a consumer project, test the exact transport and provider configuration being
used. Mock providers are useful for deterministic tests, but they do not prove a
live provider works. When debugging a missing response, trace the complete path:
authenticated transport, inbound media, transcript finality, completed turn,
model or tool result, synthesized audio, transport receipt, and playout evidence.

When changing a public contract, add a test through the public package entry
point and update the relevant documentation. Report uncertainty instead of
claiming delivery, cancellation, provider stability, or authorization behavior
that the underlying integration does not prove.
