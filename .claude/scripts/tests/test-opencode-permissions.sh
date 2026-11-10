#!/usr/bin/env bash
# test-opencode-permissions.sh -- Tests del bloque `permission` de OpenCode
# generado desde capacidades neutrales (issue #862, MEF-ADR-0049 decision 5).
#
# Cubre (CA-6, mas CA-1/CA-5 desde el mismo arnes):
#   [empty] Un agente con `capabilities: []` obtiene todo deny, incluidos
#       bash/read/edit (CA-1).
#   [vocabulario] Las 17 claves del vocabulario reciben valor explicito en los
#       5 agentes, en el orden que declara el mapping (CA-1): una clave
#       ausente equivale a un permiso abierto, porque OpenCode devuelve `ask`
#       por defecto y `--auto` auto-aprueba todo `ask`.
#   [read] Lectura de `.env` -> deny (CA-2) con la capacidad `read`.
#   [edit] Edicion de `src/Foo.cs` -> deny, de `commands/x.md` -> allow y de
#       `.mefisto/pipeline/summaries/stage-1-writer.md` -> allow (CA-2).
#   [edit-scope-temprano] `infra/main.tf` y `.github/CODEOWNERS` -> deny,
#       `src/internal/agents/x.md` -> allow: el "scope temprano" de OpenCode
#       (issue #863) es este mismo deny-por-defecto de `edit`, sin hook
#       portado -- ver "Protocolo de ejecucion y eventos" del README.
#   [bash] `rm -rf x` -> deny y `git status` -> allow (CA-3) con la capacidad
#       `shell`.
#   [question] `allow` solo en `mode: primary`, `deny` en `subagent` y `all`
#       (CA-4; issue #1034).
#   [mcp-abort] La capacidad `mcp` aborta con "capacidad mcp sin mapeo
#       OpenCode", sin escribir nada (CA-5).
#   [parity] Paridad `edit` vs `is_path_in_mefisto_scope` para cada patron que
#       el gate declara, salvo las excepciones documentadas centralmente en el
#       mapping (CA-5): defensa en profundidad, mismo veredicto que el gate
#       real sin mantener una lista de rutas duplicada.
#
# Los agentes de prueba se generan con el generador real
# (generate-internal-adapters.sh), no invocando las funciones del adaptador
# sueltas: ejercita la integracion completa (frontmatter.sh + adapter-opencode.sh
# + opencode-permissions.json), igual que test-generate-internal-adapters.sh.
# La evaluacion de "ultima coincidencia gana" usa
# src/internal/scripts/lib/opencode-permission-eval.jq (issue #862 notas
# tecnicas: ese evaluador reproduce solo la regla de orden, no el motor real
# de OpenCode -- una discrepancia del dogfooding #874 se corrige en el
# mapping, nunca aqui).
#
# Uso: .claude/scripts/tests/test-opencode-permissions.sh
# Exit code: 0 si todos los checks pasan, 1 si alguno falla.

set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
GENERATOR="$REPO_ROOT/src/internal/scripts/generate-internal-adapters.sh"
EVALUATOR="$REPO_ROOT/src/internal/scripts/lib/opencode-permission-eval.jq"
MAPPING="$REPO_ROOT/src/internal/contract/opencode-permissions.json"

source "$REPO_ROOT/.claude/scripts/_mefisto-common.sh" 2>/dev/null

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# assert_eq <esperado> <obtenido> <etiqueta>
assert_eq() {
    if [ "$1" = "$2" ]; then
        pass "$3"
    else
        fail "$3 -- esperado: '$1', obtenido: '$2'"
    fi
}

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
SRC_DIR="$WORKDIR/src"
OUT_DIR="$WORKDIR/out"
mkdir -p "$SRC_DIR"

# opencode_permission_line <id> -- imprime el JSON compacto del bloque
# `permission` ya generado para el agente <id>: opencode_render (issue #862)
# lo emite como una sola linea "permission: {...}" (jq -c), asi que basta con
# recortar el prefijo -- el resto del frontmatter es YAML de un solo campo por
# linea, no un objeto JSON completo, y no hace falta parsearlo entero.
opencode_permission_line() {
    local id="$1"
    sed -n 's/^permission: //p' "$OUT_DIR/.opencode/agents/$id.md"
}

# permission_of <id> <clave> -- imprime el valor (string o mapa JSON) de la
# clave <clave> del bloque `permission` generado para el agente <id>.
permission_of() {
    local id="$1" key="$2"
    opencode_permission_line "$id" | jq -c --arg k "$key" '.[$k]'
}

# eval_perm <id> <clave> <candidato> -- resuelve, con la regla de "ultima
# coincidencia gana", el valor efectivo de <clave> para <candidato> en el
# agente <id> ya generado.
eval_perm() {
    local id="$1" key="$2" input="$3"
    local perm
    perm="$(opencode_permission_line "$id")"
    jq -rn --argjson permission "$perm" --arg key "$key" --arg input "$input" -f "$EVALUATOR"
}

cat > "$SRC_DIR/mefisto-fx-perm-empty.md" <<'EOF'
---
{
  "kind": "agent",
  "effort": "standard",
  "id": "mefisto-fx-perm-empty",
  "description": "Agente sin capacidades, para CA-1 (issue #862).",
  "mode": "subagent",
  "capabilities": []
}
---

Cuerpo.
EOF

cat > "$SRC_DIR/mefisto-fx-perm-read.md" <<'EOF'
---
{
  "kind": "agent",
  "effort": "standard",
  "id": "mefisto-fx-perm-read",
  "description": "Agente solo-lectura, para CA-2 (issue #862).",
  "mode": "subagent",
  "capabilities": ["read"]
}
---

Cuerpo.
EOF

cat > "$SRC_DIR/mefisto-fx-perm-planner.md" <<'EOF'
---
{
  "kind": "agent",
  "effort": "standard",
  "id": "mefisto-fx-perm-planner",
  "description": "Agente estilo planner (read+shell, mode primary), para CA-3/CA-4 (issue #862).",
  "mode": "primary",
  "capabilities": ["read", "shell"]
}
---

Cuerpo.
EOF

cat > "$SRC_DIR/mefisto-fx-perm-writer.md" <<'EOF'
---
{
  "kind": "agent",
  "effort": "standard",
  "id": "mefisto-fx-perm-writer",
  "description": "Agente estilo writer/reviewer (read+edit+shell, mode all), para CA-2/CA-4 (issues #862/#1034).",
  "mode": "all",
  "capabilities": ["read", "edit", "shell"]
}
---

Cuerpo.
EOF

cat > "$SRC_DIR/mefisto-fx-perm-ask-primary.md" <<'EOF'
---
{
  "kind": "agent",
  "effort": "standard",
  "id": "mefisto-fx-perm-ask-primary",
  "description": "Agente read+ask en mode primary (issue #2142).",
  "mode": "primary",
  "capabilities": ["read", "ask"]
}
---

Cuerpo.
EOF

cat > "$SRC_DIR/mefisto-fx-perm-ask-all.md" <<'EOF'
---
{
  "kind": "agent",
  "effort": "standard",
  "id": "mefisto-fx-perm-ask-all",
  "description": "Agente read+ask en mode all (issue #2142).",
  "mode": "all",
  "capabilities": ["read", "ask"]
}
---

Cuerpo.
EOF

cat > "$SRC_DIR/mefisto-fx-perm-ask-subagent.md" <<'EOF'
---
{
  "kind": "agent",
  "effort": "standard",
  "id": "mefisto-fx-perm-ask-subagent",
  "description": "Agente read+ask en mode subagent (issue #2142).",
  "mode": "subagent",
  "capabilities": ["read", "ask"]
}
---

Cuerpo.
EOF

cat > "$SRC_DIR/mefisto-fx-perm-web.md" <<'EOF'
---
{
  "kind": "agent",
  "effort": "standard",
  "id": "mefisto-fx-perm-web",
  "description": "Agente read+shell+web, para completar la matriz de CA-6 (issue #862).",
  "mode": "subagent",
  "capabilities": ["read", "shell", "web"]
}
---

Cuerpo.
EOF

echo "[generate] los 5 agentes de prueba generan con exit 0"
OUT=$("$GENERATOR" --out "$OUT_DIR" \
    "$SRC_DIR/mefisto-fx-perm-empty.md" \
    "$SRC_DIR/mefisto-fx-perm-read.md" \
    "$SRC_DIR/mefisto-fx-perm-planner.md" \
    "$SRC_DIR/mefisto-fx-perm-writer.md" \
    "$SRC_DIR/mefisto-fx-perm-web.md" \
    "$SRC_DIR/mefisto-fx-perm-ask-primary.md" \
    "$SRC_DIR/mefisto-fx-perm-ask-all.md" \
    "$SRC_DIR/mefisto-fx-perm-ask-subagent.md" 2>&1)
RC=$?
if [ "$RC" -eq 0 ]; then
    pass "exit 0. Salida: $OUT"
else
    fail "exit $RC (esperaba 0). Salida: $OUT"
fi

echo ""
echo "[empty] CA-1: capabilities: [] -> bash/read/edit todo deny"
assert_eq "deny" "$(eval_perm mefisto-fx-perm-empty bash 'git status')" "bash deny pese a 'git status' (sin capacidad shell)"
assert_eq "deny" "$(eval_perm mefisto-fx-perm-empty read 'README.md')" "read deny pese a ruta inocua (sin capacidad read)"
assert_eq "deny" "$(eval_perm mefisto-fx-perm-empty edit 'commands/x.md')" "edit deny pese a ruta en scope (sin capacidad edit)"
assert_eq '"deny"' "$(permission_of mefisto-fx-perm-empty external_directory)" "external_directory deny"
assert_eq '"deny"' "$(permission_of mefisto-fx-perm-empty doom_loop)" "doom_loop deny"

echo ""
echo "[vocabulario] CA-1: las 17 claves con valor explicito en los 5 agentes"
# Sin este check, una clave que se cayera del mapping no fallaria ningun test
# y quedaria SIN regla: OpenCode devuelve `ask` por defecto para lo que no
# matchea, y `opencode run --auto` auto-aprueba todo `ask`. La clave ausente
# seria, en headless, un permiso abierto.
EXPECTED_KEYS='["external_directory","doom_loop","question","webfetch","websearch","skill","task","list","glob","grep","lsp","todowrite","bash","edit","write","patch","read"]'
for id in mefisto-fx-perm-empty mefisto-fx-perm-read mefisto-fx-perm-planner mefisto-fx-perm-writer mefisto-fx-perm-web; do
    assert_eq "$EXPECTED_KEYS" "$(opencode_permission_line "$id" | jq -c 'keys_unsorted')" "$id: las 17 claves del vocabulario, en el orden del mapping"
done

echo ""
echo "[read] CA-2: lectura de .env -> deny con la capacidad read"
assert_eq "deny" "$(eval_perm mefisto-fx-perm-read read '.env')" "lectura de .env deniega"
assert_eq "allow" "$(eval_perm mefisto-fx-perm-read read 'README.md')" "lectura de una ruta comun permite (catch-all)"
assert_eq "deny" "$(eval_perm mefisto-fx-perm-read read 'infra/dev/.env')" "lectura de un .env en subdirectorio deniega"
assert_eq "deny" "$(eval_perm mefisto-fx-perm-read read 'src/config/.aws/credentials')" "lectura bajo .aws/ deniega"

echo ""
echo "[edit] CA-2: src/Foo.cs deny, commands/x.md allow, metadata generada deny, resumen de stage allow"
assert_eq "deny" "$(eval_perm mefisto-fx-perm-writer edit 'src/Foo.cs')" "edicion de src/Foo.cs deniega (fuera de la allowlist interna)"
assert_eq "allow" "$(eval_perm mefisto-fx-perm-writer edit 'commands/x.md')" "edicion de commands/x.md permite"
assert_eq "allow" "$(eval_perm mefisto-fx-perm-writer edit '.mefisto/pipeline/summaries/stage-1-writer.md')" "edicion del resumen de stage (.mefisto/) permite"
assert_eq "allow" "$(eval_perm mefisto-fx-perm-writer edit '.claude/pipeline/summaries/stage-1-writer.md')" "edicion del resumen de stage (.claude/) permite"
assert_eq "allow" "$(eval_perm mefisto-fx-perm-writer edit '.mefisto/pipeline/sandbox/x/poc.sh')" "edicion bajo el sandbox del planner permite"
assert_eq "deny" "$(eval_perm mefisto-fx-perm-planner bash 'bash .mefisto/pipeline/sandbox/x/poc.sh')" "ejecutar un script del sandbox sigue denegado en shell"
assert_eq "allow" "$(eval_perm mefisto-fx-perm-writer edit 'src/runtime/lib/mefisto-models.sh')" "edicion de src/runtime/** permite"
assert_eq "allow" "$(eval_perm mefisto-fx-perm-writer edit 'src/published/contract/README.md')" "edicion de src/published/** permite"
assert_eq "deny" "$(eval_perm mefisto-fx-perm-writer edit 'mefisto-manifest.json')" "edicion manual de mefisto-manifest.json generado deniega"
assert_eq "deny" "$(eval_perm mefisto-fx-perm-writer edit 'sub/mefisto-manifest.json')" "edicion de mefisto-manifest.json anidado deniega"
assert_eq "deny" "$(eval_perm mefisto-fx-perm-writer edit 'mefisto-manifest.json.bak')" "edicion de un sufijo de mefisto-manifest.json deniega"
for key in edit write patch; do
    assert_eq "deny" "$(eval_perm mefisto-fx-perm-writer "$key" 'dist/claude/plugin.json')" "$key deniega dist/** (salida generada)"
done
assert_eq "deny" "$(eval_perm mefisto-fx-perm-writer edit 'tests/Foo.Tests.cs')" "edicion de tests/Foo.Tests.cs deniega"

EDIT_RULES="$(opencode_permission_line mefisto-fx-perm-writer | jq -c '.edit | to_entries | sort_by(.key)')"
for key in write patch; do
    assert_eq "$EDIT_RULES" "$(opencode_permission_line mefisto-fx-perm-writer | jq -c --arg key "$key" '.[$key] | to_entries | sort_by(.key)')" "$key y edit tienen el mismo conjunto exacto de reglas"
done

echo ""
echo "[edit-scope-temprano] CA-4 (issue #863): scope temprano de OpenCode sobre el mismo veredicto que el gate final"
# Mismo caso que documenta la seccion 'Protocolo de ejecucion y eventos' del
# README (issue #863): sin hook portado, el 'edit' deny-por-defecto de
# OpenCode ES el feedback temprano -- rechaza ANTES de escribir, mas fuerte
# que el aviso posterior de mefisto-scope-hook.sh (que solo aplica a Claude
# Code). infra/ y .github/ fuera de workflows/rulesets no existen en el scope de
# Mefisto: is_path_in_mefisto_scope los deniega igual que src/Foo.cs.
assert_eq "deny" "$(eval_perm mefisto-fx-perm-writer edit 'infra/main.tf')" "edicion de infra/main.tf deniega (Mefisto no tiene infra/)"
assert_eq "deny" "$(eval_perm mefisto-fx-perm-writer edit '.github/CODEOWNERS')" "edicion de .github/CODEOWNERS deniega (fuera de .github/workflows y .github/rulesets)"
assert_eq "allow" "$(eval_perm mefisto-fx-perm-writer edit '.github/workflows/x.yml')" "edicion de .github/workflows/x.yml permite (registrada, issue #1742)"
assert_eq "allow" "$(eval_perm mefisto-fx-perm-writer edit 'src/internal/agents/x.md')" "edicion de src/internal/agents/x.md permite (src/internal/ esta en la allowlist)"

echo ""
echo "[bash] CA-3: rm -rf x deny, git status allow, con la capacidad shell"
assert_eq "deny" "$(eval_perm mefisto-fx-perm-planner bash 'rm -rf x')" "'rm -rf x' deniega aunque shell este presente"
assert_eq "allow" "$(eval_perm mefisto-fx-perm-planner bash 'git status')" "'git status' permite"
assert_eq "deny" "$(eval_perm mefisto-fx-perm-planner bash 'git push --force origin main')" "'git push --force' deniega pese al allow general de 'git *'"
assert_eq "deny" "$(eval_perm mefisto-fx-perm-planner bash 'curl https://example.com')" "'curl' deniega (no listado)"
assert_eq "deny" "$(eval_perm mefisto-fx-perm-planner bash 'sudo rm -rf x')" "'sudo' deniega pese a los allow de scripts"
# El candidato que OpenCode 1.18.29 evalua para `bash` es el TEXTO COMPLETO de
# cada nodo `command` del arbol tree-sitter -- asignaciones de entorno del
# prefijo incluidas, y un candidato por comando de la tuberia. De ahi estos
# tres casos, que la lista original de patrones no cubria: la forma que emite
# {{mefisto:run}}, la invocacion directa de un script del repo, y un coreutil
# desnudo (como aparece en una tuberia).
assert_eq "allow" "$(eval_perm mefisto-fx-perm-planner bash 'MEFISTO_RUNTIME=opencode ./.claude/scripts/mefisto-tooling-pipeline.sh 862')" "la forma que emite {{mefisto:run}} permite"
assert_eq "allow" "$(eval_perm mefisto-fx-perm-planner bash './.claude/scripts/tests/test-generate-internal-adapters.sh')" "invocacion directa de un script interno permite"
assert_eq "allow" "$(eval_perm mefisto-fx-perm-planner bash 'sort')" "coreutil desnudo (en tuberia) permite"
# El anclaje al inicio del texto es lo que hace utiles los deny: ningun allow
# empieza con un comodin que absorba un prefijo de entorno arbitrario, asi que
# un `rm` disfrazado con el prefijo de {{mefisto:run}} no cae en el allow.
assert_eq "deny" "$(eval_perm mefisto-fx-perm-planner bash 'MEFISTO_RUNTIME=opencode rm -rf x')" "'rm' con prefijo de entorno no cae en el allow de scripts"
for root in src/runtime src/published; do
    for command in \
        "bash $root/scripts/validate.sh" \
        "sh $root/scripts/validate.sh" \
        "$root/scripts/validate.sh" \
        "./$root/scripts/validate.sh" \
        "MEFISTO_RUNTIME=opencode ./$root/scripts/validate.sh"; do
        assert_eq "allow" "$(eval_perm mefisto-fx-perm-planner bash "$command")" "shell permite $command"
    done
done
if jq -e '
    ["src/runtime", "src/published"] as $roots
    | [
        $roots[] as $root
        | "bash \($root)/scripts/*",
          "sh \($root)/scripts/*",
          "\($root)/scripts/*",
          "./\($root)/scripts/*",
          "MEFISTO_RUNTIME=opencode ./\($root)/scripts/*"
      ] as $expected
    | .capability_map.shell.rules as $rules
    | [
        $rules[]
        | select(.pattern | contains("src/runtime/scripts/") or contains("src/published/scripts/"))
        | select(.value == "allow")
        | .pattern
      ] as $actual
    | ([ $actual[] ] | sort) == ([ $expected[] ] | sort)
      and ($actual | all(startswith("*") | not))
      and (([ $rules | to_entries[] | select(.value.value == "deny") | .key ] | min) as $first_deny
           | [ $rules | to_entries[] | select(.value.pattern as $pattern | $expected | index($pattern)) | .key ]
           | length == ($expected | length) and all(. < $first_deny))
' "$MAPPING" >/dev/null; then
    pass "shell declara exactamente cinco formas por raiz neutral, antes de deny y sin prefijos comodin"
else
    fail "shell debe declarar exactamente cinco formas por raiz neutral, antes de deny y sin prefijos comodin"
fi

echo ""
echo "[question] CA-4: allow solo en mode primary"
assert_eq '"allow"' "$(permission_of mefisto-fx-perm-planner question)" "question allow en mode primary"
assert_eq '"deny"' "$(permission_of mefisto-fx-perm-read question)" "question deny en mode subagent"
assert_eq '"deny"' "$(permission_of mefisto-fx-perm-writer question)" "question deny en mode all"

echo ""
echo "[question-ask] #2142: ask sube question a allow en primary/all; subagent sigue deny"
assert_eq '"allow"' "$(permission_of mefisto-fx-perm-ask-primary question)" "question allow en primary con ask"
assert_eq '"allow"' "$(permission_of mefisto-fx-perm-ask-all question)" "question allow en all con ask"
assert_eq '"deny"' "$(permission_of mefisto-fx-perm-ask-subagent question)" "question deny en subagent con ask"

echo ""
echo "[web-skill-task] CA-4: sin la capacidad correspondiente, deny"
assert_eq '"allow"' "$(permission_of mefisto-fx-perm-web webfetch)" "webfetch allow con capacidad web"
assert_eq '"allow"' "$(permission_of mefisto-fx-perm-web websearch)" "websearch allow con capacidad web"
assert_eq '"deny"' "$(permission_of mefisto-fx-perm-planner webfetch)" "webfetch deny sin capacidad web"
assert_eq '"deny"' "$(permission_of mefisto-fx-perm-planner skill)" "skill deny sin capacidad skill"
assert_eq '"deny"' "$(permission_of mefisto-fx-perm-planner task)" "task deny sin capacidad task"
assert_eq '"allow"' "$(permission_of mefisto-fx-perm-planner todowrite)" "todowrite allow con capacidad read"
assert_eq '"allow"' "$(permission_of mefisto-fx-perm-planner lsp)" "lsp allow con capacidad read"
assert_eq '"deny"' "$(permission_of mefisto-fx-perm-empty todowrite)" "todowrite deny sin capacidad read"

echo ""
echo "[mcp-abort] CA-5: la capacidad mcp aborta sin escribir nada"
# El generador real nunca llega a probar el abort propio de OpenCode para
# `mcp`: claude_render (adapter-claude.sh) corre primero y ya aborta por esa
# misma capacidad (CA-2 del lado Claude, issue #854) antes de que
# opencode_render tenga oportunidad de correr. Por eso este caso se ejercita
# invocando la funcion del adaptador OpenCode directamente (source, sin
# generador), la unica forma de observar el mensaje "sin mapeo OpenCode" de
# CA-5 en aislamiento.
source "$REPO_ROOT/src/internal/scripts/lib/adapter-opencode.sh"
OUT=$(opencode_permission_json "fake/mefisto-fx-perm-mcp.md" '["read","mcp"]' "subagent" 2>&1)
RC=$?
if [ "$RC" -ne 0 ]; then
    pass "exit != 0 ($RC)"
else
    fail "exit 0 (deberia abortar)"
fi
if printf '%s' "$OUT" | grep -qF "fake/mefisto-fx-perm-mcp.md: capacidad mcp sin mapeo OpenCode"; then
    pass "mensaje exacto de CA-5"
else
    fail "el mensaje no es el de CA-5. Salida: $OUT"
fi

echo ""
echo "[parity] CA-5: paridad edit vs is_path_in_mefisto_scope declarada por el gate"
if declare -F is_path_in_mefisto_scope >/dev/null 2>&1; then
    # Extrae los patrones allow del `case` canonico y les construye una ruta
    # testigo. Asi un case nuevo del gate entra en la prueba sin editar esta
    # lista. Las excepciones se declaran solo en el mapping y deben seguir
    # perteneciendo al gate para no ocultar una deriva inversa.
    while IFS= read -r gate_pattern; do
        p="${gate_pattern//\*/__scope_probe__/archivo}"
        exception=0
        while IFS= read -r exception_pattern; do
            [[ "$p" == $exception_pattern ]] && exception=1
        done < <(jq -r '.edit_scope_exceptions[].pattern' "$MAPPING")
        if [ "$exception" -eq 0 ]; then
            assert_eq "allow" "$(eval_perm mefisto-fx-perm-writer edit "$p")" "paridad edit vs gate: $gate_pattern"
        fi
    done < <(awk '
        /is_path_in_mefisto_scope\(\)/ { inside=1; next }
        inside && /case "\$path" in/ { cases=1; next }
        cases && /\*\) return 1/ { exit }
        cases && /return 0/ {
            line=$0; sub(/^[[:space:]]*/, "", line); sub(/[[:space:]]*return 0.*/, "", line); sub(/\)[[:space:]]*$/, "", line)
            count=split(line, parts, "|")
            for (i=1; i<=count; i++) print parts[i]
        }
    ' "$REPO_ROOT/src/internal/scripts/lib/_mefisto-common.sh")
    while IFS=$'\t' read -r pattern reason; do
        p="${pattern//\*\*/__scope_probe__/archivo}"
        p="${p//\*/archivo}"
        if is_path_in_mefisto_scope "$p"; then
            pass "excepcion declarada sigue en el gate: $pattern ($reason)"
        else
            fail "excepcion declarada no pertenece al gate: $pattern ($reason)"
        fi
        for key in edit write patch; do
            assert_eq "deny" "$(eval_perm mefisto-fx-perm-writer "$key" "$p")" "excepcion $pattern deniega $key"
        done
    done < <(jq -r '.edit_scope_exceptions[] | [.pattern, .reason] | @tsv' "$MAPPING")
    if jq -e '[.edit_scope_exceptions[] | select((.pattern | length) == 0 or (.reason | length) == 0)] | length == 0' "$MAPPING" >/dev/null; then
        pass "todas las excepciones de edit tienen patron y motivo"
    else
        fail "cada excepcion de edit debe declarar patron y motivo"
    fi
else
    fail "is_path_in_mefisto_scope no disponible (no se pudo source-ar _mefisto-common.sh)"
fi

echo ""
echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
[ "$FAIL" -eq 0 ]
