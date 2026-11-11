#!/usr/bin/env bash
# Contrato del comando implement neutral y su proyeccion publicada.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
SOURCE="$REPO_ROOT/src/published/commands/implement.md"
CLAUDE="$REPO_ROOT/dist/claude/commands/implement.md"
MIRROR="$REPO_ROOT/commands/implement.md"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3" ;; esac; }
absent() { case "$1" in *"$2"*) fail "$3" ;; *) pass "$3" ;; esac; }

echo '[fuente] contrato neutral'
if bash "$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh" "$SOURCE" >/dev/null; then pass 'la fuente valida'; else fail 'la fuente no valida'; fi
metadata="$(awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$SOURCE")"
if printf '%s' "$metadata" | jq -e '.kind == "command" and .id == "implement" and .profile == "fast" and .arguments == "<issue> [--models '\''agente=modelo[,agente=modelo...]'\''] [--variant <label>]" and (keys | sort) == ["arguments", "description", "id", "kind", "profile"]' >/dev/null; then pass 'metadata sin capacidades ni runtime'; else fail 'metadata neutral invalida'; fi
body="$(awk 'NR == 1 { next } $0 == "---" && !seen { seen=1; next } seen { print }' "$SOURCE")"
contains "$body" '{{mefisto:assert-consumer-repo}}' 'guard consumidor antes del proceso'
guard_line="$(grep -nF '{{mefisto:assert-consumer-repo}}' "$SOURCE" | cut -d: -f1)"
operation_line="$(awk '/gh issue view/ { print NR; exit }' "$SOURCE")"
[ -n "$guard_line" ] && [ -n "$operation_line" ] && [ "$guard_line" -lt "$operation_line" ] && pass 'guard precede cualquier operacion' || fail 'guard no precede las operaciones'
contains "$body" 'primer token numerico' 'extrae el issue sin consumir flags'
contains "$body" 'no contiene un token compuesto solo por digitos' 'rechaza entrada sin issue'
contains "$body" 'incluye un flag sin valor' 'rechaza flags incompletos antes de consultar GitHub'
contains "$body" 'Reenvia `$ARGUMENTS` intacto' 'delega el parsing definitivo al wrapper'
contains "$body" 'Si no es consultable, no existe o esta cerrado (`CLOSED`)' 'exige un issue abierto y consultable'
contains "$body" 'Cuenta todos los labels `tipo:*` y exige exactamente uno' 'exige un unico label de tipo'
contains "$body" 'tipo:feature' 'admite feature'
contains "$body" 'tipo:refactor' 'admite refactor'
contains "$body" 'tipo:projection' 'admite projection'
contains "$body" '{{mefisto:command tooling}}' 'tooling se remite al comando especializado'
contains "$body" '{{mefisto:package-root}}/docs/adr/mef-adr-0011-definition-of-ready.md' 'DoR se lee desde package root'
contains "$body" 'todos los criterios vigentes' 'DoR no memoriza cantidad fija'
contains "$body" 'Depende de #N' 'dependencias declaradas se filtran'
contains "$body" 'Bloqueado por #N' 'dependencias bloqueadas se filtran'
contains "$body" 'lineas `Bloquea #N`' 'no confunde dependientes con prerequisitos'
contains "$body" 'consulta primero titulo y estado con `gh pr view`' 'consulta PR antes que issue'
contains "$body" 'cualquier otro fallo de la consulta del PR es no consultable y bloquea' 'falla cerrado al consultar dependencias'
contains "$body" 'Ignora cualquier otro `#N`' 'ignora referencias ajenas a dependencias'
contains "$body" 'Si no hay una dependencia canonica consultable' 'bloqueado sin prerequisitos validos falla cerrado'
contains "$body" 'Con `--variant`, nunca mutas labels' 'variante no muta labels'
contains "$body" 'no hace push, no abre PR ni muta el issue' 'variante no tiene efectos remotos'
contains "$body" '{{mefisto:config-path}}' 'configuracion usa directiva neutral'
contains "$body" '`namespacePrefix` falta o esta vacio' 'configuracion invalida bloquea scaffold'
contains "$body" 'Conserva `namespacePrefix` literalmente' 'namespacePrefix no se transforma'
contains "$body" 'convierte solo el nombre del dominio de kebab-case a PascalCase' 'solo el dominio se convierte a PascalCase'
contains "$body" '## Impacto' 'deteccion limitada a impacto'
contains "$body" '1. Scaffoldear el dominio antes de lanzar el pipeline.' 'ofrece scaffold como opcion 1'
contains "$body" '2. Continuar sin scaffold' 'ofrece continuar como opcion 2'
contains "$body" '3. Abortar sin lanzar el pipeline.' 'ofrece abortar como opcion 3'
contains "$body" 'Function App:' 'opcion de scaffold describe la Function App'
contains "$body" 'Tests:' 'opcion de scaffold describe los tests'
contains "$body" 'Terraform:' 'opcion de scaffold describe Terraform'
contains "$body" 'Workflow:' 'opcion de scaffold describe el workflow'
contains "$body" 'dentro del worktree del issue' 'scaffold y TDD comparten worktree'
contains "$body" 'solo se admite un scaffold por invocacion' 'limita scaffold por invocacion'
contains "$body" '{{mefisto:run launch-pipeline.sh $ARGUMENTS}}' 'despacho sin scaffold'
contains "$body" '{{mefisto:run launch-pipeline.sh $ARGUMENTS --scaffold-domain <dominio-kebab-confirmado>}}' 'despacho con scaffold confirmado'
[ "$(grep -cF '{{mefisto:run launch-pipeline.sh' "$SOURCE")" -eq 2 ] && pass 'existen dos rutas de lanzamiento' || fail 'las rutas de lanzamiento no son dos'
for forbidden in 'Claude' '.claude/' 'cache' 'model:' 'tools:' 'allowed-tools:' 'permission:' 'SCAFFOLD_FLAG' '/work-status'; do absent "$body" "$forbidden" "fuente no publica token prohibido: $forbidden"; done

echo '[salidas] adaptador y mirror'
[ -f "$CLAUDE" ] && pass "existe ${CLAUDE#"$REPO_ROOT/"}" || fail "falta ${CLAUDE#"$REPO_ROOT/"}"
if jq -e '.assets | any(.source == "src/published/commands/implement.md" and .destination == "commands/implement.md" and .mode == "0644" and (.sha256 | test("^[0-9a-f]{64}$")))' "$REPO_ROOT/dist/claude/.mefisto-generated-assets.json" >/dev/null; then pass 'Claude inventaria implement'; else fail 'Claude no inventaria implement'; fi
contains "$(< "$CLAUDE")" 'model: "haiku"' 'Claude materializa el perfil fast'
contains "$(< "$CLAUDE")" 'MEFISTO_PACKAGE_ROOT' 'Claude resuelve package root una vez'
[ "$(grep -c '^MEFISTO_PACKAGE_ROOT=' "$CLAUDE")" -eq 1 ] && pass 'Claude tiene un preambulo de package root' || fail 'Claude duplica package root'
contains "$(< "$CLAUDE")" 'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/launch-pipeline.sh" $ARGUMENTS' 'Claude conserva package root con espacios y fija su runtime'
if cmp -s "$MIRROR" "$CLAUDE"; then pass 'mirror Claude coincide byte a byte'; else fail 'mirror Claude diverge'; fi
contains "$(< "$MIRROR")" '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/implement.md. No editar a mano. -->' 'mirror conserva marcador generado'
if "$GENERATOR" --check >/dev/null; then pass 'generate-published-adapters --check esta al dia'; else fail 'generate-published-adapters --check detecto divergencias'; fi

printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
