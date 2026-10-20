---
description: "Dashboard de salud del entorno desplegado con semaforos: ultimo apply de infra-cd.yml y consultas de App Insights a 24 horas."
model: "sonnet"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/health-check.md. No editar a mano. -->
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

Dashboard de salud del entorno desplegado. Ejecuta queries contra App Insights, verifica el ultimo apply de infraestructura en CI (workflow `infra-cd.yml`, MEF-ADR-0021/MEF-ADR-0022) y presenta un resumen con semaforos. Comunicate en **espanol**.

Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.sh`: ese directorio es el repositorio de Mefisto, no un consumidor.

## Proceso

### 1. Validar la sesion de Azure

Verifica que hay sesion activa de Azure CLI:

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/azure-account-info.sh" 2>&1
```

Si sale con codigo distinto de `0`, muestra tal cual el mensaje que emitio el script (indica iniciar sesion en Azure) y termina: no ejecutes ningun paso siguiente.

### 2. Verificar el ultimo apply de infraestructura (workflow Infra CD)

El `apply` de infraestructura no corre en local: corre en CI, en el job `apply` de `.github/workflows/infra-cd.yml` al mergear a `main` (MEF-ADR-0021, MEF-ADR-0022). Consulta el ultimo run de ese workflow sobre `main`:

```bash
gh run list --workflow=infra-cd.yml --branch main --limit 1 --json status,conclusion,createdAt,url -q '.[0] // empty'
```

Interpreta la salida:
- **Vacia** (el workflow aun no existe o nunca corrio en `main`): reporta `NO VERIFICADO` -- normal en un proyecto greenfield que aun no hizo su primer merge de infra. No lo trates como fallo.
- `status` distinto de `completed`: el run esta en curso; reporta `EN CURSO`.
- `conclusion == "success"`: el ultimo apply fue exitoso.
- Cualquier otro `conclusion` (`failure`, `cancelled`, `timed_out`, ...): el ultimo apply fallo.

Si `gh` no esta autenticado o el comando falla, reporta `NO VERIFICADO` (mismo criterio tolerante que el resto del dashboard) y continua.

### 3. Ejecutar queries

Ejecuta las 3 queries en secuencia. Captura la salida completa de cada una:

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/appinsights-query.sh" health-summary --hours 24
```

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/appinsights-query.sh" dead-letters --hours 24
```

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/appinsights-query.sh" function-errors --hours 24
```

Si falta `.mefisto/appinsights.env`, el script lo reporta con su propio mensaje: muestralo tal cual en la linea correspondiente del dashboard. Si alguna query falla, reporta el error pero continua con las demas.

### 4. Parsear resultados y construir dashboard

Analiza la salida tabular de cada query para extraer las metricas:

**De `health-summary`**:
- `totalExceptions` y `distinctTypes` de la seccion "Excepciones"
- `totalRequests`, `failedRequests` y `availabilityPct` de la seccion "Requests fallidas"

**De `dead-letters`**:
- Cuenta el numero de filas de datos en la tabla (excluyendo headers y separadores)

**De `function-errors`**:
- Cuenta el numero de funciones distintas con fallos en la tabla (excluyendo headers y separadores)

**Del paso 2 (Infra CD)**:
- `conclusion` y `createdAt` del ultimo run sobre `main` (o "sin runs" si la salida vino vacia)

### 5. Aplicar semaforos

Criterios:

- **Exceptions**: verde = 0, amarillo = 1-5, rojo = >5
- **Requests**: verde = >99% exito, amarillo = 95-99%, rojo = <95%
- **Dead Letters**: verde = 0 filas de datos, amarillo = 1-5 filas, rojo = >5 filas
- **Function Errors**: verde = 0 funciones con fallos, rojo = cualquier fallo
- **Infra CD**: verde = ultimo run `conclusion == success`, amarillo = sin runs (`NO VERIFICADO`) o en curso, rojo = ultimo run fallido

Determina el estado general:
- Si todo es verde: "OK"
- Si hay amarillos pero no rojos: "ATENCION"
- Si hay algun rojo: "CRITICO"

### 6. Presentar dashboard

Muestra el dashboard en este formato exacto:

```
HEALTH CHECK - [FECHA Y HORA ACTUAL]
----------------------------------------------------------------------
Exceptions (24h):  [N] total, [M] tipos distintos     [SEMAFORO]
Requests:          [N] total, [M] fallidas ([P]%)      [SEMAFORO]
Dead Letters:      [N] mensajes encontrados             [SEMAFORO]
Function Errors:   [N] funciones con fallos             [SEMAFORO]
Infra CD (apply):  [ultimo estado / fecha, o "sin runs"] [SEMAFORO]
----------------------------------------------------------------------
Estado general: [OK | ATENCION | CRITICO]
```

Donde los semaforos son literalmente:
- `[verde]` para metricas saludables
- `[amarillo]` para metricas que requieren atencion
- `[rojo]` para metricas criticas

### 7. Sugerencias (solo si hay problemas)

Si algun indicador esta en amarillo o rojo, agrega una seccion de problemas detectados:

```
Problemas detectados:
- [Indicador]: [descripcion del problema]
  Sugiero: /mefisto:bug "[sintoma especifico basado en los datos]"
```

Por ejemplo:
- Si hay excepciones: `Sugiero: /mefisto:bug "N excepciones detectadas en las ultimas 24h, tipo principal: [tipo]"`
- Si hay dead letters: `Sugiero: /mefisto:bug "dead letters detectados en las ultimas 24h"`
- Si hay function errors: `Sugiero: /mefisto:bug "N funciones con requests fallidas en las ultimas 24h"`
- Si el porcentaje de exito es bajo: `Sugiero: /mefisto:bug "disponibilidad en [P]%, por debajo del umbral"`
- Si el ultimo Infra CD fallo: `Sugiero: /mefisto:bug "el ultimo apply de infra-cd.yml fallo en main"`

### 8. Tip de monitoreo continuo

Al final del dashboard, siempre agrega:

```
Tip: vuelve a ejecutar /mefisto:health-check periodicamente durante tu sesion de trabajo para detectar cambios en el entorno.
```

## Reglas

- **No modifiques el script** `appinsights-query.sh` -- solo ejecuta sus comandos.
- **No investigues problemas.** Solo presenta el dashboard y sugiere `/mefisto:bug` si hay algo anormal.
- **Usa `--hours 24`** en todas las queries para mantener consistencia.
- **Si una query falla**, muestra el error en la linea correspondiente del dashboard en lugar del valor, y continua con las demas queries.
- **Infra CD sin runs no es un fallo.** Un proyecto greenfield que aun no mergeo su primer PR de infra no tiene runs de `infra-cd.yml`: reporta `NO VERIFICADO`, no `CRITICO`.
