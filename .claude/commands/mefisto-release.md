---
description: "Versiona y publica el plugin Mefisto siguiendo SemVer y Keep a Changelog."
model: "sonnet"
argument-hint: "patch|minor|major [--prepare-only]"
---
<!-- GENERADO por src/internal/scripts/generate-internal-adapters.sh desde src/internal/commands/mefisto-release.md. No editar a mano. -->

Versiona y publica el plugin Mefisto siguiendo SemVer y Keep a Changelog. Comunicate en **espanol**.

**Alcance**: solo opera sobre el propio repo de Mefisto. No tiene equivalente publicado (el versionado del plugin es un artefacto de empaquetado del harness, no del marco arquitectonico).

## Entrada

Los argumentos estan en: $ARGUMENTS

Formas validas:
- `patch` -- bumpea `Z` en `X.Y.Z` (fase prepare, encadena merge + sync + publish)
- `minor` -- bumpea `Y` y resetea `Z` (fase prepare, encadena merge + sync + publish)
- `major` -- bumpea `X` y resetea `Y.Z` (fase prepare, encadena merge + sync + publish)
- `patch|minor|major --prepare-only` -- fase prepare sola: crea el PR y se detiene (no mergea, no publica)
- *(sin argumentos)* -- detecta automaticamente la fase publish (tag + GitHub Release); tambien la re-invocacion automatica que hace el encadenamiento tras el merge

## Proceso

### 0. Verificar que estas en el repo de Mefisto

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "ERROR: no estas en un repositorio git"; exit 1;
}
[ -f "$REPO_ROOT/.claude-plugin/plugin.json" ] || {
    echo "ERROR: este skill solo se ejecuta en el repo de Mefisto."
    echo "Abre el repo del plugin (augusto-romero-arango/mefisto) y reintenta."
    exit 1
}
```

### 1. Delegar al pipeline

```bash
MEFISTO_RUNTIME=claude ./.claude/scripts/mefisto-release.sh $ARGUMENTS
```

El script detecta solo en que fase estamos:

- **Fase prepare** (`plugin.json.version == ultimo tag`): valida el argumento `patch|minor|major`, calcula la siguiente version segun SemVer, crea la rama `release/vX.Y.Z` desde `origin/main`, **corre el gate de neutralidad de runtime** (`mefisto-neutrality-gate.sh`, MEF-ADR-0049: aborta listando cada fuga como `<ruta>:<linea>: <regla>`; la fase publish no lo repite), **consolida los fragmentos de `changelog.d/`** (los de CHANGELOG al bloque `[Unreleased]` agrupados por categoria Keep a Changelog; los `*.adr-index.md` a la tabla del indice tematico de `docs/adr/INDICE-TEMATICO.md`) y borra los consumidos, comprueba que `[Unreleased]` no queda vacio, mueve el bloque `[Unreleased]` a una seccion versionada con fecha UTC, actualiza los links de comparacion al pie, bumpea `.claude-plugin/plugin.json`, commitea, pushea y abre el PR contra `main` con titulo `chore(release): vX.Y.Z`. El body del PR **no lleva las notas completas**: lleva un indice de las categorias con su conteo de entradas mas un link a `CHANGELOG.md` en la rama de release (issue #405 -- una sola seccion versionada de este repo ya supera el limite de 65.536 caracteres de la API para bodies de PR; las notas integras estan en el diff del PR y en el GitHub Release de la fase publish).
  - **Por defecto (issue #759), encadena automaticamente** tras crear el PR: (1) `gh pr merge --squash --delete-branch`, (2) sync verificado -- confirma `state == MERGED` y el commit de merge via `gh pr view --json state,mergeCommit`, `git fetch origin main`, `git merge-base --is-ancestor <mergeCommit.oid> origin/main`, luego `git switch main` + `git merge --ff-only origin/main` --, (3) se re-invoca a si mismo sin argumentos (por ruta absoluta, resuelta antes del `cd` al root del repo), lo que aterriza en la fase publish.
  - Con **`--prepare-only`**: se detiene tras crear el PR (comportamiento previo a #759), sin mergear ni publicar.
  - **Fail-loud por eslabon**: si el merge falla, el sync no confirma el commit en `origin/main`, o la fase publish re-invocada aborta por precondicion, el script termina con exit code distinto de cero reportando que quedo hecho y el paso manual restante.
- **Fase publish** (`plugin.json.version > ultimo tag`): valida que estamos en `main`, working tree limpio, al dia con `origin/main` y `gh` autenticado; extrae las notas de la seccion versionada del CHANGELOG; crea el tag anotado `vX.Y.Z`; pushea el tag; crea el GitHub Release con esas notas.

No implementes nada tu mismo. Lanza el script y reporta el resultado.

## Flujo de extremo a extremo

Camino feliz (default, una sola invocacion):

```
/mefisto-release minor          # fase prepare -> abre PR, mergea, sincroniza main
                                 # y encadena la fase publish -> tag + GitHub Release
```

Camino con revision manual del PR (`--prepare-only`):

```
/mefisto-release minor --prepare-only   # fase prepare -> abre PR release/vX.Y+1.0, se detiene
/mefisto-merge <pr>                     # mergea el PR a main (squash + delete-branch)
git switch main && git pull --ff-only   # actualiza main local
/mefisto-release                        # fase publish -> tag + GitHub Release
```

## Reglas

- **Nunca commitear directo a `main`**: la fase prepare siempre pasa por PR (`release/vX.Y.Z`). Esta es la unica excepcion permitida al contrato del repo y se respeta igualmente.
- **No bypasses**: si el script aborta por `[Unreleased]` vacio, una fuga de neutralidad de runtime o una distribucion publicada desactualizada respecto a su fuente (ambas se corrigen en `main` via PR de issue, nunca en la rama de release), un fragmento de `changelog.d/` mal nombrado, falta de tag previo, `gh` no autenticado, working tree sucio, desfase con `origin/main`, fallo de merge o de sync verificado, no intentes saltartelo. Resuelve la precondicion y reintenta (el script indica el paso manual restante).
- **`/mefisto-release` es el UNICO que edita `CHANGELOG.md` y la tabla del indice tematico de `docs/adr/INDICE-TEMATICO.md`** (issue #380), y solo dentro de la rama `release/vX.Y.Z`. Los PRs de issue anotan su cambio como fragmento en `changelog.d/` (ver `changelog.d/README.md`); no backfillees a mano lo que la consolidacion hace sola.
- **No tocar `.claude-plugin/marketplace.json`**: no lleva campo `version`.
- **No incluir el header `## [X.Y.Z] - ...`** en las notas del GitHub Release. Solo las subsecciones (`### Added`, `### Changed`, etc.) del bloque.
- **Idempotencia**: si el tag `vX.Y.Z` o el GitHub Release ya existen, el script aborta sin tocar nada.
- **`--prepare-only`** solo es valido junto a `patch|minor|major`; usalo cuando quieras revisar el diff del PR de release antes de mergear.

## Reporte esperado

- **Tras prepare + encadenamiento (default)**: imprime el numero del PR, la confirmacion del merge y del sync, y termina reportando la URL del GitHub Release publicado (igual que "tras publish" abajo).
- **Tras prepare con `--prepare-only`**: imprime el numero del PR creado y la siguiente instruccion (`/mefisto-merge <pr>` + `git switch main && git pull --ff-only` + `/mefisto-release`).
- **Tras publish**: imprime la URL del release publicado y un resumen `vPREV -> vX.Y.Z`.
