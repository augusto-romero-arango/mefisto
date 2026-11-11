#!/usr/bin/env bash
# onboard-diagnose.sh -- shim del diagnostico de /onboard: la implementacion vive en
# onboard-diagnose.mts (MEF-ADR-0057).
#
# Ademas conserva las funciones que onboard-migrate-directives.sh carga con `source`. Son
# gemelas de hasContractHeading, contractSectionHasToken, resolveOnboardRuntime y
# checkConsumerDirectives de onboard-diagnose.mts: un cambio va en los dos lados. Se retiran
# cuando ese script deje de cargarlas.

set +e

# _has_contract_heading <file> <heading>
# Reconoce solamente los encabezados Markdown de las secciones contractuales.
_has_contract_heading() {
    grep -Eq "^[[:space:]]*#{1,6}[[:space:]]+$2([[:space:]]*\\([^)]*\\))?[[:space:]]*$" "$1"
}

# _contract_section_has_token <file> <token>
# Limita la búsqueda a "Tokens del harness": una ocurrencia incidental en otra
# sección no completa el contrato de esa sección.
_contract_section_has_token() {
    awk -v token="$2" '
        /^[[:space:]]*#{1,6}[[:space:]]+/ {
            heading = $0
            sub(/^[[:space:]]*#{1,6}[[:space:]]+/, "", heading)
            sub(/[[:space:]]+$/, "", heading)
            if (heading ~ /^Tokens del harness([[:space:]]*\([^)]*\))?$/) {
                in_tokens = 1
                next
            }
            if (in_tokens) in_tokens = 0
        }
        in_tokens && index($0, "**" token "**") { found = 1 }
        END { exit(found ? 0 : 1) }
    ' "$1"
}

# _onboard_resolve_runtime
# Deja en ONBOARD_RUNTIME el runtime activo: MEFISTO_RUNTIME (fijado por la
# directiva de cada adaptador) o, si falta, mefisto_resolve_runtime. Si no se
# puede resolver, cae en "claude" para conservar la verificacion estricta.
_onboard_resolve_runtime() {
    local here lib_dir resolved=""
    ONBOARD_RUNTIME=""
    if [ -n "${MEFISTO_RUNTIME:-}" ]; then
        ONBOARD_RUNTIME="$MEFISTO_RUNTIME"
        return 0
    fi
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    lib_dir="${MEFISTO_RUNTIME_LIB_DIR:-$(cd "$here/../src/runtime/lib" 2>/dev/null && pwd -P)}"
    if [ -n "$lib_dir" ] && [ -f "$lib_dir/mefisto-runtime.sh" ]; then
        MEFISTO_RUNTIME_LIB_DIR="$lib_dir"
        resolved=$(source "$lib_dir/mefisto-runtime.sh" && mefisto_resolve_runtime 2>/dev/null) || resolved=""
    fi
    ONBOARD_RUNTIME="${resolved:-claude}"
}

# _check_consumer_directives [agents_md] [claude_md] [runtime]
# El puente CLAUDE.md solo es requerido bajo el runtime "claude"; con cualquier
# otro es informativo (estado INFO, nunca FALTA/NV) segun MEF-ADR-0050/0053.
# Diagnóstico sourceable para que main() y las pruebas consuman la misma lógica
# sin invocar gh, az o jq. Deja estados, detalles y señales en DIRECTIVES_*.
_check_consumer_directives() {
    local agents_md="${1:-AGENTS.md}" claude_md="${2:-CLAUDE.md}" runtime="${3:-${ONBOARD_RUNTIME:-claude}}"
    local missing="" token has_import=0 has_legacy=0
    AGENTS_DIRECTIVES_STATE=""; AGENTS_DIRECTIVES_DETAIL=""
    CLAUDE_BRIDGE_STATE=""; CLAUDE_BRIDGE_DETAIL=""
    CLAUDE_BRIDGE_HAS_IMPORT=0; CLAUDE_BRIDGE_HAS_LEGACY=0

    if [ ! -e "$agents_md" ]; then
        AGENTS_DIRECTIVES_STATE="FALTA"
        AGENTS_DIRECTIVES_DETAIL="AGENTS.md no existe: crea las secciones \"Tokens del harness\" y \"Verificación de fuentes\" con los 5 tokens obligatorios"
    elif [ ! -r "$agents_md" ]; then
        AGENTS_DIRECTIVES_STATE="NV"
        AGENTS_DIRECTIVES_DETAIL="AGENTS.md existe pero no es legible"
    else
        _has_contract_heading "$agents_md" "Tokens del harness" || missing=" encabezado \"Tokens del harness\""
        _has_contract_heading "$agents_md" "Verificación de fuentes" || missing="${missing} encabezado \"Verificación de fuentes\""
        for token in RootNamespace SolutionFile ProjectDisplayName BoundedContext BoundedContextDomains; do
            _contract_section_has_token "$agents_md" "$token" || missing="${missing} ${token}"
        done
        if [ -z "$missing" ]; then
            AGENTS_DIRECTIVES_STATE="OK"
            AGENTS_DIRECTIVES_DETAIL="AGENTS.md contiene las dos secciones obligatorias y los 5 tokens"
        else
            AGENTS_DIRECTIVES_STATE="FALTA"
            AGENTS_DIRECTIVES_DETAIL="AGENTS.md esta incompleto; faltan:${missing}"
        fi
    fi

    if [ ! -e "$claude_md" ]; then
        CLAUDE_BRIDGE_STATE="FALTA"
        CLAUDE_BRIDGE_DETAIL="CLAUDE.md no existe: crea el puente con una linea independiente @AGENTS.md"
    elif [ ! -r "$claude_md" ]; then
        CLAUDE_BRIDGE_STATE="NV"
        CLAUDE_BRIDGE_DETAIL="CLAUDE.md existe pero no es legible"
    else
        grep -Eq '^[[:space:]]*@AGENTS\.md[[:space:]]*$' "$claude_md" && has_import=1
        if _has_contract_heading "$claude_md" "Tokens del harness" || _has_contract_heading "$claude_md" "Verificación de fuentes"; then has_legacy=1; fi
        CLAUDE_BRIDGE_HAS_IMPORT=$has_import
        CLAUDE_BRIDGE_HAS_LEGACY=$has_legacy
        if [ "$has_import" -eq 1 ] && [ "$has_legacy" -eq 0 ]; then
            CLAUDE_BRIDGE_STATE="OK"
            CLAUDE_BRIDGE_DETAIL="CLAUDE.md contiene el puente exacto @AGENTS.md sin secciones contractuales duplicadas"
        elif [ "$has_import" -eq 0 ] && [ "$has_legacy" -eq 1 ]; then
            CLAUDE_BRIDGE_STATE="FALTA"
            CLAUDE_BRIDGE_DETAIL="CLAUDE.md legacy legible: faltan el puente exacto @AGENTS.md y la limpieza manual de las secciones contractuales duplicadas"
        elif [ "$has_import" -eq 0 ]; then
            CLAUDE_BRIDGE_STATE="FALTA"
            CLAUDE_BRIDGE_DETAIL="CLAUDE.md no contiene una linea independiente @AGENTS.md; agrega el puente hacia AGENTS.md"
        else
            CLAUDE_BRIDGE_STATE="FALTA"
            CLAUDE_BRIDGE_DETAIL="CLAUDE.md contiene @AGENTS.md pero conserva secciones contractuales legacy duplicadas; eliminalas manualmente"
        fi
    fi

    if [ "$runtime" != "claude" ]; then
        case "$CLAUDE_BRIDGE_STATE" in
            FALTA|NV)
                if [ ! -e "$claude_md" ]; then
                    CLAUDE_BRIDGE_DETAIL="puente CLAUDE.md ausente: solo lo requiere Claude Code; si tu equipo tambien usa Claude, crealo con una linea independiente @AGENTS.md"
                else
                    CLAUDE_BRIDGE_DETAIL="opcional (solo lo requiere Claude Code): $CLAUDE_BRIDGE_DETAIL"
                fi
                CLAUDE_BRIDGE_STATE="INFO"
                ;;
        esac
    fi
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    # Sin Node >= 22.18 el .mts no arranca y su fila de Node nunca se imprimiria.
    if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' 2>/dev/null; then
        echo "FALTA: Node >= 22.18 no esta en el PATH: /onboard y los hooks de Mefisto no corren." >&2
        echo "  Instala Node 22.18 o superior (https://nodejs.org/en/download) y repite /onboard." >&2
        exit 1
    fi
    exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/onboard-diagnose.mts" "$@"
fi
