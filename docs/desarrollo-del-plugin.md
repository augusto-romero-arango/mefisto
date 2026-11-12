# Desarrollo del plugin

Estructura del plugin y guía para evolucionarlo. Movido desde el [README](../README.md).

## Estructura del plugin

```
.claude-plugin/
  plugin.json          # metadata (name, version, author)
  marketplace.json     # catálogo
commands/              # skills publicados (los que ve el consumidor), generados desde src/published/commands/
agents/                # agentes publicados, generados desde src/published/agents/
skills/                # Agent Skills publicados
scripts/               # pipelines + utilidades publicadas (.mts, se invocan con node)
hooks/hooks.json       # salida Claude generada: SessionStart (.mefisto/pipeline/.plugin-root y mirror temporal, sessions.jsonl) + PostToolUse para logging
src/published/         # fuente neutral de comandos y agentes publicados, contrato y generador
src/runtime/           # runner neutral de agentes (mefisto-run-agent.mts) y adaptador de Claude Code
src/internal/          # fuente neutral de lo interno: agents/, commands/, skills/ y scripts/ (pipelines internos)
dist/claude/           # distribución generada que publica el release
.claude/               # adaptador interno generado (no se publica)
  commands/            # /mefisto-tooling, /mefisto-plan, /mefisto-bug, ...
  agents/              # mefisto-investigator, mefisto-planner, mefisto-writer, ...
  scripts/             # hook de scope del adaptador (mefisto-scope-hook.mts) y tests internos
docs/
  adr/                 # ADRs del marco
  testing/harness-cheatsheet.md
.mcp.json              # servidor MCP bundleado (microsoft-learn)
AGENTS.md              # directivas canónicas neutrales a runtime de Mefisto
CLAUDE.md              # puente de Claude Code hacia AGENTS.md
CHANGELOG.md
```

## Desarrollo del propio plugin

Si vas a evolucionar Mefisto (este repo), **no instales el plugin sobre sí mismo**. Claude Code carga automáticamente los skills internos desde `.claude/commands/` y `.claude/agents/` del repo activo (separadamente del plugin distribuido).

Skills internos disponibles (todos con prefijo `mefisto-`):

- `/mefisto-tooling <issue>` — pipeline writer+reviewer para mejorar el plugin.
- `/mefisto-plan` — planear, refinar, desglosar issues del repo de Mefisto.
- `/mefisto-bug <síntoma>` — diagnosticar problemas del propio plugin.
- `/mefisto-fix-review <pr>` — resolver comentarios de un PR del repo.
- `/mefisto-merge <pr>` — squash + delete-branch sobre PRs del repo.

Cada skill interno verifica al inicio que estás en el repo de Mefisto (presencia de `.claude-plugin/plugin.json`) y aborta si no.

Cuando descubras desde un consumidor un problema atribuible al plugin, el tooling-investigator publicado puede **crear un draft cross-repo** en este repo (con `gh issue create -R augusto-romero-arango/mefisto --label "estado:borrador" …`). Luego, dentro del repo de Mefisto, refinas el draft con `/mefisto-plan` y lo implementas con `/mefisto-tooling`.

## Scripts en TypeScript

Todos los scripts, pipelines, hooks y generadores del plugin son TypeScript (MEF-ADR-0057): cada uno es un `.mts` que Node ejecuta directo, sin build ni dependencias npm, y no queda ningun `.sh` en el repo. Por ejemplo:

```bash
node src/internal/scripts/mefisto-portability-status.mts
```

Requiere Node 22.18 o posterior. Ese script mide las metricas de portabilidad; el estado, con la verificacion manual en Windows todavia pendiente, esta en `docs/portabilidad/ESTADO.md`.

Para verificar un cambio antes de abrir el PR:

```bash
npm install --no-save --no-package-lock typescript@7.0.2 @types/node@22.20.5
npx tsc -p src/internal/tsconfig.json
node --test ".claude/scripts/**/*.test.mts" "scripts/**/*.test.mts" "src/**/*.test.mts"
```

`tsc` y los tipos de Node son herramientas de verificacion: se instalan en `node_modules/`, que no se versiona, y ningun script depende de ellos al ejecutarse. El workflow `typescript.yml` repite esos pasos en macOS, Linux y Windows en los PRs que tocan TypeScript, cada noche y a mano; si la nightly sale roja, abre o comenta el issue `nightly-rojo`.

### Convenciones al portar un script

- **Ubicacion y nombre**: `x.mts` en el directorio de su lado (`scripts/` o `src/internal/scripts/`), invocado con `node <ruta>/x.mts`. Su test es `x.test.mts` en la carpeta `tests/` de ese lado (`scripts/tests/` para lo publicado, `.claude/scripts/tests/` para lo interno).
- **Forma del modulo**: funciones puras exportadas que el test importa, y un `main` que solo corre cuando el archivo es el punto de entrada (`isEntryPoint(import.meta.url)` de `scripts/lib/cli.mts`). Los errores previstos se lanzan como `CliError` y `runMain` los traduce a mensaje en stderr y codigo de salida.
- **Procesos**: siempre con lista de argumentos y sin shell (`capture` de `scripts/lib/cli.mts`). Nada de `exec` con una cadena.
- **Librerias compartidas**: lo publicado vive en `scripts/lib/`; lo interno, en `src/internal/scripts/lib/`. Lo interno puede importar lo publicado, nunca al reves.
- **Rutas**: se arman con `node:path`, nunca concatenando `/`. Para decidir si una ruta cae dentro de otra se comparan rutas reales con `realpathSync.native`, que es la unica variante que expande los nombres cortos de Windows.
- **Salida**: los mensajes y codigos de salida de un script son contrato para los comandos y agentes que los leen; un cambio en ellos va junto con el de sus lectores.
- **Tests**: con `node:test` y `node:assert/strict`, sobre carpetas temporales y repos git creados en el propio test. Nada que dependa de bash, salvo los que ejecutan un bloque de bash de un comando o agente con `scripts/tests/markdown-bash.mts`, que en Windows usa Git Bash.
