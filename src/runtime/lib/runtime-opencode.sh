#!/usr/bin/env bash
# runtime-opencode.sh -- Adaptador de runtime OpenCode (MEF-ADR-0049, issue
# #860). Unico lugar del repo (fuera de tests/fixtures/shims generados) que
# compone la invocacion `opencode run` y traduce su `--format json` ("raw
# JSON events", verificado en OpenCode 1.18.29) al JSONL neutral de
# src/runtime/contract/run-events.schema.json -- ver
# src/runtime/contract/README.md.
#
# OpenCode es el runtime del dogfooding interno (MEF-ADR-0049 CA-5, #851):
# ningun otro archivo del harness debe nombrar `opencode`, `--agent`, `--auto`
# ni `--format json` -- eso vive aqui. Autenticacion/credenciales (el
# almacen de credenciales local de OpenCode, OAuth de proveedor) son
# responsabilidad EXCLUSIVA de OpenCode: este adaptador no los lee, copia,
# valida ni menciona (CA-5 de #860, verificado por
# .claude/scripts/tests/test-runtime-opencode.sh seccion [E]: ni la ruta de
# ese almacen ni ninguna variable de API key de proveedor aparecen en este
# archivo ni en runtime-opencode.jq) -- la disponibilidad del provider la
# valida OpenCode al ejecutar, no Mefisto.
#
# Implementa la interfaz de funciones que todo adaptador de runtime debe
# exponer (ver src/runtime/contract/README.md, "Interfaz de adaptador"):
#   runtime_opencode_build_cmd <agent> <cwd> <prompt_file> <model> <system_file>
#                              [<resume_session_id>]
#     Rellena MEFISTO_RUNTIME_CMD con el argv de `opencode run` (sin `eval`,
#     paridad con run_agent_with_watchdog) SIN mensaje posicional (issue
#     #1448; incidente de #1407): `resolveRunInput` de OpenCode
#     (packages/opencode/src/cli/cmd/run.ts:416-418, verificado en 1.18.29)
#     CONCATENA el mensaje posicional y stdin cuando llegan los dos
#     (`value + "\n" + piped`), asi que cualquier texto en argv corromperia el
#     mensaje que recibe el modelo -- el argv nunca vuelve a llevar el
#     mensaje. En su lugar, esta funcion materializa
#     "$MEFISTO_RUNTIME_WORK_DIR/opencode-message.md" con el mismo contenido
#     que antes viajaba por argv (system + "\n\n" + prompt, o solo el prompt
#     sin system-file) y fija la variable global MEFISTO_RUNTIME_STDIN_FILE a
#     esa ruta: `lib/mefisto-process.sh` conecta ese archivo a la entrada
#     estandar del proceso en vez del argv, que sigue sujeto a ARG_MAX
#     (1.048.576 bytes en macOS, `getconf ARG_MAX`). <agent> participa del
#     argv en ambos adaptadores reales; OpenCode lo recibe como `--agent
#     <id>`. A diferencia de runtime-claude.sh, aqui <cwd> tambien participa
#     como `--dir <cwd>` porque `opencode run` lo exige como flag propio:
#     `run_agent_with_watchdog` sigue haciendo `cd "$workdir"` antes de
#     invocar, pero OpenCode ademas necesita que se le diga explicitamente
#     donde correr (CA-1). <resume_session_id> (issue #968,
#     CA-1/CA-2) es OPCIONAL y opaco -- vacio/ausente = comportamiento
#     identico a antes de #968 (sin `--session` en el argv); no vacio agrega
#     `--session <id>` (verificado en `opencode run --help` local). `--fork`
#     queda deliberadamente sin usar: reusar el id original mantiene la
#     trazabilidad del stage en un solo transcript (notas tecnicas de #968).
#   runtime_opencode_translate <raw_file> <runtime_id> <model>
#                              [<exit_code>] [<stderr_file>]
#     Delega en runtime-opencode.jq (`jq -R -s -c`, mismo idiom que
#     runtime-claude.sh). Nunca emite `run.started` -- eso lo hace
#     mefisto-run-agent.sh directo (issue #858).
#     A diferencia de Claude Code, el wire format de OpenCode no trae ninguna
#     senal propia de exito/fallo (no hay equivalente a `is_error`/`subtype`/
#     `stop_reason`): la clasificacion completa de CA-3 depende del exit code
#     y del stderr crudo que este runner SIEMPRE pasa (ver
#     src/runtime/contract/README.md, "Interfaz de adaptador"), asi que los
#     dos ultimos argumentos son mucho mas centrales aqui que en el adaptador
#     Claude Code.
#     Antes de invocar jq, se asegura (issue #1324, CA-1) una referencia
#     estable del catalogo de tarifas via runtime_opencode_ensure_pricing:
#     mefisto-run-agent.sh llama a esta funcion repetidamente durante una
#     misma corrida (el anexo en vivo cada
#     MEFISTO_RUN_AGENT_LIVE_INTERVAL segundos ademas de la traduccion
#     final), y sin esa cota cada tick repetiria la validacion/refresco
#     diario. jq recibe el contenido de esa referencia via `--rawfile
#     pricing_catalog_text` (cadena vacia si no hay catalogo disponible), asi
#     que la traduccion live y la final calculan el mismo importe.
#
# Flags que compone build_cmd (CA-1): `--agent <agent> --dir <cwd> --format
# json --auto` siempre; `-m <model>` solo si el runner entrego un modelo no
# vacio (heredar = el CLI real nunca ve un `-m` vacio); NINGUN elemento del
# argv es ni contiene el mensaje (issue #1448) -- viaja por
# MEFISTO_RUNTIME_STDIN_FILE. `--auto` ("auto-approve permissions that are
# not explicitly denied") es el UNICO flag de permisos que este adaptador
# conoce -- la politica deny-por-defecto la genera #862 en el frontmatter del
# agente, nunca este archivo.
#
# `--system-file` no tiene flag equivalente en `opencode run` (verificado:
# `opencode run --help` no lista nada parecido a `--append-system-prompt`):
# se inyecta como PREFIJO del mensaje ("$system\n\n$prompt") dentro del
# archivo que build_cmd materializa, nunca como flag ni como texto en argv.
#
# El valor de <model> es OPACO para este adaptador (CA-1): viaja tal cual a
# `-m`, con `/`, `.`, `-` o espacios, sin interpretarlo ni validarlo -- la
# disponibilidad real del provider/modelo la resuelve OpenCode al ejecutar.
#
# Bash 3.2 (macOS): sin arrays asociativos, sin novedades de bash 4+.

runtime_opencode_is_available() {
    command -v opencode >/dev/null 2>&1
}

runtime_opencode_default_model() {
    case "$1" in
        fast) printf '%s' "openai/gpt-5.6-luna" ;;
        balanced|deep) printf '%s' "openai/gpt-6-sol" ;;
        *) return 1 ;;
    esac
}

runtime_opencode_default_effort() {
    case "$1" in
        quick) printf '%s' "low" ;;
        light) printf '%s' "medium" ;;
        standard) printf '%s' "high" ;;
        thorough) printf '%s' "xhigh" ;;
        exhaustive) printf '%s' "max" ;;
        *) return 1 ;;
    esac
}

# --- Catalogo de tarifas Models.dev ------------------------------------------
#
# La estimacion es telemetria auxiliar: este adaptador conserva una copia
# validada, propia de Mefisto, sin consultar el estado ni las credenciales de
# OpenCode (MEF-ADR-0054 secciones 3 y 4). La integracion que traduce pasos y
# calcula el importe consume la ruta global que deja esta preparacion.
MEFISTO_OPENCODE_PRICING_CATALOG=""

# Valor de MEFISTO_STATE_DIR cuyo catalogo ya resolvio
# runtime_opencode_ensure_pricing en ESTE shell (issue #1324, CA-1). Solo
# acota a un caller que traduzca en su propio shell: el runner traduce dentro
# de una sustitucion de comandos, y esa asignacion muere con el subshell --
# de ahi que la cota real viva en disco (ver runtime_opencode_ensure_pricing).
# El sufijo fijo distingue "nunca preparado" de "preparado para
# MEFISTO_STATE_DIR vacio/sin definir" (ambos son cadenas vacias sin el
# sufijo).
MEFISTO_OPENCODE_PRICING_PREPARED_FOR=""

runtime_opencode_pricing_cache_is_valid() {
    local cache="$1"
    [ -s "$cache" ] || return 1
    command -v jq >/dev/null 2>&1 || return 1

    jq -e '
        def price: type == "number" and isfinite and . >= 0;
        def price_set: (.input | price) and (.output | price)
          and (.cache_read | price) and (.cache_write | price);
        type == "object" and .schema == 1
        and (.source_url == "https://models.opencode.ai/api.json")
        and (.validated_utc | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$"))
        and (.models | type == "object" and length > 0)
        and all(.models | to_entries[];
            (.key | test("^[^/]+/.+$"))
            and (.value | type == "object" and price_set)
            and ((.value.context == null) or (.value.context | price))
            and (.value.tiers | type == "array")
            and all(.value.tiers[];
                type == "object" and (.context | price) and price_set))
    ' "$cache" >/dev/null 2>&1
}

runtime_opencode_pricing_mark_attempt() {
    local cache_dir="$1" attempt_file="$2" today="$3" marker_tmp=""
    marker_tmp="$(mktemp "$cache_dir/.attempted-utc.XXXXXX" 2>/dev/null)" || return 1
    if printf '%s\n' "$today" > "$marker_tmp" && mv "$marker_tmp" "$attempt_file"; then
        return 0
    fi
    rm -f "$marker_tmp" 2>/dev/null || true
    return 1
}

runtime_opencode_pricing_warn_if_stale() {
    local cache_file="$1" today="$2"
    if [ "$(jq -r '.validated_utc' "$cache_file" 2>/dev/null)" != "$today" ]; then
        echo "AVISO: se usa una cache de tarifas de OpenCode desactualizada." >&2
    fi
}

runtime_opencode_pricing_emit_cache() {
    local cache_file="$1" today="$2"
    if runtime_opencode_pricing_cache_is_valid "$cache_file"; then
        MEFISTO_OPENCODE_PRICING_CATALOG="$cache_file"
        printf '%s\n' "$cache_file"
        runtime_opencode_pricing_warn_if_stale "$cache_file" "$today"
    else
        echo "AVISO: el catalogo de tarifas de OpenCode no esta disponible; se omite la estimacion." >&2
    fi
    return 0
}

# runtime_opencode_prepare_pricing
#
# Imprime la ruta de la ultima cache valida (o nada si no existe) y retorna
# siempre cero. El marker de intento se escribe bajo el lock ANTES de curl:
# incluso una descarga fallida queda acotada a una por dia UTC.
runtime_opencode_prepare_pricing() {
    MEFISTO_OPENCODE_PRICING_CATALOG=""
    [ -n "${MEFISTO_STATE_DIR:-}" ] || return 0

    local cache_dir cache_file attempt_file lock_dir today tmp="" normalized="" lock_owned=false
    cache_dir="$MEFISTO_STATE_DIR/cache/model-pricing"
    cache_file="$cache_dir/catalog.json"
    attempt_file="$cache_dir/attempted-utc"
    lock_dir="$cache_dir/.refresh.lock"
    today="$(date -u +%Y-%m-%d 2>/dev/null)"
    [ -n "$today" ] || return 0
    mkdir -p "$cache_dir" 2>/dev/null || {
        echo "AVISO: no se pudo preparar la cache de tarifas de OpenCode; se omite la estimacion." >&2
        return 0
    }

    # Un proceso que no obtiene el lock espera brevemente al que refresca: asi
    # dos pipelines simultaneos comparten su resultado, sin que el segundo haga
    # otra consulta. Un lock abandonado solo degrada a la ultima cache valida.
    if mkdir "$lock_dir" 2>/dev/null; then
        lock_owned=true
    else
        local wait_count=0
        while [ -d "$lock_dir" ] && [ "$wait_count" -lt 200 ]; do
            sleep 0.05
            wait_count=$((wait_count + 1))
        done
    fi

    if [ "$lock_owned" = "false" ]; then
        # El propietario puede haber terminado mientras esperabamos; intentar
        # adquirir una vez evita escribir sin lock si acaba de liberarlo.
        if mkdir "$lock_dir" 2>/dev/null; then
            lock_owned=true
        else
            runtime_opencode_pricing_emit_cache "$cache_file" "$today"
            return $?
        fi
    fi

    # Somos propietarios del lock. Revalidar fecha dentro de la seccion critica
    # es lo que hace efectiva la cota diaria bajo concurrencia.
    if [ -f "$attempt_file" ] && [ "$(cat "$attempt_file" 2>/dev/null)" = "$today" ]; then
        :
    elif runtime_opencode_pricing_cache_is_valid "$cache_file" \
        && [ "$(jq -r '.validated_utc' "$cache_file" 2>/dev/null)" = "$today" ]; then
        runtime_opencode_pricing_mark_attempt "$cache_dir" "$attempt_file" "$today" || true
    elif runtime_opencode_pricing_mark_attempt "$cache_dir" "$attempt_file" "$today"; then
        tmp="$(mktemp "$cache_dir/.catalog.XXXXXX" 2>/dev/null)"
        if [ -n "$tmp" ]; then
            normalized="$tmp.normalized"
        fi
        if [ -n "$tmp" ] && command -v curl >/dev/null 2>&1 \
            && curl --fail --silent --show-error --location --connect-timeout 5 --max-time 15 \
                "https://models.opencode.ai/api.json" > "$tmp" 2>/dev/null \
            && jq -e --arg day "$today" '
                def price: type == "number" and isfinite and . >= 0;
                def price_set: type == "object" and (.input | price) and (.output | price)
                  and (.cache_read | price) and (.cache_write | price);
                {
                  schema: 1, source_url: "https://models.opencode.ai/api.json", validated_utc: $day,
                  models: [
                    to_entries[] as $provider
                    | select($provider.key | type == "string" and length > 0 and (contains("/") | not))
                    | ($provider.value.models // {}) | to_entries[] as $model
                    | select($model.key | type == "string" and length > 0)
                    | ($model.value.cost // null) as $base
                    | [($base.tiers // [])[]
                        | {context: .tier.size, input, output, cache_read, cache_write}] as $tiers
                    | select($base | price_set)
                    | select(($model.value.limit.context // null) as $context
                        | ($context == null or ($context | price)))
                    | select(all($tiers[]; (.context | price) and price_set))
                    | {
                        key: ($provider.key + "/" + $model.key),
                        value: {
                          input: $base.input, output: $base.output,
                          cache_read: $base.cache_read, cache_write: $base.cache_write,
                          context: ($model.value.limit.context // null),
                          tiers: $tiers
                        }
                      }
                  ] | from_entries
                }
            ' "$tmp" > "$normalized" 2>/dev/null \
            && runtime_opencode_pricing_cache_is_valid "$normalized"; then
            mv "$normalized" "$cache_file" 2>/dev/null || true
        fi
        rm -f "$tmp" "$normalized" 2>/dev/null || true
    fi
    rmdir "$lock_dir" 2>/dev/null || true

    runtime_opencode_pricing_emit_cache "$cache_file" "$today"
    return $?
}

# runtime_opencode_ensure_pricing (issue #1324, CA-1)
#
# Punto unico por el que runtime_opencode_translate obtiene el catalogo, y
# la cota que impide que el anexo en vivo repita el trabajo diario cada
# MEFISTO_RUN_AGENT_LIVE_INTERVAL segundos.
#
# La cota NO puede vivir solo en una variable de shell: mefisto-run-agent.sh
# invoca la traduccion dentro de una sustitucion de comandos
# (`"$(runtime_..._translate ...)"`, dos veces -- el anexo en vivo y la
# traduccion final), o sea en un SUBSHELL, y todo lo que ese subshell asigne
# muere con el. Una memoria en variable solo acota a un caller que invoque la
# traduccion en su propio shell (los tests de esta libreria), nunca al runner
# real.
#
# La cota que si sobrevive es la del disco, que ya mantiene
# runtime_opencode_prepare_pricing: con el intento de HOY marcado y una cache
# instalada, el refresco diario ya ocurrio y no hay nada que decidir. En ese
# caso se sirve el archivo directamente, sin lock ni revalidacion completa
# del documento -- se instalo por rename atomico DESPUES de validarlo, y
# runtime-opencode.jq degrada a `estimated_cost_usd:null` ante un documento
# corrupto en vez de abortar la traduccion. Asi cada tick del anexo en vivo
# cuesta una lectura de marca, no una adquisicion de lock mas dos pasadas de
# jq sobre el catalogo entero.
runtime_opencode_ensure_pricing() {
    local current="${MEFISTO_STATE_DIR:-}#prepared"
    [ "$MEFISTO_OPENCODE_PRICING_PREPARED_FOR" = "$current" ] && return 0

    local cache_dir cache_file today
    if [ -n "${MEFISTO_STATE_DIR:-}" ]; then
        cache_dir="$MEFISTO_STATE_DIR/cache/model-pricing"
        cache_file="$cache_dir/catalog.json"
        today="$(date -u +%Y-%m-%d 2>/dev/null)"
        if [ -s "$cache_file" ] && [ -n "$today" ] \
            && [ "$(cat "$cache_dir/attempted-utc" 2>/dev/null)" = "$today" ]; then
            MEFISTO_OPENCODE_PRICING_CATALOG="$cache_file"
            runtime_opencode_pricing_warn_if_stale "$cache_file" "$today"
            MEFISTO_OPENCODE_PRICING_PREPARED_FOR="$current"
            return 0
        fi
    fi

    runtime_opencode_prepare_pricing >/dev/null
    MEFISTO_OPENCODE_PRICING_PREPARED_FOR="$current"
}

# --- runtime_opencode_build_cmd ---------------------------------------------

runtime_opencode_build_cmd() {
    # El tercer posicional del CONTRATO se llama <prompt_file> (ver cabecera y
    # src/runtime/contract/README.md); aqui el local se llama "prompt_path"
    # para marcar que este adaptador solo lo ATRAVIESA como archivo -- `cat`
    # o `cp` hacia el archivo de mensaje -- y nunca vuelca su contenido a una
    # variable: el idiom retirado por #1448 -- volcar <prompt_file> a una
    # variable con una sustitucion de comandos y pasarla en el argv, rehen de
    # ARG_MAX -- no queda ni como ocurrencia parcial.
    # `opencode run` no tiene equivalente de `--append-system-prompt-file`,
    # asi que a diferencia de runtime-claude.sh este adaptador si tiene que
    # componer un archivo propio.
    local agent="$1" cwd="$2" prompt_path="$3" model="$4" system_file="$5" resume_session_id="${6:-}"

    MEFISTO_RUNTIME_CMD=(opencode run --agent "$agent" --dir "$cwd" --format json --auto)

    # MEF-ADR-0053 decision 2: el agente descubre la superficie de la release que corre
    # el pipeline (una release tiene forma de directorio de configuracion de OpenCode).
    # Se omite si el usuario ya fija OPENCODE_CONFIG_DIR (seria reemplazarle su
    # directorio) o si la proyeccion global opt-in esta activa (cargaria cada plugin
    # dos veces); en ambos casos el cargador commiteado del worktree lo activa.
    local package_root="${MEFISTO_AGENT_PACKAGE_ROOT:-}"
    local ledger="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/.mefisto-projection.json"
    if [ -n "$package_root" ] && [ -f "$package_root/mefisto-manifest.json" ] && [ -d "$package_root/agents" ] \
        && [ -z "${OPENCODE_CONFIG_DIR:-}" ] && [ ! -f "$ledger" ]; then
        MEFISTO_RUNTIME_CMD=(env "OPENCODE_CONFIG_DIR=$package_root" "${MEFISTO_RUNTIME_CMD[@]}")
    fi

    if [ -n "$model" ]; then
        MEFISTO_RUNTIME_CMD+=(-m "$model")
    fi

    if [ -n "$resume_session_id" ]; then
        MEFISTO_RUNTIME_CMD+=(--session "$resume_session_id")
    fi

    # MEFISTO_RUNTIME_STDIN_FILE (issue #1448): el mensaje (system + "\n\n" +
    # prompt, o solo el prompt sin system-file) se materializa DENTRO de
    # MEFISTO_RUNTIME_WORK_DIR -- que mefisto-run-agent.sh ya expuso antes de
    # invocar esta funcion (ver src/runtime/contract/README.md) -- nunca en
    # /tmp suelto ni en el worktree. `cp` para el caso sin system-file evita
    # una lectura completa innecesaria del archivo.
    # Sin directorio de corrida no hay donde materializarlo, y la alternativa
    # (volver a poner el mensaje en el argv, o escribirlo en la raiz del
    # filesystem si la variable llega vacia) es exactamente lo que este issue
    # elimina: se falla explicito y se vacia MEFISTO_RUNTIME_CMD, la senal que
    # mefisto-run-agent.sh ya traduce a exit 69. Sin este guardia, un caller
    # con `set -u` (el propio runner lo usa) moriria antes con un
    # "unbound variable" que no nombra la causa. Mismo criterio defensivo que
    # runtime-fake.sh.
    if [ -z "${MEFISTO_RUNTIME_WORK_DIR:-}" ] || [ ! -d "$MEFISTO_RUNTIME_WORK_DIR" ]; then
        echo "ERROR: runtime_opencode_build_cmd necesita MEFISTO_RUNTIME_WORK_DIR (directorio de la corrida, issue #1447) para materializar el mensaje del CLI" >&2
        MEFISTO_RUNTIME_CMD=()
        return 1
    fi

    local message_file="$MEFISTO_RUNTIME_WORK_DIR/opencode-message.md"
    # Una sola redireccion para los tres tramos (no tres `>>`): si la escritura
    # falla a medias, el mensaje que recibiria el modelo estaria TRUNCADO y el
    # CLI arrancaria igual -- un fallo silencioso de la misma familia que
    # #1407. El `||` lo convierte en aborto explicito.
    if [ -n "$system_file" ]; then
        if ! { cat "$system_file" && printf '\n\n' && cat "$prompt_path"; } > "$message_file"; then
            echo "ERROR: runtime_opencode_build_cmd no pudo escribir el mensaje en '$message_file'" >&2
            MEFISTO_RUNTIME_CMD=()
            return 1
        fi
    elif ! cp "$prompt_path" "$message_file"; then
        echo "ERROR: runtime_opencode_build_cmd no pudo copiar el prompt a '$message_file'" >&2
        MEFISTO_RUNTIME_CMD=()
        return 1
    fi
    MEFISTO_RUNTIME_STDIN_FILE="$message_file"
}

# runtime_opencode_supports_resume (issue #968, CA-4 caso b)
#
# OpenCode soporta reanudacion de sesion en modo headless via `-s/--session
# <id>` (con `--fork` opcional para bifurcar en vez de continuar la misma
# sesion, que este adaptador no usa) -- verificado en `opencode run --help`
# local. Retorna 0 siempre; consumida por `runtime_supports_resume`
# (mefisto-tooling-pipeline.sh) para decidir si el hold de #967 puede
# reanudar en vez de repetir el stage desde cero.
runtime_opencode_supports_resume() {
    return 0
}

# runtime_opencode_interactive_refresh (issue #1332)
#
# OpenCode no recarga commands/agents/skills durante una sesion viva. `/exit`
# es el comando de salida mostrado por la ayuda del TUI local; el consumidor lo
# envia, espera el proceso y relanza el runtime en el mismo pane.
runtime_opencode_interactive_refresh() {
    printf '%s\n' 'restart /exit'
}

# --- runtime_opencode_translate ----------------------------------------------

runtime_opencode_translate() {
    local raw_file="$1" runtime_id="$2" model="$3" exit_code="${4:-}" stderr_file="${5:-}"
    [ -f "$raw_file" ] || return 0
    command -v jq >/dev/null 2>&1 || return 0

    local self_dir
    self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local jq_program="$self_dir/runtime-opencode.jq"
    [ -f "$jq_program" ] || return 0

    # `--rawfile` exige un archivo legible: sin stderr conocido se apunta a
    # /dev/null, que jq lee como cadena vacia (ningun patron casa y la
    # clasificacion cae en lo que el exit code/stream si permitan afirmar).
    local stderr_src="/dev/null"
    if [ -n "$stderr_file" ] && [ -f "$stderr_file" ]; then
        stderr_src="$stderr_file"
    fi

    runtime_opencode_ensure_pricing
    local pricing_src="/dev/null"
    if [ -n "$MEFISTO_OPENCODE_PRICING_CATALOG" ] && [ -f "$MEFISTO_OPENCODE_PRICING_CATALOG" ]; then
        pricing_src="$MEFISTO_OPENCODE_PRICING_CATALOG"
    fi

    jq -R -s -c \
        --arg runtime "$runtime_id" \
        --arg model_param "$model" \
        --arg exit_code "$exit_code" \
        --rawfile stderr_text "$stderr_src" \
        --rawfile pricing_catalog_text "$pricing_src" \
        -f "$jq_program" \
        "$raw_file" 2>/dev/null
    return 0
}
