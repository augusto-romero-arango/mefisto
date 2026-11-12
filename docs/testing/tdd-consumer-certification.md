# Protocolo de certificacion TDD (`/mefisto:implement`)

Este protocolo define la certificacion reproducible del pipeline
`/mefisto:implement` (`scripts/tdd-pipeline.mts`) sobre el runtime `claude`,
lanzado desde una instalacion publicada real en un consumidor. Cubre la
superficie propia de TDD: dos rutas de agentes (write-side y
`tipo:projection`), fase roja/verde, Stage 2b condicional, coverage gate
(Stage 4) y clausura del ciclo.

Las secciones de protocolo no ejecutan ninguna corrida. La evidencia de las
corridas reales vive en "Resultado write-side (#1435)" y "Resultado read-side
(#1436)", y su veredicto en "Veredicto final del corte TDD (#1487)".

## Invariantes y prerrequisitos (CA-1)

El consumidor persistente, privado y dedicado es
`augusto-romero-arango/mefisto-consumer-certification`. No representa un
producto real: se crea, se onboardea y se gestiona desde ese repositorio, y
Mefisto solo conserva este protocolo (MEF-ADR-0019). Las dos corridas comparten
estos invariantes:

- El baseline es un **consumidor completo** (onboarding `LISTO`, CI OIDC verde,
  Azure dedicado operativo), en un estado limpio verificado por
  `git status --porcelain=v1` antes y despues de cada corrida.
- Antes de cualquiera de las dos corridas existe **una unica release
  candidata** instalada: el `mefisto-manifest.json` de la raiz que carga la
  sesion declara `runtime=claude`, `<version>` y `<commit-fuente>`, y
  `.mefisto/pipeline/.plugin-root` nombra esa misma raiz. El pipeline registra
  esa identidad en el campo `identity` de `pipeline-history.jsonl`, con
  `identity_state: complete`. Una identidad incompleta, o distinta entre las
  dos corridas, bloquea el protocolo antes de crear ningun fixture.
- Queda **prohibido** instalar o referenciar Mefisto desde un checkout, un
  worktree, un enlace simbolico o una ruta absoluta del repositorio de Mefisto:
  la unica instalacion valida es la release publicada, instalada desde el
  marketplace a scope de usuario
  ([guia del consumidor, "Instalación"](../guia-del-consumidor.md#instalación)).
- Registra antes de crear los dos issues fixture: `<tag-certificable>` (tag Git
  exacto `v<version>`), `<version>`, `<commit-fuente>` (SHA completo del
  manifiesto), `<sha-baseline-inicial>`/`<sha-baseline-final>`
  (`git rev-parse HEAD` antes de cada corrida y despues de su limpieza; deben
  ser iguales) y las salidas de `claude --version` y `herdr --version`.

La superficie de discovery que este protocolo ejercita es: el comando
`/mefisto:implement`, los seis agentes de TDD
(`test-writer`, `implementer`, `smoke-test-writer`, `reviewer`,
`projection-test-writer`, `projection-implementer`), el Agent Skill
`projections` que los agentes de la ruta read-side precargan via `skills:`
-- su `SKILL.md` y los recursos de Nivel 3 `modelos-marten.md`,
`read-apis.md`, `naming.md` y `config-test.md` (MEF-ADR-0033) -- y
`scripts/tdd-pipeline.mts` como entrypoint.

## Fixtures write-side/read-side (CA-2)

Se crean **dos issues fixture independientes**, ambos desde el planner
**publicado** del consumidor (nunca desde el planner interno de Mefisto ni con
`gh -R`, MEF-ADR-0019), ambos con labels `dom:certificacion` y `estado:listo`
explicitos, y ninguno depende de que el PR fixture del otro se fusione:

| Fixture | `tipo:` | Agentes forzados |
|---|---|---|
| write-side | `tipo:feature` | `test-writer` -> `implementer` -> `smoke-test-writer` -> `reviewer` |
| read-side | `tipo:projection` | `projection-test-writer` -> `projection-implementer` -> `smoke-test-writer` -> `reviewer` |

Los dos se crean **abiertos e independientes**, los dos parten del mismo
`<sha-baseline-inicial>` -- el baseline se restaura a ese SHA antes de cada
corrida, que es lo que hace que ninguna dependa del PR de la otra --
y cada uno cumple el Definition of Ready de la columna correspondiente
(`docs/adr/mef-adr-0011-definition-of-ready.md`): CAs deterministas, seccion
`## Modelo de eventos` (write-side) o `## Necesidad de lectura` +
`## Endpoints / rutas` + `## Capas de test esperadas` (read-side), y `##
Dependencias` declarando `Ninguna`. La validacion programatica de
`/mefisto:implement` (seccion "Validacion en `/implement`" del mismo ADR) es la
misma que corre en produccion; este protocolo no la relaja ni la duplica.

Los dos fixtures llevan ademas `## ADRs aplicables`: no es una fila del DoR
de MEF-ADR-0011 (esa tabla no la nombra), sino el requisito que
`agents/implementer.md` paso 1b y `agents/reviewer.md` paso 1b exigen de todo
issue antes de escribir o revisar codigo -- si falta o esta vacia, el
implementer bloquea (`.mefisto/pipeline/blockage-report.md`) y el reviewer la
trata como hallazgo bloqueante (regla 10 de `agents/reviewer.md`).

### Eleccion del dominio certificable

Antes de redactar los dos fixtures se registra `<dominio-certificable>`:
un dominio ya scaffoldeado del baseline con Function App existente y su
proyecto `tests/<namespacePrefix>.<dominio-certificable>.SmokeTests` ya creado.
`<namespacePrefix>` es el valor de la clave homonima de
`.mefisto/harness.config.json` del consumidor -- el mismo que `tdd-pipeline.mts`
lee como `HARNESS_NAMESPACE_PREFIX` para resolver el proyecto SmokeTests del
dominio en Stage 2b, de modo que el placeholder de este protocolo y la deteccion
real del pipeline no pueden divergir.

Esa eleccion es la que deja **Stage 0 explicitamente fuera de alcance** (CA-3):
ninguna de las dos corridas ofrece ni acepta scaffold de dominio, porque el
directorio `src/<namespacePrefix>.<dominio-certificable>/` ya existe antes de
lanzar `/mefisto:implement`.

La corrida write-side registra ademas `<aggregate-certificable>` y
`<comando-certificable>`: un aggregate del mismo `<dominio-certificable>` y uno
de sus comandos HTTP ya existentes, elegidos porque el campo sobre el que se
agrega la regla de validacion ya viaja en ese comando.

La corrida read-side elige ademas `<evento-certificable>`/`<vista-certificable>`:
un evento y su read model **ya materializados en el baseline**, nunca el
resultado del PR write-side (que este protocolo descarta sin merge, seccion
"Fail-closed y limpieza" mas abajo). Esto evita que la corrida read-side
dependa de una corrida distinta para tener contenido que leer.

### Templates de fixture

Cada template deja placeholders para los valores ya registrados arriba
(`<namespacePrefix>`, `<dominio-certificable>`, `<aggregate-certificable>`,
`<comando-certificable>` en write-side; `<evento-certificable>`,
`<vista-certificable>` en read-side), para la identidad de la release
(`<tag-certificable>`, `<version>`, `<commit-fuente>`), para `<run-id>`
(formato `YYYYMMDD-HHMMSS-<tag-certificable>`) y para el runtime de la
corrida. Las dos corridas usan la misma forma; solo el `tipo:` y el contenido
determinista cambian.

Los templates son el esqueleto fijo del body: cada fixture se redacta desde el
planner **publicado** del consumidor (nunca a mano ni desde el planner interno,
MEF-ADR-0019), que sustituye tanto estos placeholders como el de
`## ADRs aplicables` con los ADRs reales que el cambio concreto toca. Un
fixture cuya seccion `## ADRs aplicables` quede vacia o conserve el placeholder
sin sustituir **no es lanzable**: el operador no ejecuta `/mefisto:implement`
sobre el.

#### Template: write-side

````markdown
# Certificar TDD write-side bajo <runtime> (<run-id>)

## Contexto

Certificar `/mefisto:implement` (`tipo:feature`) sobre la release
`<tag-certificable>` (`<version>`, commit fuente `<commit-fuente>`) desde una
instalacion publicada real en este consumidor.

## Modelo de eventos

El aggregate `<aggregate-certificable>` y el comando
`<comando-certificable>` ya existen en `<dominio-certificable>`. Este fixture
NO crea aggregate, comando ni evento nuevos: agrega una regla de validacion
determinista y acotada sobre un campo existente de `<comando-certificable>`
(por ejemplo, un rango o formato adicional) que hoy no esta cubierta por
ningun test.

`<comando-certificable>` ya expone su endpoint HTTP y este fixture no lo
introduce ni lo modifica: conserva verbo, ruta y codigo de exito sin cambio,
asi que la fila "Contrato HTTP del comando" del DoR queda *No aplica*. Esta
constancia va aqui, dentro de `## Modelo de eventos`, y no bajo un encabezado
propio: MEF-ADR-0011 fija que esa fila es la unica de la tabla que no nombra
una seccion del body.

## ADRs aplicables

<ADRs que enumera el planner publicado -- ver paso 7 del modo `refinar` y
los templates de "Crear issues" en `agents/planner.md`>

## Criterios de aceptacion

- CA-1: existe exactamente un test rojo nuevo que ejercita la regla de
  validacion descrita, sobre el aggregate `<aggregate-certificable>`.
- CA-2: la implementacion hace pasar ese test sin modificar ningun test
  existente ni el contrato HTTP del comando.
- CA-3: el diff toca al menos un archivo bajo
  `src/<namespacePrefix>.<dominio-certificable>/.../Function/`, de modo que
  Stage 2b se ejecuta contra el proyecto SmokeTests ya existente del dominio.
- CA-4: `tests/<namespacePrefix>.<dominio-certificable>.SmokeTests` gana un
  caso nuevo para la regla de validacion.
- CA-5: todos los tests (unitarios y de compilacion de smoke tests) pasan al
  cierre del pipeline.

## Impacto en archivos

- Modifica: el aggregate/handler de `<comando-certificable>` y su Function en
  `src/<namespacePrefix>.<dominio-certificable>/`.
- Modifica: los tests correspondientes en
  `tests/<namespacePrefix>.<dominio-certificable>.Tests/` y en el proyecto
  SmokeTests del dominio.
- No crea proyectos nuevos ni toca otro dominio.

## Dependencias

- Ninguna.
````

#### Template: read-side

````markdown
# Certificar TDD read-side bajo <runtime> (<run-id>)

## Contexto

Certificar `/mefisto:implement` (`tipo:projection`) sobre la release
`<tag-certificable>` (`<version>`, commit fuente `<commit-fuente>`) desde una
instalacion publicada real en este consumidor.

## Necesidad de lectura

El evento `<evento-certificable>` y su read model `<vista-certificable>` ya
estan materializados en el baseline por el worker de proyecciones. Este
fixture agrega un campo derivado adicional a `<vista-certificable>`, calculado
a partir de datos que `<evento-certificable>` ya trae, sin registrar un evento,
aggregate ni proyeccion nuevos. Lifecycle: `Async` (sin excepcion, hereda el de
`<vista-certificable>`).

## Endpoints / rutas

La Function GET que ya expone `<vista-certificable>` conserva su ruta; el
fixture solo amplia el payload de respuesta con el campo nuevo. No se verifica
colision de nombres porque no se crea ninguna Function.

## Capas de test esperadas

- Unit tests de `Create`/`Apply` de la proyeccion `<vista-certificable>` que
  cubren el campo derivado nuevo.
- Config-test del worker sin cambios (no se agrega proyeccion ni store
  nuevos).
- Test de composicion de la Function GET que verifica el campo nuevo en la
  respuesta.

## ADRs aplicables

<ADRs que enumera el planner publicado -- ver paso 7 del modo `refinar` y
los templates de "Crear issues" en `agents/planner.md`>

## Criterios de aceptacion

- CA-1: existe al menos un test rojo nuevo sobre `Create`/`Apply` de
  `<vista-certificable>` para el campo derivado.
- CA-2: la implementacion hace pasar ese test sin modificar tests ni el
  contrato de la Function GET existente.
- CA-3: el diff toca la carpeta de la Function GET de `<vista-certificable>`
  (patron `Obtener*/FunctionEndpoint.cs` o `Listar*/FunctionEndpoint.cs`), de
  modo que Stage 2b se ejecuta contra el proyecto SmokeTests ya existente del
  dominio.
- CA-4: `tests/<namespacePrefix>.<dominio-certificable>.SmokeTests` gana un
  caso que verifica el campo nuevo end-to-end.
- CA-5: todos los tests pasan al cierre del pipeline.

## Impacto en archivos

- Modifica: la proyeccion `<vista-certificable>` y su Function GET en
  `src/<namespacePrefix>.<dominio-certificable>/`.
- Modifica: los tests de proyeccion y el proyecto SmokeTests del dominio.
- No crea proyeccion, store ni Function nuevos.

## Dependencias

- Ninguna.
````

## Rutas de agentes forzadas y alcance del pipeline (CA-3)

Los dos fixtures fuerzan por diseno la ruta de agentes de su fila: el
`tipo:` del issue determina en `tdd-pipeline.mts` si `STAGE1_AGENT`/`STAGE2_AGENT`
resuelven a `test-writer`/`implementer` (write-side) o a
`projection-test-writer`/`projection-implementer` (read-side, issue #371).
`smoke-test-writer` y `reviewer` son comunes a ambas rutas.

En las dos corridas:

- **Stage 1 (fase roja)** debe terminar con tests que fallan por la razon
  correcta (no por error de compilacion), confirmando que el `test-writer` o
  `projection-test-writer` escribio solo tests y stubs, nunca implementacion
  real. En la ruta read-side el gate 1b admite ademas la señal `no-red`
  (`pipeline-state/no-red-signal.md`, honrada solo cuando `STAGE1_AGENT =
  projection-test-writer`), pero el camino esperado del fixture read-side
  sigue siendo el rojo: su template exige un test nuevo que falle sobre
  `Create`/`Apply` de `<vista-certificable>` (CA-1 del template read-side),
  asi que la fase roja es alcanzable. Una señal `no-red` solo es aceptable si
  cumple las condiciones acotadas de
  `src/published/agents/projection-test-writer.md` -- el issue no crea ni
  modifica ninguna clase de proyeccion -- y queda justificada en el archivo
  señal y en el summary del stage; sin esa justificacion es `NO PASA`.
- **Stage 2 (fase verde)** debe terminar con todos los tests pasando, sin que
  el `implementer`/`projection-implementer` haya tocado ningun archivo de
  test.
- **Stage 2b (smoke tests, condicional)** **debe ejecutarse** en las dos
  corridas: la eleccion de `<dominio-certificable>` (Function App existente +
  proyecto SmokeTests existente) y el CA-3 de cada template (diff que toca
  `Function/` o la Function GET) son las dos precondiciones que
  `tdd-pipeline.mts` evalua para no saltarlo (`AGENT_ST_RES=skipped` seria una
  divergencia, no un resultado aceptable de este protocolo).
- **Stage 3 (reviewer, fase refactor)** debe dejar todos los tests pasando y
  no introducir cambios funcionales fuera del alcance declarado.
- **Stage 4 (coverage gate) debe emitir un resultado** -- uno de los tres que
  `tdd-pipeline.mts` sabe producir en `AGENT_CG_RES`: `passed` (cobertura sobre
  el umbral), `gaps` (umbral no alcanzado; el gate advierte y continua, no
  aborta) o `skipped` con motivo explicito (sin `dotnet-coverage`, sin archivos
  de logica que evaluar, o medicion no concluyente). Nunca ausencia de
  registro. `AGENT_CG_RES` queda en el manifiesto de cada corrida
  independientemente del valor; `gaps` es un resultado registrable, no un fallo
  del protocolo.
- **Stage 0 (scaffold de dominio) queda explicitamente fuera de alcance**: la
  eleccion de `<dominio-certificable>` con Function App ya existente asegura
  que ninguna corrida ofrece ni ejecuta scaffold. Este protocolo no certifica
  la ruta de scaffold de `/mefisto:implement`.

## Lanzamiento real desde Herdr (CA-4)

Las dos corridas se lanzan desde el pane `ejecucion [claude]` del workspace que
monta `herdr-workspace.mts <ruta-del-consumidor>`
([`herdr-workspace.md`](./herdr-workspace.md)), cuyos panes heredan
`MEFISTO_RUNTIME` y `--kind`. Se invoca directamente, sin pipeline anidado:

```text
/mefisto:implement <issue-write-side>
/mefisto:implement <issue-read-side>
```

Ninguna invocacion agrega `--variant` (no produce PR, no sirve a este gate) ni
fija proveedor o modelo con `--models`: las dos corridas dejan que el runtime
resuelva su perfil neutral (`fast`/`balanced`/`deep`) automaticamente, porque
la seleccion automatica es parte de lo que se certifica (MEF-ADR-0050). Si una
corrida no arranca sin `--models`, eso es un `NO PASA` con bug en Mefisto, no
una licencia para agregar el flag. Registra por cada stage de cada corrida:
perfil neutral solicitado, modelo efectivo, origen de la seleccion (automatica
o heredada), runtime y `<version>`/`<commit-fuente>` de la release activa. La
espera de agentes y checks de CI quedan fuera de la estimacion activa de quien
ejecuta el protocolo.

Cada una de las dos invocaciones debe producir un **PR real**, con
`Closes #<issue-correspondiente>`, cambios limitados exactamente al alcance
declarado en su template (los archivos de `## Impacto en archivos`, nunca
otro dominio ni archivos del propio Mefisto) y el comentario de cierre del
pipeline con los summaries de cada stage.

## Manifiesto de evidencia sanitizado (CA-5)

Por cada una de las dos corridas se preserva un manifiesto redactado y
correlacionado por issue/stage/session. Contiene:

| Campo | Contenido |
|---|---|
| Identidad | issue, PR, `<sha-baseline-inicial>`/`<sha-baseline-final>` de esa corrida, `<tag-certificable>`, `<version>`, `<commit-fuente>` |
| Ventana temporal | inicio/fin de la corrida completa y de cada stage, con zona horaria |
| Argv | invocacion exacta de `/mefisto:implement <issue>` sin variables ni valores sensibles |
| Identidad de ejecucion | runtime, perfil neutral por stage, modelo efectivo/origen, session id (hash) |
| Stages y gates | resultado de Stage 1/2/2b/3/4 con el vocabulario real del pipeline (`passed`/`blocked`/`failed` en 1/2/3, `passed`/`skipped` + motivo en 2b, `passed`/`gaps`/`skipped` + motivo en 4), explicitamente marcando Stage 0 como no ejecutado |
| Checks | conclusiones de los checks requeridos del PR, o `NO_APLICAN` con el motivo (cuando ningun workflow cubre las rutas tocadas) |
| Summaries | los summaries de cada agente copiados al cuerpo del PR |
| Streams y logs | streams neutrales redactados por stage, `events.log` y `pipeline-history.jsonl` correlacionados por issue/stage/session |
| Metricas | las de `compute_stage_metrics` por stage, ya cosechadas por `tdd-pipeline.mts` |
| Veredicto | pasa/falla/bloqueado de esa corrida individual |

La evidencia versionada conserva unicamente indices, URLs y veredictos;
prompts, system prompts, salida raw, `stderr`, inputs de herramientas y
transcripts completos de sesion quedan **fuera** de cualquier artefacto
versionado o adjunto publico. El catalogo de centinelas (`prompt`, `raw`,
`stderr`, `tool_input`, cabeceras de auth, `auth.json`/credentials, tokens
`Bearer`/`sk-`) es el de "Centinelas y limpieza (CA-5 de #1629)" en
[`infra-consumer-certification.md`](./infra-consumer-certification.md); este
protocolo no define otro. Por cada artefacto inspeccionado se registra su ruta
relativa, SHA-256, patron, conteo y veredicto, nunca la linea coincidente, y
nunca se abre, copia ni sube el contenido de un auth store (MEF-ADR-0025).

## Fail-closed y limpieza (CA-6)

La certificacion es fail-closed:

- **Cualquier stage omitido inesperadamente** (por ejemplo, Stage 2b saltado
  en una corrida donde el diff si toca `Function/`, o Stage 4 sin registro)
  produce `NO PASA` para esa corrida.
- **Identidad divergente** entre las dos corridas (version, commit fuente o
  `identity_state` distinto de `complete` en cualquier punto) produce
  `NO PASA` para todo el protocolo, no solo para la corrida afectada.
- **Un recurso inaccesible** (issue, PR, check, log o sesion no consultable)
  se marca `BLOQUEADO`, nunca se completa por inferencia.
- **Un recurso de doctrina ausente** -- el Agent Skill `projections`, uno de
  sus recursos de Nivel 3 o un ADR citado, no visible para el agente que lo
  precarga -- produce `NO PASA` para la corrida afectada; nunca se continua
  con el alcance reducido.
- **Una ruta de agentes distinta** a la forzada por el `tipo:` del fixture
  produce `NO PASA`.

Cualquiera de estos casos crea un issue `tipo:bug` en Mefisto, enlaza la
evidencia sanitizada de la corrida afectada y bloquea el veredicto hasta su
cierre.

Tras capturar la evidencia (haya `PASA` o `NO PASA`), la limpieza es
obligatoria y corre igual en ambos casos:

1. Cierra los **dos PRs sin merge** y elimina sus ramas remotas.
2. Cierra los **dos issues fixture** como `not planned` desde el consumidor,
   con un comentario que enlace la certificacion.
3. Retira los dos worktrees de las corridas y comprueba que no queda
   ninguno.
4. Restaura el baseline y comprueba que `<sha-baseline-final>` coincide
   exactamente con `<sha-baseline-inicial>` y que el arbol queda limpio.
5. Restaura la instalacion previa si alguna corrida cambio la release activa,
   conservando en el manifiesto la version previa para poder verificar esa
   restauracion.

La limpieza es idempotente: repetirla sobre PR/issue ya cerrados, ramas
ausentes o un arbol ya restaurado no altera el resultado. Este protocolo no
certifica ninguna otra capacidad del catalogo publicado ni migra un comando
adicional.

## Resultado write-side (#1435)

Registro de la evidencia de la corrida write-side real exigida por #1435, sobre
el template de "Fixtures write-side/read-side (CA-2)" y el lanzamiento de
"Lanzamiento real desde Herdr (CA-4)".

### Estado de la corrida

**EJECUTADA (2026-09-21, America/Bogota UTC-05:00) -- corrida write-side `PASA`.**
Sesion operada en vivo sobre el consumidor privado
`augusto-romero-arango/mefisto-consumer-certification`, run-id
`20260921-073646-v0.38.2` (intento 2). El intento 1 (run-id
`20260921-062538-v0.38.2`) queda **descartado** como evidencia: sus fixtures se
crearon con un template literal sin `## ADRs aplicables`, seccion que
`agents/implementer.md` (1b) exige y ante cuya ausencia debe escribir
`blockage-report.md`; el implementer continuo sin ella, apartandose de su
doctrina. Por decision humana el intento 2 repitio las corridas sobre la misma
release y el mismo baseline con fixtures creados por el planner publicado con
su doctrina completa (incluida `## ADRs aplicables`), conservando la regla
semver de `EtiquetaRelease` y el campo derivado `IdentificadorCertificacion`.
Esa es la unica desviacion frente al intento 1 y se declara aqui para la
auditoria del veredicto.

El expediente sanitizado completo vive en el consumidor, ignorado por Git, en
`.mefisto/pipeline/certification/tdd-v0.38.2/` (`coordination.md`,
`write-claude.md`, `sentinels.md`, `final-handoff.md`; intento 1 en
`intento-1/`). Estas tablas solo conservan indices, URLs y veredictos, conforme
a "Manifiesto de evidencia sanitizado (CA-5)".

| Campo | Valor verificado |
|---|---|
| Release e identidad | `v0.38.2` (publicada 2026-09-21T11:15:57Z), version `0.38.2`, commit fuente `6c2319c5a91aef844d5f71468ecb43d6f72a1cfe`; `pipeline-history.jsonl` registra identity `0.38.2/6c2319c5`. Instalacion previa (rollback): `0.38.1` / `a48e6870`. |
| Baseline | `<sha-baseline-inicial>` = `<sha-baseline-final>` = `9f49d6a59fa96f7e5a49b0139fa27ae9c2353d35`; `main` limpio, 0/0 frente a `origin/main`, un solo worktree antes y despues de la corrida. |
| Fixture | [#34](https://github.com/augusto-romero-arango/mefisto-consumer-certification/issues/34), `tipo:feature`, `dom:certificacion`, `estado:listo`, creado por el planner publicado 0.38.2 (sha256/12 `00cc3913a679`, 26170 bytes). |
| Discovery | Tras `/reload-plugins` (cache 0.38.2): `/mefisto:implement`, `test-writer`, `implementer`, `smoke-test-writer`, `reviewer` y `scripts/tdd-pipeline.mts` presentes antes de lanzar. |
| PR | [#38](https://github.com/augusto-romero-arango/mefisto-consumer-certification/pull/38) (`Closes #34`, +51/-5, 4 archivos): validator, test del validator y dos SmokeTests, dentro del alcance del fixture; summaries de cada stage en el cuerpo y comentario de cierre. |
| Stages | Stage 0 no ejecutado; Stage 1 rojo funcional (46 tests / 1 fallido, "Fase roja confirmada (exit 2)"); Stage 2 verde tocando solo `RegistrarSolicitudCertificacionValidator.cs` (46/46 + 16/16); Stage 2b ejecutado (smoke `400` nuevo + migracion de fixtures); Stage 3 `success`; Stage 4 `passed`, gaps=0. Un unico terminal por stage. |
| Checks | `NO_APLICAN` en #38: el unico workflow del consumidor sobre `pull_request` es `infra-cd.yml`, filtrado a `infra/**`, y el fixture no toca `infra/`; `deploy-certificacion.yml`/`deploy-projections.yml` solo corren sobre `push` a `main` y `smoke-tests.yml` es programado/manual. `statusCheckRollup` vacio. |
| Modelos y duracion | Modelos resueltos automaticamente, sin `--models` ni `--variant`: `claude-sonnet-5` (1/2/2b, `balanced`) y `claude-opus-5` (3, `deep`). Stage 3 sin cambios. Duracion 10 min. |
| Centinelas | 0 coincidencias en los cuatro patrones (salida cruda/interaccion, cabeceras de auth, auth store/credenciales, tokens de portador/prefijo corto) sobre todo el expediente, incluido `intento-1/` (`sentinels.md`, 2026-09-21T08:56:30-05:00). |
| Limpieza | PR #38 cerrado sin merge con su rama remota eliminada; issue #34 cerrado `not planned` con comentario que enlaza el expediente; cero worktrees de fixtures. Los PRs y fixtures del intento 1 se cerraron igual. Por decision humana se conserva 0.38.2 instalada (paso a ser la release vigente) en lugar de restaurar 0.38.1. |

| CA de #1435 | Resultado | Sintesis |
|---|---|---|
| CA-1 preflight y fixtures | PASA | `/mefisto:onboard` `LISTO` (17 OK / 0 FALTA), Azure dedicado operativo, identidad 0.38.2/6c2319c5, baseline `9f49d6a` fijado; fixture #34. |
| CA-2 discovery en Herdr | PASA | Workspace Herdr con la fila `planner`/`ejecucion` de Claude; discovery viva antes de lanzar. |
| CA-3 corrida Claude | PASA | `/mefisto:implement 34`, sesion `20260921-075322`, 07:53:22-08:03:25; PR #38; stages 1/2/2b/3 `success`, Stage 4 `passed` gaps=0. |
| CA-5 expediente correlacionado | PASA | `write-claude.md` correlaciona issue/PR/stage/session (hash) con artefactos neutrales (`events.log`, logs por stage, metrics, `pipeline-history.jsonl`) identificados por sha256/12. |
| CA-6 centinelas y limpieza | PASA | Centinelas 0; limpieza ejecutada 2026-09-21T08:58:07-05:00 y baseline restaurado; intento 1 descartado y declarado arriba. |

## Resultado read-side (#1436)

Registro de la evidencia de la corrida read-side real exigida por #1436, sobre
el template de "Fixtures write-side/read-side (CA-2)" y el lanzamiento de
"Lanzamiento real desde Herdr (CA-4)". Parte del mismo `<sha-baseline-inicial>`
de la corrida write-side y nunca del PR write-side descartado (seccion
"Eleccion del dominio certificable"), y no depende de que ese PR se fusione. Se
lanza despues de la corrida write-side, nunca en paralelo, para no compartir el
worker de proyecciones en vuelo (MEF-ADR-0034).

### Estado de la corrida

**EJECUTADA (2026-09-21, America/Bogota UTC-05:00) -- corrida read-side `PASA`.**
Mismo run-id (`20260921-073646-v0.38.2`, intento 2), release, identidad y
baseline que la corrida write-side; se lanzo despues de ella, sin solaparse. En
el intento 1 no llego a ejecutarse (fail-closed, ver "Resultado write-side
(#1435)"). Expediente sanitizado en el consumidor:
`.mefisto/pipeline/certification/tdd-v0.38.2/read-claude.md`.

| Campo | Valor verificado |
|---|---|
| Release e identidad | `v0.38.2`, `0.38.2`, commit fuente `6c2319c5a91aef844d5f71468ecb43d6f72a1cfe`, identica a la de la corrida write-side. |
| Baseline | `9f49d6a59fa96f7e5a49b0139fa27ae9c2353d35` al inicio y al cierre, arbol limpio; ningun PR fixture se fusiono, asi que la corrida read-side parte del baseline y no del PR write-side. |
| Fixture | [#36](https://github.com/augusto-romero-arango/mefisto-consumer-certification/issues/36), `tipo:projection`, `dom:certificacion`, `estado:listo` (sha256/12 `bbad87d1d822`, 30486 bytes); `<evento-certificable>` `SolicitudCertificacionRegistrada` y `<vista-certificable>` `DetalleSolicitudCertificacion` (`SingleStreamProjection` Async) ya materializados en el baseline; campo derivado `IdentificadorCertificacion` = `EtiquetaRelease@Runtime`. |
| Discovery | `/mefisto:implement`, `projection-test-writer`, `projection-implementer`, `smoke-test-writer`, `reviewer` y el Skill `projections` con `SKILL.md`, `modelos-marten.md`, `read-apis.md`, `naming.md` y `config-test.md` presentes. |
| PR | [#40](https://github.com/augusto-romero-arango/mefisto-consumer-certification/pull/40) (`Closes #36`, +70/-10, 5 archivos): proyeccion, read model, `ObtenerDetalleSolicitudCertificacion/FunctionEndpoint.cs`, test de proyeccion y smoke del GET. |
| Stages | Stage 0 no ejecutado; Stage 1 rojo real sobre `Create` (Projections.Tests 17 / 2 fallidos), sin señal `no-red`; Stage 2 verde tocando proyeccion y Function GET sin tocar tests (45/45 + 17/17); Stage 2b ejecutado sobre la Function GET; Stage 3 `success`; Stage 4 `passed`, gaps=0. Un unico terminal por stage. |
| Checks | `NO_APLICAN` en #40, mismo motivo que la corrida write-side. |
| Modelos y duracion | Mismos modelos automaticos que la corrida write-side. Stage 3: el reviewer solo compacto comentarios (MEF-ADR-0044) en el endpoint, el read model y el test. Duracion 13 min. Recursos del Skill `projections` visibles; sin reduccion de stages, gates ni alcance. |
| Centinelas | Cubiertas por el mismo barrido del expediente (`sentinels.md`): 0 coincidencias. |
| Limpieza | PR #40 cerrado sin merge con su rama remota eliminada; issue #36 cerrado `not planned` desde el consumidor; cero worktrees; baseline restaurado. |

| CA de #1436 | Resultado | Sintesis |
|---|---|---|
| CA-1 preflight y fixtures secuenciales | PASA | Mismo preflight que la corrida write-side; fixture #36, lanzado despues de ella. |
| CA-2 discovery read-side en Herdr | PASA | Agentes de proyeccion y Skill `projections` con sus recursos de Nivel 3 visibles. |
| CA-3 corrida Claude | PASA | `/mefisto:implement 36`, sesion `20260921-082706`, 08:27:06-08:39:43; PR #40; stages 1/2/2b/3 `success`, Stage 4 `passed` gaps=0. |
| CA-5 expediente correlacionado | PASA | `read-claude.md` correlaciona issue/PR/stage/session (hash) con los artefactos neutrales por sha256/12. |
| CA-6 centinelas y limpieza | PASA | Centinelas 0; limpieza ejecutada 2026-09-21T08:58:07-05:00; baseline `9f49d6a` restaurado. |

## Bloqueo estructural de la ejecucion automatizada (#1464)

Las corridas de este protocolo exigen una sesion operada en vivo por un humano
con acceso al consumidor privado y a Herdr. Un stage de escritura no
interactivo, como los de `/mefisto:tooling`, no puede ejecutarlas: no tiene
credenciales ni alcance sobre el repositorio privado del consumidor, no puede
operar sesiones Herdr en vivo y no puede esperar minutos u horas a que un
pipeline de CI ajeno resuelva. Rellenar las tablas de resultado sin esa sesion
violaria MEF-ADR-0031.

Quien opere la sesion:

1. Ejecuta el preflight de "Invariantes y prerrequisitos (CA-1)" sobre la
   release candidata vigente al momento de la corrida, fijando
   `<sha-baseline-inicial>`, `<tag-certificable>`, `<version>` y
   `<commit-fuente>`.
2. Crea los dos issues fixture de "Fixtures write-side/read-side (CA-2)"
   desde el planner publicado del consumidor y lanza las dos corridas desde
   Herdr conforme a "Lanzamiento real desde Herdr (CA-4)", sin `--variant` ni
   override de modelo.
3. Rellena las tablas de "Resultado write-side (#1435)" y "Resultado read-side
   (#1436)" con la evidencia real correlacionada por issue/PR/stage/session, y
   ejecuta la limpieza de "Fail-closed y limpieza (CA-6)".
4. Abre el issue de veredicto que audita esa evidencia real y emite `PASA` o
   `NO PASA`.

### Sesion humana ejecutada (2026-09-21)

La sesion operada en vivo ocurrio el 2026-09-21 sobre la release `v0.38.2`:
pasos 1 a 3 cumplidos y consignados en "Resultado write-side (#1435)" y
"Resultado read-side (#1436)" (PRs #38 y #40 del consumidor). El paso 4 es
[#1487](https://github.com/augusto-romero-arango/eda-evsourcing-azure-harness/issues/1487),
el issue de veredicto que audita esa evidencia.

## Veredicto final del corte TDD (#1487)

Esta seccion audita, sin repetir ejecuciones, la sesion operada por un humano
el 2026-09-21 sobre la release `v0.38.2` contra las tablas de "Resultado
write-side (#1435)" y "Resultado read-side (#1436)" arriba. No redefine el
protocolo ni sus templates; emite el veredicto documental fail-closed conforme
a la seccion "Fail-closed y limpieza (CA-6)".

### Identidad comun de release (CA-1 de #1487)

Las dos corridas comparten los mismos valores de identidad, tomados sin
variacion de las tablas "Campo | Valor verificado" de #1435 y #1436:

| Parametro | write-side (#34) | read-side (#36) |
|---|---|---|
| `<tag-certificable>` | `v0.38.2` | `v0.38.2` |
| `<version>` | `0.38.2` | `0.38.2` |
| `<commit-fuente>` | `6c2319c5a91aef844d5f71468ecb43d6f72a1cfe` | idem |

Las dos corridas comparten ademas `<sha-baseline-inicial>` =
`9f49d6a59fa96f7e5a49b0139fa27ae9c2353d35`. No hay identidad divergente que
juzgar.

### Corridas auditadas (CA-2 de #1487)

| Dimension | write-side | read-side |
|---|---|---|
| Issue fixture | [#34](https://github.com/augusto-romero-arango/mefisto-consumer-certification/issues/34) | [#36](https://github.com/augusto-romero-arango/mefisto-consumer-certification/issues/36) |
| PR (`Closes`) | [#38](https://github.com/augusto-romero-arango/mefisto-consumer-certification/pull/38) (`Closes #34`) | [#40](https://github.com/augusto-romero-arango/mefisto-consumer-certification/pull/40) (`Closes #36`) |
| Session id | `20260921-075322` | `20260921-082706` |
| Stage 1 (fase roja) | rojo funcional, 46 tests/1 fallido | rojo real sobre `Create`, 17/2 fallidos |
| Stage 2 (fase verde) | verde, 46/46 + 16/16 | verde, 45/45 + 17/17 |
| Stage 2b (smoke tests) | ejecutado | ejecutado |
| Stage 3 (reviewer) | `success` | `success` |
| Stage 4 (coverage gate) | `passed`, gaps=0 | `passed`, gaps=0 |
| Checks | `NO_APLICAN` | `NO_APLICAN` |
| Stage 0 (scaffold) | no ejecutado | no ejecutado |

Las dos corridas tienen issue de fixture, PR con `Closes`, session id y
resultado de Stage 1/2/2b/3/4 verificables en las tablas de #1435 y #1436.
Stage 2b nunca aparece `skipped`. Stage 0 esta explicitamente marcado "no
ejecutado" en ambas, conforme a la eleccion de `<dominio-certificable>` con
Function App y proyecto SmokeTests ya existentes ("Eleccion del dominio
certificable" del protocolo). El `NO_APLICAN` de checks trae el mismo motivo
explicito en las dos: el unico workflow `pull_request` del consumidor
(`infra-cd.yml`) filtra a `infra/**` y ninguno de los dos PRs toca esa carpeta;
`statusCheckRollup` vacio en ambos.

### Observabilidad y limpieza (CA-3 de #1487)

El expediente sanitizado (`.mefisto/pipeline/certification/tdd-v0.38.2/` en el
consumidor, ignorado por Git: `coordination.md`, `write-claude.md`,
`read-claude.md`, `sentinels.md`, `final-handoff.md`) correlaciona cada corrida
por issue/PR/stage/session (hash). El barrido de centinelas (`sentinels.md`,
cubriendo tambien `intento-1/`) dio **0 coincidencias** en los cuatro patrones
(salida cruda/interaccion, cabeceras de auth, almacenes de auth/credenciales,
tokens de portador/prefijo corto). `<sha-baseline-inicial>` =
`<sha-baseline-final>` = `9f49d6a59fa96f7e5a49b0139fa27ae9c2353d35` en las dos
corridas, con el arbol limpio antes y despues de cada una; la limpieza (PRs
cerrados sin merge, ramas remotas eliminadas, issues fixture `not planned`,
cero worktrees) se ejecuto el 2026-09-21T08:58:07-05:00. El paso 5 de esa
limpieza (restaurar la instalacion previa `0.38.1` / `a48e6870`) no se aplico
por decision humana declarada en la fila "Limpieza" de #1435: `0.38.2` se
conservo por ser la release vigente, con la instalacion previa registrada para
el rollback. No afecta el veredicto: la identidad no cambio durante la sesion.

### Desviacion de fixture: justificada (CA-4 de #1487)

El intento 2 (run-id `20260921-073646-v0.38.2`, fixtures #34 y #36, unica
evidencia que este veredicto juzga) uso fixtures con una seccion
`## ADRs aplicables` que el template literal del intento 1 no traia. Esa
adicion **no es una desviacion que invalide la evidencia**: corrige un defecto
del template frente a la doctrina que ya rige la escritura real.
`agents/implementer.md`, paso "1b. Leer los ADRs aplicables del issue", exige
que todo issue declare esa seccion antes de escribir codigo y, si esta ausente
o vacia, ordena al implementer detenerse y reportar el gap en
`blockage-report.md` en vez de continuar; `agents/planner.md` (paso 7 de "Crear
issues") exige igualmente que el planner la enumere en cualquier issue que
redacte. El defecto era del template (hallazgo no bloqueante capturado en
#1560), no de `tdd-pipeline.mts` ni de los agentes que lo ejecutan.

El intento 1 (run-id `20260921-062538-v0.38.2`) corrio sobre ese template
literal y el implementer continuo sin la seccion, apartandose de su doctrina.
Queda citado aqui unicamente como antecedente de por que la seccion se agrego,
nunca como evidencia: la unica que este veredicto juzga para CA-1 a CA-6 del
protocolo es el intento 2.

### Veredicto (CA-5 de #1487)

**PASA (2026-09-22), release `v0.38.2`.** Causa: las dos corridas (write-side y
read-side) exigidas por #1435/#1436 tienen evidencia real y correlacionable
-- fixture, PR con `Closes`, session id y resultado de Stage 1/2/2b/3/4 -- con
identidad de release identica, observabilidad correlacionada por expediente,
centinelas en cero y baseline restaurado exactamente al mismo SHA. La unica
desviacion (la seccion `## ADRs aplicables` agregada en el intento 2) se juzga
arriba como **desviacion justificada**, atribuible a un defecto del template y
no del pipeline certificado.

Este `PASA`:

- Otorga a `/mefisto:implement` (rutas write-side y `tipo:projection`) soporte
  certificado bajo Claude Code, unicamente en esas dos rutas normales;
  `--scaffold-domain`, `--from-stage`, `--variant` y la remediacion de coverage
  no ejercida permanecen fuera de este veredicto y requieren un protocolo
  propio para certificarse.
- No abre ningun bug nuevo: no hay causa de `NO PASA` que reportar. Los
  hallazgos no bloqueantes del mismo expediente ya quedaron capturados como
  drafts independientes -- #1560, #1561, #1562, #1563 -- fuera del alcance de
  este veredicto.
- Cierra la dependencia que "Bloqueo estructural de la ejecucion automatizada
  (#1464)" declara sobre el issue de veredicto (su paso 4).

**Alcance de lo que este veredicto juzga.** Cubre unicamente las rutas
write-side y `tipo:projection` normales de `/mefisto:implement` sobre la
release `v0.38.2`. No certifica `--scaffold-domain`, `--from-stage`,
`--variant`, la remediacion de coverage no ejercida ni `/mefisto:tooling`.

## Referencias

- [#1487](https://github.com/augusto-romero-arango/eda-evsourcing-azure-harness/issues/1487):
  issue de veredicto que audita la sesion humana de #1464 y emite `PASA` sobre
  las corridas reales de #1435/#1436.
- `docs/testing/infra-consumer-certification.md`: catalogo de centinelas que
  este protocolo reutiliza.
- `docs/testing/herdr-workspace.md`: fila y labels de `herdr-workspace.mts`
  desde los que se lanzan las corridas.
- MEF-ADR-0011: Definition of Ready por tipo de issue; fija las secciones
  criticas de los dos templates de fixture.
- MEF-ADR-0019: separacion publicado/interno; los issues y PRs fixture se
  gestionan exclusivamente desde el consumidor.
- MEF-ADR-0025: custodia de secretos por runtime; ningun manifiesto de este
  protocolo persiste credenciales, prompts o auth stores.
- MEF-ADR-0031: un gate exige evidencia ejecutable y repetible, no presencia
  de archivos generados.
- MEF-ADR-0033/MEF-ADR-0034/MEF-ADR-0035: Skill `projections` y doctrina
  read-side (recetas de proyeccion, read model canonico, read APIs
  tenant-scoped) que la corrida read-side debe descubrir y aplicar; el worker
  de proyecciones compartido de MEF-ADR-0034 es la razon de que la corrida
  read-side no se lance en paralelo con la write-side.
- MEF-ADR-0050: toda operacion nace neutral a runtime; este protocolo verifica
  `/mefisto:implement` bajo el adaptador `claude`.
- MEF-ADR-0053, seccion 6: gate reproducible de corte vertical que este
  protocolo aplica a `/mefisto:implement`.
- [#1464](https://github.com/augusto-romero-arango/eda-evsourcing-azure-harness/issues/1464):
  rastrea la ejecucion real de las corridas de #1435/#1436.
