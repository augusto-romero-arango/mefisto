#!/usr/bin/env bash
# test-neutrality-gate.sh -- Tests de mefisto-neutrality-gate.sh (MEF-ADR-0049,
# issue #911, hijo 1 de 3 de #873).
#
# Cubre:
#   [pre]           El gate existe, es ejecutable y tiene sintaxis valida.
#   [clean]         Un arbol positivo (shims conformes, salidas con marcador,
#                   una excepcion de la allowlist realmente filtrada, prosa
#                   "claude runtime" que NO es invocacion, sin fugas)
#                   termina en exit 0 sin imprimir nada.
#   [R1]-[R4]       Un negativo por regla, cada uno con la linea
#                   "<ruta>:<linea>: <regla>" esperada; R1 anade un id de
#                   familia no enumerada (claude-nova-9) y R4 un shim con un
#                   salto de linea de mas (byte-exacto).
#   [adapters-check] Una divergencia de generate-internal-adapters.sh --check
#                   se reemite como "<ruta>: <estado>: adapters-check".
#   [published-adapters-check] Una divergencia de
#                   generate-published-adapters.sh --check se reemite como
#                   "<ruta>: <estado>: published-adapters-check"; un exit != 0
#                   sin lineas de divergencia produce la generica de exit; un
#                   --root sin ese script no cambia [clean].
#   [allowlist]     Una entrada de la allowlist sin 'motivo' hace abortar el
#                   gate (exit 1) antes de escanear nada.
#   [allowlist-origin] La allowlist se carga desde el gate (o --allowlist),
#                   nunca desde --root: un arbol que se exonera a si mismo en
#                   su propia allowlist sigue reportado (MEF-ADR-0019 E).
#   [wiring]        Afirmacion estatica (issue #914) por numero de linea de las
#                   llamadas: en mefisto-tooling-pipeline.sh, por cada stage,
#                   gate de scope < run_neutrality_gate < auto_commit_if_needed
#                   (CA-1); en mefisto-release.sh, una unica invocacion dentro
#                   de prepare, tras `git switch -c release/<tag>` y antes de
#                   consolidar changelog.d/ (CA-2, publish no la repite). El
#                   escenario e2e negativo (CLI falso del writer con una fuga
#                   real) vive en test-tooling-runtime-neutral.sh, escenario [F].
#   [perf]          Una corrida completa contra el repo real termina en menos
#                   de MEFISTO_NEUTRALITY_PERF_LIMIT segundos (default 60).
#                   Medicion que motivo el umbral (2026-10-02): 38s en local y
#                   42s en el runner macOS; el gate crecio con el repo. El
#                   proposito es detectar regresiones grandes, no medir
#                   rendimiento fino. Las dos verificaciones estructurales
#                   lanzan un generador completo cada una y dominan el reloj,
#                   asi que este bloque mide el total.
#                   Exit 0 o 1 indistinto.
#
# Los arboles de fixture son repos git minimos bajo un directorio temporal
# propio (nunca el repo real, salvo en [perf] y en la allowlist real que usa
# [allowlist-origin]): cada uno solo necesita los archivos en el INDICE
# (`git add -A`, sin commit -- `git ls-files` no exige un commit) para que el
# gate los vea. Cada arbol lleva su allowlist en la ruta canonica y se la pasa
# al gate con --allowlist, porque el gate NO la lee de --root.
#
# Uso: .claude/scripts/tests/test-neutrality-gate.sh
# Exit code: 0 si todos los checks pasan, 1 si alguno falla.

set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
GATE="$REPO_ROOT/src/internal/scripts/mefisto-neutrality-gate.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# new_tree <nombre> -- imprime la ruta de un repo git vacio nuevo bajo SCRATCH.
new_tree() {
    local dir="$SCRATCH/$1"
    mkdir -p "$dir"
    git -C "$dir" init -q >/dev/null 2>&1
    printf '%s' "$dir"
}

# write_allowlist <dir> <json> -- escribe la allowlist del arbol <dir>.
write_allowlist() {
    local dir="$1" json="$2"
    mkdir -p "$dir/src/internal/contract"
    printf '%s' "$json" > "$dir/src/internal/contract/neutrality-allowlist.json"
}

EMPTY_ALLOWLIST='{"scope_excluded": [], "exceptions": [], "not_migrated": []}'

# write_clean_generator <dir> -- stub de generate-internal-adapters.sh cuyo
# --check no reporta divergencias (exit 0, sin salida).
write_clean_generator() {
    local dir="$1"
    mkdir -p "$dir/src/internal/scripts"
    cat > "$dir/src/internal/scripts/generate-internal-adapters.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
}

# write_dirty_generator <dir> -- stub cuyo --check reporta una divergencia.
write_dirty_generator() {
    local dir="$1"
    mkdir -p "$dir/src/internal/scripts"
    cat > "$dir/src/internal/scripts/generate-internal-adapters.sh" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "--check" ]; then
    echo ".claude/agents/fx-agent.md: distinta"
    exit 1
fi
exit 0
EOF
}

# write_dirty_published_generator <dir> -- stub de
# generate-published-adapters.sh cuyo --check reporta una divergencia.
write_dirty_published_generator() {
    local dir="$1"
    mkdir -p "$dir/src/published/scripts"
    cat > "$dir/src/published/scripts/generate-published-adapters.sh" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "--check" ]; then
    echo "dist/claude/agents/fx-agent.md: distinta"
    exit 1
fi
exit 0
EOF
}

# write_dirty_published_generator_no_lines <dir> -- stub cuyo --check falla
# (exit 1) sin imprimir ninguna linea de divergencia.
write_dirty_published_generator_no_lines() {
    local dir="$1"
    mkdir -p "$dir/src/published/scripts"
    cat > "$dir/src/published/scripts/generate-published-adapters.sh" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "--check" ]; then
    exit 1
fi
exit 0
EOF
}

# write_generic_shim <ruta> -- shim conforme a la plantilla generica de
# src/internal/scripts/README.md.
write_generic_shim() {
    local path="$1"
    mkdir -p "$(dirname "$path")"
    cat > "$path" <<'EOF'
#!/usr/bin/env bash
# Shim de compatibilidad (MEF-ADR-0049): la implementacion canonica vive en src/internal/scripts/. No editar.
exec "$(cd "$(dirname "$0")/../.." && pwd)/src/internal/scripts/$(basename "$0")" "$@"
EOF
}

# write_common_shim <ruta> -- variante de una linea (`source`) para el shim
# de _mefisto-common.sh.
write_common_shim() {
    local path="$1"
    mkdir -p "$(dirname "$path")"
    cat > "$path" <<'EOF'
#!/usr/bin/env bash
# Shim de compatibilidad (MEF-ADR-0049): la implementacion canonica vive en src/internal/scripts/lib/_mefisto-common.sh. No editar.
# `source` (no `exec`): esta lib se sourcea desde otros scripts, nunca se ejecuta sola.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/src/internal/scripts/lib/_mefisto-common.sh"
EOF
}

git_add_all() {
    git -C "$1" add -A >/dev/null 2>&1
}

# run_gate <dir> -- corre el gate sobre el arbol <dir> CON la allowlist de ese
# mismo arbol (el gate no la toma de --root; ver [allowlist-origin]).
run_gate() {
    "$GATE" --root "$1" --allowlist "$1/src/internal/contract/neutrality-allowlist.json" 2>&1
}

echo "[pre] el gate existe, es ejecutable y tiene sintaxis valida"
if [ -f "$GATE" ]; then
    pass "existe $GATE"
else
    fail "no existe $GATE"
fi
if [ -x "$GATE" ]; then
    pass "es ejecutable"
else
    fail "no tiene el bit ejecutable"
fi
if bash -n "$GATE" 2>"$SCRATCH/syntax.err"; then
    pass "sintaxis bash valida"
else
    fail "error de sintaxis: $(cat "$SCRATCH/syntax.err")"
fi

echo ""
echo "[clean] arbol positivo: shims conformes, salidas con marcador, excepcion de la allowlist filtrada, sin fugas -> exit 0 sin salida"
DIR_CLEAN="$(new_tree clean)"
write_allowlist "$DIR_CLEAN" '{
  "scope_excluded": [],
  "exceptions": [
    { "path": "src/internal/scripts/lib/fx-allowed-model.sh", "rules": ["R1"], "motivo": "Fixture: archivo permitido a nombrar el alias sonnet a proposito." },
    { "path": "src/internal/contract/neutrality-allowlist.json", "rules": ["ALL"], "motivo": "Fixture: este mismo archivo cita 'sonnet' en el motivo de arriba, igual que la allowlist real se autorreferencia." }
  ],
  "not_migrated": [
    { "path": ".claude/scripts/fx-not-migrated.sh", "motivo": "Fixture: script no migrado a proposito.", "issue": null }
  ]
}'
mkdir -p "$DIR_CLEAN/src/internal/scripts/lib"
printf '#!/usr/bin/env bash\n# menciona el modelo sonnet a proposito (cubierto por la excepcion)\necho ok\n' > "$DIR_CLEAN/src/internal/scripts/lib/fx-allowed-model.sh"
printf '#!/usr/bin/env bash\n# el claude runtime lo resuelve el runner neutral: esto es prosa, no una invocacion\necho ok\n' > "$DIR_CLEAN/src/internal/scripts/lib/fx-clean.sh"
printf '#!/usr/bin/env bash\n# lee .claude-plugin/plugin.json (manifiesto fisico del plugin, no un id de modelo)\necho ok\n' > "$DIR_CLEAN/src/internal/scripts/lib/fx-plugin-manifest.sh"
printf 'doctrina neutral de ejemplo, sin fugas.\n' > "$DIR_CLEAN/AGENTS.md"
write_generic_shim "$DIR_CLEAN/.claude/scripts/fx-shim.sh"
write_common_shim "$DIR_CLEAN/.claude/scripts/_mefisto-common.sh"
printf '#!/usr/bin/env bash\necho "no soy un shim, pero estoy en not_migrated"\n' > "$DIR_CLEAN/.claude/scripts/fx-not-migrated.sh"
write_clean_generator "$DIR_CLEAN"
git_add_all "$DIR_CLEAN"

CLEAN_OUT="$(run_gate "$DIR_CLEAN")"
CLEAN_RC=$?
if [ "$CLEAN_RC" -eq 0 ]; then
    pass "exit 0"
else
    fail "exit $CLEAN_RC (esperaba 0). Salida: $CLEAN_OUT"
fi
if [ -z "$CLEAN_OUT" ]; then
    pass "sin salida"
else
    fail "imprimio salida pese a no tener fugas: $CLEAN_OUT"
fi

echo ""
echo "[R1] alias de modelo sin excepcion -> violacion R1"
DIR_R1="$(new_tree r1-neg)"
write_allowlist "$DIR_R1" "$EMPTY_ALLOWLIST"
write_clean_generator "$DIR_R1"
mkdir -p "$DIR_R1/src/internal/scripts/lib"
printf '#!/usr/bin/env bash\n# usa el modelo sonnet para esta tarea\necho ok\n' > "$DIR_R1/src/internal/scripts/lib/fx-model-leak.sh"
printf '#!/usr/bin/env bash\n# id de una familia que R1 no enumera: claude-nova-9\necho ok\n' > "$DIR_R1/src/internal/scripts/lib/fx-model-id-leak.sh"
git_add_all "$DIR_R1"
R1_OUT="$(run_gate "$DIR_R1")"
R1_RC=$?
if [ "$R1_RC" -ne 0 ] && printf '%s\n' "$R1_OUT" | grep -qE '^src/internal/scripts/lib/fx-model-leak\.sh:[0-9]+: R1$'; then
    pass "reporta 'src/internal/scripts/lib/fx-model-leak.sh:<linea>: R1' con exit != 0"
else
    fail "no reporto la violacion R1 esperada. exit=$R1_RC salida: $R1_OUT"
fi
if printf '%s\n' "$R1_OUT" | grep -qE '^src/internal/scripts/lib/fx-model-id-leak\.sh:[0-9]+: R1$'; then
    pass "reporta un id claude-* de familia no enumerada (claude-nova-9) como R1"
else
    fail "no reporto el id claude-nova-9 como R1. salida: $R1_OUT"
fi

echo ""
echo "[R2] invocacion directa de CLI sin excepcion -> violacion R2"
DIR_R2="$(new_tree r2-neg)"
write_allowlist "$DIR_R2" "$EMPTY_ALLOWLIST"
write_clean_generator "$DIR_R2"
mkdir -p "$DIR_R2/src/internal/scripts"
printf '#!/usr/bin/env bash\n# invoca claude -p directo, sin pasar por el runner neutral\necho ok\n' > "$DIR_R2/src/internal/scripts/fx-r2-leak.sh"
git_add_all "$DIR_R2"
R2_OUT="$(run_gate "$DIR_R2")"
R2_RC=$?
if [ "$R2_RC" -ne 0 ] && printf '%s\n' "$R2_OUT" | grep -qE '^src/internal/scripts/fx-r2-leak\.sh:[0-9]+: R2$'; then
    pass "reporta 'src/internal/scripts/fx-r2-leak.sh:<linea>: R2' con exit != 0"
else
    fail "no reporto la violacion R2 esperada. exit=$R2_RC salida: $R2_OUT"
fi

echo ""
echo "[R3] variable/ruta de runtime concreto sin excepcion -> violacion R3"
DIR_R3="$(new_tree r3-neg)"
write_allowlist "$DIR_R3" "$EMPTY_ALLOWLIST"
write_clean_generator "$DIR_R3"
mkdir -p "$DIR_R3/src/internal/scripts"
printf '#!/usr/bin/env bash\n# resuelve la ruta via CLAUDE_PROJECT_DIR (prohibido)\necho ok\n' > "$DIR_R3/src/internal/scripts/fx-r3-leak.sh"
git_add_all "$DIR_R3"
R3_OUT="$(run_gate "$DIR_R3")"
R3_RC=$?
if [ "$R3_RC" -ne 0 ] && printf '%s\n' "$R3_OUT" | grep -qE '^src/internal/scripts/fx-r3-leak\.sh:[0-9]+: R3$'; then
    pass "reporta 'src/internal/scripts/fx-r3-leak.sh:<linea>: R3' con exit != 0"
else
    fail "no reporto la violacion R3 esperada. exit=$R3_RC salida: $R3_OUT"
fi

echo ""
echo "[R4] .claude/scripts/*.sh que no es shim ni esta en not_migrated -> violacion R4"
DIR_R4="$(new_tree r4-neg)"
write_allowlist "$DIR_R4" "$EMPTY_ALLOWLIST"
write_clean_generator "$DIR_R4"
mkdir -p "$DIR_R4/.claude/scripts"
printf '#!/usr/bin/env bash\necho "no soy un shim conforme"\n' > "$DIR_R4/.claude/scripts/fx-bad-shim.sh"
write_generic_shim "$DIR_R4/.claude/scripts/fx-trailing-shim.sh"
printf '\n' >> "$DIR_R4/.claude/scripts/fx-trailing-shim.sh"
git_add_all "$DIR_R4"
R4_OUT="$(run_gate "$DIR_R4")"
R4_RC=$?
if [ "$R4_RC" -ne 0 ] && printf '%s\n' "$R4_OUT" | grep -qF '.claude/scripts/fx-bad-shim.sh:1: R4'; then
    pass "reporta '.claude/scripts/fx-bad-shim.sh:1: R4' con exit != 0"
else
    fail "no reporto la violacion R4 esperada. exit=$R4_RC salida: $R4_OUT"
fi
if printf '%s\n' "$R4_OUT" | grep -qF '.claude/scripts/fx-trailing-shim.sh:1: R4'; then
    pass "un shim con un salto de linea de mas no es byte-exacto -> R4"
else
    fail "no reporto el shim con salto de linea de mas como R4. salida: $R4_OUT"
fi

echo ""
echo "[adapters-check] generate-internal-adapters.sh --check con divergencia -> violacion adapters-check"
DIR_AC="$(new_tree adapters-check-neg)"
write_allowlist "$DIR_AC" "$EMPTY_ALLOWLIST"
write_dirty_generator "$DIR_AC"
git_add_all "$DIR_AC"
AC_OUT="$(run_gate "$DIR_AC")"
AC_RC=$?
if [ "$AC_RC" -ne 0 ] && printf '%s\n' "$AC_OUT" | grep -qF '.claude/agents/fx-agent.md: distinta: adapters-check'; then
    pass "reporta '.claude/agents/fx-agent.md: distinta: adapters-check' con exit != 0"
else
    fail "no reporto la violacion adapters-check esperada. exit=$AC_RC salida: $AC_OUT"
fi

echo ""
echo "[published-adapters-check] generate-published-adapters.sh --check con divergencia -> violacion published-adapters-check"
DIR_PAC="$(new_tree published-adapters-check-neg)"
write_allowlist "$DIR_PAC" "$EMPTY_ALLOWLIST"
write_clean_generator "$DIR_PAC"
write_dirty_published_generator "$DIR_PAC"
git_add_all "$DIR_PAC"
PAC_OUT="$(run_gate "$DIR_PAC")"
PAC_RC=$?
if [ "$PAC_RC" -ne 0 ] && printf '%s\n' "$PAC_OUT" | grep -qF 'dist/claude/agents/fx-agent.md: distinta: published-adapters-check'; then
    pass "reporta 'dist/claude/agents/fx-agent.md: distinta: published-adapters-check' con exit != 0"
else
    fail "no reporto la violacion published-adapters-check esperada. exit=$PAC_RC salida: $PAC_OUT"
fi

echo ""
echo "[published-adapters-check-no-lines] exit != 0 sin lineas de divergencia -> violacion generica de exit"
DIR_PAC_NL="$(new_tree published-adapters-check-no-lines)"
write_allowlist "$DIR_PAC_NL" "$EMPTY_ALLOWLIST"
write_clean_generator "$DIR_PAC_NL"
write_dirty_published_generator_no_lines "$DIR_PAC_NL"
git_add_all "$DIR_PAC_NL"
PAC_NL_OUT="$(run_gate "$DIR_PAC_NL")"
PAC_NL_RC=$?
if [ "$PAC_NL_RC" -ne 0 ] && printf '%s\n' "$PAC_NL_OUT" | grep -qF 'src/published/scripts/generate-published-adapters.sh: exit 1 sin lineas de divergencia: published-adapters-check'; then
    pass "reporta la violacion generica de exit sin lineas de divergencia"
else
    fail "no reporto la violacion generica esperada. exit=$PAC_NL_RC salida: $PAC_NL_OUT"
fi

echo ""
echo "[allowlist] entrada sin 'motivo' -> el gate aborta antes de escanear"
DIR_BAD_ALLOW="$(new_tree bad-allowlist)"
write_allowlist "$DIR_BAD_ALLOW" '{
  "scope_excluded": [],
  "exceptions": [
    { "path": "src/internal/scripts/lib/whatever.sh", "rules": ["R1"] }
  ],
  "not_migrated": []
}'
write_clean_generator "$DIR_BAD_ALLOW"
git_add_all "$DIR_BAD_ALLOW"
BAD_ALLOW_OUT="$(run_gate "$DIR_BAD_ALLOW")"
BAD_ALLOW_RC=$?
if [ "$BAD_ALLOW_RC" -ne 0 ] && printf '%s\n' "$BAD_ALLOW_OUT" | grep -qi "motivo"; then
    pass "aborta (exit $BAD_ALLOW_RC) citando 'motivo'"
else
    fail "no aborto citando 'motivo'. exit=$BAD_ALLOW_RC salida: $BAD_ALLOW_OUT"
fi

echo ""
echo "[allowlist-origin] la allowlist se carga desde el gate, nunca desde --root (MEF-ADR-0019 seccion E)"
DIR_ORIGIN="$(new_tree allowlist-origin)"
# El arbol trae una allowlist que exoneraria su propia fuga -- exactamente lo
# que un writer podria intentar desde su worktree...
write_allowlist "$DIR_ORIGIN" '{
  "scope_excluded": [],
  "exceptions": [
    { "path": "src/internal/scripts/lib/fx-self-exempt.sh", "rules": ["ALL"], "motivo": "Fixture: un PR que intenta exonerarse a si mismo desde su propio worktree." }
  ],
  "not_migrated": []
}'
write_clean_generator "$DIR_ORIGIN"
mkdir -p "$DIR_ORIGIN/src/internal/scripts/lib"
printf '#!/usr/bin/env bash\n# usa el modelo sonnet para esta tarea\necho ok\n' > "$DIR_ORIGIN/src/internal/scripts/lib/fx-self-exempt.sh"
git_add_all "$DIR_ORIGIN"
# ...pero el gate, invocado SIN --allowlist, usa la que acompana al script (la
# real del repo), que no conoce esa excepcion: la fuga se reporta igual.
ORIGIN_OUT="$("$GATE" --root "$DIR_ORIGIN" 2>&1)"
ORIGIN_RC=$?
if [ "$ORIGIN_RC" -ne 0 ] && printf '%s\n' "$ORIGIN_OUT" | grep -qE '^src/internal/scripts/lib/fx-self-exempt\.sh:[0-9]+: R1$'; then
    pass "ignora la allowlist del --root y reporta la fuga con la allowlist propia del gate"
else
    fail "el gate consulto la allowlist del --root (o no reporto la fuga). exit=$ORIGIN_RC salida: $ORIGIN_OUT"
fi

echo ""
echo "[wiring] el gate se invoca tras ambos stages del pipeline canonico y en la fase prepare del release (issue #914)"
PIPELINE_SRC="$REPO_ROOT/src/internal/scripts/mefisto-tooling-pipeline.sh"
RELEASE_SRC="$REPO_ROOT/src/internal/scripts/mefisto-release.sh"

# _nth_line <archivo> <patron-fijo> [<n>] -- numero de linea de la n-esima
# aparicion (default: la primera) del patron literal; vacio si no aparece.
_nth_line() {
    grep -nF -- "$2" "$1" | sed -n "${3:-1}p" | cut -d: -f1
}

if grep -qF 'mefisto-neutrality-gate.sh" --root "$WORKTREE_PATH"' "$PIPELINE_SRC"; then
    pass "mefisto-tooling-pipeline.sh invoca mefisto-neutrality-gate.sh --root \$WORKTREE_PATH (script del checkout principal, arbol del worktree)"
else
    fail "mefisto-tooling-pipeline.sh no invoca mefisto-neutrality-gate.sh sobre el worktree"
fi

# CA-1: por stage, validate_mefisto_scope_changes < run_neutrality_gate <
# auto_commit_if_needed. Se comparan numeros de linea de las LLAMADAS (la
# n-esima aparicion del gate de scope es la del stage n; el gate de
# neutralidad y el auto-commit llevan el rol como argumento literal).
for stage in 1 2; do
    role=writer; [ "$stage" = 2 ] && role=reviewer
    scope_ln=$(_nth_line "$PIPELINE_SRC" 'validate_mefisto_scope_changes "$WORKTREE_PATH"' "$stage")
    gate_ln=$(_nth_line "$PIPELINE_SRC" "run_neutrality_gate $stage $role")
    commit_ln=$(_nth_line "$PIPELINE_SRC" "auto_commit_if_needed \"$role\"")
    if [ -n "$scope_ln" ] && [ -n "$gate_ln" ] && [ -n "$commit_ln" ] \
       && [ "$scope_ln" -lt "$gate_ln" ] && [ "$gate_ln" -lt "$commit_ln" ]; then
        pass "Stage $stage: run_neutrality_gate $stage $role (linea $gate_ln) va tras el gate de scope ($scope_ln) y antes del auto-commit ($commit_ln)"
    else
        fail "Stage $stage: orden inesperado -- scope=${scope_ln:-?} gate=${gate_ln:-?} auto_commit=${commit_ln:-?}"
    fi
done

# CA-2: una sola invocacion en mefisto-release.sh, dentro de prepare, tras
# `git switch -c release/<tag>` y antes de consolidar changelog.d/; publish
# (todo lo que sigue a "# FASE PUBLISH") no la repite.
RELEASE_CALLS=$(grep -cF 'src/internal/scripts/mefisto-neutrality-gate.sh"' "$RELEASE_SRC" || true)
prepare_ln=$(_nth_line "$RELEASE_SRC" 'if [ "$PHASE" = "prepare" ]; then')
switch_ln=$(_nth_line "$RELEASE_SRC" 'git switch -c "$RELEASE_BRANCH" origin/main')
rgate_ln=$(_nth_line "$RELEASE_SRC" 'src/internal/scripts/mefisto-neutrality-gate.sh"')
consolidate_ln=$(_nth_line "$RELEASE_SRC" 'consolidate_changelog_fragments "$MEFISTO_REPO_ROOT"')
publish_ln=$(_nth_line "$RELEASE_SRC" '# FASE PUBLISH')
if [ "${RELEASE_CALLS:-0}" = "1" ] && [ -n "$prepare_ln" ] && [ -n "$switch_ln" ] && [ -n "$rgate_ln" ] \
   && [ -n "$consolidate_ln" ] && [ -n "$publish_ln" ] \
   && [ "$prepare_ln" -lt "$switch_ln" ] && [ "$switch_ln" -lt "$rgate_ln" ] \
   && [ "$rgate_ln" -lt "$consolidate_ln" ] && [ "$consolidate_ln" -lt "$publish_ln" ]; then
    pass "mefisto-release.sh invoca el gate una sola vez (linea $rgate_ln), en prepare, tras crear la rama ($switch_ln) y antes de consolidar changelog.d/ ($consolidate_ln); publish no lo repite"
else
    fail "mefisto-release.sh: cableado inesperado -- llamadas=$RELEASE_CALLS prepare=${prepare_ln:-?} switch=${switch_ln:-?} gate=${rgate_ln:-?} consolidate=${consolidate_ln:-?} publish=${publish_ln:-?}"
fi

echo ""
PERF_LIMIT="${MEFISTO_NEUTRALITY_PERF_LIMIT:-60}"
echo "[perf] corrida completa contra el repo real en menos de ${PERF_LIMIT}s (detecta regresiones grandes; medido 2026-10-02: 38s local, 42s runner)"
PERF_START=$(date +%s)
"$GATE" >/dev/null 2>&1
PERF_RC=$?
PERF_END=$(date +%s)
PERF_ELAPSED=$((PERF_END - PERF_START))
if [ "$PERF_ELAPSED" -lt "$PERF_LIMIT" ]; then
    pass "corrida completa en ${PERF_ELAPSED}s (< ${PERF_LIMIT}s), exit $PERF_RC (0 o 1 indistinto para este check)"
else
    fail "corrida completa tardo ${PERF_ELAPSED}s (>= ${PERF_LIMIT}s, limite configurable con MEFISTO_NEUTRALITY_PERF_LIMIT)"
fi

echo ""
echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
[ "$FAIL" -eq 0 ]
