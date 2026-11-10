#!/usr/bin/env bash
# mefisto-state.sh -- Resolucion unica del estado interno de Mefisto (issue #856)
#
# Antes de este helper, cada pipeline interno componia a mano la ruta legada
# de un runtime concreto (inventario completo en el issue #856), acoplando la
# operacion del harness a ese runtime aunque esos datos son propios de
# Mefisto. Este archivo resuelve el canonico neutral a runtime
# ".mefisto/pipeline" (MEF-ADR-0049 CA-3, issue #851), con fallback de LECTURA
# a la ruta legada -- MEFISTO_LEGACY_STATE_REL, armada mas abajo -- y SIN
# migracion automatica (MEF-ADR-0049, seccion 3).
#
# Uso: `source`ado por .claude/scripts/_mefisto-common.sh -- ningun caller lo
# sourcea directamente. Nace en src/internal/scripts/lib/ (layout canonico de
# MEF-ADR-0049, issue #851) para no tener que moverlo despues, cuando otro
# adaptador empiece a generarse a partir de esta misma fuente.
#
# Punto de extension: el archivo queda preparado para exportar mas variables
# (MEFISTO_RUNTIME y el mapping de modelos de #857/#858), sin implementarlas
# aqui.
#
# Bash 3.2 (macOS, ver mefisto-stream-watch.sh): nada de `declare -A` ni
# arrays asociativos en este archivo.

# --- MEFISTO_STATE_DIR / MEFISTO_LEGACY_STATE_DIR ---------------------------
#
# Se resuelven UNA vez, al `source`ar este archivo -- no dependen de que el
# caller ya haya llamado assert_in_mefisto (que exporta MEFISTO_REPO_ROOT):
# _mefisto-common.sh sourcea este archivo antes de que corra ninguna de sus
# propias funciones. Por eso la raiz se resuelve aqui con la misma tecnica que
# assert_in_mefisto (`git rev-parse --show-toplevel`), nunca con las
# variables de entorno de un runtime concreto (MEF-ADR-0050; la regla R3 de
# src/internal/scripts/mefisto-neutrality-gate.sh lo prohibe).
#
# `: "${VAR:=default}"` respeta un valor previo del entorno: un test o un
# caller puede fijar MEFISTO_STATE_DIR/MEFISTO_LEGACY_STATE_DIR de antemano
# (p. ej. contra un repo temporal) y este helper no lo pisa.
_mefisto_state_root="$(git rev-parse --show-toplevel 2>/dev/null)" || _mefisto_state_root="$(pwd)"
: "${MEFISTO_STATE_DIR:=$_mefisto_state_root/.mefisto/pipeline}"
# MEFISTO_LEGACY_STATE_REL es el sufijo relativo del estado legado: este
# helper es su UNICO dueno (issue #856 -- ningun otro archivo del lado interno
# vuelve a componer esa ruta), asi que se arma una sola vez aqui y tanto la
# resolucion de abajo como mefisto_state_read_paths la derivan de el. Mantener
# el nombre del directorio oculto en su propia variable, en vez de repetir la
# ruta entera en cada sitio, deja este archivo DENTRO del alcance de la regla
# R3 del gate de neutralidad (issue #1468): la alternativa era una excepcion
# nominal en src/internal/contract/neutrality-allowlist.json, que apaga la
# regla sobre el archivo COMPLETO y lo vuelve un falso precedente para quien
# busque como nombrar un runtime concreto en la fuente neutral.
_mefisto_legacy_hidden_dir=".claude"
MEFISTO_LEGACY_STATE_REL="$_mefisto_legacy_hidden_dir/pipeline"
: "${MEFISTO_LEGACY_STATE_DIR:=$_mefisto_state_root/$MEFISTO_LEGACY_STATE_REL}"
export MEFISTO_STATE_DIR MEFISTO_LEGACY_STATE_DIR MEFISTO_LEGACY_STATE_REL
unset _mefisto_state_root _mefisto_legacy_hidden_dir

# mefisto_state_path <rel> [<root>]
#
# Imprime por stdout la ruta CANONICA para ESCRIBIR <rel> (p. ej.
# "logs/events.log", "summaries/stage-1-writer.md") y crea su directorio
# padre si falta. Nunca escribe en legacy aunque exista (CA-2): siempre
# resuelve contra MEFISTO_STATE_DIR, o contra "<root>/.mefisto/pipeline" si se
# pasa <root> explicito.
#
# <root> cubre el caso de "summaries/", que vive DENTRO del worktree del
# issue y no en el checkout principal (MEFISTO_REPO_ROOT): el caller pasa
# "$WORKTREE_PATH" como <root> para que la ruta resuelva ahi. Sin <root>, usa
# MEFISTO_STATE_DIR tal cual quedo resuelto arriba.
mefisto_state_path() {
    local rel="$1" root="${2:-}"
    local base
    if [ -n "$root" ]; then
        base="$root/.mefisto/pipeline"
    else
        base="$MEFISTO_STATE_DIR"
    fi

    local full="$base/$rel"
    # Sin el `|| return 1`, un mkdir que falla (permisos, un archivo donde
    # deberia ir el directorio) devolveria igual una ruta con exit 0 y el
    # caller la usaria como destino de escritura: el fallo apareceria recien
    # en el redirect, ya sin el motivo original. Se deja el stderr de mkdir a
    # la vista por lo mismo.
    mkdir -p "$(dirname "$full")" || return 1
    echo "$full"
}

# mefisto_state_read_paths <rel> [<root>]
#
# Imprime por stdout, una por linea, las rutas EXISTENTES para <rel>: la
# canonica primero (".mefisto/pipeline/<rel>"), la legacy despues
# ("$MEFISTO_LEGACY_STATE_REL/<rel>") -- CA-3. Vacia si <rel> no existe en
# ninguna de las dos. El caller decide que hacer con la lista: la primera
# (mefisto_state_read_first) o concatenar ambas (p. ej. un historial viejo que
# se queda en legacy para siempre, ver notas tecnicas del issue #856).
#
# Mismo <root> opcional que mefisto_state_path, aplicado a AMBAS bases (la
# canonica y la legacy resuelven contra el mismo <root> cuando se pasa).
#
# Nunca copia, renombra ni borra nada de legacy (CA-4): solo consulta
# existencia con `-e`.
mefisto_state_read_paths() {
    local rel="$1" root="${2:-}"
    local canonical_base legacy_base
    if [ -n "$root" ]; then
        canonical_base="$root/.mefisto/pipeline"
        legacy_base="$root/$MEFISTO_LEGACY_STATE_REL"
    else
        canonical_base="$MEFISTO_STATE_DIR"
        legacy_base="$MEFISTO_LEGACY_STATE_DIR"
    fi

    [ -e "$canonical_base/$rel" ] && echo "$canonical_base/$rel"
    [ -e "$legacy_base/$rel" ] && echo "$legacy_base/$rel"
    return 0
}

# mefisto_state_read_first <rel> [<root>]
#
# Imprime por stdout la primera ruta existente para <rel> (canonica si esta,
# legacy si no) y retorna 0. Si <rel> no existe en ninguna, no imprime nada y
# retorna 1 -- el caller decide si eso es un error o "todavia no hay nada que
# leer".
mefisto_state_read_first() {
    local rel="$1" root="${2:-}"
    local first
    first=$(mefisto_state_read_paths "$rel" "$root" | head -n1)
    [ -n "$first" ] || return 1
    echo "$first"
}
