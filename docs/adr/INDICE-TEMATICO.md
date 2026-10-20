# Índice temático de ADRs

Migrado desde `CLAUDE.md` (issue de /doctor, limpieza de contexto siempre-cargado): esta tabla
no necesita estar residente en cada sesión, solo cuando se busca en qué ADR vive una doctrina.

> Esta tabla NO se edita a mano por-PR (issue #380): un issue que añade o enmienda un ADR anota su fila como fragmento en `changelog.d/<issue>.adr-index.md` (ver `changelog.d/README.md`), y `/mefisto-release` la consolida aquí en su propia rama de release.

| Tema | ADR |
|---|---|
| Topics de Service Bus por evento | MEF-ADR-0001 |
| Estrategia de testing con event sourcing (Given/When/Then) | MEF-ADR-0002 |
| Stack ES: Marten + Wolverine + Postgres | MEF-ADR-0003 |
| Manejo de errores en ES (eventos de fallo vs excepciones) | MEF-ADR-0004 |
| Naming y versionado de eventos | MEF-ADR-0005 |
| Convenciones de nombramiento de funciones Azure (comando, ServiceBus, fan-in, query GET) y de artefactos de proyeccion | MEF-ADR-0006 |
| Gestión de proyecto con GitHub Issues | MEF-ADR-0007 |
| Knowledge Crunching como propósito del planner | MEF-ADR-0008 |
| Mensajes en `.resx` por aggregate/handler | MEF-ADR-0009 |
| Pipeline de conocimiento del dominio | MEF-ADR-0010 |
| Definition of Ready por tipo de issue | MEF-ADR-0011 |
| Encapsulamiento, Tell-don't-Ask, value objects, frontera de serialización (event store Marten vs bus) | MEF-ADR-0012 |
| Smoke tests contra entorno dev | MEF-ADR-0013 |
| Coverage gate en pipeline TDD | MEF-ADR-0014 |
| Snapshots de Marten como excepción | MEF-ADR-0015 |
| Convención de naming para métodos de test | MEF-ADR-0016 |
| Archivo señal de refactor puro vive fuera de `.claude/` | MEF-ADR-0017 |
| Heurísticas de evolución y reuso del código (Rule of Three, etc.) | MEF-ADR-0018 |
| Separación física de skills publicados vs internos | MEF-ADR-0019 |
| Hosting de Azure Functions (un App Service Plan por dominio) | MEF-ADR-0020 |
| Infraestructura base (8 módulos + entorno) generada por agente | MEF-ADR-0021 |
| Autenticación de CI hacia Azure por OIDC (Workload Identity Federation) | MEF-ADR-0022 |
| Bounded Context, namespace interno de ASB y frontera publico/privado | MEF-ADR-0023 |
| Modelo de eventos de bus (privado propio, publico via backbone compartido, externo diferido) | MEF-ADR-0024 |
| Custodia de secretos (ningun secreto/key en texto plano; Key Vault o identidad administrada) | MEF-ADR-0025 |
| Colas de Service Bus con sesion para fan-in y serializacion por clave de aggregate | MEF-ADR-0026 |
| Enrutamiento multi-destinatario de un evento por correlation filter de igualdad | MEF-ADR-0027 |
| Estrategia de tenancy (mono-tenant transitorio en greenfield + resolver real basado en TenantContext) | MEF-ADR-0028 |
| Test de composicion del contenedor DI del host generado por el scaffold | MEF-ADR-0029 |
| Esquema de identificación de ADRs con prefijo por proyecto (adopción opcional para consumidores) | MEF-ADR-0030 |
| Readiness gate por SHA (endpoint `/api/version` + gate deploy->smoke) | MEF-ADR-0031 |
| Identidad y autenticación en el borde: WorkOS AuthKit + Azure API Management | MEF-ADR-0032 |
| Adopción de Agent Skills (progressive disclosure) para doctrina pesada del marco | MEF-ADR-0033 |
| Worker de proyecciones y read models por Bounded Context (Container App sin ingress, named store por dominio, config-test) | MEF-ADR-0034 |
| Doctrina de proyección y query read-side (recetas en 3 niveles, estilo record inmutable, superficie de consulta sobre QuerySession tenant-scoped) | MEF-ADR-0035 |
| Lista canonica de resource providers de Azure que el provider `azurerm` del entorno debe registrar | MEF-ADR-0021 |
| Compatibilidad de configuracion Marten entre write-side y read-side (los dos pares, criterio de corte, verificacion bajo gate del reviewer) | MEF-ADR-0034 |
| Doctrina de etiquetado del worker de proyecciones (`tipo:projection` para issues de configuracion del read-side, razonamiento continente/contenido de `dom:X`) | MEF-ADR-0011 |
| Observabilidad del worker de proyecciones (`service.name` obligatorio, fuentes de traza read-side, punto de extension del sampler) | MEF-ADR-0034 |
| Extension del readiness gate por SHA al read-side (`service.version` del worker de proyecciones, sin ingress) | MEF-ADR-0031 |
| Control de volumen de telemetria (sampler efectivo, filtros de ruido en origen, ratio del consumidor) | MEF-ADR-0038 |
| Wiring base de OpenTelemetry del write-side (paquetes, composicion en `Program.cs`, `telemetryMode` de `host.json`): doctrina mudada a MEF-ADR-0038 | MEF-ADR-0003 |
| Costo de ingesta de telemetria del daemon 24/7 y sampler read-side instalado por defecto con filtro del polling (doctrina en MEF-ADR-0038) | MEF-ADR-0034 |
| Identidad del evento persistido en el event store (alias vs `mt_dotnet_type`, proscripciones de registro, guardrails, protocolo de refactor) | MEF-ADR-0036 |
| Firmas admitidas de Create/Apply, tipo de identidad de N1 (StreamIdentity.AsString) y límite de fan-out en N2 | MEF-ADR-0035 |
| Origen del analizador de Marten (paquete, no `PackageReference` adicional) y namespaces de las clases base de proyección | MEF-ADR-0035 |
| Doble cobertura de la guarda 1 del config-test del worker (metodo `partial` del seam y clase de proyeccion sin `partial`) y superficie verificada de la guarda 2 | MEF-ADR-0034 |
| Resolución de `TView` en el `DocumentStore` del write-side sin registro adicional, y condición de política de tenancy documental compartida con el worker | MEF-ADR-0035 |
| Auto-creacion de tablas de read model por el worker de proyecciones (`AutoCreateSchemaObjects`, sin migracion de despliegue) | MEF-ADR-0034 |
| Identidad del stream y su representacion string canonica (Guid/clave compuesta, borde HTTP, store/bus/read-side) | MEF-ADR-0037 |
| Composicion canonica de ensamblados por rol del evento (particion PublicEvents/PrivateEvents/{Dominio}.DomainEvents; Contracts fuera del canon) | MEF-ADR-0039 |
| Acceso del worker de proyecciones a los tipos de evento persistidos via `{Dominio}.DomainEvents`, sin referenciar el `.csproj` de ningun Function App | MEF-ADR-0034 |
| Envelope de eventos referencia el ensamblado de eventos de bus que corresponda, no "el proyecto Contracts" | MEF-ADR-0005 |
| Csproj de smoke tests referencia PublicEvents/PrivateEvents en vez de Contracts | MEF-ADR-0013 |
| Referencia al shared kernel de Contracts reemplazada por la particion canonica de ensamblados de evento por rol | MEF-ADR-0010 |
| Mencion de Contracts en la fila `dom:X` del DoR actualizada a la particion de ensamblados de evento por rol | MEF-ADR-0011 |
| Referencia a un ADR de Contracts del consumidor reemplazada por la particion canonica de ensamblados de evento por rol | MEF-ADR-0012 |
| Regla simetrica de referencia unica en los proyectos de tests de eventos de bus (`PublicEvents.Tests`/`PrivateEvents.Tests`, cada uno referencia solo su propio ensamblado) | MEF-ADR-0039 |
| Cero referencias entre ensamblados de eventos (tres islas), payload por rol y enforcement por tests de arquitectura | MEF-ADR-0039 |
| Fuentes de conocimiento del dominio vigentes tras el retiro de la capa de modelado EDA (codigo por rol, glosario custodiado por el planner, field notes/bitacora, ADRs del consumidor) | MEF-ADR-0040 |
| Pipeline de conocimiento del dominio en tres fases (event-stormer/eda-modeler/planner): superseded por MEF-ADR-0040 | MEF-ADR-0010 |
| Forma propia de la vista read-side derivada de la necesidad de lectura; `ReadModels` como cuarta isla (cero `ProjectReference`) y naming sin sufijo `View` | MEF-ADR-0041 |
| Presentacion de los archivos "sin clasificar" del coverage gate (marcador de atencion y nota propios, distintos de una exclusion deliberada) | MEF-ADR-0014 |
| Patron de logica del coverage gate cubre el EventHandler directo (`*EventHandler.cs`, patron 2.1.0) | MEF-ADR-0014 |
| Frontera GET vs QUERY, paginacion y filtros multiples de las read APIs (RFC 10008) | MEF-ADR-0042 |
| `Listar{X}s` conserva nombre y ruta cuando su verbo es QUERY (solo cambia el verbo del `HttpTriggerAttribute`) | MEF-ADR-0006 |
| Enmienda a MEF-ADR-0031: el fallback a "solo 200" no es seguro con un deploy concurrente tocando el FA bajo prueba; tercera clase de invocador (deploy de un componente que prueba un FA ajeno) | MEF-ADR-0031 |
| Consecuencias del verbo QUERY en el borde APIM: `<allowed-methods>` por enumeracion explicita con `QUERY` (B3), operacion wildcard del verbo (B11) y gate empirico end-to-end | MEF-ADR-0032 |
| Trampa B11 de APIM: sin operaciones declaradas el gateway responde 404 a todo el trafico; fix con operacion wildcard por verbo, trade-off documentado frente a OWASP API5:2023 | MEF-ADR-0032 |
| Doctrina HTTP de comandos: test de precedencia (POST coleccion/PUT/DELETE/`POST {recurso}:{verbo}`), ids URL-safe, casing kebab-case y simetria CQRS | MEF-ADR-0043 |
| Casing kebab-case minusculo de las rutas HTTP y remision a MEF-ADR-0043 para el verbo y forma de ruta de comandos | MEF-ADR-0006 |
| Contrato HTTP de comandos (verbo + ruta + precedencia aplicada) como campo Critico del Definition of Ready | MEF-ADR-0011 |
| Politica de aceptacion de ids/codigos de negocio en segmentos de URI (charset RFC 3986 unreserved, criterio rechazar-vs-normalizar por propiedad del dato, momento de la invariante en issue previo dedicado) | MEF-ADR-0043 |
| Doctrina de comentarios de código mínimos (jerarquía código/comentario/documentación, umbral doble Context Delta + Decision Delta, proscripción de provenance `// HU-XX`, regla de precedencia de citas a ADR, alcance por lenguaje y frontera de limpieza del reviewer) | MEF-ADR-0044 |
| Default `always_on = true` unico del marco (sin distincion dev/prod) y su fundamento de costo real en tiers dedicados | MEF-ADR-0020 |
| Wiring de `always_on` desde el output del modulo `service-plan` hasta `site_config.always_on`, via el input nuevo del modulo `function-app` | MEF-ADR-0021 |
| Enmienda a MEF-ADR-0031: cobertura de la capa de datos con el endpoint dedicado `/api/ready` (defensa en profundidad, probe sin cache del positivo, `ApplyAllDatabaseChangesOnStartup` diferida) | MEF-ADR-0031 |
| Alerta dedicada de spike de excepciones del worker de proyecciones (umbral calibrado empiricamente, gate de deteccion parcial) | MEF-ADR-0034 |
| Desacople de logs de error del sampler de trazas en el read-side (EnableTraceBasedLogsSampler, LogFilteringProcessor) | MEF-ADR-0038 |
| Camino de resolucion de la connection string del worker bajo el overload de opciones del exporter (IConfiguration poblada por el host) | MEF-ADR-0034 |
| Correccion en MEF-ADR-0043 seccion 1.1: lectura por alcances del charset de segmentos de ruta frente a la identidad de stream de MEF-ADR-0037 (Guid por construccion, componente tipado no-Guid sujeto a 1.2/1.3, clave compuesta fuera del sujeto porque nunca viaja entera en un segmento) | MEF-ADR-0043 |
| Precision de MEF-ADR-0037 seccion 2: la unidad del borde HTTP es el componente tipado, no la clave (identidad de un componente vs. de varios) | MEF-ADR-0037 |
| Extension del desacople de logs de error del sampler de trazas al write-side (supresion ratio-dependiente, sin el filtro estructural del worker) | MEF-ADR-0038 |
| Cierre del gap de `mt_version` en la doctrina read-side (receta `UseNumericRevisions` + par de config-tests espejo write-side/read-side, segunda instancia del par de compatibilidad 2) | MEF-ADR-0034 |
| Estándar de nombramiento de recursos Azure (patrón CAF + región + secuencia) | MEF-ADR-0045 |
| Remision del naming de infraestructura base al estandar CAF + region + secuencia (MEF-ADR-0045) | MEF-ADR-0021 |
| Correccion en la nota del issue #245 de MEF-ADR-0006: el nombre del recurso Azure citado pasa a `func-{kebab}-{prefix_func}` (el dominio es el `{uso}` del patron CAF) | MEF-ADR-0006 |
| Generalizacion del par de config-tests espejo a plantilla del par 2 (tabla/tenancy/id como tercera instancia; guarda siempre-activa de la tenancy documental) | MEF-ADR-0034 |
| Enmienda a MEF-ADR-0036: el skill `/purge-store` como mecanismo canonico de ejecucion de la purga deliberada en dev (regla del mismo despliegue intacta) | MEF-ADR-0036 |
| Enriquecimiento coreografiado por el dueño del dato (Content Enricher preferido sobre réplica local) | MEF-ADR-0046 |
| Doctrina de servidores MCP serverless (ruta tecnica, granularidad por BC/proposito, aislamiento, diseno de tools, custodia de la key) | MEF-ADR-0047 |
| Testing de servidores MCP (piramide de tres niveles, verificaciones canonicas del smoke e2e, endpoints de gate propios y credencial de CI en runtime) | MEF-ADR-0048 |
| Enmienda a MEF-ADR-0013: MEF-ADR-0048 extiende la doctrina de smoke tests a servidores MCP | MEF-ADR-0013 |
| Doctrina de exportacion de metricas OTel (descarte total en Function Apps por wildcard, solo familia GC en el worker de proyecciones via vista func-based, fallback de connection string y guardrail de composicion) | MEF-ADR-0038 |
| Clasificacion de los archivos de un servidor MCP en el coverage gate (`*Tool.cs` logica, `*Api.cs` de `Infraestructura/` excluido, records DTO multi-tipo excluidos) | MEF-ADR-0014 |
| Extension obligatoria de la suite smoke MCP ante tool nueva o modificada (pin catalogo, pin `inputSchema.required`, tool call real) | MEF-ADR-0048 |
| Identidad y tenancy en servidores MCP: propagacion `X-Tenant-Id`/`X-User-Id` via `DelegatingHandler` compartido, tenant interino por app settings, y limite estructural del host (gate OAuth exclusivo del borde) | MEF-ADR-0047 |
| Variante MCP/Connect en el borde APIM: politica por-API dedicada, `audiences`/PRM/Resource Indicator consistentes byte a byte, `on-error` 401 con `WWW-Authenticate`, y trampa B12 (dominio AuthKit como authorization server de tokens Connect, distinto del issuer de login) | MEF-ADR-0032 |
| Transicion (a)->(b) de tenancy en Azure Functions isolated worker: biblioteca scaffoldeada `src/{RootNamespace}.TenantResolver/` (`TenantExecutionContext` sobre `AsyncLocal` + `TenantContextMiddleware` de worker), y por que `ProxyTenantResolver` no sirve para HTTP | MEF-ADR-0028 |
| Enmienda en MEF-ADR-0004: excepciones de precondicion tipadas (`PrecondicionComandoException`/`RecursoYaExisteException`/`RecursoNoEncontradoException`) en la capa 2, en vez de `InvalidOperationException` generica | MEF-ADR-0004 |
| Ubicacion del PRM de los servidores MCP en APIM: API compartida por entorno, fuera del well-known de RFC 9728 por restriccion de APIM (path sin punto inicial), descubrimiento exclusivo por resource_metadata | MEF-ADR-0032 |
| Restriccion de coercion de argumentos string de la extension MCP y su middleware de restauracion | MEF-ADR-0047 |
| Cobertura obligatoria del camino valido de cada parametro fecha/identificador en la tool call real del smoke MCP | MEF-ADR-0048 |
| Arquitectura neutral de runtime y proveedor: OpenCode como dogfooding interno, fuente canonica `src/internal/` con adaptadores generados, perfiles logicos de modelo, y toolchain Bash + jq | MEF-ADR-0049 |
| Perfiles logicos de modelo por runtime: tabla por defecto del adaptador (enmienda) | MEF-ADR-0049 |
| Principio de neutralidad de runtime para toda operación de Mefisto (conjunto de runtimes abierto, frontmatter portable de Agent Skills, namespace `mefisto` por adaptador) | MEF-ADR-0050 |
| No-op de PUT y DELETE por estado ya alcanzado en MEF-ADR-0043 (pasos 2-3 y contrato HTTP de la seccion 6) | MEF-ADR-0043 |
| Estado ya alcanzado (no-op de PUT/DELETE) en el Definition of Ready | MEF-ADR-0011 |
| Cobertura del no-op idempotente de PUT/DELETE (repetir la intencion, cero efectos nuevos) en los smoke tests black-box | MEF-ADR-0013 |
| Smoke tests contra entorno dev desplegado | MEF-ADR-0013 |
| Manejo de errores en event sourcing y exito HTTP | MEF-ADR-0004 |
| Manejo de errores e idempotencia en event sourcing | MEF-ADR-0004 |
| Defaults OpenCode por perfil (`fast` Luna, `balanced` Terra, `deep` Sol) | MEF-ADR-0049 |
| Resiliencia del pipeline ante limite de uso y caida del proveedor: taxonomia de fallos de agente (reintenta/espera/aborta), matiz `RATE_LIMIT`/`PROVIDER_UNAVAILABLE` vs `STREAM_CUT` que precisa el precedente de #416 sin revertirlo, defaults de la espera (sonda, techo, presupuestos propios) y deteccion delegada al adaptador con degradacion de la reanudacion | MEF-ADR-0051 |
| Decision multi-runtime sobre navegacion semantica en agentes C# (evidencia insuficiente Claude Code/OpenCode tras #979/#980, fallback textual, capacidad neutral separada de `read` diferida) | MEF-ADR-0052 |
| Codigo de exito HTTP integrado al test de precedencia de MEF-ADR-0043 (201/204/200/202 por paso, `Location` en create, extension del regimen de migracion a cambios de codigo de exito) | MEF-ADR-0043 |
| Codigo de exito HTTP como cuarto elemento critico del contrato en el DoR de MEF-ADR-0011 | MEF-ADR-0011 |
| Vinculo entre el status code esperado por un smoke test y el contrato HTTP declarado en el issue (nunca `202` por defecto), y distincion commit del event store vs. materializacion de proyeccion `Async` | MEF-ADR-0013 |
| Distribucion multi-runtime para consumidores | MEF-ADR-0053 |
| Resiliencia del pipeline ante limite de uso y caida del proveedor | MEF-ADR-0051 |
| Resiliencia del pipeline ante límite de uso y caída del proveedor | MEF-ADR-0051 |
| Resolucion comun de modelos y tabla por defecto extensible por runtime | MEF-ADR-0049 |
| Extension abierta de defaults de modelo en adaptadores de runtime | MEF-ADR-0050 |
| Distribución multi-runtime y proyección global OpenCode | MEF-ADR-0053 |
| Distribucion multi-runtime de consumidores (enmienda de mirror temporal de identidad de release) | MEF-ADR-0053 |
| Distribucion multi-runtime de Mefisto para consumidores | MEF-ADR-0053 |
| Persistencia en CI de los defaults regionales independientes de PostgreSQL | MEF-ADR-0021 |
| Event Sourcing con Marten y Wolverine | MEF-ADR-0003 |
| Enmienda a MEF-ADR-0031: presupuesto de 420 s del gate por SHA para cubrir un reintento de App Service Linux, distinto del gate `/api/ready` de 120 s | MEF-ADR-0031 |
| Default del perfil `deep` en la tabla del adaptador Claude (`opus`, enmienda) | MEF-ADR-0049 |
| Estimacion reproducible del costo de agentes | MEF-ADR-0054 |
| Fila `## ADRs aplicables` (Critico en feature/refactor/projection) en el Definition of Ready y su validacion programatica en `/implement` | MEF-ADR-0011 |
| Resiliencia del pipeline ante limite de uso y caida del proveedor: postcondiciones objetivas del caller (sin resumen de stage) como evidencia alternativa para aceptar una sesion reanudada, caso `pr-sync.sh` | MEF-ADR-0051 |
| Arquitectura neutral de runtime y proveedor de Mefisto | MEF-ADR-0049 |
| Servidor MCP General por BC y separacion por necesidad demostrada | MEF-ADR-0047 |
| Identidad derivada del token en servidores MCP (enmienda de la doctrina de servidores MCP) | MEF-ADR-0047 |
| Sin guardas de lista exacta o conteo de tipos persistidos (enmienda de la identidad del evento persistido) | MEF-ADR-0036 |
| Paginacion keyset, sobre de lista con cursor opaco, `Take` opcional y sin total | MEF-ADR-0042 |
| Modalidades de consulta, tope fijo y sobre sin total en tools MCP | MEF-ADR-0047 |
| Superficie de observacion de pipelines como mod de Claude Code: lector puro del estado, acciones via skills, banda con digitos y modo `MEFISTO_UI=mod` | MEF-ADR-0055 |
| Tablero del planner como mod: foco refinar/explorar, orden de refinamiento y carga por marketplace local (enmienda de la superficie de observacion por mods) | MEF-ADR-0055 |
| Tablero del planner en ambos lados: ubicacion de mods por lado, tableros independientes sin regla de tres y version minima 2.1.287 (enmienda de la superficie de observacion por mods) | MEF-ADR-0055 |
| Nombres de los mods desde el *Fausto*: prefijo `fausto-` en lo publicado (tablero `fausto-board`, consola reservada `fausto-blood-pact`) y `mefisto-` en lo interno (`mefisto-planner-board`, consola `mefisto-divine-wager`), comando igual al nombre del mod (enmienda de la superficie de observacion por mods) | MEF-ADR-0055 |
| Definition of Ready: issue listo sin preguntas abiertas ni decisiones diferidas (enmienda de MEF-ADR-0011) | MEF-ADR-0011 |
| Observacion sin el skill interno de dashboard: pane herdr, sesion tmux o panel de logs de OpenCode (enmienda de la superficie de observacion por mods) | MEF-ADR-0055 |
| Consola publicada `fausto-blood-pact`: solo en sesiones interactivas del consumidor fuera del planner, modulo en `hooks/fausto-blood-pact/`, independiente de `mefisto-divine-wager` y construida por incrementos con el catalogo en su README (enmienda de la superficie de observacion por mods) | MEF-ADR-0055 |
| Consola publicada `fausto-blood-pact`: el `hooks/hooks.json` carga un unico punto de entrada `hooks/index.tsx` que compone tablero y consola, porque Claude Code admite un solo modulo por plugin (enmienda de la superficie de observacion por mods) | MEF-ADR-0055 |
| Paridad de experiencia entre mods pares (tablero y consola, interno y publicado): comportamiento del par como referencia sin compartir codigo, e identidad visual por lado (enmienda de la superficie de observacion por mods) | MEF-ADR-0055 |
| Activacion de Mefisto por repositorio: archivos por usuario inertes, habilitacion commiteada por consumidor y raiz de release entregada a los agentes de pipeline | MEF-ADR-0053 |
| Paridad de mods por dimension de experiencia (ubicacion, lo que ve el usuario, como se pide input, teclas, mascota) y deber de estudiar el par antes de proponer (enmienda de la superficie de observacion por mods) | MEF-ADR-0055 |
| Default de `repoSlug` tras renombrar el repo a `augusto-romero-arango/mefisto`; el nombre previo resuelve por redireccion (enmienda del routing cross-repo) | MEF-ADR-0019 |
| Smoke tests: tamano de pagina y topes de cantidad fuera del smoke | MEF-ADR-0013, MEF-ADR-0048 |
| Polling de arrange con varias ocurrencias en smoke tests (enmienda) | MEF-ADR-0013 |
| Tolerancia a huecos de secuencia del daemon de proyecciones | MEF-ADR-0034 |
| Pin del marco: Cosmos.* 3.1.0, Marten 9.23.0, WolverineFx 6.27.1 | MEF-ADR-0003 |
| Identidad y auth en el borde (WorkOS + APIM): tercer claim organization_membership_id | MEF-ADR-0032 |
| Doctrina de servidores MCP serverless: identidad derivada con tercer claim organization_membership_id | MEF-ADR-0047 |
| Tenancy: `ITenantContext` y semantica de `OrganizationMembershipId` | MEF-ADR-0028 |
| Politica de cero warnings nuevos (diferencial contra la base, sin supresiones, ultima instancia que abre issue remanente) | MEF-ADR-0056 |
| Label especial `warning` para issues de warnings remanentes (enmienda del esquema de labels) | MEF-ADR-0007 |
| Conexion de las tools MCP de consulta con el backend paginado: catalogo y ventana temporal piden `Take = tope` y reenvian `siguienteCursor`; solo la desambiguacion pide un elemento de mas (correccion de la doctrina de servidores MCP) | MEF-ADR-0047 |
| Superficie de observacion como mod: el aviso de tests ajustados por el reviewer pasa del issue al PR (enmienda de la superficie de observacion por mods) | MEF-ADR-0055 |
| Modo de lanzamiento sin pane en el consumidor (`--parallel`) | MEF-ADR-0055 |
| Raiz del paquete en artefactos Claude (sustitucion de `${CLAUDE_PLUGIN_ROOT}`) | MEF-ADR-0053 |
