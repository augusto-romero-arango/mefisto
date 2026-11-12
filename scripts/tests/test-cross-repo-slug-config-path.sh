#!/usr/bin/env bash
# test-cross-repo-slug-config-path.sh -- Contrato de ruta efectiva para leer
# `repoSlug` en los tres caminos de draft cross-repo hacia Mefisto (#1534,
# MEF-ADR-0053 decision 4).
#
# Cubre agents/tooling-investigator.md (anclaje "Lee el slug del repo de
# Mefisto (configurable para forks):"): canonico, ambos divergentes
# (prevalece canonico), solo legacy, ausencia de ambos y canonico sin el
# campo opcional `repoSlug`.
#
# agents/planner.md (issue #1640), commands/fix-review.md (issue #1665) y
# agents/tooling-investigator.md (issue #1668) migraron a la fuente neutral publicada: leen
# `repoSlug` via `{{mefisto:config-path}}`, asi que ahora comparte el mismo
# preambulo de resolucion efectiva que el resto de agentes publicados
# (canonico primero, fallback legacy con AVISO, ABORTA si no existe ninguno
# de los dos -- MEF-ADR-0053 seccion 4). El campo en si sigue siendo opcional
# (config presente sin `repoSlug` cae al default), pero la ausencia total del
# archivo de config ya no es tolerada solo para este agente: es una
# consecuencia deliberada de adoptar el contrato neutral compartido, no una
# regresion. Las matrices de planner y fix-review combinan ese preambulo
# compartido con su propio bloque de resolucion del slug.
#
# Aqui solo se ejecutan los bloques extraidos; lo que se verifica leyendo el
# texto (preambulo compartido y ausencia de lecturas directas del config legacy)
# esta en cross-repo-slug-config-path.test.mts.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Los bloques leen el config con el script del paquete; el preambulo que fija su raiz no se extrae.
export MEFISTO_PACKAGE_ROOT="$REPO_ROOT"
PLANNER="$REPO_ROOT/agents/planner.md"
INVESTIGATOR="$REPO_ROOT/agents/tooling-investigator.md"
FIX_REVIEW="$REPO_ROOT/commands/fix-review.md"
PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

DEFAULT_SLUG="augusto-romero-arango/mefisto"

extract_after_anchor() {
    # $1: archivo, $2: substring literal del anclaje que precede el primer ```bash
    local file="$1" anchor="$2"
    awk -v anchor="$anchor" '
        index($0, anchor) { found=1 }
        found && /^```bash$/ { inside=1; next }
        found && inside && /^```$/ { exit }
        found && inside { print }
    ' "$file"
}

# extract_config_preamble <archivo>
#
# El preambulo compartido de resolucion efectiva (canonico/legacy/abort) que
# el adaptador antepone una sola vez cuando el body usa {{mefisto:config-path}}
# -- identico en todo artefacto migrado a la fuente neutral. Se identifica por
# contenido (la linea que exporta MEFISTO_CONFIG_PATH), no por posicion.
extract_config_preamble() {
    local file="$1"
    awk '
        /^```bash$/ { buf=""; inside=1; next }
        inside && /^```$/ { inside=0; if (buf ~ /export MEFISTO_CONFIG_PATH/) { printf "%s", buf; exit } next }
        inside { buf = buf $0 "\n" }
    ' "$file"
}

BLOCK_PLANNER_OWN="$(extract_after_anchor "$PLANNER" '### Slug del repo de Mefisto')"
CONFIG_PREAMBLE="$(extract_config_preamble "$PLANNER")"
BLOCK_PLANNER="$CONFIG_PREAMBLE"$'\n'"$BLOCK_PLANNER_OWN"
BLOCK_INVESTIGATOR_OWN="$(extract_after_anchor "$INVESTIGATOR" 'Lee el slug del repo de Mefisto (configurable para forks):')"
# El mirror del investigator antepone tambien la resolucion de
# {{mefisto:instructions-path}} en el mismo bloque: se aisla la parte de config.
INVESTIGATOR_PREAMBLE="$(extract_config_preamble "$INVESTIGATOR" | awk '{ print } /^export MEFISTO_CONFIG_PATH$/ { exit }')"
BLOCK_INVESTIGATOR="$INVESTIGATOR_PREAMBLE"$'\n'"$BLOCK_INVESTIGATOR_OWN"
BLOCK_FIX_REVIEW_OWN="$(extract_after_anchor "$FIX_REVIEW" 'Lee el slug del repo de Mefisto (configurable para forks):')"
FIX_REVIEW_PREAMBLE="$(extract_config_preamble "$FIX_REVIEW")"
BLOCK_FIX_REVIEW="$FIX_REVIEW_PREAMBLE"$'\n'"$BLOCK_FIX_REVIEW_OWN"

if [ -z "$BLOCK_PLANNER_OWN" ] || [ -z "$CONFIG_PREAMBLE" ] || [ -z "$BLOCK_INVESTIGATOR_OWN" ] || [ -z "$INVESTIGATOR_PREAMBLE" ] || [ -z "$BLOCK_FIX_REVIEW_OWN" ] || [ -z "$FIX_REVIEW_PREAMBLE" ]; then
    fail "no se pudo extraer alguno de los bloques esperados"
    echo "  Resumen: $PASS pass, $FAIL fail"; exit 1
fi

write_json() {
    local path="$1" slug="$2"
    mkdir -p "$(dirname "$path")"
    printf '{"repoSlug":"%s"}\n' "$slug" > "$path"
}

run_block() {
    # $1: bloque bash, $2: directorio raiz del repo temporal, $3: subdirectorio de trabajo relativo
    local block="$1" root="$2" subdir="$3"
    mkdir -p "$root/$subdir"
    (cd "$root/$subdir" && bash -c "$block")
}

run_matrix() {
    # $1: etiqueta, $2: bloque bash a ejecutar, $3: comportamiento esperado
    # sin ningun config -- "default" (cae al default, comportamiento legacy
    # de investigator/fix-review) o "abort" (preambulo compartido de
    # config-path aborta, comportamiento nuevo de planner migrado).
    # $4: modo de cwd -- "nested" (subdirectorio profundo; comportamiento
    # legacy, cwd-independiente porque el bloque hace su propio
    # 'git rev-parse --show-toplevel') o "root" (siempre desde la raiz del
    # repo temporal; el preambulo compartido de {{mefisto:config-path}}
    # resuelve relativo al cwd, MEF-ADR-0053 seccion 4 -- no reimplementa el
    # lookup de la raiz Git, asi que planner migrado ya NO ofrece la garantia
    # de independencia de cwd que su bloque hand-escrito si ofrecia).
    local label="$1" block="$2" no_config_mode="${3:-default}" cwd_mode="${4:-nested}"
    local subdir="nested/sub"
    [ "$cwd_mode" = "root" ] && subdir="."

    local s1="$TMP_DIR/$label-canonico"
    mkdir -p "$s1" && (cd "$s1" && git init -q)
    write_json "$s1/.mefisto/harness.config.json" "org/fork"
    local out
    out=$(run_block "$block" "$s1" "$subdir")
    if [ "$out" = "org/fork" ]; then
        pass "$label: solo canonico resuelve org/fork"
    else
        fail "$label: solo canonico esperaba org/fork y obtuvo '$out'"
    fi

    local s2="$TMP_DIR/$label-ambos"
    mkdir -p "$s2" && (cd "$s2" && git init -q)
    write_json "$s2/.mefisto/harness.config.json" "org/canonico"
    write_json "$s2/.claude/harness.config.json" "org/legacy"
    out=$(run_block "$block" "$s2" "$subdir")
    if [ "$out" = "org/canonico" ]; then
        pass "$label: coexistencia prevalece el canonico"
    else
        fail "$label: coexistencia esperaba org/canonico y obtuvo '$out'"
    fi

    local s3="$TMP_DIR/$label-legacy"
    mkdir -p "$s3" && (cd "$s3" && git init -q)
    write_json "$s3/.claude/harness.config.json" "org/legacy"
    out=$(run_block "$block" "$s3" "$subdir")
    if [ "$out" = "org/legacy" ]; then
        pass "$label: solo legacy resuelve org/legacy"
    else
        fail "$label: solo legacy esperaba org/legacy y obtuvo '$out'"
    fi

    local s4="$TMP_DIR/$label-sin-config"
    mkdir -p "$s4" && (cd "$s4" && git init -q)
    if [ "$no_config_mode" = "abort" ]; then
        out=$(run_block "$block" "$s4" "$subdir" 2>/dev/null); rc=$?
        if [ "$rc" -ne 0 ] && [ -z "$out" ]; then
            pass "$label: sin ningun config aborta (preambulo compartido de config-path, MEF-ADR-0053)"
        else
            fail "$label: sin config esperaba abortar sin stdout y obtuvo rc=$rc out='$out'"
        fi
    else
        out=$(run_block "$block" "$s4" "$subdir")
        if [ "$out" = "$DEFAULT_SLUG" ]; then
            pass "$label: sin ningun config aplica el default"
        else
            fail "$label: sin config esperaba el default y obtuvo '$out'"
        fi
    fi

    local s5="$TMP_DIR/$label-canonico-sin-campo"
    mkdir -p "$s5/.mefisto" && (cd "$s5" && git init -q)
    printf '{"projectName":"demo"}\n' > "$s5/.mefisto/harness.config.json"
    out=$(run_block "$block" "$s5" "$subdir")
    if [ "$out" = "$DEFAULT_SLUG" ]; then
        pass "$label: canonico sin repoSlug aplica el default"
    else
        fail "$label: canonico sin repoSlug esperaba el default y obtuvo '$out'"
    fi

    if [ "$cwd_mode" = "root" ]; then
        pass "$label: se prueba siempre desde la raiz del repo (el preambulo compartido de config-path no es cwd-independiente, MEF-ADR-0053 seccion 4)"
        return
    fi

    local out_root out_nested
    out_root=$(cd "$s1" && bash -c "$block")
    out_nested=$(run_block "$block" "$s1" "otro/nivel/distinto")
    if [ "$out_root" = "org/fork" ] && [ "$out_nested" = "org/fork" ]; then
        pass "$label: el resultado es independiente del cwd dentro del repo"
    else
        fail "$label: el resultado cambio segun el cwd (root='$out_root', nested='$out_nested')"
    fi
}

echo "[1] Matriz de resolucion (CA-3) para planner.md (preambulo compartido + bloque propio)"
run_matrix "planner" "$BLOCK_PLANNER" "abort" "root"

echo "[2] Matriz de resolucion (CA-3) para tooling-investigator.md (preambulo compartido + bloque propio)"
run_matrix "investigator" "$BLOCK_INVESTIGATOR" "abort" "root"

echo "[3] Matriz de resolucion (CA-3) para fix-review.md (preambulo compartido + bloque propio)"
run_matrix "fix-review" "$BLOCK_FIX_REVIEW" "abort" "root"

echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"
[ "$FAIL" -eq 0 ]
