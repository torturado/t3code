# Investigación: provider Oh My Pi para T3 Code

Fecha de corte: 2026-08-17. Fuente primaria fijada en el commit [`d1872493752dd085173c38ecd38a1134dabf900f`](https://github.com/can1357/oh-my-pi/commit/d1872493752dd085173c38ecd38a1134dabf900f) de [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi). No se instaló ni ejecutó el binario; los hallazgos proceden del README, código, documentación y `package.json` de ese commit.

## Conclusión ejecutiva

Oh My Pi (OMP) es un fork de Pi con el motor de agente publicado como `@oh-my-pi/pi-coding-agent` y el ejecutable `omp`. Para un adapter de T3, la interfaz externa más interoperable es `omp acp`: Agent Client Protocol (ACP), JSON-RPC 2.0 y NDJSON sobre stdin/stdout, con sesiones, streaming, permisos y filesystem/terminal delegables al cliente. OMP también ofrece `omp --mode rpc`, un protocolo NDJSON propio más amplio en operaciones de historial, modelos, compactación y UI.

La decisión no es sólo de transporte: ACP cubre bien el flujo de agente y las aprobaciones, pero no expone en su superficie estándar un rollback a un entry/turn arbitrario ni compactación o lectura de historial. El RPC propio sí tiene `branch`, `compact`, `get_messages` y paginación, pero obliga a implementar su framing, sus eventos y sus canales de UI/host tools. La integración “completa” de T3 debe convertir esta diferencia en una decisión de arquitectura, no asumir que `session/fork` equivale a `thread.checkpoint.revert`.

## Identidad, instalación y CLI

| Campo                            | Hallazgo                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Nombre de producto               | Oh My Pi / `omp`; el README lo describe como fork de Pi.                                                      |
| Paquete de engine/SDK            | `@oh-my-pi/pi-coding-agent`, versión `17.3.5` en el commit investigado.                                       |
| Binario publicado por el paquete | `omp` → `src/cli.ts`; no hay un binario `pi` en el `bin` del paquete.                                         |
| Runtime                          | Bun `>=1.3.14`; el monorepo declara `bun@1.3.14`.                                                             |
| Instalación recomendada          | `bun install -g @oh-my-pi/pi-coding-agent`.                                                                   |
| Instaladores alternativos        | `curl -fsSL https://omp.sh/install \| sh`, Homebrew `can1357/tap/omp`, Nix, PowerShell para Windows y `mise`. |
| Subcomando ACP                   | `omp acp`.                                                                                                    |

Fuentes: [README, instalación y requisitos](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/README.md#L21-L98), [`packages/coding-agent/package.json`](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/coding-agent/package.json#L1-L100), [`package.json` del workspace](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/package.json#L1-L38).

La instalación por `curl` y los binarios compilados son una superficie remota distinta del paquete npm. Para T3 conviene resolver el ejecutable configurable (`omp` por defecto), comprobarlo con una sonda de versión/protocolo y no asumir que todos los usuarios tienen Bun, aunque el paquete npm sí lo exige.

## Modos de transporte y entry points

| Modo                | Transporte                                      | Uso                                                    | Capacidades relevantes                                                                    |
| ------------------- | ----------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `omp`               | Terminal interactivo                            | TUI                                                    | Herramientas, selector `ask`, `/model`, `/login`, sesiones y UI completa.                 |
| `omp -p`            | Entrada/salida de proceso                       | One-shot                                               | Un prompt y salida; no es una sesión de larga duración para T3.                           |
| SDK                 | In-process                                      | Bun/Node + TypeScript                                  | `createAgentSession`, `SessionManager`, `ModelRegistry`, `AuthStorage` y eventos tipados. |
| `omp --mode rpc`    | NDJSON propio sobre stdin/stdout                | Integración aislada y cross-language                   | Comandos, respuestas, eventos, modelos, sesiones, compactación, host tools y UI RPC.      |
| `omp --mode rpc-ui` | RPC NDJSON + frames `extension_ui_request`      | Host que quiere renderizar tarjetas/selectores/dialogs | El host debe contestar las solicitudes de UI.                                             |
| `omp acp`           | JSON-RPC 2.0 codificado como NDJSON sobre stdio | Editores/hosts ACP                                     | Sesiones, `session/update`, permisos, filesystem, terminal, elicitation y cancelación.    |

El README presenta estos wrappers como TUI, one-shot, SDK, RPC y ACP. `rpc` escribe un objeto JSON por línea; publica un frame `ready`, correlaciona respuestas por `id` y ofrece negociación v2 para frames grandes: v1 limita el frame físico a 1 MiB y v2 puede reensamblar hasta 64 MiB mediante `rpc_chunk`. Un cliente que use RPC debe negociar v2 y validar `chunkId`, índices, cantidad, tamaño, UTF-8 y secuencias interrumpidas.

Fuentes: [README, entry points](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/README.md#L499-L564), [referencia RPC](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/docs/rpc.md#L1-L69), [implementación RPC](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L1-L58).

Hay que distinguir `transport: pi-native` de `models.yml`: no es el IPC del agente, sino un transporte de modelo que envía cada modelo a un gateway compatible con `omp auth-gateway` mediante `POST /v1/pi/stream`. No debe confundirse con ACP, RPC o stdio del proceso.

Fuente: [schema de `models.yml`, transportes de modelos](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/docs/models.md#L88-L105).

## ACP: protocolo y arranque

`omp acp` fuerza `mode: "acp"` y ejecuta el agente sobre stdio. El stdout queda reservado para el protocolo y los logs van a stderr. La implementación local usa un stream bidireccional que serializa cada mensaje como `JSON.stringify(message) + "\\n"`, lee líneas y exige `jsonrpc: "2.0"`; no usa el framing `Content-Length` de LSP.

El repositorio enlaza ACP como especificación de Zed, que redirige al repositorio oficial de [Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol). La especificación oficial estable usa negociación de versión y capacidades opcionales; OMP fija `PROTOCOL_VERSION = 1` y mantiene una reimplementación compatible de la superficie que utiliza, en vez de importar el SDK oficial.

Fuentes: [`acp` command](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/coding-agent/src/commands/acp.ts#L1-L33), [modo ACP sobre stdio](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/coding-agent/src/modes/acp/acp-mode.ts#L1-L48), [NDJSON stream](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/utils/src/acp/stream.ts#L1-L81), [JSON-RPC transport](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/utils/src/acp/transport.ts#L1-L28), [superficie ACP local](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/utils/src/acp/protocol.ts#L1-L35), [SDK TypeScript oficial](https://github.com/agentclientprotocol/typescript-sdk).

El handshake y las sesiones son:

1. El host envía `initialize` con `protocolVersion` y sus `clientCapabilities`.
2. OMP responde con `protocolVersion: 1`, `agentInfo.name: "oh-my-pi"`, título/versiones, métodos de auth y capabilities: `loadSession`, MCP HTTP/SSE, prompt con imágenes/contexto embebido y list/fork/resume/close.
3. `authenticate` acepta `agent` (“usar credenciales locales bajo `~/.omp`”). Si el host anuncia auth por terminal, también se anuncia `terminal`; esa opción relanza la TUI con `--acp-terminal-auth` para que el usuario configure claves/modelos.
4. `session/new` exige un `cwd` absoluto, crea y materializa una sesión persistente, acepta MCP servers y devuelve `sessionId`, modos y opciones de configuración.
5. `session/load` localiza una sesión persistida por id/cwd y reproduce explícitamente su historial antes de devolver sus opciones; `session/resume` reabre/restaura la sesión administrada y emite las actualizaciones bootstrap.
6. `session/list` lista sesiones persistidas, filtrables por cwd y paginadas en páginas de 50; `session/fork` es una extensión marcada como inestable, crea otra sesión desde la sesión persistida actual; `session/close` libera la sesión administrada.

Los tipos ACP incluyen `additionalDirectories`, pero en este commit `AcpAgent` pasa únicamente `cwd` y `mcpServers` al factory y no propaga ese campo al `createSession`. Por tanto, T3 no debe dar por soportado el multi-root ACP sin una prueba o ticket explícito.

Fuentes: [ACP protocol types](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/utils/src/acp/protocol.ts#L140-L305), [capabilities y auth de OMP](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/coding-agent/src/modes/acp/acp-agent.ts#L472-L623), [creación y apertura real de sesiones](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/coding-agent/src/modes/acp/acp-agent.ts#L1038-L1115).

## Prompts, streaming y finalización

El prompt ACP es `session/prompt` con `sessionId` y una lista de `ContentBlock` (`text`, `image`, `resource` y `resource_link` en la conversión de OMP). La respuesta contiene `stopReason`: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal` o `cancelled`, además de uso de tokens cuando está disponible.

Durante el turno OMP envía `session/update` como notificaciones. La superficie incluye:

- `agent_message_chunk` y `agent_thought_chunk` para texto/pensamiento incremental, con `messageId` cuando existe;
- `tool_call` y `tool_call_update`, con estado `pending`, `in_progress`, `completed` o `failed`, input/output bruto, contenido, diffs, terminales y ubicaciones;
- `plan`, `current_mode_update`, `config_option_update`, `available_commands_update`, `session_info_update` y `usage_update`;
- imágenes y mensajes de error como contenido ACP cuando corresponda.

El mapper de OMP traduce `message_update.text_delta` a `agent_message_chunk`, `thinking_delta` a `agent_thought_chunk`, y los eventos de herramientas a start/update/end ACP. La finalización de un `session/prompt` se determina por su respuesta y `stopReason`; el `agent_end` es parte del RPC/SDK, no un evento ACP estándar separado.

Fuentes: [tipos ACP de prompt/update](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/utils/src/acp/protocol.ts#L307-L362), [mapeo de eventos ACP](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/coding-agent/src/modes/acp/acp-event-mapper.ts#L211-L395), [seguimiento y entrega de eventos](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/coding-agent/src/modes/acp/acp-agent.ts#L1219-L1260).

En RPC, stdout mezcla `ready`, `response`, `AgentSessionEvent`, UI requests, host tools/URIs, errores de extensiones, comandos disponibles y side channels. Los eventos incluyen `agent_start`, `turn_start/end`, `message_start/update/end`, tool execution, compaction/retry, cambios de modelo/thinking y `agent_end`. `agent_end.isTerminal === false` no es una finalización verdadera: puede haber mantenimiento o trabajo asíncrono pendiente.

Fuente: [event stream RPC](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/docs/rpc.md#L71-L105), [semántica de `agent_end`](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/docs/rpc.md#L471-L515).

## Aprobaciones y user input

### Aprobaciones de herramientas

OMP clasifica herramientas en tiers `read`, `write` y `exec`, con modos `always-ask`, `write` y `yolo`. `--auto-approve`, `--yolo` y `--approval-mode yolo` fuerzan el modo del proceso. En ACP, la configuración global/proyecto/`--config` sigue aplicando; no existe un campo de política por sesión en `session/new/load/resume`.

Cuando la aprobación del cliente es necesaria, OMP llama al host mediante `session/request_permission` con el `toolCall` y opciones `allow_once`, `allow_always`, `reject_once` y `reject_always`. El cliente devuelve `selected(optionId)` o `cancelled`. OMP transforma el resultado a la decisión interna y una respuesta rechazada, cancelada o no soportada falla cerradamente; no se permite implícitamente.

El README documenta estas rutas ACP: `bash` → `terminal/create` + `terminal/output`, `read` → `fs/read_text_file`, `write` → `fs/write_text_file`, y `edit`/`bash` → `session/request_permission`. El host puede anunciar filesystem y terminal en `initialize`; OMP sólo instala esos bridges cuando la capability existe.

Hay una excepción que debe quedar visible en el modelo de seguridad: en este commit, el plan ACP se autoaprueba si el cliente no anuncia `elicitation.form`, porque OMP no quiere dejar al agente atrapado en plan mode. No es equivalente a “rechazo seguro” y debe decidirse conscientemente en T3.

Fuentes: [política de aprobación](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/docs/approval-mode.md#L1-L58), [reglas ACP y precedencia](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/docs/approval-mode.md#L120-L148), [tipos de permiso ACP](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/utils/src/acp/protocol.ts#L101-L152), [bridge de permisos/terminal](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/coding-agent/src/modes/acp/acp-client-bridge.ts#L25-L154), [rutas README](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/README.md#L551-L564).

### User input

Hay tres caminos distintos:

1. Un mensaje normal del usuario se envía como `session/prompt` con bloques de contenido; no hay un `user-input` ACP separado.
2. `ask` y las UI de extensiones (`select`, `confirm`, `input`, `editor`) usan `elicitation/create` en modo `form` si el cliente anuncia `elicitation.form`.
3. Si el cliente no anuncia formularios, `select`/`input`/`editor` devuelven valor vacío/undefined y `confirm` devuelve `false`; la UI no se sustituye automáticamente por un prompt ACP estándar.

La interfaz local declara también elicitation URL, pero el bridge de UI analizado usa form; la cobertura de URL/auth interactiva debe probarse antes de declararla soporte completo. Para T3, el adapter debe traducir estas respuestas a `respondToUserInput` y conservar la diferencia entre “cancelado”, “sin capability” y una respuesta vacía.

Fuentes: [bridge de elicitation](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/coding-agent/src/modes/acp/acp-agent.ts#L273-L458), [tipos de elicitation](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/utils/src/acp/protocol.ts#L406-L448).

## Interrupción y parada

En ACP, `session/cancel` es una notificación. OMP cancela la suscripción de eventos, llama `AgentSession.abort({ reason: USER_INTERRUPT_LABEL })`, resuelve el prompt con `stopReason: "cancelled"` y espera una barrera de cleanup. Si `abort()` supera el timeout configurado, cierra la sesión administrada para no dejarla registrada como streaming. Un prompt nuevo mientras el anterior sigue activo inicia implícitamente el mismo cleanup.

En RPC, la operación equivalente es `{ "type": "abort" }`; también existen `abort_and_prompt`, `abort_retry`, `abort_bash` y modos de interrupción de la cola. Cerrar stdin dispara el drenaje, rechaza UI/host requests pendientes, dispone la sesión y termina el proceso con código 0. Para parar una sesión de T3 hay que combinar la operación de protocolo con la propiedad del child process y su cierre.

Fuentes: [cancelación ACP](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/coding-agent/src/modes/acp/acp-agent.ts#L682-L740), [cleanup de cancelación](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/coding-agent/src/modes/acp/acp-agent.ts#L897-L950), [comandos de interrupción RPC](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/docs/rpc.md#L107-L173), [cierre por stdin](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/docs/rpc.md#L16-L30).

## Cambio de modelo y catálogo

OMP no tiene una lista estática pequeña que T3 pueda hardcodear. El registry compone, en este orden, el catálogo incluido en `@oh-my-pi/pi-catalog`, `~/.omp/agent/models.yml`, descubrimiento runtime de motores/gateways locales y providers/modelos registrados por extensiones. El README anuncia 60+ providers y alrededor de mil modelos, agrupados como APIs frontier, coding plans, gateways/locales y providers custom.

La disponibilidad depende de que el provider no esté deshabilitado y tenga credenciales resolubles, salvo providers keyless/locales. La identidad siempre es `provider/model-id`. Para un provider custom, `models.yml` permite `baseUrl`, `apiKey`, `api`, headers, `auth`, discovery y `models[]` con `id`, `name`, `contextWindow`, `maxTokens` y metadata de razonamiento/coste. Los APIs de modelo incluyen OpenAI completions/responses, Anthropic messages, Bedrock, Google y otros; son protocolos HTTP del backend de modelo, no transporte del agente.

En ACP, `session/new/load/resume/fork` devuelve `configOptions`. OMP añade una opción `model` de tipo select, construida desde `session.getAvailableModels()`, con valores exactos `provider/model`; `session/set_config_option {configId:"model", value}` llama a `session.setModel` y publica un `config_option_update`. También expone `thinking` y, si está habilitado, `mode`/plan. No hay un método ACP estándar dedicado a “list models”.

En RPC sí existen `get_available_models`, `set_model` y `cycle_model`; `/model`, `omp models [provider]` y `Ctrl+P` sirven para la superficie interactiva. El cambio ACP es de la sesión existente y T3 puede tratarlo como `sessionModelSwitch: in-session`, sujeto a probar si el cambio de API/provider recrea estado interno.

Fuentes: [README, providers/model roles](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/README.md#L335-L392), [providers y disponibilidad](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/docs/providers.md#L1-L52), [schema/merge de modelos](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/docs/models.md#L15-L189), [config options y cambio ACP](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/coding-agent/src/modes/acp/acp-agent.ts#L1545-L1633), [comandos de modelo RPC](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/docs/rpc.md#L124-L145).

## Configuración y autenticación

| Superficie           | Ubicación/precedencia                                                            |
| -------------------- | -------------------------------------------------------------------------------- |
| Config global        | `~/.omp/agent/config.yml` (también carga `config.yaml`).                         |
| Config de proyecto   | `<cwd>/.omp/config.yml` y legacy `<cwd>/.omp/settings.json`.                     |
| Overlay temporal     | Uno o varios `--config <file>`.                                                  |
| Modelos/providers    | `~/.omp/agent/models.yml` o `.yaml`.                                             |
| Credenciales locales | `~/.omp/agent/agent.db`.                                                         |
| Reubicación          | `PI_CODING_AGENT_DIR` mueve config, auth store y demás estado de `~/.omp/agent`. |

La resolución de API key es: override runtime (`--api-key`, no persistido), `models.yml apiKey`, OAuth almacenado/refrescado, key guardada por `/login`, variables de entorno/provider, otros secretos almacenados y resolver custom. OMP carga `.env` con prioridad de proceso, `<cwd>/.env`, `~/.omp/agent/.env`, `~/.omp/.env` y `~/.env`. `/login` y `/logout` son interactivos; en setups headless existe `omp auth-broker login/logout`.

En ACP, `authenticate("agent")` no transporta una clave: sólo valida el método y OMP usa el estado local del proceso. El server de T3 debe decidir explícitamente qué HOME/`PI_CODING_AGENT_DIR`, `config.yml`, `models.yml`, `agent.db`, env y `cwd` hereda el child process. En remoto, esas credenciales permanecen en la máquina que ejecuta el server salvo que se diseñe otra cosa.

Fuentes: [settings y paths](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/docs/settings.md#L13-L25), [precedencia de credenciales](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/docs/providers.md#L27-L56), [SDK/auth priority](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/docs/sdk.md#L147-L202), [auth ACP](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/coding-agent/src/modes/acp/acp-agent.ts#L493-L550).

## Contexto, sesiones persistentes y rollback

El SDK y el TUI usan sesiones file-backed en JSONL append-only. Cada entry tiene `id`/`parentId` y la sesión activa apunta a un leaf; el contexto LLM se reconstruye recorriendo root→leaf. Existen `/resume`, `--resume`, `--continue`, list/open/fork, `/tree` y `/branch`. Compaction guarda un resumen y reconstruye el contexto reteniendo la parte necesaria; el modelo/thinking y otros estados se restauran desde el branch.

En ACP, la cobertura estándar es `session/load`, `session/resume` y el `unstable session/fork`. No existe un método estándar `rollback`, `rewind`, `branch(entryId)`, `compact` ni `get_messages`. `session/fork` no acepta un entry/turn target, sólo el id de sesión y crea desde el estado persistido actual; además falla si la sesión aún no se ha materializado. El API de extensiones que OMP instala en modo ACP conoce `branch`/`navigateTree`, pero eso es una API interna de extensión, no un contrato ACP que T3 deba asumir.

En RPC sí están documentados `switch_session`, `branch {entryId}`, `get_branch_messages`, `compact`, `get_messages` y `get_messages_page`; la paginación usa cursores ligados a sesión, leaf y cantidad de mensajes y requiere tratar `session_busy`/`stale_cursor`. Por eso RPC es el único boundary documentado que permite aproximar el `rollbackThread(threadId, numTurns)` de T3, aunque T3 todavía debe traducir “N turns” a un entry seguro y coordinar el provider-side context/cache.

Fuentes: [SDK file-backed/resume/fork](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/docs/sdk.md#L101-L145), [árbol y reconstrucción de contexto](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/docs/session-tree-plan.md#L7-L25), [operaciones de sesión](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/docs/session-operations-export-share-fork-resume.md#L14-L31), [métodos ACP](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/packages/utils/src/acp/protocol.ts#L233-L305), [historial/branch/compact RPC](https://github.com/can1357/oh-my-pi/blob/d1872493752dd085173c38ecd38a1134dabf900f/docs/rpc.md#L153-L205).

## Comparación con la interfaz de T3

La interfaz de provider de T3 exige `startSession`, `sendTurn`, `interruptTurn`, `respondToRequest`, `respondToUserInput`, `stopSession`, `listSessions`, `hasSession`, `readThread`, `rollbackThread`, `stopAll` y `streamEvents`, además de declarar si el cambio de modelo es `in-session` o no. Los clientes envían comandos de orquestación y el server traduce eventos del adapter a eventos canónicos; no llaman directamente al provider.

Fuentes locales: [arquitectura de providers](./providers.md), [`ProviderAdapter`](../../apps/server/src/provider/Services/ProviderAdapter.ts#L25-L125), [contrato de driver](../../apps/server/src/provider/ProviderDriver.ts#L119-L157), [orquestación de comandos](./providers.md#L42-L54).

| Contrato de T3              | ACP de OMP                                               | RPC de OMP                                           | Decisión/riesgo                                                          |
| --------------------------- | -------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `startSession`              | `initialize` + `session/new` o `session/resume`          | Spawn + `ready` + `get_state`/`switch_session`       | El child process y el `sessionId` ACP deben quedar ligados a `ThreadId`. |
| `sendTurn`                  | `session/prompt`                                         | `prompt`, `steer`, `follow_up`                       | ACP normaliza texto/imágenes; RPC añade semántica de cola.               |
| `streamEvents`              | `session/update`                                         | `AgentSessionEvent` NDJSON                           | Mapear deltas, tool calls, plan, uso y fin terminal.                     |
| `interruptTurn`             | `session/cancel`                                         | `abort`/`abort_and_prompt`                           | Esperar cleanup y cerrar por timeout; no matar por patrón de nombre.     |
| `respondToRequest`          | `session/request_permission`                             | UI request/response o host channel según herramienta | Preservar allow/reject/cancel y fallback fail-closed.                    |
| `respondToUserInput`        | `elicitation/create` form o nuevo `session/prompt`       | `extension_ui_request`                               | No hay un request ACP estándar separado para preguntas de usuario.       |
| `stopSession`               | `session/close` + dispose/child lifecycle                | cerrar stdin, dispose y child                        | Necesita ownership explícito por instancia.                              |
| `listSessions`/`hasSession` | `session/list` + mapa local                              | `get_state`/sesiones RPC + mapa local                | ACP lista persistidas; T3 debe reconciliar procesos vivos.               |
| `readThread`                | No existe en ACP estándar                                | `get_messages`/paginación                            | Decidir si se lee transcript OMP o sólo eventos canónicos de T3.         |
| `rollbackThread`            | No existe; `session/fork` sólo es fork del estado actual | `branch(entryId)`/`switch_session`                   | Gap principal; requiere resolver entry y caches.                         |
| cambio de modelo            | `session/set_config_option` (`model`)                    | `set_model`/`cycle_model`                            | OMP lo soporta en la sesión; publicar `config_option_update`.            |

### Estado observado al iniciar el trabajo

La documentación versionada de T3 enumera cinco drivers (`codex`, `claudeAgent`, `cursor`, `grok`, `opencode`) y explica que un driver nuevo requiere driver + adapter + registro en `BUILT_IN_DRIVERS` ([`providers.md`](./providers.md#L8-L40)). Sin embargo, el worktree cambió durante la investigación y al finalizar ya contiene cambios no committeados que registran `PiDriver` y `OhMyPiDriver` en [`builtInDrivers.ts`](../../apps/server/src/provider/builtInDrivers.ts#L23-L58), añaden los descriptors `pi`/`ohMyPi` con binarios `pi`/`omp` en [`PiProvider.ts`](../../apps/server/src/provider/Layers/PiProvider.ts#L32-L54) y conectan settings/presentación en varias superficies web.

Esos cambios no fueron creados por este informe y se dejaron intactos durante la investigación. Ese estado inicial era explícitamente parcial para OMP: asumía el RPC propio, no negociaba `rpc_chunk` y devolvía “not supported” para rollback y preguntas interactivas. Esos gaps se convirtieron en el mapa Wayfinder y no describen el adapter ACP/RPC que se implementa en esta rama.

Esto es una observación del estado local, no una afirmación sobre `upstream/main`; el trabajo existente se dejó intacto.

## Recomendación para el mapa Wayfinder

Registrar OMP con esta ficha conceptual:

- **driver/provider:** Oh My Pi (`omp`); el slug de T3 debe decidirse como contrato interno (`ohMyPi` es el nombre que ya aparece en el worktree, no un nombre impuesto por el repo oficial);
- **boundary recomendado:** ACP sobre `omp acp` para interoperabilidad, permisos y host filesystem/terminal;
- **boundary alternativo si “full support” exige historial/rollback:** RPC propio con negociación v2, soporte `rpc_chunk`, UI/host tools y todos los comandos requeridos;
- **modelo:** catálogo dinámico, identidad `provider/model`, configuración `models.yml`, cambio en sesión soportado;
- **auth:** credenciales del host OMP (`~/.omp/agent`, `agent.db`, env/broker), sin asumir que `authenticate` aprovisiona secretos;
- **soporte T3:** streaming, interrupt, approvals, user input y model switch son mapeables; `readThread`/`rollbackThread`, multi-root ACP y política de aprobación por sesión requieren diseño/pruebas adicionales.

No conviene declarar simultáneamente ACP y RPC como un único stream: `omp acp` y `omp --mode rpc` son modos de proceso alternativos. Si T3 necesita ambos, debe existir una estrategia explícita de compatibilidad/versionado y ownership, no multiplexar frames incompatibles en stdin/stdout.

## Riesgos que deberían convertirse en tickets

1. **Decisión ACP vs RPC:** documentar qué significa “soporte completo” y si el producto requiere rollback/compact/history; seleccionar boundary y contrato de versionado.
2. **Compatibilidad ACP:** OMP mantiene una reimplementación local de la superficie del SDK oficial; fijar versión ACP, probar initialize/capabilities/permission/elicitation y vigilar drift del repositorio oficial.
3. **Rollback/contexto:** definir la traducción T3 `numTurns` → entry/leaf OMP, qué ocurre con compaction/branch summaries y cuándo se invalidan caches/provider sessions.
4. **Aprobaciones sin UI:** probar clientes sin `elicitation.form`; decidir si el auto-approve de plan ACP es aceptable o si T3 necesita una política propia más estricta.
5. **Multi-root:** `additionalDirectories` aparece en los tipos ACP pero no se propaga al factory de OMP en este commit; abrir prueba/bug antes de prometer workspaces múltiples.
6. **Auth y aislamiento:** decidir HOME/`PI_CODING_AGENT_DIR`, `agent.db`, `models.yml`, `.env`, broker y herencia de environment en local, desktop, remoto/relay y túnel; evitar exponer secretos al cliente.
7. **Framing y backpressure:** RPC v2/`rpc_chunk`, límites de 1/64 MiB, orden/correlación por id, stdout parse errors y drenaje al cerrar stdin.
8. **Identidad y concurrencia:** mapear `ThreadId`/provider instance/ACP session id, sesiones persistidas frente a procesos vivos, fork y reanudación después de reinicio.
9. **Eventos canónicos:** cubrir deltas de texto/thinking, ids de mensajes, tool calls/diffs/terminal output, `agent_end.isTerminal`, retry/compaction y errores sin duplicar finales.
10. **Superficies T3:** añadir configuración/presentación del provider, registro server, contratos, web/desktop/mobile, remote modes, documentación y pruebas focalizadas; el adapter no es suficiente por sí solo.

## Incertidumbres y límites de esta investigación

- `17.3.5` es el metadata del commit fijado; no se verificó que el tarball npm o los instaladores remotos publicados coincidan byte a byte con ese commit.
- La lista exacta de modelos es runtime-dependent: catálogo incluido, auth, `models.yml`, discovery, disabled providers y extensiones pueden cambiarla; no debe copiarse como una lista estática en T3.
- El README de OMP enlaza la antigua ruta `zed-industries/agent-client-protocol`; se usó el repositorio oficial actual de `agentclientprotocol` para la especificación, y el código OMP para el comportamiento real implementado.
- No se probó una sesión ACP/RPC real, login, cancelación, chunks grandes, fork, compaction, cliente sin capabilities ni una instalación limpia. Esos escenarios deben estar en las pruebas del driver antes de afirmar soporte completo.
