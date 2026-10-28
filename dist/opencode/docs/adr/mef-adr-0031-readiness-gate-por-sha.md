# MEF-ADR-0031: Readiness gate por SHA (deploy -> smoke)

- **Fecha**: 2026-07-19
- **Estado**: aceptado
- **Aplica a**: `domain-scaffolder` (templates `deploy-*.yml`, `smoke-tests-dominio.yml`, endpoint `/api/version`, `Fixtures/ApiFixture.cs`); y, desde la seccion 5 (issue #462), `projections-scaffolder` (Dockerfile del worker de proyecciones, seam `ConfiguracionObservabilidadProjections`, `deploy-projections.yml`). Desde la seccion 6 (issue #671) suma el endpoint dedicado `/api/ready` (cobertura de la capa de datos) y el paso de poll correspondiente en `smoke-tests-dominio.yml`; la materializacion de ese alcance en `domain-scaffolder` es el issue #675 (bloqueado por este). La enmienda del presupuesto de `/api/version` se materializa separadamente en `domain-scaffolder` (issue #1273) y `mcp-scaffolder` (issue #1274), conservando sus implementaciones deliberadamente distintas. Cross-referencia MEF-ADR-0013 (smoke tests, contexto relacionado, no enmendado), MEF-ADR-0006 (naming del endpoint), MEF-ADR-0009 (mensajes `.resx` por handler, ancla el cuerpo diagnosticable de `/api/ready`), MEF-ADR-0018 (heuristicas de evolucion, ancla el no-cache sin parametro y la propagacion separada), MEF-ADR-0020 (hosting, ancla `WEBSITE_RUN_FROM_PACKAGE`, el piso de SKU y el default `always_on = true`), MEF-ADR-0034 (worker de proyecciones sin ingress, seam de observabilidad que consume la seccion 5, y doctrina de compatibilidad de configuracion Marten que motiva diferir la Alt 5) y MEF-ADR-0048 (extiende este gate a los Function Apps MCP sin fijar un presupuesto propio).

## Contexto

El scaffold genera un job de smoke tests cuya unica compuerta previa era que `/api/health` devolviera
HTTP 200. `/api/health` es un endpoint estatico: responde 200 sin importar que version del codigo esta
sirviendo el host.

El paso `Deploy to Azure Functions` (`Azure/functions-action`) reporta exito al **subir** el paquete a
Azure, no cuando el runtime ya sirve el codigo nuevo. Con `WEBSITE_RUN_FROM_PACKAGE=1` (fijado por
`infra-base-scaffolder` en el modulo `function-app`, ver MEF-ADR-0020), la documentacion oficial
confirma que cada deploy dispara un reinicio del host: *"When a deployment occurs, a restart of the
function app is triggered"* **[1]**. Ese reinicio/swap tarda segundos, y durante la ventana el host
sigue respondiendo 200 en `/api/health` con el codigo **viejo**.

El job de smoke arrancaba inmediatamente despues de que `Deploy to Azure Functions` reportara exito,
sin ninguna gate consciente de esa ventana: el gate abria contra codigo viejo y el smoke corria antes
de tiempo -> **falso rojo**. Evidencia empirica del incidente real en el consumidor
`Bitakora.ControlAsistencia` (issue #224): deploy fin `00:54:13Z` -> smoke inicio `00:54:18Z` (5
segundos despues), paquete nuevo vivo recien ~`00:55` (casi un minuto de ventana).

Este ADR promueve al harness el fix ya validado en ese consumidor (issue #325): un readiness gate
consciente de la version desplegada, generado por el scaffold, para que todo dominio nuevo lo tenga
por defecto.

La evidencia posterior invalida el margen original de 120 s. En el run [34722573915](https://github.com/augusto-romero-arango/Bitakora.ControlAsistencia/actions/runs/34722573915) del consumidor `Bitakora.ControlAsistencia`, para el SHA `bf0e7c1375a236004e2cff9c12b24dee5f90a5aa`, el deploy termino a las `22:26:17Z`; el primer contenedor termino con exit code `134`; App Service marco fallido el startup probe a las `22:29:01Z`, reintento a las `22:30:36Z` y el mismo artefacto quedo sano alrededor de las `22:31:26Z`. El gate agoto sus 120 s al fallar el primer intento, aunque el deploy no tenia un defecto permanente: el contenedor anterior seguia sirviendo el SHA viejo durante la recuperacion.

La documentacion de App Service para Linux fija `WEBSITES_CONTAINER_START_TIME_LIMIT` en 230 s por defecto (rango 10-1800) y establece que, si el contenedor no queda listo dentro de ese limite, la plataforma falla ese intento y lo reintenta **[10]**. El presupuesto debe cubrir un reintento de la plataforma, no solo el primer arranque.

## Decision

### 1. Hornear el SHA del commit en el ensamblado al compilar, no al publicar

`deploy-{kebab}.yml` agrega `-p:SourceRevisionId=<sha resuelto>` al paso `dotnet build` del job
`deploy` (nunca al paso `Publish`, que corre con `--no-build` y no vuelve a compilar nada).

**Mecanismo verificado contra fuente oficial**: desde el SDK de .NET 8, `IncludeSourceRevisionInInformationalVersion`
(default `true`) hace que el valor de `SourceRevisionId` se agregue al atributo de ensamblado
`AssemblyInformationalVersion` **[2][3]**. El target `AddSourceRevisionToInformationalVersion`
(`Microsoft.NET.GenerateAssemblyInfo.targets`, `dotnet/sdk`) concatena con `+` si el valor de
`InformationalVersion` todavia no contiene uno (nuestro caso: `{Version}+{SourceRevisionId}`), o con
`.` si ya lo contiene -- sigue las reglas de SemVer 2.0 **[4]**. El SDK ya popula `SourceRevisionId`
automaticamente via Source Link cuando detecta el repo git, pero fijarlo explicito por MSBuild
(`-p:SourceRevisionId=...`) es mas robusto que depender de esa auto-deteccion en el runner de CI (que
hace checkout superficial) y, sobre todo, mas robusto que un app setting `DEPLOYED_SHA`: un app
setting se actualiza en un ciclo de reinicio **distinto** al del swap del paquete y podria dar falso
positivo (el setting ya reporta el SHA nuevo mientras el binario todavia sirve el viejo).

**El SHA horneado usa la misma expresion que el `ref:` del checkout, no `github.sha` a secas**:
`${{ github.event.workflow_run.head_sha || github.sha }}`. En un run disparado por `workflow_run`
(el encadenamiento tras `Infra CD`, MEF-ADR-0022), `github.sha` no es el commit que este run esta
construyendo -- es la punta de la rama por defecto en el momento del evento `workflow_run`, que puede
diferir del commit que el `apply` de infra acaba de mergear. Hornear `github.sha` a secas horneria un
SHA que no corresponde al binario que en verdad se esta construyendo y desplegando en ese run, dejando
el gate del punto 3 en timeout permanente para ese disparador. Usar la misma expresion que ya resuelve
el `ref:` del `actions/checkout` de ese job garantiza que el SHA horneado siempre sea el del commit
efectivamente compilado.

### 2. Endpoint HTTP nuevo y dedicado `/api/version`

`domain-scaffolder` genera `VersionCheck.cs` en la raiz del proyecto (mismo nivel que `HealthCheck.cs`):
un trigger HTTP anonimo (`[Function("version")]`, convencion de naming de MEF-ADR-0006, mismo patron
que `[Function("health")]`) que lee el SHA de su **propio ensamblado**
(`Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()`) y
extrae la subcadena posterior al primer `+`.

`/api/health` (`HealthCheck.cs`) **queda intacto**: sigue siendo la unica verificacion de liveness
basica del host. `/api/version` es exclusivamente el mecanismo del gate por version; ambos endpoints
coexisten con responsabilidades distintas.

### 3. Warmup por poll contra `/api/version`, no una unica llamada 200

`Fixtures/ApiFixture.cs` (el "warmup" del proyecto de smoke tests) deja de conformarse con un unico
`GET /api/health == 200`. Cuando el smoke test run recibe un `Api:ExpectedSha` (ver punto 4), hace poll
de `/api/version` hasta que el `sha` de la respuesta coincida con el esperado o se agote un presupuesto
total de **420 s medidos por reloj**, con intervalo de 5 s. El presupuesto cubre exactamente un ciclo de
reintento: 230 s del startup limit de App Service + ~95 s de teardown/reinicio observados + 92 s del peor
swap sano observado = ~417 s, redondeados a 420 s. Tolera `HttpRequestException` y respuestas HTTP
transitorias durante el reinicio del host (el swap puede dejar el endpoint momentaneamente inalcanzable o
el contenedor anterior puede responder el SHA viejo), y reintenta hasta el timeout.

El criterio de exito no cambia: solo abre cuando el SHA observado coincide con el esperado; ampliar el
presupuesto sin conservar esa identidad convertiría la compuerta en un liveness check y reabriria el
falso verde que este ADR corrige. Al agotar los 420 s, el error debe informar el SHA esperado, la ultima
respuesta o SHA observado y la ruta manual de diagnostico
`https://<app>.scm.azurewebsites.net/api/vfs/LogFiles/StartupLogs/`. Consultar Kudu activamente queda
fuera de alcance: requiere OIDC, permisos y parsing de logs anexados. Tampoco se falla rapido ante el
primer startup fallido, porque App Service puede reintentar el mismo artefacto automaticamente **[10]**;
necesitar mas de un reintento sigue siendo un fallo que debe salir rojo.

La doctrina se propaga en dos issues separados: #1273 a `domain-scaffolder`, cuyo fixture ya usa un
deadline temporal con intervalo de 5 s, y #1274 a `mcp-scaffolder`, cuya materializacion actual usa un
conteo de 60 intentos con intervalo de 2 s. Esta duplicacion deliberada sigue la heuristica de evolucion
de MEF-ADR-0018: los agentes no se mezclan ni se extrae una abstraccion antes de evidencia de evolucion
conjunta. MEF-ADR-0048 extiende el mecanismo de este ADR a los Function Apps MCP, pero no fija una
duracion propia; por eso #1274 debe adoptar este nuevo presupuesto sin enmendar aquel ADR.

### 4. Fallback a "solo 200" -- correcto solo si ningun deploy concurrente toca el FA bajo prueba

El input `expected_sha` (opcional, `type: string`, `default: ''` -- sintaxis valida de
`on.workflow_call.inputs` **[5]**) se agrega al workflow reutilizable `smoke-tests-dominio.yml` y se
propaga como variable de entorno `Api__ExpectedSha` al proceso de smoke tests (mismo mecanismo de
`Api__BaseUrl` ya existente). `ApiFixture` interpreta un `Api:ExpectedSha` vacio o ausente como
"degradar a solo 200 contra `/api/health`".

**La invariante que sostiene ese fallback, no nombrada en la version original de este ADR**: solo
puede gatear por version quien despliega el Function App que prueba, porque solo ese invocador tiene
un SHA propio que esperar en `/api/version`. Que `expected_sha` llegue vacio dice unicamente "este
invocador no tiene un SHA al que atarse" -- no dice nada sobre si **otro** deploy, de otro workflow,
esta tocando el mismo FA en ese instante. "Solo 200" es benigno unicamente cuando **ningun** deploy
concurrente toca el FA bajo prueba; cuando si lo hay, degradar a "solo 200" reintroduce exactamente el
falso verde que motiva este ADR -- `/api/health` responde 200 con el binario viejo mientras el deploy
ajeno todavia esta en vuelo (issue #604, diagnosticado en el consumidor `Bitakora.ControlAsistencia`:
4 de 4 corridas de `Deploy Projections` se solaparon con el `Deploy ControlHoras` concurrente que
desplegaba el FA bajo prueba, con ventanas de 7 a 31 segundos entre el fin del deploy ajeno y el
arranque del smoke).

Quien pasa `expected_sha`, y cuando, distingue **tres** clases de invocador -- la version original de
este ADR solo nombraba dos:

- **`deploy-{kebab}.yml` (job `smoke-tests`, encadenado tras un deploy real)**: pasa
  `expected_sha: ${{ needs.deploy.outputs.sha }}`, el mismo SHA horneado en el punto 1 (job output del
  `deploy`, para no duplicar la expresion). Esto cubre los tres disparadores de este workflow (`push`,
  `workflow_run` tras `Infra CD`, y `workflow_dispatch` manual del propio deploy): los tres saben con
  certeza que SHA acaban de construir y desplegar en ese mismo run, asi que el gate es siempre
  significativo, nunca degradado -- esta clase cumple la invariante por construccion.
- **`smoke-tests.yml` (global, Paso 6.2 -- `workflow_dispatch` manual o `schedule` diario, MEF-ADR-0013)**:
  no pasa `expected_sha` en absoluto. Este workflow no esta atado a ningun deploy que acabe de ocurrir
  -- es una verificacion periodica de salud de todos los dominios registrados -- asi que no hay un "SHA
  del deploy" real que darle. Pero su `schedule` cron corre desatendido: una corrida puede caer sobre
  un deploy real en vuelo sin que nadie la este mirando, rompiendo la invariante en la practica aunque
  el workflow en si no dispare ningun deploy.
- **Un workflow de deploy que prueba un Function App ajeno** (tercera clase; issue #604): un workflow
  que despliega un componente propio pero ejerce la suite de smoke de **otro** dominio, porque el
  componente que despliega no tiene el endpoint HTTP que un smoke test pueda probar. El caso real
  observado es el `deploy-projections.yml` del consumidor `Bitakora.ControlAsistencia`: despliega el
  worker de proyecciones, que corre sin ingress (MEF-ADR-0034 seccion 8), y por eso ejerce la suite de
  un Function App concreto que si tiene proyecciones activas. **La plantilla que emite
  `projections-scaffolder` hoy no tiene job de smoke** (sus jobs son `build-and-test` y `publish`): esa
  tercera clase existe en el marco como forma legitima que un consumidor puede adoptar a mano, y como
  la clase que la guarda de abajo debe cubrir, no como algo que el scaffolder genere. No tiene un SHA
  propio del FA bajo prueba que pasar -- igual que
  `smoke-tests.yml` -- pero, a diferencia de ese global, **si** corre disparado por el mismo push a
  `main` que puede estar desplegando ese FA en paralelo: la carrera no es una posibilidad remota de un
  cron desatendido, es estructural en cada push que toca ambos componentes a la vez.

Las clases 2 y 3 comparten la misma condicion (`expected_sha == ''`) y la misma correccion: un paso
previo al warmup, en `smoke-tests-dominio.yml`, que espera a que termine el **job** `deploy` (nunca el
run completo -- ver la nota de deadlock mas abajo) de cualquier otro run de este mismo commit cuyo
nombre de workflow empiece con `Deploy `. La condicion identifica la clase "no despliego el FA que
pruebo" sin enumerar dominios ni workflows, asi que no crece al scaffoldear un dominio nuevo. Con esa
guarda, "solo 200" vuelve a ser seguro: para cuando el warmup corre, o no hay ningun deploy ajeno
tocando el FA, o ya termino -- la invariante que este ADR no nombraba queda restaurada por
construccion en vez de asumida.

**Por que el job, nunca el run completo.** El run ajeno (p. ej. el propio `deploy-{kebab}.yml` del FA
bajo prueba) corre su propio job de smoke tests **despues** de su `deploy`: esperar el run entero es
esperar una suite que no gatea nada del lado que espera. Y en cualquier repo que serialice los smoke
con un grupo `concurrency` -- lo hace el consumidor de origen con `smoke-tests-dev`; las plantillas
del marco no declaran ninguno -- es directamente un **deadlock**, no una carrera que a veces se
pierde: el job de smoke del run ajeno no puede arrancar hasta que el job que espera libere el grupo, y
ese job no termina hasta que el run ajeno complete. Un job `deploy` con conclusion `skipped` (el caso
de `determinar-alcance` cuando el PR no toco ese dominio) ya reporta `status: completed`, asi que no
bloquea, sin codigo extra. Si un run ajeno no expone ningun job llamado `deploy`, la guarda falla
explicitamente (`::error::` + exit distinto de cero) en vez de asumir que ya termino: degradar en
silencio ante una consulta que no devuelve lo esperado reintroduce la carrera sin dejar ninguna senal
de que la guarda dejo de ver a ese invocador.

**El precio de fallar en vez de adivinar: el filtro de runs tiene que ser exacto.** Como un run
`Deploy *` sin job `deploy` aborta la guarda, todo workflow del marco que comparta ese prefijo de
nombre **sin** desplegar una Function App debe quedar fuera del filtro. Hoy hay exactamente uno:
`Deploy Projections Worker` (`.github/workflows/deploy-projections.yml`, `projections-scaffolder`),
que publica la imagen del Container App del worker (jobs `build-and-test`/`publish`) y no toca ningun
FA -- la guarda no tiene ningun job `deploy` que esperar de el. La guarda lo excluye por su `path`
exacto, no por su nombre: el path lo genera el scaffolder, el `name:` es texto libre que el consumidor
puede editar. Sin esa exclusion, cada corrida de smoke con `expected_sha` vacio que coincidiera con
una publicacion del worker del mismo commit moriria en `exit 1` por un run sin job `deploy`.

**La espera del worker de proyecciones es una correccion distinta de la guarda (issue #2469).** Los
`paths` de `deploy-{kebab}.yml` y de `deploy-projections.yml` comparten `DomainEvents/**` y
`global.json`: un mismo push dispara ambos, y los tests del smoke que leen vistas materializadas por
el worker pueden correr contra su revision vieja o en pleno cambio de revision. Por eso
`smoke-tests-dominio.yml` lleva un paso propio, "Esperar la publicacion del worker de proyecciones del
mismo commit", **sin condicion**: aplica a toda clase de invocador, tambien a `deploy-{kebab}.yml`
(clase 1), que es justo la del sintoma y que la guarda no cubre porque solo corre con
`expected_sha == ''`. El paso va antes de la guarda y:

- busca los runs del commit cuyo `path` (sin `@ref`) es `.github/workflows/deploy-projections.yml`,
  excluyendo el run propio, y espera hasta que su job `publish` tenga `status == completed`; si el job
  aun no existe y el run no termino, lo trata como en vuelo;
- el commit buscado es `inputs.expected_sha` cuando llega no vacio y `github.sha` en otro caso: en un
  `deploy-{kebab}.yml` disparado por `workflow_run`, `github.sha` no es necesariamente el commit
  desplegado (seccion 1);
- sin run del worker, o con `publish` ausente o `skipped` en un run terminado, continua sin aviso; con
  `publish` en `failure` o `cancelled` continua con `::warning::` que indica que la suite corre contra
  la revision anterior del worker (el fallo ya se ve en rojo en el run del worker y no debe tumbar el
  smoke del write-side); tras 120 intentos de 5 s falla con `::error::` y `exit 1`;
- espera el job, nunca el run, por la misma razon de deadlock de la guarda; y no pide permisos nuevos
  (`actions: read` ya cubre la consulta).

El worker es un Container App sin ingress (MEF-ADR-0034 seccion 8), asi que su revision solo se observa
por la API de Actions, a traves del job `publish`; que ese job termine solo con la revision lista
corriendo la imagen del SHA lo garantiza el poll de la seccion 5.

**Permisos del token (`actions: read`).** La guarda consulta la API de Actions
(`GET /repos/{owner}/{repo}/actions/runs` y `.../jobs`), que requiere el scope `actions: read` en el
`GITHUB_TOKEN` del job que la ejecuta. Un workflow llamado (`uses:`) no puede pedir mas permisos que
los que su invocador concede en el job que hace esa llamada -- sin esa concesion explicita, el run
muere en `startup_failure` antes de crear un solo job, sin ninguna annotation que lo explique
(verificado en un run real del consumidor de origen). La concesion va a nivel de **job**, no de
workflow completo, para no alterar los permisos de otros jobs del mismo workflow que ya declaran los
suyos (`pull-requests: read` de `determinar-alcance`, `id-token: write` de `deploy`).

### 5. Extension al read-side: el worker de proyecciones hornea el mismo SHA, pero lo consume `service.version` de OpenTelemetry, no un endpoint HTTP (issue #462)

Los puntos 1-4 asumen una Function App con un endpoint HTTP que un smoke test puede consultar tras
el deploy. El worker de proyecciones (`{RootNamespace}.Projections`, MEF-ADR-0034) no tiene esa
opcion: corre **sin ingress** (MEF-ADR-0034 seccion 8), asi que ningun smoke test ni humano puede
hacerle una peticion HTTP para preguntarle que SHA esta sirviendo. Se reutiliza el **mismo
mecanismo de horneado** del punto 1 (`SourceRevisionId` -> `AssemblyInformationalVersionAttribute`),
pero el **consumidor** cambia: en vez de un endpoint HTTP dedicado, es el atributo de recurso
`service.version` que el seam de observabilidad del worker (`ConfiguracionObservabilidadProjections`,
MEF-ADR-0034 seccion 10) agrega a cada traza exportada a Application Insights -- la unica via de
atribucion posible para ese proceso, mismo rol que cumple `/api/version` para el write-side.

**El valor es el SHA a secas, extraido con el mismo patron del punto 2.** El seam lee
`AssemblyInformationalVersionAttribute` por reflexion y toma la subcadena posterior al `+` --
identico a lo que hace `VersionCheck.cs` para responder `/api/version` --, no el
`InformationalVersion` completo: asi `service.version` queda byte a byte igual al tag
`projections:{sha}` con el que `deploy-projections.yml` publica la imagen, y correlacionar una traza
con la imagen desplegada no necesita ninguna traduccion. Sin el separador `+` (build local sin
`--build-arg`) degrada a la version desnuda (`1.0.0`) en vez de a `null` como devuelve el endpoint
del punto 2 -- unica diferencia deliberada entre ambos: un `serviceVersion` null **omite** el
atributo del recurso, y la telemetria no distinguiria "el seam no corrio" de "el SHA no se horneo".
Ese valor desnudo es, por si mismo, el modo de falla a vigilar. En Application Insights el atributo
aterriza en la propiedad **Application Version** (columna `application_Version` de las tablas de
Logs) **[7]**: ahi se verifica el circuito, no en `customDimensions`.

**Se hornea en `dotnet publish`, no en `dotnet build` (a diferencia del punto 1).** El worker
publica dentro de un Dockerfile multi-stage (`projections-scaffolder`, Paso 2): la etapa `build`
corre `dotnet build ... -o /app/build`, cuya salida **no** llega a la imagen final -- esta copia el
resultado de la etapa `publish`, que corre `dotnet publish` **sin** `--no-build` (recompila desde el
codigo fuente copiado al build context). El comando que efectivamente produce el ensamblado
embarcado en la imagen es entonces ese `dotnet publish`, no el `dotnet build` de la etapa anterior:
por eso el Dockerfile declara `ARG SOURCE_REVISION_ID` en la etapa `publish` (lo mas tarde posible,
para no invalidar el cache de capas del `restore`/`build` de la etapa previa) y lo pasa como
`-p:SourceRevisionId=$SOURCE_REVISION_ID` a ese `dotnet publish`. Con el `ARG` en su default vacio
(`docker build` local sin `--build-arg`), la propiedad `SourceRevisionId` queda vacia y el target de
MSBuild `AddSourceRevisionToInformationalVersion` se salta por completo (`Condition="'$(SourceRevisionId)'
!= ''"`, verificado por lectura de fuente del mismo target que cita el punto 1) -- no deja un `+`
colgante, `InformationalVersion` cae de vuelta a la version desnuda.

Las dos mitades del parrafo anterior estan **verificadas empiricamente** contra el SDK `10.0.201`
(linea `10.0`, la que sirve el tag flotante `mcr.microsoft.com/dotnet/sdk:10.0` del Dockerfile), no
solo por lectura del target: con `-p:SourceRevisionId=` vacio, `InformationalVersion` queda en
`1.0.0` sin `+`; y un `dotnet publish -p:SourceRevisionId=<sha>` ejecutado **despues** de un
`dotnet build` sin la propiedad -- el orden exacto de las dos etapas del Dockerfile -- vuelve a
compilar y hornea `1.0.0+<sha>` en el ensamblado publicado. Esto ultimo es lo que no era obvio: un
build incremental podria haber reusado el ensamblado de la etapa anterior y dejado el SHA fuera en
silencio. No lo hace, porque el `AssemblyInfo` generado cambia y arrastra la recompilacion.

`deploy-projections.yml` (issue
#453) pasa `--build-arg SOURCE_REVISION_ID=${{ github.sha }}` en su paso `docker build`, reutilizando
el mismo valor con el que ese workflow ya taggea la imagen del ACR: por construccion, el tag de la
imagen desplegada y el `service.version` que reporta la telemetria quedan identicos, sin tabla de
traduccion.

**`github.sha` a secas, no la expresion larga del punto 1.** El punto 1 usa
`${{ github.event.workflow_run.head_sha || github.sha }}` porque `deploy-{kebab}.yml` se encadena
tras `Infra CD` via `workflow_run` (MEF-ADR-0022), disparador en el que `github.sha` no es
necesariamente el commit que ese run esta construyendo. `deploy-projections.yml` **no** se encadena
asi -- su trigger es `push` a `main` mas `workflow_dispatch` (MEF-ADR-0034 seccion 8) --, asi que
`github.event.workflow_run.head_sha` seria siempre nulo ahi: usar la expresion larga solo
sugeriria un encadenamiento inexistente. `github.sha` a secas es correcto especificamente porque
este workflow no tiene ese disparador, no porque el punto 1 estuviera sobre-especificado.

**Poll acotado en el propio `publish` (issue #2474).** El worker no expone un endpoint de version,
pero si tiene una ventana entre que `az containerapp update` responde y la revision nueva queda
lista: con `revision_mode = "Single"` (MEF-ADR-0034 seccion 8) la revision anterior sigue activa
hasta entonces (*"The existing active revision isn't deactivated until the new revision is ready"*,
[Update and deploy changes in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/revisions#zero-downtime-deployment)),
y el worker que proyecta sigue siendo el viejo. El job `publish` de `deploy-projections.yml` espera
con un poll de 120 intentos de 5 s (10 min): cada intento lee `properties.latestRevisionName` y
`properties.latestReadyRevisionName` del Container App
([REST Container Apps - Get](https://learn.microsoft.com/rest/api/resource-manager/containerapps/container-apps/get))
y la imagen de esa revision (`az containerapp revision show`). Es exito solo cuando
`latestReadyRevisionName == latestRevisionName` y la imagen es exactamente
`<login_server>/projections:<sha>`. Falla de inmediato si la revision mas nueva reporta
`provisioningState` o `runningState` en `Failed`
([REST Revisions - Get](https://learn.microsoft.com/rest/api/resource-manager/containerapps/container-apps-revisions/get-revision))
o si la imagen sigue siendo el placeholder, y falla al agotarse el presupuesto. `properties.active`
en lectura unica no sirve: la revision mas nueva puede figurar activa mientras aun se aprovisiona.
El criterio es "revision nueva lista", no "read models al dia". La verificacion del circuito del
SHA en telemetria sigue siendo por Application Insights, documentada en `projections-scaffolder.md`.

### 6. Extension a la capa de datos: endpoint dedicado `/api/ready` (issue #671)

Los puntos 1-4 fijan que el binario correcto sirve HTTP, pero ninguna de sus compuertas abre una
conexion contra Postgres: `/api/health` es estatico (siempre 200) y `/api/version` lee un atributo de
su propio ensamblado por reflexion, sin tocar el event store. Hasta esta enmienda la capa de datos no
figuraba en ninguna parte de este ADR -- ni en la decision ni en sus consecuencias --: era un **hueco de
cobertura**, no un tradeoff evaluado y aceptado. Sin una compuerta que la anticipe, la primera peticion
que abre una conexion real contra Marten es el arrange de un smoke test -- exactamente lo que produjo el
incidente de origen del consumidor `Bitakora.ControlAsistencia` (`TimeoutException` de Npgsql a los
35.3s, ventana de indisponibilidad del write-path de ~74s, 2026-08-15, su issue #399).

**Tercer endpoint dedicado, nunca `/api/health` enriquecido.** `domain-scaffolder` genera
`ReadyCheck.cs` (`[Function("ready")]`, mismo nivel que `HealthCheck.cs`/`VersionCheck.cs`, convencion
de naming de MEF-ADR-0006) como endpoint HTTP anonimo nuevo -- la propagacion de este alcance a sus
templates es el issue #675, bloqueado por esta enmienda --, no como un enriquecimiento de
`/api/health`: la Alt 2 de este mismo ADR ya descarto mezclar liveness con otra semantica en un mismo
endpoint, y esta enmienda extiende ese precedente a la capa de datos en vez de reabrirlo. `/api/health`
y `/api/version` quedan intactos; `/api/ready` es exclusivamente el mecanismo de readiness de la capa
de datos.

**El fundamento no es el incidente de 74s -- esa ventana ya la cerro `always_on`.** El consumidor de
origen habilito `always_on` en sus tres Function Apps de dev el 2026-08-16 23:07 UTC (su issue #400),
**13.5 horas antes** de que el deploy de `/api/ready` llegara a produccion (2026-08-17 12:35 UTC): el
gate entro en servicio cuando la condicion que lo motivo ya no existia en ese entorno. MEF-ADR-0020,
enmendado por el issue #652 (en `main` desde 2026-08-17), generaliza ese `always_on = true` como default
unico del marco -- sin distincion dev/prod -- y lo cablea hasta `site_config.always_on`, asi que todo
dominio que el marco scaffoldee nace sin esa ventana. En el primer deploy real posterior al merge del
gate, los tres dominios de dev respondieron `/api/ready` en ~0-1s, con 183 smoke tests en verde. Citar
el incidente de ~74s como motivacion de esta enmienda seria una narrativa que los propios hechos
posteriores refutan.

El fundamento que si sostiene la enmienda es **defensa en profundidad de bajo costo**, apoyado en dos
hechos verificados independientes de esa narrativa:

- Aun con `always_on`, **un deploy crea una instancia nueva que arranca en frio**: evidencia del
  dominio Programacion del consumidor, 18 intentos de poll (~36s) esperando que el SHA nuevo
  respondiera, y aun asi `/api/ready` respondio en ~1s una vez arrancada la instancia -- el endpoint no
  le agrega costo al arranque frio, solo lo hace visible.
- El escenario donde el patron efectivamente se paga es el **primer deploy de un dominio nuevo contra
  una base sin esquema materializado** (Marten creando los objetos de schema del event store por
  primera vez) -- exactamente lo que produce `domain-scaffolder` por definicion cada vez que un
  consumidor scaffoldea un dominio.

El costo medido con esquema ya materializado es ~1s, y no es un cache escondiendo el trabajo:
`EventStoreReadinessProbe` no cachea el resultado positivo (ver mas abajo), cada llamada ejecuta
`FetchStreamStateAsync` de verdad. Y `always_on` **no es una garantia universal que vuelva el patron
redundante**: el tier Consumption (Y1) no lo soporta, y aunque MEF-ADR-0020 proscribe Y1 para el marco,
un consumidor puede desviarse de esa proscripcion documentandola -- el endpoint sigue siendo la unica
compuerta que cubre ese desvio.

**Semantica del endpoint fijada por esta enmienda:**

- **Probe**: `IEventStoreReadinessProbe`/`EventStoreReadinessProbe` abre una `IQuerySession` y llama
  `Events.FetchStreamStateAsync(<id centinela inexistente>)`. Un stream que no existe no es un error
  para ese metodo -- retorna `null` --, pero la ruta de esa llamada pasa por la verificacion **perezosa**
  de storage de Marten (`IMartenDatabase.EnsureStorageExistsAsync`: *"Ensures that the IDocumentStorage
  object for a document type is ready and also attempts to update the database schema for any detected
  changes"*), que ocurre en el primer uso del tipo y no en un paso de arranque **[8]**. La llamada fuerza
  esa materializacion sin necesidad de que el stream centinela exista ni de leer un solo dato real de
  ningun dominio.
- **Sin cache del positivo, por doctrina fija del marco (sin parametro)**: cada invocacion de
  `/api/ready` ejecuta el probe de nuevo. Cachear el resultado positivo degradaria la semantica a "el
  store llego a estar listo alguna vez" y esconderia un 503 real si el store cae despues del arranque;
  el unico consumidor de este endpoint es el gate de CI (nunca un humano navegando), y un parametro de
  cache sin un caso de uso que lo necesite contradice la heuristica de MEF-ADR-0018 contra la
  complejidad anticipada. No se agrega ningun `enableCache`/`ttl` -- si algun consumidor mide un costo
  que lo justifique, es una decision para su propio issue.
- **503, no 500, con cuerpo diagnosticable**: `/api/ready` devuelve `503 Service Unavailable` cuando el
  probe falla -- la semantica correcta para "el servidor esta temporalmente incapaz de atender la
  peticion" **[9]**, distinta de un `500`, que senala una condicion inesperada del handler. El cuerpo de
  la respuesta incluye el mensaje de la excepcion capturada (via
  `ReadyCheckMensajes.resx`, mismo patron de mensajes por handler que fija MEF-ADR-0009) para que quien
  lea el log del gate no tenga que correlacionar con Application Insights para saber que fallo.
- **Timeout del poll: 120 s, presupuesto propio de la capa de datos.** El paso de poll que #675
  materializa en `smoke-tests-dominio.yml` espera `/api/ready` durante 120 s. No hereda ni se justifica
  por el presupuesto de `/api/version`: `/api/ready` se ejecuta despues de que el SHA correcto ya abrio
  la compuerta y cubre exclusivamente la disponibilidad de Marten/Postgres, no un reinicio del
  contenedor de App Service.

**Alternativa considerada y diferida, no descartada de raiz: `ApplyAllDatabaseChangesOnStartup`.** Ver
Alt 5.

**Prueba de comprobacion pendiente, anotada para que no se lea como tradeoff medido.** Ningun deploy
del consumidor de origen todavia disparo el escenario que motiva esta enmienda -- el primer deploy de
un dominio **nuevo** contra una base sin esquema materializado; los tres dominios medidos (incluido
Programacion) ya tenian esquema. El log del gate, `Ready OK tras N intento(s) (~Ns)` (que #675 emite en
el paso de poll sin trabajo adicional), es la captura que cierra esa medicion la primera vez que un
consumidor scaffoldee un dominio nuevo con esta enmienda vigente. Hasta entonces, este punto es teorico
-- coherente con el mecanismo de schema de Marten **[8]**, no con una medicion propia -- y se declara
asi.

## Alternativas consideradas

### Alt 1: `sleep` fijo antes del smoke

**Descartada**: fragil (cualquier variacion en la duracion real del swap lo rompe) y no prueba nada --
un `sleep` que "por suerte" alcanza no es una señal de que el codigo nuevo esta sirviendo, solo retrasa
ciegamente el smoke.

### Alt 2: enriquecer `/api/health` con el SHA en vez de un endpoint nuevo

**Descartada**: el issue que origina este ADR fija explicitamente que `/api/health` debe quedar
intacto. Ademas mezclar liveness ("¿el host responde?") con version/readiness ("¿el host sirve el
codigo que espero?") en un mismo endpoint hace mas dificil razonar sobre cada verificacion por
separado y complica cualquier consumidor externo que ya dependa del shape actual de `/api/health`.

### Alt 3: app setting `DEPLOYED_SHA` en vez de hornear en el ensamblado

**Descartada**: un app setting se resuelve/actualiza en un ciclo de reinicio potencialmente distinto
al del swap del paquete (`WEBSITE_RUN_FROM_PACKAGE`) -- podria reportar el SHA nuevo mientras el
binario que efectivamente atiende requests sigue siendo el viejo, dando un falso positivo del gate
(exactamente el problema opuesto al que este ADR resuelve). Hornear el SHA dentro del propio binario
(`AssemblyInformationalVersion`) ata el dato al mismo artefacto que el runtime esta sirviendo: no
puede haber divergencia entre "que SHA reporta" y "que codigo corre".

### Alt 4: slots de despliegue con swap + warmup nativo de Azure App Service

Azure App Service soporta *deployment slots* con swap y warmup nativo, la forma "gold standard" de
evitar servir codigo viejo/a medio desplegar. **Descartada por ahora**: los *staging slots* requieren
el tier **Standard o superior** -- Basic (SKU `B1`, el piso que fija MEF-ADR-0020 para cada plan
dedicado del marco) no soporta ningun slot **[6]**. Adoptarlos exigiria subir de tier a todos los
dominios del marco, un cambio de costo e infraestructura que excede el alcance de este ADR (un fix de
timing del gate CI). Se anota como alternativa valida a evaluar aparte si el marco decide subir el
piso de SKU en el futuro.

### Alt 5: `ApplyAllDatabaseChangesOnStartup` en vez de un endpoint de readiness (issue #671)

Marten expone un mecanismo para materializar el schema completo del store al arrancar el host
(`AddMarten().ApplyAllDatabaseChangesOnStartup()`), en vez de dejar que cada tipo de documento/evento
dispare su propia verificacion en el primer uso **[8]**. Ataca la causa (el schema sin materializar) en
vez de exponer una compuerta que la detecte.

**Diferida, no descartada de raiz.** Es un cambio doctrinal mayor que toca la
compatibilidad de configuracion Marten write-side/read-side que fija MEF-ADR-0034 (los pares que deben
coincidir entre el Function App y el worker de proyecciones), y el consumidor de origen tiene historial
de desajustes de `mt_version` que dejaron GETs en 500 permanente (sus issues #294 y #357) -- exactamente
el tipo de falla que un cambio de arranque de schema puede reintroducir o esconder si no se disena con
cuidado. Evaluarla merece su propio issue, con su propia verificacion contra ese historial; no es
alcance de esta enmienda, que se limita a registrar una compuerta que detecta el sintoma, no a remover
la causa.

## Consecuencias

### Positivas

- **El gate deploy -> smoke prueba lo que dice probar**: el smoke test corre contra el codigo
  efectivamente nuevo, no contra el codigo viejo que todavia responde 200 durante la ventana de swap.
  Elimina la clase de falso rojo documentada en el incidente de origen.
- **Funciona igual en los tres disparadores reales de `deploy-{kebab}.yml`** (`push`, `workflow_run`
  encadenado, `workflow_dispatch` manual): los tres conocen el SHA que acaban de desplegar en su propio
  run, asi que el gate nunca queda degradado quando si hay un deploy real.
- **Degrada con gracia cuando no aplica**: el workflow global de smoke tests (sin un deploy al que
  atarse) seguiria funcionando exactamente igual que antes de este ADR -- no se le exige informacion
  que no tiene.
- **No modifica `/api/health`**: cero riesgo de romper un consumidor externo del liveness check
  existente.
- **El fallback a "solo 200" ya no es una degradacion silenciosa (issue #604)**: cuando `expected_sha`
  llega vacio, la guarda de deploys ajenos garantiza que ningun `deploy-{kebab}.yml` concurrente del
  mismo commit siga tocando el FA bajo prueba antes de dejar correr el warmup -- la invariante que la
  version original de este ADR no nombraba queda restaurada por construccion, no por suerte de timing.
- **Cierra el hueco de cobertura de la capa de datos (issue #671)**: el gate por SHA gana una tercera
  compuerta dedicada que ejercita el event store, ademas de las dos que ya ejercitaban el binario HTTP
  -- ninguna peticion de un test vuelve a ser la primera en tocar Postgres.
- **Defensa en profundidad de costo marginal (issue #671)**: con esquema ya materializado el probe
  cuesta ~1s por llamada (verificado, no cacheado); el costo real solo lo paga el escenario que de
  verdad lo necesita, el primer deploy de un dominio nuevo.

### Negativas

- **El job de smoke puede tardar hasta ~420 s mas** en el peor caso del poll por SHA, cuando antes
  bastaba una sola llamada HTTP. El poll independiente de `/api/ready` conserva su presupuesto de
  hasta 120 s. En el caso feliz (swap ya completado) el costo adicional es
  minimo -- unos pocos ciclos de poll de 5s.
- **Depende de que el SDK de .NET siga soportando `SourceRevisionId`/`AssemblyInformationalVersion`**
  como hoy (comportamiento estable desde .NET 8, sin señales de deprecacion, pero es una dependencia de
  la toolchain que este ADR no controla).
- **El workflow global de smoke tests y cualquier deploy que prueba un FA ajeno siguen sin gate por
  SHA propio**: no hay un SHA al que atarse en ese contexto (decision original de este punto,
  deliberada, no un descuido) -- lo que la enmienda del issue #604 agrega es la guarda de deploys
  ajenos, no un SHA sustituto.
- **La guarda de deploys ajenos puede añadir hasta ~10 minutos al job de smoke** en el peor caso (120
  intentos x 5s, issue #604) cuando algun run ajeno nunca termina su job `deploy`. Es un presupuesto
  defensivo propio de esa guarda, distinto de los 420 s del poll por SHA y de los 120 s de `/api/ready`.
- **Depende de tres convenciones de nombres acopladas entre dos agentes (issue #604)**: el prefijo
  `Deploy ` del nombre del workflow de deploy, el nombre exacto `deploy` de su job, y el path del
  workflow del worker de proyecciones que la guarda excluye. Un cambio a cualquiera de las tres sin
  actualizar la guarda de `smoke-tests-dominio.yml` la deja sin ver a un invocador, o la hace abortar
  contra un run que no tenia nada que esperar. Mitigacion doble: la guarda falla explicitamente en vez
  de degradar en silencio, y el bloque `[H]` de `scripts/tests/test-guards.sh` afirma la
  correspondencia entre las plantillas de `domain-scaffolder` y `projections-scaffolder` y los
  literales de la guarda, de modo que la deriva rompe la suite del marco en vez de aparecer como un
  rojo intermitente en el consumidor.
- **La guarda se ancla al `head_sha` del run que la ejecuta**, asi que solo ve deploys **de ese mismo
  commit**: en la corrida global por `schedule`, un deploy disparado por un push posterior al arranque
  del cron queda fuera del filtro y su carrera sigue abierta. Es un residuo estrecho (la ventana es el
  intervalo entre el disparo del cron y el push siguiente) y cerrarlo pediria esperar deploys de
  cualquier commit, que es otra decision -- se documenta, no se resuelve aqui.
- **El costo real del primer deploy de un dominio nuevo (Marten materializando el schema del event
  store) sigue sin medirse empiricamente (issue #671)** -- ver la nota de comprobacion pendiente de la
  seccion 6; el fundamento de esa seccion es coherente con la documentacion de Marten **[8]**, no
  todavia con una medicion propia.
- **`ApplyAllDatabaseChangesOnStartup` queda diferido, no descartado de raiz (issue #671)**: si el marco
  lo adopta en el futuro, alguien tiene que reconciliarlo con la doctrina de compatibilidad de
  configuracion Marten de MEF-ADR-0034 y con el historial de `mt_version` del consumidor de origen --
  este ADR no resuelve esa tension (Alt 5), solo la nombra.

## Referencias

- **[1]** "Run your functions from a package file in Azure" -- Microsoft Learn. *"When a deployment
  occurs, a restart of the function app is triggered. Function executions currently running during the
  deploy are terminated."*
  https://learn.microsoft.com/azure/azure-functions/run-functions-from-deployment-package
- **[2]** "MSBuild reference for .NET SDK projects" -- Microsoft Learn, seccion "Assembly attribute
  properties": `SourceRevisionId` e `IncludeSourceRevisionInInformationalVersion` (default `true`).
  https://learn.microsoft.com/dotnet/core/project-sdk/msbuild-props#assembly-attribute-properties
- **[3]** "Source Link included in the .NET SDK" -- Microsoft Learn (breaking change, .NET 8 Preview
  4): *"Starting in .NET 8, `InformationalVersion` includes the `SourceRevisionId` property in all
  cases."* https://learn.microsoft.com/dotnet/core/compatibility/sdk/8.0/source-link
- **[4]** Target `AddSourceRevisionToInformationalVersion`,
  `Microsoft.NET.Build.Tasks/targets/Microsoft.NET.GenerateAssemblyInfo.targets` (`dotnet/sdk`,
  codigo fuente publico): concatena `$(InformationalVersion)+$(SourceRevisionId)` si
  `InformationalVersion` no contiene ya un `+`, o `$(InformationalVersion).$(SourceRevisionId)` en
  caso contrario -- sigue las reglas de SemVer 2.0.
  https://github.com/dotnet/sdk/blob/main/src/Tasks/Microsoft.NET.Build.Tasks/targets/Microsoft.NET.GenerateAssemblyInfo.targets
- **[5]** "Workflow syntax for GitHub Actions", seccion `on.workflow_call.inputs.<input_id>` --
  GitHub Docs: claves `type` (requerida), `description`, `default` y `required` (opcionales); un
  input `string` sin `default` explicito vale `""`.
  https://docs.github.com/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_callinputs
- **[6]** "Azure subscription limits and quotas" -- Microsoft Learn, tabla de limites de App Service:
  *Staging slots per app* -- Basic: sin soporte (celda vacia); Standard: 5; Premium/PremiumV2/V3:
  20. https://learn.microsoft.com/azure/azure-resource-manager/management/azure-subscription-service-limits#azure-app-service-limits
- **[7]** "Create and configure Application Insights resources" -- Microsoft Learn, seccion "Version
  and release tracking": la propiedad **Application Version** es la que separa la telemetria de
  builds distintos, y para instrumentacion basada en OpenTelemetry se fija *"by using resource
  attributes"* (es decir, `service.version` -- lo que hace la seccion 5 de este ADR).
  https://learn.microsoft.com/azure/azure-monitor/app/create-workspace-resource#version-and-release-tracking
  La columna destino en las tablas de Logs la nombra explicitamente la nota equivalente de la
  configuracion del agente de Java: *"if you add a custom dimension named `service.version`, the
  value is stored in the `application_Version` column in the Application Insights Logs table"*.
  https://learn.microsoft.com/azure/azure-monitor/app/java-standalone-config#custom-dimensions
- **[8]** "Marten and the PostgreSQL Schema" -- martendb.io (documentacion oficial de Marten): la
  verificacion/creacion automatica de los objetos de schema es **perezosa**, en el primer uso del tipo
  -- *"To prevent unnecessary loss of data, even in development, on the first usage of a document type,
  Marten will: 1. Compare the current schema table to what's configured for that document type"* --,
  gobernada por `StoreOptions.AutoCreateSchemaObjects` y no por un paso de arranque; la misma pagina
  nombra `AddMarten().ApplyAllDatabaseChangesOnStartup()` como la opcion explicita que fuerza esa
  verificacion al arrancar el host (la Alt 5). Es el mecanismo que hace que un `FetchStreamStateAsync`
  sobre un stream centinela dispare la materializacion del schema del event store sin necesidad de datos
  reales (seccion 6). https://martendb.io/schema/
  El punto de entrada de esa verificacion perezosa queda anclado al XML doc del paquete pinneado (mismo
  procedimiento de inspeccion version-anclada que usa la referencia [21] de MEF-ADR-0034):
  `~/.nuget/packages/marten/9.12.0/lib/net10.0/Marten.xml`, miembro
  `M:Marten.Storage.IMartenDatabase.EnsureStorageExistsAsync` -- *"Ensures that the IDocumentStorage
  object for a document type is ready and also attempts to update the database schema for any detected
  changes"*.
- **[9]** RFC 9110 ("HTTP Semantics"), seccion 15.6.4 -- "503 Service Unavailable": el codigo indica que
  el servidor esta **temporalmente** incapaz de atender la peticion (sobrecarga transitoria o
  mantenimiento), a diferencia del `500` de la seccion 15.6.1, que senala una condicion inesperada que
  impidio cumplirla -- el motivo por el que la seccion 6 fija `503` y no `500` para un event store que
  todavia no esta listo. https://www.rfc-editor.org/rfc/rfc9110#section-15.6.4
- **[10]** "Environment variables and app settings in Azure App Service" -- Microsoft Learn,
  `WEBSITES_CONTAINER_START_TIME_LIMIT`: aplica a apps code-based y container-based en Linux; default
  230 s, rango 10-1800 s. Si el contenedor no queda listo dentro del limite, App Service falla el intento
  de startup y lo reintenta. https://learn.microsoft.com/azure/app-service/reference-app-settings
- Bitakora.ControlAsistencia issue #224 (incidente real que origina este ADR: deploy fin `00:54:13Z`
  -> smoke inicio `00:54:18Z`, paquete nuevo vivo ~`00:55`) y field note
  `docs/bitacora/field-notes/2026-07-18-2027-bug-investigation.md` (repo consumidor).
- Bitakora.ControlAsistencia issue #362 (incidente que origina la enmienda de la seccion 4, issue #604
  de este repo: `Deploy Projections` en rojo desde 2026-08-07 porque su job de smoke -- la suite de
  ControlHoras -- corria concurrente con `Deploy ControlHoras`; 4 de 4 corridas solapadas, ventanas de
  7 a 31 segundos). PR de referencia verificado en runner real: `augusto-romero-arango/Bitakora.ControlAsistencia#362`.
- Bitakora.ControlAsistencia issue #399/PR #406 (implementacion de referencia de `/api/ready` que
  origina la seccion 6 de este ADR, mergeada 2026-08-17) y el comentario con la cronologia completa de
  `always_on` y las mediciones del dominio Programacion:
  https://github.com/augusto-romero-arango/Bitakora.ControlAsistencia/pull/406#issuecomment-5316291661
- Bitakora.ControlAsistencia run #34722573915 (SHA
  `bf0e7c1375a236004e2cff9c12b24dee5f90a5aa`): deploy `22:26:17Z`, primer contenedor exit code 134,
  startup probe fallido `22:29:01Z`, reintento `22:30:36Z`, mismo artefacto sano ~`22:31:26Z`.
  https://github.com/augusto-romero-arango/Bitakora.ControlAsistencia/actions/runs/34722573915
- Bitakora.ControlAsistencia field note del 2026-09-12 (evidencia de campo y calculo del presupuesto
  de un reintento). https://github.com/augusto-romero-arango/Bitakora.ControlAsistencia/blob/main/docs/bitacora/field-notes/2026-09-12-1852-planner.md
- MEF-ADR-0013 (smoke tests contra entorno dev): contexto relacionado; este ADR no lo enmienda.
- MEF-ADR-0006 (convenciones de naming de funciones Azure): ancla `[Function("version")]`, mismo
  patron que `[Function("health")]`; y, desde la seccion 6, `[Function("ready")]`.
- MEF-ADR-0009 (mensajes en `.resx` por aggregate/handler): ancla `ReadyCheckMensajes.resx` (seccion 6),
  el cuerpo diagnosticable del 503 de `/api/ready`.
- MEF-ADR-0018 (heuristicas de evolucion y reuso del codigo): ancla la decision de la seccion 6 de no
  agregar un parametro de cache al probe sin un caso de uso que lo necesite y la propagacion separada
  de las dos implementaciones del gate por SHA.
- MEF-ADR-0020 (hosting, un App Service Plan dedicado por dominio): ancla `WEBSITE_RUN_FROM_PACKAGE=1`
  (`agents/infra-base-scaffolder.md`) y el piso de SKU `B1` que descarta, por ahora, la Alt 4
  (deployment slots); y, ya enmendado por el issue #652, el default `always_on = true` que la seccion 6
  cita para reencuadrar su fundamento sin la narrativa del incidente de 74s.
- MEF-ADR-0022 (autenticacion CI por OIDC, orden infra -> deploy): el job `deploy` de
  `deploy-{kebab}.yml` que este ADR modifica, y el disparador `workflow_run` cuyo `github.sha` motiva
  la nota del punto 1 sobre `github.event.workflow_run.head_sha || github.sha`.
- MEF-ADR-0034 (worker de proyecciones y read models): seccion 8 (Container App sin ingress, motivo
  por el que la seccion 5 de este ADR no puede replicar el patron `/api/version`) y seccion 10 (seam
  `ConfiguracionObservabilidadProjections`, el consumidor de `SourceRevisionId` en el read-side); y la
  doctrina de compatibilidad de configuracion Marten write-side/read-side (los pares que deben
  coincidir) que la Alt 5 de la seccion 6 cita como motivo para diferir `ApplyAllDatabaseChangesOnStartup`.
- MEF-ADR-0048 (testing de servidores MCP): extiende el mecanismo de `/api/version` de este ADR a los
  Function Apps MCP sin fijar un presupuesto propio; la propagacion concreta corresponde al issue #1274.

## Control de cambios

- 2026-07-19: creacion como `aceptado` (issue #325). Fija el mecanismo de readiness gate por SHA:
  `SourceRevisionId` horneado en el paso `dotnet build`, endpoint `/api/version` dedicado y anonimo,
  warmup por poll en `ApiFixture` con timeout inicial de 120 s, e input opcional `expected_sha` que
  degrada a "solo 200" cuando no hay un deploy real al que atar el SHA esperado.
- 2026-07-29: suma la seccion 5 (issue #462). Extiende el alcance al read-side: el worker de
  proyecciones (sin ingress, MEF-ADR-0034) reutiliza el mismo mecanismo de horneado de
  `SourceRevisionId`, pero horneado en el `dotnet publish` del Dockerfile (no en `dotnet build`, a
  diferencia del punto 1) y consumido como `service.version` de OpenTelemetry en vez de un endpoint
  HTTP -- el worker no tiene ninguno que exponer. El valor expuesto es el SHA **extraido** con el
  mismo patron del punto 2 (subcadena posterior al `+`), no el `InformationalVersion` completo: asi
  coincide byte a byte con el tag de la imagen del ACR; sin `+` degrada a la version desnuda y no a
  `null`, porque un `serviceVersion` null omite el atributo del recurso y borraria la senal de falla.
  `github.sha` a secas (no la expresion larga del punto 1): `deploy-projections.yml` no se encadena
  por `workflow_run`. Sin poll ni timeout: no hay smoke test que abra una compuerta contra este
  worker. Suma la referencia [7] (propiedad **Application Version** / columna `application_Version`,
  donde aterriza el atributo y donde se verifica el circuito).
- 2026-08-11: enmienda de la seccion 4 y de "Consecuencias" (issue #604). El fallback a "solo 200" no
  es benigno cuando un deploy concurrente del mismo commit toca el FA bajo prueba: nombra la
  invariante que la version original no nombraba ("solo puede gatear por version quien despliega el
  FA que prueba") y la tercera clase de invocador que la viola sin saberlo -- un workflow de deploy
  que ejerce la suite de un FA ajeno porque el componente que despliega no tiene endpoint HTTP propio
  (`deploy-projections.yml`). Agrega la correccion: un paso previo al warmup en
  `smoke-tests-dominio.yml`, condicionado a `expected_sha == ''`, que espera el **job** `deploy`
  (nunca el run completo -- esperar el run es un deadlock, ese run ajeno pide el mismo `concurrency`
  que el job que espera ya tiene tomado) de cualquier run del mismo commit cuyo workflow empiece con
  `Deploy ` -- excluyendo `.github/workflows/deploy-projections.yml`, que comparte ese prefijo pero
  publica el Container App del worker (jobs `build-and-test`/`publish`, ningun FA que esperar) y
  abortaria la guarda por no exponer un job `deploy`. Requiere `actions: read` en el job que hace
  `uses:` de los invocadores (`deploy-{kebab}.yml`, `smoke-tests.yml`, y cualquier deploy de otro
  componente que invoque el reutilizable a mano) y en el propio reutilizable -- sin esa concesion el
  run muere en `startup_failure` sin annotation visible. El acoplamiento de los tres literales de
  nombres queda afirmado por el bloque `[H]` de `scripts/tests/test-guards.sh`.
- 2026-08-17: suma la seccion 6 (issue #671). Cubre el hueco de la capa de datos que este ADR no
  mencionaba en ninguna parte: endpoint dedicado `/api/ready` (`ReadyCheck.cs`, `[Function("ready")]`,
  tercer endpoint, nunca enriqueciendo `/api/health` -- mismo precedente que la Alt 2 de este ADR),
  probe via `FetchStreamStateAsync` sobre un stream centinela inexistente (fuerza la
  verificacion/creacion de schema de Marten sin leer datos reales), sin cache del positivo (doctrina
  fija del marco, sin parametro, MEF-ADR-0018), 503 en vez de 500 con cuerpo diagnosticable
  (`ReadyCheckMensajes.resx`, MEF-ADR-0009), y un timeout de poll de 120 s, que entonces coincidia con
  el presupuesto del punto 3.
  El fundamento es defensa en profundidad de bajo costo (instancia nueva en cada deploy aun con
  `always_on`, MEF-ADR-0020 ya enmendado por #652; y materializacion de esquema en el primer deploy de
  un dominio nuevo) -- explicitamente no la narrativa del incidente de 74s que origino el par de
  issues, cerrada por `always_on` 13.5 horas antes de que el gate llegara a produccion. Registra
  `ApplyAllDatabaseChangesOnStartup` (Alt 5) como alternativa considerada y diferida por su interaccion
  con la doctrina de compatibilidad de configuracion Marten de MEF-ADR-0034 y el historial de
  `mt_version` del consumidor de origen (sus issues #294/#357), y anota explicitamente que la prueba
  de comprobacion del patron (primer deploy de un dominio nuevo sin esquema materializado) sigue
  pendiente, capturable sin trabajo adicional por el log `Ready OK tras N intento(s) (~Ns)` del poll.
  Bloquea la propagacion al `domain-scaffolder` (issue #675). Suma las referencias [8] y [9].
- 2026-09-12: enmienda el presupuesto del poll de `/api/version` (issue #1271) de 120 s a **420 s por
  reloj**, con intervalo de 5 s. Reemplaza la justificacion obsoleta del doble de una ventana de ~1
  minuto por evidencia del run 34722573915 de Bitakora.ControlAsistencia: el primer contenedor fallo
  (exit code 134), App Service reintento el mismo artefacto y este quedo sano despues de que el gate
  anterior ya habia salido rojo. El presupuesto cubre un unico reintento: 230 s del default de
  `WEBSITES_CONTAINER_START_TIME_LIMIT` + ~95 s de teardown/reinicio observado + 92 s del peor swap
  sano = ~417 s, redondeados. Conserva como unico exito la coincidencia del SHA esperado y tolera
  indisponibilidad HTTP transitoria; al timeout exige reportar SHA esperado, ultima respuesta o SHA
  visto y la ruta manual
  Kudu de StartupLogs, sin leerla activamente ni agregar OIDC o parsing. No falla rapido ante el primer
  startup fallido porque la plataforma puede reintentarlo; mas de un reintento sigue saliendo rojo.
  Mantiene `/api/ready` en 120 s como presupuesto independiente de Marten/Postgres, no como "el mismo"
  timeout. Declara la propagacion separada al `domain-scaffolder` (#1273) y al `mcp-scaffolder` (#1274),
  sin mezclar sus implementaciones deliberadamente distintas.
- 2026-10-28: enmienda la seccion 5 (issue #2474). El worker de proyecciones pasa de no tener espera a un
  poll acotado en el job `publish` de `deploy-projections.yml` (120 intentos de 5 s): exito solo con
  `latestReadyRevisionName == latestRevisionName` y la imagen de esa revision igual al tag del SHA
  publicado; falla rapido ante `Failed` o placeholder. Cierra la ventana entre `update` y la revision
  lista, que la lectura unica anterior no cubria.
- 2026-10-28: enmienda la seccion 4 (issue #2469). Se elimina la premisa de que el worker de
  proyecciones no tiene nada que esperar: la exclusion por `path` en la guarda se mantiene (el worker no
  tiene job `deploy`), y la espera del job `publish` del worker del mismo commit pasa a ser un paso
  propio de `smoke-tests-dominio.yml`, sin condicion, para toda clase de invocador, con `::warning::`
  ante `failure`/`cancelled` y `::error::` tras 120 intentos de 5 s.
