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

## Precedente: mefisto-release.sh (issue #864) y _mefisto-common.sh (issue #869)

`mefisto-release.sh` fue el primer script trasladado. `_mefisto-common.sh` -- la
lib de todos los scripts internos -- lo siguio en el issue #869, junto con
`mefisto-tooling-pipeline.sh`. Con la lib ya en `src/internal/scripts/lib/`,
`mefisto-release.sh` la `source`a relativa a su propio archivo (`lib/_mefisto-common.sh`),
igual que el resto de la libreria (`mefisto-state.sh`, `mefisto-runtime.sh`...),
sin pasar por `.claude/scripts/`. El shim de `_mefisto-common.sh` en
`.claude/scripts/` es la unica excepcion a la plantilla de `exec` de arriba: es
un `source` de una linea, para que los scripts que aun viven en `.claude/scripts/`
(`mefisto-scope-hook.sh`, el hook del adaptador Claude)
sigan resolviendo la lib por su propio `dirname "${BASH_SOURCE[0]}"` sin cambiar
una linea, y para que el gate de scope (MEF-ADR-0019 seccion E) siga
cargandose desde el checkout principal. `mefisto-batch-pipeline.sh` (issue
#870), `mefisto-tmux-pipeline.sh` (issue #871) y `mefisto-herdr-pipeline.sh`
(issue #872) siguieron a `mefisto-tooling-pipeline.sh` a este mismo layout.

## Runner de la suite completa: mefisto-test-suite.sh (issue #1439)

`.claude/scripts/mefisto-test-suite.sh` es la superficie estable (shim, ver la
plantilla arriba) sobre `src/internal/scripts/mefisto-test-suite.sh`, el runner
repo-only de la suite COMPLETA de Mefisto (issue #1416): compone el inventario
autoritativo (`src/internal/scripts/lib/mefisto-test-inventory.sh`, issue
#1438) con el ejecutor concurrente (issue #1440) sin reimplementar ninguno de
los dos contratos. La cabecera del script tiene el detalle completo; aqui solo
el contrato de uso.

Invocacion:

```bash
MEFISTO_RUNTIME=claude ./.claude/scripts/mefisto-test-suite.sh [--log-dir <dir>]
MEFISTO_RUNTIME=claude ./.claude/scripts/mefisto-test-suite.sh --help
```

`MEFISTO_RUNTIME=<id>` es la convencion `{{mefisto:run}}` del lado interno
para invocar un script neutral desde texto de doctrina (MEF-ADR-0049); no es
una dependencia del runner con ese runtime en particular (MEF-ADR-0050) -- el
runner solo usa bash, coreutils y git.

Tres carriles, tal como los define el inventario (descubrimiento dinamico, sin
conteos fijos que mantener al dia aqui):

- `publicado`: `test-*.sh` ejecutables bajo `scripts/tests/`.
- `interno`: `test-*.sh` ejecutables bajo `.claude/scripts/tests/`.
- `canonico-adicional`: fuentes canonicas sin shim homonimo en `scripts/tests/`
  (registro explicito en `mefisto-test-inventory.sh`).

Exit codes: `0` toda la suite termino PASS; `1` inventario invalido, cobertura
canonica incompleta, argumentos invalidos, o al menos una entrada termino
FAIL; `130` la corrida se interrumpio con INT; `143` con TERM. En los cuatro
casos se conservan los logs ya escritos.

Logs y resultados: cada corrida crea (o reutiliza, con `--log-dir`) un
directorio unico bajo `.mefisto/pipeline/test-suite/<run>/` (ignorado por
Git), con un subdirectorio por carril dentro: `<run>/<carril>/results.tsv`
(una linea por entrada) y `<run>/<carril>/logs/` (un log por entrada).

Costo esperado: minutos, no segundos -- nunca dentro de un stage con
presupuesto de agente acotado. Aqui no vive ninguna cifra a proposito, porque
ninguna seria una promesa: la carga de la maquina, el cache y el crecimiento
del inventario mueven la duracion de una corrida a otra (la medicion real,
fechada y con sha, queda en el PR del issue #1439).

Casos de uso explicitos: una persona antes de mergear un cambio transversal a
los tres carriles; un agente fuera de stage al que se le pida deliberadamente
la regresion completa; una CI futura, si se adopta, de forma opt-in. No es una
operacion publicada al proyecto consumidor (MEF-ADR-0019): vive solo del lado
interno de Mefisto. Tampoco es gate de ningun stage interno -- los prompts de
`mefisto-tooling-pipeline.sh` siguen cerrando con `scripts/tests/test-guards.sh`
mas los tests del diff, nunca con esta suite completa.

## Deuda conocida: `python3` en el resumen del CHANGELOG

`mefisto-release.sh` usa `python3` en 6 puntos (extraccion y reescritura de
secciones del CHANGELOG, resumen de categorias del body del PR de release) --
preexistente a esta migracion, deliberadamente fuera de alcance del issue
#864. Es la unica dependencia de este directorio fuera del toolchain
bash + jq + git + gh; sustituirla por `awk`/`jq` es trabajo de un issue futuro.
