#!/usr/bin/env bash
# test-tooling-runtime-neutral.sh -- E2E del pipeline interno de tooling POR
# RUNTIME, con CLIs falsas en PATH (MEF-ADR-0049, MEF-ADR-0031, issue #912).
#
# Hijo 3/3 de #879: el pipeline consume el runner neutral comun de
# src/runtime/mefisto-run-agent.sh, pero solo lo cubrian los tests unitarios ajustados
# (retry, stage-models, variant, state-paths). Esta suite corre el PIPELINE
# REAL (src/internal/scripts/mefisto-tooling-pipeline.sh, via el shim
# .claude/scripts/mefisto-tooling-pipeline.sh) de punta a punta, con CLIs
# falsas de `claude` y `opencode` en PATH que reproducen tal cual el formato
# crudo congelado de fixtures/runtime-{claude,opencode}/*.jsonl -- ningun CLI
# real hace falta instalado.
#
# Arnes (bloque [A], funcion setup_harness): mismo layout canonico que el
# bloque [G] de test-tooling-state-paths.sh (origin bare + clon "fake-mefisto"
# + stubs de PATH), extendido con runtime-opencode.sh/.jq y un stub `opencode`
# ademas del `claude` -- y con `gh pr create`/`gh issue comment` respondiendo
# (URL falsa) para que los escenarios de exito lleguen hasta la creacion del
# PR, a diferencia del bloque [G] (que corta a proposito en el gate de
# changelog.d/). No se comparte codigo con ese archivo -- los tests internos
# no comparten helpers entre si (ver notas tecnicas de #912) -- el arnes vive
# en funciones de ESTE archivo.
#
# Escenarios (CA-1), cada uno una corrida real distinta del pipeline sobre el
# MISMO origin/clon (issue de mentira propio por escenario, para que las
# ramas/worktrees no colisionen):
#   (a) [B] MEFISTO_RUNTIME=claude,   exito de punta a punta.
#   (b) [C] MEFISTO_RUNTIME=opencode, exito de punta a punta.
#   (c) [D] MEFISTO_RUNTIME=opencode, fallo terminal del writer en Stage 1 --
#       el CLI falso reproduce fixtures/runtime-opencode/empty-1.18.29.jsonl
#       (stream vacio, fixture congelado) y sale con exit 1, sin resumen.
#   (d) [E] Defaults: sin .mefisto/models.json ni --models, OpenCode recibe
#       GPT-6 Sol para writer y reviewer; Claude conserva sonnet para
#       writer y opus para reviewer deep.
#   (e) [F] Gate de neutralidad (issue #914): MEFISTO_RUNTIME=claude, el CLI
#       falso del writer introduce ademas una fuga real -- un archivo nuevo
#       src/internal/agents/fx-leak.md con `"model": "sonnet"` en el
#       frontmatter -- dentro del scope permitido (src/internal/**), asi que
#       el gate de scope da via libre y el UNICO gate que puede frenar la
#       corrida es mefisto-neutrality-gate.sh. Stage 1 aborta citando la
#       violacion 'src/internal/agents/fx-leak.md:<linea>: R1' y el comando
#       de retoma --from-stage 1, sin llegar a crear PR. El mensaje tambien
#       incluye el remedio de R1 (issue #1469: mefisto_neutrality_remedy) y
#       NO el de R4/adapters-check, que no aplican a esta fuga. Desde el
#       issue #1473, [F] usa el modo "leak" (la fuga NUNCA se corrige) para
#       cubrir el camino donde el intento de correccion previo al abort()
#       tambien falla; el escenario [G] (modo "leak-then-fix") cubre el
#       camino donde ese mismo intento SI corrige la fuga y la corrida
#       completa hasta crear el PR.
#   (f) [H] Contexto acotado del reviewer (issue #1449): el writer deja un
#       archivo de >= 3 MB dentro del scope y el prompt de Stage 2 no crece
#       con el.
#   (g) [I] Reanudacion --from-stage 2 (issue #1449): calcula el mismo commit
#       base / HEAD del writer que la corrida completa.
#   (h) [G] Intento de correccion del gate de neutralidad (issue #1473):
#       MEFISTO_RUNTIME=claude y la misma fuga de (e), pero el CLI falso solo
#       la deja en su primera llamada -- el intento que run_neutrality_gate
#       antepone a su abort() la elimina, el gate pasa en la segunda pasada y
#       la corrida llega a crear PR.
#
# CA-2 (evidencia verificable, MEF-ADR-0031 -- los artefactos de una corrida
# real, no la lectura del codigo): <log_base>.events.jsonl de cada stage
# termina en run.completed{status:"success"} con el runtime del escenario; el
# archivo de metricas de cada stage lleva runtime/status; pipeline-history.jsonl
# registra runtime a nivel de corrida y en agents.writer/agents.reviewer; en
# (b) el CLI falso de cada stage fue invocado con `--agent mefisto-writer` /
# `--agent mefisto-reviewer` (flag y valor ADYACENTES en el argv); en (c) el
# pipeline aborta en Stage 1, `gh pr create` nunca se invoca, el status queda
# failed y no hay entrada completed en el historial para ese issue.
#
# CA-3: toda la suite corre con CLIs falsas (sin red, sin claude/opencode
# reales instalados -- los stubs preceden en PATH) y
# MEFISTO_AGENT_RETRY_BACKOFF_SECONDS=0; limpia sus temporales via trap (el
# worktree que crea el pipeline nace como hermano del clon, o sea dentro de
# $TMP). Bash 3.2 (sin arrays asociativos, sin mapfile) + jq 1.7 (baseline
# de MEF-ADR-0049 CA-6; `jq --args ... -- "$@"` necesita el terminador `--`
# porque el argv capturado trae flags).
#
# Uso: .claude/scripts/tests/test-tooling-runtime-neutral.sh
# Exit code: 0 si todos los chequeos pasan (o si jq/python3 no estan
# disponibles -- SKIP de la suite completa), 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

CANON_LIB="$REPO_ROOT/src/internal/scripts/lib/_mefisto-common.sh"
CANON_PIPE="$REPO_ROOT/src/internal/scripts/mefisto-tooling-pipeline.sh"
SHIM_LIB="$REPO_ROOT/.claude/scripts/_mefisto-common.sh"
SHIM_PIPE="$REPO_ROOT/.claude/scripts/mefisto-tooling-pipeline.sh"

FIXTURES_CLAUDE_DIR="$REPO_ROOT/.claude/scripts/tests/fixtures/runtime-claude"
FIXTURES_OPENCODE_DIR="$REPO_ROOT/.claude/scripts/tests/fixtures/runtime-opencode"

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

if ! command -v jq >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: esta suite requiere jq y python3, no disponibles en este entorno"
    echo "----------------------------------------"
    echo "  Resumen: 0 pass, 0 fail"
    echo "----------------------------------------"
    exit 0
fi

for f in "$CANON_LIB" "$CANON_PIPE" "$SHIM_LIB" "$SHIM_PIPE" \
         "$FIXTURES_CLAUDE_DIR/success.jsonl" \
         "$FIXTURES_OPENCODE_DIR/success-tool-1.18.29.jsonl" \
         "$FIXTURES_OPENCODE_DIR/empty-1.18.29.jsonl"; do
    if [ ! -f "$f" ]; then
        echo "FAIL: archivo requerido ausente: $f"
        exit 1
    fi
done

if grep -qF 'RUNTIME_DIR="$(cd "$SCRIPT_DIR/../../runtime" && pwd)"' "$CANON_PIPE" \
    && grep -qF 'RUN_AGENT_BIN_DEFAULT="$RUNTIME_DIR/mefisto-run-agent.sh"' "$CANON_PIPE" \
    && ! grep -qF 'source "$SCRIPT_DIR/lib/mefisto-runtime.sh"' "$CANON_PIPE"; then
    pass "A-0: el pipeline consume runtime, modelos y runner desde src/runtime/ (sin librerias internas canonicas)"
else
    fail "A-0: el pipeline no quedo conectado exclusivamente al nucleo comun"
fi
for legacy in \
    "$REPO_ROOT/src/internal/scripts/mefisto-run-agent.sh" \
    "$REPO_ROOT/src/internal/scripts/lib/mefisto-models.sh" \
    "$REPO_ROOT/src/internal/scripts/lib/runtime-claude.sh" \
    "$REPO_ROOT/src/internal/scripts/lib/runtime-opencode.sh"; do
    if [ -e "$legacy" ]; then
        fail "A-0: queda una frontera temporal sin consumidor: $legacy"
    fi
done

# ============================================================================
# [A] Arnes: origin bare + clon "fake-mefisto" + stubs de gh/claude/opencode
# ============================================================================

echo "[A] Montando arnes: origin bare + clon fake-mefisto + stubs de PATH"

FAKE_MEFISTO="$TMP/fake-mefisto"
FAKE_BIN="$TMP/bin"
STATE_DIR="$FAKE_MEFISTO/.mefisto/pipeline"
mkdir -p "$FAKE_BIN"

# write_cli_stub <nombre> -- escribe en $FAKE_BIN un CLI falso llamado
# <nombre> (claude u opencode: el cuerpo es el mismo, el stub se identifica
# por basename "$0"). Reproduce tal cual (cat, sin editarlo) el fixture crudo
# congelado que indique MEFISTO_TEST_FIXTURE, captura su argv completo como
# array JSON con jq --args (issue #863: el prompt puede traer saltos de
# linea, un separador de texto no serviria) y, en modo "success", "leak" o
# "leak-then-fix", escribe el resumen de AMBOS stages + un archivo notable
# dentro del scope + un fragmento de changelog.d/ (para que el gate de
# fragmentos del issue #380 de via libre hasta crear el PR). En modo "leak"
# (issue #914) anade ademas una fuga real de neutralidad --
# src/internal/agents/fx-leak.md con `"model": "sonnet"` en el frontmatter --
# dentro del scope permitido, para que el UNICO gate que frene la corrida sea
# mefisto-neutrality-gate.sh, no el de scope: esa fuga NUNCA se corrige
# (persiste incluso tras el intento de correccion de #1473). En modo
# "leak-then-fix" (issue #1473) la MISMA fuga aparece solo en la llamada 1 (el
# writer principal); desde la llamada 2 en adelante el stub la elimina --
# reproduce que el intento de correccion que compone run_neutrality_gate (un
# segundo run_agent sobre el mismo rol) SI limpia el arbol antes de que el
# gate se re-evalue. En modo "big" (issue #1449, CA-3) el writer ademas crea un archivo
# de >= 3 MB dentro del scope (docs/1449-big-file.md), para probar que el
# prompt del reviewer NO crece con el tamano del diff. En modo "fail-stage2"
# (issue #1449, CA-4) la llamada N=1 (writer) tiene exito igual que "success",
# pero cualquier llamada posterior (reviewer) falla sin salida -- sirve para
# dejar el worktree con el commit del writer y comparar el prompt de Stage 2
# entre la corrida completa y una reanudada con --from-stage 2. En modo
# "always-fail" el CLI falla siempre, sin escribir nada -- para la segunda
# mitad de ese mismo escenario de reanudacion. Sale con MEFISTO_TEST_EXIT_CODE
# (salvo "fail-stage2"/"always-fail", que fijan su propio exit code).
write_cli_stub() {
    local name="$1"
    cat > "$FAKE_BIN/$name" <<'STUB'
#!/usr/bin/env bash
ME="$(basename "$0")"
CAP="${MEFISTO_TEST_CAPTURE_DIR:?MEFISTO_TEST_CAPTURE_DIR sin fijar}"
N_FILE="$CAP/$ME-call-count"
N=$(( $(cat "$N_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$N" > "$N_FILE"
jq -n --args '$ARGS.positional' -- "$@" > "$CAP/$ME-call-$N.json" 2>/dev/null || true

if [ "${MEFISTO_TEST_MODE:-success}" = "always-fail" ]; then
    exit 1
fi

if [ "${MEFISTO_TEST_MODE:-success}" = "fail-stage2" ]; then
    if [ "$N" = "1" ]; then
        mkdir -p .mefisto/pipeline/summaries docs changelog.d
        echo "resumen stub writer ($ME)" > .mefisto/pipeline/summaries/stage-1-writer.md
        echo "cambio del stub e2e resume ($ME)" >> docs/1449-resume-marker.md
        echo "- cambio del stub e2e (resume)" > changelog.d/1449-resume.added.md
        exit 0
    fi
    exit 1
fi

if [ "${MEFISTO_TEST_MODE:-success}" = "success" ] || [ "${MEFISTO_TEST_MODE:-success}" = "leak" ] || [ "${MEFISTO_TEST_MODE:-success}" = "leak-then-fix" ] || [ "${MEFISTO_TEST_MODE:-success}" = "big" ]; then
    mkdir -p .mefisto/pipeline/summaries docs changelog.d
    echo "resumen stub writer ($ME)" > .mefisto/pipeline/summaries/stage-1-writer.md
    echo "resumen stub reviewer ($ME)" > .mefisto/pipeline/summaries/stage-2-reviewer.md
    echo "cambio del stub e2e ($ME, llamada $N)" >> docs/912-e2e-marker.md
    echo "- cambio del stub e2e (runtime-neutral)" > changelog.d/912-e2e.added.md
fi

if [ "${MEFISTO_TEST_MODE:-success}" = "leak" ]; then
    mkdir -p src/internal/agents
    printf -- '---\n{"id": "fx-leak", "kind": "agent", "effort": "standard", "model": "sonnet"}\n---\n\nFuga de neutralidad de runtime para el escenario negativo (issue #914): el campo `model` no debe aparecer en la fuente neutral src/internal/**.\n' > src/internal/agents/fx-leak.md
fi

if [ "${MEFISTO_TEST_MODE:-success}" = "leak-then-fix" ]; then
    if [ "$N" = "1" ]; then
        mkdir -p src/internal/agents
        printf -- '---\n{"id": "fx-leak", "kind": "agent", "effort": "standard", "model": "sonnet"}\n---\n\nFuga de neutralidad de runtime para el escenario de correccion (issue #1473): el campo `model` no debe aparecer en la fuente neutral src/internal/**.\n' > src/internal/agents/fx-leak.md
    else
        rm -f src/internal/agents/fx-leak.md
    fi
fi

if [ "${MEFISTO_TEST_MODE:-success}" = "big" ] && [ "$N" = "1" ]; then
    dd if=/dev/zero bs=1024 count=3072 2>/dev/null | tr '\0' 'x' > docs/1449-big-file.md
fi

if [ -n "${MEFISTO_TEST_FIXTURE:-}" ]; then
    cat "$MEFISTO_TEST_FIXTURE"
fi
exit "${MEFISTO_TEST_EXIT_CODE:-0}"
STUB
    chmod +x "$FAKE_BIN/$name"
}

setup_harness() {
    local bare="$TMP/origin.git"
    git init -q --bare "$bare"
    git clone -q "$bare" "$FAKE_MEFISTO" 2>/dev/null

    mkdir -p "$FAKE_MEFISTO/.claude-plugin" "$FAKE_MEFISTO/.claude/scripts" \
             "$FAKE_MEFISTO/src/internal/scripts/lib" "$FAKE_MEFISTO/src/internal/prompts" \
             "$FAKE_MEFISTO/src/internal/contract" \
             "$FAKE_MEFISTO/docs" "$FAKE_MEFISTO/changelog.d"
    cat > "$FAKE_MEFISTO/.claude-plugin/plugin.json" <<'EOF'
{
  "name": "mefisto",
  "version": "0.0.0"
}
EOF
    printf '.mefisto/\n.claude/pipeline/\n' > "$FAKE_MEFISTO/.gitignore"

    # Solo la politica interna queda bajo src/internal/. Toda la mecanica de
    # runtime se copia desde su frontera canonica; el fixture no trae shims.
    cp "$REPO_ROOT/src/internal/scripts/lib/_mefisto-common.sh" "$FAKE_MEFISTO/src/internal/scripts/lib/_mefisto-common.sh"
    cp "$REPO_ROOT/src/internal/scripts/lib/mefisto-state.sh" "$FAKE_MEFISTO/src/internal/scripts/lib/mefisto-state.sh"
    # Effort por agente (issue #2499): el pipeline lee el nivel de fabrica del
    # campo `effort` de la fuente neutral de writer/reviewer con frontmatter.sh,
    # antes de crear el worktree; sin estas copias aborta en el arranque.
    cp "$REPO_ROOT/src/internal/scripts/lib/frontmatter.sh" "$FAKE_MEFISTO/src/internal/scripts/lib/frontmatter.sh"
    mkdir -p "$FAKE_MEFISTO/src/internal/agents"
    cp "$REPO_ROOT/src/internal/agents/mefisto-writer.md" "$REPO_ROOT/src/internal/agents/mefisto-reviewer.md" "$FAKE_MEFISTO/src/internal/agents/"
    cp -R "$REPO_ROOT/src/runtime" "$FAKE_MEFISTO/src/runtime"
    cp "$REPO_ROOT/src/internal/prompts/noninteractive-system.md" "$FAKE_MEFISTO/src/internal/prompts/noninteractive-system.md"
    # Gate de neutralidad (issue #914): el pipeline lo invoca tras cada stage
    # -- copias REALES (no un stub), byte-identicas al repo, para que el
    # escenario [F] ejercite el gate de verdad. La allowlist real trae las
    # excepciones (R1) de los propios adaptadores que setup_harness copia mas
    # abajo (adapter-claude.sh, adapter-opencode.sh...), asi que los
    # escenarios de exito ((a)/(b)) siguen pasando el gate en 0. No se copia
    # generate-internal-adapters.sh: sin el, el gate salta adapters-check en
    # silencio (guarda `[ -f "$ADAPTERS_SCRIPT" ]`), y ningun escenario de esta
    # suite necesita ejercer esa verificacion estructural (ya cubierta por
    # test-neutrality-gate.sh).
    cp "$REPO_ROOT/src/internal/scripts/mefisto-neutrality-gate.sh" "$FAKE_MEFISTO/src/internal/scripts/mefisto-neutrality-gate.sh"
    cp "$REPO_ROOT/src/internal/contract/neutrality-allowlist.json" "$FAKE_MEFISTO/src/internal/contract/neutrality-allowlist.json"
    chmod +x "$FAKE_MEFISTO/src/internal/scripts/mefisto-neutrality-gate.sh"
    cp "$CANON_PIPE" "$FAKE_MEFISTO/src/internal/scripts/mefisto-tooling-pipeline.sh"
    cp "$SHIM_LIB" "$FAKE_MEFISTO/.claude/scripts/_mefisto-common.sh"
    cp "$SHIM_PIPE" "$FAKE_MEFISTO/.claude/scripts/mefisto-tooling-pipeline.sh"
    chmod +x "$FAKE_MEFISTO/src/runtime/mefisto-run-agent.sh" \
             "$FAKE_MEFISTO/src/internal/scripts/mefisto-tooling-pipeline.sh" \
             "$FAKE_MEFISTO/.claude/scripts/mefisto-tooling-pipeline.sh"
    echo "# changelog.d" > "$FAKE_MEFISTO/changelog.d/README.md"

    (cd "$FAKE_MEFISTO" \
        && git add -A \
        && git -c user.email="test@example.com" -c user.name="Test" commit -q -m "base" \
        && git push -q origin main)

    # --- Stub de gh: issue view responde un issue abierto; pr create responde
    # una URL falsa (y deja constancia de la llamada); issue comment succeed;
    # el resto (pr list, repo view...) falla -- el pipeline ya degrada esos
    # casos (find_open_pr_for_branch/assert_in_mefisto tratan un gh roto como
    # "sin dato", nunca abortan por eso).
    cat > "$FAKE_BIN/gh" <<'STUB'
#!/usr/bin/env bash
CAP="${MEFISTO_TEST_CAPTURE_DIR:-}"
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
    printf '{"number":%s,"title":"E2E stub issue runtime-neutral","body":"cuerpo de prueba stub","state":"OPEN"}\n' "$3"
    exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
    [ -n "$CAP" ] && echo "called" >> "$CAP/gh-pr-create.calls"
    echo "https://github.com/fake-org/fake-repo/pull/9999"
    exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
    [ -n "$CAP" ] && echo "called" >> "$CAP/gh-issue-comment.calls"
    exit 0
fi
exit 1
STUB
    chmod +x "$FAKE_BIN/gh"

    # --- Stubs de claude y opencode: mismo cuerpo (write_cli_stub), sobre las
    # fixtures de su propio runtime. La diferencia observable esta en el argv
    # que el runner les compone: opencode recibe --agent/--dir/-m como flags
    # reales; claude recibe -p <prompt> y --model solo cuando hay modelo.
    write_cli_stub claude
    write_cli_stub opencode
}

setup_harness
if [ -x "$FAKE_MEFISTO/.claude/scripts/mefisto-tooling-pipeline.sh" ] && [ -x "$FAKE_BIN/claude" ] && [ -x "$FAKE_BIN/opencode" ] && [ -x "$FAKE_BIN/gh" ]; then
    pass "A-1: arnes montado (clon fake-mefisto + stubs gh/claude/opencode ejecutables)"
else
    fail "A-1: el arnes no quedo montado correctamente"
fi

# run_scenario <runtime> <issue_num> <mode> <fixture_file> <exit_code>
#
# Corre el pipeline REAL (via el shim) contra el clon fake-mefisto, con
# env -u de todo el estado que esta MISMA sesion de test hereda (mismo motivo
# que el bloque [G] de test-tooling-state-paths.sh: sin esto, la corrida
# escribiria en el .mefisto/pipeline/ del repo real). MEFISTO_RUNTIME_LIB_DIR
# y MEFISTO_MODELS_FILE entran en esa lista porque un pipeline en curso los
# exporta apuntando al checkout que lo lanzo: heredarlos haria que los
# defaults del bloque [E] se resolvieran contra las tablas y el mapping de
# OTRO arbol, no contra los del clon fake-mefisto que este test monta. Cada escenario usa su
# propio directorio de captura (para que los contadores de invocacion
# <cli>-call-N arranquen en 1 en cada corrida) y su propio numero de issue de
# mentira (para que rama/worktree no colisionen entre escenarios que
# reutilizan el mismo origin/clon). Deja SCEN_RC/SCEN_OUT/SCEN_ERR/SCEN_CAP
# poblados para que el caller haga sus aserciones. Los argumentos extra ($6,
# opcional, p. ej. "--from-stage 2") se pasan tal cual al pipeline -- reusan
# el mismo capdir del issue si ya existia (issue #1449, escenario de
# reanudacion: la segunda invocacion no reinicia los contadores de llamada).
run_scenario() {
    local runtime="$1" issue_num="$2" mode="$3" fixture="$4" exitcode="$5" extra_args="${6:-}"
    local capdir="$TMP/capture-${issue_num}"
    mkdir -p "$capdir"
    local out="$TMP/scenario-${issue_num}.out"
    local err="$TMP/scenario-${issue_num}.err"

    (
        cd "$FAKE_MEFISTO" || exit 99
        env -u MEFISTO_STATE_DIR -u MEFISTO_LEGACY_STATE_DIR -u MEFISTO_REPO_ROOT \
            -u MEFISTO_PROJECT_NAME -u MEFISTO_REPO_SLUG -u MEFISTO_LAUNCH_ROOT \
            -u MEFISTO_RUNTIME_LIB_DIR -u MEFISTO_MODELS_FILE \
            PATH="$FAKE_BIN:$PATH" MEFISTO_RUNTIME="$runtime" MEFISTO_AGENT_RETRY_BACKOFF_SECONDS=0 \
            MEFISTO_TEST_CAPTURE_DIR="$capdir" MEFISTO_TEST_MODE="$mode" \
            MEFISTO_TEST_FIXTURE="$fixture" MEFISTO_TEST_EXIT_CODE="$exitcode" \
            ./.claude/scripts/mefisto-tooling-pipeline.sh "$issue_num" $extra_args
    ) </dev/null >"$out" 2>"$err"
    SCEN_RC=$?
    SCEN_OUT="$out"
    SCEN_ERR="$err"
    SCEN_CAP="$capdir"
}

# _events_file <issue_num> <stage> <agent> -- ruta del events.jsonl del stage
# (timestamp desconocido de antemano: se resuelve con find + comodin).
_events_file() {
    find "$STATE_DIR/logs" -name "mefisto-tooling-stage-${2}-${3}-*-issue-${1}.events.jsonl" 2>/dev/null | head -n1
}

# _metrics_file <issue_num> <stage> <agent> -- ruta del metrics/*.json del stage.
_metrics_file() {
    find "$STATE_DIR/metrics" -name "mefisto-tooling-*-issue-${1}-stage-${2}-${3}.json" 2>/dev/null | head -n1
}

# _stage2_prompt_files <issue_num> -- todas las rutas de prompt.md de Stage 2
# (reviewer) de ese issue, una por linea (issue #1449: puede haber mas de una
# si el issue se corrio mas de una vez, p. ej. corrida completa + reanudacion).
_stage2_prompt_files() {
    find "$STATE_DIR/prompts" -name "mefisto-tooling-stage-2-reviewer-*-issue-${1}.prompt.md" 2>/dev/null | sort
}

# _stage1_prompt_files <issue_num> -- mismo criterio que _stage2_prompt_files,
# para el prompt de Stage 1 (writer) de ese issue.
_stage1_prompt_files() {
    find "$STATE_DIR/prompts" -name "mefisto-tooling-stage-1-writer-*-issue-${1}.prompt.md" 2>/dev/null | sort
}

# _find_call <capdir> <cli> <aguja> -- ruta del primer <cli>-call-N.json cuyo
# argv (array JSON) tiene algun elemento que CONTIENE <aguja>. Sirve para
# ubicar la invocacion de un stage por contenido, no por orden de llamada.
# La aguja util es el id del agente (`--agent mefisto-writer` /
# `--agent mefisto-reviewer`): desde #1368 lo pasan AMBOS adaptadores reales,
# y desde #1448 es lo unico del stage que queda en el argv -- el prompt (que
# antes nombraba el archivo de resumen del stage) viaja por stdin.
_find_call() {
    local f
    for f in "$1/$2"-call-*.json; do
        [ -f "$f" ] || continue
        if jq -e --arg n "$3" 'any(.[]; contains($n))' "$f" >/dev/null 2>&1; then
            printf '%s' "$f"
            return 0
        fi
    done
    return 1
}

# _argv_has_flag_value <call.json> <flag> <valor> -- true si el argv trae
# <flag> seguido INMEDIATAMENTE por <valor> (adyacentes, no sueltos).
_argv_has_flag_value() {
    jq -e --arg f "$2" --arg v "$3" '(index($f)) as $i | $i != null and .[$i+1] == $v' "$1" >/dev/null 2>&1
}

# assert_stage_artifacts <prefijo> <runtime> <issue> <stage> <agent> --
# chequeos -2 (events.jsonl terminal) y -3 (metrics) de un stage exitoso.
assert_stage_artifacts() {
    local prefix="$1" runtime="$2" issue="$3" stage="$4" agent="$5"
    local ev mf term t_type t_status t_runtime m_runtime m_status

    ev="$(_events_file "$issue" "$stage" "$agent")"
    if [ -n "$ev" ] && [ -f "$ev" ]; then
        term="$(tail -n1 "$ev")"
        t_type="$(printf '%s' "$term" | jq -r '.type')"
        t_status="$(printf '%s' "$term" | jq -r '.status')"
        t_runtime="$(printf '%s' "$term" | jq -r '.runtime')"
        if [ "$t_type" = "run.completed" ] && [ "$t_status" = "success" ] && [ "$t_runtime" = "$runtime" ]; then
            pass "$prefix-2: stage $stage ($agent) -- events.jsonl termina en run.completed{status:success, runtime:$runtime}"
        else
            fail "$prefix-2: stage $stage ($agent) -- terminal inesperado: $term"
        fi
    else
        fail "$prefix-2: stage $stage ($agent) -- no se encontro events.jsonl bajo $STATE_DIR/logs"
    fi

    mf="$(_metrics_file "$issue" "$stage" "$agent")"
    if [ -n "$mf" ] && [ -f "$mf" ]; then
        m_runtime="$(jq -r '.runtime' "$mf")"
        m_status="$(jq -r '.status' "$mf")"
        if [ "$m_runtime" = "$runtime" ] && [ "$m_status" = "success" ]; then
            pass "$prefix-3: stage $stage ($agent) -- metrics/*.json lleva runtime:$runtime, status:success"
        else
            fail "$prefix-3: stage $stage ($agent) -- metrics con runtime='$m_runtime' status='$m_status'"
        fi
    else
        fail "$prefix-3: stage $stage ($agent) -- no se encontro metrics/*.json bajo $STATE_DIR/metrics"
    fi
}

# assert_success_run <prefijo> <runtime> <issue> <capdir> -- aserciones CA-2
# comunes a los escenarios de exito (a) y (b), sobre la ultima run_scenario:
#   -1 rc=0; -2/-3 por stage (assert_stage_artifacts); -4 runtime en el
#   historial a nivel de corrida y por agente; -5 `gh pr create` exactamente
#   una vez.
assert_success_run() {
    local prefix="$1" runtime="$2" issue="$3" capdir="$4"
    local hist entry h_runtime h_wr h_rv

    if [ "$SCEN_RC" -eq 0 ]; then
        pass "$prefix-1: el pipeline completa con exito bajo runtime=$runtime (rc=0)"
    else
        fail "$prefix-1: rc=$SCEN_RC -- stderr: $(tail -n 20 "$SCEN_ERR")"
    fi

    assert_stage_artifacts "$prefix" "$runtime" "$issue" 1 writer
    assert_stage_artifacts "$prefix" "$runtime" "$issue" 2 reviewer

    hist="$STATE_DIR/pipeline-history.jsonl"
    entry="$(jq -c --arg issue "$issue" 'select(.issue == $issue and .state == "completed")' "$hist" 2>/dev/null | tail -n1)"
    if [ -n "$entry" ]; then
        h_runtime="$(printf '%s' "$entry" | jq -r '.runtime')"
        h_wr="$(printf '%s' "$entry" | jq -r '.agents.writer.runtime')"
        h_rv="$(printf '%s' "$entry" | jq -r '.agents.reviewer.runtime')"
        if [ "$h_runtime" = "$runtime" ] && [ "$h_wr" = "$runtime" ] && [ "$h_rv" = "$runtime" ]; then
            pass "$prefix-4: pipeline-history.jsonl registra runtime:$runtime a nivel de corrida y en agents.writer/agents.reviewer"
        else
            fail "$prefix-4: runtime en historial -- corrida:'$h_runtime' writer:'$h_wr' reviewer:'$h_rv'"
        fi
    else
        fail "$prefix-4: no se encontro entrada 'completed' del issue $issue en pipeline-history.jsonl"
    fi

    if [ -f "$capdir/gh-pr-create.calls" ] && [ "$(wc -l < "$capdir/gh-pr-create.calls" | tr -d ' ')" = "1" ]; then
        pass "$prefix-5: el stub de 'gh pr create' se invoco exactamente una vez (la corrida llego hasta crear el PR)"
    else
        fail "$prefix-5: 'gh pr create' no se invoco la cantidad esperada de veces"
    fi
}

# ============================================================================
# [B] Escenario (a): MEFISTO_RUNTIME=claude, exito de punta a punta
# ============================================================================

echo ""
echo "[B] Escenario (a): MEFISTO_RUNTIME=claude, exito de punta a punta (CA-1/CA-2)"

A_ISSUE="912101"
run_scenario claude "$A_ISSUE" success "$FIXTURES_CLAUDE_DIR/success.jsonl" 0
A_CAP="$SCEN_CAP"
assert_success_run B claude "$A_ISSUE" "$A_CAP"

# ============================================================================
# [N] Doctrina de neutralidad de runtime en los prompts del pipeline (issue
# #1468). El marcador "NEUTRALIDAD DE RUNTIME:" vive en una unica variable
# Bash que se interpola sin cambios en STAGE1_PROMPT y STAGE2_PROMPT -- se
# verifica sobre los prompt.md REALES que la corrida (a) ya dejo en disco, no
# releyendo la fuente. Por separado, se verifica que ni ese bloque ni el
# resto de la fuente canonica del pipeline nombran los literales que R3
# persigue (esta suite vive bajo .claude/scripts/tests/**, rules: ["ALL"],
# asi que SI puede nombrarlos para afirmar su ausencia).
# ============================================================================

echo ""
echo "[N] Doctrina de neutralidad de runtime en los prompts del pipeline (issue #1468)"

N_STAGE1_PROMPT="$(_stage1_prompt_files "$A_ISSUE" | tail -n1)"
if [ -n "$N_STAGE1_PROMPT" ] && grep -qF 'NEUTRALIDAD DE RUNTIME:' "$N_STAGE1_PROMPT"; then
    pass "N-1: el prompt de Stage 1 (writer) trae el bloque 'NEUTRALIDAD DE RUNTIME:'"
else
    fail "N-1: el prompt de Stage 1 no trae el bloque de neutralidad de runtime"
fi

N_STAGE2_PROMPT="$(_stage2_prompt_files "$A_ISSUE" | tail -n1)"
if [ -n "$N_STAGE2_PROMPT" ] && grep -qF 'NEUTRALIDAD DE RUNTIME:' "$N_STAGE2_PROMPT"; then
    pass "N-2: el prompt de Stage 2 (reviewer) trae el bloque 'NEUTRALIDAD DE RUNTIME:'"
else
    fail "N-2: el prompt de Stage 2 no trae el bloque de neutralidad de runtime"
fi

if ! grep -qE 'CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|\.claude/pipeline' "$CANON_PIPE"; then
    pass "N-3: mefisto-tooling-pipeline.sh (fuente canonica, bloque incluido) no nombra ningun literal de R3"
else
    fail "N-3: mefisto-tooling-pipeline.sh nombra un literal de R3: $(grep -nE 'CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|\.claude/pipeline' "$CANON_PIPE")"
fi

# El bloque nace unificado (CA-1): una sola definicion en la fuente y dos
# interpolaciones, una por prompt. Si alguien lo copiara a mano en el segundo
# prompt, N-1/N-2 seguirian verdes y la divergencia pasaria inadvertida.
N_DEF_COUNT="$(grep -c '^NEUTRALITY_RUNTIME_BLOCK=' "$CANON_PIPE" || true)"
N_USE_COUNT="$(grep -cF '${NEUTRALITY_RUNTIME_BLOCK}' "$CANON_PIPE" || true)"
if [ "$N_DEF_COUNT" = "1" ] && [ "$N_USE_COUNT" = "2" ]; then
    pass "N-4: el bloque se define una sola vez y se interpola en los dos prompts (1 definicion, 2 usos)"
else
    fail "N-4: el bloque deberia tener 1 definicion y 2 usos; hay $N_DEF_COUNT definicion(es) y $N_USE_COUNT uso(s)"
fi

# CA-2: al reviewer no le basta con conocer la regla -- tiene que corregir la
# fuga en su propia revision, sin reportarla ni ampliar la allowlist.
if [ -n "$N_STAGE2_PROMPT" ] \
    && grep -qF 'reformulalos tu mismo en esta misma revision' "$N_STAGE2_PROMPT" \
    && grep -qF 'propongas ampliar la allowlist' "$N_STAGE2_PROMPT"; then
    pass "N-5: el prompt de Stage 2 manda reformular la fuga en la propia revision, sin ampliar la allowlist"
else
    fail "N-5: el prompt de Stage 2 no trae la instruccion de reformular la fuga sin ampliar la allowlist"
fi

# ============================================================================
# [C] Escenario (b): MEFISTO_RUNTIME=opencode, exito de punta a punta
# ============================================================================

echo ""
echo "[C] Escenario (b): MEFISTO_RUNTIME=opencode, exito de punta a punta (CA-1/CA-2)"

B_ISSUE="912102"
run_scenario opencode "$B_ISSUE" success "$FIXTURES_OPENCODE_DIR/success-tool-1.18.29.jsonl" 0
B_CAP="$SCEN_CAP"
assert_success_run C opencode "$B_ISSUE" "$B_CAP"

# CA-2(b): el CLI falso de opencode fue invocado con `--agent mefisto-writer`
# y `--agent mefisto-reviewer` -- flag y valor adyacentes en el argv, no
# sueltos. Se ubica cada invocacion por CONTENIDO (no por orden de llamada).
B_WRITER_CALL="$(_find_call "$B_CAP" opencode mefisto-writer || true)"
B_REVIEWER_CALL="$(_find_call "$B_CAP" opencode mefisto-reviewer || true)"
if [ -n "$B_WRITER_CALL" ] && _argv_has_flag_value "$B_WRITER_CALL" --agent mefisto-writer; then
    pass "C-6: el CLI falso de opencode se invoco con '--agent mefisto-writer' (adyacentes) en Stage 1"
else
    fail "C-6: no se encontro una invocacion de opencode con '--agent mefisto-writer': ${B_WRITER_CALL:+$(cat "$B_WRITER_CALL")}"
fi
if [ -n "$B_REVIEWER_CALL" ] && _argv_has_flag_value "$B_REVIEWER_CALL" --agent mefisto-reviewer; then
    pass "C-7: el CLI falso de opencode se invoco con '--agent mefisto-reviewer' (adyacentes) en Stage 2"
else
    fail "C-7: no se encontro una invocacion de opencode con '--agent mefisto-reviewer': ${B_REVIEWER_CALL:+$(cat "$B_REVIEWER_CALL")}"
fi

# ============================================================================
# [D] Escenario (c): MEFISTO_RUNTIME=opencode, fallo terminal del writer en
# Stage 1 (fixture congelado empty-1.18.29.jsonl: stream vacio + exit 1)
# ============================================================================

echo ""
echo "[D] Escenario (c): MEFISTO_RUNTIME=opencode, fallo terminal del writer en Stage 1 (CA-2)"

C_ISSUE="912103"
run_scenario opencode "$C_ISSUE" fail "$FIXTURES_OPENCODE_DIR/empty-1.18.29.jsonl" 1
C_CAP="$SCEN_CAP"

if [ "$SCEN_RC" -ne 0 ]; then
    pass "D-1: el pipeline aborta en Stage 1 (rc=$SCEN_RC != 0)"
else
    fail "D-1: se esperaba que el pipeline abortara (rc=0)"
fi

if [ ! -f "$C_CAP/gh-pr-create.calls" ]; then
    pass "D-2: el stub de 'gh pr create' nunca se invoco"
else
    fail "D-2: 'gh pr create' se invoco pese al fallo terminal en Stage 1"
fi

C_STATUS_FILE="$STATE_DIR/pipeline-status-mefisto-tooling-${C_ISSUE}.json"
if [ -f "$C_STATUS_FILE" ] && [ "$(jq -r '.state' "$C_STATUS_FILE")" = "failed" ]; then
    pass "D-3: el status de la corrida queda en 'failed'"
else
    fail "D-3: no se encontro pipeline-status-mefisto-tooling-${C_ISSUE}.json con state:failed"
fi

C_HIST="$STATE_DIR/pipeline-history.jsonl"
C_FAILED_COUNT="$(jq -c --arg issue "$C_ISSUE" 'select(.issue == $issue and .state == "failed")' "$C_HIST" 2>/dev/null | wc -l | tr -d ' ')"
C_COMPLETED_COUNT="$(jq -c --arg issue "$C_ISSUE" 'select(.issue == $issue and .state == "completed")' "$C_HIST" 2>/dev/null | wc -l | tr -d ' ')"
if [ "${C_FAILED_COUNT:-0}" -ge 1 ] && [ "${C_COMPLETED_COUNT:-0}" = "0" ]; then
    pass "D-4: pipeline-history.jsonl tiene una entrada 'failed' del issue $C_ISSUE y ninguna 'completed'"
else
    fail "D-4: historial inesperado -- failed=$C_FAILED_COUNT completed=$C_COMPLETED_COUNT"
fi

C_WRITER_EV="$(_events_file "$C_ISSUE" "1" "writer")"
if [ -n "$C_WRITER_EV" ] && [ -f "$C_WRITER_EV" ]; then
    C_TERM="$(tail -n1 "$C_WRITER_EV")"
    C_T_TYPE="$(printf '%s' "$C_TERM" | jq -r '.type')"
    if [ "$C_T_TYPE" = "run.failed" ]; then
        pass "D-5: events.jsonl de Stage 1 (writer) termina en run.failed (sin resumen, exit != 0)"
    else
        fail "D-5: terminal inesperado en events.jsonl de Stage 1: $C_TERM"
    fi
else
    fail "D-5: no se encontro events.jsonl de Stage 1 (writer) para el issue $C_ISSUE"
fi

if [ -z "$(_events_file "$C_ISSUE" "2" "reviewer")" ]; then
    pass "D-6: Stage 2 (reviewer) nunca arranco: no hay events.jsonl del reviewer para el issue $C_ISSUE"
else
    fail "D-6: el pipeline lanzo Stage 2 (reviewer) pese al fallo terminal de Stage 1"
fi

# ============================================================================
# [E] Escenario (d): sin mapping local ni --models se aplican las tablas de
# cada adaptador. Claude deep usa opus; OpenCode usa GPT-6 Sol para ambos stages.
# ============================================================================

echo ""
echo "[E] Escenario (d): defaults de modelo por runtime y perfil (CA-1)"

if [ -n "$B_REVIEWER_CALL" ]; then
    if _argv_has_flag_value "$B_REVIEWER_CALL" -m openai/gpt-6-sol; then
        pass "E-1: opencode -- reviewer deep usa '-m openai/gpt-6-sol'"
    else
        fail "E-1: opencode -- reviewer deep no uso el default GPT-6 Sol: $(cat "$B_REVIEWER_CALL")"
    fi
else
    fail "E-1: no se pudo localizar la invocacion del reviewer de la corrida (b)"
fi

if [ -n "$B_WRITER_CALL" ]; then
    if _argv_has_flag_value "$B_WRITER_CALL" -m openai/gpt-6-sol; then
        pass "E-2: opencode -- writer balanced usa '-m openai/gpt-6-sol'"
    else
        fail "E-2: opencode -- writer balanced no uso el default GPT-6 Sol: $(cat "$B_WRITER_CALL")"
    fi
else
    fail "E-2: no se pudo localizar la invocacion del writer de la corrida (b)"
fi

# Cada stage se ubica por su `--agent <id>`, igual que en opencode (#1368):
# el prompt -- que antes nombraba stage-1-writer.md / stage-2-reviewer.md
# dentro del argv -- ya no esta ahi, viaja por stdin (issue #1448).
A_WRITER_CALL="$(_find_call "$A_CAP" claude mefisto-writer || true)"
A_REVIEWER_CALL="$(_find_call "$A_CAP" claude mefisto-reviewer || true)"
if [ -n "$A_REVIEWER_CALL" ]; then
    if _argv_has_flag_value "$A_REVIEWER_CALL" --model opus; then
        pass "E-3: claude -- reviewer deep usa '--model opus'"
    else
        fail "E-3: claude -- la linea de comando del reviewer no trae '--model opus': $(cat "$A_REVIEWER_CALL")"
    fi
else
    fail "E-3: no se pudo localizar la invocacion del reviewer de la corrida (a)"
fi

if [ -n "$A_WRITER_CALL" ]; then
    A_WR_MODEL="$(jq -r '(index("--model")) as $i | if $i == null then "" else .[$i+1] // "" end' "$A_WRITER_CALL" 2>/dev/null)"
    if [ -n "$A_WR_MODEL" ]; then
        pass "E-4: control positivo -- claude writer (perfil balanced) SI recibe '--model $A_WR_MODEL'"
    else
        fail "E-4: claude writer (perfil balanced) deberia recibir --model <no vacio>: $(cat "$A_WRITER_CALL")"
    fi
else
    fail "E-4: no se pudo localizar la invocacion del writer de la corrida (a)"
fi


# ============================================================================
# [F] Escenario (e): gate de neutralidad (issue #914) -- el CLI falso del
# writer introduce una fuga real (src/internal/agents/fx-leak.md con
# "model": "sonnet") DENTRO del scope permitido, asi que el gate de scope da
# via libre y Stage 1 aborta por mefisto-neutrality-gate.sh, sin PR. Desde el
# issue #1473, antes de abortar el pipeline le da al writer UN intento de
# correccion (segundo run_agent sobre el mismo rol, con la salida del gate +
# su remedio); el modo "leak" de este escenario nunca la corrige (el stub
# reintroduce la misma fuga en cada llamada), asi que el intento falla y el
# pipeline aborta igual -- ahora tras exactamente 2 llamadas al CLI falso
# (writer + intento) en vez de 1. El escenario [G] (nuevo, mismo issue) cubre
# el camino donde el intento SI corrige la fuga.
# ============================================================================

echo ""
echo "[F] Escenario (e): MEFISTO_RUNTIME=claude, fuga de neutralidad en Stage 1 -- el gate la frena (CA-2)"

F_ISSUE="912104"
run_scenario claude "$F_ISSUE" leak "$FIXTURES_CLAUDE_DIR/success.jsonl" 0
F_CAP="$SCEN_CAP"

if [ "$SCEN_RC" -ne 0 ]; then
    pass "F-1: el pipeline aborta en Stage 1 por la fuga de neutralidad (rc=$SCEN_RC != 0)"
else
    fail "F-1: se esperaba que el pipeline abortara (rc=0)"
fi

if [ ! -f "$F_CAP/gh-pr-create.calls" ]; then
    pass "F-2: el stub de 'gh pr create' nunca se invoco"
else
    fail "F-2: 'gh pr create' se invoco pese a la fuga de neutralidad"
fi

F_STATUS_FILE="$STATE_DIR/pipeline-status-mefisto-tooling-${F_ISSUE}.json"
if [ -f "$F_STATUS_FILE" ] && [ "$(jq -r '.state' "$F_STATUS_FILE")" = "failed" ]; then
    pass "F-3: el status de la corrida queda en 'failed'"
else
    fail "F-3: no se encontro pipeline-status-mefisto-tooling-${F_ISSUE}.json con state:failed"
fi

if grep -qE 'src/internal/agents/fx-leak\.md:[0-9]+: R1' "$SCEN_ERR"; then
    pass "F-4: el mensaje de aborto incluye la violacion del gate ('src/internal/agents/fx-leak.md:<linea>: R1')"
else
    fail "F-4: el mensaje de aborto no incluye la violacion esperada. stderr: $(cat "$SCEN_ERR")"
fi

if grep -qF -- "--from-stage 1" "$SCEN_ERR"; then
    pass "F-5: el mensaje de aborto incluye el comando de retoma --from-stage 1"
else
    fail "F-5: el mensaje de aborto no incluye el comando de retoma. stderr: $(cat "$SCEN_ERR")"
fi

# F-7/F-8 (issue #1469): la fuga sintetica de este escenario es R1 (fx-leak.md
# con "model": "sonnet") -- el remedio compuesto debe ofrecer el de R1 y NO el
# de R4/adapters-check, que no aplican a esta violacion.
if grep -qF -- "R1:" "$SCEN_ERR"; then
    pass "F-7: el mensaje de aborto incluye el remedio de R1"
else
    fail "F-7: el mensaje de aborto no incluye el remedio de R1. stderr: $(cat "$SCEN_ERR")"
fi

if grep -qF -- "R4:" "$SCEN_ERR" || grep -qF -- "adapters-check:" "$SCEN_ERR"; then
    fail "F-8: el mensaje de aborto no deberia incluir el remedio de R4 ni de adapters-check. stderr: $(cat "$SCEN_ERR")"
else
    pass "F-8: el mensaje de aborto no incluye el remedio de R4 ni de adapters-check"
fi

F_HIST="$STATE_DIR/pipeline-history.jsonl"
F_FAILED_COUNT="$(jq -c --arg issue "$F_ISSUE" 'select(.issue == $issue and .state == "failed")' "$F_HIST" 2>/dev/null | wc -l | tr -d ' ')"
F_COMPLETED_COUNT="$(jq -c --arg issue "$F_ISSUE" 'select(.issue == $issue and .state == "completed")' "$F_HIST" 2>/dev/null | wc -l | tr -d ' ')"
if [ "${F_FAILED_COUNT:-0}" -ge 1 ] && [ "${F_COMPLETED_COUNT:-0}" = "0" ]; then
    pass "F-6: pipeline-history.jsonl tiene una entrada 'failed' del issue $F_ISSUE y ninguna 'completed'"
else
    fail "F-6: historial inesperado -- failed=$F_FAILED_COUNT completed=$F_COMPLETED_COUNT"
fi

# F-9/F-10 (issue #1473): en modo "leak" la fuga es PERMANENTE (el stub la
# reintroduce en cada llamada), asi que el intento de correccion que ahora
# antepone run_neutrality_gate a su abort() no la elimina -- el pipeline
# aborta igual, pero solo despues de una segunda llamada al CLI falso (el
# intento) y dejando constancia de que la fuga persistio.
F_CALL_COUNT=$(cat "$F_CAP/claude-call-count" 2>/dev/null || echo 0)
if [ "$F_CALL_COUNT" = "2" ]; then
    pass "F-9: el CLI falso recibio exactamente 2 llamadas (writer + intento de correccion, sin llegar al reviewer)"
else
    fail "F-9: se esperaban exactamente 2 llamadas al CLI falso, se registraron $F_CALL_COUNT"
fi

if grep -qF -- "[neutralidad][fix] writer: persiste" "$STATE_DIR/events.log" 2>/dev/null; then
    pass "F-10: events.log registra '[neutralidad][fix] writer: persiste' tras el intento de correccion"
else
    fail "F-10: events.log no registra '[neutralidad][fix] writer: persiste'. events.log: $(grep -F '[neutralidad]' "$STATE_DIR/events.log" 2>/dev/null)"
fi

# ============================================================================
# [G] Escenario (h): intento de correccion exitoso (issue #1473) -- el CLI
# falso del writer deja la fuga solo en la llamada 1 (modo "leak-then-fix"); a
# partir de la llamada 2 (el intento de correccion que compone
# run_neutrality_gate, un segundo run_agent sobre el mismo rol) elimina
# src/internal/agents/fx-leak.md, el gate pasa en la segunda pasada y el stage
# sigue -- corrida completa hasta crear el PR, sin abortar.
# ============================================================================

echo ""
echo "[G] Escenario (h): MEFISTO_RUNTIME=claude, fuga corregida en el intento -- la corrida completa (CA-1/CA-2/CA-3, #1473)"

G_ISSUE="912105"
run_scenario claude "$G_ISSUE" leak-then-fix "$FIXTURES_CLAUDE_DIR/success.jsonl" 0
G_CAP="$SCEN_CAP"
assert_success_run G claude "$G_ISSUE" "$G_CAP"

G_CALL_COUNT=$(cat "$G_CAP/claude-call-count" 2>/dev/null || echo 0)
if [ "$G_CALL_COUNT" -ge 3 ]; then
    pass "G-6: el CLI falso recibio $G_CALL_COUNT llamadas (>= 3: writer + intento de correccion + reviewer)"
else
    fail "G-6: se esperaban >= 3 llamadas al CLI falso, se registraron $G_CALL_COUNT"
fi

G_FIX_METRICS=$(find "$STATE_DIR/metrics" -name "mefisto-tooling-*-issue-${G_ISSUE}-stage-1-fix-writer.json" 2>/dev/null | head -n1)
if [ -n "$G_FIX_METRICS" ] && [ -f "$G_FIX_METRICS" ]; then
    pass "G-7: existe metrics/*-stage-1-fix-writer.json del intento de correccion"
else
    fail "G-7: no se encontro metrics/*-stage-1-fix-writer.json para el issue $G_ISSUE"
fi

if grep -qF -- "[neutralidad][fix] writer: corregido" "$STATE_DIR/events.log" 2>/dev/null; then
    pass "G-8: events.log registra '[neutralidad][fix] writer: corregido'"
else
    fail "G-8: events.log no registra '[neutralidad][fix] writer: corregido'. events.log: $(grep -F '[neutralidad]' "$STATE_DIR/events.log" 2>/dev/null)"
fi

# CA-3: la duracion del intento se registra APARTE, en su propia linea de
# events.log -- es lo unico que queda de ella, porque LAST_AGENT_DURATION se
# restaura a la de la corrida principal (lo que comprueba G-9 por el lado de
# las metricas).
if grep -qE '\[neutralidad\]\[fix\] writer: [0-9]+s$' "$STATE_DIR/events.log" 2>/dev/null; then
    pass "G-10: events.log registra aparte la duracion del intento de correccion"
else
    fail "G-10: events.log no registra la duracion del intento ('[neutralidad][fix] writer: <s>s')"
fi

G_MAIN_METRICS="$(_metrics_file "$G_ISSUE" 1 writer)"
case "$G_MAIN_METRICS" in
    "") fail "G-9: no se encontro metrics/*-stage-1-writer.json (corrida principal) para el issue $G_ISSUE" ;;
    *stage-1-fix-writer.json) fail "G-9: _metrics_file devolvio el archivo del fix en vez del de la corrida principal: $G_MAIN_METRICS" ;;
    *) pass "G-9: _metrics_file del issue $G_ISSUE stage 1 writer sigue siendo el de la corrida principal (no el del fix)" ;;
esac

# ============================================================================
# [H] Escenario (f): contexto acotado del reviewer (issue #1449, CA-3) -- el
# writer deja en el worktree un archivo de >= 3 MB dentro del scope; el prompt
# de Stage 2 debe pesar bien por debajo de esa magnitud (no contiene el diff
# completo) y aun asi traer los SHA y las rutas cambiadas.
# ============================================================================

echo ""
echo "[H] Escenario (f): MEFISTO_RUNTIME=claude, diff de >= 3 MB -- el prompt de Stage 2 no crece con el (CA-3, #1449)"

H_ISSUE="912106"
run_scenario claude "$H_ISSUE" big "$FIXTURES_CLAUDE_DIR/success.jsonl" 0
H_CAP="$SCEN_CAP"
assert_success_run H claude "$H_ISSUE" "$H_CAP"

H_PROMPT="$(_stage2_prompt_files "$H_ISSUE" | tail -n1)"
if [ -n "$H_PROMPT" ] && [ -f "$H_PROMPT" ]; then
    H_PROMPT_BYTES=$(wc -c < "$H_PROMPT" | tr -d ' ')
    if [ "$H_PROMPT_BYTES" -lt 65536 ]; then
        pass "H-6: el prompt de Stage 2 pesa $H_PROMPT_BYTES bytes (< 64 KiB) pese al diff de >= 3 MB del writer"
    else
        fail "H-6: el prompt de Stage 2 pesa $H_PROMPT_BYTES bytes (>= 64 KiB) -- volvio a crecer con el tamano del diff"
    fi

    if grep -qE '^diff --git' "$H_PROMPT" || grep -qE '^@@' "$H_PROMPT"; then
        fail "H-7: el prompt de Stage 2 todavia contiene cuerpo de diff ('diff --git' o '@@')"
    else
        pass "H-7: el prompt de Stage 2 no contiene ninguna linea 'diff --git' ni '@@'"
    fi

    if grep -qE '^Commit base: [0-9a-f]{7,40}$' "$H_PROMPT" && grep -qE '^HEAD del writer: [0-9a-f]{7,40}$' "$H_PROMPT"; then
        pass "H-8: el prompt de Stage 2 trae 'Commit base' y 'HEAD del writer' con SHA"
    else
        fail "H-8: el prompt de Stage 2 no trae ambos SHA esperados: $(grep -E 'Commit base|HEAD del writer' "$H_PROMPT")"
    fi

    if grep -qF "docs/1449-big-file.md" "$H_PROMPT"; then
        pass "H-9: el prompt de Stage 2 trae la ruta cambiada (--name-status) del archivo grande"
    else
        fail "H-9: el prompt de Stage 2 no menciona docs/1449-big-file.md"
    fi
else
    fail "H-6..9: no se encontro el prompt de Stage 2 para el issue $H_ISSUE"
fi

# ============================================================================
# [I] Escenario (g): reanudacion --from-stage 2 calcula el mismo contexto que
# la corrida completa (issue #1449, CA-4). Primera corrida: el writer tiene
# exito (mode "fail-stage2", N=1) y el reviewer falla siempre (N>=2) sin
# reintentos utiles -- el pipeline aborta en Stage 2 pero el worktree, con el
# commit del writer, sobrevive (solo el camino de exito completo lo borra).
# Segunda corrida: mismo issue, --from-stage 2, reviewer siempre falla (modo
# "always-fail") -- solo interesa el prompt que vuelve a generar.
# ============================================================================

echo ""
echo "[I] Escenario (g): --from-stage 2 calcula el mismo commit base/HEAD que la corrida completa (CA-4, #1449)"

I_ISSUE="912107"
run_scenario claude "$I_ISSUE" fail-stage2 "$FIXTURES_CLAUDE_DIR/api-error-404.jsonl" 1
I_PROMPT_1="$(_stage2_prompt_files "$I_ISSUE" | tail -n1)"

if [ "$SCEN_RC" -ne 0 ]; then
    pass "I-1: la corrida completa aborta en Stage 2 (rc=$SCEN_RC != 0)"
else
    fail "I-1: se esperaba que la corrida completa abortara en Stage 2 (rc=0)"
fi

I_SNAP_1="$TMP/i-stage2-prompt-corrida-completa.md"
if [ -n "$I_PROMPT_1" ] && [ -f "$I_PROMPT_1" ]; then
    # Copia aparte antes de la segunda corrida: el nombre del prompt lleva el
    # TIMESTAMP del pipeline con resolucion de segundos, asi que una colision
    # sobrescribiria el prompt de la corrida completa y I-4 se quedaria sin
    # evidencia con que comparar.
    cp "$I_PROMPT_1" "$I_SNAP_1"
    pass "I-2: la corrida completa dejo un prompt de Stage 2 antes de abortar"
else
    fail "I-2: no se encontro el prompt de Stage 2 de la corrida completa para el issue $I_ISSUE"
fi

# Garantiza que la reanudacion caiga en un segundo distinto (mismo motivo: el
# TIMESTAMP del nombre del prompt tiene resolucion de segundos).
sleep 1
run_scenario claude "$I_ISSUE" always-fail "" 1 "--from-stage 2"
I_PROMPT_2="$(_stage2_prompt_files "$I_ISSUE" | tail -n1)"

if [ -n "$I_PROMPT_2" ] && [ "$I_PROMPT_2" != "$I_PROMPT_1" ] && [ -f "$I_PROMPT_2" ]; then
    pass "I-3: la reanudacion con --from-stage 2 genero un prompt de Stage 2 nuevo"
else
    fail "I-3: la reanudacion no genero un prompt de Stage 2 distinto del de la corrida completa"
fi

if [ -f "$I_SNAP_1" ] && [ -n "$I_PROMPT_2" ] && [ -f "$I_PROMPT_2" ]; then
    I_BASE_1="$(grep -E '^Commit base: ' "$I_SNAP_1")"
    I_HEAD_1="$(grep -E '^HEAD del writer: ' "$I_SNAP_1")"
    I_BASE_2="$(grep -E '^Commit base: ' "$I_PROMPT_2")"
    I_HEAD_2="$(grep -E '^HEAD del writer: ' "$I_PROMPT_2")"
    if [ -n "$I_BASE_1" ] && [ "$I_BASE_1" = "$I_BASE_2" ] && [ -n "$I_HEAD_1" ] && [ "$I_HEAD_1" = "$I_HEAD_2" ]; then
        pass "I-4: '$I_BASE_1' / '$I_HEAD_1' -- mismo commit base y HEAD del writer en la corrida completa y en la reanudacion"
    else
        fail "I-4: SHA distintos entre corrida completa (${I_BASE_1:-?}/${I_HEAD_1:-?}) y reanudacion (${I_BASE_2:-?}/${I_HEAD_2:-?})"
    fi
else
    fail "I-4: faltan uno o ambos prompts de Stage 2 para comparar SHA"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
