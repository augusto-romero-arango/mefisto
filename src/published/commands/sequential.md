---
{
  "kind": "command",
  "id": "sequential",
  "description": "Lanza el pipeline secuencial para multiples issues.",
  "profile": "fast",
  "arguments": "<issue1> <issue2> ... [--pipeline tdd|tooling]"
}
---

{{mefisto:assert-consumer-repo}}

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
{{mefisto:run launch-pipeline.mts --batch $ARGUMENTS}}
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
- Si el usuario pasa `--stop-on-error`, informale que ese flag requiere lanzar `node {{mefisto:package-root}}/scripts/batch-pipeline.mts` directamente, porque `launch-pipeline.mts` no lo soporta. Para detener un batch ya en marcha usa {{mefisto:command batch-stop}} en su lugar.
- Si el usuario pasa `--pipeline tdd|tooling`, pasalo tal cual al wrapper.
- **Salto por dependencia**: antes de lanzar cada eslabon, el batch lee las dependencias canonicas de `## Dependencias` (`Depende de #N` / `Bloqueado por #N` al inicio del item). Una dependencia esta satisfecha si quedo `completado` en este mismo batch o si en GitHub esta `CLOSED` (issue) o `MERGED` (PR). Si alguna no lo esta, el issue queda `saltado: depende de #N (<motivo>)` (`fallido en este batch`, `OPEN` o `no consultable`) y el batch sigue con el siguiente; la cascada se propaga sola. Un issue con `bloqueado` y sin dependencias canonicas queda `saltado: bloqueado sin dependencias canonicas`; si tiene todas satisfechas, el batch le quita el label. El salto no cambia el exit code ni dispara `--stop-on-error`. El resumen final lista los saltados con `Relanza tras resolver sus dependencias: /sequential <nums>`.
