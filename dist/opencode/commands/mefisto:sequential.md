---
description: "Lanza el pipeline secuencial para multiples issues dentro de una sesion tmux."
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/sequential.md. No editar a mano. -->
```bash
# Cada llamada bash que use ${MEFISTO_PACKAGE_ROOT} debe incluir este bloque antes de sus comandos: no se asume estado de shell persistente entre llamadas.
if [ -n "${XDG_DATA_HOME:-}" ]; then mefisto_opencode_launcher="$XDG_DATA_HOME/mefisto/active/bin/mefisto-opencode"
elif [ "${OSTYPE%%[0-9.]*}" = darwin ]; then mefisto_opencode_launcher="$HOME/Library/Application Support/mefisto/active/bin/mefisto-opencode"
else mefisto_opencode_launcher="$HOME/.local/share/mefisto/active/bin/mefisto-opencode"; fi
if [ ! -f "$mefisto_opencode_launcher" ] || [ -L "$mefisto_opencode_launcher" ] || [ ! -x "$mefisto_opencode_launcher" ]; then
    printf '%s\n' 'ERROR OpenCode: no hay una release activa valida; instale o active la release OpenCode.' >&2; exit 1
fi
MEFISTO_PACKAGE_ROOT="$("$mefisto_opencode_launcher" package-root)" || {
    printf '%s\n' 'ERROR OpenCode: no se pudo resolver la release activa; instale o active la release OpenCode.' >&2; exit 1;
}
case "$MEFISTO_PACKAGE_ROOT" in
    /*) ;;
    *) printf '%s\n' 'ERROR OpenCode: la release activa no devolvio una raiz absoluta; reinstale o active la release OpenCode.' >&2; exit 1 ;;
esac
MEFISTO_PACKAGE_ROOT="$(cd -P "$MEFISTO_PACKAGE_ROOT" 2>/dev/null && printf '%s\n' "$PWD")" || {
    printf '%s\n' 'ERROR OpenCode: la release activa no existe; reinstale o active la release OpenCode.' >&2; exit 1;
}
export MEFISTO_PACKAGE_ROOT
```

Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.sh`: ese directorio es el repositorio de Mefisto, no un consumidor.

Lanza el pipeline secuencial para multiples issues dentro de una sesion tmux. Cada issue se enruta automaticamente al pipeline correcto segun su label `tipo:*`. Comunicate en **espanol**.

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
MEFISTO_RUNTIME=opencode "${MEFISTO_PACKAGE_ROOT}/scripts/tmux-pipeline.sh" --batch $ARGUMENTS
```

### 3. Instrucciones de conexion

Seguimiento por runtime: cuando el runtime activo trae su propia cinta de seguimiento (la consola `fausto-blood-pact`) y el usuario no fijo la interfaz, el wrapper no abre pane ni sesion tmux: corre desacoplado, imprime la ruta del log y el avance lo sigue esa consola desde esta misma sesion. En el resto de los runtimes (MEF-ADR-0050): dentro de Herdr (`HERDR_ENV=1` en el entorno), el wrapper delega en la interfaz Herdr y no hay nada que adjuntar: el batch queda corriendo en un pane de este mismo workspace con el visor en vivo, que salta solo de issue en issue. En ese caso responde con:

```
Secuencial corriendo en un pane de este workspace (visor en vivo del agente).
Los issues se procesaran en orden: pipeline -> PR -> merge -> siguiente.
```

Fuera de Herdr responde con:

```
Secuencial lanzado en tmux. Para monitorear:
  tmux -CC attach -t batch-<timestamp>

Los issues se procesaran en orden: pipeline -> PR -> merge -> siguiente.
```

## Reglas

- **No esperes a que termine.** Devuelve el control inmediatamente.
- **No implementes nada tu mismo.** Solo lanza el wrapper.
- Si el usuario pasa `--stop-on-error`, informale que ese flag requiere lanzar `${MEFISTO_PACKAGE_ROOT}/scripts/batch-pipeline.sh` directamente, porque `tmux-pipeline.sh` no lo soporta. Para detener un batch ya en marcha usa /mefisto:batch-stop en su lugar.
- Si el usuario pasa `--pipeline tdd|tooling`, pasalo tal cual al wrapper.
- **Salto por dependencia**: antes de lanzar cada eslabon, el batch lee las dependencias canonicas de `## Dependencias` (`Depende de #N` / `Bloqueado por #N` al inicio del item). Una dependencia esta satisfecha si quedo `completado` en este mismo batch o si en GitHub esta `CLOSED` (issue) o `MERGED` (PR). Si alguna no lo esta, el issue queda `saltado: depende de #N (<motivo>)` (`fallido en este batch`, `OPEN` o `no consultable`) y el batch sigue con el siguiente; la cascada se propaga sola. Un issue con `bloqueado` y sin dependencias canonicas queda `saltado: bloqueado sin dependencias canonicas`; si tiene todas satisfechas, el batch le quita el label. El salto no cambia el exit code ni dispara `--stop-on-error`. El resumen final lista los saltados con `Relanza tras resolver sus dependencias: /sequential <nums>`.
