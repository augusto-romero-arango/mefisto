#!/usr/bin/env bash
# test-onboard-diagnose.sh -- Tests de scripts/onboard-diagnose.sh (issues #443, #1225).
#
# Cubre, sin invocar gh/az/jq reales (CA-4):
#   S-1: row() -- los tres estados (OK/FALTA/cualquier otra cosa -> NO VERIFICADO)
#        incrementan el contador correcto y respetan el formato fijo de impresion.
#   S-2: _secret_present() -- la verificacion de secretos aisla la PRIMERA columna
#        de una linea estilo 'gh secret list' (NAME<TAB>UPDATED_AT) antes de
#        comparar, en vez de buscar el texto en cualquier parte de la linea. Cubre
#        el caso que motiva la extraccion (issue #443): un awk '{print $1}' sin
#        aislar en una funcion se hubiera repetido 4 veces sin test que probara
#        que de verdad ignora las demas columnas.
#   S-3: _check_consumer_directives() -- contrato canónico, puente y fallback legacy.
#   S-4: _mefisto_pipeline_ignored() -- exige el ignore especifico del estado y
#        rechaza ignorar tambien la configuracion sibling versionada.
#   S-5: diagnostico integrado -- config canónico efectivo, precedencia sobre el
#        legacy y fallback legacy, incluidos los opt-outs explícitos, la
#        redacción de identificadores Entra y la degradación conservadora ante
#        config inválido o ausente.
#
# El script se sourcea (no se ejecuta): scripts/onboard-diagnose.sh solo corre su
# main() cuando BASH_SOURCE[0] == $0, asi que sourcearlo aqui carga row()/
# _secret_present() sin disparar el diagnostico completo (que si invoca gh/az/jq).
#
# Uso: scripts/tests/test-onboard-diagnose.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail
export MEFISTO_RUNTIME=claude

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

source "$REPO_ROOT/scripts/onboard-diagnose.sh"

# row() incrementa N_OK/N_FALTA/N_NV (variables globales del script fuente).
# $(row ...) correria row() en un subshell -- sus incrementos se perderian al
# volver -- asi que se captura la salida redirigiendo a un archivo (misma
# invocacion, mismo shell) en vez de con command substitution.
ROW_OUT="$(mktemp)"
trap 'rm -f "$ROW_OUT"' EXIT

echo "[S-1] row(): estados, contadores y formato"

N_OK=0; N_FALTA=0; N_NV=0

row OK "config presente" > "$ROW_OUT"
OUT=$(cat "$ROW_OUT")
if [ "$N_OK" -eq 1 ] && [ "$N_FALTA" -eq 0 ] && [ "$N_NV" -eq 0 ]; then
    pass "row OK incrementa N_OK y solo N_OK"
else
    fail "row OK: contadores inesperados (N_OK=$N_OK N_FALTA=$N_FALTA N_NV=$N_NV)"
fi
if [ "$OUT" = "  [OK           ] config presente" ]; then
    pass "row OK imprime con el formato fijo '  [%-13s] %s'"
else
    fail "row OK: formato inesperado: '$OUT'"
fi

row FALTA "faltan labels: dom:x" > "$ROW_OUT"
OUT=$(cat "$ROW_OUT")
if [ "$N_OK" -eq 1 ] && [ "$N_FALTA" -eq 1 ] && [ "$N_NV" -eq 0 ]; then
    pass "row FALTA incrementa N_FALTA y solo N_FALTA"
else
    fail "row FALTA: contadores inesperados (N_OK=$N_OK N_FALTA=$N_FALTA N_NV=$N_NV)"
fi
if [ "$OUT" = "  [FALTA        ] faltan labels: dom:x" ]; then
    pass "row FALTA imprime con el formato fijo"
else
    fail "row FALTA: formato inesperado: '$OUT'"
fi

# Cualquier estado que no sea OK/FALTA cuenta como NO VERIFICADO -- incluido el
# literal "NV" que usa el resto del script, y cualquier otro texto (defensivo:
# row() nunca debe dejar un estado desconocido sin contar).
for estado_input in NV algo-no-reconocido; do
    N_OK=0; N_FALTA=0; N_NV=0
    row "$estado_input" "seccion sin verificar" > "$ROW_OUT"
    OUT=$(cat "$ROW_OUT")
    if [ "$N_NV" -eq 1 ] && [ "$N_OK" -eq 0 ] && [ "$N_FALTA" -eq 0 ]; then
        pass "row '$estado_input' incrementa N_NV y solo N_NV"
    else
        fail "row '$estado_input': contadores inesperados (N_OK=$N_OK N_FALTA=$N_FALTA N_NV=$N_NV)"
    fi
    if [ "$OUT" = "  [NO VERIFICADO] seccion sin verificar" ]; then
        pass "row '$estado_input' normaliza la etiqueta impresa a 'NO VERIFICADO'"
    else
        fail "row '$estado_input': etiqueta impresa inesperada: '$OUT'"
    fi
done

# row() acepta el item en varias palabras (shift + "$*"), no solo la primera --
# es la forma en que las secciones 1, 4, 5, etc. le pasan texto con espacios.
N_OK=0; N_FALTA=0; N_NV=0
row OK "el archivo existe y parsea con jq" > "$ROW_OUT"
OUT=$(cat "$ROW_OUT")
if [ "$OUT" = "  [OK           ] el archivo existe y parsea con jq" ]; then
    pass "row OK preserva un item multi-palabra completo"
else
    fail "row OK: item multi-palabra truncado o mal formado: '$OUT'"
fi

echo ""
echo "[S-2] _secret_present(): aisla la columna del nombre, no busca en toda la linea"

# Formato real de 'gh secret list': NAME<TAB>UPDATED_AT (a veces con mas columnas,
# p. ej. visibilidad en secrets de organizacion).
SECRETS_LIST=$(printf 'AZURE_CLIENT_ID\t2024-01-01T00:00:00Z\nAZURE_CLIENT_ID_OLD\t2023-01-01T00:00:00Z\nTF_VAR_POSTGRESQL_ADMIN_PASSWORD\tActions\t2024-06-01T00:00:00Z\n')

if _secret_present "$SECRETS_LIST" "AZURE_CLIENT_ID"; then
    pass "detecta un secreto presente por coincidencia exacta de columna 1"
else
    fail "no detecto 'AZURE_CLIENT_ID' estando presente"
fi

if _secret_present "$SECRETS_LIST" "AZURE_CLIENT_ID_OLD"; then
    pass "detecta el otro secreto (columna 1 completa, sin confundirlo con el primero)"
else
    fail "no detecto 'AZURE_CLIENT_ID_OLD' estando presente"
fi

# 'AZURE_CLIENT_ID' es un prefijo/substring de 'AZURE_CLIENT_ID_OLD'. Si la
# verificacion no aislara la columna 1 con match exacto (grep -Fqx), buscar
# 'AZURE_CLIENT_ID' podria dar un falso OK aunque solo exista la variante _OLD.
SECRETS_LIST_SOLO_OLD=$(printf 'AZURE_CLIENT_ID_OLD\t2023-01-01T00:00:00Z\n')
if _secret_present "$SECRETS_LIST_SOLO_OLD" "AZURE_CLIENT_ID"; then
    fail "falso positivo: 'AZURE_CLIENT_ID' coincidio por substring contra 'AZURE_CLIENT_ID_OLD'"
else
    pass "'AZURE_CLIENT_ID' NO coincide por substring contra 'AZURE_CLIENT_ID_OLD' (match exacto de columna)"
fi

# 'Actions' aparece en la SEGUNDA columna de la fila de TF_VAR_POSTGRESQL_ADMIN_PASSWORD
# (visibilidad del secreto). Si la verificacion buscara en la linea completa en vez de
# solo en la columna 1 (awk '{print $1}'), esto daria un falso OK.
if _secret_present "$SECRETS_LIST" "Actions"; then
    fail "falso positivo: 'Actions' (columna 2, visibilidad) se conto como nombre de secreto"
else
    pass "'Actions' (columna 2) no se confunde con un nombre de secreto -- solo se mira la columna 1"
fi

if _secret_present "$SECRETS_LIST" "NO_EXISTE"; then
    fail "falso positivo: 'NO_EXISTE' no deberia estar presente"
else
    pass "un secreto ausente por completo se reporta ausente"
fi

echo ""
echo "[S-3] _check_consumer_directives(): AGENTS.md canónico y puente CLAUDE.md"
DIRECTIVES_REPO=$(mktemp -d)
trap 'rm -f "$ROW_OUT"; rm -rf "$IGNORE_REPO" "$DIRECTIVES_REPO"' EXIT

write_complete_agents() {
    printf '%s\n' \
        '## Tokens del harness' \
        '**RootNamespace**: Ejemplo' \
        '**SolutionFile**: Ejemplo.sln' \
        '**ProjectDisplayName**: Ejemplo' \
        '**BoundedContext**: Ejemplo' \
        '**BoundedContextDomains**: ejemplo' \
        '## Verificación de fuentes (obligatorio para agentes)' > "$DIRECTIVES_REPO/AGENTS.md"
}

assert_directives() {
    local scenario="$1" expected_agents="$2" expected_claude="$3" needle="$4"
    _check_consumer_directives "$DIRECTIVES_REPO/AGENTS.md" "$DIRECTIVES_REPO/CLAUDE.md"
    if [ "$AGENTS_DIRECTIVES_STATE" = "$expected_agents" ] && [ "$CLAUDE_BRIDGE_STATE" = "$expected_claude" ]; then
        pass "$scenario: estados $expected_agents/$expected_claude"
    else
        fail "$scenario: estados $AGENTS_DIRECTIVES_STATE/$CLAUDE_BRIDGE_STATE (esperaba $expected_agents/$expected_claude)"
    fi
    if printf '%s\n%s\n' "$AGENTS_DIRECTIVES_DETAIL" "$CLAUDE_BRIDGE_DETAIL" | grep -Fq "$needle"; then
        pass "$scenario: detalle accionable contiene '$needle'"
    else
        fail "$scenario: falta detalle '$needle'"
    fi
}

assert_bridge_signals() {
    local scenario="$1" expected_import="$2" expected_legacy="$3"
    if [ "$CLAUDE_BRIDGE_HAS_IMPORT" -eq "$expected_import" ] && [ "$CLAUDE_BRIDGE_HAS_LEGACY" -eq "$expected_legacy" ]; then
        pass "$scenario: señales import/legacy $expected_import/$expected_legacy"
    else
        fail "$scenario: señales import/legacy $CLAUDE_BRIDGE_HAS_IMPORT/$CLAUDE_BRIDGE_HAS_LEGACY (esperaba $expected_import/$expected_legacy)"
    fi
}

# Greenfield completo: ambas ubicaciones son independientes y quedan listas.
write_complete_agents
printf '  @AGENTS.md  \n' > "$DIRECTIVES_REPO/CLAUDE.md"
BEFORE=$(cksum "$DIRECTIVES_REPO/AGENTS.md" "$DIRECTIVES_REPO/CLAUDE.md")
assert_directives "greenfield completo" OK OK "puente exacto"
assert_bridge_signals "greenfield completo" 1 0
AFTER=$(cksum "$DIRECTIVES_REPO/AGENTS.md" "$DIRECTIVES_REPO/CLAUDE.md")
if [ "$BEFORE" = "$AFTER" ]; then pass "la comprobación de directivas no escribe archivos"; else fail "la comprobación de directivas modificó un archivo"; fi

# AGENTS.md incompleto mantiene visible el puente correcto.
printf '## Tokens del harness\n**RootNamespace**: Ejemplo\n' > "$DIRECTIVES_REPO/AGENTS.md"
assert_directives "AGENTS.md incompleto" FALTA OK "BoundedContextDomains"

# Los tokens deben pertenecer a su sección contractual, no estar dispersos.
printf '%s\n' \
    '## Tokens del harness' \
    '## Otra sección' \
    '**RootNamespace**: Ejemplo' \
    '**SolutionFile**: Ejemplo.sln' \
    '**ProjectDisplayName**: Ejemplo' \
    '**BoundedContext**: Ejemplo' \
    '**BoundedContextDomains**: ejemplo' \
    '## Verificación de fuentes (obligatorio para agentes)' > "$DIRECTIVES_REPO/AGENTS.md"
assert_directives "tokens fuera de la sección contractual" FALTA OK "RootNamespace"

# Contenido específico de Claude permitido, pero una mención en prosa no es import.
write_complete_agents
printf '%s\n' 'Esta prosa menciona @AGENTS.md pero no lo importa.' > "$DIRECTIVES_REPO/CLAUDE.md"
assert_directives "CLAUDE.md con contenido propio sin import" OK FALTA "linea independiente"
assert_bridge_signals "CLAUDE.md con contenido propio sin import" 0 0

# Un archivo ausente tiene una acción distinta de un archivo legacy legible.
rm -f "$DIRECTIVES_REPO/CLAUDE.md"
assert_directives "CLAUDE.md ausente" OK FALTA "no existe"
assert_bridge_signals "CLAUDE.md ausente" 0 0

# El fallback legacy explica el estado sin ocultar las dos faltas canónicas.
rm -f "$DIRECTIVES_REPO/AGENTS.md"
printf '%s\n' '## Tokens del harness' '**RootNamespace**: Ejemplo' '## Verificación de fuentes' > "$DIRECTIVES_REPO/CLAUDE.md"
assert_directives "solo legacy" FALTA FALTA "legacy legible"
assert_bridge_signals "solo legacy" 0 1

# El import exacto no habilita duplicar las secciones de la fuente canónica.
write_complete_agents
printf '%s\n' '@AGENTS.md' '## Tokens del harness' '## Verificación de fuentes' > "$DIRECTIVES_REPO/CLAUDE.md"
assert_directives "puente con doctrina contractual duplicada" OK FALTA "duplicadas"
assert_bridge_signals "puente con doctrina contractual duplicada" 1 1

# Otras directivas específicas de Claude pueden coexistir con el import.
printf '%s\n' '# Directivas de Claude' 'Usa una capacidad exclusiva.' ' @AGENTS.md ' > "$DIRECTIVES_REPO/CLAUDE.md"
assert_directives "puente correcto con contenido específico de Claude" OK OK "sin secciones contractuales duplicadas"
assert_bridge_signals "puente correcto con contenido específico de Claude" 1 0

# Un archivo existente pero inaccesible no se confunde con uno ausente.
chmod 000 "$DIRECTIVES_REPO/AGENTS.md"
_check_consumer_directives "$DIRECTIVES_REPO/AGENTS.md" "$DIRECTIVES_REPO/CLAUDE.md"
if [ "$AGENTS_DIRECTIVES_STATE" = "NV" ]; then
    pass "AGENTS.md existente no legible reporta NO VERIFICADO"
else
    fail "AGENTS.md no legible reportó $AGENTS_DIRECTIVES_STATE en vez de NO VERIFICADO"
fi
chmod 644 "$DIRECTIVES_REPO/AGENTS.md"
chmod 000 "$DIRECTIVES_REPO/CLAUDE.md"
_check_consumer_directives "$DIRECTIVES_REPO/AGENTS.md" "$DIRECTIVES_REPO/CLAUDE.md"
if [ "$CLAUDE_BRIDGE_STATE" = "NV" ]; then
    pass "CLAUDE.md existente no legible reporta NO VERIFICADO"
else
    fail "CLAUDE.md no legible reportó $CLAUDE_BRIDGE_STATE en vez de NO VERIFICADO"
fi
chmod 644 "$DIRECTIVES_REPO/CLAUDE.md"

echo ""
echo "[S-4] _mefisto_pipeline_ignored(): diagnostico de solo lectura del ignore especifico"
IGNORE_REPO=$(mktemp -d)
trap 'rm -f "$ROW_OUT"; rm -rf "$IGNORE_REPO" "$DIRECTIVES_REPO"' EXIT
(cd "$IGNORE_REPO" && git init -q)
if _mefisto_pipeline_ignored "$IGNORE_REPO"; then
    fail "reporta ignorado sin patron en .gitignore"
else
    pass "reporta falta cuando .mefisto/pipeline/ no esta ignorado"
fi
printf '.mefisto/pipeline/\n' > "$IGNORE_REPO/.gitignore"
if _mefisto_pipeline_ignored "$IGNORE_REPO"; then
    pass "detecta exactamente .mefisto/pipeline/ via git check-ignore"
else
    fail "no detecto el patron .mefisto/pipeline/"
fi
if git -C "$IGNORE_REPO" check-ignore -q .mefisto/harness.config.json; then
    fail "el patron especifico ignora indebidamente harness.config.json"
else
    pass "no ignora .mefisto/harness.config.json"
fi

printf '.mefisto/\n' > "$IGNORE_REPO/.gitignore"
if _mefisto_pipeline_ignored "$IGNORE_REPO"; then
    fail "acepta indebidamente el ignore amplio .mefisto/"
else
    pass "rechaza .mefisto/ completo porque ocultaria harness.config.json"
fi
if [ "$(cat "$IGNORE_REPO/.gitignore")" = ".mefisto/" ]; then
    pass "el diagnostico no modifica .gitignore"
else
    fail "el diagnostico modifico .gitignore"
fi

echo ""
echo "[S-5] main(): config efectivo, precedencia y fallback legacy"
ONBOARD_REPO=$(mktemp -d)
ONBOARD_BIN=$(mktemp -d)
trap 'rm -f "$ROW_OUT"; rm -rf "$IGNORE_REPO" "$DIRECTIVES_REPO" "$ONBOARD_REPO" "$ONBOARD_BIN"' EXIT

cat > "$ONBOARD_BIN/gh" <<'GH'
#!/usr/bin/env bash
if [ "$1" = "label" ]; then
    printf '%s\n' tipo:feature tipo:infra tipo:refactor tipo:tooling tipo:projection estado:borrador estado:listo bug bloqueado dom:dominio1
    if [ -z "${GH_LABELS_SIN_WARNING:-}" ]; then echo warning; fi
elif [ "$1" = "api" ]; then
    case "${GH_API_MODE:-mefisto}" in
        mefisto) printf '{"name":"mefisto"}\n' ;;
        otro) printf '{"name":"otra-cosa"}\n' ;;
        404) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
        noauth) echo "gh: Bad credentials (HTTP 401)" >&2; exit 1 ;;
    esac
    if [ -n "${GH_API_LOG:-}" ]; then echo "$*" >> "$GH_API_LOG"; fi
elif [ "$1" = "secret" ]; then
    printf '%s\t%s\n' AZURE_CLIENT_ID ahora AZURE_TENANT_ID ahora AZURE_SUBSCRIPTION_ID ahora TF_VAR_POSTGRESQL_ADMIN_PASSWORD ahora
fi
GH
cat > "$ONBOARD_BIN/az" <<'AZ'
#!/usr/bin/env bash
if [ "$1" = "account" ]; then exit 0; fi
if [ "$*" = 'ad app list --display-name ci-diagnostico --query [0].appId -o tsv' ]; then
    case "${AZ_APP_MODE:-success}" in
        success) printf 'APP_ID_CENTINELA_NO_PUBLICAR\n' ;;
        absent) printf 'None\n' ;;
        error)
            printf 'ERROR_AZURE_CON_APP_ID_CENTINELA_NO_PUBLICAR\n' >&2
            exit 1
            ;;
    esac
fi
AZ
chmod +x "$ONBOARD_BIN/gh" "$ONBOARD_BIN/az"

prepare_onboard_repo() {
    local config_path="$1" projections="$2"
    mkdir -p "$(dirname "$config_path")"
    cat > "$config_path" <<JSON
{
  "projectName": "Diagnostico",
  "namespacePrefix": "Diagnostico.Dominio",
  "solutionFile": "Diagnostico.slnx",
  "githubServicePrincipalName": "ci-diagnostico",
  "domainLabels": ["dominio1"],
  "boundedContext": { "name": "Principal", "domains": ["dominio1"] },
  "secrets": [],
  "tenancy": { "strategy": "mono-tenant-transitorio" },
  "projections": { "enabled": $projections }
}
JSON
}

git init -q "$ONBOARD_REPO"
ONBOARD_REPO_REAL=$(cd "$ONBOARD_REPO" && pwd -P)
rm -rf "$ONBOARD_REPO/.mefisto" "$ONBOARD_REPO/.claude"
printf '.mefisto/pipeline/\n' > "$ONBOARD_REPO/.gitignore"
mkdir -p "$ONBOARD_REPO/src" "$ONBOARD_REPO/tests" "$ONBOARD_REPO/infra/environments"
write_complete_agents
cp "$DIRECTIVES_REPO/AGENTS.md" "$ONBOARD_REPO/AGENTS.md"
printf '@AGENTS.md\n' > "$ONBOARD_REPO/CLAUDE.md"

prepare_onboard_repo "$ONBOARD_REPO/.mefisto/harness.config.json" false
prepare_onboard_repo "$ONBOARD_REPO/.claude/harness.config.json" true
# Si se mezclara información, estos valores exclusivos del legacy aparecerían
# aunque la fila de ruta efectiva siguiera nombrando correctamente el canónico.
jq '.secrets = [{"name":"legacy-ignorado","source":{"type":"github-secret","value":"LEGACY_IGNORADO"}}]
    | .tenancy.strategy = "multi-tenant-header"' \
    "$ONBOARD_REPO/.claude/harness.config.json" > "$ONBOARD_REPO/.claude/harness.config.json.tmp"
mv "$ONBOARD_REPO/.claude/harness.config.json.tmp" "$ONBOARD_REPO/.claude/harness.config.json"
OUT=$(cd "$ONBOARD_REPO" && PATH="$ONBOARD_BIN:$PATH" bash "$REPO_ROOT/scripts/onboard-diagnose.sh" 2>&1)
if printf '%s\n' "$OUT" | grep -Fq "[OK           ] config efectivo $ONBOARD_REPO_REAL/.mefisto/harness.config.json existe" \
    && ! printf '%s\n' "$OUT" | grep -Fq "legacy-ignorado" \
    && ! printf '%s\n' "$OUT" | grep -Fq "multi-tenant-header"; then
    pass "el config canónico prevalece y no mezcla datos del legacy"
else
    fail "el diagnóstico no usó exclusivamente el config canónico efectivo"
fi
if printf '%s\n' "$OUT" | grep -Fqx '  [OK           ] aplicacion de Entra "ci-diagnostico" existe' \
    && ! printf '%s\n' "$OUT" | grep -Fq 'APP_ID_CENTINELA_NO_PUBLICAR'; then
    pass "la aplicación Entra conserva nombre y OK sin exponer el appId en stdout/stderr"
else
    fail "la fila exitosa de Entra cambió de estado/formato o expuso el appId"
fi
if printf '%s\n' "$OUT" | grep -Fq "[OK           ] secrets[] registra 0 entrada(s)" \
    && printf '%s\n' "$OUT" | grep -Fq "[OK           ] tenancy.strategy = mono-tenant-transitorio -- camino (B) POC" \
    && printf '%s\n' "$OUT" | grep -Fq "[OK           ] projections.enabled=false -- opt-out explicito"; then
    pass "secrets[] vacío, tenancy POC y projections=false explícitos reportan OK"
else
    fail "los tokens explícitos no recibieron el diagnóstico esperado"
fi

if [[ "$OUT" =~ Resumen:\ ([0-9]+)\ OK\ \|\ ([0-9]+)\ FALTA\ \|\ ([0-9]+)\ NO\ VERIFICADO ]]; then
    SUCCESS_OK="${BASH_REMATCH[1]}"
    SUCCESS_FALTA="${BASH_REMATCH[2]}"
    SUCCESS_NV="${BASH_REMATCH[3]}"
else
    SUCCESS_OK=""
    SUCCESS_FALTA=""
    SUCCESS_NV=""
    fail "la corrida exitosa no emitió el resumen de conteos esperado"
fi

if printf '%s\n' "$OUT" | grep -Fqx '  [OK           ] esquema completo (tipo:*, estado:*, dom:*, bug, bloqueado, warning)'; then
    pass "con warning en el stub, la fila de labels sale OK con el esquema completo"
else
    fail "la fila de labels no salio OK con warning presente"
fi
OUT_NOWARN=$(cd "$ONBOARD_REPO" && GH_LABELS_SIN_WARNING=1 PATH="$ONBOARD_BIN:$PATH" bash "$REPO_ROOT/scripts/onboard-diagnose.sh" 2>&1)
if printf '%s\n' "$OUT_NOWARN" | grep -Fqx '  [FALTA        ] faltan labels: warning'; then
    pass "sin warning en el stub, se reporta 'faltan labels: warning'"
else
    fail "la ausencia de warning no produjo 'faltan labels: warning'"
fi

OUT_ABSENT=$(cd "$ONBOARD_REPO" && AZ_APP_MODE=absent PATH="$ONBOARD_BIN:$PATH" bash "$REPO_ROOT/scripts/onboard-diagnose.sh" 2>&1)
if [ -n "$SUCCESS_OK" ] \
    && printf '%s\n' "$OUT_ABSENT" | grep -Fqx '  [FALTA        ] aplicacion de Entra "ci-diagnostico" no encontrada' \
    && printf '%s\n' "$OUT_ABSENT" | grep -Fq 'setup-github-ci.sh <subscription-id>' \
    && [[ "$OUT_ABSENT" =~ Resumen:\ ([0-9]+)\ OK\ \|\ ([0-9]+)\ FALTA\ \|\ ([0-9]+)\ NO\ VERIFICADO ]] \
    && [ "${BASH_REMATCH[1]}" -eq $((SUCCESS_OK - 1)) ] \
    && [ "${BASH_REMATCH[2]}" -eq $((SUCCESS_FALTA + 1)) ] \
    && [ "${BASH_REMATCH[3]}" -eq "$SUCCESS_NV" ]; then
    pass "una aplicación ausente conserva FALTA accionable y ajusta solo sus conteos"
else
    fail "una aplicación ausente perdió su estado, acción o conteos esperados"
fi

OUT_ERROR=$(cd "$ONBOARD_REPO" && AZ_APP_MODE=error PATH="$ONBOARD_BIN:$PATH" bash "$REPO_ROOT/scripts/onboard-diagnose.sh" 2>&1)
if printf '%s\n' "$OUT_ERROR" | grep -Fqx '  [FALTA        ] aplicacion de Entra "ci-diagnostico" no encontrada' \
    && printf '%s\n' "$OUT_ERROR" | grep -Fq 'setup-github-ci.sh <subscription-id>' \
    && ! printf '%s\n' "$OUT_ERROR" | grep -Fq 'APP_ID_CENTINELA_NO_PUBLICAR'; then
    pass "un error de Azure sigue siendo accionable sin filtrar identificadores por stderr"
else
    fail "un error de Azure dejó de ser accionable o filtró el identificador centinela"
fi

echo ""
echo "[S-5b] repoSlug: atajo local y verificacion de contenido"
prepare_onboard_repo "$ONBOARD_REPO/.mefisto/harness.config.json" false
run_slug() { (cd "$ONBOARD_REPO" && PATH="$ONBOARD_BIN:$PATH" "$@" bash "$REPO_ROOT/scripts/onboard-diagnose.sh" 2>&1); }
NOGH_BIN=$(mktemp -d)
for t in git jq bash mktemp cat rm sed grep tr dirname az; do
    p=$(command -v "$t" 2>/dev/null) && ln -s "$p" "$NOGH_BIN/$t"
done
trap 'rm -f "$ROW_OUT"; rm -rf "$IGNORE_REPO" "$DIRECTIVES_REPO" "$ONBOARD_REPO" "$ONBOARD_BIN" "$NOGH_BIN"' EXIT
set_slug() { jq --arg s "$1" '.repoSlug = $s' "$ONBOARD_REPO/.mefisto/harness.config.json" > "$ONBOARD_REPO/cfg.tmp" && mv "$ONBOARD_REPO/cfg.tmp" "$ONBOARD_REPO/.mefisto/harness.config.json"; }

git -C "$ONBOARD_REPO" remote remove origin 2>/dev/null
git -C "$ONBOARD_REPO" remote add origin "git@github.com:Org/Consumidor.git"
set_slug "org/consumidor"
GH_LOG=$(mktemp); : > "$GH_LOG"
OUT=$(run_slug env GH_API_LOG="$GH_LOG")
if printf '%s\n' "$OUT" | grep -Fq "[FALTA        ] repoSlug 'org/consumidor' apunta al propio consumidor" \
    && [ ! -s "$GH_LOG" ] && printf '%s\n' "$OUT" | grep -Fq "Corrige repoSlug en"; then
    pass "repoSlug igual al propio origin: FALTA con accion, sin llamar a gh api"
else
    fail "el atajo local no detecto el repoSlug propio"
fi
rm -f "$GH_LOG"

git -C "$ONBOARD_REPO" remote set-url origin "https://github.com/Org/Consumidor.git"
OUT=$(run_slug env)
printf '%s\n' "$OUT" | grep -Fq "[FALTA        ] repoSlug 'org/consumidor' apunta al propio consumidor" \
    && pass "el atajo reconoce el remoto HTTPS" || fail "el atajo no reconocio el remoto HTTPS"

set_slug "otro/mefisto-fork"
OUT=$(run_slug env GH_API_MODE=mefisto)
printf '%s\n' "$OUT" | grep -Fq "[OK           ] repoSlug 'otro/mefisto-fork' apunta a un repo de Mefisto" \
    && pass "plugin.json con name mefisto: OK" || fail "name mefisto no dio OK"

OUT=$(run_slug env GH_API_MODE=otro)
printf '%s\n' "$OUT" | grep -Fq "[FALTA        ] repoSlug 'otro/mefisto-fork'" \
    && printf '%s\n' "$OUT" | grep -Fq "name 'otra-cosa'" \
    && printf '%s\n' "$OUT" | grep -Fq "Corrige repoSlug en" \
    && pass "name distinto: FALTA con causa y accion" || fail "name distinto no dio FALTA accionable"

OUT=$(run_slug env GH_API_MODE=404)
printf '%s\n' "$OUT" | grep -Fq "[FALTA        ] repoSlug 'otro/mefisto-fork'" \
    && printf '%s\n' "$OUT" | grep -Fq "no existe o no tiene .claude-plugin/plugin.json" \
    && pass "404: FALTA con causa" || fail "404 no dio FALTA con causa"

OUT=$(run_slug env GH_API_MODE=noauth)
printf '%s\n' "$OUT" | grep -Fq "[NO VERIFICADO] repoSlug 'otro/mefisto-fork'" \
    && printf '%s\n' "$OUT" | grep -Fq "(gh: Bad credentials (HTTP 401))" \
    && pass "gh sin autenticacion: NO VERIFICADO con el motivo de gh" || fail "gh sin autenticacion no dio NO VERIFICADO con motivo"

OUT=$(cd "$ONBOARD_REPO" && PATH="$NOGH_BIN" bash "$REPO_ROOT/scripts/onboard-diagnose.sh" 2>&1)
printf '%s\n' "$OUT" | grep -Fq "[NO VERIFICADO] repoSlug 'otro/mefisto-fork'" \
    && pass "sin gh: NO VERIFICADO" || fail "sin gh no dio NO VERIFICADO"

jq 'del(.repoSlug)' "$ONBOARD_REPO/.mefisto/harness.config.json" > "$ONBOARD_REPO/cfg.tmp" && mv "$ONBOARD_REPO/cfg.tmp" "$ONBOARD_REPO/.mefisto/harness.config.json"
OUT=$(run_slug env GH_API_MODE=mefisto)
printf '%s\n' "$OUT" | grep -Fq "[OK           ] repoSlug 'augusto-romero-arango/mefisto' apunta a un repo de Mefisto (default" \
    && pass "sin repoSlug se valida el default" || fail "el default no se valido"
git -C "$ONBOARD_REPO" remote remove origin

rm -f "$ONBOARD_REPO/.mefisto/harness.config.json"
OUT=$(cd "$ONBOARD_REPO" && PATH="$ONBOARD_BIN:$PATH" bash "$REPO_ROOT/scripts/onboard-diagnose.sh")
if printf '%s\n' "$OUT" | grep -Fq "[OK           ] config efectivo $ONBOARD_REPO_REAL/.claude/harness.config.json existe" \
    && printf '%s\n' "$OUT" | grep -Fq "[OK           ] secrets[] registra 1 entrada(s)" \
    && printf '%s\n' "$OUT" | grep -Fq "[OK           ] tenancy.strategy = multi-tenant-header" \
    && printf '%s\n' "$OUT" | grep -Fq "[NO VERIFICADO] projections.enabled=true, pero el worker" \
    && [ ! -e "$ONBOARD_REPO/.mefisto/harness.config.json" ]; then
    pass "el fallback legacy conserva el diagnóstico funcional sin escribir config canónico"
else
    fail "el fallback legacy no usó su ruta efectiva o no diagnosticó projections"
fi

printf '{ JSON inválido\n' > "$ONBOARD_REPO/.mefisto/harness.config.json"
OUT=$(cd "$ONBOARD_REPO" && PATH="$ONBOARD_BIN:$PATH" bash "$REPO_ROOT/scripts/onboard-diagnose.sh" 2>&1)
if printf '%s\n' "$OUT" | grep -Fq "[FALTA        ] configuracion invalida o incompleta" \
    && printf '%s\n' "$OUT" | grep -Fq "el JSON de $ONBOARD_REPO_REAL/.mefisto/harness.config.json no es parseable" \
    && printf '%s\n' "$OUT" | grep -Fq "secrets[] no verificado porque el config efectivo no pudo cargarse" \
    && printf '%s\n' "$OUT" | grep -Fq "tenancy.strategy no verificado porque el config efectivo no pudo cargarse" \
    && printf '%s\n' "$OUT" | grep -Fq "projections.enabled no verificado porque el config efectivo no pudo cargarse" \
    && ! printf '%s\n' "$OUT" | grep -Fq "config efectivo $ONBOARD_REPO_REAL/.claude/harness.config.json existe" \
    && ! printf '%s\n' "$OUT" | grep -Fq "parse error"; then
    pass "un canónico inválido falla cerrado sin mezclar el fallback ni disparar jq secundarios"
else
    fail "el config canónico inválido no degradó de forma conservadora y accionable"
fi

rm -f "$ONBOARD_REPO/.mefisto/harness.config.json" "$ONBOARD_REPO/.claude/harness.config.json"
OUT=$(cd "$ONBOARD_REPO" && PATH="$ONBOARD_BIN:$PATH" bash "$REPO_ROOT/scripts/onboard-diagnose.sh" 2>&1)
if printf '%s\n' "$OUT" | grep -Fq "no se encontro el config canonico requerido $ONBOARD_REPO_REAL/.mefisto/harness.config.json" \
    && printf '%s\n' "$OUT" | grep -Fq "[FALTA        ] configuracion invalida o incompleta" \
    && printf '%s\n' "$OUT" | grep -Fq "projections.enabled no verificado porque el config efectivo no pudo cargarse"; then
    pass "la ausencia de ambos configs falla con la ruta canónica y sin lecturas directas"
else
    fail "la ausencia del config no produjo un diagnóstico conservador y accionable"
fi

# Issue #2384 (CA-2/CA-4): el fixture tiene infra/environments/ y no tiene
# .mefisto/appinsights.env -> fila FALTA, paso manual en "Proximos pasos" y exit 0.
OUT=$(cd "$ONBOARD_REPO" && PATH="$ONBOARD_BIN:$PATH" bash "$REPO_ROOT/scripts/onboard-diagnose.sh" 2>&1)
RC=$?
PASOS=$(printf '%s\n' "$OUT" | sed -n '/^Proximos pasos/,$p')
if [ "$RC" -eq 0 ] \
    && printf '%s\n' "$OUT" | grep -Fq "[FALTA        ] .mefisto/appinsights.env no existe" \
    && printf '%s\n' "$PASOS" | grep -Fq "Crea .mefisto/appinsights.env con las cinco claves" \
    && printf '%s\n' "$PASOS" | grep -Fq "/bug, /health-check y /purge-store lo requieren" \
    && [ ! -e "$ONBOARD_REPO/.mefisto/appinsights.env" ]; then
    pass "diagnostico integrado: appinsights.env ausente da FALTA, paso manual y exit 0 sin escribir"
else
    fail "diagnostico integrado de appinsights.env (rc=$RC)"
fi

echo ""
echo "[S-6] _claude_version_meets() y _check_claude_version() (sin invocar claude)"
_claude_version_meets "2.1.287 (Claude Code)" 2.1.287 && pass "igual cumple" || fail "igual deberia cumplir"
_claude_version_meets "2.1.288 (Claude Code)" 2.1.287 && pass "mayor por patch cumple" || fail "mayor patch"
_claude_version_meets "2.2.0" 2.1.287 && pass "mayor por minor cumple" || fail "mayor minor"
_claude_version_meets "3.0.0" 2.1.287 && pass "mayor por major cumple" || fail "mayor major"
_claude_version_meets "2.1.286" 2.1.287; [ $? -eq 1 ] && pass "menor por patch" || fail "menor patch"
_claude_version_meets "2.0.999" 2.1.287; [ $? -eq 1 ] && pass "menor por minor" || fail "menor minor"
_claude_version_meets "1.9.999" 2.1.287; [ $? -eq 1 ] && pass "menor por major" || fail "menor major"
_claude_version_meets "sin version" 2.1.287; [ $? -eq 2 ] && pass "salida sin version -> 2" || fail "sin version"
_check_claude_version claude "2.1.287 (Claude Code)"
[ "$CLAUDE_VERSION_STATE" = "OK" ] && pass "estado OK" || fail "estado OK: $CLAUDE_VERSION_STATE"
_check_claude_version claude "2.1.0 (Claude Code)"
[ "$CLAUDE_VERSION_STATE" = "FALTA" ] && pass "estado FALTA" || fail "estado FALTA: $CLAUDE_VERSION_STATE"
_check_claude_version claude ""
[ "$CLAUDE_VERSION_STATE" = "NV" ] && pass "estado NV sin version" || fail "estado NV: $CLAUDE_VERSION_STATE"
_check_claude_version fake "1.0.0"
[ "$CLAUDE_VERSION_STATE" = "INFO" ] && pass "runtime distinto de claude es INFO" || fail "runtime distinto de claude INFO: $CLAUDE_VERSION_STATE"
_check_claude_version fake ""
[ "$CLAUDE_VERSION_STATE" = "INFO" ] && pass "runtime distinto de claude sin version sigue INFO" || fail "runtime distinto de claude INFO sin version"

echo ""
echo "[S-AI] _check_appinsights_env(): .mefisto/appinsights.env (issue #2384)"

AI_REPO="$(mktemp -d)"
mkdir -p "$AI_REPO/.mefisto"
AI_ENV="$AI_REPO/.mefisto/appinsights.env"
ai_full() { printf 'APPINSIGHTS_APP=ai\nAPPINSIGHTS_RG=rg\nSERVICEBUS_NAMESPACE=sb\nSERVICEBUS_RG=rg2\n'; }

# Sin archivo y sin infra/environments -> NV
_check_appinsights_env "$AI_REPO"
[ "$APPINSIGHTS_ENV_STATE" = "NV" ] && pass "sin archivo y sin infra/environments: NV" || fail "NV esperado: $APPINSIGHTS_ENV_STATE"

# Sin archivo y con infra/environments -> FALTA
mkdir -p "$AI_REPO/infra/environments"
_check_appinsights_env "$AI_REPO"
[ "$APPINSIGHTS_ENV_STATE" = "FALTA" ] && pass "sin archivo con infra/environments: FALTA" || fail "FALTA esperado: $APPINSIGHTS_ENV_STATE"
case "$APPINSIGHTS_ENV_DETAIL" in
    */bug*/health-check*/purge-store*) pass "el detalle cita /bug, /health-check y /purge-store" ;;
    *) fail "detalle sin los tres comandos: $APPINSIGHTS_ENV_DETAIL" ;;
esac

# Completo con FUNCTIONAPP_NAMES -> OK sin INFO
{ ai_full; printf 'FUNCTIONAPP_NAMES=func-a,func-b\n'; } > "$AI_ENV"
_check_appinsights_env "$AI_REPO"
if [ "$APPINSIGHTS_ENV_STATE" = "OK" ] && [ -z "$APPINSIGHTS_ENV_INFO" ] && [[ "$APPINSIGHTS_ENV_DETAIL" == *appinsights.env* ]]; then
    pass "archivo completo: OK que nombra el archivo"
else
    fail "OK esperado: $APPINSIGHTS_ENV_STATE / $APPINSIGHTS_ENV_INFO"
fi

# Completo sin FUNCTIONAPP_NAMES, y con FUNCTIONAPP_NAMES vacio -> OK + INFO
ai_full > "$AI_ENV"
_check_appinsights_env "$AI_REPO"
[ "$APPINSIGHTS_ENV_STATE" = "OK" ] && [[ "$APPINSIGHTS_ENV_INFO" == *FUNCTIONAPP_NAMES* ]] && pass "FUNCTIONAPP_NAMES ausente: OK + INFO" || fail "OK+INFO esperado (ausente)"
{ ai_full; printf 'FUNCTIONAPP_NAMES=\n'; } > "$AI_ENV"
_check_appinsights_env "$AI_REPO"
[ "$APPINSIGHTS_ENV_STATE" = "OK" ] && [[ "$APPINSIGHTS_ENV_INFO" == *FUNCTIONAPP_NAMES* ]] && pass "FUNCTIONAPP_NAMES vacio: OK + INFO" || fail "OK+INFO esperado (vacio)"

# Claves ausentes o vacias -> FALTA con la lista exacta
printf 'APPINSIGHTS_APP=ai\nAPPINSIGHTS_RG=\nSERVICEBUS_RG=rg2\nFUNCTIONAPP_NAMES=f\n' > "$AI_ENV"
_check_appinsights_env "$AI_REPO"
if [ "$APPINSIGHTS_ENV_STATE" = "FALTA" ] && [[ "$APPINSIGHTS_ENV_DETAIL" == *"APPINSIGHTS_RG, SERVICEBUS_NAMESPACE" ]]; then
    pass "claves ausentes/vacias: FALTA listando exactamente APPINSIGHTS_RG, SERVICEBUS_NAMESPACE"
else
    fail "FALTA con lista exacta esperado: $APPINSIGHTS_ENV_STATE / $APPINSIGHTS_ENV_DETAIL"
fi

# No ejecuta el archivo (sin source) ni escribe
AI_PROBE="$AI_REPO/ejecutado"
{ ai_full; printf 'touch %s\n' "$AI_PROBE"; } > "$AI_ENV"
AI_SUM_BEFORE=$(cksum < "$AI_ENV")
_check_appinsights_env "$AI_REPO"
if [ ! -e "$AI_PROBE" ] && [ "$(cksum < "$AI_ENV")" = "$AI_SUM_BEFORE" ]; then
    pass "no hace source del archivo ni lo modifica"
else
    fail "el archivo se ejecuto o se modifico"
fi
rm -rf "$AI_REPO"

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
