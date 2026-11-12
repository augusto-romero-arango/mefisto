# Contrato de artefactos y ejecucion internos (`src/internal/contract/`)

Esta carpeta contiene el contrato exclusivo del lado interno para
`src/internal/{agents,commands}/` y la configuracion de su generador de
adaptadores. No es un formato para proyectos consumidores (MEF-ADR-0019).

El vocabulario, schema, taxonomia de fallos, cardinalidad terminal y fixtures
del stream JSONL son parte del nucleo comun y se documentan unicamente en
[`src/runtime/contract/README.md`](../../runtime/contract/README.md).

## Formato de un artefacto

Cada archivo es `src/internal/{agents,commands}/<id>.md`:

```text
---
{ ... objeto JSON ... }
---

Cuerpo Markdown. $ARGUMENTS es el unico placeholder neutral de argumentos.
```

El frontmatter debe ser un objeto valido tanto en JSON como en YAML 1.2. `id`
coincide con el nombre del archivo, usa kebab-case y lleva prefijo `mefisto-`.
El body no nombra runtimes concretos; el generador introduce esas diferencias.
Las excepciones fisicas permanentes son `.claude-plugin/` y
`.claude/scripts/`, esta ultima superficie estable de invocacion interna para
todos los adaptadores.

`internal-artifact.schema.json` es la unica declaracion de campos validos:

| Campo | Aplica a | Regla |
|---|---|---|
| `kind` | ambos | `agent` o `command` |
| `id`, `description` | ambos | obligatorios |
| `profile` | ambos | `fast`, `balanced` o `deep` |
| `capabilities`, `skills` | ambos | listas opcionales |
| `mode` | agente | `primary`, `subagent` o `all` |
| `effort` | agente | obligatorio: `quick`, `light`, `standard`, `thorough` o `exhaustive`; sin default global |
| `agent`, `arguments` | comando | opcionales |

Todos los objetos usan `additionalProperties: false`. Las capacidades forman
el vocabulario `read`, `edit`, `shell`, `web`, `skill`, `task`, `mcp`, `ask` y
expresan intenciones, nunca nombres de tools o claves de permisos.

## Generacion de adaptadores

`src/internal/scripts/generate-internal-adapters.sh` transforma las fuentes
neutrales en `.claude/{agents,commands}/`. Las salidas incluyen un marcador
estable de archivo generado y no se editan a mano. El modo `--check` genera en
memoria, sin escribir nada, y detecta salidas faltantes, distintas, huerfanas o
sin marcador. El `.sh` es un shim: la implementacion vive en
`generate-internal-adapters.mts` y `lib/adapter-claude.mts` (MEF-ADR-0057).

Mapeo principal:

| Campo neutral | Adaptador Claude Code |
|---|---|
| `description` | `description` |
| `mode` | campo del contrato que este adaptador no traduce; se omite |
| `capabilities` | `tools` / `allowed-tools` |
| `skills` | `skills` |
| `agent` de comando | campo del contrato que este adaptador no traduce; el enrutamiento va en el body con `{{mefisto:launch-agent <id>}}` |
| `arguments` | `argument-hint` |
| `profile` | modelo por tabla fija |
| `effort` (agente) | `effort` nativo por tabla fija, justo despues de `model` |

Las dos tablas fijas viven en `lib/adapter-claude.mts` y coinciden con
`defaultModel` y `defaultEffort` de `src/runtime/lib/runtime-claude.mts`;
`generate-internal-adapters.test.mts` las compara.

El mapping de modelos en ejecucion headless vive en los adaptadores y en
`src/runtime/lib/mefisto-models.mts`; el generador no lee `.mefisto/models.json`, porque eso
haria no determinista su `--check`. Una resolucion vacia significa heredar y
el caller omite el flag de modelo.

## Agent Skills internos

La fuente canonica es `src/internal/skills/<id>/` (`SKILL.md` con frontmatter
YAML portable de MEF-ADR-0033, mas recursos de Nivel 3). El generador copia el
directorio a `.claude/skills/<id>/`; en `SKILL.md` inserta el marcador de
generado justo despues del frontmatter (que se conserva verbatim) y los demas
archivos se copian tal cual. `--check` reporta Skills faltantes, distintos,
huerfanos o sin marcador bajo `.claude/skills/`.
`validate-internal-artifacts.sh` exige en cada `SKILL.md`: `name` igual al
directorio, `description` presente y ningun `allowed-tools`. Los Skills no
pasan por la regla de neutralidad de body de agentes/comandos (pueden
documentar un adaptador concreto), pero si por el gate de neutralidad de texto.

### Skills publicados proyectados (issue #2529)

El plugin no se instala sobre si mismo, asi que ningun runtime carga aqui los
Skills de `skills/`. El generador proyecta a `.claude/skills/<id>/` los Skills
publicados de una allowlist explicita (`PUBLISHED_PROJECTED_SKILLS`, hoy solo
`code-comments`), con el mismo tratamiento que los internos: marcador
`GENERADO ... desde skills/<id>/SKILL.md` en `SKILL.md` y recursos de Nivel 3
copiados tal cual. No es una segunda copia mantenida a mano: la fuente sigue
siendo `skills/<id>/` y `--check` detecta cualquier edicion directa. Los
demas Skills publicados (p. ej. `projections`) no se proyectan para que no se
disparen en este repo. Un id presente a la vez en `src/internal/skills/` y en la
allowlist aborta la generacion con un error que nombra el id.

Las directivas de body son el unico escape neutral y una directiva desconocida
aborta la generacion:

| Directiva | Efecto |
|---|---|
| `{{mefisto:launch-agent <id>}}` | Lanza o enruta al agente indicado |
| `{{mefisto:run <script> <args>}}` | Invoca la superficie estable `.claude/scripts/` con el runtime activo |
| `{{mefisto:command-path <id>}}` | Resuelve la ruta de comando propia del adaptador |

La capacidad `mcp` no tiene mapping implicito: el generador aborta hasta que
haya una decision explicita. `neutrality-allowlist.json` registra solo
excepciones permanentes del gate de neutralidad; el schema comun de eventos no
pertenece a esa lista interna.

## Validacion de artefactos

```bash
src/internal/scripts/validate-internal-artifacts.sh [archivo...]
```

Sin argumentos valida `src/internal/{agents,commands}/*.md` y `src/internal/skills/*/SKILL.md` (ver arriba). Extrae el
frontmatter, aplica `internal-artifact.schema.json`, compara `id` con el nombre
del archivo y comprueba la neutralidad del body. El `.sh` es un shim hacia
`validate-internal-artifacts.mts`, que aplica el schema con
`src/internal/scripts/lib/jsonschema-lite.mts`, sin un validador externo. Los
fixtures propios de este contrato permanecen en `fixtures/{valid,invalid}/` y
los ejercita `validate-internal-artifacts.test.mts`.

## Compatibilidad del runner interno

La interfaz ejecutable y de adaptadores vive desde #1045 en el
[contrato comun](../../runtime/contract/README.md). Los archivos homonimos de
`src/internal/scripts/` son shims temporales hasta #1046 y delegan en
`src/runtime/` sin duplicar mecanica. El shim del runner conserva el default
interno `.mefisto/pipeline/events.log`; el nucleo no conoce esa ruta.

Contrato historico que conserva el shim:

```bash
src/runtime/mefisto-run-agent.sh \
  --agent <id> --cwd <dir> --prompt-file <archivo> \
  --event-log <jsonl> \
  [--runtime <id>] [--model <opaco>] [--system-file <archivo>] \
  [--timeout <segundos>] [--raw-log <archivo>] \
  [--stderr-log <archivo>] [--resume-session <id>]
```

Es un proceso con argumentos, exit code y archivo de eventos explicitos. Los
argumentos invalidos terminan con exit 64. Modelo vacio o ausente significa
heredar y no llega como flag al runtime. El runner escribe `run.started`,
delega al adaptador la traduccion del wire format y normaliza el cierre contra
el [contrato comun](../../runtime/contract/README.md).

La seleccion de runtime respeta esta precedencia: `--runtime`,
`MEFISTO_RUNTIME`, autodeteccion. La autodeteccion solo acepta exactamente un
runtime disponible; cero o mas de uno exigen desambiguar. La libreria se
descubre como `$MEFISTO_RUNTIME_LIB_DIR/runtime-<id>.mts`, sin una lista cerrada
de runtimes (MEF-ADR-0050).

### Interfaz de adaptador

Cada `src/runtime/lib/runtime-<id>.mts` exporta (tipos en
`src/runtime/lib/mefisto-runtime.mts`; solo `buildCmd` y `translate` son
obligatorias):

| Funcion | Contrato interno |
|---|---|
| `isAvailable(env, hasCommand)` | Probe local usado solo en autodeteccion; no lee credenciales ni configuracion del proveedor |
| `buildCmd(input)` | Devuelve `{ argv, env?, stdinFile? }` sin pasar por un shell; traduce opciones y omite las vacias. `input.effort` (issue #2496) llega ya en nombre nativo y opaco para el runner, que siempre lo pasa (vacio = heredar); cada adaptador lo aplica con su mecanismo nativo |
| `translate(input)` | Devuelve los eventos del JSONL comun derivados del wire format; nunca emite `run.started` |
| `supportsResume()` | `true` si soporta reanudacion; ausente equivale a no soportada |

El runner siempre entrega exit code y stderr al traductor para distinguir una
muerte por senal o un error que el CLI no escribio en stdout. El traductor
puede ignorarlos. El caller consulta `supportsResume` antes de decidir
reanudar; el runner solo reenvia el identificador opaco a `buildCmd`.

El anexo de eventos no terminales durante una corrida es best-effort y
append-only. Al cierre se detiene el anexo en vivo, se agregan los eventos que
faltan y se normaliza un unico terminal. El watchdog sintetiza timeout; cero o
varios terminales del traductor producen protocolo invalido. Las reglas
completas del stream, incluida la cardinalidad, viven exclusivamente en el
contrato comun.

### Reanudacion y telemetria interna

Tras un hold, el pipeline puede reanudar si el terminal conserva `session_id`
y el adaptador declara soporte. Degrada a una corrida nueva si falta el id, la
capacidad no existe o la sesion reanudada vuelve a morir sin resumen de stage.
El prompt de continuacion es corto y nunca bifurca la sesion. Esta decision
pertenece al caller, no al runner.

`--events-log` es la telemetria legible del pipeline y no debe confundirse con
`--event-log`, que es el JSONL comun. A partir de este ultimo registra actividad
de tools, archivos y el estado del stage. Un fallo de escritura de telemetria
solo produce un aviso: no modifica el exit code ni el terminal ya emitido.
