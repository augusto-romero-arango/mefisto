---
description: "Lanza el pipeline de scaffold para crear un nuevo dominio, opcionalmente asociado a un issue de GitHub."
argument-hint: "<issue> [dominio] | <dominio>"
model: "haiku"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/scaffold.md. No editar a mano. -->
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

Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.sh`: ese directorio es el repositorio de Mefisto, no un consumidor.

Lanza el pipeline de scaffold para crear un nuevo dominio, opcionalmente asociado a un issue de GitHub. Comunicate en **espanol**.

## Entrada

`$ARGUMENTS` puede ser:
- Un numero de issue: `42`
- Un numero de issue + dominio: `42 calculo-horas`
- Solo dominio (sin issue): `calculo-horas`

Si `$ARGUMENTS` esta vacio, responde: `Uso: /mefisto:scaffold <numero-de-issue> o /mefisto:scaffold <nombre-dominio>`

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
  /mefisto:scaffold 42 calculo-horas        (issue + dominio explicito)
  /mefisto:scaffold calculo-horas           (dominio sin issue)
  Agregar "Dominio: nombre" al body del issue
```

### 3b. Normalizar a kebab-case

Si el dominio viene en PascalCase (ej: `ControlHoras`), convertirlo a kebab-case (`control-horas`).
Guardar ambas formas: `DOMAIN_NAME_KEBAB` (para el script) y `DOMAIN_NAME_PASCAL` (para verificar directorio).

### 4. Verificar que el dominio no existe

Lee `namespacePrefix` desde `${MEFISTO_CONFIG_PATH}`; es el `<RootNamespace>`. Si la configuracion no es consultable o `namespacePrefix` falta o esta vacio, informa el error y detente. Convierte el dominio a PascalCase (ej: `calculo-horas` -> `CalculoHoras`) y verifica:

```bash
jq -r '.namespacePrefix // empty' "${MEFISTO_CONFIG_PATH}"
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
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/tmux-pipeline.sh" --scaffold <issue> --domain <dominio-kebab-confirmado>

# Sin issue:
MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/tmux-pipeline.sh" --scaffold --domain <dominio-kebab-confirmado>
```

### 7. Instrucciones de conexion

Dentro de Herdr (`HERDR_ENV=1` en el entorno), el script delega en la interfaz Herdr y no hay nada que adjuntar: el pipeline queda corriendo en un pane de este mismo workspace con el visor en vivo del agente. En ese caso responde con:

```
Pipeline de scaffold corriendo en un pane de este workspace (visor en vivo del agente).
Log: .mefisto/pipeline/logs/scaffold-<timestamp>-<pid>.log
```

Fuera de Herdr responde con:

```
Pipeline de scaffold lanzado en tmux. Para monitorear:
  tmux -CC attach -t scaffold-<dominio>

Log: .mefisto/pipeline/logs/scaffold-<timestamp>-<pid>.log
```

## Reglas

- **No esperes a que termine.** El script corre en background (en un pane Herdr o una sesion tmux). Devuelve el control inmediatamente.
- **No crees el dominio tu mismo.** Solo lanza el script.
- **Nunca crees un dominio sin confirmacion explicita del usuario.** La creacion implica Terraform e infraestructura en Azure.
- Si tmux no esta instalado (y no estas dentro de Herdr), el script lo detecta y muestra el error. No intentes instalarlo.
