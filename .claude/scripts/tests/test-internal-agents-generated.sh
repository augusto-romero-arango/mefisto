#!/usr/bin/env bash
# test-internal-agents-generated.sh -- Tests de la migracion de los cinco
# agentes internos (planner, investigator, historiador, writer, reviewer) a
# la fuente neutral (MEF-ADR-0049, issues #865 y #909).
#
# Cubre:
#   [sources] Los cinco src/internal/agents/mefisto-{planner,investigator,
#         historiador,writer,reviewer}.md existen y pasan
#         validate-internal-artifacts.sh (#853).
#   [neutral] Ningun body de las cinco fuentes nombra `claude`/`opencode`
#         (CA-1/CA-5) -- ya lo cubre el validador, este bloque solo hace
#         explicito el motivo para estos cinco agentes en concreto.
#   [check] generate-internal-adapters.sh --check esta en verde: los
#         adaptadores versionados en .claude/agents/ y .opencode/agents/
#         coinciden byte-a-byte con lo que la fuente neutral produce (CA-2).
#   [runtime-output] Los diez adaptadores generados llevan el marcador;
#         Claude materializa su tabla (`balanced`->sonnet, `deep`->opus) y
#         OpenCode omite `model:` para heredar la configuracion del usuario
#         (CA-2, issue #961; tabla enmendada por issue #1309). El veto de
#         alias Anthropic (fable/opus/claude-<id>) aplica SOLO a la salida
#         OpenCode, donde no serian resolubles: en la salida Claude un alias
#         es justamente lo que la tabla debe emitir.
#   [opencode-cli] Si el CLI `opencode` esta instalado, `opencode agent list`
#         corrido en la raiz del repo lista cada id con su modo -- `primary`
#         para planner/investigator/historiador, `all` para writer/reviewer;
#         si no esta instalado, se omite con aviso (CA-6).
#   [writer-reviewer] Writer y reviewer se mantienen seleccionables como
#         agentes primarios (`mode: all`) sin abrir permisos de stages
#         headless (CA-3/CA-4, issue #1034).
#   [opencode-edit] Los cinco agentes, que declaran capability `edit`, reciben
#         las rutas neutrales en edit/write/patch sin abrir el catch-all
#         (CA-6, issue #1078).
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
# `model:` esperado en la salida Claude y el modo esperado en
# `opencode agent list`. Sin arrays asociativos (bash 3.2, MEF-ADR-0049 CA-6).
profile_for_agent() {
    case "$1" in
        mefisto-historiador|mefisto-writer) echo "balanced" ;;
        mefisto-planner|mefisto-investigator|mefisto-reviewer) echo "deep" ;;
        *) echo "" ;;
    esac
}

mode_for_agent() {
    case "$1" in
        mefisto-planner|mefisto-investigator|mefisto-historiador) echo "primary" ;;
        mefisto-writer|mefisto-reviewer) echo "all" ;;
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
echo "[writer-reviewer] Writer y reviewer son seleccionables como agentes primarios sin abrir permisos"
for id in mefisto-writer mefisto-reviewer; do
    src="$AGENTS_DIR/$id.md"
    out_file="$REPO_ROOT/.opencode/agents/$id.md"
    if grep -q '"mode": "all"' "$src" 2>/dev/null; then
        pass "$id: fuente neutral declara mode: all"
    else
        fail "$id: fuente neutral debe declarar mode: all (no subagent)"
    fi
    if grep -q '^mode: "all"$' "$out_file" 2>/dev/null; then
        pass "$id: adaptador OpenCode declara mode: all"
    else
        fail "$id: adaptador OpenCode debe declarar mode: all"
    fi
    permission="$(sed -n 's/^permission: //p' "$out_file")"
    for key in question task webfetch websearch external_directory; do
        if [ "$(printf '%s' "$permission" | jq -r --arg key "$key" '.[$key] // empty')" = "deny" ]; then
            pass "$id: permission.$key permanece en deny"
        else
            fail "$id: permission.$key debe permanecer en deny"
        fi
    done
    if [ "$(printf '%s' "$permission" | jq -r '.skill["*"] // empty')" = "deny" ] \
        && [ "$(printf '%s' "$permission" | jq -r '.skill["code-comments"] // empty')" = "allow" ]; then
        pass "$id: permission.skill acotado a code-comments (resto en deny)"
    else
        fail "$id: permission.skill debe permitir solo code-comments y denegar el resto"
    fi
    for key in list glob grep lsp todowrite; do
        if [ "$(printf '%s' "$permission" | jq -r --arg key "$key" '.[$key] // empty')" = "allow" ]; then
            pass "$id: permission.$key permanece en allow por capability read"
        else
            fail "$id: permission.$key debe permanecer en allow por capability read"
        fi
    done
    if [ "$(printf '%s' "$permission" | jq -r '.bash["git *"] // empty')" = "allow" ] \
        && [ "$(printf '%s' "$permission" | jq -r '.bash["*"] // empty')" = "deny" ]; then
        pass "$id: permission.bash conserva la allowlist de capability shell"
    else
        fail "$id: permission.bash debe conservar catch-all deny y git * allow"
    fi
    if [ "$(printf '%s' "$permission" | jq -r '.read["*"] // empty')" = "allow" ] \
        && [ "$(printf '%s' "$permission" | jq -r '.read[".env"] // empty')" = "deny" ]; then
        pass "$id: permission.read conserva la allowlist de capability read"
    else
        fail "$id: permission.read debe conservar catch-all allow y .env deny"
    fi
done

echo ""
echo "[opencode-edit] Los cinco agentes reciben las rutas neutrales en edit/write/patch"
for id in $AGENT_IDS; do
    out_file="$REPO_ROOT/.opencode/agents/$id.md"
    permission="$(sed -n 's/^permission: //p' "$out_file")"
    for key in edit write patch; do
        if [ "$(printf '%s' "$permission" | jq -r --arg key "$key" '.[ $key ]["src/internal/**"] // empty')" = "allow" ] \
            && [ "$(printf '%s' "$permission" | jq -r --arg key "$key" '.[ $key ]["src/published/**"] // empty')" = "allow" ] \
            && [ "$(printf '%s' "$permission" | jq -r --arg key "$key" '.[ $key ]["src/runtime/**"] // empty')" = "allow" ] \
            && [ "$(printf '%s' "$permission" | jq -r --arg key "$key" '.[ $key ]["*"] // empty')" = "deny" ]; then
            pass "$id: permission.$key conserva la allowlist neutral de capability edit"
        else
            fail "$id: permission.$key debe conservar catch-all deny y allow para src/internal/**, src/published/** y src/runtime/**"
        fi
    done
done

echo ""
echo "[neutral] Ningun body nombra 'claude'/'opencode' (CA-1/CA-5)"
for id in $AGENT_IDS; do
    src="$AGENTS_DIR/$id.md"
    [ -f "$src" ] || continue
    hit=$(awk '
        NR==1 { next }
        $0=="---" && !seen { seen=1; next }
        seen && tolower($0) ~ /claude|opencode/ { print NR; exit }
    ' "$src")
    if [ -z "$hit" ]; then
        pass "$id: body sin menciones a claude/opencode"
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
echo "[runtime-output] .claude/agents/*.md y .opencode/agents/*.md reflejan las tablas por runtime"
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
    if grep -q "^<!-- GENERADO por src/internal/scripts/generate-internal-adapters.sh" "$REPO_ROOT/.opencode/agents/$id.md" 2>/dev/null; then
        pass "$id: .opencode/agents/$id.md lleva el marcador de generado"
    else
        fail "$id: .opencode/agents/$id.md no lleva el marcador de generado"
    fi
done

for id in $AGENT_IDS; do
    out_file="$REPO_ROOT/.opencode/agents/$id.md"
    rel="${out_file#"$REPO_ROOT"/}"
    [ -f "$out_file" ] || { fail "$rel: no existe"; continue; }
    if grep -qiE '\b(fable|opus)\b|claude-[a-z0-9]+-[0-9]' "$out_file"; then
        fail "$rel: menciona un id de modelo prohibido (fable/opus o un id completo, irresoluble en OpenCode)"
    else
        pass "$rel: sin fable/opus ni id de modelo"
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

for id in $AGENT_IDS; do
    if grep -q '^model:' "$REPO_ROOT/.opencode/agents/$id.md" 2>/dev/null; then
        fail "$id: .opencode/agents no deberia fijar model:"
    else
        pass "$id: .opencode/agents sin model: (hereda la configuracion del usuario)"
    fi
done

echo ""
echo "[opencode-cli] 'opencode agent list' lista los cinco ids con su modo (se omite si el CLI no esta instalado)"
if command -v opencode >/dev/null 2>&1; then
    # Un reintento: el CLI descubre los agentes leyendo .opencode/agents/, que
    # el generador acaba de reescribir en la corrida tipica (writer regenera ->
    # test verifica). Una lectura que cae en ese instante devuelve el listado
    # sin alguno de los cinco; reintentar una vez distingue esa carrera de una
    # ausencia real, sin debilitar la asercion.
    #
    # `grep -q` sobre here-string (<<<), nunca sobre un pipe. `grep -q` cierra
    # su stdin en el primer match; si el escritor del otro extremo del pipe
    # todavia no termino, muere con SIGPIPE y `pipefail` propaga ese 141
    # aunque grep haya salido en 0. Con tres agentes el volcado de 'opencode
    # agent list' cabia en el buffer del pipe (64KB en macOS) y el escritor
    # terminaba antes de que grep saliera; con cinco son ~98KB y el fallo se
    # vuelve determinista para todo id que aparezca temprano en el listado
    # (medido en #909: los tres `primary` fallaban con rc=141 y los dos
    # `subagent`, al final del volcado, pasaban). El here-string no tiene un
    # segundo proceso que pueda recibir la señal.
    out=$(cd "$REPO_ROOT" && opencode agent list 2>&1)
    for id in $AGENT_IDS; do
        mode=$(mode_for_agent "$id")
        grep -q "^$id ($mode)" <<<"$out" || {
            out=$(cd "$REPO_ROOT" && opencode agent list 2>&1)
            break
        }
    done
    for id in $AGENT_IDS; do
        mode=$(mode_for_agent "$id")
        if grep -q "^$id ($mode)" <<<"$out"; then
            pass "$id: listado por 'opencode agent list' como $mode"
        else
            fail "$id: NO aparece en 'opencode agent list' como $mode"
        fi
    done
else
    echo "  AVISO: CLI 'opencode' no instalado, se omite este bloque"
fi

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
