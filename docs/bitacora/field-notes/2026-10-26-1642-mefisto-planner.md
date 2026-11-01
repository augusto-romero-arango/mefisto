---
fecha: 2026-10-26
hora: 16:42
sesion: mefisto-planner
tema: Refinar #2471 (el batch publicado lanza issues que dependen de uno que acaba de fallar)
---

## Contexto
Refinamiento del borrador #2471, creado desde Bitakora.ControlAsistencia (batch 20261025-211202): #1235 fallo y el batch lanzo y mergeo #1236 y #1237, que dependian de el.

## Descubrimientos
- `scripts/batch-pipeline.sh` solo comprueba `OPEN` y enrutamiento antes de cada eslabon; nunca lee `## Dependencias` ni `bloqueado`.
- La compuerta de `bloqueado` vive en los skills (`/implement`, `/tooling`, `/infra`) y en `iac-pipeline.sh`; el batch invoca `tdd-pipeline.sh`/`tooling-pipeline.sh` directo y la salta.
- El parser de dependencias de `iac-pipeline.sh` toma cualquier `#N` de la seccion (incluido `Bloquea`); el de `next-order.sh` es el anclado correcto.
- El motor interno `mefisto-batch-pipeline.sh` tiene el mismo hueco tras un fallo.

## Decisiones
- Saltar y seguir (usuario); cascada automatica; `--stop-on-error` sigue para frenar todo.
- El gate cubre toda dependencia declarada; `completado` en el batch cuenta como satisfecha.
- El salto no cambia el exit code; quita `bloqueado` al lanzar con deps satisfechas.
- #2471 pasa a `estado:listo`.

## Descartado
- Frenar el batch entero al primer dependiente no satisfecho.

## Preguntas abiertas
- #2478 (mismo hueco en el batch interno) queda en borrador.

## Referencias
Refinados: #2471. Creados: #2478.
