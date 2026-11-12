#!/usr/bin/env bash
# test-stage-models.sh -- Tests del mecanismo de asignacion de modelo por stage
# (--models, issue #708) en scripts/_pipeline-common.sh.
#
# Cubre:
#   parse_stage_models    - spec vacio (no --models: comportamiento actual
#                            intacto), spec valido de 1 y N entradas, y las tres
#                            formas de entrada malformada (CA-1: sin '=', clave o
#                            valor vacio, agente repetido) -- todas abortan con un
#                            mensaje en PIPELINE_STAGE_MODELS_ERROR, sin imprimir
#                            nada por si misma.
#   resolve_stage_model    - override por clave exacta, sin match cae al default,
#                            y sin --models (mapa vacio) siempre el default (CA-2:
#                            byte a byte el comportamiento previo al flag), y
#                            la cadena clave-fina -> agente-relanzado que
#                            tdd-pipeline.sh usa en los sub-stages de patch
#                            (issue #712).
#   format_stage_models_for_log - formato de auditoria (CA-4), vacio sin mapa.
#
# El reenvio y el rechazo de --models en el modo desacoplado de launch-pipeline.mts
# los cubre scripts/tests/launch-pipeline.test.mts; dentro de herdr,
# scripts/tests/herdr-pipeline.test.mts.
#
# Uso: scripts/tests/test-stage-models.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

FAKE_CONSUMER="$(mktemp -d)"
TMP_DIR="$(mktemp -d)"
MODEL_PLUGIN="$TMP_DIR/plugin"
mkdir -p "$MODEL_PLUGIN/scripts" "$MODEL_PLUGIN/agents"
cp "$REPO_ROOT/scripts/_pipeline-common.sh" "$MODEL_PLUGIN/scripts/_pipeline-common.sh"
printf '%s\n' '---' 'name: fixture-con-modelo' 'model: "modelo-fixture"' '---' > "$MODEL_PLUGIN/agents/con-modelo.md"
printf '%s\n' '---' 'name: fixture-sin-comillas' 'model: modelo-sin-comillas' '---' > "$MODEL_PLUGIN/agents/sin-comillas.md"
printf '%s\n' '---' 'name: fixture-sin-modelo' '---' > "$MODEL_PLUGIN/agents/sin-modelo.md"
printf '%s\n' '---' 'name: fixture-modelo-vacio' 'model:' 'model: no-debe-leerse' '---' > "$MODEL_PLUGIN/agents/modelo-vacio.md"
cp "$REPO_ROOT/agents/infra-writer.md" "$MODEL_PLUGIN/agents/infra-writer.md"
cp "$REPO_ROOT/agents/infra-reviewer.md" "$MODEL_PLUGIN/agents/infra-reviewer.md"
cp "$REPO_ROOT/agents/domain-scaffolder.md" "$MODEL_PLUGIN/agents/domain-scaffolder.md"
cp "$REPO_ROOT/agents/test-writer.md" "$MODEL_PLUGIN/agents/test-writer.md"
cp "$REPO_ROOT/agents/implementer.md" "$MODEL_PLUGIN/agents/implementer.md"
cp "$REPO_ROOT/agents/reviewer.md" "$MODEL_PLUGIN/agents/reviewer.md"
cp "$REPO_ROOT/agents/smoke-test-writer.md" "$MODEL_PLUGIN/agents/smoke-test-writer.md"
cp "$REPO_ROOT/agents/projection-test-writer.md" "$MODEL_PLUGIN/agents/projection-test-writer.md"
cp "$REPO_ROOT/agents/projection-implementer.md" "$MODEL_PLUGIN/agents/projection-implementer.md"
trap 'rm -rf "$FAKE_CONSUMER" "$TMP_DIR"' EXIT

# Las funciones viven en _pipeline-common.sh; sourcearlo solo las define (es una
# libreria, no ejecuta nada), asi que es seguro incluso dentro del repo de Mefisto.
set +u
source "$MODEL_PLUGIN/scripts/_pipeline-common.sh" 2>/dev/null
set -u

echo "[0] resolve_declared_agent_model: metadata publicada tolerante y ruta independiente del cwd (CA-1 a CA-3)"
R=$(resolve_declared_agent_model "con-modelo")
if [ "$R" = "modelo-fixture" ]; then pass "devuelve el modelo declarado del agente"; else fail "deberia devolver 'modelo-fixture' (obtenido '$R')"; fi

R=$(resolve_declared_agent_model "sin-comillas")
if [ "$R" = "modelo-sin-comillas" ]; then pass "tolera el modelo declarado sin comillas"; else fail "deberia devolver 'modelo-sin-comillas' (obtenido '$R')"; fi

R=$(resolve_declared_agent_model "sin-modelo")
if [ -z "$R" ]; then pass "sin metadata model devuelve cadena vacia"; else fail "sin metadata deberia devolver vacio (obtenido '$R')"; fi

R=$(resolve_declared_agent_model "modelo-vacio")
if [ -z "$R" ]; then pass "la primera clave model vacia devuelve cadena vacia"; else fail "model vacio deberia devolver vacio (obtenido '$R')"; fi

MODEL_STDERR="$TMP_DIR/model-stderr"
if R=$(resolve_declared_agent_model "agente-inexistente" 2> "$MODEL_STDERR"); then
    pass "archivo inexistente retorna codigo 0"
else
    fail "archivo inexistente no deberia retornar error"
fi
if [ -z "$R" ] && [ ! -s "$MODEL_STDERR" ]; then pass "archivo inexistente no produce salida ni diagnosticos"; else fail "archivo inexistente produjo stdout '$R' o stderr"; fi

R=$(cd "$FAKE_CONSUMER" && resolve_declared_agent_model "con-modelo")
if [ "$R" = "modelo-fixture" ]; then pass "resuelve agents desde el plugin fuera del cwd"; else fail "desde cwd ajeno deberia devolver 'modelo-fixture' (obtenido '$R')"; fi

R=$(resolve_declared_agent_model "infra-writer")
if [ "$R" = "sonnet" ]; then pass "infra-writer declara sonnet"; else fail "infra-writer deberia declarar 'sonnet' (obtenido '$R')"; fi
R=$(resolve_declared_agent_model "infra-reviewer")
if [ "$R" = "opus" ]; then pass "infra-reviewer declara opus"; else fail "infra-reviewer deberia declarar 'opus' (obtenido '$R')"; fi
R=$(resolve_declared_agent_model "domain-scaffolder")
if [ "$R" = "sonnet" ]; then pass "domain-scaffolder declara sonnet"; else fail "domain-scaffolder deberia declarar 'sonnet' (obtenido '$R')"; fi
R=$(resolve_declared_agent_model "test-writer")
if [ "$R" = "sonnet" ]; then pass "test-writer generado declara sonnet sin comillas"; else fail "test-writer deberia declarar 'sonnet' (obtenido '$R')"; fi
R=$(resolve_declared_agent_model "implementer")
if [ "$R" = "sonnet" ]; then pass "implementer generado declara sonnet sin comillas"; else fail "implementer deberia declarar 'sonnet' (obtenido '$R')"; fi
R=$(resolve_declared_agent_model "reviewer")
if [ "$R" = "opus" ]; then pass "reviewer generado declara opus sin comillas"; else fail "reviewer deberia declarar 'opus' (obtenido '$R')"; fi
for agent in smoke-test-writer projection-test-writer projection-implementer; do
    R=$(resolve_declared_agent_model "$agent")
    if [ "$R" = "sonnet" ]; then pass "$agent generado declara sonnet con metadata JSON"; else fail "$agent deberia declarar 'sonnet' (obtenido '$R')"; fi
done

echo ""
echo "[1] parse_stage_models: spec vacio deja el mapa vacio y no aborta (CA-2: sin --models, nada cambia)"
if parse_stage_models ""; then pass "spec vacio retorna 0"; else fail "spec vacio no deberia abortar"; fi
if [ -z "$PIPELINE_STAGE_MODELS" ]; then pass "mapa vacio"; else fail "mapa deberia quedar vacio (obtenido '$PIPELINE_STAGE_MODELS')"; fi

echo ""
echo "[2] parse_stage_models: spec valido de una entrada"
if parse_stage_models "reviewer=opus"; then pass "una entrada retorna 0"; else fail "una entrada valida no deberia abortar"; fi
if [ "$PIPELINE_STAGE_MODELS" = "reviewer=opus" ]; then pass "mapa contiene la entrada"; else fail "mapa incorrecto: '$PIPELINE_STAGE_MODELS'"; fi

echo ""
echo "[3] parse_stage_models: spec valido de N entradas, separadas por coma"
if parse_stage_models "writer=sonnet,reviewer=opus"; then pass "dos entradas retorna 0"; else fail "dos entradas validas no deberia abortar"; fi
R=$(resolve_stage_model "writer" "default-no-usado")
if [ "$R" = "sonnet" ]; then pass "writer resuelve a sonnet"; else fail "writer deberia resolver a sonnet (obtenido '$R')"; fi
R=$(resolve_stage_model "reviewer" "default-no-usado")
if [ "$R" = "opus" ]; then pass "reviewer resuelve a opus"; else fail "reviewer deberia resolver a opus (obtenido '$R')"; fi

echo ""
echo "[4] parse_stage_models: id de modelo completo con caracteres especiales (sin allowlist de nombres)"
if parse_stage_models 'writer=claude-opus-5[1m]'; then pass "id completo con [] retorna 0"; else fail "un id de modelo completo no deberia abortar (sin allowlist propia)"; fi
R=$(resolve_stage_model "writer" "default-no-usado")
if [ "$R" = "claude-opus-5[1m]" ]; then pass "resuelve el id completo tal cual"; else fail "deberia resolver 'claude-opus-5[1m]' (obtenido '$R')"; fi

echo ""
echo "[5] parse_stage_models: entrada sin '=' aborta con mensaje claro (CA-1)"
if parse_stage_models "reviewer-opus"; then fail "entrada sin '=' no deberia retornar 0"; else pass "entrada sin '=' aborta"; fi
if printf '%s' "$PIPELINE_STAGE_MODELS_ERROR" | grep -q "reviewer-opus"; then pass "el error nombra la entrada malformada"; else fail "PIPELINE_STAGE_MODELS_ERROR no menciona la entrada: '$PIPELINE_STAGE_MODELS_ERROR'"; fi

echo ""
echo "[6] parse_stage_models: clave o valor vacio aborta (CA-1)"
if parse_stage_models "=opus"; then fail "clave vacia no deberia retornar 0"; else pass "clave vacia aborta"; fi
if parse_stage_models "reviewer="; then fail "valor vacio no deberia retornar 0"; else pass "valor vacio aborta"; fi

echo ""
echo "[7] parse_stage_models: agente repetido aborta (CA-1)"
if parse_stage_models "writer=sonnet,writer=opus"; then fail "agente repetido no deberia retornar 0"; else pass "agente repetido aborta"; fi
if printf '%s' "$PIPELINE_STAGE_MODELS_ERROR" | grep -q "writer"; then pass "el error nombra el agente repetido"; else fail "PIPELINE_STAGE_MODELS_ERROR no menciona 'writer': '$PIPELINE_STAGE_MODELS_ERROR'"; fi

echo ""
echo "[8] resolve_stage_model: sin match en el mapa, cae al default"
parse_stage_models "reviewer=opus" >/dev/null
R=$(resolve_stage_model "writer" "sonnet")
if [ "$R" = "sonnet" ]; then pass "writer sin override resuelve al default"; else fail "deberia caer al default 'sonnet' (obtenido '$R')"; fi

echo ""
echo "[9] resolve_stage_model: sin --models (mapa vacio), siempre el default -- byte a byte el comportamiento previo (CA-2)"
parse_stage_models "" >/dev/null
R=$(resolve_stage_model "reviewer" "opus")
if [ "$R" = "opus" ]; then pass "reviewer sin mapa resuelve al default 'opus'"; else fail "deberia resolver al default (obtenido '$R')"; fi
R=$(resolve_stage_model "writer" "sonnet")
if [ "$R" = "sonnet" ]; then pass "writer sin mapa resuelve al default 'sonnet'"; else fail "deberia resolver al default (obtenido '$R')"; fi
R=$(resolve_stage_model "merge-writer" "sonnet")
if [ "$R" = "sonnet" ]; then pass "la etapa de merge (default '*' del case) tambien resuelve al default"; else fail "deberia resolver al default (obtenido '$R')"; fi

echo ""
echo "[9b] resolve_stage_model: default vacio -- el mecanismo que usa tdd-pipeline.sh (issue #712) para NO agregar --model sin override"
parse_stage_models "" >/dev/null
R=$(resolve_stage_model "test-writer" "")
if [ -z "$R" ]; then pass "sin --models y default vacio, resuelve a cadena vacia (run_agent no agrega --model)"; else fail "deberia resolver a vacio (obtenido '$R')"; fi
parse_stage_models "test-writer=opus" >/dev/null
R=$(resolve_stage_model "test-writer" "")
if [ "$R" = "opus" ]; then pass "con override y default vacio, resuelve al override (run_agent agrega --model opus)"; else fail "deberia resolver a 'opus' (obtenido '$R')"; fi
R=$(resolve_stage_model "implementer" "")
if [ -z "$R" ]; then pass "sin match en el mapa y default vacio, resuelve a cadena vacia"; else fail "deberia resolver a vacio (obtenido '$R')"; fi

echo ""
echo "[9c] cadena de resolucion de los sub-stages de patch (issue #712): clave fina -> agente relanzado -> vacio"
# tdd-pipeline.sh compone las dos llamadas asi:
#   resolve_stage_model "patch-test-writer" "$(resolve_stage_model "$STAGE1_AGENT" "")"
# La clave fina gana si esta; si no, hereda la del agente que el stage relanza
# (sin esa caida, '--models test-writer=X' correria Stage 1 con X y la
# remediacion con el frontmatter -- dos modelos para el mismo rol en una corrida).
parse_stage_models "test-writer=opus" >/dev/null
R=$(resolve_stage_model "patch-test-writer" "$(resolve_stage_model "test-writer" "")")
if [ "$R" = "opus" ]; then pass "sin clave fina, el patch hereda el modelo de 'test-writer'"; else fail "deberia heredar 'opus' (obtenido '$R')"; fi

parse_stage_models "test-writer=opus,patch-test-writer=haiku" >/dev/null
R=$(resolve_stage_model "patch-test-writer" "$(resolve_stage_model "test-writer" "")")
if [ "$R" = "haiku" ]; then pass "la clave fina 'patch-test-writer' gana sobre la heredada"; else fail "deberia ganar 'haiku' (obtenido '$R')"; fi

parse_stage_models "reviewer=opus" >/dev/null
R=$(resolve_stage_model "patch-implementer" "$(resolve_stage_model "implementer" "")")
if [ -z "$R" ]; then pass "sin ninguna de las dos claves, la cadena resuelve a vacio (no se agrega --model)"; else fail "deberia resolver a vacio (obtenido '$R')"; fi

parse_stage_models "projection-test-writer=sonnet" >/dev/null
R=$(resolve_stage_model "patch-test-writer" "$(resolve_stage_model "projection-test-writer" "")")
if [ "$R" = "sonnet" ]; then pass "la herencia sigue al STAGE1_AGENT read-side (projection-test-writer)"; else fail "deberia heredar 'sonnet' (obtenido '$R')"; fi

echo ""
echo "[10] format_stage_models_for_log: vacio sin mapa, formateado con mapa (CA-4)"
parse_stage_models "" >/dev/null
R=$(format_stage_models_for_log)
if [ -z "$R" ]; then pass "sin mapa, formato vacio"; else fail "deberia ser vacio sin --models (obtenido '$R')"; fi
parse_stage_models "writer=sonnet,reviewer=opus" >/dev/null
R=$(format_stage_models_for_log)
if [ "$R" = "writer=sonnet, reviewer=opus" ]; then pass "formato de auditoria: 'writer=sonnet, reviewer=opus'"; else fail "formato incorrecto: '$R'"; fi

echo ""
echo "----------------------------------------"
echo "  _pipeline-common.sh: $PASS pass, $FAIL fail (hasta aqui)"
echo "----------------------------------------"

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
