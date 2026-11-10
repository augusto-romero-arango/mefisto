#!/usr/bin/env bash
# test-changelog-gate.sh -- Tests del gate de fragmentos de CHANGELOG (changelog.d/, issue #380).
#
# Valida las funciones de _mefisto-common.sh que sostienen el gate de
# fragmentos del pipeline interno mefisto-tooling. Reemplaza el gate anterior
# sobre edicion directa de CHANGELOG.md (issue #70, endurecido en #133): esa
# edicion por-PR de un archivo-indice compartido era el punto de contencion
# que colisionaba entre PRs paralelos o en la ventana entre sync y merge, y
# es exactamente lo que #380 elimina.
#
#   [pre] Las funciones del gate estan definidas.
#   [A] is_path_changelog_exempt clasifica rutas exentas vs notables.
#   [B] changelog_fragment_added detecta la presencia de un fragmento en changelog.d/.
#   [C] gate_would_abort, la decision compuesta del gate, sobre diffs simulados
#       en un repo git temporal:
#         - diff NOTABLE sin fragmento  -> el gate ABORTA
#         - diff EXENTO sin fragmento   -> el gate PASA
#         - diff NOTABLE con fragmento  -> el gate PASA
#   [D] Paridad: el pipeline real invoca las mismas funciones que este test, y
#       ya no referencia el gate obsoleto sobre CHANGELOG.md directo.
#
# gate_would_abort replica EXACTAMENTE la decision del pipeline
# (.claude/scripts/mefisto-tooling-pipeline.sh, bloque "Verificando fragmento
# de CHANGELOG (changelog.d/)").
#
# La consolidacion de fragmentos (fase prepare de /mefisto-release) se cubre
# aparte en test-changelog-consolidation.sh.
#
# Uso: .claude/scripts/tests/test-changelog-gate.sh
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

# gate_would_abort <wt> <base>
# Replica la decision del gate del pipeline: aborta solo si el cambio es
# notable Y no hay fragmento en changelog.d/. Retorna 0 si abortaria, 1 si no.
gate_would_abort() {
    local wt="$1" base="$2"
    if changelog_fragment_added "$wt" "$base"; then return 1; fi          # fragmento -> no aborta
    if ! changes_require_changelog "$wt" "$base"; then return 1; fi       # exento -> no aborta
    return 0                                                               # notable y sin fragmento -> aborta
}

# -------- Bloque pre: funciones existen --------

echo "[pre] Las funciones del gate estan definidas"
for fn in is_path_changelog_exempt changes_require_changelog changelog_fragment_added; do
    if declare -F "$fn" >/dev/null; then
        pass "$fn definida en _mefisto-common.sh"
    else
        fail "$fn NO definida"
    fi
done

# -------- Bloque A: is_path_changelog_exempt --------

echo ""
echo "[A] is_path_changelog_exempt clasifica rutas exentas vs notables"

# AGENTS.md: doctrina canonica neutral (MEF-ADR-0049, issue #852) -- mismo
# tratamiento de gobierno que CLAUDE.md, exenta de exigir fragmento.
for exempt in "docs/bitacora/algo.md" "docs/bitacora/field-notes/2026-x.md" "README.md" "CLAUDE.md" "AGENTS.md" ".gitignore"; do
    if is_path_changelog_exempt "$exempt"; then
        pass "'$exempt' exento (no exige fragmento)"
    else
        fail "'$exempt' deberia ser exento"
    fi
done

# src/internal/ esta en scope (issue #852) pero NO es gobierno: cambiarlo es un
# cambio de comportamiento y exige fragmento.
for notable in "commands/x.md" "agents/y.md" "scripts/z.sh" ".claude/scripts/w.sh" "docs/adr/mef-adr-0021-infraestructura-base.md" "hooks/hooks.json" "CHANGELOG.md" "src/internal/x.ts"; do
    if is_path_changelog_exempt "$notable"; then
        fail "'$notable' deberia ser NOTABLE (exige fragmento)"
    else
        pass "'$notable' notable (exige fragmento)"
    fi
done

# -------- Bloque B: changelog_fragment_added detecta fragmentos --------

echo ""
echo "[B] changelog_fragment_added detecta la presencia de un fragmento en changelog.d/"

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

git -C "$TMP" init -q
git -C "$TMP" config user.email "t@t.test"
git -C "$TMP" config user.name "test"

cat > "$TMP/CHANGELOG.md" <<'EOF'
# Changelog

## [Unreleased]

## [0.1.0] - 2026-01-01

### Added

- inicial
EOF
mkdir -p "$TMP/commands" "$TMP/docs/bitacora" "$TMP/changelog.d"
echo "base" > "$TMP/commands/existente.md"
echo "# Como funcionan los fragmentos" > "$TMP/changelog.d/README.md"
git -C "$TMP" add -A >/dev/null
git -C "$TMP" commit -qm "base"
BASE=$(git -C "$TMP" rev-parse HEAD)

reset_wt() { git -C "$TMP" reset -q --hard HEAD; git -C "$TMP" clean -qfd; }

# B-1: fragmento nuevo -> detectado
reset_wt
echo "- entrada del fragmento" > "$TMP/changelog.d/380.added.md"
if changelog_fragment_added "$TMP" "$BASE"; then
    pass "B-1: detecta el fragmento changelog.d/380.added.md"
else
    fail "B-1: NO detecto el fragmento changelog.d/380.added.md"
fi

# B-2: el README del propio mecanismo NO cuenta como fragmento
reset_wt
echo "# actualizacion del doc" > "$TMP/changelog.d/README.md"
if changelog_fragment_added "$TMP" "$BASE"; then
    fail "B-2: changelog.d/README.md NO debia contar como fragmento"
else
    pass "B-2: changelog.d/README.md no cuenta como fragmento"
fi

# B-3: sin fragmento -> no detectado
reset_wt
echo "cambio" > "$TMP/commands/existente.md"
if changelog_fragment_added "$TMP" "$BASE"; then
    fail "B-3: no habia fragmento y lo detecto igual"
else
    pass "B-3: sin fragmento, changelog_fragment_added retorna 1"
fi

# -------- Bloque C: gate_would_abort (decision compuesta) --------

echo ""
echo "[C] gate_would_abort: decision compuesta sobre diffs simulados"

# C-1: cambio NOTABLE anotado SOLO como fragmento -> el gate NO aborta. Es el
# caso central de #380: toca scripts (notable), no toca CHANGELOG.md, y anota
# su cambio en changelog.d/.
reset_wt
echo "cambio" > "$TMP/commands/existente.md"
echo "- entrada del fragmento" > "$TMP/changelog.d/380.added.md"
if changes_require_changelog "$TMP" "$BASE"; then
    pass "C-1: cambio en commands/existente.md clasificado como notable"
else
    fail "C-1: commands/existente.md deberia ser notable"
fi
if gate_would_abort "$TMP" "$BASE"; then
    fail "C-1: el gate NO debia abortar con un cambio notable anotado como fragmento"
else
    pass "C-1: el gate PASA con un cambio notable anotado como fragmento"
fi

# C-2: cambio NOTABLE sin fragmento -> el gate ABORTA (no se aflojo el gate).
reset_wt
echo "cambio" > "$TMP/commands/existente.md"
if gate_would_abort "$TMP" "$BASE"; then
    pass "C-2: el gate ABORTA ante cambio notable sin fragmento"
else
    fail "C-2: el gate deberia abortar sin fragmento"
fi

# C-3: cambio EXENTO (solo docs/bitacora) sin fragmento -> el gate PASA.
reset_wt
mkdir -p "$TMP/docs/bitacora"
echo "nota de bitacora" > "$TMP/docs/bitacora/2026-x.md"
if changes_require_changelog "$TMP" "$BASE"; then
    fail "C-3: solo docs/bitacora NO deberia ser notable"
else
    pass "C-3: cambio exento (solo docs/bitacora) clasificado como no notable"
fi
if gate_would_abort "$TMP" "$BASE"; then
    fail "C-3: el gate NO deberia abortar ante cambio exento"
else
    pass "C-3: el gate PASA ante cambio exento sin fragmento"
fi

# -------- Bloque D: paridad con el pipeline real --------

echo ""
echo "[D] Paridad: el pipeline real invoca las mismas funciones que este test"

PIPE="$REPO_ROOT/src/internal/scripts/mefisto-tooling-pipeline.sh"

if grep -q 'if changelog_fragment_added "\$WORKTREE_PATH" "\$SNAPSHOT_COMMIT"; then' "$PIPE"; then
    pass "D-1: mefisto-tooling-pipeline.sh invoca changelog_fragment_added en el gate"
else
    fail "D-1: el pipeline real NO invoca changelog_fragment_added (gate_would_abort divergiria)"
fi

if grep -q 'elif ! changes_require_changelog "\$WORKTREE_PATH" "\$SNAPSHOT_COMMIT"; then' "$PIPE"; then
    pass "D-2: mefisto-tooling-pipeline.sh invoca changes_require_changelog en el gate"
else
    fail "D-2: el pipeline real NO invoca changes_require_changelog (gate_would_abort divergiria)"
fi

if grep -q 'check_unreleased_touched\|detect_misplaced_changelog_entry' "$PIPE"; then
    fail "D-3: el pipeline real todavia referencia el gate obsoleto sobre CHANGELOG.md directo"
else
    pass "D-3: el pipeline real ya NO referencia el gate obsoleto (solo-fragmentos)"
fi

if declare -F check_unreleased_touched >/dev/null || declare -F detect_misplaced_changelog_entry >/dev/null; then
    fail "D-4: _mefisto-common.sh todavia define una funcion del gate obsoleto"
else
    pass "D-4: _mefisto-common.sh ya no define funciones del gate obsoleto"
fi

# D-5: el fragmento tiene que llegar al PR, no solo satisfacer el gate.
# changelog_fragment_added acepta un fragmento que solo existe en el working
# tree, asi que si changelog.d/ falta en la lista de paths del auto-commit el
# gate pasaria y el fragmento nunca entraria a un commit: anotacion perdida en
# silencio y /mefisto-release sin nada que consolidar. Las dos listas de paths
# del pipeline (auto_commit_if_needed y la deteccion de cambios del writer)
# deben incluir changelog.d/.
# Las listas de pathspec de git son las que enumeran 'commands/ agents/ scripts/'
# separadas por espacios (no la prosa del prompt, que las separa por comas).
PATH_LISTS_TOTAL=$(grep -c 'commands/ agents/ scripts/ hooks/' "$PIPE" || true)
PATH_LISTS_OK=$(grep -c 'commands/ agents/ scripts/ hooks/.*changelog\.d/ ' "$PIPE" || true)
if [ "$PATH_LISTS_TOTAL" -gt 0 ] && [ "$PATH_LISTS_OK" -eq "$PATH_LISTS_TOTAL" ]; then
    pass "D-5: las $PATH_LISTS_TOTAL listas de paths del pipeline incluyen changelog.d/ (el fragmento se commitea)"
else
    fail "D-5: solo $PATH_LISTS_OK de $PATH_LISTS_TOTAL listas de paths incluyen changelog.d/ (el fragmento podria no llegar al PR)"
fi

# -------- Resumen --------

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
