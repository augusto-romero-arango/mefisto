#!/usr/bin/env bash
# test-changelog-consolidation.sh -- Tests de la consolidacion de fragmentos
# de changelog.d/ (issue #380), fase prepare de /mefisto-release.
#
# Valida las dos funciones de _mefisto-common.sh. /mefisto-release usa sus
# gemelas en TypeScript (lib/mefisto-release-lib.mts), que tienen su propio
# test (mefisto-release-lib.test.mts) con la paridad entre las dos:
#
#   [A] consolidate_changelog_fragments agrupa por categoria Keep a Changelog
#       (added/changed/fixed/removed), preserva subsecciones ya existentes en
#       [Unreleased], borra los fragmentos consumidos, ignora README.md y
#       *.adr-index.md, y aborta ante un nombre de fragmento invalido.
#   [B] consolidate_adr_index_fragments anexa filas *.adr-index.md a la tabla
#       "Indice tematico" de docs/adr/INDICE-TEMATICO.md, en orden de nombre de
#       archivo, y borra los fragmentos consumidos.
#   [C] Ausencia de contencion (la razon de ser de #380): dos fragmentos de
#       issues distintos en ramas independientes que parten del mismo commit
#       base mergean SIN conflicto de git. C-1 es un control que reproduce el
#       incidente (dos ramas editando la MISMA linea de un archivo-indice SI
#       colisionan); C-2 es el mecanismo de fragmentos (NO colisionan).
#
# Uso: .claude/scripts/tests/test-changelog-consolidation.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# shellcheck source=/dev/null
source "$REPO_ROOT/.claude/scripts/_mefisto-common.sh" 2>/dev/null

# Un unico directorio padre (en vez de un array de temporales) evita el bug de
# bash 3.2 (default en macOS) donde un array vacio bajo 'set -u' se trata como
# variable no definida al expandirse en el trap EXIT de una subshell heredada
# (cualquier $(...) de este script, p. ej. el propio "mktemp -d").
PARENT_TMP=$(mktemp -d)
trap 'rm -rf "$PARENT_TMP"' EXIT

new_tmp_repo() {
    mktemp -d "$PARENT_TMP/repo.XXXXXX"
}

# -------- Bloque A: consolidate_changelog_fragments --------

echo "[A] consolidate_changelog_fragments agrupa por categoria y borra los fragmentos consumidos"

TMP=$(new_tmp_repo)
mkdir -p "$TMP/changelog.d"
cat > "$TMP/CHANGELOG.md" <<'EOF'
# Changelog

## [Unreleased]

## [0.1.0] - 2026-01-01

### Added

- inicial
EOF

# A-1: dos fragmentos (added + fixed) se agrupan bajo sus subsecciones y se borran.
echo "- Se anade el mecanismo de fragmentos de CHANGELOG." > "$TMP/changelog.d/380.added.md"
echo "- Se corrige un bug menor." > "$TMP/changelog.d/381.fixed.md"
echo "| Doctrina X | MEF-ADR-0036 |" > "$TMP/changelog.d/380.adr-index.md"
echo "# doc del mecanismo" > "$TMP/changelog.d/README.md"

if consolidate_changelog_fragments "$TMP"; then
    pass "A-1: consolidate_changelog_fragments retorna 0"
else
    fail "A-1: consolidate_changelog_fragments deberia retornar 0"
fi

if grep -q '### Added' "$TMP/CHANGELOG.md" && grep -q 'Se anade el mecanismo de fragmentos' "$TMP/CHANGELOG.md"; then
    pass "A-1: la entrada 'added' quedo bajo '### Added'"
else
    fail "A-1: la entrada 'added' no aparece bajo '### Added'"
fi
if grep -q '### Fixed' "$TMP/CHANGELOG.md" && grep -q 'Se corrige un bug menor' "$TMP/CHANGELOG.md"; then
    pass "A-1: la entrada 'fixed' quedo bajo '### Fixed'"
else
    fail "A-1: la entrada 'fixed' no aparece bajo '### Fixed'"
fi
if [ ! -e "$TMP/changelog.d/380.added.md" ] && [ ! -e "$TMP/changelog.d/381.fixed.md" ]; then
    pass "A-1: los fragmentos de changelog consumidos se borraron"
else
    fail "A-1: los fragmentos de changelog consumidos deberian haberse borrado"
fi
if [ -e "$TMP/changelog.d/380.adr-index.md" ]; then
    pass "A-1: el fragmento *.adr-index.md NO se toco (lo consume otra funcion)"
else
    fail "A-1: el fragmento *.adr-index.md no deberia tocarse aqui"
fi
if [ -e "$TMP/changelog.d/README.md" ]; then
    pass "A-1: changelog.d/README.md no se borro"
else
    fail "A-1: changelog.d/README.md no deberia borrarse"
fi

# A-2: fragmento con nombre invalido -> aborta sin modificar CHANGELOG.md.
TMP=$(new_tmp_repo)
mkdir -p "$TMP/changelog.d"
cat > "$TMP/CHANGELOG.md" <<'EOF'
# Changelog

## [Unreleased]

## [0.1.0] - 2026-01-01
EOF
BEFORE=$(cat "$TMP/CHANGELOG.md")
echo "- oops" > "$TMP/changelog.d/sin-numero.added.md"
if consolidate_changelog_fragments "$TMP"; then
    fail "A-2: deberia abortar ante un fragmento con nombre invalido"
else
    pass "A-2: aborta (exit != 0) ante un fragmento con nombre invalido"
fi
AFTER=$(cat "$TMP/CHANGELOG.md")
if [ "$BEFORE" = "$AFTER" ]; then
    pass "A-2: CHANGELOG.md no se modifico al abortar"
else
    fail "A-2: CHANGELOG.md no deberia modificarse al abortar"
fi
if [ -e "$TMP/changelog.d/sin-numero.added.md" ]; then
    pass "A-2: el fragmento invalido no se borro"
else
    fail "A-2: el fragmento invalido no deberia borrarse"
fi

# A-3: sin fragmentos (o sin changelog.d/) -> no-op.
TMP=$(new_tmp_repo)
cat > "$TMP/CHANGELOG.md" <<'EOF'
# Changelog

## [Unreleased]

## [0.1.0] - 2026-01-01
EOF
if consolidate_changelog_fragments "$TMP"; then
    pass "A-3: sin changelog.d/, consolidate_changelog_fragments es un no-op (exit 0)"
else
    fail "A-3: sin changelog.d/ no deberia abortar"
fi

# A-4: la consolidacion reescribe el bloque [Unreleased] entero, asi que todo lo
# que ya vivia ahi debe sobrevivir: tanto las entradas de una subseccion previa
# como un preambulo suelto escrito a mano ANTES de la primera '###'. Perder ese
# preambulo seria un borrado silencioso de notas del release.
TMP=$(new_tmp_repo)
mkdir -p "$TMP/changelog.d"
cat > "$TMP/CHANGELOG.md" <<'EOF'
# Changelog

## [Unreleased]

Nota manual suelta, sin subseccion.

### Added

- entrada previa

## [0.1.0] - 2026-01-01
EOF
echo "- entrada del fragmento" > "$TMP/changelog.d/380.added.md"
if consolidate_changelog_fragments "$TMP"; then
    pass "A-4: consolidate_changelog_fragments retorna 0 sobre un [Unreleased] con contenido previo"
else
    fail "A-4: consolidate_changelog_fragments deberia retornar 0"
fi
if grep -q 'Nota manual suelta, sin subseccion.' "$TMP/CHANGELOG.md"; then
    pass "A-4: el preambulo suelto de [Unreleased] sobrevive la consolidacion"
else
    fail "A-4: el preambulo suelto de [Unreleased] se perdio (borrado silencioso)"
fi
if grep -q 'entrada previa' "$TMP/CHANGELOG.md" && grep -q 'entrada del fragmento' "$TMP/CHANGELOG.md"; then
    pass "A-4: la entrada previa y la del fragmento conviven bajo '### Added'"
else
    fail "A-4: se perdio la entrada previa o la del fragmento"
fi
# El preambulo va antes del primer '### ', no dentro de una subseccion.
LINE_NOTA=$(grep -n 'Nota manual suelta' "$TMP/CHANGELOG.md" | head -1 | cut -d: -f1)
LINE_ADDED=$(grep -n '^### Added' "$TMP/CHANGELOG.md" | head -1 | cut -d: -f1)
if [ "$LINE_NOTA" -lt "$LINE_ADDED" ]; then
    pass "A-4: el preambulo conserva su posicion (antes de la primera subseccion)"
else
    fail "A-4: el preambulo quedo fuera de sitio"
fi

# -------- Bloque B: consolidate_adr_index_fragments --------

echo ""
echo "[B] consolidate_adr_index_fragments anexa filas a la tabla de docs/adr/INDICE-TEMATICO.md"

TMP=$(new_tmp_repo)
mkdir -p "$TMP/changelog.d" "$TMP/docs/adr"
cat > "$TMP/docs/adr/INDICE-TEMATICO.md" <<'EOF'
### Índice temático

| Tema | ADR |
|---|---|
| Topics de Service Bus por evento | MEF-ADR-0001 |
| Estrategia de testing con event sourcing (Given/When/Then) | MEF-ADR-0002 |

## Convenciones del marco
EOF

# B-1: dos fragmentos ADR se anexan en orden de nombre de archivo.
echo "| Doctrina B | MEF-ADR-0037 |" > "$TMP/changelog.d/377.adr-index.md"
echo "| Doctrina A | MEF-ADR-0036 |" > "$TMP/changelog.d/376.adr-index.md"

if consolidate_adr_index_fragments "$TMP"; then
    pass "B-1: consolidate_adr_index_fragments retorna 0"
else
    fail "B-1: consolidate_adr_index_fragments deberia retornar 0"
fi

if grep -q 'MEF-ADR-0036' "$TMP/docs/adr/INDICE-TEMATICO.md" && grep -q 'MEF-ADR-0037' "$TMP/docs/adr/INDICE-TEMATICO.md"; then
    pass "B-1: ambas filas (MEF-ADR-0036 y MEF-ADR-0037) aparecen en docs/adr/INDICE-TEMATICO.md"
else
    fail "B-1: faltan filas en la tabla de docs/adr/INDICE-TEMATICO.md"
fi

LINE_36=$(grep -n 'MEF-ADR-0036' "$TMP/docs/adr/INDICE-TEMATICO.md" | head -1 | cut -d: -f1)
LINE_37=$(grep -n 'MEF-ADR-0037' "$TMP/docs/adr/INDICE-TEMATICO.md" | head -1 | cut -d: -f1)
LINE_CONV=$(grep -n '^## Convenciones del marco' "$TMP/docs/adr/INDICE-TEMATICO.md" | head -1 | cut -d: -f1)
if [ "$LINE_36" -lt "$LINE_37" ] && [ "$LINE_37" -lt "$LINE_CONV" ]; then
    pass "B-1: las filas se insertaron en orden de nombre de archivo (376 antes que 377), antes de la siguiente seccion"
else
    fail "B-1: el orden/posicion de insercion de las filas es incorrecto"
fi

if [ ! -e "$TMP/changelog.d/376.adr-index.md" ] && [ ! -e "$TMP/changelog.d/377.adr-index.md" ]; then
    pass "B-1: los fragmentos *.adr-index.md consumidos se borraron"
else
    fail "B-1: los fragmentos *.adr-index.md consumidos deberian haberse borrado"
fi

# B-2: sin fragmentos *.adr-index.md -> no-op, docs/adr/INDICE-TEMATICO.md intacto.
TMP=$(new_tmp_repo)
mkdir -p "$TMP/changelog.d" "$TMP/docs/adr"
cat > "$TMP/docs/adr/INDICE-TEMATICO.md" <<'EOF'
### Índice temático

| Tema | ADR |
|---|---|
| Topics de Service Bus por evento | MEF-ADR-0001 |

## Convenciones del marco
EOF
BEFORE=$(cat "$TMP/docs/adr/INDICE-TEMATICO.md")
if consolidate_adr_index_fragments "$TMP"; then
    pass "B-2: sin fragmentos *.adr-index.md, retorna 0 (no-op)"
else
    fail "B-2: sin fragmentos no deberia abortar"
fi
AFTER=$(cat "$TMP/docs/adr/INDICE-TEMATICO.md")
if [ "$BEFORE" = "$AFTER" ]; then
    pass "B-2: docs/adr/INDICE-TEMATICO.md queda intacto sin fragmentos que consolidar"
else
    fail "B-2: docs/adr/INDICE-TEMATICO.md no deberia modificarse sin fragmentos"
fi

# -------- Bloque C: ausencia de contencion --------

echo ""
echo "[C] Ausencia de contencion: dos issues distintos no colisionan en changelog.d/"

# C-1 (control -- reproduce el incidente de #376/#377): dos ramas que parten
# del mismo commit base editan la MISMA linea de un archivo-indice monolitico
# (el CLAUDE.md pre-#380). Git SI reporta conflicto de merge.
TMP=$(new_tmp_repo)
git -C "$TMP" init -q
git -C "$TMP" config user.email "t@t.test"
git -C "$TMP" config user.name "test"
cat > "$TMP/CLAUDE.md" <<'EOF'
### Índice temático

| Tema | ADR |
|---|---|
| Topics de Service Bus por evento | MEF-ADR-0001 |

## Convenciones del marco
EOF
git -C "$TMP" add -A >/dev/null
git -C "$TMP" commit -qm "base"
git -C "$TMP" branch -m main >/dev/null 2>&1 || true

git -C "$TMP" checkout -qb pr-376
sed -i.bak '/MEF-ADR-0001/a\
| Doctrina A | MEF-ADR-0036 |' "$TMP/CLAUDE.md" && rm -f "$TMP/CLAUDE.md.bak"
git -C "$TMP" commit -qam "pr-376: anade fila del indice"

git -C "$TMP" checkout -q main
git -C "$TMP" checkout -qb pr-377
sed -i.bak '/MEF-ADR-0001/a\
| Doctrina B | MEF-ADR-0037 |' "$TMP/CLAUDE.md" && rm -f "$TMP/CLAUDE.md.bak"
git -C "$TMP" commit -qam "pr-377: anade fila del indice"

git -C "$TMP" checkout -q pr-376
if git -C "$TMP" merge --no-edit pr-377 >/dev/null 2>&1; then
    fail "C-1 (control): dos PRs editando la MISMA linea de CLAUDE.md deberian colisionar (no colisiono)"
else
    pass "C-1 (control): dos PRs editando la MISMA linea de CLAUDE.md SI colisionan (reproduce el incidente)"
fi
git -C "$TMP" merge --abort >/dev/null 2>&1 || true

# C-2 (fix de #380): mismas dos "PRs", cada una anota su propio fragmento en
# changelog.d/ en vez de editar CLAUDE.md -- archivos DISTINTOS, sin colision.
TMP=$(new_tmp_repo)
git -C "$TMP" init -q
git -C "$TMP" config user.email "t@t.test"
git -C "$TMP" config user.name "test"
mkdir -p "$TMP/changelog.d"
echo "# doc del mecanismo" > "$TMP/changelog.d/README.md"
git -C "$TMP" add -A >/dev/null
git -C "$TMP" commit -qm "base"
git -C "$TMP" branch -m main >/dev/null 2>&1 || true

git -C "$TMP" checkout -qb pr-376
echo "| Doctrina A | MEF-ADR-0036 |" > "$TMP/changelog.d/376.adr-index.md"
git -C "$TMP" add -A >/dev/null
git -C "$TMP" commit -qm "pr-376: fragmento propio"

git -C "$TMP" checkout -q main
git -C "$TMP" checkout -qb pr-377
echo "| Doctrina B | MEF-ADR-0037 |" > "$TMP/changelog.d/377.adr-index.md"
git -C "$TMP" add -A >/dev/null
git -C "$TMP" commit -qm "pr-377: fragmento propio"

git -C "$TMP" checkout -q pr-376
if git -C "$TMP" merge --no-edit pr-377 >/dev/null 2>&1; then
    pass "C-2 (fix): dos fragmentos changelog.d/<issue>.adr-index.md de PRs distintos mergean SIN conflicto"
else
    fail "C-2 (fix): los fragmentos no deberian colisionar (si colisiono, el fix no elimina la contencion)"
    git -C "$TMP" merge --abort >/dev/null 2>&1 || true
fi
if [ -e "$TMP/changelog.d/376.adr-index.md" ] && [ -e "$TMP/changelog.d/377.adr-index.md" ]; then
    pass "C-2 (fix): ambos fragmentos sobreviven el merge"
else
    fail "C-2 (fix): deberian sobrevivir ambos fragmentos tras el merge"
fi

# -------- Resumen --------

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
