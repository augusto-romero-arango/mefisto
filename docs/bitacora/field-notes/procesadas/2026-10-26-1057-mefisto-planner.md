---
fecha: 2026-10-26
hora: 10:57
sesion: mefisto-planner
tema: Refinar #2469 (smoke de dominio vs. revision nueva del worker de proyecciones)
---

## Contexto
Refinamiento del borrador #2469, creado desde Bitakora.ControlAsistencia (issue #1157, PR #1167): los tests read-side del smoke de dominio corren contra la revision vieja del worker.

## Descubrimientos
- El `publish` de `deploy-projections.yml` solo comprueba que la imagen dejo el placeholder, y lo lee del template del Container App, que devuelve lo que acaba de escribir `az containerapp update`. No mira la revision.
- En modo Single, Azure mantiene activa la revision vieja hasta que la nueva esta lista (Microsoft Learn, Revisions). El criterio documentado es `latestReadyRevisionName == latestRevisionName` mas la imagen de esa revision.
- MEF-ADR-0031 seccion 4 ("el worker no tiene nada que esperar") y seccion 5 ("sin poll ni timeout") quedan refutadas.
- En un deploy disparado por `workflow_run`, `github.sha` no es el commit desplegado: la espera nueva usa `expected_sha` con fallback.

## Decisiones
- Partir en dos: #2474 (`publish` espera la revision lista, MEF-ADR-0031 seccion 5) bloquea #2469 (el smoke de dominio espera el job `publish`, seccion 4 y bloque `[H]`).
- Si el worker falla o se cancela: `::warning::` y el smoke continua, alineado con el consumidor.
- El job conserva el nombre `publish`. MEF-ADR-0034 seccion 8 queda sin enmienda.
- Ambos issues pasan a `estado:listo` (#2469 ademas con el label `bloqueado`).

## Descartado
- Un solo issue con dos agentes.
- Comprobar `properties.active` en una lectura unica, como hace el consumidor.
- Fallar el smoke cuando falla el worker.

## Preguntas abiertas
- Que el daemon haya terminado de reconstruir los read models tras arrancar sigue fuera del gate.

## Referencias
Issues creados: #2474. Refinados: #2469. Relacionados: #2468.
