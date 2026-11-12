---
description: "Calcula el orden topologico de lanzamiento de los issues 'estado:listo' abiertos del repo de Mefisto a partir de sus dependencias declaradas (ciclos y bloqueos al tope), y deja lista la linea de lanzamiento de /mefisto-sequential."
model: "haiku"
---
<!-- GENERADO por src/internal/scripts/generate-internal-adapters.mts desde src/internal/commands/mefisto-next-order.md. No editar a mano. -->

Calcula el orden topologico de lanzamiento de los issues `estado:listo` abiertos del repo de Mefisto, a partir de sus dependencias declaradas. Solo opera dentro del repo de Mefisto. Comunicate en **espanol**.

## Paso 0: Verificar que estas en el repo de Mefisto

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "ERROR: no estas en un repositorio git"; exit 1;
}
[ -f "$REPO_ROOT/.claude-plugin/plugin.json" ] || {
    echo "ERROR: este skill solo se ejecuta en el repo de Mefisto."
    exit 1
}
```

## Paso 1: Ejecutar el calculo

Este comando no acepta argumentos: siempre analiza TODO el universo `estado:listo` abierto. Si `$ARGUMENTS` trae texto, ignoralo por completo -- no se lo pases al script.

```bash
MEFISTO_RUNTIME=claude node src/internal/scripts/mefisto-next-order.mts
```

Reproduce la salida tal cual, sin reordenarla, resumirla ni completarla con informacion propia: el reporte de ciclos/bloqueos (si los hay) y la lista numerada de issues lanzables, terminando siempre con la linea `/mefisto-sequential ...`.

Como leer el exit code -- el script nunca deja la salida vacia, asi que un exit distinto de `0` no significa "no hay nada que mostrar":

- **`0`**: hay al menos un issue lanzable. Reproduce la salida y termina.
- **`1`**: no quedo ningun issue lanzable (universo vacio, o todos en ciclos o bloqueados). **No es un fallo del comando**: reproduce igual la salida -- el motivo de cada exclusion esta ahi -- y no reintentes.
- **`2`**: fallo real (`gh issue list` no respondio, o se le pasaron argumentos). Reporta el mensaje de error tal cual.

Si el script emite una linea `ADVERTENCIA` de universo truncado, reproducela tambien: el orden pudo calcularse sobre un grafo incompleto.

## Reglas

- No dupliques a mano el calculo del orden ni la deteccion de ciclos: el script es la unica fuente de verdad.
- Este comando es de solo lectura: nunca muta labels ni bodies de issues.
- **No lances el batch por tu cuenta.** La linea `/mefisto-sequential ...` queda lista para copiar; decidir si se lanza -- y con que subconjunto -- es del usuario.
