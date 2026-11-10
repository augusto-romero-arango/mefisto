#!/usr/bin/env bash
# next-order.sh -- Calcula el orden topologico de lanzamiento de los issues
# 'estado:listo' abiertos del repo consumidor (issue #940).
#
# Copia hermana deliberada de src/internal/scripts/mefisto-next-order.sh
# (issue #936; --refinement y --json portados en #2079), MEF-ADR-0018 regla
# de tres: el lado publicado no puede
# depender de src/internal/ (MEF-ADR-0019), asi que el algoritmo se duplica en
# vez de compartirse via source. Cualquier fix al calculo del orden (Kahn,
# deteccion de ciclos, bloqueos externos/indirectos) debe aplicarse a AMBAS
# copias.
#
# Diferencia con la copia interna: la ultima linea de la salida es la linea de
# lanzamiento de un comando de secuenciamiento, y ese comando depende del
# runtime del consumidor (MEF-ADR-0050): hoy el unico adaptador publicado es
# Claude Code Plugin y el comando se invoca '/mefisto:sequential'; bajo
# otro runtime el namespace puede diferir. Este script NUNCA hardcodea esa
# decision: la recibe por '--launch-command "<texto>"' (el wrapper de cada
# runtime la pasa), y sin el flag cae al default '/mefisto:sequential' -- el
# unico adaptador publicado hoy.
#
# Diferencia 2 con la copia interna (#2190): este lado separa los 'tipo:infra'
# y los issues sin tipo de las lineas de batch (batch-pipeline.sh y
# parallel-pipeline.sh los saltan) y calcula un lote para '/mefisto:parallel'
# (funcion compute_parallel_batch, mas abajo). En Mefisto todo es 'tipo:tooling'
# y no existe '/mefisto-parallel', asi que esto no se porta a la copia interna.
# El comando del lote tambien llega por flag (MEF-ADR-0050):
# '--parallel-command "<texto>"', default '/mefisto:parallel'.
#
# Uso:
#   scripts/next-order.sh [--refinement] [--json] [--launch-command "<texto>"]
#                         [--parallel-command "<texto>"]
#   (sin flags: opera sobre TODO el universo 'estado:listo' abierto del repo
#   consumidor y emite texto)
#
#   --refinement  Orden de REFINAMIENTO: el universo son los 'estado:borrador'
#                 abiertos. Una dependencia ya 'estado:listo' (abierta) o
#                 cerrada cuenta como satisfecha. Un borrador que depende de
#                 otro va despues de el; entre los disponibles gana el de mayor
#                 numero (el mas reciente primero). Lo consume el modo refinar del planner
#                 publicado y el tablero del planner (MEF-ADR-0055 decision 1:
#                 el orden vive aqui, el tablero solo lo lee). Ultima linea de
#                 texto: 'Siguiente a refinar: #N' (o '(sin borradores
#                 refinables)').
#   --json        Salida estructurada en vez de texto (un objeto JSON en
#                 stdout, mismos exit codes): mode, items[] (position, number,
#                 title, tipo, after[], hasDepsSection), blocked[] (number, by,
#                 reason: external|indirect|pr, y pr cuando reason es 'pr'), inPr[] (number,
#                 title, tipo, pr: los issues en PR, [] en --refinement),
#                 cycles[][] y launch. 'tipo' es el
#                 label 'tipo:*' sin prefijo, o null. 'launch' es
#                 '<--launch-command><numeros>' en modo lanzamiento, y null en
#                 --refinement o sin items. 'launch' EXCLUYE los 'tipo:infra' y
#                 los issues sin tipo (los motores los saltan); 'items[]' los
#                 sigue listando. 'infra' son los numeros de los 'tipo:infra'
#                 lanzables, en el orden de items ([] si no hay). 'parallel' es
#                 { issues, launch } (null en --refinement): el lote para
#                 /mefisto:parallel, por dependencias declaradas -- entra el
#                 lanzable sin ninguna dependencia abierta (grado de entrada
#                 inicial 0 en Kahn), que no es infra ni sin tipo, con a lo sumo
#                 un 'tipo:projection' (la primera del orden, MEF-ADR-0034);
#                 'launch' es '<--parallel-command><numeros>', o null con menos
#                 de 2 issues. No se analizan archivos.
#
# En texto, con 'tipo:infra' lanzables, una linea antes de la de lanzamiento
# sugiere '/mefisto:infra #N' (una invocacion por issue, separadas por ' | ');
# si todos los lanzables son infra o sin tipo, la linea de sequential se
# reemplaza por un aviso sin comando. Con lote parallel de 2+ issues, su linea va
# despues de la de sequential.
#
# Cada linea del orden incluye el label 'tipo:' del issue ('N. #123
# [tipo:feature] Titulo -- tras #A'): el consumidor lo necesita para decidir
# si un tramo va a /mefisto:sequential o podria ir a /mefisto:parallel en su
# lugar. El orden es un unico orden lineal; el lote parallel es solo por
# dependencias declaradas. El modo 'oleadas' del planner publicado usa otro
# criterio (matriz de conflictos por archivo) y no se altera.
#
# Exit codes:
#   0 -- hay al menos un issue lanzable (el orden no quedo vacio)
#   1 -- no hay ningun issue lanzable (universo vacio, o todos los issues
#        quedaron en ciclos, bloqueados y/o en PR)
#   2 -- fallo 'gh issue list', o se invoco con argumentos invalidos
#   (con --json, 0 y 1 emiten igualmente un JSON valido)
#
# El guard de entorno (cwd = repo de Mefisto, o cwd fuera de un repo git)
# tambien sale con 1, con mensaje en stderr: es la convencion de todos los
# scripts publicados, y el bloque C2 de scripts/tests/test-guards.sh la
# verifica script por script.
#
# Universo de analisis (MEF-ADR-0011, Definition of Ready): exactamente los
# issues 'estado:listo' Y abiertos del repo consumidor -- ni borradores ni
# cerrados. El label 'bloqueado' no filtra nada: un issue que lo lleva puesto
# entra igual al analisis, y si su dependencia queda resuelta por el orden
# calculado aqui simplemente entra al orden -- este script nunca muta labels.
#
# Extraccion de dependencias: SOLO dependencias forward de la seccion
# '## Dependencias' ('Depende de #N' / 'Bloqueado por #N', case-insensitive) y SOLO si el
# marcador va al inicio del item (vineta '-'/'*' opcional): 'No depende de #N' o
# el marcador a mitad de linea no cuentan;
# se ignoran 'Bloquea', 'Consumido por' y la prosa libre. Una dependencia
# DENTRO del universo esta abierta por construccion (el listado es --state
# open); para las de FUERA se consulta su estado, y CLOSED/MERGED = satisfecha
# (no genera arista ni bloqueo).
#
# Clasificacion de cada issue del universo -- toda exclusion se reporta:
#   (a) Bloqueo externo: declara al menos una dependencia abierta que NO esta
#       en el universo 'estado:listo' -- excluido del orden, reportado como
#       '#N bloqueado por #M: fuera de estado:listo, estado OPEN'.
#   (b) Ciclo: depende directa o indirectamente de si mismo -- excluido del
#       orden, reportado con sus miembros ('ciclo: #A -> #B -> #A').
#   (c) Bloqueo indirecto: sus dependencias son todas intra-universo, pero al
#       menos una quedo excluida por (a), (b) o (c) -- excluido del orden,
#       reportado como '#N bloqueado por #M: excluido del orden'.
#   (e) En PR (#2451, solo en lanzamiento): ya tiene un PR abierto sin mergear
#       (borradores incluidos) -- excluido del orden, de 'launch', de 'parallel'
#       y de 'infra', reportado como '#N en PR #X: pendiente de merge' y en
#       'inPr[]' del JSON. Esta en PR si algun PR abierto lo lista en
#       'closingIssuesReferences' o su rama empieza con 'worktree-issue-<n>-' o
#       'infra-issue-<n>-' (cubre los PRs 'cierre:manual', que usan Refs); con
#       varios PRs gana el de menor numero. Un issue que depende de uno en PR
#       queda bloqueado con reason 'pr' ('#N bloqueado por #M: espera el merge
#       del PR #X'), y sus dependientes, bloqueados indirectamente; al mergear
#       el PR el issue se cierra y el dependiente vuelve solo (CLOSED =
#       satisfecha). Si 'gh pr list' falla se avisa en stderr y se calcula sin
#       esta clasificacion. En --refinement no se consultan PRs.
#   (d) Lanzable: todas sus dependencias abiertas estan en el orden, antes que
#       el. Entra al orden por Kahn con seleccion golosa segun el modo:
#       en lanzamiento el menor numero disponible en cada paso (numero de
#       issue ascendente); en --refinement el MAYOR (descendente: los
#       borradores recientes primero), sin romper la dependencia, que manda.
#
# No usa 'set -e': 'gh issue view' de una dependencia puede ser un PR, y esa
# falla es esperada -- se cae a 'gh pr view' explicitamente, nunca se propaga
# como abort.

set -uo pipefail

# Guard defensivo: este script es del lado publicado y solo aplica al
# consumidor. No sourcea _pipeline-common.sh (solo hace falta el guard, y
# arrastrar ese archivo aqui sumaria dependencias -- dotnet, colores -- que
# este script no usa).
_REPO_TOP=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "ERROR: no estas en un repositorio git" >&2
    exit 1
}
if [ -f "$_REPO_TOP/.claude-plugin/plugin.json" ]; then
    echo "ERROR: scripts/next-order.sh es del plugin publicado y solo aplica al consumidor." >&2
    echo "Estas en el repo de Mefisto. Usa src/internal/scripts/mefisto-next-order.sh en su lugar." >&2
    exit 1
fi
unset _REPO_TOP

LAUNCH_COMMAND="/mefisto:sequential"
PARALLEL_COMMAND="/mefisto:parallel"
MODE="launch"
AS_JSON=0
USAGE='Uso: scripts/next-order.sh [--refinement] [--json] [--launch-command "<texto>"] [--parallel-command "<texto>"]'

while [ "$#" -gt 0 ]; do
    case "$1" in
        --refinement) MODE="refinement"; shift ;;
        --json) AS_JSON=1; shift ;;
        --launch-command)
            if [ "$#" -lt 2 ]; then
                echo "ERROR: --launch-command requiere un argumento." >&2
                echo "$USAGE" >&2
                exit 2
            fi
            if [ -z "$2" ]; then
                echo "ERROR: --launch-command no admite texto vacio (la ultima linea quedaria sin comando)." >&2
                echo "$USAGE" >&2
                exit 2
            fi
            LAUNCH_COMMAND="$2"
            shift 2
            ;;
        --parallel-command)
            if [ "$#" -lt 2 ]; then
                echo "ERROR: --parallel-command requiere un argumento." >&2
                echo "$USAGE" >&2
                exit 2
            fi
            if [ -z "$2" ]; then
                echo "ERROR: --parallel-command no admite texto vacio (la linea del lote quedaria sin comando)." >&2
                echo "$USAGE" >&2
                exit 2
            fi
            PARALLEL_COMMAND="$2"
            shift 2
            ;;
        *)
            echo "ERROR: argumento desconocido: $1." >&2
            echo "$USAGE" >&2
            exit 2
            ;;
    esac
done

LABEL="estado:listo"
[ "$MODE" = "refinement" ] && LABEL="estado:borrador"

ISSUE_LIMIT=200

if ! ISSUES_JSON=$(gh issue list --label "$LABEL" --state open --limit "$ISSUE_LIMIT" --json number,title,body,labels 2>/dev/null); then
    echo "ERROR: fallo 'gh issue list --label $LABEL --state open'." >&2
    exit 2
fi

# En refinamiento, un 'estado:listo' abierto ya esta refinado: satisface la
# dependencia de un borrador sin formar parte del universo.
LISTO_NUMS=""
if [ "$MODE" = "refinement" ]; then
    if ! LISTO_JSON=$(gh issue list --label "estado:listo" --state open --limit "$ISSUE_LIMIT" --json number 2>/dev/null); then
        echo "ERROR: fallo 'gh issue list --label estado:listo --state open'." >&2
        exit 2
    fi
    LISTO_NUMS=$(echo "$LISTO_JSON" | jq -r '.[].number')
fi

is_listo() {
    local target="$1" n
    for n in $LISTO_NUMS; do
        [ "$n" = "$target" ] && return 0
    done
    return 1
}

NUMS=$(echo "$ISSUES_JSON" | jq -r '.[].number' | sort -n)

# Truncar el universo en silencio daria un orden correcto sobre un grafo
# incompleto: el peor resultado posible aqui, porque parece bueno.
UNIVERSE_COUNT=$(echo "$ISSUES_JSON" | jq -r 'length')
if [ "$UNIVERSE_COUNT" -ge "$ISSUE_LIMIT" ]; then
    echo "ADVERTENCIA: 'gh issue list' devolvio $UNIVERSE_COUNT issues (--limit $ISSUE_LIMIT):" >&2
    echo "el universo puede estar truncado y el orden calculado sobre un grafo incompleto." >&2
fi

# Issues del universo con PR abierto (#2451): 'numero<TAB>pr'. Solo en
# lanzamiento; si la consulta falla se avisa y el orden se calcula sin esta
# exclusion.
PR_MAP=""
if [ "$MODE" = "launch" ]; then
    if PRS_JSON=$(gh pr list --state open --limit 200 --json number,headRefName,closingIssuesReferences 2>/dev/null); then
        PR_MAP=$(echo "$ISSUES_JSON" | jq -r --argjson prs "$PRS_JSON" '
            .[] | .number as $n
            | ($prs | map(select(
                (([.closingIssuesReferences[]?.number] | index($n)) != null)
                or ((.headRefName // "") | (startswith("worktree-issue-\($n)-") or startswith("infra-issue-\($n)-")))
              ) | .number) | min) as $p
            | select($p != null) | "\($n)\t\($p)"')
    else
        echo "ADVERTENCIA: no se pudo consultar PRs abiertos; el orden no excluye issues en PR" >&2
    fi
fi

title_of() {
    echo "$ISSUES_JSON" | jq -r --argjson n "$1" '.[] | select(.number==$n) | .title'
}

body_of() {
    echo "$ISSUES_JSON" | jq -r --argjson n "$1" '.[] | select(.number==$n) | .body'
}

# Label 'tipo:X' de un issue del universo (CA-3): el consumidor lo necesita
# para decidir si un tramo va a /mefisto:sequential o /mefisto:parallel. Si el
# issue no lleva ningun label 'tipo:*' (no deberia pasar, es obligatorio por
# convencion), imprime "tipo:desconocido" en vez de dejar la linea sin
# clasificar en silencio.
tipo_of() {
    local t
    t=$(echo "$ISSUES_JSON" | jq -r --argjson n "$1" \
        '.[] | select(.number==$n) | [.labels[]?.name] | map(select(startswith("tipo:"))) | first // "tipo:desconocido"')
    echo "$t"
}

# Pertenece un numero de issue al universo (lista NUMS)?
in_universe() {
    local target="$1" n
    for n in $NUMS; do
        [ "$n" = "$target" ] && return 0
    done
    return 1
}

# Valor del label 'tipo:*' sin prefijo, o cadena vacia si no tiene (para JSON).
tipo_plain_of() {
    echo "$ISSUES_JSON" | jq -r --argjson n "$1" \
        '.[] | select(.number==$n) | [.labels[]?.name] | map(select(startswith("tipo:"))) | first // "" | sub("^tipo:"; "")'
}

# PR abierto (menor numero) que ya cubre el issue, o vacio (#2451).
in_pr_of() {
    local target="$1" row pr
    while IFS=$'\t' read -r row pr; do
        [ "$row" = "$target" ] && { echo "$pr"; return 0; }
    done <<< "$PR_MAP"
    return 1
}

# Estado (issue o PR) de una dependencia -- solo se consulta para
# dependencias FUERA del universo.
dep_state_of() {
    local dep="$1"
    gh issue view "$dep" --json state -q '.state' 2>/dev/null \
        || gh pr view "$dep" --json state -q '.state' 2>/dev/null \
        || echo ""
}

# Formatea una lista de numeros (args separados) como "#A, #B, #C" ascendente.
format_dep_list() {
    local n out=""
    for n in $(printf '%s\n' "$@" | sort -n); do
        [ -z "$n" ] && continue
        if [ -z "$out" ]; then out="#$n"; else out="$out, #$n"; fi
    done
    echo "$out"
}

# --- Pase 1: leer el grafo del universo entero -------------------------------

NUM=()
TITLE=()
TIPO=()
TIPO_PLAIN=()
HAS_SECTION=()  # 1 si el body declara '## Dependencias'
DEPS_IN=()      # dependencias abiertas intra-universo
EXCLUDED=()     # 1 si ya se sabe que no puede entrar al orden
BLOCKED_MSGS=""
BLOCKED_TSV=""  # numero<TAB>dependencia<TAB>razon[<TAB>pr], para --json
INPR_MSGS=""
INPR_TSV=""     # numero<TAB>pr<TAB>tipo<TAB>titulo, para --json

for ISSUE in $NUMS; do
    if PR_OF_ISSUE=$(in_pr_of "$ISSUE"); then
        INPR_MSGS="${INPR_MSGS}#$ISSUE en PR #$PR_OF_ISSUE: pendiente de merge"$'\n'
        INPR_TSV="${INPR_TSV}$ISSUE"$'\t'"$PR_OF_ISSUE"$'\t'"$(tipo_plain_of "$ISSUE")"$'\t'"$(title_of "$ISSUE")"$'\n'
        continue
    fi
    BODY=$(body_of "$ISSUE")
    DEPS=$(printf '%s\n' "$BODY" \
        | awk '/^##[[:space:]]*[Dd]ependencias/{f=1;next} /^##[[:space:]]/{f=0} f' \
        | grep -ioE '^[[:space:]]*([-*][[:space:]]+)?(Depende de|Bloqueado por)[[:space:]]+#[0-9]+' \
        | grep -oE '[0-9]+' | sort -u)
    if printf '%s\n' "$BODY" | grep -qE '^##[[:space:]]*[Dd]ependencias'; then SECTION=1; else SECTION=0; fi

    INSET=""
    IS_BLOCKED=0
    for DEP in $DEPS; do
        [ "$DEP" = "$ISSUE" ] && continue
        if DEP_PR=$(in_pr_of "$DEP"); then
            IS_BLOCKED=1
            BLOCKED_MSGS="${BLOCKED_MSGS}#$ISSUE bloqueado por #$DEP: espera el merge del PR #$DEP_PR"$'\n'
            BLOCKED_TSV="${BLOCKED_TSV}$ISSUE"$'\t'"$DEP"$'\t'"pr"$'\t'"$DEP_PR"$'\n'
            continue
        fi
        if in_universe "$DEP"; then
            INSET="$INSET $DEP"
            continue
        fi
        is_listo "$DEP" && continue
        case "$(dep_state_of "$DEP")" in CLOSED|MERGED) continue ;; esac
        IS_BLOCKED=1
        BLOCKED_MSGS="${BLOCKED_MSGS}#$ISSUE bloqueado por #$DEP: fuera de $LABEL, estado OPEN"$'\n'
        BLOCKED_TSV="${BLOCKED_TSV}$ISSUE"$'\t'"$DEP"$'\t'"external"$'\n'
    done

    NUM+=("$ISSUE")
    TITLE+=("$(title_of "$ISSUE")")
    TIPO+=("$(tipo_of "$ISSUE")")
    TIPO_PLAIN+=("$(tipo_plain_of "$ISSUE")")
    HAS_SECTION+=("$SECTION")
    DEPS_IN+=("$INSET")
    EXCLUDED+=("$IS_BLOCKED")
done

COUNT=${#NUM[@]}

# Indice (0-based) de un numero de issue dentro del universo.
index_of() {
    local target="$1" i
    for ((i = 0; i < COUNT; i++)); do
        [ "${NUM[i]}" = "$target" ] && { echo "$i"; return 0; }
    done
    return 1
}

# --- Pase 2: Kahn sobre los nodos no excluidos -------------------------------

RESOLVED=()
INDEG=()
for ((i = 0; i < COUNT; i++)); do
    RESOLVED[i]=0
    n=0
    for DEP in ${DEPS_IN[i]}; do
        n=$((n + 1))
    done
    INDEG[i]=$n
done

ORDER=()
progress=1
while [ "$progress" -eq 1 ]; do
    progress=0
    best=-1
    for ((i = 0; i < COUNT; i++)); do
        if [ "${RESOLVED[i]}" -eq 0 ] && [ "${EXCLUDED[i]}" -eq 0 ] && [ "${INDEG[i]}" -eq 0 ]; then
            if [ "$best" -eq -1 ]; then
                best=$i
            elif [ "$MODE" = "refinement" ] && [ "${NUM[i]}" -gt "${NUM[best]}" ]; then
                best=$i
            elif [ "$MODE" != "refinement" ] && [ "${NUM[i]}" -lt "${NUM[best]}" ]; then
                best=$i
            fi
        fi
    done
    if [ "$best" -ge 0 ]; then
        RESOLVED[best]=1
        ORDER+=("$best")
        progress=1
        BEST_NUM=${NUM[best]}
        for ((j = 0; j < COUNT; j++)); do
            if [ "${RESOLVED[j]}" -eq 0 ]; then
                case " ${DEPS_IN[j]} " in
                    *" $BEST_NUM "*) INDEG[j]=$((INDEG[j] - 1)) ;;
                esac
            fi
        done
    fi
done

# --- Pase 3: ciclos entre los nodos que quedaron sin resolver ----------------

CYCLE_MSGS=""
CYCLE_NUMS=""   # numeros de issue que son miembros de algun ciclo
CYCLE_LINES=""  # un ciclo por linea, sus numeros separados por espacio
COLOR=()
STACK=()
for ((i = 0; i < COUNT; i++)); do COLOR[i]="white"; done

stack_index_of() {
    local target="$1" k
    for ((k = 0; k < ${#STACK[@]}; k++)); do
        [ "${STACK[k]}" -eq "$target" ] && { echo "$k"; return 0; }
    done
    return 1
}

emit_cycle() {
    local anchor="$1" pos path n k
    pos=$(stack_index_of "$anchor") || return 0
    path=""
    members=""
    for ((k = pos; k < ${#STACK[@]}; k++)); do
        n=${NUM[${STACK[k]}]}
        case " $CYCLE_NUMS " in *" $n "*) ;; *) CYCLE_NUMS="$CYCLE_NUMS $n" ;; esac
        if [ -z "$path" ]; then path="#$n"; else path="$path -> #$n"; fi
        members="$members $n"
    done
    path="$path -> #${NUM[anchor]}"
    CYCLE_MSGS="${CYCLE_MSGS}ciclo: $path"$'\n'
    CYCLE_LINES="${CYCLE_LINES}${members# }"$'\n'
}

dfs_visit() {
    local u="$1" dep v
    COLOR[u]="gray"
    STACK+=("$u")
    for dep in ${DEPS_IN[u]}; do
        v=$(index_of "$dep") || continue
        [ "${RESOLVED[v]}" -eq 1 ] && continue
        case "${COLOR[v]}" in
            gray) emit_cycle "$v" ;;
            white) dfs_visit "$v" ;;
        esac
    done
    COLOR[u]="black"
    unset 'STACK[${#STACK[@]}-1]'
}

for ((i = 0; i < COUNT; i++)); do
    if [ "${RESOLVED[i]}" -eq 0 ] && [ "${COLOR[i]}" = "white" ]; then
        dfs_visit "$i"
    fi
done

# --- Pase 4: bloqueos indirectos (caso c) ------------------------------------

INDIRECT_MSGS=""
for ((i = 0; i < COUNT; i++)); do
    [ "${RESOLVED[i]}" -eq 1 ] && continue
    [ "${EXCLUDED[i]}" -eq 1 ] && continue
    case " $CYCLE_NUMS " in *" ${NUM[i]} "*) continue ;; esac
    for DEP in ${DEPS_IN[i]}; do
        DEP_IDX=$(index_of "$DEP") || continue
        [ "${RESOLVED[DEP_IDX]}" -eq 1 ] && continue
        INDIRECT_MSGS="${INDIRECT_MSGS}#${NUM[i]} bloqueado por #$DEP: excluido del orden"$'\n'
        BLOCKED_TSV="${BLOCKED_TSV}${NUM[i]}"$'\t'"$DEP"$'\t'"indirect"$'\n'
    done
done

# --- Salida ------------------------------------------------------------------

# Los motores (batch-pipeline.sh, parallel-pipeline.sh) saltan 'tipo:infra' y
# los issues sin tipo: no entran a las lineas de batch. 'items' los conserva.
LAUNCH_NUMS=""
INFRA_NUMS=""
for idx in ${ORDER[@]+"${ORDER[@]}"}; do
    case "${TIPO_PLAIN[idx]}" in
        infra) INFRA_NUMS="$INFRA_NUMS ${NUM[idx]}" ;;
        "") ;;
        *) LAUNCH_NUMS="$LAUNCH_NUMS ${NUM[idx]}" ;;
    esac
done

# Lote para /mefisto:parallel, solo por dependencias declaradas (#2190). Recibe
# el grafo ya construido (ORDER, DEPS_IN, TIPO_PLAIN) y no modifica nada: deja
# los numeros del lote en PARALLEL_NUMS. Entra el lanzable sin aristas
# intra-universo (DEPS_IN vacio = grado de entrada inicial 0), que no es infra
# ni sin tipo, con a lo sumo un 'projection' (MEF-ADR-0034: comparten el worker
# de proyecciones). Orden de items.
PARALLEL_NUMS=""
compute_parallel_batch() {
    local idx has_projection=0 t deps
    PARALLEL_NUMS=""
    for idx in ${ORDER[@]+"${ORDER[@]}"}; do
        deps="${DEPS_IN[idx]}"
        [ -n "${deps// /}" ] && continue
        t="${TIPO_PLAIN[idx]}"
        case "$t" in
            ""|infra) continue ;;
            projection)
                [ "$has_projection" -eq 1 ] && continue
                has_projection=1
                ;;
        esac
        PARALLEL_NUMS="$PARALLEL_NUMS ${NUM[idx]}"
    done
}

PARALLEL_LINE=""
if [ "$MODE" = "launch" ]; then
    compute_parallel_batch
    # shellcheck disable=SC2086
    [ "$(set -- $PARALLEL_NUMS; echo $#)" -ge 2 ] && PARALLEL_LINE="$PARALLEL_COMMAND$PARALLEL_NUMS"
else
    INFRA_NUMS=""
fi

if [ "$AS_JSON" -eq 1 ]; then
    ITEMS_TSV=""
    pos=1
    for idx in ${ORDER[@]+"${ORDER[@]}"}; do
        ITEMS_TSV="${ITEMS_TSV}$pos"$'\t'"${NUM[idx]}"$'\t'"${HAS_SECTION[idx]}"$'\t'"${DEPS_IN[idx]# }"$'\t'"${TIPO_PLAIN[idx]}"$'\t'"${TITLE[idx]}"$'\n'
        pos=$((pos + 1))
    done
    LAUNCH_LINE=""
    [ "$MODE" = "launch" ] && [ -n "$LAUNCH_NUMS" ] && LAUNCH_LINE="$LAUNCH_COMMAND$LAUNCH_NUMS"
    jq -n \
        --arg mode "$MODE" \
        --arg items "$ITEMS_TSV" \
        --arg blocked "$BLOCKED_TSV" \
        --arg inpr "$INPR_TSV" \
        --arg cycles "$CYCLE_LINES" \
        --arg launch "$LAUNCH_LINE" \
        --arg infra "$INFRA_NUMS" \
        --arg pnums "$PARALLEL_NUMS" \
        --arg pline "$PARALLEL_LINE" '
        def lines: split("\n") | map(select(length > 0));
        def nums: split(" ") | map(select(length > 0) | tonumber);
        {
          mode: $mode,
          items: ($items | lines | map(split("\t") | {
            position: (.[0] | tonumber),
            number: (.[1] | tonumber),
            title: (.[5:] | join("\t")),
            tipo: (if .[4] == "" then null else .[4] end),
            after: (.[3] | nums | sort),
            hasDepsSection: (.[2] == "1")
          })),
          blocked: ($blocked | lines | map(split("\t") | {
            number: (.[0] | tonumber), by: (.[1] | tonumber), reason: .[2]
          } + (if .[2] == "pr" then {pr: (.[3] | tonumber)} else {} end))),
          inPr: ($inpr | lines | map(split("\t") | {
            number: (.[0] | tonumber),
            title: (.[3:] | join("\t")),
            tipo: (if .[2] == "" then null else .[2] end),
            pr: (.[1] | tonumber)
          })),
          cycles: ($cycles | lines | map(nums)),
          launch: (if $launch == "" then null else $launch end),
          infra: ($infra | nums),
          parallel: (if $mode != "launch" then null else {
            issues: ($pnums | nums),
            launch: (if $pline == "" then null else $pline end)
          } end)
        }'
    [ "${#ORDER[@]}" -gt 0 ] && exit 0
    exit 1
fi

if [ -z "$CYCLE_MSGS" ] && [ -z "$BLOCKED_MSGS" ] && [ -z "$INDIRECT_MSGS" ] && [ -z "$INPR_MSGS" ]; then
    echo "Sin ciclos ni bloqueos externos."
else
    printf '%s' "$CYCLE_MSGS" "$INPR_MSGS" "$BLOCKED_MSGS" "$INDIRECT_MSGS"
fi
echo

if [ "${#ORDER[@]}" -gt 0 ]; then
    pos=1
    for idx in "${ORDER[@]}"; do
        if [ -z "${DEPS_IN[idx]}" ]; then
            JUST="sin dependencias abiertas"
        else
            # Split intencional: format_dep_list espera args separados, no un unico string.
            # shellcheck disable=SC2086
            JUST="tras $(format_dep_list ${DEPS_IN[idx]})"
        fi
        echo "$pos. #${NUM[idx]} [${TIPO[idx]}] ${TITLE[idx]} -- $JUST"
        pos=$((pos + 1))
    done
    if [ "$MODE" = "refinement" ]; then
        echo "Siguiente a refinar: #${NUM[${ORDER[0]}]}"
    else
        if [ -n "$INFRA_NUMS" ]; then
            # /mefisto:infra recibe un solo issue: una invocacion por numero.
            INFRA_HINT=""
            for n in $INFRA_NUMS; do
                INFRA_HINT="${INFRA_HINT:+$INFRA_HINT | }/mefisto:infra #$n"
            done
            echo "Infra lanzable (desarrollala antes, sin exigirlo): ${INFRA_HINT}"
        fi
        if [ -n "$LAUNCH_NUMS" ]; then
            printf '%s\n' "$LAUNCH_COMMAND$LAUNCH_NUMS"
        else
            echo "Sin issues para $LAUNCH_COMMAND: los lanzables son solo infra o sin tipo."
        fi
        [ -n "$PARALLEL_LINE" ] && printf '%s\n' "$PARALLEL_LINE"
    fi
    exit 0
fi

if [ "$MODE" = "refinement" ]; then
    echo "Siguiente a refinar: (sin borradores refinables)"
else
    printf '%s\n' "$LAUNCH_COMMAND (sin issues lanzables)"
fi
exit 1
