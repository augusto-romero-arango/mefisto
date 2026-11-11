#!/usr/bin/env bash
# test-guards.sh -- Tests de los guards defensivos de skills publicados e internos.
#
# Valida que:
#   A) Los skills publicados (commands/*.md) llevan el guard "cwd != Mefisto"
#      al inicio: presencia del bloque manual que verifica
#      .claude-plugin/plugin.json, o del guard neutral generado desde
#      src/published/ (directiva {{mefisto:assert-consumer-repo}}, MEF-ADR-0049),
#      que en su lugar verifica src/internal/scripts/generate-internal-adapters.sh.
#   B) Los skills internos (.claude/commands/mefisto-*.md) llevan el guard inverso.
#   C) Los pipelines publicados (scripts/tooling-pipeline.sh, scripts/parallel-pipeline.sh,
#      scripts/batch-pipeline.sh, scripts/pr-sync.sh, scripts/tdd-pipeline.sh,
#      scripts/iac-pipeline.sh, scripts/scaffold-pipeline.sh, scripts/launch-pipeline.sh)
#      y los scripts auxiliares publicados (appinsights-query.sh,
#      setup-github-ci.sh, setup-github-labels.sh, bootstrap-backend.sh,
#      seed-secret.sh, onboard-diagnose.sh, update-plugin.sh) abortan si se
#      sourcean en un contexto donde .claude-plugin/plugin.json existe.
#   D) Las funciones validate_*_scope_changes son sourceables sin errores.
#   F) Integridad de los Agent Skills (MEF-ADR-0033 seccion 4): el `name` del
#      frontmatter de cada SKILL.md coincide con su directorio (F1), tiene
#      `description` no vacio (F2), sus recursos de Nivel 3 referenciados
#      existen (F3), todo valor de `skills:` declarado por un agente resuelve a
#      un Skill real (F4), y el frontmatter no declara ningun campo fuera del
#      estandar portable `name`/`description`/`license`/`compatibility`/
#      `metadata` -- `allowed-tools` en particular (F5, MEF-ADR-0050 seccion 3).
#      Esta es la mitigacion que MEF-ADR-0033 delego al issue que creara el
#      primer Skill: un `skills:` mal escrito NO aborta el agente ni emite error
#      visible ("Claude Code skips it and logs a warning to the debug log"), asi
#      que en los pipelines headless (`claude -p`) el subagente correria sin su
#      doctrina y produciria codigo plausible pero ciego a ella. F5 cierra el
#      hueco anotado en MEF-ADR-0049: un campo especifico de Claude Code pasaba
#      el bloque `[F]` sin senal.
#   G) Ningun bloque triple-backtick `bash` de commands/*.md contiene sintaxis
#      posicional de shell ($1..$9, ${N}, $*, $@, $#): Claude Code la expande como
#      placeholder de argumentos del slash command ANTES de entregar el texto al
#      modelo, incluso dentro de comillas simples de un heredoc o de un awk, y sin
#      argumentos la sustituye por cadena vacia -- un `awk '{print $1}'` llega al
#      modelo como `awk '{print }'`. Replica en el lado publicado (issue #443) el
#      guard que el bloque G de .claude/scripts/tests/test-batch-deps-validation.sh
#      aplica a .claude/commands/*.md (issue #436).
#   L) Todo test-*.sh de primer nivel en scripts/tests/ y .claude/scripts/tests/
#      tiene bit de ejecucion, tanto en disco como en el modo versionado en git
#      (100755, no 100644): _mefisto_test_inventory_scan_lane descarta con
#      `[ -x "$file" ] || continue` cualquiera que no lo tenga, asi que ese
#      archivo nunca entra en la suite completa -- sin PASS, sin FAIL, sin
#      linea en el reporte de mefisto-test-suite.sh (issue #1509).
#
# Uso: scripts/tests/test-guards.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# hooks/hooks.json es salida Claude-specific sin marcador JSON; su fuente y
# sincronía se verifican por el generador dedicado, no por el generador Markdown.
if bash "$REPO_ROOT/src/published/scripts/generate-claude-hooks.sh" --check; then
    :
else
    echo "FAIL: hooks/hooks.json no coincide con generate-claude-hooks.sh" >&2
    exit 1
fi

if bash "$REPO_ROOT/src/published/scripts/validate-published-mcp.sh"; then
    :
else
    echo "FAIL: el registro MCP publicado no valida" >&2
    exit 1
fi

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# -------- Bloque A: guards en skills publicados --------

echo "[A] Skills publicados (commands/*.md): guard 'cwd != Mefisto' presente"

PUBLISHED_SKILLS=(
    batch-stop.md bitacora.md bug.md draft.md eraser-diagram.md fix-review.md health-check.md
    implement.md infra.md infra-base.md install-apim.md install-auth.md install-workos.md
    merge.md next-order.md onboard.md parallel.md purge-store.md scaffold.md scaffold-mcp.md
    scaffold-projections.md seed-secret.md sequential.md tooling.md upgrade.md
)

for skill in "${PUBLISHED_SKILLS[@]}"; do
    path="$REPO_ROOT/commands/$skill"
    if [ ! -f "$path" ]; then
        fail "$skill: archivo no existe"
        continue
    fi
    if grep -q '\.claude-plugin/plugin\.json' "$path"; then
        pass "$skill: menciona .claude-plugin/plugin.json"
    elif grep -q 'src/internal/scripts/generate-internal-adapters\.sh' "$path"; then
        pass "$skill: menciona el guard neutral generado (src/internal/scripts/generate-internal-adapters.sh)"
    else
        fail "$skill: no menciona .claude-plugin/plugin.json ni el guard neutral generado (falta guard)"
    fi
done

# Cobertura del listado: un skill nuevo que nadie agregue a PUBLISHED_SKILLS quedaria sin
# verificar su guard, en silencio (fue el caso de install-apim/install-auth hasta el issue #367).
for path in "$REPO_ROOT"/commands/*.md; do
    skill="$(basename "$path")"
    listed=0
    for known in "${PUBLISHED_SKILLS[@]}"; do
        [ "$known" = "$skill" ] && listed=1 && break
    done
    if [ "$listed" -eq 1 ]; then
        pass "$skill: enumerado en PUBLISHED_SKILLS"
    else
        fail "$skill: existe en commands/ pero no esta en PUBLISHED_SKILLS (agregalo a este test)"
    fi
done

# -------- Bloque B: guards inversos en skills internos --------

echo ""
echo "[B] Skills internos (.claude/commands/mefisto-*.md): guard inverso presente"

INTERNAL_SKILLS=(
    mefisto-tooling.md mefisto-plan.md mefisto-bug.md
    mefisto-fix-review.md mefisto-merge.md
    mefisto-sequential.md mefisto-release.md mefisto-bitacora.md
    mefisto-next-order.md mefisto-batch-stop.md
)

for skill in "${INTERNAL_SKILLS[@]}"; do
    path="$REPO_ROOT/.claude/commands/$skill"
    if [ ! -f "$path" ]; then
        fail "$skill: archivo no existe"
        continue
    fi
    # El guard inverso verifica que el archivo NO existe -> aborta
    if grep -q '\.claude-plugin/plugin\.json' "$path"; then
        pass "$skill: menciona .claude-plugin/plugin.json (guard inverso)"
    else
        fail "$skill: no menciona .claude-plugin/plugin.json"
    fi
done

# Cobertura del listado, simetrica a la del Bloque A: un skill interno nuevo que nadie
# agregue a INTERNAL_SKILLS quedaria sin verificar su guard inverso, en silencio (fue el
# caso de mefisto-sequential/mefisto-release/mefisto-bitacora hasta el issue #530).
for path in "$REPO_ROOT"/.claude/commands/mefisto-*.md; do
    skill="$(basename "$path")"
    listed=0
    for known in "${INTERNAL_SKILLS[@]}"; do
        [ "$known" = "$skill" ] && listed=1 && break
    done
    if [ "$listed" -eq 1 ]; then
        pass "$skill: enumerado en INTERNAL_SKILLS"
    else
        fail "$skill: existe en .claude/commands/ pero no esta en INTERNAL_SKILLS (agregalo a este test)"
    fi
done

# -------- Bloque C: pipelines publicados abortan en repo de Mefisto --------

echo ""
echo "[C] Pipelines publicados: contienen guard contra repo de Mefisto"

PUBLISHED_PIPELINES=(
    tooling-pipeline.sh parallel-pipeline.sh batch-pipeline.sh pr-sync.sh
    tdd-pipeline.sh iac-pipeline.sh scaffold-pipeline.sh launch-pipeline.sh
    appinsights-query.sh setup-github-ci.sh setup-github-labels.sh
    bootstrap-backend.sh seed-secret.sh onboard-migrate-directives.sh purge-store.sh
)

for pipe in "${PUBLISHED_PIPELINES[@]}"; do
    path="$REPO_ROOT/scripts/$pipe"
    if [ ! -f "$path" ]; then
        fail "$pipe: archivo no existe"
        continue
    fi
    if grep -q '\.claude-plugin/plugin\.json' "$path"; then
        pass "$pipe: menciona .claude-plugin/plugin.json (guard)"
    else
        fail "$pipe: no menciona .claude-plugin/plugin.json"
    fi

    # Validar sintaxis bash
    if bash -n "$path" 2>/dev/null; then
        pass "$pipe: sintaxis bash valida"
    else
        fail "$pipe: sintaxis bash invalida"
    fi
done

# -------- Bloque C2: scripts auxiliares publicados abortan en repo de Mefisto --------

echo ""
echo "[C2] Scripts auxiliares publicados: el guard aborta cuando se ejecutan en Mefisto"

AUX_SCRIPTS=(
    appinsights-query.sh setup-github-ci.sh setup-github-labels.sh
    bootstrap-backend.sh seed-secret.sh onboard-diagnose.sh onboard-migrate-directives.sh onboard-activate-repo.sh update-plugin.sh upgrade.sh
    purge-store.sh next-order.sh field-note.sh warnings-diff.sh
)

for aux in "${AUX_SCRIPTS[@]}"; do
    path="$REPO_ROOT/scripts/$aux"
    output=$("$path" 2>&1)
    rc=$?
    if [ "$rc" -eq 1 ] && echo "$output" | grep -q "plugin publicado y solo aplica al consumidor"; then
        pass "$aux: aborta con exit 1 y mensaje correcto en repo de Mefisto"
    else
        fail "$aux: no aborta como se espera (exit=$rc)"
    fi
done

# -------- Bloque D: _pipeline-common.sh y _mefisto-common.sh sourceables --------

echo ""
echo "[D] Funciones de scope son sourceables y exportan los simbolos esperados"

# Subshell para no contaminar este shell con las funciones
(
    set +u
    source "$REPO_ROOT/scripts/_pipeline-common.sh" 2>/dev/null
    if declare -F is_path_in_consumer_blocklist >/dev/null; then
        echo "  PASS: is_path_in_consumer_blocklist definida en _pipeline-common.sh"
        exit 0
    else
        echo "  FAIL: is_path_in_consumer_blocklist NO definida"
        exit 1
    fi
) && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

(
    set +u
    source "$REPO_ROOT/scripts/_pipeline-common.sh" 2>/dev/null
    if declare -F validate_consumer_scope_changes >/dev/null; then
        echo "  PASS: validate_consumer_scope_changes definida"
        exit 0
    else
        echo "  FAIL: validate_consumer_scope_changes NO definida"
        exit 1
    fi
) && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

(
    set +u
    source "$REPO_ROOT/.claude/scripts/_mefisto-common.sh" 2>/dev/null
    if declare -F is_path_in_mefisto_scope >/dev/null && declare -F validate_mefisto_scope_changes >/dev/null && declare -F assert_in_mefisto >/dev/null; then
        echo "  PASS: _mefisto-common.sh exporta assert_in_mefisto, is_path_in_mefisto_scope, validate_mefisto_scope_changes"
        exit 0
    else
        echo "  FAIL: _mefisto-common.sh no exporta todas las funciones esperadas"
        exit 1
    fi
) && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

# -------- Bloque E: comportamiento funcional del scope --------

echo ""
echo "[E] is_path_in_consumer_blocklist clasifica correctamente"

(
    set +u
    source "$REPO_ROOT/scripts/_pipeline-common.sh" 2>/dev/null

    # Rutas que deben estar en el blocklist (reservadas al plugin)
    # skills/: Agent Skills publicados del plugin (MEF-ADR-0033)
    for blocked in "commands/foo.md" "skills/projections/SKILL.md" "skills/projections/reference.md" "agents/bar.md" "hooks/baz.json" ".claude-plugin/plugin.json" "src/published/foo.md" "src/runtime/foo.sh" "dist/claude/plugin.json" "mefisto-manifest.json" "docs/adr/mef-adr-0001-service-bus-topics-por-evento.md"; do
        if is_path_in_consumer_blocklist "$blocked"; then
            echo "  PASS: '$blocked' detectado como blocklist"
        else
            echo "  FAIL: '$blocked' NO detectado como blocklist"
            exit 1
        fi
    done

    # Rutas que NO deben estar en el blocklist (validas para el consumidor)
    # docs/adr/0028-*.md y docs/adr/ca-adr-0009-*.md: ADR local del consumidor
    # (MEF-ADR-0030 decision #4) -- solo docs/adr/mef-adr-* es del marco
    # mefisto-manifest.json es una entrada exacta: vecinos, prefijos, sufijos,
    # subdirectorios y separadores alternativos siguen siendo rutas del consumidor.
    for allowed in "src/Foo.cs" "src/publication/foo.md" "src/runtime-local/foo.sh" "distribution/foo.txt" "tests/Bar.cs" ".github/workflows/deploy.yml" ".claude/settings.json" "docs/bitacora/notes.md" "docs/testing/mefisto-certification/fixture.md" "docs/adr/0028-x.md" "docs/adr/ca-adr-0009-x.md" "AGENTS.md" ".github/workflows/ci.yml" ".github/rulesets/main.json" "sub/mefisto-manifest.json" "mefisto-manifest.json.bak" "foo-mefisto-manifest.json" "mefisto-manifest.json/foo" "mefisto-manifest.json\\foo"; do
        if is_path_in_consumer_blocklist "$allowed"; then
            echo "  FAIL: '$allowed' detectado como blocklist (deberia estar permitido)"
            exit 1
        else
            echo "  PASS: '$allowed' NO detectado como blocklist"
        fi
    done
    exit 0
) && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

# La frontera se prueba a traves del gate real, no solo de su predicado: los
# fixtures documentales del consumidor pasan y los ADRs del marco siguen fuera.
(
    set +u
    source "$REPO_ROOT/scripts/_pipeline-common.sh" 2>/dev/null
    scope_fixture=$(mktemp -d)
    trap 'rm -rf "$scope_fixture"' EXIT
    git -C "$scope_fixture" init -q -b main
    git -C "$scope_fixture" config user.email "test@local"
    git -C "$scope_fixture" config user.name "Test"
    touch "$scope_fixture/README.md"
    git -C "$scope_fixture" add README.md
    git -C "$scope_fixture" commit -q -m "base"
    base=$(git -C "$scope_fixture" rev-parse HEAD)

    mkdir -p "$scope_fixture/docs/testing/mefisto-certification"
    touch "$scope_fixture/docs/testing/mefisto-certification/fixture.md"
    git -C "$scope_fixture" add docs/testing/mefisto-certification/fixture.md
    if validate_consumer_scope_changes "$scope_fixture" "$base"; then
        echo "  PASS: validate_consumer_scope_changes acepta docs/testing/mefisto-certification/fixture.md"
    else
        echo "  FAIL: validate_consumer_scope_changes rechazo un fixture documental permitido"
        exit 1
    fi

    rm -rf "$scope_fixture/docs/testing"
    mkdir -p "$scope_fixture/docs/adr"
    touch "$scope_fixture/docs/adr/mef-adr-0001-ejemplo.md"
    git -C "$scope_fixture" add -A docs
    if validate_consumer_scope_changes "$scope_fixture" "$base"; then
        echo "  FAIL: validate_consumer_scope_changes acepto docs/adr/mef-adr-0001-ejemplo.md"
        exit 1
    else
        echo "  PASS: validate_consumer_scope_changes rechaza docs/adr/mef-adr-0001-ejemplo.md"
    fi
    exit 0
) && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo ""
echo "[E2] is_path_in_mefisto_scope clasifica correctamente"

(
    set +u
    source "$REPO_ROOT/.claude/scripts/_mefisto-common.sh" 2>/dev/null

    # Rutas validas en Mefisto
    # skills/ y .claude/skills/: Agent Skills publicados e internos (MEF-ADR-0033)
    # changelog.d/: fragmentos de CHANGELOG/indice de ADRs (issue #380)
    # .mcp.json: declaracion del server MCP bundleado (issue #763), entrada EXACTA
    # src/internal/ y AGENTS.md: arquitectura neutral interna (issue #852, MEF-ADR-0049).
    # mefisto-manifest.json: metadata Claude raiz exacta, registrada antes de que
    # #1132 la pueble. src/{published,runtime}/ y dist/: distribucion publicada multi-runtime
    # registrada antes de poblarla (issue #1043, MEF-ADR-0053).
    for valid in "commands/foo.md" "skills/projections/SKILL.md" "skills/projections/scripts/check.sh" "agents/bar.md" "scripts/baz.sh" "hooks/hooks.json" "docs/adr/mef-adr-0001-service-bus-topics-por-evento.md" ".claude-plugin/plugin.json" ".claude/commands/mefisto-foo.md" ".claude/skills/mefisto-doctrina/SKILL.md" ".claude/mods/mefisto-divine-wager/hooks/register.tsx" ".claude/settings.json" ".mcp.json" "mefisto-manifest.json" "changelog.d/380.added.md" "changelog.d/README.md" "README.md" "src/internal/foo.ts" "src/internal/skills/foo/SKILL.md" "src/published/foo.md" "src/runtime/foo.sh" "dist/x" "AGENTS.md" ".github/workflows/ci.yml" ".github/rulesets/main.json"; do
        if is_path_in_mefisto_scope "$valid"; then
            echo "  PASS: '$valid' en scope de Mefisto"
        else
            echo "  FAIL: '$valid' NO esta en scope (deberia)"
            exit 1
        fi
    done

    # Rutas invalidas en Mefisto
    # ".mcp.json" y "mefisto-manifest.json" son entradas EXACTAS de la raiz: ni
    # prefijos, sufijos, separadores alternativos ni subdirectorios (issues #763 y #1135).
    # Vecinos de src/{published,runtime}/ y dist/, y ".mefisto/", siguen fuera de scope.
    for invalid in "src/Foo.cs" "src/otro/x.sh" "src/publication/foo.md" "src/runtime-local/foo.sh" "distribution/x" "dist-local/x" "tests/Bar.cs" ".github/CODEOWNERS" ".github/workflows" ".github/rulesets" "infra/main.tf" ".claude/harness.config.json" ".claude/pipeline/events.log" "sub/.mcp.json" "foo.mcp.json" "sub/mefisto-manifest.json" "mefisto-manifest.json.bak" "foo-mefisto-manifest.json" "mefisto-manifest.json/foo" "mefisto-manifest.json\\foo" ".mefisto/pipeline/events.log" ".mefisto/models.json"; do
        if is_path_in_mefisto_scope "$invalid"; then
            echo "  FAIL: '$invalid' esta en scope (NO deberia)"
            exit 1
        else
            echo "  PASS: '$invalid' fuera del scope"
        fi
    done
    exit 0
) && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

# -------- Bloque F: integridad de los Agent Skills (MEF-ADR-0033) --------

echo ""
echo "[F] Agent Skills: frontmatter, recursos Nivel-3 y referencias 'skills:' de agentes"

# frontmatter_field <archivo> <campo> -- imprime el valor del campo dentro del
# bloque de frontmatter YAML delimitado por '---' al inicio del archivo.
frontmatter_field() {
    awk -v field="$2" '
        NR == 1 { if ($0 != "---") exit; next }
        $0 == "---" { exit }
        index($0, field ":") == 1 {
            sub("^" field ":[ \t]*", "")
            gsub(/^["'"'"']|["'"'"']$/, "")
            print
            exit
        }
    ' "$1"
}

# Unica fuente de la lista de campos que MEF-ADR-0050 seccion 3 admite en el
# frontmatter de un SKILL.md, y su grafia para el mensaje de fallo de F5:
# duplicarla entre la regla y sus fixtures dejaria a estos validando una lista
# vieja mientras la regla real usa otra.
PORTABLE_SKILL_FRONTMATTER_FIELDS="name description license compatibility metadata"
PORTABLE_SKILL_FRONTMATTER_FIELDS_SLASHED="$(printf '%s' "$PORTABLE_SKILL_FRONTMATTER_FIELDS" | tr ' ' '/')"

# non_portable_frontmatter_fields <archivo> -- imprime (una por linea) las
# claves de nivel superior del frontmatter que NO pertenecen al estandar
# portable. Una linea indentada (^[ \t]) es una sub-clave anidada (p. ej. bajo
# `metadata:`) y no cuenta como campo propio.
non_portable_frontmatter_fields() {
    awk '
        NR == 1 { if ($0 != "---") exit; next }
        $0 == "---" { exit }
        /^[ \t]/ { next }
        /^[A-Za-z][A-Za-z0-9-]*:/ {
            match($0, /^[A-Za-z][A-Za-z0-9-]*/)
            print substr($0, RSTART, RLENGTH)
        }
    ' "$1" | while IFS= read -r fm_key; do
        case " $PORTABLE_SKILL_FRONTMATTER_FIELDS " in
            *" $fm_key "*) continue ;;
        esac
        printf '%s\n' "$fm_key"
    done
}

SKILL_FILES="$(find "$REPO_ROOT/skills" "$REPO_ROOT/.claude/skills" -name 'SKILL.md' 2>/dev/null | sort)"
SKILL_NAMES=""

if [ -z "$SKILL_FILES" ]; then
    pass "no hay Agent Skills en el repo todavia: nada que validar en [F]"
else
    while IFS= read -r skill_file; do
        [ -n "$skill_file" ] || continue
        skill_dir="$(dirname "$skill_file")"
        dir_name="$(basename "$skill_dir")"
        rel="${skill_file#"$REPO_ROOT"/}"

        # F1: el `name` del frontmatter es el valor que un agente lista en `skills:`
        # (MEF-ADR-0033 seccion 4: "el campo `name` de su frontmatter, no el nombre
        # del directorio"). Exigirlos iguales elimina la ambiguedad de origen.
        skill_name="$(frontmatter_field "$skill_file" name)"
        if [ -z "$skill_name" ]; then
            fail "$rel: frontmatter sin campo 'name'"
        elif [ "$skill_name" != "$dir_name" ]; then
            fail "$rel: name '$skill_name' != directorio '$dir_name'"
        else
            pass "$rel: name '$skill_name' coincide con su directorio"
            SKILL_NAMES="$SKILL_NAMES $skill_name"
        fi

        # F2: sin `description` el Skill nunca se dispara automaticamente (Nivel 1).
        if [ -z "$(frontmatter_field "$skill_file" description)" ]; then
            fail "$rel: frontmatter sin campo 'description' (Nivel 1 vacio: nunca se dispara)"
        else
            pass "$rel: tiene 'description' en el frontmatter"
        fi

        # F3: todo recurso de Nivel 3 referenciado por el body debe existir --
        # un link roto deja la doctrina inalcanzable sin ningun error visible.
        missing_resources=""
        while IFS= read -r resource; do
            [ -n "$resource" ] || continue
            case "$resource" in
                http*|"#"*|/*) continue ;;
            esac
            [ -f "$skill_dir/$resource" ] || missing_resources="$missing_resources $resource"
        done <<EOF
$(grep -o '](\([^)]*\.md\))' "$skill_file" 2>/dev/null | sed 's/^](//; s/)$//' | sort -u)
EOF
        if [ -n "$missing_resources" ]; then
            fail "$rel: recursos Nivel-3 referenciados que no existen:$missing_resources"
        else
            pass "$rel: todos los recursos Nivel-3 referenciados existen"
        fi

        # F5: el frontmatter no declara ningun campo fuera del estandar portable
        # (MEF-ADR-0050 seccion 3) -- `allowed-tools` en particular. Solo cuentan
        # claves de nivel superior: una linea indentada (^[ \t]) es una sub-clave
        # anidada bajo `metadata:` y no cuenta.
        non_portable_fields="$(non_portable_frontmatter_fields "$skill_file")"
        if [ -n "$non_portable_fields" ]; then
            while IFS= read -r field; do
                [ -n "$field" ] || continue
                fail "$rel: frontmatter con campo no portable '$field' (MEF-ADR-0050: solo $PORTABLE_SKILL_FRONTMATTER_FIELDS_SLASHED)"
            done <<EOF
$non_portable_fields
EOF
        else
            pass "$rel: frontmatter limitado al estandar portable (MEF-ADR-0050)"
        fi
    done <<EOF
$SKILL_FILES
EOF
fi

# F5 (verificacion positiva/negativa, CA-3): el guard debe SI marcar un campo
# no portable introducido a mano, y NO marcar un `metadata:` con sub-claves
# anidadas -- sin este par, F5 podria ser un guard ciego o, al reves, uno
# demasiado ruidoso que confunde una sub-clave con un campo de nivel superior.
SYNTH_DIR_F5=$(mktemp -d)
cat > "$SYNTH_DIR_F5/synthetic-non-portable.md" <<'EOF'
---
name: synthetic-non-portable
description: Fixture sintetico para F5.
allowed-tools: Bash
---

# Fixture
EOF
HITS_F5_NEG="$(non_portable_frontmatter_fields "$SYNTH_DIR_F5/synthetic-non-portable.md")"
if [ -n "$HITS_F5_NEG" ]; then
    pass "F5 detecta 'allowed-tools' introducido a mano en un archivo sintetico"
else
    fail "F5 NO detecto 'allowed-tools' introducido a mano (guard ciego)"
fi

cat > "$SYNTH_DIR_F5/synthetic-nested-metadata.md" <<'EOF'
---
name: synthetic-nested-metadata
description: Fixture sintetico para F5.
metadata:
  author: x
  version: "1.0"
---

# Fixture
EOF
HITS_F5_POS="$(non_portable_frontmatter_fields "$SYNTH_DIR_F5/synthetic-nested-metadata.md")"
rm -rf "$SYNTH_DIR_F5"
if [ -z "$HITS_F5_POS" ]; then
    pass "F5 no marca sub-claves anidadas de 'metadata:' (sin falsos positivos)"
else
    fail "falso positivo de F5 sobre sub-claves anidadas de 'metadata:': $HITS_F5_POS"
fi

# F4: todo valor de `skills:` de un agente resuelve a un Skill real del repo.
# Cubre la forma de lista YAML del ejemplo de MEF-ADR-0033 seccion 3
# (`skills:` + items `- nombre`) y la forma inline (`skills: [a, b]`).
AGENT_FILES="$(find "$REPO_ROOT/agents" "$REPO_ROOT/.claude/agents" -name '*.md' 2>/dev/null | sort)"
SKILLS_REFS_FOUND=0

while IFS= read -r agent_file; do
    [ -n "$agent_file" ] || continue
    rel="${agent_file#"$REPO_ROOT"/}"
    refs="$(awk '
        NR == 1 { if ($0 != "---") exit; next }
        $0 == "---" { exit }
        /^skills:[ \t]*$/ { inlist = 1; next }
        inlist && /^[ \t]*-[ \t]*/ { sub(/^[ \t]*-[ \t]*/, ""); print; next }
        inlist { inlist = 0 }
        index($0, "skills:") == 1 {
            sub(/^skills:[ \t]*/, "")
            gsub(/[][,]/, " ")
            print
        }
    ' "$agent_file" | tr -s ' \t' '\n' | tr -d '"'"'" | sort -u)"

    while IFS= read -r ref; do
        [ -n "$ref" ] || continue
        SKILLS_REFS_FOUND=$((SKILLS_REFS_FOUND+1))
        if echo " $SKILL_NAMES " | grep -q " $ref "; then
            pass "$rel: skills: '$ref' resuelve a un SKILL.md real"
        else
            fail "$rel: skills: '$ref' NO resuelve a ningun SKILL.md del repo (degradaria en silencio)"
        fi
    done <<EOF
$refs
EOF
done <<EOF
$AGENT_FILES
EOF

if [ "$SKILLS_REFS_FOUND" -eq 0 ]; then
    pass "ningun agente declara 'skills:' todavia: nada que resolver (guard activo para cuando lo declaren)"
fi

# -------- Bloque G: guard de regresion, lado publicado (issue #443) --------
#
# Mismo guard que el Bloque G de .claude/scripts/tests/test-batch-deps-validation.sh
# (issue #436), pero sobre commands/*.md (lado publicado): Claude Code expande la
# sintaxis posicional de shell ($1..$9, ${N}, $*, $@, $#) que encuentra en el texto
# de un slash command antes de entregarlo al modelo, sin importar que ese texto este
# dentro de comillas simples de un heredoc o de un awk. commands/onboard.md incrustaba
# un heredoc bash con 5 ocurrencias hasta que el issue #443 lo extrajo a
# scripts/onboard-diagnose.sh.

echo ""
echo "[G] Guard de regresion: sin sintaxis posicional de shell en bloques bash de commands/*.md"

scan_bash_positional_leaks_published() {
    local f="$1"
    awk -v F="$f" '
        /^```bash/ {inb=1; next}
        /^```/ {inb=0; next}
        inb && (/\$[1-9]/ || /\$\{[0-9]+\}/ || /\$\*/ || /\$@/ || /\$#/) { printf "%s:%d: %s\n", F, NR, $0 }
    ' "$f"
}

PUBLISHED_VIOLATIONS=""
for f in "$REPO_ROOT"/commands/*.md; do
    hits=$(scan_bash_positional_leaks_published "$f")
    [ -n "$hits" ] && PUBLISHED_VIOLATIONS="$PUBLISHED_VIOLATIONS
$hits"
done
if [ -z "$PUBLISHED_VIOLATIONS" ]; then
    pass "cero hallazgos de sintaxis posicional en commands/*.md"
else
    fail "hallazgos de sintaxis posicional en commands/*.md:$PUBLISHED_VIOLATIONS"
fi

# El guard debe SI detectar un $1 introducido a mano -- si no, es un guard ciego
# que nunca pondria nada en rojo (verificacion positiva, no solo "hoy no encuentra nada").
SYNTH_DIR_PUB=$(mktemp -d)
cat > "$SYNTH_DIR_PUB/synthetic-leak.md" <<'EOF'
Prosa de un skill sintetico.

```bash
echo "$1"
```
EOF
HITS_PUB=$(scan_bash_positional_leaks_published "$SYNTH_DIR_PUB/synthetic-leak.md")
if [ -n "$HITS_PUB" ]; then
    pass "el guard detecta un \$1 introducido a mano en un archivo sintetico"
else
    fail "el guard NO detecto un \$1 introducido a mano (guard ciego)"
fi

# Y NO debe marcar $ARGUMENTS ni ${#ARRAY[@]}: los dos son idiomas legitimos de un
# skill publicado (commands/onboard.md documenta $ARGUMENTS en su ultima regla) y
# Claude Code no los expande como posicionales. Sin este caso, ensanchar el regex
# del guard hasta volverlo ruidoso pasaria inadvertido.
cat > "$SYNTH_DIR_PUB/synthetic-clean.md" <<'EOF'
Prosa de un skill sintetico.

```bash
echo "$ARGUMENTS"
echo "${#SEC_NAMES[@]}"
```
EOF
HITS_PUB2=$(scan_bash_positional_leaks_published "$SYNTH_DIR_PUB/synthetic-clean.md")
rm -rf "$SYNTH_DIR_PUB"
if [ -z "$HITS_PUB2" ]; then
    pass "el guard no marca \$ARGUMENTS ni \${#ARRAY[@]} (sin falsos positivos)"
else
    fail "falso positivo del guard sobre \$ARGUMENTS/\${#ARRAY[@]}: $HITS_PUB2"
fi

# -------- Bloque H: convenciones acopladas de la guarda "Esperar deploys ajenos" --------

echo "[H] Guarda de deploys ajenos (issue #604, MEF-ADR-0031 seccion 4): convenciones acopladas"

DS="$REPO_ROOT/agents/domain-scaffolder.md"
GUARDA=$(grep -F 'startswith("Deploy ")' "$DS" | grep -F 'workflow_runs' || true)

if [ -n "$GUARDA" ]; then
    pass "la plantilla del reutilizable conserva el filtro de runs de la guarda"
else
    fail "no se encontro el filtro de runs de la guarda ('workflow_runs' + startswith(\"Deploy \")) en agents/domain-scaffolder.md"
fi

# La guarda solo se activa para la clase "no despliego el FA que pruebo" (CA-3): la condicion es el
# input vacio, nunca una lista de dominios o de workflows.
if grep -qF "if: inputs.expected_sha == ''" "$DS"; then
    pass "la guarda se condiciona a inputs.expected_sha == '' (sin enumerar dominios)"
else
    fail "la guarda perdio su condicion 'if: inputs.expected_sha == \\'\\''' en agents/domain-scaffolder.md"
fi

# El literal que la guarda busca en los runs ajenos ('deploy') tiene que seguir siendo el nombre del
# job de la plantilla deploy-{kebab}.yml, y su nombre de workflow tiene que seguir empezando con
# 'Deploy ': si alguno se renombra sin mover el literal, la guarda deja de ver a ese invocador EN
# SILENCIO y la carrera del issue #604 vuelve sin senal.
if grep -qE '^name: Deploy \{PascalCase\}' "$DS"; then
    pass "la plantilla deploy-{kebab}.yml conserva un nombre de workflow con prefijo 'Deploy '"
else
    fail "la plantilla deploy-{kebab}.yml ya no se llama 'Deploy {PascalCase}': mueve el prefijo en el filtro de la guarda (Paso 6.1)"
fi

if grep -qE '^  deploy:$' "$DS" && grep -qF 'select(.name == "deploy")' "$DS"; then
    pass "el job 'deploy' de la plantilla y el literal que la guarda busca coinciden"
else
    fail "desalineacion entre el job 'deploy' de deploy-{kebab}.yml y el literal 'select(.name == \"deploy\")' de la guarda"
fi

# Porque la guarda FALLA (no degrada) cuando un run 'Deploy *' no expone un job 'deploy', todo
# workflow del marco que comparta ese prefijo SIN desplegar una Function App (sin job 'deploy')
# debe estar excluido por path (hoy, deploy-projections.yml: jobs build-and-test/publish). Un
# workflow 'Deploy *' que SI declara su propio job 'deploy' (deploy-mcp-{proposito}.yml,
# mcp-scaffolder) conforma la convencion sin necesitar exclusion -- la guarda lo encuentra por el
# nombre del job, no por su path. El patron tolera placeholders ({...}) en el path generado: un
# servidor MCP es parametrico por {Proposito}, asi que no hay un unico literal que excluir.
for agente in "$REPO_ROOT"/agents/*.md; do
    [ "$agente" = "$DS" ] && continue
    grep -qE '^name: Deploy ' "$agente" || continue
    generados=$(grep -oE '\.github/workflows/deploy-[A-Za-z0-9{}.-]+\.yml' "$agente" | sort -u)
    if [ -z "$generados" ]; then
        fail "$(basename "$agente") emite un workflow 'Deploy *' sin un path .github/workflows/deploy-*.yml identificable: no se puede verificar su exclusion en la guarda"
        continue
    fi
    tiene_job_deploy=$(grep -qE '^  deploy:$' "$agente" && echo 1 || echo 0)
    for wf in $generados; do
        if echo "$GUARDA" | grep -qF "select(.path != \"$wf\")"; then
            pass "la guarda excluye $wf ($(basename "$agente"): 'Deploy *' que no despliega ninguna Function App)"
        elif [ "$tiene_job_deploy" = "1" ]; then
            pass "$wf ($(basename "$agente")) declara su propio job 'deploy' -- conforma la convencion de la guarda sin necesitar exclusion por path"
        else
            fail "$wf ($(basename "$agente")) matchea el prefijo 'Deploy ' de la guarda pero no esta excluido por path ni declara un job 'deploy': la guarda abortaria con exit 1 al no encontrarle uno"
        fi
    done
done

# Paso "Esperar la publicacion del worker de proyecciones" (issue #2469): el job y el path que busca
# deben seguir siendo el job 'publish:' y el path que genera projections-scaffolder.
PS="$REPO_ROOT/agents/projections-scaffolder.md"
PASO_WORKER=$(grep -F 'deploy-projections.yml") | select(.id' "$DS" || true)
if grep -qE '^  publish:$' "$PS" && grep -qF 'select(.name == "publish")' "$DS"; then
    pass "el job 'publish' del worker y el literal del paso de espera coinciden"
else
    fail "desalineacion entre el job 'publish:' de projections-scaffolder y el literal 'select(.name == \"publish\")' del paso de espera del worker"
fi
WORKER_PATH=$(grep -oE '\.github/workflows/deploy-projections\.yml' "$PS" | sort -u | head -1)
if [ -n "$PASO_WORKER" ] && [ -n "$WORKER_PATH" ] && echo "$PASO_WORKER" | grep -qF "== \"$WORKER_PATH\""; then
    pass "el paso de espera del worker busca el path que genera projections-scaffolder"
else
    fail "el paso de espera del worker no busca el path .github/workflows/deploy-projections.yml que genera projections-scaffolder"
fi

# Promocion del gate por SHA (issue #2468): la guarda publica el output expected_sha (con 'id' en el
# step) y 'Smoke tests' lo consume. Sin ambos extremos, la promocion queda muerta en silencio.
if grep -qF 'id: guarda_deploys_ajenos' "$DS" && grep -qF 'echo "expected_sha=$SHA" >> "$GITHUB_OUTPUT"' "$DS"; then
    pass "la guarda publica el output expected_sha de la promocion (id + GITHUB_OUTPUT)"
else
    fail "la guarda perdio 'id: guarda_deploys_ajenos' o la escritura de 'expected_sha' a \$GITHUB_OUTPUT en agents/domain-scaffolder.md"
fi
# La funcion definida no basta: si se pierde su invocacion tras la espera, el output nunca se escribe.
if grep -qE '^[[:space:]]+promover_gate_por_sha$' "$DS"; then
    pass "la guarda invoca promover_gate_por_sha tras la espera"
else
    fail "la guarda define promover_gate_por_sha pero ya no la invoca en la rama 'ningun deploy ajeno en vuelo' de agents/domain-scaffolder.md"
fi
if grep -qF 'Api__ExpectedSha: ${{ inputs.expected_sha != '"''"' && inputs.expected_sha || steps.guarda_deploys_ajenos.outputs.expected_sha }}' "$DS"; then
    pass "'Smoke tests' consume el expected_sha del input o el promovido por la guarda"
else
    fail "'Smoke tests' no consume steps.guarda_deploys_ajenos.outputs.expected_sha en Api__ExpectedSha"
fi

# La promocion reconoce el FA bajo prueba comparando el host de base_url con 'app-name:' del workflow
# ajeno: ambos deben derivar el mismo nombre func-{kebab}-{prefix_func} en la plantilla del Paso 5.
APP_NAME_DEPLOY=$(grep -E '^[[:space:]]+app-name: ' "$DS" | grep -F 'func-' | sed -E 's/^[[:space:]]+app-name: //' | sort -u)
BASE_URL_DEPLOY=$(grep -E '^[[:space:]]+base_url: https://func-' "$DS" | sed -E 's#^[[:space:]]+base_url: https://([^/]+)\.azurewebsites\.net.*#\1#' | sort -u)
if [ -n "$APP_NAME_DEPLOY" ] && [ "$APP_NAME_DEPLOY" = "func-{kebab}-{prefix_func}" ] && [ "$APP_NAME_DEPLOY" = "$BASE_URL_DEPLOY" ]; then
    pass "el app-name: de deploy-{kebab}.yml y el host del base_url derivan el mismo FA (func-{kebab}-{prefix_func})"
else
    fail "el 'app-name:' ('$APP_NAME_DEPLOY') y el host del base_url ('$BASE_URL_DEPLOY') de deploy-{kebab}.yml ya no coinciden: la promocion del issue #2468 dejaria de reconocer el FA bajo prueba"
fi

# actions: read en el reutilizable y en los dos jobs invocadores que hacen el 'uses:' (CA-4/CA-5).
# Sin la concesion el run muere en startup_failure SIN annotation: nada mas lo atraparia.
ACTIONS_READ=$(grep -cE '^[[:space:]]+actions: read' "$DS" || true)
if [ "$ACTIONS_READ" -eq 3 ]; then
    pass "las 3 plantillas conceden 'actions: read' (reutilizable + job smoke-tests de deploy-{kebab}.yml + job smoke-tests del global)"
else
    fail "se esperaban 3 concesiones de 'actions: read' en agents/domain-scaffolder.md (reutilizable + 2 invocadores), se encontraron $ACTIONS_READ"
fi

# -------- Bloque I: field-note.sh (cierre documental del planner publicado) --------

echo ""
echo "[I] scripts/field-note.sh: presencia e invocacion desde agents/planner.md"

FIELD_NOTE_SCRIPT="$REPO_ROOT/scripts/field-note.sh"
PLANNER="$REPO_ROOT/agents/planner.md"

if [ -f "$FIELD_NOTE_SCRIPT" ]; then
    pass "field-note.sh: presente"
else
    fail "field-note.sh: ausente"
fi
if [ -x "$FIELD_NOTE_SCRIPT" ]; then
    pass "field-note.sh: bit de ejecucion presente"
else
    fail "field-note.sh: sin bit de ejecucion"
fi
if bash -n "$FIELD_NOTE_SCRIPT" 2>/dev/null; then
    pass "field-note.sh: sintaxis bash valida"
else
    fail "field-note.sh: sintaxis bash invalida"
fi

# El cierre de agents/planner.md queda reducido a redactar el contenido + una
# sola invocacion del script + reportar su salida (CA-5), con la prohibicion
# explicita de crear la rama documental en el checkout principal.
for required in \
    '"${MEFISTO_PACKAGE_ROOT}/scripts/field-note.sh"' \
    '--session-id "$SESSION_ID"' \
    '--timestamp "$CLOSING_TIMESTAMP"' \
    '--field-note "$FIELD_NOTE_LOCAL"' \
    '[ -f "$GLOSSARY_LOCAL" ] || GLOSSARY_PATH=""' \
    'nunca crees la rama documental ahí'; do
    if grep -qF -- "$required" "$PLANNER"; then
        pass "planner: conserva '$required'"
    else
        fail "planner: falta '$required'"
    fi
done

# El cierre YA NO debe reimplementar la mecanica de git en prosa: ninguno de
# estos fragmentos (que SI vivian ahi antes del issue #1296) puede seguir
# presente, o la logica quedaria duplicada entre el prompt y el script.
for forbidden in \
    'git worktree add -b "$DOC_BRANCH"' \
    'git -C "$WORKTREE_DIR" commit' \
    'gh pr create --base "$DEFAULT_BRANCH" --head "$DOC_BRANCH"'; do
    if grep -qF -- "$forbidden" "$PLANNER"; then
        fail "planner: todavia reimplementa la mecanica de cierre en prosa ('$forbidden'); debe delegar en field-note.sh"
    else
        pass "planner: no reimplementa '$forbidden' (delega en field-note.sh)"
    fi
done

# -------- Bloque J: planner interno delega el cierre en mefisto-field-note.sh --------

echo ""
echo "[J] Planner interno: delega el cierre documental en mefisto-field-note.sh (issue #1298)"

MEFISTO_PLANNER="$REPO_ROOT/src/internal/agents/mefisto-planner.md"

# El cierre queda reducido a: identidad estable al inicio (timestamp +
# session-id), redactar la field note con Write y una sola invocacion del
# script, reportando su salida tal cual (CA-1/CA-2).
for required in \
    'SESSION_TIMESTAMP=$(date "+%Y-%m-%d-%H%M")' \
    'SESSION_ID="${SESSION_TIMESTAMP}-$(date +%S)-$(git rev-parse --short=12 HEAD)-$$"' \
    'Nunca escribas la field note, crees una rama documental' \
    'FIELD_NOTE_DIR="$(git rev-parse --show-toplevel)/.mefisto/pipeline/summaries"' \
    'FIELD_NOTE_LOCAL="$FIELD_NOTE_DIR/mefisto-planner-field-note-${SESSION_ID}.md"' \
    '{{mefisto:run mefisto-field-note.sh --agent mefisto-planner --timestamp "$CLOSING_TIMESTAMP" --session-id "$SESSION_ID"}} < "$FIELD_NOTE_LOCAL"' \
    'nunca crees la rama documental ahi'; do
    if grep -qF -- "$required" "$MEFISTO_PLANNER"; then
        pass "mefisto-planner: conserva '$required'"
    else
        fail "mefisto-planner: falta '$required'"
    fi
done

# El cierre YA NO debe reimplementar la mecanica de git en prosa: ninguno de
# estos fragmentos (que SI vivian ahi antes del issue #1298) puede seguir
# presente, o la logica quedaria duplicada entre el prompt y el script. El
# ultimo prohibido no es mecanica de git sino neutralidad (MEF-ADR-0050): el
# borrador de la nota vive en `.mefisto/` (ignorado por Git, dentro del repo),
# nunca en /tmp.
for forbidden in \
    'INITIAL_HEAD_REF=$(git symbolic-ref -q --short HEAD || true)' \
    'INITIAL_DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef' \
    'git worktree add -b "$DOC_BRANCH"' \
    'git -C "$WORKTREE_DIR" commit' \
    'gh pr create --base "$DEFAULT_BRANCH" --head "$DOC_BRANCH"' \
    'CURRENT_HEAD_REF=$(git symbolic-ref -q --short HEAD || true)' \
    'FIELD_NOTE_LOCAL="/tmp'; do
    if grep -qF -- "$forbidden" "$MEFISTO_PLANNER"; then
        fail "mefisto-planner: todavia reimplementa la mecanica de cierre en prosa ('$forbidden'); debe delegar en mefisto-field-note.sh"
    else
        pass "mefisto-planner: no reimplementa '$forbidden' (delega en mefisto-field-note.sh)"
    fi
done

# -------- Bloque K: finales de linea heredados de Azure Functions Core Tools --------

echo ""
echo "[K] domain-scaffolder: normalizacion LF de archivos heredados de func init"

# Acota los chequeos al bloque de normalizacion: ambas rutas aparecen tambien en
# otras secciones del agente y buscarlas en el documento completo daria un falso
# positivo si una dejara de estar cubierta por el loop.
LF_BLOCK=$(awk '
    /^\*\*Normalizar a LF los archivos heredados de `func init`/ { capture=1 }
    capture && /^Despues de `func init`/ { exit }
    capture { print }
' "$DS")

for required in \
    '"$REPO_ROOT/src/<RootNamespace>.{PascalCase}/.gitignore"' \
    '"$REPO_ROOT/src/<RootNamespace>.{PascalCase}/<RootNamespace>.{PascalCase}.csproj"' \
    "tr -d '\\r'" \
    'El comando es idempotente' \
    'no reemplaces ni borres el `.gitignore`'; do
    if grep -qF -- "$required" <<< "$LF_BLOCK"; then
        pass "domain-scaffolder: conserva '$required' en la normalizacion LF"
    else
        fail "domain-scaffolder: falta '$required' en la normalizacion LF de archivos heredados"
    fi
done

if grep -qF -- 'git diff --cached --check' "$DS"; then
    pass "domain-scaffolder: verifica el diff staged, incluidos los archivos nuevos de func init"
else
    fail "domain-scaffolder: falta git diff --cached --check despues de agregar el scaffold"
fi

# -------- Bloque L: bit de ejecucion de tests versionados (issue #1509) --------
#
# _mefisto_test_inventory_scan_lane (src/internal/scripts/lib/mefisto-test-inventory.sh)
# descubre los carriles publicado/interno con `find ... -name 'test-*.sh'` y
# descarta con `[ -x "$file" ] || continue` cualquiera sin bit de ejecucion: ese
# archivo pasa al correrlo a mano con bash, pero nunca entra en la suite
# completa -- sin PASS, sin FAIL, sin linea en el reporte. Este bloque cubre
# tanto el bit en disco (CA-1) como el modo versionado en git (CA-2): un
# `chmod +x` hecho DESPUES de `git add` sin volver a agregar deja el archivo
# ejecutable en el worktree actual pero 100644 en el commit, y el mismo hueco
# reaparece en cualquier otro checkout.

echo ""
echo "[L] Tests versionados con bit de ejecucion (scripts/tests/ y .claude/scripts/tests/, issue #1509)"

# check_test_exec_bits <repo_root> -- imprime una linea por violacion (vacio =
# OK). Alcance identico al de _mefisto_test_inventory_scan_lane: un solo nivel
# (-maxdepth 1) de scripts/tests/ y .claude/scripts/tests/, sin recursar en
# fixtures/. Bucle 'while IFS= read -r' en vez de 'find -perm -u+x' por
# portabilidad bash 3.2/macOS (GNU vs. BSD find difieren en -perm).
check_test_exec_bits() {
    local repo_root="$1"
    local subdir dir file rel

    for subdir in scripts/tests .claude/scripts/tests; do
        dir="$repo_root/$subdir"
        [ -d "$dir" ] || continue
        find "$dir" -maxdepth 1 -type f -name 'test-*.sh' 2>/dev/null | LC_ALL=C sort | while IFS= read -r file; do
            [ -z "$file" ] && continue
            rel="${file#"$repo_root"/}"
            [ -x "$file" ] || printf '%s: sin bit de ejecucion en disco (chmod +x %s)\n' "$rel" "$rel"
        done
    done

    # Modo versionado: un archivo sin trackear no aparece en 'ls-files -s' y
    # por lo tanto se juzga solo por el chequeo de disco de arriba. El pathspec
    # es el directorio a secas y el recorte a un solo nivel lo hace awk: un
    # pathspec con glob ('scripts/tests/test-*.sh') NO equivale a -maxdepth 1
    # porque el '*' de git cruza '/' salvo con la magia :(glob), asi que
    # marcaria archivos de subdirectorios que el inventario nunca escanea.
    # awk parte por TAB (el formato de ls-files -s es '<modo> <sha> <stage>\t<ruta>')
    # para no romperse con rutas que contengan espacios.
    git -C "$repo_root" ls-files -s -- scripts/tests .claude/scripts/tests 2>/dev/null |
        awk -F'\t' '
            {
                split($1, meta, " ")
                if (meta[1] != "100644") next
                path = $2
                n = split(path, seg, "/")
                base = seg[n]
                if (base !~ /^test-/ || base !~ /\.sh$/) next
                dir = substr(path, 1, length(path) - length(base) - 1)
                if (dir != "scripts/tests" && dir != ".claude/scripts/tests") next
                print path
            }' |
        while IFS= read -r rel; do
            [ -z "$rel" ] && continue
            printf '%s: versionado en git con modo 100644 (chmod +x %s && git add %s)\n' "$rel" "$rel" "$rel"
        done
}

L_VIOLATIONS="$(check_test_exec_bits "$REPO_ROOT")"
if [ -z "$L_VIOLATIONS" ]; then
    pass "todos los test-*.sh de scripts/tests/ y .claude/scripts/tests/ tienen bit de ejecucion en disco y en git"
else
    fail "test-*.sh sin bit de ejecucion (en disco o versionado con 100644):
$L_VIOLATIONS"
fi

# Verificacion positiva/negativa (CA-3, mismo patron que el bloque G): sobre un
# repo git temporal, un test-*.sh en modo 644 debe detectarse; el mismo archivo
# en 755 y agregado al indice no debe reportar nada (sin falsos positivos). El
# fixture se limpia siempre.
SYNTH_DIR_L=$(mktemp -d)
git -C "$SYNTH_DIR_L" init -q -b main
git -C "$SYNTH_DIR_L" config user.email "test@local"
git -C "$SYNTH_DIR_L" config user.name "Test"
mkdir -p "$SYNTH_DIR_L/scripts/tests/fixtures"
printf '#!/usr/bin/env bash\necho ok\n' > "$SYNTH_DIR_L/scripts/tests/test-sintetico.sh"
chmod 644 "$SYNTH_DIR_L/scripts/tests/test-sintetico.sh"
# Anidado en 644: fuera del alcance (-maxdepth 1), no debe reportarse nunca.
printf '#!/usr/bin/env bash\necho ok\n' > "$SYNTH_DIR_L/scripts/tests/fixtures/test-anidado.sh"
chmod 644 "$SYNTH_DIR_L/scripts/tests/fixtures/test-anidado.sh"
git -C "$SYNTH_DIR_L" add scripts/tests/test-sintetico.sh scripts/tests/fixtures/test-anidado.sh
git -C "$SYNTH_DIR_L" commit -q -m "base"

HITS_L_NEG="$(check_test_exec_bits "$SYNTH_DIR_L")"
if echo "$HITS_L_NEG" | grep -q 'scripts/tests/test-sintetico\.sh'; then
    pass "[L] detecta un test-*.sh en modo 644 en un repo sintetico"
else
    fail "[L] NO detecto un test-*.sh en modo 644 (guard ciego)"
fi

if echo "$HITS_L_NEG" | grep -q 'fixtures/test-anidado\.sh'; then
    fail "falso positivo de [L]: reporto un test-*.sh anidado, fuera del alcance -maxdepth 1"
else
    pass "[L] ignora un test-*.sh anidado en fixtures/ (mismo alcance que _mefisto_test_inventory_scan_lane)"
fi

chmod 755 "$SYNTH_DIR_L/scripts/tests/test-sintetico.sh"
git -C "$SYNTH_DIR_L" add scripts/tests/test-sintetico.sh
HITS_L_POS="$(check_test_exec_bits "$SYNTH_DIR_L")"
rm -rf "$SYNTH_DIR_L"
if [ -z "$HITS_L_POS" ]; then
    pass "[L] no marca un test-*.sh en modo 755 ya agregado al indice (sin falsos positivos)"
else
    fail "falso positivo de [L] sobre un test-*.sh ya en modo 755: $HITS_L_POS"
fi

# -------- Resumen --------

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
