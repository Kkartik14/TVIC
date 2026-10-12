# TVIC Python client preview

This is a source-installable preview and has not been published to PyPI. Install
it from the TVIC repository root with `python -m pip install ./sdks/python`.

This package connects Python applications to an optional Node.js worker built
with TVIC's open-source `voice-runtime` SDK. The Node worker owns the voice
runtime and provider adapters; Python supplies application tools and receives
events and PCM audio over the versioned WebSocket protocol.

The consumer configures the worker's agents and provider credentials, chooses
its network exposure, and may integrate application authentication. TVIC does
not prescribe a network boundary, add an identity system, or store
agent/provider secrets.

Install from this directory:

```sh
python -m pip install .
```

The worker and protocol setup are documented in the repository's
[multi-language guide](../../docs/multi-language.md). The stable wire contract
is [remote runtime protocol v1](../../docs/protocols/remote-runtime-v1.md).
