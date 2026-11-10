#!/usr/bin/env bash
# test-iac-pipeline-state-paths.sh -- Regresion de #1626: iac-pipeline.sh
# escribe su estado (logs, status, history, events.log) exclusivamente bajo
# el root canonico que resuelve mefisto_state_path() (MEF-ADR-0053 seccion 4),
# nunca bajo .claude/pipeline. Mismo patron de fixture (repo consumidor +
# origin real + gh/terraform stub + runner stub via MEFISTO_RUN_AGENT_BIN)
# que test-pr-sync-state-paths.sh (#1583) y test-batch-runtime.sh, pero
# corriendo iac-pipeline.sh COMPLETO (no una funcion extraida) porque el
# reparto canonico/legacy solo se observa end-to-end.
#
#   [A] Root canonico (CA-5 a/b): con un fallo duro y no-holdable en
#       infra-reviewer, el log del pipeline, los logs por stage, el status
#       (state: failed), pipeline-history.jsonl (con "runtime") y events.log
#       quedan todos bajo .mefisto/pipeline/; nunca se crea .claude/pipeline/.
#   [B] MEFISTO_STATE_DIR (CA-5c): con el override exportado, todo el estado
#       cae bajo <dir> en vez de la ruta canonica del repo, y el repo no
#       recibe ninguna escritura bajo .mefisto/pipeline/.
#   [C] Hold visible (CA-5d): durante un rate_limit del stub en infra-writer,
#       el status transicionalmente en disco trae state: hold con
#       hold.cause no nulo, antes de que la sonda reanude y el pipeline
#       complete con exito.
#
# Uso: scripts/tests/test-iac-pipeline-state-paths.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PIPELINE_SRC="$REPO_ROOT/scripts/iac-pipeline.sh"
COMMON_LIB="$REPO_ROOT/scripts/_pipeline-common.sh"
RUNTIME_DIR_SRC="$REPO_ROOT/src/runtime"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Mismo criterio que test-batch-runtime.sh/test-batch-stop-signal.sh: solo el
# tramo de sistema (git/coreutils/jq/python3) queda fuera del PATH de stubs.
SAFE_SYSTEM_PATH="/usr/bin:/bin:/usr/sbin:/sbin"

# setup_work_repo <dir>
# Copia la clausura publicada bajo prueba (mismo patron que
# test-batch-runtime.sh): iac-pipeline.sh resuelve src/runtime relativo a su
# propia ubicacion fisica, no al cwd del pipeline.
setup_work_repo() {
    local dir="$1"
    mkdir -p "$dir/scripts" "$dir/src"
    cp "$COMMON_LIB" "$dir/scripts/_pipeline-common.sh"
    cp "$PIPELINE_SRC" "$dir/scripts/iac-pipeline.sh"
    chmod +x "$dir/scripts/iac-pipeline.sh"
    cp -R "$RUNTIME_DIR_SRC" "$dir/src/runtime"
}

# new_origin <bare> <work>
# Origin real (bare) + clon de trabajo con harness.config.json canonico y
# infra/environments/dev/ versionados -- el pipeline exige ambos antes de
# crear el worktree.
new_origin() {
    local bare="$1" work="$2"
    git init -q --bare "$bare"
    git -C "$bare" symbolic-ref HEAD refs/heads/main
    git clone -q "$bare" "$work" 2>/dev/null
    git -C "$work" config user.email "test@mefisto.local"
    git -C "$work" config user.name "Mefisto Test"
    mkdir -p "$work/.mefisto" "$work/infra/environments/dev"
    cat > "$work/.mefisto/harness.config.json" <<'JSON'
{
  "projectName": "TestProject",
  "namespacePrefix": "Test.Namespace",
  "solutionFile": "Test.slnx",
  "domainLabels": ["dom1"],
  "boundedContext": { "name": "TestBC", "domains": ["dom1"] }
}
JSON
    printf '# placeholder\n' > "$work/infra/environments/dev/main.tf"
    git -C "$work" add -A
    git -C "$work" commit -q -m "base"
    git -C "$work" push -q origin main
}

# make_gh_stub <path> <issue_num> <title>
# gh minimo: el issue no trae labels (nunca 'bloqueado'), pr list siempre
# vacio (nunca hay PR previo que reutilizar) y pr create/issue comment/issue
# edit son no-op exitosos.
make_gh_stub() {
    local path="$1" issue_num="$2" title="$3"
    cat > "$path" <<STUB
#!/usr/bin/env bash
case "\$1 \$2" in
    "issue view")
        printf '{"number":%s,"title":"%s","body":"cuerpo de prueba","state":"OPEN","labels":[]}\n' "$issue_num" "$title"
        exit 0 ;;
    "pr list")
        exit 0 ;;
    "pr create")
        printf 'https://example.invalid/pr/%s\n' "$issue_num"
        exit 0 ;;
    "issue comment") exit 0 ;;
    "issue edit") exit 0 ;;
esac
exit 0
STUB
    chmod +x "$path"
}

# make_terraform_stub <path>
# Revision estatica siempre exitosa: el pipeline nunca corre plan/apply
# local (MEF-ADR-0021/0022), asi que el contenido real del HCL es irrelevante
# para este test de rutas de estado.
make_terraform_stub() {
    cat > "$1" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
    chmod +x "$1"
}

# make_claude_stub <path>
# Solo necesita existir en PATH para que runtime_claude_is_available (que
# hace 'command -v claude') resuelva el runtime; el runner real esta
# reemplazado por completo via MEFISTO_RUN_AGENT_BIN.
make_claude_stub() {
    cat > "$1" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
    chmod +x "$1"
}

# make_run_agent_stub <path>
# Reemplaza el runner neutral (mefisto-run-agent.sh) por completo. Controlado
# por dos variables de entorno que el CALLER exporta antes de invocar el
# pipeline (no se hornean en el stub, para reusar el mismo binario en los
# tres escenarios):
#   STUB_STATE_DIR       - directorio de conteo de intentos por agente.
#   STUB_FAIL_AGENT       - si coincide con --agent, falla duro (no-holdable)
#                            en TODOS los intentos.
#   STUB_RATE_LIMIT_AGENT - si coincide con --agent, falla con rate_limit
#                            SOLO en el primer intento; el resto tiene exito.
# En cualquier corrida exitosa, deja el resumen del stage bajo
# .mefisto/pipeline/summaries/ del worktree (--cwd) y, para infra-writer,
# una modificacion real bajo infra/ para que el pipeline tenga algo que
# commitear.
make_run_agent_stub() {
    cat > "$1" <<'STUB'
#!/usr/bin/env bash
set -u
agent="" event_log="" cwd=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --agent) agent="$2"; shift 2 ;;
        --cwd) cwd="$2"; shift 2 ;;
        --event-log) event_log="$2"; shift 2 ;;
        *) shift ;;
    esac
done

mkdir -p "${STUB_STATE_DIR:-/tmp}"
count_file="${STUB_STATE_DIR:-/tmp}/${agent}.count"
n=0
[ -f "$count_file" ] && n=$(cat "$count_file")
n=$((n + 1))
printf '%s' "$n" > "$count_file"

if [ "$agent" = "${STUB_FAIL_AGENT:-}" ]; then
    printf '%s\n' '{"type":"run.failed","status":"failed","session_id":null,"denials":0,"error":{"kind":"api_error"}}' > "$event_log"
    exit 1
fi

if [ "$agent" = "${STUB_RATE_LIMIT_AGENT:-}" ] && [ "$n" -eq 1 ]; then
    printf '%s\n' '{"type":"run.failed","status":"failed","session_id":"sess-hold","denials":0,"error":{"kind":"rate_limit"}}' > "$event_log"
    exit 1
fi

stage_num="1"
[ "$agent" = "infra-reviewer" ] && stage_num="2"
if [ "$agent" = "infra-writer" ]; then
    mkdir -p "$cwd/infra/environments/dev"
    printf '# writer change %s\n' "$n" >> "$cwd/infra/environments/dev/main.tf"
fi
mkdir -p "$cwd/.mefisto/pipeline/summaries"
printf 'Resumen de %s\n' "$agent" > "$cwd/.mefisto/pipeline/summaries/stage-${stage_num}-${agent}.md"

printf '%s\n' '{"type":"run.completed","status":"success","session_id":"sess-ok","denials":0,"error":null}' > "$event_log"
exit 0
STUB
    chmod +x "$1"
}

# run_pipeline <workdir> <bindir> <run_agent_bin> <state_dir> <issue> [VAR=val...]
#
# Invoca iac-pipeline.sh con un entorno LIMPIO (env -i): el proceso que corre
# esta suite hereda variables MEFISTO_* del propio pipeline de tooling que la
# lanzo (MEFISTO_STATE_DIR, MEFISTO_RUNTIME_LIB_DIR, MEFISTO_RUNTIME, ...) --
# sin este aislamiento esas variables heredadas pisarian silenciosamente la
# resolucion bajo prueba en vez de dejar que _pipeline-common.sh la calcule
# desde cero contra <workdir>. Cualquier VAR=val adicional (p. ej.
# STUB_FAIL_AGENT, MEFISTO_STATE_DIR de un override, MEFISTO_HOLD_*) se pasa
# tal cual a 'env'.
run_pipeline() {
    local workdir="$1" bindir="$2" run_agent_bin="$3" state_dir="$4" issue="$5"
    shift 5
    (
        cd "$workdir" || exit 99
        env -i HOME="$HOME" PATH="$bindir:$SAFE_SYSTEM_PATH" \
            MEFISTO_RUNTIME=claude MEFISTO_RUN_AGENT_BIN="$run_agent_bin" \
            STUB_STATE_DIR="$state_dir" \
            "$@" \
            ./scripts/iac-pipeline.sh "$issue" --env dev
    )
}

# ---------------------------------------------------------------------------
# [A] Root canonico: logs/status/history/events bajo .mefisto/pipeline;
#     nunca se crea .claude/pipeline (CA-5 a/b).
# ---------------------------------------------------------------------------
echo "[A] Root canonico: estado bajo .mefisto/pipeline, sin .claude/pipeline"

WORK_A="$TMP_DIR/work-a"
new_origin "$TMP_DIR/origin-a.git" "$WORK_A"
setup_work_repo "$WORK_A"

BIN_A="$TMP_DIR/bin-a"
mkdir -p "$BIN_A"
make_gh_stub "$BIN_A/gh" 9001 "Issue de prueba A"
make_terraform_stub "$BIN_A/terraform"
make_claude_stub "$BIN_A/claude"
RUN_AGENT_STUB_A="$TMP_DIR/run-agent-a.sh"
make_run_agent_stub "$RUN_AGENT_STUB_A"
STATE_A="$TMP_DIR/stub-state-a"; mkdir -p "$STATE_A"

run_pipeline "$WORK_A" "$BIN_A" "$RUN_AGENT_STUB_A" "$STATE_A" 9001 \
    STUB_FAIL_AGENT=infra-reviewer \
    </dev/null >"$TMP_DIR/stdout-a" 2>"$TMP_DIR/stderr-a"
RC_A=$?

if [ "$RC_A" -ne 0 ]; then
    pass "el fallo duro de infra-reviewer aborta con exit != 0"
else
    fail "se esperaba exit != 0. stdout: $(cat "$TMP_DIR/stdout-a")"
fi

CANON_A="$WORK_A/.mefisto/pipeline"
if ls "$CANON_A"/logs/iac-pipeline-*.log >/dev/null 2>&1; then
    pass "log principal bajo .mefisto/pipeline/logs/"
else
    fail "no se encontro iac-pipeline-*.log bajo $CANON_A/logs/"
fi

if ls "$CANON_A"/logs/iac-stage-1-infra-writer-*.log >/dev/null 2>&1 \
    && ls "$CANON_A"/logs/iac-stage-2-infra-reviewer-*.log >/dev/null 2>&1; then
    pass "logs por stage (writer y reviewer) bajo .mefisto/pipeline/logs/"
else
    fail "faltan logs por stage bajo $CANON_A/logs/: $(ls "$CANON_A/logs" 2>/dev/null)"
fi

STATUS_A="$CANON_A/pipeline-status-infra-9001.json"
if [ -f "$STATUS_A" ]; then
    pass "status pipeline-status-infra-9001.json presente (la corrida fallo, nunca se borra)"
    if [ "$(jq -r '.state' "$STATUS_A")" = "failed" ]; then
        pass "status.state == failed (nunca queda 'running')"
    else
        fail "status.state inesperado: $(jq -r '.state' "$STATUS_A")"
    fi
    if [ "$(jq -r '.runtime' "$STATUS_A")" = "claude" ]; then
        pass "status.runtime == claude"
    else
        fail "status.runtime inesperado: $(jq -r '.runtime' "$STATUS_A")"
    fi
    if jq -e '.identity | type == "object"' "$STATUS_A" >/dev/null 2>&1; then
        pass "status.identity es un objeto (esquema de tooling-pipeline.sh)"
    else
        fail "status.identity no es un objeto: $(jq -c '.identity' "$STATUS_A")"
    fi
    if jq -e '.hold | has("cause") and has("next_probe") and has("ceiling_seconds") and has("accumulated_seconds")' "$STATUS_A" >/dev/null 2>&1; then
        pass "status.hold trae las 4 claves del esquema (cause/next_probe/ceiling_seconds/accumulated_seconds)"
    else
        fail "status.hold no trae el esquema esperado: $(jq -c '.hold' "$STATUS_A")"
    fi
else
    fail "no existe $STATUS_A"
fi

HISTORY_A="$CANON_A/pipeline-history.jsonl"
if [ -s "$HISTORY_A" ]; then
    pass "pipeline-history.jsonl presente"
    LAST_A=$(tail -n1 "$HISTORY_A")
    if [ "$(printf '%s' "$LAST_A" | jq -r '.state')" = "failed" ] \
        && [ "$(printf '%s' "$LAST_A" | jq -r '.runtime')" = "claude" ]; then
        pass "la ultima fila del historial trae state:failed y runtime:claude"
    else
        fail "fila de historial incorrecta: $LAST_A"
    fi
    LOG_A=$(printf '%s' "$LAST_A" | jq -r '.log // empty')
    if [ -n "$LOG_A" ] && [ -f "$LOG_A" ] && [[ "$LOG_A" == /*/.mefisto/pipeline/logs/iac-pipeline-*.log ]]; then
        pass "la entrada failed declara log absoluto existente bajo logs/"
    else
        fail "log ausente o inexistente en la entrada failed: $LAST_A"
    fi
else
    fail "no existe o esta vacio $HISTORY_A"
fi

# La entrada completed no se ejercita en runtime aqui (todos los casos abortan):
# se verifica que su linea de historial declare el log de la corrida (#1734).
if grep -F '\"state\":\"completed\"' "$PIPELINE_SRC" | grep -qF ',\"log\":\"$LOG_FILE\"}'; then
    pass "la entrada completed del historial declara log"
else
    fail "la entrada completed del historial no declara log"
fi

if [ -f "$CANON_A/events.log" ] && grep -q "SESSION IAC" "$CANON_A/events.log"; then
    pass "events.log bajo .mefisto/pipeline/ con la cabecera de sesion"
else
    fail "no existe events.log con 'SESSION IAC' bajo $CANON_A"
fi

if [ ! -e "$WORK_A/.claude/pipeline" ]; then
    pass "no se creo .claude/pipeline/"
else
    fail "se creo .claude/pipeline/ (no debia): $(find "$WORK_A/.claude/pipeline" 2>/dev/null)"
fi

# ---------------------------------------------------------------------------
# [B] MEFISTO_STATE_DIR redirige todo el estado (CA-5c).
# ---------------------------------------------------------------------------
echo ""
echo "[B] MEFISTO_STATE_DIR override redirige logs/status/history/events"

WORK_B="$TMP_DIR/work-b"
new_origin "$TMP_DIR/origin-b.git" "$WORK_B"
setup_work_repo "$WORK_B"

BIN_B="$TMP_DIR/bin-b"
mkdir -p "$BIN_B"
make_gh_stub "$BIN_B/gh" 9002 "Issue de prueba B"
make_terraform_stub "$BIN_B/terraform"
make_claude_stub "$BIN_B/claude"
RUN_AGENT_STUB_B="$TMP_DIR/run-agent-b.sh"
make_run_agent_stub "$RUN_AGENT_STUB_B"
STATE_B="$TMP_DIR/stub-state-b"; mkdir -p "$STATE_B"
OVERRIDE_DIR="$TMP_DIR/override-state"

run_pipeline "$WORK_B" "$BIN_B" "$RUN_AGENT_STUB_B" "$STATE_B" 9002 \
    STUB_FAIL_AGENT=infra-reviewer MEFISTO_STATE_DIR="$OVERRIDE_DIR" \
    </dev/null >"$TMP_DIR/stdout-b" 2>"$TMP_DIR/stderr-b"
RC_B=$?

if [ "$RC_B" -ne 0 ]; then
    pass "B: el fallo duro tambien aborta bajo el override"
else
    fail "B: se esperaba exit != 0"
fi

if ls "$OVERRIDE_DIR"/logs/iac-pipeline-*.log >/dev/null 2>&1 \
    && [ -f "$OVERRIDE_DIR/pipeline-status-infra-9002.json" ] \
    && [ -s "$OVERRIDE_DIR/pipeline-history.jsonl" ] \
    && [ -f "$OVERRIDE_DIR/events.log" ]; then
    pass "B: log/status/history/events caen bajo \$MEFISTO_STATE_DIR"
else
    fail "B: falta algun archivo bajo $OVERRIDE_DIR: $(ls "$OVERRIDE_DIR" 2>/dev/null)"
fi

if [ ! -e "$WORK_B/.mefisto/pipeline/logs" ] && [ ! -e "$WORK_B/.claude/pipeline" ]; then
    pass "B: con el override no se escribio nada bajo la ruta canonica del repo ni bajo .claude/pipeline"
else
    fail "B: se escribio en el repo pese al override (.mefisto/pipeline o .claude/pipeline)"
fi

# ---------------------------------------------------------------------------
# [C] Hold visible: durante un rate_limit del stub, el status trae
#     state:hold con hold.cause no nulo (CA-5d).
# ---------------------------------------------------------------------------
echo ""
echo "[C] Hold visible: state:hold con hold.cause durante un rate_limit"

WORK_C="$TMP_DIR/work-c"
new_origin "$TMP_DIR/origin-c.git" "$WORK_C"
setup_work_repo "$WORK_C"

BIN_C="$TMP_DIR/bin-c"
mkdir -p "$BIN_C"
make_gh_stub "$BIN_C/gh" 9003 "Issue de prueba C"
make_terraform_stub "$BIN_C/terraform"
make_claude_stub "$BIN_C/claude"
RUN_AGENT_STUB_C="$TMP_DIR/run-agent-c.sh"
make_run_agent_stub "$RUN_AGENT_STUB_C"
STATE_C="$TMP_DIR/stub-state-c"; mkdir -p "$STATE_C"
STATUS_C="$WORK_C/.mefisto/pipeline/pipeline-status-infra-9003.json"

run_pipeline "$WORK_C" "$BIN_C" "$RUN_AGENT_STUB_C" "$STATE_C" 9003 \
    STUB_RATE_LIMIT_AGENT=infra-writer \
    MEFISTO_HOLD_PROBE_SECONDS=2 MEFISTO_HOLD_MAX_SECONDS=60 \
    </dev/null >"$TMP_DIR/stdout-c" 2>"$TMP_DIR/stderr-c" &
PID_C=$!

FOUND_HOLD=false
HOLD_CAUSE=""
for _ in $(seq 1 100); do
    if [ -f "$STATUS_C" ]; then
        STATE_NOW=$(jq -r '.state // empty' "$STATUS_C" 2>/dev/null || true)
        if [ "$STATE_NOW" = "hold" ]; then
            HOLD_CAUSE=$(jq -r '.hold.cause // empty' "$STATUS_C" 2>/dev/null || true)
            FOUND_HOLD=true
            break
        fi
    fi
    sleep 0.1
done

if [ "$FOUND_HOLD" = true ] && [ -n "$HOLD_CAUSE" ]; then
    pass "C: se observo state:hold en disco con hold.cause no nulo ('$HOLD_CAUSE')"
else
    fail "C: nunca se observo state:hold con hold.cause no nulo"
fi

wait "$PID_C"
RC_C=$?
if [ "$RC_C" -eq 0 ]; then
    pass "C: tras el hold, la sonda reanuda y el pipeline completa con exito"
else
    fail "C: el pipeline no completo tras la reanudacion. stdout: $(cat "$TMP_DIR/stdout-c")"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"
[ "$FAIL" -eq 0 ]
