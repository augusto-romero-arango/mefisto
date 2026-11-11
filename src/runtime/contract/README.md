# Contratos comunes de runtime (`src/runtime/contract/`)

Esta carpeta es la fuente canonica, comun a callers publicados e internos, del
stream JSONL neutral que describe una ejecucion de agente. El protocolo esta
versionado en `run-events.schema.json`: cada linea es un objeto y valida contra
`definitions[.type]`. El contrato no presupone un runtime, proveedor ni modelo
concretos (MEF-ADR-0049 y MEF-ADR-0050).

## Vocabulario y version

Todo evento lleva `v: 1` y un `type` del vocabulario cerrado declarado en
`types`:

| `type` | Campos propios |
|---|---|
| `run.started` | `ts`, `runtime`, `agent`, `model|null`, `cwd` |
| `message` | `ts`, `role`, `text`, `kind?` (`text` o `thinking`) |
| `tool.started` | `ts`, `tool`, `input_summary|null` |
| `tool.completed` | `ts`, `tool`, `ok`, `duration_ms|null` |
| `run.completed` / `run.failed` | `ts`, `status`, `runtime`, `model|null`, `session_id|null`, `duration_ms`, `tokens`, `estimated_cost_usd|null`, `turns|null`, `denials|null`, `ttft_ms|null`, `api_duration_ms|null`, `error|null`, `resets_at?` |

`tokens` conserva `input` y `output`, ambos numero o `null`, y puede incluir
`cache_read`, `cache_write` y `reasoning`, tambien numero o `null`. Cuando un
runtime expone ambos contadores, `output` representa la salida visible y
`reasoning` queda separado. Claude conserva sin reinterpretar la semantica de
su `output_tokens` en `output`, mapea
`cache_read_input_tokens`/`cache_creation_input_tokens` como cache y deja
`reasoning: null`. Los datos que un runtime no puede informar se representan
con `null`, nunca con un cero ni otro valor inventado. Cada definicion cierra su forma con
`additionalProperties: false`; lo mismo hacen `tokens` y `error`.

`estimated_cost_usd` es una estimacion de equivalencia a tarifas API, no el
costo marginal de una suscripcion (MEF-ADR-0054). Los escritores posteriores
al corte emiten solo ese nombre. Para leer JSONL v1 local previo, el schema
tambien acepta `cost_usd`; es costo reportado legado y no se reinterpreta como
estimacion. Como el validador ligero no soporta `oneOf`, ambos campos son
opcionales en el schema, pero el gate de contrato exige que cada terminal traiga
al menos uno de los dos. No hay protocolo v2 ni doble escritura.

## Relacion entre terminal y estado

Los unicos terminales son `run.completed` y `run.failed`. `type` y `status` no
son dos veredictos independientes: el schema divide deliberadamente el
vocabulario de estados entre ambos.

| Terminal | `status` valido |
|---|---|
| `run.completed` | `success` |
| `run.failed` | `failed`, `timeout`, `protocol_invalid` |

Combinaciones como `run.completed{status:"timeout"}` son invalidas. Una corrida
completa tiene **exactamente un** terminal. La cardinalidad es una invariante
del stream y no puede expresarse en el schema de una linea: el caller debe
contar terminales y rechazar tanto cero como mas de uno (MEF-ADR-0031). Los
eventos no terminales completos se conservan aunque el desenlace sea timeout o
protocolo invalido.

## Taxonomia de `error.kind`

`error` es `null` o un objeto `{kind, detail}`. `kind` pertenece al vocabulario
cerrado siguiente (MEF-ADR-0051):

| `error.kind` | Significado neutral |
|---|---|
| `timeout` | El caller agoto el tiempo permitido |
| `killed` | El proceso termino por una senal externa |
| `api_error` | El proveedor informo un error de API no clasificado en otra familia |
| `rate_limit` | Se agoto una ventana de uso |
| `provider_unavailable` | El proveedor informo indisponibilidad transitoria |
| `stream_cut` | El stream termino antes de declarar un desenlace confiable |
| `nonzero_exit` | El proceso salio distinto de cero sin una causa mas especifica |
| `no_result` | No hubo resultado util del runtime |
| `protocol_invalid` | La traduccion produjo un stream que viola el contrato |

La distincion entre `rate_limit`, `provider_unavailable`, `stream_cut` y las
demas causas preserva la frontera de politica fijada por MEF-ADR-0051; un
caller consume la clasificacion y no vuelve a inferirla desde texto crudo.
`resets_at` es opcional y contiene un instante ISO 8601 o `null`: solo aporta
el fin de la ventana cuando el runtime lo conoce. Que un runtime carezca de esa
senal no cambia la taxonomia ni obliga a inventar el dato.

Un `run.completed` puede conservar excepcionalmente un `error` para registrar
una muerte posterior a que el runtime ya declarara exito. Esto no contradice
`status: "success"`; documenta el incidente posterior sin invalidar evidencia
ya emitida.

## Validacion

El schema no usa `oneOf`: el `oneOf` del validador ligero
`src/internal/scripts/lib/jsonschema-lite.mts` despacha por `kind`, mientras que
este contrato discrimina por `type`. Quien valida una linea comprueba primero
que `.type` pertenezca a `types`, selecciona `definitions[.type]` y pasa esa
definicion al validador. `eventErrors` de
`src/runtime/tests/runner-sandbox.mts` es la implementacion de referencia
vigente.

El validador ligero no soporta uniones de tipos. Por eso los campos
documentados como valor o `null` omiten `type` en su sub-schema. Esta es una
limitacion conocida del toolchain Bash 3.2 + jq existente, no una autorizacion
para que los productores emitan tipos arbitrarios.

## Fixtures

`fixtures/run-events/valid-*.jsonl` contiene corridas validas del contrato
nuevo y no usa `cost_usd`. `legacy-cost-usd.jsonl` identifica expresamente una
lectura v1 previa al corte. Los casos de
limite de uso muestran `resets_at` poblado cuando el runtime ofrece esa senal y
`null` cuando no la ofrece. `invalid-missing-field.jsonl`,
`invalid-unknown-type.jsonl` e `invalid-status-mismatch.jsonl` son rechazables
linea a linea.

`invalid-two-terminals.jsonl` tiene lineas individualmente validas, pero viola
la cardinalidad de exactamente un terminal; existe para comprobar el gate
cross-linea. Los tests recorren todos los fixtures `valid-*` e `invalid-*` sin
mantener una segunda copia del contrato.

## Runner y adaptadores

El runner es `src/runtime/mefisto-run-agent.mts` (MEF-ADR-0057);
`mefisto-run-agent.sh` es el shim con que lo invocan los pipelines en bash.
Recibe `--agent`, `--cwd`, `--prompt-file` y `--event-log`; acepta `--runtime`,
modelo opaco, system prompt, timeout, raw/stderr logs, `--events-log`,
`--resume-session`, `--effort` y `--redact-observability`. Este ultimo es
opt-in y transforma por igual los anexos en vivo y el stream final: omite
`message`, deja `tool.started.input_summary` en `null` y reemplaza
`error.detail` por el texto estable `detalle redactado: <error.kind>`. Conserva
el terminal, su `type`, `status`, `error.kind` y el exit del runner. No vuelve
seguros `--raw-log` ni `--stderr-log`: si se combinan, el runner avisa
explícitamente que esos destinos no estan redactados. `--events-log` es opt-in:
el nucleo no deriva rutas de estado. Sus exits son 0 (exito), 64 (uso), 65
(protocolo invalido), 69 (runtime/dependencia), 124 (timeout sin exito
declarado, ver "Corte tras exito declarado"), o el exit no cero del adaptador.

Mientras el agente corre, su stdout va directo al raw log y el runner lo
traduce cada `MEFISTO_RUN_AGENT_LIVE_INTERVAL` segundos (default `2`) para
anexar a `--event-log` los eventos no terminales nuevos. El terminal,
exactamente uno, se anexa al cierre.

### Interfaz de un adaptador

Un adaptador es el modulo `lib/runtime-<id>.mts`. El runner lo carga por su id
desde `MEFISTO_RUNTIME_LIB_DIR` (por defecto, `lib/`) y usa lo que exporta:

| Export | Obligatorio | Contrato |
|---|---|---|
| `buildCmd(input)` | si | Devuelve `{argv, env?, stdinFile?}`: el argv del CLI, las variables que se suman a su entorno y el archivo regular que viaja por su entrada estandar |
| `translate(input)` | si | Devuelve los eventos neutrales (mensajes, tools y terminal) de la traza cruda; nunca `run.started` |
| `isAvailable(env, hasCommand)` | no | Probe sin leer credenciales; sin el, el adaptador no participa de la autodeteccion |
| `supportsResume(env)` | no | Si el runtime reanuda sesiones |
| `interactiveRefresh(env)` | no | `prompt <texto>` o `restart <comando-de-salida>`; `null` si el runtime no sabe refrescarse |
| `defaultModel(profile, env)` | no | Modelo del perfil (vacio = heredar); `null` si no acepta el perfil |
| `defaultEffort(nivel, env)` | no | Valor nativo del nivel (vacio = heredar); `null` si no lo acepta |

`buildCmd` recibe `{agent, cwd, promptFile, model, systemFile,
resumeSessionId, effort, workDir, env}`. `model`, `resumeSessionId` y `effort`
son opacos para el runner y llegan vacios cuando no se pidieron: vacio
significa heredar y no agrega nada al argv ni al entorno. `workDir` es el
directorio temporal de la corrida, que el runner crea antes de llamar a
`buildCmd` y borra al terminar; el proceso lo recibe ademas en
`MEFISTO_RUNTIME_WORK_DIR`.

`stdinFile` es el canal para un prompt de cualquier tamano: el argv tiene
limite (issue #1447; incidente de #1407: un prompt de 3.237.916 bytes en el
argv hizo que el kernel rechazara el `exec` antes de que el runtime arrancara).
El runner valida, antes de lanzar el proceso, que sea un archivo regular
legible, y aborta con exit 69 si no lo es. Sin `stdinFile` la entrada queda
cerrada. Un archivo regular nunca es TTY, asi que no reintroduce SIGTTIN ni
SIGTTOU (#943).

`translate` recibe `{rawFile, runtime, model, exitCode, stderrFile}`. Durante
la corrida `exitCode` es `null` y `stderrFile` esta vacio; al cierre traen el
codigo de salida y el stderr del proceso, sin los que un adaptador no distingue
una muerte por senal ni el `API Error: <status>` que un CLI escribe solo por
stderr.

`--effort <opaco>` (issue #2496) es un effort ya traducido a nombre nativo y
queda en `run.started.effort` (string o `null`; campo opcional en el schema).
Cada adaptador lo aplica a su manera: el de Claude Code devuelve
`env: {CLAUDE_CODE_EFFORT_LEVEL: <valor>}` (la variable prevalece sobre el campo
`effort` del frontmatter del agente, que el flag no logra) y el fake agrega
`--fake-effort <valor>`.

El id `<agent>` es opaco para el runner y obligatorio en su interfaz. El
adaptador de Claude Code lo entrega al CLI como `--agent <id>`, para que el
runtime cargue el frontmatter, la doctrina y los permisos del agente
seleccionado. El adaptador `fake` lo recibe pero lo ignora, pues solo modela
escenarios de prueba. En Claude Code, un `--model` explicito que el runner
entrega gana sobre `model:` del frontmatter; si el runner no entrega modelo,
el runtime aplica el declarado por el agente.

El adaptador de Claude Code no pone el prompt en argv (issue #1448): devuelve
`stdinFile` apuntando a `<prompt_file>`, sin releerlo, y recibe el system
prompt como `--append-system-prompt-file <system_file>` (la RUTA, nunca el
contenido).

El resolutor respeta `--runtime` -> `MEFISTO_RUNTIME` -> autodeteccion. Esta
ultima recorre los adaptadores y ejecuta sus probes: un runtime nuevo no exige
modificar el runner ni el resolutor.

### Gemelas en bash

Los pipelines en bash cargan con `source` las librerias `lib/*.sh`, que
conviven con sus gemelas `.mts` hasta que esos pipelines se porten; un cambio
va en los dos lados. Cada `lib/runtime-<id>.sh` declara las mismas operaciones
como funciones `runtime_<id>_is_available`, `runtime_<id>_build_cmd`,
`runtime_<id>_translate`, `runtime_<id>_supports_resume`,
`runtime_<id>_interactive_refresh`, `runtime_<id>_default_model <profile>` y
`runtime_<id>_default_effort <nivel>`. Los pipelines consultan de ahi las
capacidades (`supports_resume`, `interactive_refresh`) y las tablas por
defecto; el comando y la traduccion los usa solo el runner, desde el `.mts`.
`runtime_<id>_interactive_refresh` no recibe argumentos: si conoce una
estrategia, retorna 0 e imprime por stdout exactamente una linea con una de
las dos formas de arriba; la ausencia de la funcion significa "este runtime no
sabe refrescarse: el consumidor omite el pane". La ausencia de
`runtime_<id>_default_model` significa heredar el modelo activo.

### Ejecucion vigilada y plataformas

`lib/mefisto-process.mts` lanza el argv sin shell, con stdout y stderr a
archivo, y vigila al proceso: lo corta al agotar `--timeout`, lo termina a
pedido del runner y, si queda detenido, lo reanuda. El runner decide timeout
con dos evidencias, el corte del watchdog y su reloj de pared, conforme a
MEF-ADR-0031.

| | macOS y Linux | Windows |
|---|---|---|
| Aislamiento | Sesion propia, sin terminal de control | Comparte la consola del runner |
| Timeout | `SIGKILL` al grupo de procesos | `taskkill /PID <pid> /T /F` sobre el PID lanzado |
| Terminacion a pedido | `SIGTERM` al grupo y `SIGKILL` 10 s despues | `taskkill /PID <pid> /T /F`, sin paso amable |
| Exit de un proceso matado | 128 mas la senal (137, 143) | Siempre 137 |
| Proceso detenido | Se reanuda con `SIGCONT` | No existe |
| `claude` | El ejecutable del PATH | `claude.exe`, o `claude.cmd` a traves de `cmd.exe` |

En toda plataforma el runner mata solo PIDs que el mismo lanzo, nunca por
nombre. Si el runner recibe `SIGINT`, `SIGTERM` o `SIGHUP`, mata al arbol del
agente, borra su directorio temporal y sale con 130, 143 o 129, sin escribir
terminal. En Windows un runner matado con `taskkill` no llega a hacerlo y el
agente queda sin limite.

### Corte tras exito declarado (issue #2472)

Un agente que ya declaro exito puede seguir vivo (p. ej. por un comando en
segundo plano sin terminar) y, sin este corte, el watchdog lo mataria por
timeout y el pipeline descartaria un resultado bueno. El bucle en vivo del
runner mira el terminal que traduce el adaptador: si es
`run.completed{status:"success"}`, anota el instante (una sola vez). Si el
proceso sigue vivo `MEFISTO_RUN_AGENT_POST_RESULT_GRACE_S` segundos despues
(default `120`, entero >= 1; vacio equivale a no fijarla, y un `0` o un valor
no numerico cae al default con un aviso en stderr), el runner pide terminarlo y
escribe en `--events-log`
`POST-RESULT: <agente> seguia vivo <N>s despues de declarar exito -- SIGTERM`.

El watchdog atiende el pedido en su siguiente rebanada
(`MEFISTO_WATCHDOG_POLL_S`, default `5`) como indica "Ejecucion vigilada y
plataformas". No es un timeout. La corrida cierra con el terminal de exito del
adaptador y exit 0 (el exito declarado manda sobre el exit distinto de cero
posterior).

Si igual se llega al timeout del watchdog y el raw log ya traia un terminal de
exito, el runner usa ese terminal (exit 0) en vez de sintetizar `timeout` y
registra `TIMEOUT tras exito declarado: <agente>` en `--events-log`. Sin exito
declarado el timeout se comporta como siempre (`run.failed{status:timeout}`,
exit 124). Un adaptador que no declara exito antes de salir (MEF-ADR-0050)
conserva el comportamiento de siempre. Si tras el exito un comando en segundo
plano termina dentro de la gracia, el runtime puede abrir otro turno: un corte a
mitad de ese turno conserva el ultimo terminal de exito, y el trabajo del turno
extra puede quedar sin commitear (lo juzga `agent_work_is_trustworthy`).

## Mapping de modelos

`models.validate.jq` valida el mapping abierto que entrega cada caller al
resolutor `lib/mefisto-models.sh`; sus gemelas son `validateModelsMapping`,
`resolveModel` y `resolveEffort` de `lib/mefisto-models.mts`, con las mismas
reglas y los mismos mensajes. La forma es `<runtime-id> -> {profiles,
agents, efforts}` (las tres claves opcionales); `profiles` solo admite `fast`,
`balanced` y `deep`, y cada modelo es un string no vacio (se preservan
espacios). `models.example.json` usa
placeholders y no declara un conjunto cerrado de runtimes.
El placeholder `<runtime-id>` debe sustituirse por un id valido antes de pasar
la plantilla al validador.

`mefisto_resolve_model <runtime> <agent-id> <profile> [explicit-model]
[mapping-file]` conserva el resultado y el motivo de error en
`MEFISTO_RESOLVED_MODEL` y `MEFISTO_MODELS_ERROR`. Su precedencia es override
explicito, agente, perfil, `runtime_<id>_default_model` y herencia (cadena
vacia). Una ruta omitida, inexistente o vacia equivale a no tener mapping; JSON
o forma invalidos fallan como `<archivo>: <campo>: <motivo>`. El nucleo no
deriva la ruta ni consulta estado, Git o cwd.

### Bloque `efforts`

Cada runtime admite ademas `efforts` con dos claves opcionales:
`efforts.agents.<agent-id>` (nivel **neutral** que reemplaza el de fabrica del
agente) y `efforts.levels.<nivel>` (valor **nativo**, string opaco no vacio, que
reemplaza la traduccion del adaptador para ese nivel). El vocabulario neutral es
`quick | light | standard | thorough | exhaustive`; cualquier otro nivel o campo
se rechaza como `<ruta>: <motivo>`.

`mefisto_resolve_effort <runtime> <agent-id> <nivel-fabrica> [mapping-file]`
fija `MEFISTO_RESOLVED_EFFORT` (y lo imprime); el error queda en
`MEFISTO_EFFORTS_ERROR`. Precedencia del nivel: `efforts.agents[<id>]` > nivel
de fabrica del caller (vacio o fuera del vocabulario retorna `1`). Precedencia
del valor nativo: `efforts.levels[<nivel>]` > `runtime_<id>_default_effort
<nivel>` (quick->low, light->medium, standard->high, thorough->xhigh,
exhaustive->max en los adaptadores actuales) > vacio (heredar). Capturar el
resultado con redirect a archivo, nunca con `$(...)`.

### Effort en conversaciones

El mapping de modelos rige en los pipelines (resolutor + `--effort` por
corrida). Cuando el usuario **conversa** con un agente fuera de un pipeline,
rige el mecanismo nativo de cada runtime (MEF-ADR-0050).

En Claude Code la conversacion usa el effort de fabrica del frontmatter del
agente, que gana sobre `--effort`, `/effort` y los settings. El ajuste de
`.mefisto/models.json` rige solo en pipelines; no existe override por agente en
settings. La unica via para una conversacion es la variable de entorno
`CLAUDE_CODE_EFFORT_LEVEL`, global (todos los agentes) y la unica que gana
sobre el frontmatter.
