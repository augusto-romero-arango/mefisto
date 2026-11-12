---
description: "Orquesta la bitacora del propio plugin Mefisto: invoca al agente `mefisto-historiador` y, si termina con un PR creado, lo verifica y sugiere `/mefisto-merge` o `gh pr close` sin mergearlo."
model: "haiku"
argument-hint: "[YYYY-MM-DD]"
---
<!-- GENERADO por src/internal/scripts/generate-internal-adapters.mts desde src/internal/commands/mefisto-bitacora.md. No editar a mano. -->

Orquesta la bitacora del propio plugin Mefisto: invoca al agente `mefisto-historiador` (issue #529) para procesar de forma autonoma las field notes pendientes, verifica el PR que reporta y se detiene sugiriendo el siguiente paso; la decision de mergearlo o cerrarlo es del usuario. Comunicate en **espanol**.

**Alcance**: solo opera sobre la bitacora del propio plugin Mefisto. Para la bitacora de un proyecto consumidor, usa `/bitacora` publicado.

## Pre-condicion: estas en el repo de Mefisto

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "ERROR: no estas en un repositorio git"; exit 1;
}
[ -f "$REPO_ROOT/.claude-plugin/plugin.json" ] || {
    echo "ERROR: este skill solo se ejecuta en el repo de Mefisto."
    echo "Si trabajas en un proyecto consumidor, usa /bitacora en su lugar."
    exit 1
}
```

Si el bloque imprime `ERROR`, detente y muestra el mensaje al usuario.

## Entrada

Los argumentos estan en: $ARGUMENTS

`/mefisto-bitacora` **no requiere argumentos**: el historiador descubre solo las field notes pendientes en `docs/bitacora/field-notes/` y por defecto procesa todo el backlog. La unica forma valida de argumento es una fecha `YYYY-MM-DD`, que se propaga al historiador como su *filtro opcional por dia* (ver su propia doctrina, seccion "Filtro opcional por dia") para reprocesar unicamente ese dia sin tocar el resto del backlog. Si `$ARGUMENTS` trae cualquier otra cosa, ignoralo y corre el backlog completo.

## Proceso

### 1. Invocar al agente `mefisto-historiador` (CA-2)

```bash
claude --agent mefisto-historiador "$ARGUMENTS"
```

El agente interpreta `$ARGUMENTS` tal cual lo describe su propia doctrina: vacio procesa todo el backlog pendiente, una fecha `YYYY-MM-DD` acota el procesamiento a ese dia unicamente. Corre de forma autonoma de punta a punta: recopila el backlog, escribe (o extiende) una entrada por cada dia pendiente, mueve todas las field notes del backlog a `procesadas/` y ejecuta el cierre atomico (rama + entradas + PR), todo sin pausas ni confirmaciones intermedias. La invocacion corre en **primer plano** -- espera a que la sesion del agente termine, nunca lo lances en segundo plano --: el paso 2 necesita el numero de PR que el historiador reporta en su mensaje final.

### 2. Extraer y verificar el numero de PR (CA-2, CA-4)

El contrato del historiador (su propia seccion "Al terminar") es reportar explicitamente el PR en su mensaje final con el patron `PR #<numero>` (ej: "PR #123 creado con las entradas del 2026-07-27 al 2026-08-04."). Toma el numero de su **mensaje final**, no de cualquier `#N` que aparezca en el medio de la conversacion: el historiador cita issues y PRs ajenos al armar cada entrada, y confundirlos aca sugeriria el PR equivocado.

- **Si NO aparece ningun PR** -- el historiador reporto que no habia field notes pendientes, o fallo en algun punto antes de crear el PR -- reporta el resultado tal cual lo dijo el historiador y **detente**.
- **Si aparece un numero**, confirmalo (el numero no lo tipeo el usuario: lo leiste de una conversacion):

  ```bash
  gh pr view <num> --json number,state,headRefName,files
  ```

  Verifica que el PR este `OPEN` y que sus archivos caigan bajo `docs/bitacora/` (las entradas nuevas y/o los movimientos a `procesadas/`). Si el PR no existe, ya esta `MERGED`/`CLOSED`, o no toca la bitacora, reporta el numero que leiste, lo que devolvio `gh pr view`, y detente para que el usuario decida.

- Con el numero verificado, continua al paso 3.

### 3. Reportar y sugerir

Consolida en un solo resumen y termina, sin preguntar nada:
- Lo que reporto el historiador (dias procesados, field notes integradas, o el motivo de no haber creado PR).
- El PR verificado (`PR #N`) y la sugerencia: `/mefisto-merge <N>` para integrarlo o `gh pr close <N>` para descartarlo. Sin PR o con verificacion fallida, el motivo y nada mas.

## Reglas

- **Nunca reimplementes la logica del historiador.** Corre de punta a punta de forma autonoma.
- **Nunca mergees el PR: la decision es del usuario.** Ni `gh pr merge` ni `git merge` + push.
- **No sugieras un PR que no hayas leido del mensaje final del historiador y verificado con `gh pr view`** (abierto y tocando `docs/bitacora/`).
- **No invoca a `historiador`** (ese opera sobre proyectos consumidores, no aplica a Mefisto).
