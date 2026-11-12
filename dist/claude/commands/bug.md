---
description: "Investiga un sintoma: lo clasifica como bug de tooling local o de entorno desplegado y enruta al agente investigador apropiado."
argument-hint: "[--tooling|--deployed] <descripcion del sintoma>"
model: "haiku"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.mts desde src/published/commands/bug.md. No editar a mano. -->
```bash
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' 2>/dev/null; then
    printf '%s\n' 'FALTA: Node >= 22.18 no esta en el PATH: los comandos y hooks de Mefisto no corren. Instala Node 22.18 o superior (https://nodejs.org/en/download).' >&2; exit 1
fi
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

Investiga un error o sintoma reportado. Clasifica automaticamente si es un bug de tooling local o del entorno desplegado, y enruta al agente apropiado. Comunicate en **espanol**.

Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.mts`: ese directorio es el repositorio de Mefisto, no un consumidor.

Para bugs del propio plugin Mefisto este comando no aplica: remite al mantenedor del plugin a trabajar dentro del repo de Mefisto.

## Entrada

El sintoma esta en: $ARGUMENTS

Si `$ARGUMENTS` esta vacio, responde: `Uso: /mefisto:bug [descripcion del sintoma]` y termina.

## Proceso

### 1. Parsear flags explicitos

Extrae flags de `$ARGUMENTS`:
- Si contiene `--tooling`: enrutar directamente a `tooling-investigator`. Elimina el flag del sintoma.
- Si contiene `--deployed`: enrutar directamente a `bug-investigator`. Elimina el flag del sintoma.
- Si hay flag explicito, salta al paso 4 (sin clasificacion heuristica).

### 2. Clasificar por heuristica (case-insensitive, busqueda de substrings)

**Indicadores de tooling**:
`pipeline`, `skill`, `agente`, `herdr`, `script`, `/implement`, `/tooling`, `status`, `.claude/`, `.mefisto/`, `worktree`, `tooling-status`, `pipeline-status`

**Indicadores de entorno desplegado**:
`produccion`, `excepcion`, `Service Bus`, `dead letter`, `Function App`, `timeout`, `500`, `App Insights`, `NullReferenceException`

Busca coincidencias del sintoma contra ambas listas.

### 3. Resolver ambiguedad

- Si **solo** hay indicadores de tooling -> enrutar a `tooling-investigator`
- Si **solo** hay indicadores de entorno desplegado -> enrutar a `bug-investigator`
- Si hay indicadores de **ambas** categorias, o **ninguna** -> preguntar al usuario:

```
No puedo determinar automaticamente el tipo de bug.

El sintoma: "$ARGUMENTS"

Es un bug de:
1. **Tooling local** (pipelines, skills, agentes, scripts, worktrees)
2. **Entorno desplegado** (Azure Functions, Service Bus, App Insights)

Responde 1 o 2.
```

Espera la respuesta del usuario antes de continuar.

### 4. Enrutar al agente

El sintoma que se le pasa al agente es `$ARGUMENTS` sin los flags.

#### Si tooling:

Delega sin validar prerequisitos de Azure:

invoca la tool `Task` con el agente `mefisto:tooling-investigator` y este mensaje: Sintoma reportado: <sintoma sin flags>. Espera su resultado final y continua con el paso siguiente del comando.

Responde con:

```
Agente tooling-investigator lanzado.
Sintoma: [SINTOMA]

El agente investigara scripts, pipelines, skills y agentes locales,
y te presentara hipotesis antes de tomar accion.
```

#### Si entorno desplegado:

Valida primero los prerequisitos, en este orden, y no delegues si alguno falla.

1. Sesion de Azure:

```bash
MEFISTO_RUNTIME=claude node "${MEFISTO_PACKAGE_ROOT}/scripts/azure-account-info.mts" 2>&1
```

Si sale con codigo distinto de `0`, muestra tal cual el mensaje que emitio el script (indica iniciar sesion en Azure) y termina sin delegar.

2. Configuracion de telemetria: verifica que existe `.mefisto/appinsights.env` en la raiz del consumidor:

```bash
test -f .mefisto/appinsights.env && echo "OK" || echo "FAIL"
```

Si falta, responde con el formato que espera `appinsights-query.mts` y termina sin delegar:

```
No se encontro .mefisto/appinsights.env en la raiz del consumidor.
Crea ese archivo con los nombres de recursos (sin secretos, versionable):
  APPINSIGHTS_APP=<nombre del App Insights>
  APPINSIGHTS_RG=<resource group del App Insights y las Function Apps>
  SERVICEBUS_NAMESPACE=<namespace de Service Bus>
  SERVICEBUS_RG=<resource group de Service Bus>
  FUNCTIONAPP_NAMES=<function apps separadas por coma>
```

Si ambas validaciones pasan, delega:

invoca la tool `Task` con el agente `mefisto:bug-investigator` y este mensaje: Sintoma reportado: <sintoma sin flags>. Espera su resultado final y continua con el paso siguiente del comando.

Responde con:

```
Agente bug-investigator lanzado.
Sintoma: [SINTOMA]

El agente investigara en App Insights, correlacionara con el codigo
y te presentara hipotesis antes de tomar accion.
```

## Reglas

- **No investigues nada tu mismo.** Solo clasifica, valida y lanza el agente.
- **No modifiques codigo.** Ningun agente puede hacerlo.
