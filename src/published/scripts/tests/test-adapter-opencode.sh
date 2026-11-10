#!/usr/bin/env bash
# Prueba aislada del adaptador publicado: Bash 3.2 + jq, sin red ni OpenCode.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
ADAPTER="$REPO_ROOT/src/published/scripts/adapters/adapter-opencode.sh"
MAPPING="$REPO_ROOT/src/published/contract/opencode-permissions.json"
FIXTURES="$HERE/fixtures/opencode"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
assert_contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
assert_not_contains() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }
render() { "$ADAPTER" render "$1" '<!-- GENERADO por prueba desde fixture. No editar a mano. -->'; }
extract_preamble() { awk '/^```bash$/{inside=1; next} /^```$/{if (inside) exit} inside' "$1"; }
make_agent() {
    local name="$1" capabilities="$2" extras="${3:-}"
    printf '%s\n' '---' "{\"kind\":\"agent\",\"effort\":\"light\",\"id\":\"$name\",\"description\":\"Prueba.\",\"mode\":\"subagent\",\"capabilities\":$capabilities$extras}" '---' '{{mefisto:assert-consumer-repo}}' > "$WORK/$name.md"
}
permission_of() {
    render "$1" | while IFS= read -r line; do
        case "$line" in 'permission: '*) printf '%s\n' "${line#permission: }"; return 0 ;; esac
    done
}

printf '%s\n' '[pre] adaptador, rutas y vocabulario'
bash -n "$ADAPTER" && bash -n "$REPO_ROOT/src/published/scripts/lib/effective-contract.sh" && pass 'sintaxis Bash valida' || fail 'sintaxis Bash invalida'
[ -x "$ADAPTER" ] && pass 'adaptador ejecutable' || fail 'adaptador no ejecutable'
[ "$("$ADAPTER" root)" = dist/opencode ] && pass 'raiz dist/opencode' || fail 'raiz incorrecta'
agent_path="$("$ADAPTER" path src/published/agents/agent-minimo.md)"
command_path="$("$ADAPTER" path src/published/commands/command-delegado.md)"
[ "$agent_path" = agents/agent-minimo.md ] && pass 'path de agente' || fail 'path de agente incorrecto'
[ "$command_path" = commands/mefisto:command-delegado.md ] && pass 'namespace literal del comando' || fail 'namespace incorrecto'
assert_not_contains "$command_path" 'mefisto-command' 'no usa id interno mefisto-<id>'
[ "$command_path" != commands/command-delegado.md ] && pass 'no publica comando sin namespace' || fail 'publico comando sin namespace'
assets="$($ADAPTER assets)"; rc=$?
[ "$rc" -eq 0 ] && pass 'enumera assets de Skills publicados' || fail 'no enumero assets de Skills publicados'
skill_file_count="$(find "$REPO_ROOT/skills" -type f | wc -l | tr -d '[:space:]')"
jq -e --argjson count "$skill_file_count" 'length == ($count + 2) and ([.[] | select(.source == "skills/projections/SKILL.md" and .destination == "skills/mefisto-projections/SKILL.md")] | length) == 1 and ([.[] | select(.id == "interactive-observability" and .source == "src/published/hooks/interactive-hooks.json" and .destination == "plugins/mefisto-observability.js" and .mode == "0644")] | length) == 1 and ([.[] | select(.id == "mcp-config" and .source == "src/published/contract/mcp-servers.json" and .destination == "plugins/mefisto-mcp.js" and .mode == "0644")] | length) == 1 and ([.[] | select(.destination == "mefisto-manifest.json")] | length) == 0' <<< "$assets" >/dev/null && pass 'assets preservan Skills, observabilidad y MCP sin usurpar el manifiesto del packager' || fail 'inventario de assets incompleto'
"$ADAPTER" render-asset interactive-observability "$REPO_ROOT/src/published/hooks/interactive-hooks.json" > "$WORK/mefisto-observability.js"; rc=$?
[ "$rc" -eq 0 ] && grep -q 'session.model-observed' "$WORK/mefisto-observability.js" && grep -q 'session.idle' "$WORK/mefisto-observability.js" && pass 'renderiza el plugin de observabilidad desde el contrato' || fail 'plugin de observabilidad no renderizado'
"$ADAPTER" render-asset skills/projections/SKILL.md "$REPO_ROOT/skills/projections/SKILL.md" > "$WORK/projections-skill.md"; rc=$?
[ "$rc" -eq 0 ] && grep -q '^name: mefisto-projections$' "$WORK/projections-skill.md" && ! grep -q '^name: projections$' "$WORK/projections-skill.md" && pass 'SKILL.md adapta solo el name OpenCode' || fail 'SKILL.md no adapta el name OpenCode'
cmp -s "$REPO_ROOT/skills/projections/read-apis.md" <("$ADAPTER" render-asset skills/projections/read-apis.md "$REPO_ROOT/skills/projections/read-apis.md") && pass 'recursos Nivel 3 se conservan byte a byte' || fail 'recurso Nivel 3 fue transformado'

printf '%s\n' '[skills] enumeracion abierta y validacion fail-closed'
SKILL_REPO="$WORK/skill-repo"; FIXTURE_ADAPTER="$SKILL_REPO/src/published/scripts/adapters/adapter-opencode.sh"
mkdir -p "$SKILL_REPO/src/published/scripts/adapters" "$SKILL_REPO/src/published/hooks" "$SKILL_REPO/src/published/contract" "$SKILL_REPO/skills/futuro"
cp "$ADAPTER" "$FIXTURE_ADAPTER"; chmod +x "$FIXTURE_ADAPTER"
cp "$REPO_ROOT/src/published/scripts/validate-interactive-hooks.sh" "$SKILL_REPO/src/published/scripts/"
cp "$REPO_ROOT/src/published/scripts/validate-published-mcp.sh" "$SKILL_REPO/src/published/scripts/"
mkdir -p "$SKILL_REPO/src/published/scripts/lib"
cp "$REPO_ROOT/src/published/scripts/lib/jsonschema-lite.jq" "$REPO_ROOT/src/published/scripts/lib/effective-contract.sh" "$SKILL_REPO/src/published/scripts/lib/"
cp "$REPO_ROOT/src/published/contract/mcp-servers.json" "$REPO_ROOT/src/published/contract/mcp-servers.schema.json" "$REPO_ROOT/src/published/contract/published-artifact.schema.json" "$SKILL_REPO/src/published/contract/"
cp "$MAPPING" "$SKILL_REPO/src/published/contract/"
cp "$REPO_ROOT/.mcp.json" "$SKILL_REPO/.mcp.json"
cp "$REPO_ROOT/src/published/hooks/interactive-hooks.json" "$REPO_ROOT/src/published/hooks/interactive-hooks.schema.json" "$SKILL_REPO/src/published/hooks/"
chmod +x "$SKILL_REPO/src/published/scripts/validate-interactive-hooks.sh" "$SKILL_REPO/src/published/scripts/validate-published-mcp.sh"
write_future_skill() {
    printf '%s\n' '---' 'name: futuro' 'description: Skill futuro.' '---' '' '# Futuro' '[detalle](detalle.md)' > "$SKILL_REPO/skills/futuro/SKILL.md"
    printf 'detalle futuro\n' > "$SKILL_REPO/skills/futuro/detalle.md"
}
assert_skill_failure() {
    local label="$1" output rc
    output="$("$FIXTURE_ADAPTER" assets 2>&1)"; rc=$?
    [ "$rc" -ne 0 ] && [ -n "$output" ] && pass "$label" || fail "$label"
}
write_future_skill
future_assets="$("$FIXTURE_ADAPTER" assets)"; rc=$?
[ "$rc" -eq 0 ] && jq -e 'length == 4 and ([.[] | select(.source == "skills/futuro/SKILL.md" and .destination == "skills/mefisto-futuro/SKILL.md")] | length) == 1 and ([.[] | select(.destination == "skills/mefisto-futuro/detalle.md")] | length) == 1 and ([.[] | select(.id == "interactive-observability")] | length) == 1 and ([.[] | select(.id == "mcp-config")] | length) == 1' <<< "$future_assets" >/dev/null && pass 'un Skill futuro converge sin inventario hardcodeado' || fail 'un Skill futuro no fue enumerado'
"$FIXTURE_ADAPTER" render-asset skills/futuro/SKILL.md "$SKILL_REPO/skills/futuro/SKILL.md" > "$WORK/futuro-rendered.md"
awk 'NR == 2 { print "name: mefisto-futuro"; next } { print }' "$SKILL_REPO/skills/futuro/SKILL.md" > "$WORK/futuro-expected.md"
cmp -s "$WORK/futuro-expected.md" "$WORK/futuro-rendered.md" && pass 'render futuro cambia exclusivamente name' || fail 'render futuro altero campos o body'
printf '%s\n' '---' 'name: otro' 'description: Valida.' '---' > "$SKILL_REPO/skills/futuro/SKILL.md"
assert_skill_failure 'rechaza name distinto del directorio'
write_future_skill; printf '\n[roto](ausente.md)\n' >> "$SKILL_REPO/skills/futuro/SKILL.md"
assert_skill_failure 'rechaza link local no resoluble'
write_future_skill; printf 'ajeno\n' > "$WORK/ajeno.md"; rm "$SKILL_REPO/skills/futuro/detalle.md"; ln -s "$WORK/ajeno.md" "$SKILL_REPO/skills/futuro/detalle.md"
assert_skill_failure 'rechaza recursos symlink'
rm "$SKILL_REPO/skills/futuro/detalle.md"; write_future_skill; rm "$SKILL_REPO/skills/futuro/SKILL.md"
assert_skill_failure 'rechaza Skill sin SKILL.md'
write_future_skill; awk 'NR == 3 { print "name: futuro" } { print }' "$SKILL_REPO/skills/futuro/SKILL.md" > "$WORK/duplicado.md"; mv "$WORK/duplicado.md" "$SKILL_REPO/skills/futuro/SKILL.md"
assert_skill_failure 'rechaza frontmatter ambiguo'
write_future_skill; printf '%s\n' '---' 'name: futuro' 'description: ""' '---' > "$SKILL_REPO/skills/futuro/SKILL.md"
assert_skill_failure 'rechaza description vacia aunque este entre comillas'
write_future_skill; printf '%s\n' '---' 'name: futuro' '---' > "$SKILL_REPO/skills/futuro/SKILL.md"
skill_out="$("$FIXTURE_ADAPTER" assets 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && assert_contains "$skill_out" 'falta description valida' 'Skill sin description culpa a la description, no al name' || fail 'Skill sin description debio fallar'
write_future_skill; mkdir -p "$SKILL_REPO/skills/futuro/sub:dir"; printf '%s\n' '[detalle](../detalle.md)' > "$SKILL_REPO/skills/futuro/sub:dir/nota.md"
"$FIXTURE_ADAPTER" assets >/dev/null 2>&1 && pass 'un recurso cuya ruta contiene ":" no falsea la validacion de enlaces' || fail 'un recurso con ":" en la ruta rompio la validacion de enlaces'
rm -rf "$SKILL_REPO/skills/futuro/sub:dir"
long_id="$(printf 'a%.0s' {1..57})"; rm -rf "$SKILL_REPO/skills/futuro"; mkdir "$SKILL_REPO/skills/$long_id"; printf '%s\n' '---' "name: $long_id" 'description: Valida.' '---' > "$SKILL_REPO/skills/$long_id/SKILL.md"
assert_skill_failure 'rechaza nombre OpenCode mayor de 64 caracteres'
permission_count="$(jq -r '.supported_permissions | length' "$MAPPING")"
[ "$permission_count" -eq 17 ] && pass 'mapping declara los 17 permisos soportados' || fail 'mapping no declara 17 permisos'

printf '%s\n' '[render] snapshots y frontmatter'
if render "$FIXTURES/agent-minimo.md" > "$WORK/minimo.md" && cmp -s "$FIXTURES/expected-agent-minimo.md" "$WORK/minimo.md"; then
    pass 'snapshot byte a byte de agente minimo'
else
    fail 'snapshot byte a byte de agente minimo'
fi
if render "$FIXTURES/command-delegado.md" > "$WORK/comando.md" && cmp -s "$FIXTURES/expected-command-delegado.md" "$WORK/comando.md"; then
    pass 'snapshot byte a byte de comando delegado'
else
    fail 'snapshot byte a byte de comando delegado'
fi
comando="$(< "$WORK/comando.md")"
assert_not_contains "$comando" 'agent:' 'agent no se infiere de launch-agent'
assert_not_contains "$comando" 'subtask' 'launch-agent puntual no emite subtask'
assert_contains "$comando" 'este mensaje: Analiza el estado actual y resume.' 'comando delegado lleva el mensaje explicito'
assert_not_contains "$comando" 'permission:' 'comando sin campo permission'
assert_not_contains "$comando" 'model:' 'comando hereda modelo'
assert_contains "$comando" 'usa la tool nativa `skill` para cargar, en este orden: `mefisto-projections`' 'comando solicita carga nativa del Skill'
assert_not_contains "$comando" '## Projections' 'comando no copia doctrina del Skill'

render "$FIXTURES/agent-completo.md" > "$WORK/completo.md"; rc=$?
[ "$rc" -eq 0 ] && pass 'render de capacidades combinadas' || fail 'render de capacidades combinadas'
if [ "$rc" -eq 0 ] && cmp -s "$FIXTURES/expected-agent-completo.md" "$WORK/completo.md"; then
    pass 'snapshot byte a byte de agente con varios Skills'
else
    fail 'snapshot byte a byte de agente con varios Skills'
fi
completo="$(< "$WORK/completo.md")"
assert_contains "$completo" 'description: "Lee, \"edita\" y ejecuta."' 'description queda escapada como YAML valido'
assert_contains "$completo" '"edit":{"*":"allow"' 'edicion sobre alcance consumidor'
assert_contains "$completo" '"read":{"*":"allow"' 'lectura sobre consumidor'
assert_contains "$completo" '"webfetch":"allow"' 'capacidad web'
assert_contains "$completo" '"lsp":"deny"' 'read no habilita lsp implicitamente'
assert_contains "$completo" '"todowrite":"deny"' 'permiso sin capacidad neutral queda denegado'
assert_contains "$completo" '"${MEFISTO_PACKAGE_ROOT}/scripts/prueba.sh" "$ARGUMENTS con espacios"' 'run cita la ruta y preserva argumentos con espacios'
assert_contains "$completo" 'package-root' 'preambulo OpenCode consulta el launcher activo'
assert_contains "$completo" 'export MEFISTO_PACKAGE_ROOT' 'preambulo OpenCode exporta la raiz efectiva'
assert_contains "$completo" 'Rutas: ${MEFISTO_CONFIG_PATH}, ${MEFISTO_INSTRUCTIONS_PATH} y ${MEFISTO_PACKAGE_ROOT}.' 'varias directivas preservan texto circundante'
assert_contains "$completo" 'MEFISTO_CONFIG_PATH=".mefisto/harness.config.json"' 'preambulo del contrato efectivo resuelve config canonico'
assert_contains "$completo" 'MEFISTO_INSTRUCTIONS_PATH="AGENTS.md"' 'preambulo del contrato efectivo resuelve instructions canonico'
[ "$(printf '%s\n' "$completo" | grep -c '^```bash$')" -eq 2 ] && pass 'config-path e instructions-path comparten un unico preambulo OpenCode adicional' || fail 'config-path e instructions-path no comparten preambulo OpenCode'
assert_contains "$completo" '.mefisto/pipeline/logs/con-espacio.log' 'state-path traducida'
assert_contains "$completo" '/mefisto:otra-orden' 'command conserva namespace'
assert_not_contains "$completo" '{{mefisto:' 'ocho directivas resueltas'
assert_contains "$completo" '.claude/harness.config.json' 'contrato efectivo nombra el fallback legacy de config solo en la salida adaptada'
assert_contains "$completo" 'CLAUDE.md' 'contrato efectivo nombra el fallback legacy de instrucciones solo en la salida adaptada'
assert_not_contains "$completo" '/Users/' 'sin path de maquina'
assert_not_contains "$completo" 'model:' 'agente hereda modelo'
assert_contains "$completo" 'tools: {"microsoft-learn_*":false,"terraform_*":false}' 'tools MCP cerradas por defecto y ordenadas'
assert_not_contains "$completo" 'mcp__' 'no emite matchers MCP de Claude'
assert_contains "$completo" '"skill":{"*":"deny","mefisto-projections":"allow","mefisto-comment-cleanup":"allow"}' 'allowlist exacta de Skills adaptados'
assert_contains "$completo" 'usa la tool nativa `skill` para cargar, en este orden: `mefisto-projections`, `mefisto-comment-cleanup`' 'agente solicita carga nativa en orden fuente'
assert_not_contains "$completo" '## Projections' 'agente no copia doctrina del Skill'
assert_not_contains "$comando" 'MEFISTO_PACKAGE_ROOT' 'body sin directivas de raiz no recibe preambulo'
make_agent raiz-skill '["skill"]' ',"skills":["projections"]'
printf '%s\n' 'Recursos: {{mefisto:skill-root projections}}/read-apis.md y {{mefisto:skill-root projections}}/recipes.md; paquete {{mefisto:package-root}}; ejecuta {{mefisto:run prueba.sh "$ARGUMENTS con espacios"}}.' >> "$WORK/raiz-skill.md"
skill_root_rendered="$(render "$WORK/raiz-skill.md")"; rc=$?
skill_root_preambles="$(printf '%s\n' "$skill_root_rendered" | grep -c 'mefisto_opencode_launcher="\$HOME/.local/share/mefisto/active/bin/mefisto-opencode"')"
[ "$rc" -eq 0 ] && assert_contains "$skill_root_rendered" '"${MEFISTO_PACKAGE_ROOT}/skills/mefisto-projections"/read-apis.md' 'skill-root OpenCode adapta el layout físico' || fail 'skill-root OpenCode debio renderizar'
[ "$rc" -eq 0 ] && assert_contains "$skill_root_rendered" 'paquete ${MEFISTO_PACKAGE_ROOT}; ejecuta MEFISTO_RUNTIME=opencode "${MEFISTO_PACKAGE_ROOT}/scripts/prueba.sh" "$ARGUMENTS con espacios"' 'skill-root convive con package-root y run en OpenCode' || fail 'directivas de raiz combinadas no se tradujeron en OpenCode'
[ "$skill_root_preambles" -eq 1 ] && pass 'varias directivas skill-root emiten un solo preambulo OpenCode' || fail 'skill-root OpenCode duplico el preambulo'

printf '%s\n' '[command-doc] ruta del comando generado'
printf '%s\n' '---' '{"kind":"command","id":"doc-prueba","description":"Prueba."}' '---' '{{mefisto:assert-consumer-repo}}' 'Lee {{mefisto:command-doc draft}} y luego {{mefisto:command-doc seed-secret}}.' > "$WORK/doc-prueba.md"
doc_rendered="$(render "$WORK/doc-prueba.md")"; rc=$?
doc_preambles="$(printf '%s\n' "$doc_rendered" | grep -c 'mefisto_opencode_launcher="\$HOME/.local/share/mefisto/active/bin/mefisto-opencode"')"
[ "$rc" -eq 0 ] && assert_contains "$doc_rendered" 'Lee "${MEFISTO_PACKAGE_ROOT}/commands/mefisto:draft.md" y' 'command-doc OpenCode resuelve la ruta exacta' || fail 'command-doc OpenCode debio renderizar'
[ "$rc" -eq 0 ] && assert_contains "$doc_rendered" 'luego "${MEFISTO_PACKAGE_ROOT}/commands/mefisto:seed-secret.md".' 'command-doc OpenCode segunda aparicion entre comillas' || fail 'command-doc OpenCode segunda aparicion'
[ "$doc_preambles" -eq 1 ] && pass 'varias directivas command-doc emiten un solo preambulo OpenCode' || fail 'command-doc OpenCode duplico el preambulo'
[ -f "$REPO_ROOT/dist/opencode/commands/mefisto:draft.md" ] && pass 'dist OpenCode contiene el comando referido' || fail 'dist OpenCode no contiene el comando referido'
printf '%s\n' '---' '{"kind":"command","id":"doc-prueba","description":"Prueba."}' '---' '{{mefisto:assert-consumer-repo}}' 'Lee {{mefisto:command-doc no-existe-jamas}}.' > "$WORK/doc-inexistente.md"
out="$(bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$WORK/doc-inexistente.md" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && assert_contains "$out" 'no-existe-jamas' 'validador rechaza command-doc inexistente nombrando el id (OpenCode)' || fail 'validador debio rechazar command-doc inexistente (OpenCode)'

printf '%s\n' '[contrato-efectivo] config-path e instructions-path'
make_agent contrato-config '["read"]'
printf '%s\n' '{{mefisto:config-path}}' >> "$WORK/contrato-config.md"
render "$WORK/contrato-config.md" > "$WORK/contrato-config.rendered.md"
CONFIG_PREAMBLE_CODE="$(extract_preamble "$WORK/contrato-config.rendered.md")"
make_agent contrato-instrucciones '["read"]'
printf '%s\n' '{{mefisto:instructions-path}}' >> "$WORK/contrato-instrucciones.md"
render "$WORK/contrato-instrucciones.md" > "$WORK/contrato-instrucciones.rendered.md"
INSTRUCTIONS_PREAMBLE_CODE="$(extract_preamble "$WORK/contrato-instrucciones.rendered.md")"
resolve_config() { local cwd="$1"; (cd "$cwd" && bash -c "$CONFIG_PREAMBLE_CODE"$'\n''printf "%s\n" "$MEFISTO_CONFIG_PATH"'); }
resolve_instructions() { local cwd="$1"; (cd "$cwd" && bash -c "$INSTRUCTIONS_PREAMBLE_CODE"$'\n''printf "%s\n" "$MEFISTO_INSTRUCTIONS_PATH"'); }

CONTRATO="$WORK/contrato consumidor"; mkdir -p "$CONTRATO/.mefisto" "$CONTRATO/.claude"

printf '{}' > "$CONTRATO/.mefisto/harness.config.json"
out="$(resolve_config "$CONTRATO" 2>"$WORK/config-canonico.err")"; rc=$?
[ "$rc" -eq 0 ] && [ "$out" = '.mefisto/harness.config.json' ] && [ ! -s "$WORK/config-canonico.err" ] && pass 'config-path: solo canonico resuelve sin aviso' || fail 'config-path: solo canonico'

rm -f "$CONTRATO/.mefisto/harness.config.json"
printf '{}' > "$CONTRATO/.claude/harness.config.json"
out="$(resolve_config "$CONTRATO" 2>"$WORK/config-legacy.err")"; rc=$?
[ "$rc" -eq 0 ] && [ "$out" = '.claude/harness.config.json' ] && [ ! -s "$WORK/config-legacy.err" ] && pass 'config-path: solo legacy resuelve como fallback' || fail 'config-path: solo legacy'

printf '{}' > "$CONTRATO/.mefisto/harness.config.json"
out="$(resolve_config "$CONTRATO" 2>"$WORK/config-ambos.err")"; rc=$?
[ "$rc" -eq 0 ] && [ "$out" = '.mefisto/harness.config.json' ] && grep -qF 'se usara el config canonico .mefisto/harness.config.json; se ignora el legacy .claude/harness.config.json' "$WORK/config-ambos.err" && pass 'config-path: coexistencia elige canonico y avisa sin mezclar' || fail 'config-path: coexistencia'

rm -f "$CONTRATO/.mefisto/harness.config.json" "$CONTRATO/.claude/harness.config.json"
out="$(resolve_config "$CONTRATO" 2>"$WORK/config-ausente.err")"; rc=$?
[ "$rc" -ne 0 ] && [ -z "$out" ] && grep -qF 'no se encontro el config canonico requerido .mefisto/harness.config.json' "$WORK/config-ausente.err" && grep -qF 'fallback legacy .claude/harness.config.json' "$WORK/config-ausente.err" && pass 'config-path: ausencia total aborta nombrando canonico y legacy' || fail 'config-path: ausencia total'

printf '{}' > "$CONTRATO/.mefisto/harness.config.json"; chmod 000 "$CONTRATO/.mefisto/harness.config.json"
out="$(resolve_config "$CONTRATO" 2>"$WORK/config-ilegible.err")"; rc=$?
if [ "$(id -u)" -eq 0 ]; then
    pass 'config-path: no legible (omitido bajo root, sin aplicacion de permisos)'
else
    [ "$rc" -eq 0 ] && [ "$out" = '.mefisto/harness.config.json' ] && pass 'config-path: canonico no legible se sigue seleccionando, igual que resolve_harness_config_path' || fail 'config-path: canonico no legible'
fi
chmod 644 "$CONTRATO/.mefisto/harness.config.json"

printf '%s\n' '@AGENTS.md' > "$CONTRATO/AGENTS.md"
out="$(resolve_instructions "$CONTRATO" 2>"$WORK/instrucciones-canonico.err")"; rc=$?
[ "$rc" -eq 0 ] && [ "$out" = 'AGENTS.md' ] && [ ! -s "$WORK/instrucciones-canonico.err" ] && pass 'instructions-path: solo canonico resuelve sin aviso' || fail 'instructions-path: solo canonico'

rm -f "$CONTRATO/AGENTS.md"
printf '%s\n' '@AGENTS.md' > "$CONTRATO/CLAUDE.md"
out="$(resolve_instructions "$CONTRATO" 2>"$WORK/instrucciones-legacy.err")"; rc=$?
[ "$rc" -eq 0 ] && [ "$out" = 'CLAUDE.md' ] && [ ! -s "$WORK/instrucciones-legacy.err" ] && pass 'instructions-path: solo legacy resuelve como fallback' || fail 'instructions-path: solo legacy'

printf '%s\n' '@AGENTS.md' > "$CONTRATO/AGENTS.md"
out="$(resolve_instructions "$CONTRATO" 2>"$WORK/instrucciones-ambos.err")"; rc=$?
[ "$rc" -eq 0 ] && [ "$out" = 'AGENTS.md' ] && grep -qF 'se usara AGENTS.md; se ignora el legacy CLAUDE.md' "$WORK/instrucciones-ambos.err" && pass 'instructions-path: coexistencia elige canonico y avisa sin mezclar' || fail 'instructions-path: coexistencia'

rm -f "$CONTRATO/AGENTS.md" "$CONTRATO/CLAUDE.md"
out="$(resolve_instructions "$CONTRATO" 2>"$WORK/instrucciones-ausente.err")"; rc=$?
[ "$rc" -ne 0 ] && [ -z "$out" ] && grep -qF 'no se encontro AGENTS.md' "$WORK/instrucciones-ausente.err" && grep -qF 'fallback legacy CLAUDE.md' "$WORK/instrucciones-ausente.err" && grep -qF '/mefisto:onboard' "$WORK/instrucciones-ausente.err" && pass 'instructions-path: ausencia total aborta con diagnostico de onboarding' || fail 'instructions-path: ausencia total'

printf '%s\n' '@AGENTS.md' > "$CONTRATO/AGENTS.md"; chmod 000 "$CONTRATO/AGENTS.md"
out="$(resolve_instructions "$CONTRATO" 2>"$WORK/instrucciones-ilegible.err")"; rc=$?
if [ "$(id -u)" -eq 0 ]; then
    pass 'instructions-path: no legible (omitido bajo root, sin aplicacion de permisos)'
else
    [ "$rc" -eq 0 ] && [ "$out" = 'AGENTS.md' ] && pass 'instructions-path: canonico no legible se sigue seleccionando' || fail 'instructions-path: canonico no legible'
fi
chmod 644 "$CONTRATO/AGENTS.md"

make_agent contrato-repetido '["read"]'
printf '%s\n' 'Primero {{mefisto:config-path}} y de nuevo {{mefisto:config-path}}; tambien {{mefisto:instructions-path}} y otra vez {{mefisto:instructions-path}}.' >> "$WORK/contrato-repetido.md"
repetido_rendered="$(render "$WORK/contrato-repetido.md")"; rc=$?
repetido_blocks="$(printf '%s\n' "$repetido_rendered" | grep -c '^```bash$')"
[ "$rc" -eq 0 ] && [ "$repetido_blocks" -eq 1 ] && pass 'usos repetidos de config-path/instructions-path comparten un unico preambulo OpenCode' || fail 'usos repetidos duplicaron el preambulo OpenCode'
[ "$(printf '%s\n' "$repetido_rendered" | grep -Fo '${MEFISTO_CONFIG_PATH}' | wc -l | tr -d '[:space:]')" -eq 2 ] && pass 'config-path conserva cada uso inline repetido' || fail 'config-path perdio un uso inline repetido'
[ "$(printf '%s\n' "$repetido_rendered" | grep -Fo '${MEFISTO_INSTRUCTIONS_PATH}' | wc -l | tr -d '[:space:]')" -eq 2 ] && pass 'instructions-path conserva cada uso inline repetido' || fail 'instructions-path perdio un uso inline repetido'

printf '%s\n' '[resolucion] launcher XDG y fallos OpenCode'
PREAMBLE_CODE="$(extract_preamble "$WORK/completo.md")"
HOME="$WORK/home con espacios"; XDG_DATA_HOME="$HOME/datos con espacios"; export HOME XDG_DATA_HOME
FAKE_ROOT="$WORK/release activa con espacios"; mkdir -p "$FAKE_ROOT/scripts" "$XDG_DATA_HOME/mefisto/active/bin"
FAKE_ROOT_PHYSICAL="$(cd "$FAKE_ROOT" && pwd -P)"
printf '%s\n' '#!/bin/sh' '[ "$1" = package-root ] || exit 2' 'printf "%s\\n" "$MEFISTO_TEST_ROOT"' > "$XDG_DATA_HOME/mefisto/active/bin/mefisto-opencode"
chmod +x "$XDG_DATA_HOME/mefisto/active/bin/mefisto-opencode"
printf '%s\n' '#!/bin/sh' 'printf invoked > "$MEFISTO_TEST_TRACE"' > "$FAKE_ROOT/scripts/probe.sh"; chmod +x "$FAKE_ROOT/scripts/probe.sh"
run_opencode_resolution() {
    local root="$1" trace="$2"
    MEFISTO_TEST_ROOT="$root" MEFISTO_TEST_TRACE="$trace" bash -c "$PREAMBLE_CODE"$'\n''printf "ROOT=%s\\n" "$MEFISTO_PACKAGE_ROOT"; "$MEFISTO_PACKAGE_ROOT/scripts/probe.sh"'
}
out="$(run_opencode_resolution "$FAKE_ROOT/" "$WORK/opencode.trace" 2> "$WORK/opencode.err")"; rc=$?
[ "$rc" -eq 0 ] && [ "$out" = "ROOT=$FAKE_ROOT_PHYSICAL" ] && [ -f "$WORK/opencode.trace" ] && pass 'XDG localiza launcher y normaliza release con espacios' || fail 'XDG no resolvio la release con espacios'
assert_opencode_resolution_fails() {
    local root="$1" label="$2" trace="$WORK/opencode-failure.trace" rc
    rm -f "$trace"
    run_opencode_resolution "$root" "$trace" > "$WORK/opencode-failure.stdout" 2> "$WORK/opencode-failure.stderr"; rc=$?
    if [ "$rc" -ne 0 ] && [ ! -e "$trace" ]; then
        assert_contains "$(< "$WORK/opencode-failure.stderr")" 'ERROR OpenCode:' "$label"
        assert_contains "$(< "$WORK/opencode-failure.stderr")" 'active la release OpenCode' "$label incluye accion concreta"
    else
        fail "$label"; fail "$label incluye accion concreta"
    fi
}
assert_opencode_resolution_fails 'release-relativa' 'salida relativa aborta antes del script'
assert_opencode_resolution_fails "$WORK/release ausente" 'release ausente aborta antes del script'
printf '%s\n' '#!/bin/sh' 'exit 7' > "$XDG_DATA_HOME/mefisto/active/bin/mefisto-opencode"; chmod +x "$XDG_DATA_HOME/mefisto/active/bin/mefisto-opencode"
assert_opencode_resolution_fails "$FAKE_ROOT" 'fallo del launcher aborta antes del script'
rm "$XDG_DATA_HOME/mefisto/active/bin/mefisto-opencode"
assert_opencode_resolution_fails "$FAKE_ROOT" 'launcher ausente aborta antes del script'
ln -s "$WORK/no-existe" "$XDG_DATA_HOME/mefisto/active/bin/mefisto-opencode"
assert_opencode_resolution_fails "$FAKE_ROOT" 'launcher roto aborta antes del script'

printf '%s\n' '[permisos] deny por defecto y capacidades aisladas'
make_agent solo-read '["read"]'; read_permission="$(permission_of "$WORK/solo-read.md")"
jq -e '.read["*"] == "allow" and .list == "allow" and .glob == "allow" and .grep == "allow" and .edit["*"] == "deny" and .bash["*"] == "deny"' <<< "$read_permission" >/dev/null && pass 'combinacion read' || fail 'combinacion read'
make_agent solo-edit '["edit"]'; edit_permission="$(permission_of "$WORK/solo-edit.md")"
jq -e '.edit["*"] == "allow" and .write["*"] == "allow" and .patch["*"] == "allow" and .read["*"] == "deny"' <<< "$edit_permission" >/dev/null && pass 'combinacion edit' || fail 'combinacion edit'
make_agent solo-shell '["shell"]'; shell_permission="$(permission_of "$WORK/solo-shell.md")"
jq -e '.bash["*"] == "deny" and .bash["${MEFISTO_PACKAGE_ROOT}/scripts/*"] == "allow" and .bash["dotnet *"] == "allow" and .bash["func init *"] == "allow" and .bash["terraform init -backend=false*"] == "allow" and .bash["terraform validate*"] == "allow" and .bash["terraform fmt*"] == "allow" and .bash["python3 - *"] == "allow" and .bash["python3 -m json.tool*"] == "allow" and .bash["cd *"] == "allow" and .bash["echo *"] == "allow" and .bash["test *"] == "allow" and .bash["[ *"] == "allow" and .bash["touch *"] == "allow" and .bash["tr *"] == "allow" and .bash["head *"] == "allow" and .bash["tail *"] == "allow" and .bash["awk *"] == "allow" and .bash["sed *"] == "allow" and .bash["mv *"] == "allow" and .bash["ilspycmd *"] == "allow" and .bash["rm *"] == "deny" and .bash["rm -f src/*"] == "allow" and .bash["rm -rf src/*"] == "allow" and .bash["rm -f tests/*"] == "allow" and .bash["rm -f \"src/*"] == "allow" and .bash["rm -rf \"src/*"] == "allow" and .bash["rm -f \"tests/*"] == "allow" and .bash["curl *"] == "deny" and .bash["ssh *"] == "deny" and .bash["scp *"] == "deny" and .bash["sudo *"] == "deny" and ((.bash | to_entries | map(.key)) as $rules | ($rules | index("rm *")) < ($rules | index("rm -f src/*"))) and .external_directory["*"] == "deny" and .external_directory["~/.local/share/mefisto/*"] == "allow"' <<< "$shell_permission" >/dev/null && pass 'combinacion shell acotada' || fail 'combinacion shell acotada'
keys="$(printf '%s' "$read_permission" | jq -c 'keys | sort')"
supported="$(jq -c '.supported_permissions | sort' "$MAPPING")"
[ "$keys" = "$supported" ] && pass 'todo permiso soportado tiene valor explicito' || fail 'faltan o sobran permisos emitidos'

printf '%s\n' '[fallos] fail-closed'
make_agent desconocida '["desconocida"]'
out="$(render "$WORK/desconocida.md" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && assert_contains "$out" 'capabilities: capacidad '\''desconocida'\'' sin mapping OpenCode' 'capacidad desconocida falla con campo' || fail 'capacidad desconocida debio fallar'
make_agent con-skill '[]' ',"skills":["algo"]'
out="$(render "$WORK/con-skill.md" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && assert_contains "$out" "Skill publicado 'algo' no existe" 'Skill inexistente falla antes de publicar' || fail 'Skill inexistente debio fallar'
make_agent sin-capacidad '[]' ',"skills":["projections"]'
out="$(render "$WORK/sin-capacidad.md" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && assert_contains "$out" "requiere la capacidad 'skill'" 'agente con Skills sin capacidad falla' || fail 'Skills sin capacidad debieron fallar'
make_agent duplicado '["skill"]' ',"skills":["projections","projections"]'
out="$(render "$WORK/duplicado.md" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && assert_contains "$out" "referencia duplicada 'projections'" 'Skill duplicado falla' || fail 'Skill duplicado debio fallar'
make_agent prefijado '["skill"]' ',"skills":["mefisto-projections"]'
out="$(render "$WORK/prefijado.md" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && assert_contains "$out" 'ya tiene prefijo OpenCode' 'Skill prefijado falla' || fail 'Skill prefijado debio fallar'
make_agent no-representable '["skill"]' ',"skills":["no_representable"]'
out="$(render "$WORK/no-representable.md" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && assert_contains "$out" "referencia no representable 'no_representable'" 'Skill no representable falla' || fail 'Skill no representable debio fallar'
make_agent vacio '["skill"]' ',"skills":[""]'
out="$(render "$WORK/vacio.md" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && assert_contains "$out" "referencia no representable ''" 'Skill vacio no desaparece silenciosamente' || fail 'Skill vacio debio fallar'
make_agent skill-sin-lista '["skill"]'
skill_sin_lista="$(permission_of "$WORK/skill-sin-lista.md")"
jq -e '.skill == "allow"' <<< "$skill_sin_lista" >/dev/null && pass 'capacidad skill sin referencias conserva politica general' || fail 'capacidad skill sin referencias altero politica'
make_agent read-skill-sin-lista '["read","skill"]'
make_agent read-skill-acotado '["read","skill"]' ',"skills":["projections"]'
read_skill_general="$(permission_of "$WORK/read-skill-sin-lista.md")"
read_skill_acotado="$(permission_of "$WORK/read-skill-acotado.md")"
[ "$(printf '%s' "$read_skill_general" | jq -c 'del(.skill)')" = "$(printf '%s' "$read_skill_acotado" | jq -c 'del(.skill)')" ] && pass 'allowlist de Skills no altera otros permisos' || fail 'allowlist de Skills altero otros permisos'
make_agent microsoft '[]' ',"mcp":["microsoft-learn"]'
out="$(render "$WORK/microsoft.md" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && assert_contains "$out" 'tools: {"microsoft-learn_*":true,"terraform_*":false}' 'MCP Microsoft bundleado habilita solo su patron' || fail 'MCP Microsoft debio renderizar una allowlist cerrada'
make_agent terraform '[]' ',"mcp":["terraform"]'
out="$(render "$WORK/terraform.md" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && assert_contains "$out" 'tools: {"microsoft-learn_*":false,"terraform_*":true}' 'MCP Terraform externo habilita solo su patron' || fail 'MCP Terraform externo debio renderizar una allowlist cerrada'
make_agent ambos '[]' ',"mcp":["microsoft-learn","terraform"]'
out="$(render "$WORK/ambos.md" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && assert_contains "$out" 'tools: {"microsoft-learn_*":true,"terraform_*":true}' 'ambos ids MCP conservan el orden del registro' || fail 'ambos ids MCP debieron renderizarse'
make_agent duplicado-mcp '[]' ',"mcp":["terraform","terraform"]'
out="$(render "$WORK/duplicado-mcp.md" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && assert_contains "$out" 'referencia MCP duplicada' 'MCP duplicado aborta visiblemente' || fail 'MCP duplicado debio fallar'
out="$(render "$FIXTURES/agent-mcp-desconocido.md" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && assert_contains "$out" "id MCP 'servidor-ajeno' ausente del registro" 'MCP ausente del registro aborta con id' || fail 'MCP ausente debio fallar'

for fixture in agent-microsoft agent-terraform agent-ambos-mcp; do
    if render "$FIXTURES/$fixture.md" > "$WORK/$fixture.md" && cmp -s "$FIXTURES/expected-$fixture.md" "$WORK/$fixture.md"; then
        pass "snapshot byte a byte de $fixture"
    else
        fail "snapshot byte a byte de $fixture"
    fi
done

rm -rf "$SKILL_REPO/skills"; mkdir -p "$SKILL_REPO/skills/futuro"; write_future_skill
cp "$FIXTURES/agent-microsoft.md" "$SKILL_REPO/src/published/agent-microsoft.md"
jq '.servers += [{"id":"servidor-sin-mapping","provisioning":"external","transport":null,"url":null,"authentication":null}]' "$REPO_ROOT/src/published/contract/mcp-servers.json" > "$SKILL_REPO/src/published/contract/mcp-servers.json"
out="$("$FIXTURE_ADAPTER" render "$SKILL_REPO/src/published/agent-microsoft.md" '<!-- prueba -->' 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then
    assert_contains "$out" 'agent-microsoft.md: mcp:' 'id sin mapping nombra el artefacto'
    assert_contains "$out" "id MCP 'servidor-sin-mapping' sin mapping OpenCode" 'id sin mapping nombra el id afectado'
else
    fail 'id MCP sin mapping debio fallar'
fi
jq '.servers += [.servers[0]]' "$REPO_ROOT/src/published/contract/mcp-servers.json" > "$SKILL_REPO/src/published/contract/mcp-servers.json"
out="$("$FIXTURE_ADAPTER" render "$SKILL_REPO/src/published/agent-microsoft.md" '<!-- prueba -->' 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then
    assert_contains "$out" 'agent-microsoft.md: mcp:' 'registro duplicado nombra el artefacto'
    assert_contains "$out" "id MCP 'microsoft-learn' duplicado en el registro" 'registro duplicado nombra el id afectado'
else
    fail 'id MCP duplicado en registro debio fallar'
fi

printf '%s\n' '[delegacion MCP] comandos y agente ejecutor'
MCP_ROOT="$WORK/mcp-root"
mkdir -p "$MCP_ROOT/src/published/agents" "$MCP_ROOT/src/published/commands" "$MCP_ROOT/src/published/contract" "$MCP_ROOT/src/published/scripts/lib"
cp "$REPO_ROOT/src/published/contract/published-artifact.schema.json" "$MCP_ROOT/src/published/contract/"
cp "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$MCP_ROOT/src/published/scripts/"
cp "$REPO_ROOT/src/published/scripts/lib/jsonschema-lite.jq" "$MCP_ROOT/src/published/scripts/lib/"
chmod +x "$MCP_ROOT/src/published/scripts/validate-published-artifacts.sh"
MCP_ARTIFACT_VALIDATOR="$MCP_ROOT/src/published/scripts/validate-published-artifacts.sh"
cp "$FIXTURES/agent-ejecutor-mcp.md" "$MCP_ROOT/src/published/agents/ejecutor-mcp.md"
cp "$FIXTURES/command-mcp-valido.md" "$MCP_ROOT/src/published/commands/command-mcp-valido.md"
cp "$FIXTURES/command-mcp-invalido.md" "$MCP_ROOT/src/published/commands/command-mcp-invalido.md"
out="$(cd "$MCP_ROOT" && src/published/scripts/validate-published-artifacts.sh src/published/commands/command-mcp-valido.md 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && pass 'fixture de comando MCP delega validamente con ruta relativa' || fail "fixture de delegacion MCP valida fue rechazada: $out"
out="$("$MCP_ARTIFACT_VALIDATOR" "$MCP_ROOT/src/published/commands/command-mcp-invalido.md" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && assert_contains "$out" 'no delega a un agente neutral' 'fixture de comando MCP rechaza ausencia de agente' || fail 'fixture de comando sin agente debio fallar'
write_mcp_agent() {
    printf '%s\n' '---' '{"kind":"agent","effort":"light","id":"ejecutor-mcp","description":"Ejecutor.","mode":"subagent","mcp":["microsoft-learn","terraform"]}' '---' '{{mefisto:assert-consumer-repo}}' > "$MCP_ROOT/src/published/agents/ejecutor-mcp.md"
}
write_mcp_command() {
    local mcp="$1" agent="$2"
    printf '%s\n' '---' "{\"kind\":\"command\",\"id\":\"consulta-mcp\",\"description\":\"Consulta.\",\"mcp\":$mcp${agent:+,\"agent\":\"$agent\"}}" '---' '{{mefisto:assert-consumer-repo}}' > "$MCP_ROOT/src/published/commands/consulta-mcp.md"
}
write_mcp_agent; write_mcp_command '["microsoft-learn"]' ejecutor-mcp
out="$("$MCP_ARTIFACT_VALIDATOR" "$MCP_ROOT/src/published/commands/consulta-mcp.md" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && pass 'comando MCP delega validamente a agente con superconjunto' || fail "delegacion MCP valida fue rechazada: $out"
write_mcp_command '["microsoft-learn"]' inexistente
out="$("$MCP_ARTIFACT_VALIDATOR" "$MCP_ROOT/src/published/commands/consulta-mcp.md" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && assert_contains "$out" "agente delegado 'inexistente' no existe" 'comando MCP rechaza agente inexistente' || fail 'agente inexistente debio fallar'
write_mcp_command '["microsoft-learn"]' ''
out="$("$MCP_ARTIFACT_VALIDATOR" "$MCP_ROOT/src/published/commands/consulta-mcp.md" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && assert_contains "$out" 'no delega a un agente neutral' 'comando MCP rechaza ausencia de agente' || fail 'comando sin agente debio fallar'
write_mcp_command '["microsoft-learn"]' ejecutor-mcp
printf '%s\n' '---' '{"kind":"agent","effort":"light","id":"ejecutor-mcp","description":"Ejecutor.","mode":"subagent","mcp":["terraform"]}' '---' '{{mefisto:assert-consumer-repo}}' > "$MCP_ROOT/src/published/agents/ejecutor-mcp.md"
out="$("$MCP_ARTIFACT_VALIDATOR" "$MCP_ROOT/src/published/commands/consulta-mcp.md" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && assert_contains "$out" 'no declaran todos los ids requeridos' 'comando MCP rechaza subconjunto incumplido' || fail 'subconjunto MCP incumplido debio fallar'
{ printf '%s\n' '---' '{"kind":"command","id":"consulta-mcp","description":"x","mcp":["microsoft-learn","terraform"]}' '---' '{{mefisto:assert-consumer-repo}}' '{{mefisto:launch-agent ejecutor-mcp Mensaje A}}'; } > "$MCP_ROOT/src/published/commands/consulta-mcp.md"
printf '%s\n' '---' '{"kind":"agent","effort":"light","id":"otro-mcp","description":"Otro.","mode":"subagent","mcp":["microsoft-learn"]}' '---' '{{mefisto:assert-consumer-repo}}' > "$MCP_ROOT/src/published/agents/otro-mcp.md"
out="$("$MCP_ARTIFACT_VALIDATOR" "$MCP_ROOT/src/published/commands/consulta-mcp.md" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && pass 'MCP con una sola delegacion insuficiente falla' || fail 'MCP con una sola delegacion insuficiente debio fallar'
{ printf '%s\n' '---' '{"kind":"command","id":"consulta-mcp","description":"x","mcp":["microsoft-learn","terraform"]}' '---' '{{mefisto:assert-consumer-repo}}' '{{mefisto:launch-agent ejecutor-mcp Mensaje A}}' '{{mefisto:launch-agent otro-mcp Mensaje B}}'; } > "$MCP_ROOT/src/published/commands/consulta-mcp.md"
out="$("$MCP_ARTIFACT_VALIDATOR" "$MCP_ROOT/src/published/commands/consulta-mcp.md" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && pass 'MCP considera todas las delegaciones del body' || fail "MCP con dos delegaciones debio pasar: $out"
make_agent directiva '[]'
printf '%s\n' '{{mefisto:desconocida}}' >> "$WORK/directiva.md"
out="$(render "$WORK/directiva.md" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && assert_contains "$out" 'body: directiva sin mapping OpenCode' 'directiva sin mapping falla con campo' || fail 'directiva debio fallar'

printf '%s\n' '[coste] limite de procesos jq por render OpenCode (issue #1519)'
JQ_REAL="$(command -v jq)"
JQ_WRAPPER_DIR="$WORK/jq-wrapper"
mkdir -p "$JQ_WRAPPER_DIR"
cat > "$JQ_WRAPPER_DIR/jq" <<EOF
#!/usr/bin/env bash
[ -z "\${JQ_CALL_COUNTER:-}" ] || printf 'x' >> "\$JQ_CALL_COUNTER"
exec "$JQ_REAL" "\$@"
EOF
chmod +x "$JQ_WRAPPER_DIR/jq"
assert_jq_budget() {
    local fixture="$1" counter="$WORK/jq-calls-$fixture.count" rc calls
    rm -f "$counter"
    JQ_CALL_COUNTER="$counter" PATH="$JQ_WRAPPER_DIR:$PATH" "$ADAPTER" render "$FIXTURES/$fixture.md" '<!-- prueba coste -->' > "$WORK/jq-calls-$fixture.out" 2> "$WORK/jq-calls-$fixture.err"
    rc=$?
    calls="$(wc -c < "$counter" 2>/dev/null | tr -d '[:space:]')"
    [ -n "$calls" ] || calls=0
    [ "$rc" -eq 0 ] && [ "$calls" -le 12 ] && pass "$fixture: render usa <= 12 procesos jq ($calls)" || fail "$fixture: render uso $calls procesos jq (rc=$rc): $(cat "$WORK/jq-calls-$fixture.err")"
}
assert_jq_budget agent-completo
assert_jq_budget agent-ambos-mcp

printf '%s\n' '[delegacion] completa por frontmatter y puntual en el body'
mk_cmd() { local n="$1" fm="$2"; shift 2; { printf '%s\n' '---' "$fm" '---' '{{mefisto:assert-consumer-repo}}'; printf '%s\n' "$@"; } > "$WORK/$n.md"; }
mk_cmd cmd-completo '{"kind":"command","id":"cmd-completo","description":"x","agent":"agent-completo"}' 'Cuerpo.'
completo_o="$(render "$WORK/cmd-completo.md")"
assert_contains "$completo_o" 'agent: "agent-completo"' 'frontmatter agent emite agent'
assert_contains "$completo_o" 'subtask: true' 'frontmatter agent emite subtask'
mk_cmd cmd-lr '{"kind":"command","id":"cmd-lr","description":"x"}' "MEFISTO_LOADED_ROOT='{{mefisto:loaded-root}}' fin"
render "$WORK/cmd-lr.md" > "$WORK/cmd-lr.out"; lr_c="$(< "$WORK/cmd-lr.out")"
assert_contains "$lr_c" "MEFISTO_LOADED_ROOT='' fin" 'loaded-root se renderiza como cadena vacia'
mk_cmd cmd-puntual '{"kind":"command","id":"cmd-puntual","description":"x"}' 'Paso 1: pregunta al usuario.' '{{mefisto:launch-agent agent-completo Escribe el ambiente dev y el proposito Facturas}}' 'Paso 3: crea el PR.'
puntual_o="$(render "$WORK/cmd-puntual.md")"
assert_not_contains "$puntual_o" 'subtask' 'puntual no convierte el comando en subtask'
assert_not_contains "$puntual_o" 'agent:' 'puntual no infiere agent'
assert_contains "$puntual_o" 'invoca la tool `task` con el agente `agent-completo` y este mensaje: Escribe el ambiente dev y el proposito Facturas.' 'puntual invoca task con el mensaje dado'
assert_not_contains "$puntual_o" 'ARGUMENTS' 'puntual no pasa $ARGUMENTS'
assert_contains "$puntual_o" 'Paso 3: crea el PR.' 'el comando continua tras la delegacion'
mk_cmd cmd-alt '{"kind":"command","id":"cmd-alt","description":"x"}' 'Si aplica A: {{mefisto:launch-agent agent-completo Mensaje A}}' 'Si aplica B: {{mefisto:launch-agent agent-completo Mensaje B}}'
alt_o="$(render "$WORK/cmd-alt.md")"
assert_contains "$alt_o" 'este mensaje: Mensaje A.' 'alternativa A traducida'
assert_contains "$alt_o" 'este mensaje: Mensaje B.' 'alternativa B traducida'
assert_not_contains "$alt_o" 'subtask' 'alternativas no generan subtask'
printf '%s\n' '---' '{"kind":"command","id":"consulta-mcp","description":"x"}' '---' '{{mefisto:assert-consumer-repo}}' '{{mefisto:launch-agent ejecutor-mcp}}' > "$MCP_ROOT/src/published/commands/consulta-mcp.md"
out="$("$MCP_ARTIFACT_VALIDATOR" "$MCP_ROOT/src/published/commands/consulta-mcp.md" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && assert_contains "$out" 'directiva mefisto mal formada' 'rechaza launch-agent sin mensaje' || fail 'launch-agent sin mensaje debio fallar'
printf '%s\n' '---' '{"kind":"command","id":"consulta-mcp","description":"x"}' '---' '{{mefisto:assert-consumer-repo}}' '{{mefisto:launch-agent agente-inexistente Haz algo}}' > "$MCP_ROOT/src/published/commands/consulta-mcp.md"
out="$("$MCP_ARTIFACT_VALIDATOR" "$MCP_ROOT/src/published/commands/consulta-mcp.md" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && assert_contains "$out" "launch-agent 'agente-inexistente' no existe" 'rechaza launch-agent con id inexistente' || fail 'launch-agent con id inexistente debio fallar'
printf '%s\n' '---' '{"kind":"command","id":"consulta-mcp","description":"x","agent":"ejecutor-mcp"}' '---' '{{mefisto:assert-consumer-repo}}' '{{mefisto:launch-agent ejecutor-mcp Haz algo}}' > "$MCP_ROOT/src/published/commands/consulta-mcp.md"
out="$("$MCP_ARTIFACT_VALIDATOR" "$MCP_ROOT/src/published/commands/consulta-mcp.md" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && assert_contains "$out" 'un comando con agent no puede usar launch-agent' 'rechaza launch-agent junto a agent' || fail 'launch-agent junto a agent debio fallar'

printf '%s\n' '[ask] capacidad neutral ask'
make_mode_agent() {
    printf '%s\n' '---' "{\"kind\":\"agent\",\"effort\":\"light\",\"id\":\"$1\",\"description\":\"Prueba.\",\"mode\":\"$2\",\"capabilities\":$3}" '---' '{{mefisto:assert-consumer-repo}}' > "$WORK/$1.md"
}
make_mode_agent ask-all all '["read","ask"]'; assert_contains "$(permission_of "$WORK/ask-all.md")" '"question":"allow"' 'mode all con ask permite question'
make_mode_agent ask-primary primary '["read","ask"]'; assert_contains "$(permission_of "$WORK/ask-primary.md")" '"question":"allow"' 'mode primary con ask permite question'
make_mode_agent noask-all all '["read"]'; assert_contains "$(permission_of "$WORK/noask-all.md")" '"question":"deny"' 'mode all sin ask conserva question deny'
make_mode_agent ask-sub subagent '["read","ask"]'; assert_contains "$(permission_of "$WORK/ask-sub.md")" '"question":"deny"' 'subagent con ask sigue en question deny'

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
