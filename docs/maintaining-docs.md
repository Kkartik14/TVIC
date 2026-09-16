# Maintaining documentation

Documentation is part of the public contract. A guide is complete only when a
new developer can understand the boundary, run the relevant command, and know
what the result proves.

## Source of truth

| Information                  | Canonical source                                                 |
| ---------------------------- | ---------------------------------------------------------------- |
| Public exports and types     | `packages/voice-runtime/src/index.ts` and generated declarations |
| Managed agent behavior       | `packages/voice-runtime/src/managed-agent.ts`                    |
| Provider models and maturity | `packages/providers/src/catalog.ts`                              |
| Provider protocol behavior   | The provider adapter and its tests                               |
| Runtime invariants           | `packages/runtime/*.md` and runtime tests                        |
| Security boundary            | `docs/security.md`, transport code, and security tests           |
| Release procedure            | `docs/releasing.md` and the release workflow                     |
| User-facing changes          | `CHANGELOG.md` and GitHub release notes                          |

If prose and executable behavior disagree, fix the prose or the code before
merging. Do not silently document a planned feature as if it were available.

## Public guide rules

- Begin with the user's task and expected result.
- State prerequisites before the first command that needs them.
- Explain whether the path uses mocks, Docker, or paid providers.
- Link to a complete example for network and authentication flows.
- Define STT, LLM, TTS, transport, and playout on first use.
- State which responsibilities remain in the host application.
- Put security and cost warnings beside the relevant command.
- Keep provider stability labels dated and sourced.
- Keep package README content useful when viewed on NPM without the repository.
- Keep maintainer evidence out of the beginner navigation.

## Code example rules

- Import only from the public package root in user-facing examples.
- Use environment variables for secrets.
- Use model and voice IDs that exist in the current catalog or label them as
  placeholders.
- Mark pseudocode clearly when it cannot run as written.
- Prefer a tested example over a shortened fragment when the boundary is easy to
  misunderstand.
- Update the example when a public type, error, provider, or transport changes.

## Provider documentation rules

Every provider entry should state:

- Runtime role
- Required credentials
- Model and voice settings
- Supported transport or protocol
- Stability label
- Catalog verification date
- Official provider documentation
- Live smoke-test command or evidence location
- Known limitations

Do not turn a provider marketing claim into a TVIC capability claim. A passing
contract test proves the adapter shape. A live smoke test proves one configured
provider path at one point in time.

## AI coding-agent rules

Human guides and machine instructions have different jobs. Keep the installed
skill short, direct, and action-oriented. Link it to the canonical guides rather
than copying every detail into `SKILL.md`.

When the public API changes, update:

- The beginner guide
- The human voice-agent guide
- The AI coding-agent guide or installed skill when behavior changes
- The relevant provider or transport guide
- The API reference
- At least one runnable example
- Tests and the changelog

## Review checklist

- Does the guide use the current package name and version policy?
- Are all links valid relative to the file location?
- Are commands runnable from the stated directory?
- Are environment variables named exactly as the code expects?
- Does the guide distinguish mock, local integration, and live testing?
- Are error and shutdown behaviors described honestly?
- Are secrets and personal data excluded?
- Does the Markdown contain no Unicode U+2014 characters?
