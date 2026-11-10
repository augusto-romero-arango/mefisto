#!/usr/bin/env bash
# Suite aislada del motor publicado: usa una copia temporal del script, un
# validador fixture y dos adaptadores fixture; nunca toca dist/ real.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
SOURCE_GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
FIXTURES="$HERE/fixtures/adapters"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
assert_rc() { [ "$1" -eq "$2" ] && pass "$3" || fail "$3 (exit $1)"; }
file_mode() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"; }

# Extrae la declaracion canonica en vez de reconstruir su contenido en este
# fixture. Asi una ampliacion de la clausura prueba automaticamente la fuente
# nueva con el modo que declaro el generador.
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
done < <(python3 "$CLOSURE_EXTRACTOR" "$SOURCE_GENERATOR")
CLOSURE_COUNT="${#CLOSURE_SOURCES[@]}"
CLOSURE_FAILURE_SOURCE="${CLOSURE_SOURCES[0]}"
FIXTURE_KNOWLEDGE_COUNT=3
FIXTURE_RENDERED_MARKDOWN_COUNT=1

setup_repo() {
    local name="$1"
    TEST_REPO="$WORK/$name"
    mkdir -p "$TEST_REPO/src/published/scripts/adapters" "$TEST_REPO/src/published/agents"
    cp "$SOURCE_GENERATOR" "$TEST_REPO/src/published/scripts/generate-published-adapters.sh"
    cp "$FIXTURES"/adapter-alpha.sh "$FIXTURES"/adapter-beta.sh "$TEST_REPO/src/published/scripts/adapters/"
    chmod +x "$TEST_REPO/src/published/scripts/"*.sh "$TEST_REPO/src/published/scripts/adapters/"*.sh
    cat > "$TEST_REPO/src/published/scripts/validate-published-artifacts.sh" <<'EOF'
#!/usr/bin/env bash
set -u
if [ -n "${VALIDATOR_LOG:-}" ]; then printf 'validate\n' >> "$VALIDATOR_LOG"; fi
for file in "$@"; do case "$file" in *invalida*) echo "$file: invalida"; exit 1;; esac; done
exit 0
EOF
    chmod +x "$TEST_REPO/src/published/scripts/validate-published-artifacts.sh"
    cat > "$TEST_REPO/src/published/agents/valida con espacios.md" <<'EOF'
---
{}
---
fixture
EOF
    for i in "${!CLOSURE_SOURCES[@]}"; do
        source="${CLOSURE_SOURCES[$i]}"
        mode="${CLOSURE_MODES[$i]}"
        mkdir -p "$TEST_REPO/$(dirname "$source")"
        case "$mode" in
            0755) printf '#!/usr/bin/env bash\n' > "$TEST_REPO/$source" ;;
            0644) printf 'fixture\n' > "$TEST_REPO/$source" ;;
        esac
        chmod "$mode" "$TEST_REPO/$source"
    done
    mkdir -p "$TEST_REPO/docs/adr" "$TEST_REPO/docs/testing"
    printf 'ADR uno\n' > "$TEST_REPO/docs/adr/mef-adr-0011.md"
    printf 'ADR dos\n' > "$TEST_REPO/docs/adr/mef-adr-0053.md"
    printf 'indice excluido\n' > "$TEST_REPO/docs/adr/INDICE-TEMATICO.md"
    printf 'cheatsheet\n' > "$TEST_REPO/docs/testing/harness-cheatsheet.md"
    printf 'documento excluido\n' > "$TEST_REPO/docs/testing/otro.md"
}

add_assets_adapter() {
    cp "$FIXTURES/adapter-assets.sh" "$TEST_REPO/src/published/scripts/adapters/"
    chmod +x "$TEST_REPO/src/published/scripts/adapters/adapter-assets.sh"
    mkdir -p "$TEST_REPO/src/published/assets"
    printf 'configuracion fuente\n' > "$TEST_REPO/src/published/assets/config.txt"
    printf 'launcher fuente\n' > "$TEST_REPO/src/published/assets/launcher.txt"
}

echo '[pre] sintaxis y ejecutable'
if bash -n "$SOURCE_GENERATOR" && [ -x "$SOURCE_GENERATOR" ]; then pass 'generador valido'; else fail 'generador invalido'; fi

setup_repo valido
GEN="$TEST_REPO/src/published/scripts/generate-published-adapters.sh"
OUT="$WORK/salida con espacios"
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md"; rc=$?
assert_rc "$rc" 0 'dos adaptadores procesan fuente y paths con espacios'
[ -f "$OUT/dist/alpha/artefactos/valida con espacios.md" ] && [ -f "$OUT/dist/beta/artefactos/valida con espacios.md" ] && pass 'salidas de ambos adaptadores' || fail 'faltan salidas'
expected_inventory_count=$((CLOSURE_COUNT + FIXTURE_KNOWLEDGE_COUNT + FIXTURE_RENDERED_MARKDOWN_COUNT))
jq -e --argjson expected_inventory_count "$expected_inventory_count" '.assets | length == $expected_inventory_count and any(.[]; .adapter == "adapter-alpha.sh" and .source == "src/published/agents/valida con espacios.md" and .destination == "artefactos/valida con espacios.md" and .mode == "0644" and (.sha256 | length == 64)) and any(.[]; .adapter == "tooling-closure" and .source == "scripts/tdd-pipeline.sh" and .destination == "scripts/tdd-pipeline.sh" and .mode == "0755" and (.sha256 | length == 64)) and ([.[] | select(.adapter == "tooling-knowledge") | .source] == ["docs/adr/mef-adr-0011.md", "docs/adr/mef-adr-0053.md", "docs/testing/harness-cheatsheet.md"])' "$OUT/dist/alpha/.mefisto-generated-assets.json" >/dev/null && pass "inventario atribuye Markdown, pipeline y conocimiento TDD con checksum ($expected_inventory_count assets derivados)" || fail 'inventario de la distribucion invalido'
if cmp -s "$TEST_REPO/docs/adr/mef-adr-0011.md" "$OUT/dist/alpha/docs/adr/mef-adr-0011.md" \
    && cmp -s "$TEST_REPO/docs/adr/mef-adr-0011.md" "$OUT/dist/beta/docs/adr/mef-adr-0011.md" \
    && cmp -s "$TEST_REPO/docs/testing/harness-cheatsheet.md" "$OUT/dist/alpha/docs/testing/harness-cheatsheet.md" \
    && cmp -s "$TEST_REPO/docs/testing/harness-cheatsheet.md" "$OUT/dist/beta/docs/testing/harness-cheatsheet.md" \
    && [ "$(file_mode "$OUT/dist/alpha/docs/adr/mef-adr-0011.md")" = 644 ] \
    && [ "$(file_mode "$OUT/dist/beta/docs/testing/harness-cheatsheet.md")" = 644 ] \
    && [ ! -e "$OUT/dist/alpha/docs/adr/INDICE-TEMATICO.md" ] \
    && [ ! -e "$OUT/dist/alpha/docs/testing/otro.md" ]; then
    pass 'conocimiento TDD conserva bytes y modo en ambos runtimes, excluyendo el resto de docs'
else
    fail 'proyeccion de conocimiento TDD invalida'
fi
if [ "$(sed -n '4p' "$OUT/dist/beta/artefactos/valida con espacios.md")" = '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/agents/valida con espacios.md. No editar a mano. -->' ]; then
    pass 'el marcador puede ir despues del frontmatter'
else
    fail 'el adaptador no pudo ubicar el marcador despues del frontmatter'
fi

CHECK_OUT="$WORK/check no crea salida"
"$GEN" --check --out "$CHECK_OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" >/dev/null; assert_rc "$?" 1 '--check informa salidas faltantes'
[ ! -e "$CHECK_OUT" ] && pass '--check no crea la raiz de salida' || fail '--check creo la raiz de salida'
"$GEN" --desconocida >/dev/null 2>&1; assert_rc "$?" 1 'argumento desconocido falla con exit 1'
check_out="$("$GEN" --check --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md")"; rc=$?
[ "$rc" -eq 0 ] && pass '--check al dia' || fail "--check al dia (exit $rc: $check_out)"
printf 'cambio\n' >> "$OUT/dist/alpha/artefactos/valida con espacios.md"
check_out="$("$GEN" --check --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md")"; rc=$?
assert_rc "$rc" 1 '--check distinta'; case "$check_out" in *'dist/alpha/artefactos/valida con espacios.md: distinta'*) pass 'diagnostico distinta';; *) fail 'sin diagnostico distinta';; esac
rm "$OUT/dist/beta/artefactos/valida con espacios.md"
check_out="$("$GEN" --check --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md")"; rc=$?
assert_rc "$rc" 1 '--check faltante'; case "$check_out" in *'dist/beta/artefactos/valida con espacios.md: faltante'*) pass 'diagnostico faltante';; *) fail 'sin diagnostico faltante';; esac
mkdir -p "$OUT/dist/alpha/artefactos"; printf '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde x. No editar a mano. -->\n' > "$OUT/dist/alpha/artefactos/huerfana.md"
printf 'manual\n' > "$OUT/dist/beta/artefactos/manual.md"
check_out="$("$GEN" --check --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md")"; rc=$?
case "$check_out" in *'huerfana.md: huerfana'*) pass 'diagnostico huerfana';; *) fail 'sin diagnostico huerfana';; esac
case "$check_out" in *'manual.md: sin marcador'*) pass 'diagnostico sin marcador';; *) fail 'sin diagnostico sin marcador';; esac
assert_rc "$rc" 1 '--check combina divergencias con exit 1'
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" >/dev/null
check_out="$("$GEN" --check --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md")"; rc=$?
[ "$rc" -eq 0 ] && [ -z "$check_out" ] && pass 'escritura reconcilia distintas, faltantes, huerfanas y manuales' || fail 'escritura no converge al arbol esperado'
jq -e '.assets | any(.adapter == "adapter-alpha.sh" and .destination == "artefactos/valida con espacios.md")' "$OUT/dist/alpha/.mefisto-generated-assets.json" >/dev/null && jq -e '.assets | any(.adapter == "adapter-beta.sh" and .destination == "artefactos/valida con espacios.md")' "$OUT/dist/beta/.mefisto-generated-assets.json" >/dev/null && pass 'cada runtime atribuye su Markdown al adaptador correspondiente' || fail 'inventarios de Markdown divergen del adaptador'
closure_alpha="$(jq -c '[.assets[] | select(.adapter == "tooling-closure" or .adapter == "tooling-knowledge")]' "$OUT/dist/alpha/.mefisto-generated-assets.json")"
closure_beta="$(jq -c '[.assets[] | select(.adapter == "tooling-closure" or .adapter == "tooling-knowledge")]' "$OUT/dist/beta/.mefisto-generated-assets.json")"
[ "$closure_alpha" = "$closure_beta" ] && pass 'inventarios de clausura son identicos entre runtimes' || fail 'inventarios de clausura divergen entre runtimes'
printf 'ADR alterado\n' > "$OUT/dist/alpha/docs/adr/mef-adr-0011.md"
check_out="$("$GEN" --check --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md")"; rc=$?
assert_rc "$rc" 1 '--check detecta conocimiento divergente'; case "$check_out" in *'dist/alpha/docs/adr/mef-adr-0011.md: distinta'*) pass 'diagnostico conocimiento divergente';; *) fail 'sin diagnostico conocimiento divergente';; esac
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" >/dev/null
chmod 0755 "$OUT/dist/beta/docs/testing/harness-cheatsheet.md"
check_out="$("$GEN" --check --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md")"; rc=$?
assert_rc "$rc" 1 '--check detecta modo divergente del conocimiento'; case "$check_out" in *'dist/beta/docs/testing/harness-cheatsheet.md: modo divergente'*) pass 'diagnostico modo del conocimiento';; *) fail 'sin diagnostico modo del conocimiento';; esac
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" >/dev/null
rm "$OUT/dist/alpha/docs/adr/mef-adr-0053.md"
check_out="$("$GEN" --check --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md")"; rc=$?
assert_rc "$rc" 1 '--check detecta conocimiento faltante'; case "$check_out" in *'dist/alpha/docs/adr/mef-adr-0053.md: faltante'*) pass 'diagnostico conocimiento faltante';; *) fail 'sin diagnostico conocimiento faltante';; esac
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" >/dev/null
rm "$TEST_REPO/docs/adr/mef-adr-0053.md"
check_out="$("$GEN" --check --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md")"; rc=$?
assert_rc "$rc" 1 '--check detecta conocimiento huerfano'; case "$check_out" in *'dist/alpha/docs/adr/mef-adr-0053.md: huerfana'*'dist/beta/docs/adr/mef-adr-0053.md: huerfana'*) pass 'diagnostico conocimiento huerfano en ambos runtimes';; *) fail 'sin diagnostico conocimiento huerfano';; esac
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" >/dev/null
printf 'alterada\n' >> "$OUT/dist/alpha/scripts/_pipeline-common.sh"
check_out="$("$GEN" --check --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md")"; rc=$?
assert_rc "$rc" 1 '--check detecta contenido divergente en clausura'; case "$check_out" in *'dist/alpha/scripts/_pipeline-common.sh: distinta'*) pass 'diagnostico contenido de clausura';; *) fail 'sin diagnostico contenido de clausura';; esac
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" >/dev/null
chmod 0644 "$OUT/dist/alpha/scripts/_pipeline-common.sh"
check_out="$("$GEN" --check --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md")"; rc=$?
assert_rc "$rc" 1 '--check detecta modo divergente en clausura'; case "$check_out" in *'dist/alpha/scripts/_pipeline-common.sh: modo divergente'*) pass 'diagnostico modo de clausura';; *) fail 'sin diagnostico modo de clausura';; esac
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" >/dev/null
rm "$OUT/dist/alpha/scripts/_pipeline-common.sh"
ln -s "$TEST_REPO/scripts/_pipeline-common.sh" "$OUT/dist/alpha/scripts/_pipeline-common.sh"
check_out="$("$GEN" --check --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md")"; rc=$?
assert_rc "$rc" 1 '--check rechaza symlink en salida de clausura'; case "$check_out" in *'dist/alpha/scripts/_pipeline-common.sh: enlace simbolico'*) pass 'diagnostico symlink de clausura';; *) fail 'sin diagnostico symlink de clausura';; esac
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" >/dev/null
ln -s "$WORK/fuera-del-repo" "$OUT/dist/alpha/scripts/huerfano.sh"
check_out="$("$GEN" --check --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md")"; rc=$?
assert_rc "$rc" 1 '--check detecta symlink huerfano'; case "$check_out" in *'dist/alpha/scripts/huerfano.sh: enlace simbolico'*) pass 'diagnostico symlink huerfano';; *) fail 'sin diagnostico symlink huerfano';; esac
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" >/dev/null

setup_repo assets
GEN="$TEST_REPO/src/published/scripts/generate-published-adapters.sh"; OUT="$WORK/assets-out"
add_assets_adapter
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md"; rc=$?
assert_rc "$rc" 0 'assets suplementarios se generan junto con Markdown'
[ "$(cat "$OUT/dist/assets/runtime/config.json")" = 'renderizado:configuracion fuente' ] && pass 'asset se renderiza desde su fuente' || fail 'asset no se renderizo desde fuente'
[ "$(file_mode "$OUT/dist/assets/bin/launcher")" = 755 ] && pass 'asset ejecutable conserva modo 0755' || fail 'asset ejecutable no conserva modo'
inventory="$OUT/dist/assets/.mefisto-generated-assets.json"
expected_inventory_count=$((CLOSURE_COUNT + FIXTURE_KNOWLEDGE_COUNT + FIXTURE_RENDERED_MARKDOWN_COUNT + 2))
jq -e --argjson expected_inventory_count "$expected_inventory_count" '.schemaVersion == 1 and (.assets | length) == $expected_inventory_count and .assets[0].source == "src/published/assets/config.txt" and .assets[1].mode == "0755" and any(.assets[]; .source == "src/published/agents/valida con espacios.md" and .destination == "artefactos/valida con espacios.md") and (.assets[] | .sha256 | length == 64)' "$inventory" >/dev/null && pass "inventario determinista atribuye Markdown y assets ($expected_inventory_count assets derivados)" || fail 'inventario de distribucion invalido'
check_out="$("$GEN" --check --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md")"; rc=$?
[ "$rc" -eq 0 ] && pass '--check acepta assets e inventario al dia' || fail "--check acepta assets e inventario al dia (exit $rc: $check_out)"
printf 'alterado\n' > "$OUT/dist/assets/runtime/config.json"
check_out="$("$GEN" --check --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md")"; rc=$?
assert_rc "$rc" 1 '--check detecta asset distinto'; case "$check_out" in *'dist/assets/runtime/config.json: distinta'*) pass 'diagnostico asset distinto';; *) fail 'sin diagnostico asset distinto';; esac
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" >/dev/null
rm "$OUT/dist/assets/runtime/config.json"
check_out="$("$GEN" --check --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md")"; rc=$?
assert_rc "$rc" 1 '--check detecta asset faltante'; case "$check_out" in *'dist/assets/runtime/config.json: faltante'*) pass 'diagnostico asset faltante';; *) fail 'sin diagnostico asset faltante';; esac
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" >/dev/null
chmod 0644 "$OUT/dist/assets/bin/launcher"
check_out="$("$GEN" --check --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md")"; rc=$?
assert_rc "$rc" 1 '--check detecta modo divergente'; case "$check_out" in *'dist/assets/bin/launcher: modo divergente'*) pass 'diagnostico modo divergente';; *) fail 'sin diagnostico modo divergente';; esac
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" >/dev/null
printf '{"schemaVersion":0,"assets":[]}' > "$inventory"
check_out="$("$GEN" --check --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md")"; rc=$?
assert_rc "$rc" 1 '--check detecta inventario inconsistente'; case "$check_out" in *'dist/assets/.mefisto-generated-assets.json: inventario inconsistente'*) pass 'diagnostico inventario inconsistente';; *) fail 'sin diagnostico inventario inconsistente';; esac
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" >/dev/null
check_out="$(FIXTURE_ASSETS=uno "$GEN" --check --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md")"; rc=$?
assert_rc "$rc" 1 '--check detecta asset huerfano'; case "$check_out" in *'dist/assets/bin/launcher: huerfana'*) pass 'diagnostico asset huerfano';; *) fail 'sin diagnostico asset huerfano';; esac
first="$(shasum "$OUT/dist/assets/.mefisto-generated-assets.json" "$OUT/dist/assets/runtime/config.json" | shasum)"
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" >/dev/null
second="$(shasum "$OUT/dist/assets/.mefisto-generated-assets.json" "$OUT/dist/assets/runtime/config.json" | shasum)"
[ "$first" = "$second" ] && pass 'assets e inventario son deterministas' || fail 'assets o inventario no son deterministas'
before="$(shasum "$OUT/dist/assets/.mefisto-generated-assets.json" "$OUT/dist/assets/runtime/config.json" "$OUT/dist/assets/bin/launcher" | shasum)"
FIXTURE_ASSETS=render-fallar "$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" >/dev/null 2>&1; rc=$?
after="$(shasum "$OUT/dist/assets/.mefisto-generated-assets.json" "$OUT/dist/assets/runtime/config.json" "$OUT/dist/assets/bin/launcher" | shasum)"
[ "$rc" -eq 1 ] && [ "$before" = "$after" ] && pass 'fallo de render conserva intactas todas las raices previas' || fail 'fallo de render publico una salida parcial'

for scenario in colision colision-anidada duplicado mismo-destino destinos-anidados inventario inseguro id-inseguro destino-inseguro ausente symlink modo invalido fallar render-fallar; do
    setup_repo "asset-$scenario"; add_assets_adapter
    ln -s "$WORK/fuera-del-repo" "$TEST_REPO/src/published/assets/link"
    printf 'fuera\n' > "$WORK/fuera-del-repo"
    GEN="$TEST_REPO/src/published/scripts/generate-published-adapters.sh"; OUT="$WORK/asset-$scenario-out"
    diagnostic="$(FIXTURE_ASSETS="$scenario" "$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" 2>&1)"; rc=$?
    assert_rc "$rc" 1 "asset $scenario se rechaza antes de publicar"
    case "$scenario" in
        fallar|render-fallar) ;;
        *) case "$diagnostic" in *'adapter-assets.sh'*) pass "asset $scenario identifica su adaptador";; *) fail "asset $scenario no identifica su adaptador";; esac ;;
    esac
    [ ! -e "$OUT" ] && pass "asset $scenario no deja salida parcial" || fail "asset $scenario creo salida"
done

setup_repo invalida
GEN="$TEST_REPO/src/published/scripts/generate-published-adapters.sh"; OUT="$WORK/invalida-out"
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/invalida.md" >/dev/null 2>&1; assert_rc "$?" 1 'validador rechaza antes de crear salida'
[ ! -e "$OUT" ] && pass 'fuente invalida no crea salida' || fail 'fuente invalida creo salida'

setup_repo clausura-ausente
GEN="$TEST_REPO/src/published/scripts/generate-published-adapters.sh"; OUT="$WORK/clausura-ausente-out"
rm "$TEST_REPO/$CLOSURE_FAILURE_SOURCE"
diagnostic="$("$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" 2>&1)"; rc=$?
assert_rc "$rc" 1 'clausura rechaza una fuente ausente antes de publicar'
case "$diagnostic" in *"$CLOSURE_FAILURE_SOURCE"*) pass 'fuente ausente identifica la ruta exacta';; *) fail 'fuente ausente no identifica la ruta exacta';; esac
[ ! -e "$OUT" ] && pass 'fuente de clausura ausente no deja salida parcial' || fail 'fuente de clausura ausente creo salida'

setup_repo clausura-no-regular
GEN="$TEST_REPO/src/published/scripts/generate-published-adapters.sh"; OUT="$WORK/clausura-no-regular-out"
rm "$TEST_REPO/$CLOSURE_FAILURE_SOURCE"
mkdir "$TEST_REPO/$CLOSURE_FAILURE_SOURCE"
diagnostic="$("$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" 2>&1)"; rc=$?
assert_rc "$rc" 1 'clausura rechaza una fuente no regular antes de publicar'
case "$diagnostic" in *"$CLOSURE_FAILURE_SOURCE"*) pass 'fuente no regular identifica la ruta exacta';; *) fail 'fuente no regular no identifica la ruta exacta';; esac
[ ! -e "$OUT" ] && pass 'fuente de clausura no regular no deja salida parcial' || fail 'fuente de clausura no regular creo salida'

setup_repo conocimiento-ausente
GEN="$TEST_REPO/src/published/scripts/generate-published-adapters.sh"; OUT="$WORK/conocimiento-ausente-out"
rm "$TEST_REPO/docs/adr/"mef-adr-*.md
diagnostic="$("$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" 2>&1)"; rc=$?
assert_rc "$rc" 1 'clausura rechaza la desaparicion total de ADRs'
case "$diagnostic" in *'no descubrio ningun docs/adr/mef-adr-*.md'*) pass 'ausencia de ADRs produce diagnostico accionable';; *) fail 'ausencia de ADRs no produce diagnostico accionable';; esac
[ ! -e "$OUT" ] && pass 'ausencia de ADRs no deja salida parcial' || fail 'ausencia de ADRs creo salida'

setup_repo fallo
GEN="$TEST_REPO/src/published/scripts/generate-published-adapters.sh"; OUT="$WORK/fallo-out"
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" >/dev/null
before="$(shasum "$OUT"/dist/*/artefactos/* | shasum)"
cp "$TEST_REPO/src/published/agents/valida con espacios.md" "$TEST_REPO/src/published/agents/fallar.md"
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/fallar.md" >/dev/null 2>&1; assert_rc "$?" 1 'fallo del segundo adaptador aborta'
after="$(shasum "$OUT"/dist/*/artefactos/* | shasum)"
[ "$before" = "$after" ] && pass 'fallo conserva intacta la salida anterior' || fail 'fallo modifico parcialmente la salida'
rm "$TEST_REPO/src/published/scripts/adapters/"adapter-*.sh
"$GEN" --out "$WORK/sin-adaptadores" "$TEST_REPO/src/published/agents/valida con espacios.md" >/dev/null 2>&1; assert_rc "$?" 1 'cero adaptadores con fuente explicita falla'
rm "$TEST_REPO/src/published/agents/"*.md
"$GEN" --out "$WORK/sin-adaptadores-vacio" >/dev/null 2>&1; assert_rc "$?" 0 'cero adaptadores sin fuentes termina verde'

setup_repo determinismo
GEN="$TEST_REPO/src/published/scripts/generate-published-adapters.sh"; OUT="$WORK/determinismo"
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" && first="$(shasum "$OUT"/dist/*/artefactos/* | shasum)"
touch "$TEST_REPO/src/published/agents/valida con espacios.md"
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" && second="$(shasum "$OUT"/dist/*/artefactos/* | shasum)"
[ "$first" = "$second" ] && pass 'determinismo independiente de mtime' || fail 'salida no determinista'

setup_repo orden-default
GEN="$TEST_REPO/src/published/scripts/generate-published-adapters.sh"; OUT="$WORK/orden-default"
mkdir -p "$TEST_REPO/src/published/commands"
cp "$TEST_REPO/src/published/agents/valida con espacios.md" "$TEST_REPO/src/published/commands/zeta.md"
cp "$TEST_REPO/src/published/agents/valida con espacios.md" "$TEST_REPO/src/published/agents/alfa.md"
VALIDATOR_LOG="$WORK/validator.log" "$GEN" --out "$OUT"; rc=$?
assert_rc "$rc" 0 'modo default valida y genera todas las fuentes'
[ "$(wc -l < "$WORK/validator.log" | tr -d ' ')" -eq 1 ] && pass 'el validador se invoca una vez antes de generar' || fail 'invocacion inesperada del validador'
[ -f "$OUT/dist/alpha/artefactos/alfa.md" ] && [ -f "$OUT/dist/alpha/artefactos/zeta.md" ] && pass 'scan default cubre agents y commands' || fail 'scan default incompleto'

echo '[perf] adaptador con >= 150 assets no reintroduce la cuadratica con jq'
setup_repo muchos-assets
GEN="$TEST_REPO/src/published/scripts/generate-published-adapters.sh"; OUT="$WORK/muchos-assets-out"
cp "$FIXTURES/adapter-many-assets.sh" "$TEST_REPO/src/published/scripts/adapters/"
chmod +x "$TEST_REPO/src/published/scripts/adapters/adapter-many-assets.sh"
export MANY_ASSETS_COUNT=160
mkdir -p "$TEST_REPO/src/published/assets"
printf 'configuracion fuente\n' > "$TEST_REPO/src/published/assets/config.txt"
"$GEN" --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md" >/dev/null; rc=$?
assert_rc "$rc" 0 'fixture de 160 assets genera la salida inicial'
jq -e '(.assets | length) >= 160' "$OUT/dist/many/.mefisto-generated-assets.json" >/dev/null && pass 'inventario del fixture registra los 160 assets' || fail 'inventario del fixture no registra los 160 assets'
start="$(date +%s)"
check_out="$("$GEN" --check --out "$OUT" "$TEST_REPO/src/published/agents/valida con espacios.md")"; rc=$?
elapsed=$(( $(date +%s) - start ))
[ "$rc" -eq 0 ] && [ -z "$check_out" ] && pass 'fixture de 160 assets: --check al dia' || fail "fixture de 160 assets: --check al dia (exit $rc: $check_out)"
# Umbral generoso a proposito (issue #1499, CA-4): con la cuadratica previa esto
# tardaba minutos; con la deteccion de colisiones en arrays bash basta con
# quedar comodamente por debajo.
ASSETS_PERF_LIMIT="${MEFISTO_ASSETS_PERF_LIMIT:-20}"
[ "$elapsed" -lt "$ASSETS_PERF_LIMIT" ] && pass "fixture de 160 assets: --check completo en ${elapsed}s (< ${ASSETS_PERF_LIMIT}s)" || fail "fixture de 160 assets: --check tardo ${elapsed}s (>= ${ASSETS_PERF_LIMIT}s, limite configurable con MEFISTO_ASSETS_PERF_LIMIT)"

# ---------------------------------------------------------------------------
# ARBOL REAL (no fixtures): invariante de expresiones GitHub Actions (#2052).
# Cada fuente con `${{` debe conservar el mismo conteo en todos sus espejos.
# ---------------------------------------------------------------------------
# Uso: check_expression_mirrors ROOT. Define EXPR_EVALUATED y EXPR_FAILURES.
check_expression_mirrors() {
    local root="$1" src kind name n mirror_rel mirror_n
    EXPR_EVALUATED=0; EXPR_FAILURES=()
    for src in "$root"/src/published/agents/*.md "$root"/src/published/commands/*.md; do
        [ -f "$src" ] || continue
        kind="$(basename "$(dirname "$src")")"; name="$(basename "$src")"
        n="$(grep -cF '${{' "$src")"
        [ "$n" -gt 0 ] || continue
        EXPR_EVALUATED=$((EXPR_EVALUATED + 1))
        for mirror_rel in "$kind/$name" "dist/claude/$kind/$name"; do
            if [ ! -f "$root/$mirror_rel" ]; then
                EXPR_FAILURES+=("$name: espejo $mirror_rel ausente"); continue
            fi
            mirror_n="$(grep -cF '${{' "$root/$mirror_rel")"
            [ "$mirror_n" -eq "$n" ] || EXPR_FAILURES+=("$name: espejo $mirror_rel tiene $mirror_n expresiones, la fuente $n")
        done
    done
}

echo '[arbol real] expresiones GitHub Actions conservadas en todos los espejos'
check_expression_mirrors "$REPO_ROOT"
[ "$EXPR_EVALUATED" -gt 0 ] && pass "se evaluaron $EXPR_EVALUATED fuentes con expresiones GitHub Actions" || fail 'ninguna fuente con expresiones GitHub Actions evaluada (layout cambio?)'
if [ "${#EXPR_FAILURES[@]}" -eq 0 ]; then
    pass 'fuente y espejos conservan el mismo conteo de expresiones GitHub Actions'
else
    for f in "${EXPR_FAILURES[@]}"; do fail "$f"; done
fi

echo '[arbol real] caso negativo: un espejo con una expresion menos se detecta'
NEG="$WORK/expr-neg"
mkdir -p "$NEG/src/published/agents" "$NEG/agents" "$NEG/dist/claude/agents"
neg_src="$REPO_ROOT/src/published/agents/domain-scaffolder.md"
for d in src/published/agents agents dist/claude/agents; do cp "$neg_src" "$NEG/$d/domain-scaffolder.md"; done
check_expression_mirrors "$NEG"
[ "$EXPR_EVALUATED" -eq 1 ] && [ "${#EXPR_FAILURES[@]}" -eq 0 ] && pass 'copia temporal consistente no produce fallos' || fail 'copia temporal consistente produjo fallos'
neg_line="$(grep -nF '${{' "$neg_src" | head -1 | cut -d: -f1)"
sed "${neg_line}d" "$neg_src" > "$NEG/dist/claude/agents/domain-scaffolder.md"
check_expression_mirrors "$NEG"
if [ "${#EXPR_FAILURES[@]}" -eq 1 ] && [[ "${EXPR_FAILURES[0]}" == *domain-scaffolder.md*dist/claude/agents/domain-scaffolder.md* ]]; then
    pass 'espejo corrupto detectado con nombre de archivo y espejo'
else
    fail "espejo corrupto no detectado correctamente (${EXPR_FAILURES[*]:-sin fallos})"
fi

printf '\nResultado: %s PASS, %s FAIL\n' "$PASS" "$FAIL"
exit "$FAIL"
