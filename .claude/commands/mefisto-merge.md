---
description: "Mergea uno o varios PRs del repo de Mefisto."
model: "haiku"
argument-hint: "<numero-de-PR> [<numero-de-PR> ...] | --all"
---
<!-- GENERADO por src/internal/scripts/generate-internal-adapters.mts desde src/internal/commands/mefisto-merge.md. No editar a mano. -->

Mergea uno o varios PRs del repo de Mefisto. Comunicate en **espanol**.

**Alcance**: solo opera sobre PRs del repo de Mefisto. Para PRs del consumidor, usa `/merge` publicado.

## Entrada

Los argumentos estan en: $ARGUMENTS

Formas validas:
- `<numero-de-PR>` -- un solo PR
- `<numero-de-PR> <numero-de-PR> ...` -- varios PRs
- `--all` -- todos los PRs abiertos del repo de Mefisto

Si `$ARGUMENTS` esta vacio:
```
Uso: /mefisto-merge <numero-de-PR> [<numero-de-PR> ...] | --all
```

## Proceso

### 0. Verificar que estas en el repo de Mefisto

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "ERROR: no estas en un repositorio git"; exit 1;
}
[ -f "$REPO_ROOT/.claude-plugin/plugin.json" ] || {
    echo "ERROR: este skill solo se ejecuta en el repo de Mefisto."
    echo "Si trabajas en un proyecto consumidor, usa /merge en su lugar."
    exit 1
}
```

### 1. Validar PRs

Para cada numero:

```bash
gh pr view <num> --json number,title,state,headRefName,mergeable,statusCheckRollup
```

- Si el PR no existe o esta `CLOSED`/`MERGED`: descartalo.
- Conserva el `headRefName` de cada PR valido: el paso 3 lo usa para borrar sus ramas sin volver a consultar `gh`.
- Si todos los PRs fueron descartados: muestra el motivo y detente.

### 2. Mostrar resumen

```
Se mergearan en este repo (Mefisto):
  #12 [MERGEABLE, checks SUCCESS] Anadir guard defensivo a /implement
  #13 [MERGEABLE, checks PENDING] Refactorizar tooling-pipeline.mts
```

No pidas confirmacion adicional. El usuario ya la dio al escribir `/mefisto-merge` explicitamente.

### 3. Mergear

En Mefisto no usamos `scripts/pr-sync.mts` (es del lado publicado y depende de configuracion del consumidor). Aqui mergeamos con `gh pr merge` directo, con squash (consistente con la mayoria de PRs del repo) y borrado explicito de ramas (sin la opcion de borrado de rama de `gh`: esta borra primero la rama local y, si un worktree la tiene checkouteada, corta con error dejando viva la remota).

```bash
for pr in <prs>; do
    echo "Mergeando #$pr..."
    head="<headRefName de #$pr, tomado del paso 1>"
    gh pr merge "$pr" --squash || {
        echo "Fallo al mergear #$pr"
        continue
    }

    resultado="MERGED"
    git push origin --delete "$head" \
        || echo "ADVERTENCIA: no se pudo borrar la rama remota $head de #$pr (el merge quedo MERGED)."
    if git show-ref --verify --quiet "refs/heads/$head"; then
        if git worktree list --porcelain | grep -qxF "branch refs/heads/$head"; then
            echo "Rama local $head en uso por un worktree: se conserva; mefisto-worktree.mts clean la limpiara."
        else
            git branch -D "$head" || echo "ADVERTENCIA: no se pudo borrar la rama local $head."
        fi
    fi
    if ! MEFISTO_RUNTIME=claude node src/internal/scripts/mefisto-validate-batch-deps.mts --reconcile-pr "$pr"; then
        echo "ADVERTENCIA: #$pr se mergeo, pero fallo la reconciliacion post-merge de bloqueados."
        resultado="MERGED (POST-MERGE DEGRADADO)"
    fi
done
```

El borrado de ramas nunca degrada el resultado: un fallo de `git push origin --delete`
o de `git branch -D` solo imprime una advertencia y el PR sigue `MERGED`. La rama local
se borra unicamente si ningun worktree la tiene checkouteada.

La invocacion del reconciliador queda dentro de la rama exitosa de cada vuelta:
un PR inexistente, cerrado, ya mergeado, conflictivo o cuyo merge falle no la
ejecuta. Conserva `MERGED` como resultado del merge aun cuando la reconciliacion
falle; usa `MERGED (POST-MERGE DEGRADADO)` en la tabla para senalar ese warning
sin atribuirlo falsamente a `gh pr merge`. La salida del reconciliador se muestra
sin reinterpretarla: informa los issues a los que quito `bloqueado` o que no hubo
cambios. No reimplementes aqui el parsing de `Closes`, `## Dependencias` ni los
estados de GitHub.

Si `--all` fue especificado, primero lista todos los PRs abiertos:

```bash
gh pr list --state open --json number -q '.[].number'
```

Y aplica el loop sobre ellos.

### 4. Reportar resultado

Imprime una tabla final:

```
PR | Titulo                              | Resultado
#12| Anadir guard defensivo a /implement | MERGED
#13| Refactorizar tooling-pipeline.mts    | FALLO (checks PENDING)
#14| Reconciliar bloqueos internos        | MERGED (POST-MERGE DEGRADADO)
```

## Reglas

- **No uses `scripts/pr-sync.mts`**: ese script requiere la configuracion del harness del consumidor (`harness.config.json`, no existe en Mefisto) y esta pensado para el consumidor.
- **No auto-reintentes** un PR fallido. Si el merge falla, reporta el error y espera instruccion.
- **Verifica que el PR esta MERGEABLE** antes de intentar; si esta `CONFLICTING`, indicalo y omite.
- **Squash por defecto**: el historial de Mefisto se mantiene limpio con squash + borrado explicito de la rama remota (la local solo si ningun worktree la usa).
- **Reconciliacion aislada**: tras cada merge exitoso ejecuta una sola vez el reconciliador interno con `--reconcile-pr`; si falla, advierte y continua con el siguiente PR.
