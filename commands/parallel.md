---
description: "Lanza pipelines en paralelo para multiples issues, sin panes en Claude Code o cada uno en su propio pane."
argument-hint: "<issue1> <issue2> ... [--pipeline tdd|tooling]"
model: "haiku"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.mts desde src/published/commands/parallel.md. No editar a mano. -->
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

Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.mts`: ese directorio es el repositorio de Mefisto, no un consumidor.

Lanza pipelines en paralelo para multiples issues. Con el runtime que trae su propia cinta de seguimiento (consola `fausto-blood-pact`) y sin la interfaz fijada, corren sin panes y se siguen desde esta sesion; en el resto, dentro de Herdr cada issue corre en su propio pane apilado en el workspace actual y fuera de Herdr corren sin panes, con el visor en otra terminal (MEF-ADR-0055 decision 6). Los PRs se crean pero NO se mergean automaticamente. Comunicate en **espanol**.

**Grupos homogeneos**: todos los issues del grupo deben pertenecer al repo activo. El script subyacente (`parallel-pipeline.mts`) consulta cada issue con `gh issue view N` sin `-R`, asi que issues de otros repos se descartan automaticamente como UNKNOWN. No uses flags `-R` con este comando.

## Entrada

Los numeros de issues estan en: $ARGUMENTS

Si `$ARGUMENTS` esta vacio, responde: `Uso: /mefisto:parallel <issue1> <issue2> <issue3> ... [--pipeline tdd|tooling]`

## Proceso

### 1. Validar los issues

Para cada numero en los argumentos (excluyendo flags como `--pipeline`):

```bash
gh issue view <num> --json number,title,state,labels -q '"#\(.number): \(.title) [\(.state)] [\(.labels | map(.name) | join(", "))]"'
```

Si algun issue no existe o esta cerrado, informalo y excluyelo de la lista. Si no queda ningun issue valido, detente.

### 2. Mostrar resumen y lanzar

Muestra la lista de issues que se procesaran:

```
Paralelo — 3 issues:
  #42: Implementar calculo de horas extras nocturnas
  #43: Agregar validacion de jornada maxima
  #44: Calcular recargos dominicales
```

Si el grupo trae mas de un issue `tipo:projection`, avisa desde este resumen que /mefisto:sequential es el camino natural para un lote de puras proyecciones.

Luego lanza, pasando `--pipeline` si el usuario lo proporciono:

```bash
MEFISTO_RUNTIME=claude node "${MEFISTO_PACKAGE_ROOT}/scripts/launch-pipeline.mts" --parallel $ARGUMENTS
```

Cada pipeline conserva sus logs por issue en `.mefisto/pipeline/logs`; el visor en vivo consume `.mefisto/pipeline/events.log`.

### 3. Instrucciones de seguimiento

Seguimiento por runtime: cuando el runtime activo trae su propia cinta de seguimiento (la consola `fausto-blood-pact`) y el usuario no fijo la interfaz, el wrapper no abre panes: delega en `parallel-pipeline.mts` desacoplado (escalonado de 30s entre issues, `tipo:projection` serializados) y la corrida se sigue en la banda de la consola `fausto-blood-pact` de esta sesion; el report queda en `.mefisto/pipeline/logs/parallel-run-<timestamp>.report.log`. Lo reconoces porque la salida del wrapper dice `sin pane: lo sigue la consola de Fausto`. En ese caso responde con:

```
Pipeline paralelo corriendo sin panes: lo sigues en la banda de fausto-blood-pact.
Los PRs NO se mergean automaticamente.
```

En el resto de los runtimes (MEF-ADR-0050), o con la interfaz fijada por el usuario:

Dentro de Herdr (`HERDR_ENV=1` en el entorno), el wrapper delega en la interfaz Herdr: cada issue queda corriendo en su propio pane apilado de este workspace, con el visor en vivo de su agente y arranques escalonados de 30s. En ese caso responde con:

```
Pipeline paralelo corriendo: un pane apilado por issue en este workspace.
Los PRs NO se mergean automaticamente.
```

Fuera de Herdr el wrapper tambien delega en `parallel-pipeline.mts` desacoplado, sin consola que lo siga: su salida dice `sin pane` sin nombrar la consola, e imprime la ruta del report y la linea del visor. En ese caso responde con:

```
Pipeline paralelo corriendo sin panes. Para monitorear, en otra terminal:
  <linea de stream-watch.mts que imprimio el wrapper>
Los PRs NO se mergean automaticamente.
```

## Reglas

- **No esperes a que termine.** Devuelve el control inmediatamente.
- **No implementes nada tu mismo.** Solo lanza el wrapper.
- Los PRs creados no se mergean. Recuerdale al usuario que puede usar /mefisto:merge despues.
- Si el usuario pasa `--pipeline tdd|tooling`, pasalo tal cual al wrapper.
- **Issues `tipo:projection`: nunca deben correr dos a la vez.** Todas las proyecciones del BC comparten los archivos del worker de proyecciones (MEF-ADR-0034). En el modo pane (Herdr) un lote con dos o mas aborta con mensaje, antes de crear panes; en el modo sin panes no aborta porque el scheduler los serializa. Para el modo pane: el camino es /mefisto:sequential, o `node ${MEFISTO_PACKAGE_ROOT}/scripts/parallel-pipeline.mts` directo (su scheduler si los serializa dentro del lote sin frenar al resto).
- `--max-parallel N`: en el modo sin panes, pasalo tal cual al wrapper (llega a `parallel-pipeline.mts`) y /mefisto:batch-stop detiene la cola. En el modo pane, lanza `node ${MEFISTO_PACKAGE_ROOT}/scripts/parallel-pipeline.mts` directo para limitar la concurrencia: el modo pane lanza todos los issues de entrada y no tiene cola que retener.
