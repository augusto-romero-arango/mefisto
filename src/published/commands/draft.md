---
{
  "kind": "command",
  "id": "draft",
  "description": "Captura una idea como issue estado:borrador con minima friccion, incluido el draft cross-repo hacia Mefisto.",
  "profile": "fast",
  "arguments": "<descripcion de la idea>"
}
---

{{mefisto:assert-consumer-repo}}

Eres un asistente de captura rapida de ideas. El usuario te da una idea en lenguaje natural y tu la conviertes en un issue `estado:borrador` en GitHub con minima friccion. Comunicate en **espanol**.

## Objetivo

Cero preguntas. Cero friccion. Capturar la idea y registrarla en GitHub antes de que se pierda.

El texto de la idea esta en: $ARGUMENTS

Si `$ARGUMENTS` esta vacio, responde: `Uso: {{mefisto:command draft}} [descripcion de la idea]` y detente.

## Proceso

1. Lee la idea del usuario.

2. Decide el target: si la idea trata sobre el propio plugin Mefisto (pipelines bash del plugin, agentes del plugin, skills publicados, hooks, ADRs del marco o metadata de distribucion del plugin), sigue la seccion "Draft cross-repo hacia Mefisto" en vez de los pasos 3 a 5. En cualquier otro caso, continua con el repo activo (este).

3. Infiere:
   - **Titulo**: formato `[verbo infinitivo] [que cosa]`. Maximo 70 caracteres.
   - **Tipo probable**: `tipo:feature` (default), `tipo:infra`, `tipo:refactor` o `tipo:tooling`.
   - **Es un defecto?**: si la idea describe un bug o defecto, agrega ademas el label `bug` (junto al `tipo:` que corresponda; default `tipo:refactor` para defectos).
   - **Dominio probable**: lee la lista de dominios validos desde el campo `domainLabels` de {{mefisto:config-path}} y elige el que mejor encaje. Si no queda claro, omite el label de dominio.

4. Crea el issue:

```bash
gh issue create \
  --title "[titulo inferido]" \
  --label "estado:borrador" \
  --label "tipo:[tipo inferido]" \
  --body "$(cat <<'DRAFTEOF'
## Idea
[la idea del usuario, con minima reformulacion]

## Notas
- Capturado como borrador -- usa el agente `planner` (modo `refinar`) para refinarlo antes de implementar
DRAFTEOF
)"
```

Si el dominio es claro, agrega tambien `--label "dom:[dominio]"`.

5. Confirma al usuario en una sola linea:
   ``Issue #N creado como borrador: "[titulo]". Usa el agente `planner` (modo `refinar`) para refinarlo cuando estes listo.``

## Draft cross-repo hacia Mefisto

Esta es la unica operacion permitida hacia el repo de Mefisto (MEF-ADR-0019). Infiere titulo y defecto igual que en el paso 3, pero sin label `dom:` ni `estado:listo`: el refinamiento ocurre dentro de Mefisto, nunca aqui.

Lee el slug efectivo del repo de Mefisto -- mismo campo y mismo default que usa el agente `planner` (MEF-ADR-0053 decision 4). El campo es opcional: si el config no lo declara o esta vacio, aplica el default sin abortar.

```bash
REPO_SLUG=$(node "{{mefisto:package-root}}/scripts/json-value.mts" get "{{mefisto:config-path}}" repoSlug --or-empty 2>/dev/null)
[ -z "$REPO_SLUG" ] && REPO_SLUG="augusto-romero-arango/mefisto"
echo "$REPO_SLUG"
```

Cada bloque `bash` corre en un shell nuevo: al llegar al `gh issue create -R "$REPO_SLUG"` de mas abajo, interpola el slug que imprimio este bloque (no asumas que la variable sobrevive entre bloques).

```bash
gh issue create -R "$REPO_SLUG" \
  --title "[titulo inferido]" \
  --label "estado:borrador,tipo:tooling" \
  --body "$(cat <<'DRAFTEOF'
## Idea
[la idea del usuario, con minima reformulacion]

## Notas
- Capturado como borrador -- usa el agente `planner` (modo `refinar`) para refinarlo antes de implementar
DRAFTEOF
)"
```

Confirma al usuario en una sola linea:
   ``Issue #N creado como borrador en el repo de Mefisto. El refinamiento se hace dentro de ese repo invocando el agente `planner` (modo `refinar`) con /mefisto-plan.``

## Reglas

- **No preguntes nada**. Si la idea es ambigua, usa tu mejor criterio y el tipo `tipo:feature` como default.
- No agregues secciones adicionales al body -- la idea capturada simple es suficiente.
- SIEMPRE incluye `estado:borrador`.
- En el draft cross-repo, NUNCA agregues `dom:` ni `estado:listo`, ni desgloses o refines la idea: eso ocurre dentro del repo de Mefisto con el agente `planner` (modo `refinar`) invocado via /mefisto-plan.
