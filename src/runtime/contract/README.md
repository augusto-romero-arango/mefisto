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
`cache_read`, `cache_write` y `reasoning`, tambien numero o `null`. Cuando
OpenCode expone ambos contadores, `output` representa la salida visible y
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
`src/internal/scripts/lib/jsonschema-lite.jq` despacha por `kind`, mientras que
este contrato discrimina por `type`. Quien valida una linea comprueba primero
que `.type` pertenezca a `types`, selecciona `definitions[.type]` y pasa esa
definicion al validador. `validate_event_line` de
`.claude/scripts/tests/test-mefisto-run-agent.sh` es la implementacion de
referencia vigente.

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

`src/runtime/mefisto-run-agent.sh` recibe `--agent`, `--cwd`, `--prompt-file`
y `--event-log`; acepta `--runtime`, modelo opaco, system prompt, timeout,
raw/stderr logs, `--events-log`, `--resume-session`, `--effort` y
`--redact-observability`. Este ultimo es opt-in y transforma por igual los
anexos en vivo y el stream final: omite `message`, deja
`tool.started.input_summary` en `null` y reemplaza `error.detail` por el texto
estable `detalle redactado: <error.kind>`. Conserva el terminal, su `type`,
`status`, `error.kind` y el exit del runner. No vuelve seguros `--raw-log` ni
`--stderr-log`: si se combinan, el runner avisa explícitamente que esos destinos
no estan redactados. `--events-log` es opt-in:
el nucleo no deriva rutas de estado. Sus exits son 0 (exito), 64 (uso), 65
(protocolo invalido), 69 (runtime/dependencia), 124 (timeout), o el exit no
cero del adaptador.

`--effort <opaco>` (issue #2496) es un effort ya traducido a nombre nativo:
el runner lo trata como opaco, vacio o ausente significa heredar (no se agrega
nada al argv ni al entorno) y, no vacio, se registra en `run.started.effort`
(string o `null`; campo opcional en el schema). Viaja siempre como 7mo
posicional de `build_cmd`:
`runtime_<id>_build_cmd <agent> <cwd> <prompt_file> <model> <system_file>
[<resume_session_id>] [<effort>]` (vacio si no hubo `--effort`; un adaptador
que no lo lea sigue siendo valido). Cada adaptador lo aplica a su manera: el de
Claude Code antepone `env CLAUDE_CODE_EFFORT_LEVEL=<valor>` al argv (la variable
prevalece sobre el campo `effort` del frontmatter del agente, que el flag no
logra), el de OpenCode agrega `--variant <valor>` y el fake agrega
`--fake-effort <valor>`.

`src/runtime/mefisto-run-agent.sh` crea un directorio de trabajo por corrida
(`mktemp -d`) y lo expone en la variable global `MEFISTO_RUNTIME_WORK_DIR`
(ruta absoluta) ANTES de invocar `build_cmd`; lo borra al terminar la
corrida. `runtime_<id>_build_cmd` puede ademas fijar la variable global
`MEFISTO_RUNTIME_STDIN_FILE` con la ruta absoluta de un archivo regular
legible: `lib/mefisto-process.sh` conecta ese archivo a la entrada estandar
del proceso invocado, en vez de `/dev/null` (comportamiento por defecto
cuando la variable queda vacia o sin fijar -- byte a byte igual a antes de
este canal). No esta sujeto a `ARG_MAX` (issue #1447; incidente de #1407: un
prompt de 3.237.916 bytes en el argv supero el limite del host y el kernel
rechazo el `exec` antes de que el runtime arrancara -- `duration_ms: 0`,
`session_id: null`, sin tokens). Un adaptador que necesite transportar un
prompt arbitrariamente grande lo materializa dentro de
`MEFISTO_RUNTIME_WORK_DIR` y apunta `MEFISTO_RUNTIME_STDIN_FILE` ahi; este
runner valida, antes de lanzar el proceso, que la ruta declarada sea un
archivo regular legible, y aborta con exit 69 si no lo es. El aislamiento de
#943 se conserva sin condiciones: un archivo regular nunca es TTY, asi que
conectarlo a stdin no reintroduce SIGTTIN/SIGTTOU.

Cada `lib/runtime-<id>.sh` implementa `runtime_<id>_is_available` (probe sin
leer credenciales), `runtime_<id>_build_cmd` y `runtime_<id>_translate`; puede
implementar `runtime_<id>_supports_resume`,
`runtime_<id>_interactive_refresh` y `runtime_<id>_default_model <profile>`.
`runtime_<id>_interactive_refresh` no recibe argumentos y es opcional: si
conoce una estrategia, retorna 0 e imprime por stdout exactamente una linea con
una de estas dos formas: `prompt <texto>` para inyectar `<texto>` como entrada
en una sesion interactiva viva, o `restart <comando-de-salida>` para enviar ese
comando, esperar a que termine el proceso y relanzar el runtime en el mismo
pane. La ausencia de la funcion significa "este runtime no sabe refrescarse: el
consumidor omite el pane". Un adaptador de prueba puede simular el mismo caso
retornando un valor distinto de cero sin imprimir. La ausencia de
`runtime_<id>_default_model` significa heredar el modelo activo. El resolutor
respeta `--runtime` ->
`MEFISTO_RUNTIME` -> autodeteccion. Esta ultima escanea adaptadores y ejecuta
sus probes: un runtime nuevo no exige modificar el runner ni el resolutor.

El id `<agent>` es opaco para el runner y obligatorio en su interfaz. Los dos
adaptadores reales lo entregan al CLI como `--agent <id>` (Claude Code y
OpenCode), para que cada runtime cargue el frontmatter, la doctrina y los
permisos del agente seleccionado. El adaptador `fake` lo recibe pero lo ignora,
pues solo modela escenarios de prueba. En Claude Code, un `--model` explicito
que el runner entrega gana sobre `model:` del frontmatter; si el runner no
entrega modelo, el runtime aplica el declarado por el agente.

Ninguno de los dos adaptadores reales pone el prompt en argv (issue #1448):
ambos lo transportan por el canal de stdin de la seccion anterior. Claude Code
fija `MEFISTO_RUNTIME_STDIN_FILE` directo a `<prompt_file>`, sin releerlo, y
recibe el system prompt como `--append-system-prompt-file <system_file>` (la
RUTA, nunca el contenido). OpenCode no tiene un flag equivalente para el
system prompt ni para el mensaje: materializa
`<MEFISTO_RUNTIME_WORK_DIR>/opencode-message.md` con `system + "\n\n" +
prompt` (o solo `prompt` sin system-file) y apunta `MEFISTO_RUNTIME_STDIN_FILE`
ahi, porque `opencode run` concatena mensaje posicional y stdin cuando llegan
los dos (`resolveRunInput`, `packages/opencode/src/cli/cmd/run.ts`,
verificado en 1.18.29) -- cualquier texto en argv corromperia el mensaje que
recibe el modelo.

`lib/mefisto-process.sh` es la fuente unica del watchdog: ejecuta el argv sin
`eval`, separa stdout/stderr y crea una sesion sin TTY de control. El runner
decide timeout mediante la senal del watchdog y su reloj de pared conforme a
MEF-ADR-0031.

## Mapping de modelos

`models.validate.jq` valida el mapping abierto que entrega cada caller al
resolutor `lib/mefisto-models.sh`. La forma es `<runtime-id> -> {profiles,
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

El mapping de modelos rige en los pipelines (resolutor + `--variant`/`effort`
por corrida). Cuando el usuario **conversa** con un agente fuera de un
pipeline, cada runtime lo aplica distinto (MEF-ADR-0050):

- **OpenCode**: el agente hereda el modelo interactivo y `variant` solo rige
  si el agente fija su propio `model`, asi que el effort de fabrica no aplica
  por si solo. El plugin generado `plugins/mefisto-efforts.js` inyecta
  `agent.<id>.{model,variant}` **solo si** `.mefisto/models.json` del
  repositorio fija modelo para ese agente (`opencode.agents.<id>` u
  `opencode.profiles.<perfil>`). Sin modelo local no inyecta nada. Nivel:
  `opencode.efforts.agents.<id>` > fabrica; nativo:
  `opencode.efforts.levels.<nivel>` > tabla embebida del adaptador (misma que
  `runtime_opencode_default_effort`, con test de paridad). Un nivel fuera del
  vocabulario omite ese agente (`efforts_level_invalid`); si la config del
  usuario ya fija `model` o `variant` del agente no se sobreescribe
  (`efforts_config_conflict`); un mapping ilegible o de forma invalida no
  inyecta nada (`efforts_mapping_invalid`). Nunca interrumpe el arranque. En un
  worktree sin `.mefisto/models.json` no inyecta nada: los pipelines ya pasan
  `--variant`.
- **Claude Code**: la conversacion usa el effort de fabrica del frontmatter
  del agente, que gana sobre `--effort`, `/effort` y los settings. El ajuste
  de `.mefisto/models.json` rige solo en pipelines; no existe override por
  agente en settings. La unica via para una conversacion es la variable de
  entorno `CLAUDE_CODE_EFFORT_LEVEL`, global (todos los agentes) y la unica que
  gana sobre el frontmatter.
