---
{
  "kind": "command",
  "id": "merge",
  "description": "Mergea uno o varios PRs del consumidor a main via pr-sync.",
  "profile": "fast",
  "arguments": "<numero-de-PR> [<numero-de-PR> ...] | --all"
}
---

{{mefisto:assert-consumer-repo}}

Mergea uno o varios PRs a main via `pr-sync`. Comunicate en **espanol**.

**Alcance**: este comando solo mergea PRs del proyecto consumidor.

## Entrada

Los argumentos estan en: $ARGUMENTS

Formas validas:

- `<numero-de-PR>` — un solo PR
- `<numero-de-PR> <numero-de-PR> ...` — varios PRs en orden
- `--all` — todos los PRs abiertos

Si `$ARGUMENTS` esta vacio, responde:

```
Uso: /mefisto:merge <numero-de-PR> [<numero-de-PR> ...] | --all
```

Y detente.

---

## Proceso

### 1. Validar PRs

Si los argumentos son `--all`, salta al paso 2.

Si son uno o mas numeros, para cada numero consulta:

```bash
gh pr view <num> --json number,title,state,headRefName,mergeable,statusCheckRollup
```

- Si el PR no existe o esta `CLOSED` / `MERGED`: informalo y quitalo de la lista.
- Si todos los PRs fueron descartados: muestra el motivo y detente.

### 2. Mostrar resumen

Imprime la lista a procesar con titulo, rama y estado de checks para que el usuario vea exactamente que va a pasar:

```
Se mergearan via pr-sync:
  #120 [MERGEABLE, checks SUCCESS] Adicionar marcacion a ControlDiario...
  #121 [MERGEABLE, checks PENDING] Otra cosa...
```

No pidas confirmacion adicional. El usuario ya la dio al escribir el comando explicitamente.

### 3. Invocar el script

Lanza directamente el script `pr-sync.mts` con `--merge`.

Para los PRs validados en el paso 1 (numeros separados por espacio):

```bash
{{mefisto:run pr-sync.mts <PRs> --merge}}
```

Para todos los PRs abiertos:

```bash
{{mefisto:run pr-sync.mts --all --merge}}
```

El script imprime progreso en tiempo real. Espera a que termine.

### 4. Colapsar paneles Herdr sobrantes (issue #799)

Bajo `HERDR_ENV=1`, si la tabla de resumen del paso anterior muestra al menos un PR en estado `mergeado`, cierra los paneles Herdr ociosos que dejo el lote (cada issue lanzado en paralelo termina en su propio pane apilado, y sin esto quedan abiertos hasta el proximo despacho). Es best-effort: nunca debe hacer fallar el comando ni bloquear el reporte final.

```bash
if [ "${HERDR_ENV:-}" = "1" ]; then
    CLOSED=$({{mefisto:run herdr-pipeline.mts --collapse-panes}} 2>/dev/null || true)
    echo "paneles_herdr_cerrados=${CLOSED:-0}"
fi
```

`--collapse-panes` imprime por stdout la cantidad de paneles cerrados (o "0"; nunca falla, incluso sin estado previo). El `echo` final es lo unico que llega al output del bloque: lee de ahi el numero para el paso 5. Fuera de `HERDR_ENV=1`, no ejecutes el bloque.

### 5. Reportar resultado

El script ya imprime un resumen final con tabla `PR | Rama | Estado` y la ruta del log. Si al menos un merge del lote salio bien, `pr-sync.mts` corre ademas una vez `worktree-clean.mts`, que elimina los worktrees de rama mergeada o de pipeline abandonada (issue cerrado sin trabajo propio) y conserva con aviso los que tienen cambios sin commitear, rama sin mergear o HEAD desacoplado; su salida va al log y su fallo solo deja un aviso, sin cambiar el exit code. Tu solo debes:

- Confirmar el exit code.
- Si hubo errores, apunta al log en `{{mefisto:state-path logs}}/pr-sync-<ts>.log` y ofrece reintentar con el PR concreto:

  ```
  Reintentar el PR fallido: {{mefisto:command merge}} <num>
  ```
- Si el paso 4 imprimio `paneles_herdr_cerrados=<n>` con `<n>` mayor que 0, mencionalo brevemente: "Paneles Herdr sobrantes cerrados: <n>". Si fue 0 (o no corriste el paso 4 por estar fuera de `HERDR_ENV=1`), no lo menciones.

---

## Reglas

- **Nunca hagas merges manuales** (`gh pr merge`, `git merge` + push, etc.). Todo pasa por `pr-sync.mts`.
- **No diagnostiques errores del script.** Reporta el error tal cual viene en su output y espera instruccion del usuario.
- **No reintentes automaticamente** un PR fallido. El script ya hace retry interno del merge con backoff exponencial. Si se rinde, es decision del usuario.
- **No instales dependencias** ni arregles el entorno. Si falta `gh`, `git` o `dotnet`, informa al usuario y detente.
- **No toques PRs que no esten en la lista final.** Si el usuario pidio `--all`, el script decide cuales procesar.
