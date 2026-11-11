#!/usr/bin/env bash
# Resolucion ejecutable del preambulo de la raiz del paquete en los agentes TDD generados:
# corre el bloque de shell que publica la proyeccion Claude. El resto del corte vertical de los
# agentes TDD esta en tdd-agents.test.mts.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
first_bash_block() { awk '/^```bash$/{inside=1; next} /^```$/{if (inside) exit} inside' "$1"; }
claude_substitute() { local pat='${CLAUDE_PLUGIN_ROOT}'; printf '%s\n' "${1//"$pat"/$2}"; }

echo '[conocimiento] los agentes generados abren ADRs y Skill desde el package root efectivo'
# MEF-ADR-0031: prueba la resolucion ejecutable desde los agentes generados, no
# solo la presencia textual de las directivas en la fuente. La fixture usa una
# raiz con espacios y contiene bytes de la distribucion real.
claude_package="$WORK/paquete Claude con espacios"
mkdir -p "$claude_package/.claude-plugin" "$claude_package/docs/adr" "$claude_package/skills/projections"
cp "$REPO_ROOT/.claude-plugin/plugin.json" "$claude_package/.claude-plugin/plugin.json"
cp "$REPO_ROOT/mefisto-manifest.json" "$claude_package/mefisto-manifest.json"
for adr in mef-adr-0002-estrategia-testing-event-sourcing.md mef-adr-0016-convencion-naming-tests.md mef-adr-0035-doctrina-proyeccion-query-read-side.md mef-adr-0034-worker-proyecciones-read-models.md mef-adr-0006-convenciones-nombramiento-funciones-azure.md mef-adr-0041-forma-propia-vista-read-side.md mef-adr-0028-estrategia-tenancy.md mef-adr-0029-test-composicion-host.md; do cp "$REPO_ROOT/dist/claude/docs/adr/$adr" "$claude_package/docs/adr/"; done
for resource in modelos-marten.md read-apis.md naming.md config-test.md; do cp "$REPO_ROOT/skills/projections/$resource" "$claude_package/skills/projections/$resource"; done
claude_physical="$(cd "$claude_package" && pwd -P)"
claude_preamble="$(first_bash_block "$REPO_ROOT/dist/claude/agents/reviewer.md")"
claude_resolved="$(bash -c "$(claude_substitute "$claude_preamble" "$claude_package/")"$'\n''test -f "$MEFISTO_PACKAGE_ROOT/docs/adr/mef-adr-0016-convencion-naming-tests.md" && for resource in modelos-marten.md read-apis.md naming.md config-test.md; do test -f "$MEFISTO_PACKAGE_ROOT/skills/projections/$resource" || exit 1; done && printf "%s\n" "$MEFISTO_PACKAGE_ROOT"' 2>/dev/null)"; rc=$?
[ "$rc" -eq 0 ] && [ "$claude_resolved" = "$claude_physical" ] && pass 'reviewer Claude generado abre ADRs y Skill desde un package root con espacios' || fail 'reviewer Claude generado no resuelve su conocimiento desde el package root efectivo'

claude_preamble="$(first_bash_block "$REPO_ROOT/dist/claude/agents/projection-implementer.md")"
claude_resolved="$(bash -c "$(claude_substitute "$claude_preamble" "$claude_package/")"$'\n''for adr in mef-adr-0035-doctrina-proyeccion-query-read-side.md mef-adr-0034-worker-proyecciones-read-models.md mef-adr-0006-convenciones-nombramiento-funciones-azure.md mef-adr-0041-forma-propia-vista-read-side.md mef-adr-0028-estrategia-tenancy.md mef-adr-0029-test-composicion-host.md; do test -f "$MEFISTO_PACKAGE_ROOT/docs/adr/$adr" || exit 1; done && for resource in modelos-marten.md naming.md read-apis.md config-test.md; do test -f "$MEFISTO_PACKAGE_ROOT/skills/projections/$resource" || exit 1; done && printf "%s\n" "$MEFISTO_PACKAGE_ROOT"' 2>/dev/null)"; rc=$?
[ "$rc" -eq 0 ] && [ "$claude_resolved" = "$claude_physical" ] && pass 'projection-implementer Claude generado abre ADRs y Skill desde un package root con espacios' || fail 'projection-implementer Claude generado no resuelve su conocimiento desde el package root efectivo'

claude_preamble="$(first_bash_block "$REPO_ROOT/dist/claude/agents/projection-test-writer.md")"
claude_resolved="$(bash -c "$(claude_substitute "$claude_preamble" "$claude_package/")"$'\n''for adr in mef-adr-0035-doctrina-proyeccion-query-read-side.md mef-adr-0034-worker-proyecciones-read-models.md mef-adr-0006-convenciones-nombramiento-funciones-azure.md mef-adr-0041-forma-propia-vista-read-side.md mef-adr-0016-convencion-naming-tests.md mef-adr-0002-estrategia-testing-event-sourcing.md; do test -f "$MEFISTO_PACKAGE_ROOT/docs/adr/$adr" || exit 1; done && for resource in modelos-marten.md naming.md read-apis.md config-test.md; do test -f "$MEFISTO_PACKAGE_ROOT/skills/projections/$resource" || exit 1; done && printf "%s\n" "$MEFISTO_PACKAGE_ROOT"' 2>/dev/null)"; rc=$?
[ "$rc" -eq 0 ] && [ "$claude_resolved" = "$claude_physical" ] && pass 'projection-test-writer Claude generado abre ADRs y Skill desde un package root con espacios' || fail 'projection-test-writer Claude generado no resuelve su conocimiento desde el package root efectivo'

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
