#!/usr/bin/env bash
# Contrato canonico de resolucion de modelos (issue #1072). Bash 3.2 + jq;
# usa adaptadores locales y nunca ejecuta proveedores reales.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODELS="$ROOT/src/runtime/lib/mefisto-models.sh"
PASS=0; FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1" >&2; FAIL=$((FAIL + 1)); }
assert_model() {
    local expected="$1" label="$2"
    if [ "$MEFISTO_RESOLVED_MODEL" = "$expected" ]; then pass "$label"; else fail "$label (obtenido '$MEFISTO_RESOLVED_MODEL')"; fi
}
assert_invalid_mapping() {
    local file="$1" expected="$2" label="$3"
    if mefisto_resolve_model alpha writer fast '' "$file" >/dev/null; then
        fail "$label (aceptado)"
    else
        case "$MEFISTO_MODELS_ERROR" in "$file":*"$expected"*) pass "$label" ;; *) fail "$label ($MEFISTO_MODELS_ERROR)" ;; esac
    fi
}
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
LIBS="$TMP/libs"; mkdir -p "$LIBS"
cat > "$LIBS/runtime-alpha.sh" <<'EOF'
runtime_alpha_default_model() { case "$1" in fast) printf '%s' 'alpha default' ;; balanced|deep) printf '%s' '' ;; *) return 1 ;; esac; }
EOF
cat > "$LIBS/runtime-nodefault.sh" <<'EOF'
runtime_nodefault_is_available() { return 0; }
EOF
MEFISTO_RUNTIME_LIB_DIR="$LIBS"
source "$MODELS"

MAPPING="$TMP/models.json"
cat > "$MAPPING" <<'EOF'
{"alpha":{"profiles":{"fast":"profile model","balanced":"balanced model"},"agents":{"writer":"agent model with spaces"}}}
EOF

mefisto_resolve_model alpha writer fast 'explicit model with spaces' "$MAPPING" >/dev/null && assert_model 'explicit model with spaces' "1. override explicito con espacios"
mefisto_resolve_model alpha writer fast '' "$MAPPING" >/dev/null && assert_model 'agent model with spaces' "2. mapping por agente gana al perfil"
mefisto_resolve_model alpha reviewer fast '' "$MAPPING" >/dev/null && assert_model 'profile model' "3. mapping por perfil gana al default"
mefisto_resolve_model alpha reviewer deep '' "$MAPPING" >/dev/null && assert_model '' "5. default vacio hereda"
mefisto_resolve_model alpha reviewer fast '' "$TMP/inexistente.json" >/dev/null && assert_model 'alpha default' "4. ruta inexistente cae al default"
mefisto_resolve_model alpha reviewer fast >/dev/null && assert_model 'alpha default' "mapping omitido cae al default"
: > "$TMP/vacio.json"
mefisto_resolve_model alpha reviewer fast '' "$TMP/vacio.json" >/dev/null && assert_model 'alpha default' "archivo vacio equivale a ausencia"
printf '{}' > "$TMP/mapa-vacio.json"
mefisto_resolve_model alpha reviewer fast '' "$TMP/mapa-vacio.json" >/dev/null && assert_model 'alpha default' "objeto mapping vacio es valido"
mefisto_resolve_model nodefault writer deep >/dev/null && assert_model '' "adaptador sin funcion default hereda"

# Volver a cargar el mismo id desde un adaptador sin default no puede reutilizar
# accidentalmente la funcion que dejo una resolucion anterior.
cat > "$LIBS/runtime-alpha.sh" <<'EOF'
runtime_alpha_is_available() { return 0; }
EOF
mefisto_resolve_model alpha reviewer fast >/dev/null && assert_model '' "adaptador sin default no reutiliza una funcion obsoleta"
cat > "$LIBS/runtime-alpha.sh" <<'EOF'
runtime_alpha_default_model() { case "$1" in fast) printf '%s' 'alpha default' ;; balanced|deep) printf '%s' '' ;; *) return 1 ;; esac; }
EOF

printf '{' > "$TMP/json-invalido.json"
assert_invalid_mapping "$TMP/json-invalido.json" "no es JSON valido" "JSON invalido cita archivo y motivo"
printf '{}\n{}\n' > "$TMP/dos-documentos.json"
assert_invalid_mapping "$TMP/dos-documentos.json" "no es JSON valido" "varios documentos no son un unico mapping JSON"
printf '[]' > "$TMP/raiz-invalida.json"
assert_invalid_mapping "$TMP/raiz-invalida.json" ".: se esperaba un objeto" "raiz no objeto cita campo"
printf '{"alpha":{"otro":{}}}' > "$TMP/campo-invalido.json"
assert_invalid_mapping "$TMP/campo-invalido.json" "alpha.otro: campo desconocido" "campo desconocido"
printf '{"alpha":{"profiles":null}}' > "$TMP/profiles-null.json"
assert_invalid_mapping "$TMP/profiles-null.json" "alpha.profiles: se esperaba un objeto" "profiles null no equivale a ausencia"
printf '{"alpha":{"agents":{"writer":7}}}' > "$TMP/modelo-invalido.json"
assert_invalid_mapping "$TMP/modelo-invalido.json" "alpha.agents.writer: se esperaba un string no vacio" "modelo no string"
printf '{"alpha":{"profiles":{"slow":"x"}}}' > "$TMP/perfil-invalido.json"
assert_invalid_mapping "$TMP/perfil-invalido.json" "alpha.profiles.slow: perfil desconocido" "perfil desconocido en mapping"
printf '{"bad-id":{}}' > "$TMP/runtime-invalido.json"
assert_invalid_mapping "$TMP/runtime-invalido.json" "bad-id: id de runtime invalido" "runtime invalido en mapping"

if mefisto_resolve_model alpha writer unknown >/dev/null; then fail "perfil de llamada invalido"; else case "$MEFISTO_MODELS_ERROR" in profile:*) pass "perfil de llamada invalido" ;; *) fail "motivo de perfil invalido" ;; esac; fi
if mefisto_resolve_model 'bad-id' writer fast >/dev/null; then fail "runtime de llamada invalido"; else case "$MEFISTO_MODELS_ERROR" in runtime\ invalido:*) pass "runtime usa el vocabulario abierto canonico" ;; *) fail "motivo de runtime invalido" ;; esac; fi
if mefisto_resolve_model missing writer fast >/dev/null; then fail "adaptador inexistente"; else case "$MEFISTO_MODELS_ERROR" in *missing*"$LIBS/runtime-missing.sh"*) pass "adaptador inexistente cita runtime y ruta" ;; *) fail "adaptador inexistente no cita ruta" ;; esac; fi

# El fake comun puede heredar o configurarse y no deriva mapping desde cwd,
# Git, MEFISTO_REPO_ROOT ni el estado .mefisto.
MEFISTO_RUNTIME_LIB_DIR="$ROOT/src/runtime/lib"
source "$MODELS"
mkdir -p "$TMP/.mefisto"
printf '{"fake":{"profiles":{"balanced":"modelo de estado prohibido"}}}' > "$TMP/.mefisto/models.json"
unset MEFISTO_FAKE_DEFAULT_MODEL
OLD_PWD="$PWD"; cd "$TMP" || exit 1
MEFISTO_REPO_ROOT="$TMP" mefisto_resolve_model fake writer balanced >/dev/null
cd "$OLD_PWD" || exit 1
assert_model '' "mapping omitido no depende de cwd ni estado interno"
MEFISTO_FAKE_DEFAULT_MODEL='fake model with spaces'
mefisto_resolve_model fake writer balanced >/dev/null && assert_model 'fake model with spaces' "fake configurable con espacios"

# Las tablas concretas vigentes pertenecen exclusivamente a los adaptadores de
# ejecucion. Resolverlas no ejecuta los CLIs reales.
mefisto_resolve_model claude writer fast >/dev/null && assert_model 'haiku' "Claude fast usa su default vigente"
mefisto_resolve_model claude writer balanced >/dev/null && assert_model 'sonnet' "Claude balanced usa su default vigente"
mefisto_resolve_model claude writer deep >/dev/null && assert_model 'opus' "Claude deep usa su default vigente"

echo "RESULTADO modelos comunes: $PASS pasaron, $FAIL fallaron"
[ "$FAIL" -eq 0 ]
