# Protocolo de certificacion IaC (`/mefisto:infra`)

Este protocolo define, sin ejecutarla, la certificacion reproducible del
pipeline `/mefisto:infra` (`scripts/iac-pipeline.sh`, lanzado por
`scripts/launch-pipeline.sh --infra`) sobre el runtime `claude` y sobre los dos
contextos de lanzamiento que el propio script distingue: en un pane de un
workspace Herdr (`herdr-workspace.sh`) y desacoplado, sin pane. Molde: "Resultado write-side (#1435)" y
[`tdd-consumer-certification.md`](./tdd-consumer-certification.md). Este
documento fija su instalacion e identidad como prerrequisito y agrega la
superficie propia de `/mefisto:infra` -- dos agentes (`infra-writer`,
`infra-reviewer`), cero credenciales de Azure, PR sin `Closes` y los dos
contextos de lanzamiento.

Las secciones de protocolo satisfacen el CA-1 de #1629. Los CA-2 a CA-5 exigen
una sesion operada en vivo con acceso a Herdr y a un consumidor sintetico -- el mismo tipo de operacion que
`tdd-consumer-certification.md` documenta como fuera de alcance de un stage de
escritura no interactivo ("Bloqueo estructural de la ejecucion automatizada
(#1464)"). Esa sesion y su veredicto quedan en "Estado de la certificacion".

## Invariantes y prerrequisitos (CA-1: preflight)

- **Identidad**: una unica release candidata instalada, verificada como exige
  "Invariantes y prerrequisitos (CA-1)" de `tdd-consumer-certification.md`: el
  `mefisto-manifest.json` de la raiz cargada declara `runtime=claude`,
  `<version>` y `<commit-fuente>`, y `pipeline-status-infra-<N>.json` y
  `pipeline-history.jsonl` registran esa `identity` con
  `identity_state: complete`. Una identidad incompleta, o distinta entre las
  dos corridas, bloquea el protocolo antes de crear ningun fixture.
- **Instalacion publicada exclusivamente**: prohibido instalar o referenciar
  Mefisto desde un checkout, un worktree, un enlace simbolico o una ruta
  absoluta del repositorio de Mefisto; la unica instalacion valida es la del
  marketplace.
- **Consumidor sintetico**: a diferencia del consumidor completo que exige
  `tdd-consumer-certification.md` (dominio scaffoldeado con Function App y
  proyecto SmokeTests), `/mefisto:infra` solo necesita:
  - `infra/modules/` con al menos un modulo base ya generado (por ejemplo por
    `/mefisto:infra-base`, MEF-ADR-0021) para que `infra-writer` tenga algo
    real que modificar y `infra-reviewer` tenga algo real que revisar;
  - `terraform` instalado en el `PATH` de cada pane de ejecucion, version
    registrada en el manifiesto de evidencia;
  - **sin** backend remoto configurado ni sesion `az login`: `infra-reviewer`
    corre `terraform init -backend=false` (MEF-ADR-0021, MEF-ADR-0022), asi que
    el consumidor sintetico no necesita una Storage Account de tfstate real ni
    ningun permiso de Azure.
  Puede ser el mismo consumidor persistente de #1435/#1436
  (`augusto-romero-arango/mefisto-consumer-certification`) si ya tiene
  `infra/modules/` provisionado, o un consumidor sintetico dedicado mas
  liviano; cualquiera de los dos vale mientras cumpla los tres puntos
  anteriores y se registre como `<consumidor-certificable>`.
- **`tipo:infra` fuera de lotes**: la matriz de este protocolo no incluye
  `/mefisto:batch-stop`, `/mefisto:sequential` ni `/mefisto:parallel`
  (`SKIP:infra` en ambos orquestadores de cola); las dos corridas se lanzan
  siempre como invocacion directa de `/mefisto:infra`.
- Registra antes de crear ningun fixture: `<tag-certificable>`, `<version>`,
  `<commit-fuente>`, `<consumidor-certificable>`,
  `<sha-baseline-inicial>`/`<sha-baseline-final>`, version de `terraform` y
  version de `claude`.

## Fixture minimo `tipo:infra` (CA-1: fixture)

Se crea **un issue fixture por corrida** (dos en total), ambos desde el
planner **publicado** del consumidor (nunca desde el planner interno de
Mefisto ni con `gh -R`, MEF-ADR-0019), ambos con `estado:listo` explicito y
DoR de la columna `infra` de MEF-ADR-0011: `## Contexto`, `## Dependencias`
(`Ninguna`), `## Criterios de aceptacion` (**Critico**), `## Ambiente`
(**Obligatorio**) y `## Impacto en archivos` (**Obligatorio**). `dom:X` es
opcional en `infra` y `## ADRs aplicables` es solo Recomendado -- ni
`infra-writer` ni `infra-reviewer` lo consumen en su paso 1b, a diferencia de
`implementer`/`reviewer` -- pero el planner publicado la agrega igual por
buena practica; su ausencia no bloquea el lanzamiento en esta ruta.

### Eleccion del cambio certificable

Antes de redactar los dos fixtures se registra `<modulo-certificable>`: un
modulo ya existente bajo `infra/modules/` de `<consumidor-certificable>` (por
ejemplo `monitoring` o `service-plan`). El cambio que describe el fixture es
**deterministico y acotado** -- agregar o modificar un `tag`/etiqueta fija, o
un valor de variable con default explicito -- para que `terraform fmt`,
`terraform init -backend=false` y `terraform validate` tengan una unica forma
correcta de pasar, sin ambiguedad de diseño que dependa del modelo. El fixture
**no** crea un modulo nuevo ni toca `infra/environments/<env>/backend.tf`: eso
mantiene fuera de alcance el bootstrap del backend (`bootstrap-backend.sh`),
que este protocolo no certifica.

### Template de fixture (Herdr/desacoplado)

Las dos corridas usan la misma forma; solo el contexto de lanzamiento y
`<run-id>` (formato `YYYYMMDD-HHMMSS-<tag-certificable>`, mismo que
`tdd-consumer-certification.md`) cambian.

````markdown
# Certificar IaC bajo <runtime> x <contexto-lanzamiento> (<run-id>)

## Contexto

Certificar `/mefisto:infra` sobre la release `<tag-certificable>`
(`<version>`, commit fuente `<commit-fuente>`) desde una instalacion
publicada real en este consumidor, lanzada desde <contexto-lanzamiento>
(Herdr o desacoplado).

## Ambiente

`dev`. El fixture no ejecuta `terraform plan` ni `terraform apply` en ningun
punto del pipeline local (MEF-ADR-0021, MEF-ADR-0022): solo revision estatica
sin credenciales de Azure.

## Criterios de aceptacion

- CA-1: el modulo `<modulo-certificable>` en `infra/modules/<modulo-certificable>/`
  agrega el tag/valor determinista descrito, sin cambiar ninguna interfaz
  (variables de entrada, outputs) del modulo.
- CA-2: `terraform fmt -check` no reporta diferencias sobre el modulo
  modificado.
- CA-3: `terraform init -backend=false` y `terraform validate` pasan sobre
  `infra/environments/dev/` con el modulo modificado.
- CA-4: el diff no toca `infra/environments/dev/backend.tf` ni ningun otro
  modulo distinto de `<modulo-certificable>`.

## Impacto en archivos

- Modifica: `infra/modules/<modulo-certificable>/main.tf` (o el archivo HCL
  equivalente donde vive el tag/valor).
- No crea modulos nuevos ni toca `infra/environments/<env>/backend.tf`.

## Dependencias

- Ninguna.
````

## Matriz de corridas (CA-1: matriz)

| Corrida | Contexto de lanzamiento | Invocacion |
|---|---|---|
| A | Herdr | `/mefisto:infra <issue-A>` desde el pane `ejecucion [claude]` de un workspace Herdr (`herdr-workspace.sh`), con `MEFISTO_UI=herdr` en el entorno |
| B | Desacoplado | `/mefisto:infra <issue-B>` (o `scripts/launch-pipeline.sh --infra <issue-B>` directo) sin `MEFISTO_UI`; la sigue la consola `fausto-blood-pact` o, sin ella, `scripts/stream-watch.sh --issues <issue-B>` en otra terminal |

Las dos corridas parten del mismo `<sha-baseline-inicial>` del consumidor y
son independientes entre si: ninguna depende de que el PR fixture de la otra
se fusione (los dos PRs se cierran sin merge, seccion "Fail-closed y limpieza"
mas abajo). Con `MEFISTO_UI=herdr`, `scripts/launch-pipeline.sh` delega en la
interfaz Herdr para A; sin `MEFISTO_UI`, para B, corre el pipeline desacoplado
(MEF-ADR-0055) e imprime la ruta del log y la linea del visor, tal como
documenta `commands/infra.md`.

## Resultados esperados de cada corrida (CA-2 de #1629)

En las dos corridas, `/mefisto:infra` debe:

1. **Lanzar `iac-pipeline.sh` en el runtime correcto**: antes de la cabecera
   `=== IAC STAGE <n>: <agente> ===`, `events.log` contiene una linea
   `MODELS:` por agente (`infra-writer` e `infra-reviewer`) con
   `runtime=<runtime-resuelto>`, `perfil=` (`balanced` para `infra-writer`,
   `deep` para `infra-reviewer`) y `resuelto=` con el modelo efectivo,
   conforme la escribe `resolve_infra_model` en `scripts/iac-pipeline.sh`. El
   `runtime=` debe ser `claude`. Ninguna de las dos
   corridas fija `--models` ni un modelo explicito: la seleccion automatica
   por perfil neutral es parte de lo que se certifica.
2. **Completar Stage 1 (`infra-writer`) y Stage 2 (`infra-reviewer`) con
   summaries**: `pipeline-status-infra-<N>.json` registra
   `agents.infra-writer.result` y `agents.infra-reviewer.result` en `passed`,
   y el PR final incluye el summary de cada stage en `<details>` (mismo patron
   que `iac-pipeline.sh` lineas 694-722).
3. **Abrir un PR real limitado a `infra/`, sin `Closes #N`**: el pipeline
   IaC nunca agrega `Closes` al body del PR (MEF-ADR-0021, MEF-ADR-0022): el
   cierre del issue lo hace el workflow `infra-cd.yml` tras un `apply` exitoso
   en CI, no este pipeline local. El diff del PR se limita exactamente al
   archivo declarado en `## Impacto en archivos` del fixture.
4. **Publicar o justificar el job `plan` de CI**: si el consumidor tiene
   `infra-cd.yml` con el job `plan` sobre `pull_request` filtrado a
   `infra/**`, su conclusion (o el comentario que publica en el PR) queda
   registrada. Si el consumidor sintetico no tiene ese workflow configurado
   (por ejemplo, un consumidor sin bootstrap de CI todavia), se registra
   `NO_APLICA` con el motivo explicito -- mismo criterio que usa
   `tdd-consumer-certification.md` para sus checks `NO_APLICAN`. Cualquiera de
   las dos formas es aceptable; la ausencia silenciosa de ambas no lo es.

## Evidencia correlacionada (CA-3 de #1629)

Cada una de las dos corridas debe dejar, bajo `.mefisto/pipeline/` del
consumidor (nunca bajo `.claude/pipeline/`, que queda solo como fallback de
lectura de `work-status-collect.sh` desde #1626):

- `logs/iac-stage-<N>-<agente>-<ts>-issue-<issue>.log` por stage (Stage 1
  `infra-writer`, Stage 2 `infra-reviewer`).
- Los streams neutrales por stage e intento
  (`logs/iac-stage-<N>-<agente>-<ts>-issue-<issue>-attempt-<k>.events.jsonl`;
  mas de un intento solo aparece si hubo hold o reanudacion), redactados conforme al
  catalogo de centinelas de la seccion "Centinelas y limpieza" mas abajo.
- `events.log` con la linea `MODELS:` de cada stage y los eventos de
  transicion de stage.
- `pipeline-status-infra-<issue>.json` con `identity` (version/commit/estado
  de la distribucion), `runtime` y, si hubo hold, el objeto `hold`. El
  pipeline lo borra al completar, asi que se captura mientras la corrida esta
  en curso (o en hold); tras el cierre, la fuente es `pipeline-history.jsonl`.
- `pipeline-history.jsonl` con una entrada por corrida, `runtime` e
  `identity`.

La correlacion se verifica cruzando issue, PR, stage y session id (hash) entre
estos cinco artefactos y el PR real de GitHub. Cualquier corrida cuya
evidencia aparezca bajo `.claude/pipeline/` en vez de `.mefisto/pipeline/` es
una divergencia de MEF-ADR-0053 seccion 4, no solo del protocolo, y produce
`NO PASA` para esa corrida.

## Visibilidad en la salida de `work-status-collect.sh --json` (CA-4 de #1629)

- **En curso**: mientras cualquiera de las dos corridas esta `running`,
  `scripts/work-status-collect.sh --json`
  devuelve una fila con `pipeline=infra`, el `issue`, el `runtime` y el
  `stage` vigente (`1-infra-writer` o `2-infra-reviewer`), con el
  `progress_pct` que asigna `scripts/work-status-collect.sh` (30 para
  `infra-writer`, 80 para `infra-reviewer`) y `activity.kind = stage`.
- **Terminada**: al completar, la fila pasa a reflejar el PR (`pr` no vacio) y
  dejar de aparecer como `running`, conforme al historial en
  `pipeline-history.jsonl`.
- **Hold inducido**: se induce un hold sobre **al menos una** de las dos
  corridas fijando `MEFISTO_HOLD_PROBE_SECONDS` a un valor corto y usando un
  runner de agente con `rate_limit` simulado (mismo mecanismo que
  `.claude/scripts/tests/mefisto-tooling-pipeline-agent.test.mts`/`scripts/tests/pr-sync-run-agent.test.mts`
  stubean para el resto de pipelines), o aprovechando un limite real de uso
  del proveedor si ocurre durante la ventana de la corrida. Mientras el hold
  esta activo, la fila del colector debe traer `state: hold` /
  `activity.kind = hold` en lugar de `stage`, con
  la causa (`activity.cause`) y la proxima sonda (`activity.next_probe`)
  visibles -- MEF-ADR-0051 (mecanismo) y MEF-ADR-0053
  seccion 4 (raiz de estado unica) convergen aqui con MEF-ADR-0031: la
  visibilidad del hold es evidencia ejecutable, no un campo que se asuma
  presente porque el JSON lo declara.

## Centinelas y limpieza (CA-5 de #1629)

El catalogo de centinelas, case-insensitive salvo donde el patron explicite
caracteres, se aplica sobre los cinco artefactos de "Evidencia correlacionada"
y sobre cualquier manifiesto propio de esta corrida:

```text
("|')?(prompt|system[ _-]?prompt|question|confirmation|approval|raw|stderr|message|tool[ _-]?input)("|')?[[:space:]]*[:=]
(authorization|cookie|set-cookie|x-api-key)[[:space:]]*:
auth\.json|credentials|((api[_-]?key|access[_-]?token|refresh[_-]?token)[[:space:]]*[:=])
Bearer[[:space:]]+[A-Za-z0-9._~+/-]+=*|sk-[A-Za-z0-9]{16,}
```

Cero coincidencias en las dos corridas es el minimo para continuar; una
coincidencia exige redaccion local antes de persistir evidencia. Por cada
artefacto inspeccionado se registra su ruta relativa, SHA-256, patron, conteo
y veredicto, nunca la linea coincidente. Tras capturarla (haya `PASA` o
`NO PASA`):

1. Cierra los **dos PRs sin merge** y elimina sus ramas remotas -- **nunca
   se mergean**: un merge dispararia el `apply` real de CI sobre un fixture
   sintetico (MEF-ADR-0022).
2. Cierra los **dos issues fixture** como `not planned` desde el
   consumidor, con un comentario que enlace la certificacion.
3. Retira los dos worktrees de las corridas y comprueba que no queda
   ninguno.
4. Restaura el baseline y comprueba que `<sha-baseline-final>` coincide
   exactamente con `<sha-baseline-inicial>` y que el arbol queda limpio.
5. Restaura la instalacion previa si alguna corrida cambio la release activa,
   conservando en el manifiesto la version previa.

La limpieza es idempotente, igual que en `tdd-consumer-certification.md`.

## Escala de veredicto y fail-closed

- **`PASA`**: las dos corridas cumplen integramente "Resultados esperados
  de cada corrida", "Evidencia correlacionada" y "Visibilidad en la salida
  de `work-status-collect.sh --json`" (incluido el hold inducido en al menos una corrida), con
  centinelas en cero y limpieza completa.
- **`NO PASA`**: cualquier gap -- stage sin summary, PR con `Closes`,
  evidencia bajo `.claude/pipeline/`, hold no visible, centinela positivo sin
  redaccion posible, o una diferencia entre las dos corridas no atribuible al
  contexto de lanzamiento -- produce `NO PASA` para el protocolo
  completo. Cada gap abre un issue `tipo:bug` dependiente antes de repetir la
  matriz, con la evidencia sanitizada de la corrida afectada enlazada.
- Un recurso inaccesible (issue, PR, check, log o sesion no consultable) se
  marca `BLOQUEADO`, nunca se completa por inferencia (MEF-ADR-0031).

## Estado de la certificacion

**PASA (2026-09-30), release `v0.40.1`.** Las dos celdas de la matriz (A y
B-bis del intento 2) cumplen CA-2 a CA-5, con `identity` `0.40.1` en el historial,
centinelas en cero y baseline restaurado. `/mefisto:infra` queda certificado
bajo Claude Code, lanzado desde Herdr y fuera de Herdr, en el alcance
que fija este protocolo: invocacion directa, sin `--models` ni modelo
explicito, fixture de modificacion acotada de un modulo existente.

En `v0.40.x` el lanzador abria, fuera de Herdr, una sesion de un multiplexor
de terminal en vez de correr desacoplado: la celda B de los dos intentos
corrio en esa sesion. La celda B de la matriz vigente (desacoplado) no tiene
corrida registrada.

El intento 1 (`v0.40.0`) dio `NO PASA` por el gap de CA-4 que resolvio
[#1730](https://github.com/augusto-romero-arango/eda-evsourcing-azure-harness/issues/1730).
En el intento 2 la celda B se repitio como B-bis sobre un servidor de sesiones
limpio, por el motivo que explica "Repeticion de la celda B (#1740)".

### Intento 2 (2026-09-30, run-id `20260930-074511-v0.40.1`)

| Campo | Valor verificado |
|---|---|
| Release e identidad | `v0.40.1` (publicada 2026-09-30T12:19:52Z), version `0.40.1`, commit fuente `eba9773ad106b4e86400b2690340cfd3e8380c45`; historial con `identity` `0.40.1` en las corridas. Incluye #1730, #1731 y #1734. |
| Instalacion | `claude plugin update` (scopes user y project) `0.40.0 -> 0.40.1`. Rollback: `0.40.0` / `d876b9af`. |
| Consumidor, herramientas y fixture | Iguales al intento 1: mismo consumidor, `terraform` 1.14.4, Claude Code 2.1.285; mismo `<modulo-certificable>` (`monitoring`) y mismo cambio. |
| Baseline | `<sha-baseline-inicial>` = `<sha-baseline-final>` = `feb5103dc9b8ce118bddc76cd6b9c63481573abf`, arbol limpio antes y despues. |

| Dimension | A: Herdr | B-bis: fuera de Herdr |
|---|---|---|
| Issue fixture | [#70](https://github.com/augusto-romero-arango/mefisto-consumer-certification/issues/70) | [#78](https://github.com/augusto-romero-arango/mefisto-consumer-certification/issues/78) |
| Lanzamiento | pane Herdr `w9:pE` | sesion `infra-78`, servidor de sesiones creado por esta corrida |
| `MODELS:` writer / reviewer | `claude` balanced `sonnet` / deep `opus` | idem A |
| Stage 1 / Stage 2 | `passed` 22 s / `passed` 30 s | `passed` 22 s (hold aparte) / `passed` 26 s |
| PR (sin `Closes`) | [#74](https://github.com/augusto-romero-arango/mefisto-consumer-certification/pull/74) | [#79](https://github.com/augusto-romero-arango/mefisto-consumer-certification/pull/79) |
| Diff y summaries | solo `infra/modules/monitoring/main.tf`, una linea identica; `<details>` de writer y reviewer | idem |
| Job `plan` de CI | `SUCCESS`; `apply` `SKIPPED` | `SUCCESS` |
| Session id (hash sha256, 12) writer / reviewer | `086de7d1cea0` / `e9c766bcdf62` | intento 1 sin sesion (`rate_limit`), intento 2 `911bdf4b4850` / `3a9f58c04692` |
| Evidencia bajo `.mefisto/pipeline/` | log por stage + stream por intento, `events.log`, historial | idem, mas `attempt-2` del writer |

- **CA-4 hold**: en B-bis, con el mismo wrapper de `rate_limit` y
  `MEFISTO_HOLD_PROBE_SECONDS=90` del intento 1, el status paso a
  `state: hold`, `RATE_LIMIT`, `next_probe`, y `/work-status` mostro
  `EN ESPERA` con causa y proxima sonda. El hold tambien se indujo y se vio
  sobre la B original (#71).
- **CA-4 terminada**: las filas infra muestran `env:dev, PR #N` y `log`
  resuelto a `iac-pipeline-<started>.log`. El gap del intento 1 queda cerrado.
- **`events.log`**: todas las lineas, incluidas `[tool]`/`[stage]`, usan hora
  local. Se cierra el hallazgo #1731 del intento 1.
- **Ruta legacy**: igual que en el intento 1, solo se refresco el marker
  `.claude/pipeline/.plugin-root`, sin evidencia.
- **Centinelas**: 0 coincidencias en los cuatro patrones sobre los logs de las
  corridas A, B y B-bis, `events.log`, `pipeline-history.jsonl` y el expediente
  `.mefisto/pipeline/certification/infra-v0.40.1/`.
- **Limpieza**: PRs #74, #77 y #79 cerrados sin merge, con sus ramas remotas
  eliminadas; fixtures #70, #71 y #78 cerrados `not planned`; sin worktrees ni
  sesiones abiertas.
- **Desviaciones**: las mismas del intento 1 (fixtures con `gh issue create`
  desde el consumidor, invocacion no interactiva del comando publicado y hold
  por runner wrapper).

### Repeticion de la celda B (#1740)

La B original (#71, PR #77) corrio sobre un servidor de sesiones que ya estaba
arrancado. El lanzador carga `mefisto-models.sh`, que exportaba
`MEFISTO_RUNTIME_LIB_DIR` con `:=`, asi que la corrida heredo del entorno
global del servidor una raiz de librerias, `MEFISTO_STATE_DIR` y
`MEFISTO_LEGACY_STATE_DIR` que no eran los de su propia instalacion. B cumplio
todo, pero su evidencia no proviene de la distribucion que certifica. Por eso
se repitio como B-bis (#78) sobre un servidor de sesiones arrancado por esa misma
corrida, y es B-bis la celda que entra en la matriz. El intento 1 corrio con
la misma herencia sin detectarla.

La herencia no invalida el veredicto: la matriz certificada ejecuta sobre su
propia distribucion. El defecto del lanzador se trato en
[#1740](https://github.com/augusto-romero-arango/eda-evsourcing-azure-harness/issues/1740).
Mezclar lanzamientos de dos versiones sobre el mismo servidor de sesiones no
forma parte de lo certificado.

### Intento 1 (2026-09-30, run-id `20260930-042402-v0.40.0`): NO PASA

| Campo | Valor verificado |
|---|---|
| Release e identidad | `v0.40.0` (publicada 2026-09-30T09:21:22Z), version `0.40.0`, commit fuente `d876b9af5e250c695b82031a58346064705e8ffb`; `pipeline-status-infra-<N>.json` y `pipeline-history.jsonl` registran `identity` `0.40.0/d876b9af` (`identity_state: complete`) en las corridas. La ruta infra entro por primera vez en una release con `v0.40.0`: `v0.39.0` se publico antes de los merges de #1624-#1628. |
| Instalacion | Marketplace + `claude plugin update` (scopes user y project) `0.39.0 -> 0.40.0`. Instalacion previa (rollback): `0.39.0` / `e5bff995`; se conserva `0.40.0` por ser la release vigente. |
| Consumidor | `augusto-romero-arango/mefisto-consumer-certification`, 11 modulos bajo `infra/modules/`, `infra-cd.yml` con `plan` en `pull_request` filtrado a `infra/**`. `<modulo-certificable>` = `monitoring`: tag determinista `modulo = "monitoring"` sobre `azurerm_log_analytics_workspace.this`. |
| Herramientas | `terraform` 1.14.4, Claude Code 2.1.285, Herdr y el multiplexor de sesiones locales. Sin `az login` ni backend remoto en local. |
| Baseline | `<sha-baseline-inicial>` = `<sha-baseline-final>` = `feb5103dc9b8ce118bddc76cd6b9c63481573abf`, arbol limpio antes y despues. |

#### Corridas (CA-2, CA-3)

| Dimension | A: Herdr | B: fuera de Herdr |
|---|---|---|
| Issue fixture | [#62](https://github.com/augusto-romero-arango/mefisto-consumer-certification/issues/62) | [#63](https://github.com/augusto-romero-arango/mefisto-consumer-certification/issues/63) |
| Lanzamiento | pane Herdr `w9:pC` | sesion `infra-63` |
| `MODELS:` writer / reviewer | `claude` balanced `sonnet` / deep `opus` | idem A |
| Stage 1 `infra-writer` | `passed`, 22 s | `passed`, 21 s (hold aparte) |
| Stage 2 `infra-reviewer` | `passed`, 24 s | `passed`, 18 s |
| PR (sin `Closes`) | [#66](https://github.com/augusto-romero-arango/mefisto-consumer-certification/pull/66) | [#69](https://github.com/augusto-romero-arango/mefisto-consumer-certification/pull/69) |
| Diff | solo `infra/modules/monitoring/main.tf`, una linea, identico en las dos | idem |
| Summaries en `<details>` | writer + reviewer | writer + reviewer |
| Job `plan` de CI | `SUCCESS` (fmt/init/validate/plan `success`, comentario publicado); `apply` `SKIPPED` | idem |
| Session id (hash sha256, 12) writer / reviewer | `eeb40e2c27cd` / `8acc929f575a` | intento 1 sin sesion (`rate_limit`), intento 2 `9290789cd785` / `cf4fca8dd827` |
| Evidencia bajo `.mefisto/pipeline/` | log por stage + stream `attempt-1` por stage, `events.log`, historial | idem, mas `attempt-2` del writer |

Ninguna corrida escribio evidencia bajo `.claude/pipeline/`: el unico archivo
tocado ahi fue el marker `.plugin-root` que el comando refresca como mirror de
resolucion de raiz, sin logs, estado ni historial.

#### Visibilidad en `/work-status` (CA-4)

- **Hold inducido (B)**: `MEFISTO_RUN_AGENT_BIN` apunto a un wrapper local
  que emite un terminal neutral `run.failed` con `error.kind = rate_limit` en
  el primer intento y delega en `src/runtime/mefisto-run-agent.sh` de la
  release en los siguientes, con `MEFISTO_HOLD_PROBE_SECONDS=90`.
  `events.log` registro `FALLO infra-writer: RATE_LIMIT` y la espera. El
  status paso a `state: hold` con `hold.cause = RATE_LIMIT` y `next_probe`.
  `/work-status` mostro `EN ESPERA`, la causa, la proxima sonda y el techo de
  6 h. Tras la sonda, el writer reanudo desde cero en `attempt-2` (no habia
  `session_id` que reanudar) y la corrida termino `completed`.
- **Terminada**: las filas pasan al historial como `completed`, pero con
  `detail = env:dev` y sin PR, a diferencia de las filas TDD, que muestran
  `PR #N`. `pipeline-history.jsonl` si guarda `pr`; el colector
  (`work-status-collect.sh`) prioriza `environment` sobre `pr` al calcular
  `detail` y no expone `pr` en la fila. Las filas infra ademas salen con
  `log: null`, asi que el drill-down no puede abrir la corrida. **Este es el
  gap de `NO PASA`** (#1730).

#### Centinelas y limpieza (CA-5)

- Barrido de los cuatro patrones sobre logs por stage, streams por intento,
  logs del pipeline, `events.log`, `pipeline-history.jsonl` y el expediente
  (`.mefisto/pipeline/certification/infra-v0.40.0/` en el consumidor, ignorado
  por Git): **0 coincidencias**.
- PRs #66 y #69 cerrados sin merge (`mergedAt = null`) y ramas remotas
  eliminadas; fixtures #62 y #63 cerrados `not planned` con comentario; sin
  worktrees `infra-issue-*`; sesion `infra-63` cerrada.

#### Desviaciones de la sesion

- **Fixtures**: se crearon con `gh issue create` desde el checkout del
  consumidor (sin `-R`, sin el planner interno de Mefisto) y con el cuerpo
  literal del template, mas `## ADRs aplicables` por la misma razon que juzgo
  #1487. No pasaron por el planner publicado; eso no afecta lo certificado,
  que empieza en `/mefisto:infra`.
- **Invocacion**: las corridas se lanzaron con el comando publicado real en
  modo no interactivo (`claude -p "/mefisto:infra <N>"`) desde el checkout del
  consumidor. A heredo el entorno Herdr del workspace del operador; B se lanzo
  con las variables `HERDR_*` retiradas, de modo que el lanzador abrio
  una sesion `infra-<N>` autonoma.
- **Hold**: se indujo con un runner wrapper local, uno de los dos mecanismos
  que admite "Visibilidad en `/work-status`"; el wrapper no forma parte de la
  release y solo se inyecto en la sesion de B.

#### Hallazgos no bloqueantes

- `events.log` mezcla zonas horarias: las lineas del pipeline van en hora
  local y las `[tool]`/`[stage]` del runner en UTC. La correlacion sigue siendo
  posible (draft
  [#1731](https://github.com/augusto-romero-arango/eda-evsourcing-azure-harness/issues/1731)).

## Referencias

- `docs/testing/tdd-consumer-certification.md`: molde de protocolo, fixture,
  manifiesto de evidencia y la seccion "Bloqueo estructural de la
  ejecucion automatizada (#1464)" que esta certificacion replica para
  `/mefisto:infra`.
- `docs/testing/herdr-workspace.md`: fila y labels de `herdr-workspace.sh`
  que la corrida A reutiliza.
- MEF-ADR-0011: Definition of Ready; columna `infra` de la tabla DoR.
- MEF-ADR-0019: separacion publicado/interno; issues y PRs fixture se
  gestionan exclusivamente desde el consumidor.
- MEF-ADR-0021/MEF-ADR-0022: cero credenciales de Azure en el pipeline local,
  PR sin `Closes`, `apply` real solo en CI tras merge.
- MEF-ADR-0031: el gate es evidencia ejecutable, no outputs asumidos.
- MEF-ADR-0050: toda operacion nace neutral a runtime.
- MEF-ADR-0051: mecanismo de hold ante `rate_limit`/`provider_unavailable`.
- MEF-ADR-0053, seccion 4: raiz de estado canonica `.mefisto/pipeline/` que
  la evidencia de este protocolo debe usar exclusivamente.
