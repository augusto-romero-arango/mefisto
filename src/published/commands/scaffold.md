---
{
  "kind": "command",
  "id": "scaffold",
  "description": "Lanza el pipeline de scaffold para crear un nuevo dominio, opcionalmente asociado a un issue de GitHub.",
  "profile": "fast",
  "arguments": "<issue> [dominio] | <dominio>"
}
---

{{mefisto:assert-consumer-repo}}

Lanza el pipeline de scaffold para crear un nuevo dominio, opcionalmente asociado a un issue de GitHub. Comunicate en **espanol**.

## Entrada

`$ARGUMENTS` puede ser:
- Un numero de issue: `42`
- Un numero de issue + dominio: `42 calculo-horas`
- Solo dominio (sin issue): `calculo-horas`

Si `$ARGUMENTS` esta vacio, responde: `Uso: {{mefisto:command scaffold}} <numero-de-issue> o {{mefisto:command scaffold}} <nombre-dominio>`

## Proceso

### 1. Parsear entrada

Analiza `$ARGUMENTS`:
- Si es un numero solo → `ISSUE_NUM=N`, `DOMAIN_NAME=""`
- Si son dos tokens y el primero es numero → `ISSUE_NUM=N`, `DOMAIN_NAME=segundo`
- Si es un string con letras → `ISSUE_NUM=""`, `DOMAIN_NAME=string`

### 2. Si hay issue, validar y extraer info

```bash
gh issue view <issue> --json number,title,state,labels,body -q '"#\(.number): \(.title) [\(.state)] labels: \([.labels[].name] | join(", "))"'
```

Si el issue no existe o esta cerrado (`CLOSED`), informa y detente.

Si no hay `DOMAIN_NAME`, extrae del body la linea `Dominio: nombre-kebab` en cualquier posicion de la linea y sin distinguir mayusculas, con una expresion portable (sin `grep -P`, que el `grep` BSD de macOS no admite):

```bash
gh issue view <issue> --json body -q '.body' | sed -n 's/.*[Dd][Oo][Mm][Ii][Nn][Ii][Oo]:[[:space:]]*\([A-Za-z][A-Za-z0-9-]*\).*/\1/p' | head -1
```

### 3. Validar que hay dominio

Si no se pudo determinar el nombre del dominio de ninguna fuente, responde:

```
No se pudo determinar el nombre del dominio.
Opciones:
  {{mefisto:command scaffold}} 42 calculo-horas        (issue + dominio explicito)
  {{mefisto:command scaffold}} calculo-horas           (dominio sin issue)
  Agregar "Dominio: nombre" al body del issue
```

### 3b. Normalizar a kebab-case

Si el dominio viene en PascalCase (ej: `ControlHoras`), convertirlo a kebab-case (`control-horas`).
Guardar ambas formas: `DOMAIN_NAME_KEBAB` (para el script) y `DOMAIN_NAME_PASCAL` (para verificar directorio).

### 4. Verificar que el dominio no existe

Lee `namespacePrefix` desde `{{mefisto:config-path}}`; es el `<RootNamespace>`. Si la configuracion no es consultable o `namespacePrefix` falta o esta vacio, informa el error y detente. Convierte el dominio a PascalCase (ej: `calculo-horas` -> `CalculoHoras`) y verifica:

```bash
node "{{mefisto:package-root}}/scripts/json-value.mts" get "{{mefisto:config-path}}" namespacePrefix --or-empty
test -d "src/<namespacePrefix>.{PascalCase}/"
```

Si ya existe, informa y detente.

### 5. Confirmar con el usuario

Muestra exactamente lo que se va a crear (con `<RootNamespace>` sustituido por `namespacePrefix`) y pregunta:

```
Se va a crear el scaffold del dominio "{domain-name}" ({PascalCase}):

  - Function App:   src/<RootNamespace>.{PascalCase}/
  - Tests:          tests/<RootNamespace>.{PascalCase}.Tests/
  - Smoke Tests:    tests/<RootNamespace>.{PascalCase}.SmokeTests/
  - Terraform:      infra/environments/dev/dominio-{kebab}.tf (archivo propio del dominio)
                    (Service Plan dedicado asp-{kebab}-... + Storage + Function App, MEF-ADR-0020)
  - GitHub Actions: .github/workflows/deploy-{kebab}.yml
                    (+ smoke-tests-dominio.yml y smoke-tests.yml la primera vez en el repo)
  - Smoke tests:    .github/smoke-tests/{kebab}.json (registro propio del dominio)
  - Label:          dom:{kebab}

Issue: #{N} (o "sin issue asociado")

El scaffold se ejecutara en un worktree aislado y creara un PR al terminar.
¿Continuar? (s/n)
```

Si dice no, detente.

### 6. Lanzar el pipeline

Con `DOMAIN_NAME_KEBAB` como dominio confirmado:

```bash
# Con issue:
{{mefisto:run launch-pipeline.mts --scaffold <issue> --domain <dominio-kebab-confirmado>}}

# Sin issue:
{{mefisto:run launch-pipeline.mts --scaffold --domain <dominio-kebab-confirmado>}}
```

### 7. Instrucciones de seguimiento

Seguimiento por runtime: cuando el runtime activo trae su propia cinta de seguimiento (la consola `fausto-blood-pact`) y el usuario no fijo la interfaz, el script no abre pane: corre desacoplado, imprime la ruta del log y el avance lo sigue esa consola desde esta misma sesion. En el resto de los runtimes (MEF-ADR-0050): dentro de Herdr (`HERDR_ENV=1` en el entorno), el script delega en la interfaz Herdr: el pipeline queda corriendo en un pane de este mismo workspace con el visor en vivo del agente. En ese caso responde con:

```
Pipeline de scaffold corriendo en un pane de este workspace (visor en vivo del agente).
Log: {{mefisto:state-path logs}}/scaffold-<timestamp>-<pid>.log
```

Fuera de Herdr el script tambien corre desacoplado, sin consola que lo siga: su salida dice `sin pane` sin nombrar la consola, e imprime la ruta del log y la linea del visor. En ese caso responde con:

```
Pipeline de scaffold corriendo sin pane. Para monitorear, en otra terminal:
  <linea de stream-watch.mts que imprimio el script>

Log: {{mefisto:state-path logs}}/scaffold-<timestamp>-<pid>.log
```

## Reglas

- **No esperes a que termine.** El script corre en background (desacoplado o en un pane Herdr). Devuelve el control inmediatamente.
- **No crees el dominio tu mismo.** Solo lanza el script.
- **Nunca crees un dominio sin confirmacion explicita del usuario.** La creacion implica Terraform e infraestructura en Azure.
- `MEFISTO_UI` admite `mod` (desacoplado) y `herdr` (panes, solo dentro de Herdr); con cualquier otro valor el script aborta y muestra el error.
