#!/usr/bin/env bash
# mefisto-scope-hook.sh -- Hook PostToolUse (matcher Edit|Write) del pipeline
# interno de Mefisto (issue #523, paso 2 del plan de velocidad -- ver #481/#482).
#
# Avisa EN EL INSTANTE en que un Edit/Write cae fuera del scope permitido para
# el propio plugin, gratis (bash deterministico, cero turnos), para que el
# agente no tenga motivo para inspeccionar el arbol preventivamente contra un
# gate que validate_mefisto_scope_changes ya evalua al final de cada stage.
# Este hook es feedback temprano, NO reemplaza ese gate final.
#
# Lee el input JSON del tool call por stdin (docs de hooks de Claude Code,
# https://docs.claude.com/en/docs/claude-code/hooks): extrae tool_input.file_path,
# lo relativiza a la raiz del repo y lo valida con is_path_in_mefisto_scope
# (_mefisto-common.sh). Semantica de PostToolUse + exit 2: el tool ya corrio (no
# se puede bloquear retroactivamente), pero el stderr se muestra a Claude como
# feedback del tool call -- exactamente lo que sustituye la auto-inspeccion.
# Por eso el mensaje pide REVERTIR lo ya escrito, no "no lo escribas".
#
# PARIDAD CON EL GATE FINAL: validate_mefisto_scope_changes juzga sobre
# `git diff --name-only` + `git status --porcelain`, y ninguno de los dos lista
# archivos ignorados por git. Un Write a una ruta ignorada (.claude/pipeline/**,
# .claude/settings.local.json, *.log) es por tanto INVISIBLE para el gate final
# y este hook tampoco debe avisar por el. Sin esa exclusion, el resumen de stage
# que el pipeline EXIGE a cada agente (.claude/pipeline/summaries/stage-N-*.md,
# ruta ignorada y fuera de la allowlist) dispararia un falso positivo en cada
# corrida -- gastando exactamente los turnos de confusion que este hook existe
# para eliminar.
#
# Degrada seguro (exit 0) ante cualquier entrada no parseable, archivo fuera del
# worktree o fallo propio (jq ausente, _mefisto-common.sh no sourceable): este
# hook nunca es la fuente de verdad, solo un aviso -- el gate final
# (validate_mefisto_scope_changes) sigue siendo el juez.
#
# SOLO APLICA A SESIONES CLAUDE CODE (issue #863): este mecanismo de hooks
# (`.claude/settings.json` -> PostToolUse) es propio de Claude Code. No
# reemplaza el gate final: `validate_mefisto_scope_changes` sigue siendo el
# juez (MEF-ADR-0031).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/_mefisto-common.sh" 2>/dev/null

# Si la allowlist no quedo definida (archivo movido, renombrado o corrupto) no
# hay con que juzgar: callar es la degradacion correcta -- bloquear aqui seria
# bloquear por un error propio del hook, justo lo que CA-3 prohibe.
declare -F is_path_in_mefisto_scope >/dev/null || exit 0

command -v jq >/dev/null 2>&1 || exit 0

INPUT="$(cat)"

FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null)
[ -z "$FILE_PATH" ] && exit 0

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0

case "$FILE_PATH" in
    /*) ABS_PATH="$FILE_PATH" ;;
    *)  ABS_PATH="$REPO_ROOT/$FILE_PATH" ;;
esac

case "$ABS_PATH" in
    "$REPO_ROOT"/*) REL_PATH="${ABS_PATH#"$REPO_ROOT"/}" ;;
    *) exit 0 ;;
esac

is_path_in_mefisto_scope "$REL_PATH" && exit 0

# Ignorado por git -> invisible para el gate final -> nada que avisar (ver
# "PARIDAD CON EL GATE FINAL" arriba).
git -C "$REPO_ROOT" check-ignore -q -- "$REL_PATH" 2>/dev/null && exit 0

{
    echo "FUERA DE SCOPE: '$REL_PATH' no esta en la allowlist interna de Mefisto (is_path_in_mefisto_scope, src/internal/scripts/lib/_mefisto-common.sh). El gate final del stage (validate_mefisto_scope_changes) abortara el PR si el archivo sigue ahi."
    echo "Este aviso llega DESPUES de la escritura (hook PostToolUse): el archivo ya existe en el arbol, asi que revierte lo que acabas de hacer -- borralo si lo creaste, o 'git checkout -- $REL_PATH' si ya estaba versionado."
    echo "Rutas permitidas: commands/, skills/, agents/, scripts/, hooks/, docs/, .claude-plugin/, .claude/{commands,skills,agents,scripts,mods}/, .claude/settings.json, .mcp.json, src/{internal,published,runtime}/, dist/, AGENTS.md, changelog.d/, README.md, CHANGELOG.md, CLAUDE.md, .gitignore, LICENSE, NOTICE."
    echo "Si esta ruta deberia estar permitida, MEF-ADR-0019 seccion E exige registrarla PRIMERO en un PR aparte (is_path_in_mefisto_scope + is_path_in_consumer_blocklist) antes de poblarla: no la crees en este PR, reportalo en tu resumen de stage."
} >&2
exit 2
