#!/usr/bin/env bash
# mefisto-test-executor.sh -- Ejecutor supervisado de los tres carriles de
# prueba de Mefisto (issue #1440).
#
# #1438 (mefisto-test-inventory.sh) define QUE archivos existen en cada uno de
# los tres carriles disjuntos ('publicado', 'interno', 'canonico-adicional').
# Esta biblioteca resuelve COMO correrlos: un worker concurrente por carril,
# secuencia preservada dentro de cada worker, continuidad ante un rojo,
# recoleccion de resultados sin escrituras concurrentes al mismo archivo, y
# terminacion limpia de toda la descendencia ante INT/TERM. Es deliberadamente
# ciega a la presentacion final (#1416 combina los resultados y arma el
# resumen humano DESPUES de que esta biblioteca retorna) y ciega al calculo
# del inventario (recibe las entradas ya resueltas, nunca las descubre por su
# cuenta) -- MEF-ADR-0019 (paquete interno, opera solo sobre el propio
# repo) y MEF-ADR-0049/MEF-ADR-0050 (biblioteca repo-only, neutral a
# runtime/proveedor: solo bash + coreutils, ningun CLI de runtime).
#
# Uso: se `source`a por ruta relativa al archivo del caller, como el resto de
# la libreria interna -- desde src/internal/scripts/:
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/mefisto-test-executor.sh"
#
# Sin shim en .claude/scripts/: igual que mefisto-test-inventory.sh, esta lib
# no se ejecuta por una ruta estable -- se sourcea. La "Plantilla del shim de
# compatibilidad" de src/internal/scripts/README.md cubre EJECUTABLES, no
# libs (la unica excepcion documentada ahi es _mefisto-common.sh).
#
# API publica:
#   mefisto_test_executor_entries_for_lane <carril> <inventario>
#   mefisto_test_executor_results_file <run_dir> <carril>
#   mefisto_test_executor_log_dir <run_dir> <carril>
#   mefisto_test_executor_run <repo_root> <run_dir>
#       <carril1_nombre> <carril1_entradas>
#       <carril2_nombre> <carril2_entradas>
#       <carril3_nombre> <carril3_entradas>
#
# Contrato de mefisto_test_executor_run (CA-1..CA-4 del issue #1440):
#
#   - Cada <carrilN_entradas> es una lista de rutas relativas al repo (una por
#     linea, en el orden en que deben ejecutarse), SIN columna de carril --
#     mefisto_test_executor_entries_for_lane la deriva del formato
#     'carril<TAB>ruta' de mefisto_test_inventory_list/lane_* si el caller
#     prefiere partir de ahi, pero cualquier lista en ese formato sirve: esta
#     biblioteca no conoce los nombres de carril de #1438 ('publicado',
#     'interno', 'canonico-adicional') mas que como texto arbitrario para
#     nombrar directorios.
#   - Arranca un worker concurrente por carril (CA-2): cada worker ejecuta sus
#     entradas secuencialmente y en orden, cada entrada exactamente una vez,
#     con cwd en <repo_root> y stdout+stderr combinados en un log propio bajo
#     <run_dir>/<carril>/logs/.
#   - Un exit no-cero de una entrada se registra y NO detiene ni las entradas
#     restantes del mismo carril ni los otros carriles (CA-3).
#   - Tras esperar los tres workers, cada carril tiene su propio
#     <run_dir>/<carril>/results.tsv (CA-3): un archivo por carril evita
#     depender de locks no portables -- dentro de un carril solo su worker
#     escribe, nunca dos a la vez. Formato de cada linea, sin encabezado,
#     campos separados por TAB:
#
#       orden<TAB>ruta<TAB>estado<TAB>exit_code<TAB>inicio<TAB>fin<TAB>duracion_s<TAB>log
#
#     'orden' es la posicion 1-based dentro del carril (coincide con la
#     posicion en <carrilN_entradas>). 'estado' es PASS, FAIL o CANCELLED.
#     'inicio'/'fin' son timestamps ISO-8601 UTC; 'duracion_s' son segundos de
#     reloj. Una entrada CANCELLED (ver mas abajo) nunca llego a correr:
#     exit_code/inicio/fin/duracion_s/log van con el placeholder '-'.
#   - Ante INT/TERM (CA-4): dejan de lanzarse entradas nuevas (chequeo
#     cooperativo antes de cada lanzamiento MAS la senal propagada al grupo de
#     procesos de cada worker, que se lleva de encuentro tambien a la entrada
#     en vuelo y a cualquier descendiente suyo -- no solo al subshell del
#     worker), se espera la terminacion real de los tres workers y la funcion
#     retorna 130 (INT) o 143 (TERM). Toda entrada que no llego a completarse
#     (nunca lanzada, o interrumpida a mitad de ejecucion) queda marcada
#     CANCELLED en el results.tsv de su carril -- la reconciliacion corre
#     SIEMPRE tras el `wait`, sin importar si hubo senal, así que el mismo
#     codigo cubre el camino feliz (no encuentra nada que reconciliar) y el
#     interrumpido. No queda ningun proceso en segundo plano ni ningun
#     temporal fuera de <run_dir> -- logs y results.tsv son evidencia
#     persistente (ignorada por Git), no temporales a limpiar.
#   - Retorna 0 en el camino feliz (incluso si alguna entrada individual
#     termino FAIL: agregar PASS/FAIL/CANCELLED en un veredicto es trabajo del
#     consumidor, no de esta biblioteca), 130 si la corrida termino por INT,
#     143 si termino por TERM.
#
# `set -euo pipefail` del caller: todo pipeline interno de Mefisto lo activa
# (mefisto-tooling-pipeline.sh, mefisto-release.sh, mefisto-batch-pipeline.sh...)
# y el consumidor #1416 no sera la excepcion, asi que esta biblioteca esta
# escrita para sobrevivirlo sin que el caller tenga que apagarlo:
#   - Todo comando cuyo exit no-cero es DATO, no error, va dentro de una lista
#     '||' (la ejecucion de cada entrada, los `wait` de los workers): con
#     set -e heredado, 'cmd; rc=$?' a secas aborta el subshell del worker en la
#     primera entrada roja -- el carril entero quedaria CANCELLED y las
#     entradas siguientes no correrian, exactamente lo contrario de CA-3.
#   - Ningun argumento se lee sin default ('${1:-}'): con set -u, una llamada
#     incompleta debe morir en la validacion explicita de abajo, con un mensaje
#     accionable, no con un 'unbound variable' del shell.
# El bloque [J] de .claude/scripts/tests/test-mefisto-test-executor.sh corre la
# biblioteca bajo `set -euo pipefail` para que la regresion no vuelva en
# silencio.
#
# Cortesia con el shell del caller: mefisto_test_executor_run deja el monitor
# mode ('set -m') y los traps de INT/TERM como los encontro -- los traps
# previos se capturan con 'trap -p' y se restauran con 'eval', en vez de un
# 'trap - INT TERM' que borraria el manejador de limpieza del consumidor.
#
# Bash 3.2 (macOS): sin 'declare -A', sin 'wait -n', sin 'mapfile'/'readarray'.
# Los tres workers se identifican por variable suelta (pid1/pid2/pid3), nunca
# por array indexado por PID -- ni hace falta un array: son siempre tres. Los
# bucles sobre listas multilinea usan 'while IFS= read -r ... done <<< "$var"'
# (el here-string agrega su '\n' final, la ultima linea nunca se pierde).
#
# Grupos de procesos (CA-4): cada worker se lanza en su PROPIA ventana de
# 'set -m' (monitor mode), igual que el watchdog de
# src/runtime/lib/mefisto-process.sh -- un subshell lanzado con '&' bajo
# job control se vuelve lider de su propio grupo (PGID == PID), asi que
# 'kill -<senal> -$pid' apunta al GRUPO completo: el subshell del worker, la
# entrada de prueba que tenga en vuelo en ese instante (hijo directo, mismo
# PGID por herencia) y cualquier proceso que esa entrada haya podido forkear
# sin desprenderse de sesion (el caso comun: un `sleep &` de fixture). Las
# pruebas de este archivo lo verifican con `ps` sobre el arbol real, no solo
# comprobando que se envio la senal al PID del subshell (nota tecnica del
# issue #1440).

# --- Conveniencia: derivar entradas de un carril desde el inventario --------

# mefisto_test_executor_entries_for_lane <carril> <inventario>
#
# Filtra <inventario> (formato 'carril<TAB>ruta', una linea por entrada -- el
# que produce mefisto_test_inventory_list/lane_* de mefisto-test-inventory.sh)
# y devuelve solo las rutas del carril <carril>, en el mismo orden relativo,
# una por linea, sin la columna de carril. Conveniencia para el consumidor:
# NO es la unica forma valida de construir los argumentos <carrilN_entradas>
# de mefisto_test_executor_run -- cualquier lista de rutas relativas al repo,
# una por linea, sirve igual.
mefisto_test_executor_entries_for_lane() {
    local carril="$1" inventario="$2"
    printf '%s\n' "$inventario" | awk -F'\t' -v c="$carril" '$1 == c { print $2 }'
}

# --- Rutas derivadas del run dir --------------------------------------------

# mefisto_test_executor_results_file <run_dir> <carril>
#
# Imprime la ruta del results.tsv de <carril> dentro de <run_dir>. No verifica
# existencia -- antes de que mefisto_test_executor_run corra, el archivo
# todavia no existe.
mefisto_test_executor_results_file() {
    local run_dir="$1" carril="$2"
    printf '%s\n' "$run_dir/$carril/results.tsv"
}

# mefisto_test_executor_log_dir <run_dir> <carril>
#
# Imprime la ruta del directorio de logs de <carril> dentro de <run_dir>.
mefisto_test_executor_log_dir() {
    local run_dir="$1" carril="$2"
    printf '%s\n' "$run_dir/$carril/logs"
}

# --- Helpers internos --------------------------------------------------------

# _mefisto_test_executor_sanitize_name <ruta>
#
# Convierte una ruta relativa ('scripts/tests/test-foo.sh') en un componente
# de nombre de archivo seguro ('scripts_tests_test-foo.sh'), reemplazando cada
# '/' por '_'. Nunca produce un separador de directorio nuevo.
_mefisto_test_executor_sanitize_name() {
    printf '%s' "$1" | tr '/' '_'
}

# _mefisto_test_executor_log_path <log_dir> <orden> <ruta>
#
# Imprime la ruta deterministica del log de la entrada <orden>/<ruta> dentro
# de <log_dir>: '<log_dir>/<orden con 3 digitos>-<ruta saneada>.log'.
_mefisto_test_executor_log_path() {
    local log_dir="$1" orden="$2" ruta="$3"
    local safe
    safe="$(_mefisto_test_executor_sanitize_name "$ruta")"
    printf '%s\n' "$log_dir/$(printf '%03d' "$orden")-$safe.log"
}

# _mefisto_test_executor_has_result <results_file> <orden>
#
# Exit 0 si <results_file> ya tiene una linea cuyo primer campo (TAB) es
# exactamente <orden>; 1 si no. Usado para detectar, tras el `wait`, que
# entradas no llegaron a completarse (CA-4).
_mefisto_test_executor_has_result() {
    local results_file="$1" orden="$2"
    [ -f "$results_file" ] || return 1
    awk -F'\t' -v o="$orden" '$1 == o { found=1 } END { exit(found ? 0 : 1) }' "$results_file"
}

# _mefisto_test_executor_run_one <repo_root> <cancel_file> <orden> <ruta>
#                                 <results_file> <log_dir>
#
# Corre UNA entrada (CA-2: exactamente una vez, cwd en <repo_root>, stdout y
# stderr combinados en su log propio) y anexa su linea de resultado a
# <results_file>. Antes de lanzarla, si <cancel_file> ya existe, no la corre
# en absoluto (parte cooperativa de CA-4: cierra la ventana de carrera entre
# "la entrada anterior termino sola" y "la senal de grupo todavia no aterriza"
# -- sin este chequeo, un worker podria alcanzar a lanzar una entrada mas
# entre que la senal se envia y efectivamente lo mata). Una entrada que no se
# lanza por esto NO deja fila en <results_file> -- la reconciliacion de
# _mefisto_test_executor_reconcile_lane la marca CANCELLED despues del `wait`.
_mefisto_test_executor_run_one() {
    local repo_root="$1" cancel_file="$2" orden="$3" ruta="$4" results_file="$5" log_dir="$6"

    [ -f "$cancel_file" ] && return 0

    local log_file
    log_file="$(_mefisto_test_executor_log_path "$log_dir" "$orden" "$ruta")"

    local start_epoch start_iso
    start_epoch=$(date -u +%s)
    start_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    # '|| exit_code=$?' y NO 'cmd; exit_code=$?': dentro de una lista '||' el
    # exit no-cero de la entrada no dispara el set -e que el worker heredo del
    # caller (ver la cabecera). Con la forma a secas, la primera entrada roja
    # mataria el subshell del worker y el resto del carril quedaria sin correr.
    local exit_code=0
    ( cd "$repo_root" && "$repo_root/$ruta" ) >"$log_file" 2>&1 || exit_code=$?

    local end_epoch end_iso duration
    end_epoch=$(date -u +%s)
    end_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    duration=$((end_epoch - start_epoch))

    local estado="PASS"
    [ "$exit_code" -ne 0 ] && estado="FAIL"

    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$orden" "$ruta" "$estado" "$exit_code" "$start_iso" "$end_iso" "$duration" "$log_file" \
        >> "$results_file"
}

# _mefisto_test_executor_run_lane <repo_root> <run_dir> <carril> <entradas>
#                                  <cancel_file>
#
# Worker de UN carril (CA-2): prepara su directorio (results.tsv vacio, logs/
# creado), y corre <entradas> secuencialmente, una por una, en orden,
# delegando cada una en _mefisto_test_executor_run_one. Pensado para lanzarse
# en su propio grupo de procesos (ver mefisto_test_executor_run, 'set -m'
# antes del '&' que invoca esta funcion en un subshell).
#
# Instala su PROPIO trap de INT/TERM (CA-4), ademas del que instala
# mefisto_test_executor_run en el proceso coordinador: un job asincrono ('&')
# lanzado bajo job control hereda de bash inmunidad a SIGINT (y SIGQUIT) --
# verificado en bash 3.2/macOS -- asi que sin un trap propio, el worker
# ignoraria silenciosamente el INT que 'kill -INT -$pid' manda a su GRUPO
# (aunque la entrada en vuelo, un hijo comun sin trap propio, si muriera) y
# seguiria corriendo el resto de su carril -- exactamente lo que CA-4 prohibe.
# Con este trap, tanto INT como TERM propagados al grupo terminan al worker de
# inmediato (exit 130/143), consistente entre ambas senales: la entrada en
# vuelo (si la habia) nunca llega a escribir su fila de resultado, y
# _mefisto_test_executor_reconcile_lane la deja CANCELLED como a cualquier
# otra que no se completo -- nunca queda registrada como si hubiera
# corrido y fallado con exit 130/143 (ANTES de agregar este trap, la version
# sin el hacia justo eso para INT, el unico camino donde el worker sobrevivia
# a su entrada muerta).
_mefisto_test_executor_run_lane() {
    local repo_root="$1" run_dir="$2" carril="$3" entradas="$4" cancel_file="$5"

    trap 'exit 130' INT
    trap 'exit 143' TERM

    local lane_dir="$run_dir/$carril"
    local results_file="$lane_dir/results.tsv"
    local log_dir="$lane_dir/logs"
    mkdir -p "$log_dir"
    : > "$results_file"

    local orden=0 ruta
    while IFS= read -r ruta; do
        [ -z "$ruta" ] && continue
        orden=$((orden + 1))
        _mefisto_test_executor_run_one "$repo_root" "$cancel_file" "$orden" "$ruta" "$results_file" "$log_dir"
    done <<< "$entradas"
}

# _mefisto_test_executor_reconcile_lane <run_dir> <carril> <entradas>
#
# Tras el `wait` de los tres workers (con o sin senal de por medio), recorre
# <entradas> en orden y, para cada una cuyo <orden> no tiene fila en el
# results.tsv de <carril> (nunca se lanzo, o se interrumpio a mitad de
# ejecucion sin llegar a escribir su fila), anexa una fila CANCELLED con
# placeholders '-' en exit_code/inicio/fin/duracion_s -- salvo 'log', que
# apunta al log parcial si de casualidad quedo creado (la entrada alcanzo a
# escribir algo antes de morir), o '-' si no existe. Correr esto siempre
# (incluso sin senal) es deliberado: en el camino feliz no encuentra nada que
# reconciliar, y el mismo codigo cubre ambos casos sin una rama especial.
_mefisto_test_executor_reconcile_lane() {
    local run_dir="$1" carril="$2" entradas="$3"

    local lane_dir="$run_dir/$carril"
    local results_file="$lane_dir/results.tsv"
    local log_dir="$lane_dir/logs"
    mkdir -p "$log_dir"
    [ -f "$results_file" ] || : > "$results_file"

    local orden=0 ruta
    while IFS= read -r ruta; do
        [ -z "$ruta" ] && continue
        orden=$((orden + 1))
        if ! _mefisto_test_executor_has_result "$results_file" "$orden"; then
            local log_file
            log_file="$(_mefisto_test_executor_log_path "$log_dir" "$orden" "$ruta")"
            [ -f "$log_file" ] || log_file="-"
            printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
                "$orden" "$ruta" "CANCELLED" "-" "-" "-" "-" "$log_file" \
                >> "$results_file"
        fi
    done <<< "$entradas"
}

# _mefisto_test_executor_on_signal <señal>
#
# Handler comun para INT y TERM (CA-4). Dos efectos, en este orden:
#   1. Crea el cancel-file compartido: cierra la ventana cooperativa (ver
#      _mefisto_test_executor_run_one) para que ningun worker lance una
#      entrada mas despues de esto.
#   2. Propaga <señal> al GRUPO de procesos de cada worker todavia vivo
#      (kill -<señal> -$pid): se lleva la entrada en vuelo (si hay una) y
#      cualquier descendiente suyo, no solo el subshell del worker. La forma
#      'kill -<señal> -$pid' (bandera pegada al nombre de la senal) es
#      deliberada y NO intercambiable con 'kill -s <señal> -$pid': verificado
#      en bash 3.2 (macOS) que la segunda forma revienta con "invalid signal
#      specification" -- ese builtin no acepta un PID negativo como argumento
#      posicional cuando la senal llega via '-s'.
#   3. Sigue con un SIGKILL de refuerzo al MISMO grupo, incondicional. No es
#      redundante: un descendiente que la propia entrada de prueba haya
#      lanzado con '&' (un fixture de sleeper que hace 'sleep 999 &' antes de
#      dormir el, por ejemplo) hereda de bash la inmunidad automatica a
#      SIGINT/SIGQUIT que el shell concede a los jobs asincronos no
#      interactivos -- verificado en bash 3.2/macOS que ese descendiente
#      sobrevive intacto a un 'kill -INT' de grupo (mientras que el proceso en
#      primer plano de esa misma entrada SI muere, por no tener esa inmunidad)
#      -- SIGTERM no tiene esa inmunidad, pero para no depender de esa
#      asimetria entre senales, CA-4 ("no deja procesos en segundo plano")
#      se cumple igual para ambas: SIGKILL no puede ignorarse ni bloquearse
#      nunca, por ningun proceso.
# Usa variables globales (prefijo _MEFISTO_TEST_EXECUTOR_), nunca locals de
# mefisto_test_executor_run: un trap se dispara con la pila de llamadas tal
# cual estaba en el instante de la senal, y depender de ese detalle de
# alcance dinamico es mas fragil que un puñado de globales que la propia
# mefisto_test_executor_run resetea al empezar cada corrida.
#
# Los tres globales se inicializan aqui, al sourcear, para que la funcion sea
# legible bajo 'set -u' aunque alguien la invoque antes de la primera corrida.
_MEFISTO_TEST_EXECUTOR_SIGNAL=""
_MEFISTO_TEST_EXECUTOR_CANCEL_FILE=""
_MEFISTO_TEST_EXECUTOR_WORKER_PIDS=""
_mefisto_test_executor_on_signal() {
    local senal="$1"
    _MEFISTO_TEST_EXECUTOR_SIGNAL="$senal"
    [ -n "$_MEFISTO_TEST_EXECUTOR_CANCEL_FILE" ] && : > "$_MEFISTO_TEST_EXECUTOR_CANCEL_FILE" 2>/dev/null

    local pid
    for pid in $_MEFISTO_TEST_EXECUTOR_WORKER_PIDS; do
        # Fallback al PID suelto si el grupo no existe: 'set -m' puede no
        # conceder job control en algun entorno (shell sin terminal de
        # control), y ahi el worker se queda en el grupo del coordinador, con
        # lo que 'kill -SENAL -$pid' falla por grupo inexistente. Matar al
        # coordinador por error no es un riesgo: '-$pid' solo puede resolver a
        # un grupo cuyo lider es ese worker recien forkeado, nunca al propio.
        kill -"$senal" -"$pid" 2>/dev/null || kill -"$senal" "$pid" 2>/dev/null
        kill -9 -"$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null
    done
    return 0
}

# --- Entry point --------------------------------------------------------

# mefisto_test_executor_run <repo_root> <run_dir>
#                            <carril1_nombre> <carril1_entradas>
#                            <carril2_nombre> <carril2_entradas>
#                            <carril3_nombre> <carril3_entradas>
#
# Ver el contrato completo en la cabecera de este archivo. Devuelve 0, 130
# (INT) o 143 (TERM) como CODIGO DE RETORNO de la funcion (capturar con
# `mefisto_test_executor_run ...; rc=$?`) -- nunca por stdout: esta funcion no
# imprime nada por si misma (CA-1, "no imprime un UI final").
mefisto_test_executor_run() {
    local repo_root="${1:-}" run_dir="${2:-}"
    local carril1="${3:-}" entradas1="${4:-}"
    local carril2="${5:-}" entradas2="${6:-}"
    local carril3="${7:-}" entradas3="${8:-}"

    if [ -z "$repo_root" ] || [ -z "$run_dir" ] || [ -z "$carril1" ] || [ -z "$carril2" ] || [ -z "$carril3" ]; then
        echo "ERROR: [ejecutor-tests] repo_root, run_dir y los tres nombres de carril son obligatorios" >&2
        return 1
    fi

    mkdir -p "$run_dir" || {
        echo "ERROR: [ejecutor-tests] no se pudo crear run_dir '$run_dir'" >&2
        return 1
    }

    _MEFISTO_TEST_EXECUTOR_CANCEL_FILE="$run_dir/.cancel"
    rm -f "$_MEFISTO_TEST_EXECUTOR_CANCEL_FILE"
    _MEFISTO_TEST_EXECUTOR_SIGNAL=""
    _MEFISTO_TEST_EXECUTOR_WORKER_PIDS=""

    # El trap de INT/TERM se instala DESPUES del bloque 'set -m'/'set +m', no
    # antes (verificado en bash 3.2/macOS): activar monitor mode reinicializa
    # la disposicion de SIGINT para el propio proceso como parte de su gestion
    # de senales de job control, y eso se lleva de encuentro un trap para INT
    # que ya estuviera instalado -- un `trap ... INT` puesto ANTES de `set -m`
    # deja de disparar (el proceso muere por la accion por defecto en vez de
    # correr el handler), aun despues de un `set +m` posterior. TERM no sufre
    # esto (job control no lo gestiona), pero para no depender de esa asimetria
    # ambos traps se instalan en el mismo lugar, ya con los tres workers
    # arrancados y sus PID capturados.
    # Traps y monitor mode del caller: se capturan ANTES de tocarlos y se
    # restauran al final, para no dejar al consumidor sin su propio manejador
    # de limpieza de INT/TERM (ni con job control encendido si no lo estaba).
    local prev_trap_int prev_trap_term prev_monitor=0
    prev_trap_int="$(trap -p INT)"
    prev_trap_term="$(trap -p TERM)"
    case "$-" in *m*) prev_monitor=1 ;; esac

    local pid1 pid2 pid3
    set -m
    ( _mefisto_test_executor_run_lane "$repo_root" "$run_dir" "$carril1" "$entradas1" "$_MEFISTO_TEST_EXECUTOR_CANCEL_FILE" ) &
    pid1=$!
    ( _mefisto_test_executor_run_lane "$repo_root" "$run_dir" "$carril2" "$entradas2" "$_MEFISTO_TEST_EXECUTOR_CANCEL_FILE" ) &
    pid2=$!
    ( _mefisto_test_executor_run_lane "$repo_root" "$run_dir" "$carril3" "$entradas3" "$_MEFISTO_TEST_EXECUTOR_CANCEL_FILE" ) &
    pid3=$!
    [ "$prev_monitor" -eq 1 ] || set +m

    _MEFISTO_TEST_EXECUTOR_WORKER_PIDS="$pid1 $pid2 $pid3"

    trap '_mefisto_test_executor_on_signal INT' INT
    trap '_mefisto_test_executor_on_signal TERM' TERM

    # Primer `wait`: en el camino feliz espera a que los tres terminen solos.
    # Si llega INT/TERM, el trap corre (manda la senal al grupo de cada
    # worker) y este `wait` puede retornar antes de que esos workers hayan
    # terminado de morir -- el segundo bloque de `wait` (uno por PID, no un
    # `wait -n`: no existe en bash 3.2) cierra esa ventana sin importar el
    # comportamiento exacto de la version de bash que lo corre.
    #
    # Los cuatro `wait` van en lista '||': el exit no-cero de un worker (una
    # entrada roja, o el 130/143 del worker señalado) es DATO para esta lib, y
    # sin el '||' abortaria al coordinador bajo el set -e heredado del caller
    # -- sin reconciliar CANCELLED ni devolver 130/143 (ver cabecera).
    wait "$pid1" "$pid2" "$pid3" 2>/dev/null || true
    if [ -n "$_MEFISTO_TEST_EXECUTOR_SIGNAL" ]; then
        wait "$pid1" 2>/dev/null || true
        wait "$pid2" 2>/dev/null || true
        wait "$pid3" 2>/dev/null || true
    fi

    if [ -n "$prev_trap_int" ]; then eval "$prev_trap_int"; else trap - INT; fi
    if [ -n "$prev_trap_term" ]; then eval "$prev_trap_term"; else trap - TERM; fi

    # Reconciliacion incondicional (ver docstring de la funcion): en el
    # camino feliz no encuentra nada, en el interrumpido rellena CANCELLED.
    _mefisto_test_executor_reconcile_lane "$run_dir" "$carril1" "$entradas1"
    _mefisto_test_executor_reconcile_lane "$run_dir" "$carril2" "$entradas2"
    _mefisto_test_executor_reconcile_lane "$run_dir" "$carril3" "$entradas3"

    case "$_MEFISTO_TEST_EXECUTOR_SIGNAL" in
        INT) return 130 ;;
        TERM) return 143 ;;
    esac
    return 0
}
