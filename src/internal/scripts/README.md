# src/internal/scripts/ -- Scripts canonicos internos de Mefisto

Layout canonico para los pipelines internos de Mefisto, en TypeScript sobre Node
(MEF-ADR-0049 decision 2, MEF-ADR-0057): sin dependencia de ninguna variable ni
CLI de Claude Code. Analogo interno a `scripts/` (publicado), pero de uso
exclusivo del propio plugin -- no lo instala ningun proyecto consumidor.

## Invocacion

Cada script se invoca desde aqui con Node, sin build ni reenvio:

```bash
node src/internal/scripts/<script>.mts <args>
```

Es la forma que emite `{{mefisto:run}}` (ver `src/internal/contract/README.md`)
y la que citan comandos, agentes, mods y documentacion. `.claude/scripts/` no
lleva copia ni shim de estos scripts: solo guarda `mefisto-scope-hook.mts`, el
hook del adaptador Claude, y los tests internos.

## Precedente: mefisto-release.mts (issue #864)

`mefisto-release.mts` fue el primer script trasladado. `mefisto-tooling-pipeline.mts`
(issue #869), `mefisto-batch-pipeline.mts` (issue #870), `mefisto-launch-pipeline.mts`
(issue #871) y `mefisto-herdr-pipeline.mts` (issue #872) lo siguieron a este mismo
layout.

## Suite completa

La suite completa es `tsc` mas `node --test` con los globs de los `*.test.mts`
(comandos en `docs/desarrollo-del-plugin.md`). La corre de noche y a mano el
workflow `typescript.yml`; con la nightly roja, su job `notify` abre o comenta el
issue `nightly-rojo` con el cuerpo de `mefisto-nightly-report.mts`, que lee el
`results.tsv` que deja el reporter `lib/mefisto-nightly-reporter.mts` en cada job.
No es gate de ningun stage interno: los prompts de `mefisto-tooling-pipeline.mts`
cierran con `scripts/tests/guards.test.mts` mas los tests del diff.
