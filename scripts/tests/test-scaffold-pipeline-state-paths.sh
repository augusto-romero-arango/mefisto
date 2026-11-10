#!/usr/bin/env bash
# test-scaffold-pipeline-state-paths.sh -- Regresion de #1645: scaffold-pipeline.sh
# escribe su estado (logs, events.log, pipeline-history.jsonl) exclusivamente
# bajo el root canonico de mefisto_state_path() (MEF-ADR-0053 seccion 4), nunca
# bajo .claude/pipeline, y su commit defensivo no incluye .mefisto/pipeline.
# Corre el pipeline COMPLETO en un repo git temporal con origin real, runner
# stub (MEFISTO_RUN_AGENT_BIN), gh stub y git real.
#
#   [A] Root canonico (CA-5 a/b/d)
#   [B] MEFISTO_STATE_DIR (CA-5 c)
#   [C] Worktree dentro de .mefisto/pipeline/worktrees/ (#2341 CA-1/3/4)
#
# Uso: scripts/tests/test-scaffold-pipeline-state-paths.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PASS=0; FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
SAFE_SYSTEM_PATH="/usr/bin:/bin:/usr/sbin:/sbin"

# setup_case <case-dir>: crea <case-dir>/work (clon con origin bare), stubs y clausura publicada.
setup_case() {
    local base="$1" bare="$1/origin.git" work="$1/work" bin="$1/bin"
    mkdir -p "$base" "$bin"
    git init -q --bare "$bare"
    git -C "$bare" symbolic-ref HEAD refs/heads/main
    git clone -q "$bare" "$work" 2>/dev/null
    git -C "$work" config user.email "test@mefisto.local"
    git -C "$work" config user.name "Mefisto Test"
    mkdir -p "$work/.mefisto" "$work/scripts" "$work/src"
    cat > "$work/.mefisto/harness.config.json" <<'JSON'
{
  "projectName": "TestProject",
  "namespacePrefix": "Test.Namespace",
  "solutionFile": "Test.slnx",
  "domainLabels": ["dom1"],
  "boundedContext": { "name": "TestBC", "domains": ["dom1"] }
}
JSON
    git -C "$work" add -A
    git -C "$work" commit -q -m "base"
    git -C "$work" push -q origin main
    cp "$REPO_ROOT/scripts/_pipeline-common.sh" "$work/scripts/_pipeline-common.sh"
    cp "$REPO_ROOT/scripts/scaffold-pipeline.sh" "$work/scripts/scaffold-pipeline.sh"
    chmod +x "$work/scripts/scaffold-pipeline.sh"
    cp -R "$REPO_ROOT/src/runtime" "$work/src/runtime"

    cat > "$bin/gh" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
    "pr create") echo "https://example.invalid/pr/1"; exit 0 ;;
esac
exit 0
STUB
    printf '#!/usr/bin/env bash\nexit 0\n' > "$bin/claude"
    cat > "$base/run-agent.sh" <<'STUB'
#!/usr/bin/env bash
cwd="" event_log=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --cwd) cwd="$2"; shift 2 ;;
        --event-log) event_log="$2"; shift 2 ;;
        *) shift ;;
    esac
done
ns="Test.Namespace.Prueba"
mkdir -p "$cwd/src/$ns" "$cwd/tests/$ns.Tests" "$cwd/.mefisto/pipeline/summaries"
printf '<Project><ItemGroup><PackageReference Include="OpenTelemetry.Extensions.Hosting" Version="1.15.3" /></ItemGroup></Project>\n' > "$cwd/src/$ns/$ns.csproj"
printf '<Project><ItemGroup><PackageReference Include="OpenTelemetry.Exporter.InMemory" Version="1.15.3" /></ItemGroup></Project>\n' > "$cwd/tests/$ns.Tests/$ns.Tests.csproj"
printf 'estado del agente\n' > "$cwd/.mefisto/pipeline/summaries/stage-1.md"
printf '%s\n' '{"type":"run.completed","status":"success","session_id":"s","denials":0,"error":null}' > "$event_log"
exit 0
STUB
    chmod +x "$bin/gh" "$bin/claude" "$base/run-agent.sh"
}

run_case() {
    local base="$1"; shift
    ( cd "$base/work" || exit 99
      env -i HOME="$HOME" PATH="$base/bin:$SAFE_SYSTEM_PATH" \
          MEFISTO_RUNTIME=claude MEFISTO_RUN_AGENT_BIN="$base/run-agent.sh" \
          "$@" ./scripts/scaffold-pipeline.sh --domain prueba )
}

echo "[A] Root canonico: estado bajo .mefisto/pipeline, sin .claude/pipeline"
A="$TMP_DIR/a"; setup_case "$A"
run_case "$A" </dev/null >"$A/stdout" 2>"$A/stderr"; RC_A=$?
[ "$RC_A" -eq 0 ] && pass "el pipeline completa con exit 0" || fail "exit $RC_A: $(cat "$A/stderr")"
C="$A/work/.mefisto/pipeline"
ls "$C"/logs/scaffold-*.log >/dev/null 2>&1 && pass "log principal bajo .mefisto/pipeline/logs/" || fail "falta log principal"
ls "$C"/logs/scaffold-agent-*.log >/dev/null 2>&1 && pass "log del agente bajo .mefisto/pipeline/logs/" || fail "falta log del agente"
[ -f "$C/events.log" ] && pass "events.log bajo .mefisto/pipeline/" || fail "falta events.log"
if [ -s "$C/pipeline-history.jsonl" ] \
    && jq -e '.pipeline=="scaffold" and .domain=="prueba" and .runtime=="claude" and .state=="completed" and (.pr|length>0)' "$C/pipeline-history.jsonl" >/dev/null 2>&1; then
    pass "pipeline-history.jsonl con fila scaffold"
else
    fail "historial ausente o invalido: $(cat "$C/pipeline-history.jsonl" 2>/dev/null)"
fi
LOG_DECL=$(jq -r 'select(.state=="completed") | .log // empty' "$C/pipeline-history.jsonl" 2>/dev/null | tail -n1)
if [ -n "$LOG_DECL" ] && [ -f "$LOG_DECL" ] && [[ "$LOG_DECL" == /*/.mefisto/pipeline/logs/scaffold-*-*.log ]]; then
    pass "la entrada completed declara log existente (scaffold-<ts>-<pid>.log)"
else
    fail "log ausente o inexistente en la entrada completed: '$LOG_DECL'"
fi
[ ! -e "$C/history.jsonl" ] && pass "no se escribe history.jsonl" || fail "history.jsonl legacy presente"
[ ! -e "$A/work/.claude/pipeline" ] && pass "no se crea .claude/pipeline" || fail ".claude/pipeline creado"
grep -Fq "$C/logs/" "$A/stdout" && pass "el resumen imprime ruta absoluta bajo .mefisto/pipeline/logs/" || fail "resumen sin ruta absoluta de logs"
if git -C "$A/origin.git" log --name-only --format= main..scaffold-prueba 2>/dev/null | grep -q '^src/Test.Namespace.Prueba' \
    && ! git -C "$A/origin.git" log --name-only --format= main..scaffold-prueba 2>/dev/null | grep -q '^\.mefisto/pipeline'; then
    pass "el commit del scaffold no incluye .mefisto/pipeline"
else
    fail "commit del scaffold ausente o con .mefisto/pipeline: $(git -C "$A/origin.git" log --name-only --format= main..scaffold-prueba 2>&1)"
fi

echo "[B] MEFISTO_STATE_DIR: todo el estado cae en el override"
B="$TMP_DIR/b"; setup_case "$B"; SD="$B/custom-state"
run_case "$B" MEFISTO_STATE_DIR="$SD" </dev/null >"$B/stdout" 2>"$B/stderr"; RC_B=$?
[ "$RC_B" -eq 0 ] && pass "el pipeline completa con override" || fail "exit $RC_B: $(cat "$B/stderr")"
if ls "$SD"/logs/scaffold-*.log >/dev/null 2>&1 && [ -f "$SD/events.log" ] && [ -s "$SD/pipeline-history.jsonl" ]; then
    pass "logs, events.log e historial en MEFISTO_STATE_DIR"
else
    fail "estado ausente en $SD: $(ls -R "$SD" 2>&1)"
fi
[ ! -e "$B/work/.mefisto/pipeline/pipeline-history.jsonl" ] && [ ! -e "$B/work/.claude/pipeline" ] \
    && pass "el repo no recibe estado del pipeline" || fail "el repo recibio estado pese al override"

echo "[C] Worktree en .mefisto/pipeline/worktrees/ y checkout principal limpio (#2341)"
W="$TMP_DIR/c"; setup_case "$W"
printf '.mefisto/pipeline/\n' > "$W/work/.gitignore"
git -C "$W/work" add .gitignore && git -C "$W/work" commit -q -m "gitignore" && git -C "$W/work" push -q origin main
# El agente stub commitea su trabajo: el commit defensivo (fuera de este caso) no entra en juego.
{ grep -v '^exit 0$' "$W/run-agent.sh"
  printf '%s\n' 'git -C "$cwd" add -A -- src tests && git -C "$cwd" commit -q -m agente' 'exit 0'
} > "$W/run-agent.tmp" && mv "$W/run-agent.tmp" "$W/run-agent.sh" && chmod +x "$W/run-agent.sh"
W_ROOT="$(cd "$W/work" && pwd -P)"
PORCELAIN_BEFORE=$(git -C "$W/work" status --porcelain)
run_case "$W" </dev/null >"$W/stdout" 2>"$W/stderr"; RC_C=$?
[ "$RC_C" -eq 0 ] && pass "el pipeline completa con .mefisto/pipeline/ ignorado" || fail "exit $RC_C: $(cat "$W/stderr")"
grep -Fq "Creando worktree: $W_ROOT/.mefisto/pipeline/worktrees/scaffold-prueba" "$W/stdout" \
    && pass "el worktree se crea en .mefisto/pipeline/worktrees/<rama>" || fail "ruta de worktree inesperada: $(grep -F 'Creando worktree' "$W/stdout")"
[ ! -e "$W/scaffold-prueba" ] && pass "no se crea worktree al lado del repo" || fail "worktree creado al lado del repo"
[ ! -e "$W/work/.mefisto/pipeline/worktrees/scaffold-prueba" ] \
    && pass "el worktree se elimina al terminar con exito" || fail "el worktree sigue en .mefisto/pipeline/worktrees/"
PORCELAIN=$(git -C "$W/work" status --porcelain)
[ "$PORCELAIN" = "$PORCELAIN_BEFORE" ] && pass "git status --porcelain del checkout principal no gana entradas" || fail "checkout principal con entradas nuevas: $PORCELAIN"

printf '\nResultado: %s PASS, %s FAIL\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
