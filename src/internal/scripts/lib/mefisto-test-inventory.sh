#!/usr/bin/env bash
# mefisto-test-inventory.sh -- Inventario centralizado de la suite de tests de
# Mefisto (issue #1438).
#
# Antes de este archivo, cada llamador (un runner, un guard, un humano)
# reconstruia el universo de tests a mano y podia omitir una superficie o
# ejecutar una fuente canonica dos veces a traves de su shim. Esta biblioteca
# es la UNICA autoridad -- repo-only, neutral a runtime (MEF-ADR-0049,
# MEF-ADR-0050) -- que enumera, sin ejecutar ninguna prueba, los tres carriles
# disjuntos de la suite completa:
#
#   publicado            archivos regulares ejecutables 'test-*.sh' bajo
#                        scripts/tests/ (descubrimiento dinamico).
#   interno              archivos regulares ejecutables 'test-*.sh' bajo
#                        .claude/scripts/tests/ (descubrimiento dinamico).
#   canonico-adicional   fuentes canonicas SIN shim homonimo en scripts/tests/
#                        (registro explicito, ver
#                        MEFISTO_TEST_INVENTORY_ADDITIONAL_SOURCES mas abajo).
#
# Los nombres de carril describen SUPERFICIES DEL REPO, no CLIs de runtime
# (MEF-ADR-0050): 'interno' se seguira llamando asi si las pruebas internas se
# mudan algun dia fuera de .claude/scripts/tests/. Lo unico que cambiaria
# entonces es el subdirectorio que escanea mefisto_test_inventory_lane_interno;
# ningun consumidor del contrato se entera.
#
# Uso: se `source`a por ruta relativa al archivo del caller, igual que el resto
# de la libreria interna -- desde src/internal/scripts/:
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/mefisto-test-inventory.sh"
#
# No tiene shim en .claude/scripts/ ni lo necesita: la "Plantilla del shim de
# compatibilidad" de src/internal/scripts/README.md cubre EJECUTABLES invocados
# por una ruta estable (reenvian con `exec`), y esta lib no se ejecuta -- el
# unico shim de lib que existe es el de _mefisto-common.sh, excepcion
# documentada en ese mismo README.
#
# API publica:
#   mefisto_test_inventory_lane_publicado [repo_root]
#   mefisto_test_inventory_lane_interno [repo_root]
#   mefisto_test_inventory_lane_adicional [repo_root]
#   mefisto_test_inventory_list [repo_root]
#   mefisto_test_inventory_validate [repo_root]
#   mefisto_test_inventory_check_canonical_coverage [repo_root]
#
# Formato de salida (CA-1): una linea 'carril<TAB>ruta-relativa' por entrada,
# ordenada de forma determinista (LC_ALL=C, por ruta dentro de cada carril) y
# concatenada en el orden fijo publicado -> interno -> canonico-adicional.
# 'ruta-relativa' nunca depende del cwd del proceso: siempre relativa al
# repo_root resuelto (explicito o via 'git rev-parse --show-toplevel', que
# resuelve igual sea cual sea el subdirectorio desde el que se invoque).
#
# Bash 3.2 (macOS): sin 'declare -A', sin 'mapfile'/'readarray'. Los bucles
# sobre listas multilinea usan 'while IFS= read -r ... done <<< "$var"' (el
# here-string agrega su propio '\n' final, asi que la ultima linea nunca se
# pierde aunque la sustitucion de comando previa haya recortado el suyo --
# mismo idioma que 'validate_mefisto_scope_changes' en _mefisto-common.sh).

# --- Registro de fuentes canonico-adicionales ---------------------------
#
# Lista de rutas relativas al repo_root, una por linea, que el carril
# 'canonico-adicional' expone SIN pasar por un shim en scripts/tests/. Hoy
# esta vacio: su unica entrada (issue #1438) se porto a TypeScript y corre con
# `node --test` (MEF-ADR-0057). Como agregar una:
#
#   1. Confirmar que un shim homonimo en scripts/tests/ duplicaria dentro de
#      la suite publicada una prueba costosa/aislada (si no hay motivo para
#      aislarla, preferir el shim -- es el camino por defecto, no este).
#   2. Agregar una linea a _MEFISTO_TEST_INVENTORY_DEFAULT_ADDITIONAL_SOURCES
#      con la ruta relativa de la nueva fuente.
#   3. mefisto_test_inventory_check_canonical_coverage exige que TODA fuente
#      bajo src/published/scripts/tests/test-*.sh este cubierta por un shim
#      homonimo o por este registro -- omitir ambas decisiones la deja roja.
#
# MEFISTO_TEST_INVENTORY_ADDITIONAL_SOURCES permite override para pruebas
# (test-mefisto-test-inventory.sh la sobreescribe contra un repo fixture);
# sin override, se usa el registro real de Mefisto.
_MEFISTO_TEST_INVENTORY_DEFAULT_ADDITIONAL_SOURCES=''

# _mefisto_test_inventory_repo_root
#
# Imprime por stdout la raiz de repo a usar cuando el caller no pasa
# repo_root explicito: 'git rev-parse --show-toplevel' (resuelve igual desde
# cualquier subdirectorio del repo, CA-5 "ejecucion desde un subdirectorio"),
# con fallback a 'pwd' si no hay git o no estamos en un repo.
_mefisto_test_inventory_repo_root() {
    local root
    root="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$root" ] && { echo "$root"; return 0; }
    pwd
}

# _mefisto_test_inventory_additional_sources
#
# Imprime por stdout el registro de fuentes canonico-adicionales vigente
# (override si MEFISTO_TEST_INVENTORY_ADDITIONAL_SOURCES esta seteada, el
# default real de Mefisto si no), una ruta relativa por linea.
_mefisto_test_inventory_additional_sources() {
    if [ -n "${MEFISTO_TEST_INVENTORY_ADDITIONAL_SOURCES+x}" ]; then
        printf '%s\n' "$MEFISTO_TEST_INVENTORY_ADDITIONAL_SOURCES"
    else
        printf '%s\n' "$_MEFISTO_TEST_INVENTORY_DEFAULT_ADDITIONAL_SOURCES"
    fi
}

# _mefisto_test_inventory_scan_lane <repo_root> <carril> <subdir_relativo>
#
# Descubre dinamicamente los archivos regulares ejecutables 'test-*.sh' bajo
# <repo_root>/<subdir_relativo> (un solo nivel, sin recursar en fixtures/ ni
# otros subdirectorios) e imprime una linea '<carril><TAB><ruta-relativa>'
# por cada uno, ordenadas por ruta con LC_ALL=C (CA-2). Un directorio ausente
# es un no-op silencioso (imprime nada) -- la deteccion de "carril vacio" es
# responsabilidad de mefisto_test_inventory_validate, no de este scanner.
#
# 'find -type f' ya excluye symlinks en si mismo (lstat, no stat) tanto en
# GNU como en BSD find: un symlink a un archivo regular nunca entra aqui, sin
# importar a que apunte.
_mefisto_test_inventory_scan_lane() {
    local repo_root="$1" lane="$2" subdir="$3"
    local dir="$repo_root/$subdir"
    [ -d "$dir" ] || return 0

    local found
    found="$(find "$dir" -maxdepth 1 -type f -name 'test-*.sh' 2>/dev/null)"
    [ -z "$found" ] && return 0

    local file rel
    while IFS= read -r file; do
        [ -z "$file" ] && continue
        [ -x "$file" ] || continue
        rel="${file#"$repo_root"/}"
        printf '%s\n' "$rel"
    done <<< "$found" | LC_ALL=C sort | while IFS= read -r rel; do
        [ -z "$rel" ] && continue
        printf '%s\t%s\n' "$lane" "$rel"
    done
}

# mefisto_test_inventory_lane_publicado [repo_root]
mefisto_test_inventory_lane_publicado() {
    local repo_root="${1:-$(_mefisto_test_inventory_repo_root)}"
    _mefisto_test_inventory_scan_lane "$repo_root" "publicado" "scripts/tests"
}

# mefisto_test_inventory_lane_interno [repo_root]
mefisto_test_inventory_lane_interno() {
    local repo_root="${1:-$(_mefisto_test_inventory_repo_root)}"
    _mefisto_test_inventory_scan_lane "$repo_root" "interno" ".claude/scripts/tests"
}

# mefisto_test_inventory_lane_adicional [repo_root]
#
# Imprime el registro de MEFISTO_TEST_INVENTORY_ADDITIONAL_SOURCES (o el
# default real si no hay override), una linea 'canonico-adicional<TAB>ruta'
# por entrada no vacia, ordenadas por ruta con LC_ALL=C. No verifica
# existencia/ejecutabilidad aqui -- eso es trabajo de
# mefisto_test_inventory_validate (fail-closed, CA-3).
mefisto_test_inventory_lane_adicional() {
    local repo_root="${1:-$(_mefisto_test_inventory_repo_root)}"
    local registry rel
    registry="$(_mefisto_test_inventory_additional_sources)"

    { while IFS= read -r rel; do
        [ -z "$rel" ] && continue
        printf '%s\n' "$rel"
    done <<< "$registry"; } | LC_ALL=C sort | while IFS= read -r rel; do
        [ -z "$rel" ] && continue
        printf '%s\t%s\n' "canonico-adicional" "$rel"
    done
}

# mefisto_test_inventory_list [repo_root]
#
# Concatena los tres carriles en el orden fijo publicado -> interno ->
# canonico-adicional (CA-1): cada uno ya viene ordenado por ruta
# internamente, y el orden ENTRE carriles es siempre el mismo, sin depender
# de locale ni de cwd.
mefisto_test_inventory_list() {
    local repo_root="${1:-$(_mefisto_test_inventory_repo_root)}"
    mefisto_test_inventory_lane_publicado "$repo_root"
    mefisto_test_inventory_lane_interno "$repo_root"
    mefisto_test_inventory_lane_adicional "$repo_root"
}

# mefisto_test_inventory_validate [repo_root]
#
# Valida fail-closed (CA-3) el inventario completo de <repo_root>: rechaza
# carriles vacios, rutas ausentes, no regulares, no ejecutables, symlinks,
# rutas absolutas o que resuelven fuera del repo, y cualquier ruta relativa
# repetida entre carriles (una misma entrada efectiva contada dos veces).
# Cada violacion identifica carril y ruta. Imprime el listado de violaciones
# en stderr y retorna 1 si hay al menos una; retorna 0 si el inventario es
# valido.
mefisto_test_inventory_validate() {
    local repo_root="${1:-$(_mefisto_test_inventory_repo_root)}"
    local real_repo
    real_repo="$(cd "$repo_root" 2>/dev/null && pwd -P)" || {
        echo "ERROR: [inventario-tests] repo_root '$repo_root' no existe o no es accesible" >&2
        return 1
    }

    local violations=()
    local seen=$'\n'
    local count_publicado=0 count_interno=0
    local combined
    combined="$(mefisto_test_inventory_list "$repo_root")"

    local lane relpath full real_full
    while IFS=$'\t' read -r lane relpath; do
        [ -z "$lane" ] && continue

        case "$lane" in
            publicado) count_publicado=$((count_publicado + 1)) ;;
            interno) count_interno=$((count_interno + 1)) ;;
        esac

        case "$relpath" in
            /*)
                violations+=("carril '$lane' ruta '$relpath': debe ser una ruta relativa a la raiz del repo")
                continue
                ;;
        esac

        full="$repo_root/$relpath"
        if [ ! -e "$full" ]; then
            violations+=("carril '$lane' ruta '$relpath': no existe")
            continue
        fi
        if [ -L "$full" ]; then
            violations+=("carril '$lane' ruta '$relpath': es un symlink, no un archivo regular")
            continue
        fi
        if [ ! -f "$full" ]; then
            violations+=("carril '$lane' ruta '$relpath': no es un archivo regular")
            continue
        fi
        if [ ! -x "$full" ]; then
            violations+=("carril '$lane' ruta '$relpath': no es ejecutable")
            continue
        fi

        real_full="$(cd "$(dirname "$full")" 2>/dev/null && pwd -P)/$(basename "$full")"
        case "$real_full" in
            "$real_repo"/*) ;;
            *)
                violations+=("carril '$lane' ruta '$relpath': resuelve fuera del repo ($real_full)")
                continue
                ;;
        esac

        case "$seen" in
            *$'\n'"$relpath"$'\n'*)
                violations+=("carril '$lane' ruta '$relpath': entrada repetida entre carriles")
                ;;
        esac
        seen="${seen}${relpath}"$'\n'
    done <<< "$combined"

    [ "$count_publicado" -eq 0 ] && violations+=("carril 'publicado': no descubrio ninguna entrada en scripts/tests/")
    [ "$count_interno" -eq 0 ] && violations+=("carril 'interno': no descubrio ninguna entrada en .claude/scripts/tests/")

    if [ "${#violations[@]}" -gt 0 ]; then
        echo "ERROR: [inventario-tests] inventario invalido en '$repo_root':" >&2
        local v
        for v in "${violations[@]}"; do
            echo "  - $v" >&2
        done
        return 1
    fi
    return 0
}

# mefisto_test_inventory_check_canonical_coverage [repo_root]
#
# Guard de cobertura (CA-4): recorre src/published/scripts/tests/test-*.sh de
# <repo_root> y exige que cada fuente tenga, o bien un shim homonimo (mismo
# basename, archivo regular no-symlink) en scripts/tests/, o bien figure en
# el registro de MEFISTO_TEST_INVENTORY_ADDITIONAL_SOURCES (ver mas arriba).
# Agregar una fuente canonica nueva sin ninguna de las dos decisiones la deja
# listada en stderr y retorna 1. Sin src/published/scripts/tests/, es un
# no-op (retorna 0).
#
# Deliberadamente NO exige que el shim sea ejecutable: esa es una condicion
# del carril 'publicado' (mefisto_test_inventory_validate/lane_publicado ya
# la verifica para lo que SI queda en el inventario), no de este guard --
# aqui solo importa que la decision "shim vs. registro" quedo tomada para
# cada fuente canonica.
mefisto_test_inventory_check_canonical_coverage() {
    local repo_root="${1:-$(_mefisto_test_inventory_repo_root)}"
    local dir="$repo_root/src/published/scripts/tests"
    [ -d "$dir" ] || return 0

    local found
    found="$(find "$dir" -maxdepth 1 -type f -name 'test-*.sh' 2>/dev/null)"
    [ -z "$found" ] && return 0

    local registry_lines
    registry_lines=$'\n'"$(_mefisto_test_inventory_additional_sources)"$'\n'

    local violations=()
    local file base rel shim
    while IFS= read -r file; do
        [ -z "$file" ] && continue
        base="$(basename "$file")"
        rel="${file#"$repo_root"/}"
        shim="$repo_root/scripts/tests/$base"

        if [ -f "$shim" ] && [ ! -L "$shim" ]; then
            continue
        fi
        case "$registry_lines" in
            *$'\n'"$rel"$'\n'*) continue ;;
        esac
        violations+=("$rel")
    done <<< "$found"

    if [ "${#violations[@]}" -gt 0 ]; then
        echo "ERROR: [inventario-tests] fuentes canonicas sin shim en scripts/tests/ ni registro en canonico-adicional:" >&2
        local v
        for v in "${violations[@]}"; do
            echo "  - $v" >&2
        done
        return 1
    fi
    return 0
}
