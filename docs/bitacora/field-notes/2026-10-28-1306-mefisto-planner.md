---
fecha: 2026-10-28
hora: 13:06
sesion: mefisto-planner
tema: Refinar #2480 (smokes que invocan un endpoint HTTP cuyo contrato cambia)
---

## Contexto
Refinamiento del borrador #2480, contraparte HTTP de #2473 (que quedo limitado a tools MCP).

## Descubrimientos
- En el consumidor Bitakora.ControlAsistencia, los endpoints HTTP de un dominio se invocan desde smokes de otros dominios y de la suite MCP (Arrange cruzados).
- 118 de 468 referencias a rutas se arman desde un identificador; 95 resuelven a una `const string` del mismo archivo.
- PoC en sandbox: plantilla de ruta -> regex (`{x}` -> segmento sin `/?:`) + expansion de constantes del archivo distingue `turnos/{id}` de `turnos/{id}:agregar-franja` (12 y 8 smokes).
- El gate del Stage 2b compila solo el proyecto SmokeTests del dominio.

## Decisiones
- Buscar en todos los `tests/*.SmokeTests` (usuario); el gate compila cada proyecto tocado.
- Coincidencia por plantilla, sin metodo HTTP; constantes solo del mismo archivo; helper en python3.
- Depende de #2473; pasa a `estado:listo` con `bug` y `bloqueado`.

## Descartado
- Coincidencia por prefijo de ruta; buscar solo en el proyecto del dominio.

## Preguntas abiertas
- Constantes de ruta declaradas en otro archivo (23 casos en el consumidor) quedan fuera.

## Referencias
Refinados: #2480.
