---
description: "Lanza el pipeline secuencial para multiples issues."
argument-hint: "<issue1> <issue2> ... [--pipeline tdd|tooling]"
model: "haiku"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.mts desde src/published/commands/sequential.md. No editar a mano. -->
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

Lanza el pipeline secuencial para multiples issues. Cada issue se enruta automaticamente al pipeline correcto segun su label `tipo:*`. Comunicate en **espanol**.

**Grupos homogeneos**: todos los issues del grupo deben pertenecer al repo activo. No uses flags `-R`.

## Entrada

Los numeros de issues estan en: $ARGUMENTS

Si `$ARGUMENTS` esta vacio, responde: `Uso: /mefisto:sequential <issue1> <issue2> <issue3> ... [--pipeline tdd|tooling]`

## Proceso

### 1. Validar los issues

Para cada numero en los argumentos (excluyendo flags como `--pipeline`):

```bash
gh issue view <num> --json number,title,state,labels -q '"#\(.number): \(.title) [\(.state)] [\(.labels | map(.name) | join(", "))]"'
```

Si algun issue no existe o esta cerrado, informalo y excluyelo de la lista. Si no queda ningun issue valido, detente.

### 2. Mostrar resumen y lanzar

Muestra la lista de issues que se procesaran en orden, indicando el pipeline resuelto:

```
Secuencial --- 3 issues:
  1. #42: Implementar calculo de horas extras nocturnas [tdd-pipeline]
  2. #60: Configurar fixture de tests [tooling-pipeline]
  3. #44: Calcular recargos dominicales [tdd-pipeline]
```

Luego lanza, pasando `--pipeline` si el usuario lo proporciono:

```bash
MEFISTO_RUNTIME=claude node "${MEFISTO_PACKAGE_ROOT}/scripts/launch-pipeline.mts" --batch $ARGUMENTS
```

### 3. Instrucciones de seguimiento

Seguimiento por runtime: cuando el runtime activo trae su propia cinta de seguimiento (la consola `fausto-blood-pact`) y el usuario no fijo la interfaz, el wrapper no abre pane: corre desacoplado, imprime la ruta del log y el avance lo sigue esa consola desde esta misma sesion. En el resto de los runtimes (MEF-ADR-0050): dentro de Herdr (`HERDR_ENV=1` en el entorno), el wrapper delega en la interfaz Herdr: el batch queda corriendo en un pane de este mismo workspace con el visor en vivo, que salta solo de issue en issue. En ese caso responde con:

```
Secuencial corriendo en un pane de este workspace (visor en vivo del agente).
Los issues se procesaran en orden: pipeline -> PR -> merge -> siguiente.
```

Fuera de Herdr el wrapper tambien corre desacoplado, sin consola que lo siga: su salida dice `sin pane` sin nombrar la consola, e imprime la ruta del log y la linea del visor. En ese caso responde con:

```
Secuencial corriendo sin pane. Para monitorear, en otra terminal:
  <linea de stream-watch.mts que imprimio el wrapper>

Los issues se procesaran en orden: pipeline -> PR -> merge -> siguiente.
```

## Reglas

- **No esperes a que termine.** Devuelve el control inmediatamente.
- **No implementes nada tu mismo.** Solo lanza el wrapper.
- Si el usuario pasa `--stop-on-error`, informale que ese flag requiere lanzar `node ${MEFISTO_PACKAGE_ROOT}/scripts/batch-pipeline.mts` directamente, porque `launch-pipeline.mts` no lo soporta. Para detener un batch ya en marcha usa /mefisto:batch-stop en su lugar.
- Si el usuario pasa `--pipeline tdd|tooling`, pasalo tal cual al wrapper.
- **Salto por dependencia**: antes de lanzar cada eslabon, el batch lee las dependencias canonicas de `## Dependencias` (`Depende de #N` / `Bloqueado por #N` al inicio del item). Una dependencia esta satisfecha si quedo `completado` en este mismo batch o si en GitHub esta `CLOSED` (issue) o `MERGED` (PR). Si alguna no lo esta, el issue queda `saltado: depende de #N (<motivo>)` (`fallido en este batch`, `OPEN` o `no consultable`) y el batch sigue con el siguiente; la cascada se propaga sola. Un issue con `bloqueado` y sin dependencias canonicas queda `saltado: bloqueado sin dependencias canonicas`; si tiene todas satisfechas, el batch le quita el label. El salto no cambia el exit code ni dispara `--stop-on-error`. El resumen final lista los saltados con `Relanza tras resolver sus dependencias: /sequential <nums>`.
