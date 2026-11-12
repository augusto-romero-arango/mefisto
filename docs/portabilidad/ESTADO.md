# Estado de la portabilidad de Mefisto

Objetivo: que Mefisto funcione completo en macOS y Windows nativo, solo con Claude Code. Linux se
verifica en CI pero no es criterio de cierre. Este archivo es la única fuente del
avance: cada goal lo lee al empezar y lo actualiza al terminar.

**Portabilidad: en curso** (4 de 7 pasos hechos; verificación en Windows pendiente).

## Decisiones

Tomadas el 2026-11-10 y fijadas en [MEF-ADR-0057](../adr/mef-adr-0057-portabilidad-typescript-node.md),
que es la fuente de verdad. Resumen:

1. Los scripts bash se portan a TypeScript sobre Node >= 22.18, ejecutado directo (`node x.mts`),
   sin build y sin dependencias npm en ejecución.
2. tmux se retira del todo. Quedan dos modos de UI: herdr (panes) y desacoplado (default).
3. Se conserva la compatibilidad con herdr.
4. OpenCode sale. Runtime único: Claude Code. Se conservan el contrato de eventos JSONL, la
   interfaz de runtime y la fuente neutral `src/internal/`.
5. El port es incremental sobre `main`: bash y TypeScript conviven mientras dura.
6. No hay un segundo runtime en los planes.
7. En Windows se exige Git for Windows (decisión del 2026-11-11): los bloques de bash que Claude
   ejecuta desde comandos y agentes siguen en bash y corren en Git Bash. Los scripts del harness
   no dependen de bash.

## Reglas de trabajo

- Este trabajo va fuera de los pipelines de Mefisto: sin issues ni `/mefisto-plan`. Sigue rigiendo
  el flujo de entrega de `AGENTS.md`: worktree, rama y PR a `main`.
- Cada goal mergea sus propios PRs a `main` (squash y borrado de rama) cuando pasa la
  verificación de abajo, sin esperar al usuario. Si falla no se mergea: se corrige en el mismo PR.
- Un script se porta completo, con sus tests, en un PR. El `.sh` queda como shim
  (`exec node x.mts "$@"`) solo mientras tenga llamadores en bash.
- Tests con `node --test` y chequeo de tipos con `tsc`; los comandos exactos están en
  `docs/desarrollo-del-plugin.md`.
- Fragmentos de `changelog.d/`: como no hay issue, se nombran con el número del PR
  (`<pr>.<categoria>.md`). El consolidador de `/mefisto-release` solo exige un prefijo numérico.
  Todo PR que toque algo distinto de `docs/bitacora/`, `README.md`, `AGENTS.md`, `CLAUDE.md` o
  `.gitignore` lleva fragmento.
- El PR que cierra una fila de este archivo actualiza esa fila (estado y PR) y vuelve a medir la
  tabla de métricas, en la rama del PR.

## Verificación antes de mergear

Ningún PR dispara CI: por política de `.github/workflows/ci.yml` (issues #1743 y #1766) la suite
corre en la nightly y a mano. Por eso la verificación la hace el goal antes de mergear:

- PR solo de documentación: nada que correr, salvo que toque `docs/adr/`. Los ADRs se copian a
  `dist/`, así que ese PR regenera con `src/published/scripts/generate-published-adapters.sh` y
  comprueba que su `--check` sale en 0.
- PR que toca bash: los tests de lo tocado, en local. Al cerrar una fila, la suite completa en
  local con `src/internal/scripts/mefisto-test-suite.sh`.
- PR que toca TypeScript: `tsc` y `node --test` en local, y el workflow `typescript.yml` en verde
  en sus seis celdas (macOS, Linux y Windows, sobre Node 22.18 y 24). Se dispara solo en los PRs
  que tocan un `.mts` (excepción acotada de MEF-ADR-0057, decisión 8); a mano se lanza con
  `gh workflow run typescript.yml --ref <rama>`.
- PR que toca `hooks/`, `.claude-plugin/` o `.claude/mods/`: esperar el check `Plugin validate`.
  No es obligatorio, así que GitHub deja mergear mientras corre.
- Si una nightly queda en rojo por un PR del port, arreglarla va antes que el siguiente PR.

## Métricas

Las mide `node src/internal/scripts/mefisto-portability-status.mts` desde cualquier carpeta del
repo (`--json` para la salida estructurada). `dist/` queda fuera porque lo regenera el release.

| Id | Qué mide | Línea base (v0.56.0) | Actual | Meta |
|---|---|---|---|---|
| M1a | Archivos `.sh` | 408 | 168 | 0 |
| M1b | Líneas en `.sh` | 104686 | 29077 | 0 |
| M2 | Archivos `.jq` | 21 | 3 | 0 |
| M3 | Archivos que mencionan tmux | 96 | 6, todos excepción | 0 fuera de las excepciones |
| M4 | Archivos que mencionan OpenCode | 283 | 11, todos excepción | 0 fuera de las excepciones |
| M5 | Comandos de `hooks/hooks.json` que no son `node` | 7 de 7 | 0 de 7 | 0 |
| M6 | Archivos `.py` | 0 | 1 | 0 |

M3 y M4 excluyen la historia (bitácora, changelog y este directorio) y admiten estas excepciones,
que el script descuenta solo:

- La sección de control de cambios de cualquier ADR.
- `docs/adr/mef-adr-0057-portabilidad-typescript-node.md`: es el ADR que retira tmux y OpenCode.
- `docs/adr/INDICE-TEMATICO.md`: filas históricas que solo consolida `/mefisto-release`.
- El propio script y su test, que nombran lo que miden.

## Pasos

Estados: `pendiente`, `en curso`, `hecho`.

| Paso | Qué | Estado | PR |
|---|---|---|---|
| 1 | ADR de portabilidad | hecho | #2547 |
| 2a | Retirar OpenCode | hecho | #2551, #2552 |
| 2b | Retirar tmux | hecho | #2555 |
| 3 | Base TypeScript | hecho | #2556 |
| 4 | Hooks | hecho | #2557, #2558 |
| 5 | Scripts sueltos | hecho | #2559 a #2586 |
| 6 | Librerías y pipelines | en curso | #2587 a #2609 |
| 7 | Despachador, herdr y cierre | en curso | #2595, #2596, #2598, #2607, #2610, #2611 |

### Paso 1: ADR de portabilidad

Alcance: un ADR nuevo (el siguiente número libre en `docs/adr/`) con las decisiones de arriba, las
reglas de convivencia y la ubicación de los `.mts`; su fragmento `adr-index` en `changelog.d/`.
Las enmiendas a los ADRs existentes van con el paso que borra el código (2a y 2b), para que ADRs
y código no se contradigan.

Hecho cuando: el ADR está en `main` y la sección Decisiones de este archivo enlaza al ADR.

### Paso 2: Retirar OpenCode y tmux (todavía en bash)

Primero OpenCode: al salir, el único uso de tmux que queda es el modo explícito.

| Fila | Alcance | Estado | PR |
|---|---|---|---|
| 2a | OpenCode: `.opencode/`, `opencode.json`, adaptadores y runtime de OpenCode, política de permisos, scripts de instalación, empaquetado y proyección, lógica de par de adaptadores en `/upgrade` y `/runtimes`, sus tests y fixtures. Enmiendas a MEF-ADR-0049, 0050 y 0053; `AGENTS.md` y `README.md` | hecho | #2551, #2552 |
| 2b | tmux: el modo sesión de los dos despachadores (que pasan a un nombre sin tmux), `--attach`, `--if-exists`, sus tests, `docs/tmux-cheatsheet.md` y el requisito en `README.md`. `MEFISTO_UI=tmux` da un error claro. Enmienda a MEF-ADR-0055 | hecho | #2555 |

Hecho cuando: M4 (2a) y M3 (2b) están en su meta, ningún archivo lleva `opencode` ni `tmux` en la ruta
fuera de `dist/`, y la suite completa pasa en local.

### Paso 3: Base TypeScript

Alcance: `src/internal/tsconfig.json`; el workflow `typescript.yml`, que corre `tsc` y
`node --test` en macOS, Linux y Windows sobre Node 22.18 y 24 (MEF-ADR-0057, decisión 8); la
extensión `.mts` para los módulos (decisión 1); y el primer script portado,
`mefisto-portability-status.mts`, que mide las métricas de este archivo.

No hizo falta registrar rutas en los gates: todo vive en carpetas ya registradas.

Hecho cuando: el workflow existe y pasa en los tres sistemas con al menos un test `.mts`.

### Paso 4: Hooks

| Fila | Alcance | Estado | PR |
|---|---|---|---|
| 4a | Hooks publicados: los 7 comandos de `hooks/hooks.json` pasan a la forma exec de Claude Code (`command: "node"` más `args`, sin shell) sobre `scripts/interactive-hooks.mts`. Con ellos entra el requisito de Node >= 22.18 para el consumidor: chequeo en `/onboard` y línea en `README.md` (MEF-ADR-0057, decisión 9) | hecho | #2557 |
| 4b | Hook de scope interno: `.claude/scripts/mefisto-scope-hook.mts`, en forma exec desde `.claude/settings.json`. La lista de scope vive también en TypeScript (`src/internal/scripts/lib/mefisto-scope.mts`), gemela de la función bash hasta el paso 6g; un test verifica que coinciden | hecho | #2558 |

`src/internal/githooks/pre-push` se queda en shell: Git ejecuta los hooks con su propio `sh` (se
confirma en W6).

Hecho cuando: M5 = 0, no queda ningún hook en bash y los tests de los hooks pasan en los tres
sistemas.

### Paso 5: Scripts sueltos

Alcance: los scripts que no son pipeline ni librería de pipeline, con sus tests y sus `.jq`.

| Fila | Alcance (línea base, sin tests) | Estado | PR |
|---|---|---|---|
| 5a | `src/published/scripts/` (76 archivos, 9979 líneas antes de retirar OpenCode) | hecho | #2580, #2585, #2586 |
| 5b | `scripts/` que no son pipeline ni `_pipeline-common.sh` | hecho | #2559, #2560, #2563, #2565, #2566, #2567, #2570, #2573, #2574, #2575, #2582 |
| 5c | `src/internal/scripts/` que no son pipeline ni `lib/_mefisto-common.sh` | hecho | #2560, #2564, #2566, #2569, #2575, #2578 |

MEF-ADR-0049 (decisión 6 y alternativa a) y MEF-ADR-0050 dejaron de fijar bash + `jq` como
toolchain del generador al portarlo (#2578).

Ya portados (su `.sh` queda como shim hasta el paso 7):

- Base: `scripts/lib/cli.mts`, `scripts/lib/state.mts`, `scripts/lib/harness-config.mts`,
  `scripts/lib/tfstate-naming.mts`, `scripts/lib/issue-dependencies.mts` y
  `src/internal/scripts/lib/mefisto-repo.mts`. `capture` lanza los `.cmd` y `.bat` de Windows
  (p. ej. `az.cmd`) a través de `cmd.exe` (#2565).
- `scripts/`: `next-order`, `field-note`, `azure-account-info`, `worktree-clean`, `upgrade`,
  `warnings-diff`, `purge-store`, `setup-github-ci`, `bootstrap-backend`, `appinsights-query`,
  `update-plugin`, `onboard-diagnose`, `onboard-activate-repo`, `register-harness-secret`,
  `setup-github-labels`, `onboard-provision-appinsights`, `onboard-migrate-directives`,
  `seed-secret`, `validate-dockerfile`, `metrics-report` y `work-status-collect`.
  `_plugin-scopes.sh` se borró: su lógica vive en `scripts/lib/plugin-scopes.mts`.
- `src/internal/scripts/`: `mefisto-next-order`, `mefisto-field-note`, `mefisto-nightly-report`,
  `mefisto-validate-batch-deps`, `mefisto-worktree`, `mefisto-bitacora-worktree`,
  `mefisto-release` y `mefisto-metrics-report`.

También están portados los generadores y validadores de los dos lados y el gate de neutralidad
(#2578, #2580), y los tests que verifican texto de agentes, plantillas y README (#2582).

Los tests de contrato de comandos y agentes publicados también corren con `node --test` (#2585,
#2586). `scripts/pr-sync.sh` carga `_pipeline-common.sh` y se porta con el paso 6.

Un test que extrae un bloque de bash del markdown de un comando o agente y lo ejecuta no se puede
portar mientras ese bloque sea bash: conserva en bash solo esos casos (residual) y se cierra en el
paso 7. Hay residuales en `scripts/tests/` y en `src/published/scripts/tests/` (`install-apim`,
`historiador`, `infra-base-scaffolder`, `tdd-agents`, `tdd-pipeline-closure`, entre otros); la
cabecera de cada uno apunta al `.test.mts` que cubre el resto.

El repo fija los finales de línea en LF con `.gitattributes` (#2561, #2562): con CRLF, en Windows
fallaban los shims y las lecturas de texto.

Límites y deudas de lo portado:

- `field-note` valida el glosario YAML con un validador que ya esté en el PATH (`python3` con
  PyYAML, `ruby` o `yq`). En Windows sin ninguno aborta con un mensaje y no stagea nada.
- El descubrimiento sincrono de runtime que usan `upgrade` y `onboard` sale de la tabla `PROBES` de
  `src/runtime/lib/mefisto-runtime.mts`, que duplica el `isAvailable` de cada adaptador.
- El parser de la salida de `dotnet` en `warnings-diff` solo está probado con fixtures; falta un
  build real en Windows, con rutas con `\`.
- `mefisto-release` no se ha ejecutado contra el repo real: el primer release que lo use es su
  prueba de extremo a extremo. Sigue lanzando con `bash` el gate de neutralidad y el generador
  publicado hasta que se porten, y su bloque de recuperación es una receta bash + `python3`.
- Los scripts que lanzan un CLI externo muestran su salida cuando el comando termina, no en vivo
  (`mefisto-release`, `update-plugin`, `setup-github-labels`).
- Ningún script portado se ha probado contra Azure, GitHub ni `claude` reales: los tests inyectan
  esos CLIs. Queda por ver en Windows `az.cmd` con argumentos que llevan `&&` y comillas (W3).
- El shim de `onboard-diagnose` avisa si falta Node >= 22.18; los demás shims fallan con el error
  de `node`.
- Los defectos que ya tenía el bash se portaron tal cual y quedaron como borradores: #2571, #2572,
  #2576, #2579 y #2581.
- Quedan módulos gemelos entre el lado publicado y el interno (esquema JSON y frontmatter), porque
  el publicado no importa de `src/internal/`.

Hecho cuando: en esas rutas solo quedan pipelines, sus librerías y shims.

### Paso 6: Librerías y pipelines

| Fila | Alcance (líneas en la línea base) | Estado | PR |
|---|---|---|---|
| 6a | `src/runtime/` (2500) y `scripts/_pipeline-common.sh` (3150) | en curso | #2587, #2588, #2590, #2593 |
| 6b | `scripts/tooling-pipeline.sh` (1065) | hecho | #2599 |
| 6c | `scripts/tdd-pipeline.sh` (2651) | hecho | #2603 |
| 6d | `scripts/iac-pipeline.sh` (812) | hecho | #2604 |
| 6e | `scripts/scaffold-pipeline.sh` (599) | hecho | #2604 |
| 6f | `scripts/batch-pipeline.sh` (660) y `scripts/parallel-pipeline.sh` (862) | hecho | #2605 |
| 6g | `src/internal/scripts/lib/_mefisto-common.sh` (1914) | en curso | #2594, #2597 |
| 6h | `src/internal/scripts/mefisto-tooling-pipeline.sh` (1645) | hecho | #2606 |
| 6i | `src/internal/scripts/mefisto-batch-pipeline.sh` (958) | hecho | #2609 |

`.claude/scripts/tests/fixtures/pty-run.py` es un helper en Python que entró al retirar tmux: da
una terminal real a tres tests de señales. Sale con el port de los scripts que esos tests prueban
(`mefisto-test-suite.sh`, el ejecutor de tests y el watchdog); al cerrar el paso no queda ningún
`.py`.

Mientras una librería tenga llamadores en bash conviven sus dos versiones; un cambio en una función
ya portada va en las dos.

Orden de trabajo: primero las librerías como gemelas, después cada pipeline.

- Runner: `src/runtime/mefisto-run-agent.mts` y los adaptadores `runtime-<id>.mts` ya son los que
  corren (#2587); sus `.sh` y `.jq` quedan como gemelas para los pipelines en bash. En Windows el
  runner termina al agente con `taskkill /PID <pid> /T /F` sobre el PID que lanzó; nunca mata por
  nombre. Falta una corrida real en Windows (W4).
- `scripts/_pipeline-common.sh` se porta por grupos a `scripts/lib/pipeline/*.mts`. La librería
  bash no cambia: gana un comentario `# Gemela en TypeScript` junto a cada función. Cada gemela
  lleva tests y una paridad contra la función bash real, que se salta en Windows y se borra con la
  librería. En `main`: scope, identidad, resolución de pipeline y PRs (#2588); tests, métricas de
  stage, historial, cobertura y smokes (#2590); modelos, efforts, eventos, fallos, holds y
  reanudación de agentes (#2593). Todas sus funciones tienen gemela.
- `src/internal/scripts/lib/_mefisto-common.sh` (6g) sigue el mismo esquema y ya tiene gemela de
  sus 37 funciones (#2594, #2597); reutiliza los módulos publicados donde la función interna es
  idéntica.
- Las filas 6a y 6g pasan a `hecho` cuando el último pipeline deja de cargar la librería bash y
  esta se borra, junto con sus tests de paridad.
- `tooling-pipeline` es el primer pipeline portado (#2599) y el modelo de los demás. Dejó en
  `scripts/lib/pipeline/` los módulos que todos comparten: `pipeline-exit` (cierre único en
  éxito, aborto, excepción y señal), `pipeline-log`, `pipeline-status`, `pipeline-agent-run`
  (reintentos, espera por límite de uso y reanudación, con el runner como proceso hijo),
  `pipeline-worktree` y `pipeline-pr`. Las diferencias entre pipelines entran como parámetros.
- La paridad con `jq` no puede depender de su versión: jq 1.7 y 1.8 difieren (p. ej. `tonumber`
  sobre una cadena con espacios alrededor) y los runners de CI traen versiones distintas.
- Defectos heredados del bash en estas librerías y en los pipelines: borradores #2589, #2591 y
  #2600.

Hecho cuando: todas las filas están en `hecho` y no queda ningún `.jq` (M2 = 0).

### Paso 7: Despachador, herdr y cierre

Alcance: los dos despachadores, `herdr-pipeline.sh`, `mefisto-herdr-pipeline.sh`,
`herdr-workspace.sh` y los dos `stream-watch`. Dos rediseños para Windows: la ocupación de un pane
la marca Mefisto (no el grupo de foreground de Unix), y el comando que se teclea en el pane es
`node <script>.mts <args>` sin sintaxis de shell. Cierre: se borran los shims, los comandos y
agentes invocan `node`, y `README.md` y `/onboard` dejan de pedir `jq` y tmux y piden Git for
Windows en Windows.

Bloques de bash del markdown: comandos, agentes y skills llevan unos 350 bloques que Claude
ejecuta, con 96 usos de `jq` y algunos de `awk`, `sed` y `python3`. En Windows nativo, Claude Code
usa Git Bash para la herramienta Bash si Git for Windows está instalado y, si no, PowerShell
([setup de Claude Code](https://code.claude.com/docs/en/setup)). Con Git for Windows exigido
(decisión 7), los bloques se quedan en bash y este paso reemplaza solo lo que Git Bash no trae:
`jq` y `python3` pasan a invocaciones de `node`. `/onboard` comprueba que Git Bash esté disponible
en Windows. Los tests residuales que ejecutan esos bloques se portan aquí.

Ya hecho de este paso:

- Los dos visores `stream-watch` corren en TypeScript (#2595).
- Los bloques de bash del markdown ya no usan `jq` ni `python3`: leen y escriben JSON con
  `scripts/json-value.mts` (#2596). Los `gh ... --jq` y los workflows de GitHub Actions que los
  agentes generan se quedan como estaban: el filtro lo ejecuta `gh` y los runners traen `jq`.
- El preámbulo que fija `MEFISTO_PACKAGE_ROOT` valida la raíz con `scripts/verify-package-root.mts`
  y acepta raíces de Windows (`C:\...`) (#2598). Sin esto, en Windows abortaba todo comando o
  agente que nombra la raíz del paquete.

- Los dos lanzadores corren en TypeScript y lanzan el modo desacoplado sin shell (#2607).
- `/onboard` y `/install-apim` ya no cargan `_pipeline-common.sh`; `/onboard` comprueba Git Bash
  en Windows; `README.md` pide Node 22.18+ y, en Windows, Git for Windows, sin `jq` (#2610).
- Herdr corre en TypeScript (#2611). La ocupación de un pane la marca Mefisto con el PID del runner
  (`herdr-panes/<pane>.json`); en Windows, un pane sin marca cuenta como ocupado. La línea tecleada
  es `node "<scripts>/herdr-pipeline.mts" "--_pane-runner" "--dispatch" "<archivo>"`, válida en
  bash, zsh, PowerShell y `cmd.exe`.

## Lo que falta (plan al 2026-11-12)

Ya no queda ningún script del harness en bash: lo que falta es borrar y cerrar. En orden:

1. **Herdr (#2611)**: mergear cuando pasen sus 6 checks.
2. **Borrar las librerías bash y sus gemelas**, una vez que ningún script bash las cargue
   (`git grep -n '_pipeline-common.sh\|_mefisto-common.sh\|runtime-claude.sh\|mefisto-runtime.sh'`):
   `scripts/_pipeline-common.sh`, `src/internal/scripts/lib/_mefisto-common.sh`,
   `src/runtime/lib/{mefisto-runtime,mefisto-models,mefisto-process,runtime-claude,runtime-fake}.sh`
   con `runtime-claude.jq` y `src/runtime/contract/models.validate.jq`,
   `src/internal/scripts/lib/{mefisto-state,mefisto-deps,frontmatter}.sh` y
   `src/internal/scripts/lib/jsonschema-lite.jq`, junto con los tests de paridad que las ejecutan
   (`scripts/tests/pipeline-*.test.mts`, `.claude/scripts/tests/mefisto-*-parity*` y similares: se
   quita el bloque de paridad, no el test). Quitar los comentarios `# Gemela en TypeScript` y las
   anotaciones de gemela en los `.mts`. `scripts/onboard-diagnose.sh` pasa a shim normal.
3. **Runner de la suite bash**: `src/internal/scripts/mefisto-test-suite.sh`,
   `lib/mefisto-test-inventory.sh`, `lib/mefisto-test-executor.sh` y
   `.claude/scripts/tests/fixtures/pty-run.py` (M6). Decidir qué hacen sin ellos la nightly
   (`.github/workflows/ci.yml`) y `/mefisto-release`: lo natural es que corran `node --test`.
4. **Tests bash restantes** (83 archivos, unas 15 300 líneas): los que prueban las librerías que
   se borran se van con ellas; el resto pasa a `node --test`. Los que ejecutan un bloque de bash del
   markdown lo extraen y lo corren con `bash` desde un `.test.mts` (helper
   `scripts/tests/markdown-bash.mts`); en los runners de Windows hay Git Bash.
5. **Shims**: 68 `.sh` de tres líneas. Para borrarlos, comandos, agentes, mods, lanzadores y
   documentación deben invocar `node <script>.mts`. `.claude/scripts/*.sh` es una superficie que
   valida el gate de neutralidad y cuya plantilla documenta el generador interno: retirarla exige
   ajustar el gate y enmendar MEF-ADR-0049, decisión 2.
6. **Correcciones**: dos tests que dependen del reloj con la máquina cargada (techo de espera en
   `mefisto-tooling-pipeline-agent.test.mts` y en `pr-sync-run-agent.test.mts`); el bloque C2 de
   `scripts/tests/test-guards.sh` es intermitente en CI y desde #2607 imprime la salida del script
   al fallar; M4 marca `scripts/tests/pipeline-harness-identity.test.mts` (menciona OpenCode fuera
   de las excepciones); MEF-ADR-0055 todavía menciona `nohup`.
7. **Cerrar este archivo**: medir de nuevo, pasar los pasos 6 y 7 a `hecho` y dejar solo la
   verificación en Windows.

Fuera del port quedan los borradores de defectos heredados del bash: #2571, #2572, #2576, #2579,
#2581, #2589, #2591 y #2600.

## Cómo se trabaja cada lote

- Un worktree por lote (`src/internal/scripts/mefisto-worktree.sh new <slug>`), con un agente
  que entrega commits locales sin push. Las convenciones de port están en
  `docs/desarrollo-del-plugin.md` ("Convenciones al portar un script"). Para portar un pipeline:
  reutilizar `scripts/lib/pipeline/pipeline-{exit,log,status,agent-run,worktree,pr}.mts` y el
  modelo `scripts/tooling-pipeline.mts`; las diferencias entre pipelines entran como parámetros.
- Integrar: `git merge origin/main`; un conflicto en `dist/claude/.mefisto-generated-assets.json`
  se resuelve regenerando con `src/published/scripts/generate-published-adapters.sh`. Si dos
  lotes tocaron los mismos tests bash compartidos, el merge lo resuelve el agente del lote, que
  sabe qué casos sacó.
- Verificar: `npx tsc -p src/internal/tsconfig.json`, `node --test` con los tres globs, los dos
  generadores con `--check` y `mefisto-neutrality-gate.sh`. Correr los tests con un PATH sin
  `claude` (los runners de CI no lo tienen) y sin aserciones que dependan del reloj. La paridad
  con `jq` no puede depender de su versión.
- Entregar: PR con fragmento en `changelog.d/<pr>.<categoría>.md` (y `.adr-index.md` con `dist/`
  regenerado si toca `docs/adr/`), esperar los 6 checks de `typescript.yml`, mergear con squash y
  borrar la rama remota con `git push origin --delete <rama>`. Un PR en conflicto no dispara CI.
- Un defecto heredado del bash se porta tal cual y va a un borrador, salvo que en Windows rompa
  algo (JSON inválido, rutas): entonces se corrige en el mismo lote.

Hecho cuando: M1a = 0, M1b = 0 y el workflow de los tres sistemas pasa.

## Verificación manual en Windows

La hace el usuario en una máquina Windows nativa con Git for Windows instalado, lanzando Claude
Code desde PowerShell. No la puede
cerrar un goal. Estados: `pendiente`, `ok`, `falla`.

| Id | Qué se prueba | Disponible desde | Estado | Fecha y versión | Notas |
|---|---|---|---|---|---|
| W1 | La suite `node --test` pasa en PowerShell | Paso 3 | pendiente | | |
| W2 | El plugin se instala en Claude Code y los hooks escriben `.mefisto/pipeline/sessions.jsonl` | Paso 4 | pendiente | | |
| W3 | `/mefisto:onboard` corre completo | Paso 5 | pendiente | | |
| W4 | Un pipeline corre de principio a fin en modo desacoplado | Paso 6 | pendiente | | |
| W5 | Herdr: despacho a un pane, reutilización de pane libre y `--parallel` | Paso 7 | pendiente | | |
| W6 | El hook `pre-push` corre con Git para Windows | Paso 4 | pendiente | | |
| W7 | Worktrees bajo `.mefisto/worktrees/` con rutas de Windows | Paso 6 | pendiente | | |

## Completitud

La portabilidad está completa cuando se cumplen las tres:

1. Los 7 pasos están en `hecho`.
2. M1a, M1b, M2, M3, M4, M5 y M6 están en su meta, y tras el release siguiente no existe
   `dist/opencode/` ni queda ningún `.sh` bajo `dist/`.
3. W1 a W7 están en `ok`.

## Goals

Un goal por paso. Cada uno se lanza cuando el anterior está en `hecho`.

```
Goal 1: Completa el paso 1 de docs/portabilidad/ESTADO.md (ADR de portabilidad). Terminado
cuando el ADR está mergeado en main, ESTADO.md enlaza al ADR y la fila 1 está en "hecho" con su PR.
```

```
Goal 2: Completa el paso 2 de docs/portabilidad/ESTADO.md (retirar OpenCode y luego tmux, en
bash). Terminado cuando las métricas M4 y M3 dan 0 medidas con los comandos del archivo, la suite
completa pasa en local, y las filas 2a y 2b están en "hecho" con sus PRs mergeados en main.
```

```
Goal 3: Completa el paso 3 de docs/portabilidad/ESTADO.md (base TypeScript). Terminado cuando el
workflow typescript.yml pasa en macOS, Linux y Windows con al menos un test .mts, y la fila 3
está en "hecho" con sus PRs mergeados en main.
```

```
Goal 4: Completa el paso 4 de docs/portabilidad/ESTADO.md (hooks). Terminado cuando M5 da 0, los
tests de los hooks pasan en el workflow de los tres sistemas, /onboard y README piden Node >= 22.18,
y la fila 4 está en "hecho" con sus PRs
mergeados en main.
```

```
Goal 5: Completa el paso 5 de docs/portabilidad/ESTADO.md (scripts sueltos). Terminado cuando las
filas 5a, 5b y 5c están en "hecho" con sus PRs mergeados en main, el workflow de los tres sistemas pasa
y la tabla de métricas está medida de nuevo.
```

```
Goal 6: Completa el paso 6 de docs/portabilidad/ESTADO.md (librerías y pipelines). Terminado
cuando las filas 6a a 6i están en "hecho" con sus PRs mergeados en main, M2 da 0, el workflow de los
tres sistemas pasa y la tabla de métricas está medida de nuevo.
```

```
Goal 7: Completa el paso 7 de docs/portabilidad/ESTADO.md (despachador, herdr y cierre).
Terminado cuando M1a y M1b dan 0, el workflow de los tres sistemas pasa, README y /onboard no piden
jq ni tmux y piden Git for Windows en Windows, y la fila 7 está en "hecho" con sus PRs mergeados en main. La verificación W1 a W7 la
hace el usuario y no forma parte de este goal.
```
