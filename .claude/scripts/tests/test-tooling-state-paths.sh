#!/usr/bin/env bash
# test-tooling-state-paths.sh -- Tests del traslado de mefisto-tooling-pipeline.sh
# y _mefisto-common.sh al layout canonico, con rutas de estado neutrales
# (MEF-ADR-0049, issue #869).
#
# Cubre:
#   [pre] La politica interna y el nucleo comun existen con sintaxis
#         bash valida; los shims de .claude/scripts/ tambien (CA-1).
#   [A]   Los shims son EXACTAMENTE la plantilla documentada en
#         src/internal/scripts/README.md: exec de 3 lineas para el pipeline,
#         source de una linea para la lib (CA-1).
#   [B]   El pipeline canonico no contiene la ruta legacy ".claude/pipeline"
#         (CA-2).
#   [C]   El pipeline canonico resuelve su estado con MEFISTO_STATE_DIR /
#         mefisto_state_path, no con una ruta hardcodeada (CA-2).
#   [D]   collect_summary() y el SUMMARY_FILE de run_agent() resuelven el
#         resumen de stage con mefisto_state_path "summaries/..." "$WORKTREE_PATH"
#         (CA-2).
#   [E]   Los prompts de stage 1/2 le piden al agente escribir su resumen bajo
#         .mefisto/pipeline/summaries/, nunca bajo .claude/pipeline/ (CA-2).
#   [F]   MEFISTO_RUNTIME se resuelve con mefisto_resolve_runtime y se conecta
#         al runner neutral: run_agent ya no invoca `claude -p` directo, lanza
#         src/runtime/mefisto-run-agent.sh (issue #910); el runtime resuelto se registra en
#         events.log/status/historial.
#   [G]   Corrida real con stubs (claude/gh) contra un origin bare: al cerrar
#         Stage 1 y Stage 2, logs/, metrics/, pipeline-status-*.json y
#         pipeline-history.jsonl (con una linea "failed") quedan bajo
#         .mefisto/pipeline/ del clon, el directorio de summaries del worktree
#         nace bajo .mefisto/pipeline/summaries/, y nada nuevo aparece bajo
#         .claude/pipeline/ (CA-6). El corte lo da el gate de changelog.d/
#         (ningun fragmento creado): no hace falta stub de push/PR.
#   [I]   Los lanzadores (desacoplado, herdr) resuelven events.log y logs/ con
#         mefisto_state_path, de modo que el traslado del pipeline no los deja
#         vigilando archivos que ya nadie escribe (CA-3; el porte completo de
#         ambos es #871/#872).
#   [J]   MEFISTO_AGENT_TIMEOUT_SECONDS (issue #946): con un runtime fake que
#         se cuelga, el stage termina por TIMEOUT en ~1s con
#         MEFISTO_AGENT_TIMEOUT_SECONDS=1, no con el default de 1800s (CA-4);
#         con un valor no entero (p. ej. "abc") el pipeline aborta ANTES de
#         crear el worktree (CA-2). Reutiliza el fixture del bloque G.
#   [K]   MEFISTO_AGENT_TIMEOUT_SECONDS viaja hasta el eslabon (issue #946,
#         CA-3): ni mefisto-batch-pipeline.sh ni mefisto-herdr-pipeline.sh
#         filtran el entorno del pipeline de tooling mas alla de las HERDR_*,
#         asi que la variable llega heredada sin que ningun eslabon la
#         reenvie a mano. Guarda estatica -- sin fixture, siempre corre.
#
# Uso: .claude/scripts/tests/test-tooling-state-paths.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

CANON_PIPE="$REPO_ROOT/src/internal/scripts/mefisto-tooling-pipeline.sh"
CANON_LIB="$REPO_ROOT/src/internal/scripts/lib/_mefisto-common.sh"
SHIM_PIPE="$REPO_ROOT/.claude/scripts/mefisto-tooling-pipeline.sh"
SHIM_LIB="$REPO_ROOT/.claude/scripts/_mefisto-common.sh"

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# -------- Bloque pre --------

echo "[pre] Canonicos y shims existen, con sintaxis bash valida"
for f in "$CANON_PIPE" "$CANON_LIB" "$SHIM_PIPE" "$SHIM_LIB"; do
    if [ -f "$f" ]; then
        pass "$(basename "$(dirname "$f")")/$(basename "$f"): presente"
    else
        fail "$f: ausente"
        echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
        exit 1
    fi
    if bash -n "$f" 2>/dev/null; then
        pass "$(basename "$f") ($f): sintaxis bash valida"
    else
        fail "$(basename "$f") ($f): sintaxis bash invalida"
    fi
done

# -------- Bloque A: los shims son la plantilla exacta --------

echo ""
echo "[A] Los shims siguen la plantilla documentada (CA-1)"

if [ -x "$SHIM_PIPE" ]; then pass "el shim del pipeline tiene bit de ejecucion"; else fail "el shim del pipeline no es ejecutable"; fi

EXPECTED_EXEC_SHIM='exec "$(cd "$(dirname "$0")/../.." && pwd)/src/internal/scripts/$(basename "$0")" "$@"'
if grep -qF "$EXPECTED_EXEC_SHIM" "$SHIM_PIPE"; then
    pass "el shim del pipeline usa 'exec' con la forma documentada"
else
    fail "el shim del pipeline no coincide con la plantilla de exec de src/internal/scripts/README.md"
fi
if [ "$(grep -cv '^\s*#' "$SHIM_PIPE" | grep -cv '^\s*$')" -le 2 ]; then
    pass "el shim del pipeline no tiene logica propia (solo shebang + exec)"
else
    fail "el shim del pipeline tiene mas codigo del esperado"
fi

if grep -q '^source ' "$SHIM_LIB"; then
    pass "el shim de la lib usa 'source' (no 'exec': se sourcea, no se ejecuta)"
else
    fail "el shim de la lib no usa 'source'"
fi
if grep -qF 'src/internal/scripts/lib/_mefisto-common.sh' "$SHIM_LIB"; then
    pass "el shim de la lib apunta al canonico en src/internal/scripts/lib/"
else
    fail "el shim de la lib no referencia la ruta canonica"
fi
if grep -q 'BASH_SOURCE\[0\]' "$SHIM_LIB"; then
    pass "el shim de la lib resuelve via BASH_SOURCE (correcto para un archivo sourceado, no ejecutado)"
else
    fail "el shim de la lib no usa BASH_SOURCE -- '\$0' resolveria mal cuando se sourcea"
fi

# -------- Bloque B: sin la ruta legacy --------

echo ""
echo "[B] El pipeline canonico no contiene la ruta legacy '.claude/pipeline' (CA-2)"
if grep -q '\.claude/pipeline' "$CANON_PIPE"; then
    fail "el pipeline canonico todavia contiene '.claude/pipeline'"
    grep -n '\.claude/pipeline' "$CANON_PIPE"
else
    pass "el pipeline canonico no contiene '.claude/pipeline'"
fi

# -------- Bloque C: el estado se resuelve via el helper neutral --------

echo ""
echo "[C] El pipeline resuelve su estado con MEFISTO_STATE_DIR / mefisto_state_path (CA-2)"

if grep -qF 'PIPELINE_DIR="$MEFISTO_STATE_DIR"' "$CANON_PIPE"; then
    pass "PIPELINE_DIR se resuelve desde MEFISTO_STATE_DIR (mefisto-state.sh)"
else
    fail "PIPELINE_DIR ya no se resuelve desde MEFISTO_STATE_DIR"
fi
if grep -qF 'INTERNAL_MODELS_FILE="${MEFISTO_MODELS_FILE:-${MEFISTO_LAUNCH_ROOT:-$MEFISTO_REPO_ROOT}/.mefisto/models.json}"' "$CANON_PIPE" \
    && grep -qF 'EVENTS_LOG_ABS="$PIPELINE_DIR_ABS/events.log"' "$CANON_PIPE"; then
    pass "mapping interno y events.log se entregan por rutas explicitas al nucleo"
else
    fail "faltan rutas explicitas al mapping interno o events.log"
fi
if grep -qF 'mkdir -p "$WORKTREE_PATH/.mefisto/pipeline/summaries"' "$CANON_PIPE"; then
    pass "el directorio de summaries del worktree se crea bajo .mefisto/pipeline/"
else
    fail "el directorio de summaries del worktree no se crea bajo .mefisto/pipeline/"
fi

# -------- Bloque D: collect_summary/SUMMARY_FILE via mefisto_state_path --------

echo ""
echo "[D] collect_summary() y SUMMARY_FILE resuelven con mefisto_state_path \"summaries/...\" \"\$WORKTREE_PATH\" (CA-2)"

MEFISTO_STATE_PATH_SUMMARY_HITS=$(grep -c 'mefisto_state_path "summaries/stage-\${stage}-\${agent}\.md" "\$WORKTREE_PATH"' "$CANON_PIPE")
if [ "$MEFISTO_STATE_PATH_SUMMARY_HITS" -ge 2 ]; then
    pass "collect_summary() y run_agent() resuelven el resumen via mefisto_state_path (>=2 usos, obtenido $MEFISTO_STATE_PATH_SUMMARY_HITS)"
else
    fail "solo $MEFISTO_STATE_PATH_SUMMARY_HITS uso(s) de mefisto_state_path para el resumen de stage: se esperaban >=2 (collect_summary + run_agent)"
fi

# -------- Bloque E: los prompts de stage referencian la ruta canonica --------

echo ""
echo "[E] Los prompts de stage 1/2 le piden al agente escribir en .mefisto/pipeline/summaries/ (CA-2)"

if grep -qF '.mefisto/pipeline/summaries/stage-1-writer.md' "$CANON_PIPE"; then
    pass "el prompt de stage 1 referencia .mefisto/pipeline/summaries/stage-1-writer.md"
else
    fail "el prompt de stage 1 no referencia la ruta canonica del resumen"
fi
if grep -qF '.mefisto/pipeline/summaries/stage-2-reviewer.md' "$CANON_PIPE"; then
    pass "el prompt de stage 2 referencia .mefisto/pipeline/summaries/stage-2-reviewer.md"
else
    fail "el prompt de stage 2 no referencia la ruta canonica del resumen"
fi

# -------- Bloque F: MEFISTO_RUNTIME se resuelve y conecta al runner (CA-2/CA-4) --------

echo ""
echo "[F] MEFISTO_RUNTIME se resuelve y conecta al runner neutral (issue #910)"

if grep -qF 'MEFISTO_RUNTIME_RESUELTO="$(mefisto_resolve_runtime)"' "$CANON_PIPE"; then
    pass "el pipeline resuelve el runtime activo con mefisto_resolve_runtime"
else
    fail "el pipeline no resuelve MEFISTO_RUNTIME_RESUELTO"
fi
if grep -qF '"runtime": ${MEFISTO_RUNTIME_JSON:-null}' "$CANON_PIPE"; then
    pass "el status declara el campo runtime"
else
    fail "el status no declara el campo runtime"
fi
RUNTIME_HISTORY_HITS=$(grep -cF '\"runtime\":${MEFISTO_RUNTIME_JSON:-null}' "$CANON_PIPE")
if [ "$RUNTIME_HISTORY_HITS" -ge 2 ]; then
    pass "las 2 lineas de historial (completed y failed) llevan runtime ($RUNTIME_HISTORY_HITS)"
else
    fail "solo $RUNTIME_HISTORY_HITS linea(s) de historial llevan runtime: se esperan 2"
fi
if grep -qF 'RUN_AGENT_BIN_DEFAULT="$RUNTIME_DIR/mefisto-run-agent.sh"' "$CANON_PIPE"; then
    pass "run_agent lanza el runner neutral comun de src/runtime/"
else
    fail "run_agent no lanza el runner comun de src/runtime/"
fi
if grep -qE '^\s*claude -p "\$prompt"' "$CANON_PIPE"; then
    fail "todavia queda una invocacion directa de 'claude -p' (issue #910 la retira)"
else
    pass "ninguna invocacion directa de 'claude -p' en el pipeline canonico"
fi

# -------- Bloque G: corrida real con stubs, estado bajo .mefisto/pipeline/ --------

echo ""
echo "[G] Corrida real con stubs: logs/metrics/status/historial quedan bajo .mefisto/pipeline/ (CA-6)"

if ! command -v jq >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
    echo "  SKIP: el bloque G requiere jq y python3, no disponibles en este entorno"
else
    G_TMP="$TMP/g"
    mkdir -p "$G_TMP"

    # Origin bare + clon "fake-mefisto", con el mismo layout canonico que el
    # repo real (canonicos + shims + .gitignore con .mefisto/), para que
    # 'git worktree add ... origin/main' (el primer paso real del pipeline)
    # resuelva igual que en produccion.
    BARE="$G_TMP/origin.git"
    git init -q --bare "$BARE"
    FAKE_MEFISTO="$G_TMP/fake-mefisto"
    git clone -q "$BARE" "$FAKE_MEFISTO"

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
    cp "$CANON_LIB" "$FAKE_MEFISTO/src/internal/scripts/lib/_mefisto-common.sh"
    cp "$REPO_ROOT/src/internal/scripts/lib/mefisto-state.sh" "$FAKE_MEFISTO/src/internal/scripts/lib/mefisto-state.sh"
    # Effort por agente (issue #2499): el pipeline lee el nivel de fabrica del
    # campo `effort` de la fuente neutral de writer/reviewer con frontmatter.sh,
    # antes de crear el worktree; sin estas copias aborta en el arranque.
    cp "$REPO_ROOT/src/internal/scripts/lib/frontmatter.sh" "$FAKE_MEFISTO/src/internal/scripts/lib/frontmatter.sh"
    mkdir -p "$FAKE_MEFISTO/src/internal/agents"
    cp "$REPO_ROOT/src/internal/agents/mefisto-writer.md" "$REPO_ROOT/src/internal/agents/mefisto-reviewer.md" "$FAKE_MEFISTO/src/internal/agents/"
    # El fixture copia el nucleo completo y no conserva una segunda fuente
    # ejecutable de runtime/modelos/runner bajo src/internal/.
    cp -R "$REPO_ROOT/src/runtime" "$FAKE_MEFISTO/src/runtime"
    cp "$REPO_ROOT/src/internal/prompts/noninteractive-system.md" "$FAKE_MEFISTO/src/internal/prompts/noninteractive-system.md"
    chmod +x "$FAKE_MEFISTO/src/runtime/mefisto-run-agent.sh"
    # Gate de neutralidad (issue #914): mefisto-tooling-pipeline.sh ahora lo
    # invoca tras cada stage, mismo motivo que runtime-claude.sh/mefisto-run-agent.sh
    # arriba -- sin el, la corrida real del bloque G aborta con "No such file
    # or directory" antes de llegar al gate de changelog.d/ que este bloque
    # espera ejercer.
    cp "$REPO_ROOT/src/internal/scripts/mefisto-neutrality-gate.sh" "$FAKE_MEFISTO/src/internal/scripts/mefisto-neutrality-gate.sh"
    cp "$REPO_ROOT/src/internal/scripts/mefisto-neutrality-gate.mts" "$FAKE_MEFISTO/src/internal/scripts/mefisto-neutrality-gate.mts"
    mkdir -p "$FAKE_MEFISTO/scripts/lib" && cp "$REPO_ROOT/scripts/lib/cli.mts" "$FAKE_MEFISTO/scripts/lib/cli.mts"
    cp "$REPO_ROOT/src/internal/contract/neutrality-allowlist.json" "$FAKE_MEFISTO/src/internal/contract/neutrality-allowlist.json"
    chmod +x "$FAKE_MEFISTO/src/internal/scripts/mefisto-neutrality-gate.sh"
    cp "$CANON_PIPE" "$FAKE_MEFISTO/src/internal/scripts/mefisto-tooling-pipeline.sh"
    cp "$SHIM_LIB" "$FAKE_MEFISTO/.claude/scripts/_mefisto-common.sh"
    cp "$SHIM_PIPE" "$FAKE_MEFISTO/.claude/scripts/mefisto-tooling-pipeline.sh"
    chmod +x "$FAKE_MEFISTO/.claude/scripts/mefisto-tooling-pipeline.sh" "$FAKE_MEFISTO/src/internal/scripts/mefisto-tooling-pipeline.sh"
    echo "# changelog.d" > "$FAKE_MEFISTO/changelog.d/README.md"

    (cd "$FAKE_MEFISTO" \
        && git add -A \
        && git -c user.email="test@example.com" -c user.name="Test" commit -q -m "base" \
        && git push -q origin main)

    FAKE_BIN="$G_TMP/bin"
    mkdir -p "$FAKE_BIN"

    # Stub de gh: solo 'issue view' responde algo util (un issue abierto). El
    # resto (repo view, etc.) falla -- el pipeline ya degrada con '|| echo ""'.
    # No hace falta stub de 'gh pr create' ni de push a origin: el gate de
    # changelog.d/ (ningun fragmento creado) corta la corrida ANTES de llegar
    # ahi.
    cat > "$FAKE_BIN/gh" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
    printf '{"number":%s,"title":"E2E stub issue 869","body":"cuerpo de prueba stub","state":"OPEN"}\n' "$3"
    exit 0
fi
exit 1
STUB
    chmod +x "$FAKE_BIN/gh"

    # Stub de claude: cada invocacion (writer y reviewer) toca un archivo
    # NOTABLE fuera de changelog.d/ (para forzar el gate de changelog al
    # cerrar stage 2) y deja los dos resumenes de stage bajo la ruta canonica
    # -- auto_commit_if_needed del propio pipeline stagea y commitea el
    # cambio, el stub no necesita invocar git.
    cat > "$FAKE_BIN/claude" <<'STUB'
#!/usr/bin/env bash
mkdir -p docs
echo "cambio del stub $(date +%s%N)" >> docs/869-e2e-marker.md
mkdir -p .mefisto/pipeline/summaries
echo "resumen stub writer" > .mefisto/pipeline/summaries/stage-1-writer.md
echo "resumen stub reviewer" > .mefisto/pipeline/summaries/stage-2-reviewer.md
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"duration_ms":10,"duration_api_ms":5,"total_cost_usd":0.0001,"usage":{"input_tokens":1,"output_tokens":1}}'
exit 0
STUB
    chmod +x "$FAKE_BIN/claude"

    G_OUT="$G_TMP/stdout"; G_ERR="$G_TMP/stderr"
    (
        cd "$FAKE_MEFISTO" || exit 99
        # -u de las MEFISTO_* de estado/repo: esta MISMA sesion corre dentro de
        # una invocacion real de mefisto-tooling-pipeline.sh (el repo principal
        # las exporta antes de invocar `claude -p`), y sin este `env -u` la
        # corrida contra FAKE_MEFISTO heredaria MEFISTO_STATE_DIR/MEFISTO_REPO_ROOT
        # del proceso PADRE -- escribiendo el estado de esta prueba en el
        # .mefisto/pipeline/ del repo real en vez del clon temporal.
        # MEFISTO_RUNTIME=claude fijo (issue #910): la corrida no depende de
        # la autodeteccion de mefisto_resolve_runtime ni del toolchain del
        # host.
        env -u MEFISTO_STATE_DIR -u MEFISTO_LEGACY_STATE_DIR -u MEFISTO_REPO_ROOT -u MEFISTO_LAUNCH_ROOT \
            -u MEFISTO_PROJECT_NAME -u MEFISTO_REPO_SLUG \
            PATH="$FAKE_BIN:$PATH" MEFISTO_RUNTIME=claude MEFISTO_AGENT_RETRY_BACKOFF_SECONDS=0 \
            ./.claude/scripts/mefisto-tooling-pipeline.sh 869
    ) </dev/null >"$G_OUT" 2>"$G_ERR"
    G_RC=$?

    if [ "$G_RC" -ne 0 ]; then
        pass "G-1: la corrida aborta (rc=$G_RC) -- se espera el gate de changelog.d/ sin fragmento"
    else
        fail "G-1: se esperaba que la corrida abortara en el gate de changelog.d/ (rc=0)"
    fi
    if grep -q "Cambio notable sin fragmento en changelog.d/" "$G_ERR"; then
        pass "G-2: el motivo del aborto es el gate de changelog.d/ (confirma que Stage 1 y 2 corrieron)"
    else
        fail "G-2: el aborto no fue por el gate de changelog.d/ -- stderr: $(cat "$G_ERR")"
    fi

    STATE_DIR="$FAKE_MEFISTO/.mefisto/pipeline"
    if [ -d "$STATE_DIR/logs" ] && [ -n "$(find "$STATE_DIR/logs" -type f 2>/dev/null)" ]; then
        pass "G-3: .mefisto/pipeline/logs/ tiene archivos"
    else
        fail "G-3: .mefisto/pipeline/logs/ esta vacio o ausente"
    fi
    if [ -d "$STATE_DIR/metrics" ] && [ -n "$(find "$STATE_DIR/metrics" -type f 2>/dev/null)" ]; then
        pass "G-4: .mefisto/pipeline/metrics/ tiene archivos"
    else
        fail "G-4: .mefisto/pipeline/metrics/ esta vacio o ausente"
    fi
    if compgen -G "$STATE_DIR/pipeline-status-mefisto-tooling-869*.json" >/dev/null 2>&1; then
        pass "G-5: pipeline-status-mefisto-tooling-869*.json existe bajo .mefisto/pipeline/ (el abort no lo borra)"
    else
        fail "G-5: no se encontro pipeline-status-mefisto-tooling-869*.json bajo .mefisto/pipeline/"
    fi
    if [ -f "$STATE_DIR/pipeline-history.jsonl" ] && grep -q '"issue":"869".*"state":"failed"' "$STATE_DIR/pipeline-history.jsonl"; then
        pass "G-6: pipeline-history.jsonl registra la corrida con state=failed"
    else
        fail "G-6: pipeline-history.jsonl no registra la corrida fallida"
    fi
    if [ -f "$STATE_DIR/events.log" ] && grep -q "MEFISTO-TOOLING" "$STATE_DIR/events.log"; then
        pass "G-7: events.log de la corrida vive bajo .mefisto/pipeline/"
    else
        fail "G-7: no se encontro events.log bajo .mefisto/pipeline/"
    fi

    LEGACY_DIR="$FAKE_MEFISTO/.claude/pipeline"
    if [ ! -d "$LEGACY_DIR" ] || [ -z "$(find "$LEGACY_DIR" -type f 2>/dev/null)" ]; then
        pass "G-8: no aparecio nada nuevo bajo .claude/pipeline/"
    else
        fail "G-8: aparecieron archivos bajo .claude/pipeline/: $(find "$LEGACY_DIR" -type f 2>/dev/null)"
    fi

    if compgen -G "$FAKE_MEFISTO/.mefisto/worktrees/worktree-mefisto-issue-869-*" >/dev/null 2>&1; then
        WT_DIR=$(compgen -G "$FAKE_MEFISTO/.mefisto/worktrees/worktree-mefisto-issue-869-*" | head -n1)
        if [ -d "$WT_DIR/.mefisto/pipeline/summaries" ]; then
            pass "G-9: el worktree de la corrida tiene .mefisto/pipeline/summaries/ (creado al preparar el worktree)"
        else
            fail "G-9: el worktree de la corrida no tiene .mefisto/pipeline/summaries/"
        fi
        if [ -f "$WT_DIR/.mefisto/pipeline/summaries/stage-1-writer.md" ] && [ -f "$WT_DIR/.mefisto/pipeline/summaries/stage-2-reviewer.md" ]; then
            pass "G-10: los resumenes de stage 1 y 2 quedaron en la ruta canonica del worktree"
        else
            fail "G-10: faltan resumenes de stage en .mefisto/pipeline/summaries/ del worktree"
        fi
    else
        fail "G-9/G-10: no se encontro el worktree de la corrida (abort() lo deja en disco, ver nota tecnica del pipeline)"
    fi

    # -------- Bloque J: MEFISTO_AGENT_TIMEOUT_SECONDS (issue #946) --------
    #
    # Reutiliza el mismo FAKE_MEFISTO/FAKE_BIN del bloque G (origin/main sigue
    # intacto: la corrida de G aborto en el gate de changelog.d/ antes de
    # pushear nada). J-1/J-2/J-3 prueban CA-4 con un runtime fake que se
    # cuelga: el stage debe terminar por TIMEOUT en ~1s con
    # MEFISTO_AGENT_TIMEOUT_SECONDS=1, no esperar el default de 1800s.
    # J-4/J-5/J-6 prueban CA-2: un valor no entero aborta el pipeline ANTES de
    # crear el worktree.

    echo ""
    echo "[J] MEFISTO_AGENT_TIMEOUT_SECONDS controla el timeout de stage (issue #946)"

    cat > "$FAKE_BIN/claude" <<'STUB'
#!/usr/bin/env bash
sleep 1000
STUB
    chmod +x "$FAKE_BIN/claude"

    J1_ERR="$G_TMP/j1-stderr"
    J1_START=$(date +%s)
    (
        cd "$FAKE_MEFISTO" || exit 99
        env -u MEFISTO_STATE_DIR -u MEFISTO_LEGACY_STATE_DIR -u MEFISTO_REPO_ROOT -u MEFISTO_LAUNCH_ROOT \
            -u MEFISTO_PROJECT_NAME -u MEFISTO_REPO_SLUG \
            PATH="$FAKE_BIN:$PATH" MEFISTO_RUNTIME=claude MEFISTO_AGENT_RETRY_BACKOFF_SECONDS=0 \
            MEFISTO_AGENT_TIMEOUT_SECONDS=1 MEFISTO_AGENT_MAX_ATTEMPTS=1 \
            ./.claude/scripts/mefisto-tooling-pipeline.sh 870
    ) </dev/null >/dev/null 2>"$J1_ERR"
    J1_RC=$?
    J1_ELAPSED=$(( $(date +%s) - J1_START ))

    if [ "$J1_RC" -ne 0 ]; then
        pass "J-1: la corrida aborta (rc=$J1_RC) tras el TIMEOUT del stage 1"
    else
        fail "J-1: se esperaba que la corrida abortara por TIMEOUT (rc=0)"
    fi
    if grep -q "TIMEOUT" "$J1_ERR"; then
        pass "J-2: el motivo del aborto menciona TIMEOUT"
    else
        fail "J-2: el aborto no menciona TIMEOUT -- stderr: $(cat "$J1_ERR")"
    fi
    if [ "$J1_ELAPSED" -le 30 ]; then
        pass "J-3: el stage termino en ${J1_ELAPSED}s -- acorde a MEFISTO_AGENT_TIMEOUT_SECONDS=1, no al default de 1800s"
    else
        fail "J-3: el stage tardo ${J1_ELAPSED}s -- MEFISTO_AGENT_TIMEOUT_SECONDS=1 no parece haberse aplicado"
    fi

    J4_ERR="$G_TMP/j4-stderr"
    (
        cd "$FAKE_MEFISTO" || exit 99
        env -u MEFISTO_STATE_DIR -u MEFISTO_LEGACY_STATE_DIR -u MEFISTO_REPO_ROOT -u MEFISTO_LAUNCH_ROOT \
            -u MEFISTO_PROJECT_NAME -u MEFISTO_REPO_SLUG \
            PATH="$FAKE_BIN:$PATH" MEFISTO_RUNTIME=claude MEFISTO_AGENT_TIMEOUT_SECONDS=abc \
            ./.claude/scripts/mefisto-tooling-pipeline.sh 871
    ) </dev/null >/dev/null 2>"$J4_ERR"
    J4_RC=$?

    if [ "$J4_RC" -ne 0 ]; then
        pass "J-4: MEFISTO_AGENT_TIMEOUT_SECONDS=abc aborta el pipeline"
    else
        fail "J-4: se esperaba que abc abortara el pipeline (rc=0)"
    fi
    if grep -q "MEFISTO_AGENT_TIMEOUT_SECONDS" "$J4_ERR" && grep -q "abc" "$J4_ERR"; then
        pass "J-5: el mensaje de aborto nombra la variable y el valor recibido"
    else
        fail "J-5: el mensaje de aborto no nombra la variable/valor -- stderr: $(cat "$J4_ERR")"
    fi
    if compgen -G "$FAKE_MEFISTO/.mefisto/worktrees/worktree-mefisto-issue-871-*" >/dev/null 2>&1; then
        fail "J-6: se creo un worktree para el issue 871 pese a que MEFISTO_AGENT_TIMEOUT_SECONDS era invalido"
    else
        pass "J-6: no se creo worktree para el issue 871 (abort ocurrio antes de crear el worktree)"
    fi
fi

# -------- Bloque K: la variable de timeout viaja heredada hasta el eslabon --------

echo ""
echo "[K] MEFISTO_AGENT_TIMEOUT_SECONDS se hereda en batch y herdr sin reenvio explicito (issue #946, CA-3)"

# CA-3 se cumple hoy por OMISION: ningun eslabon menciona la variable, y por
# eso mismo un grep de presencia no la puede acreditar. Lo que hay que fijar
# es la propiedad que la sostiene -- que ninguno de los dos lanzadores PODE el
# entorno del hijo. Es fragil de la forma que una guarda estatica ataja bien:
# el filtro de mefisto-herdr-pipeline.sh (env_unset) ya existe y es un
# denylist, asi que ampliarlo una linea de mas apagaria en silencio todo
# override de timeout de una corrida en herdr -- sin error visible, solo
# stages volviendo al default de 1800s.

CANON_BATCH="$REPO_ROOT/src/internal/scripts/mefisto-batch-pipeline.sh"
CANON_HERDR="$REPO_ROOT/src/internal/scripts/mefisto-herdr-pipeline.sh"

if grep -qE '\benv (-u|-i)\b' "$CANON_BATCH"; then
    fail "K-1: mefisto-batch-pipeline.sh filtra el entorno del eslabon (env -u/-i): $(grep -nE '\benv (-u|-i)\b' "$CANON_BATCH" | head -n1)"
else
    pass "K-1: mefisto-batch-pipeline.sh no filtra el entorno del eslabon (lo hereda completo)"
fi

HERDR_UNSET_ARMS=$(grep -cE 'env_unset\+=' "$CANON_HERDR")
HERDR_UNSET_NON_HERDR=$(grep -E 'env_unset\+=' "$CANON_HERDR" | grep -cvE '^[[:space:]]*HERDR_\*\)' || true)
if [ "$HERDR_UNSET_ARMS" -ge 1 ] && [ "$HERDR_UNSET_NON_HERDR" -eq 0 ]; then
    pass "K-2: el unico filtro de mefisto-herdr-pipeline.sh es la rama HERDR_* ($HERDR_UNSET_ARMS acumulacion(es) de env_unset)"
else
    fail "K-2: mefisto-herdr-pipeline.sh acumula env_unset fuera de la rama HERDR_* ($HERDR_UNSET_NON_HERDR linea(s)): un denylist mas ancho puede tragarse MEFISTO_AGENT_TIMEOUT_SECONDS"
fi

K3_HITS=$(grep -lE -- '-u "?MEFISTO_' "$CANON_BATCH" "$CANON_HERDR" 2>/dev/null || true)
if [ -z "$K3_HITS" ]; then
    pass "K-3: ninguno de los dos lanzadores desregistra una MEFISTO_* del entorno del hijo"
else
    fail "K-3: hay lanzadores que desregistran alguna MEFISTO_* del entorno del hijo: $K3_HITS"
fi

# -------- Bloque I: los lanzadores siguen viendo la corrida --------

echo ""
echo "[I] los lanzadores resuelven el estado de la corrida con mefisto_state_path (CA-3)"

# El traslado del pipeline mueve events.log y logs/ a .mefisto/pipeline/. Los
# lanzadores que en ese momento vivian en .claude/scripts/ los componian a
# mano contra .claude/pipeline/, asi que -- sin cambiar una linea de su codigo
# -- pasaban a vigilar archivos que ya nadie escribe: un events.log vacio toda
# la corrida, y el pane de reporte de herdr apuntando a un directorio de logs
# muerto. Ninguno de los dos falla ni avisa; simplemente no muestra nada. El
# porte del lanzador se cerro en #871 y el de herdr en #872 (ambos ya
# canonicos en src/internal/scripts/). Esto solo fija que la resolucion no
# vuelva a quedarse atras.
LAUNCHER="$REPO_ROOT/src/internal/scripts/mefisto-launch-pipeline.sh"
HERDR_LAUNCHER="$REPO_ROOT/src/internal/scripts/mefisto-herdr-pipeline.sh"

if grep -qF 'EVENTS_LOG="$(mefisto_state_path "events.log")"' "$LAUNCHER"; then
    pass "I-1: el lanzador prepara el events.log que el pipeline escribe hoy"
else
    fail "I-1: mefisto-launch-pipeline.sh no resuelve events.log con mefisto_state_path"
fi
if grep -qF 'LOG_DIR_ABS="$(mefisto_state_path "logs")"' "$HERDR_LAUNCHER"; then
    pass "I-2: herdr busca los logs de la corrida donde el pipeline los deja"
else
    fail "I-2: mefisto-herdr-pipeline.sh no resuelve logs/ con mefisto_state_path"
fi
for launcher in "$LAUNCHER" "$HERDR_LAUNCHER"; do
    name=$(basename "$launcher")
    # Solo lineas de CODIGO: los comentarios si pueden nombrar la ruta legacy al
    # explicar por que se dejo de usar.
    legacy_refs=$(grep -vE '^\s*#' "$launcher" | grep -c '\.claude/pipeline' || true)
    if [ "$legacy_refs" -eq 0 ]; then
        pass "I-3: $name no compone ninguna ruta .claude/pipeline en codigo"
    else
        fail "I-3: $name todavia compone $legacy_refs ruta(s) .claude/pipeline en codigo"
    fi
done

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
