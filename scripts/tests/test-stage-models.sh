#!/usr/bin/env bash
# test-stage-models.sh -- Tests del mecanismo de asignacion de modelo por stage
# (--models, issue #708) en scripts/_pipeline-common.sh y scripts/launch-pipeline.sh.
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
#   launch-pipeline.sh      - --tooling reenvia --models intacto al sub-pipeline
#                            (CA-3); el enrutamiento automatico de un unico
#                            issue (sin --tooling explicito) tambien lo reenvia
#                            desde que tdd-pipeline.sh lo implementa (issue
#                            #712) -- los unicos overrides validos de
#                            resolve_pipeline() son "tdd"/"tooling", asi que
#                            ese camino siempre resuelve a un sub-script que
#                            soporta el flag. El resto de los modos (--infra,
#                            --scaffold, --batch, --parallel, y varios
#                            issues sueltos) lo siguen rechazando con mensaje
#                            explicito en vez de tragarselo en silencio.
#   tdd-pipeline.sh         - resuelve el modelo neutral por perfil de cada
#                            stage (issue #1362, MEF-ADR-0049 decision 4): la
#                            tabla agente->perfil, el helper resolve_tdd_model
#                            (override --models por clave exacta -- incluida
#                            la cadena fina patch-test-writer/patch-implementer
#                            -> $STAGE1_AGENT/$STAGE2_AGENT -- o, si no hay,
#                            mefisto_resolve_model con el mapping opcional del
#                            consumidor y el adaptador del runtime activo) y su
#                            uso en run_agent/Stage 0/remediacion 4b/4c, con
#                            --model pasado siempre que el resuelto no sea
#                            vacio. Cubre estatica (tabla, helper, formato
#                            MODELS:) y un bloque ejecutable que corre
#                            resolve_tdd_model bajo runtime-fake (CA-5), mas un
#                            cruce estatico contra el `.profile` de
#                            src/published/agents/*.md (CA-6).
#   iac-pipeline.sh         - resuelve el modelo neutral por perfil de cada
#                            stage (issue #1624, alineado con tdd/tooling):
#                            infra-writer con perfil balanced, infra-reviewer
#                            con perfil deep, via mefisto_resolve_model (sin
#                            --models: el pipeline IaC nunca lo soporto), con
#                            --model condicional en el argv y una sola linea
#                            de anuncio por stage.
#   scaffold-pipeline.sh     - resuelve el modelo neutral por perfil (issue
#                            #1644, alineado con iac/tooling): domain-scaffolder
#                            con perfil balanced via mefisto_resolve_model (sin
#                            --models: este pipeline nunca lo soporto), con
#                            --model condicional en el argv y una sola linea de
#                            anuncio, sin duplicar entre el intento inicial y
#                            las sondas de hold (mismo bucle).
#   herdr-pipeline.sh       - la otra mitad de CA-3: dentro de un pane herdr,
#                            launch-pipeline.sh delega con `exec herdr-pipeline.sh
#                            "$@"`, asi que el flag tiene que sobrevivir tambien
#                            ahi -- mismo reenvio (con el valor intacto) y el
#                            mismo rechazo explicito por modo sin soporte.
#
# Uso: scripts/tests/test-stage-models.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

export HERDR_STUB_OWNER_PID=$$

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

# --- tdd-pipeline.sh: evidencia visible y persistente del modelo -------------
TDD_PIPELINE="$REPO_ROOT/scripts/tdd-pipeline.sh"
TDD_CONTENT=$(cat "$TDD_PIPELINE")

assert_tdd_contains() {
    local description="$1" expected="$2"
    case "$TDD_CONTENT" in
        *"$expected"*) pass "$description" ;;
        *) fail "$description -- no se encontro: $expected" ;;
    esac
}

assert_tdd_count() {
    local description="$1" expected="$2" needle="$3" actual
    actual=$(grep -cF -- "$needle" "$TDD_PIPELINE" || true)
    if [ "$actual" -eq "$expected" ]; then
        pass "$description"
    else
        fail "$description -- esperado $expected, obtenido $actual: $needle"
    fi
}

assert_tdd_order() {
    local description="$1" first="$2" second="$3" first_line second_line
    first_line=$(grep -nF -- "$first" "$TDD_PIPELINE" | cut -d: -f1 | head -n1)
    second_line=$(grep -nF -- "$second" "$TDD_PIPELINE" | cut -d: -f1 | head -n1)
    if [ -n "$first_line" ] && [ -n "$second_line" ] && [ "$first_line" -lt "$second_line" ]; then
        pass "$description"
    else
        fail "$description -- orden obtenido: '${first:-ausente}'=$first_line, '${second:-ausente}'=$second_line"
    fi
}

echo ""
echo "[10b] tdd: tabla agente->perfil, helper resolve_tdd_model y su uso en run_agent (CA-1, CA-2, CA-3)"
if grep -qF 'resolve_declared_agent_model' "$TDD_PIPELINE"; then
    fail "tdd retiene resolve_declared_agent_model (CA-4 exige retirarla de este pipeline)"
else
    pass "tdd retiro resolve_declared_agent_model (CA-4)"
fi
for absent_needle in 'MODEL_VISIBLE' 'MODEL_ORIGIN' 'MODEL_ARGS'; do
    if grep -qF -- "$absent_needle" "$TDD_PIPELINE"; then
        fail "tdd conserva la variable retirada $absent_needle"
    else
        pass "tdd no conserva la variable retirada $absent_needle"
    fi
done
assert_tdd_contains "tabla agente->perfil: 6 agentes balanced" 'test-writer|projection-test-writer|implementer|projection-implementer|smoke-test-writer|domain-scaffolder)'
assert_tdd_contains "tabla agente->perfil: balanced se imprime" "printf 'balanced'"
assert_tdd_contains "tabla agente->perfil: reviewer deep" 'reviewer)'
assert_tdd_contains "tabla agente->perfil: deep se imprime" "printf 'deep'"
assert_tdd_contains "un agente fuera de la tabla no hereda en silencio" 'return 1'
assert_tdd_contains "CONSUMER_MODELS_FILE se calcula antes del worktree" 'CONSUMER_MODELS_FILE="$(git rev-parse --show-toplevel)/.mefisto/models.json"'
assert_tdd_order "CONSUMER_MODELS_FILE se calcula antes de crear el worktree" 'CONSUMER_MODELS_FILE="$(git rev-parse --show-toplevel)/.mefisto/models.json"' 'header "Preparando worktree"'
assert_tdd_contains "resolve_tdd_model declara la firma de 3 parametros" 'local key="$1" agent_id="$2" profile="$3" explicit=""'
assert_tdd_contains "resolve_tdd_model resuelve el override por clave exacta via resolve_stage_model" 'explicit="$(resolve_stage_model "$key" "$(resolve_stage_model "$agent_id" "")")"'
assert_tdd_contains "resolve_tdd_model cae a mefisto_resolve_model con el mapping del consumidor" 'mefisto_resolve_model "$MEFISTO_RUNTIME_RESUELTO" "$agent_id" "$profile" "" "$CONSUMER_MODELS_FILE"'
assert_tdd_contains "resolve_tdd_model aborta si la resolucion del adaptador falla" 'abort "No se pudo resolver el modelo de $agent_id (perfil $profile): ${MEFISTO_MODELS_ERROR:-motivo desconocido}"'
assert_tdd_contains "resolve_tdd_model anuncia el override con el formato canonico" "MODELS: \$key runtime=\$MEFISTO_RUNTIME_RESUELTO perfil=\$profile solicitado='\$explicit' resuelto='\$RESOLVED_TDD_MODEL' (override --models)"
assert_tdd_contains "resolve_tdd_model anuncia lo automatico con el formato canonico" "MODELS: \$key runtime=\$MEFISTO_RUNTIME_RESUELTO perfil=\$profile solicitado=<automatico> resuelto='\${RESOLVED_TDD_MODEL:-<heredado>}'"
assert_tdd_contains "run_agent resuelve el perfil desde la tabla antes de invocar" 'agent_profile="$(_tdd_agent_profile "$agent")" || abort "Agente'
assert_tdd_contains "run_agent usa resolve_tdd_model con clave y agente identicos" 'resolve_tdd_model "$agent" "$agent" "$agent_profile"'
assert_tdd_contains "run_agent muestra el modelo resuelto antes del runner" 'log "Invocando $agent (modelo: ${AGENT_MODEL_OVERRIDE:-<heredado>})..."'
assert_tdd_contains "run_agent conserva el argv condicional --model" '[ -n "$AGENT_MODEL_OVERRIDE" ] && args+=(--model "$AGENT_MODEL_OVERRIDE")'
assert_tdd_contains "log escribe tambien en el log persistente" '_log_file "$m"'
assert_tdd_order "run_agent resuelve el perfil y el modelo antes de anunciar" 'resolve_tdd_model "$agent" "$agent" "$agent_profile"' 'log "Invocando $agent (modelo: ${AGENT_MODEL_OVERRIDE:-<heredado>})..."'
assert_tdd_contains "run_agent conserva el argv neutral con agente y cwd" '--agent "$agent" --cwd "$WORKTREE_PATH"'
for stage_call in 'run_agent "1" "$STAGE1_AGENT"' 'run_agent "2" "$STAGE2_AGENT"' 'run_agent "2b" "smoke-test-writer"' 'run_agent "3" "reviewer"' 'run_agent "merge" "implementer"'; do
    assert_tdd_contains "stage normal conserva la ruta run_agent: $stage_call" "$stage_call"
done
assert_tdd_count "run_agent declara una unica adicion condicional de --model" 1 '[ -n "$AGENT_MODEL_OVERRIDE" ] && args+=(--model "$AGENT_MODEL_OVERRIDE")'
assert_tdd_contains "Stage 0 pasa el modelo resuelto al runner (a diferencia de antes de #1362)" 'invoke_agent_once "domain-scaffolder" "$SCAFFOLD_PROMPT_FILE" "$EVENTS_SCAFFOLD" "$LOG_SCAFFOLD" "$RESOLVED_TDD_MODEL"'
assert_tdd_contains "Stage 0 resuelve via la tabla y el helper" 'resolve_tdd_model "domain-scaffolder" "domain-scaffolder" "$(_tdd_agent_profile "domain-scaffolder")"'

echo ""
echo "[10c] tdd: las remediaciones preservan la cadena fina via resolve_tdd_model (CA-2, CA-3)"
assert_tdd_contains "4b deriva el perfil de la misma tabla que el Stage 1" 'PATCH_TW_PROFILE="$(_tdd_agent_profile "$STAGE1_AGENT")"'
assert_tdd_contains "4b resuelve con la clave fina y el fallback del agente relanzado" 'resolve_tdd_model "patch-test-writer" "$STAGE1_AGENT" "$PATCH_TW_PROFILE"'
assert_tdd_contains "4b toma el modelo resuelto de RESOLVED_TDD_MODEL" 'PATCH_TW_MODEL_OVERRIDE="$RESOLVED_TDD_MODEL"'
assert_tdd_contains "4b pasa el override como valor opcional al helper neutral" '"$PATCH_TW_MODEL_OVERRIDE" "$PATCH_TW_EFFORT_OVERRIDE" || CG_TW_EXIT=$?'
assert_tdd_contains "4b anuncia el modelo resuelto antes de invocar" 'log "Invocando $STAGE1_AGENT (modelo: ${PATCH_TW_MODEL_OVERRIDE:-<heredado>})..."'
assert_tdd_contains "4b usa el helper neutral" 'invoke_agent_once "$STAGE1_AGENT" "$PATCH_TW_PROMPT_FILE" "$EVENTS_CG_TW" "$LOG_CG_TW" "$PATCH_TW_MODEL_OVERRIDE"'
assert_tdd_contains "4c deriva el perfil de la misma tabla que el Stage 2" 'PATCH_IM_PROFILE="$(_tdd_agent_profile "$STAGE2_AGENT")"'
assert_tdd_contains "4c resuelve con la clave fina y el fallback del agente relanzado" 'resolve_tdd_model "patch-implementer" "$STAGE2_AGENT" "$PATCH_IM_PROFILE"'
assert_tdd_contains "4c toma el modelo resuelto de RESOLVED_TDD_MODEL" 'PATCH_IM_MODEL_OVERRIDE="$RESOLVED_TDD_MODEL"'
assert_tdd_contains "4c pasa el override como valor opcional al helper neutral" '"$PATCH_IM_MODEL_OVERRIDE" "$PATCH_IM_EFFORT_OVERRIDE" || CG_IM_EXIT=$?'
assert_tdd_contains "4c anuncia el modelo resuelto antes de invocar" 'log "Invocando $STAGE2_AGENT (modelo: ${PATCH_IM_MODEL_OVERRIDE:-<heredado>})..."'
assert_tdd_contains "4c usa el helper neutral" 'invoke_agent_once "$STAGE2_AGENT" "$PATCH_IM_PROMPT_FILE" "$EVENTS_CG_IM" "$LOG_CG_IM" "$PATCH_IM_MODEL_OVERRIDE"'
assert_tdd_count "resolve_tdd_model se invoca exactamente una vez por camino (run_agent, scaffold, 4b, 4c)" 4 'resolve_tdd_model "'
assert_tdd_count "solo la tabla imprime el literal del perfil balanced (ningun callsite lo repite)" 1 "printf 'balanced'"
assert_tdd_count "solo la tabla imprime el literal del perfil deep (ningun callsite lo repite)" 1 "printf 'deep'"

echo ""
echo "[10f] tdd: resolve_tdd_model ejecutable bajo runtime-fake (CA-5)"
# Extrae la funcion real publicada (mismo patron que test-tooling-neutral-runner.sh
# para log_agent_model_invocation/run_agent): el argv y la precedencia los
# deriva la funcion misma, los dobles solo reemplazan sus dependencias externas.
TDD_MODEL_FN_SRC="$(awk '/^resolve_tdd_model\(\) \{/{p=1} p{print} p && /^}/{p=0}' "$TDD_PIPELINE")"
if [ -z "$TDD_MODEL_FN_SRC" ]; then
    fail "no se pudo extraer resolve_tdd_model de $TDD_PIPELINE"
else
    pass "resolve_tdd_model se extrae con awk"
fi

TDD_MODEL_TMP="$(mktemp -d)"
export MEFISTO_RUNTIME_LIB_DIR="$REPO_ROOT/src/runtime/lib"
export MEFISTO_MODELS_VALIDATOR="$REPO_ROOT/src/runtime/contract/models.validate.jq"
# shellcheck source=/dev/null
source "$REPO_ROOT/src/runtime/lib/mefisto-models.sh"
run_resolve_tdd_model() {
    local key="$1" agent_id="$2" profile="$3"
    EVENTS_LOG_ABS="$TDD_MODEL_TMP/events.log"
    : > "$EVENTS_LOG_ABS"
    ABORT_CALLED=false
    ABORT_MSG=""
    abort() { ABORT_CALLED=true; ABORT_MSG="$1"; return 1; }
    RESOLVED_TDD_MODEL=""
    eval "$TDD_MODEL_FN_SRC"
    resolve_tdd_model "$key" "$agent_id" "$profile"
}

echo "  [perfil default por agente]"
parse_stage_models "" >/dev/null
MEFISTO_RUNTIME_RESUELTO=fake CONSUMER_MODELS_FILE="$TDD_MODEL_TMP/sin-mapping.json" MEFISTO_FAKE_DEFAULT_MODEL=modelo-x \
    run_resolve_tdd_model "test-writer" "test-writer" "balanced"
if [ "$RESOLVED_TDD_MODEL" = "modelo-x" ]; then pass "sin override ni mapping, resuelve al default fake (MEFISTO_FAKE_DEFAULT_MODEL)"; else fail "deberia resolver 'modelo-x' (obtenido '$RESOLVED_TDD_MODEL')"; fi
if grep -qF "MODELS: test-writer runtime=fake perfil=balanced solicitado=<automatico> resuelto='modelo-x'" "$EVENTS_LOG_ABS"; then pass "deja evidencia automatica en events.log"; else fail "no dejo la evidencia esperada: $(cat "$EVENTS_LOG_ABS")"; fi

echo "  [override exacto]"
parse_stage_models "reviewer=modelo-override" >/dev/null
MEFISTO_RUNTIME_RESUELTO=fake CONSUMER_MODELS_FILE="$TDD_MODEL_TMP/sin-mapping.json" MEFISTO_FAKE_DEFAULT_MODEL=modelo-x \
    run_resolve_tdd_model "reviewer" "reviewer" "deep"
if [ "$RESOLVED_TDD_MODEL" = "modelo-override" ]; then pass "el override --models gana por clave exacta"; else fail "deberia resolver 'modelo-override' (obtenido '$RESOLVED_TDD_MODEL')"; fi
if grep -qF "MODELS: reviewer runtime=fake perfil=deep solicitado='modelo-override' resuelto='modelo-override' (override --models)" "$EVENTS_LOG_ABS"; then pass "deja evidencia de override en events.log"; else fail "no dejo la evidencia esperada: $(cat "$EVENTS_LOG_ABS")"; fi

echo "  [cadena fina patch-test-writer]"
parse_stage_models "test-writer=modelo-agente" >/dev/null
MEFISTO_RUNTIME_RESUELTO=fake CONSUMER_MODELS_FILE="$TDD_MODEL_TMP/sin-mapping.json" MEFISTO_FAKE_DEFAULT_MODEL=modelo-x \
    run_resolve_tdd_model "patch-test-writer" "test-writer" "balanced"
if [ "$RESOLVED_TDD_MODEL" = "modelo-agente" ]; then pass "sin clave fina, hereda el override de 'test-writer' (agent_id)"; else fail "deberia heredar 'modelo-agente' (obtenido '$RESOLVED_TDD_MODEL')"; fi

parse_stage_models "test-writer=modelo-agente,patch-test-writer=modelo-fino" >/dev/null
MEFISTO_RUNTIME_RESUELTO=fake CONSUMER_MODELS_FILE="$TDD_MODEL_TMP/sin-mapping.json" MEFISTO_FAKE_DEFAULT_MODEL=modelo-x \
    run_resolve_tdd_model "patch-test-writer" "test-writer" "balanced"
if [ "$RESOLVED_TDD_MODEL" = "modelo-fino" ]; then pass "la clave fina 'patch-test-writer' gana sobre la heredada de 'test-writer'"; else fail "deberia ganar 'modelo-fino' (obtenido '$RESOLVED_TDD_MODEL')"; fi

echo "  [mapping del consumidor: agents.<id> gana a profiles.<perfil>]"
CONSUMER_MAPPING="$TDD_MODEL_TMP/models.json"
cat > "$CONSUMER_MAPPING" <<'JSON'
{"fake": {"profiles": {"balanced": "modelo-perfil"}, "agents": {"test-writer": "modelo-agente-mapping"}}}
JSON
parse_stage_models "" >/dev/null
MEFISTO_RUNTIME_RESUELTO=fake CONSUMER_MODELS_FILE="$CONSUMER_MAPPING" MEFISTO_FAKE_DEFAULT_MODEL=modelo-x \
    run_resolve_tdd_model "test-writer" "test-writer" "balanced"
if [ "$RESOLVED_TDD_MODEL" = "modelo-agente-mapping" ]; then pass "agents.<id> del mapping del consumidor gana a profiles.<perfil>"; else fail "deberia resolver 'modelo-agente-mapping' (obtenido '$RESOLVED_TDD_MODEL')"; fi
MEFISTO_RUNTIME_RESUELTO=fake CONSUMER_MODELS_FILE="$CONSUMER_MAPPING" MEFISTO_FAKE_DEFAULT_MODEL=modelo-x \
    run_resolve_tdd_model "implementer" "implementer" "balanced"
if [ "$RESOLVED_TDD_MODEL" = "modelo-perfil" ]; then pass "sin agents.<id>, cae a profiles.<perfil> del mapping"; else fail "deberia resolver 'modelo-perfil' (obtenido '$RESOLVED_TDD_MODEL')"; fi

echo "  [heredado]"
parse_stage_models "" >/dev/null
MEFISTO_RUNTIME_RESUELTO=fake CONSUMER_MODELS_FILE="$TDD_MODEL_TMP/sin-mapping.json" MEFISTO_FAKE_DEFAULT_MODEL="" \
    run_resolve_tdd_model "implementer" "implementer" "balanced"
if [ -z "$RESOLVED_TDD_MODEL" ]; then pass "sin mapping y sin default del adaptador, resuelve a vacio (heredar, sin --model)"; else fail "deberia resolver vacio (obtenido '$RESOLVED_TDD_MODEL')"; fi
if grep -qF "resuelto='<heredado>'" "$EVENTS_LOG_ABS"; then pass "la evidencia muestra <heredado> cuando no hay modelo"; else fail "no mostro <heredado>: $(cat "$EVENTS_LOG_ABS")"; fi

echo "  [fallo de resolucion: perfil invalido aborta]"
parse_stage_models "" >/dev/null
# El doble de abort() retorna en vez de terminar el proceso (el real hace exit),
# asi que la funcion sigue corriendo y hace cat sobre el temporal ya borrado:
# ese stderr es ruido esperado de la simulacion, no un fallo del pipeline.
MEFISTO_RUNTIME_RESUELTO=fake CONSUMER_MODELS_FILE="$TDD_MODEL_TMP/sin-mapping.json" MEFISTO_FAKE_DEFAULT_MODEL=modelo-x \
    run_resolve_tdd_model "implementer" "implementer" "perfil-invalido" 2>/dev/null || true
if [ "$ABORT_CALLED" = true ]; then pass "perfil fuera del vocabulario fast|balanced|deep aborta"; else fail "deberia haber abortado (RESOLVED_TDD_MODEL='$RESOLVED_TDD_MODEL')"; fi
if printf '%s' "$ABORT_MSG" | grep -q "No se pudo resolver el modelo de implementer"; then pass "el mensaje de abort nombra el agente y el perfil"; else fail "mensaje de abort inesperado: $ABORT_MSG"; fi

unset -f abort 2>/dev/null || true
rm -rf "$TDD_MODEL_TMP"

echo ""
echo "[10g] tdd: la tabla agente->perfil no diverge de src/published/agents/*.md (CA-6)"
# Tolerante a fuentes aun no migradas (#1369-#1372): solo cruza los agentes
# cuyo src/published/agents/<id>.md ya existe. Cuando los 7 existan (ya es el
# caso hoy), este bloque los cubre completos sin depender de esos issues.
frontmatter() { awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$1"; }
TDD_TABLE_AGENTS=(test-writer projection-test-writer implementer projection-implementer smoke-test-writer domain-scaffolder reviewer)
TDD_TABLE_PROFILES=(balanced balanced balanced balanced balanced balanced deep)
TDD_TABLE_CHECKED=0
for index in "${!TDD_TABLE_AGENTS[@]}"; do
    agent="${TDD_TABLE_AGENTS[$index]}"
    expected_profile="${TDD_TABLE_PROFILES[$index]}"
    source="$REPO_ROOT/src/published/agents/$agent.md"
    [ -f "$source" ] || continue
    TDD_TABLE_CHECKED=$((TDD_TABLE_CHECKED + 1))
    actual_profile="$(frontmatter "$source" | jq -r '.profile // empty' 2>/dev/null)"
    if [ "$actual_profile" = "$expected_profile" ]; then
        pass "$agent: tabla de tdd ($expected_profile) coincide con .profile de la fuente neutral"
    else
        fail "$agent: tabla de tdd dice '$expected_profile' pero src/published/agents/$agent.md declara '$actual_profile'"
    fi
done
if [ "$TDD_TABLE_CHECKED" -eq "${#TDD_TABLE_AGENTS[@]}" ]; then
    pass "los 7 agentes de la tabla ya tienen fuente neutral publicada (cobertura completa)"
else
    echo "  (info: $TDD_TABLE_CHECKED/${#TDD_TABLE_AGENTS[@]} agentes con fuente neutral publicada -- el resto migra en #1369-#1372)"
fi

# --- iac-pipeline.sh: default heredado observable sin override ----------------
IAC_PIPELINE="$REPO_ROOT/scripts/iac-pipeline.sh"
IAC_CONTENT=$(cat "$IAC_PIPELINE")

assert_iac_contains() {
    local description="$1" expected="$2"
    case "$IAC_CONTENT" in
        *"$expected"*) pass "$description" ;;
        *) fail "$description -- no se encontro: $expected" ;;
    esac
}

assert_iac_count() {
    local description="$1" expected="$2" needle="$3" actual
    actual=$(grep -cF -- "$needle" "$IAC_PIPELINE" || true)
    if [ "$actual" -eq "$expected" ]; then
        pass "$description"
    else
        fail "$description -- esperado $expected, obtenido $actual: $needle"
    fi
}

assert_iac_order() {
    local description="$1" first="$2" second="$3" first_line second_line
    first_line=$(grep -nF -- "$first" "$IAC_PIPELINE" | cut -d: -f1 | head -n1)
    second_line=$(grep -nF -- "$second" "$IAC_PIPELINE" | cut -d: -f1 | head -n1)
    if [ -n "$first_line" ] && [ -n "$second_line" ] && [ "$first_line" -lt "$second_line" ]; then
        pass "$description"
    else
        fail "$description -- orden obtenido: '${first:-ausente}'=$first_line, '${second:-ausente}'=$second_line"
    fi
}

echo ""
echo "[10d] iac: resuelve el modelo neutral por perfil de cada stage (issue #1624)"
assert_iac_contains "infra-writer resuelve con perfil balanced" 'resolve_infra_model infra-writer balanced'
assert_iac_contains "infra-reviewer resuelve con perfil deep" 'resolve_infra_model infra-reviewer deep'
assert_iac_contains "resolve_infra_model usa el helper neutral compartido" 'mefisto_resolve_model "$MEFISTO_RUNTIME_RESUELTO" "$agent_id" "$profile" "" "$CONSUMER_MODELS_FILE"'
assert_iac_contains "resolve_infra_model aborta si la resolucion del adaptador falla" 'abort "No se pudo resolver el modelo de $agent_id (perfil $profile): ${MEFISTO_MODELS_ERROR:-motivo desconocido}"'
assert_iac_contains "run_agent anuncia el modelo resuelto o heredado" 'log "Invocando $agent (modelo: ${model:-<heredado>})..."'
assert_iac_contains "run_agent conserva el argv condicional --model" '[ -n "$model" ] && args+=(--model "$model")'
assert_iac_contains "run_agent conserva el argv neutral con agente y cwd" '--agent "$agent" --cwd "$WORKTREE_PATH"'
assert_iac_contains "Stage 1 conserva infra-writer" 'run_agent "1" "infra-writer" "$STAGE1_PROMPT"'
assert_iac_contains "Stage 2 conserva infra-reviewer" 'run_agent "2" "infra-reviewer" "$STAGE2_PROMPT"'
assert_iac_order "resuelve ambos modelos antes de descargar el issue" 'resolve_infra_model infra-reviewer deep' 'log "Descargando issue #$ISSUE_NUM...'
assert_iac_order "run_agent resuelve el modelo del agente antes de anunciarlo" 'model="$MODEL_REVIEWER"' 'log "Invocando $agent (modelo: ${model:-<heredado>})..."'
assert_iac_count "run_agent anuncia el modelo una sola vez por stage" 1 'log "Invocando $agent (modelo: ${model:-<heredado>})..."'
assert_iac_count "un solo punto de armado de argv (initial y sondas de hold comparten el mismo bucle)" 1 '--agent "$agent" --cwd "$WORKTREE_PATH"'

# --- scaffold-pipeline.sh: modelo declarado sin override -----------------------
SCAFFOLD_PIPELINE="$REPO_ROOT/scripts/scaffold-pipeline.sh"
SCAFFOLD_CONTENT=$(cat "$SCAFFOLD_PIPELINE")

assert_scaffold_contains() {
    local description="$1" expected="$2"
    case "$SCAFFOLD_CONTENT" in
        *"$expected"*) pass "$description" ;;
        *) fail "$description -- no se encontro: $expected" ;;
    esac
}

assert_scaffold_count() {
    local description="$1" expected="$2" needle="$3" actual
    actual=$(grep -cF -- "$needle" "$SCAFFOLD_PIPELINE" || true)
    if [ "$actual" -eq "$expected" ]; then
        pass "$description"
    else
        fail "$description -- esperado $expected, obtenido $actual: $needle"
    fi
}

assert_scaffold_order() {
    local description="$1" first="$2" second="$3" first_line second_line
    first_line=$(grep -nF -- "$first" "$SCAFFOLD_PIPELINE" | cut -d: -f1 | head -n1)
    second_line=$(grep -nF -- "$second" "$SCAFFOLD_PIPELINE" | cut -d: -f1 | head -n1)
    if [ -n "$first_line" ] && [ -n "$second_line" ] && [ "$first_line" -lt "$second_line" ]; then
        pass "$description"
    else
        fail "$description -- orden obtenido: '${first:-ausente}'=$first_line, '${second:-ausente}'=$second_line"
    fi
}

echo ""
echo "[10e] scaffold: resuelve el modelo neutral por perfil (issue #1644)"
assert_scaffold_contains "domain-scaffolder resuelve con perfil balanced" 'mefisto_resolve_model "$MEFISTO_RUNTIME_RESUELTO" "domain-scaffolder" "balanced" "" "$CONSUMER_MODELS_FILE"'
assert_scaffold_contains "aborta si la resolucion del adaptador falla" 'abort "No se pudo resolver el modelo de domain-scaffolder (perfil balanced): ${MEFISTO_MODELS_ERROR:-motivo desconocido}"'
assert_scaffold_contains "anuncia el modelo resuelto o heredado en el encabezado" 'header "Invocando domain-scaffolder (modelo: ${SCAFFOLD_AGENT_MODEL:-<heredado>})..."'
assert_scaffold_contains "persiste evidencia con el formato canonico" 'MODELS: domain-scaffolder runtime=$MEFISTO_RUNTIME_RESUELTO perfil=balanced solicitado=<automatico> resuelto='
assert_scaffold_contains "run_scaffold_agent conserva el argv condicional --model" '[ -n "$SCAFFOLD_AGENT_MODEL" ] && args+=(--model "$SCAFFOLD_AGENT_MODEL")'
assert_scaffold_contains "run_scaffold_agent conserva el argv neutral con agente y cwd" '--agent domain-scaffolder --cwd "$WORKTREE_PATH"'
assert_scaffold_order "resuelve el modelo antes de anunciarlo" 'mefisto_resolve_model "$MEFISTO_RUNTIME_RESUELTO" "domain-scaffolder" "balanced" "" "$CONSUMER_MODELS_FILE"' 'header "Invocando domain-scaffolder (modelo: ${SCAFFOLD_AGENT_MODEL:-<heredado>})..."'
assert_scaffold_order "registra evidencia durable antes del primer argv del runner" 'MODELS: domain-scaffolder runtime=$MEFISTO_RUNTIME_RESUELTO' '--agent domain-scaffolder --cwd "$WORKTREE_PATH"'
assert_scaffold_count "emite una sola evidencia durable, incluso con sondas de hold" 1 'MODELS: domain-scaffolder runtime=$MEFISTO_RUNTIME_RESUELTO'
assert_scaffold_count "un solo punto de armado de argv (intento y sondas de hold comparten el mismo bucle)" 1 '--agent domain-scaffolder --cwd "$WORKTREE_PATH"'
SCAFFOLD_MODEL_ARG_COUNT=$(grep -cF -- '[ -n "$SCAFFOLD_AGENT_MODEL" ] && args+=(--model "$SCAFFOLD_AGENT_MODEL")' "$SCAFFOLD_PIPELINE" || true)
if [ "$SCAFFOLD_MODEL_ARG_COUNT" -eq 1 ]; then
    pass "scaffold agrega --model condicionalmente una sola vez (intento y sondas comparten el mismo bucle)"
else
    fail "se esperaba 1 punto de armado condicional de --model, obtenidos $SCAFFOLD_MODEL_ARG_COUNT"
fi

# --- launch-pipeline.sh: reenvio/rechazo de --models por modo (CA-3) ---------
#
# Mismo arnes que test-launch-preparse.sh: consumidor falso (git init sin
# .claude-plugin/plugin.json) para pasar el guard defensivo y MEFISTO_UI=mod
# para no delegar a la interfaz herdr si el test corre dentro de un pane herdr.
export MEFISTO_UI=mod

FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN"

(cd "$FAKE_CONSUMER" && git init -q)

# Copia del paquete con sub-pipelines stub que imprimen su argv, un argumento
# por <>: el report log de cada corrida desacoplada deja ver que recibieron.
LAUNCH_PKG="$TMP_DIR/pkg"
mkdir -p "$LAUNCH_PKG/scripts" "$LAUNCH_PKG/src"
cp "$REPO_ROOT"/scripts/*.sh "$LAUNCH_PKG/scripts/"
ln -s "$REPO_ROOT/src/runtime" "$LAUNCH_PKG/src/runtime"
for s in tdd tooling iac scaffold batch parallel; do
    cat > "$LAUNCH_PKG/scripts/$s-pipeline.sh" <<STUB
#!/usr/bin/env bash
printf 'stub $s'; printf ' <%s>' "\$@"; echo
STUB
done
chmod +x "$LAUNCH_PKG"/scripts/*.sh
LAUNCH_SCRIPT="$LAUNCH_PKG/scripts/launch-pipeline.sh"

LAST_STDOUT=""
LAST_STDERR=""
LAST_RC=0

run_wrapper() {
    find "$FAKE_CONSUMER" -name '*.report.log' -delete 2>/dev/null
    local out="$TMP_DIR/stdout" err="$TMP_DIR/stderr"
    (
        cd "$FAKE_CONSUMER" || exit 99
        # Hermetico: el pipeline exporta estas rutas y desviarian el estado fuera del consumidor falso.
        unset MEFISTO_STATE_DIR MEFISTO_LEGACY_STATE_DIR MEFISTO_REPO_ROOT MEFISTO_MODELS_FILE
        MEFISTO_RUNTIME=claude "$LAUNCH_SCRIPT" "$@"
    ) </dev/null >"$out" 2>"$err"
    LAST_RC=$?
    LAST_STDOUT=$(cat "$out")
    LAST_STDERR=$(cat "$err")
}

# launched_argv <prefijo>: argv que recibio el sub-pipeline de la corrida
# <prefijo>-run-*.report.log, esperando a que el proceso desacoplado lo escriba.
launched_argv() {
    local i=0 f=""
    while [ $i -lt 50 ]; do
        f=$(find "$FAKE_CONSUMER" -name "$1-run-*.report.log" -size +0 2>/dev/null | head -n1)
        [ -n "$f" ] && break
        sleep 0.1
        i=$((i+1))
    done
    [ -n "$f" ] && cat "$f"
}

echo ""
echo "[11] --tooling reenvia --models intacto al sub-pipeline (CA-3)"
run_wrapper --tooling 253 --models "writer=sonnet,reviewer=opus"
if [ "$LAST_RC" -eq 0 ]; then pass "--tooling + --models corre sin abortar (rc=$LAST_RC)"; else fail "--tooling + --models no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
ARGV="$(launched_argv tooling-issue-253)"
if printf '%s' "$ARGV" | grep -qF "stub tooling <253> <--models> <writer=sonnet,reviewer=opus>"; then
    pass "tooling-pipeline.sh recibe el issue y --models con el valor intacto"
else
    fail "tooling-pipeline.sh no recibio '253 --models ...' -- argv: $ARGV"
fi
run_wrapper --tooling 253 --models "writer=claude-opus-5[1m]"
ARGV="$(launched_argv tooling-issue-253)"
if printf '%s' "$ARGV" | grep -qF "stub tooling <253> <--models> <writer=claude-opus-5[1m]>"; then
    pass "un id de modelo con corchetes llega literal (sin expansion de glob)"
else
    fail "el id con corchetes no llego literal -- argv: $ARGV"
fi

echo ""
echo "[12] --tooling combina --from-stage y --models en orden"
run_wrapper --tooling 253 --from-stage 2 --models "reviewer=opus"
if [ "$LAST_RC" -eq 0 ]; then pass "combinado corre sin abortar"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
ARGV="$(launched_argv tooling-issue-253)"
if printf '%s' "$ARGV" | grep -qF "stub tooling <253> <--from-stage> <2> <--models> <reviewer=opus>"; then
    pass "tooling-pipeline.sh recibe --from-stage y --models en orden"
else
    fail "orden incorrecto -- argv: $ARGV"
fi

echo ""
echo "[13] --models sin valor aborta con mensaje claro"
run_wrapper --tooling 253 --models
if [ "$LAST_RC" -eq 1 ]; then pass "--models sin valor aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "Falta el valor de --models"; then pass "mensaje: falta el valor"; else fail "mensaje inesperado: $LAST_STDERR"; fi

echo ""
echo "[14] --models se rechaza (nunca se traga en silencio) en modos sin soporte todavia"

run_wrapper --infra 253 --models "writer=sonnet"
if [ "$LAST_RC" -eq 1 ]; then pass "--infra + --models aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "no es valido con --infra"; then pass "mensaje: no valido con --infra"; else fail "mensaje inesperado: $LAST_STDERR"; fi

run_wrapper --scaffold 253 --domain miDominio --models "writer=sonnet"
if [ "$LAST_RC" -eq 1 ]; then pass "--scaffold + --models aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "no es valido con --scaffold"; then pass "mensaje: no valido con --scaffold"; else fail "mensaje inesperado: $LAST_STDERR"; fi

run_wrapper --batch 253 254 --models "writer=sonnet" --pipeline tooling
if [ "$LAST_RC" -eq 1 ]; then pass "--batch + --models aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "no es valido con --batch"; then pass "mensaje: no valido con --batch"; else fail "mensaje inesperado: $LAST_STDERR"; fi

run_wrapper --parallel 253 254 --models "writer=sonnet" --pipeline tooling
if [ "$LAST_RC" -eq 1 ]; then pass "--parallel + --models aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "no es valido con --parallel"; then pass "mensaje: no valido con --parallel"; else fail "mensaje inesperado: $LAST_STDERR"; fi

echo ""
echo "[14b] issue suelto (sin --tooling), enrutado por --pipeline, reenvia --models (issue #712)"

run_wrapper 253 --models "writer=sonnet" --pipeline tooling
if [ "$LAST_RC" -eq 0 ]; then pass "issue suelto + --pipeline tooling + --models corre sin abortar"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
ARGV="$(launched_argv tooling-pipeline-issue-253)"
if printf '%s' "$ARGV" | grep -qF "stub tooling <253> <--models> <writer=sonnet>"; then
    pass "--models llega a tooling-pipeline.sh"
else
    fail "--models no llego a tooling-pipeline.sh -- argv: $ARGV"
fi

run_wrapper 253 --models "test-writer=sonnet,reviewer=opus" --pipeline tdd
if [ "$LAST_RC" -eq 0 ]; then pass "issue suelto + --pipeline tdd + --models corre sin abortar"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
ARGV="$(launched_argv tdd-pipeline-issue-253)"
if printf '%s' "$ARGV" | grep -qF "stub tdd <253> <--models> <test-writer=sonnet,reviewer=opus>"; then
    pass "--models llega a tdd-pipeline.sh"
else
    fail "--models no llego a tdd-pipeline.sh -- argv: $ARGV"
fi

# --- herdr-pipeline.sh: la otra mitad de CA-3 --------------------------------
#
# Dentro de un pane herdr, launch-pipeline.sh hace `exec herdr-pipeline.sh "$@"`
# ANTES de su propio pre-parseo: si herdr-pipeline.sh no conoce --models, el
# flag cae en filtered_args y el dispatch de --tooling (que solo reenvia "$1")
# lo descarta en silencio -- la corrida usaria los modelos default mientras el
# reporte del experimento le atribuye el resultado al override.
#
# Arnes de test-herdr-parallel.sh: stub de `herdr` que registra cada invocacion
# y responde JSON determinista, stub de `gh`, y contexto HERDR_* falso.

export HERDR_STUB_LOG="$TMP_DIR/herdr-invocations.log"
export HERDR_STUB_COUNTER="$TMP_DIR/herdr-pane-counter"
HERDR_SCRIPT="$REPO_ROOT/scripts/herdr-pipeline.sh"

cat > "$FAKE_BIN/herdr" <<'STUB'
#!/usr/bin/env bash
set -u
echo "herdr $*" >> "$HERDR_STUB_LOG"
case "${1:-} ${2:-}" in
    "pane split")
        n=$(cat "$HERDR_STUB_COUNTER" 2>/dev/null || echo 0)
        n=$((n + 1))
        echo "$n" > "$HERDR_STUB_COUNTER"
        echo "{\"result\":{\"pane\":{\"pane_id\":\"w1:p$n\"}}}"
        ;;
    "pane get")
        echo '{"result":{"pane":{"pane_id":"stub"}}}'
        ;;
    "pane process-info")
        # Issue #2285: el guard de pane propio exige que el wrapper descienda del
        # shell_pid del pane despachante (HERDR_PANE_ID); se reporta el PID del test.
        if [ -n "${HERDR_STUB_OWNER_PID:-}" ] && [ "${4:-}" = "${HERDR_PANE_ID:-}" ]; then
            echo "{\"result\":{\"process_info\":{\"shell_pid\":$HERDR_STUB_OWNER_PID,\"foreground_process_group_id\":$HERDR_STUB_OWNER_PID}}}"
            exit 0
        fi
        echo '{"result":{"process_info":{"shell_pid":100,"foreground_process_group_id":100}}}'
        ;;
    "pane run")
        # Simula que el shell del pane ejecuto la linea: toca el
        # --started-marker para que el despacho confirme sin esperar el
        # timeout real (issue #1563).
        marker=$(printf '%s\n' "${4:-}" | grep -oE -- '--started-marker [^[:space:]]+' | awk '{print $2}')
        if [ -n "$marker" ]; then
            mkdir -p "$(dirname "$marker")" 2>/dev/null
            : > "$marker"
        fi
        echo '{"result":{"type":"ok"}}'
        ;;
    *)
        echo '{"result":{"type":"ok"}}'
        ;;
esac
STUB
chmod +x "$FAKE_BIN/herdr"

cat > "$FAKE_BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -u
case "${3:-}" in
    253|254) printf 'OPEN|tipo:tooling\n' ;;
    *)       exit 1 ;;
esac
STUB
chmod +x "$FAKE_BIN/gh"

run_herdr() {
    : > "$HERDR_STUB_LOG"
    echo 0 > "$HERDR_STUB_COUNTER"
    local out="$TMP_DIR/stdout" err="$TMP_DIR/stderr"
    (
        cd "$FAKE_CONSUMER" || exit 99
        env -u MEFISTO_UI \
            PATH="$FAKE_BIN:$PATH" \
            HERDR_ENV=1 HERDR_PANE_ID="w1:p0" HERDR_WORKSPACE_ID="w1" \
            HERDR_STUB_LOG="$HERDR_STUB_LOG" HERDR_STUB_COUNTER="$HERDR_STUB_COUNTER" \
            "$HERDR_SCRIPT" "$@"
    ) </dev/null >"$out" 2>"$err"
    LAST_RC=$?
    LAST_STDOUT=$(cat "$out")
    LAST_STDERR=$(cat "$err")
}

echo ""
echo "[15] herdr: --tooling reenvia --models al pane run (CA-3 dentro de herdr)"
run_herdr --tooling 253 --models "writer=sonnet,reviewer=opus"
HERDR_CALLS=$(cat "$HERDR_STUB_LOG")
if [ "$LAST_RC" -eq 0 ]; then pass "--tooling + --models corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
# build_pane_runner_cmdline quotea cada argv con printf %q, que escapa la coma
# como '\,' -- el shell del pane la deshace al ejecutar. Se compara contra la
# linea con los backslashes removidos: lo que importa es que el argumento
# --models este y su valor sea el que se paso, no la forma del escape.
HERDR_CALLS_UNQ=$(printf '%s' "$HERDR_CALLS" | tr -d '\\')
if printf '%s' "$HERDR_CALLS_UNQ" | grep -qF -- "--models writer=sonnet,reviewer=opus"; then
    pass "el pane run lleva --models con el valor intacto y SIN comillas literales"
else
    fail "el pane run no lleva --models (se perdio en el dispatch) -- log: $HERDR_CALLS"
fi
if printf '%s' "$HERDR_CALLS" | grep -qF -- "--models 'writer=sonnet,reviewer=opus'"; then
    fail "el valor viaja con comillas simples literales (herdr no re-parsea con un shell, printf %q ya lo quotea)"
else
    pass "sin comillas simples literales en el argv del pane"
fi

echo ""
echo "[16] herdr: --tooling combina --from-stage y --models"
run_herdr --tooling 253 --from-stage 2 --models "reviewer=opus"
HERDR_CALLS=$(cat "$HERDR_STUB_LOG")
if [ "$LAST_RC" -eq 0 ]; then pass "combinado corre sin abortar"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if printf '%s' "$HERDR_CALLS" | grep -qF -- "--from-stage 2" && printf '%s' "$HERDR_CALLS" | grep -qF -- "--models reviewer=opus"; then
    pass "el pane run lleva los dos flags"
else
    fail "falta alguno de los dos flags -- log: $HERDR_CALLS"
fi

echo ""
echo "[17] herdr: un id de modelo con caracteres de glob llega intacto"
run_herdr --tooling 253 --models 'writer=claude-opus-5[1m]'
HERDR_CALLS=$(cat "$HERDR_STUB_LOG")
HERDR_CALLS_UNQ=$(printf '%s' "$HERDR_CALLS" | tr -d '\\')
if printf '%s' "$HERDR_CALLS_UNQ" | grep -qF -- "--models writer=claude-opus-5[1m]"; then
    pass "'claude-opus-5[1m]' sobrevive (no lo toca la pathname expansion)"
else
    fail "el id de modelo se altero -- log: $HERDR_CALLS"
fi

echo ""
echo "[18] herdr: --models sin valor y rechazo por modo (nunca silencio)"
run_herdr --tooling 253 --models
if [ "$LAST_RC" -eq 1 ]; then pass "--models sin valor aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "Falta el valor de --models"; then pass "mensaje: falta el valor"; else fail "mensaje inesperado: $LAST_STDERR"; fi

run_herdr --infra 253 --models "writer=sonnet"
if [ "$LAST_RC" -eq 1 ]; then pass "--infra + --models aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q -- "--infra"; then pass "mensaje: nombra --infra"; else fail "mensaje inesperado: $LAST_STDERR"; fi

run_herdr --parallel 253 254 --models "writer=sonnet" --pipeline tooling
if [ "$LAST_RC" -eq 1 ]; then pass "--parallel + --models aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$(cat "$HERDR_STUB_LOG")" | grep -q "pane run"; then fail "no deberia despachar ningun pane"; else pass "ningun pane despachado"; fi

run_herdr --batch 253 254 --models "writer=sonnet" --pipeline tooling
if [ "$LAST_RC" -eq 1 ]; then pass "--batch + --models aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi

echo ""
echo "[18b] herdr: issue suelto (sin --tooling), enrutado por --pipeline, reenvia --models (issue #712)"
run_herdr 253 --models "writer=sonnet" --pipeline tooling
HERDR_CALLS=$(cat "$HERDR_STUB_LOG")
HERDR_CALLS_UNQ=$(printf '%s' "$HERDR_CALLS" | tr -d '\\')
if [ "$LAST_RC" -eq 0 ]; then pass "issue suelto + --pipeline tooling + --models corre sin abortar"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if printf '%s' "$HERDR_CALLS_UNQ" | grep -qF -- "--models writer=sonnet"; then
    pass "el pane run lleva --models"
else
    fail "el pane run no lleva --models -- log: $HERDR_CALLS"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
