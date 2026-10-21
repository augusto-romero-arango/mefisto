---
fecha: 2026-10-21
hora: 12:31
sesion: mefisto-planner
tema: Causa raiz de la nightly roja (test-tdd-agents.sh y test-tooling-agents.sh)
---

## Contexto
La nightly (`ci.yml`, tracker #2439) estaba roja desde el 2026-10-14; hoy aparecio un segundo test en rojo.

## Descubrimientos
- `test-tdd-agents.sh`: #2432 anadio `{{mefisto:package-root}}` a `domain-scaffolder`, que paso a emitir ambos preambulos; el test lo seguia tratando como "solo contrato efectivo". El writer de #2463 lo vio y lo anoto como "previo y ajeno" sin capturarlo.
- `test-tooling-agents.sh`: #2463 cambio el preambulo Claude y regenero `dist/`, pero no los snapshots `fixtures/tooling-agents/expected-claude-tooling-*.md`.
- Ningun PR corre estos tests (`ci.yml` solo en schedule), asi que las regresiones de expectativas solo afloran en la nightly.
- Los `awk: write error on /dev/stdout` del log son ruido de SIGPIPE, no fallos.

## Decisiones
- Un solo issue para ambos fallos (#2465), lado publicado, solo tests y fixtures; pasado a `estado:listo` con confirmacion.
- Prueba de concepto en sandbox: 208/0 y 221/0 tras los dos cambios.

## Descartado
- Partir en dos issues.
- Issue aparte para cubrir el gap de CI en PRs (no se pidio en esta sesion).

## Preguntas abiertas
- Si conviene que el pipeline de tooling corra los tests afectados antes de mergear para no depender de la nightly.

## Referencias
Issues creados: #2465. Relacionados: #2439, #2432, #2463.
