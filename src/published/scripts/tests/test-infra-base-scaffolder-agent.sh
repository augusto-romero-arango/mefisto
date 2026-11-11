#!/usr/bin/env bash
# Gate greenfield y workflow nuget-audit.yml del agente infra-base-scaffolder (issue #1760):
# ejecuta los bloques de shell que el agente embebe. El resto del contrato del agente esta en
# infra-base-scaffolder-agent.test.mts.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/agents/infra-base-scaffolder.md"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }

echo '[d] nuget-audit.yml (issue #1760): gate greenfield y workflow generado'
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

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
