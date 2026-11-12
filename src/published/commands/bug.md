---
{
  "kind": "command",
  "id": "bug",
  "description": "Investiga un sintoma: lo clasifica como bug de tooling local o de entorno desplegado y enruta al agente investigador apropiado.",
  "profile": "fast",
  "arguments": "[--tooling|--deployed] <descripcion del sintoma>"
}
---

Investiga un error o sintoma reportado. Clasifica automaticamente si es un bug de tooling local o del entorno desplegado, y enruta al agente apropiado. Comunicate en **espanol**.

{{mefisto:assert-consumer-repo}}

Para bugs del propio plugin Mefisto este comando no aplica: remite al mantenedor del plugin a trabajar dentro del repo de Mefisto.

## Entrada

El sintoma esta en: $ARGUMENTS

Si `$ARGUMENTS` esta vacio, responde: `Uso: {{mefisto:command bug}} [descripcion del sintoma]` y termina.

## Proceso

### 1. Parsear flags explicitos

Extrae flags de `$ARGUMENTS`:
- Si contiene `--tooling`: enrutar directamente a `tooling-investigator`. Elimina el flag del sintoma.
- Si contiene `--deployed`: enrutar directamente a `bug-investigator`. Elimina el flag del sintoma.
- Si hay flag explicito, salta al paso 4 (sin clasificacion heuristica).

### 2. Clasificar por heuristica (case-insensitive, busqueda de substrings)

**Indicadores de tooling**:
`pipeline`, `skill`, `agente`, `herdr`, `script`, `/implement`, `/tooling`, `status`, `.claude/`, `.mefisto/`, `worktree`, `tooling-status`, `pipeline-status`

**Indicadores de entorno desplegado**:
`produccion`, `excepcion`, `Service Bus`, `dead letter`, `Function App`, `timeout`, `500`, `App Insights`, `NullReferenceException`

Busca coincidencias del sintoma contra ambas listas.

### 3. Resolver ambiguedad

- Si **solo** hay indicadores de tooling -> enrutar a `tooling-investigator`
- Si **solo** hay indicadores de entorno desplegado -> enrutar a `bug-investigator`
- Si hay indicadores de **ambas** categorias, o **ninguna** -> preguntar al usuario:

```
No puedo determinar automaticamente el tipo de bug.

El sintoma: "$ARGUMENTS"

Es un bug de:
1. **Tooling local** (pipelines, skills, agentes, scripts, worktrees)
2. **Entorno desplegado** (Azure Functions, Service Bus, App Insights)

Responde 1 o 2.
```

Espera la respuesta del usuario antes de continuar.

### 4. Enrutar al agente

El sintoma que se le pasa al agente es `$ARGUMENTS` sin los flags.

#### Si tooling:

Delega sin validar prerequisitos de Azure:

{{mefisto:launch-agent tooling-investigator Sintoma reportado: <sintoma sin flags>}}

Responde con:

```
Agente tooling-investigator lanzado.
Sintoma: [SINTOMA]

El agente investigara scripts, pipelines, skills y agentes locales,
y te presentara hipotesis antes de tomar accion.
```

#### Si entorno desplegado:

Valida primero los prerequisitos, en este orden, y no delegues si alguno falla.

1. Sesion de Azure:

```bash
{{mefisto:run azure-account-info.mts 2>&1}}
```

Si sale con codigo distinto de `0`, muestra tal cual el mensaje que emitio el script (indica iniciar sesion en Azure) y termina sin delegar.

2. Configuracion de telemetria: verifica que existe `.mefisto/appinsights.env` en la raiz del consumidor:

```bash
test -f .mefisto/appinsights.env && echo "OK" || echo "FAIL"
```

Si falta, responde con el formato que espera `appinsights-query.mts` y termina sin delegar:

```
No se encontro .mefisto/appinsights.env en la raiz del consumidor.
Crea ese archivo con los nombres de recursos (sin secretos, versionable):
  APPINSIGHTS_APP=<nombre del App Insights>
  APPINSIGHTS_RG=<resource group del App Insights y las Function Apps>
  SERVICEBUS_NAMESPACE=<namespace de Service Bus>
  SERVICEBUS_RG=<resource group de Service Bus>
  FUNCTIONAPP_NAMES=<function apps separadas por coma>
```

Si ambas validaciones pasan, delega:

{{mefisto:launch-agent bug-investigator Sintoma reportado: <sintoma sin flags>}}

Responde con:

```
Agente bug-investigator lanzado.
Sintoma: [SINTOMA]

El agente investigara en App Insights, correlacionara con el codigo
y te presentara hipotesis antes de tomar accion.
```

## Reglas

- **No investigues nada tu mismo.** Solo clasifica, valida y lanza el agente.
- **No modifiques codigo.** Ningun agente puede hacerlo.
