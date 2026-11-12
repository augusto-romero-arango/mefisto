---
description: "Lanza el agente `mefisto-planner` para planear, refinar o reorganizar issues del propio repo de Mefisto."
model: "haiku"
---
<!-- GENERADO por src/internal/scripts/generate-internal-adapters.mts desde src/internal/commands/mefisto-plan.md. No editar a mano. -->

Lanza el agente `mefisto-planner` para planear, refinar o reorganizar issues del propio repo de Mefisto. Comunicate en **espanol**.

**Alcance**: solo opera sobre issues del repo de Mefisto. Para planear issues de un proyecto consumidor, usa el skill `/planner` publicado desde el repo del consumidor.

## Proceso

### 0. Verificar que estas en el repo de Mefisto

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "ERROR: no estas en un repositorio git"; exit 1;
}
[ -f "$REPO_ROOT/.claude-plugin/plugin.json" ] || {
    echo "ERROR: este skill solo se ejecuta en el repo de Mefisto."
    echo "Si trabajas en un proyecto consumidor, usa /planner en su lugar."
    exit 1
}
```

### 1. Lanzar el agente

Invoca al agente `mefisto-planner` con el contexto disponible (si `$ARGUMENTS` trae texto, pasalo como mensaje inicial; si no, deja que el agente pregunte el modo).

```bash
claude --agent mefisto-planner "$ARGUMENTS"
```

## Reglas

- **No planees nada tu mismo.** Lanza al agente y observa.
- **No uses `gh -R`**. Los issues del repo de Mefisto se crean siempre en el repo activo. El routing cross-repo solo aplica al planner publicado desde el consumidor.
- **No interpretes labels del consumidor**: en Mefisto no hay `dom:`, no hay `tipo:feature` ni `tipo:infra` (solo `tipo:tooling`).
