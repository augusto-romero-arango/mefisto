---
{
  "kind": "command",
  "id": "mefisto-bug",
  "description": "Investiga un error o sintoma observado al desarrollar el plugin Mefisto.",
  "profile": "fast",
  "agent": "mefisto-investigator",
  "arguments": "[descripcion del sintoma]"
}
---

Investiga un error o sintoma observado al desarrollar el plugin Mefisto. Enruta al agente `mefisto-investigator`. Comunicate en **espanol**.

**Alcance**: solo investiga problemas del propio plugin (skills publicados, internos, agentes, pipelines, hooks, ADRs). NO investiga el entorno desplegado del consumidor (eso es trabajo del `/bug` publicado con `--deployed`).

## Entrada

El sintoma esta en: $ARGUMENTS

Si `$ARGUMENTS` esta vacio, responde: `Uso: /mefisto-bug [descripcion del sintoma]` y termina.

## Proceso

### 0. Verificar que estas en el repo de Mefisto

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "ERROR: no estas en un repositorio git"; exit 1;
}
[ -f "$REPO_ROOT/.claude-plugin/plugin.json" ] || {
    echo "ERROR: este skill solo se ejecuta en el repo de Mefisto."
    echo "Si trabajas en un proyecto consumidor, usa /bug en su lugar."
    exit 1
}
```

### 1. Enrutar al agente

Lanza directamente `mefisto-investigator`:

{{mefisto:launch-agent mefisto-investigator}}

Responde con:

```
Agente mefisto-investigator lanzado.
Sintoma: $ARGUMENTS

El agente investigara skills, agentes, pipelines y configuracion del propio plugin,
y te presentara hipotesis antes de tomar accion. Todos los issues que se creen
viviran en este repo (Mefisto), nunca en un consumidor.
```

## Reglas

- **No investigues nada tu mismo.** Solo enruta al agente.
- **No modifiques codigo.** El agente tampoco lo hara: su output son hipotesis, issues y field notes.
- **No invoca a `bug-investigator`** (ese investiga el entorno desplegado del consumidor, no aplica a Mefisto).
