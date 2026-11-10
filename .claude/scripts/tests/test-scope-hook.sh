#!/usr/bin/env bash
# test-scope-hook.sh -- Tests del hook PostToolUse de scope (issue #523).
#
# Cubre .claude/scripts/mefisto-scope-hook.sh, el aviso temprano que sustituye
# la auto-inspeccion de scope del writer/reviewer del pipeline interno. El hook
# es feedback, no juez: el gate final del stage sigue siendo
# validate_mefisto_scope_changes (cubierto aparte por la paridad del bloque [D]).
#
#   [A] Ruta EN scope -> exit 0 y silencio absoluto (ni stdout ni stderr).
#   [B] Ruta FUERA de scope -> exit 2 y stderr accionable (nombra la allowlist,
#       pide revertir lo ya escrito y cita MEF-ADR-0019 seccion E).
#   [C] Ruta IGNORADA por git -> exit 0. Paridad con el gate final, que juzga
#       sobre `git status --porcelain` y nunca ve archivos ignorados. Incluye el
#       caso critico: el resumen de stage que el pipeline EXIGE a cada agente
#       (.claude/pipeline/summaries/stage-N-*.md) esta fuera de la allowlist y
#       es ignorado -- avisar ahi seria un falso positivo en CADA corrida.
#   [D] Degradacion segura (CA-3): stdin vacio, JSON invalido, sin file_path y
#       ruta absoluta fuera del worktree -> exit 0, nunca bloquea por error propio.
#   [E] Cableado: .claude/settings.json registra el hook con matcher Edit|Write
#       apuntando al script; el pipeline reconcilia sus listas operativas con la
#       allowlist y ya no inyecta ni revierte settings.json.
#
# El hook NO escribe archivos: recibe el JSON del tool call por stdin y solo
# decide. Por eso los casos se ejercitan alimentandolo con el mismo payload que
# Claude Code le pasa (docs de hooks: https://docs.claude.com/en/docs/claude-code/hooks),
# sin necesidad de un repo temporal.
#
# Uso: .claude/scripts/tests/test-scope-hook.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
HOOK="$REPO_ROOT/.claude/scripts/mefisto-scope-hook.sh"
SETTINGS="$REPO_ROOT/.claude/settings.json"
PIPELINE="$REPO_ROOT/src/internal/scripts/mefisto-tooling-pipeline.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# run_hook <file_path> -> exporta HOOK_EXIT, HOOK_STDERR, HOOK_STDOUT
# Alimenta el hook con el payload PostToolUse real de un Write, desde la raiz
# del repo (el hook resuelve la raiz con `git rev-parse --show-toplevel`).
run_hook() {
    local payload
    payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s","content":"x"}}' "$1")
    run_hook_raw "$payload"
}

# run_hook_raw <payload-crudo>
run_hook_raw() {
    local err_file out_file
    err_file=$(mktemp)
    out_file=$(mktemp)
    ( cd "$REPO_ROOT" && printf '%s' "$1" | "$HOOK" ) >"$out_file" 2>"$err_file"
    HOOK_EXIT=$?
    HOOK_STDERR=$(cat "$err_file")
    HOOK_STDOUT=$(cat "$out_file")
    rm -f "$err_file" "$out_file"
}

echo "[pre] El hook existe y es ejecutable"
if [ -x "$HOOK" ]; then
    pass "mefisto-scope-hook.sh presente y con bit de ejecucion"
else
    fail "mefisto-scope-hook.sh ausente o no ejecutable (el hook no correria)"
    echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
    exit 1
fi

# -------- Bloque A: rutas en scope pasan en silencio --------

echo ""
echo "[A] Ruta EN scope -> exit 0 silencioso"
for p in \
    "docs/bitacora/prueba.md" \
    ".claude/scripts/mefisto-tooling-pipeline.sh" \
    ".claude/settings.json" \
    ".claude/mods/mefisto-divine-wager/hooks/register.tsx" \
    ".mcp.json" \
    "changelog.d/523.added.md" \
    "commands/implement.md" \
    "skills/projections/SKILL.md" \
    "CLAUDE.md" \
    "src/internal/foo.ts" \
    "src/published/foo.md" \
    "src/runtime/foo.sh" \
    "dist/x" \
    "AGENTS.md"
do
    run_hook "$p"
    if [ "$HOOK_EXIT" -eq 0 ] && [ -z "$HOOK_STDERR" ] && [ -z "$HOOK_STDOUT" ]; then
        pass "$p -> exit 0 sin ruido"
    else
        fail "$p -> exit $HOOK_EXIT, stderr='$HOOK_STDERR', stdout='$HOOK_STDOUT' (esperaba exit 0 y silencio)"
    fi
done

# Ruta absoluta dentro del worktree: mismo veredicto que la relativa.
run_hook "$REPO_ROOT/docs/bitacora/prueba.md"
if [ "$HOOK_EXIT" -eq 0 ] && [ -z "$HOOK_STDERR" ]; then
    pass "ruta absoluta dentro del worktree -> exit 0 sin ruido"
else
    fail "ruta absoluta dentro del worktree -> exit $HOOK_EXIT (esperaba 0)"
fi

# -------- Bloque B: rutas fuera de scope avisan --------

echo ""
echo "[B] Ruta FUERA de scope -> exit 2 con stderr accionable"
# .mefisto/** queda deliberadamente FUERA de este bloque: el issue #856 lo anade
# a .gitignore, y desde ese momento el hook calla por paridad con el gate final
# (ver bloque [C]), no por la allowlist. Afirmar aqui exit 2 seria un test que se
# rompe solo al mergear #856; su clasificacion la cubre test-guards.sh [E2], que
# ejercita is_path_in_mefisto_scope directamente y es inmune a .gitignore.
for p in "src/Foo.cs" "src/otro/x.sh" "src/publication/foo.md" "src/runtime-local/foo.sh" "distribution/x" "dist-local/x" "tests/Foo.Tests/FooTests.cs" ".github/CODEOWNERS" ".claude/harness.config.json" "infra/main.tf"; do
    run_hook "$p"
    if [ "$HOOK_EXIT" -eq 2 ]; then
        pass "$p -> exit 2"
    else
        fail "$p -> exit $HOOK_EXIT (esperaba 2; con otro codigo Claude no ve el stderr como feedback del tool call)"
    fi
done

run_hook "src/Foo.cs"
if echo "$HOOK_STDERR" | grep -q "src/Foo.cs"; then
    pass "el mensaje nombra la ruta ofensora"
else
    fail "el mensaje no nombra la ruta ofensora"
fi
if echo "$HOOK_STDERR" | grep -q "is_path_in_mefisto_scope"; then
    pass "el mensaje nombra la allowlist autoritativa (is_path_in_mefisto_scope)"
else
    fail "el mensaje no nombra is_path_in_mefisto_scope"
fi
if echo "$HOOK_STDERR" | grep -q "MEF-ADR-0019 seccion E"; then
    pass "el mensaje recuerda MEF-ADR-0019 seccion E (registrar la ruta primero)"
else
    fail "el mensaje no cita MEF-ADR-0019 seccion E"
fi
if echo "$HOOK_STDERR" | grep -qi "revierte"; then
    pass "el mensaje pide revertir lo ya escrito (semantica PostToolUse: el tool ya corrio)"
else
    fail "el mensaje no pide revertir; en PostToolUse el archivo YA existe y decir 'no lo crees' es inaccionable"
fi
if echo "$HOOK_STDERR" | grep -q 'src/{internal,published,runtime}/, dist/'; then
    pass "el catalogo del feedback temprano enumera las tres raices nuevas"
else
    fail "el catalogo del feedback temprano no refleja src/published/, src/runtime/ y dist/"
fi

# -------- Bloque C: rutas ignoradas por git no avisan --------

echo ""
echo "[C] Ruta IGNORADA por git -> exit 0 (paridad con el gate final)"
for p in \
    ".claude/pipeline/summaries/stage-1-writer.md" \
    ".claude/pipeline/summaries/stage-2-reviewer.md" \
    ".claude/pipeline/status.json" \
    ".claude/settings.local.json" \
    ".mefisto/pipeline/summaries/stage-1-writer.md"
do
    # Precondicion: la ruta debe estar fuera de la allowlist Y ignorada por git.
    # Si alguna dejara de estarlo, el caso pierde sentido y hay que revisarlo.
    if git -C "$REPO_ROOT" check-ignore -q -- "$p" 2>/dev/null; then
        run_hook "$p"
        if [ "$HOOK_EXIT" -eq 0 ] && [ -z "$HOOK_STDERR" ]; then
            pass "$p (ignorado por git) -> exit 0 sin ruido"
        else
            fail "$p -> exit $HOOK_EXIT: falso positivo; el gate final usa git status y nunca ve esta ruta"
        fi
    else
        fail "$p ya no esta ignorado por git; revisa .gitignore y este caso"
    fi
done

# -------- Bloque D: degradacion segura --------

echo ""
echo "[D] Degradacion segura -> exit 0, nunca bloquea por error propio (CA-3)"
run_hook_raw ""
if [ "$HOOK_EXIT" -eq 0 ]; then pass "stdin vacio -> exit 0"; else fail "stdin vacio -> exit $HOOK_EXIT"; fi

run_hook_raw "no soy json {{{"
if [ "$HOOK_EXIT" -eq 0 ]; then pass "stdin no-JSON -> exit 0"; else fail "stdin no-JSON -> exit $HOOK_EXIT"; fi

run_hook_raw '{"tool_name":"Write","tool_input":{}}'
if [ "$HOOK_EXIT" -eq 0 ]; then pass "tool_input sin file_path -> exit 0"; else fail "tool_input sin file_path -> exit $HOOK_EXIT"; fi

run_hook_raw '{"tool_name":"Write","tool_input":{"file_path":""}}'
if [ "$HOOK_EXIT" -eq 0 ]; then pass "file_path vacio -> exit 0"; else fail "file_path vacio -> exit $HOOK_EXIT"; fi

run_hook "/tmp/mefisto-scope-hook-fuera-del-worktree.txt"
if [ "$HOOK_EXIT" -eq 0 ] && [ -z "$HOOK_STDERR" ]; then
    pass "ruta absoluta fuera del worktree -> exit 0 sin ruido"
else
    fail "ruta absoluta fuera del worktree -> exit $HOOK_EXIT (el scope de Mefisto no aplica fuera del repo)"
fi

# -------- Bloque E: cableado del hook y reconciliacion del pipeline --------

echo ""
echo "[E] Cableado en settings.json y reconciliacion del pipeline"
if [ -f "$SETTINGS" ]; then
    pass ".claude/settings.json existe y esta versionado"
else
    fail ".claude/settings.json no existe (el hook no se cargaria)"
fi

if command -v jq >/dev/null 2>&1 && [ -f "$SETTINGS" ]; then
    if jq -e '.hooks.PostToolUse' "$SETTINGS" >/dev/null 2>&1; then
        pass "settings.json declara hooks.PostToolUse"
    else
        fail "settings.json no declara hooks.PostToolUse"
    fi

    MATCHER=$(jq -r '.hooks.PostToolUse[]?.matcher // empty' "$SETTINGS" 2>/dev/null)
    if [ "$MATCHER" = "Edit|Write" ]; then
        pass "matcher es 'Edit|Write'"
    else
        fail "matcher es '$MATCHER' (esperaba 'Edit|Write')"
    fi

    CMD=$(jq -r '.hooks.PostToolUse[]?.hooks[]?.command // empty' "$SETTINGS" 2>/dev/null)
    case "$CMD" in
        *mefisto-scope-hook.sh) pass "el comando apunta a mefisto-scope-hook.sh" ;;
        *) fail "el comando es '$CMD' (esperaba terminar en mefisto-scope-hook.sh)" ;;
    esac
    case "$CMD" in
        \$\{CLAUDE_PROJECT_DIR\}/*|\$CLAUDE_PROJECT_DIR/*)
            pass "la ruta del comando se ancla en CLAUDE_PROJECT_DIR (resuelve al worktree de cada corrida)" ;;
        /*) fail "la ruta del comando es absoluta ('$CMD'): no resolveria al worktree de una corrida del pipeline" ;;
        *)  fail "la ruta del comando ('$CMD') no se ancla en CLAUDE_PROJECT_DIR" ;;
    esac
fi

# El pipeline NO debe revertir settings.json: ahora esta versionado y un
# `git checkout --` borraria en silencio la edicion legitima de un writer que
# anada un hook nuevo (y el bloque ECONOMIA DE TURNOS le pide no re-inspeccionar
# el arbol, asi que no se enteraria).
# Se juzga sobre CODIGO, no sobre comentarios: el propio pipeline documenta en
# prosa por que no hace ninguna de las dos cosas, y un grep crudo leeria esa
# explicacion como la infraccion que describe.
PIPELINE_CODE=$(grep -v '^[[:space:]]*#' "$PIPELINE")

if printf '%s' "$PIPELINE_CODE" | grep -q "checkout -- .claude/settings.json"; then
    fail "el pipeline interno aun hace 'git checkout -- .claude/settings.json': destruiria una edicion no comiteada del archivo versionado"
else
    pass "el pipeline interno ya no revierte .claude/settings.json"
fi

if printf '%s' "$PIPELINE_CODE" | grep -q 'sed .*settings\.json'; then
    fail "el pipeline interno aun inyecta settings.json desde \$REPO_ROOT: pisaria el archivo versionado del worktree"
else
    pass "el pipeline interno ya no inyecta .claude/settings.json desde el clon principal"
fi

if printf '%s\n' "$PIPELINE_CODE" | grep 'local paths=' | grep -q 'src/published/ src/runtime/ dist/'; then
    pass "src/published/, src/runtime/ y dist/ estan en la lista operativa de auto-commit"
else
    fail "la lista operativa de auto-commit omite src/published/, src/runtime/ o dist/"
fi

if printf '%s\n' "$PIPELINE_CODE" | grep 'status --porcelain -- commands/' | grep -q 'src/published/ src/runtime/ dist/'; then
    pass "src/published/, src/runtime/ y dist/ estan en la deteccion de cambios del writer"
else
    fail "la deteccion de cambios del writer omite src/published/, src/runtime/ o dist/"
fi

echo ""
echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
[ "$FAIL" -eq 0 ]
