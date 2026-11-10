#!/usr/bin/env bash
# Verifica el corte vertical de los agentes neutrales del pipeline de tooling.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
FIXTURES="$HERE/fixtures/tooling-agents"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }
frontmatter() { awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$1"; }
body() { awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$1"; }
sha256() {
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | cut -d ' ' -f 1
    else
        sha256sum "$1" | cut -d ' ' -f 1
    fi
}

# Deriva la clausura desde TOOLING_CLOSURE_ASSETS con el mismo patron de
# extraccion que test-tdd-pipeline-closure.sh: nunca una segunda autoridad
# manual sobre el tamano o el contenido de la clausura publicada.
CLOSURE_EXTRACTOR="$WORK/extract-tooling-closure.py"
cat > "$CLOSURE_EXTRACTOR" <<'PY'
import pathlib
import re
import sys

generator = pathlib.Path(sys.argv[1]).read_text()
array = re.search(r'^TOOLING_CLOSURE_ASSETS=\(\n(.*?)^\)', generator, re.M | re.S)
if not array:
    print('no se pudo leer TOOLING_CLOSURE_ASSETS del generador', file=sys.stderr)
    raise SystemExit(2)
for match in re.finditer(r"^\s*'([^'|]+)\|(0644|0755)'\s*$", array.group(1), re.M):
    print(f'{match.group(1)}|{match.group(2)}')
PY
CLOSURE_SOURCES=()
CLOSURE_MODES=()
while IFS='|' read -r closure_source closure_mode; do
    [ -n "$closure_source" ] || continue
    CLOSURE_SOURCES+=("$closure_source")
    CLOSURE_MODES+=("$closure_mode")
done < <(python3 "$CLOSURE_EXTRACTOR" "$GENERATOR")
CLOSURE_COUNT="${#CLOSURE_SOURCES[@]}"
closure_has() {
    local needle="$1" i
    for i in "${!CLOSURE_SOURCES[@]}"; do
        [ "${CLOSURE_SOURCES[$i]}" = "$needle" ] && return 0
    done
    return 1
}

echo '[fuentes] contrato neutral y responsabilidades'
for agent in tooling-writer tooling-reviewer; do
    source="$REPO_ROOT/src/published/agents/$agent.md"
    if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$source" >/dev/null; then pass "$agent valida"; else fail "$agent no valida"; fi
    metadata="$(frontmatter "$source")"
    expected_profile=balanced; [ "$agent" = tooling-reviewer ] && expected_profile=deep
    if printf '%s' "$metadata" | jq -e --arg id "$agent" --arg profile "$expected_profile" \
        '.kind == "agent" and .id == $id and .mode == "all" and .profile == $profile and .capabilities == ["read", "edit", "shell"] and (keys | sort) == ["capabilities", "description", "effort", "id", "kind", "mode", "profile"]' >/dev/null; then
        pass "$agent declara solo el contrato neutral esperado"
    else
        fail "$agent no declara el contrato neutral esperado"
    fi
    agent_body="$(body "$source")"
    contains "$agent_body" '{{mefisto:assert-consumer-repo}}' "$agent conserva el guard"
    contains "$agent_body" 'archivo de summary' "$agent declara el summary entregado"
    for token in '.claude/' '.opencode/' '.mefisto/' 'Claude' 'OpenCode' 'model:' 'tools:' 'permission:'; do
        absent "$agent_body" "$token" "$agent no fija token de runtime o ruta de estado: $token"
    done
done
writer="$(< "$REPO_ROOT/src/published/agents/tooling-writer.md")"
reviewer="$(< "$REPO_ROOT/src/published/agents/tooling-reviewer.md")"
contains "$writer" 'scope exacto recibido' 'writer respeta el scope recibido'
contains "$writer" 'patrones existentes' 'writer lee patrones antes de editar'
contains "$writer" 'comandos de verificacion permitidos' 'writer limita sus verificaciones'
contains "$writer" 'no hagas preguntas' 'writer opera sin interaccion'
contains "$writer" 'logica de dominio, artefactos de Mefisto o rutas fuera del scope' 'writer bloquea trabajo ajeno al tooling permitido'
contains "$writer" '## Implementado' 'writer declara Implementado'
contains "$writer" '## Verificacion' 'writer declara Verificacion'
contains "$writer" '## Pendiente/bloqueos' 'writer declara Pendiente/bloqueos'
contains "$reviewer" 'Audita el diff contra el issue y las directivas efectivas' 'reviewer audita issue y directivas'
contains "$reviewer" 'Corrige directamente' 'reviewer corrige directamente'
contains "$reviewer" 'fuera de scope sin ampliar la tarea' 'reviewer contiene cambios fuera de scope'
contains "$reviewer" 'Verifica las correcciones' 'reviewer verifica sus correcciones'
contains "$reviewer" '## Resultado' 'reviewer declara Resultado'
contains "$reviewer" '## Correcciones' 'reviewer declara Correcciones'
contains "$reviewer" '## Verificacion' 'reviewer declara Verificacion'
for role in "$writer" "$reviewer"; do
    contains "$role" 'Nunca hagas push ni abras un pull request' 'el agente no publica rama ni PR'
done

echo '[salidas] snapshots y capacidades derivadas'
for runtime in claude opencode; do
    for agent in tooling-writer tooling-reviewer; do
        actual="$REPO_ROOT/dist/$runtime/agents/$agent.md"
        expected="$FIXTURES/expected-$runtime-$agent.md"
        if cmp -s "$expected" "$actual"; then pass "$runtime/$agent coincide con el snapshot"; else fail "$runtime/$agent difiere del snapshot"; fi
        rendered="$(< "$actual")"
        contains "$rendered" 'Antes de continuar, aborta si existe' "$runtime/$agent traduce el guard"
        absent "$rendered" '{{mefisto:' "$runtime/$agent no conserva directivas"
        case "$rendered" in *[Mm][Cc][Pp]*) fail "$runtime/$agent omite MCP" ;; *) pass "$runtime/$agent omite MCP" ;; esac
        if [ "$runtime" = claude ]; then
            case "$rendered" in *[Ss]kill*) fail "$runtime/$agent omite Skills" ;; *) pass "$runtime/$agent omite Skills" ;; esac
        else
            contains "$rendered" '"skill":"deny"' "$runtime/$agent omite Skills habilitados"
        fi
    done
done
claude_writer="$(< "$REPO_ROOT/dist/claude/agents/tooling-writer.md")"
claude_reviewer="$(< "$REPO_ROOT/dist/claude/agents/tooling-reviewer.md")"
contains "$claude_writer" 'name: "tooling-writer"' 'Claude expone el id del writer'
contains "$claude_reviewer" 'name: "tooling-reviewer"' 'Claude expone el id del reviewer'
contains "$claude_writer" 'tools: "Read, Glob, Grep, Edit, Write, Bash"' 'Claude writer deriva solo read/edit/shell'
contains "$claude_reviewer" 'tools: "Read, Glob, Grep, Edit, Write, Bash"' 'Claude reviewer deriva solo read/edit/shell'
contains "$claude_writer" 'model: "sonnet"' 'Claude materializa perfil balanced'
contains "$claude_reviewer" 'model: "opus"' 'Claude materializa perfil deep'

echo '[marketplace] raiz Claude instalada y mirrors generados'
if jq -e '(.plugins | length) == 1 and .plugins[0].name == "mefisto" and .plugins[0].source == "./"' "$REPO_ROOT/.claude-plugin/marketplace.json" >/dev/null; then
    pass 'el marketplace instala la raiz Claude actual'
else
    fail 'el marketplace no instala la raiz Claude actual'
fi
for agent in tooling-writer tooling-reviewer; do
    mirror="$REPO_ROOT/agents/$agent.md"
    rendered="$REPO_ROOT/dist/claude/agents/$agent.md"
    if [ -f "$mirror" ]; then pass "la raiz instalada descubre $agent"; else fail "falta $agent en la raiz instalada"; fi
    if cmp -s "$mirror" "$rendered"; then pass "mirror raiz de $agent coincide byte a byte"; else fail "mirror raiz de $agent diverge de Claude"; fi
    contains "$(< "$mirror")" '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/agents/'"$agent"'.md. No editar a mano. -->' "mirror raiz de $agent conserva marcador generado"
    contains "$(< "$mirror")" 'tools: "Read, Glob, Grep, Edit, Write, Bash"' "mirror raiz de $agent expone solo tools Claude"
    if [ "$agent" = tooling-writer ]; then
        contains "$(< "$mirror")" 'model: "sonnet"' 'mirror raiz del writer conserva perfil balanced'
    else
        contains "$(< "$mirror")" 'model: "opus"' 'mirror raiz del reviewer materializa perfil deep'
    fi
    for forbidden in 'Skill' 'MCP' 'WebFetch' 'WebSearch' 'Task'; do
        absent "$(< "$mirror")" "$forbidden" "mirror raiz de $agent omite $forbidden"
    done
done
opencode_writer="$(< "$REPO_ROOT/dist/opencode/agents/tooling-writer.md")"
opencode_reviewer="$(< "$REPO_ROOT/dist/opencode/agents/tooling-reviewer.md")"
for rendered in "$opencode_writer" "$opencode_reviewer"; do
    contains "$rendered" 'mode: "all"' 'OpenCode conserva mode all'
    contains "$rendered" '"read":{"*":"allow"' 'OpenCode permite lectura'
    contains "$rendered" '"edit":{"*":"allow"' 'OpenCode permite edicion'
    contains "$rendered" '"bash":{"*":"deny"' 'OpenCode mantiene shell deny por defecto'
    contains "$rendered" '"webfetch":"deny"' 'OpenCode deniega web'
    contains "$rendered" '"skill":"deny"' 'OpenCode deniega Skills'
    contains "$rendered" '"task":"deny"' 'OpenCode deniega delegacion'
    absent "$rendered" 'model:' 'OpenCode hereda modelo'
done

echo '[clausura] TOOLING_CLOSURE_ASSETS declara los scripts que arrancan TDD publicado'
[ "$CLOSURE_COUNT" -gt 0 ] && pass "se derivaron $CLOSURE_COUNT assets de clausura" || fail 'no se pudo derivar TOOLING_CLOSURE_ASSETS'
for required in scripts/tdd-pipeline.sh src/runtime/lib/mefisto-process.sh; do
    if closure_has "$required"; then pass "la clausura declara $required"; else fail "la clausura no declara $required"; fi
done

echo '[integracion] generacion de las cuatro salidas y check limpio'
if "$GENERATOR" --out "$WORK" \
    "$REPO_ROOT/src/published/agents/tooling-writer.md" \
    "$REPO_ROOT/src/published/agents/tooling-reviewer.md" >/dev/null; then
    pass 'el generador procesa ambos agentes en conjunto'
else
    fail 'el generador no proceso ambos agentes en conjunto'
fi
# El inventario de cada distribucion es la unica autoridad sobre lo generado:
# en disco deben estar exactamente sus destinos, mas el propio inventario y
# los dos agentes renderizados que esta suite somete a prueba. No queda ningun
# conteo base manual: todo sale de la clausura derivada y de los inventarios.
closure_expected="$(for i in "${!CLOSURE_SOURCES[@]}"; do printf '%s|%s\n' "${CLOSURE_SOURCES[$i]}" "${CLOSURE_MODES[$i]}"; done | sort)"
skill_expected="$(cd "$REPO_ROOT/skills" && find . -type f | sed 's|^\./||' | sed 's|^\(.*\)$|skills/\1 skills/mefisto-\1|' | sort)"
for runtime in claude opencode; do
    inventory="$WORK/dist/$runtime/.mefisto-generated-assets.json"
    expected_files="$({ jq -r '.assets[].destination' "$inventory"; printf '%s\n' '.mefisto-generated-assets.json'; } | sort)"
    actual_files="$(cd "$WORK/dist/$runtime" && find . -type f | sed 's|^\./||' | sort)"
    if [ "$expected_files" = "$actual_files" ]; then
        pass "$runtime genera exactamente sus assets inventariados, su inventario y los dos agentes bajo prueba"
    else
        fail "$runtime difiere entre disco e inventario: $(diff <(printf '%s\n' "$expected_files") <(printf '%s\n' "$actual_files") | tr '\n' ' ')"
    fi
    if jq -e '.schemaVersion == 1' "$inventory" >/dev/null; then pass "$runtime inventaria con schemaVersion 1"; else fail "$runtime no inventaria con schemaVersion 1"; fi
    closure_actual="$(jq -r '.assets[] | select(.adapter == "tooling-closure") | "\(.source)|\(.mode)"' "$inventory" | sort)"
    if [ "$closure_actual" = "$closure_expected" ]; then
        pass "$runtime inventaria la clausura completa derivada de TOOLING_CLOSURE_ASSETS ($CLOSURE_COUNT assets)"
    else
        fail "$runtime no inventaria la clausura derivada de TOOLING_CLOSURE_ASSETS"
    fi
    for i in "${!CLOSURE_SOURCES[@]}"; do
        closure_source="${CLOSURE_SOURCES[$i]}"
        closure_mode="${CLOSURE_MODES[$i]}"
        actual_file="$WORK/dist/$runtime/$closure_source"
        if [ -f "$actual_file" ]; then expected_sha="$(sha256 "$actual_file")"; else expected_sha=''; fi
        if jq -e --arg source "$closure_source" --arg mode "$closure_mode" --arg sha "$expected_sha" \
            'any(.assets[]; .adapter == "tooling-closure" and .source == $source and .destination == $source and .mode == $mode and .sha256 == $sha)' \
            "$inventory" >/dev/null; then
            pass "$runtime inventaria $closure_source con source/destination/mode/sha256"
        else
            fail "$runtime no inventaria $closure_source con source/destination/mode/sha256"
        fi
    done
done
# Lo no-clausura de cada distribucion se afirma como conjunto semantico: el
# manifiesto en Claude, y observabilidad + MCP + todo el arbol de Skills en
# OpenCode, derivado de skills/ en vez de muestrear dos archivos sueltos.
claude_extra="$(jq -r '.assets[] | select(.adapter != "tooling-closure" and .adapter != "tooling-knowledge" and (.source | startswith("src/published/agents/") | not)) | "\(.id) \(.destination)"' "$WORK/dist/claude/.mefisto-generated-assets.json" | sort)"
opencode_extra="$(jq -r '.assets[] | select(.adapter != "tooling-closure" and .adapter != "tooling-knowledge" and (.source | startswith("src/published/agents/") | not)) | "\(.id) \(.destination)"' "$WORK/dist/opencode/.mefisto-generated-assets.json" | sort)"
opencode_extra_expected="$(printf '%s\n%s\n%s\n' 'interactive-observability plugins/mefisto-observability.js' 'mcp-config plugins/mefisto-mcp.js' "$skill_expected" | sort)"
[ "$claude_extra" = 'mefisto-manifest mefisto-manifest.json' ] && pass 'Claude inventaria el manifiesto fuera de las clausuras compartidas' || fail "Claude inventaria assets inesperados fuera de las clausuras: $claude_extra"
[ "$opencode_extra" = "$opencode_extra_expected" ] && pass 'OpenCode inventaria observabilidad, MCP y todos los archivos de Skills' || fail 'OpenCode no inventaria observabilidad, MCP y todos los archivos de Skills'
[ ! -e "$WORK/dist/claude/skills" ] && pass 'Claude no recibe Skills adaptados ni internos' || fail 'Claude recibio un arbol de Skills adaptado'
for runtime in claude opencode; do
    for agent in tooling-writer tooling-reviewer; do
        if cmp -s "$FIXTURES/expected-$runtime-$agent.md" "$WORK/dist/$runtime/agents/$agent.md"; then
            pass "integracion $runtime/$agent coincide con el snapshot"
        else
            fail "integracion $runtime/$agent difiere del snapshot"
        fi
    done
done
for agent in tooling-writer tooling-reviewer; do
    if cmp -s "$WORK/agents/$agent.md" "$WORK/dist/claude/agents/$agent.md"; then
        pass "integracion publica el mirror raiz de $agent"
    else
        fail "integracion no publica el mirror raiz de $agent"
    fi
done
if "$GENERATOR" --check --out "$WORK" \
    "$REPO_ROOT/src/published/agents/tooling-writer.md" \
    "$REPO_ROOT/src/published/agents/tooling-reviewer.md" >/dev/null; then
    pass 'check aislado no detecta divergencias, huerfanos ni copias manuales'
else
    fail 'check aislado detecto divergencias, huerfanos o copias manuales'
fi

echo '[integridad] ausencia y divergencia de cada artefacto Claude'
for artifact in \
    agents/tooling-writer.md \
    agents/tooling-reviewer.md \
    dist/claude/agents/tooling-writer.md \
    dist/claude/agents/tooling-reviewer.md; do
    backup="$WORK/backup-$(printf '%s' "$artifact" | tr '/' '-')"
    cp "$WORK/$artifact" "$backup"
    rm "$WORK/$artifact"
    diagnostic="$($GENERATOR --check --out "$WORK" \
        "$REPO_ROOT/src/published/agents/tooling-writer.md" \
        "$REPO_ROOT/src/published/agents/tooling-reviewer.md" 2>&1)"
    case "$diagnostic" in
        *"$artifact: faltante"*) pass "$artifact ausente falla con diagnostico accionable" ;;
        *) fail "$artifact ausente no produce diagnostico accionable" ;;
    esac
    cp "$backup" "$WORK/$artifact"
    printf '\ndivergencia\n' >> "$WORK/$artifact"
    diagnostic="$($GENERATOR --check --out "$WORK" \
        "$REPO_ROOT/src/published/agents/tooling-writer.md" \
        "$REPO_ROOT/src/published/agents/tooling-reviewer.md" 2>&1)"
    case "$diagnostic" in
        *"$artifact: distinta"*) pass "$artifact divergente falla con diagnostico accionable" ;;
        *) fail "$artifact divergente no produce diagnostico accionable" ;;
    esac
    cp "$backup" "$WORK/$artifact"
done
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
