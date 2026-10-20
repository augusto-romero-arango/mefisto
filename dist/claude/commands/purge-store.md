---
description: "Diagnostica con evidencia si un dominio en dev tiene datos de era vieja, confirma con el humano, purga el store via purge-store.sh y valida relanzando los smoke tests fallidos."
argument-hint: "<dominio> [--env <env>]"
model: "sonnet"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/purge-store.md. No editar a mano. -->
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
```bash
if [ -f ".mefisto/harness.config.json" ]; then
    if [ -f ".claude/harness.config.json" ]; then
        printf '%s\n' 'AVISO: se usara el config canonico .mefisto/harness.config.json; se ignora el legacy .claude/harness.config.json. Migra o elimina conscientemente el archivo legacy para evitar divergencias.' >&2
    fi
    MEFISTO_CONFIG_PATH=".mefisto/harness.config.json"
elif [ -f ".claude/harness.config.json" ]; then
    MEFISTO_CONFIG_PATH=".claude/harness.config.json"
else
    printf '%s\n' 'ERROR: no se encontro el config canonico requerido .mefisto/harness.config.json.' >&2
    printf '%s\n' '  Se acepta solo para lectura el fallback legacy .claude/harness.config.json.' >&2
    exit 1
fi
export MEFISTO_CONFIG_PATH
```

Diagnostica con evidencia si un dominio tiene datos de era vieja tras un movimiento/renombrado de eventos persistidos (MEF-ADR-0036), confirma con el humano mostrando exactamente que se pierde, y valida el resultado tras purgar. Los pasos destructivos los ejecuta siempre `purge-store.sh` (issue #725) -- este comando nunca corre `psql`/`DROP`/firewall por su cuenta. Comunicate en **espanol**.

Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.sh`: ese directorio es el repositorio de Mefisto, no un consumidor.

## Entrada

`$ARGUMENTS`:

```
<dominio> [--env dev]
```

- **`<dominio>`**: dominio a diagnosticar y, si corresponde, purgar. Acepta kebab o PascalCase (`calculo-horas` o `CalculoHoras`); la forma canonica es siempre la declarada en `domainLabels`, resuelta en el paso 1 (y revalidada por `purge-store.sh`, que es el juez ultimo).
- **`--env <env>`** (opcional): ambiente objetivo, default `dev`. `purge-store.sh` aborta con una guarda anti-prod codificada si `--env` no es `dev`; este comando **nunca** intenta rodear esa guarda ni ofrece purgar otro ambiente.

Si falta `<dominio>`, responde con el uso exacto de arriba y detente sin ejecutar nada.

## Proceso

### 1. Parsear `$ARGUMENTS` y resolver el dominio canonico

Extrae `DOMINIO` y `ENV` (default `dev`). Resuelve **ya aqui** la forma canonica contra `domainLabels` de `${MEFISTO_CONFIG_PATH}`. Es lectura pura, cero efectos: los pasos 3/4 buscan evidencia por nombre de dominio, y un dominio mal tecleado o no declarado produciria un "no hay evidencia" enganoso (que este comando trata como "no purgar") en vez del error real. Mismo criterio de comparacion que `purge-store.sh` (formas "aplanadas": minusculas sin guiones), y la forma que se usa de aqui en adelante es la declarada, nunca la que tecleo el operador:

```bash
CONFIG="${MEFISTO_CONFIG_PATH}"
[ -f "$CONFIG" ] || { echo "ERROR: no se encontro el config del harness en $CONFIG" >&2; exit 1; }

DOMINIO_FLAT=$(printf '%s' "$DOMINIO" | tr '[:upper:]' '[:lower:]' | tr -d '-')
DOMINIO_KEBAB=$(jq -r --arg flat "$DOMINIO_FLAT" \
    '.domainLabels[]? | select((ascii_downcase | gsub("-";"")) == $flat)' \
    "$CONFIG" 2>/dev/null | head -1)
if [ -z "$DOMINIO_KEBAB" ]; then
    echo "ERROR: el dominio '$DOMINIO' no esta declarado en domainLabels de $CONFIG"
    echo "  Dominios declarados: $(jq -r '.domainLabels // [] | join(", ")' "$CONFIG" 2>/dev/null)"
else
    echo "Dominio canonico: $DOMINIO_KEBAB"
fi
```

Si imprime `ERROR`, muestra el mensaje y detente sin ejecutar nada mas: no hay dominio que diagnosticar. **No confundas este caso con "sin evidencia"** (paso 5): son dos desenlaces distintos y el reporte debe decir cual es.

### 2. Validar la sesion de Azure

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/azure-account-info.sh" 2>&1
```

Si sale con codigo distinto de `0`, muestra tal cual el mensaje que emitio el script (indica iniciar sesion en Azure) y detente: no hay diagnostico sin acceso a la evidencia.

### 3. Diagnostico -- evidencia en App Insights (CA-1)

La configuracion de telemetria vive en `.mefisto/appinsights.env`; si falta, `appinsights-query.sh` lo reporta con su propio mensaje: muestralo tal cual y detente -- no hay diagnostico sin acceso a la evidencia.

Busca el sintoma de identidad rota descrito en MEF-ADR-0036 (columna `mt_dotnet_type` desactualizada, error `42804` de Postgres al leer `mt_version`, o una excepcion de tipo no resuelto) en la ultima semana:

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/appinsights-query.sh" custom "exceptions | where timestamp > ago(168h) | where outerMessage has '42804' or outerMessage has 'mt_version' or outerMessage has 'UnknownEventTypeException' | project timestamp, cloud_RoleName, type, outerMessage, operation_Name | order by timestamp desc | take 20"
```

**El recurso de App Insights es uno por Bounded Context, no por dominio**, y el schema que la purga destruye es de un solo dominio: una fila de otro dominio **no** es evidencia para purgar este. Por eso la query proyecta `cloud_RoleName` -- para el write-side es el nombre de la Function App (`func-{dominio}-...`, MEF-ADR-0045) y para el read-side es el `service.name` del worker, compartido por todo el BC (`<RootNamespace>.Projections`, MEF-ADR-0034 seccion 10). Atribuye cada fila antes de contarla como evidencia:

- `cloud_RoleName` de la Function App de **este** dominio (`func-<dominio-canonico>-...`) -> evidencia valida.
- `cloud_RoleName` del worker de proyecciones -> evidencia valida **solo** si el mensaje o el `operation_Name` nombran este dominio o su schema (el worker corre las proyecciones de todos los dominios del BC).
- Cualquier otro rol -> **no** es evidencia para este dominio; menciona el hallazgo en el reporte, pero no lo cuentes a favor de la purga.

No filtres por `cloud_RoleName` dentro de la query: un literal mal adivinado devuelve cero filas y una query muda es indistinguible de un entorno sano (mismo riesgo que documenta `infra-base-scaffolder` para la alerta del worker). Filtra al leer, no al consultar.

Guarda el resultado (filas atribuidas a este dominio, o "resultado vacio"). Ojo con el encabezado del script: el comando `custom` imprime siempre "ultimas 1h" -- es una etiqueta fija, la ventana real es la del `ago(168h)` de la query. Reporta 168h, no 1h.

### 4. Diagnostico -- evidencia en los smoke tests del ultimo deploy (CA-1)

Localiza el ultimo run del workflow de deploy de este dominio y su conclusion:

```bash
gh run list --workflow="deploy-${DOMINIO_KEBAB}.yml" --branch main --limit 1 \
    --json databaseId,conclusion,createdAt,url -q '.[0] // empty' 2>/dev/null || true
```

Si el run existe y no concluyo en `success`, trae el log de lo que fallo (incluye el job `smoke-tests`, reutilizable dentro del mismo run -- MEF-ADR-0031):

```bash
gh run view <databaseId> --log-failed
```

Lee el log con criterio: busca assertions de smoke test que fallen por campos `null` inesperados (forma vieja de un evento que el read model ya no reconoce), excepciones de deserializacion, o los mismos indicadores del paso 3 (`42804`, `mt_version`, `UnknownEventTypeException`). Distingue eso de un fallo no relacionado (timeout de red, flake de infraestructura, asercion de negocio ajena a la identidad de eventos).

Si el workflow no existe con ese nombre kebab (`gh run list` sale sin nada, o `gh` avisa que no hay workflows con ese nombre -- de ahi el `|| true`), no lo trates como fallo duro: reporta que no se encontraron runs con ese nombre y continua solo con la evidencia del paso 3.

### 5. Evaluar evidencia: sin sintoma, sin purga (CA-1)

Si **ni** el paso 3 **ni** el paso 4 muestran alguno de los sintomas (`42804`/`mt_version`/`UnknownEventTypeException`/nulls de forma vieja) **atribuible a este dominio** (paso 3, criterio de `cloud_RoleName`), detente aqui. Responde:

```
No se encontro evidencia de datos de era vieja para "<dominio-canonico>":
  - App Insights (168h): sin coincidencias de 42804/mt_version/UnknownEventTypeException
    atribuibles a este dominio <(o: N coincidencias, todas de otro dominio: <roles>)>.
  - Ultimo deploy (<workflow o "sin runs">): <resumen: verde, o rojo por un motivo no relacionado>.

No se ofrece la purga: MEF-ADR-0036 exige diagnostico positivo antes de destruir el store.
Si el sintoma es otro, usa /mefisto:bug "<descripcion>" para investigarlo.
```

Y **detente sin continuar al paso 6**.

Si hay evidencia (de cualquiera de los dos pasos), continua.

### 6. Resolver dominio/schema y cuantificar la perdida (CA-2 parcial)

Ejecuta el `--dry-run` de la mitad determinista -- revalida el dominio contra `domainLabels`, calcula el schema y reporta streams/tablas de read model/checkpoints sin tocar nada:

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/purge-store.sh" --domain "$DOMINIO_KEBAB" --env "$ENV" --dry-run
```

Si el script termina con error (dominio no declarado, recurso de Azure ausente, ambiguedad de Function App), muestra el mensaje tal cual y **detente sin continuar**.

Si el script reporta "no hay nada que purgar" (el schema no existe), detente y reportalo -- no hay purga posible ni tiene sentido pedir confirmacion.

### 7. Rastrear el issue/PR de origen, si es posible (CA-2)

Best-effort, nunca bloqueante. Busca un PR reciente que haya movido o renombrado eventos de este dominio:

El ensamblado de eventos persistidos del dominio es `src/<RootNamespace>.{PascalCase}.DomainEvents/` (MEF-ADR-0039), en PascalCase: un glob armado con lo que tecleo el operador no matchea nada si vino en kebab. Localiza el directorio comparando formas aplanadas (mismo criterio del paso 1) en vez de adivinar el casing:

```bash
DOMAIN_EVENTS_DIR=$(git ls-files 'src/*.DomainEvents/*' | cut -d/ -f1,2 | sort -u \
    | awk -v flat="$DOMINIO_FLAT" '{ d=tolower($0); gsub(/-/,"",d); if (index(d, "." flat ".domainevents") > 0) print }' \
    | head -1)
gh pr list --state merged --search "$DOMINIO_KEBAB in:title" --limit 10 --json number,title,mergedAt,url
[ -n "$DOMAIN_EVENTS_DIR" ] && git log --oneline -20 -- "$DOMAIN_EVENTS_DIR"
```

Si algun resultado menciona mover/renombrar namespace, assembly o eventos, citalo en el reporte del paso 8 (`#<numero>: <titulo>`). Si no encuentras nada plausible, dilo explicitamente ("no se pudo rastrear el issue/PR de origen") -- no es un bloqueo, CA-2 solo lo exige "si es rastreable".

### 8. Presentar el diagnostico y confirmar (CA-3)

Muestra el reporte completo y pide confirmacion explicita antes de tocar nada:

```
=== Diagnostico: posible datos de era vieja en "<dominio>" (schema "<schema>") ===

Evidencia:
  - App Insights (168h): <resumen del paso 3>
  - Ultimo deploy (<workflow>, <fecha>): <resumen del paso 4>
  - Origen probable: <#issue/PR: titulo, o "no rastreado">

Esto es exactamente lo que se pierde (salida real de --dry-run):

<pegar aqui, verbatim, el output completo del paso 6>

Esta accion es IRREVERSIBLE: borra el schema completo y reinicia los procesos del dominio.

¿Continuar con la purga? (s/n)
```

Si la respuesta no es un "s"/"si" inequivoco, detente sin escribir ni ejecutar nada mas.

### 9. Ejecutar la purga (CA-4)

El unico paso destructivo, y **solo** via el script:

```bash
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/purge-store.sh" --domain "$DOMINIO_KEBAB" --env "$ENV"
```

Muestra la salida completa. Si el script falla a mitad de camino, reporta el error tal cual -- **nunca** intentes completar manualmente lo que quedo a medias (ni `psql`, ni reinicios sueltos): la idempotencia de un reintento la garantiza el propio script.

### 10. Validar: relanzar smoke fallidos y veredicto (CA-5)

Si el paso 4 identifico un `databaseId` de un deploy con conclusion distinta de `success`, relanza solo lo que fallo. `gh run rerun --failed` **reusa el mismo `databaseId`** e incrementa el numero de intento (`attempt`), asi que el sondeo tiene que anclarse a ese contador: recien relanzado, el run sigue reportando por unos segundos el `status: completed` y la `conclusion: failure` del intento **anterior**, y un sondeo que solo mire `status` cerraria con el veredicto invertido -- declarando que la purga no sirvio sobre un resultado de antes de la purga.

Captura el intento vigente, relanza, y sondea hasta que el contador avance **y** el run complete (maximo ~20 intentos cada 15s, ~5 minutos):

```bash
RUN_ID=<databaseId>
ATTEMPT_PREVIO=$(gh run view "$RUN_ID" --json attempt -q '.attempt')
gh run rerun "$RUN_ID" --failed
for i in $(seq 1 20); do
    sleep 15
    ESTADO=$(gh run view "$RUN_ID" --json attempt,status,conclusion \
        -q '(.attempt|tostring) + " " + .status + " " + (.conclusion // "pendiente")')
    echo "[$i] intento_previo=$ATTEMPT_PREVIO ahora=$ESTADO"
    ATTEMPT_AHORA=${ESTADO%% *}
    RESTO=${ESTADO#* }
    if [ "$ATTEMPT_AHORA" != "$ATTEMPT_PREVIO" ] && [ "${RESTO%% *}" = "completed" ]; then
        echo "VEREDICTO_CONCLUSION=${RESTO#* }"
        break
    fi
done
```

Usa el `VEREDICTO_CONCLUSION` de ese bloque -- el del intento nuevo -- para el veredicto de abajo. Si tras el maximo de intentos no aparece, dilo explicitamente ("aun en curso, revisa con `gh run view <databaseId>`") -- no es un fallo del comando, y **no** cierres con veredicto de exito ni de fracaso sobre un resultado que no observaste.

Cierra siempre con un veredicto explicito, nunca ambiguo:

- **Si la `conclusion` del intento nuevo es `success`**: "Veredicto: los smoke tests que estaban rojos por datos de era vieja en '<dominio>' quedaron verdes tras la purga."
- **Si sigue en rojo**: trae `gh run view <databaseId> --log-failed` y reporta "Veredicto: la purga NO resolvio los smoke tests de '<dominio>'. Siguen fallando: <resumen del log>. El sintoma probablemente no era (solo) datos de era vieja -- investiga con /mefisto:bug." de una vez.
- **Si el paso 4 no identifico ningun deploy fallido que relanzar** (el ultimo deploy ya estaba verde, o no se encontro el workflow): reporta que no hay smoke que relanzar y sugiere /mefisto:health-check para confirmar el estado actual del dominio.

## Reglas

- **Sin evidencia positiva, no hay purga.** Si App Insights y el ultimo smoke run del dominio no muestran ninguno de los sintomas de identidad rota, detente en el paso 5 y dilo explicitamente -- nunca ofrezcas la purga "por si acaso" (CA-1).
- **La evidencia debe ser de ESTE dominio.** El recurso de App Insights es uno por BC y el schema que se destruye es de un dominio: una excepcion de otro dominio (o del worker sin referencia a este) no habilita nada. Atribuye por `cloud_RoleName` antes de contar una fila como evidencia (CA-1/CA-2).
- **"Dominio no declarado" no es "sin evidencia".** El paso 1 aborta con el error real cuando `<dominio>` no esta en `domainLabels`; nunca lo reportes como diagnostico negativo, porque los dos desenlaces se leen igual y solo uno significa que el store esta sano.
- **Todo paso destructivo pasa por `purge-store.sh`, sin excepcion.** Nunca ejecutes `psql`, `DROP`, reglas de firewall, ni reinicios de Function App/Container App directamente -- ese script es la unica superficie que este comando invoca para destruir algo (CA-4).
- **Nunca relajes la guarda anti-prod.** Si `--env` es distinto de `dev`, deja que `purge-store.sh` aborte con su mensaje; no intentes rodear esa guarda ni ofrecer purgar otro ambiente.
- **Confirmacion explicita obligatoria antes del paso 9.** Si el humano no responde "s"/"si" de forma inequivoca en el paso 8, detente sin ejecutar la purga real.
- **La purga es irreversible** -- comunicalo sin eufemismos antes de pedir confirmacion, mostrando siempre el `--dry-run` real, nunca un resumen aproximado.
- **El veredicto final del paso 10 es siempre explicito, y sobre el intento nuevo.** Nunca termines la corrida sin decir si los smoke tests quedaron verdes o por que no; y nunca lo dictes sobre la `conclusion` que el run traia antes del `rerun` (el `attempt` es lo que distingue un resultado post-purga de uno pre-purga).
- **El rastreo del issue/PR de origen (paso 7) es best-effort.** No bloquea el diagnostico ni la purga si no se encuentra nada.
