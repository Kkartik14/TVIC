# Provider author guide

TVIC provider adapters implement the contract for the provider kind they serve.
For text-to-speech, import `TextToSpeechProvider` and related types from the
published `voice-runtime` package. TTS selection hooks are optional. STT, LLM,
and telephony adapters do not need to implement them.

## TTS selection hooks

The runtime calls these optional hooks during agent and per-call preflight.
They should be synchronous, side-effect-free capability checks. They must agree
with the adapter's execution-time validation so preflight does not accept a
request that `synthesize()` or `openSession()` will reject.

| Hook                                                        | Use it when                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| `requiresTtsLanguageForModel(model)`                        | A model needs an explicit language in the resolved call.            |
| `describeTtsLanguageRequirement(selection, context)`        | A composed provider needs to name the model requiring a language.   |
| `requiresTtsVoiceForModel(model)`                           | A model cannot run without a voice selected by the caller.          |
| `supportsTtsLanguage(language, model, voice, context)`      | Language support depends on the configured model or selected voice. |
| `supportsTtsSpeed(speed, model, voice)`                     | Speed support depends on the configured model or selected voice.    |
| `supportsTtsVoiceOverride(voice, model, language, context)` | A voice override is valid only for a particular model or language.  |
| `supportsTtsSelection(selection, context)`                  | Several selection fields must be checked together.                  |
| `maxTtsTextCharacters(model, voice)`                        | Incremental sessions have a provider-specific text submission cap.  |

Use `capabilities.models`, `capabilities.voices`, and
`capabilities.languages` for finite, stable catalogs. Model catalogs are
enforced unless `allowUnknownModel` is enabled. For languages and voices, a
provider hook takes precedence over the corresponding static catalog, so the
hook may accept a value outside that list. Omit a catalog when it is not
exhaustive. `supportsLanguage` can provide a dynamic language check when
language support is independent of TTS voice selection. Implement TTS-specific
hooks for model-specific language or voice rules, dynamic catalogs, speed, and
cross-field constraints. When both `supportsTtsLanguage` and the generic
`supportsLanguage` are present, the TTS-specific hook takes precedence.
When TVIC uses only `capabilities.languages`, a regional tag may match an
entry's parent tag (`en-GB` can match `en`). Implement a language hook when the
provider has regional restrictions that differ from this general BCP-47 rule.

The configured model, voice, and language are defaults. A call may override
them. `supportsTtsSelection` receives the effective selection after defaults
and per-call values are resolved, so it may include configured values. Return
`true` for a supported combination and `false` for one the adapter cannot
execute. `TtsProviderSelectionContext.languageWasCallerSelected` is true only
when the caller supplied the per-call language. A configured language and a
primary provider's default propagated through failover do not count as caller
choices. A `defaults.language` value supplied by the host is an explicit host
default, but it is still not caller-selected. Set
`languageWasExplicitlyConfigured: true` when `configuredLanguage` came from the
host; leave it false when the value is only the adapter's default. That flag
can satisfy a requirement for an explicit language in the resolved call; a
host-supplied `defaults.language` can satisfy it too. An adapter that requires
the end caller to choose the language for each request should inspect
`languageWasCallerSelected` in `supportsTtsSelection()` and enforce that rule
there. Use the context flag when the adapter must distinguish a per-call choice
from a configured host default.
Direct `TtsSynthesisRequest` values can carry the same optional
`selectionContext` hint. The runtime sets it; direct callers may omit it or set
it to reflect the request's language source. Wrappers should preserve the hint
when forwarding a request.

`describeTtsLanguageRequirement()` is an optional diagnostic hook for composed
providers such as failover. It should name the downstream provider and model
whose route needs a language; ordinary adapters can omit it.

`voice-runtime` re-exports `evaluateTtsSelectionCompatibility()` from the core
contracts package. The helper is marked `@internal`: third-party providers
should use the documented hooks as their supported contract because the
helper's API may change. Validate requests the same way at execution.

STT providers opt into related controls through `supportsSttLanguagePolicy`,
`supportsSttVocabulary`, and `supportsSttAgentContext`. Implement only the hooks
the adapter can execute, and make them agree with its open/update behavior.

Avoid network calls, mutable state, and telemetry from these hooks. Fetch
catalogs during provider construction or through an explicit host-controlled
setup step, then pass an immutable snapshot to the provider.

`maxTtsTextCharacters()` applies to each text submission through an incremental
`TtsSession`. The runtime uses a generic bound when a provider does not declare
one. Providers with stricter submission limits should return their limit for
the selected model and voice; complete-text `synthesize()` implementations
should continue validating their own request size.
