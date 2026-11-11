#!/usr/bin/env bash
# Genera el adaptador Claude Code de los hooks interactivos publicados.
set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd -P)"
VALIDATOR="$SCRIPT_DIR/validate-interactive-hooks.sh"
CONTRACT="$REPO_ROOT/src/published/hooks/interactive-hooks.json"
CHECK_MODE=0
OUT_ROOT="$REPO_ROOT"

usage_error() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
    case "$1" in
        --check) CHECK_MODE=1; shift ;;
        --out)
            [ "$#" -ge 2 ] || usage_error "--out requiere una raiz"
            OUT_ROOT="$2"; shift 2 ;;
        --*) usage_error "opcion desconocida: $1" ;;
        *) usage_error "argumento inesperado: $1" ;;
    esac
done

# La validacion debe ocurrir antes de preparar temporales o inspeccionar la salida.
[ -x "$VALIDATOR" ] || usage_error "no existe o no es ejecutable validate-interactive-hooks.sh"
VALIDATION="$($VALIDATOR "$CONTRACT" 2>&1)"; VALIDATION_RC=$?
if [ "$VALIDATION_RC" -ne 0 ]; then
    [ -z "$VALIDATION" ] || printf '%s\n' "$VALIDATION" >&2
    exit 1
fi
command -v jq >/dev/null 2>&1 || usage_error "jq no esta instalado (MEF-ADR-0049: bash + jq)"

# El descriptor validado es neutral; esta comprobacion evita omitir bindings en
# silencio al materializar sus dos hechos de sesion en los eventos Claude.
EXPECTED='append-dotnet-test-result append-file-change append-session append-session-model append-terraform-result record-active-release remind-field-notes'
ACTUAL="$(jq -r '[.bindings[].id] | sort | join(" ")' "$CONTRACT")"
[ "$ACTUAL" = "$EXPECTED" ] || usage_error "el contrato no contiene el conjunto exacto de siete bindings publicados"

# Forma exec de Claude Code: sin shell intermedio, igual en macOS, Linux y Windows. El binding
# viaja como argumento del unico script que implementa los siete (MEF-ADR-0057 decision 3).
STAGE="$(mktemp)" || usage_error "no se pudo crear el temporal"
trap 'rm -f "$STAGE"' EXIT
jq -n '
    def hook($binding): {type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/scripts/interactive-hooks.mts", $binding]};
    {hooks: {
        SessionStart: [{hooks: [hook("record-active-release"), hook("append-session")]}],
        Stop: [{hooks: [hook("append-session-model"), hook("remind-field-notes")]}],
        PostToolUse: [
            {matcher: "Write|Edit", hooks: [hook("append-file-change")]},
            {matcher: "Bash", hooks: [hook("append-dotnet-test-result"), hook("append-terraform-result")]}
        ]
    }, modules: ["./index.tsx"]}
' > "$STAGE" || usage_error "no se pudo renderizar el adaptador Claude"

# JSON y topologia se validan antes de que una salida existente pueda reemplazarse.
jq -e '
  (. | keys) == ["hooks", "modules"] and
  .modules == ["./index.tsx"] and
  (.hooks | keys | sort) == ["PostToolUse", "SessionStart", "Stop"] and
  (.hooks.SessionStart | type == "array" and length == 1) and
  (.hooks.SessionStart[0] | keys == ["hooks"] and (.hooks | type == "array" and length == 2)) and
  (.hooks.Stop | type == "array" and length == 1) and
  (.hooks.Stop[0] | keys == ["hooks"] and (.hooks | type == "array" and length == 2)) and
  (.hooks.PostToolUse | type == "array" and length == 2) and
  ([.hooks.PostToolUse[] | keys] | all(. == ["hooks", "matcher"])) and
  ([.hooks.PostToolUse[].matcher] == ["Write|Edit", "Bash"]) and
  ([.hooks.PostToolUse[].hooks | type] | all(. == "array")) and
  ([.hooks.PostToolUse[] | .hooks[]] | length) == 3 and
  ([.hooks.SessionStart[0].hooks[], .hooks.Stop[0].hooks[], .hooks.PostToolUse[].hooks[]] |
    all(keys == ["args", "command", "type"] and .type == "command" and .command == "node" and
        (.args | type == "array" and length == 2) and
        .args[0] == "${CLAUDE_PLUGIN_ROOT}/scripts/interactive-hooks.mts")) and
  ([.hooks.SessionStart[0].hooks[], .hooks.Stop[0].hooks[], .hooks.PostToolUse[].hooks[]] | map(.args[1])) ==
    ["record-active-release", "append-session", "append-session-model", "remind-field-notes",
     "append-file-change", "append-dotnet-test-result", "append-terraform-result"]
' "$STAGE" >/dev/null || usage_error "el adaptador Claude renderizado no cumple la estructura de hooks"

DESTINATION="$OUT_ROOT/hooks/hooks.json"
if [ "$CHECK_MODE" -eq 1 ]; then
    if [ ! -f "$DESTINATION" ]; then
        printf 'hooks/hooks.json: faltante\n'
        exit 1
    fi
    if ! cmp -s "$STAGE" "$DESTINATION"; then
        printf 'hooks/hooks.json: distinta\n'
        exit 1
    fi
    exit 0
fi

mkdir -p "$OUT_ROOT/hooks" || usage_error "no se pudo preparar hooks/"
PUBLISH="$(mktemp "$OUT_ROOT/hooks/.hooks.json.XXXXXX")" || usage_error "no se pudo preparar la salida temporal"
cp "$STAGE" "$PUBLISH" && mv -f "$PUBLISH" "$DESTINATION" || { rm -f "$PUBLISH"; usage_error "no se pudo publicar hooks/hooks.json"; }
