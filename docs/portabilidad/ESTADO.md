# Estado de la portabilidad de Mefisto

Objetivo: que Mefisto funcione completo en macOS y Windows nativo, solo con Claude Code. Linux se
verifica en CI pero no es criterio de cierre. Este archivo es la única fuente del
avance: cada goal lo lee al empezar y lo actualiza al terminar.

**Portabilidad: en curso** (1 de 7 pasos hechos; verificación en Windows pendiente).

## Decisiones

Tomadas el 2026-11-10 y fijadas en [MEF-ADR-0057](../adr/mef-adr-0057-portabilidad-typescript-node.md),
que es la fuente de verdad. Resumen:

1. Los scripts bash se portan a TypeScript sobre Node >= 22.18, ejecutado directo (`node x.ts`),
   sin build y sin dependencias npm en ejecución.
2. tmux se retira del todo. Quedan dos modos de UI: herdr (panes) y desacoplado (default).
3. Se conserva la compatibilidad con herdr.
4. OpenCode sale. Runtime único: Claude Code. Se conservan el contrato de eventos JSONL, la
   interfaz de runtime y la fuente neutral `src/internal/`.
5. El port es incremental sobre `main`: bash y TypeScript conviven mientras dura.
6. No hay un segundo runtime en los planes.

## Reglas de trabajo

- Este trabajo va fuera de los pipelines de Mefisto: sin issues ni `/mefisto-plan`. Sigue rigiendo
  el flujo de entrega de `AGENTS.md`: worktree, rama y PR a `main`.
- Cada goal mergea sus propios PRs a `main` (squash y borrado de rama) cuando pasa la
  verificación de abajo, sin esperar al usuario. Si falla no se mergea: se corrige en el mismo PR.
- Un script se porta completo, con sus tests, en un PR. El `.sh` queda como shim
  (`exec node x.ts "$@"`) solo mientras tenga llamadores en bash.
- Tests con `node --test` y chequeo de tipos con `tsc --noEmit`.
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
- PR que toca TypeScript (desde el paso 3): `tsc --noEmit` y `node --test` en local, y el workflow
  de los tres sistemas en verde. Ese workflow sí se dispara en los PRs que tocan TypeScript
  (excepción acotada de MEF-ADR-0057, decisión 8); también se puede lanzar a mano con
  `gh workflow run <workflow> --ref <rama>`.
- Si una nightly queda en rojo por un PR del port, arreglarla va antes que el siguiente PR.

## Métricas

Se miden con git desde la raíz del repo. `dist/` queda fuera porque lo regenera el release.

| Id | Qué mide | Línea base (v0.56.0) | Actual | Meta |
|---|---|---|---|---|
| M1a | Archivos `.sh` | 408 | 364 | 0 |
| M1b | Líneas en `.sh` | 104686 | 94501 | 0 |
| M2 | Archivos `.jq` | 21 | 19 | 0 |
| M3 | Archivos que mencionan tmux | 96 | 90 | 0 |
| M4 | Archivos que mencionan OpenCode | 283 | 9, todos excepción | 0 fuera de las excepciones |
| M5 | Comandos de `hooks/hooks.json` que no son `node` | 7 de 7 | 7 de 7 | 0 |

```bash
# M1a y M1b
git ls-files -- '*.sh' ':!dist/' | wc -l
git ls-files -z -- '*.sh' ':!dist/' | xargs -0 cat | wc -l
# M2
git ls-files -- '*.jq' ':!dist/' | wc -l
# M3 y M4 (excluyen historia: bitácora, changelog y este directorio)
git grep -lIiw tmux -- ':!dist/' ':!docs/bitacora/' ':!docs/portabilidad/' ':!CHANGELOG.md' ':!changelog.d/' | wc -l
git grep -lIi opencode -- ':!dist/' ':!docs/bitacora/' ':!docs/portabilidad/' ':!CHANGELOG.md' ':!changelog.d/' | wc -l
# M5: total de comandos menos los que ya son node
git grep -c '"command":' -- hooks/hooks.json
git grep -c '"command": "node ' -- hooks/hooks.json
```

M3 y M4 admiten una excepción: la sección de control de cambios de un ADR puede nombrar tmux u
OpenCode. La comprobación, que debe dar 0 en cada ADR:

```bash
for f in docs/adr/mef-adr-*.md; do awk '/^## Control de cambios/{c=1} !c' "$f" | grep -ci opencode; done
```

Restos aceptados de M4, además de esas secciones:

- `docs/adr/mef-adr-0057-portabilidad-typescript-node.md`: es el ADR que retira OpenCode.
- `docs/adr/INDICE-TEMATICO.md`: filas históricas que solo consolida `/mefisto-release`.

## Pasos

Estados: `pendiente`, `en curso`, `hecho`.

| Paso | Qué | Estado | PR |
|---|---|---|---|
| 1 | ADR de portabilidad | hecho | #2547 |
| 2a | Retirar OpenCode | hecho | #2551, #2552 |
| 2b | Retirar tmux | pendiente | |
| 3 | Base TypeScript | pendiente | |
| 4 | Hooks | pendiente | |
| 5 | Scripts sueltos | pendiente | |
| 6 | Librerías y pipelines | pendiente | |
| 7 | Despachador, herdr y cierre | pendiente | |

### Paso 1: ADR de portabilidad

Alcance: un ADR nuevo (el siguiente número libre en `docs/adr/`) con las decisiones de arriba, las
reglas de convivencia y la ubicación de los `.ts`; su fragmento `adr-index` en `changelog.d/`.
Las enmiendas a los ADRs existentes van con el paso que borra el código (2a y 2b), para que ADRs
y código no se contradigan.

Hecho cuando: el ADR está en `main` y la sección Decisiones de este archivo enlaza al ADR.

### Paso 2: Retirar OpenCode y tmux (todavía en bash)

Primero OpenCode: al salir, el único uso de tmux que queda es el modo explícito.

| Fila | Alcance | Estado | PR |
|---|---|---|---|
| 2a | OpenCode: `.opencode/`, `opencode.json`, adaptadores y runtime de OpenCode, política de permisos, scripts de instalación, empaquetado y proyección, lógica de par de adaptadores en `/upgrade` y `/runtimes`, sus tests y fixtures. Enmiendas a MEF-ADR-0049, 0050 y 0053; `AGENTS.md` y `README.md` | hecho | #2551, #2552 |
| 2b | tmux: el modo sesión de los dos despachadores (que pasan a un nombre sin tmux), `--attach`, `--if-exists`, sus tests, `docs/tmux-cheatsheet.md` y el requisito en `README.md`. `MEFISTO_UI=tmux` da un error claro. Enmienda a MEF-ADR-0055 | pendiente | |

Hecho cuando: M4 = 0 (2a) y M3 = 0 (2b), ningún archivo lleva `opencode` ni `tmux` en la ruta
fuera de `dist/`, y la suite completa pasa en local.

### Paso 3: Base TypeScript

Alcance: `tsconfig`; workflow con `tsc --noEmit` y `node --test` sobre macOS, Linux y Windows,
que se dispara en los PRs que tocan TypeScript, en la nightly y a mano, sin ser check obligatorio
del ruleset (MEF-ADR-0057, decisión 8); mecanismo que marca los módulos ES (decisión 1); registro en los gates de scope (`is_path_in_mefisto_scope`, `is_path_in_consumer_blocklist`) de
toda ruta nueva, en un PR anterior al que la puebla (MEF-ADR-0019, sección E); chequeo de
Node >= 22.18 en `/onboard` y en `README.md`.

Hecho cuando: el workflow existe y pasa en los tres sistemas con al menos un test `.ts`.

### Paso 4: Hooks

Alcance: los 7 comandos inline de `hooks/hooks.json` pasan a scripts `node` con tests;
`.claude/scripts/mefisto-scope-hook.sh` se porta. `src/internal/githooks/pre-push` se queda en
shell: Git ejecuta los hooks con su propio `sh` (se confirma en W6).

Hecho cuando: M5 = 0 y los tests de los hooks pasan en los tres sistemas.

### Paso 5: Scripts sueltos

Alcance: los scripts que no son pipeline ni librería de pipeline, con sus tests y sus `.jq`.

| Fila | Alcance (línea base, sin tests) | Estado | PR |
|---|---|---|---|
| 5a | `src/published/scripts/` (76 archivos, 9979 líneas antes de retirar OpenCode) | pendiente | |
| 5b | `scripts/` que no son pipeline ni `_pipeline-common.sh` | pendiente | |
| 5c | `src/internal/scripts/` que no son pipeline ni `lib/_mefisto-common.sh` | pendiente | |

Al portar `generate-internal-adapters.sh` se enmienda MEF-ADR-0049, decisión 6 y alternativa a:
hoy fijan bash + `jq` como toolchain del generador y descartan Node.

Hecho cuando: en esas rutas solo quedan pipelines, sus librerías y shims.

### Paso 6: Librerías y pipelines

| Fila | Alcance (líneas en la línea base) | Estado | PR |
|---|---|---|---|
| 6a | `src/runtime/` (2500) y `scripts/_pipeline-common.sh` (3150) | pendiente | |
| 6b | `scripts/tooling-pipeline.sh` (1065) | pendiente | |
| 6c | `scripts/tdd-pipeline.sh` (2651) | pendiente | |
| 6d | `scripts/iac-pipeline.sh` (812) | pendiente | |
| 6e | `scripts/scaffold-pipeline.sh` (599) | pendiente | |
| 6f | `scripts/batch-pipeline.sh` (660) y `scripts/parallel-pipeline.sh` (862) | pendiente | |
| 6g | `src/internal/scripts/lib/_mefisto-common.sh` (1914) | pendiente | |
| 6h | `src/internal/scripts/mefisto-tooling-pipeline.sh` (1645) | pendiente | |
| 6i | `src/internal/scripts/mefisto-batch-pipeline.sh` (958) | pendiente | |

Mientras una librería tenga llamadores en bash conviven sus dos versiones; un cambio en una función
ya portada va en las dos.

Hecho cuando: todas las filas están en `hecho` y no queda ningún `.jq` (M2 = 0).

### Paso 7: Despachador, herdr y cierre

Alcance: los dos despachadores, `herdr-pipeline.sh`, `mefisto-herdr-pipeline.sh`,
`herdr-workspace.sh` y los dos `stream-watch`. Dos rediseños para Windows: la ocupación de un pane
la marca Mefisto (no el grupo de foreground de Unix), y el comando que se teclea en el pane es
`node <script>.ts <args>` sin sintaxis de shell. Cierre: se borran los shims, los comandos y
agentes invocan `node`, y `README.md` y `/onboard` dejan de pedir bash, jq y tmux.

Hecho cuando: M1a = 0, M1b = 0 y el workflow de los tres sistemas pasa.

## Verificación manual en Windows

La hace el usuario en una máquina Windows nativa, sin Git Bash salvo donde se indique. No la puede
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
2. M1a, M1b, M2, M3, M4 y M5 están en su meta, y tras el release siguiente no existe
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
workflow con tsc --noEmit y node --test pasa en macOS, Linux y Windows, /onboard y README piden
Node >= 22.18, y la fila 3 está en "hecho" con sus PRs mergeados en main.
```

```
Goal 4: Completa el paso 4 de docs/portabilidad/ESTADO.md (hooks). Terminado cuando M5 da 0, los
tests de los hooks pasan en el workflow de los tres sistemas, y la fila 4 está en "hecho" con sus PRs
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
Terminado cuando M1a y M1b dan 0, el workflow de los tres sistemas pasa, README y /onboard no piden bash,
jq ni tmux, y la fila 7 está en "hecho" con sus PRs mergeados en main. La verificación W1 a W7 la
hace el usuario y no forma parte de este goal.
```
