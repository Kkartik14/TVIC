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
| `requiresTtsLanguageForModel(model)`                        | A model cannot run without a language selected by the caller.       |
| `requiresTtsVoiceForModel(model)`                           | A model cannot run without a voice selected by the caller.          |
| `supportsTtsLanguage(language, model, voice, context)`      | Language support depends on the configured model or selected voice. |
| `supportsTtsSpeed(speed, model, voice)`                     | Speed support depends on the configured model or selected voice.    |
| `supportsTtsVoiceOverride(voice, model, language, context)` | A voice override is valid only for a particular model or language.  |
| `supportsTtsSelection(selection, context)`                  | Several selection fields must be checked together.                  |

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

The configured model, voice, and language are defaults. A call may override
them. `supportsTtsSelection` receives the effective selection after defaults
and per-call values are resolved, so it may include configured values. Return
`true` for a supported combination and `false` for one the adapter cannot
execute. `TtsProviderSelectionContext.languageWasCallerSelected` is true only
when the caller supplied the per-call language. A configured language and a
primary provider's default propagated through failover do not count as caller
choices. Use this flag with `requiresTtsLanguageForModel()` when the vendor
requires the caller to choose a language. `languageWasExplicitlyConfigured`
distinguishes a host-selected provider default from an adapter default.

`evaluateTtsSelectionCompatibility` is exported from `@tvic/core` because TVIC's
runtime and first-party adapters share it across package boundaries. It is
exported from the published package but marked `@internal`; third-party
providers can use the documented hooks without depending on this helper, whose
API is not covered by the stable provider-author contract. Validate requests
the same way at execution.

STT providers opt into related controls through `supportsSttLanguagePolicy`,
`supportsSttVocabulary`, and `supportsSttAgentContext`. Implement only the hooks
the adapter can execute, and make them agree with its open/update behavior.

Avoid network calls, mutable state, and telemetry from these hooks. Fetch
catalogs during provider construction or through an explicit host-controlled
setup step, then pass an immutable snapshot to the provider.
