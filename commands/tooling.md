---
description: "Lanza el pipeline de tooling del consumidor para un issue de GitHub."
argument-hint: "<issue> [--models 'agente=modelo[,agente=modelo...]'] [--variant <label>]"
model: "haiku"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/tooling.md. No editar a mano. -->
```bash
mefisto_claude_root=''
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

Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.sh`: ese directorio es el repositorio de Mefisto, no un consumidor.

Lanza el pipeline de tooling para un issue de GitHub. Comunicate en **espanol**.

**Alcance**: este comando solo lanza tareas de tooling del proyecto consumidor. No implementa logica de dominio ni cambia el plugin Mefisto. Si la causa pertenece a Mefisto, crea o enruta un draft en su repositorio y detiene esta ejecucion.

## Entrada

El numero de issue y los flags estan en: $ARGUMENTS

Si `$ARGUMENTS` esta vacio, no contiene un token compuesto solo por digitos, incluye un flag sin valor o presenta argumentos mal formados, muestra el motivo y responde con este uso accionable: `Uso: /mefisto:tooling <numero-de-issue> [--models 'agente=modelo[,agente=modelo...]'] [--variant <label>]`.

Extrae `ISSUE_NUM` como el primer token numerico de `$ARGUMENTS`. Reenvia `$ARGUMENTS` intacto al wrapper: el parser definitivo y la validacion de formato pertenecen al wrapper y al pipeline, sin mantener una segunda gramatica shell aqui.

`--models` acepta un mapa opaco para las claves de stage `writer` y `reviewer`; no alteres sus valores ni publiques aliases de proveedor. Un stage omitido conserva su default y `writer` cubre tanto escritura como merge porque ambos stages usan esa clave.

`--variant <label>` recibe un slug de minusculas, digitos y guiones (`[a-z0-9-]`, maximo 40 caracteres). Conserva el aislamiento mediante el sufijo `-<label>` en worktree, rama, logs y pane o sesion. Una variante no hace push, no abre PR ni muta el issue (comentarios, labels o transiciones); deja la rama local para compararla. No intentes validar otra vez estas gramaticas: reenvia ambos flags intactos.

## Proceso

### 1. Validar el issue

Consulta el issue con `gh issue view ISSUE_NUM --json number,title,state,labels,body`. Muestra titulo, estado y labels. Si no es consultable, no existe o esta cerrado (`CLOSED`), informa el motivo y detente.

### 2. Validar el tipo y los bloqueos

Verifica el label `tipo:tooling`. Si falta, explica que la logica de dominio se lanza con el comando de implementacion y pide confirmacion explicita antes de continuar. Si no se confirma, detente.

Si lleva el label `bloqueado`, lee solo la seccion `## Dependencias` del body, hasta el siguiente encabezado de nivel dos, y considera exclusivamente las lineas canonicas `Depende de #N` o `Bloqueado por #N` (tambien si llevan marcador de lista). Ignora cualquier otro `#N`. Si no hay una dependencia canonica consultable, conserva el label, muestra el bloqueo y detente.

Para cada numero, intenta primero `gh pr view` y, si no corresponde a un PR, `gh issue view`, consultando titulo y estado. Una dependencia `OPEN` o no consultable es un bloqueo visible: muestra su numero, titulo si pudo consultarse y estado o error de consulta, y detente; nunca supongas que un fallo significa cierre.

Solo cuando todas las dependencias canonicas declaradas cerraron (`CLOSED`) o se integraron (`MERGED`), retira el label `bloqueado` y continua. Con `--variant`, nunca mutas labels: informa que el label permanece y continua solo si todas las dependencias cerraron.

### 3. Lanzar

Muestra la informacion validada del issue y ejecuta exactamente:

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/launch-pipeline.sh" --tooling $ARGUMENTS
```

Seguimiento por runtime: cuando el runtime activo trae su propia cinta de seguimiento (la consola `fausto-blood-pact`) y el usuario no fijo la interfaz, el wrapper no abre pane: corre desacoplado, imprime la ruta del log y el avance lo sigue esa consola desde esta misma sesion. En el resto de los runtimes (MEF-ADR-0050): dentro de Herdr, informa que el pipeline queda corriendo en un pane de este workspace con el visor en vivo. Fuera de Herdr tambien corre desacoplado, sin consola que lo siga (la salida del wrapper dice `sin pane` sin nombrar la consola): entrega la ruta del log y la linea de `stream-watch.sh` que imprime el wrapper para abrir el visor en otra terminal.

## Reglas

- **No esperes a que termine.** Devuelve el control inmediatamente.
- **No implementes nada tu mismo.** Solo valida y lanza el wrapper.
- `MEFISTO_UI` admite `mod` (desacoplado) y `herdr` (panes, solo dentro de Herdr); con cualquier otro valor el wrapper aborta y muestra el error.
