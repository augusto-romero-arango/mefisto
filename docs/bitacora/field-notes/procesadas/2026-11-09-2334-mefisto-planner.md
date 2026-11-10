---
fecha: 2026-11-09
hora: 23:34
sesion: mefisto-planner
tema: Refinar #2496-#2501 y crear #2504/#2505 (effort por agente) refinar #2493 (mef-abrir en herdr) #2472 (TIMEOUT tras exito declarado) #2502 (colision de nombres de agente herdr) #2506 (hook del mod y clasificador de auto mode) #2507 (diagnostico de warnings-diff.sh) y #2468 (gate por SHA tras deploy ajeno)
---

## Contexto
Refinamiento de seis borradores de la serie de effort por agente (#2495-#2501) y de los bugs #2493 (`herdr-workspace.sh`) #2472 (TIMEOUT de agentes terminados) #2502 (nombres de agente herdr) #2506 (reescritura del hook de `mefisto-divine-wager`) #2507 (`warnings-diff.sh`) y #2468 (guarda de deploys ajenos del smoke de dominio).

## Descubrimientos
- El adaptador Claude del runtime no tenia prefijo `env`; solo OpenCode lo usa (`OPENCODE_CONFIG_DIR`).
- Los tests de adaptadores, runner y generador interno viven en `.claude/scripts/tests/`, no en `src/runtime/tests`.
- `run.started` aparece tambien en fixtures fuera del contrato (`scripts/tests/fixtures/`).
- `dist/claude` y `dist/opencode` copian `src/runtime/*` via `generate-published-adapters.sh`; el gate de neutralidad (`published-adapters-check`) exige regenerar en el mismo PR (precedente #2262). Tambien afecta a #2495 (`mefisto-models.sh`, `models.validate.jq`).
- Lado interno: `adapter_claude_default_model` delega en el runtime. Lado publicado: el renderer es autocontenido (tabla propia + test de paridad).
- Hacer `effort` obligatorio toca fixtures de agente y agentes inline en varios tests, en ambos lados.
- Claude Code baja al nivel soportado mas alto si el modelo no soporta el effort pedido (doc model-config).
- El pipeline interno de tooling no tiene summary JSON por stage (el de `profile`/`requested_model` es del publicado, #2500); su codigo y sus agentes vienen del snapshot en batch aislado.
- El fake devuelve el mismo effort para todos los niveles: los tests distinguen niveles con `fake.efforts.levels`.
- `pr-sync.sh` lanza `implementer`, no el agente `pr-sync`. El TDD resuelve el modelo por stage (despues del worktree), con 4 puntos de invocacion.
- OpenCode `AgentConfig.variant` existe pero "applies only when using the agent's configured model" (config.json oficial). PoC en sandbox (1.18.34): variant sin model no se aplica en una corrida real (`variant: null`); `model#variant` en JSON no se separa; `OPENCODE_CONFIG_DIR` y un plugin con hook `config` inyectan model+variant conservando prompt y permisos; el contexto del plugin trae `worktree`.
- #2493: `herdr-workspace.sh` elige el primer workspace con label = basename del repo; el que herdr crea al abrir un pane en la carpeta no tiene panes de Mefisto y bloquea tanto en consumidor (normalizacion) como en Mefisto (`last_existing` vacio). Usar el pane que invoca como planner no sirve: su shell esta ocupada por el propio script.
- #2472: con `TIMED_OUT=true` el runner descarta el terminal de exito ya traducido. Doc oficial de Claude Code: `-p` "stays open after its result" mientras viva un comando en segundo plano de la conversacion principal (limite 10 min con prompt de texto, o el `timeout` pedido hasta 2 h). El adaptador usa el ultimo `result`.
- #2502: `agent_name_for_role` recorta el slug a 13/14 caracteres (opencode/claude); labels con prefijo comun colisionan. Ningun otro script reconstruye esos nombres.
- #2506: la reescritura `MEFISTO_UI=mod` del hook de `mefisto-divine-wager` es redundante desde #2284 (el wrapper ya elige modo sin pane con `MEFISTO_RUNTIME=claude`, que el adaptador antepone siempre) y rompe la revision del clasificador de auto mode. El par `fausto-blood-pact` no reescribe.
- #2507: los "mas de 20 min" de `warnings-diff.sh` en #1235 eran el timeout de 600 s del comando (que ademas encadenaba `dotnet format` sobre la solucion) mas el limite de 10 min de Claude Code para comandos en segundo plano en `-p`. En 15 corridas de consumidores lo tipico es 14-44 s; 5 terminaron en `ERROR: la base no compila` sin causa, porque el script descarta la consola del build.
- #2468: la guarda de deploys ajenos de `smoke-tests-dominio.yml` solo espera el job `deploy` y deja el warmup en "solo 200"; el host del FA se recicla 33-104 s despues (evidencia del consumidor, sin fuente oficial). #2489 (espera del worker de proyecciones) no cubre el caso.
- El clasificador de permisos de Claude Code bloquea lanzar `claude -p` anidado como prueba de concepto.
- Claude no tiene override de effort por agente en settings (`modelSettings` es por modelo); el frontmatter gana salvo `CLAUDE_CODE_EFFORT_LEVEL`.

## Decisiones
- #2496: `effort` en `run.started` opcional en el schema (precedente `resets_at`), siempre emitido. Claude via `CLAUDE_CODE_EFFORT_LEVEL`, OpenCode via `--variant`.
- #2497: traduccion en `adapter-claude.sh` interno delegando en el runtime; `effort:` tras `model:`; OpenCode sin cambios hasta #2501.
- #2498: tabla propia `published_claude_effort` con test de paridad; `effort:` tras `model:`; OpenCode sin cambios.
- #2499: nivel de fabrica leido de `$SCRIPT_DIR/../agents/<id>.md`, resuelto antes del worktree junto al modelo; merge, reintentos y resume usan el effort del rol.
- #2500 partido: base comun (tabla total de 22 agentes en `_pipeline-common.sh`, helper `resolve_pipeline_agent_effort`, guard de paridad, `requested_effort` en metricas) + tooling/iac/scaffold/pr-sync; el TDD pasa a #2504 (nuevo, depende de #2500).
- #2501: plugin OpenCode publicado autocontenido (`plugins/mefisto-efforts.js`, hook `config`) que inyecta model+variant solo si `.mefisto/models.json` fija modelo local (decision del usuario); Claude: limitacion documentada (decision del usuario). Lado interno partido a #2505.
- #2493: adoptar el workspace sin panes de rol de Mefisto y montar todas las filas debajo del pane raiz, que queda como shell (decision del usuario); preferir el workspace con filas si hay varios con el mismo label. Label `bug`.
- #2472: el runner detecta en vivo el exito declarado y, tras una gracia (default 120 s), pide al watchdog SIGTERM al grupo; en timeout respeta un exito previo (decision del usuario). La lentitud de `warnings-diff.sh` pasa a #2507 (borrador nuevo).
- #2502: hash corto (`cksum` del label, 4 hex) solo cuando el slug se recorta; labels cortos y legacy sin cambio (decision del usuario). Label `bug`.
- #2506: quitar la reescritura y eliminar `withModUi`, alineado con el par; enmendar MEF-ADR-0055 decision 6. Se refino como issue (y no directo, como el resto del trabajo en mods) porque enmienda un ADR. Label `bug`.
- #2507 reorientado al diagnostico (decision del usuario): conservar la consola del build por lado, extracto de errores al fallar y tiempo por fase en stderr; optimizar y diagnosticar `la base no compila` quedan para cuando haya datos. Retitulado.
- #2468: la guarda promueve `expected_sha` cuando un run `Deploy *` del commit desplego con exito el FA de `base_url` (`app-name:` en su workflow); deploy fallido o base_url no `azurewebsites.net` no promueven. Se enmienda MEF-ADR-0031 seccion 4. Label `bug`.
- Correcciones posteriores al paso a listo: nota de `dist/` en #2496 y motivo de OpenCode en #2497.
- #2496-#2501, #2504 y #2505 pasan a `estado:listo` (todos salvo #2496 conservan `bloqueado`). #2493, #2472, #2502, #2506, #2507 y #2468 pasan a `estado:listo` sin bloqueos. #2497 reapuntado: bloquea #2505.

## Descartado
- #2507: cerrar como no reproducible, o esperar una medicion manual en Bitakora.
- #2506: `MEFISTO_UI=mod` explicito en los comandos, senal por otra via, o denegar pidiendo reenvio.
- #2502: hash siempre, o resolver la colision consultando `herdr agent list`.
- #2472: solo respetar el exito en timeout sin cortar antes, o desactivar tareas en segundo plano (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`); doctrina de agentes contra bucles sin tope.
- #2493: usar la raiz como planner cuando esta libre, o solo mejorar el mensaje.
- OpenCode: fijar siempre model por perfil en conversaciones, o no aplicar effort; Claude: copias locales de agentes.
- Hacer `effort` requerido en `run.started` (obligaba a tocar fixtures ajenos e invalidaba logs viejos).

## Preguntas abiertas
- #2472: confirmar a mano que `claude -p` emite `result` antes de esperar las tareas en segundo plano (la doc lo afirma; la PoC no se pudo correr).

## Referencias
Issues refinados: #2496, #2497, #2498, #2499, #2500, #2501, #2493, #2472, #2502, #2506, #2507, #2468
Issues creados: #2504, #2505, #2507
