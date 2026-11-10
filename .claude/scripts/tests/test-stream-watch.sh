#!/usr/bin/env bash
# test-stream-watch.sh -- Tests del visor en vivo sobre el JSONL neutral de
# eventos (issue #878, protocolo de #858/#861).
#
# Contexto: mefisto-stream-watch.sh sigue incrementalmente
# `<log_base>.events.jsonl` (el JSONL neutral que el runner escribe por
# stage, run-events.schema.json de #858) y renderiza una linea legible por
# actividad -- mensaje de texto/razonamiento sin llamada a herramienta,
# cierre de cada llamada a herramienta con su duracion, y cierre de stage con
# sus metricas -- para que un humano viendo el pane de tmux pueda notar que
# el agente esta dando vueltas en vez de mirar 20 minutos de silencio.
#
# Estilo test-abort-log-tail.sh: el script bajo prueba corre codigo top-level
# (source de _mefisto-common.sh, assert_in_mefisto, el chequeo de jq) antes
# de llegar a definir sus funciones -- sourcing el archivo completo lo
# dispararia. En vez de eso se extrae SOLO el cuerpo de cada funcion (awk
# sobre "nombre() {" .. "}" en columna 0) y se evalua en este proceso. `main`
# (el bucle infinito real) nunca se extrae ni se llama: no terminaria.
#
# Casos cubiertos:
#   [pre] Todas las funciones bajo prueba se pueden extraer y cargar.
#   [A] message (issue #925): con texto vacio se mantiene "(pensando)"/
#       "(texto)" tal cual antes; con texto presente se imprime completo,
#       primera linea junto a la marca de tiempo y las siguientes indentadas
#       sin truncar ni colapsar saltos de linea -- "(pensando)" se conserva
#       delante del texto, "(texto)" NO (el texto mismo ya lo dice). Un texto
#       con `\n`/`\t`/`\` literales se reproduce fiel en pantalla.
#   [B] tool.started (issue #925): renderiza `<tool>: <input_summary>` (solo
#       `<tool>` si `input_summary` es null), relativizando contra el `cwd`
#       del `run.started` vigente cuando el resumen empieza por ese prefijo.
#       tool.completed deja de imprimir linea cuando ok=true (ya se vio al
#       arrancar); ok=false si señala "fallo" con su duracion. run.started no
#       imprime nada por si mismo (solo fija el cwd) ni cuenta como ignorado.
#       Un input_summary con `\t`/`\c` literales (comando de Bash) se
#       muestra fiel y sin truncar (CA-6 aplicado al resumen, no solo al
#       texto).
#   [C] Cierre de stage (terminal) con TODOS los campos presentes -> "OK" y
#       ningun "n/d" en la salida (CA-2/CA-3).
#   [D] Cierre de stage con los campos ausentes tipicos de una corrida
#       degradada (session_id/costo estimado/turns/tokens/ttft_ms/api_duration_ms
#       en null) -> "n/d" en cada uno, nunca 0 ni el layout roto; el status
#       no-exitoso se señala como "ERROR: <error.kind>" (CA-3). Un terminal
#       success con `error` no nulo (la muerte posterior que el contrato
#       documenta) conserva el OK y muestra igual el error.kind.
#   [E] Una linea JSON valida pero no-objeto, y una con `.type` fuera del
#       vocabulario reconocido, se cuentan como "eventos ignorados" sin
#       aportar ninguna fila (CA-4).
#   [F] Una linea que NO es JSON valido, a mitad de un lote (hay contenido
#       posterior), se cuenta como ignorada y el visor avanza mas alla de
#       ella -- nunca se queda atascado (CA-4).
#   [G] La MISMA situacion pero como ULTIMA linea del lote (posible corte a
#       mitad de escritura) NO se cuenta ni se consume -- se reintenta en el
#       siguiente ciclo, cuando ya esta completa (paridad con el
#       comportamiento previo del visor sobre la traza cruda).
#   [H] discover_stream elige el *.events.jsonl mas reciente por mtime, entre
#       varios candidatos, y no falla si el directorio no existe (CA-1).
#   [I] discover_stream_in_dirs: el directorio canonico gana aunque el legacy
#       tenga un candidato mas reciente; si el canonico no tiene ninguno,
#       cae al legacy; sin directorios no falla (CA-1).
#   [I2] discover_current_stream re-resuelve los directorios con
#       mefisto_state_read_paths en CADA llamada: un directorio de logs que
#       aparece DESPUES de arrancar el visor si se descubre (CA-1; el visor se
#       lanza antes que el pipeline, ver --newer-than).
#   [J] parse_stream_header deriva issue/stage/agente del nombre de archivo
#       `.events.jsonl` (sin leer contenido) y degrada a mostrar el nombre
#       tal cual si no matchea el patron conocido (CA-1).
#   [K] fmt_delta_s -> "-" sin accion anterior, numerico con ella (CA-2).
#   [L] is_missing/fmt_nd/fmt_ms_nd/ms_to_s: el contrato de "n/d" para un
#       campo ausente (CA-3), sin confundir 0/false con ausente.
#   [M] stream_matches_issues: match exacto por issue, copias .attempt-,
#       variantes, lista y sin filtro (paridad con el visor previo, sobre la
#       extension .events.jsonl).
#   [N] stream_is_newer_than + discover_stream con filtros activos.
#   [O] CA-5: el JSONL neutral que produce el adaptador REAL de #859 sobre
#       su fixture de traza cruda (no JSONL escrito a mano) rinde el conteo
#       de tools, el estado terminal y todas las metricas. Tambien verifica
#       la lectura de compatibilidad de un terminal legacy que solo contiene
#       cost_usd, y que un costo no resoluble se muestra como n/d sin
#       degradar un session_id presente.
#   [P] CA-6: el script no contiene ninguno de los campos propios de la
#       traza cruda de Claude (`"assistant"`, `"result"`, `tool_use`,
#       `num_turns`, `total_cost_usd`) ni `.claude/pipeline`, y si localiza
#       archivos con mefisto_state_read_paths + el sufijo *.events.jsonl.
#
# Uso: .claude/scripts/tests/test-stream-watch.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TARGET="$REPO_ROOT/src/internal/scripts/mefisto-stream-watch.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: este test requiere jq (no encontrado en PATH)." >&2
    exit 1
fi

# extract_fn <function_name> <file> -- mismo patron que test-abort-log-tail.sh.
extract_fn() {
    local name="$1" file="$2"
    awk -v fn="$name" '$0 ~ "^"fn"\\(\\) \\{" {p=1} p{print} p && /^}/{p=0}' "$file"
}

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# discover_current_stream llama a mefisto_state_read_paths, asi que el helper
# de estado (#856) tiene que estar cargado. Se sourcea la LIBRERIA sola, no
# _mefisto-common.sh entero: esa dispara assert_in_mefisto y demas codigo
# top-level, justo lo que este estilo de test evita. Fijar las dos variables
# ANTES del source las deja apuntando a directorios de este TMP (la libreria
# usa `: "${VAR:=default}"`, que respeta un valor previo), para que ningun
# bloque toque el estado real del repo.
MEFISTO_STATE_DIR="$TMP/state-canonico/pipeline"
MEFISTO_LEGACY_STATE_DIR="$TMP/state-legacy/pipeline"
export MEFISTO_STATE_DIR MEFISTO_LEGACY_STATE_DIR
source "$REPO_ROOT/src/internal/scripts/lib/mefisto-state.sh"

# Colores a vacio: las funciones extraidas los referencian, y este test corre
# con `set -u` (mismo motivo que test-abort-log-tail.sh).
RED=""; GREEN=""; YELLOW=""; BLUE=""; CYAN=""; BOLD=""; NC=""

FNS="write_jq_filter stream_matches_issues stream_is_newer_than discover_stream discover_stream_in_dirs discover_current_stream parse_stream_header is_missing tsv_decode relativize_path fmt_time_hhmmss fmt_delta_s fmt_nd fmt_ms_nd ms_to_s render_terminal_summary render_row process_new_lines"

echo "[pre] Las funciones bajo prueba se pueden extraer y cargar desde mefisto-stream-watch.sh"
ALL_LOADED=1
for fn in $FNS; do
    body=$(extract_fn "$fn" "$TARGET")
    if [ -n "$body" ]; then
        eval "$body"
        if declare -F "$fn" >/dev/null; then
            pass "$fn definida y cargable"
        else
            fail "$fn: eval no la dejo definida"
            ALL_LOADED=0
        fi
    else
        fail "$fn: no se pudo extraer el cuerpo"
        ALL_LOADED=0
    fi
done

if [ "$ALL_LOADED" -ne 1 ]; then
    echo "Abortando: no se pudieron cargar todas las funciones bajo prueba."
    exit 1
fi

# Filtro jq materializado una sola vez para todos los bloques.
JQ_FILTER_PATH="$TMP/filter.jq"
write_jq_filter "$JQ_FILTER_PATH"

# Filtros de descubrimiento en su default (sin filtro): discover_stream los
# referencia bajo `set -u`, y los bloques que los prueban ([N]) los setean y
# los devuelven a vacio.
ISSUES_CSV=""
NEWER_THAN=""

# reset_stage_state -- vuelve al estado "recien cambiado de archivo" (lo que
# hace el bucle principal en cada switch): contador de lineas en cero, sin
# accion previa, sin eventos ignorados.
reset_stage_state() {
    LAST_LINE=0
    PREV_EMS=""
    IGNORED_COUNT=0
    CURRENT_CWD=""
}

# run_process_new_lines <stream_file> <out_file>
#
# Llama a process_new_lines SIN command substitution: `$(...)` correria en
# una subshell y las mutaciones a LAST_LINE/PREV_EMS/IGNORED_COUNT (variables
# globales que el bucle principal real depende que persistan entre ciclos) se
# perderian al volver -- exactamente lo que necesitamos observar en estos
# tests. La redireccion simple `>` no crea subshell para un comando simple,
# asi que el estado global si sobrevive a la llamada.
run_process_new_lines() {
    local stream="$1" outfile="$2"
    process_new_lines "$stream" > "$outfile"
}

# -------- Bloque A: message -- texto completo e indentacion (issue #925) --------

echo ""
echo "[A] message: texto completo, indentacion multilinea, y el degrade con texto vacio (issue #925)"

reset_stage_state
STREAM_A="$TMP/a-stream.jsonl"
printf '%s\n' \
  '{"v":1,"type":"message","ts":"2026-09-05T10:00:00Z","role":"assistant","text":"","kind":"thinking"}' \
  '{"v":1,"type":"message","ts":"2026-09-05T10:00:05Z","role":"assistant","text":"","kind":"text"}' \
  '{"v":1,"type":"message","ts":"2026-09-05T10:00:10Z","role":"assistant","text":"linea uno\nlinea dos"}' \
  '{"v":1,"type":"message","ts":"2026-09-05T10:00:15Z","role":"assistant","text":"razono paso 1\nrazono paso 2","kind":"thinking"}' \
  '{"v":1,"type":"message","ts":"2026-09-05T10:00:20Z","role":"assistant","text":"ruta C:\\temp con\ttab y \\n literal"}' \
  > "$STREAM_A"

run_process_new_lines "$STREAM_A" "$TMP/a-out.txt"
OUT_A=$(cat "$TMP/a-out.txt")
L1=$(sed -n '1p' "$TMP/a-out.txt")
L2=$(sed -n '2p' "$TMP/a-out.txt")
L3=$(sed -n '3p' "$TMP/a-out.txt")
L4=$(sed -n '4p' "$TMP/a-out.txt")
L5=$(sed -n '5p' "$TMP/a-out.txt")
L6=$(sed -n '6p' "$TMP/a-out.txt")
L7=$(sed -n '7p' "$TMP/a-out.txt")

if printf '%s' "$L1" | grep -q "pensando" && ! printf '%s' "$L1" | grep -qi "linea"; then
    pass "A-1: kind=thinking con texto vacio se señala solo con (pensando), como antes"
else
    fail "A-1: no se encontro (pensando) solo: $L1"
fi

if printf '%s' "$L2" | grep -q "texto"; then
    pass "A-2: kind=text con texto vacio se señala solo con (texto), como antes"
else
    fail "A-2: no se encontro (texto): $L2"
fi

if printf '%s' "$L3" | grep -q "linea uno" && ! printf '%s' "$L3" | grep -q "texto"; then
    pass "A-3: con texto presente, kind=text NO lleva la etiqueta (texto) -- el texto mismo la reemplaza"
else
    fail "A-3: se esperaba 'linea uno' sin la etiqueta (texto): $L3"
fi

if printf '%s' "$L4" | grep -qE '^[[:space:]]+linea dos$'; then
    pass "A-4: la segunda linea del texto se imprime SOLA, indentada, sin marca de tiempo ni truncar"
else
    fail "A-4: la segunda linea no quedo indentada tal cual: $L4"
fi

if printf '%s' "$L5" | grep -q "(pensando)" && printf '%s' "$L5" | grep -q "razono paso 1"; then
    pass "A-5: kind=thinking con texto presente SI conserva la etiqueta (pensando) delante del texto"
else
    fail "A-5: no se encontro (pensando) + el texto en la misma linea: $L5"
fi

if printf '%s' "$L6" | grep -qE '^[[:space:]]+razono paso 2$' && ! printf '%s' "$L6" | grep -q "pensando"; then
    pass "A-6: la segunda linea de un thinking multilinea va indentada, sin repetir la etiqueta"
else
    fail "A-6: la segunda linea de thinking no quedo como se esperaba: $L6"
fi

if printf '%s' "$L7" | grep -qF 'ruta C:\temp con' && printf '%s' "$L7" | grep -qF $'\ttab y \\n literal'; then
    pass "A-7 (CA-6): backslash, tab y la secuencia \\n literales se reproducen fieles, sin escapes crudos"
else
    fail "A-7: el texto con backslash/tab/\\n literal no se reprodujo fiel: $L7"
fi

if [ "$LAST_LINE" -eq 5 ]; then
    pass "A-8: LAST_LINE avanzo a 5 (las 5 lineas, bien formadas)"
else
    fail "A-8: se esperaba LAST_LINE=5, se obtuvo $LAST_LINE"
fi

# -------- Bloque B: tool.started + tool.completed (issue #925) --------

echo ""
echo "[B] tool.started visible con input_summary relativizado; tool.completed silencioso salvo fallo (issue #925)"

reset_stage_state
STREAM_B="$TMP/b-stream.jsonl"
printf '%s\n' \
  '{"v":1,"type":"run.started","ts":"2026-09-05T10:00:00Z","runtime":"fake","agent":"mefisto-writer","model":"m","cwd":"/tmp/worktree"}' \
  '{"v":1,"type":"tool.started","ts":"2026-09-05T10:00:01Z","tool":"Read","input_summary":"/tmp/worktree/src/Foo.cs"}' \
  '{"v":1,"type":"tool.completed","ts":"2026-09-05T10:00:01.500Z","tool":"Read","ok":true,"duration_ms":42}' \
  '{"v":1,"type":"tool.started","ts":"2026-09-05T10:00:02Z","tool":"Bash","input_summary":null}' \
  '{"v":1,"type":"tool.completed","ts":"2026-09-05T10:00:05Z","tool":"Bash","ok":false,"duration_ms":null}' \
  '{"v":1,"type":"tool.started","ts":"2026-09-05T10:00:06Z","tool":"WebFetch","input_summary":"/otra/ruta/afuera.txt"}' \
  '{"v":1,"type":"tool.completed","ts":"2026-09-05T10:00:06.200Z","tool":"WebFetch","ok":false,"duration_ms":200}' \
  '{"v":1,"type":"tool.started","ts":"2026-09-05T10:00:07Z","tool":"Bash","input_summary":"sed -e s/\\t/x/ f && grep -F \\c f"}' \
  > "$STREAM_B"

run_process_new_lines "$STREAM_B" "$TMP/b-out.txt"
OUT_B=$(cat "$TMP/b-out.txt")

if [ "$(wc -l < "$TMP/b-out.txt" | tr -d ' ')" = "6" ]; then
    pass "B-1: run.started no produce fila; Read exitoso tampoco -- los 4 tool.started y los 2 fallos (Bash, WebFetch) si (6 filas)"
else
    fail "B-1: se esperaban 6 filas, se obtuvo: $OUT_B"
fi

if printf '%s' "$OUT_B" | grep -q "Read: src/Foo.cs"; then
    pass "B-2: tool.started de Read relativiza input_summary contra el cwd del run.started vigente"
else
    fail "B-2: no se encontro 'Read: src/Foo.cs' relativizado: $OUT_B"
fi

if printf '%s' "$OUT_B" | grep -qE '^\[[0-9:]+\] .*  Bash$'; then
    pass "B-3: tool.started de Bash con input_summary null renderiza solo el nombre de la tool"
else
    fail "B-3: no se encontro la fila 'Bash' sin resumen: $OUT_B"
fi

if ! printf '%s' "$OUT_B" | grep -q "Read (ok"; then
    pass "B-4: el tool.completed{ok:true} de Read no produce ninguna linea (ya se vio al arrancar)"
else
    fail "B-4: el tool.completed exitoso no deberia imprimir nada: $OUT_B"
fi

if printf '%s' "$OUT_B" | grep -q "Bash fallo (n/d)"; then
    pass "B-5: Bash con ok=false SI imprime linea, con duration_ms null como n/d"
else
    fail "B-5: no se encontro la fila de fallo de Bash: $OUT_B"
fi

if printf '%s' "$OUT_B" | grep -q "WebFetch: /otra/ruta/afuera.txt"; then
    pass "B-6: un input_summary que NO empieza por el cwd se muestra tal cual, sin relativizar"
else
    fail "B-6: WebFetch deberia mostrarse sin relativizar: $OUT_B"
fi

if printf '%s' "$OUT_B" | grep -q "WebFetch fallo (200ms)"; then
    pass "B-7: WebFetch con ok=false SI imprime linea con su duracion"
else
    fail "B-7: no se encontro la fila de fallo de WebFetch: $OUT_B"
fi

if [ "$IGNORED_COUNT" -eq 0 ]; then
    pass "B-8: run.started no cuenta como evento ignorado"
else
    fail "B-8: se esperaba IGNORED_COUNT=0, se obtuvo $IGNORED_COUNT"
fi

# CA-6 aplicado al `input_summary`, no solo al `text`: un comando de Bash
# trae backslashes de verdad, y `tsv_decode` ya los decodifico una sola vez.
# Si la fila se imprimiera interpolando el resumen dentro de un formato `%b`
# (como hacia la primera version de #925), ese segundo pase convertiria el
# `\t` del comando en un tab real y el `\c` CORTARIA la salida ahi mismo --
# tragandose el resto del comando y el propio salto de linea, pegando la
# fila siguiente a esta.
B_BASH_LINE=$(grep -F "sed " "$TMP/b-out.txt" || true)
if printf '%s' "$B_BASH_LINE" | grep -qF 'sed -e s/\t/x/ f && grep -F \c f'; then
    pass "B-9 (CA-6): el input_summary de un Bash con \\t y \\c se muestra literal y completo, sin re-interpretar ni truncar"
else
    fail "B-9: el input_summary con backslashes se re-interpreto o se trunco: $B_BASH_LINE"
fi

case "$B_BASH_LINE" in
    *$'\t'*) fail "B-10 (CA-6): la fila del Bash tiene un tab REAL -- el \\t del comando se re-interpreto" ;;
    *) pass "B-10 (CA-6): la fila del Bash no contiene ningun tab real (nada re-interpreto su \\t)" ;;
esac

# -------- Bloque C: terminal con TODOS los campos presentes -- CA-2/CA-3 --------

echo ""
echo "[C] Cierre de stage con todos los campos presentes -> OK, sin ningun n/d (CA-2/CA-3)"

reset_stage_state
STREAM_C="$TMP/c-stream.jsonl"
printf '%s\n' \
  '{"v":1,"type":"message","ts":"2026-09-05T10:04:55Z","role":"assistant","text":"listo"}' \
  '{"v":1,"type":"run.completed","ts":"2026-09-05T10:05:00Z","status":"success","runtime":"claude","model":"claude-sonnet-5","session_id":"sess-1","duration_ms":45000,"tokens":{"input":1200,"output":340},"cost_usd":0.55,"turns":7,"denials":0,"ttft_ms":300,"api_duration_ms":40000,"error":null}' \
  > "$STREAM_C"

run_process_new_lines "$STREAM_C" "$TMP/c-out.txt"
OUT_C=$(cat "$TMP/c-out.txt")

if printf '%s' "$OUT_C" | grep -q "n/d"; then
    fail "C-1: con todos los campos presentes no deberia aparecer ningun n/d: $OUT_C"
else
    pass "C-1: sin ningun n/d cuando todos los campos estan presentes"
fi

if printf '%s' "$OUT_C" | grep -q -- "(OK)"; then
    pass "C-2: status=success se muestra como (OK)"
else
    fail "C-2: no se encontro (OK): $OUT_C"
fi

if printf '%s' "$OUT_C" | grep -q "turnos=7" && printf '%s' "$OUT_C" | grep -q "costo_usd=0.55"; then
    pass "C-3: turnos y costo del evento terminal, sin desplazamiento de campos"
else
    fail "C-3: turnos/costo incorrectos: $OUT_C"
fi

if printf '%s' "$OUT_C" | grep -q "duracion=45.0s (api=40.0s, no-api=5.0s)"; then
    pass "C-4: duracion total y desglose api/no-api correctos"
else
    fail "C-4: desglose de duracion incorrecto: $OUT_C"
fi

if printf '%s' "$OUT_C" | grep -q "runtime=claude  modelo=claude-sonnet-5  session_id=sess-1"; then
    pass "C-5: runtime/modelo/session_id del cierre (CA-3)"
else
    fail "C-5: no se encontro runtime/modelo/session_id: $OUT_C"
fi

if [ "$IGNORED_COUNT" -eq 0 ]; then
    pass "C-6: IGNORED_COUNT se reinicia a 0 tras el cierre de stage"
else
    fail "C-6: se esperaba IGNORED_COUNT=0 tras el cierre, se obtuvo $IGNORED_COUNT"
fi

# -------- Bloque D: terminal degradado (campos en null) -- CA-3 --------

echo ""
echo "[D] Cierre de stage con campos ausentes -> n/d en cada uno, ERROR: <kind> (CA-3)"

reset_stage_state
STREAM_D="$TMP/d-stream.jsonl"
printf '%s\n' \
  '{"v":1,"type":"run.failed","ts":"2026-09-05T10:05:05Z","status":"failed","runtime":"fake","model":null,"session_id":null,"duration_ms":5000,"tokens":{"input":800,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"nonzero_exit","detail":"exit 1"}}' \
  > "$STREAM_D"

run_process_new_lines "$STREAM_D" "$TMP/d-out.txt"
OUT_D=$(cat "$TMP/d-out.txt")

if printf '%s' "$OUT_D" | grep -q -- "--- cierre de stage \[.*\] (ERROR: nonzero_exit) ---"; then
    pass "D-1: status no-exitoso se señala como ERROR: <error.kind>"
else
    fail "D-1: no se encontro el estado ERROR esperado: $OUT_D"
fi

if printf '%s' "$OUT_D" | grep -q "modelo=n/d" && printf '%s' "$OUT_D" | grep -q "session_id=n/d"; then
    pass "D-2: modelo y session_id ausentes se muestran como n/d"
else
    fail "D-2: modelo/session_id deberian ser n/d: $OUT_D"
fi

if printf '%s' "$OUT_D" | grep -q "turnos=n/d  costo_usd=n/d"; then
    pass "D-3: turnos y costo ausentes se muestran como n/d, nunca 0"
else
    fail "D-3: turnos/costo deberian ser n/d: $OUT_D"
fi

if printf '%s' "$OUT_D" | grep -q "duracion=5.0s (api=n/d, no-api=n/d)"; then
    pass "D-4: duration_ms (siempre presente) se muestra en segundos; api/no-api ausentes son n/d"
else
    fail "D-4: desglose de duracion incorrecto: $OUT_D"
fi

if printf '%s' "$OUT_D" | grep -q "tokens: in=800 out=n/d  ttft=n/d  denials=n/d"; then
    pass "D-5: tokens.input presente se muestra tal cual, el resto ausente como n/d"
else
    fail "D-5: tokens/ttft/denials incorrectos: $OUT_D"
fi

# El contrato (run-events.schema.json) documenta explicitamente un
# run.completed con status "success" Y `error` no nulo: la muerte POSTERIOR a
# que el runtime declarara cumplido su contrato (senal, exit distinto de
# cero), que no invalida el trabajo hecho. El estado sigue siendo OK, pero
# callar el `kind` perderia la unica senal de esa muerte (CA-2 pide error.kind
# en el cierre).
reset_stage_state
STREAM_D2="$TMP/d2-stream.jsonl"
printf '%s\n' \
  '{"v":1,"type":"run.completed","ts":"2026-09-05T10:06:00Z","status":"success","runtime":"claude","model":"m","session_id":"s","duration_ms":9000,"tokens":{"input":10,"output":20},"cost_usd":0.1,"turns":3,"denials":0,"ttft_ms":100,"api_duration_ms":8000,"error":{"kind":"killed","detail":"SIGKILL tras el result"}}' \
  > "$STREAM_D2"

run_process_new_lines "$STREAM_D2" "$TMP/d2-out.txt"
OUT_D2=$(cat "$TMP/d2-out.txt")

if printf '%s' "$OUT_D2" | grep -q "OK" && printf '%s' "$OUT_D2" | grep -q "killed"; then
    pass "D-6: un terminal success con error no nulo conserva el estado OK y muestra igual el error.kind"
else
    fail "D-6: se esperaba OK + el error.kind 'killed': $OUT_D2"
fi

# -------- Bloque E: JSON valido no-objeto y type desconocido -- CA-4 --------

echo ""
echo "[E] Linea JSON no-objeto y type desconocido -> eventos ignorados, sin fila (CA-4)"

reset_stage_state
STREAM_E="$TMP/e-stream.jsonl"
printf '%s\n' \
  '"una linea suelta"' \
  '{"v":1,"type":"algo.no.reconocido","ts":"2026-09-05T10:00:00Z"}' \
  '{"v":1,"type":"message","ts":"2026-09-05T10:00:01Z","role":"assistant","text":"hola"}' \
  > "$STREAM_E"

run_process_new_lines "$STREAM_E" "$TMP/e-out.txt"
OUT_E=$(cat "$TMP/e-out.txt")

if [ "$IGNORED_COUNT" -eq 2 ]; then
    pass "E-1: la linea no-objeto y el type desconocido cuentan como 2 eventos ignorados"
else
    fail "E-1: se esperaba IGNORED_COUNT=2, se obtuvo $IGNORED_COUNT"
fi

if [ "$(wc -l < "$TMP/e-out.txt" | tr -d ' ')" = "1" ]; then
    pass "E-2: solo la linea message produjo una fila visible"
else
    fail "E-2: se esperaba 1 sola fila visible, se obtuvo: $OUT_E"
fi

if [ "$LAST_LINE" -eq 3 ]; then
    pass "E-3: LAST_LINE avanzo sobre las 3 lineas (las ignoradas tambien se consumen)"
else
    fail "E-3: se esperaba LAST_LINE=3, se obtuvo $LAST_LINE"
fi

# -------- Bloque F: linea no-JSON A MITAD del lote -- CA-4 --------

echo ""
echo "[F] Linea no-JSON que NO es la ultima del lote -> se cuenta como ignorada y no atasca (CA-4)"

reset_stage_state
STREAM_F="$TMP/f-stream.jsonl"
printf '%s\n' \
  'esto no es JSON en absoluto' \
  '{"v":1,"type":"message","ts":"2026-09-05T10:00:00Z","role":"assistant","text":"hola"}' \
  > "$STREAM_F"

run_process_new_lines "$STREAM_F" "$TMP/f-out.txt"
OUT_F=$(cat "$TMP/f-out.txt")

if [ "$IGNORED_COUNT" -eq 1 ]; then
    pass "F-1: la linea no-JSON se cuenta como ignorada"
else
    fail "F-1: se esperaba IGNORED_COUNT=1, se obtuvo $IGNORED_COUNT"
fi

if [ "$LAST_LINE" -eq 2 ]; then
    pass "F-2: LAST_LINE avanza mas alla de la linea corrupta -- no se queda atascado"
else
    fail "F-2: se esperaba LAST_LINE=2, se obtuvo $LAST_LINE"
fi

if printf '%s' "$OUT_F" | grep -q "hola"; then
    pass "F-3: la linea valida posterior a la corrupta SI se renderizo (con su texto completo)"
else
    fail "F-3: no se renderizo la linea posterior a la corrupta: $OUT_F"
fi

# -------- Bloque G: linea no-JSON COMO ULTIMA del lote -- reintento (CA-4) --------

echo ""
echo "[G] Linea no-JSON como ULTIMA del lote -> no se cuenta ni se consume, se reintenta despues (CA-4)"

reset_stage_state
STREAM_G="$TMP/g-stream.jsonl"
printf '%s\n' '{"v":1,"type":"message","ts":"2026-09-05T10:00:00Z","role":"assistant","text":"primera accion completa"}' > "$STREAM_G"
# Linea truncada a mitad de escritura -- SIN newline final, como quedaria si
# el proceso productor fuera pillado a mitad del write() de esta linea.
printf '%s' '{"v":1,"type":"tool.completed","ts":"2026-09-05T10:00:0' >> "$STREAM_G"

process_new_lines "$STREAM_G" > "$TMP/g-out1.txt"
RC_G1=$?
LAST_LINE_AFTER_1=$LAST_LINE
IGNORED_AFTER_1=$IGNORED_COUNT

if [ "$RC_G1" -eq 0 ]; then
    pass "G-1: una linea truncada no aborta el proceso (set -uo pipefail activo)"
else
    fail "G-1: se esperaba exit 0 con una linea truncada, se obtuvo $RC_G1"
fi

if [ "$LAST_LINE_AFTER_1" -eq 1 ]; then
    pass "G-2: LAST_LINE se detuvo en 1 -- la linea truncada NO se cuenta como consumida"
else
    fail "G-2: se esperaba LAST_LINE=1, se obtuvo $LAST_LINE_AFTER_1"
fi

if [ "$IGNORED_AFTER_1" -eq 0 ]; then
    pass "G-3: la linea truncada NO se cuenta como ignorada (se reintenta, no se descarta)"
else
    fail "G-3: se esperaba IGNORED_COUNT=0, se obtuvo $IGNORED_AFTER_1"
fi

# El productor real termina de escribir esa misma linea (cierra el JSON) y
# agrega una linea nueva completa a continuacion. ok=false (en vez de true)
# a proposito -- issue #925 silencia el tool.completed exitoso, y este bloque
# necesita una fila VISIBLE para comprobar que la reconstruccion se renderizo.
printf '%s\n' '2Z","tool":"Bash","ok":false,"duration_ms":10}' >> "$STREAM_G"
printf '%s\n' '{"v":1,"type":"message","ts":"2026-09-05T10:00:12Z","role":"assistant","text":"otra"}' >> "$STREAM_G"

run_process_new_lines "$STREAM_G" "$TMP/g-out2.txt"
OUT_G2=$(cat "$TMP/g-out2.txt")

if [ "$LAST_LINE" -eq 3 ]; then
    pass "G-4: al completarse, el siguiente ciclo avanza sobre la linea reparada Y la que vino despues"
else
    fail "G-4: se esperaba LAST_LINE=3, se obtuvo $LAST_LINE"
fi

if printf '%s' "$OUT_G2" | grep -q "Bash fallo (10ms)"; then
    pass "G-5: la tool call reparada se renderizo con su duracion"
else
    fail "G-5: no se encontro la tool call reparada: $OUT_G2"
fi

# -------- Bloque H: discover_stream elige el mas reciente por mtime (CA-1) --------

echo ""
echo "[H] discover_stream elige el *.events.jsonl mas reciente por mtime (CA-1)"

DIR_H="$TMP/logs-h"
mkdir -p "$DIR_H"
echo '{}' > "$DIR_H/mefisto-tooling-stage-1-writer-20260729-090000-issue-100.events.jsonl"
touch -t 202607290900 "$DIR_H/mefisto-tooling-stage-1-writer-20260729-090000-issue-100.events.jsonl"
echo '{}' > "$DIR_H/mefisto-tooling-stage-2-reviewer-20260729-093000-issue-100.events.jsonl"
touch -t 202607290930 "$DIR_H/mefisto-tooling-stage-2-reviewer-20260729-093000-issue-100.events.jsonl"

FOUND_H=$(discover_stream "$DIR_H")
if [ "$(basename "$FOUND_H")" = "mefisto-tooling-stage-2-reviewer-20260729-093000-issue-100.events.jsonl" ]; then
    pass "H-1: elige el archivo con mtime mas reciente (stage 2), no el mas viejo (stage 1)"
else
    fail "H-1: se esperaba el archivo de stage 2, se obtuvo: $FOUND_H"
fi

FOUND_H_EMPTY=$(discover_stream "$TMP/no-existe-jamas")
RC_H_EMPTY=$?
if [ "$RC_H_EMPTY" -eq 0 ] && [ -z "$FOUND_H_EMPTY" ]; then
    pass "H-2: un directorio inexistente no aborta -- devuelve vacio"
else
    fail "H-2: se esperaba exit 0 y vacio con directorio inexistente, se obtuvo rc=$RC_H_EMPTY out='$FOUND_H_EMPTY'"
fi

# -------- Bloque I: discover_stream_in_dirs -- canonico primero (CA-1) --------

echo ""
echo "[I] discover_stream_in_dirs: canonico gana aunque legacy sea mas nuevo; cae a legacy si el canonico esta vacio (CA-1)"

DIR_CANON="$TMP/canon"; DIR_LEGACY="$TMP/legacy"; DIR_EMPTY="$TMP/vacio"
mkdir -p "$DIR_CANON" "$DIR_LEGACY" "$DIR_EMPTY"
echo '{}' > "$DIR_LEGACY/mefisto-tooling-stage-1-writer-20260826-100000-issue-10.events.jsonl"
touch -t 202608261000 "$DIR_LEGACY/mefisto-tooling-stage-1-writer-20260826-100000-issue-10.events.jsonl"
echo '{}' > "$DIR_CANON/mefisto-tooling-stage-1-writer-20260826-080000-issue-20.events.jsonl"
touch -t 202608260800 "$DIR_CANON/mefisto-tooling-stage-1-writer-20260826-080000-issue-20.events.jsonl"

FOUND_I1=$(discover_stream_in_dirs "$DIR_CANON" "$DIR_LEGACY")
if [ "$(basename "$FOUND_I1")" = "mefisto-tooling-stage-1-writer-20260826-080000-issue-20.events.jsonl" ]; then
    pass "I-1: el canonico gana aunque el legacy tenga un archivo con mtime mas reciente"
else
    fail "I-1: se esperaba el archivo del canonico, se obtuvo: $FOUND_I1"
fi

FOUND_I2=$(discover_stream_in_dirs "$DIR_EMPTY" "$DIR_LEGACY")
if [ "$(basename "$FOUND_I2")" = "mefisto-tooling-stage-1-writer-20260826-100000-issue-10.events.jsonl" ]; then
    pass "I-2: sin candidatos en el canonico, cae al legacy"
else
    fail "I-2: se esperaba el archivo del legacy, se obtuvo: $FOUND_I2"
fi

FOUND_I3=$(discover_stream_in_dirs)
RC_I3=$?
if [ "$RC_I3" -eq 0 ] && [ -z "$FOUND_I3" ]; then
    pass "I-3: sin ningun directorio no aborta -- devuelve vacio"
else
    fail "I-3: se esperaba exit 0 y vacio sin directorios, se obtuvo rc=$RC_I3 out='$FOUND_I3'"
fi

# -------- Bloque I2: discover_current_stream re-resuelve cada ciclo (CA-1) --------

echo ""
echo "[I2] discover_current_stream re-resuelve los directorios en CADA llamada: un visor lanzado"
echo "     antes que el pipeline encuentra la corrida que nace despues (CA-1)"

# La regresion que cubre: mefisto_state_read_paths solo emite rutas que YA
# existen, y el modo de uso normal del visor es arrancarlo ANTES que el
# pipeline (es la razon de --newer-than, y lo que hacen los lanzadores de
# tmux/herdr). Resolviendo la lista una sola vez al arrancar, el visor se
# quedaria con la lista vacia para siempre y no mostraria nada de la corrida
# que empieza un segundo despues -- en silencio, sin error, exactamente el
# sintoma que el issue #434 vino a eliminar.
FOUND_I2_ANTES=$(discover_current_stream)
RC_I2_ANTES=$?

mkdir -p "$MEFISTO_STATE_DIR/logs"
echo '{}' > "$MEFISTO_STATE_DIR/logs/mefisto-tooling-stage-1-writer-20260905-100000-issue-878.events.jsonl"

FOUND_I2_DESPUES=$(discover_current_stream)

if [ "$RC_I2_ANTES" -eq 0 ] && [ -z "$FOUND_I2_ANTES" ]; then
    pass "I2-1: sin directorio de logs todavia, devuelve vacio sin abortar"
else
    fail "I2-1: se esperaba exit 0 y vacio, se obtuvo rc=$RC_I2_ANTES out='$FOUND_I2_ANTES'"
fi

if [ "$(basename "$FOUND_I2_DESPUES")" = "mefisto-tooling-stage-1-writer-20260905-100000-issue-878.events.jsonl" ]; then
    pass "I2-2: el directorio creado DESPUES de la primera llamada si se descubre en la siguiente"
else
    fail "I2-2: no se descubrio el archivo aparecido despues: '$FOUND_I2_DESPUES'"
fi

# -------- Bloque J: parse_stream_header (CA-1) --------

echo ""
echo "[J] parse_stream_header deriva issue/stage/agente del nombre .events.jsonl (CA-1)"

HEADER_J1=$(parse_stream_header "/tmp/x/mefisto-tooling-stage-1-writer-20260729-100000-issue-434.events.jsonl")
if printf '%s' "$HEADER_J1" | grep -q "issue #434" \
    && printf '%s' "$HEADER_J1" | grep -q "stage 1" \
    && printf '%s' "$HEADER_J1" | grep -q "writer"; then
    pass "J-1: extrae issue=434, stage=1, agente=writer del nombre convencional"
else
    fail "J-1: no se extrajeron los campos esperados: $HEADER_J1"
fi

HEADER_J2=$(parse_stream_header "/tmp/x/mefisto-tooling-stage-merge-writer-20260729-100000-issue-441.events.jsonl")
if printf '%s' "$HEADER_J2" | grep -q "stage merge"; then
    pass "J-2: el stage 'merge' (no numerico) tambien se extrae"
else
    fail "J-2: no se extrajo el stage 'merge': $HEADER_J2"
fi

HEADER_J3=$(parse_stream_header "/tmp/x/un-nombre-cualquiera.jsonl")
if printf '%s' "$HEADER_J3" | grep -q "un-nombre-cualquiera.jsonl"; then
    pass "J-3: un nombre que no matchea el patron degrada a mostrarlo tal cual (no falla)"
else
    fail "J-3: no degrado mostrando el nombre tal cual: $HEADER_J3"
fi

# -------- Bloque K: fmt_delta_s (CA-2) --------

echo ""
echo "[K] fmt_delta_s -- sin accion previa devuelve '-', con ella devuelve el delta en segundos (CA-2)"

DELTA_K1=$(fmt_delta_s "" "1785190194169")
if printf '%s' "$DELTA_K1" | grep -q -- "-"; then
    pass "K-1: sin accion previa, el delta se muestra como '-'"
else
    fail "K-1: se esperaba '-' sin accion previa, se obtuvo: $DELTA_K1"
fi

DELTA_K2=$(fmt_delta_s "1785190174000" "1785190194169")
if printf '%s' "$DELTA_K2" | grep -q "20.2"; then
    pass "K-2: con accion previa, el delta es la diferencia en segundos (20.2s)"
else
    fail "K-2: delta incorrecto, se esperaba ~20.2s: $DELTA_K2"
fi

# -------- Bloque L: is_missing/fmt_nd/fmt_ms_nd/ms_to_s (CA-3) --------

echo ""
echo "[L] is_missing/fmt_nd/fmt_ms_nd/ms_to_s: el contrato de n/d para un campo ausente (CA-3)"

MISSING_OK=1
for v in "" "-" "null"; do
    is_missing "$v" || { fail "L-1: is_missing deberia reconocer '$v' como ausente"; MISSING_OK=0; }
done
[ "$MISSING_OK" -eq 1 ] && pass "L-1: vacio, '-' (placeholder de cell) y 'null' cuentan como ausente"

if ! is_missing "0" && ! is_missing "false" && ! is_missing "42"; then
    pass "L-2: un valor real no se confunde con ausente (0, false y un numero son presentes)"
else
    fail "L-2: un valor real se clasifico como ausente"
fi

if [ "$(fmt_nd "-")" = "n/d" ] && [ "$(fmt_nd "3")" = "3" ]; then
    pass "L-3: fmt_nd traduce el placeholder a n/d y deja pasar un valor presente tal cual"
else
    fail "L-3: fmt_nd no se comporto como se esperaba: ausente='$(fmt_nd "-")' presente='$(fmt_nd "3")'"
fi

if [ "$(fmt_ms_nd "-")" = "n/d" ] && [ "$(fmt_ms_nd "42")" = "42ms" ]; then
    pass "L-4: fmt_ms_nd agrega la unidad ms sin convertir a segundos, y n/d si esta ausente"
else
    fail "L-4: fmt_ms_nd incorrecto: ausente='$(fmt_ms_nd "-")' presente='$(fmt_ms_nd "42")'"
fi

if [ "$(ms_to_s "-")" = "n/d" ] && [ "$(ms_to_s "3000")" = "3.0s" ]; then
    pass "L-5: ms_to_s convierte a segundos con un decimal, y n/d si esta ausente"
else
    fail "L-5: ms_to_s incorrecto: ausente='$(ms_to_s "-")' presente='$(ms_to_s "3000")'"
fi

if [ "$(fmt_time_hhmmss "-")" = "--:--:--" ]; then
    pass "L-6: fmt_time_hhmmss traduce el placeholder a su marca de hora ausente"
else
    fail "L-6: fmt_time_hhmmss no tradujo el placeholder: '$(fmt_time_hhmmss "-")'"
fi

# -------- Bloque M: stream_matches_issues (paridad, extension .events.jsonl) --------

echo ""
echo "[M] stream_matches_issues: match exacto por issue, copias .attempt-, variantes, lista y sin filtro"

if stream_matches_issues "mefisto-tooling-stage-1-writer-20260826-100000-issue-42.events.jsonl" "42"; then
    pass "M-1: el archivo del issue 42 matchea el filtro '42'"
else
    fail "M-1: el archivo del issue 42 no matcheo el filtro '42'"
fi

if ! stream_matches_issues "mefisto-tooling-stage-1-writer-20260826-100000-issue-42.events.jsonl" "4"; then
    pass "M-2: el filtro '4' NO matchea el issue 42 (el match es exacto, no substring)"
else
    fail "M-2: el filtro '4' matcheo el issue 42 -- cruzaria visores de corridas concurrentes"
fi

if stream_matches_issues "mefisto-tooling-stage-2-reviewer-20260826-100000-issue-42.attempt-2.events.jsonl" "42"; then
    pass "M-3: la copia de reintento (.attempt-2) sigue matcheando su issue"
else
    fail "M-3: la copia .attempt-2 no matcheo su issue"
fi

if stream_matches_issues "mefisto-tooling-stage-1-writer-20260826-100000-issue-43.events.jsonl" "42,43,44" \
    && ! stream_matches_issues "mefisto-tooling-stage-1-writer-20260826-100000-issue-99.events.jsonl" "42,43,44"; then
    pass "M-4: una lista de issues (batch) matchea sus miembros y rechaza los ajenos"
else
    fail "M-4: la lista '42,43,44' no filtro como se esperaba"
fi

if stream_matches_issues "mefisto-tooling-stage-1-writer-20260826-100000-issue-42-experimento-a.events.jsonl" "42" \
    && ! stream_matches_issues "mefisto-tooling-stage-1-writer-20260826-100000-issue-42-experimento-a.events.jsonl" "4"; then
    pass "M-5: el archivo de una corrida de variante (--variant, issue #711) matchea su issue sin relajar el match exacto"
else
    fail "M-5: el filtro de variante no se comporto como se esperaba"
fi

if stream_matches_issues "cualquier-cosa.events.jsonl" ""; then
    pass "M-6: sin filtro (lista vacia) todo archivo matchea -- el comportamiento original"
else
    fail "M-6: la lista vacia deberia matchear todo"
fi

# -------- Bloque N: stream_is_newer_than + discover_stream con filtros --------

echo ""
echo "[N] stream_is_newer_than y discover_stream con filtros activos"

DIR_N="$TMP/logs-n"
mkdir -p "$DIR_N"
echo '{}' > "$DIR_N/mefisto-tooling-stage-1-writer-20260826-090000-issue-10.events.jsonl"
touch -t 202608260900 "$DIR_N/mefisto-tooling-stage-1-writer-20260826-090000-issue-10.events.jsonl"
echo '{}' > "$DIR_N/mefisto-tooling-stage-1-writer-20260826-100000-issue-20.events.jsonl"
touch -t 202608261000 "$DIR_N/mefisto-tooling-stage-1-writer-20260826-100000-issue-20.events.jsonl"

if ! stream_is_newer_than "$DIR_N/mefisto-tooling-stage-1-writer-20260826-090000-issue-10.events.jsonl" "9999999999" \
    && stream_is_newer_than "$DIR_N/mefisto-tooling-stage-1-writer-20260826-100000-issue-20.events.jsonl" "1" \
    && stream_is_newer_than "$DIR_N/mefisto-tooling-stage-1-writer-20260826-090000-issue-10.events.jsonl" ""; then
    pass "N-1: el corte por mtime rechaza lo anterior, deja pasar lo posterior y sin corte pasa todo"
else
    fail "N-1: stream_is_newer_than no filtro como se esperaba"
fi

ISSUES_CSV="10"
NEWER_THAN=""
FOUND_N1=$(discover_stream "$DIR_N")
if [ "$(basename "$FOUND_N1")" = "mefisto-tooling-stage-1-writer-20260826-090000-issue-10.events.jsonl" ]; then
    pass "N-2: con ISSUES_CSV=10, discover_stream ignora el archivo mas reciente de OTRO issue"
else
    fail "N-2: se esperaba el archivo del issue 10, se obtuvo: $FOUND_N1"
fi

ISSUES_CSV="10"
NEWER_THAN="9999999999"
FOUND_N2=$(discover_stream "$DIR_N")
if [ -z "$FOUND_N2" ]; then
    pass "N-3: con un corte posterior al mtime, discover_stream espera (devuelve vacio)"
else
    fail "N-3: se esperaba vacio con corte futuro, se obtuvo: $FOUND_N2"
fi

ISSUES_CSV=""
NEWER_THAN=""

# -------- Bloque O: CA-5 -- corrida traducida por el adaptador real --------

echo ""
echo "[O] CA-5: la corrida traducida por el adaptador Claude rinde su conteo de tools,"
echo "    su estado terminal y todas sus metricas."

# La entrada de este bloque NO es JSONL escrito a mano: se genera corriendo el
# adaptador real de #859 sobre su fixture de traza cruda. Inventar el JSONL
# neutral deja al test afirmando lo que el autor CREE que reporta el runtime,
# no lo que reporta.
#
# neutral_run <lib> <fn> <fixture-dir> <fixture> <runtime> <modelo> <destino>
#
# Reproduce el archivo tal como queda en disco: el `run.started` que emite el
# runner, la traduccion del adaptador, y el `duration_ms` del terminal
# sobreescrito con el reloj de pared que mide el runner (mefisto-run-agent.sh
# lo hace explicitamente -- el adaptador lo deja en null). Sin ese ultimo paso
# el test estaria juzgando un archivo que el visor nunca ve.
neutral_run() {
    local lib="$1" fn="$2" fixdir="$3" fixture="$4" runtime="$5" modelo="$6" dest="$7"
    jq -n -c --arg rt "$runtime" --argjson model "$([ -n "$modelo" ] && printf '"%s"' "$modelo" || printf 'null')" \
        '{v: 1, type: "run.started", ts: "2026-09-05T10:00:00Z", runtime: $rt, agent: "mefisto-writer", model: $model, cwd: "/tmp/w"}' \
        > "$dest"
    bash -c "cd '$REPO_ROOT' && source '$lib' && $fn '$fixdir/$fixture' '$runtime' '$modelo' 0 ''" \
        | jq -c 'if (.type == "run.completed" or .type == "run.failed") then .duration_ms = 5000 else . end' \
        >> "$dest"
}

LIB_DIR="$REPO_ROOT/src/runtime/lib"
FIX_CLAUDE="$SCRIPT_DIR/fixtures/runtime-claude"

reset_stage_state
STREAM_CLAUDE="$TMP/claude.events.jsonl"
neutral_run "$LIB_DIR/runtime-claude.sh" runtime_claude_translate \
    "$FIX_CLAUDE" "success.jsonl" "claude" "claude-sonnet-5" "$STREAM_CLAUDE"
run_process_new_lines "$STREAM_CLAUDE" "$TMP/claude-out.txt"
OUT_CLAUDE=$(cat "$TMP/claude-out.txt")
# El tool.completed{ok:true} de la fixture ya no imprime linea (issue #925):
# se cuenta por el tool.started, que si es siempre visible -- la fixture trae
# exactamente una llamada a tool ("Read").
TOOLS_CLAUDE=$(grep -c "Read: x" "$TMP/claude-out.txt" | tr -d ' ')

if [ "$TOOLS_CLAUDE" -eq 1 ]; then
    pass "O-1: conteo de tools (1) sobre la salida real del adaptador"
else
    fail "O-1: conteo de tools inesperado -- claude=$TOOLS_CLAUDE"
fi

if printf '%s' "$OUT_CLAUDE" | grep -q -- "(OK)"; then
    pass "O-2: estado terminal (OK)"
else
    fail "O-2: estado terminal inesperado -- claude='$OUT_CLAUDE'"
fi

if printf '%s' "$OUT_CLAUDE" | grep -q "costo_usd=0.01" && ! printf '%s' "$OUT_CLAUDE" | grep -q "n/d"; then
    pass "O-3: la corrida Claude muestra estimated_cost_usd=0.01 y todas sus metricas"
else
    fail "O-3: la corrida Claude no mostro costo_usd=0.01 o degrado alguna metrica a n/d: $OUT_CLAUDE"
fi

# MEF-ADR-0054, seccion 5: los lectores conservan la compatibilidad con el
# historial que solo trae cost_usd, aunque los escritores nuevos emiten
# estimated_cost_usd. Este JSONL manual aísla esa ruta de lectura legacy.
reset_stage_state
STREAM_LEGACY="$TMP/legacy-cost.events.jsonl"
printf '%s\n' '{"v":1,"type":"run.completed","ts":"2026-09-05T10:00:00Z","status":"success","runtime":"claude","model":"claude-sonnet-5","session_id":null,"duration_ms":100,"tokens":{"input":10,"output":5},"cost_usd":0.02,"turns":1,"denials":null,"ttft_ms":null,"api_duration_ms":80,"error":null}' > "$STREAM_LEGACY"
run_process_new_lines "$STREAM_LEGACY" "$TMP/legacy-cost-out.txt"
OUT_LEGACY=$(cat "$TMP/legacy-cost-out.txt")
if printf '%s' "$OUT_LEGACY" | grep -q "costo_usd=0.02"; then
    pass "O-3b: un terminal legacy con solo cost_usd conserva su costo reportado"
else
    fail "O-3b: el terminal legacy no mostro costo_usd=0.02: $OUT_LEGACY"
fi

# MEF-ADR-0054, seccion 1: cuando modelo y tokens no permiten resolver la
# estimacion, el terminal trae estimated_cost_usd:null. session_id si esta
# presente debe conservarse aunque la estimacion sea n/d.
reset_stage_state
STREAM_NOCOST="$TMP/no-cost.events.jsonl"
printf '%s\n' '{"v":1,"type":"run.completed","ts":"2026-09-05T10:00:00Z","status":"success","runtime":"fake","model":null,"session_id":"ses_presente","duration_ms":100,"tokens":{"input":10,"output":5,"cache_read":null,"cache_write":null,"reasoning":null},"estimated_cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":null}' > "$STREAM_NOCOST"
run_process_new_lines "$STREAM_NOCOST" "$TMP/no-cost-out.txt"
OUT_NOCOST=$(cat "$TMP/no-cost-out.txt")
if printf '%s' "$OUT_NOCOST" | grep -q "costo_usd=n/d" \
    && printf '%s' "$OUT_NOCOST" | grep -q "session_id=ses_presente"; then
    pass "O-4: costo no resoluble se muestra como n/d sin degradar un session_id presente"
else
    fail "O-4: no se distinguio costo no resoluble de session_id presente: $OUT_NOCOST"
fi

# -------- Bloque P: CA-6 -- neutralidad del script fuente --------

echo ""
echo "[P] CA-6: el script no referencia campos propios de la traza cruda de Claude ni rutas legacy hardcodeadas"

CA6_OK=1
for pat in '"assistant"' '"result"' 'tool_use' 'num_turns' 'total_cost_usd' '.claude/pipeline'; do
    if grep -qF -- "$pat" "$TARGET"; then
        fail "P-1: el script contiene el patron prohibido: $pat"
        CA6_OK=0
    fi
done
[ "$CA6_OK" -eq 1 ] && pass "P-1: ninguno de los patrones prohibidos (assistant/result/tool_use/num_turns/total_cost_usd/.claude/pipeline) esta presente"

if grep -q "mefisto_state_read_paths" "$TARGET"; then
    pass "P-2: el visor localiza el archivo con mefisto_state_read_paths (CA-1)"
else
    fail "P-2: no se encontro una llamada a mefisto_state_read_paths"
fi

if grep -q '\*\.events\.jsonl' "$TARGET"; then
    pass "P-3: el visor sigue *.events.jsonl (el JSONL neutral, no la traza cruda)"
else
    fail "P-3: no se encontro la referencia a *.events.jsonl"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
