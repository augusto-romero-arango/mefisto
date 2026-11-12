---
description: "Lanza el pipeline IaC para un issue de GitHub."
argument-hint: "<issue>"
model: "haiku"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.mts desde src/published/commands/infra.md. No editar a mano. -->
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

Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.mts`: ese directorio es el repositorio de Mefisto, no un consumidor.

Lanza el pipeline IaC para un issue de GitHub. Comunicate en **espanol**.

## Entrada

El numero de issue esta en: $ARGUMENTS

Si `$ARGUMENTS` esta vacio, responde: `Uso: /mefisto:infra <numero-de-issue>`

## Proceso

### 1. Validar el issue

```bash
gh issue view $ARGUMENTS --json number,title,state,labels -q '"#\(.number): \(.title) [\(.state)] labels: \([.labels[].name] | join(", "))"'
```

Si el issue no existe o esta cerrado (`CLOSED`), informa y detente.

### 2. Validar que es una tarea de infra

Extrae labels del issue:

```bash
gh issue view $ARGUMENTS --json labels -q '[.labels[].name] | join(",")'
```

Verifica que tenga el label `tipo:infra`. Si no lo tiene, advierte al usuario:

```
Este issue no tiene el label tipo:infra.
Si es logica de dominio, usa /mefisto:implement en su lugar.
Si es tooling, usa /mefisto:tooling en su lugar.
Continuar de todos modos? (s/n)
```

Si no se confirma, detente.

### 2.5. Verificar label bloqueado

Si el issue tiene el label `bloqueado`, lee solo la seccion `## Dependencias` del body, hasta el siguiente encabezado de nivel dos, y considera exclusivamente las lineas canonicas `Depende de #N` o `Bloqueado por #N` (tambien si llevan marcador de lista). Ignora cualquier otro `#N`.

Para cada numero, consulta primero titulo y estado con `gh pr view`. Solo si GitHub confirma que el numero no corresponde a un PR, consulta `gh issue view`; cualquier otro fallo de la consulta del PR es no consultable y bloquea. Nunca supongas que un fallo significa cierre.

- Si **todas** las dependencias canonicas declaradas cerraron (`CLOSED`) o se integraron (`MERGED`): quita el label, informa el desbloqueo y continua:

```bash
gh issue edit $ARGUMENTS --remove-label "bloqueado"
```

```
Dependencias resueltas: se quito el label 'bloqueado'.
```

- Si no hay una dependencia canonica consultable, o **alguna** dependencia sigue abierta o no es consultable: conserva el label, muestra cuales y **detente**:

```
El issue #$ARGUMENTS esta bloqueado. Dependencias abiertas:
  - #42: [titulo] (OPEN)
  - #55: [titulo] (OPEN)

Resuelve estas dependencias antes de lanzar el pipeline.
```

### 3. Mostrar info y lanzar

Muestra una linea con el issue:

```
#42: Configurar Application Insights con daily cap
Tipo: infra | Estado: listo
```

Luego lanza el pipeline:

```bash
MEFISTO_RUNTIME=claude node "${MEFISTO_PACKAGE_ROOT}/scripts/launch-pipeline.mts" --infra $ARGUMENTS
```

### 4. Instrucciones de seguimiento

Seguimiento por runtime: cuando el runtime activo trae su propia cinta de seguimiento (la consola `fausto-blood-pact`) y el usuario no fijo la interfaz, el wrapper no abre pane: corre desacoplado, imprime la ruta del log y el avance lo sigue esa consola desde esta misma sesion. En el resto de los runtimes (MEF-ADR-0050): dentro de Herdr (`HERDR_ENV=1` en el entorno), el script delega en la interfaz Herdr: el pipeline queda corriendo en un pane de este mismo workspace con el visor en vivo del agente. En ese caso responde con:

```
Pipeline infra corriendo en un pane de este workspace (visor en vivo del agente).
```

Fuera de Herdr el script tambien corre desacoplado, sin consola que lo siga: su salida dice `sin pane` sin nombrar la consola, e imprime la ruta del log y la linea del visor. En ese caso responde con:

```
Pipeline infra corriendo sin pane. Para monitorear, en otra terminal:
  <linea de stream-watch.mts que imprimio el script>
Log: <ruta del log que imprimio el script>
```

## Flujo: cero permisos de Azure en local (MEF-ADR-0021, MEF-ADR-0022)

En el flujo *ongoing*, el desarrollador que usa Mefisto **no tiene ningun permiso de Azure**. Este pipeline corre enteramente sin credenciales de Azure y sin sesion `az login`:

1. **Write** (`infra-writer`): escribe o modifica el HCL en un worktree aislado.
2. **Review** (`infra-reviewer`): revisa seguridad/calidad del HCL y hace **revision estatica** (`terraform fmt -check` + `terraform init -backend=false` + `terraform validate`). **No** ejecuta `terraform plan`.
3. **PR**: el pipeline crea un PR con el HCL escrito y revisado. El PR **nunca** lleva `Closes #N`.

El **plan real** corre en CI cuando se abre el PR (workflow `infra-cd.yml`, job `plan`, publicado como comentario del PR) y el **apply real** corre en CI al mergear el PR a `main` (job `apply`). Ese mismo job cierra el issue tras un apply exitoso (MEF-ADR-0022) -- nunca el propio merge del PR ni este pipeline local.

**Distincion bootstrap vs ongoing**: el bootstrap inicial (`bootstrap-backend.mts` para el tfstate, `setup-github-ci.mts` para el Service Principal de CI) es una operacion **privilegiada de una sola vez** que corre un admin con permisos de Azure para habilitar la CI. No es parte de este flujo ongoing.

## Reglas

- **No esperes a que termine.** El script corre en background (desacoplado o en un pane Herdr). Devuelve el control inmediatamente.
- **No implementes nada tu mismo.** Solo lanza el script.
- `MEFISTO_UI` admite `mod` (desacoplado) y `herdr` (panes, solo dentro de Herdr); con cualquier otro valor el script aborta y muestra el error.
