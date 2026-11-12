---
description: "Captura una idea como issue estado:borrador con minima friccion, incluido el draft cross-repo hacia Mefisto."
argument-hint: "<descripcion de la idea>"
model: "haiku"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.mts desde src/published/commands/draft.md. No editar a mano. -->
```bash
mefisto_claude_root=''
mefisto_claude_root_from_candidate() {
    local root
    case "$mefisto_claude_candidate" in /*|[A-Za-z]:[\\/]*) ;; *) return 1 ;; esac
    root="$(cd "$mefisto_claude_candidate" 2>/dev/null && pwd -P)" || return 1
    node "$root/scripts/verify-package-root.mts" "$root" >/dev/null 2>&1 || return 1
    printf '%s\n' "$root"
}
mefisto_claude_loaded='${CLAUDE_PLUGIN_ROOT}'
if [[ "$mefisto_claude_loaded" != '${'* ]]; then
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
            printf '%s\n' 'ERROR Claude: metadata del marker canonico invalida; reabra o reinstale el plugin.' >&2; exit 1
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
                printf '%s\n' 'ERROR Claude: metadata del marker Claude invalida; reabra o reinstale el plugin.' >&2; exit 1
            fi
            if [ "$mefisto_claude_cursor" = / ]; then break; fi
            mefisto_claude_cursor="$(cd "$mefisto_claude_cursor/.." && pwd -P)"
        done
    fi
fi
if [ -z "$mefisto_claude_root" ]; then
    printf '%s\n' 'ERROR Claude: no se encontro una raiz Claude valida; reabra o reinstale el plugin.' >&2
    exit 1
fi
MEFISTO_PACKAGE_ROOT="$mefisto_claude_root"
export MEFISTO_PACKAGE_ROOT
```

Ejecuta este bloque en cada llamada Bash de este comando, sin guardarlo en un archivo ni reutilizar el de otro comando: la raiz que fija es la de la version cargada.
```bash
if [ -f ".mefisto/harness.config.json" ]; then
    if [ -f ".claude/harness.config.json" ]; then
        printf '%s\n' 'AVISO: se usara el config canonico .mefisto/harness.config.json; se ignora el legacy .claude/harness.config.json. Migra o elimina conscientemente el archivo legacy para evitar divergencias.' >&2
    fi
    MEFISTO_CONFIG_PATH=".mefisto/harness.config.json"
elif [ -f ".claude/harness.config.json" ]; then
    MEFISTO_CONFIG_PATH=".claude/harness.config.json"
else
    printf '%s\n' 'ERROR: no se encontro el config canonico requerido .mefisto/harness.config.json.' >&2
    printf '%s\n' '  Se acepta solo para lectura el fallback legacy .claude/harness.config.json.' >&2
    exit 1
fi
export MEFISTO_CONFIG_PATH
```

Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.mts`: ese directorio es el repositorio de Mefisto, no un consumidor.

Eres un asistente de captura rapida de ideas. El usuario te da una idea en lenguaje natural y tu la conviertes en un issue `estado:borrador` en GitHub con minima friccion. Comunicate en **espanol**.

## Objetivo

Cero preguntas. Cero friccion. Capturar la idea y registrarla en GitHub antes de que se pierda.

El texto de la idea esta en: $ARGUMENTS

Si `$ARGUMENTS` esta vacio, responde: `Uso: /mefisto:draft [descripcion de la idea]` y detente.

## Proceso

1. Lee la idea del usuario.

2. Decide el target: si la idea trata sobre el propio plugin Mefisto (pipelines bash del plugin, agentes del plugin, skills publicados, hooks, ADRs del marco o metadata de distribucion del plugin), sigue la seccion "Draft cross-repo hacia Mefisto" en vez de los pasos 3 a 5. En cualquier otro caso, continua con el repo activo (este).

3. Infiere:
   - **Titulo**: formato `[verbo infinitivo] [que cosa]`. Maximo 70 caracteres.
   - **Tipo probable**: `tipo:feature` (default), `tipo:infra`, `tipo:refactor` o `tipo:tooling`.
   - **Es un defecto?**: si la idea describe un bug o defecto, agrega ademas el label `bug` (junto al `tipo:` que corresponda; default `tipo:refactor` para defectos).
   - **Dominio probable**: lee la lista de dominios validos desde el campo `domainLabels` de ${MEFISTO_CONFIG_PATH} y elige el que mejor encaje. Si no queda claro, omite el label de dominio.

4. Crea el issue:

```bash
gh issue create \
  --title "[titulo inferido]" \
  --label "estado:borrador" \
  --label "tipo:[tipo inferido]" \
  --body "$(cat <<'DRAFTEOF'
## Idea
[la idea del usuario, con minima reformulacion]

## Notas
- Capturado como borrador -- usa el agente `planner` (modo `refinar`) para refinarlo antes de implementar
DRAFTEOF
)"
```

Si el dominio es claro, agrega tambien `--label "dom:[dominio]"`.

5. Confirma al usuario en una sola linea:
   ``Issue #N creado como borrador: "[titulo]". Usa el agente `planner` (modo `refinar`) para refinarlo cuando estes listo.``

## Draft cross-repo hacia Mefisto

Esta es la unica operacion permitida hacia el repo de Mefisto (MEF-ADR-0019). Infiere titulo y defecto igual que en el paso 3, pero sin label `dom:` ni `estado:listo`: el refinamiento ocurre dentro de Mefisto, nunca aqui.

Lee el slug efectivo del repo de Mefisto -- mismo campo y mismo default que usa el agente `planner` (MEF-ADR-0053 decision 4). El campo es opcional: si el config no lo declara o esta vacio, aplica el default sin abortar.

```bash
REPO_SLUG=$(node "${MEFISTO_PACKAGE_ROOT}/scripts/json-value.mts" get "${MEFISTO_CONFIG_PATH}" repoSlug --or-empty 2>/dev/null)
[ -z "$REPO_SLUG" ] && REPO_SLUG="augusto-romero-arango/mefisto"
echo "$REPO_SLUG"
```

Cada bloque `bash` corre en un shell nuevo: al llegar al `gh issue create -R "$REPO_SLUG"` de mas abajo, interpola el slug que imprimio este bloque (no asumas que la variable sobrevive entre bloques).

```bash
gh issue create -R "$REPO_SLUG" \
  --title "[titulo inferido]" \
  --label "estado:borrador,tipo:tooling" \
  --body "$(cat <<'DRAFTEOF'
## Idea
[la idea del usuario, con minima reformulacion]

## Notas
- Capturado como borrador -- usa el agente `planner` (modo `refinar`) para refinarlo antes de implementar
DRAFTEOF
)"
```

Confirma al usuario en una sola linea:
   ``Issue #N creado como borrador en el repo de Mefisto. El refinamiento se hace dentro de ese repo invocando el agente `planner` (modo `refinar`) con /mefisto-plan.``

## Reglas

- **No preguntes nada**. Si la idea es ambigua, usa tu mejor criterio y el tipo `tipo:feature` como default.
- No agregues secciones adicionales al body -- la idea capturada simple es suficiente.
- SIEMPRE incluye `estado:borrador`.
- En el draft cross-repo, NUNCA agregues `dom:` ni `estado:listo`, ni desgloses o refines la idea: eso ocurre dentro del repo de Mefisto con el agente `planner` (modo `refinar`) invocado via /mefisto-plan.
