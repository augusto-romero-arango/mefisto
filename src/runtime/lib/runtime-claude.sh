#!/usr/bin/env bash
# runtime-claude.sh -- Adaptador de runtime Claude Code (MEF-ADR-0049, issue
# #859). Unico lugar del repo (fuera de tests/fixtures/shims generados) que
# compone la invocacion `claude -p` y traduce su stream-json al JSONL neutral
# de src/runtime/contract/run-events.schema.json -- ver
# src/runtime/contract/README.md.
#
# Gemela de lib/runtime-claude.mts, la que usa el runner (MEF-ADR-0057): un
# cambio va en los dos lados.
#
# Claude Code sigue siendo runtime soportado por compatibilidad, nunca
# dependencia del nucleo (MEF-ADR-0049): ningun otro archivo del harness debe
# nombrar `claude`, `--permission-mode`, `--append-system-prompt-file` ni
# `--output-format stream-json` -- eso vive aqui.
#
# Implementa la interfaz de funciones que todo adaptador de runtime debe
# exponer (ver src/runtime/contract/README.md, "Interfaz de adaptador"):
#   runtime_claude_build_cmd <agent> <cwd> <prompt_file> <model> <system_file>
#                            [<resume_session_id>] [<effort>]
#     Rellena MEFISTO_RUNTIME_CMD con el argv de `claude -p` (sin `eval`,
#     paridad con run_agent_with_watchdog -- ver #424/_mefisto-common.sh) y
#     SIN prompt posicional (issue #1448; incidente de #1407): fija la
#     variable global MEFISTO_RUNTIME_STDIN_FILE a <prompt_file> tal cual --
#     ya es un archivo regular legible que mefisto-run-agent.sh valido antes
#     de invocar esta funcion, asi que declararlo como canal de stdin no
#     exige releer su contenido: esta funcion nunca vuelca ese archivo a una
#     variable ni lo concatena.
#     `lib/mefisto-process.sh` conecta ESE archivo a la entrada estandar del
#     proceso en vez del argv, que sigue sujeto a ARG_MAX (1.048.576 bytes en
#     macOS, `getconf ARG_MAX`; el incidente de #1407 fue un prompt de
#     3.237.916 bytes que el kernel rechazo en el `exec`, antes de que Claude
#     Code arrancara). <agent> participa como `--agent <id>` para que Claude
#     Code cargue la doctrina, skills y allowlist declaradas por el agente.
#     <cwd> ya lo aplica run_agent_with_watchdog (`cd "$workdir"` antes de
#     invocar), igual que runtime-fake.sh. <resume_session_id> (issue #968,
#     CA-1/CA-2) es OPCIONAL y opaco -- vacio/ausente = comportamiento
#     identico a antes de #968 (sin `--resume` en el argv); no vacio agrega
#     `--resume <id>` (compatible con `-p`, verificado en `claude --help`
#     local).
#   runtime_claude_translate <raw_file> <runtime_id> <model>
#                            [<exit_code>] [<stderr_file>]
#     Delega en runtime-claude.jq (`jq -R -s -c -f`, mismo idiom que
#     jsonschema-lite.jq vs. validate-internal-artifacts.sh): traduce la
#     traza cruda de <raw_file> al JSONL neutral. Nunca emite `run.started`
#     -- eso lo hace mefisto-run-agent.sh directo (issue #858).
#     Los dos ultimos argumentos son la extension OPCIONAL de la interfaz de
#     #858 (un adaptador que no los reciba sigue siendo valido, ver
#     src/runtime/contract/README.md): sin ellos la clasificacion de CA-3 no
#     es completable, porque `killed` (exit 137/143), el `API Error: <status>`
#     que Claude escribe SOLO por stderr (los canales siguen separados desde
#     #425) y `nonzero_exit` no son deducibles del stream de stdout. Vacios o
#     ausentes, la clasificacion degrada a lo que el stream si permite
#     afirmar, nunca inventa un veredicto.
#
# <effort> (issue #2496) es OPCIONAL y ya viene en nombre nativo: no vacio
# antepone `env CLAUDE_CODE_EFFORT_LEVEL=<effort>` al argv (nunca `--effort`:
# el nivel por variable de entorno prevalece sobre el campo `effort` del
# frontmatter del agente, y el flag solo fija el de sesion); vacio/ausente no
# agrega nada.
#
# Flags que compone build_cmd (CA-1): `--agent <agent>`, `--permission-mode
# bypassPermissions` y `--output-format stream-json --verbose` siempre;
# `--append-system-prompt-file <system_file>` (issue #1448: la RUTA, nunca el
# contenido) solo si <system_file> no es vacio; `--model
# <model>` solo si el runner entrego un modelo no vacio (CA-1 de #858:
# vacio/ausente = heredar, el adaptador real nunca debe ver un `--model ""`).
# `--plugin-dir <raiz>` solo si MEFISTO_AGENT_PACKAGE_ROOT apunta a una raiz
# de plugin Claude (la exportan los pipelines publicados; los internos no).
# `--append-system-prompt-file` existe ademas de `--append-system-prompt`,
# verificado en Claude Code 2.1.276 local: `claude --help` lo lista en forma
# abreviada (`--append-system-prompt[-file]`) y la sonda
# `claude -p --append-system-prompt-file <ruta-inexistente>` responde
# "Error: Append system prompt file not found: <ruta>" -- es decir, el parser
# lo acepta (una opcion desconocida responde "error: unknown option").
# El orden de los flags es irrelevante para quien los consume (el CLI real, y
# el stub de test-runtime-claude.sh que solo comprueba presencia/ausencia). Un
# `--model` explicito del runner tiene precedencia sobre `model:` del
# frontmatter del agente; sin `--model`, Claude Code aplica el frontmatter.
#
# Bash 3.2 + jq 1.7 (MEF-ADR-0049 CA-6): sin arrays asociativos.

runtime_claude_is_available() {
    command -v claude >/dev/null 2>&1
}

runtime_claude_default_model() {
    case "$1" in
        fast) printf '%s' "haiku" ;;
        balanced) printf '%s' "sonnet" ;;
        deep) printf '%s' "opus" ;;
        *) return 1 ;;
    esac
}

runtime_claude_default_effort() {
    case "$1" in
        quick) printf '%s' "low" ;;
        light) printf '%s' "medium" ;;
        standard) printf '%s' "high" ;;
        thorough) printf '%s' "xhigh" ;;
        exhaustive) printf '%s' "max" ;;
        *) return 1 ;;
    esac
}

# --- runtime_claude_build_cmd ------------------------------------------------

runtime_claude_build_cmd() {
    local agent="$1" cwd="$2" prompt_file="$3" model="$4" system_file="$5" resume_session_id="${6:-}" effort="${7:-}"

    MEFISTO_RUNTIME_CMD=(claude -p --agent "$agent" --permission-mode bypassPermissions --output-format stream-json --verbose)

    if [ -n "$model" ]; then
        MEFISTO_RUNTIME_CMD+=(--model "$model")
    fi

    if [ -n "$resume_session_id" ]; then
        MEFISTO_RUNTIME_CMD+=(--resume "$resume_session_id")
    fi

    if [ -n "$system_file" ]; then
        MEFISTO_RUNTIME_CMD+=(--append-system-prompt-file "$system_file")
    fi

    # MEF-ADR-0053 decision 2: el agente carga el plugin de la release que
    # corre el pipeline, no la instalacion registrada para la ruta del
    # worktree (que puede no existir, estar deshabilitada o ser otra version).
    # `--plugin-dir` precede a la copia instalada (verificado en 2.1.296).
    local package_root="${MEFISTO_AGENT_PACKAGE_ROOT:-}"
    if [ -n "$package_root" ] && [ -f "$package_root/.claude-plugin/plugin.json" ]; then
        MEFISTO_RUNTIME_CMD+=(--plugin-dir "$package_root")
    fi

    if [ -n "$effort" ]; then
        MEFISTO_RUNTIME_CMD=(env "CLAUDE_CODE_EFFORT_LEVEL=$effort" "${MEFISTO_RUNTIME_CMD[@]}")
    fi

    # MEFISTO_RUNTIME_STDIN_FILE (issue #1448): <prompt_file> viaja tal cual,
    # sin volver a leerlo ni tocarlo -- el canal de stdin, no el argv, es lo
    # que transporta el prompt (ver cabecera de este archivo y "Runner y
    # adaptadores" en src/runtime/contract/README.md).
    MEFISTO_RUNTIME_STDIN_FILE="$prompt_file"
}

# runtime_claude_supports_resume (issue #968, CA-4 caso b)
#
# Claude Code soporta reanudacion de sesion en modo headless via `--resume
# <session-id>` (alias corto `-r`), compatible con `-p` -- verificado en
# `claude --help` local. Retorna 0 siempre; consumida por
# `runtime_supports_resume` (mefisto-tooling-pipeline.sh) para decidir si el
# hold de #967 puede reanudar en vez de repetir el stage desde cero.
runtime_claude_supports_resume() {
    return 0
}

# runtime_claude_interactive_refresh (issue #1332)
#
# Claude Code recarga los plugins de una sesion interactiva con el comando de
# barra `/reload-plugins`, verificado en `claude --help` local. El consumidor
# inyecta este texto en el pane; el adaptador no opera la sesion directamente.
runtime_claude_interactive_refresh() {
    printf '%s\n' 'prompt /reload-plugins'
}

# --- runtime_claude_translate -------------------------------------------------

runtime_claude_translate() {
    local raw_file="$1" runtime_id="$2" model="$3" exit_code="${4:-}" stderr_file="${5:-}"
    [ -f "$raw_file" ] || return 0
    command -v jq >/dev/null 2>&1 || return 0

    local self_dir
    self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local jq_program="$self_dir/runtime-claude.jq"
    [ -f "$jq_program" ] || return 0

    # `--rawfile` exige un archivo legible: sin stderr conocido se apunta a
    # /dev/null, que jq lee como cadena vacia (ningun patron casa y la
    # clasificacion cae en lo que el stream de stdout permita afirmar).
    local stderr_src="/dev/null"
    if [ -n "$stderr_file" ] && [ -f "$stderr_file" ]; then
        stderr_src="$stderr_file"
    fi

    jq -R -s -c \
        --arg runtime "$runtime_id" \
        --arg model_param "$model" \
        --arg exit_code "$exit_code" \
        --rawfile stderr_text "$stderr_src" \
        -f "$jq_program" \
        "$raw_file" 2>/dev/null
    return 0
}
