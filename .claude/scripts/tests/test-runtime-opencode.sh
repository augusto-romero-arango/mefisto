#!/usr/bin/env bash
# test-runtime-opencode.sh -- Tests del adaptador de runtime OpenCode
# (MEF-ADR-0049, issue #860): src/runtime/lib/runtime-opencode.sh + su traductor.
#
# Ninguno de estos tests invoca el CLI real de OpenCode -- todo corre contra
# una CLI `opencode` FALSA (stub bash) puesta primero en el PATH, que
# reproduce fixtures de .claude/scripts/tests/fixtures/runtime-opencode/
# *-1.18.29.jsonl (capturados con corridas reales minimas; su procedencia,
# la version del CLI y la regla de "no editar un fixture viejo" estan en el
# README.md de ese directorio) y devuelve el exit code que le indique el
# escenario (mismo espiritu que test-runtime-claude.sh, pero aqui la CLI
# falsa tiene que ser un binario real llamado `opencode`: runtime_opencode_
# build_cmd invoca literalmente ese nombre).
#
# Casos cubiertos:
#   [pre] Los archivos nuevos existen, tienen sintaxis valida y el programa
#         jq corre sin errores.
#   [A] CA-2 (issue #1448): runtime_opencode_build_cmd compone `opencode run
#       --agent <id> --dir <cwd> --format json --auto [-m <modelo>]
#       [--session <id>]` SIN mensaje posicional -- flags fijos siempre
#       presentes, -m solo si se recibe modelo no vacio, --system-file
#       inyectado como PREFIJO del mensaje (nunca un flag ni texto en argv),
#       el mensaje se materializa en
#       "$MEFISTO_RUNTIME_WORK_DIR/opencode-message.md" y se declara via
#       MEFISTO_RUNTIME_STDIN_FILE (sin esa variable, build_cmd falla
#       explicito en vez de degradar al argv), y el modelo opaco (con "/" y
#       espacios) reenviado literal.
#   [I] CA-3/CA-4 (issue #1448): paridad ante ARG_MAX -- un prompt >=
#       `getconf ARG_MAX` + 65536 bytes corre por stdin (nunca por argv) via
#       el runner real contra la CLI falsa, con exit 0, exactamente un
#       run.completed y el volcado de stdin identico byte a byte (cmp) al
#       fixture; el stub deja constancia de que stdin no era TTY.
#   [B] CA-2: runtime_opencode_translate mapea text->message, tool_use
#       (segun state.status)->tool.started/tool.completed sintetizados desde
#       la MISMA linea (OpenCode 1.18.29 no separa tool_use/tool_result como
#       Claude), y descarta en silencio cualquier tipo no reconocido (nunca
#       expone el wire format al JSONL neutral) contandolo por el canal de
#       diagnostico (`raw_ignored`), con membresia EXACTA: un tipo futuro que
#       sea subcadena de uno conocido tampoco cuenta como reconocido.
#   [C] CA-3: clasificacion completa -- exito (exit 0 + texto visible) >
#       rate_limit (exit != 0 con "429" + "rate limit"/"usage limit" en
#       stderr, patron conservador del issue #965: OpenCode no expone un
#       evento estructurado equivalente al `rate_limit_event` de Claude) >
#       nonzero_exit (exit != 0, detalle de stderr) > no_result (stream
#       vacio) > protocol_invalid (linea no-JSON) > no_result (exit 0 sin
#       texto visible). El TIMEOUT del watchdog no se ejercita aqui via
#       translate directo (lo sintetiza el runner, ver seccion [F]).
#   [D] CA-4: durante el corte el productor OpenCode conserva el terminal
#       legacy con session_id/tokens/cost_usd hasta que integre el estimador.
#       format los trae (SUMANDO todos los step_finish, que reportan por paso
#       y no acumulado); turns/denials/ttft_ms/
#       api_duration_ms SIEMPRE null (el wire format no tiene equivalente);
#       model degrada siempre al parametro pedido (el wire format no lo
#       trae en ninguna version verificada).
#   [E] CA-5: ninguna ruta/variable de credenciales
#       (~/.local/share/opencode/auth.json, OPENAI_API_KEY,
#       ANTHROPIC_API_KEY) aparece en runtime-opencode.sh/.jq, y un secreto
#       puesto en el entorno del test no aparece ni en el argv que compone
#       build_cmd ni en el JSONL que produce una corrida real contra el stub.
#   [F] CA-6: runner real (mefisto-run-agent.sh --runtime opencode) contra la
#       CLI falsa: exito, fallo con exit 1, timeout, stream vacio, JSON
#       malformado, exit 0 sin texto visible, modelo heredado (sin -m en la
#       linea capturada), modelo opaco con "/" y espacios, y prefijo de
#       --system-file presente al inicio del mensaje. Cada caso valida el
#       JSONL contra run-events.schema.json y exactamente un terminal.
#   [G] CA #1322: cache diaria de Models.dev con forma real, refresh acotado,
#       validacion, fallback stale, marca de intento y lock concurrente; curl
#       y la fecha UTC son stubs, por lo que la suite nunca consulta Internet.
#   [H] issue #1324 (MEF-ADR-0054): estimated_cost_usd por paso con tarifas
#       REALES de gpt-5.6-luna/terra/sol (verificadas 2026-09-13, las mismas
#       citadas en el ADR) inyectadas directo como cache ya validada (sin
#       pasar por curl): reproduce los importes de #1315 (writer Terra,
#       reviewer Sol), cache_read/cache_write/reasoning en la formula, cruce
#       de tier dentro de un solo paso (con el caso limite exacto-al-umbral),
#       varios pasos que individualmente no cruzan tier (tier por paso, nunca
#       acumulado), modelo desconocido y catalogo ausente/stale -> null o
#       degradacion con aviso segun corresponda; que el trabajo diario del
#       catalogo no se repite en cada anexo en vivo cuando se invoca la
#       traduccion COMO LO HACE EL RUNNER (dentro de una sustitucion de
#       comandos, o sea en un subshell) y que live y final dan el mismo
#       importe; y que un catalogo corrupto, una tarifa no numerica, un tier
#       invalido o un step_finish sin objeto `tokens` degradan a null sin
#       abortar la traduccion ni fabricar un cero.
#
# Uso: .claude/scripts/tests/test-runtime-opencode.sh
# Exit code: 0 si todos los checks pasan, 1 si alguno falla.
# Bash 3.2 + jq 1.7 (MEF-ADR-0049 CA-6): sin arrays asociativos.

set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
INTERNAL_SCRIPTS="$REPO_ROOT/src/internal/scripts"
LIB_DIR="$REPO_ROOT/src/runtime/lib"
CONTRACT_DIR="$REPO_ROOT/src/runtime/contract"
RUNNER="$REPO_ROOT/src/runtime/mefisto-run-agent.sh"
OPENCODE_LIB="$LIB_DIR/runtime-opencode.sh"
OPENCODE_JQ="$LIB_DIR/runtime-opencode.jq"
SCHEMA_FILE="$CONTRACT_DIR/run-events.schema.json"
JSONSCHEMA_LITE="$INTERNAL_SCRIPTS/lib/jsonschema-lite.jq"
FIXTURES_DIR="$SCRIPT_DIR/fixtures/runtime-opencode"

# El runner (mefisto-run-agent.sh) resuelve la lib de adaptador via
# MEFISTO_RUNTIME_LIB_DIR (mefisto-runtime.sh), que respeta un valor ya
# EXPORTADO por el caller. Los pipelines internos la exportan apuntando al
# checkout donde arrancaron, asi que sin pinearla aqui el bloque del runner
# real traduciria con el adaptador de OTRO checkout (el principal) en vez del
# que este test esta juzgando: un gate no determinista que da por bueno
# codigo que nunca ejecuto (MEF-ADR-0031). test-mefisto-run-agent.sh ya la
# controla por el mismo motivo.
export MEFISTO_RUNTIME_LIB_DIR="$LIB_DIR"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# translate_fixture <fixture.jsonl> [model] [exit_code] [stderr_file] -- corre
# runtime_opencode_translate directo (sin pasar por el runner) contra un
# fixture, imprime el JSONL.
translate_fixture() {
    local fixture="$1" model="${2:-}" exit_code="${3:-}" stderr_file="${4:-}"
    runtime_opencode_translate "$FIXTURES_DIR/$fixture" "opencode" "$model" "$exit_code" "$stderr_file"
}

# validate_event_line <json-line> -- mismo patron que test-runtime-claude.sh:
# valida contra definitions[.type].
validate_event_line() {
    local line="$1"
    local ev_type
    ev_type="$(printf '%s' "$line" | jq -r '.type // empty' 2>/dev/null)"
    if [ -z "$ev_type" ]; then
        echo "linea sin campo 'type' (o JSON invalido)"
        return 1
    fi
    local known
    known="$(jq --arg t "$ev_type" '(.types | index($t)) != null' "$SCHEMA_FILE" 2>/dev/null)"
    if [ "$known" != "true" ]; then
        echo "type '$ev_type' no esta en el vocabulario cerrado de 'types'"
        return 1
    fi
    local sub_schema errors
    sub_schema="$(jq -c --arg t "$ev_type" '.definitions[$t]' "$SCHEMA_FILE" 2>/dev/null)"
    errors="$(jq -n --argjson schema "$sub_schema" --argjson instance "$line" -f "$JSONSCHEMA_LITE" 2>&1)"
    if [ -n "$errors" ] && [ "$(printf '%s' "$errors" | jq 'length' 2>/dev/null)" != "0" ]; then
        printf '%s' "$errors" | jq -r '.[]'
        return 1
    fi
    case "$ev_type" in
        run.completed|run.failed)
            printf '%s' "$line" | jq -e 'has("estimated_cost_usd") or has("cost_usd")' >/dev/null 2>&1 || return 1
            ;;
    esac
    return 0
}

count_terminals() {
    jq -c 'select(.type == "run.completed" or .type == "run.failed")' "$1" 2>/dev/null | wc -l | tr -d ' '
}

check_all_lines_valid() {
    local name="$1" file="$2"
    local bad=0 line reason
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        if ! reason="$(validate_event_line "$line")"; then
            bad=1
            echo "    linea invalida: $reason"
        fi
    done < "$file"
    if [ "$bad" -eq 0 ]; then
        pass "$name: todas las lineas validan contra el schema"
    else
        fail "$name: alguna linea no valido (ver arriba)"
    fi
}

echo "[pre] Archivos nuevos existen, sintaxis valida"

for f in "$OPENCODE_LIB" "$OPENCODE_JQ"; do
    if [ -f "$f" ]; then
        pass "existe: ${f#"$REPO_ROOT"/}"
    else
        fail "no existe: ${f#"$REPO_ROOT"/}"
    fi
done

if bash -n "$OPENCODE_LIB" 2>/dev/null; then
    pass "sintaxis bash valida: ${OPENCODE_LIB#"$REPO_ROOT"/}"
else
    fail "sintaxis bash invalida: ${OPENCODE_LIB#"$REPO_ROOT"/}"
fi

# shellcheck source=/dev/null
source "$OPENCODE_LIB" 2>/dev/null
for fn in runtime_opencode_build_cmd runtime_opencode_translate runtime_opencode_supports_resume runtime_opencode_interactive_refresh runtime_opencode_prepare_pricing runtime_opencode_ensure_pricing; do
    if declare -F "$fn" >/dev/null 2>&1; then
        pass "$fn definida"
    else
        fail "$fn NO definida"
    fi
done

if OUT="$(translate_fixture success-1.18.29.jsonl "" 0)" && [ -n "$OUT" ]; then
    pass "runtime-opencode.jq corre sin errores (stderr silenciado, exit 0)"
else
    fail "runtime-opencode.jq fallo al correr contra success-1.18.29.jsonl"
fi

# ============================================================================
echo ""
echo "[A] CA-2 (issue #1448): runtime_opencode_build_cmd compone el argv completo, SIN mensaje posicional"

PROMPT_PLAIN="$TMP/prompt-plain.txt"
printf 'Instrucciones de prueba.' > "$PROMPT_PLAIN"
SYSTEM_FILE="$TMP/system.txt"
printf 'You are running in non-interactive print mode.' > "$SYSTEM_FILE"

# build_cmd materializa el mensaje DENTRO de MEFISTO_RUNTIME_WORK_DIR (issue
# #1448): un caller que la invoque fuera del runner real (como esta seccion)
# tiene que exponerla igual que lo hace mefisto-run-agent.sh antes de invocar
# build_cmd.
export MEFISTO_RUNTIME_WORK_DIR="$TMP/work-a"
mkdir -p "$MEFISTO_RUNTIME_WORK_DIR"

MEFISTO_RUNTIME_CMD=()
MEFISTO_RUNTIME_STDIN_FILE=""
runtime_opencode_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "openai/gpt-5" "$SYSTEM_FILE"

if [ "${MEFISTO_RUNTIME_CMD[0]}" = "opencode" ] && [ "${MEFISTO_RUNTIME_CMD[1]}" = "run" ]; then
    pass "A-1: el argv arranca con 'opencode run'"
else
    fail "A-1: el argv no arranca con 'opencode run': ${MEFISTO_RUNTIME_CMD[*]}"
fi

contains_pair() {
    # contains_pair <flag> <valor> -- true si el array MEFISTO_RUNTIME_CMD
    # trae <flag> inmediatamente seguido de <valor>.
    local flag="$1" value="$2" i
    for ((i=0; i<${#MEFISTO_RUNTIME_CMD[@]}-1; i++)); do
        if [ "${MEFISTO_RUNTIME_CMD[$i]}" = "$flag" ] && [ "${MEFISTO_RUNTIME_CMD[$((i+1))]}" = "$value" ]; then
            return 0
        fi
    done
    return 1
}

contains_elem() {
    local needle="$1" e
    for e in "${MEFISTO_RUNTIME_CMD[@]}"; do
        [ "$e" = "$needle" ] && return 0
    done
    return 1
}

if contains_pair "--agent" "writer"; then
    pass "A-2: --agent writer presente"
else
    fail "A-2: falta --agent writer: ${MEFISTO_RUNTIME_CMD[*]}"
fi

if contains_pair "--dir" "$TMP"; then
    pass "A-3: --dir <cwd> presente"
else
    fail "A-3: falta --dir $TMP: ${MEFISTO_RUNTIME_CMD[*]}"
fi

if contains_pair "--format" "json" && contains_elem "--auto"; then
    pass "A-4: --format json --auto presente"
else
    fail "A-4: falta --format json --auto: ${MEFISTO_RUNTIME_CMD[*]}"
fi

if contains_pair "-m" "openai/gpt-5"; then
    pass "A-5: -m openai/gpt-5 presente cuando se recibe modelo no vacio"
else
    fail "A-5: falta -m openai/gpt-5: ${MEFISTO_RUNTIME_CMD[*]}"
fi

# A-6 (CA-2/CA-5, issue #1448): ni el mensaje ni ningun fragmento suyo
# aparece en el argv -- viaja SOLO por MEFISTO_RUNTIME_STDIN_FILE.
argv_contains_needle() {
    local needle="$1" e
    for e in "${MEFISTO_RUNTIME_CMD[@]}"; do
        case "$e" in *"$needle"*) return 0 ;; esac
    done
    return 1
}
if ! argv_contains_needle "Instrucciones de prueba."; then
    pass "A-6: el contenido del mensaje no aparece en ningun elemento del argv"
else
    fail "A-6: el mensaje aparecio en el argv: ${MEFISTO_RUNTIME_CMD[*]}"
fi

EXPECTED_MESSAGE="You are running in non-interactive print mode."$'\n\n'"Instrucciones de prueba."
if [ -n "$MEFISTO_RUNTIME_STDIN_FILE" ] && [ -f "$MEFISTO_RUNTIME_STDIN_FILE" ] \
    && [ "$(cat "$MEFISTO_RUNTIME_STDIN_FILE")" = "$EXPECTED_MESSAGE" ]; then
    pass "A-6b: MEFISTO_RUNTIME_STDIN_FILE contiene '<system-file>\\n\\n<prompt>' materializado"
else
    fail "A-6b: el archivo de stdin no coincide: '$(cat "${MEFISTO_RUNTIME_STDIN_FILE:-/dev/null}" 2>/dev/null)'"
fi

case "$MEFISTO_RUNTIME_STDIN_FILE" in
    "$MEFISTO_RUNTIME_WORK_DIR"/*) pass "A-6c: el archivo de mensaje vive dentro de MEFISTO_RUNTIME_WORK_DIR" ;;
    *) fail "A-6c: MEFISTO_RUNTIME_STDIN_FILE fuera de MEFISTO_RUNTIME_WORK_DIR: '$MEFISTO_RUNTIME_STDIN_FILE'" ;;
esac

# A-6d: sin MEFISTO_RUNTIME_WORK_DIR no hay donde materializar el mensaje. El
# adaptador NO puede degradar a poner el mensaje en el argv (es justo lo que
# #1448 elimina) ni escribir en la raiz del filesystem: falla explicito,
# nombrando la variable, y deja MEFISTO_RUNTIME_CMD vacio -- la senal que
# mefisto-run-agent.sh ya traduce a exit 69.
A6D_ERR="$TMP/a6d-stderr.txt"
if ( unset MEFISTO_RUNTIME_WORK_DIR
     MEFISTO_RUNTIME_CMD=()
     MEFISTO_RUNTIME_STDIN_FILE=""
     ! runtime_opencode_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "" "" 2>"$A6D_ERR" ) \
   && grep -q "MEFISTO_RUNTIME_WORK_DIR" "$A6D_ERR" && [ ! -e /opencode-message.md ]; then
    pass "A-6d: sin MEFISTO_RUNTIME_WORK_DIR build_cmd falla explicito nombrando la variable, sin escribir fuera del directorio de la corrida"
else
    fail "A-6d: build_cmd no fallo explicito sin MEFISTO_RUNTIME_WORK_DIR: '$(cat "$A6D_ERR" 2>/dev/null)'"
fi

# Modelo vacio (heredar, CA-1 de #858): NUNCA debe verse -m en el argv.
MEFISTO_RUNTIME_CMD=()
MEFISTO_RUNTIME_STDIN_FILE=""
runtime_opencode_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "" ""
if ! contains_elem "-m"; then
    pass "A-7: modelo vacio (heredar) -> ningun -m en el argv"
else
    fail "A-7: modelo vacio pero el argv trae -m: ${MEFISTO_RUNTIME_CMD[*]}"
fi
if [ -f "$MEFISTO_RUNTIME_STDIN_FILE" ] && [ "$(cat "$MEFISTO_RUNTIME_STDIN_FILE")" = "Instrucciones de prueba." ]; then
    pass "A-8: --system-file vacio -> el archivo de mensaje es SOLO el prompt, sin prefijo"
else
    fail "A-8: el archivo de mensaje trae un prefijo espurio: '$(cat "${MEFISTO_RUNTIME_STDIN_FILE:-/dev/null}" 2>/dev/null)'"
fi

# El prompt puede traer backticks/$()/comillas -- sin eval, viajan intactos
# dentro del archivo de mensaje, nunca por argv.
PROMPT_DANGEROUS="$TMP/prompt-dangerous.txt"
printf 'Linea con `comando`, $(echo pwned) y "comillas".' > "$PROMPT_DANGEROUS"
MEFISTO_RUNTIME_CMD=()
MEFISTO_RUNTIME_STDIN_FILE=""
runtime_opencode_build_cmd "writer" "$TMP" "$PROMPT_DANGEROUS" "" ""
if ! argv_contains_needle '`comando`' \
    && [ -f "$MEFISTO_RUNTIME_STDIN_FILE" ] \
    && [ "$(cat "$MEFISTO_RUNTIME_STDIN_FILE")" = 'Linea con `comando`, $(echo pwned) y "comillas".' ]; then
    pass "A-9: backticks/\$()/comillas del prompt viajan literales en el archivo de mensaje, nunca por argv"
else
    fail "A-9: el prompt peligroso aparecio en argv o el archivo de mensaje no coincide"
fi

# Modelo opaco con '/' y espacios -- el adaptador nunca lo interpreta, solo lo reenvia.
MEFISTO_RUNTIME_CMD=()
runtime_opencode_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "openai/gpt-4.1 mini" ""
if contains_pair "-m" "openai/gpt-4.1 mini"; then
    pass "A-10: modelo opaco con '/' y espacios reenviado literal"
else
    fail "A-10: el modelo opaco no llego intacto: ${MEFISTO_RUNTIME_CMD[*]}"
fi

# --- Reanudacion de sesion (issue #968) ---

MEFISTO_RUNTIME_CMD=()
MEFISTO_RUNTIME_STDIN_FILE=""
runtime_opencode_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "" "" "sess-xyz-789"
if contains_pair "--session" "sess-xyz-789"; then
    pass "A-11: resume_session_id no vacio -> --session <id> en el argv"
else
    fail "A-11: falta --session sess-xyz-789: ${MEFISTO_RUNTIME_CMD[*]}"
fi
if [ -f "$MEFISTO_RUNTIME_STDIN_FILE" ] && [ "$(cat "$MEFISTO_RUNTIME_STDIN_FILE")" = "Instrucciones de prueba." ]; then
    pass "A-11b: el mensaje se sigue materializando igual con --session presente (nunca se mezcla con el argv)"
else
    fail "A-11b: --session altero el archivo de mensaje: '$(cat "${MEFISTO_RUNTIME_STDIN_FILE:-/dev/null}" 2>/dev/null)'"
fi

MEFISTO_RUNTIME_CMD=()
runtime_opencode_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "" "" ""
if ! contains_elem "--session"; then
    pass "A-12: resume_session_id vacio (o ausente) -> ningun --session en el argv (byte a byte igual a antes de #968)"
else
    fail "A-12: resume_session_id vacio pero el argv trae --session: ${MEFISTO_RUNTIME_CMD[*]}"
fi

# --- Effort (issue #2496) ---

MEFISTO_RUNTIME_CMD=()
runtime_opencode_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "" "" "" "high"
if contains_pair "--variant" "high"; then
    pass "A-14: effort high -> --variant high en el argv"
else
    fail "A-14: falta --variant high: ${MEFISTO_RUNTIME_CMD[*]}"
fi

for _eff_case in "empty" "absent"; do
    MEFISTO_RUNTIME_CMD=()
    if [ "$_eff_case" = "empty" ]; then
        runtime_opencode_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "" "" "" ""
    else
        runtime_opencode_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "" "" ""
    fi
    if ! contains_elem "--variant"; then
        pass "A-15 ($_eff_case): effort vacio/ausente -> ningun --variant en el argv"
    else
        fail "A-15 ($_eff_case): el argv trae --variant sin effort: ${MEFISTO_RUNTIME_CMD[*]}"
    fi
done

MEFISTO_RUNTIME_CMD=()
MEFISTO_AGENT_PACKAGE_ROOT_SAVED="${MEFISTO_AGENT_PACKAGE_ROOT:-}"
_eff_pkg="$TMP/eff-pkg"
mkdir -p "$_eff_pkg/agents"
echo '{}' > "$_eff_pkg/mefisto-manifest.json"
(
    unset OPENCODE_CONFIG_DIR
    export MEFISTO_AGENT_PACKAGE_ROOT="$_eff_pkg" XDG_CONFIG_HOME="$TMP/eff-xdg"
    runtime_opencode_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "" "" "" "high"
    if [ "${MEFISTO_RUNTIME_CMD[0]:-}" = "env" ] && printf '%s\n' "${MEFISTO_RUNTIME_CMD[@]}" | grep -qxF -- "--variant"; then
        echo "EFF_ENV_OK"
    fi
    MEFISTO_RUNTIME_CMD=()
    runtime_opencode_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "" "" "" ""
    if [ "${MEFISTO_RUNTIME_CMD[0]:-}" = "env" ] && ! printf '%s\n' "${MEFISTO_RUNTIME_CMD[@]}" | grep -qxF -- "--variant"; then
        echo "EFF_ENV_EMPTY_OK"
    fi
) > "$TMP/eff-env.out" 2>/dev/null
if grep -qx "EFF_ENV_OK" "$TMP/eff-env.out" && grep -qx "EFF_ENV_EMPTY_OK" "$TMP/eff-env.out"; then
    pass "A-16: con el prefijo env OPENCODE_CONFIG_DIR, --variant solo aparece con effort no vacio"
else
    fail "A-16: combinacion env + --variant incorrecta: $(cat "$TMP/eff-env.out" 2>/dev/null)"
fi

if runtime_opencode_supports_resume; then
    pass "A-13: runtime_opencode_supports_resume retorna 0 (OpenCode soporta reanudacion)"
else
    fail "A-13: runtime_opencode_supports_resume deberia retornar 0"
fi

printf '%s\n' 'restart /exit' > "$TMP/refresh-expected"
if runtime_opencode_interactive_refresh > "$TMP/refresh-actual" \
    && cmp -s "$TMP/refresh-expected" "$TMP/refresh-actual"; then
    pass "A-14: runtime_opencode_interactive_refresh imprime exactamente una linea 'restart /exit' sin invocar el CLI"
else
    REFRESH_OUTPUT="$(runtime_opencode_interactive_refresh 2>/dev/null)"
    fail "A-14: refresh interactivo OpenCode inesperado: '$REFRESH_OUTPUT'"
fi

# --- Raiz de la release del pipeline (MEF-ADR-0053 decision 2) ---

RELEASE_OK="$TMP/release-opencode"
mkdir -p "$RELEASE_OK/agents"
printf '{"runtime":"opencode"}' > "$RELEASE_OK/mefisto-manifest.json"
XDG_SANDBOX="$TMP/xdg-a15"
mkdir -p "$XDG_SANDBOX/opencode"

build_with_root() {
    MEFISTO_RUNTIME_CMD=()
    ( unset OPENCODE_CONFIG_DIR
      export XDG_CONFIG_HOME="$XDG_SANDBOX" MEFISTO_AGENT_PACKAGE_ROOT="$1"
      [ -n "${2:-}" ] && export OPENCODE_CONFIG_DIR="$2"
      runtime_opencode_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "" "" >/dev/null
      printf '%s\n' "${MEFISTO_RUNTIME_CMD[@]}" )
}

ARGV="$(build_with_root "$RELEASE_OK")"
if [ "$(printf '%s\n' "$ARGV" | sed -n '1p')" = "env" ] && [ "$(printf '%s\n' "$ARGV" | sed -n '2p')" = "OPENCODE_CONFIG_DIR=$RELEASE_OK" ] \
    && [ "$(printf '%s\n' "$ARGV" | sed -n '3p')" = "opencode" ]; then
    pass "A-15: release valida -> env OPENCODE_CONFIG_DIR=<raiz> opencode run ..."
else
    fail "A-15: argv inesperado: $(printf '%s' "$ARGV" | tr '\n' ' ')"
fi

ARGV="$(build_with_root "$TMP")"
[ "$(printf '%s\n' "$ARGV" | sed -n '1p')" = "opencode" ] \
    && pass "A-16: raiz sin manifiesto de release -> sin OPENCODE_CONFIG_DIR" \
    || fail "A-16: inyecto OPENCODE_CONFIG_DIR con una raiz que no es release: $(printf '%s' "$ARGV" | tr '\n' ' ')"

ARGV="$(build_with_root "$RELEASE_OK" "/ruta/del/usuario")"
[ "$(printf '%s\n' "$ARGV" | sed -n '1p')" = "opencode" ] \
    && pass "A-17: OPENCODE_CONFIG_DIR del usuario se respeta -> sin reemplazo" \
    || fail "A-17: reemplazo el OPENCODE_CONFIG_DIR del usuario: $(printf '%s' "$ARGV" | tr '\n' ' ')"

printf '{}' > "$XDG_SANDBOX/opencode/.mefisto-projection.json"
ARGV="$(build_with_root "$RELEASE_OK")"
[ "$(printf '%s\n' "$ARGV" | sed -n '1p')" = "opencode" ] \
    && pass "A-18: proyeccion global activa -> sin OPENCODE_CONFIG_DIR (evita plugins duplicados)" \
    || fail "A-18: inyecto con la proyeccion global activa: $(printf '%s' "$ARGV" | tr '\n' ' ')"
rm -f "$XDG_SANDBOX/opencode/.mefisto-projection.json"

ARGV="$( MEFISTO_RUNTIME_CMD=(); ( unset MEFISTO_AGENT_PACKAGE_ROOT; runtime_opencode_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "" "" >/dev/null; printf '%s\n' "${MEFISTO_RUNTIME_CMD[@]}" ) )"
[ "$(printf '%s\n' "$ARGV" | sed -n '1p')" = "opencode" ] \
    && pass "A-19: sin MEFISTO_AGENT_PACKAGE_ROOT (pipelines internos) -> sin OPENCODE_CONFIG_DIR" \
    || fail "A-19: inyecto sin raiz: $(printf '%s' "$ARGV" | tr '\n' ' ')"

# ============================================================================
echo ""
echo "[B] CA-2: mapeo de eventos (text->message, tool_use->tool.started+tool.completed, tipos ignorados)"

B_OUT="$TMP/b-tool.jsonl"
translate_fixture success-tool-1.18.29.jsonl "" 0 > "$B_OUT"

if jq -e 'select(.type=="message") | .role == "assistant" and .text == "- `archivo-demo.txt`"' "$B_OUT" >/dev/null 2>&1; then
    pass "B-1: el bloque 'text' se tradujo a message{role:assistant}"
else
    fail "B-1: el mensaje traducido no coincide: $(jq -c 'select(.type=="message")' "$B_OUT")"
fi

if jq -e 'select(.type=="tool.started") | .tool == "glob" and .input_summary == null' "$B_OUT" >/dev/null 2>&1; then
    pass "B-2: el tool_use (status completed) sintetizo tool.started{tool:'glob', input_summary:null}"
else
    fail "B-2: no se encontro el tool.started esperado: $(jq -c 'select(.type=="tool.started")' "$B_OUT")"
fi

if jq -e 'select(.type=="tool.completed") | .tool == "glob" and .ok == true and .duration_ms == 92' "$B_OUT" >/dev/null 2>&1; then
    pass "B-3: el mismo tool_use sintetizo tool.completed{tool:'glob', ok:true, duration_ms:92} (state.time.end - state.time.start)"
else
    fail "B-3: no se encontro el tool.completed esperado: $(jq -c 'select(.type=="tool.completed")' "$B_OUT")"
fi

STARTED_TS="$(jq -r 'select(.type=="tool.started") | .ts' "$B_OUT")"
COMPLETED_TS="$(jq -r 'select(.type=="tool.completed") | .ts' "$B_OUT")"
FIRST_MSG_TS="$(jq -r 'select(.type=="message") | .ts' "$B_OUT" | head -n1)"
if [ "$STARTED_TS" \< "$COMPLETED_TS" ] || [ "$STARTED_TS" = "$COMPLETED_TS" ]; then
    if [ "$COMPLETED_TS" \< "$FIRST_MSG_TS" ] || [ "$COMPLETED_TS" = "$FIRST_MSG_TS" ]; then
        pass "B-4: orden temporal tool.started <= tool.completed <= message (mismo orden del stream)"
    else
        fail "B-4: tool.completed no precede al message: started=$STARTED_TS completed=$COMPLETED_TS message=$FIRST_MSG_TS"
    fi
else
    fail "B-4: tool.started no precede a tool.completed: started=$STARTED_TS completed=$COMPLETED_TS"
fi

if [ "$(grep -c '"type":"step_start"' "$B_OUT")" = "0" ] && [ "$(grep -c '"type":"step_finish"' "$B_OUT")" = "0" ]; then
    pass "B-5: step_start/step_finish nunca se re-emiten como linea propia (tipos reconocidos pero no traducidos)"
else
    fail "B-5: el adaptador re-emitio un evento step_start/step_finish espurio"
fi

if [ "$(grep -c '"type":"run.started"' "$B_OUT")" = "0" ]; then
    pass "B-6: runtime_opencode_translate nunca emite 'run.started' (responsabilidad exclusiva del runner)"
else
    fail "B-6: el adaptador emitio 'run.started' -- viola la interfaz de #858"
fi

# tool_use con status "error" -> tool.completed{ok:false}.
B_ERR_FIXTURE="$TMP/tool-error.jsonl"
cat > "$B_ERR_FIXTURE" <<'EOF'
{"type":"step_start","timestamp":1788666719871,"sessionID":"ses_err","part":{"id":"prt_1","messageID":"msg_1","sessionID":"ses_err","type":"step-start"}}
{"type":"tool_use","timestamp":1788666720782,"sessionID":"ses_err","part":{"type":"tool","tool":"read","callID":"call_1","state":{"status":"error","input":{"filePath":"/no/existe.txt"},"error":"File not found","time":{"start":1788666720768,"end":1788666720779}},"id":"prt_2","sessionID":"ses_err","messageID":"msg_1"}}
{"type":"step_finish","timestamp":1788666720829,"sessionID":"ses_err","part":{"id":"prt_3","reason":"tool-calls","messageID":"msg_1","sessionID":"ses_err","type":"step-finish","tokens":{"total":10,"input":8,"output":2},"cost":0}}
{"type":"text","timestamp":1788666724629,"sessionID":"ses_err","part":{"id":"prt_4","messageID":"msg_2","sessionID":"ses_err","type":"text","text":"El archivo no existe.","time":{"start":1788666723957,"end":1788666724623}}}
{"type":"step_finish","timestamp":1788666724691,"sessionID":"ses_err","part":{"id":"prt_5","reason":"stop","messageID":"msg_2","sessionID":"ses_err","type":"step-finish","tokens":{"total":20,"input":15,"output":5},"cost":0}}
EOF
B_ERR_OUT="$TMP/b-tool-error.jsonl"
runtime_opencode_translate "$B_ERR_FIXTURE" "opencode" "" 0 > "$B_ERR_OUT"
if jq -e 'select(.type=="tool.completed") | .ok == false' "$B_ERR_OUT" >/dev/null 2>&1; then
    pass "B-7: tool_use con state.status=='error' -> tool.completed{ok:false}"
else
    fail "B-7: no se tradujo el error de tool como ok:false: $(jq -c 'select(.type=="tool.completed")' "$B_ERR_OUT")"
fi

# Tipo de evento nunca visto (forward-compat, CA-2): se descarta en silencio,
# nunca aparece en el JSONL neutral (el diagnostico raw_ignored vive solo en
# el stderr del propio programa jq, ver cabecera de runtime-opencode.jq).
B_UNKNOWN_FIXTURE="$TMP/unknown-type.jsonl"
cat > "$B_UNKNOWN_FIXTURE" <<'EOF'
{"type":"step_start","timestamp":1000,"sessionID":"ses_u","part":{"type":"step-start"}}
{"type":"reasoning_delta","timestamp":1001,"sessionID":"ses_u","part":{"text":"pensando..."}}
{"type":"text","timestamp":1002,"sessionID":"ses_u","part":{"text":"listo"}}
{"type":"step_finish","timestamp":1003,"sessionID":"ses_u","part":{"tokens":{"input":1,"output":1},"cost":0}}
EOF
B_UNKNOWN_OUT="$TMP/b-unknown.jsonl"
runtime_opencode_translate "$B_UNKNOWN_FIXTURE" "opencode" "" 0 > "$B_UNKNOWN_OUT"
if [ "$(grep -c 'reasoning_delta' "$B_UNKNOWN_OUT")" = "0" ] && [ "$(jq -c 'select(.type=="message")' "$B_UNKNOWN_OUT" | wc -l | tr -d ' ')" = "1" ]; then
    pass "B-8: un tipo de evento desconocido ('reasoning_delta') se descarta sin filtrarse al JSONL neutral"
else
    fail "B-8: el tipo desconocido se filtro al JSONL neutral: $(cat "$B_UNKNOWN_OUT")"
fi

# `raw_ignored` (CA-2): el conteo vive SOLO en el canal de diagnostico del
# propio programa jq (run-events.schema.json fija additionalProperties:false
# sobre el terminal y este issue no lo modifica), asi que hay que invocar el
# programa a mano, sin el `2>/dev/null` con el que lo silencia
# runtime_opencode_translate. Los dos tipos que se esperan contados incluyen
# uno ('step') que es SUBCADENA de un tipo conocido ('step_start'): con una
# membresia por subcadena se lo tragaria como reconocido y el diagnostico
# mentiria por lo bajo.
B_IGNORED_FIXTURE="$TMP/raw-ignored.jsonl"
cat > "$B_IGNORED_FIXTURE" <<'EOF'
{"type":"step_start","timestamp":1000,"sessionID":"ses_i","part":{"type":"step-start"}}
{"type":"step","timestamp":1001,"sessionID":"ses_i","part":{"text":"tipo futuro, subcadena de step_start"}}
{"type":"reasoning_delta","timestamp":1002,"sessionID":"ses_i","part":{"text":"pensando..."}}
{"type":"text","timestamp":1003,"sessionID":"ses_i","part":{"text":"listo"}}
{"type":"step_finish","timestamp":1004,"sessionID":"ses_i","part":{"tokens":{"input":1,"output":1},"cost":0}}
EOF
B_IGNORED_ERR="$TMP/raw-ignored.stderr"
B_IGNORED_OUT="$TMP/raw-ignored.out.jsonl"
jq -R -s -c \
    --arg runtime "opencode" --arg model_param "" --arg exit_code "0" \
    --rawfile stderr_text /dev/null \
    --rawfile pricing_catalog_text /dev/null \
    -f "$OPENCODE_JQ" "$B_IGNORED_FIXTURE" > "$B_IGNORED_OUT" 2> "$B_IGNORED_ERR"
if grep -q 'raw_ignored=2' "$B_IGNORED_ERR"; then
    pass "B-9: raw_ignored=2 por el canal de diagnostico (membresia EXACTA: 'step' no lo absorbe 'step_start')"
else
    fail "B-9: el diagnostico no reporto raw_ignored=2: $(cat "$B_IGNORED_ERR")"
fi
if ! grep -q 'raw_ignored' "$B_IGNORED_OUT"; then
    pass "B-10: raw_ignored NUNCA aparece en el JSONL neutral (el terminal es additionalProperties:false)"
else
    fail "B-10: raw_ignored se filtro al JSONL neutral: $(cat "$B_IGNORED_OUT")"
fi

# ============================================================================
echo ""
echo "[C] CA-3: clasificacion completa"

C_SUCCESS="$TMP/c-success.jsonl"; translate_fixture success-1.18.29.jsonl "" 0 > "$C_SUCCESS"
if jq -e 'select(.type=="run.completed") | .status == "success" and .error == null' "$C_SUCCESS" >/dev/null 2>&1; then
    pass "C-1: exit 0 + al menos un message -> run.completed{status:success}"
else
    fail "C-1: el fixture de exito no produjo el terminal esperado: $(jq -c 'select(.type=="run.completed" or .type=="run.failed")' "$C_SUCCESS")"
fi

C_NONZERO="$TMP/c-nonzero.jsonl"; translate_fixture success-1.18.29.jsonl "" 1 > "$C_NONZERO"
if jq -e 'select(.type=="run.failed") | .status == "failed" and .error.kind == "nonzero_exit"' "$C_NONZERO" >/dev/null 2>&1; then
    pass "C-2: exit != 0 (incluso con texto visible en el stream) -> run.failed{error.kind:nonzero_exit} (gana sobre el contenido)"
else
    fail "C-2: no se clasifico el exit 1 como nonzero_exit: $(jq -c 'select(.type=="run.failed")' "$C_NONZERO")"
fi

STDERR_FILE="$TMP/stderr.log"; printf 'ruido previo\nOpenAI: rate limit exceeded\n' > "$STDERR_FILE"
C_STDERR="$TMP/c-stderr.jsonl"; translate_fixture success-1.18.29.jsonl "" 1 "$STDERR_FILE" > "$C_STDERR"
if jq -e 'select(.type=="run.failed") | .error.kind == "nonzero_exit" and (.error.detail | contains("rate limit exceeded"))' "$C_STDERR" >/dev/null 2>&1; then
    pass "C-3: exit != 0 con stderr -> el detalle incluye las ultimas lineas de stderr (sin '429': nonzero_exit, no rate_limit)"
else
    fail "C-3: no se clasifico como se esperaba: $(jq -c 'select(.type=="run.failed")' "$C_STDERR")"
fi

# issue #965: patron conservador -- hace falta "429" JUNTO con "rate limit"
# (evidencia real: anomalyco/opencode#42029, `Error: 429: {"type":
# "FreeUsageLimitError","message":"...Rate limit exceeded..."}`).
STDERR_RL="$TMP/stderr-ratelimit.log"
printf 'Error: 429: {"type":"FreeUsageLimitError","message":"Error from provider (Console): Rate limit exceeded. Please try again later."}\n' > "$STDERR_RL"
C_RATELIMIT="$TMP/c-ratelimit.jsonl"; translate_fixture success-1.18.29.jsonl "" 1 "$STDERR_RL" > "$C_RATELIMIT"
if jq -e 'select(.type=="run.failed") | .error.kind == "rate_limit" and .resets_at == null' "$C_RATELIMIT" >/dev/null 2>&1; then
    pass "C-3b: '429' + 'Rate limit exceeded' en stderr -> run.failed{error.kind:rate_limit, resets_at:null} (issue #965)"
else
    fail "C-3b: no se clasifico la ventana agotada como se esperaba: $(jq -c 'select(.type=="run.failed")' "$C_RATELIMIT")"
fi

C_EMPTY="$TMP/c-empty.jsonl"; translate_fixture empty-1.18.29.jsonl "" 0 > "$C_EMPTY"
if jq -e 'select(.type=="run.failed") | .error.kind == "no_result"' "$C_EMPTY" >/dev/null 2>&1; then
    pass "C-4: stream vacio -> run.failed{error.kind:no_result}"
else
    fail "C-4: no se clasifico el stream vacio como no_result: $(jq -c 'select(.type=="run.failed")' "$C_EMPTY")"
fi

C_MALFORMED="$TMP/c-malformed.jsonl"; translate_fixture malformed-1.18.29.jsonl "" 0 > "$C_MALFORMED"
if jq -e 'select(.type=="run.failed") | .error.kind == "protocol_invalid"' "$C_MALFORMED" >/dev/null 2>&1; then
    pass "C-5: linea no-JSON -> run.failed{error.kind:protocol_invalid}"
else
    fail "C-5: no se clasifico la linea malformada como protocol_invalid: $(jq -c 'select(.type=="run.failed")' "$C_MALFORMED")"
fi

C_NOTEXT="$TMP/c-notext.jsonl"; translate_fixture no-visible-text-1.18.29.jsonl "" 0 > "$C_NOTEXT"
if jq -e 'select(.type=="run.failed") | .error.kind == "no_result"' "$C_NOTEXT" >/dev/null 2>&1; then
    pass "C-6: exit 0 sin ningun texto visible del asistente -> run.failed{error.kind:no_result}"
else
    fail "C-6: no se clasifico la ausencia de texto como no_result: $(jq -c 'select(.type=="run.failed")' "$C_NOTEXT")"
fi

for f in "$C_SUCCESS" "$C_NONZERO" "$C_STDERR" "$C_EMPTY" "$C_MALFORMED" "$C_NOTEXT"; do
    T=$(count_terminals "$f")
    if [ "$T" = "1" ]; then
        pass "C-7 ($(basename "$f")): exactamente 1 evento terminal"
    else
        fail "C-7 ($(basename "$f")): se contaron $T eventos terminales (se esperaba 1)"
    fi
done

# ============================================================================
echo ""
echo "[D] CA-4: el terminal SUMA los step_finish de session_id/tokens; turns/denials/ttft_ms/api_duration_ms siempre null; model degrada al parametro; nunca emite cost_usd"

D_OUT="$TMP/d-full.jsonl"; translate_fixture success-tool-1.18.29.jsonl "" 0 > "$D_OUT"
TERM="$(jq -c 'select(.type=="run.completed")' "$D_OUT")"
assert_field() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$actual" = "$expected" ]; then
        pass "$desc"
    else
        fail "$desc (esperado '$expected', obtenido '$actual')"
    fi
}
assert_field "D-1: session_id (del ultimo step_finish/evento con sessionID)" "ses_f8b28e18effew6dRCNC6Tm8NHq" "$(echo "$TERM" | jq -r '.session_id')"
assert_field "D-2: tokens.input = SUMA de los dos step_finish (6127+6167), no el ultimo" "12294" "$(echo "$TERM" | jq -r '.tokens.input')"
assert_field "D-3: tokens.output = SUMA de los dos step_finish (17+10), no el ultimo" "27" "$(echo "$TERM" | jq -r '.tokens.output')"
assert_field "D-4: tokens.cache_read/cache_write/reasoning = 0 en el fixture real (siempre presentes, nunca 0 fabricado)" "0 0 0" "$(echo "$TERM" | jq -r '[.tokens.cache_read, .tokens.cache_write, .tokens.reasoning] | join(" ")')"
assert_field "D-4a: sin MEFISTO_STATE_DIR/catalogo, estimated_cost_usd es null (nunca el .part.cost crudo)" "null" "$(echo "$TERM" | jq -r '.estimated_cost_usd')"
assert_field "D-4b: el terminal OpenCode nuevo nunca emite cost_usd (issue #1324, CA-6)" "false" "$(echo "$TERM" | jq 'has("cost_usd")')"

# Cada `step_finish` reporta lo de SU paso, no un acumulado: quedarse con el
# ultimo reportaria el costo del cierre de la corrida como el de la corrida
# entera. tokens.cache_read/cache_write/reasoning suman igual que input/output.
D_COST_FIXTURE="$TMP/multi-cost.jsonl"
cat > "$D_COST_FIXTURE" <<'EOF'
{"type":"step_finish","timestamp":1000,"sessionID":"ses_c","part":{"type":"step-finish","reason":"tool-calls","tokens":{"input":100,"output":10,"reasoning":2,"cache":{"read":5,"write":1}},"cost":0.25}}
{"type":"text","timestamp":1001,"sessionID":"ses_c","part":{"type":"text","text":"listo"}}
{"type":"step_finish","timestamp":1002,"sessionID":"ses_c","part":{"type":"step-finish","reason":"stop","tokens":{"input":200,"output":20,"reasoning":3,"cache":{"read":7,"write":2}},"cost":0.5}}
EOF
D_COST_OUT="$TMP/d-multi-cost.jsonl"
runtime_opencode_translate "$D_COST_FIXTURE" "opencode" "" 0 > "$D_COST_OUT"
TERM_COST="$(jq -c 'select(.type=="run.completed")' "$D_COST_OUT")"
assert_field "D-4c: tokens.input suma pasos (100+200)" "300" "$(echo "$TERM_COST" | jq -r '.tokens.input')"
assert_field "D-4d: tokens.output suma pasos (10+20)" "30" "$(echo "$TERM_COST" | jq -r '.tokens.output')"
assert_field "D-4e: tokens.reasoning suma pasos (2+3)" "5" "$(echo "$TERM_COST" | jq -r '.tokens.reasoning')"
assert_field "D-4f: tokens.cache_read suma pasos (5+7)" "12" "$(echo "$TERM_COST" | jq -r '.tokens.cache_read')"
assert_field "D-4g: tokens.cache_write suma pasos (1+2)" "3" "$(echo "$TERM_COST" | jq -r '.tokens.cache_write')"
assert_field "D-4h: sin catalogo, estimated_cost_usd sigue null aunque .part.cost trajera 0.25/0.5" "null" "$(echo "$TERM_COST" | jq -r '.estimated_cost_usd')"
assert_field "D-5: turns siempre null (sin equivalente en el wire format)" "null" "$(echo "$TERM" | jq -r '.turns')"
assert_field "D-6: denials siempre null (sin equivalente en el wire format)" "null" "$(echo "$TERM" | jq -r '.denials')"
assert_field "D-7: ttft_ms siempre null (sin equivalente en el wire format)" "null" "$(echo "$TERM" | jq -r '.ttft_ms')"
assert_field "D-8: api_duration_ms siempre null (sin equivalente en el wire format)" "null" "$(echo "$TERM" | jq -r '.api_duration_ms')"
assert_field "D-9: model sin parametro -> null (el wire format nunca lo trae)" "null" "$(echo "$TERM" | jq -r '.model')"

D_MODEL_OUT="$TMP/d-model.jsonl"; translate_fixture success-tool-1.18.29.jsonl "openai/gpt-5" 0 > "$D_MODEL_OUT"
assert_field "D-10: model degrada siempre al parametro pedido (opaco, reenviado literal)" "openai/gpt-5" "$(jq -r 'select(.type=="run.completed") | .model' "$D_MODEL_OUT")"

D_EMPTY_OUT="$TMP/d-empty.jsonl"; translate_fixture empty-1.18.29.jsonl "" 0 > "$D_EMPTY_OUT"
TERM_EMPTY="$(jq -c 'select(.type=="run.failed")' "$D_EMPTY_OUT")"
assert_field "D-11: session_id ausente (stream vacio) -> null" "null" "$(echo "$TERM_EMPTY" | jq -r '.session_id')"
assert_field "D-12: tokens.input ausente -> null (nunca 0)" "null" "$(echo "$TERM_EMPTY" | jq -r '.tokens.input')"
assert_field "D-13: estimated_cost_usd ausente -> null (nunca 0)" "null" "$(echo "$TERM_EMPTY" | jq -r '.estimated_cost_usd')"

# ============================================================================
echo ""
echo "[E] CA-5: ninguna ruta/variable de credenciales aparece en el adaptador ni se filtra al argv/JSONL"

for pattern in "auth\.json" "OPENAI_API_KEY" "ANTHROPIC_API_KEY"; do
    if grep -Eqi "$pattern" "$OPENCODE_LIB" "$OPENCODE_JQ"; then
        fail "E-1 ($pattern): aparece en runtime-opencode.sh/.jq"
    else
        pass "E-1 ($pattern): no aparece en runtime-opencode.sh/.jq"
    fi
done

SECRET_OPENAI="sk-fake-secret-value-xyz-789"
SECRET_ANTHROPIC="sk-ant-fake-secret-value-abc-123"
(
    export OPENAI_API_KEY="$SECRET_OPENAI"
    export ANTHROPIC_API_KEY="$SECRET_ANTHROPIC"
    export MEFISTO_RUNTIME_WORK_DIR="$TMP/work-e"
    mkdir -p "$MEFISTO_RUNTIME_WORK_DIR"
    MEFISTO_RUNTIME_CMD=()
    runtime_opencode_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "" "$SYSTEM_FILE"
    printf '%s\0' "${MEFISTO_RUNTIME_CMD[@]}" > "$TMP/e-argv.bin"
)
if ! grep -qa "$SECRET_OPENAI" "$TMP/e-argv.bin" && ! grep -qa "$SECRET_ANTHROPIC" "$TMP/e-argv.bin"; then
    pass "E-2: build_cmd no incorpora OPENAI_API_KEY/ANTHROPIC_API_KEY del entorno en el argv que compone"
else
    fail "E-2: el argv compuesto por build_cmd contiene un secreto del entorno"
fi

E_EV="$TMP/e-events.jsonl"
(
    export OPENAI_API_KEY="$SECRET_OPENAI"
    export ANTHROPIC_API_KEY="$SECRET_ANTHROPIC"
    export PATH="$TMP/e-bin:$PATH"
    mkdir -p "$TMP/e-bin"
    cat > "$TMP/e-bin/opencode" <<STUBEOF
#!/usr/bin/env bash
cat "$FIXTURES_DIR/success-1.18.29.jsonl"
exit 0
STUBEOF
    chmod +x "$TMP/e-bin/opencode"
    unset MEFISTO_RUNTIME
    "$RUNNER" --runtime opencode --agent test-agent --cwd "$TMP" \
        --prompt-file "$PROMPT_PLAIN" --event-log "$E_EV" >/dev/null 2>&1
)
if [ -f "$E_EV" ] && ! grep -qa "$SECRET_OPENAI" "$E_EV" && ! grep -qa "$SECRET_ANTHROPIC" "$E_EV"; then
    pass "E-3: el JSONL producido por una corrida real (secretos en el entorno) nunca los reproduce"
else
    fail "E-3: el JSONL contiene un secreto del entorno: $(cat "$E_EV" 2>/dev/null)"
fi

# ============================================================================
echo ""
echo "[F] CA-6: runner real (mefisto-run-agent.sh --runtime opencode) contra la CLI falsa"

WORKDIR="$TMP/wt-f"; mkdir -p "$WORKDIR"
PROMPT_FILE="$TMP/prompt-f.txt"; echo "prompt" > "$PROMPT_FILE"
STUB_BIN="$TMP/bin-stub"; mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/opencode" <<'STUBEOF'
#!/usr/bin/env bash
# NUL-separado (no newline-separado, issue #1448): el argv ya no lleva el
# mensaje (viaja por stdin), pero se conserva NUL-separado por si algun valor
# opaco (modelo, id de sesion) trajera un caracter fuera de lo comun.
if [ -n "${MEFISTO_OPENCODE_STUB_ARGS_FILE:-}" ]; then
    : > "$MEFISTO_OPENCODE_STUB_ARGS_FILE"
    for a in "$@"; do
        printf '%s\0' "$a" >> "$MEFISTO_OPENCODE_STUB_ARGS_FILE"
    done
fi
if [ -n "${MEFISTO_OPENCODE_STUB_SLEEP:-}" ]; then
    sleep "$MEFISTO_OPENCODE_STUB_SLEEP"
fi
# CA-4 (issue #1448): mismo patron que MEFISTO_CLAUDE_STUB_STDIN_FILE de
# test-runtime-claude.sh. [ -t 0 ] ANTES de leer nada de stdin.
if [ -n "${MEFISTO_OPENCODE_STUB_STDIN_FILE:-}" ]; then
    STDIN_IS_TTY=0
    [ -t 0 ] && STDIN_IS_TTY=1
    printf '%s\n' "$STDIN_IS_TTY" > "${MEFISTO_OPENCODE_STUB_STDIN_FILE}.tty"
    cat > "$MEFISTO_OPENCODE_STUB_STDIN_FILE"
else
    cat > /dev/null
fi
if [ -n "${MEFISTO_OPENCODE_STUB_FIXTURE:-}" ] && [ -f "$MEFISTO_OPENCODE_STUB_FIXTURE" ]; then
    cat "$MEFISTO_OPENCODE_STUB_FIXTURE"
fi
if [ -n "${MEFISTO_OPENCODE_STUB_STDERR:-}" ]; then
    printf '%s\n' "$MEFISTO_OPENCODE_STUB_STDERR" >&2
fi
exit "${MEFISTO_OPENCODE_STUB_EXIT:-0}"
STUBEOF
chmod +x "$STUB_BIN/opencode"

# read_nul_args <file> -- rellena el array global NUL_ARGS con los campos
# NUL-separados de <file>. A diferencia de un split por linea, preserva
# intactos los saltos de linea EMBEBIDOS del mensaje final (system-file +
# "\n\n" + prompt, CA-1).
read_nul_args() {
    NUL_ARGS=()
    local field
    while IFS= read -r -d '' field; do
        NUL_ARGS+=("$field")
    done < "$1"
}

nul_args_contains() {
    local needle="$1" e
    for e in "${NUL_ARGS[@]}"; do
        [ "$e" = "$needle" ] && return 0
    done
    return 1
}

# nul_args_pair_value <flag> -- imprime por stdout el elemento de NUL_ARGS
# inmediatamente posterior a <flag>; vacio (exit 1) si <flag> no aparece.
nul_args_pair_value() {
    local flag="$1" i
    for ((i=0; i<${#NUL_ARGS[@]}-1; i++)); do
        if [ "${NUL_ARGS[$i]}" = "$flag" ]; then
            printf '%s' "${NUL_ARGS[$((i+1))]}"
            return 0
        fi
    done
    return 1
}

ORIG_PATH="$PATH"
export PATH="$STUB_BIN:$PATH"
unset MEFISTO_RUNTIME

run_opencode_scenario() {
    # run_opencode_scenario <event_log> [args del runner...]
    local ev="$1"; shift
    "$RUNNER" --runtime opencode --agent test-agent --cwd "$WORKDIR" \
        --prompt-file "$PROMPT_FILE" --event-log "$ev" "$@" >/dev/null 2>&1
    echo $?
}

check_scenario() {
    local desc="$1" ev="$2" expected_exit="$3" expected_status="$4" expected_error_kind="$5" rc="$6"

    if [ "$rc" = "$expected_exit" ]; then
        pass "$desc: exit $rc"
    else
        fail "$desc: exit $rc (esperaba $expected_exit)"
    fi

    if [ ! -s "$ev" ]; then
        fail "$desc: --event-log vacio o inexistente"
        return
    fi

    check_all_lines_valid "$desc" "$ev"

    local terms
    terms=$(count_terminals "$ev")
    if [ "$terms" = "1" ]; then
        pass "$desc: exactamente 1 evento terminal en --event-log"
    else
        fail "$desc: se contaron $terms eventos terminales (se esperaba 1)"
    fi

    local last_status last_kind
    last_status="$(jq -r 'select(.type=="run.completed" or .type=="run.failed") | .status' "$ev" 2>/dev/null | tail -n1)"
    if [ "$last_status" = "$expected_status" ]; then
        pass "$desc: status='$last_status'"
    else
        fail "$desc: status='$last_status' (esperaba '$expected_status')"
    fi

    if [ -n "$expected_error_kind" ]; then
        last_kind="$(jq -r 'select(.type=="run.completed" or .type=="run.failed") | .error.kind // empty' "$ev" 2>/dev/null | tail -n1)"
        if [ "$last_kind" = "$expected_error_kind" ]; then
            pass "$desc: error.kind='$last_kind'"
        else
            fail "$desc: error.kind='$last_kind' (esperaba '$expected_error_kind')"
        fi
    fi
}

F_EV="$TMP/f-success.jsonl"
RC=$(MEFISTO_OPENCODE_STUB_FIXTURE="$FIXTURES_DIR/success-1.18.29.jsonl" MEFISTO_OPENCODE_STUB_EXIT=0 run_opencode_scenario "$F_EV")
check_scenario "exito" "$F_EV" 0 "success" "" "$RC"

F_EV="$TMP/f-fail1.jsonl"
RC=$(MEFISTO_OPENCODE_STUB_FIXTURE="$FIXTURES_DIR/success-1.18.29.jsonl" MEFISTO_OPENCODE_STUB_EXIT=1 run_opencode_scenario "$F_EV")
check_scenario "fallo con exit 1" "$F_EV" 1 "failed" "nonzero_exit" "$RC"

F_EV="$TMP/f-timeout.jsonl"
RC=$(MEFISTO_OPENCODE_STUB_FIXTURE="$FIXTURES_DIR/success-1.18.29.jsonl" MEFISTO_OPENCODE_STUB_SLEEP=3600 run_opencode_scenario "$F_EV" --timeout 1)
check_scenario "timeout (stub que duerme)" "$F_EV" 124 "timeout" "timeout" "$RC"

F_EV="$TMP/f-empty.jsonl"
RC=$(MEFISTO_OPENCODE_STUB_EXIT=0 run_opencode_scenario "$F_EV")
check_scenario "stream vacio" "$F_EV" 1 "failed" "no_result" "$RC"

F_EV="$TMP/f-malformed.jsonl"
RC=$(MEFISTO_OPENCODE_STUB_FIXTURE="$FIXTURES_DIR/malformed-1.18.29.jsonl" MEFISTO_OPENCODE_STUB_EXIT=0 run_opencode_scenario "$F_EV")
check_scenario "JSON malformado" "$F_EV" 1 "failed" "protocol_invalid" "$RC"

F_EV="$TMP/f-notext.jsonl"
RC=$(MEFISTO_OPENCODE_STUB_FIXTURE="$FIXTURES_DIR/no-visible-text-1.18.29.jsonl" MEFISTO_OPENCODE_STUB_EXIT=0 run_opencode_scenario "$F_EV")
check_scenario "exit 0 sin texto visible" "$F_EV" 1 "failed" "no_result" "$RC"

F_EV="$TMP/f-model-heredado.jsonl"
F_ARGS="$TMP/f-model-heredado.args"
RC=$(MEFISTO_OPENCODE_STUB_FIXTURE="$FIXTURES_DIR/success-1.18.29.jsonl" MEFISTO_OPENCODE_STUB_EXIT=0 MEFISTO_OPENCODE_STUB_ARGS_FILE="$F_ARGS" run_opencode_scenario "$F_EV")
check_scenario "modelo heredado (sin -m)" "$F_EV" 0 "success" "" "$RC"
read_nul_args "$F_ARGS"
if ! nul_args_contains "-m"; then
    pass "modelo heredado: -m NO aparece en la linea de comando capturada"
else
    fail "modelo heredado: -m aparecio en la linea de comando capturada"
fi

F_EV="$TMP/f-model-opaco.jsonl"
F_ARGS="$TMP/f-model-opaco.args"
RC=$(MEFISTO_OPENCODE_STUB_FIXTURE="$FIXTURES_DIR/success-1.18.29.jsonl" MEFISTO_OPENCODE_STUB_EXIT=0 MEFISTO_OPENCODE_STUB_ARGS_FILE="$F_ARGS" run_opencode_scenario "$F_EV" --model "openai/gpt-4.1 mini")
check_scenario "modelo opaco con / y espacios" "$F_EV" 0 "success" "" "$RC"
read_nul_args "$F_ARGS"
if [ "$(nul_args_pair_value "-m")" = "openai/gpt-4.1 mini" ]; then
    pass "modelo opaco: 'openai/gpt-4.1 mini' reenviado literal en la linea de comando capturada"
else
    fail "modelo opaco: no se encontro el modelo opaco intacto: '$(nul_args_pair_value "-m")'"
fi

F_EV="$TMP/f-system-prefix.jsonl"
F_STDIN="$TMP/f-system-prefix.stdin"
SYSTEM_FILE_F="$TMP/system-f.txt"; printf 'You are running in non-interactive print mode.' > "$SYSTEM_FILE_F"
RC=$(MEFISTO_OPENCODE_STUB_FIXTURE="$FIXTURES_DIR/success-1.18.29.jsonl" MEFISTO_OPENCODE_STUB_EXIT=0 MEFISTO_OPENCODE_STUB_STDIN_FILE="$F_STDIN" run_opencode_scenario "$F_EV" --system-file "$SYSTEM_FILE_F")
check_scenario "prefijo de --system-file al inicio del mensaje (via stdin, issue #1448)" "$F_EV" 0 "success" "" "$RC"
# Comparacion por archivo (cmp), no por cadena: una comparacion de cadenas
# via `$(head -c ...)` pierde los saltos de linea finales de la sustitucion
# de comandos, y el prefijo esperado TERMINA justo en "\n\n".
EXPECTED_PREFIX="You are running in non-interactive print mode."$'\n\n'
EXPECTED_PREFIX_FILE="$TMP/f-system-prefix.expected"
printf '%s' "$EXPECTED_PREFIX" > "$EXPECTED_PREFIX_FILE"
ACTUAL_PREFIX_FILE="$TMP/f-system-prefix.actual"
if [ -f "$F_STDIN" ]; then
    head -c "${#EXPECTED_PREFIX}" "$F_STDIN" > "$ACTUAL_PREFIX_FILE"
fi
if [ -f "$ACTUAL_PREFIX_FILE" ] && cmp -s "$EXPECTED_PREFIX_FILE" "$ACTUAL_PREFIX_FILE"; then
    pass "system-file: el mensaje recibido por stdin empieza con el contenido de --system-file"
else
    fail "system-file: el mensaje por stdin no empieza con el system-file: '$(cat "$F_STDIN" 2>/dev/null)'"
fi

F_EV="$TMP/f-redacted.jsonl"
F_EVENTS="$TMP/f-redacted-events.log"
RC=$(MEFISTO_OPENCODE_STUB_FIXTURE="$FIXTURES_DIR/sensitive-redaction-derived.jsonl" MEFISTO_OPENCODE_STUB_STDERR="STDERR_SENTINEL AUTH_TOKEN_SENTINEL" MEFISTO_OPENCODE_STUB_EXIT=0 run_opencode_scenario "$F_EV" --events-log "$F_EVENTS" --redact-observability --model "openai/gpt-5")
check_scenario "persistencia redactada OpenCode" "$F_EV" 0 "success" "" "$RC"
if [ -s "$F_EVENTS" ] \
    && ! grep -Eq 'PROMPT_SENTINEL|ASSISTANT_SENTINEL|COMMAND_SENTINEL|STDERR_SENTINEL|HEADER_SENTINEL|AUTH_TOKEN_SENTINEL' "$F_EV" "$F_EVENTS" \
    && ! jq -e 'select(.type == "message")' "$F_EV" >/dev/null 2>&1 \
    && jq -e 'select(.type == "tool.started") | .tool == "bash" and .input_summary == null' "$F_EV" >/dev/null 2>&1 \
    && jq -e 'select(.type == "run.completed") | .runtime == "opencode" and .model == "openai/gpt-5" and .session_id == "sess-redaction-opencode" and .tokens.input == 13 and .tokens.output == 5 and .estimated_cost_usd == null and (has("cost_usd") | not)' "$F_EV" >/dev/null 2>&1; then
    pass "redaccion OpenCode elimina centinelas y conserva identidad/metricas/tools"
else
    fail "redaccion OpenCode filtro contenido sensible o perdio evidencia operacional"
fi

# ============================================================================
echo ""
echo "[I] CA-3/CA-4: paridad ante ARG_MAX (issue #1448) -- el mensaje viaja por stdin, nunca por argv"

I_ARG_MAX="$(getconf ARG_MAX 2>/dev/null)"
case "$I_ARG_MAX" in
    ''|*[!0-9]*)
        fail "I-0: getconf ARG_MAX no devolvio un entero ('$I_ARG_MAX')"
        I_ARG_MAX=0
        ;;
    *)
        pass "I-0: getconf ARG_MAX = $I_ARG_MAX"
        ;;
esac

I_SENTINEL="$(printf '%-64s' 'MEFISTO_1448_OPENCODE_SENTINEL')"
I_TARGET_SIZE=$((I_ARG_MAX + 65536))
I_BODY_SIZE=$((I_TARGET_SIZE - ${#I_SENTINEL}))
I_BLOCK="$TMP/i-block.txt"
printf 'linea con tab\tdolar $HOME y barra \\ y unicode: ñáéíóú 日本語\n' > "$I_BLOCK"
I_FIXTURE="$TMP/i-fixture-argmax.bin"
yes "$(cat "$I_BLOCK")" 2>/dev/null | head -c "$I_BODY_SIZE" > "$I_FIXTURE"
printf '%s' "$I_SENTINEL" >> "$I_FIXTURE"

I_FIXTURE_SIZE="$(wc -c < "$I_FIXTURE" | tr -d ' ')"
if [ "$I_FIXTURE_SIZE" -ge "$I_TARGET_SIZE" ]; then
    pass "I-1: fixture ARG_MAX = $I_FIXTURE_SIZE bytes (>= $I_TARGET_SIZE)"
else
    fail "I-1: fixture ARG_MAX = $I_FIXTURE_SIZE bytes (se esperaba >= $I_TARGET_SIZE)"
fi

I_EV="$TMP/i-event-log.jsonl"
I_DUMP="$TMP/i-stdin-dump.bin"
I_ARGS="$TMP/i-args.bin"
RC=$(MEFISTO_OPENCODE_STUB_FIXTURE="$FIXTURES_DIR/success-1.18.29.jsonl" MEFISTO_OPENCODE_STUB_EXIT=0 \
    MEFISTO_OPENCODE_STUB_ARGS_FILE="$I_ARGS" MEFISTO_OPENCODE_STUB_STDIN_FILE="$I_DUMP" \
    "$RUNNER" --runtime opencode --agent test-agent --cwd "$WORKDIR" \
        --prompt-file "$I_FIXTURE" --event-log "$I_EV" --timeout 60 >/dev/null 2>&1; echo $?)

if [ "$RC" = "0" ]; then
    pass "I-2: el runner termina con exit 0 pese a un prompt >= ARG_MAX"
else
    fail "I-2: exit $RC (se esperaba 0)"
fi

I_TERMS=$(count_terminals "$I_EV")
if [ "$I_TERMS" = "1" ]; then
    pass "I-3: exactamente 1 evento terminal en --event-log"
else
    fail "I-3: se contaron $I_TERMS eventos terminales (se esperaba 1)"
fi

if [ -f "$I_DUMP" ] && cmp -s "$I_FIXTURE" "$I_DUMP"; then
    pass "I-4: el volcado de stdin del stub es identico byte a byte al fixture (cmp)"
else
    fail "I-4: el volcado de stdin difiere del fixture original"
fi

if [ -f "$I_ARGS" ] && ! grep -qaF "$I_SENTINEL" "$I_ARGS"; then
    pass "I-5: el centinela del prompt NO aparece en el volcado de argv (nunca viajo por argv)"
else
    fail "I-5: el centinela aparecio en el volcado de argv"
fi

if [ -f "${I_DUMP}.tty" ] && [ "$(cat "${I_DUMP}.tty")" = "0" ]; then
    pass "I-6: stdin del stub NO era TTY (el aislamiento de #943 se conserva con el canal de #1447/#1448)"
else
    fail "I-6: no se registro TTY=0 junto al volcado de stdin: $(cat "${I_DUMP}.tty" 2>/dev/null)"
fi

export PATH="$ORIG_PATH"

# ============================================================================
echo ""
echo "[G] CA #1322: cache diaria de catalogo de tarifas, sin red real"

PRICING_BIN="$TMP/pricing-bin"; mkdir -p "$PRICING_BIN"
PRICING_STATE="$TMP/pricing-state"
PRICING_CALLS="$TMP/pricing-calls"
PRICING_PAYLOAD="$TMP/pricing-payload.json"
cat > "$PRICING_PAYLOAD" <<'EOF'
{"openai":{"id":"openai","models":{"gpt-test":{"id":"gpt-test","cost":{"input":1,"output":2,"cache_read":0.1,"cache_write":0.2,"tiers":[{"tier":{"type":"context","size":100000},"input":3,"output":4,"cache_read":0.3,"cache_write":0.4}]},"limit":{"context":200000}},"sin-cache":{"id":"sin-cache","cost":{"input":1,"output":2},"limit":{"context":1000}}}}}
EOF
cat > "$PRICING_BIN/curl" <<'EOF'
#!/usr/bin/env bash
printf 'x\n' >> "$MEFISTO_TEST_CURL_CALLS"
printf '%s\n' "$*" >> "$MEFISTO_TEST_CURL_ARGS"
[ -z "${MEFISTO_TEST_CURL_DELAY:-}" ] || sleep "$MEFISTO_TEST_CURL_DELAY"
case "${MEFISTO_TEST_CURL_MODE:-ok}" in
    ok) cat "$MEFISTO_TEST_CURL_PAYLOAD" ;;
    invalid) printf '{truncado' ;;
    incomplete) printf '{"openai":{"models":{"sin-costos":{}}}}' ;;
    negative) printf '{"openai":{"models":{"negativo":{"cost":{"input":-1,"output":2,"cache_read":0.1,"cache_write":0.2}}}}}' ;;
    fail) exit 22 ;;
esac
EOF
cat > "$PRICING_BIN/date" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "-u" ] && [ "$2" = "+%Y-%m-%d" ]; then printf '%s\n' "$MEFISTO_TEST_UTC_DAY"; else command /bin/date "$@"; fi
EOF
chmod +x "$PRICING_BIN/curl" "$PRICING_BIN/date"
prepare_pricing() {
    PATH="$PRICING_BIN:$ORIG_PATH" MEFISTO_STATE_DIR="$PRICING_STATE" \
        MEFISTO_TEST_CURL_CALLS="$PRICING_CALLS" MEFISTO_TEST_CURL_PAYLOAD="$PRICING_PAYLOAD" \
        MEFISTO_TEST_CURL_ARGS="$TMP/pricing-curl-args" \
        MEFISTO_TEST_UTC_DAY="$1" MEFISTO_TEST_CURL_MODE="$2" runtime_opencode_prepare_pricing
}
G_PATH="$(prepare_pricing 2026-09-13 ok)"
if [ -f "$G_PATH" ] && [ "$(wc -l < "$PRICING_CALLS" | tr -d ' ')" = "1" ] \
    && jq -e '.models["openai/gpt-test"] == {input:1, output:2, cache_read:0.1, cache_write:0.2, context:200000, tiers:[{context:100000, input:3, output:4, cache_read:0.3, cache_write:0.4}]}
        and (.models | has("openai/sin-cache") | not)' "$G_PATH" >/dev/null 2>&1 \
    && grep -q -- '--connect-timeout 5 --max-time 15 https://models.opencode.ai/api.json' "$TMP/pricing-curl-args" \
    && ! grep -Eq -- '(^| )(-H|--header)( |$)' "$TMP/pricing-curl-args"; then
    pass "G-1: primer fetch normaliza IDs, costos y tiers en la cache propia"
else fail "G-1: primer fetch no dejo la cache normalizada esperada"; fi
prepare_pricing 2026-09-13 ok >/dev/null
if [ "$(wc -l < "$PRICING_CALLS" | tr -d ' ')" = "1" ]; then pass "G-2: mismo dia UTC no consulta red"; else fail "G-2: repitio curl el mismo dia"; fi
prepare_pricing 2026-09-14 ok >/dev/null
if [ "$(wc -l < "$PRICING_CALLS" | tr -d ' ')" = "2" ]; then pass "G-3: cambio de dia UTC refresca una vez"; else fail "G-3: no refresco al cambiar de dia"; fi
G_BEFORE="$(cat "$G_PATH")"; prepare_pricing 2026-09-15 invalid >/dev/null
if [ "$(cat "$G_PATH")" = "$G_BEFORE" ]; then pass "G-4: payload invalido no reemplaza cache valida"; else fail "G-4: payload invalido reemplazo cache"; fi
prepare_pricing 2026-09-16 incomplete >/dev/null
if [ "$(cat "$G_PATH")" = "$G_BEFORE" ]; then pass "G-4b: forma incompleta no reemplaza cache valida"; else fail "G-4b: forma incompleta reemplazo cache"; fi
prepare_pricing 2026-09-17 negative >/dev/null
if [ "$(cat "$G_PATH")" = "$G_BEFORE" ]; then pass "G-4c: precio negativo no reemplaza cache valida"; else fail "G-4c: precio negativo reemplazo cache"; fi
G_STALE="$(prepare_pricing 2026-09-18 fail 2>"$TMP/g-stale.err")"
G_CALLS_AFTER_STALE="$(wc -l < "$PRICING_CALLS" | tr -d ' ')"
prepare_pricing 2026-09-18 fail >/dev/null
if [ "$G_STALE" = "$G_PATH" ] && grep -q 'desactualizada' "$TMP/g-stale.err" \
    && [ "$(wc -l < "$PRICING_CALLS" | tr -d ' ')" = "$G_CALLS_AFTER_STALE" ]; then pass "G-5: fallo de red usa cache stale, avisa y queda marcado por dia"; else fail "G-5: fallo con cache stale no degrado correctamente"; fi
G_EMPTY_STATE="$TMP/pricing-empty"
G_EMPTY="$(PATH="$PRICING_BIN:$ORIG_PATH" MEFISTO_STATE_DIR="$G_EMPTY_STATE" MEFISTO_TEST_CURL_CALLS="$PRICING_CALLS" MEFISTO_TEST_CURL_ARGS="$TMP/pricing-curl-args" MEFISTO_TEST_CURL_PAYLOAD="$PRICING_PAYLOAD" MEFISTO_TEST_UTC_DAY=2026-09-18 MEFISTO_TEST_CURL_MODE=fail runtime_opencode_prepare_pricing 2>"$TMP/g-empty.err")"
if [ -z "$G_EMPTY" ] && grep -q 'no esta disponible' "$TMP/g-empty.err"; then pass "G-6: fallo sin cache retorna 0, ruta vacia y aviso"; else fail "G-6: fallo sin cache no degrado correctamente"; fi
rm -rf "$PRICING_STATE"; : > "$PRICING_CALLS"
(MEFISTO_TEST_CURL_DELAY=0.2 prepare_pricing 2026-09-19 ok >/dev/null) & G_PID_1=$!
(MEFISTO_TEST_CURL_DELAY=0.2 prepare_pricing 2026-09-19 ok >/dev/null) & G_PID_2=$!
wait "$G_PID_1"; wait "$G_PID_2"
if [ "$(wc -l < "$PRICING_CALLS" | tr -d ' ')" = "1" ] && runtime_opencode_pricing_cache_is_valid "$PRICING_STATE/cache/model-pricing/catalog.json"; then pass "G-7: concurrencia usa lock y deja una cache valida"; else fail "G-7: concurrencia consulto mas de una vez o corrompio cache"; fi
G_NO_STATE="$TMP/pricing-no-state"; mkdir -p "$G_NO_STATE"
if (cd "$G_NO_STATE" && env -u MEFISTO_STATE_DIR bash -c 'source "$1"; runtime_opencode_prepare_pricing' _ "$OPENCODE_LIB" >/dev/null 2>&1) \
    && [ -z "$(ls -A "$G_NO_STATE")" ]; then pass "G-8: sin state dir degrada sin escribir fuera del cwd"; else fail "G-8: sin state dir no degrado limpiamente"; fi

# ============================================================================
echo ""
echo "[H] issue #1324: estimated_cost_usd por paso (MEF-ADR-0054), catalogo preparado una unica vez"

# write_pricing_cache <state_dir> <validated_utc> <models_json> -- crea una
# cache YA validada (nunca pasa por curl) mas su marker de intento fechado
# HOY de verdad (fecha real del sistema, no un stub), para que
# runtime_opencode_prepare_pricing nunca contacte red durante esta seccion:
# ve el intento de hoy ya marcado y sirve directo el archivo que este helper
# dejo listo.
write_pricing_cache() {
    local state_dir="$1" validated_utc="$2" models_json="$3"
    local cache_dir="$state_dir/cache/model-pricing"
    mkdir -p "$cache_dir"
    jq -n --arg day "$validated_utc" --argjson models "$models_json" \
        '{schema: 1, source_url: "https://models.opencode.ai/api.json", validated_utc: $day, models: $models}' \
        > "$cache_dir/catalog.json"
    date -u +%Y-%m-%d > "$cache_dir/attempted-utc"
}

# Tarifas base y de tier REALES de gpt-5.6-luna/terra/sol, verificadas contra
# https://models.opencode.ai/api.json el 2026-09-13 (mismas fuentes citadas
# en MEF-ADR-0054 seccion 6) -- no son inventadas para el test.
H_MODELS='{
  "openai/gpt-5.6-luna": {"input":0.2,"output":1.2,"cache_read":0.02,"cache_write":0.25,"context":1050000,
    "tiers":[{"context":272000,"input":0.4,"output":1.8,"cache_read":0.04,"cache_write":0.5}]},
  "openai/gpt-5.6-terra": {"input":2,"output":12,"cache_read":0.2,"cache_write":2.5,"context":1050000,
    "tiers":[{"context":272000,"input":4,"output":18,"cache_read":0.4,"cache_write":5}]},
  "openai/gpt-5.6-sol": {"input":4,"output":20,"cache_read":0.4,"cache_write":5,"context":1050000,
    "tiers":[{"context":272000,"input":8,"output":30,"cache_read":0.8,"cache_write":10}]}
}'
H_STATE_MAIN="$TMP/h-state-main"
write_pricing_cache "$H_STATE_MAIN" "2026-09-13" "$H_MODELS"

h_step_fixture() {
    # h_step_fixture <archivo> <tokens_json...> -- un step_finish por tokens_json,
    # seguido de un `text` para que la corrida clasifique como exito.
    local out="$1"; shift
    : > "$out"
    local i=0 tok
    for tok in "$@"; do
        i=$((i+1))
        printf '{"type":"step_finish","timestamp":%s,"sessionID":"s","part":{"tokens":%s}}\n' "$i" "$tok" >> "$out"
    done
    printf '{"type":"text","timestamp":%s,"sessionID":"s","part":{"text":"ok"}}\n' "$((i+1))" >> "$out"
}

h_cost() {
    # h_cost <state_dir> <model> <archivo> -- corre runtime_opencode_translate
    # con MEFISTO_STATE_DIR=<state_dir> e imprime .estimated_cost_usd del terminal.
    local state_dir="$1" model="$2" fixture="$3"
    MEFISTO_STATE_DIR="$state_dir" runtime_opencode_translate "$fixture" "opencode" "$model" 0 2>/dev/null \
        | jq -r 'select(.type=="run.completed" or .type=="run.failed") | .estimated_cost_usd'
}

# H-1/H-2: reproducen los importes citados en MEF-ADR-0054 (evidencia de
# dimension de #1315) con tarifas base observadas -- writer Terra, reviewer
# Sol. Los contadores de tokens son una reconstruccion (el transcript crudo
# de #1315 no vive en este fixture set): se eligieron para que la formula
# produzca EXACTAMENTE los mismos totales citados en el ADR.
H1_FIXTURE="$TMP/h1-terra-writer.jsonl"
h_step_fixture "$H1_FIXTURE" '{"input":250000,"output":7721}'
assert_field "H-1: writer Terra reproduce el importe citado en MEF-ADR-0054 (USD 0.592652, tarifas base)" \
    "0.592652" "$(h_cost "$H_STATE_MAIN" "openai/gpt-5.6-terra" "$H1_FIXTURE")"

H2_FIXTURE="$TMP/h2-sol-reviewer.jsonl"
h_step_fixture "$H2_FIXTURE" '{"input":135585,"output":15000,"cache":{"read":8,"write":0}}'
assert_field "H-2: reviewer Sol reproduce el importe citado en MEF-ADR-0054 (USD 0.8423432, tarifas base + cache_read)" \
    "0.8423432" "$(h_cost "$H_STATE_MAIN" "openai/gpt-5.6-sol" "$H2_FIXTURE")"

# H-3: Luna (el tercer modelo del catalogo), caso simple sin cache/reasoning.
H3_FIXTURE="$TMP/h3-luna.jsonl"
h_step_fixture "$H3_FIXTURE" '{"input":1000,"output":100}'
assert_field "H-3: Luna con tarifas base (1000 input, 100 output)" \
    "0.00032" "$(h_cost "$H_STATE_MAIN" "openai/gpt-5.6-luna" "$H3_FIXTURE")"

# H-4: cache_read + cache_write + reasoning en un mismo paso (Terra): reasoning
# se cobra a tarifa de OUTPUT (nunca inventa una categoria de precio aparte).
H4_FIXTURE="$TMP/h4-cache-reasoning.jsonl"
h_step_fixture "$H4_FIXTURE" '{"input":1000,"output":200,"reasoning":50,"cache":{"read":300,"write":100}}'
assert_field "H-4: cache_read/cache_write/reasoning entran en la formula (reasoning a tarifa output)" \
    "0.00531" "$(h_cost "$H_STATE_MAIN" "openai/gpt-5.6-terra" "$H4_FIXTURE")"

# H-5/H-6: cruce de tier DENTRO DE UN SOLO PASO (Terra, umbral 272000). El
# contexto del paso es input+cache_read+cache_write; un contexto IGUAL al
# umbral todavia usa la tarifa base -- solo un contexto ESTRICTAMENTE MAYOR
# usa el tier.
H5_FIXTURE="$TMP/h5-tier-cross.jsonl"
h_step_fixture "$H5_FIXTURE" '{"input":300000,"output":1000}'
assert_field "H-5: un paso con contexto > 272000 usa las tarifas del tier (no las base)" \
    "1.218" "$(h_cost "$H_STATE_MAIN" "openai/gpt-5.6-terra" "$H5_FIXTURE")"

H6_FIXTURE="$TMP/h6-tier-boundary.jsonl"
h_step_fixture "$H6_FIXTURE" '{"input":272000,"output":0}'
assert_field "H-6: contexto EXACTAMENTE igual al umbral usa todavia la tarifa base" \
    "0.544" "$(h_cost "$H_STATE_MAIN" "openai/gpt-5.6-terra" "$H6_FIXTURE")"

H6B_FIXTURE="$TMP/h6b-tier-boundary-plus1.jsonl"
h_step_fixture "$H6B_FIXTURE" '{"input":272001,"output":0}'
assert_field "H-6b: un token mas alla del umbral ya usa la tarifa del tier" \
    "1.088004" "$(h_cost "$H_STATE_MAIN" "openai/gpt-5.6-terra" "$H6B_FIXTURE")"

# H-7: VARIOS pasos que INDIVIDUALMENTE no cruzan el tier (200000 < 272000
# cada uno) pero cuya SUMA si lo haria si se evaluara acumulada -- el tier se
# elige POR PASO, nunca para la corrida completa (MEF-ADR-0054 seccion 2). Si
# la implementacion sumara contexto antes de elegir tier, este caso daria
# 1.6 (tier) en vez de 0.8 (base x2).
H7_FIXTURE="$TMP/h7-multi-step-no-cross.jsonl"
h_step_fixture "$H7_FIXTURE" '{"input":200000,"output":0}' '{"input":200000,"output":0}'
assert_field "H-7: tier por paso, no acumulado (2 x 200000 < 272000 cada uno, nunca cruza)" \
    "0.8" "$(h_cost "$H_STATE_MAIN" "openai/gpt-5.6-terra" "$H7_FIXTURE")"

# H-8: modelo desconocido (ausente del catalogo) -> null, tokens se siguen sumando.
H8_FIXTURE="$TMP/h8-unknown-model.jsonl"
h_step_fixture "$H8_FIXTURE" '{"input":100,"output":10}'
assert_field "H-8: modelo ausente del catalogo -> estimated_cost_usd null" \
    "null" "$(h_cost "$H_STATE_MAIN" "openai/gpt-9-unknown" "$H8_FIXTURE")"
H8_TOKENS_INPUT="$(MEFISTO_STATE_DIR="$H_STATE_MAIN" runtime_opencode_translate "$H8_FIXTURE" "opencode" "openai/gpt-9-unknown" 0 2>/dev/null | jq -r 'select(.type=="run.completed") | .tokens.input')"
assert_field "H-8b: modelo desconocido no impide sumar tokens.input" "100" "$H8_TOKENS_INPUT"

# H-9: catalogo AUSENTE (MEFISTO_STATE_DIR sin cache alguna, intento de hoy ya
# marcado para no tocar red) -> null.
H_STATE_ABSENT="$TMP/h-state-absent"
mkdir -p "$H_STATE_ABSENT/cache/model-pricing"
date -u +%Y-%m-%d > "$H_STATE_ABSENT/cache/model-pricing/attempted-utc"
H9_FIXTURE="$TMP/h9-no-catalog.jsonl"
h_step_fixture "$H9_FIXTURE" '{"input":100,"output":10}'
assert_field "H-9: catalogo ausente -> estimated_cost_usd null (nunca 0 ni el .part.cost crudo)" \
    "null" "$(h_cost "$H_STATE_ABSENT" "openai/gpt-5.6-terra" "$H9_FIXTURE")"

# H-10: catalogo STALE pero estructuralmente valido (validated_utc de ayer,
# intento de hoy ya marcado) -- ADR seccion 4: se sigue calculando con esa
# cache (con aviso), nunca null solo por estar vencida.
H_STATE_STALE="$TMP/h-state-stale"
write_pricing_cache "$H_STATE_STALE" "2000-01-01" "$H_MODELS"
H10_FIXTURE="$TMP/h10-stale.jsonl"
h_step_fixture "$H10_FIXTURE" '{"input":1000,"output":100}'
H10_ERR="$TMP/h10-stale.err"
H10_OUT="$(MEFISTO_STATE_DIR="$H_STATE_STALE" runtime_opencode_translate "$H10_FIXTURE" "opencode" "openai/gpt-5.6-luna" 0 2>"$H10_ERR" | jq -r 'select(.type=="run.completed" or .type=="run.failed") | .estimated_cost_usd')"
assert_field "H-10: catalogo stale (valido) sigue calculando el estimado, no degrada a null" "0.00032" "$H10_OUT"
if grep -q "desactualizada" "$H10_ERR"; then
    pass "H-10b: catalogo stale avisa por stderr (visible, no silencioso)"
else
    fail "H-10b: no se encontro el aviso de catalogo desactualizado: $(cat "$H10_ERR")"
fi

# H-11 (CA-1): mefisto-run-agent.sh invoca la traduccion DENTRO DE UNA
# SUSTITUCION DE COMANDOS -- `TRANSLATED="$("$TRANSLATE_FN" ...)"`, una vez
# por tick del anexo en vivo y otra al cerrar -- o sea en un SUBSHELL. Este
# bloque reproduce esa forma exacta (`$(...)`) y no una llamada en el shell
# actual: una cota que viva solo en una variable de shell se pierde al
# terminar cada subshell, asi que un test que llame a la traduccion en su
# propio shell mediria una cota que el runner real nunca obtiene.
#
# Se envuelve la funcion real con un contador que escribe a un ARCHIVO (lo
# unico que sobrevive al subshell; nunca se edita el archivo de produccion).
eval "$(declare -f runtime_opencode_prepare_pricing | sed '1s/.*/runtime_opencode_prepare_pricing_h11_real ()/')"
H11_CALLS="$TMP/h11-prepare-calls"
: > "$H11_CALLS"
runtime_opencode_prepare_pricing() {
    printf 'x\n' >> "$H11_CALLS"
    runtime_opencode_prepare_pricing_h11_real
}
h11_prepare_count() { wc -l < "$H11_CALLS" | tr -d ' '; }
h11_translate() {
    # Misma forma que mefisto-run-agent.sh: subshell + captura.
    local state_dir="$1" fixture="$2" exit_code="$3"
    local _out
    _out="$(MEFISTO_STATE_DIR="$state_dir" runtime_opencode_translate "$fixture" "opencode" "openai/gpt-5.6-terra" "$exit_code" "" 2>/dev/null)"
    printf '%s' "$_out" > /dev/null
}
MEFISTO_OPENCODE_PRICING_PREPARED_FOR=""
H11_FIXTURE="$TMP/h11-live-tick.jsonl"
h_step_fixture "$H11_FIXTURE" '{"input":10,"output":1}'

# Caso A -- el estado que ve el 99% de los ticks: el trabajo del dia ya esta
# hecho en disco (intento de hoy marcado + cache instalada). Ningun tick
# vuelve a tomar el lock ni a revalidar el catalogo entero.
h11_translate "$H_STATE_MAIN" "$H11_FIXTURE" ""
h11_translate "$H_STATE_MAIN" "$H11_FIXTURE" ""
h11_translate "$H_STATE_MAIN" "$H11_FIXTURE" 0
if [ "$(h11_prepare_count)" = "0" ]; then
    pass "H-11: con el trabajo diario ya hecho en disco, 3 traducciones en subshell (2 live + 1 final) no repiten la preparacion"
else
    fail "H-11: la preparacion se repitio $(h11_prepare_count) veces pese a que el intento de hoy ya estaba marcado"
fi

# Caso B -- la cota no es ciega: un MEFISTO_STATE_DIR cuyo trabajo del dia
# NO esta hecho (cache validada hoy pero sin marca de intento) si prepara, y
# lo hace UNA sola vez: el primer tick deja la marca y los siguientes ya
# entran por el camino rapido. La cache se fecha HOY a proposito para que la
# preparacion no intente ninguna descarga (misma razon que write_pricing_cache).
H_STATE_FRESH="$TMP/h-state-fresh"
write_pricing_cache "$H_STATE_FRESH" "$(date -u +%Y-%m-%d)" "$H_MODELS"
rm -f "$H_STATE_FRESH/cache/model-pricing/attempted-utc"
h11_translate "$H_STATE_FRESH" "$H11_FIXTURE" ""
h11_translate "$H_STATE_FRESH" "$H11_FIXTURE" ""
h11_translate "$H_STATE_FRESH" "$H11_FIXTURE" 0
if [ "$(h11_prepare_count)" = "1" ]; then
    pass "H-11b: un state dir sin el trabajo del dia SI prepara, y solo en el primer tick (la cota no es ciega ni se repite)"
else
    fail "H-11b: se esperaba exactamente 1 preparacion para el state dir nuevo, hubo $(h11_prepare_count)"
fi

# H-11c: la cota no puede cambiar el importe -- el anexo en vivo y la
# traduccion final de la MISMA corrida tienen que coincidir al centavo, que
# es lo que CA-1 pide con "una unica referencia de catalogo".
H11C_LIVE="$(h_cost "$H_STATE_MAIN" "openai/gpt-5.6-terra" "$H1_FIXTURE")"
H11C_FINAL="$(h_cost "$H_STATE_MAIN" "openai/gpt-5.6-terra" "$H1_FIXTURE")"
assert_field "H-11c: traduccion live y final de la misma corrida dan el mismo importe" \
    "0.592652 0.592652" "$H11C_LIVE $H11C_FINAL"

unset -f runtime_opencode_prepare_pricing
eval "$(declare -f runtime_opencode_prepare_pricing_h11_real | sed '1s/.*/runtime_opencode_prepare_pricing ()/')"
unset -f runtime_opencode_prepare_pricing_h11_real

# H-12 (CA-4): un catalogo corrupto/incompleto que igual llego a servirse
# -- el camino rapido de runtime_opencode_ensure_pricing no revalida el
# documento entero en cada tick -- degrada a null SIN abortar la traduccion:
# el resto de los eventos neutrales se sigue emitiendo.
h12_case() {
    # h12_case <slug> <contenido-del-catalogo>
    local slug="$1" body="$2"
    # `local a=$1 b=$TMP/$a` NO funciona: bash expande todos los argumentos de
    # `local` antes de asignar ninguno, asi que $a todavia no existe.
    local dir="$TMP/h12-$slug/cache/model-pricing"
    mkdir -p "$dir"
    printf '%s' "$body" > "$dir/catalog.json"
    date -u +%Y-%m-%d > "$dir/attempted-utc"
    printf '%s' "$TMP/h12-$slug"
}
H12_FIXTURE="$TMP/h12.jsonl"
h_step_fixture "$H12_FIXTURE" '{"input":1000,"output":100}'
H12_TODAY="$(date -u +%Y-%m-%d)"
H12_BROKEN="$(h12_case broken 'esto no es JSON')"
assert_field "H-12: catalogo que no parsea -> null (no aborta la traduccion)" \
    "null" "$(h_cost "$H12_BROKEN" "openai/gpt-5.6-terra" "$H12_FIXTURE")"
H12_NO_MODELS="$(h12_case nomodels "{\"schema\":1,\"validated_utc\":\"$H12_TODAY\",\"models\":\"no-es-objeto\"}")"
assert_field "H-12b: catalogo con .models no-objeto -> null" \
    "null" "$(h_cost "$H12_NO_MODELS" "openai/gpt-5.6-terra" "$H12_FIXTURE")"
H12_BAD_RATE="$(h12_case badrate "{\"schema\":1,\"validated_utc\":\"$H12_TODAY\",\"models\":{\"openai/gpt-5.6-terra\":{\"input\":\"2\",\"output\":12,\"cache_read\":0.2,\"cache_write\":2.5,\"tiers\":[]}}}")"
assert_field "H-12c: tarifa base no numerica -> null (nunca multiplica un string)" \
    "null" "$(h_cost "$H12_BAD_RATE" "openai/gpt-5.6-terra" "$H12_FIXTURE")"
H12_BAD_TIER="$(h12_case badtier "{\"schema\":1,\"validated_utc\":\"$H12_TODAY\",\"models\":{\"openai/gpt-5.6-terra\":{\"input\":2,\"output\":12,\"cache_read\":0.2,\"cache_write\":2.5,\"tiers\":[{\"context\":272000,\"input\":null,\"output\":18,\"cache_read\":0.4,\"cache_write\":5}]}}}")"
assert_field "H-12d: tier con tarifa invalida -> null, no cae a la tarifa base (cobraria de menos en silencio)" \
    "null" "$(h_cost "$H12_BAD_TIER" "openai/gpt-5.6-terra" "$H12_FIXTURE")"
# Control positivo del mismo mecanismo: sin el, los cuatro casos de arriba
# podrian estar dando null solo porque el catalogo nunca llego a servirse.
H12_OK="$(h12_case ok "{\"schema\":1,\"validated_utc\":\"$H12_TODAY\",\"models\":{\"openai/gpt-5.6-terra\":{\"input\":2,\"output\":12,\"cache_read\":0.2,\"cache_write\":2.5,\"tiers\":[]}}}")"
assert_field "H-12f: el mismo mecanismo con un catalogo sano SI calcula (control positivo de H-12a..d)" \
    "0.003200" "$(printf '%.6f' "$(h_cost "$H12_OK" "openai/gpt-5.6-terra" "$H12_FIXTURE")")"

H12_EVENTS="$(MEFISTO_STATE_DIR="$H12_BROKEN" runtime_opencode_translate "$H12_FIXTURE" "opencode" "openai/gpt-5.6-terra" 0 2>/dev/null | wc -l | tr -d ' ')"
if [ "$H12_EVENTS" -ge 2 ]; then
    pass "H-12e: con catalogo corrupto la traduccion sigue emitiendo sus eventos (degradacion, no aborto)"
else
    fail "H-12e: la traduccion emitio $H12_EVENTS lineas con catalogo corrupto (se esperaba el JSONL completo)"
fi

# H-13 (CA-4): un `step_finish` sin objeto `tokens` no vale 0 -- anula la
# corrida entera. Un wire format que dejara de traer ese objeto produciria,
# si no, un importe cercano a cero indistinguible de una corrida barata.
H13_FIXTURE="$TMP/h13-sin-tokens.jsonl"
cat > "$H13_FIXTURE" <<'EOF'
{"type":"step_finish","timestamp":1,"sessionID":"s","part":{"reason":"stop"}}
{"type":"text","timestamp":2,"sessionID":"s","part":{"text":"ok"}}
EOF
assert_field "H-13: step_finish sin objeto tokens -> null (nunca un cero fabricado)" \
    "null" "$(h_cost "$H_STATE_MAIN" "openai/gpt-5.6-terra" "$H13_FIXTURE")"

MEFISTO_OPENCODE_PRICING_PREPARED_FOR=""

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
