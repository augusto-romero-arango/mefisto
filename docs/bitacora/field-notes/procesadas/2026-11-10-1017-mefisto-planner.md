---
fecha: 2026-11-10
hora: 10:17
sesion: mefisto-planner
tema: Heuristica de comentarios "lo no obvio, en una frase" para todos los agentes que escriben o revisan codigo
---

## Contexto
El usuario trajo una heuristica de comentarios basada en Ousterhout (*A Philosophy of Software Design*), porque la doctrina de MEF-ADR-0044 no ha sido efectiva. Pidio aplicarla a los agentes de TDD, tooling, infra y onboarding.

## Descubrimientos
- Por que MEF-ADR-0044 no fue efectivo:
  - su umbral (Context Delta + Decision Delta) es abstracto y no dice que si escribir;
  - su alcance es estrecho: `.cs` completo, HCL solo al escribir;
  - el reviewer solo poda y nunca marca lo que falta;
  - el mismo bloque de doctrina esta copiado en 3 agentes;
  - tooling, infra, los scaffolders y los agentes internos no tienen ninguna doctrina de comentarios.
- Las plantillas de los scaffolders tienen unas 1 960 lineas de comentario, y unas 390 citan un issue o un ADR: son la fuente principal del ruido en el consumidor. El usuario las dejo fuera de alcance.
- Verificacion de citas: en CS190 dice "Interface comment blocks", no "Header". La cita "Feature code needs far less documentation..." no aparece en CS190 ni en aposd-vs-clean-code.
- Los Skills publicados (`skills/`) no se cargan en el repo de Mefisto. Hace falta proyectarlos a `.claude/skills/` desde el generador.

## Decisiones
- Se enmienda MEF-ADR-0044 y se omiten las referencias a notas externas de la heuristica.
- Un comentario falso siempre se corrige o se borra; ya no se "reporta sin tocar".
- Una referencia a un issue es valida si va junto a su porque.
- Las revisiones marcan hallazgos en los dos sentidos: lo que sobra y lo que falta.
- El alcance cubre el consumidor y el propio plugin (C#, HCL, bash, TypeScript y comentarios YAML), sin la prosa Markdown.
- HCL entra al modo revision; los comentarios que exigen MEF-ADR-0027/0032 quedan blindados.
- Fuente unica: el Skill `code-comments` (renombrado desde `comment-cleanup`), proyectado al lado interno con una lista explicita de ids.
- Onboarding (scaffolders) fuera de este plan.

## Descartado
- Crear un ADR nuevo, o dejar la heuristica solo en el Skill.
- Mantener la regla de "reportar sin tocar" el comentario falso.
- Una copia interna aparte del Skill, o que los agentes internos lo lean por ruta.
- Limpiar las plantillas de los scaffolders.

## Preguntas abiertas
- Si el ruido en el consumidor persiste, retomar la limpieza de las plantillas de los scaffolders.

## Referencias
Issues creados (todos en estado:listo): #2527, #2528, #2529, #2530, #2531, #2532, #2533, #2534.
Orden: /mefisto-sequential 2527 2528 2529 2530 2531 2532 2533 2534
