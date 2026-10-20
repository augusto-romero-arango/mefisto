---
description: "Mergea uno o varios PRs del consumidor a main via pr-sync."
argument-hint: "<numero-de-PR> [<numero-de-PR> ...] | --all"
model: "haiku"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/merge.md. No editar a mano. -->
```bash
mefisto_claude_root=''
mefisto_claude_canonical_contaminated=0
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
mefisto_claude_is_opencode_root() {
    local root
    case "$mefisto_claude_candidate" in /*) ;; *) return 1 ;; esac
    root="$(cd "$mefisto_claude_candidate" 2>/dev/null && pwd -P)" || return 1
    jq -e '
      (keys | sort) == ["commit", "minimumRuntimeVersion", "runtime", "schemaVersion", "version"] and
      .schemaVersion == 1 and .runtime == "opencode" and
      (.version | type == "string" and test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$")) and
      (.commit | type == "string" and test("^[0-9a-f]{40}$")) and
      (.minimumRuntimeVersion | type == "string" and test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"))
    ' "$root/mefisto-manifest.json" >/dev/null 2>&1
}
mefisto_claude_loaded='${CLAUDE_PLUGIN_ROOT}'
if [ "${mefisto_claude_loaded#/}" != "$mefisto_claude_loaded" ]; then
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
            if mefisto_claude_is_opencode_root; then
                mefisto_claude_canonical_contaminated=1
                break
            else
                printf '%s\n' 'ERROR Claude: metadata del marker canonico invalida; reabra o reinstale el plugin.' >&2; exit 1
            fi
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
                if mefisto_claude_is_opencode_root; then
                    printf '%s\n' 'ERROR Claude: el marker Claude identifica una distribucion de otro runtime; reabra Claude o reinstale el plugin.' >&2; exit 1
                fi
                printf '%s\n' 'ERROR Claude: metadata del marker Claude invalida; reabra o reinstale el plugin.' >&2; exit 1
            fi
            if [ "$mefisto_claude_cursor" = / ]; then break; fi
            mefisto_claude_cursor="$(cd "$mefisto_claude_cursor/.." && pwd -P)"
        done
    fi
fi
if [ -z "$mefisto_claude_root" ]; then
    if [ "$mefisto_claude_canonical_contaminated" -eq 1 ]; then
        printf '%s\n' 'ERROR Claude: el marker canonico identifica una distribucion OpenCode y no existe un mirror Claude valido; reabra Claude o reinstale el plugin.' >&2
    else
        printf '%s\n' 'ERROR Claude: no se encontro una raiz Claude valida; reabra o reinstale el plugin.' >&2
    fi
    exit 1
fi
MEFISTO_PACKAGE_ROOT="$mefisto_claude_root"
export MEFISTO_PACKAGE_ROOT
```

Ejecuta este bloque en cada llamada Bash de este comando, sin guardarlo en un archivo ni reutilizar el de otro comando: la raiz que fija es la de la version cargada.

Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.sh`: ese directorio es el repositorio de Mefisto, no un consumidor.

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

Lanza directamente el script `pr-sync.sh` con `--merge`.

Para los PRs validados en el paso 1 (numeros separados por espacio):

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/pr-sync.sh" <PRs> --merge
```

Para todos los PRs abiertos:

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/pr-sync.sh" --all --merge
```

El script imprime progreso en tiempo real. Espera a que termine.

### 4. Colapsar paneles Herdr sobrantes (issue #799)

Bajo `HERDR_ENV=1`, si la tabla de resumen del paso anterior muestra al menos un PR en estado `mergeado`, cierra los paneles Herdr ociosos que dejo el lote (cada issue lanzado en paralelo termina en su propio pane apilado, y sin esto quedan abiertos hasta el proximo despacho). Es best-effort: nunca debe hacer fallar el comando ni bloquear el reporte final.

```bash
if [ "${HERDR_ENV:-}" = "1" ]; then
    CLOSED=$(MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/herdr-pipeline.sh" --collapse-panes 2>/dev/null || true)
    echo "paneles_herdr_cerrados=${CLOSED:-0}"
fi
```

`--collapse-panes` imprime por stdout la cantidad de paneles cerrados (o "0"; nunca falla, incluso sin estado previo). El `echo` final es lo unico que llega al output del bloque: lee de ahi el numero para el paso 5. Fuera de `HERDR_ENV=1`, no ejecutes el bloque.

### 5. Reportar resultado

El script ya imprime un resumen final con tabla `PR | Rama | Estado` y la ruta del log. Si al menos un merge del lote salio bien, `pr-sync.sh` corre ademas una vez `worktree-clean.sh`, que elimina los worktrees de rama mergeada o de pipeline abandonada (issue cerrado sin trabajo propio) y conserva con aviso los que tienen cambios sin commitear, rama sin mergear o HEAD desacoplado; su salida va al log y su fallo solo deja un aviso, sin cambiar el exit code. Tu solo debes:

- Confirmar el exit code.
- Si hubo errores, apunta al log en `.mefisto/pipeline/logs/pr-sync-<ts>.log` y ofrece reintentar con el PR concreto:

  ```
  Reintentar el PR fallido: /mefisto:merge <num>
  ```
- Si el paso 4 imprimio `paneles_herdr_cerrados=<n>` con `<n>` mayor que 0, mencionalo brevemente: "Paneles Herdr sobrantes cerrados: <n>". Si fue 0 (o no corriste el paso 4 por estar fuera de `HERDR_ENV=1`), no lo menciones.

---

## Reglas

- **Nunca hagas merges manuales** (`gh pr merge`, `git merge` + push, etc.). Todo pasa por `pr-sync.sh`.
- **No diagnostiques errores del script.** Reporta el error tal cual viene en su output y espera instruccion del usuario.
- **No reintentes automaticamente** un PR fallido. El script ya hace retry interno del merge con backoff exponencial. Si se rinde, es decision del usuario.
- **No instales dependencias** ni arregles el entorno. Si falta `gh`, `git` o `dotnet`, informa al usuario y detente.
- **No toques PRs que no esten en la lista final.** Si el usuario pidio `--all`, el script decide cuales procesar.
