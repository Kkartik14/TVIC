# voice-runtime documentation

`voice-runtime` is the public Node.js SDK for TVIC, a provider-neutral runtime for
realtime voice agents.

If you are new to TVIC, start with [Start here](./start-here.md). It explains the
parts of a voice system in plain language and shows which pieces TVIC owns.

## Choose a path

| Goal                       | Read this                                                                        | What you will provide                                   |
| -------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Understand the system      | [How it works](./how-it-works.md)                                                | Nothing                                                 |
| Learn the vocabulary       | [TVIC glossary](./glossary.md)                                                   | Nothing                                                 |
| Configure AI coding agents | [TVIC skills](./agent-skills.md)                                                 | An explicit install command                             |
| Configure providers        | [Providers, models, and keys](./providers.md)                                    | Provider accounts and credentials                       |
| Run a browser voice demo   | [Browser voice-mode example](../examples/voice-mode/README.md)                   | Node.js; mock mode needs no provider account            |
| Run an inbound phone agent | [Twilio example](../examples/live-call/README.md)                                | Twilio, a public webhook, and live provider credentials |
| Own part of the pipeline   | [Composable API](../packages/voice-runtime/README.md#composable-api)             | A custom provider or application boundary               |
| Add durable state          | [Persistence adapters](../packages/voice-runtime/README.md#persistence-adapters) | PostgreSQL and/or Redis                                 |

## Important boundary

Installing the package does not create a phone number, open a public server, ask
for microphone permission, choose provider accounts, or authorize application
users. Your application owns those boundaries. TVIC coordinates the live voice
session after it receives an authenticated transport connection.

The public package is server-side only. Browser code connects to your Node server;
it does not import `voice-runtime` directly.

## Reference material

- [Published package README](../packages/voice-runtime/README.md)
- [Root repository README](../README.md)
- [Contribution process](../CONTRIBUTING.md)
- [Private security reporting](../SECURITY.md)
