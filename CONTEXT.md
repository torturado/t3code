# T3 Code provider context

This context defines the vocabulary for integrating external coding-agent runtimes into T3 Code.

## Provider runtime

**Provider**: The agent runtime that performs work for a T3 Code thread. _Avoid_: Model, driver.

**Driver**: The T3 Code integration boundary for one provider runtime family. _Avoid_: Provider instance, model.

**Provider instance**: A configured, independently addressable use of a driver and its runtime environment. _Avoid_: Provider, account.

**Oh My Pi**: The Pi-compatible external coding-agent runtime targeted by this integration. Its T3 driver kind is `ohMyPi` and its default executable is `omp`. _Avoid_: Pi provider, model.

**Native provider configuration**: Configuration and credentials owned by Oh My Pi rather than duplicated in T3. T3 owns only the executable, per-instance process environment, and isolated runtime directory inputs.

**ACP session**: The long-lived `omp acp` JSON-RPC/NDJSON process session used for T3 lifecycle, prompts, events, permissions, user input, cancellation, and model selection. _Avoid_: Transcript replay.

**Provider continuation identity**: The persisted Oh My Pi session identifier associated with a T3 thread and instance. It is reused for load/resume and is not regenerated from T3 transcript text.

**Provider-native control operation**: An explicit Oh My Pi operation outside the active ACP stream, used only when ACP does not expose a required native capability such as history branching. It is never an automatic transport fallback.
