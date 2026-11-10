#!/usr/bin/env bash
# Regresion de #1624: iac-pipeline.sh conecta run_agent al runner neutral
# (mefisto-run-agent.sh) conservando la politica de hold/retry de MEF-ADR-0051
# sobre el JSONL neutral. Mismo molde que test-tooling-neutral-runner.sh.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PIPELINE="$ROOT/scripts/iac-pipeline.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { grep -Fq -- "$1" "$PIPELINE" && pass "$2" || fail "$2"; }
absent() { grep -Fq -- "$1" "$PIPELINE" && fail "$2" || pass "$2"; }

echo '[frontera] runner neutral en iac-pipeline.sh'
contains 'mefisto-run-agent.sh' 'localiza el runner desde la clausura publicada'
contains 'RUN_AGENT_BIN_DEFAULT' 'define el default del runner como en tooling-pipeline.sh'
contains 'MEFISTO_RUN_AGENT_BIN' 'permite override del runner via MEFISTO_RUN_AGENT_BIN'
contains 'infra-writer balanced' 'writer usa id y perfil neutral'
contains 'infra-reviewer deep' 'reviewer usa id y perfil neutral'
contains 'mefisto_resolve_model "$MEFISTO_RUNTIME_RESUELTO" "$agent_id" "$profile"' 'resuelve el modelo con el helper neutral'
contains '--resume-session' 'reanudacion via session_id neutral'
contains 'runtime_supports_resume' 'consulta capability de reanudacion'
contains 'agent_events_completed_successfully' 'exige terminal neutral de exito'
contains 'agent_events_resets_at' 'honra el resets_at del JSONL neutral en el hold'
contains 'mefisto_resolve_runtime' 'resuelve el runtime activo'
contains 'runtime_cli_available' 'valida el CLI del runtime resuelto'
contains 'if "$RUN_AGENT_BIN" "${args[@]}"' 'invoca el runner con un array, sin eval'
absent 'claude -p' 'no invoca Claude directamente'
absent 'claude $RESUME_ARGS' 'no reanuda con el CLI de un runtime concreto'
absent '--permission-mode' 'no fija permisos de un runtime'
absent 'resolve_declared_agent_model' 'no resuelve el modelo visible del frontmatter de un runtime concreto'
absent 'bypassPermissions' 'no fija permisos de un runtime'
absent 'agent_session_transcript_count' 'no depende del store de transcripts de un CLI concreto'
absent '.claude/settings.json"' 'no copia settings.json de Claude al worktree'
absent 'checkout -- .claude/' 'no restaura .claude/ en cleanup (ya no lo parchea)'
contains 'for cmd in gh git jq terraform' 'jq es dependencia dura; claude ya no se exige'

echo '[regresion] invocacion ejecutable de run_agent'

extract_run_agent() {
    awk '/^run_agent\(\) \{/{p=1} p{print} p && /^}/{p=0}' "$PIPELINE"
}

# build_case <tmp-dir> <stub-bin> <extra-env-lines-file>
#
# Escribe en <tmp-dir>/case.sh la funcion run_agent REAL extraida del pipeline
# mas un entorno minimo bajo `set -eu`: mismo patron que la "regresion" de
# test-tooling-neutral-runner.sh. abort() se sobreescribe a `return 1` -- bajo
# `set -eu`, eso hace que el propio interprete corte el script exactamente en
# ese punto, asi que el exit code de case.sh ya distingue avance/fallo sin
# necesidad de un flag aparte.
build_case() {
    local tmp="$1" stub="$2" extra_env="$3"
    mkdir -p "$tmp/logs" "$tmp/pipeline-tmp" "$tmp/worktree/.claude/pipeline/summaries"
    {
        printf '%s\n' 'set -eu'
        extract_run_agent
        cat <<EOF
LOG_DIR_ABS="$tmp/logs"
TIMESTAMP='20260101-000000'
ISSUE_NUM='1624'
PIPELINE_TMP_DIR="$tmp/pipeline-tmp"
WORKTREE_PATH="$tmp/worktree"
RUN_AGENT_BIN="$stub"
MEFISTO_RUNTIME_RESUELTO='fake'
MEFISTO_RUNTIME_LIB_DIR="$ROOT/src/runtime/lib"
MODEL_WRITER=''
MODEL_REVIEWER=''
EFFORT_WRITER=''
EFFORT_REVIEWER=''
EVENTS_LOG_ABS="$tmp/events.log"
RED=''
NC=''
: > "\$EVENTS_LOG_ABS"
log() { :; }
warn() { :; }
abort() { return 1; }
update_status() { :; }
EOF
        printf 'source "%s"\n' "$ROOT/scripts/_pipeline-common.sh"
        [ -z "$extra_env" ] || cat "$extra_env"
        printf '%s\n' "run_agent '1' 'infra-writer' 'prompt de prueba #1624'"
    } > "$tmp/case.sh"
}

# --- (a)+(b): argv correcto y exito de la primera pasada avanza -------------
AB_TMP="$(mktemp -d -t mefisto-iac-ab)"
cat > "$AB_TMP/stub" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$AB_TMP/args"
event_log=""
while [ "\$#" -gt 0 ]; do
    case "\$1" in --event-log) event_log="\$2"; shift 2 ;; *) shift ;; esac
done
printf '%s\n' '{"type":"run.completed","status":"success","session_id":"sess-ab","denials":0,"error":null}' > "\$event_log"
exit 0
EOF
chmod +x "$AB_TMP/stub"
build_case "$AB_TMP" "$AB_TMP/stub" ""
if bash "$AB_TMP/case.sh"; then
    AB_ARGS_FLAT="$(tr '\n' ' ' < "$AB_TMP/args")"
    if printf '%s' "$AB_ARGS_FLAT" | grep -Fq -- '--agent infra-writer' \
        && printf '%s' "$AB_ARGS_FLAT" | grep -Fq -- "--cwd $AB_TMP/worktree"; then
        pass '(a) argv incluye --agent infra-writer y --cwd <worktree>'
    else
        fail '(a) argv no incluye --agent infra-writer / --cwd <worktree>'
    fi
    pass '(b) exit 0 con terminal exitoso avanza (run_agent no aborta)'
else
    fail '(a)/(b) run_agent aborto con un runner exitoso'
fi
rm -rf "$AB_TMP"

# --- (c): exit 0 sin terminal falla -----------------------------------------
C_TMP="$(mktemp -d -t mefisto-iac-c)"
cat > "$C_TMP/stub" <<'EOF'
#!/usr/bin/env bash
while [ "$#" -gt 0 ]; do
    case "$1" in --event-log) : > "$2"; shift 2 ;; *) shift ;; esac
done
exit 0
EOF
chmod +x "$C_TMP/stub"
build_case "$C_TMP" "$C_TMP/stub" ""
if bash "$C_TMP/case.sh"; then
    fail '(c) exit 0 sin terminal deberia fallar y no avanzo'
else
    pass '(c) exit 0 sin terminal neutral falla'
fi
rm -rf "$C_TMP"

# --- (d): rate_limit y luego exito reanuda con --resume-session ------------
D_TMP="$(mktemp -d -t mefisto-iac-d)"
cat > "$D_TMP/stub" <<EOF
#!/usr/bin/env bash
n_file="$D_TMP/count"
n=0; [ -f "\$n_file" ] && n=\$(cat "\$n_file")
n=\$((n + 1)); printf '%s' "\$n" > "\$n_file"
printf '%s\n' "\$@" > "$D_TMP/args-\$n"
event_log=""
while [ "\$#" -gt 0 ]; do
    case "\$1" in --event-log) event_log="\$2"; shift 2 ;; *) shift ;; esac
done
if [ "\$n" -eq 1 ]; then
    printf '%s\n' '{"type":"run.failed","status":"failed","session_id":"sess-1","denials":0,"error":{"kind":"rate_limit"}}' > "\$event_log"
    exit 1
else
    printf '%s\n' '{"type":"run.completed","status":"success","session_id":"sess-1","denials":0,"error":null}' > "\$event_log"
    exit 0
fi
EOF
chmod +x "$D_TMP/stub"
cat > "$D_TMP/extra-env" <<'EOF'
MEFISTO_HOLD_PROBE_SECONDS=1
MEFISTO_FAKE_SUPPORTS_RESUME=1
EOF
build_case "$D_TMP" "$D_TMP/stub" "$D_TMP/extra-env"
if bash "$D_TMP/case.sh" \
    && [ -f "$D_TMP/args-2" ] \
    && grep -Fq -- '--resume-session sess-1' <(tr '\n' ' ' < "$D_TMP/args-2"); then
    pass '(d) rate_limit reanuda con --resume-session tras el hold y termina exitoso'
else
    fail '(d) no reanudo con --resume-session tras rate_limit'
fi
rm -rf "$D_TMP"

# --- (e): stream_cut falla sin linea [hold] ---------------------------------
E_TMP="$(mktemp -d -t mefisto-iac-e)"
cat > "$E_TMP/stub" <<'EOF'
#!/usr/bin/env bash
while [ "$#" -gt 0 ]; do
    case "$1" in
        --event-log) printf '%s\n' '{"type":"run.failed","status":"failed","session_id":null,"denials":0,"error":{"kind":"stream_cut"}}' > "$2"; shift 2 ;;
        *) shift ;;
    esac
done
exit 1
EOF
chmod +x "$E_TMP/stub"
build_case "$E_TMP" "$E_TMP/stub" ""
E_RC=0
bash "$E_TMP/case.sh" || E_RC=$?
if [ "$E_RC" -ne 0 ] && ! grep -Fq '[hold]' "$E_TMP/events.log"; then
    pass '(e) stream_cut falla sin esperar (sin linea [hold] en events.log)'
else
    fail '(e) stream_cut no fallo como esperado, o dejo una linea [hold]'
fi
rm -rf "$E_TMP"

# --- (f): effort por agente con el adaptador fake (issue #2500) --------------
echo '[effort] --effort recibido por infra-writer e infra-reviewer'
contains '[ -n "$effort" ] && args+=(--effort "$effort")' 'pasa --effort solo si el effort resuelto no es vacio'
contains 'resolve_pipeline_agent_effort infra-writer infra-writer' 'resuelve el effort del writer antes del worktree'
contains 'resolve_pipeline_agent_effort infra-reviewer infra-reviewer' 'resuelve el effort del reviewer antes del worktree'
contains 'MEFISTO_EFFORTS_ERROR' 'un mapping de effort invalido aborta citando MEFISTO_EFFORTS_ERROR'

F_TMP="$(mktemp -d -t mefisto-iac-f)"
cat > "$F_TMP/stub" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$F_TMP/args"
event_log=""
while [ "\$#" -gt 0 ]; do
    case "\$1" in --event-log) event_log="\$2"; shift 2 ;; *) shift ;; esac
done
printf '%s\n' '{"type":"run.completed","status":"success","session_id":"sess-f","denials":0,"error":null}' > "\$event_log"
exit 0
EOF
chmod +x "$F_TMP/stub"
cat > "$F_TMP/models.json" <<'EOF'
{"fake":{"efforts":{"levels":{"light":"n-light","standard":"n-standard"},"agents":{"infra-writer":"standard"}}}}
EOF
# eff_args <infra-writer|infra-reviewer> <models-file>: deja el argv en $F_TMP/args
eff_args() {
    local agent="$1" models="$2" role=WRITER
    [ "$agent" = infra-reviewer ] && role=REVIEWER
    : > "$F_TMP/extra-env"
    {
        printf 'source "%s"\n' "$ROOT/src/runtime/lib/mefisto-models.sh"
        printf 'CONSUMER_MODELS_FILE="%s"\n' "$models"
        printf 'resolve_pipeline_agent_effort %s %s\n' "$agent" "$agent"
        printf 'EFFORT_%s="$RESOLVED_PIPELINE_EFFORT"\n' "$role"
    } > "$F_TMP/extra-env"
    rm -f "$F_TMP/args"
    build_case "$F_TMP" "$F_TMP/stub" "$F_TMP/extra-env"
    sed -i.bak "s/run_agent '1' 'infra-writer'/run_agent '1' '$agent'/" "$F_TMP/case.sh"
    bash "$F_TMP/case.sh"
}
if eff_args infra-writer "$F_TMP/ausente.json" && eff_args infra-reviewer "$F_TMP/ausente.json" \
    && ! grep -qx -- '--effort' "$F_TMP/args"; then
    pass '(f) sin mapping ni default: no se pasa --effort (hereda)'
else
    fail '(f) sin mapping no debia pasarse --effort'
fi
if eff_args infra-writer "$F_TMP/models.json" && grep -qx -- '--effort' "$F_TMP/args" && grep -qx 'n-standard' "$F_TMP/args"; then
    pass '(f) infra-writer con efforts.agents recibe n-standard'
else
    fail "(f) infra-writer: $(tr '\n' ' ' < "$F_TMP/args" 2>/dev/null)"
fi
if eff_args infra-reviewer "$F_TMP/models.json" && grep -qx 'n-standard' "$F_TMP/args"; then
    pass '(f) infra-reviewer sin override recibe el nativo de su nivel de fabrica (standard)'
else
    fail "(f) infra-reviewer: $(tr '\n' ' ' < "$F_TMP/args" 2>/dev/null)"
fi
rm -rf "$F_TMP"

printf '\nResultado: %s PASS, %s FAIL\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
