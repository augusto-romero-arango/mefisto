---
{
  "kind": "command",
  "id": "mefisto-fix-review",
  "description": "Resuelve los comentarios de revision de un pull request del repo de Mefisto.",
  "profile": "deep",
  "arguments": "<numero-de-PR>"
}
---

Resuelve los comentarios de revision de un pull request del repo de Mefisto. Comunicate en **espanol**.

**Alcance**: solo opera sobre PRs del repo de Mefisto. Para PRs del consumidor, usa `/fix-review` publicado.

## Entrada

El numero de PR esta en: $ARGUMENTS

Si `$ARGUMENTS` esta vacio, responde: `Uso: /mefisto-fix-review <numero-de-PR>`

## Proceso

### 0. Verificar que estas en el repo de Mefisto

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "ERROR: no estas en un repositorio git"; exit 1;
}
[ -f "$REPO_ROOT/.claude-plugin/plugin.json" ] || {
    echo "ERROR: este skill solo se ejecuta en el repo de Mefisto."
    echo "Si trabajas en un proyecto consumidor, usa /fix-review en su lugar."
    exit 1
}
```

### 1. Fases del fix-review (adaptadas al harness)

El flujo general es identico al `/fix-review` publicado (Triaje -> Plan -> Ejecutar -> Responder -> Mejora continua), con estas diferencias:

- **Sin `dotnet build` ni `dotnet test`**: Mefisto no tiene .sln. La verificacion post-cambios es:
  ```bash
  npx tsc -p src/internal/tsconfig.json   # tipos de los .mts
  node --test scripts/tests/guards.test.mts
  ```
  Suma los `*.test.mts` que mencionen los archivos que tocaste.
  Si modificaste archivos `.md` de skills/agentes, no hay verificacion automatica de schema; revisa que el frontmatter siga el formato del resto.
- **Mejoras a agentes** se aplican sobre `agents/` (publicados) o `src/internal/agents/` (internos -- tras editar, regenera los adaptadores con el generador de `src/internal/scripts/`) segun corresponda.
- **Commits**: separa el commit de correcciones del de mejoras a agentes, igual que en el publicado.
- **Field notes** en `docs/bitacora/field-notes/` del repo de Mefisto.

### 2. Resto de las fases

Sigue el mismo proceso conceptual que el skill `/fix-review` publicado:
1. Triaje de comentarios (`resuelto` / `explicar` / `corregir` / `investigar`).
2. Plan en modo plan.
3. Ejecucion de cambios con `Edit`/`Write`.
4. Respuestas a los comentarios (con aprobacion previa).
5. Field note y mejoras a agentes/skills si aplica.

## Reglas

- **Nunca publiques una respuesta sin aprobacion del usuario**.
- **Nunca auto-resuelvas comentarios**.
- **Verifica sintaxis bash** antes de hacer push si modificaste scripts (`bash -n`).
- **Las mejoras a agentes/skills van en commit separado en la misma rama del PR.** Nunca se pushean directo a `main`; si el usuario quiere partirlas en otro PR, crea rama nueva (`git switch -c docs/agentes-mejoras-pr-<n>`) y abre un segundo PR contra `main`. Aplica el mismo guard que el `/fix-review` publicado: si por error estuvieras en `main`, crea la rama antes de commitear.
