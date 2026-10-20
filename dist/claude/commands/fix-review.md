---
description: "Resuelve los comentarios de revision de un PR del consumidor: triaje, plan, ejecucion, respuestas y mejora continua."
argument-hint: "<numero-de-PR>"
model: "opus"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/fix-review.md. No editar a mano. -->
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

Resuelve los comentarios de revision de un pull request. Comunicate en **espanol**.

**Alcance**: este comando solo resuelve PRs del proyecto consumidor.

Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.sh`: ese directorio es el repositorio de Mefisto, no un consumidor.

## Entrada

El numero de PR esta en: $ARGUMENTS

Si `$ARGUMENTS` esta vacio, responde: `Uso: /mefisto:fix-review <numero-de-PR>`

---

## Fase 1: Triaje

### 1.1 Obtener datos del PR

Lee en paralelo:

```bash
gh pr view $ARGUMENTS --json title,body,state,headRefName,baseRefName,url
```

```bash
gh api repos/{owner}/{repo}/pulls/$ARGUMENTS/comments --jq '.[] | "---\nid: \(.id)\nfile: \(.path)\nline: \(.line // .original_line)\nbody: \(.body)\n"'
```

Si el PR no existe o esta cerrado, informa y detente.

Verifica que estas en la rama correcta del PR (`headRefName`). Si no:

```bash
git checkout <headRefName>
```

### 1.2 Explorar el codigo referenciado

Para cada comentario, lee el archivo y las lineas referenciadas. Lee los archivos directamente con la herramienta de lectura de tu runtime, sin pasar por el shell.

Si un comentario referencia un ADR, convencion o patron, leelo tambien para tener contexto completo.

### 1.3 Clasificar cada comentario

Clasifica cada comentario en una de estas categorias:

| Categoria     | Significado                                              | Accion                                  |
|---------------|----------------------------------------------------------|-----------------------------------------|
| **resuelto**  | El codigo ya esta correcto (cambio posterior lo resolvio) | Responder explicando que ya esta resuelto |
| **explicar**  | El codigo esta bien pero falta contexto                  | Responder con explicacion tecnica        |
| **corregir**  | El reviewer tiene razon, hay que cambiar codigo          | Planificar y ejecutar cambio             |
| **investigar**| No hay respuesta inmediata, requiere trabajo separado    | Proponer issue de seguimiento            |

### 1.4 Presentar triaje al usuario

Muestra una tabla con la clasificacion:

```
## Triaje de comentarios — PR #N

| # | Archivo                    | Categoria   | Resumen                              |
|---|----------------------------|-------------|--------------------------------------|
| 1 | src/.../MiArchivo.cs:42    | corregir    | Falta parametro X en constructor     |
| 2 | tests/.../MiTest.cs:15     | explicar    | El patron es correcto segun MEF-ADR-0005  |
| 3 | infra/.../main.tf:51       | resuelto    | Ya corregido en commit abc1234       |
| 4 | tests/.../Smoke.cs:14      | investigar  | Requiere investigacion de approach   |
```

**Espera confirmacion del usuario.** El usuario puede:
- Aprobar el triaje tal cual
- Reclasificar comentarios (ej: "el 2 tambien hay que corregirlo")
- Agregar contexto que cambie la clasificacion

**No avances a la Fase 2 sin aprobacion explicita del triaje.**

---

## Fase 2: Plan

### 2.1 Redactar el plan

Redacta el plan completo **en el chat**, sin editar ningun archivo todavia. El gate es el mismo en cualquier runtime y no depende de una herramienta de plan nativa.

### 2.2 Estructura del plan

El plan debe tener esta estructura:

```markdown
# Plan: Resolver comentarios del PR #N

## Contexto
[Por que se hace este cambio — el PR, los comentarios, el issue original]

## Comentarios a corregir
[Para cada comentario clasificado como "corregir":]

### C<id>: <resumen del comentario>
- **Archivo**: <path>:<linea>
- **Cambio**: <descripcion concreta del cambio>
- **Impacto**: <otros archivos afectados>

## Comentarios a explicar
[Para cada comentario clasificado como "explicar":]

### C<id>: <resumen>
- **Borrador de respuesta**: <texto que se publicara como respuesta>

## Comentarios ya resueltos
[Lista breve]

## Comentarios a investigar
[Para cada uno, propuesta de issue de seguimiento]

## Orden de ejecucion
[Cambios agrupados por dependencia]

## Verificacion
[Comandos para validar: build, tests, sin warnings nuevos (MEF-ADR-0056)]
```

### 2.3 Gate de aprobacion

Presenta el plan completo y detente. Exige aprobacion explicita del usuario antes de editar cualquier archivo.

**No avances a la Fase 3 sin aprobacion del plan.**

---

## Fase 3: Ejecutar

### 3.1 Aplicar cambios de codigo

Antes de editar, registra la base del diferencial de warnings (HEAD justo antes de tus cambios, no la base del PR: respondes solo por los warnings que introducen tus propios cambios):

```bash
FIX_BASE=$(git rev-parse HEAD)
```

Cada bloque `bash` corre en un shell nuevo: sustituye `<FIX_BASE>` por el SHA que imprimio este bloque.

Ejecuta los cambios del plan en el orden definido. Modifica los archivos existentes con la herramienta de edicion y crea archivos nuevos solo cuando el plan lo indique.

### 3.2 Verificar

```bash
dotnet build
dotnet test
```

Si hay errores, corrigelos antes de continuar. Si un test falla por una razon no relacionada con tus cambios, informalo al usuario.

**Cero warnings nuevos (MEF-ADR-0056).** Ademas de build y tests, corre el helper del plugin (el comando corre con `cwd` en el consumidor: usa la ruta del paquete, no `scripts/` relativo). Elige las toolchains segun los archivos tocados desde la base, incluidos los archivos sin seguimiento:

```bash
git diff --name-only <FIX_BASE>
git ls-files --others --exclude-standard
```

- `dotnet`: si tocaste algun `*.cs`, `*.csproj`, `*.props`, `*.targets` o `.editorconfig`.
- `terraform`: si tocaste algun `*.tf`; una corrida por cada entorno que exista en `infra/environments/<env>`.
- `shell`: si tocaste algun `*.sh`.

```bash
${MEFISTO_PACKAGE_ROOT}/scripts/warnings-diff.sh --toolchain dotnet --base <FIX_BASE>
${MEFISTO_PACKAGE_ROOT}/scripts/warnings-diff.sh --toolchain terraform --path infra/environments/<env> --base <FIX_BASE>
${MEFISTO_PACKAGE_ROOT}/scripts/warnings-diff.sh --toolchain shell --base <FIX_BASE>
```

- Exit `2`: hay warnings `NEW` (una supresion anadida aparece con codigo `SUPPRESSION`). Remedia cada uno antes del commit y vuelve a correrlo.
- Exit `1`: no se pudo medir (p. ej. no compila). Informa al usuario y sigue; la politica no bloquea.
- **Prohibido suprimir como remediacion**: `#pragma warning disable`, `SuppressMessage`, `NoWarn`, `WarningLevel`, bajar la severidad en `.editorconfig` y `# shellcheck disable=` no remedian nada.

**Warning que no puedas remediar: issue remanente.** Por cada `NEW` que quede, deduplica por codigo y archivo entre los issues `warning` abiertos:

```bash
gh issue list --state open --label warning --search "<codigo> <archivo>" --json number,title
```

Si ya existe uno, comenta en el:

```bash
gh issue comment <N> --body "Reaparece en el PR #<pr> (rama <rama>): <warning literal>. Razon: <razon>"
```

Si no existe, toma el `Closes #N` del body del PR leido en la Fase 1.1 y consulta sus labels (`gh issue view <N> --json labels`). Crea el issue con los `tipo:*` y `dom:*` de ese issue mas `estado:borrador` y `warning` (MEF-ADR-0007, MEF-ADR-0011); sin `Closes`, solo `estado:borrador` y `warning`:

```bash
gh issue create \
  --title "Remediar <codigo> en <archivo>" \
  --label "estado:borrador" --label "warning" --label "<tipo:X>" --label "<dom:X>" \
  --body "<warning literal, archivo, PR origen y la razon por la que no se pudo remediar>"
```

Crearlo no pide confirmacion extra. Si `gh` falla (p. ej. el consumidor no tiene el label `warning`), informa al usuario y sigue sin bloquear. Recuerda los numeros de issue: se enlazan en el comentario `## Warnings remanentes` de la Fase 4.

### 3.3 Commit y push

Crea un commit con mensaje descriptivo que referencie el PR:

```
fix(hu-N): resolver comentarios de revision del PR #N

- [resumen de cambios principales]
```

No escribas una linea de atribucion a mano: sigue la convencion de atribucion de tu runtime o del usuario.

Haz push a la rama del PR.

---

## Fase 4: Responder

### 4.1 Redactar respuestas finales

Para **cada** comentario del PR, redacta una respuesta informada por lo que realmente se hizo:

- **corregir**: "Corregido en [commit]. [descripcion breve del cambio]."
- **explicar**: La explicacion tecnica del plan (puede ajustarse si durante la ejecucion aprendiste algo nuevo).
- **resuelto**: "Este punto ya estaba resuelto en [commit/contexto]. [explicacion breve]."
- **investigar**: "Creado issue #N para investigar este punto. [enlace]."

### 4.2 Presentar borradores al usuario

Muestra todas las respuestas en una tabla o lista antes de publicarlas:

```
## Respuestas a publicar — PR #N

### Comentario 1 (src/.../MiArchivo.cs:42) — corregir
> [cita del comentario original]

Respuesta: "Corregido en abc1234. Se agrego el parametro X al constructor..."

### Comentario 2 (tests/.../MiTest.cs:15) — explicar
> [cita del comentario original]

Respuesta: "El patron es correcto segun MEF-ADR-0005 porque..."
```

Si la Fase 3 dejo issues de warnings remanentes, incluye tambien el comentario general que se publicara:

```
## Warnings remanentes

- Relacionado: #N
```

Una linea `- Relacionado: #N` por issue remanente (creado o reutilizado).

**Espera aprobacion del usuario antes de publicar.**

### 4.3 Publicar respuestas en GitHub

Para cada respuesta aprobada:

```bash
gh api repos/{owner}/{repo}/pulls/$ARGUMENTS/comments \
  -f body="<respuesta>" \
  -F in_reply_to=<comment-id>
```

> **Importante:** El endpoint correcto para responder a un review comment es `POST /pulls/{pr}/comments` con el parametro `in_reply_to` apuntando al ID del comentario original. NO uses el sub-endpoint `/replies` — no existe y retorna 404.

Si la Fase 3 dejo issues de warnings remanentes, publica ademas el comentario general aprobado en la 4.2:

```bash
gh pr comment $ARGUMENTS --body "$(cat <<'WARNEOF'
## Warnings remanentes

- Relacionado: #<N>
WARNEOF
)"
```

Si `gh` falla, informa al usuario y sigue.

Confirma al final:

```
Listo. PR #N:
- N comentarios respondidos
- N cambios aplicados (commit abc1234)
- N issues de seguimiento creados
- N issues de warnings remanentes
```

---

## Fase 5: Mejora continua

Cada comentario de review es evidencia de un gap en las instrucciones de un agente. Esta fase traza las correcciones hasta su origen y propone mejoras.

> **Harness read-only.** Los agentes y skills del marco no viven en el repo consumidor: estan en la release instalada del plugin `mefisto`, read-only y versionada, en `${MEFISTO_PACKAGE_ROOT}/agents/`. Por eso una mejora a un artefacto del harness **no se puede editar en la rama del PR del consumidor**: se enruta como **draft** (`estado:borrador`) al repo de Mefisto via `gh -R`, igual que hacen el `planner` y el `tooling-investigator` publicados (ver la seccion C "Routing cross-repo: solo drafts" de MEF-ADR-0019, `${MEFISTO_PACKAGE_ROOT}/docs/adr/mef-adr-0019-*.md`). La edicion en-rama queda reservada a lo que realmente vive en el consumidor (un ADR local del proyecto, convenciones de su `AGENTS.md`, un fixture/helper propio).

### 5.1 Trazar correcciones a su origen

Lee el body del PR — el pipeline TDD registra decisiones de cada agente (test-writer, implementer, reviewer) en secciones `<details>`. Para cada comentario clasificado como "corregir", lee la definicion del agente del harness que produjo el codigo en `${MEFISTO_PACKAGE_ROOT}/agents/<id>.md` y responde:

- **¿Que agente produjo el codigo?** (test-writer, implementer, reviewer, infra-writer, domain-scaffolder, etc.)
- **¿Que tipo de gap causo el error?**
  - Regla faltante: el agente no tenia instruccion sobre este caso
  - Regla ignorada: la instruccion existe pero no se siguio (reforzar o reformular)
  - Conocimiento de dominio: el agente no tenia contexto de negocio o arquitectura
  - Limitacion del framework: el agente no conocia un overload, API o patron del framework

### 5.2 Proponer ajustes concretos

Para cada gap identificado, proponer:

```
## Propuesta de mejora — PR #N

### Ajuste 1: [descripcion breve]
- **Agente/skill afectado**: `implementer` (o `reviewer`, `test-writer`, skill, pipeline). Si es del harness, lee su definicion en `${MEFISTO_PACKAGE_ROOT}/agents/<id>.md`; no vive en el consumidor.
- **Destino del ajuste**: draft en el harness | edicion local en el consumidor
- **Seccion**: [nombre de la seccion donde iria el cambio]
- **Tipo de gap**: regla faltante | regla ignorada | conocimiento dominio | limitacion framework
- **Causa raiz**: [por que el agente tomo la decision incorrecta]
- **Cambio propuesto**: [descripcion del ajuste — nueva regla, ejemplo, reformulacion]

### Ajuste 2: ...
```

El **destino** se decide por donde vive el archivo a tocar: un agente/skill/pipeline/hook del harness va como **draft a Mefisto** (no es editable desde el consumidor); un ADR local o una convencion del `AGENTS.md` del consumidor se **edita en-rama**. La Fase 5.4 detalla cada caso.

Si el PR no tuvo correcciones que ameriten mejoras (todos los comentarios eran "explicar" o "resuelto"), indica que no hay ajustes necesarios y salta a la field note.

### 5.3 Presentar plan de mejora al usuario

Muestra las propuestas. **Espera aprobacion explicita.** El usuario puede:
- Aprobar todas
- Descartar algunas
- Reformular la redaccion de una regla
- Agregar contexto que enriquezca la mejora

### 5.4 Aplicar los ajustes aprobados

Cada ajuste aprobado tiene un **destino** segun donde viva el archivo a tocar:

| Destino | Donde vive el archivo | Accion |
|---|---|---|
| **Harness** (`mefisto`) | Release instalada del plugin (`${MEFISTO_PACKAGE_ROOT}/`), read-only y versionada | **Crear un draft** (`estado:borrador`) en el repo de Mefisto via `gh -R` |
| **Consumidor** (este repo) | ADR local del proyecto (`docs/adr/`), convencion de su `AGENTS.md`, fixture/helper propio | **Editar en-rama**, commit en la rama del PR |

#### Si el ajuste es al harness: crear un draft cross-repo

Reutiliza el mismo routing que el `planner` y el `tooling-investigator` publicados (ver la seccion C "Routing cross-repo: solo drafts" de MEF-ADR-0019, `${MEFISTO_PACKAGE_ROOT}/docs/adr/mef-adr-0019-*.md`). Lee el slug del repo de Mefisto (configurable para forks):

Lee `repoSlug` desde `${MEFISTO_CONFIG_PATH}` (MEF-ADR-0053 decision 4). El campo es opcional: si el config no lo declara o esta vacio, aplica el default sin abortar:

```bash
SLUG=$(jq -r '.repoSlug // empty' "${MEFISTO_CONFIG_PATH}" 2>/dev/null); echo "${SLUG:-augusto-romero-arango/mefisto}"
```

Cada bloque `bash` corre en un shell nuevo: en el `gh issue create -R "<slug>"` de mas abajo, sustituye `<slug>` por el slug que imprimio este bloque.

Crea un draft por cada ajuste aprobado (o uno agrupando ajustes al mismo agente), describiendo el gap y el cambio propuesto:

```bash
gh issue create -R "<slug>" \
  --title "[verbo infinitivo] [que cosa]" \
  --label "estado:borrador,tipo:tooling" \
  --body "$(cat <<'DRAFTEOF'
## Idea
[Gap detectado + cambio propuesto en el agente/skill del harness]

## Origen
- Descubierto desde el consumidor [nombre o slug del repo del consumidor], review del PR #<numero>
- Agente/skill del harness afectado: <implementer | reviewer | test-writer | ...>
- Tipo de gap: regla faltante | regla ignorada | conocimiento dominio | limitacion framework
- Causa raiz: [por que el agente tomo la decision incorrecta]
- Field notes: [URL del field-note de la Fase 5.5]
DRAFTEOF
)"
```

**Importante** (igual que el resto del routing cross-repo):
- Solo `estado:borrador` y `tipo:tooling`. **No agregues** `dom:`, `estado:listo`, ni intentes refinar el draft. El refinamiento ocurre dentro del repo de Mefisto con `/mefisto-plan`.
- Captura el numero del draft creado: va en la columna "Ajuste aplicado" de la field note (5.5) como `Draft propuesto en harness #N`.
- Si `gh -R` falla con 403 (sin permisos), no insistas: indica al usuario que cree el draft manualmente desde la UI de GitHub con los datos recopilados.

> El #37 del repo de Mefisto es exactamente el resultado de aplicar este routing a mano cuando la Fase 5.4 todavia asumia edicion en-rama; sirve de ejemplo del comportamiento esperado.

#### Si el ajuste es local del consumidor: editar en-rama

Solo para lo que **realmente vive en el consumidor** (un ADR local del proyecto, una convencion de su `AGENTS.md`, un fixture/helper). Edita y commitea en la **misma rama del PR**, en commit separado del de correcciones de codigo.

Los fixtures y helpers son codigo y pueden introducir warnings (MEF-ADR-0056). Antes del primer ajuste en la rama del PR, registra la base del diferencial:

```bash
ADJ_BASE=$(git rev-parse HEAD)
```

Cada bloque `bash` corre en un shell nuevo: sustituye `<ADJ_BASE>` por el SHA que imprimio este bloque.

Antes de commitear, verifica que **no estas en `main`** (guard idempotente; en el flujo normal ya estas en la rama del PR por el `git checkout <headRefName>` de la Fase 1.1, asi que no dispara):

```bash
git symbolic-ref --short HEAD
```

Si imprime `main`, cambia a una rama de docs y vuelve a verificar:

```bash
git switch -c "docs/convenciones-pr-<numero-de-PR>" 2>/dev/null || git switch "docs/convenciones-pr-<numero-de-PR>"
git symbolic-ref --short HEAD
```

Si tras eso la rama sigue siendo `main`, aborta la Fase 5.4: no estas en la rama del PR.

**Cero warnings nuevos (MEF-ADR-0056).** Antes del commit, aplica la misma regla de la Fase 3.2 con `--base <ADJ_BASE>`: toolchains segun los archivos tocados desde `<ADJ_BASE>`, remediar cada `NEW`, supresiones prohibidas y exit `1` informado sin bloquear. Los warnings que no puedas remediar siguen el issue remanente de la Fase 3.2 (titulo, labels, body y deduplicacion).

Commitea con un mensaje como:

```
docs(convenciones): ajustar [archivo local] a partir del review del PR #N

- [resumen del ajuste]
```

Push a la rama del PR. No pushees nunca directo a `main`: la politica del marco (ver el archivo efectivo de instrucciones: `AGENTS.md`) exige entregar siempre via rama + PR.

Al terminar la 5.4, si sus ajustes dejaron issues de warnings remanentes, publica su propio comentario en el PR, con una linea `- Relacionado: #N` por issue:

```bash
gh pr comment $ARGUMENTS --body "$(cat <<'WARNEOF'
## Warnings remanentes

- Relacionado: #<N>
WARNEOF
)"
```

Si `gh` falla, informa al usuario y sigue.

### 5.5 Field note

Genera una field note en `docs/bitacora/field-notes/` **del consumidor** con el registro de las lecciones aprendidas. Nombre: `review-pr-<numero>.md`. La field note siempre vive en el consumidor, aunque el ajuste se haya enrutado como draft al harness — solo cambia el destino del "ajuste", no donde se documenta el review.

Estructura:

```markdown
# Field Note: Review del PR #<numero>

**Fecha**: <fecha>
**PR**: <url del PR>
**Issue**: #<numero del issue original>

## Comentarios del review

| # | Categoria  | Resumen                          |
|---|------------|----------------------------------|
| 1 | corregir   | ...                              |
| 2 | explicar   | ...                              |

## Correcciones aplicadas

[Resumen breve de los cambios de codigo hechos en Fase 3]

## Mejoras a agentes

| Agente       | Gap              | Destino     | Ajuste aplicado                       |
|--------------|------------------|-------------|---------------------------------------|
| implementer  | regla faltante   | harness     | Draft propuesto en harness #N         |
| test-writer  | limitacion fw    | harness     | Draft propuesto en harness #N         |
| (ADR local)  | conocimiento dom | consumidor  | Editado en-rama (commit abc1234)      |

## Lecciones

[1-3 bullet points con las lecciones clave para el proyecto]
```

---

## Reglas

- **Nunca publiques una respuesta sin aprobacion del usuario.** Los borradores siempre se presentan primero.
- **Nunca auto-resuelvas comentarios.** Eso lo decide el reviewer original, no nosotros.
- **Si un cambio planificado no es viable durante la ejecucion**, detente, informa al usuario, y ajusta el plan antes de continuar.
- **Agrupa cambios relacionados en un solo commit.** No hagas un commit por comentario.
- **Si el triaje revela que todos los comentarios ya estan resueltos**, salta directamente a la Fase 4 (responder).
- **Siempre verifica build + tests antes de hacer push.** Si fallan, no hagas push.
- **Las mejoras a agentes/skills del harness se enrutan como draft (`estado:borrador`) al repo de Mefisto via `gh -R`**, no se editan en la rama del PR del consumidor: esos archivos viven en la release instalada del plugin (read-only). Solo los ajustes a archivos que viven en el consumidor (ADR local, convenciones de su `AGENTS.md`, fixtures propios) se editan en-rama, en commit separado y nunca directo a `main`.
- **La field note siempre se genera**, incluso si no hubo mejoras a agentes — el registro del review tiene valor historico.
- Comunica en espanol. Las respuestas a los comentarios del PR se redactan en el mismo idioma del comentario original.
