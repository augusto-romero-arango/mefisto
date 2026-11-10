---
fecha: 2026-10-13
hora: 17:35
sesion: mefisto-planner
tema: Refinar #2409, #2407 (cero warnings nuevos), #2435 (Take = tope + 1 en MEF-ADR-0047), crear #2438 (issue de tests ajustados por el reviewer), #2443 (precedente primero en el planner publicado), la serie #2447-#2450 (parallel sin panes con una banda por desarrollo) y #2451-#2453 (issues con PR abierto fuera del orden de lanzamiento)
---

## Contexto
Refinamiento de los borradores #2409 y #2407, parte de la serie MEF-ADR-0056 (#2404-#2417), y de #2435, defecto de paginacion en MEF-ADR-0047 reportado desde Bitakora.ControlAsistencia. Ademas, el usuario pidio desactivar los issues de revision de tests que crea el pipeline TDD (#2062) por ruido, y que el planner del consumidor investigue precedentes antes de recomendar (caso Bitakora: practica usada en 3 tools MCP ignorada), y que `/parallel` del consumidor deje de abrir un pane por issue y muestre cada desarrollo en la banda de la sesion que lo lanzo, como un sequential. Por ultimo, que los issues con PR abierto sin mergear no se ofrezcan para desarrollar en la consola.

## Descubrimientos
- `tooling-writer`/`tooling-reviewer` son agentes delgados: la receta vive en `STAGE1_PROMPT`/`STAGE2_PROMPT` y ambos agentes restringen la verificacion a "los comandos permitidos en el mensaje inicial". Doctrina nueva en el agente exige tambien autorizarla en el prompt.
- `## Pendiente/bloqueos` del summary del writer de tooling lo extrae el pipeline como motivo de aborto: no sirve para remanentes de warnings.
- El `smoke-test-writer` corre en el stage `2b` y escribe `stage-2b-smoke-test-writer.md`: un glob `stage-2-*.md` no lo ve.
- El gate de salida del `smoke-test-writer` exigia "sin warnings" absoluto, en conflicto con el diferencial de MEF-ADR-0056.
- La politica OpenCode ya permite `${MEFISTO_PACKAGE_ROOT}/scripts/*`.
- MEF-ADR-0047 decision 4 (`Take = tope + 1` + cursor reenviado) choca con MEF-ADR-0042 seccion 2 (el backend ya pide `Take + 1` y arma el cursor con el ultimo devuelto): se pierde un elemento por pagina. El defecto vive solo en el texto del ADR y sus copias en `dist/`.
- El issue de #2062 se dispara con cualquier test que el reviewer modifique, renombre o borre en Stage 3, no solo al destrabar rojos: de ahi el ruido.
- El planner publicado tiene guardrail anti-sinonimos para nombres, pero ninguno para patrones de solucion; no lee los ADRs propios del consumidor y `## Investigacion del planner` es opcional y solo vive en el template de dominio.
- `tmux-pipeline.sh` ya corre desacoplado en el runtime claude (#2285) salvo `--parallel`, excluido "por diseno"; `parallel-pipeline.sh` es el scheduler sin panes pero no escalona arranques ni escribe un status de lote (el sequential si, #2202). MEF-ADR-0055 todavia dice que el modo sin pane del consumidor "queda fuera", aunque #2285 lo implemento.
- El par interno `mefisto-divine-wager` no tiene parallel: la referencia de experiencia es la vista del sequential de la propia consola publicada.
- `next-order.sh` (y su copia interna) no consulta PRs: un `estado:listo` con PR abierto sigue lanzable, y su dependiente tambien. `gh pr list` expone `closingIssuesReferences`; los PRs `cierre:manual` (Refs) se reconocen por la rama `worktree-issue-<n>-`/`infra-issue-<n>-` (interno: `worktree-mefisto-issue-<n>-`).
- Reporte de que `/parallel` seguia abriendo panes tras #2447-#2450 (v0.54.0). Investigacion exhaustiva (transcript `5c0e8dad` del consumidor + docs oficiales): el preambulo Claude de 42 artefactos pregunta por `${CLAUDE_PLUGIN_ROOT:-}`, que no se sustituye y no existe en Bash, asi que siempre cae al marker `.mefisto/pipeline/.plugin-root`, compartido por repo, escrito solo por SessionStart (no por `/reload-plugins`) y no reescrito por el upgrade (#2248). Tras upgrade + `/reload-plugins`, el texto del comando era 0.54.0 y los scripts 0.53.2. Los tests lo ocultaban al exportar la variable al entorno, escenario imposible en Claude Code. Frente con historia: #1054, #1099, #2248, #2249.

## Decisiones
- Nombre comun de seccion para remanentes de escritores: `## Warnings no remediados` (#2407, #2409, leido por #2408).
- Tokens `{{mefisto:package-root}}` y `{{mefisto:state-path ...}}` en los agentes, alineados con #2408.
- #2408 (ya listo) ajustado para leer tambien `stage-2b-*` y buscar esa seccion; comentario de trazabilidad en el issue.
- Test estructural en tooling; el comportamiento de `render_warning_remnants_section` lo cubre #2408.
- Stage `merge` del TDD fuera de alcance de #2407.
- #2435 adopta la regla del consumidor (#1057): catalogo/ventana piden `Take = tope` y deducen "hay mas" de `siguienteCursor`; la desambiguacion conserva `tope + 1`.
- #2438: sin issue; los tests ajustados por el reviewer se listan en una seccion del PR (`render_reviewer_touched_tests_section`). Se borra `create_reviewer_tests_review_issue` y su mencion en MEF-ADR-0055.
- #2443: protocolo "Precedente primero" (interno -> ADRs consumidor+Mefisto -> externo solo sin precedente, anunciando "primera vez"); ADR gana sobre precedente que lo contradice; la recomendada nombra su base; `## Investigacion del planner` obligatoria con `Precedentes:`/`Primera vez:`. Solo planner publicado.
- Parallel: #2448 (lanzamiento desacoplado + escalonado 30 s + enmienda MEF-ADR-0055 d.6), #2447 (`pipeline-status-parallel.json`, forma de #2202), #2449 (lote en curso: cabecera unica con teclas, una banda por corrida con mascota, max 3 con paginacion `0`, cola y tabla), #2450 (lote terminado + `1: mergear` sin `--all`).
- En PR: #2451 (clasificacion (e) en `next-order.sh`, `inPr[]`, dependientes bloqueados con `reason: pr` hasta el merge -- decidido con el usuario), #2452 (consola: filas atenuadas con `PR #X`, sin tecla; `listos N · en PR M`), #2453 (misma regla en la copia interna por la regla de copias hermanas). La consola interna se ajusta directo por el mod, sin issue.
- #2462 (refinado, bug): preambulo con `'${CLAUDE_PLUGIN_ROOT}'` exacto como primer candidato (valida; aborta si es invalido sin caer al marker; fallback solo si no se sustituyo), regla de no guardar/reutilizar el bloque, tests sin exportar la variable, enmienda de MEF-ADR-0053. Se descarto la variante sin preambulo (ruta literal por linea) y reescribir el canonico en el upgrade.
- #2409 y #2407 pasan a `estado:listo` (siguen `bloqueado`); #2435 pasa a `estado:listo` con `bug`; #2438, #2443, #2447-#2450 y #2451-#2453 creados y pasados a `estado:listo`.

## Descartado
- Test funcional del body del PR de tooling (exigiria correr el pipeline).
- Quitar la senal del todo o limitar el issue al caso de bloqueo resuelto (#2438): el usuario eligio moverla al PR.
- Cubrir el hueco de stage 2b dentro de #2407 (mezclaria escritores y reviewer).

## Preguntas abiertas
Ninguna.

## Referencias
Issues refinados: #2409, #2407, #2435. Issue ajustado: #2408. Issues creados: #2438, #2443, #2447, #2448, #2449, #2450, #2451, #2452, #2453. Refinado: #2462.
