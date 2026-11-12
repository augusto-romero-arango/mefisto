---
{
  "kind": "command",
  "id": "batch-stop",
  "description": "Escribe la senal de parada suave de los orquestadores publicados de Mefisto.",
  "profile": "fast"
}
---

{{mefisto:assert-consumer-repo}}

Escribe la senal de parada suave de los orquestadores publicados de Mefisto (`batch-pipeline.mts` y `parallel-pipeline.mts`). Comunicate en **espanol**.

## Alcance: que orquestadores tienen cola que retener

La senal es cooperativa: solo la consulta un orquestador que **mantiene una cola de issues sin lanzar**. Son dos:

- `batch-pipeline.mts` --- el motor que lanza {{mefisto:command sequential}}. Se detiene tras el eslabon en curso (pipeline -> PR -> merge).
- `parallel-pipeline.mts` --- el scheduler que lanza {{mefisto:command parallel}} cuando corre sin panes, o invocado directo (el camino de `--max-parallel` y de la serializacion de `tipo:projection`). Deja de lanzar pendientes; los worktrees ya en vuelo terminan.

{{mefisto:command parallel}} en modo pane (Herdr) **no** entra aqui: abre un pane por issue de entrada y no deja ninguna cola pendiente. Si el usuario pide detener un {{mefisto:command parallel}} en modo pane, dile que ahi no hay nada que retener --- todos los issues ya estan en vuelo --- y que la unica via es cerrar los panes de los que aun no quiera (con el costo de dejarlos a medio pipeline).

## Proceso

### 1. Detectar si hay un orquestador corriendo

Criterio: el proceso real de `batch-pipeline.mts` o `parallel-pipeline.mts` -- un log activo no distingue una corrida activa de una ya terminada sin volver a parsear su contenido.

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "ERROR: no estas en un repositorio git"; exit 1; }
case "$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null)" in
    "")  ;;
    /*)  REPO_ROOT=$(dirname "$(git -C "$REPO_ROOT" rev-parse --git-common-dir)") ;;
    *)   REPO_ROOT=$(cd "$REPO_ROOT/$(dirname "$(git -C "$REPO_ROOT" rev-parse --git-common-dir)")" 2>/dev/null && pwd) || REPO_ROOT=$(git rev-parse --show-toplevel) ;;
esac
pgrep -f "[s]cripts/batch-pipeline\.mts" >/dev/null 2>&1 || pgrep -f "[s]cripts/parallel-pipeline\.mts" >/dev/null 2>&1
```

Tres detalles del patron, los tres deliberados:

- `[s]cripts` en vez de `scripts`: el patron viaja en la linea de comandos del propio shell que corre este `pgrep`, y `pgrep -f` la mira igual que cualquier otra. Con la clase de un solo caracter, el texto literal del patron ya no encaja con la expresion, asi que la deteccion no puede auto-cumplirse: sin orquestador corriendo, el exit es 1.
- Ancla en `scripts/` (no `batch-pipeline.mts` a secas) para no confundirse con el motor interno de Mefisto (`mefisto-batch-pipeline.mts`, que vive en `src/internal/scripts/` de OTRO repo/checkout): si ese proceso corre en la misma maquina, `batch-pipeline.mts` SI aparece como substring de `mefisto-batch-pipeline.mts`, pero `scripts/batch-pipeline.mts` no.
- El criterio es **por maquina**, no por checkout: si el orquestador corre sobre otro clon del consumidor, aqui tambien da positivo y la senal se escribe en ESTE repo, donde nadie la va a consumir hasta la proxima corrida local (que se detendra de entrada, con todos sus issues `aplazado`, y la consumira). Es el precio de no inventar estado nuevo; invoca este comando desde el checkout donde lanzaste el batch o desde cualquiera de sus worktrees (la senal se escribe siempre en la raiz del checkout principal, que es donde el orquestador la lee). Otro clon del consumidor es otro checkout: sus worktrees no cuentan como este.

- Si **no** hay ningun proceso: responde y detente sin escribir nada:
  ```
  No hay ningun batch ni corrida paralela corriendo ahora mismo. No se escribio ninguna senal.
  ```
- Si **si** hay uno: continua al paso 2.

### 2. Escribir la senal

```bash
mkdir -p "$REPO_ROOT/pipeline-state"
touch "$REPO_ROOT/pipeline-state/batch-stop"
```

### 3. Confirmar

Responde:

```
Senal de parada escrita. El orquestador se detendra tras el trabajo en curso:
- batch-pipeline.mts completa el issue en curso entero (pipeline -> PR -> merge) y no arranca los siguientes.
- parallel-pipeline.mts deja terminar los worktrees ya en vuelo (pipeline -> PR, sin merge automatico) y no lanza mas issues de la cola.
Los issues no procesados quedaran "aplazado" en el resumen final, con la linea lista para relanzarlos en el mismo orden.
```

## Reglas

- No pidas confirmacion adicional: el usuario ya la dio al escribir {{mefisto:command batch-stop}} explicitamente.
- No mates ningun proceso ni pane: la senal es cooperativa, el propio motor la consulta.
- No la escribas si no detectaste ningun orquestador corriendo (paso 1): dejarla puesta sin necesidad envenenaria la proxima corrida.
- La senal se autoconsume: el propio motor la borra al detenerse (`pipeline-state/` es estado transitorio del pipeline y no se versiona, MEF-ADR-0017). Este comando nunca la borra por su cuenta.
