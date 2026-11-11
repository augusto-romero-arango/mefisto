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
  scripts/             # _mefisto-common.sh, mefisto-tooling-pipeline.sh, ...
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
