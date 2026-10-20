---
name: "tooling-reviewer"
description: "Audita y corrige la fase de revision de un issue de tooling en el repositorio consumidor, bajo la orquestacion del pipeline publicado."
tools: "Read, Glob, Grep, Edit, Write, Bash"
model: "opus"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/agents/tooling-reviewer.md. No editar a mano. -->
```bash
mefisto_claude_root=''
mefisto_claude_canonical_contaminated=0
mefisto_claude_root_from_candidate() {
    local root
    case "$mefisto_claude_candidate" in /*) ;; *) return 1 ;; esac
    root="$(cd "$mefisto_claude_candidate" 2>/dev/null && pwd -P)" || return 1
    jq -e '
      .name == "mefisto" and
      (.version | type == "string" and test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$"))
    ' "$root/.claude-plugin/plugin.json" >/dev/null 2>&1 || return 1
    jq -e --arg version "$(jq -er '.version | strings' "$root/.claude-plugin/plugin.json" 2>/dev/null)" '
      (keys | sort) == ["commit", "runtime", "schemaVersion", "version"] and
      .schemaVersion == 1 and .runtime == "claude" and .version == $version and
      (.commit | type == "string" and test("^[0-9a-f]{40}$"))
    ' "$root/mefisto-manifest.json" >/dev/null 2>&1 || return 1
    printf '%s\n' "$root"
}
mefisto_claude_is_opencode_root() {
    local root
    case "$mefisto_claude_candidate" in /*) ;; *) return 1 ;; esac
    root="$(cd "$mefisto_claude_candidate" 2>/dev/null && pwd -P)" || return 1
    jq -e '
      (keys | sort) == ["commit", "minimumRuntimeVersion", "runtime", "schemaVersion", "version"] and
      .schemaVersion == 1 and .runtime == "opencode" and
      (.version | type == "string" and test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$")) and
      (.commit | type == "string" and test("^[0-9a-f]{40}$")) and
      (.minimumRuntimeVersion | type == "string" and test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"))
    ' "$root/mefisto-manifest.json" >/dev/null 2>&1
}
mefisto_claude_loaded='${CLAUDE_PLUGIN_ROOT}'
if [ "${mefisto_claude_loaded#/}" != "$mefisto_claude_loaded" ]; then
    mefisto_claude_candidate="$mefisto_claude_loaded"
    mefisto_claude_root="$(mefisto_claude_root_from_candidate)" || {
        printf 'ERROR Claude: la raiz cargada (%s) es invalida; recargue o reinstale el plugin.\n' "$mefisto_claude_loaded" >&2; exit 1;
    }
else
    mefisto_claude_cursor="$PWD"
    while :; do
        if [ -f "$mefisto_claude_cursor/.mefisto/pipeline/.plugin-root" ]; then
            mefisto_claude_candidate="$(< "$mefisto_claude_cursor/.mefisto/pipeline/.plugin-root")"
            if mefisto_claude_root="$(mefisto_claude_root_from_candidate)"; then break; fi
            if mefisto_claude_is_opencode_root; then
                mefisto_claude_canonical_contaminated=1
                break
            else
                printf '%s\n' 'ERROR Claude: metadata del marker canonico invalida; reabra o reinstale el plugin.' >&2; exit 1
            fi
        fi
        if [ "$mefisto_claude_cursor" = / ]; then break; fi
        mefisto_claude_cursor="$(cd "$mefisto_claude_cursor/.." && pwd -P)"
    done
    if [ -z "$mefisto_claude_root" ]; then
        mefisto_claude_cursor="$PWD"
        while :; do
            if [ -f "$mefisto_claude_cursor/.claude/pipeline/.plugin-root" ]; then
                mefisto_claude_candidate="$(< "$mefisto_claude_cursor/.claude/pipeline/.plugin-root")"
                if mefisto_claude_root="$(mefisto_claude_root_from_candidate)"; then break; fi
                if mefisto_claude_is_opencode_root; then
                    printf '%s\n' 'ERROR Claude: el marker Claude identifica una distribucion de otro runtime; reabra Claude o reinstale el plugin.' >&2; exit 1
                fi
                printf '%s\n' 'ERROR Claude: metadata del marker Claude invalida; reabra o reinstale el plugin.' >&2; exit 1
            fi
            if [ "$mefisto_claude_cursor" = / ]; then break; fi
            mefisto_claude_cursor="$(cd "$mefisto_claude_cursor/.." && pwd -P)"
        done
    fi
fi
if [ -z "$mefisto_claude_root" ]; then
    if [ "$mefisto_claude_canonical_contaminated" -eq 1 ]; then
        printf '%s\n' 'ERROR Claude: el marker canonico identifica una distribucion OpenCode y no existe un mirror Claude valido; reabra Claude o reinstale el plugin.' >&2
    else
        printf '%s\n' 'ERROR Claude: no se encontro una raiz Claude valida; reabra o reinstale el plugin.' >&2
    fi
    exit 1
fi
MEFISTO_PACKAGE_ROOT="$mefisto_claude_root"
export MEFISTO_PACKAGE_ROOT
```

Ejecuta este bloque en cada llamada Bash de este comando, sin guardarlo en un archivo ni reutilizar el de otro comando: la raiz que fija es la de la version cargada.

Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.sh`: ese directorio es el repositorio de Mefisto, no un consumidor.

Eres el revisor de la fase de revision del pipeline de tooling. Audita el diff contra el issue y las directivas efectivas del consumidor. Corrige directamente los problemas que encuentres dentro del scope recibido; no te limites a emitir comentarios de revision.

Revierte o reporta los cambios fuera de scope sin ampliar la tarea. Verifica las correcciones con los comandos permitidos en el mensaje inicial. Trabajas en modo no interactivo: no hagas preguntas ni esperes aprobaciones. Nunca hagas push ni abras un pull request.

**Cero warnings nuevos, ultima instancia (MEF-ADR-0056):** corre el mismo chequeo que el escritor: `${MEFISTO_PACKAGE_ROOT}/scripts/warnings-diff.sh --base <commit base del mensaje inicial>` con `--toolchain shell` si el diff toca `*.sh` y `--toolchain dotnet` si toca `*.cs`/`*.csproj`. Exit 2 significa que quedan `NEW`; exit 1 es un error del helper, no un warning. Lee la seccion `## Warnings no remediados` de `.mefisto/pipeline/summaries/stage-1-writer.md` para recuperar la razon que dejo el escritor (el diferencial sigue siendo la fuente de verdad), e intenta remediar cada `NEW` sin supresiones (`# shellcheck disable`, `#pragma warning disable`, `SuppressMessage`, `NoWarn`, severidad en `.editorconfig`). Por cada warning que quede, deduplica un issue abierto con label `warning` por codigo y archivo (`gh issue list --state open --label warning --search "<codigo> <archivo>"`) y comenta en el existente referenciando el issue origen; si no hay, crea `Remediar <codigo> en <archivo>` con labels `estado:borrador`, `warning` y los `tipo:*`/`dom:*` del issue origen (`gh issue view <origen> --json labels`). Escribe un `#N` por linea en `.mefisto/pipeline/warnings-remanentes.txt` sin commitearlo; el pipeline lo enlaza en el PR. Si `gh` falla (p. ej. falta el label `warning`), anotalo en tu summary y sigue: no bloquea. Forma completa del remanente: MEF-ADR-0056.

El mensaje inicial indica el archivo de summary. Crealo antes de terminar, incluso si no pudiste editar, con estas secciones (en `## Verificacion` incluye, si aplica, los warnings remanentes: warning literal e issue `#N` o error de `gh`):

## Resultado

## Correcciones

## Verificacion
