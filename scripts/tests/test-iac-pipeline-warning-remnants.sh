#!/usr/bin/env bash
# test-iac-pipeline-warning-remnants.sh -- Issue #2410 (MEF-ADR-0056): el body del
# PR de iac-pipeline.sh enlaza los warnings remanentes que el infra-reviewer deja
# en .mefisto/pipeline/warnings-remanentes.txt, y los prompts de ambos stages
# traen el directorio relativo del ambiente y el commit base.
#
#   [A] Con '#12' en el archivo de traspaso, el body trae '## Warnings remanentes'
#       y '- Relacionado: #12' antes de '## Cambios Terraform'.
#   [B] Sin archivo de traspaso, el body no trae la seccion.
#
# Uso: scripts/tests/test-iac-pipeline-warning-remnants.sh
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
        while [ "\$#" -gt 0 ]; do
            if [ "\$1" = "--body" ]; then printf '%s' "\$2" > "\${GH_BODY_CAPTURE:-/dev/null}"; fi
            shift
        done
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
agent="" event_log="" cwd="" prompt_file=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --agent) agent="$2"; shift 2 ;;
        --prompt-file) prompt_file="$2"; shift 2 ;;
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
[ -n "$prompt_file" ] && cp "$prompt_file" "${STUB_STATE_DIR:-/tmp}/${agent}.prompt.md"

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
if [ "$agent" = "infra-reviewer" ] && [ "${STUB_REMNANT:-}" = "1" ]; then
    printf '#12\n' > "$cwd/.mefisto/pipeline/warnings-remanentes.txt"
fi
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


run_case() {
    local tag="$1" issue="$2"; shift 2
    local work="$TMP_DIR/work-$tag" bin="$TMP_DIR/bin-$tag"
    new_origin "$TMP_DIR/origin-$tag.git" "$work"
    setup_work_repo "$work"
    mkdir -p "$bin" "$TMP_DIR/stub-state-$tag"
    make_gh_stub "$bin/gh" "$issue" "Issue de prueba $tag"
    make_terraform_stub "$bin/terraform"
    make_claude_stub "$bin/claude"
    make_run_agent_stub "$TMP_DIR/run-agent-$tag.sh"
    run_pipeline "$work" "$bin" "$TMP_DIR/run-agent-$tag.sh" "$TMP_DIR/stub-state-$tag" "$issue" \
        GH_BODY_CAPTURE="$TMP_DIR/body-$tag.md" "$@" \
        </dev/null >"$TMP_DIR/stdout-$tag" 2>"$TMP_DIR/stderr-$tag"
    return $?
}

echo "[A] Con archivo de traspaso: el body enlaza el remanente"
run_case a 9101 STUB_REMNANT=1
RC=$?
BODY_A="$TMP_DIR/body-a.md"
if [ "$RC" -eq 0 ] && [ -s "$BODY_A" ]; then pass "A: el pipeline completa y captura el body"; else fail "A: rc=$RC. stdout: $(cat "$TMP_DIR/stdout-a")"; fi
grep -qF '## Warnings remanentes' "$BODY_A" 2>/dev/null && pass "A: el body trae '## Warnings remanentes'" || fail "A: falta '## Warnings remanentes'"
grep -qF -- '- Relacionado: #12' "$BODY_A" 2>/dev/null && pass "A: el body trae '- Relacionado: #12'" || fail "A: falta '- Relacionado: #12'"
L_DEC=$(grep -nF '## Decisiones del pipeline' "$BODY_A" | head -1 | cut -d: -f1)
L_REM=$(grep -nF '## Warnings remanentes' "$BODY_A" | head -1 | cut -d: -f1)
L_TF=$(grep -nF '## Cambios Terraform' "$BODY_A" | head -1 | cut -d: -f1)
if [ -n "$L_DEC" ] && [ -n "$L_REM" ] && [ -n "$L_TF" ] && [ "$L_DEC" -lt "$L_REM" ] && [ "$L_REM" -lt "$L_TF" ]; then
    pass "A: la seccion va entre Decisiones del pipeline y Cambios Terraform"
else
    fail "A: orden incorrecto (dec=$L_DEC rem=$L_REM tf=$L_TF)"
fi
grep -qF 'Apply pendiente en CI' "$BODY_A" 2>/dev/null && pass "A: se conserva el aviso de apply pendiente" || fail "A: falta el aviso de apply pendiente"
for ag in infra-writer infra-reviewer; do
    PROMPT="$TMP_DIR/stub-state-a/$ag.prompt.md"
    grep -qxF 'Directorio relativo del ambiente: infra/environments/dev' "$PROMPT" 2>/dev/null \
        && pass "A: el prompt de $ag trae el directorio relativo del ambiente" \
        || fail "A: el prompt de $ag no trae 'Directorio relativo del ambiente: infra/environments/dev'"
    grep -qE '^Commit base: [0-9a-f]{40}$' "$PROMPT" 2>/dev/null \
        && pass "A: el prompt de $ag trae el commit base" \
        || fail "A: el prompt de $ag no trae 'Commit base: <sha>'"
done

echo ""
echo "[B] Sin archivo de traspaso: el body no trae la seccion"
run_case b 9102
RC=$?
BODY_B="$TMP_DIR/body-b.md"
if [ "$RC" -eq 0 ] && [ -s "$BODY_B" ]; then pass "B: el pipeline completa y captura el body"; else fail "B: rc=$RC. stdout: $(cat "$TMP_DIR/stdout-b")"; fi
grep -qF '## Warnings remanentes' "$BODY_B" 2>/dev/null && fail "B: el body no debia traer la seccion" || pass "B: el body no trae '## Warnings remanentes'"

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"
[ "$FAIL" -eq 0 ]
