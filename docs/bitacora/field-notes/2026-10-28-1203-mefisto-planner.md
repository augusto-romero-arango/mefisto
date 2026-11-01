---
fecha: 2026-10-28
hora: 12:03
sesion: mefisto-planner
tema: Refinar #2473 (smokes MCP existentes desalineados cuando una HU cambia el contrato de una tool)
---

## Contexto
Refinamiento del borrador #2473, creado desde Bitakora.ControlAsistencia: #1214, #1221 y #1245 dejaron rojo el smoke del MCP tras el merge (alineado despues en el PR #1279 del consumidor).

## Descubrimientos
- El Stage 2b de `tdd-pipeline.sh` solo pasa al `smoke-test-writer` los `*Tool.cs` modificados; su doctrina MCP pide actualizar solo la tool call de la clase de la propia tool.
- Otras clases invocan la tool en su Arrange con `CallToolAsync("<nombre>", ...)`; el nombre es literal en la tool (`NombreTool`) y en el smoke, asi que un grep determinista los encuentra.
- El caso de #1214 (assert residual en la propia clase, ya tocada) no lo detecta un grep: solo doctrina.

## Decisiones
- Alcance solo MCP (usuario); HTTP en el borrador #2480.
- Lista determinista del pipeline -> prompt del `smoke-test-writer`; regla en su doctrina; seccion informativa en el PR.
- #2473 pasa a `estado:listo` con label `bug`.

## Descartado
- Grep en implementer/reviewer, listado del planner en "Impacto esperado" y gate bloqueante.

## Preguntas abiertas
- #2480 (endpoints HTTP) queda en borrador.

## Referencias
Refinados: #2473. Creados: #2480.
