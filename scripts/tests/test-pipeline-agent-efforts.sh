#!/usr/bin/env bash
# Guard de #2500: la tabla pipeline_agent_effort_level de scripts/_pipeline-common.sh
# debe coincidir con el `effort` de src/published/agents/*.md (los consumidores no
# tienen las fuentes, asi que la tabla las duplica a proposito). Tambien cubre
# el helper resolve_pipeline_agent_effort con el adaptador `fake`.
#
# Uso: scripts/tests/test-pipeline-agent-efforts.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
COMMON="$ROOT/scripts/_pipeline-common.sh"
AGENTS_DIR="$ROOT/src/published/agents"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
command -v jq >/dev/null 2>&1 || { echo "SKIP: jq no disponible"; exit 0; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# shellcheck disable=SC1090
source "$COMMON"
source "$ROOT/src/runtime/lib/mefisto-models.sh"

# Lista de agentes de la tabla: se extrae del propio case, sin duplicarla aqui.
TABLE_AGENTS="$(awk '/^pipeline_agent_effort_level\(\) \{/{p=1} p{print} p && /^}/{exit}' "$COMMON" \
    | grep -v '^pipeline_agent_effort_level\|printf\|\*)\|^}\|esac\|case ' \
    | tr -d '\\)' | tr '|' '\n' | tr -s ' \n' '\n' | sed '/^$/d' | sort -u)"

echo '[CA-2] tabla vs frontmatter de src/published/agents'
SRC_AGENTS=""
for f in "$AGENTS_DIR"/*.md; do
    id="$(basename "$f" .md)"
    SRC_AGENTS="${SRC_AGENTS}${id}"$'\n'
    src_level="$(sed -n '2,/^---$/p' "$f" | sed '$d' | jq -r '.effort // empty' 2>/dev/null)"
    if [ -z "$src_level" ]; then
        fail "$id: la fuente no declara effort"
        continue
    fi
    if table_level="$(pipeline_agent_effort_level "$id")"; then
        if [ "$table_level" = "$src_level" ]; then
            pass "$id: tabla y fuente coinciden ($src_level)"
        else
            fail "$id: tabla='$table_level' fuente='$src_level'"
        fi
    else
        fail "$id: existe en la fuente y no en la tabla"
    fi
done
SRC_AGENTS="$(printf '%s' "$SRC_AGENTS" | sort -u)"
EXTRA="$(comm -13 <(printf '%s\n' "$SRC_AGENTS") <(printf '%s\n' "$TABLE_AGENTS"))"
if [ -z "$EXTRA" ]; then
    pass 'la tabla no tiene agentes que no existan en la fuente'
else
    fail "agentes en la tabla sin fuente: $(printf '%s' "$EXTRA" | tr '\n' ' ')"
fi
[ "$(printf '%s\n' "$SRC_AGENTS" | wc -l | tr -d ' ')" -eq 22 ] \
    && pass 'son 22 agentes publicados' || fail 'se esperaban 22 agentes publicados'

[ "$(printf '%s\n' "$TABLE_AGENTS" | wc -l | tr -d ' ')" -eq 22 ] \
    && pass 'la tabla cubre 22 agentes' || fail "la tabla cubre $(printf '%s\n' "$TABLE_AGENTS" | wc -l | tr -d ' ') agentes, se esperaban 22"

echo '[CA-1] pipeline_agent_effort_level con id desconocido'
if out="$(pipeline_agent_effort_level agente-inexistente)"; then
    fail 'un id desconocido debio retornar 1'
else
    [ -z "$out" ] && pass 'id desconocido retorna 1 sin imprimir' || fail 'id desconocido imprimio algo'
fi

echo '[CA-1] resolve_pipeline_agent_effort con el adaptador fake'
MEFISTO_RUNTIME_RESUELTO=fake
EVENTS_LOG_ABS="$TMP/events.log"
: > "$EVENTS_LOG_ABS"

# Sin mapping y sin default del adaptador: hereda (vacio).
CONSUMER_MODELS_FILE="$TMP/ausente.json"
unset MEFISTO_FAKE_DEFAULT_EFFORT
if resolve_pipeline_agent_effort writer tooling-writer && [ -z "$RESOLVED_PIPELINE_EFFORT" ] \
    && grep -Fq 'EFFORTS: writer -> <heredado> (nivel light)' "$EVENTS_LOG_ABS"; then
    pass 'sin mapping ni default: hereda y anota <heredado> con el nivel'
else
    fail "sin mapping: RESOLVED='$RESOLVED_PIPELINE_EFFORT' log=$(cat "$EVENTS_LOG_ABS")"
fi

# Default del adaptador fake: mismo valor para todo nivel.
MEFISTO_FAKE_DEFAULT_EFFORT=fx-default
if resolve_pipeline_agent_effort reviewer tooling-reviewer && [ "$RESOLVED_PIPELINE_EFFORT" = fx-default ]; then
    pass 'default del adaptador fake llega a RESOLVED_PIPELINE_EFFORT'
else
    fail "default fake: '$RESOLVED_PIPELINE_EFFORT'"
fi
unset MEFISTO_FAKE_DEFAULT_EFFORT

# Mapping con un nativo distinto por nivel y un override por agente.
CONSUMER_MODELS_FILE="$TMP/models.json"
cat > "$CONSUMER_MODELS_FILE" <<'JSON'
{"fake":{"efforts":{"levels":{"light":"n-light","standard":"n-standard","thorough":"n-thorough"},"agents":{"tooling-reviewer":"thorough"}}}}
JSON
: > "$EVENTS_LOG_ABS"
resolve_pipeline_agent_effort writer tooling-writer
w="$RESOLVED_PIPELINE_EFFORT"
resolve_pipeline_agent_effort implementer implementer
i="$RESOLVED_PIPELINE_EFFORT"
resolve_pipeline_agent_effort reviewer tooling-reviewer
r="$RESOLVED_PIPELINE_EFFORT"
if [ "$w" = n-light ] && [ "$i" = n-standard ] && [ "$r" = n-thorough ]; then
    pass 'nivel de fabrica y efforts.agents se traducen con efforts.levels'
else
    fail "mapping: writer='$w' implementer='$i' reviewer='$r'"
fi
grep -Fq 'EFFORTS: reviewer -> n-thorough (nivel standard)' "$EVENTS_LOG_ABS" \
    && pass 'events.log registra el nativo y el nivel de fabrica' || fail "events.log: $(cat "$EVENTS_LOG_ABS")"

echo '[CA-1] fallos de resolve_pipeline_agent_effort'
if resolve_pipeline_agent_effort x agente-inexistente; then
    fail 'agente desconocido debio retornar 1'
else
    [ -n "$PIPELINE_EFFORT_ERROR" ] && [ -z "$RESOLVED_PIPELINE_EFFORT" ] \
        && pass 'agente desconocido: retorna 1 con PIPELINE_EFFORT_ERROR' || fail 'agente desconocido sin motivo'
fi
cat > "$TMP/invalido.json" <<'JSON'
{"fake":{"efforts":{"levels":"no-es-un-objeto"}}}
JSON
CONSUMER_MODELS_FILE="$TMP/invalido.json"
if resolve_pipeline_agent_effort writer tooling-writer; then
    fail 'mapping invalido debio retornar 1'
else
    [ -n "$PIPELINE_EFFORT_ERROR" ] && pass "mapping invalido: retorna 1 con motivo ($PIPELINE_EFFORT_ERROR)" || fail 'mapping invalido sin motivo'
fi

printf '\nResultado: %s PASS, %s FAIL\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
