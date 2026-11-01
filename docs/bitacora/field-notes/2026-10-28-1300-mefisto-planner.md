---
fecha: 2026-10-28
hora: 13:00
sesion: mefisto-planner
tema: Refinar #2478 (el batch interno lanza issues que dependen de uno que fallo)
---

## Contexto
Refinamiento del borrador #2478, contraparte interna de #2471, capturado al refinar este ultimo.

## Descubrimientos
- `/mefisto-sequential` valida dependencias una sola vez (paso 1.5) y le quita `bloqueado` al dependiente; el loop de `mefisto-batch-pipeline.sh` no vuelve a mirar tras un fallo.
- `lib/mefisto-deps.sh` ya expone `mefisto_forward_dependencies` (regla anclada) para reutilizar.
- El mod `mefisto-divine-wager` (`issueMark`) no reconoce `saltado` y lo pintaria como pendiente.

## Decisiones
- Misma politica que #2471; el label `bloqueado` no participa (doctrina interna #466: el label es solo salida).
- Gate antes de `set_status en curso` y del snapshot.
- Texto `saltado`; la marca en el mod va como cambio directo, sin issue.
- #2478 pasa a `estado:listo`.

## Descartado
- Usar `aplazado` para el salto (dispararia el aviso de parada solicitada y el estado `stopped`).

## Preguntas abiertas
- Ajuste de `issueMark` en `mefisto-divine-wager` pendiente como cambio directo al mod.

## Referencias
Refinados: #2478.
