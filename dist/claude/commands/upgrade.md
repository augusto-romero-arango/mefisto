---
description: "Actualiza Mefisto en el runtime activo y alinea el par de adaptadores ya adherido o, con una confirmacion, lo habilita."
model: "haiku"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/upgrade.md. No editar a mano. -->
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

Actualiza Mefisto instalado en este consumidor a la ultima version publicada desde el runtime activo. Tambien alinea el adaptador par ya adherido o, con una unica confirmacion explicita, ofrece habilitarlo. La intencion es actualizar Mefisto, no cambiar la sesion viva: comunica siempre en **espanol** y termina indicando el reload o reinicio requerido. Nunca aceptes argumentos: ignora `$ARGUMENTS`.

## Proceso

### 1. Consultar el estado del par antes de actualizar

No leas configuracion ajena, providers, modelos, permisos ni auth stores. La unica autoridad es la salida JSON versionada de `upgrade.sh --status`:

MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/upgrade.sh" --status

Presenta el JSON sin reinterpretarlo. `installedVersion` es la version **instalada en disco** (la que cargara la proxima sesion); no es la version cargada en la sesion viva. `--status` es una consulta local: **no informa si existe una version mas nueva publicada**, asi que nunca autoriza concluir que Mefisto esta al dia. Estados posibles de `peer.state`:

- `enabled` o `stale`: el par expresa adhesion valida. `stale` conserva esa adhesion; no es una desactivacion.
- `disabled`: no hay adhesion del par; incluye primera instalacion y una desactivacion deliberada. Una release instalada cuenta como adhesion aunque no este proyectada globalmente: cada repo la activa con sus archivos commiteados.
- `legacy`: el launcher del par responde con un uso anterior al contrato de estado. Su presencia no prueba adhesion previa.
- `conflict`, `operation-in-progress` o `unavailable`: estados seguros no alineables. No los reinterpretes como `legacy` ni como consentimiento.

### 2. Decidir una sola vez la actualizacion

Cada invocacion ejecuta la actualizacion de este paso **exactamente una vez**, sea cual sea el JSON de `--status` y aunque en esta misma sesion ya se haya corrido otro upgrade. `--status` solo decide si se pasa `--align-peer`. Nunca respondas "ya esta al dia" ni "no hay nada que actualizar" sin la salida del script: esa afirmacion solo puede venir de esa salida.

Decide **antes** de invocar el script, para ejecutarlo una sola vez:

| Estado del par | Decision |
|---|---|
| `enabled` / `stale` | Alinea automaticamente con `--align-peer`. No pidas confirmacion: la adhesion ya existe. |
| `disabled` | Pide una unica confirmacion: "El par de Mefisto no esta habilitado. ¿Quieres habilitarlo o reactivarlo y alinearlo con esta actualizacion? [si/no]". Solo si responde exactamente `si`, usa `--align-peer`; si declina o no responde, actualiza solo el runtime activo. |
| `legacy` | Pide una unica confirmacion: "El par tiene un launcher de una version anterior que no declara su estado. No se puede inferir que estuviera adherido a Mefisto. ¿Quieres migrarlo y alinearlo con esta actualizacion? [si/no]". Solo si responde exactamente `si`, usa `--align-peer`; si declina o no responde, actualiza solo el runtime activo. |
| `conflict` / `operation-in-progress` / `unavailable` | Explica el motivo visible (el JSON), indica que el par requiere intervencion manual y actualiza solo el runtime activo. Nunca pases `--align-peer`. |

Invoca exactamente una de estas dos formas, segun la decision:

Con alineacion del par:

MEFISTO_LOADED_ROOT='${CLAUDE_PLUGIN_ROOT}' MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/upgrade.sh" --align-peer

Solo el runtime activo:

MEFISTO_LOADED_ROOT='${CLAUDE_PLUGIN_ROOT}' MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/upgrade.sh" 2>&1

Si el script termina con `ERROR`, muestra su salida tal cual. Una falla deja las releases existentes para reintento o rollback; no intentes una reparacion adicional ni una poda.

### 3. Presentar evidencia

Muestra sin reinterpretar la salida del script. Reten `Version cargada en esta sesion: <version>` y `Version destino: <version>`. Si el par se alineo, muestra tambien su estado, su version y el diagnostico JSON de identidad entre ambas instalaciones. Nunca afirmes que la sesion viva ya cambio: la version cargada pertenece a esta sesion; la destino esta en disco para la proxima recarga.

### 4. Migrar a activacion por repositorio

Mefisto se instala por usuario pero se activa solo en los repos que lo habilitan con archivos de proyecto commiteados (MEF-ADR-0053 decision 2). El script reporta el estado de cada runtime en los bloques `Activacion de Mefisto`; muestralos sin reinterpretar.

- Si la salida incluye `MIGRACION PENDIENTE` (en uno o en ambos runtimes), pide una unica confirmacion: "Mefisto todavia se carga en todos tus repos. ¿Quieres retirarlo de ese nivel para que solo se active en los repos que lo habilitan, como este? [si/no]". Solo si responde exactamente `si`, ejecuta:

  MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/upgrade.sh" --disable-user

  Muestra su salida tal cual. Si declina o no responde, no ejecutes nada.
- Si la salida incluye `AVISO: este repo no`, muestralo y sugiere `/mefisto:onboard`; nunca ofrezcas retirar el nivel global en ese caso.

### 5. Refrescar agentes herdr

Solo si `HERDR_ENV=1`, refresca los agentes herdr con la version nueva. Es best-effort: un fallo o salida vacia no debe impedir la poda ni el cierre.

MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/herdr-pipeline.sh" --refresh-agents

Reporta la salida sin reinterpretar: por cada linea no vacia `<pane_id> <runtime> <accion>`, muestra una tabla con las columnas `Pane`, `Runtime` y `Accion`. Si no hubo lineas, muestra exactamente: `Sin panes Herdr que refrescar`. No afirmes que la sesion o pane propio cambio. Fuera de herdr (`HERDR_ENV` distinto de `1`), no ejecutes ni menciones este paso.

### 6. Poda opt-in del runtime activo

La poda aplica solo al runtime activo y solo si el script listo versiones podables. Muestra la lista exacta y pide confirmacion explicita. Si responde exactamente `si`, invoca la poda pasando con `--only` exactamente esa lista (versiones separadas por coma, sin agregar ni quitar ninguna); la poda borra solo la interseccion con las podables recalculadas y reporta aparte las no confirmadas y las que ahora estan protegidas (`--only` solo restringe la poda cuyo listado puede recalcularse entre ambos pasos; donde la lista sale del mismo `--keep`, se ignora). Si la version cargada es conocida, agrega `--loaded <version-cargada>`. Si no confirma, no borres nada. Nunca podes la version cargada ni el par.

MEFISTO_LOADED_ROOT='${CLAUDE_PLUGIN_ROOT}' MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/upgrade.sh" --prune --only <versiones-confirmadas>

### 7. Cerrar con el reload

Independientemente de la poda, termina siempre: "Recarga o reinicia la sesion de tu runtime para activar la version `<version-destino>`. La sesion actual sigue cargando `<version-cargada>` hasta entonces." Si el par se alineo, agrega que reinicie tambien ese runtime. Si el reporte herdr incluyo `omitido:working` u `omitido:blocked`, agrega que esos panes deben recargarse a mano cuando terminen.

## Reglas

- `upgrade.sh` es la autoridad para actualizar, alinear el par, diagnosticar identidad y conservar releases de rollback; no reimplementes esos controles en el comando.
- Un conflicto nunca autoriza una mutacion automatica.
- El update no borra nada. La unica operacion destructiva es la poda opt-in del runtime activo; nunca toca la version cargada ni el par.
- Retirar Mefisto del nivel global solo ocurre con `--disable-user`, tras la confirmacion del paso 4; el script se niega en cada runtime cuyo repo no lo activa con archivos commiteados.
- El refresco de panes herdr es automatico y best-effort; nunca interrumpe un pane ocupado ni el pane propio.
