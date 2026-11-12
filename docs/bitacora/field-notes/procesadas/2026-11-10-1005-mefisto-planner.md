---
fecha: 2026-11-10
hora: 10:05
sesion: mefisto-planner
tema: Descartar #2524 (prompt vacio del historiador en /mefisto-bitacora)
---

## Contexto
Continuacion de la sesion 2026-11-09-2334 (su field note ya fue procesada). El usuario pidio cerrar #2524.

## Descubrimientos
- El defecto sigue en main: `src/internal/commands/mefisto-bitacora.md` lanza al historiador con `$ARGUMENTS` vacio y, sin TTY, `claude --print` rechaza el prompt vacio.

## Decisiones
- #2524 cerrado como not planned (decision del usuario): el workaround de relanzar con un prompt explicito via `-p` basta por ahora.

## Referencias
Issues cerrados: #2524
