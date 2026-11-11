#!/usr/bin/env bash
# mefisto-stream-watch.sh -- Visor en vivo del flujo de actividad de un stage
# sobre el JSONL neutral de eventos (issue #878, protocolo de #858/#861).
#
# Uso:
#   .claude/scripts/mefisto-stream-watch.sh
#       Descubre por si solo el *.events.jsonl mas reciente entre los
#       directorios de logs que resuelve mefisto_state_read_paths (canonico
#       primero, legacy despues -- CA-1) y lo sigue en vivo. Cuando aparece un
#       archivo mas nuevo (stage 2, o el siguiente issue de un batch/secuencial)
#       cambia a el solo.
#
#   .claude/scripts/mefisto-stream-watch.sh <ruta-al-archivo>
#       Sigue/inspecciona un *.events.jsonl concreto (p. ej. para revisar una
#       corrida pasada) en vez de descubrir el mas reciente.
#
#   .claude/scripts/mefisto-stream-watch.sh --issues 42,43
#       Restringe el descubrimiento a los eventos de esos issues (por el
#       `-issue-<N>` del nombre de archivo, incluidas las copias
#       .attempt-<k> de los reintentos). Evita que dos corridas concurrentes
#       en panes distintos se crucen los visores (interfaz herdr).
#
#   .claude/scripts/mefisto-stream-watch.sh --newer-than <epoch-segundos>
#       Ignora archivos con mtime anterior a <epoch>: el visor arranca
#       esperando la corrida nueva en vez de mostrar la traza de la corrida
#       ANTERIOR hasta que la nueva empiece a escribirse.
#
# Contexto (issue #434): durante una corrida un `tail -f` del log de eventos
# del pipeline solo ve DOS lineas por stage completo
# ("STAGE 1: writer" / "STAGE 2: reviewer") -- 20+ minutos de
# silencio en el medio, sin forma de notar que el agente esta dando vueltas ni
# de aprender mirando. Este visor sigue incrementalmente el JSONL neutral que
# el runner escribe por stage (`<log_base>.events.jsonl`, protocolo de
# ejecucion y eventos de MEF-ADR-0049, issue #858) y renderiza una linea con
# marca de tiempo por actividad (issue #925): el texto completo de cada
# mensaje (razonamiento o respuesta, sin truncar ni colapsar saltos de linea),
# cada tool al arrancar con su `input_summary` (para que se vea que hace el
# agente MIENTRAS corre, no solo al terminar), el fallo de una tool si lo hay
# (un exito no produce linea -- ya se vio al arrancar) y el cierre del stage
# con sus metricas.
#
# Neutral a runtime (CA-6, MEF-ADR-0049): el parser solo conoce el vocabulario
# de run-events.schema.json (`message`, `tool.started`, `tool.completed`,
# `run.completed`, `run.failed`; `run.started` se reconoce pero no se
# renderiza) -- nunca un nombre de campo propio de un runtime concreto. Un
# campo no disponible (`null` en el JSONL) se muestra como "n/d", nunca como
# un cero fabricado (CA-3).
#
# Solo lectura y autonomo: no modifica ningun pipeline ni archivo existente,
# no escribe mas que en un directorio temporal propio via mktemp, y se puede
# invocar a mano en cualquier terminal contra una corrida en marcha o pasada.
#
# Lectura incremental sin `tail -f` (notas tecnicas del issue): se lleva un
# contador de lineas ya consumidas y se emiten las nuevas con
# `sed -n "$((last+1)),\$p"` cada ~1s -- mas simple y portable que anidar
# `tail -f` y matarlo al cambiar de archivo, y resuelve el cambio de corrida
# con solo comparar la ruta descubierta.
#
# Entorno: macOS con bash 3.2.57 en PATH -- nada de `declare -A` (bash 3.2 no
# la tiene) y toda expansion de un array indexado que puede estar vacio usa el
# idiom `"${arr[@]+"${arr[@]}"}"` (bash 3.2 con `set -u` aborta con "unbound
# variable" ante `"${arr[@]}"` cuando el array no tiene elementos).
#
# Tolerancia a corrupcion (CA-4): una linea que no es JSON valido, o que
# parsea pero no es un objeto, o cuyo `.type` no esta en el vocabulario
# reconocido, se cuenta en "eventos ignorados" (visible en el cierre de
# stage) y NUNCA aborta el visor. La unica excepcion es la ULTIMA linea del
# lote leido en un ciclo: si esa no parsea como JSON se asume que el proceso
# productor la esta escribiendo a medias, y se reintenta en el proximo ciclo
# sin contarla ni consumirla (mismo caveat que documentaba la version anterior
# de este visor sobre la traza cruda del runtime que la version previa seguia).
#
# Testeable sin invocar ningun CLI ni depender de una corrida real: cada
# pieza de logica vive en su propia funcion pura (o casi pura, con estado en
# variables globales explicitas) para que
# .claude/scripts/tests/test-stream-watch.sh pueda extraerlas con el mismo
# patron de test-abort-log-tail.sh (awk sobre "funcname() {" .. "}") y
# evaluarlas sueltas, sin sourcing el archivo completo (evita disparar
# assert_in_mefisto/el chequeo de jq/el bucle principal).

set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/_mefisto-common.sh"
assert_in_mefisto || exit 1

# --- Colores ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

POLL_INTERVAL=1

# Filtros de descubrimiento (ver Uso arriba). Vacios = sin filtro, el
# comportamiento original del visor. Mismo contrato que el porte publicado
# (scripts/stream-watch.sh, issue #690).
ISSUES_CSV=""
NEWER_THAN=""

# Estado runtime (mutado por process_new_lines/render_row a lo largo del
# bucle principal).
TMP_STATE=""
JQ_FILTER_PATH=""
LAST_LINE=0
PREV_EMS=""
IGNORED_COUNT=0
CURRENT_STREAM=""
CURRENT_CWD=""

# write_jq_filter <dest_file>
#
# Escribe en <dest_file> el programa jq que traduce una linea del JSONL
# neutral (run-events.schema.json, issue #858) a una fila TSV lista para
# render_row:
#   "run_started"  -> `cwd` de un `run.started` (issue #925: solo fija el cwd
#                 vigente para relativizar `input_summary`, no imprime fila).
#   "message"  -> kind del turno sin llamada a herramienta ("text"/"thinking")
#                 mas su `text` completo (issue #925).
#   "tool_started" -> nombre + `input_summary` de un `tool.started` (issue
#                 #925: se renderiza al arrancar la tool, no al terminar --
#                 es la unica forma de ver que hace el agente MIENTRAS corre).
#   "tool"     -> nombre + `ok` + `duration_ms` de un `tool.completed` (una
#                 sola fila por herramienta; render_row solo la imprime
#                 cuando `ok == false`, issue #925 -- un exito no aporta nada
#                 que `tool_started` no haya mostrado ya).
#   "terminal" -> cierre de stage (`run.completed`/`run.failed`): status,
#                 runtime, model, session_id, duration_ms, api_duration_ms,
#                 estimated_cost_usd (o cost_usd legado), turns,
#                 tokens.input/output, ttft_ms, denials,
#                 error.kind.
#   "ignored"  -> una linea JSON valida pero no-objeto, o con un `.type` fuera
#                 del vocabulario reconocido (CA-4). Una linea que ni
#                 siquiera es JSON valido nunca llega aqui -- jq aborta antes,
#                 y process_new_lines decide alli si se reintenta o se cuenta
#                 como ignorada (ver su propio comentario).
#
# `cell` sustituye por "-" todo campo nulo o vacio, y NO es cosmetico: la
# fila se lee en el shell con `IFS=$'\t' read`, y el tab es un caracter de
# espacio en blanco para IFS -- bash colapsa dos tabs seguidos en un solo
# separador, asi que un campo vacio en el medio DESPLAZARIA todos los que
# siguen. Con placeholder no hay campo vacio y la posicion se conserva; el
# shell lo traduce de vuelta con is_missing. `@tsv` (dentro de `row`) escapa
# tab/salto de linea/barra invertida de CADA celda como secuencias de dos
# caracteres (`\t`/`\n`/`\\`) antes de unirlas con tabs reales -- por eso
# `text` (de `message`) e `input_summary` (de `tool_started`) viajan intactos
# sin desplazar ningun campo, y el shell los reconstruye con tsv_decode
# (issue #925, `printf '%b'`).
write_jq_filter() {
    local dest="$1"
    cat > "$dest" <<'MEFISTO_STREAM_WATCH_JQ'
def epoch_ms:
  if . == null then null
  else
    (capture("^(?<base>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(\\.(?<frac>[0-9]+))?Z$")) as $c
    | if $c == null then null
      else
        (($c.base + "Z") | strptime("%Y-%m-%dT%H:%M:%SZ") | mktime) as $sec
        | $sec*1000 + (if $c.frac then (($c.frac + "000") | .[0:3] | tonumber) else 0 end)
      end
  end;

def cell: if (. == null or . == "") then "-" else tostring end;
def row: map(cell) | @tsv;

def known_type($t):
  ($t == "run.started" or $t == "message" or $t == "tool.started"
    or $t == "tool.completed" or $t == "run.completed" or $t == "run.failed");

if (type != "object") then ["ignored"] | row
else
  . as $e
  | ($e.type // null) as $t
  | if ($t == null) or (known_type($t) | not) then
      ["ignored"] | row
    elif $t == "run.started" then
      ($e.ts | epoch_ms) as $ems
      | ["run_started", $ems, ($e.cwd // null)] | row
    elif $t == "tool.started" then
      ($e.ts | epoch_ms) as $ems
      | ["tool_started", $ems, ($e.tool // null), ($e.input_summary // null)] | row
    elif $t == "message" then
      ($e.ts | epoch_ms) as $ems
      | (if ($e.kind // "text") == "thinking" then "thinking" else "text" end) as $k
      | ["message", $ems, $k, ($e.text // null)] | row
    elif $t == "tool.completed" then
      ($e.ts | epoch_ms) as $ems
      | ["tool", $ems, ($e.tool // null), $e.ok, ($e.duration_ms // null)] | row
    else
      ($e.ts | epoch_ms) as $ems
      | ["terminal", $ems, $e.status, $e.runtime, ($e.model // null), ($e.session_id // null),
         $e.duration_ms, ($e.api_duration_ms // null), ($e.estimated_cost_usd // $e.cost_usd // null), ($e.turns // null),
         ($e.tokens.input // null), ($e.tokens.output // null), ($e.ttft_ms // null),
         ($e.denials // null), (($e.error.kind) // null)]
        | row
    end
end
MEFISTO_STREAM_WATCH_JQ
}

# stream_matches_issues <basename> <issues_csv>
#
# 0 si el nombre de archivo corresponde a uno de los issues de la lista
# (separada por comas). El match es sobre el segmento `-issue-<N>` seguido de
# `.events.jsonl`, de una copia de reintento (`.attempt-<k>.events.jsonl`, ver
# run_agent en mefisto-tooling-pipeline.sh) o del sufijo de una corrida de
# variante (`-<label>.events.jsonl`, --variant del issue #711): un substring
# simple confundiria el issue 4 con el 42. Con lista vacia matchea todo (sin
# filtro).
stream_matches_issues() {
    local base="$1" csv="$2"
    [ -n "$csv" ] || return 0
    local issue
    for issue in ${csv//,/ }; do
        [ -n "$issue" ] || continue
        case "$base" in
            *"-issue-${issue}.events.jsonl") return 0 ;;
            *"-issue-${issue}.attempt-"*".events.jsonl") return 0 ;;
            *"-issue-${issue}-"*".events.jsonl") return 0 ;;
        esac
    done
    return 1
}

# stream_is_newer_than <ruta> <epoch-segundos>
#
# 0 si el mtime del archivo es >= <epoch> (el mismo segundo cuenta: el
# runner de la interfaz herdr toma su epoch justo antes de lanzar el
# pipeline). Con <epoch> vacio, o si stat no puede leer el archivo, matchea:
# nunca se descarta un archivo por no poder juzgarlo. `stat -f %m` es la
# forma BSD (macOS); el segundo intento cubre el stat de GNU.
stream_is_newer_than() {
    local path="$1" epoch="$2"
    [ -n "$epoch" ] || return 0
    local mtime
    mtime=$(stat -f %m "$path" 2>/dev/null || stat -c %Y "$path" 2>/dev/null)
    [ -n "$mtime" ] || return 0
    [ "$mtime" -ge "$epoch" ]
}

# discover_stream <log_dir>
#
# Imprime por stdout la ruta absoluta del *.events.jsonl mas reciente (por
# mtime) de <log_dir> que pase los filtros ISSUES_CSV/NEWER_THAN, o nada si
# el directorio no existe o ningun candidato pasa (CA-1).
discover_stream() {
    local dir="$1"
    [ -d "$dir" ] || return 0
    local candidate
    while IFS= read -r candidate; do
        [ -n "$candidate" ] || continue
        stream_matches_issues "$(basename "$candidate")" "$ISSUES_CSV" || continue
        stream_is_newer_than "$candidate" "$NEWER_THAN" || continue
        echo "$candidate"
        return 0
    done < <(ls -t "$dir"/*.events.jsonl 2>/dev/null)
    return 0
}

# discover_stream_in_dirs <dir1> [<dir2> ...]
#
# Aplica discover_stream a cada directorio en el orden dado y devuelve el
# primer resultado no vacio (CA-1: canonico primero, legacy despues -- los
# llama main() en ese orden, el mismo que devuelve mefisto_state_read_paths).
# Sin combinar mtimes entre directorios: si el primero tiene algun candidato
# valido, gana aunque el segundo tenga uno mas reciente -- mismo criterio de
# "el primero que exista" que mefisto_state_read_first.
discover_stream_in_dirs() {
    local dir found
    for dir in "$@"; do
        found=$(discover_stream "$dir")
        if [ -n "$found" ]; then
            echo "$found"
            return 0
        fi
    done
    return 0
}

# discover_current_stream
#
# Resuelve los directorios de logs y descubre en ellos (CA-1). Re-resuelve
# con mefisto_state_read_paths en CADA llamada, y eso no es una ineficiencia
# a limpiar: read_paths solo emite las rutas que YA existen, y el modo de uso
# normal del visor es arrancarlo ANTES que el pipeline (es la razon de ser de
# --newer-than, y lo que hace el lanzador de herdr). Resolviendo una
# sola vez al arrancar, un visor lanzado sobre un directorio de logs todavia
# inexistente se quedaria con la lista vacia PARA SIEMPRE y nunca mostraria la
# corrida que nace un segundo despues -- justo el sintoma que el aviso de
# main() promete que se resuelve solo. El costo por ciclo son dos `-e`.
discover_current_stream() {
    local dirs=() d
    while IFS= read -r d; do
        [ -n "$d" ] && dirs+=("$d")
    done < <(mefisto_state_read_paths "logs")
    discover_stream_in_dirs "${dirs[@]+"${dirs[@]}"}"
}

# parse_stream_header <archivo_de_eventos>
#
# Imprime el encabezado de CA-1: el nombre del archivo ya codifica issue,
# stage y agente (`mefisto-tooling-stage-<N>-<agente>-<TS>-issue-<N>.events.jsonl`,
# ver run_agent en mefisto-tooling-pipeline.sh) -- de ahi sale el encabezado
# sin leer el contenido del archivo. Si la ruta no matchea ese patron (una
# ruta manual con otro nombre, o una convencion futura), degrada a mostrar
# el nombre tal cual en vez de fallar.
#
# Los archivos de reintento (`.attempt-<k>`) y los de una corrida de variante
# (`-issue-<N>-<label>`, --variant del issue #711) caen hoy en esa
# degradacion: se ven, pero con el nombre de archivo crudo en vez del
# encabezado formateado. El filtro por issue (stream_matches_issues) si los
# matchea, que es lo que decide si el visor los muestra.
parse_stream_header() {
    local path="$1"
    local base
    base=$(basename "$path")

    if [[ "$base" =~ ^mefisto-tooling-stage-([^-]+)-([^-]+)-([0-9]{8}-[0-9]{6})-issue-([0-9]+)\.events\.jsonl$ ]]; then
        local stage="${BASH_REMATCH[1]}"
        local agent="${BASH_REMATCH[2]}"
        local ts="${BASH_REMATCH[3]}"
        local issue="${BASH_REMATCH[4]}"
        printf '%b\n' "${CYAN}${BOLD}=== issue #${issue} -- stage ${stage} (${agent}) -- ${ts} ===${NC}"
    else
        printf '%b\n' "${CYAN}${BOLD}=== ${base} ===${NC}"
    fi
    printf '%b\n' "${CYAN}${path}${NC}"
}

# is_missing <valor>
#
# 0 si <valor> representa "campo ausente" en una fila del filtro jq: vacio,
# el placeholder "-" que emite `cell` (ver write_jq_filter) o el literal
# "null". Centraliza el contrato de la fila para que los formateadores no
# repitan el triple guard.
is_missing() {
    case "$1" in
        ""|"-"|"null") return 0 ;;
        *) return 1 ;;
    esac
}

# tsv_decode <celda>
#
# Revierte el escapado de `@tsv` (issue #925): una celda ya separada por
# `IFS=$'\t' read` trae `\t`/`\n`/`\\` como secuencias literales de dos
# caracteres (nunca un tab o salto de linea reales -- eso rompería el
# contrato de filas, ver write_jq_filter), y `printf '%b'` las revierte a los
# caracteres reales sin doble-interpretar nada mas: `@tsv` escapa TODO
# backslash de la celda original (incluido uno que preceda a una letra suelta
# como "n" o "t" sin ser una secuencia de escape), asi que lo que le llega a
# `%b` como backslash unico proviene siempre de un backslash real ya
# duplicado por `@tsv` -- nunca deja una secuencia ambigua tipo octal.
#
# Lo que sale de aqui es TEXTO YA DECODIFICADO: imprimirlo hay que hacerlo
# con `%s`, nunca interpolandolo dentro de un formato `%b`. Un segundo pase
# de `%b` reinterpretaria los backslashes que el dato contiene de verdad
# (`\t` -> tab real, `\c` -> corta la salida y se traga el salto de linea).
tsv_decode() {
    printf '%b' "$1"
}

# relativize_path <valor> <cwd>
#
# Si <valor> empieza exactamente por "<cwd>/", devuelve el resto sin ese
# prefijo; en cualquier otro caso (o si <cwd> falta -- CA-2 de #925: sin
# `run.started` previo, p.ej. un archivo pineado que arranca a mitad, no se
# relativiza) devuelve <valor> tal cual. La comparacion es por PREFIJO
# LITERAL, nunca por regex: <cwd> puede traer espacios o caracteres
# especiales de glob, y citarlo dentro del patron de `case` (`"$cwd"/*`)
# fuerza esos caracteres a matchear como texto en vez de como operadores de
# glob -- solo el `/*` final (sin comillas) actua como comodin.
relativize_path() {
    local valor="$1" cwd="$2"
    if is_missing "$cwd" || is_missing "$valor"; then
        printf '%s' "$valor"
        return 0
    fi
    case "$valor" in
        "$cwd"/*)
            printf '%s' "${valor#"$cwd"/}"
            ;;
        *)
            printf '%s' "$valor"
            ;;
    esac
}

# fmt_time_hhmmss <epoch_ms>
#
# Formatea un timestamp epoch-en-milisegundos (el que produce epoch_ms del
# filtro jq) como hora local HH:MM:SS. "--:--:--" si <epoch_ms> falta
# (is_missing: evento sin `.ts` parseable). `date -r` es la forma BSD
# (macOS, el entorno del harness); el segundo intento cubre el `date` de GNU
# por si el visor se corre en Linux.
fmt_time_hhmmss() {
    local ems="$1"
    if is_missing "$ems"; then
        echo "--:--:--"
        return 0
    fi
    local secs=$((ems / 1000))
    date -r "$secs" +%H:%M:%S 2>/dev/null \
        || date -d "@$secs" +%H:%M:%S 2>/dev/null \
        || echo "--:--:--"
}

# fmt_delta_s <prev_epoch_ms> <epoch_ms>
#
# Formatea el delta "+N.Ns" desde la accion anterior -- el reloj que revela
# los round-trips de ~20s (CA-2). "-" si no hay accion anterior en el stage
# actual (primer render tras un cambio de archivo) o si falta algun operando.
fmt_delta_s() {
    local prev="$1" ems="$2"
    if is_missing "$prev" || is_missing "$ems"; then
        printf '%7s' "-"
        return 0
    fi
    awk -v a="$prev" -v b="$ems" 'BEGIN{d=(b-a)/1000; printf "+%5.1fs", d}'
}

# fmt_nd <valor>
#
# <valor> tal cual si esta presente, "n/d" si es un campo ausente
# (is_missing) -- CA-3: turns/costo estimado/tokens/session_id/denials/model nunca
# se muestran como 0 ni en blanco cuando el runtime no los provee.
fmt_nd() {
    local v="$1"
    if is_missing "$v"; then
        echo "n/d"
    else
        printf '%s' "$v"
    fi
}

# fmt_ms_nd <milisegundos>
#
# "<n>ms" cuando <milisegundos> esta presente, "n/d" si es un campo ausente.
# Sin convertir a segundos (a diferencia de ms_to_s): la duracion de una tool
# call y el ttft suelen ser del orden de decenas/cientos de ms, y un decimal
# en segundos perderia esa resolucion.
fmt_ms_nd() {
    local ms="$1"
    if is_missing "$ms"; then
        echo "n/d"
    else
        printf '%sms' "$ms"
    fi
}

# ms_to_s <milisegundos>
#
# "<n>.<d>s" cuando <milisegundos> esta presente, "n/d" si es un campo
# ausente (CA-3): la duracion total del stage y su desglose api/no-api se
# muestran en segundos, con un decimal.
ms_to_s() {
    local ms="$1"
    if is_missing "$ms"; then
        echo "n/d"
    else
        awk -v v="$ms" 'BEGIN{printf "%.1fs", v/1000}'
    fi
}

# render_terminal_summary <hora> <status> <runtime> <model> <session_id>
#   <duration_ms> <api_duration_ms> <estimated_cost_usd_o_cost_usd_legacy>
#   <turns> <tokens_in>
#   <tokens_out> <ttft_ms> <denials> <error_kind> <ignored_count>
#
# Imprime el cierre de stage (CA-2/CA-3): estado (OK si `status=="success"`,
# ERROR con `error_kind` si no), runtime/modelo/session_id, turnos/costo/
# duracion (total, api, no-api), tokens/ttft/denials y el contador de eventos
# ignorados (CA-4). Todo campo ausente se muestra como "n/d" -- nunca como 0
# ni en blanco. No termina el proceso -- el bucle principal sigue esperando
# el siguiente archivo.
render_terminal_summary() {
    local now_str="$1" status="$2" runtime="$3" model="$4" session_id="$5" \
          duration_ms="$6" api_duration_ms="$7" cost_usd="$8" turns="$9" \
          tokens_in="${10}" tokens_out="${11}" ttft_ms="${12}" denials="${13}" \
          error_kind="${14}" ignored_count="${15}"

    # Un terminal con status "success" PUEDE traer `error` no nulo: el
    # contrato lo documenta como la muerte posterior a que el runtime declarara
    # cumplido su contrato (senal, exit distinto de cero), que no invalida el
    # trabajo hecho. Ahi el estado sigue siendo OK -- pero el `kind` se muestra
    # igual (CA-2 pide `error.kind` en el cierre): callarlo perderia la unica
    # senal de que la corrida murio despues de terminar.
    local estado_color estado_txt
    if [ "$status" = "success" ]; then
        estado_color="$GREEN"
        estado_txt="OK"
        is_missing "$error_kind" || estado_txt="OK, con $error_kind posterior"
    else
        estado_color="$RED"
        estado_txt="ERROR"
        is_missing "$error_kind" || estado_txt="ERROR: $error_kind"
    fi

    local dur_disp api_disp nonapi_disp
    dur_disp=$(ms_to_s "$duration_ms")
    api_disp=$(ms_to_s "$api_duration_ms")
    if ! is_missing "$duration_ms" && ! is_missing "$api_duration_ms"; then
        nonapi_disp=$(awk -v a="$duration_ms" -v b="$api_duration_ms" 'BEGIN{printf "%.1fs", (a-b)/1000}')
    else
        nonapi_disp="n/d"
    fi

    echo ""
    printf '%b\n' "${estado_color}${BOLD}--- cierre de stage [${now_str}] (${estado_txt}) ---${NC}"
    printf 'runtime=%s  modelo=%s  session_id=%s\n' "$(fmt_nd "$runtime")" "$(fmt_nd "$model")" "$(fmt_nd "$session_id")"
    printf 'turnos=%s  costo_usd=%s  duracion=%s (api=%s, no-api=%s)\n' \
        "$(fmt_nd "$turns")" "$(fmt_nd "$cost_usd")" "$dur_disp" "$api_disp" "$nonapi_disp"
    printf 'tokens: in=%s out=%s  ttft=%s  denials=%s\n' \
        "$(fmt_nd "$tokens_in")" "$(fmt_nd "$tokens_out")" "$(fmt_ms_nd "$ttft_ms")" "$(fmt_nd "$denials")"
    printf 'eventos ignorados: %s\n' "$ignored_count"
    printf '%b\n' "${estado_color}${BOLD}Esperando el siguiente archivo...${NC}"
    echo ""
}

# render_row <kind> <ts> <p3> <p4> <p5> <p6> <p7> <p8> <p9> <p10> <p11> <p12> <p13> <p14> <p15>
#
# Renderiza una fila TSV ya producida por el filtro jq (write_jq_filter):
#   kind=ignored     -> solo incrementa IGNORED_COUNT (CA-4), sin imprimir
#                       nada.
#   kind=run_started -> p3=cwd (tsv-escapado). Fija CURRENT_CWD para
#                       relativizar el proximo tool_started (issue #925);
#                       no imprime nada ni actualiza PREV_EMS.
#   kind=message     -> p3=kind del turno ("text"/"thinking"), p4=texto
#                       completo (tsv-escapado, issue #925).
#   kind=tool_started -> p3=nombre, p4=input_summary (tsv-escapado, issue
#                       #925).
#   kind=tool        -> p3=nombre, p4=ok, p5=duration_ms -- solo imprime
#                       linea si p4="false" (issue #925: un exito ya se vio
#                       al arrancar via tool_started).
#   kind=terminal    -> p3..p15 = status,runtime,model,session_id,
#                       duration_ms,api_duration_ms,estimated_cost_usd (o
#                       cost_usd legado),turns,
#                       tokens_in,tokens_out,ttft_ms,denials,error_kind
#                       (cierre de stage).
#
# Todo campo ausente llega como el placeholder "-" del filtro (is_missing).
# Actualiza PREV_EMS SOLO cuando la fila produce una linea visible (issue
# #925: un tool_started/message impreso lo actualiza, un tool exitoso
# silenciado NO -- asi el delta de la proxima linea visible sigue revelando
# el tiempo total entre acciones observables, round-trips incluidos). El
# cierre de stage reinicia PREV_EMS e IGNORED_COUNT para la proxima corrida.
render_row() {
    local kind="$1" ts="$2" p3="$3" p4="$4" p5="$5" p6="$6" p7="$7" p8="$8" \
          p9="$9" p10="${10}" p11="${11}" p12="${12}" p13="${13}" p14="${14}" p15="${15}"

    if [ "$kind" = "ignored" ]; then
        IGNORED_COUNT=$((IGNORED_COUNT + 1))
        return 0
    fi

    if [ "$kind" = "run_started" ]; then
        CURRENT_CWD=$(tsv_decode "$p3")
        return 0
    fi

    if [ "$kind" = "terminal" ]; then
        local close_ems="$ts"
        is_missing "$close_ems" && close_ems="$PREV_EMS"
        render_terminal_summary "$(fmt_time_hhmmss "$close_ems")" \
            "$p3" "$p4" "$p5" "$p6" "$p7" "$p8" "$p9" "$p10" "$p11" "$p12" "$p13" "$p14" "$p15" "$IGNORED_COUNT"
        PREV_EMS=""
        IGNORED_COUNT=0
        return 0
    fi

    local now_str delta_str
    now_str=$(fmt_time_hhmmss "$ts")
    delta_str=$(fmt_delta_s "$PREV_EMS" "$ts")

    case "$kind" in
        message)
            # Etiqueta delante del texto: "(pensando)" para `kind=thinking`
            # siempre (CA-1 de #925); "(texto)" solo cuando el texto viene
            # vacio -- con texto presente el turno "text" no lleva etiqueta,
            # el texto mismo ya lo dice.
            local etiqueta="" texto
            [ "$p3" = "thinking" ] && etiqueta="(pensando)"
            texto=$(tsv_decode "$p4")
            if is_missing "$texto"; then
                [ "$p3" != "thinking" ] && etiqueta="(texto)"
                printf '%b\n' "${BLUE}[${now_str}]${NC} ${delta_str}  ${YELLOW}${etiqueta}${NC}"
            else
                local etiqueta_coloreada="" indent primera=1 linea
                [ -n "$etiqueta" ] && etiqueta_coloreada="${YELLOW}${etiqueta}${NC} "
                indent=$(printf '%20s' '')
                printf '%b' "${BLUE}[${now_str}]${NC} ${delta_str}  "
                while IFS= read -r linea || [ -n "$linea" ]; do
                    if [ "$primera" -eq 1 ]; then
                        printf '%b%s\n' "$etiqueta_coloreada" "$linea"
                        primera=0
                    else
                        printf '%s%s\n' "$indent" "$linea"
                    fi
                done <<< "$texto"
            fi
            PREV_EMS="$ts"
            ;;
        tool_started)
            # El nombre de la tool y el resumen van por `%s`, NUNCA
            # interpolados en el formato `%b`: `tsv_decode` ya los decodifico
            # una vez, y un segundo pase de `%b` volveria a interpretar los
            # backslashes que el propio comando contiene -- un
            # `input_summary` de Bash como `sed 's/\t/ /'` imprimiria un tab
            # real en vez del texto del comando, y uno con `\c` TRUNCARIA la
            # linea (incluido su salto de linea) pegando el evento siguiente
            # a esta fila. Solo los codigos de color, que son literales de
            # este script, se interpolan en el `%b`.
            local resumen prefijo
            prefijo="${BLUE}[${now_str}]${NC} ${delta_str}  ${BOLD}"
            resumen=$(tsv_decode "$p4")
            if is_missing "$resumen"; then
                printf '%b%s%b\n' "$prefijo" "$p3" "${NC}"
            else
                resumen=$(relativize_path "$resumen" "$CURRENT_CWD")
                printf '%b%s%b%s\n' "$prefijo" "$p3" "${NC}: " "$resumen"
            fi
            PREV_EMS="$ts"
            ;;
        tool)
            # `ok` es obligatorio en el contrato; un exito ya se vio al
            # arrancar la tool (tool_started) y no aporta nada nuevo, asi que
            # solo el fallo produce linea (issue #925). Inventar una linea
            # para un `ok` ausente mentiria sobre el desenlace de la tool
            # (MEF-ADR-0049: ausente se muestra, no se inventa) -- pero el
            # contrato lo declara obligatorio, asi que esa rama nunca ocurre
            # en la practica.
            if [ "$p4" = "false" ]; then
                printf '%b%s%b\n' "${BLUE}[${now_str}]${NC} ${delta_str}  ${BOLD}" \
                    "$p3" "${NC} fallo ($(fmt_ms_nd "$p5"))"
                PREV_EMS="$ts"
            fi
            ;;
    esac
}

# process_new_lines <archivo_de_eventos>
#
# Un ciclo de lectura incremental (CA-1/CA-2): emite con
# `sed -n "$((LAST_LINE+1)),\$p"` las lineas nuevas desde la ultima vez,
# parsea cada una con el filtro jq y renderiza sus filas via render_row.
#
# Tolerancia de CA-4: si una linea no es JSON valido (jq exit != 0), la
# ULTIMA linea del lote leido se trata como un corte a mitad de escritura --
# no avanza LAST_LINE mas alla de ella y se reintenta en el proximo ciclo,
# cuando ya este completa. Cualquier OTRA linea del lote que falle (hay
# contenido posterior que ya se proceso o se intentara aparte, asi que esta
# ya esta sellada y no es una escritura a medias) se cuenta en IGNORED_COUNT
# y se consume: el visor nunca se queda atascado en una linea irrecuperable.
# Una linea JSON valida pero no-objeto, o con un `.type` fuera del
# vocabulario reconocido, tambien incrementa IGNORED_COUNT -- eso lo resuelve
# el propio filtro jq (fila kind=ignored, ver write_jq_filter), no esta
# funcion. Una linea vacia se cuenta como consumida sin renderizar nada.
process_new_lines() {
    local stream="$1"
    [ -f "$stream" ] || return 0

    local new_content
    new_content=$(sed -n "$((LAST_LINE + 1)),\$p" "$stream" 2>/dev/null)
    [ -z "$new_content" ] && return 0

    local batch_total
    batch_total=$(printf '%s' "$new_content" | awk 'END{print NR}')

    local line_num=$LAST_LINE
    local batch_idx=0
    local line rows rc
    while IFS= read -r line; do
        line_num=$((line_num + 1))
        batch_idx=$((batch_idx + 1))

        if [ -z "$line" ]; then
            LAST_LINE=$line_num
            continue
        fi

        rows=$(printf '%s' "$line" | jq -r -f "$JQ_FILTER_PATH" 2>/dev/null)
        rc=$?

        if [ "$rc" -ne 0 ]; then
            if [ "$batch_idx" -eq "$batch_total" ]; then
                break
            fi
            IGNORED_COUNT=$((IGNORED_COUNT + 1))
            LAST_LINE=$line_num
            continue
        fi

        LAST_LINE=$line_num

        [ -z "$rows" ] && continue

        while IFS=$'\t' read -r kind v2 v3 v4 v5 v6 v7 v8 v9 v10 v11 v12 v13 v14 v15; do
            [ -z "$kind" ] && continue
            render_row "$kind" "$v2" "$v3" "$v4" "$v5" "$v6" "$v7" "$v8" "$v9" "$v10" "$v11" "$v12" "$v13" "$v14" "$v15"
        done <<< "$rows"
    done <<< "$new_content"

    return 0
}

# main [<ruta-al-archivo>]
#
# Bucle principal (CA-1): sin argumentos descubre y sigue el *.events.jsonl
# mas reciente entre los directorios de logs que resuelve
# mefisto_state_read_paths (canonico primero, legacy despues -- via
# discover_current_stream, que los re-resuelve en cada ciclo), cambiando de
# archivo cuando aparece uno mas nuevo; con un argumento sigue/inspecciona esa
# ruta fija sin descubrir otras. Sin ningun directorio de logs todavia, avisa
# en vez de fallar y sigue esperando -- el directorio aparece en cuanto
# arranca un pipeline. Nunca termina por si solo (Ctrl-C lo corta limpiamente
# via el trap de EXIT/INT/TERM, que borra el directorio temporal propio).
main() {
    local pinned_path=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --issues)
                if [ $# -lt 2 ]; then echo "ERROR: falta el valor de --issues" >&2; return 2; fi
                ISSUES_CSV="$2"
                shift 2
                ;;
            --newer-than)
                if [ $# -lt 2 ]; then echo "ERROR: falta el valor de --newer-than" >&2; return 2; fi
                if ! [[ "$2" =~ ^[0-9]+$ ]]; then echo "ERROR: --newer-than debe ser un epoch en segundos (recibido: '$2')" >&2; return 2; fi
                NEWER_THAN="$2"
                shift 2
                ;;
            *)
                pinned_path="$1"
                shift
                ;;
        esac
    done

    if [ -n "$pinned_path" ] && [ ! -f "$pinned_path" ]; then
        echo "ERROR: no existe el archivo de eventos indicado: $pinned_path" >&2
        return 1
    fi

    if ! command -v jq >/dev/null 2>&1; then
        echo "ERROR: este visor requiere jq (no encontrado en PATH). Instalalo (p.ej. 'brew install jq') y reintenta." >&2
        return 1
    fi

    TMP_STATE=$(mktemp -d "${TMPDIR:-/tmp}/mefisto-stream-watch.XXXXXX") || return 1
    trap 'rm -rf "$TMP_STATE"' EXIT
    trap 'rm -rf "$TMP_STATE"; exit 130' INT TERM

    JQ_FILTER_PATH="$TMP_STATE/filter.jq"
    write_jq_filter "$JQ_FILTER_PATH"

    LAST_LINE=0
    PREV_EMS=""
    IGNORED_COUNT=0
    CURRENT_STREAM=""
    CURRENT_CWD=""

    printf '%b\n' "${CYAN}${BOLD}Mefisto -- visor en vivo del flujo de eventos (issue #434/#878)${NC}"
    if [ -n "$pinned_path" ]; then
        echo "Inspeccionando: $pinned_path"
    else
        echo "Descubriendo el archivo de eventos mas reciente..."
        [ -n "$ISSUES_CSV" ] && echo "Filtro de issues: $ISSUES_CSV"
        if [ -n "$NEWER_THAN" ]; then
            printf '%b\n' "${YELLOW}Esperando la traza de esta corrida (el archivo del stage 1 nace cuando arranca${NC}"
            printf '%b\n' "${YELLOW}el primer agente, tras crear el worktree y validar el DoR)...${NC}"
        fi
        if [ -z "$(mefisto_state_read_paths "logs")" ]; then
            printf '%b\n' "${YELLOW}Aviso: todavia no hay ningun directorio de logs del harness resuelto por${NC}"
            printf '%b\n' "${YELLOW}mefisto_state_read_paths. Se creara cuando arranque un pipeline (el visor lo${NC}"
            printf '%b\n' "${YELLOW}reintenta cada ciclo); si esperabas una corrida en curso, lanza el visor${NC}"
            printf '%b\n' "${YELLOW}desde la raiz del repo principal.${NC}"
        fi
    fi
    echo ""

    while true; do
        local stream
        if [ -n "$pinned_path" ]; then
            stream="$pinned_path"
        else
            stream=$(discover_current_stream)
        fi

        if [ -n "$stream" ] && [ "$stream" != "$CURRENT_STREAM" ]; then
            CURRENT_STREAM="$stream"
            LAST_LINE=0
            PREV_EMS=""
            IGNORED_COUNT=0
            CURRENT_CWD=""
            echo ""
            parse_stream_header "$CURRENT_STREAM"
            echo ""
        fi

        [ -n "$CURRENT_STREAM" ] && process_new_lines "$CURRENT_STREAM"

        sleep "$POLL_INTERVAL"
    done
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    main "$@"
fi
