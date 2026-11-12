# src/internal/scripts/ -- Scripts canonicos internos de Mefisto

Layout canonico para los pipelines internos de Mefisto que son Bash + git +
`gh` + `jq` (MEF-ADR-0049 decision 2, issue #851): sin dependencia de ninguna
variable ni CLI de Claude Code. Analogo interno a `scripts/` (publicado), pero
de uso exclusivo del propio plugin -- no lo instala ningun proyecto
consumidor.

`.claude/scripts/` sigue siendo la superficie **estable** de invocacion
(`{{mefisto:run}}`, ver `src/internal/contract/README.md`): cada script que se
traslada aqui deja en su lugar un shim de compatibilidad de tres lineas, nunca
un `git mv` a secas que rompa a quien lo invoque por la ruta vieja.

## Plantilla del shim de compatibilidad

Literal, sin variaciones -- cada shim de `.claude/scripts/*.sh` que reenvia a
un script ya migrado tiene exactamente esta forma (3 lineas, resuelve la raiz
del repo desde su propio `$0`, nunca hardcodeada):

```bash
#!/usr/bin/env bash
# Shim de compatibilidad (MEF-ADR-0049): la implementacion canonica vive en src/internal/scripts/. No editar.
exec "$(cd "$(dirname "$0")/../.." && pwd)/src/internal/scripts/$(basename "$0")" "$@"
```

Reenvia `"$@"` y el exit code tal cual (via `exec`, sin logica propia). El
issue #873 verificara que todo `.claude/scripts/*.sh` sea, o bien un shim
conforme a esta plantilla, o bien un script explicitamente listado como
todavia-no-migrado.

Los shims se escriben **a mano**, copiando la plantilla; no los emite
`generate-internal-adapters.sh`. Es la excepcion deliberada al "los
adaptadores nunca se editan a mano" de MEF-ADR-0049 decision 2 -- esa regla
gobierna `.claude/{agents,commands}/`, que si son salida del generador --:
tres lineas identicas para todos, sin un solo campo que derive de la fuente
neutral, no justifican una etapa de generacion; lo que si hace falta es un
gate que verifique la conformidad: `mefisto-neutrality-gate.sh` (regla R4,
issue #911), que `mefisto-tooling-pipeline.sh` corre tras cada stage y
`mefisto-release.sh` en su fase `prepare` (issue #914).

## Precedente: mefisto-release.sh (issue #864)

`mefisto-release.sh` fue el primer script trasladado. `mefisto-tooling-pipeline.sh`
(issue #869), `mefisto-batch-pipeline.sh` (issue #870), `mefisto-launch-pipeline.sh`
(issue #871) y `mefisto-herdr-pipeline.sh` (issue #872) lo siguieron a este mismo
layout.

## Suite completa

La suite completa es `tsc` mas `node --test` con los globs de los `*.test.mts`
(comandos en `docs/desarrollo-del-plugin.md`). La corre de noche y a mano el
workflow `typescript.yml`; con la nightly roja, su job `notify` abre o comenta el
issue `nightly-rojo` con el cuerpo de `mefisto-nightly-report.mts`, que lee el
`results.tsv` que deja el reporter `lib/mefisto-nightly-reporter.mts` en cada job.
No es gate de ningun stage interno: los prompts de `mefisto-tooling-pipeline.sh`
cierran con `scripts/tests/guards.test.mts` mas los tests del diff.
