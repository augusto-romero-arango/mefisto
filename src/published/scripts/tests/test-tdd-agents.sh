#!/usr/bin/env bash
# Verifica el corte vertical de los agentes neutrales del pipeline TDD.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
VALIDATOR="$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh"
source "$REPO_ROOT/src/published/scripts/lib/effective-contract.sh"
source "$REPO_ROOT/src/published/scripts/lib/adapter-claude.sh"
source "$REPO_ROOT/src/published/scripts/adapters/adapter-opencode.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
frontmatter() { awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$1"; }
body() { awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$1"; }
body_without_adapter_lines() {
    body "$1" | awk \
        '!/\{\{mefisto:assert-consumer-repo\}\}/ &&
         !/Antes de continuar, aborta si existe `src\/internal\/scripts\/generate-internal-adapters.sh`/ &&
         !/^<!-- GENERADO por / &&
         !/^Antes de ejecutar este body, usa la tool nativa `skill` para cargar, en este orden: /'
}
translated_source_body() {
    local runtime="$1" source="$2" source_body
    source_body="$(body_without_adapter_lines "$source")"
    case "$runtime" in
        claude) published_claude_translate_body "$source" "$source_body" ;;
        opencode) published_opencode_translate_body "$source" "$source_body" ;;
    esac
}
expected_rendered_body() {
    local runtime="$1" source="$2"
    case "$runtime" in
        claude) published_claude_package_root_preamble ;;
        opencode) package_root_preamble ;;
    esac
    translated_source_body "$runtime" "$source"
}
# Reconstruye solo el preambulo del contrato efectivo de config-path/
# instructions-path (#1408); hoy ningun agente lo usa sin package-root, asi que
# solo lo compone expected_package_root_and_effective_contract_body.
expected_effective_contract_body() {
    local runtime="$1" source="$2" raw_body needs_config=0 needs_instructions=0
    raw_body="$(body_without_adapter_lines "$source")"
    published_effective_contract_needs_config "$raw_body" && needs_config=1
    published_effective_contract_needs_instructions "$raw_body" && needs_instructions=1
    if [ "$needs_config" -eq 1 ] || [ "$needs_instructions" -eq 1 ]; then
        published_effective_contract_preamble "$needs_config" "$needs_instructions"
    fi
    translated_source_body "$runtime" "$source"
}
# projection-test-writer (#1428), test-writer (#1429) y projection-implementer
# (#1433) combinan ambos preambulos: package-root/skill-root para las rutas de
# conocimiento -- ADRs, cheatsheet y recursos de Nivel 3 del Skill (#1446) --
# mas el contrato efectivo de instructions-path para RootNamespace, en ese
# orden. domain-scaffolder (#2432) tambien los combina.
expected_package_root_and_effective_contract_body() {
    local runtime="$1" source="$2"
    case "$runtime" in
        claude) published_claude_package_root_preamble ;;
        opencode) package_root_preamble ;;
    esac
    expected_effective_contract_body "$runtime" "$source"
}
first_bash_block() { awk '/^```bash$/{inside=1; next} /^```$/{if (inside) exit} inside' "$1"; }
claude_substitute() { local pat='${CLAUDE_PLUGIN_ROOT}'; printf '%s\n' "${1//"$pat"/$2}"; }
validator_fixture() {
    local agent="$1" extra="$2" destination="$WORK/$agent.md"
    printf '%s\n' '---' > "$destination"
    frontmatter "$REPO_ROOT/src/published/agents/$agent.md" >> "$destination"
    printf '%s\n\n%s\n%s\n' '---' '{{mefisto:assert-consumer-repo}}' "$extra" >> "$destination"
}

# La lista es el unico punto que los siguientes cortes de la serie deben ampliar.
agents=(test-writer implementer reviewer smoke-test-writer projection-test-writer projection-implementer domain-scaffolder)
descriptions=(
    'Escribe tests ES (fase roja TDD) con DSL Given/When/Then y stubs minimos de compilacion.'
    'Implementa logica de negocio (fase verde TDD) con event sourcing. AggregateRoots, CommandHandlers, Service Bus.'
    'Revisa y refactoriza el código producido en las fases roja y verde del pipeline ES (fase refactor). Verifica patrones de event sourcing y mantiene todos los tests pasando.'
    'Escribe smoke tests black-box contra el entorno dev desplegado. Asume que el proyecto SmokeTests ya existe.'
    'Escribe tests read-side (fase roja TDD) de proyecciones Marten -- unit tests de Create/Apply/ShouldDelete, config-test del worker y composicion de la Function GET. Nunca implementa.'
    'Implementa proyecciones Marten (read models), el seam de registro read-side (Configurar{Dominio}) y las Functions HTTP GET de consulta. Nunca modifica tests.'
    'Crea el scaffold completo para un nuevo dominio (Function App, tests, Terraform, GitHub Actions).'
)
state_agents=(test-writer implementer reviewer smoke-test-writer projection-test-writer projection-implementer)
state_summaries=(
    'stage-1-test-writer'
    'stage-2-implementer'
    'stage-3-reviewer'
    'stage-2b-smoke-test-writer'
    'stage-1-projection-test-writer'
    'stage-2-projection-implementer'
)
# Marca por agente: 1 si reporta bloqueo (exige al menos una mencion), 0 si no (exige ninguna).
state_reports_blockage=(0 1 1 0 0 0)
BLOCKAGE_REF='{{mefisto:state-path blockage-report.md}}'
# Imprime "ok" o la condicion incumplida; no depende de un conteo exacto.
blockage_verdict() {
    local file="$1" reports="$2" mentions
    mentions="$(grep -Fc "$BLOCKAGE_REF" "$file")"
    if [ "$reports" -eq 1 ]; then
        if [ "$mentions" -ge 1 ]; then echo ok; else echo 'reporta bloqueo pero no menciona la ruta neutral (0 menciones)'; fi
    elif [ "$mentions" -eq 0 ]; then echo ok
    else echo "no reporta bloqueo pero menciona la ruta neutral ($mentions menciones)"; fi
}

echo '[fuentes] contrato neutral, guard y doctrina preservada'
for index in "${!agents[@]}"; do
    agent="${agents[$index]}"
    source="$REPO_ROOT/src/published/agents/$agent.md"
    mirror="$REPO_ROOT/agents/$agent.md"
    if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$source" >/dev/null; then pass "$agent valida"; else fail "$agent no valida"; fi
    case "$agent" in
        reviewer)
            expected_profile='deep'
            expected_capabilities='["read", "edit", "shell", "skill"]'
            expected_skills='["projections", "comment-cleanup"]'
            expected_keys='["capabilities", "description", "id", "kind", "mode", "profile", "skills"]'
            ;;
        smoke-test-writer|projection-test-writer|projection-implementer)
            expected_profile='balanced'
            expected_capabilities='["read", "edit", "shell", "skill"]'
            expected_skills='["projections"]'
            expected_keys='["capabilities", "description", "id", "kind", "mode", "profile", "skills"]'
            ;;
        *)
            expected_profile='balanced'
            expected_capabilities='["read", "edit", "shell"]'
            expected_skills='null'
            expected_keys='["capabilities", "description", "id", "kind", "mode", "profile"]'
            ;;
    esac
    if frontmatter "$source" | jq -e --arg id "$agent" --arg description "${descriptions[$index]}" --arg profile "$expected_profile" --argjson capabilities "$expected_capabilities" --argjson skills "$expected_skills" --argjson keys "$expected_keys" '
        .kind == "agent" and .id == $id and .description == $description and
        .mode == "all" and .profile == $profile and .capabilities == $capabilities and
        (if $skills == null then has("skills") | not else .skills == $skills end) and
        (keys | sort) == $keys' >/dev/null; then
        pass "$agent declara el contrato neutral exacto"
    else
        fail "$agent no declara el contrato neutral exacto"
    fi
    if [ "$(body "$source" | awk 'NF { print; exit }')" = '{{mefisto:assert-consumer-repo}}' ]; then pass "$agent inicia con el guard"; else fail "$agent no inicia con el guard"; fi
    if grep -Fqx '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/agents/'"$agent"'.md. No editar a mano. -->' "$mirror"; then pass "$agent generado conserva marcador"; else fail "$agent generado sin marcador"; fi
    if [ "$agent" = reviewer ]; then
        if diff -u <(expected_rendered_body claude "$source") <(body_without_adapter_lines "$mirror") >/dev/null; then pass "$agent conserva exactamente un preambulo y el cuerpo traducido al proyectar Claude"; else fail "$agent altera el preambulo o el cuerpo al proyectar Claude"; fi
    elif [ "$agent" = projection-test-writer ] || [ "$agent" = test-writer ] || [ "$agent" = projection-implementer ] || [ "$agent" = implementer ] || [ "$agent" = smoke-test-writer ] || [ "$agent" = domain-scaffolder ]; then
        if diff -u <(expected_package_root_and_effective_contract_body claude "$source") <(body_without_adapter_lines "$mirror") >/dev/null; then pass "$agent conserva exactamente ambos preambulos y el cuerpo traducido al proyectar Claude"; else fail "$agent altera alguno de los preambulos o el cuerpo al proyectar Claude"; fi
    elif diff -u <(translated_source_body claude "$source") <(body_without_adapter_lines "$mirror") >/dev/null; then pass "$agent conserva el cuerpo traducido al proyectar Claude"; else fail "$agent altera el cuerpo al proyectar Claude"; fi
    if [ "$agent" = domain-scaffolder ]; then
        source_separators="$(body "$source" | grep -cx -- '---')"
        mirror_separators="$(body "$mirror" | grep -cx -- '---')"
        if [ "$source_separators" -ge 4 ] && [ "$source_separators" -eq "$mirror_separators" ]; then pass 'domain-scaffolder conserva las cuatro lineas documentadas y los demas separadores del cuerpo'; else fail 'domain-scaffolder altera los separadores del cuerpo'; fi
        rm_lines="$(grep -E '^[[:space:]]*rm ' "$source" || true)"
        if [ "$(printf '%s\n' "$rm_lines" | grep -c '^rm ')" -eq 8 ] && ! printf '%s\n' "$rm_lines" | grep -Eqv '^rm -r?f (src|tests)/[^ "$]+$'; then
            pass 'domain-scaffolder normaliza las ocho eliminaciones de plantillas a rutas relativas sin comillas'
        else
            fail 'domain-scaffolder no conserva la forma canonica de las ocho eliminaciones de plantillas'
        fi
        if ! printf '%s\n' "$rm_lines" | grep -Eq '\$REPO_ROOT|"|\$temporal'; then
            pass 'domain-scaffolder no usa REPO_ROOT, comillas ni temporales al eliminar plantillas'
        else
            fail 'domain-scaffolder conserva REPO_ROOT, comillas o temporales al eliminar plantillas'
        fi
    fi
done

echo '[estado] rutas neutrales de los agentes TDD'
for index in "${!state_agents[@]}"; do
    agent="${state_agents[$index]}"
    source="$REPO_ROOT/src/published/agents/$agent.md"
    summary="{{mefisto:state-path summaries/${state_summaries[$index]}.md}}"
    if ! grep -Fq '.claude/pipeline/summaries' "$source" && ! grep -Fq '.claude/pipeline/blockage-report' "$source" && ! grep -Fq '`.claude/pipeline/`' "$source"; then pass "$agent no conserva rutas legacy de estado"; else fail "$agent conserva rutas legacy de estado"; fi
    if [ "$(grep -Fc "$summary" "$source")" -eq 1 ]; then pass "$agent declara su summary neutral exacto"; else fail "$agent no declara su summary neutral exacto"; fi
    verdict="$(blockage_verdict "$source" "${state_reports_blockage[$index]}")"
    if [ "$verdict" = ok ]; then pass "$agent declara las rutas neutrales esperadas de bloqueo"; else fail "$agent no declara las rutas neutrales esperadas de bloqueo: $verdict"; fi
done

echo '[estado] regresion: la asercion de bloqueo no depende de un conteo exacto'
regression_copy="$WORK/implementer-regression.md"
cp "$REPO_ROOT/src/published/agents/implementer.md" "$regression_copy"
printf '\n%s\n' "$BLOCKAGE_REF" >> "$regression_copy"
if [ "$(blockage_verdict "$regression_copy" 1)" = ok ]; then pass 'implementer con una mencion extra sigue en verde'; else fail 'implementer con una mencion extra rompe la asercion'; fi
grep -Fv "$BLOCKAGE_REF" "$regression_copy" > "$regression_copy.sin" || true
if [ "$(blockage_verdict "$regression_copy.sin" 1)" != ok ]; then pass 'implementer sin ninguna mencion da FAIL'; else fail 'implementer sin menciones no es detectado'; fi
regression_silent="$WORK/test-writer-regression.md"
cp "$REPO_ROOT/src/published/agents/test-writer.md" "$regression_silent"
printf '\n%s\n' "$BLOCKAGE_REF" >> "$regression_silent"
if [ "$(blockage_verdict "$regression_silent" 0)" != ok ]; then pass 'test-writer con una mencion de bloqueo da FAIL'; else fail 'test-writer con una mencion de bloqueo no es detectado'; fi

echo '[validador] excepciones transitorias acotadas'
for agent in "${agents[@]}"; do
    validator_fixture "$agent" 'model: runtime-inyectado'
    if "$VALIDATOR" "$WORK/$agent.md" >/dev/null 2>&1; then fail "$agent no admite metadata de runtime nueva"; else pass "$agent rechaza metadata de runtime nueva"; fi
    validator_fixture "$agent" 'Variable ajena: $TOKEN_AJENO'
    if "$VALIDATOR" "$WORK/$agent.md" >/dev/null 2>&1; then fail "$agent no admite placeholders arbitrarios"; else pass "$agent rechaza placeholders arbitrarios"; fi
done
validator_fixture reviewer 'Posicional ajeno: $2'
if "$VALIDATOR" "$WORK/reviewer.md" >/dev/null 2>&1; then fail 'reviewer no hereda placeholders exclusivos de test-writer'; else pass 'reviewer rechaza placeholders exclusivos de test-writer'; fi
validator_fixture implementer 'Este agente corre dentro de Claude Code'
if "$VALIDATOR" "$WORK/implementer.md" >/dev/null 2>&1; then fail 'implementer aun admite referencias a Claude/OpenCode tras salir de la excepcion legacy (#1430)'; else pass 'implementer rechaza referencias a Claude/OpenCode tras salir de la excepcion legacy (#1430)'; fi
validator_fixture implementer 'Se instala desde el marketplace del plugin'
if "$VALIDATOR" "$WORK/implementer.md" >/dev/null 2>&1; then fail 'implementer aun admite vocabulario de distribucion de runtime tras salir de la excepcion legacy (#1430)'; else pass 'implementer rechaza vocabulario de distribucion de runtime tras salir de la excepcion legacy (#1430)'; fi
validator_fixture test-writer 'Ruta legacy: $PLUGIN_ROOT'
if "$VALIDATOR" "$WORK/test-writer.md" >/dev/null 2>&1; then fail 'test-writer aun admite el placeholder de raiz legacy'; else pass 'test-writer rechaza el placeholder de raiz legacy'; fi
validator_fixture projection-implementer 'Posicional ajeno: $2'
if "$VALIDATOR" "$WORK/projection-implementer.md" >/dev/null 2>&1; then fail 'projection-implementer no hereda placeholders exclusivos de projection-test-writer'; else pass 'projection-implementer rechaza placeholders exclusivos de projection-test-writer'; fi
validator_fixture smoke-test-writer 'Ruta ajena: $PLUGIN_ROOT'
if "$VALIDATOR" "$WORK/smoke-test-writer.md" >/dev/null 2>&1; then fail 'smoke-test-writer no hereda placeholders de los agentes de proyeccion'; else pass 'smoke-test-writer rechaza placeholders de los agentes de proyeccion'; fi
validator_fixture smoke-test-writer 'Este agente corre dentro de Claude Code'
if "$VALIDATOR" "$WORK/smoke-test-writer.md" >/dev/null 2>&1; then fail 'smoke-test-writer aun admite referencias a Claude/OpenCode tras salir de la excepcion legacy (#1431)'; else pass 'smoke-test-writer rechaza referencias a Claude/OpenCode tras salir de la excepcion legacy (#1431)'; fi
validator_fixture smoke-test-writer 'Se instala desde el marketplace del plugin'
if "$VALIDATOR" "$WORK/smoke-test-writer.md" >/dev/null 2>&1; then fail 'smoke-test-writer aun admite vocabulario de distribucion de runtime tras salir de la excepcion legacy (#1431)'; else pass 'smoke-test-writer rechaza vocabulario de distribucion de runtime tras salir de la excepcion legacy (#1431)'; fi

echo '[salidas] proyecciones Claude y OpenCode'
for agent in "${agents[@]}"; do
    claude="$REPO_ROOT/dist/claude/agents/$agent.md"
    opencode="$REPO_ROOT/dist/opencode/agents/$agent.md"
    if cmp -s "$claude" "$REPO_ROOT/agents/$agent.md"; then pass "$agent mirror Claude coincide byte a byte"; else fail "$agent mirror Claude diverge"; fi
    if [ "$agent" = reviewer ]; then
        if diff -u <(expected_rendered_body opencode "$REPO_ROOT/src/published/agents/$agent.md") <(body_without_adapter_lines "$opencode") >/dev/null; then pass "$agent conserva exactamente un preambulo y el cuerpo traducido al proyectar OpenCode"; else fail "$agent altera el preambulo o el cuerpo al proyectar OpenCode"; fi
    elif [ "$agent" = projection-test-writer ] || [ "$agent" = test-writer ] || [ "$agent" = projection-implementer ] || [ "$agent" = implementer ] || [ "$agent" = smoke-test-writer ] || [ "$agent" = domain-scaffolder ]; then
        if diff -u <(expected_package_root_and_effective_contract_body opencode "$REPO_ROOT/src/published/agents/$agent.md") <(body_without_adapter_lines "$opencode") >/dev/null; then pass "$agent conserva exactamente ambos preambulos y el cuerpo traducido al proyectar OpenCode"; else fail "$agent altera alguno de los preambulos o el cuerpo al proyectar OpenCode"; fi
    elif diff -u <(translated_source_body opencode "$REPO_ROOT/src/published/agents/$agent.md") <(body_without_adapter_lines "$opencode") >/dev/null; then pass "$agent conserva el cuerpo traducido al proyectar OpenCode"; else fail "$agent altera el cuerpo al proyectar OpenCode"; fi
    grep -Fq '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh' "$opencode" && pass "$agent OpenCode conserva marcador" || fail "$agent OpenCode no conserva marcador"
    if ! grep -Fq '{{mefisto:' "$claude" && ! grep -Fq '{{mefisto:' "$opencode"; then pass "$agent no filtra directivas a las salidas"; else fail "$agent filtra directivas a las salidas"; fi
    if [ "$agent" = reviewer ]; then
        grep -Fq 'model: "opus"' "$claude" && pass "$agent Claude materializa deep como opus" || fail "$agent Claude no materializa opus"
        grep -Fq 'tools: "Read, Glob, Grep, Edit, Write, Bash, Skill"' "$claude" && pass "$agent Claude materializa capacidades y Skill" || fail "$agent Claude no materializa Skill"
        grep -Fq 'skills: ["projections","comment-cleanup"]' "$claude" && pass "$agent Claude conserva skills" || fail "$agent Claude no conserva skills"
        grep -Fq '"skill":{"*":"deny","mefisto-projections":"allow","mefisto-comment-cleanup":"allow"}' "$opencode" && grep -Fq 'Antes de ejecutar este body, usa la tool nativa `skill` para cargar, en este orden: `mefisto-projections`, `mefisto-comment-cleanup`.' "$opencode" && pass "$agent OpenCode materializa skills" || fail "$agent OpenCode no materializa skills"
    elif [ "$agent" = smoke-test-writer ] || [ "$agent" = projection-test-writer ] || [ "$agent" = projection-implementer ]; then
        grep -Fq 'model: "sonnet"' "$claude" && pass "$agent Claude materializa balanced como sonnet" || fail "$agent Claude no materializa sonnet"
        grep -Fq 'tools: "Read, Glob, Grep, Edit, Write, Bash, Skill"' "$claude" && pass "$agent Claude materializa capacidades y Skill" || fail "$agent Claude no materializa Skill"
        grep -Fq 'skills: ["projections"]' "$claude" && pass "$agent Claude conserva skills" || fail "$agent Claude no conserva skills"
        grep -Fq '"skill":{"*":"deny","mefisto-projections":"allow"}' "$opencode" && grep -Fq 'Antes de ejecutar este body, usa la tool nativa `skill` para cargar, en este orden: `mefisto-projections`.' "$opencode" && pass "$agent OpenCode materializa skills" || fail "$agent OpenCode no materializa skills"
    else
        grep -Fq 'model: "sonnet"' "$claude" && pass "$agent Claude materializa balanced como sonnet" || fail "$agent Claude no materializa sonnet"
        grep -Fq 'tools: "Read, Glob, Grep, Edit, Write, Bash"' "$claude" && pass "$agent Claude materializa capacidades" || fail "$agent Claude no materializa capacidades"
    fi
    grep -Fq 'permission: ' "$opencode" && grep -Fq '"read":{"*":"allow"' "$opencode" && grep -Fq '"edit":{"*":"allow"' "$opencode" && grep -Fq '"bash":{"*":"deny"' "$opencode" && pass "$agent OpenCode materializa permisos" || fail "$agent OpenCode no materializa permisos"
    grep -Fq 'mode: "all"' "$opencode" && pass "$agent OpenCode conserva mode all" || fail "$agent OpenCode no conserva mode all"
done

echo '[conocimiento] test-writer usa la release activa'
for artifact in "$REPO_ROOT/src/published/agents/test-writer.md" "$REPO_ROOT/agents/test-writer.md" "$REPO_ROOT/dist/claude/agents/test-writer.md" "$REPO_ROOT/dist/opencode/agents/test-writer.md"; do
    rendered="$(< "$artifact")"
    if [[ "$artifact" = "$REPO_ROOT/src/"* ]]; then root='{{mefisto:package-root}}'; else root='${MEFISTO_PACKAGE_ROOT}'; fi
    if [[ "$rendered" = *"$root/docs/adr/mef-adr-0002-estrategia-testing-event-sourcing.md"* && "$rendered" = *"$root/docs/adr/mef-adr-0016-convencion-naming-tests.md"* && "$rendered" = *"$root/docs/testing/harness-cheatsheet.md"* ]]; then pass "$(basename "$(dirname "$artifact")") test-writer resuelve ADRs y cheatsheet desde package root"; else fail "$(basename "$(dirname "$artifact")") test-writer no resuelve todo el conocimiento desde package root"; fi
    if [[ "$artifact" != "$REPO_ROOT/src/"* ]] && { { [[ "$artifact" = *'/opencode/'* ]] && [ "$(grep -c 'mefisto_opencode_launcher" package-root' "$artifact")" -eq 1 ]; } || { [[ "$artifact" != *'/opencode/'* ]] && [ "$(grep -c 'MEFISTO_PACKAGE_ROOT="\$mefisto_claude_root"' "$artifact")" -eq 1 ]; }; } && grep -Fq 'cat "${MEFISTO_PACKAGE_ROOT}/docs/testing/harness-cheatsheet.md"' "$artifact"; then pass "$(basename "$(dirname "$artifact")") cita el conocimiento con raiz que preserva espacios"; elif [[ "$artifact" = "$REPO_ROOT/src/"* ]]; then :; else fail "$(basename "$(dirname "$artifact")") no cita el conocimiento con raiz segura"; fi
    if [[ "$artifact" = "$REPO_ROOT/src/"* ]]; then legacy_pattern='\.claude/pipeline/\.plugin-root|PLUGIN_ROOT=|plugins/cache|\$HOME/.claude'; else legacy_pattern='PLUGIN_ROOT=|plugins/cache|\$HOME/.claude'; fi
    if ! grep -Eq "$legacy_pattern" "$artifact"; then pass "$(basename "$(dirname "$artifact")") no conserva resolver de runtime legado"; else fail "$(basename "$(dirname "$artifact")") conserva resolver de runtime legado"; fi
done

for runtime in claude opencode; do
    package_root="$REPO_ROOT/dist/$runtime"
    if MEFISTO_PACKAGE_ROOT="$package_root" bash -c '
        test -f "${MEFISTO_PACKAGE_ROOT}/docs/adr/mef-adr-0002-estrategia-testing-event-sourcing.md" &&
        test -f "${MEFISTO_PACKAGE_ROOT}/docs/adr/mef-adr-0016-convencion-naming-tests.md" &&
        test -f "${MEFISTO_PACKAGE_ROOT}/docs/testing/harness-cheatsheet.md"
    '; then pass "$runtime contiene el conocimiento que test-writer abre desde package root"; else fail "$runtime no empaqueta todo el conocimiento requerido por test-writer"; fi
done

echo '[conocimiento] reviewer usa la release activa y el Skill adaptado'
for artifact in "$REPO_ROOT/src/published/agents/reviewer.md" "$REPO_ROOT/agents/reviewer.md" "$REPO_ROOT/dist/claude/agents/reviewer.md" "$REPO_ROOT/dist/opencode/agents/reviewer.md"; do
    rendered="$(< "$artifact")"
    rendered_without_quotes="${rendered//\"/}"
    if [[ "$artifact" = "$REPO_ROOT/src/"* ]]; then package_root='{{mefisto:package-root}}'; skill_root='{{mefisto:skill-root projections}}'; else package_root='${MEFISTO_PACKAGE_ROOT}'; skill_root='${MEFISTO_PACKAGE_ROOT}/skills/projections'; [[ "$artifact" = *'/opencode/'* ]] && skill_root='${MEFISTO_PACKAGE_ROOT}/skills/mefisto-projections'; fi
    if [[ "$rendered_without_quotes" = *"$package_root/docs/adr/mef-adr-0016-convencion-naming-tests.md"* && "$rendered_without_quotes" = *"$skill_root/modelos-marten.md"* && "$rendered_without_quotes" = *"$skill_root/read-apis.md"* && "$rendered_without_quotes" = *"$skill_root/naming.md"* && "$rendered_without_quotes" = *"$skill_root/config-test.md"* ]]; then pass "$(basename "$(dirname "$artifact")") reviewer resuelve ADRs y Skill desde la release activa"; else fail "$(basename "$(dirname "$artifact")") reviewer no resuelve todo el conocimiento desde la release activa"; fi
    if [[ "$artifact" != "$REPO_ROOT/src/"* ]] && { { [[ "$artifact" = *'/opencode/'* ]] && [ "$(grep -c 'mefisto_opencode_launcher" package-root' "$artifact")" -eq 1 ]; } || { [[ "$artifact" != *'/opencode/'* ]] && [ "$(grep -c 'MEFISTO_PACKAGE_ROOT="\$mefisto_claude_root"' "$artifact")" -eq 1 ]; }; }; then pass "$(basename "$(dirname "$artifact")") reviewer conserva un solo preambulo que preserva espacios"; elif [[ "$artifact" = "$REPO_ROOT/src/"* ]]; then :; else fail "$(basename "$(dirname "$artifact")") reviewer no conserva el preambulo de package root"; fi
    if [[ "$artifact" = "$REPO_ROOT/src/"* ]]; then legacy_pattern='\.claude/pipeline/\.plugin-root|PLUGIN_ROOT=|plugins/cache|\$HOME/.claude|OpenCode|Claude'; else legacy_pattern='PLUGIN_ROOT=|plugins/cache|\$HOME/.claude'; fi
    if ! grep -Eq "$legacy_pattern" "$artifact"; then pass "$(basename "$(dirname "$artifact")") reviewer no conserva resolucion de runtime legado"; else fail "$(basename "$(dirname "$artifact")") reviewer conserva resolucion de runtime legado"; fi
done

echo '[conocimiento] projection-implementer usa la release activa y el Skill adaptado'
for artifact in "$REPO_ROOT/src/published/agents/projection-implementer.md" "$REPO_ROOT/agents/projection-implementer.md" "$REPO_ROOT/dist/claude/agents/projection-implementer.md" "$REPO_ROOT/dist/opencode/agents/projection-implementer.md"; do
    rendered="$(< "$artifact")"
    rendered_without_quotes="${rendered//\"/}"
    if [[ "$artifact" = "$REPO_ROOT/src/"* ]]; then package_root='{{mefisto:package-root}}'; skill_root='{{mefisto:skill-root projections}}'; else package_root='${MEFISTO_PACKAGE_ROOT}'; skill_root='${MEFISTO_PACKAGE_ROOT}/skills/projections'; [[ "$artifact" = *'/opencode/'* ]] && skill_root='${MEFISTO_PACKAGE_ROOT}/skills/mefisto-projections'; fi
    if [[ "$rendered_without_quotes" = *"$package_root/docs/adr/mef-adr-0035-doctrina-proyeccion-query-read-side.md"* && "$rendered_without_quotes" = *"$package_root/docs/adr/mef-adr-0034-worker-proyecciones-read-models.md"* && "$rendered_without_quotes" = *"$package_root/docs/adr/mef-adr-0006-convenciones-nombramiento-funciones-azure.md"* && "$rendered_without_quotes" = *"$package_root/docs/adr/mef-adr-0041-forma-propia-vista-read-side.md"* && "$rendered_without_quotes" = *"$package_root/docs/adr/mef-adr-0028-estrategia-tenancy.md"* && "$rendered_without_quotes" = *"$package_root/docs/adr/mef-adr-0029-test-composicion-host.md"* && "$rendered_without_quotes" = *"$skill_root/modelos-marten.md"* && "$rendered_without_quotes" = *"$skill_root/naming.md"* && "$rendered_without_quotes" = *"$skill_root/read-apis.md"* && "$rendered_without_quotes" = *"$skill_root/config-test.md"* ]]; then pass "$(basename "$(dirname "$artifact")") projection-implementer resuelve ADRs y Skill desde la release activa"; else fail "$(basename "$(dirname "$artifact")") projection-implementer no resuelve todo el conocimiento desde la release activa"; fi
    if [[ "$artifact" != "$REPO_ROOT/src/"* ]] && { { [[ "$artifact" = *'/opencode/'* ]] && [ "$(grep -c 'mefisto_opencode_launcher" package-root' "$artifact")" -eq 1 ]; } || { [[ "$artifact" != *'/opencode/'* ]] && [ "$(grep -c 'MEFISTO_PACKAGE_ROOT="\$mefisto_claude_root"' "$artifact")" -eq 1 ]; }; }; then pass "$(basename "$(dirname "$artifact")") projection-implementer conserva un solo preambulo que preserva espacios"; elif [[ "$artifact" = "$REPO_ROOT/src/"* ]]; then :; else fail "$(basename "$(dirname "$artifact")") projection-implementer no conserva el preambulo de package root"; fi
    if [[ "$artifact" = "$REPO_ROOT/src/"* ]]; then legacy_pattern='\.claude/pipeline/\.plugin-root|PLUGIN_ROOT=|plugins/cache|\$HOME/.claude|OpenCode|Claude'; else legacy_pattern='PLUGIN_ROOT=|plugins/cache|\$HOME/.claude'; fi
    if ! grep -Eq "$legacy_pattern" "$artifact"; then pass "$(basename "$(dirname "$artifact")") projection-implementer no conserva resolucion de runtime legado"; else fail "$(basename "$(dirname "$artifact")") projection-implementer conserva resolucion de runtime legado"; fi
done

echo '[conocimiento] projection-test-writer usa la release activa y el Skill adaptado'
for artifact in "$REPO_ROOT/src/published/agents/projection-test-writer.md" "$REPO_ROOT/agents/projection-test-writer.md" "$REPO_ROOT/dist/claude/agents/projection-test-writer.md" "$REPO_ROOT/dist/opencode/agents/projection-test-writer.md"; do
    rendered="$(< "$artifact")"
    rendered_without_quotes="${rendered//\"/}"
    if [[ "$artifact" = "$REPO_ROOT/src/"* ]]; then package_root='{{mefisto:package-root}}'; skill_root='{{mefisto:skill-root projections}}'; else package_root='${MEFISTO_PACKAGE_ROOT}'; skill_root='${MEFISTO_PACKAGE_ROOT}/skills/projections'; [[ "$artifact" = *'/opencode/'* ]] && skill_root='${MEFISTO_PACKAGE_ROOT}/skills/mefisto-projections'; fi
    if [[ "$rendered_without_quotes" = *"$package_root/docs/adr/mef-adr-0035-doctrina-proyeccion-query-read-side.md"* && "$rendered_without_quotes" = *"$package_root/docs/adr/mef-adr-0034-worker-proyecciones-read-models.md"* && "$rendered_without_quotes" = *"$package_root/docs/adr/mef-adr-0006-convenciones-nombramiento-funciones-azure.md"* && "$rendered_without_quotes" = *"$package_root/docs/adr/mef-adr-0041-forma-propia-vista-read-side.md"* && "$rendered_without_quotes" = *"$package_root/docs/adr/mef-adr-0016-convencion-naming-tests.md"* && "$rendered_without_quotes" = *"$package_root/docs/adr/mef-adr-0002-estrategia-testing-event-sourcing.md"* && "$rendered_without_quotes" = *"$skill_root/modelos-marten.md"* && "$rendered_without_quotes" = *"$skill_root/naming.md"* && "$rendered_without_quotes" = *"$skill_root/read-apis.md"* && "$rendered_without_quotes" = *"$skill_root/config-test.md"* ]]; then pass "$(basename "$(dirname "$artifact")") projection-test-writer resuelve ADRs y Skill desde la release activa"; else fail "$(basename "$(dirname "$artifact")") projection-test-writer no resuelve todo el conocimiento desde la release activa"; fi
    if [[ "$artifact" != "$REPO_ROOT/src/"* ]] && [[ "$rendered" = *'"${MEFISTO_PACKAGE_ROOT}/docs/adr/mef-adr-0035-doctrina-proyeccion-query-read-side.md"'* && "$rendered" = *'"${MEFISTO_PACKAGE_ROOT}/docs/adr/mef-adr-0002-estrategia-testing-event-sourcing.md"'* && "$rendered" = *'"${MEFISTO_PACKAGE_ROOT}/skills/'*'"/modelos-marten.md'* && "$rendered" = *'"${MEFISTO_PACKAGE_ROOT}/skills/'*'"/config-test.md'* ]]; then pass "$(basename "$(dirname "$artifact")") projection-test-writer conserva rutas citables con espacios"; elif [[ "$artifact" = "$REPO_ROOT/src/"* ]]; then :; else fail "$(basename "$(dirname "$artifact")") projection-test-writer deja rutas sensibles a espacios sin citar"; fi
    if [[ "$artifact" != "$REPO_ROOT/src/"* ]] && { { [[ "$artifact" = *'/opencode/'* ]] && [ "$(grep -c 'mefisto_opencode_launcher" package-root' "$artifact")" -eq 1 ]; } || { [[ "$artifact" != *'/opencode/'* ]] && [ "$(grep -c 'MEFISTO_PACKAGE_ROOT="\$mefisto_claude_root"' "$artifact")" -eq 1 ]; }; }; then pass "$(basename "$(dirname "$artifact")") projection-test-writer conserva un solo preambulo que preserva espacios"; elif [[ "$artifact" = "$REPO_ROOT/src/"* ]]; then :; else fail "$(basename "$(dirname "$artifact")") projection-test-writer no conserva el preambulo de package root"; fi
    if [[ "$artifact" = "$REPO_ROOT/src/"* ]]; then legacy_pattern='\.claude/pipeline/\.plugin-root|PLUGIN_ROOT=|plugins/cache|\$HOME/.claude|OpenCode|Claude'; else legacy_pattern='PLUGIN_ROOT=|plugins/cache|\$HOME/.claude'; fi
    if ! grep -Eq "$legacy_pattern" "$artifact"; then pass "$(basename "$(dirname "$artifact")") projection-test-writer no conserva resolucion de runtime legado"; else fail "$(basename "$(dirname "$artifact")") projection-test-writer conserva resolucion de runtime legado"; fi
done

for runtime in claude opencode; do
    package_root="$REPO_ROOT/dist/$runtime"
    skill_dir='skills/projections'
    if [ "$runtime" = claude ]; then package_root="$REPO_ROOT"; else skill_dir='skills/mefisto-projections'; fi
    if MEFISTO_PACKAGE_ROOT="$package_root" SKILL_DIR="$skill_dir" bash -c '
        test -f "${MEFISTO_PACKAGE_ROOT}/docs/adr/mef-adr-0035-doctrina-proyeccion-query-read-side.md" &&
        test -f "${MEFISTO_PACKAGE_ROOT}/docs/adr/mef-adr-0034-worker-proyecciones-read-models.md" &&
        test -f "${MEFISTO_PACKAGE_ROOT}/docs/adr/mef-adr-0006-convenciones-nombramiento-funciones-azure.md" &&
        test -f "${MEFISTO_PACKAGE_ROOT}/docs/adr/mef-adr-0041-forma-propia-vista-read-side.md" &&
        test -f "${MEFISTO_PACKAGE_ROOT}/docs/adr/mef-adr-0028-estrategia-tenancy.md" &&
        test -f "${MEFISTO_PACKAGE_ROOT}/docs/adr/mef-adr-0029-test-composicion-host.md" &&
        for resource in modelos-marten.md naming.md read-apis.md config-test.md; do test -f "${MEFISTO_PACKAGE_ROOT}/${SKILL_DIR}/$resource" || exit 1; done
    '; then pass "el paquete $runtime contiene el conocimiento que projection-implementer abre desde sus raices adaptadas"; else fail "el paquete $runtime no contiene todo el conocimiento requerido por projection-implementer"; fi
done

for runtime in claude opencode; do
    package_root="$REPO_ROOT"
    skill_dir='skills/projections'
    if [ "$runtime" = opencode ]; then package_root="$REPO_ROOT/dist/opencode"; skill_dir='skills/mefisto-projections'; fi
    if MEFISTO_PACKAGE_ROOT="$package_root" SKILL_DIR="$skill_dir" bash -c '
        test -f "${MEFISTO_PACKAGE_ROOT}/docs/adr/mef-adr-0016-convencion-naming-tests.md" &&
        test -f "${MEFISTO_PACKAGE_ROOT}/${SKILL_DIR}/modelos-marten.md" &&
        test -f "${MEFISTO_PACKAGE_ROOT}/${SKILL_DIR}/read-apis.md" &&
        test -f "${MEFISTO_PACKAGE_ROOT}/${SKILL_DIR}/naming.md" &&
        test -f "${MEFISTO_PACKAGE_ROOT}/${SKILL_DIR}/config-test.md"
    '; then pass "el paquete $runtime contiene el conocimiento que reviewer abre desde sus raices adaptadas"; else fail "el paquete $runtime no contiene todo el conocimiento requerido por reviewer"; fi
done

# MEF-ADR-0031: prueba la resolucion ejecutable desde los agentes generados, no
# solo la presencia textual de las directivas en la fuente. Las dos fixtures
# usan una raiz con espacios y contienen bytes de las distribuciones reales.
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

opencode_package="$WORK/paquete OpenCode con espacios"
opencode_data="$WORK/datos OpenCode con espacios"
mkdir -p "$opencode_package/docs/adr" "$opencode_package/skills/mefisto-projections" "$opencode_data/mefisto/active/bin"
for adr in mef-adr-0002-estrategia-testing-event-sourcing.md mef-adr-0016-convencion-naming-tests.md mef-adr-0035-doctrina-proyeccion-query-read-side.md mef-adr-0034-worker-proyecciones-read-models.md mef-adr-0006-convenciones-nombramiento-funciones-azure.md mef-adr-0041-forma-propia-vista-read-side.md mef-adr-0028-estrategia-tenancy.md mef-adr-0029-test-composicion-host.md; do cp "$REPO_ROOT/dist/opencode/docs/adr/$adr" "$opencode_package/docs/adr/"; done
for resource in modelos-marten.md read-apis.md naming.md config-test.md; do cp "$REPO_ROOT/dist/opencode/skills/mefisto-projections/$resource" "$opencode_package/skills/mefisto-projections/$resource"; done
printf '%s\n' '#!/bin/sh' '[ "$1" = package-root ] || exit 2' 'printf "%s\n" "$MEFISTO_TEST_PACKAGE_ROOT"' > "$opencode_data/mefisto/active/bin/mefisto-opencode"
chmod +x "$opencode_data/mefisto/active/bin/mefisto-opencode"
opencode_physical="$(cd "$opencode_package" && pwd -P)"
opencode_preamble="$(first_bash_block "$REPO_ROOT/dist/opencode/agents/reviewer.md")"
opencode_resolved="$(XDG_DATA_HOME="$opencode_data" MEFISTO_TEST_PACKAGE_ROOT="$opencode_package/" bash -c "$opencode_preamble"$'\n''test -f "$MEFISTO_PACKAGE_ROOT/docs/adr/mef-adr-0016-convencion-naming-tests.md" && for resource in modelos-marten.md read-apis.md naming.md config-test.md; do test -f "$MEFISTO_PACKAGE_ROOT/skills/mefisto-projections/$resource" || exit 1; done && printf "%s\n" "$MEFISTO_PACKAGE_ROOT"' 2>/dev/null)"; rc=$?
[ "$rc" -eq 0 ] && [ "$opencode_resolved" = "$opencode_physical" ] && pass 'reviewer OpenCode generado abre ADRs y Skill desde un package root con espacios' || fail 'reviewer OpenCode generado no resuelve su conocimiento desde el package root efectivo'

claude_preamble="$(first_bash_block "$REPO_ROOT/dist/claude/agents/projection-implementer.md")"
claude_resolved="$(bash -c "$(claude_substitute "$claude_preamble" "$claude_package/")"$'\n''for adr in mef-adr-0035-doctrina-proyeccion-query-read-side.md mef-adr-0034-worker-proyecciones-read-models.md mef-adr-0006-convenciones-nombramiento-funciones-azure.md mef-adr-0041-forma-propia-vista-read-side.md mef-adr-0028-estrategia-tenancy.md mef-adr-0029-test-composicion-host.md; do test -f "$MEFISTO_PACKAGE_ROOT/docs/adr/$adr" || exit 1; done && for resource in modelos-marten.md naming.md read-apis.md config-test.md; do test -f "$MEFISTO_PACKAGE_ROOT/skills/projections/$resource" || exit 1; done && printf "%s\n" "$MEFISTO_PACKAGE_ROOT"' 2>/dev/null)"; rc=$?
[ "$rc" -eq 0 ] && [ "$claude_resolved" = "$claude_physical" ] && pass 'projection-implementer Claude generado abre ADRs y Skill desde un package root con espacios' || fail 'projection-implementer Claude generado no resuelve su conocimiento desde el package root efectivo'

opencode_preamble="$(first_bash_block "$REPO_ROOT/dist/opencode/agents/projection-implementer.md")"
opencode_resolved="$(XDG_DATA_HOME="$opencode_data" MEFISTO_TEST_PACKAGE_ROOT="$opencode_package/" bash -c "$opencode_preamble"$'\n''for adr in mef-adr-0035-doctrina-proyeccion-query-read-side.md mef-adr-0034-worker-proyecciones-read-models.md mef-adr-0006-convenciones-nombramiento-funciones-azure.md mef-adr-0041-forma-propia-vista-read-side.md mef-adr-0028-estrategia-tenancy.md mef-adr-0029-test-composicion-host.md; do test -f "$MEFISTO_PACKAGE_ROOT/docs/adr/$adr" || exit 1; done && for resource in modelos-marten.md naming.md read-apis.md config-test.md; do test -f "$MEFISTO_PACKAGE_ROOT/skills/mefisto-projections/$resource" || exit 1; done && printf "%s\n" "$MEFISTO_PACKAGE_ROOT"' 2>/dev/null)"; rc=$?
[ "$rc" -eq 0 ] && [ "$opencode_resolved" = "$opencode_physical" ] && pass 'projection-implementer OpenCode generado abre ADRs y Skill desde un package root con espacios' || fail 'projection-implementer OpenCode generado no resuelve su conocimiento desde el package root efectivo'

claude_preamble="$(first_bash_block "$REPO_ROOT/dist/claude/agents/projection-test-writer.md")"
claude_resolved="$(bash -c "$(claude_substitute "$claude_preamble" "$claude_package/")"$'\n''for adr in mef-adr-0035-doctrina-proyeccion-query-read-side.md mef-adr-0034-worker-proyecciones-read-models.md mef-adr-0006-convenciones-nombramiento-funciones-azure.md mef-adr-0041-forma-propia-vista-read-side.md mef-adr-0016-convencion-naming-tests.md mef-adr-0002-estrategia-testing-event-sourcing.md; do test -f "$MEFISTO_PACKAGE_ROOT/docs/adr/$adr" || exit 1; done && for resource in modelos-marten.md naming.md read-apis.md config-test.md; do test -f "$MEFISTO_PACKAGE_ROOT/skills/projections/$resource" || exit 1; done && printf "%s\n" "$MEFISTO_PACKAGE_ROOT"' 2>/dev/null)"; rc=$?
[ "$rc" -eq 0 ] && [ "$claude_resolved" = "$claude_physical" ] && pass 'projection-test-writer Claude generado abre ADRs y Skill desde un package root con espacios' || fail 'projection-test-writer Claude generado no resuelve su conocimiento desde el package root efectivo'

opencode_preamble="$(first_bash_block "$REPO_ROOT/dist/opencode/agents/projection-test-writer.md")"
opencode_resolved="$(XDG_DATA_HOME="$opencode_data" MEFISTO_TEST_PACKAGE_ROOT="$opencode_package/" bash -c "$opencode_preamble"$'\n''for adr in mef-adr-0035-doctrina-proyeccion-query-read-side.md mef-adr-0034-worker-proyecciones-read-models.md mef-adr-0006-convenciones-nombramiento-funciones-azure.md mef-adr-0041-forma-propia-vista-read-side.md mef-adr-0016-convencion-naming-tests.md mef-adr-0002-estrategia-testing-event-sourcing.md; do test -f "$MEFISTO_PACKAGE_ROOT/docs/adr/$adr" || exit 1; done && for resource in modelos-marten.md naming.md read-apis.md config-test.md; do test -f "$MEFISTO_PACKAGE_ROOT/skills/mefisto-projections/$resource" || exit 1; done && printf "%s\n" "$MEFISTO_PACKAGE_ROOT"' 2>/dev/null)"; rc=$?
[ "$rc" -eq 0 ] && [ "$opencode_resolved" = "$opencode_physical" ] && pass 'projection-test-writer OpenCode generado abre ADRs y Skill desde un package root con espacios' || fail 'projection-test-writer OpenCode generado no resuelve su conocimiento desde el package root efectivo'

if grep -Fq '.mefisto/pipeline/summaries/stage-2b-smoke-test-writer.md' "$REPO_ROOT/agents/smoke-test-writer.md" && grep -Fq '.mefisto/pipeline/summaries/stage-2b-smoke-test-writer.md' "$REPO_ROOT/dist/claude/agents/smoke-test-writer.md" && grep -Fq '.mefisto/pipeline/summaries/stage-2b-smoke-test-writer.md' "$REPO_ROOT/dist/opencode/agents/smoke-test-writer.md"; then
    pass 'los generados conservan el summary canonico de smoke stage 2b'
else
    fail 'los generados no conservan el summary canonico de smoke stage 2b'
fi

echo '[inventarios] clausura publicada actualizada'
for runtime in claude opencode; do
    inventory="$REPO_ROOT/dist/$runtime/.mefisto-generated-assets.json"
    expected_sha="$(shasum -a 256 "$REPO_ROOT/scripts/_pipeline-common.sh" | cut -d ' ' -f 1)"
    if jq -e --arg sha "$expected_sha" '.schemaVersion == 1 and (.assets | length > 0) and all(.assets[]; (.sha256 | test("^[0-9a-f]{64}$"))) and any(.assets[]; .source == "scripts/_pipeline-common.sh" and .destination == "scripts/_pipeline-common.sh" and .sha256 == $sha)' "$inventory" >/dev/null; then
        pass "$runtime conserva un inventario completo con sha256"
    else
        fail "$runtime tiene un inventario incompleto o sin sha256"
    fi
done

if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi
printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
