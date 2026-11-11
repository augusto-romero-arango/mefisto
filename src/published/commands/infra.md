---
{
  "kind": "command",
  "id": "infra",
  "description": "Lanza el pipeline IaC para un issue de GitHub.",
  "profile": "fast",
  "arguments": "<issue>"
}
---

{{mefisto:assert-consumer-repo}}

Lanza el pipeline IaC para un issue de GitHub. Comunicate en **espanol**.

## Entrada

El numero de issue esta en: $ARGUMENTS

Si `$ARGUMENTS` esta vacio, responde: `Uso: {{mefisto:command infra}} <numero-de-issue>`

## Proceso

### 1. Validar el issue

```bash
gh issue view $ARGUMENTS --json number,title,state,labels -q '"#\(.number): \(.title) [\(.state)] labels: \([.labels[].name] | join(", "))"'
```

Si el issue no existe o esta cerrado (`CLOSED`), informa y detente.

### 2. Validar que es una tarea de infra

Extrae labels del issue:

```bash
gh issue view $ARGUMENTS --json labels -q '[.labels[].name] | join(",")'
```

Verifica que tenga el label `tipo:infra`. Si no lo tiene, advierte al usuario:

```
Este issue no tiene el label tipo:infra.
Si es logica de dominio, usa {{mefisto:command implement}} en su lugar.
Si es tooling, usa {{mefisto:command tooling}} en su lugar.
Continuar de todos modos? (s/n)
```

Si no se confirma, detente.

### 2.5. Verificar label bloqueado

Si el issue tiene el label `bloqueado`, lee solo la seccion `## Dependencias` del body, hasta el siguiente encabezado de nivel dos, y considera exclusivamente las lineas canonicas `Depende de #N` o `Bloqueado por #N` (tambien si llevan marcador de lista). Ignora cualquier otro `#N`.

Para cada numero, consulta primero titulo y estado con `gh pr view`. Solo si GitHub confirma que el numero no corresponde a un PR, consulta `gh issue view`; cualquier otro fallo de la consulta del PR es no consultable y bloquea. Nunca supongas que un fallo significa cierre.

- Si **todas** las dependencias canonicas declaradas cerraron (`CLOSED`) o se integraron (`MERGED`): quita el label, informa el desbloqueo y continua:

```bash
gh issue edit $ARGUMENTS --remove-label "bloqueado"
```

```
Dependencias resueltas: se quito el label 'bloqueado'.
```

- Si no hay una dependencia canonica consultable, o **alguna** dependencia sigue abierta o no es consultable: conserva el label, muestra cuales y **detente**:

```
El issue #$ARGUMENTS esta bloqueado. Dependencias abiertas:
  - #42: [titulo] (OPEN)
  - #55: [titulo] (OPEN)

Resuelve estas dependencias antes de lanzar el pipeline.
```

### 3. Mostrar info y lanzar

Muestra una linea con el issue:

```
#42: Configurar Application Insights con daily cap
Tipo: infra | Estado: listo
```

Luego lanza el pipeline:

```bash
{{mefisto:run launch-pipeline.sh --infra $ARGUMENTS}}
```

### 4. Instrucciones de seguimiento

Seguimiento por runtime: cuando el runtime activo trae su propia cinta de seguimiento (la consola `fausto-blood-pact`) y el usuario no fijo la interfaz, el wrapper no abre pane: corre desacoplado, imprime la ruta del log y el avance lo sigue esa consola desde esta misma sesion. En el resto de los runtimes (MEF-ADR-0050): dentro de Herdr (`HERDR_ENV=1` en el entorno), el script delega en la interfaz Herdr: el pipeline queda corriendo en un pane de este mismo workspace con el visor en vivo del agente. En ese caso responde con:

```
Pipeline infra corriendo en un pane de este workspace (visor en vivo del agente).
```

Fuera de Herdr el script tambien corre desacoplado, sin consola que lo siga: su salida dice `sin pane` sin nombrar la consola, e imprime la ruta del log y la linea del visor. En ese caso responde con:

```
Pipeline infra corriendo sin pane. Para monitorear, en otra terminal:
  <linea de stream-watch.sh que imprimio el script>
Log: <ruta del log que imprimio el script>
```

## Flujo: cero permisos de Azure en local (MEF-ADR-0021, MEF-ADR-0022)

En el flujo *ongoing*, el desarrollador que usa Mefisto **no tiene ningun permiso de Azure**. Este pipeline corre enteramente sin credenciales de Azure y sin sesion `az login`:

1. **Write** (`infra-writer`): escribe o modifica el HCL en un worktree aislado.
2. **Review** (`infra-reviewer`): revisa seguridad/calidad del HCL y hace **revision estatica** (`terraform fmt -check` + `terraform init -backend=false` + `terraform validate`). **No** ejecuta `terraform plan`.
3. **PR**: el pipeline crea un PR con el HCL escrito y revisado. El PR **nunca** lleva `Closes #N`.

El **plan real** corre en CI cuando se abre el PR (workflow `infra-cd.yml`, job `plan`, publicado como comentario del PR) y el **apply real** corre en CI al mergear el PR a `main` (job `apply`). Ese mismo job cierra el issue tras un apply exitoso (MEF-ADR-0022) -- nunca el propio merge del PR ni este pipeline local.

**Distincion bootstrap vs ongoing**: el bootstrap inicial (`bootstrap-backend.sh` para el tfstate, `setup-github-ci.sh` para el Service Principal de CI) es una operacion **privilegiada de una sola vez** que corre un admin con permisos de Azure para habilitar la CI. No es parte de este flujo ongoing.

## Reglas

- **No esperes a que termine.** El script corre en background (desacoplado o en un pane Herdr). Devuelve el control inmediatamente.
- **No implementes nada tu mismo.** Solo lanza el script.
- `MEFISTO_UI` admite `mod` (desacoplado) y `herdr` (panes, solo dentro de Herdr); con cualquier otro valor el script aborta y muestra el error.
