#!/usr/bin/env bash
# Contrato del agente planner neutral y su proyeccion publicada
# (issue #1640: migracion desde agents/planner.md hand-escrito Claude-only).
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/agents/planner.md"
CLAUDE="$REPO_ROOT/dist/claude/agents/planner.md"
MIRROR="$REPO_ROOT/agents/planner.md"
FIELD_NOTE_SOURCE="$REPO_ROOT/scripts/field-note.sh"
FIELD_NOTE_CLAUDE="$REPO_ROOT/dist/claude/scripts/field-note.sh"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }

echo '[fuente] contrato neutral, perfil, skill y mcp'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "agent" and .id == "planner" and .mode == "all" and .profile == "deep" and (.capabilities | index("read") != null and index("edit") != null and index("shell") != null) and .skills == ["projections"] and .mcp == ["microsoft-learn"]' >/dev/null; then
    pass 'metadata declara agent/planner/all/deep/skills-projections/mcp-microsoft-learn'
else
    fail 'metadata neutral invalida'
fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor presente'
contains "$body" '{{mefisto:package-root}}/docs/adr/' 'resuelve ADRs via package-root'
contains "$body" '{{mefisto:skill-root projections}}' 'resuelve recursos de Nivel 3 del Skill via skill-root'
contains "$body" '{{mefisto:config-path}}' 'lee el config efectivo via config-path'
contains "$body" '{{mefisto:state-path summaries}}' 'redacta los borradores bajo state-path summaries'
contains "$body" '{{mefisto:run field-note.sh' 'el cierre delega en field-note.sh via directiva run'
absent "$body" '/tmp/planner-' 'fuente no escribe borradores en /tmp'
absent "$body" '.plugin-root' 'fuente no resuelve .plugin-root'
absent "$body" 'plugins/cache' 'fuente no busca el cache del marketplace'
absent "$body" '.claude/' 'fuente no referencia rutas .claude/'
absent "$body" 'CLAUDE_' 'fuente no referencia variables CLAUDE_*'
absent "$body" 'PLUGIN_ROOT' 'fuente no reconstruye PLUGIN_ROOT a mano'

echo '[fuente] guardas de inventario de eventos (#2058)'
contains "$body" '## Guardas de inventario de eventos: agregar un evento' 'seccion de guardas de inventario presente'
contains "$body" 'agrega un evento persistido o de bus' 'la seccion declara su activacion'
contains "$body" '**Lista exacta / conteo**' 'clasifica lista exacta/conteo'
contains "$body" '**Tabla evento->topic**' 'clasifica tabla evento->topic'
contains "$body" 'eliminar `<Test>`' 'instruye eliminar la guarda cuando existe la derivada'
contains "$body" 'reemplazar `<Test>` por la guarda derivada' 'instruye reemplazar cuando no existe la derivada'
contains "$body" 'RegistraTodosLosEventosPersistidos' 'referencia el patron del domain-scaffolder'
contains "$body" '(typeof(Evento), "topic")' 'exige el par exacto tipo-topic'
contains "$body" 'tests de dominio Given/When/Then' 'excluye los tests de dominio'
contains "$body" '- [ ] **Guardas de inventario de eventos**' 'checklist pre-listo incluye el item'

echo '[fuente] decisiones cerradas (#2147)'
if printf '%s' "$metadata" | jq -e '.capabilities | index("web") != null' >/dev/null; then pass 'metadata declara la capacidad web'; else fail 'metadata sin capacidad web'; fi
contains "$body" '- [ ] **Decisiones cerradas**' 'checklist pre-listo incluye Decisiones cerradas'
contains "$body" '{{mefisto:state-path sandbox}}' 'pruebas de concepto bajo state-path sandbox'

echo '[fuente] preguntas nativas (#2137)'
if printf '%s' "$metadata" | jq -e '.capabilities | index("ask") != null' >/dev/null; then pass 'metadata declara la capacidad ask'; else fail 'metadata sin capacidad ask'; fi
contains "$body" '## Preguntas al usuario' 'seccion de preguntas al usuario presente'
contains "$body" '(Recomendado)' 'la recomendada primero con (Recomendado)'
contains "$body" 'pregunta en texto con las mismas reglas' 'fallback en texto sin la herramienta'
contains "$body" '¿Paso #N "<título>" a estado:listo?' 'la pregunta de listo nombra el issue'
absent "$body" 'AskUserQuestion' 'la fuente no nombra AskUserQuestion'
contains "$(< "$CLAUDE")" 'AskUserQuestion' 'el adaptador Claude incluye AskUserQuestion'

echo '[salidas] adaptador y mirror'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
claude_body="$(< "$CLAUDE")"

contains "$claude_body" 'name: "planner"' 'Claude expone el id del agente'
contains "$claude_body" 'model: "opus"' 'Claude materializa el perfil deep como opus'
contains "$claude_body" 'skills: ["projections"]' 'Claude declara el Skill projections'
contains "$claude_body" 'mcp__plugin_mefisto_microsoft-learn__*' 'Claude declara el matcher MCP scoped de microsoft-learn (plugin bundleado)'

# El preambulo compartido de resolucion de MEFISTO_PACKAGE_ROOT/MEFISTO_CONFIG_PATH
# (identico en todo artefacto que use {{mefisto:package-root}}/{{mefisto:config-path}},
# p. ej. merge.md) SI menciona '.plugin-root' y el fallback legacy '.claude/harness.config.json'
# como parte de su propia mecanica de resolucion -- eso no es responsabilidad de este
# agente y queda fuera de este chequeo. Lo que se exige es que el CUERPO PROPIO de
# planner (fuera de ese preambulo compartido) no reimplemente esa mecanica a mano.
absent "$claude_body" '/tmp/planner-' 'salida claude_body no escribe borradores en /tmp'
absent "$claude_body" 'plugins/cache' 'salida claude_body no busca el cache del marketplace'
absent "$claude_body" 'CONFIG="$REPO_ROOT' 'el cuerpo propio no reconstruye la ruta del config a mano (CONFIG=$REPO_ROOT/...)'

echo '[cierre] invocacion de field-note.sh'
contains "$claude_body" '"${MEFISTO_PACKAGE_ROOT}/scripts/field-note.sh"' 'Claude invoca field-note.sh via MEFISTO_PACKAGE_ROOT'
contains "$claude_body" 'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/field-note.sh"' 'Claude fija su propio runtime al invocar field-note.sh'
contains "$claude_body" '--session-id "$SESSION_ID" --timestamp "$CLOSING_TIMESTAMP" --field-note "$FIELD_NOTE_LOCAL"' 'Claude conserva los flags obligatorios del cierre'

echo '[scripts/field-note.sh] paridad de la clausura de tooling'
if [ -x "$FIELD_NOTE_SOURCE" ]; then pass 'scripts/field-note.sh conserva el bit de ejecucion'; else fail 'scripts/field-note.sh sin bit de ejecucion'; fi
if [ -f "$FIELD_NOTE_CLAUDE" ] && cmp -s "$FIELD_NOTE_SOURCE" "$FIELD_NOTE_CLAUDE"; then
    pass 'dist/claude/scripts/field-note.sh es identico a scripts/field-note.sh'
else
    fail 'dist/claude/scripts/field-note.sh diverge de scripts/field-note.sh'
fi
if jq -e '.assets[] | select(.destination == "scripts/field-note.sh" and .mode == "0755")' "$REPO_ROOT/dist/claude/.mefisto-generated-assets.json" >/dev/null 2>&1; then
    pass 'claude/.mefisto-generated-assets.json lista scripts/field-note.sh en 0755'
else
    fail 'claude/.mefisto-generated-assets.json no lista scripts/field-note.sh en 0755'
fi

echo '[fuente] confirmacion antes de estado:listo (#2111)'
absent "$body" '--label "estado:listo"' 'ningun gh issue create usa --label "estado:listo"'
absent "$body" 'puede salir directamente como `estado:listo`' 'desglosar no ofrece salir directo como listo'
contains "$body" '**espera la respuesta**' 'refinar espera la respuesta antes del label listo'
contains "$body" 'sin cambiar el label' 'refinar guarda el cuerpo sin cambiar el label'
contains "$body" 'Una única confirmación pasa a listo' 'una unica confirmacion cubre refinado y creados'
contains "$body" 'sin volver a preguntar' 'excepcion de pedido explicito en el mismo turno'

echo '[fuente] regla de ## Dependencias sin negaciones (#2129)'
contains "$body" '### Regla de `## Dependencias`' 'la regla de Dependencias existe'
contains "$body" 'todos los templates (dominio, infraestructura, proyección, MCP)' 'la regla aplica a todos los templates'
contains "$body" '`- Depende de #N`' 'marcador Depende de'
contains "$body" '`- Bloqueado por #N`' 'marcador Bloqueado por'
contains "$body" '`- Bloquea #N`' 'marcador Bloquea'
contains "$body" '`- Relacionado: #N`' 'marcador Relacionado'
contains "$body" '`Ninguna - ...`' 'linea Ninguna'
contains "$body" 'Nunca declares una dependencia en negativo ("No depende de #N", "Ya no depende de #N")' 'prohibe la negacion'
contains "$body" 'borra la línea' 'la dependencia caducada se borra'
contains "$body" '`gh issue comment`' 'la explicacion va en comentario'
contains "$body" 'cumpliendo la "Regla de `## Dependencias`"' 'desglosar referencia la regla'
contains "$body" 'borra las dependencias negadas' 'refinar paso 8 borra negaciones'

echo '[precedente primero] seccion, regla primera vez, checklist y templates (#2443)'
SOURCE_TEXT="$(< "$SOURCE")"
CLAUDE_TEXT="$(< "$CLAUDE")"
for pv in SOURCE_TEXT CLAUDE_TEXT; do
    text="${!pv}"
    contains "$text" '## Precedente primero: investigar antes de recomendar' "$pv tiene la seccion Precedente primero"
    contains "$text" 'sería la primera vez que el proyecto hace algo de ese estilo' "$pv conserva la regla de primera vez"
    contains "$text" '- [ ] **Consistencia con precedentes**' "$pv checklist incluye Consistencia con precedentes"
    n="$(printf '%s\n' "$text" | grep -c '^Precedentes: ')"
    if [ "$n" -ge 3 ]; then pass "$pv tiene Precedentes: en los templates de dominio, proyeccion y MCP"; else fail "$pv sin Precedentes: en los tres templates ($n)"; fi
    contains "$text" '(Obligatoria cuando el issue sugiere una forma de implementacion; ver' "$pv template de dominio con Investigacion obligatoria"
done

echo '[mirror] agents/planner.md pasa a generado'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
contains "$(< "$MIRROR")" '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/agents/planner.md. No editar a mano. -->' 'mirror conserva marcador generado'
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
