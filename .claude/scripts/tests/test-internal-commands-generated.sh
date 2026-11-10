#!/usr/bin/env bash
# test-internal-commands-generated.sh -- Tests de la migracion de los diez
# comandos internos a la fuente neutral: los cinco de analisis y seguimiento
# (plan, bug, bitacora, work-status, fix-review, issue #866) y los cinco de
# ejecucion (tooling, tooling-verbose, sequential, merge, release, issue
# #867) (MEF-ADR-0049).
#
# Cubre:
#   [sources] Las diez src/internal/commands/mefisto-{plan,bug,bitacora,
#         work-status,fix-review,tooling,tooling-verbose,sequential,merge,
#         release}.md existen y pasan validate-internal-artifacts.sh (#853).
#   [ca-3] Ninguna fuente contiene `claude --agent`, `.claude/pipeline`,
#         `.claude/agents` ni `.claude/commands` (CA-3); la salida generada
#         de plan/bug/bitacora invoca `claude --agent <agente> "$ARGUMENTS"`
#         y ninguna salida cita `.claude/pipeline` ni `.claude/agents`.
#   [check] generate-internal-adapters.sh --check esta en verde: los
#         adaptadores versionados en .claude/commands/ coinciden byte-a-byte
#         con lo que la fuente neutral produce (CA-1).
#   [claude-output] La salida Claude de los cuatro comandos `fast` lleva
#         `model: "haiku"`; la de `fix-review` (`deep`) lleva `model: "opus"`
#         (CA-2, tabla enmendada por issue #1309).
#   [guard] El bloque del guard inverso (`.claude-plugin/plugin.json`) esta
#         presente en la salida de cada comando (CA-2).
#   [ca-5] Ninguna fuente cita `CLAUDE.md` como referencia de gobierno: si
#         aparece, la linea debe describirlo como shim de compatibilidad.
#   [command-path] mefisto-tooling-verbose delega en mefisto-tooling via
#         `{{mefisto:command-path}}`: la salida apunta al directorio de
#         comandos del adaptador (CA-4). mefisto-bitacora ya no lee
#         mefisto-merge (issue #2260).
#   [exec-sources] Los cinco comandos de ejecucion (issue #867) existen y
#         pasan validate-internal-artifacts.sh.
#   [exec-ca-3] La salida de tooling/tooling-verbose/sequential/release
#         invoca el script real con `MEFISTO_RUNTIME=<runtime>
#         ./.claude/scripts/<script>` (CA-3, issue #867).
#   [exec-command-path] mefisto-tooling-verbose encadena mefisto-tooling via
#         `{{mefisto:command-path}}` (issue #867).
#   [exec-claude-output] La salida Claude de los cuatro comandos de
#         ejecucion `fast` lleva `model: "haiku"`; la de `release`
#         (`balanced`) lleva `model: "sonnet"` (CA-5, issue #867).
#   [ca-4] mefisto-tooling no prescribe un alias Anthropic concreto en sus
#         ejemplos de `--models` y remite a models.example.json (CA-4, issue
#         #867).
#   [run-quoting] {{mefisto:run}} preserva sin alterar un argumento con
#         espacios y comillas (`--models 'writer=a b'`) (CA-6, issue #867).
#   [merge-reconcile] mefisto-merge reconcilia cada merge exitoso mediante la
#         directiva neutral y conserva MERGED si el paso post-merge falla
#         (issue #1160).
#
# Uso: .claude/scripts/tests/test-internal-commands-generated.sh
# Exit code: 0 si todos los checks pasan, 1 si alguno falla.

set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
COMMANDS_DIR="$REPO_ROOT/src/internal/commands"
VALIDATOR="$REPO_ROOT/src/internal/scripts/validate-internal-artifacts.sh"
GENERATOR="$REPO_ROOT/src/internal/scripts/generate-internal-adapters.sh"

COMMAND_IDS="mefisto-plan mefisto-bug mefisto-bitacora mefisto-fix-review"
EXEC_COMMAND_IDS="mefisto-tooling mefisto-tooling-verbose mefisto-sequential mefisto-merge mefisto-release"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "[sources] Las cinco fuentes existen y pasan validate-internal-artifacts.sh"
for id in $COMMAND_IDS; do
    src="$COMMANDS_DIR/$id.md"
    if [ ! -f "$src" ]; then
        fail "$id: no existe src/internal/commands/$id.md"
        continue
    fi
    pass "existe: src/internal/commands/$id.md"

    out=$("$VALIDATOR" "$src" 2>&1)
    rc=$?
    if [ "$rc" -eq 0 ]; then
        pass "$id: pasa el validador del contrato neutral"
    else
        fail "$id: el validador rechazo la fuente. Salida: $out"
    fi
done

echo ""
echo "[exec-sources] Los cinco comandos de ejecucion existen y pasan validate-internal-artifacts.sh (issue #867)"
for id in $EXEC_COMMAND_IDS; do
    src="$COMMANDS_DIR/$id.md"
    if [ ! -f "$src" ]; then
        fail "$id: no existe src/internal/commands/$id.md"
        continue
    fi
    pass "existe: src/internal/commands/$id.md"

    out=$("$VALIDATOR" "$src" 2>&1)
    rc=$?
    if [ "$rc" -eq 0 ]; then
        pass "$id: pasa el validador del contrato neutral"
    else
        fail "$id: el validador rechazo la fuente. Salida: $out"
    fi
done

echo ""
echo "[check] generate-internal-adapters.sh --check esta en verde"
if [ -x "$GENERATOR" ]; then
    out=$("$GENERATOR" --check 2>&1)
    rc=$?
    if [ "$rc" -eq 0 ]; then
        pass "generate-internal-adapters.sh --check -> exit 0 (sin divergencias)"
    else
        fail "generate-internal-adapters.sh --check -> exit $rc. Salida: $out"
    fi
else
    fail "$GENERATOR no existe o no es ejecutable"
fi

echo ""
echo "[ca-3] Ninguna fuente ni salida contiene las referencias prohibidas; plan/bug/bitacora invocan su agente"
FORBIDDEN_PATTERNS=("claude --agent" "\.claude/pipeline" "\.claude/agents" "\.claude/commands")
ALL_SOURCES=()
for id in $COMMAND_IDS $EXEC_COMMAND_IDS; do
    ALL_SOURCES+=("$COMMANDS_DIR/$id.md")
done
for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    hit=$(grep -inE "$pattern" "${ALL_SOURCES[@]}" 2>/dev/null)
    if [ -z "$hit" ]; then
        pass "ninguna fuente contiene '$pattern'"
    else
        fail "una fuente contiene '$pattern': $hit"
    fi
done

declare_pairs="mefisto-plan:mefisto-planner mefisto-bug:mefisto-investigator mefisto-bitacora:mefisto-historiador"
for pair in $declare_pairs; do
    cmd_id="${pair%%:*}"
    agent_id="${pair##*:}"
    claude_out="$REPO_ROOT/.claude/commands/$cmd_id.md"

    if [ -f "$claude_out" ] && grep -qF "claude --agent $agent_id \"\$ARGUMENTS\"" "$claude_out"; then
        pass "$cmd_id: salida Claude invoca 'claude --agent $agent_id \"\$ARGUMENTS\"'"
    else
        fail "$cmd_id: salida Claude NO invoca 'claude --agent $agent_id \"\$ARGUMENTS\"' ($claude_out)"
    fi
done

# La salida SI nombra su runtime y su directorio de comandos (los introduce el
# generador); lo que CA-3 prohibe es que siga citando `.claude/pipeline` o
# `.claude/agents`, reemplazadas por `.mefisto/pipeline` y `src/internal/agents`.
stale_ok=1
for id in $COMMAND_IDS $EXEC_COMMAND_IDS; do
    out_file="$REPO_ROOT/.claude/commands/$id.md"
    [ -f "$out_file" ] || { fail "no existe la salida generada $out_file"; stale_ok=0; continue; }
    for stale in ".claude/pipeline" ".claude/agents"; do
        if grep -qF "$stale" "$out_file" 2>/dev/null; then
            fail "$out_file: sigue citando '$stale' (CA-3)"
            stale_ok=0
        fi
    done
done
[ "$stale_ok" -eq 1 ] && pass "ninguna salida generada cita una ruta reemplazada por CA-3"

echo ""
echo "[guard] CA-2: el bloque del guard inverso esta presente en la salida de cada comando"
for id in $COMMAND_IDS $EXEC_COMMAND_IDS; do
    claude_guard=$(sed -n '/^\[ -f "\$REPO_ROOT\/\.claude-plugin\/plugin\.json" \]/,/^}$/p' "$REPO_ROOT/.claude/commands/$id.md" 2>/dev/null)
    if [ -n "$claude_guard" ]; then
        pass "$id: guard inverso presente en .claude/commands"
    else
        fail "$id: guard inverso ausente en .claude/commands"
    fi
done

echo ""
echo "[ca-5] Las referencias de gobierno usan AGENTS.md; CLAUDE.md solo como shim de compatibilidad"
ca5_ok=1
for src in "${ALL_SOURCES[@]}"; do
    while IFS= read -r hit; do
        [ -n "$hit" ] || continue
        case "$hit" in
            *shim*) ;;
            *) fail "$(basename "$src"): cita CLAUDE.md fuera de un 'shim de compatibilidad': $hit"; ca5_ok=0 ;;
        esac
    done < <(grep -nF 'CLAUDE.md' "$src" 2>/dev/null)
done
[ "$ca5_ok" -eq 1 ] && pass "ninguna fuente cita CLAUDE.md como fuente de gobierno"

echo ""
echo "[claude-output] model: \"haiku\" en los cuatro fast; fix-review con model: \"opus\" (perfil deep)"
for id in mefisto-plan mefisto-bug mefisto-bitacora; do
    out_file="$REPO_ROOT/.claude/commands/$id.md"
    if grep -q '^model: "haiku"$' "$out_file" 2>/dev/null; then
        pass "$id: .claude/commands lleva model: \"haiku\""
    else
        fail "$id: .claude/commands NO lleva model: \"haiku\" ($out_file)"
    fi
done
if grep -q '^model: "opus"$' "$REPO_ROOT/.claude/commands/mefisto-fix-review.md" 2>/dev/null; then
    pass "mefisto-fix-review: .claude/commands lleva model: \"opus\" (perfil deep)"
else
    fail "mefisto-fix-review: .claude/commands NO lleva model: \"opus\" (perfil deep)"
fi

echo ""
echo "[command-path] mefisto-tooling-verbose apunta a mefisto-tooling en el directorio de comandos del adaptador (CA-4)"
claude_verbose="$REPO_ROOT/.claude/commands/mefisto-tooling-verbose.md"
if grep -qF '.claude/commands/mefisto-tooling.md' "$claude_verbose" 2>/dev/null; then
    pass "mefisto-tooling-verbose: salida Claude apunta a .claude/commands/mefisto-tooling.md"
else
    fail "mefisto-tooling-verbose: salida Claude NO apunta a .claude/commands/mefisto-tooling.md"
fi
if grep -qF 'commands/mefisto-merge.md' "$REPO_ROOT/.claude/commands/mefisto-bitacora.md" 2>/dev/null; then
    fail "mefisto-bitacora: .claude/commands/mefisto-bitacora.md todavia lee mefisto-merge (issue #2260)"
else
    pass "mefisto-bitacora: .claude/commands/mefisto-bitacora.md no lee mefisto-merge (issue #2260)"
fi

echo ""
echo "[exec-ca-3] Las invocaciones de script de los comandos de ejecucion pasan por {{mefisto:run}} (issue #867)"
check_run_invocation() {
    local id="$1" invocation="$2"
    local claude_out="$REPO_ROOT/.claude/commands/$id.md"
    if [ -f "$claude_out" ] && grep -qF "MEFISTO_RUNTIME=claude ./.claude/scripts/$invocation" "$claude_out"; then
        pass "$id: salida Claude invoca 'MEFISTO_RUNTIME=claude ./.claude/scripts/$invocation'"
    else
        fail "$id: salida Claude NO invoca 'MEFISTO_RUNTIME=claude ./.claude/scripts/$invocation' ($claude_out)"
    fi
}
check_run_invocation mefisto-tooling 'mefisto-tmux-pipeline.sh --tooling $ARGUMENTS'
check_run_invocation mefisto-tooling-verbose 'mefisto-tmux-pipeline.sh --tooling $ARGUMENTS --verbose'
check_run_invocation mefisto-sequential 'mefisto-validate-batch-deps.sh <issue1> <issue2> ...'
check_run_invocation mefisto-sequential 'mefisto-tmux-pipeline.sh --batch <issue1> <issue2> ...'
check_run_invocation mefisto-release 'mefisto-release.sh $ARGUMENTS'

echo ""
echo "[merge-reconcile] mefisto-merge reconcilia cada cierre exitoso sin contaminar el resultado del merge (issue #1160)"
merge_source="$COMMANDS_DIR/mefisto-merge.md"
reconcile_directive='{{mefisto:run mefisto-validate-batch-deps.sh --reconcile-pr "$pr"}}'
if [ "$(grep -cF "$reconcile_directive" "$merge_source" 2>/dev/null)" -eq 1 ]; then
    pass "mefisto-merge: la fuente contiene una unica directiva neutral --reconcile-pr"
else
    fail "mefisto-merge: la fuente debe contener una unica directiva neutral --reconcile-pr"
fi
check_run_invocation mefisto-merge 'mefisto-validate-batch-deps.sh --reconcile-pr "$pr"'

# Fija la estructura del loop, no solo la presencia aislada de sus tokens: el
# continue del merge fallido debe preceder al reconciliador y no puede existir
# otro continue en la rama post-merge. Asi una lista mixta reconcilia los merges
# exitosos anteriores y posteriores sin reconciliar ni reintentar el fallido.
merge_loop=$(sed -n '/^for pr in <prs>; do$/,/^done$/p' "$merge_source")
merge_line=$(printf '%s\n' "$merge_loop" | grep -nF 'gh pr merge "$pr" --squash || {' | cut -d: -f1)
remote_delete_line=$(printf '%s\n' "$merge_loop" | grep -nF 'git push origin --delete "$head"' | cut -d: -f1)
continue_line=$(printf '%s\n' "$merge_loop" | grep -nF 'continue' | cut -d: -f1)
reconcile_line=$(printf '%s\n' "$merge_loop" | grep -nF "$reconcile_directive" | cut -d: -f1)
merged_line=$(printf '%s\n' "$merge_loop" | grep -nF 'resultado="MERGED"' | cut -d: -f1)
degraded_line=$(printf '%s\n' "$merge_loop" | grep -nF 'resultado="MERGED (POST-MERGE DEGRADADO)"' | cut -d: -f1)
continue_count=$(printf '%s\n' "$merge_loop" | grep -cF 'continue' || true)
if [ -n "$merge_line" ] && [ -n "$continue_line" ] && [ -n "$reconcile_line" ] \
    && [ -n "$merged_line" ] && [ -n "$degraded_line" ] \
    && [ "$continue_count" -eq 1 ] \
    && [ "$merge_line" -lt "$continue_line" ] \
    && [ "$continue_line" -lt "$merged_line" ] \
    && [ -n "$remote_delete_line" ] \
    && [ "$continue_line" -lt "$remote_delete_line" ] \
    && [ "$remote_delete_line" -lt "$reconcile_line" ] \
    && [ "$merged_line" -lt "$reconcile_line" ] \
    && [ "$reconcile_line" -lt "$degraded_line" ]; then
    pass "mefisto-merge: una lista mixta omite el fallido, reconcilia cada exitoso y degrada solo el post-merge"
else
    fail "mefisto-merge: el loop no aisla correctamente merges fallidos, exitosos y reconciliaciones degradadas"
fi

if grep -qF -- '--delete-branch' "$merge_source" 2>/dev/null; then
    fail "mefisto-merge: la fuente aun contiene --delete-branch (issue #2159)"
else
    pass "mefisto-merge: la fuente no usa --delete-branch (issue #2159)"
fi

echo ""
echo "[exec-command-path] mefisto-tooling-verbose encadena mefisto-tooling en el directorio de comandos del adaptador (issue #867)"
claude_tooling_verbose="$REPO_ROOT/.claude/commands/mefisto-tooling-verbose.md"
if grep -qF '.claude/commands/mefisto-tooling.md' "$claude_tooling_verbose" 2>/dev/null; then
    pass "mefisto-tooling-verbose: salida Claude apunta a .claude/commands/mefisto-tooling.md"
else
    fail "mefisto-tooling-verbose: salida Claude NO apunta a .claude/commands/mefisto-tooling.md"
fi

echo ""
echo "[exec-claude-output] model: \"haiku\" en los cuatro fast; release (balanced) con model: \"sonnet\" (issue #867)"
for id in mefisto-tooling mefisto-tooling-verbose mefisto-sequential mefisto-merge; do
    out_file="$REPO_ROOT/.claude/commands/$id.md"
    if grep -q '^model: "haiku"$' "$out_file" 2>/dev/null; then
        pass "$id: .claude/commands lleva model: \"haiku\""
    else
        fail "$id: .claude/commands NO lleva model: \"haiku\" ($out_file)"
    fi
done
if grep -q '^model: "sonnet"$' "$REPO_ROOT/.claude/commands/mefisto-release.md" 2>/dev/null; then
    pass "mefisto-release: .claude/commands lleva model: \"sonnet\""
else
    fail "mefisto-release: .claude/commands NO lleva model: \"sonnet\""
fi
echo ""
echo "[ca-4] mefisto-tooling no prescribe un alias Anthropic concreto en sus ejemplos de --models y remite a models.example.json (issue #867)"
src_tooling="$COMMANDS_DIR/mefisto-tooling.md"
if grep -qiE -- "--models[^\`]*=(opus|sonnet|haiku)" "$src_tooling" 2>/dev/null; then
    fail "mefisto-tooling: la fuente todavia prescribe un alias Anthropic concreto en un ejemplo --models"
else
    pass "mefisto-tooling: ningun ejemplo --models prescribe un alias Anthropic concreto"
fi
if grep -qF 'models.example.json' "$src_tooling" 2>/dev/null; then
    pass "mefisto-tooling: remite al models.example.json comun para la forma del mapping"
else
    fail "mefisto-tooling: NO remite a src/runtime/contract/models.example.json"
fi

echo ""
echo "[run-quoting] {{mefisto:run}} preserva sin alterar un argumento con espacios y comillas (CA-6, issue #867)"
FIXTURE_DIR=$(mktemp -d)
FIXTURE_OUT=$(mktemp -d)
trap 'rm -rf "$FIXTURE_DIR" "$FIXTURE_OUT"' EXIT
FIXTURE_FILE="$FIXTURE_DIR/mefisto-test-run-quoting.md"
cat > "$FIXTURE_FILE" <<'FIXTURE_EOF'
---
{
  "kind": "command",
  "id": "mefisto-test-run-quoting",
  "description": "Fixture de test: verifica que {{mefisto:run}} preserva argumentos con espacios y comillas (issue #867 CA-6). No se invoca en produccion."
}
---

Invocacion de prueba:

{{mefisto:run mefisto-tmux-pipeline.sh --tooling $ARGUMENTS --models 'writer=a b'}}
FIXTURE_EOF

if out=$("$VALIDATOR" "$FIXTURE_FILE" 2>&1); then
    pass "fixture de quoting: pasa el validador del contrato neutral"
else
    fail "fixture de quoting: el validador la rechazo. Salida: $out"
fi

if "$GENERATOR" --out "$FIXTURE_OUT" "$FIXTURE_FILE" >/dev/null 2>&1; then
    claude_fixture_out="$FIXTURE_OUT/.claude/commands/mefisto-test-run-quoting.md"
    expected_claude="MEFISTO_RUNTIME=claude ./.claude/scripts/mefisto-tmux-pipeline.sh --tooling \$ARGUMENTS --models 'writer=a b'"
    if grep -qF "$expected_claude" "$claude_fixture_out" 2>/dev/null; then
        pass "fixture de quoting: salida Claude conserva el argumento con espacios y comillas intacto"
    else
        fail "fixture de quoting: salida Claude altero el argumento con espacios/comillas ($claude_fixture_out)"
    fi
else
    fail "fixture de quoting: generate-internal-adapters.sh fallo al generarla"
fi
rm -rf "$FIXTURE_DIR" "$FIXTURE_OUT"

echo ""
echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
[ "$FAIL" -eq 0 ]
