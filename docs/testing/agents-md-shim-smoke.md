# Smoke manual: shim `CLAUDE.md` -> `AGENTS.md`

Verificacion de sesion (no automatizable con `node --test`) de que el runtime carga la doctrina canonica de `AGENTS.md` tras el shim del issue #855 (MEF-ADR-0049 CA-3). El gate automatizado (`.claude/scripts/tests/agents-md-shim.test.mts`) solo valida la forma de los archivos; este smoke valida que el runtime realmente los carga.

## Claude Code

1. Abrir el repo con Claude Code.
2. Correr `/memory` (lista los archivos de memoria cargados) o `/context`, y confirmar que `AGENTS.md` aparece importado desde `CLAUDE.md` (sintaxis `@AGENTS.md`, ver Referencias [7] en `docs/adr/mef-adr-0049-arquitectura-neutral-runtime-proveedor.md`).

## Resultado (completar en cada corrida)

| Fecha | Runtime | `AGENTS.md` cargado | `CLAUDE.md` tambien cargado | Notas |
|---|---|---|---|---|
| 2026-09-05 | Claude Code (sesion headless del pipeline de #855) | si | n/a (es el archivo que dispara el import) | El import `@AGENTS.md` resolvio: el runtime inyecto el contenido integro de `AGENTS.md` como project instructions. Falta la comprobacion interactiva con `/memory` |
| _pendiente_ | Claude Code (sesion interactiva) | | | |
