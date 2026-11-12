---
{
  "kind": "command",
  "id": "next-order",
  "description": "Calcula el orden topologico de lanzamiento de los issues estado:listo del consumidor y deja lista la linea de sequential.",
  "profile": "fast"
}
---

Calcula el orden topologico de lanzamiento de los issues `estado:listo` abiertos del repo consumidor, a partir de sus dependencias declaradas, y deja lista la linea de lanzamiento de `{{mefisto:command sequential}}`. Comunicate en **espanol**.

{{mefisto:assert-consumer-repo}}

## Entrada

Este comando no acepta argumentos: siempre analiza TODO el universo `estado:listo` abierto del consumidor. Si `$ARGUMENTS` trae texto, ignoralo por completo -- no se lo pases al script -- y dilo en una nota al reportar la salida, para que el usuario sepa que su filtro no se aplico.

## Proceso

### Ejecutar el calculo

```bash
{{mefisto:run next-order.mts --launch-command "/mefisto:sequential" --parallel-command "/mefisto:parallel"}}
```

Doctrina completa del algoritmo (extraccion de dependencias, clasificacion bloqueo externo/ciclo/bloqueo indirecto/lanzable, Kahn con seleccion golosa): cabecera de `scripts/next-order.mts`. No la dupliques aqui.

Reproduce la salida **tal cual**, sin reordenarla, resumirla ni completarla con informacion propia: el reporte de ciclos/bloqueos (si los hay) al tope, la lista numerada de issues lanzables, la linea de infra (`/mefisto:infra #N`, una invocacion por issue, solo si hay `tipo:infra` lanzables: se ofrece desarrollarlos antes, sin exigirlo), la linea `{{mefisto:command sequential}} ...` lista para copiar y, si el script la emite, la linea `{{mefisto:command parallel}} ...` del lote parallel.

Como leer el exit code -- el script nunca deja la salida vacia, asi que un exit distinto de `0` no significa "no hay nada que mostrar":

- **`0`**: hay al menos un issue lanzable. Reproduce la salida y termina.
- **`1`**: no quedo ningun issue lanzable (universo vacio, o todos en ciclos o bloqueados). **No es un fallo del comando**: reproduce igual la salida -- el motivo de cada exclusion esta ahi -- y no reintentes.
- **`2`**: fallo real (`gh issue list` no respondio, o se le pasaron argumentos invalidos). Reporta el mensaje de error tal cual.

Si el script emite una linea `ADVERTENCIA` de universo truncado, reproducela tambien: el orden pudo calcularse sobre un grafo incompleto.

## Reglas

- No dupliques a mano el calculo del orden ni la deteccion de ciclos: el script es la unica fuente de verdad.
- Este comando es de solo lectura: nunca muta labels ni bodies de issues.
- **El lote parallel lo calcula el script**, solo por dependencias declaradas; no lo amplies ni lo recortes ni propongas otras oleadas. El modo `oleadas` del agente `planner` usa otro criterio y no es este comando.
- **No lances el batch por tu cuenta.** La linea `{{mefisto:command sequential}} ...` queda lista para copiar; decidir si se lanza -- y con que subconjunto -- es del usuario.
