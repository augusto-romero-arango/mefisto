#!/usr/bin/env bash
# test-internal-agents-generated.sh -- Tests de la migracion de los cinco
# agentes internos (planner, investigator, historiador, writer, reviewer) a
# la fuente neutral (MEF-ADR-0049, issues #865 y #909).
#
# Cubre:
#   [sources] Los cinco src/internal/agents/mefisto-{planner,investigator,
#         historiador,writer,reviewer}.md existen y pasan
#         validate-internal-artifacts.sh (#853).
#   [neutral] Ningun body de las cinco fuentes nombra `claude` (CA-1/CA-5)
#         -- ya lo cubre el validador, este bloque solo hace explicito el
#         motivo para estos cinco agentes en concreto.
#   [check] generate-internal-adapters.sh --check esta en verde: los
#         adaptadores versionados en .claude/agents/ coinciden byte-a-byte
#         con lo que la fuente neutral produce (CA-2).
#   [runtime-output] Los cinco adaptadores generados llevan el marcador y
#         materializan la tabla de modelos de Claude (`balanced`->sonnet,
#         `deep`->opus; CA-2, issue #961; tabla enmendada por issue #1309).
#   [writer-reviewer] La fuente neutral de writer y reviewer los declara
#         seleccionables como agentes primarios (`mode: all`, issue #1034).
#   [guard-f] El bloque [F] de scripts/tests/test-guards.sh (integridad de
#         Agent Skills) sigue en verde tras la migracion.
#
# Uso: .claude/scripts/tests/test-internal-agents-generated.sh
# Exit code: 0 si todos los checks pasan, 1 si alguno falla.

set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
AGENTS_DIR="$REPO_ROOT/src/internal/agents"
VALIDATOR="$REPO_ROOT/src/internal/scripts/validate-internal-artifacts.sh"
GENERATOR="$REPO_ROOT/src/internal/scripts/generate-internal-adapters.sh"
GUARDS="$REPO_ROOT/scripts/tests/test-guards.sh"

AGENT_IDS="mefisto-planner mefisto-investigator mefisto-historiador mefisto-writer mefisto-reviewer"

# Perfil declarado por cada agente (MEF-ADR-0049 CA-4): condiciona el
# `model:` esperado en la salida Claude. Sin arrays asociativos (bash 3.2,
# MEF-ADR-0049 CA-6).
profile_for_agent() {
    case "$1" in
        mefisto-historiador|mefisto-writer) echo "balanced" ;;
        mefisto-planner|mefisto-investigator|mefisto-reviewer) echo "deep" ;;
        *) echo "" ;;
    esac
}

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "[sources] Las cinco fuentes existen y pasan validate-internal-artifacts.sh"
for id in $AGENT_IDS; do
    src="$AGENTS_DIR/$id.md"
    if [ ! -f "$src" ]; then
        fail "$id: no existe src/internal/agents/$id.md"
        continue
    fi
    pass "existe: src/internal/agents/$id.md"

    out=$("$VALIDATOR" "$src" 2>&1)
    rc=$?
    if [ "$rc" -eq 0 ]; then
        pass "$id: pasa el validador del contrato neutral"
    else
        fail "$id: el validador rechazo la fuente. Salida: $out"
    fi
done

echo ""
echo "[writer-reviewer] La fuente neutral de writer y reviewer declara mode: all"
for id in mefisto-writer mefisto-reviewer; do
    src="$AGENTS_DIR/$id.md"
    if grep -q '"mode": "all"' "$src" 2>/dev/null; then
        pass "$id: fuente neutral declara mode: all"
    else
        fail "$id: fuente neutral debe declarar mode: all (no subagent)"
    fi
done

echo ""
echo "[neutral] Ningun body nombra 'claude' (CA-1/CA-5)"
for id in $AGENT_IDS; do
    src="$AGENTS_DIR/$id.md"
    [ -f "$src" ] || continue
    hit=$(awk '
        NR==1 { next }
        $0=="---" && !seen { seen=1; next }
        seen && tolower($0) ~ /claude/ { print NR; exit }
    ' "$src")
    if [ -z "$hit" ]; then
        pass "$id: body sin menciones a claude"
    else
        fail "$id: body menciona un runtime concreto en la linea $hit"
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
echo "[runtime-output] .claude/agents/*.md refleja la tabla de modelos de Claude"
for id in $AGENT_IDS; do
    out_file="$REPO_ROOT/.claude/agents/$id.md"
    if [ ! -f "$out_file" ]; then
        fail "$id: no existe .claude/agents/$id.md"
        continue
    fi
    if grep -q "^<!-- GENERADO por src/internal/scripts/generate-internal-adapters.sh" "$out_file"; then
        pass "$id: .claude/agents/$id.md lleva el marcador de generado"
    else
        fail "$id: .claude/agents/$id.md no lleva el marcador de generado"
    fi
done

for id in $AGENT_IDS; do
    profile=$(profile_for_agent "$id")
    case "$profile" in
        fast) expected="haiku" ;;
        balanced) expected="sonnet" ;;
        deep) expected="opus" ;;
        *) fail "$id: perfil '$profile' sin modelo Claude esperado en este test"; continue ;;
    esac
    if grep -q "^model: \"$expected\"\$" "$REPO_ROOT/.claude/agents/$id.md" 2>/dev/null; then
        pass "$id: .claude/agents lleva model: \"$expected\" (perfil $profile)"
    else
        fail "$id: .claude/agents no lleva model: \"$expected\" (perfil $profile)"
    fi
done

echo ""
echo "[guard-f] El bloque [F] de test-guards.sh sigue en verde"
if [ -x "$GUARDS" ]; then
    out=$("$GUARDS" 2>&1)
    rc=$?
    if printf '%s' "$out" | grep -qF "FAIL" ; then
        fail "test-guards.sh reporta al menos un FAIL tras la migracion. Salida relevante:
$(printf '%s' "$out" | grep -F "FAIL")"
    elif [ "$rc" -ne 0 ]; then
        fail "test-guards.sh -> exit $rc sin FAILs explicitos. Salida: $out"
    else
        pass "test-guards.sh completo -> exit 0, sin FAILs"
    fi
else
    fail "$GUARDS no existe o no es ejecutable"
fi

echo ""
echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
[ "$FAIL" -eq 0 ]
