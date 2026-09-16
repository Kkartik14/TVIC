# voice-runtime documentation

`voice-runtime` is the public Node.js SDK for TVIC, a provider-neutral runtime for
realtime voice agents.

Choose a path based on what you are trying to do. The first path is intentionally
short. The deeper guides explain the boundary and failure behavior after you have
seen a session run.

## Start here

| Goal                           | Read this                                             | What you need                             |
| ------------------------------ | ----------------------------------------------------- | ----------------------------------------- |
| Build your first agent         | [Beginner's guide](./getting-started.md)              | Node.js and an application directory      |
| Build a production voice agent | [Building a voice agent](./building-a-voice-agent.md) | A transport and provider choices          |
| Use an AI coding assistant     | [AI coding agents](./ai-coding-agents.md)             | Claude Code, Codex, or a compatible agent |
| Understand the runtime         | [How it works](./how-it-works.md)                     | Nothing                                   |

## Build

| Goal                                         | Read this                                       |
| -------------------------------------------- | ----------------------------------------------- |
| Choose STT, LLM, TTS, or transport providers | [Providers](./providers.md)                     |
| Accept browser or Twilio traffic             | [Transports](./transports.md)                   |
| Add tools, memory writes, or post-call work  | [Tools and workflows](./tools-and-workflows.md) |
| Add PostgreSQL, Redis, or memory             | [Persistence](./persistence.md)                 |
| Browse the public root exports               | [API reference](./api-reference.md)             |
| Browse runnable applications                 | [Examples](../examples/README.md)               |

## Operate

| Goal                                            | Read this                               |
| ----------------------------------------------- | --------------------------------------- |
| Run tests and paid provider checks              | [Testing](./testing.md)                 |
| Deploy and scale a Node service                 | [Deploying](./deploying.md)             |
| Protect users, tokens, and provider credentials | [Security](./security.md)               |
| Diagnose a failed session                       | [Troubleshooting](./troubleshooting.md) |
| Learn TVIC terms                                | [Glossary](./glossary.md)               |

## Contribute and release

- [Contribution process](../CONTRIBUTING.md)
- [Private security reporting](../SECURITY.md)
- [Release guide](./releasing.md)
- [Release evidence index](./release/README.md)
- [Public API decision record](./decisions/1.1.0-public-api.md)
- [Release evidence](./release/1.1.0-acceptance-evidence.md)
- [Documentation maintenance](./maintaining-docs.md)

## Important boundary

Installing the package does not create a phone number, open a public server, ask
for microphone permission, choose provider accounts, or authorize application
users. Your application owns those boundaries. TVIC coordinates the live voice
session after it receives an authenticated transport connection.

The public package is server-side only. Browser code connects to your Node server;
it does not import `voice-runtime` directly.

## Documentation ownership

- The root README is for repository orientation.
- The package README is the NPM landing page.
- The guides in this directory explain tasks and concepts.
- Example READMEs explain runnable applications.
- Runtime design notes and release evidence are maintainer material.
- Documentation research lives under `refs/` and is not a product contract.
