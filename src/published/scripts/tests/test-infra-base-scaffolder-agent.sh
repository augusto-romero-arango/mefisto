#!/usr/bin/env bash
# Contrato del agente infra-base-scaffolder neutral y su proyeccion publicada
# (issue #1649: migracion desde agents/infra-base-scaffolder.md hand-escrito Claude-only).
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/agents/infra-base-scaffolder.md"
CLAUDE="$REPO_ROOT/dist/claude/agents/infra-base-scaffolder.md"
MIRROR="$REPO_ROOT/agents/infra-base-scaffolder.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }

echo '[fuente] (a) metadata y perfil'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "agent" and .id == "infra-base-scaffolder" and .mode == "all" and .profile == "balanced" and .capabilities == ["read","edit","shell"] and (has("mcp") | not)' >/dev/null; then
    pass 'metadata declara agent/infra-base-scaffolder/all/balanced/read-edit-shell sin mcp'
else
    fail 'metadata neutral invalida'
fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
contains "$body" '{{mefisto:config-path}}' 'lee el config via config-path'
contains "$body" '{{mefisto:instructions-path}}' 'lee RootNamespace via instructions-path'
contains "$body" '{{mefisto:command onboard}}' 'remite al diagnostico via command onboard'
contains "$body" '{{mefisto:run register-harness-secret.sh' 'Paso 2b.0 delega en register-harness-secret.sh via run'

echo '[fuente] (b) ausencia de acoplamientos de runtime'
for pattern in 'source "$' 'source "${' '_pipeline-common.sh' '.plugin-root' 'plugins/cache' 'PLUGIN_ROOT' 'export MEFISTO_INSTRUCTIONS_PATH' '.claude/harness.config.json' 'upsert_harness_secret'; do
    absent "$body" "$pattern" "fuente no contiene '$pattern'"
done

echo '[salidas] adaptador y mirror'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"
contains "$claude_body" 'name: "infra-base-scaffolder"' 'Claude expone el id del agente'
contains "$claude_body" 'model: "sonnet"' 'Claude materializa el perfil balanced como sonnet'
absent "$claude_body" 'source "${PLUGIN_ROOT' 'claude_body no hace source del script comun'
absent "$claude_body" '_pipeline-common.sh' 'claude_body no referencia _pipeline-common.sh'
absent "$claude_body" 'CONFIG="$REPO_ROOT' 'claude_body no reconstruye la ruta del config a mano'

echo '[c] Paso 2b.0 invoca el script distribuido con el runtime de su adaptador'
contains "$claude_body" 'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/register-harness-secret.sh" "marten-connection" "composite" "marten-connection"' 'Claude registra marten-connection como composite'
contains "$claude_body" '"app-insights-connection" "output" "app_insights_connection_string"' 'se conserva app-insights-connection como output'
contains "$claude_body" '"github-secret" "SB_EXTERNAL_COSMOS_CONNECTION_STRING"' 'se conserva el registro por alias external como github-secret'

echo '[d] nuget-audit.yml (issue #1760): gate greenfield y workflow generado'
contains "$body" 'NUGET_AUDIT_GREENFIELD=si' 'Paso 0 calcula el gate greenfield'
gate_line="$(grep -n 'NUGET_AUDIT_GREENFIELD=si$' "$SOURCE" | head -n1 | cut -d: -f1)"
first_write="$(grep -n '^## Paso 1 - Generar' "$SOURCE" | head -n1 | cut -d: -f1)"
if [ -n "$gate_line" ] && [ -n "$first_write" ] && [ "$gate_line" -lt "$first_write" ]; then pass 'el gate se calcula antes de escribir el esqueleto'; else fail 'el gate no precede a la escritura'; fi
contains "$body" 'nunca sobrescribas' 'nunca sobrescribe nuget-audit.yml'
contains "$body" 'ya inicializado al comenzar' 'omite la auditoria en consumidores ya inicializados'
contains "$body" 'dotnet package list --project "$SOLUTION" --vulnerable --include-transitive --format json --output-version 1' 'usa dotnet package list sobre la solucion'
absent "$body" '--no-restore --vulnerable' 'no usa --no-restore en la auditoria'

contains "$body" 'NUGET_AUDIT_GREENFIELD=<si|no>' 'Paso 2b.1 sustituye el valor literal del gate (el shell no persiste)'

gate="$(awk '/^\*\*Gate greenfield de la auditoria NuGet/ { s=1 } s && /^```bash$/ { b=1; next } b && /^```$/ { exit } b { print }' "$SOURCE")"
decide="$(awk '/^## Paso 2b.1/ { s=1 } s && /^```bash$/ { b=1; next } b && /^```$/ { exit } b { print }' "$SOURCE")"
GTMP="$(mktemp -d)"
run_gate() { ( cd "$1" && bash -c "$gate" ); }
run_decide() { ( cd "$1" && bash -c "${decide/<si|no>/$2}" ); }
mkdir -p "$GTMP/green" "$GTMP/cd/.github/workflows" "$GTMP/env/infra/environments/dev" "$GTMP/idem/.github/workflows"
: > "$GTMP/cd/.github/workflows/infra-cd.yml"; : > "$GTMP/env/infra/environments/dev/main.tf"; : > "$GTMP/idem/.github/workflows/nuget-audit.yml"
contains "$(run_gate "$GTMP/green")" 'NUGET_AUDIT_GREENFIELD=si' 'gate: repo vacio es greenfield'
contains "$(run_gate "$GTMP/cd")" 'NUGET_AUDIT_GREENFIELD=no' 'gate: infra-cd.yml previo marca ya inicializado'
contains "$(run_gate "$GTMP/env")" 'NUGET_AUDIT_GREENFIELD=no' 'gate: environments/*/main.tf previo marca ya inicializado'
out="$(run_decide "$GTMP/cd" no)"
contains "$out" 'ya inicializado al comenzar' 'reejecucion sobre consumidor inicializado sin nuget-audit.yml no lo agrega'
if [ ! -e "$GTMP/cd/.github/workflows/nuget-audit.yml" ]; then pass 'reejecucion no crea nuget-audit.yml'; else fail 'reejecucion creo nuget-audit.yml'; fi
contains "$(run_decide "$GTMP/idem" si)" 'no se sobrescribe' 'idempotencia: nuget-audit.yml existente no se sobrescribe'
run_decide "$GTMP/green" si >/dev/null
if [ -d "$GTMP/green/.github/workflows" ]; then pass 'greenfield prepara .github/workflows'; else fail 'greenfield no prepara .github/workflows'; fi
rm -rf "$GTMP"

wf="$(awk '/^## Paso 2b.1/ { s=1 } s && /^```yaml$/ { y=1; next } y && /^```$/ { exit } y { print }' "$SOURCE")"
contains "$wf" 'pull_request:' 'workflow usa pull_request'
absent "$wf" 'paths' 'workflow sin filtros de rutas'
absent "$wf" 'id-token' 'workflow sin OIDC'
absent "$wf" 'secrets.' 'workflow sin secretos'
contains "$wf" "dotnet-version: '10.0.x'" 'workflow usa SDK .NET 10'
runscript="$(printf '%s\n' "$wf" | awk '/^        run: \|$/ { r=1; next } r { sub(/^          /, ""); print }')"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
cat > "$TMP/bin/dotnet" <<'STUB'
#!/usr/bin/env bash
case "$STUB_MODE" in
    fail) echo boom >&2; exit 1 ;;
    garbage) echo 'no-json'; exit 0 ;;
    clean) echo '{"version":1,"projects":[{"path":"x","frameworks":[{"framework":"net10.0","topLevelPackages":[{"id":"A","resolvedVersion":"1.0.0"}]}]}]}' ;;
    vuln) echo '{"version":1,"projects":[{"path":"x","frameworks":[{"framework":"net10.0","topLevelPackages":[{"id":"Marten","resolvedVersion":"9.12.0","vulnerabilities":[{"severity":"High","advisoryurl":"https://github.com/advisories/GHSA-x"}]}],"transitivePackages":[{"id":"Otel|<b>","resolvedVersion":"1.14.0","vulnerabilities":[{"severity":"Moderate","advisoryurl":"https://github.com/advisories/GHSA-y"}]}]}]}]}' ;;
esac
STUB
chmod +x "$TMP/bin/dotnet"
run_audit() { # $1 modo, $2 con_solucion(si/no) ; imprime resumen y codigo
    local d="$TMP/run-$1-$2"; rm -rf "$d"; mkdir -p "$d"
    printf -- '- **SolutionFile**: App.slnx\n' > "$d/AGENTS.md"
    [ "$2" = si ] && : > "$d/App.slnx"
    ( cd "$d" && STUB_MODE="$1" PATH="$TMP/bin:$PATH" RUNNER_TEMP="$d" GITHUB_STEP_SUMMARY="$d/summary.md" bash -c "$runscript" >/dev/null 2>&1; echo "exit=$?" >> "$d/summary.md" )
    cat "$d/summary.md"
}
out="$(run_audit vuln si)"
contains "$out" 'Marten | 9.12.0 | High | https://github.com/advisories/GHSA-x' 'resultado vulnerable lista paquete directo'
contains "$out" '1.14.0 | Moderate' 'resultado vulnerable lista paquete transitivo'
absent "$out" '<b>' 'datos del escaneo saneados'
contains "$out" 'exit=0' 'vulnerable termina success'
out="$(run_audit clean si)"
contains "$out" 'Sin advisories' 'resultado limpio se informa'
contains "$out" 'exit=0' 'limpio termina success'
out="$(run_audit fail si)"
contains "$out" 'no verificada' 'falla de dotnet es no verificable'
absent "$out" 'Sin advisories' 'falla de dotnet no se confunde con limpio'
contains "$out" 'exit=0' 'falla de dotnet no bloquea'
out="$(run_audit garbage si)"
contains "$out" 'no verificada' 'parseo fallido es no verificable'
out="$(run_audit clean no)"
contains "$out" 'no verificada' 'sin solucion es no verificable'
contains "$out" 'exit=0' 'sin solucion no bloquea'

echo '[mirror] agents/infra-base-scaffolder.md pasa a generado'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
contains "$(< "$MIRROR")" '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/agents/infra-base-scaffolder.md. No editar a mano. -->' 'mirror conserva marcador generado'
if jq -e '.assets[] | select(.destination == "agents/infra-base-scaffolder.md")' "$REPO_ROOT/dist/claude/.mefisto-generated-assets.json" >/dev/null 2>&1; then
    pass 'claude inventaria el agente'
else
    fail 'claude no inventaria el agente'
fi
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
