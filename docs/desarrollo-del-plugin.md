# Desarrollo del plugin

Estructura del plugin y guía para evolucionarlo. Movido desde el [README](../README.md).

## Estructura del plugin

```
.claude-plugin/
  plugin.json          # metadata (name, version, author)
  marketplace.json     # catálogo
commands/              # skills publicados (los que ve el consumidor)
agents/                # agentes publicados
scripts/               # pipelines + utilidades bash publicadas
hooks/hooks.json       # salida Claude generada: SessionStart (.mefisto/pipeline/.plugin-root y mirror temporal, sessions.jsonl) + PostToolUse para logging
.claude/               # skills/agentes/pipelines INTERNOS (no se publican)
  commands/            # /mefisto-tooling, /mefisto-plan, /mefisto-bug, ...
  agents/              # mefisto-investigator, mefisto-planner, mefisto-historiador
  scripts/             # shims de los pipelines internos: mefisto-tooling-pipeline.sh, ...
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

Los scripts se estan portando de bash a TypeScript (MEF-ADR-0057). Un script portado es un `.mts` que Node ejecuta directo, sin build:

```bash
node src/internal/scripts/mefisto-portability-status.mts
```

Requiere Node 22.18 o posterior. El avance del port esta en `docs/portabilidad/ESTADO.md`; ese mismo script lo mide.

Para verificar un cambio antes de abrir el PR:

```bash
npm install --no-save --no-package-lock typescript@7.0.2 @types/node@22.20.5
npx tsc -p src/internal/tsconfig.json
node --test ".claude/scripts/**/*.test.mts" "scripts/**/*.test.mts" "src/**/*.test.mts"
```

`tsc` y los tipos de Node son herramientas de verificacion: se instalan en `node_modules/`, que no se versiona, y ningun script depende de ellos al ejecutarse. El workflow `typescript.yml` repite esos pasos en macOS, Linux y Windows.

### Convenciones al portar un script

- **Ubicacion y nombre**: `x.mts` junto al `x.sh` que reemplaza. Su test es `x.test.mts` en la carpeta `tests/` de ese lado (`scripts/tests/` para lo publicado, `.claude/scripts/tests/` para lo interno).
- **Shim**: mientras algo en bash o un comando invoque `x.sh`, queda como shim de una linea de codigo: `exec node "$(dirname "$0")/x.mts" "$@"`. Cuando no quede ningun llamador, se borra.
- **Forma del modulo**: funciones puras exportadas que el test importa, y un `main` que solo corre cuando el archivo es el punto de entrada (`isEntryPoint(import.meta.url)` de `scripts/lib/cli.mts`). Los errores previstos se lanzan como `CliError` y `runMain` los traduce a mensaje en stderr y codigo de salida.
- **Procesos**: siempre con lista de argumentos y sin shell (`capture` de `scripts/lib/cli.mts`). Nada de `exec` con una cadena.
- **Librerias compartidas**: lo publicado vive en `scripts/lib/`; lo interno, en `src/internal/scripts/lib/`. Lo interno puede importar lo publicado, nunca al reves.
- **Rutas**: se arman con `node:path`, nunca concatenando `/`. Para decidir si una ruta cae dentro de otra se comparan rutas reales con `realpathSync.native`, que es la unica variante que expande los nombres cortos de Windows.
- **Salida**: los mensajes y codigos de salida del script en bash se conservan; son contrato para los comandos y agentes que los leen.
- **Tests**: con `node:test` y `node:assert/strict`, sobre carpetas temporales y repos git creados en el propio test. Nada que dependa de bash, salvo los que ejecutan un bloque de bash de un comando o agente con `scripts/tests/markdown-bash.mts`, que en Windows usa Git Bash.
