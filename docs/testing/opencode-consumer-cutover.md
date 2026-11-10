# Protocolo de certificacion del consumidor multi-runtime

Este protocolo materializa el gate de corte vertical de
[MEF-ADR-0053](../adr/mef-adr-0053-distribucion-multi-runtime-consumidores.md),
seccion 6. Su antecedente, `opencode-dogfooding.md`, certifica exclusivamente el
lado interno; no sustituye esta certificacion de consumidor publicado.

Este documento certifica exclusivamente `/mefisto:tooling`. La superficie de
`/mefisto:implement` (dos rutas de agentes, fase roja/verde, Stage 2b
condicional, coverage gate) tiene su propio protocolo, que reutiliza el
consumidor y la mecanica de instalacion de este documento como prerrequisito:
ver [`tdd-consumer-certification.md`](./tdd-consumer-certification.md). Su
[veredicto final](./tdd-consumer-certification.md#veredicto-final-del-corte-tdd-multi-runtime-1487)
(#1487) cerro `PASA` (2026-09-22, release `v0.38.2`), auditando las cuatro
corridas write-side/read-side x Claude/OpenCode ejecutadas en vivo el
2026-09-21 sobre esa release (#1435/#1436): `/mefisto:implement` (rutas
write-side y `tipo:projection`) queda certificado bajo ambos runtimes. El
veredicto anterior (#1411, `NO PASA` el 2026-09-17) queda como antecedente:
esas cuatro corridas nunca se habian ejecutado en vivo hasta la sesion humana
que #1487 audita.

No se ejecuta durante la redaccion de este documento. Requiere que exista una
release candidata y el repositorio fixture descrito abajo. La primera candidata
prevista es el patch posterior a `v0.37.0`, pero cada corrida registra el tag
efectivo: nunca sustituye ese valor por `latest` ni lo infiere desde un cache.

## Invariantes y prerrequisitos

El consumidor persistente, privado y dedicado es
`augusto-romero-arango/mefisto-consumer-certification`. No representa un
producto real. Se crea, se onborda y se gestiona desde ese repositorio; Mefisto
solo conserva este protocolo. Conforme a MEF-ADR-0019, los issues y PRs fixture
se crean desde el consumidor y no se usa el planner interno para gestionar otro
repositorio.

El baseline versionado debe ser un **consumidor completo**, no un fixture
minimo. Antes de certificar, su evidencia privada demuestra:

- `AGENTS.md`, `CLAUDE.md`, `.mefisto/harness.config.json` y `.gitignore`
  conformes al contrato del harness;
- el informe de `/mefisto:onboard` en estado `LISTO`, sin `FALTA` ni `NO
  VERIFICADO`;
- CI verde que use OIDC hacia Azure, recursos Azure dedicados operativos y
  secretos declarados por nombre, sin client secret persistente ni valores de
  secretos; y
- los labels requeridos por el consumidor, incluidos `tipo:tooling`,
  `dom:certificacion` y `estado:listo` para las corridas posteriores.

La provision y el diagnostico ocurren **desde el clone de ese consumidor**. No
se admite como instalacion ni como evidencia un checkout, worktree, enlace
simbolico, copia parcial o ruta absoluta del repositorio de Mefisto. Esto evita
que el cwd, una fuente mutable o un cache local reemplacen la release versionada
(MEF-ADR-0053, decisiones 2 y 6).

Antes de instalar o abrir issues se registra este conjunto de parametros
inmutables:

| Parametro | Como se obtiene o valida |
|---|---|
| `<tag-certificable>` | tag Git exacto `v<version>` de la candidata publicada |
| `<version>` | SemVer del manifiesto de ambos adaptadores; coincide con el tag sin `v` |
| `<commit-fuente>` | SHA completo de 40 hexadecimales en ambos `mefisto-manifest.json` |
| `<checksum-opencode>` | digest SHA-256 de la linea canonica de `mefisto-opencode-v<version>.tar.gz.sha256` y resultado de `shasum -a 256 -c` |
| `<sha-baseline-inicial>` / `<sha-baseline-final>` | `git rev-parse HEAD` antes de cada corrida y despues de su limpieza; deben ser iguales |
| `<version-claude>`, `<version-opencode>`, `<version-herdr>` | salidas completas de `claude --version`, `opencode --version` y `herdr --version`; no se sustituyen por la version de Mefisto |

La identidad se confirma antes de crear corridas con el
`diagnose-installation-identity.sh` distribuido. Su JSON debe ser `aligned` y
debe contener el mismo `version` y `commit` para `claude` y `opencode`; cualquier
otro estado es una divergencia, no un permiso para continuar.

## Certificacion de instalacion y discovery (#1180)

Esta seccion certifica exclusivamente el baseline, la instalacion real y el
discovery de una release publicada. Termina antes de crear los dos issues
fixture, abrir Herdr o invocar `/mefisto:tooling`; esas corridas E2E pertenecen
a #1181. Los valores entre angulos son outputs de los prerrequisitos, no valores
que se puedan anticipar, inferir desde `latest` ni sustituir por un checkout.

### Estado de la corrida

**PASA (2026-09-13T02:45:29Z).** El expediente sanitizado de esta
certificacion esta preservado en el [comentario de cierre de
#1180](https://github.com/augusto-romero-arango/eda-evsourcing-azure-harness/issues/1180#issuecomment-5650360428).
Los datos siguientes son su indice verificable; no reproducen streams ni logs
crudos.

| Campo | Valor verificado |
|---|---|
| Release e identidad | `v0.37.14`, commit etiquetado `b5facdda76492991ecb4e24935a5bf8a46f6a699`, commit fuente (padre unico) `e8f6043be71a0a9cf71d50bc027007a466c53cdb`. |
| Asset OpenCode | `mefisto-opencode-v0.37.14.tar.gz` + `.sha256` en el mismo tag; SHA-256 `3c24e89fc885b59c99add310c8cf688d52118d92c2d2a0d75339f48448c5da3f`. |
| Defectos corregidos antes del veredicto | [#1270](https://github.com/augusto-romero-arango/eda-evsourcing-azure-harness/issues/1270) y [#1281](https://github.com/augusto-romero-arango/eda-evsourcing-azure-harness/issues/1281), ambos `CLOSED`; no se parcheo el consumidor. |

| CA de #1180 | Resultado | Sintesis |
|---|---|---|
| CA-1 baseline | PASA | Consumidor privado completo, baseline limpio, sin checkout/worktree/symlink/ruta absoluta de Mefisto; onboarding `LISTO` sin `FALTA`/`NO VERIFICADO`, CI OIDC verde, Azure dedicado operativo; sin secretos ni identificadores sensibles. |
| CA-2 release | PASA | Tag posterior a `v0.37.0`, relacion padre/tag verificada, version `0.37.14` y commit fuente comun en metadata Claude/OpenCode; ambos assets del mismo release, checksum verificado por el camino publicado. |
| CA-3 claude | PASA | Actualizacion desde marketplace a scope `user`, sesion nueva; raiz cargada, markers y manifiesto identifican `0.37.14` y el commit fuente. |
| CA-4 opencode | PASA | Instalacion/actualizacion por la autoridad publicada, proyeccion `enabled`, release activa `0.37.14`, un unico `active`, release inmutable, configuracion ajena conservada, `project`/`status`/`diagnose` satisfactorios. |
| CA-5 discovery | PASA | Ambos runtimes descubren `/mefisto:tooling`, `tooling-writer` y `tooling-reviewer`; permisos `read/edit/shell`, sin Skills/MCP en esos agentes; Skills, observabilidad, MCP bundled, clausura de scripts y dependencia externa `terraform` observados en sus superficies; checkout principal y worktree resuelven la misma instalacion activa. |
| CA-6 identidad y redaccion | PASA | `diagnose-installation-identity.sh` reporto `aligned` para Claude/OpenCode en `0.37.14`; evidencia sanitizada sin prompts, raw, stderr, headers, auth stores, API keys ni tokens. |

Este resultado habilito a #1181 para ejecutar las dos corridas E2E reales; por
si solo no constituia el veredicto final de #1066, que reconcilia ambos
expedientes en la seccion "Veredicto final del corte vertical (#1066)" mas
abajo.

### Preflight del consumidor ajeno

Desde un clone nuevo de
`augusto-romero-arango/mefisto-consumer-certification`, privado y persistente,
registre la URL remota, su visibilidad privada y `<sha-baseline-inicial>`. El
arbol debe estar limpio antes y despues del preflight. Con comandos de
metadatos, no copiando su contenido, demuestre que:

1. el clone no es checkout ni worktree de Mefisto (`git worktree list` no
   referencia una raiz Mefisto y `git rev-parse --show-toplevel` es la raiz del
   consumidor);
2. no hay enlaces simbolicos versionados ni rutas absolutas hacia Mefisto en el
   arbol o su configuracion de harness; y
3. existe evidencia enlazable del onboarding `LISTO` sin ocurrencias de
   `FALTA`/`NO VERIFICADO`, del workflow CI verde que autentica a Azure por OIDC,
   y de la infraestructura Azure dedicada operativa.

La evidencia del punto 3 solo conserva URLs, nombres de recursos o secretos y
estados sanitizados. No incorpora IDs de suscripcion/tenant, outputs sensibles,
valores de secretos, cabeceras ni credenciales. Si el baseline cambia durante
el preflight, se restaura o se vuelve a clonar antes de continuar; no se
"arregla" desde este repositorio ni se gestiona con `gh -R`.

### Verificacion de la release efectiva

La publicacion mediante `/mefisto-release patch`, posterior a la integracion de
#1179, es un prerrequisito y no un paso ejecutado desde el consumidor. Conserve
el registro que produce: `<tag-certificable>`, `<commit-etiquetado>`,
`<commit-fuente>` y las URLs de los dos assets OpenCode. Antes de instalar,
consulte el tag y release publicados por su nombre exacto `v<version>` y
registre respuestas sanitizadas que prueben todos estos predicados:

| Predicado fail-closed | Evidencia requerida |
|---|---|
| Version publicable | `<version>` es SemVer y es estrictamente posterior a `0.37.0`; `<tag-certificable>` es exactamente `v<version>`. |
| Procedencia Git | El commit del tag tiene un unico padre y ese padre es exactamente `<commit-fuente>`; el tag apunta a `<commit-etiquetado>`. |
| Identidad Claude | El `plugin.json` de la distribucion marketplace declara `name=mefisto` y `<version>`; su `mefisto-manifest.json` declara `runtime=claude`, la misma `<version>` y `<commit-fuente>`. |
| Identidad OpenCode | El manifiesto del artefacto OpenCode declara identidad `opencode`, `<version>` y `<commit-fuente>` (y su minimo de runtime). |
| Assets | Las URLs del mismo tag descargan `mefisto-opencode-v<version>.tar.gz` y `mefisto-opencode-v<version>.tar.gz.sha256`; se registran ambas URLs y el SHA-256 publicado. |

Las consultas deben dirigirse al tag/release exacto (por ejemplo, la vista y API
de GitHub del tag y de sus assets), nunca a `latest`. Un cache de plugin, un
checkout local o un manifiesto ya instalado pueden corroborar una instalacion,
pero no completan esta verificacion de release. Si falta uno de los predicados,
no se instala ni se sustituye el dato por una candidata supuesta.

### Instalacion Claude Code a scope de usuario

Registre el argv sanitizado y las versiones efectivas de CLI y plugin. Instale
o actualice desde el marketplace al scope `user` con el identificador publicado,
despues reinicie Claude Code o ejecute `/reload-plugins`. En una **sesion nueva**
capture la raiz realmente cargada, no la raiz mas reciente de su cache, y
compruebe:

- `mefisto-manifest.json` de esa raiz declara `runtime=claude`, `<version>` y
  `<commit-fuente>`;
- `.mefisto/pipeline/.plugin-root` nombra exactamente esa raiz cargada; y
- el mirror legacy autorizado `.claude/pipeline/.plugin-root`, cuando exista,
  nombra la misma raiz y no una version mas nueva del cache.

Un marker ausente, una raiz que sea checkout/worktree o una identidad distinta
es fallo. La certificacion no reescribe markers a mano: la sesion y su hook
`record-active-release` son quienes los producen.

### Instalacion y proyeccion OpenCode

Registre `opencode --version` y confirme que la version efectiva es al menos
1.18.29. En un directorio temporal, descargue ambos assets por sus URLs exactas,
valide el checksum **antes** de extraer o ejecutar el bootstrap y ejecute
`./install.sh install <version>`, el entrypoint empaquetado. Ese comando instala
y activa la release. Despues, mediante el launcher instalado, ejecute en este
orden:

```bash
<mefisto-opencode> project
<mefisto-opencode> status
<mefisto-opencode> diagnose
```

`status` debe identificar la release activa y su commit; la raiz de datos debe
contener `releases/<version>/` sin enlaces ni permisos de escritura y un unico
puntero `active` hacia ella. `project` debe informar la raiz global efectiva de
OpenCode, preservar configuracion ajena y mostrar las capacidades ausentes como
`DEGRADACION VISIBLE`; en macOS se registran separadamente la raiz de datos de
Mefisto y la raiz de configuracion OpenCode, salvo overrides XDG explicitamente
declarados. No se inspecciona ni registra el auth store de OpenCode.

### Matriz de discovery y alineacion

Discovery es una observacion de runtime, no una inspeccion de archivos ni una
ejecucion anticipada del pipeline. Registre el comando equivalente realmente
ejecutado y su resultado sanitizado. Claude usa los listados de comandos,
agentes, Skills, hooks y MCP de una sesion nueva; OpenCode usa `opencode debug
config`, `opencode agent list` y la proyeccion global efectiva. La matriz debe
quedar completa:

| Superficie | Claude Code | OpenCode |
|---|---|---|
| Comando y agentes tooling | `/mefisto:tooling`, `tooling-writer`, `tooling-reviewer` | `/mefisto:tooling`, `tooling-writer`, `tooling-reviewer` |
| Clausura y permisos | clausura exacta enumerada abajo; solo `read`, `edit`, `shell` | misma clausura adaptada; solo `read`, `edit`, `shell` |
| Skills | `projections`, `code-comments` | `mefisto-projections`, `mefisto-code-comments` |
| Observabilidad y MCP | hooks/plugin de observabilidad y `microsoft-learn` bundled | plugin de observabilidad y `microsoft-learn` bundled |
| Externo | `terraform` identificado como dependencia externa | `terraform` identificado como dependencia externa |

Los agentes tooling no cargan Skills ni MCP: su ausencia en esos agentes es el
resultado esperado, no una degradacion. Las Skills y MCP se certifican por la
fila propia de discovery. La clausura exacta que ambos runtimes deben descubrir
en la distribucion instalada es:

```text
scripts/_pipeline-common.sh
scripts/tmux-pipeline.sh
scripts/herdr-pipeline.sh
scripts/stream-watch.sh
scripts/tooling-pipeline.sh
src/runtime/mefisto-run-agent.sh
src/runtime/lib/mefisto-runtime.sh
src/runtime/lib/mefisto-models.sh
src/runtime/lib/mefisto-process.sh
src/runtime/lib/runtime-claude.sh
src/runtime/lib/runtime-claude.jq
src/runtime/lib/runtime-opencode.sh
src/runtime/lib/runtime-opencode.jq
src/runtime/contract/models.validate.jq
```

El checkout principal y un worktree del consumidor deben resolver la misma
raiz Claude cargada y el mismo `active` OpenCode, y producir la misma matriz;
una diferencia por cwd es fallo.

Por ultimo, invoque `diagnose-installation-identity.sh` solamente con
`--claude-root <raiz-claude-cargada>` y
`--opencode-root <raiz-opencode-activa>`. Su JSON debe tener `status=aligned` y
ambos objetos deben declarar `<version>` y `<commit-fuente>` ya verificados. No
se permite que el diagnostico consulte checkout, cache, red, configuracion o
auth stores.

### Evidencia, centinelas y bloqueo

Anexe un manifiesto redactado con timestamp/zona horaria, argv sanitizados,
versiones de CLI, tag, ambos commits, SHA-256, rutas observadas, estados de
preflight/proyeccion/discovery y URLs de evidencia. Ejecute los centinelas de la
seccion "Manifiesto de evidencia y redaccion" sobre el reporte final y registre
conteo cero para prompts, raw, stderr, headers, auth stores, API keys y tokens;
nunca persista el contenido que coincida.

Cualquier fallo crea un issue `tipo:bug` en Mefisto, enlaza la evidencia
sanitizada, se añade como dependencia de #1180 y conserva #1180 abierto. No se
parchea el consumidor para simular paridad ni se repite sobre un baseline sucio.

### Expediente minimo de #1180

El reporte de esta certificacion es un artefacto privado y redactado, separado
de los logs crudos de cada runtime. Debe permitir auditar el procedimiento y
repetirlo con acceso autorizado, sin distribuir el consumidor ni sus
credenciales. Use esta estructura minima; se puede repetir `comando` y
`evidencia` por paso. Un campo no verificable se marca `BLOQUEADO` con la URL o
nombre sanitizado de la evidencia que falta, nunca se completa por inferencia:

```text
certificacion=#1180
inicio=<ISO-8601-con-zona-horaria>
fin=<ISO-8601-con-zona-horaria>
veredicto=<PASA|FALLA|BLOQUEADO>
comando=<paso>: <argv sanitizado>
evidencia=<paso>: <URL o nombre sanitizado>

[CA-1 baseline]
consumidor.url=<URL privada>
consumidor.visibilidad=private
baseline.sha-inicial=<SHA completo>
baseline.sha-final=<SHA completo; igual al inicial>
baseline.limpio-antes=<SI|NO>
baseline.limpio-despues=<SI|NO>
referencia-mefisto.checkout=<NO|SI>
referencia-mefisto.worktree=<NO|SI>
referencia-mefisto.symlink=<NO|SI>
referencia-mefisto.ruta-absoluta=<NO|SI>
onboard.estado=<LISTO|BLOQUEADO>
onboard.falta=<0|conteo>
onboard.no-verificado=<0|conteo>
ci-oidc=<VERDE|BLOQUEADO>
azure-dedicado=<OPERATIVO|BLOQUEADO>

[CA-2 release]
tag=<vSemVer posterior a v0.37.0>
commit-etiquetado=<SHA completo>
commit-fuente=<SHA completo>
padre-unico=<SI|NO>
padre=<SHA completo; igual al commit-fuente>
claude.plugin.name=<mefisto|otro>
claude.plugin.version=<version>
claude.manifest.runtime=<claude|otro>
claude.manifest.version=<version>
claude.manifest.commit=<commit-fuente>
opencode.manifest.runtime=<opencode|otro>
opencode.manifest.version=<version>
opencode.manifest.commit=<commit-fuente>
opencode.asset=<URL exacta del tag>
opencode.sha256.asset=<URL exacta del tag>
opencode.sha256=<digest>

[CA-3 claude]
claude.cli=<version>
claude.plugin=<version>
claude.origen=marketplace
claude.scope=user
claude.recarga=<reload-plugins|reinicio>
claude.sesion-nueva=<SI|NO>
claude.raiz-cargada=<ruta observada>
claude.manifest.runtime=claude
claude.manifest.version=<version>
claude.manifest.commit=<commit-fuente>
claude.plugin-root=<coincide|no coincide>
claude.legacy-plugin-root=<coincide|ausente permitido|no coincide>

[CA-4 opencode]
opencode.cli=<version >= 1.18.29>
opencode.checksum=<correcto|incorrecto>
opencode.checksum-antes-bootstrap=<SI|NO>
opencode.entrypoint=install.sh install <version>
opencode.release=<version>
opencode.commit=<commit-fuente>
opencode.raiz-datos=<ruta observada>
opencode.raiz-config=<ruta global efectiva observada>
opencode.release-sin-enlace=<SI|NO>
opencode.release-sin-escritura=<SI|NO>
opencode.active.cantidad=<1|otro>
opencode.active.destino=<releases/version|otro>
opencode.project=<OK|DEGRADACION VISIBLE|FALLA>
opencode.config-ajena=<CONSERVADA|ALTERADA>
opencode.capacidades-ausentes=<DEGRADACION VISIBLE|ninguna|silenciosas>
opencode.status=<OK|FALLA>
opencode.diagnose=<OK|FALLA>

[CA-5 discovery]
claude.tooling=<presente|ausente>
opencode.tooling=<presente|ausente>
claude.agentes=<tooling-writer y tooling-reviewer presentes|ausentes>
opencode.agentes=<tooling-writer y tooling-reviewer presentes|ausentes>
claude.permisos-agentes=<solo read,edit,shell|otros>
opencode.permisos-agentes=<solo read,edit,shell|otros>
claude.skills-mcp-agentes=<ausentes|presentes>
opencode.skills-mcp-agentes=<ausentes|presentes>
claude.clausura=<14/14 rutas de la lista anterior|faltantes>
opencode.clausura=<14/14 rutas adaptadas de la lista anterior|faltantes>
claude.skills=<projections,code-comments|faltantes>
opencode.skills=<mefisto-projections,mefisto-code-comments|faltantes>
claude.observabilidad=<hooks/plugin presente|ausente>
opencode.observabilidad=<plugin presente|ausente>
claude.mcp=<microsoft-learn bundled|ausente>
opencode.mcp=<microsoft-learn bundled|ausente>
claude.terraform=<externo|otro>
opencode.terraform=<externo|otro>
claude.checkout-worktree=<misma raiz cargada|distintas>
opencode.checkout-worktree=<mismo active|distintos>

[CA-6 identidad y redaccion]
diagnostico.argv=<diagnose-installation-identity.sh --claude-root raiz-cargada --opencode-root raiz-activa>
diagnostico.status=<aligned|otro>
diagnostico.claude.version=<version>
diagnostico.claude.commit=<commit-fuente>
diagnostico.opencode.version=<version>
diagnostico.opencode.commit=<commit-fuente>
artefacto-sanitizado=<ruta relativa; SHA-256; ID de patron; conteo; veredicto>
centinelas.contenido-prompt=0
centinelas.salida-cruda=0
centinelas.salida-error=0
centinelas.cabeceras=0
centinelas.almacenes-auth=0
centinelas.claves-api=0
centinelas.tokens=0
bug=<URL sanitizada|ninguno>
```

`consumidor.url` puede conservar la URL privada porque ya es un identificador
del repositorio de certificacion; los restantes campos de evidencia externa se
reducen a URL, nombre o estado. El expediente no incluye IDs de Entra/Azure,
variables de entorno, contenido de manifests no requerido, rutas de auth store
ni salida `stderr`. La ausencia de un secreto se demuestra exclusivamente por
los conteos de centinelas sobre material previamente sanitizado. Cada linea
`comando` conserva el programa, subcomando, flags y placeholders, no variables
ni valores sensibles. Cada artefacto inspeccionado aporta su ruta relativa,
hash, ID estable del patron de la seccion "Manifiesto de evidencia y redaccion",
conteo y estado; el catalogo de patrones y este bloque de control no forman
parte del payload escaneado, para que sus propios nombres no produzcan una
coincidencia autorreferencial.

## Matriz de corridas e issues fixture (#1181)

### Estado de la corrida

**PASA (2026-09-13T13:06:13-05:00).** El expediente sanitizado de la
certificacion real esta preservado en los comentarios de los issues fixture:
[#11, fila
Claude](https://github.com/augusto-romero-arango/mefisto-consumer-certification/issues/11#issuecomment-5655078146)
y [#12, fila
OpenCode](https://github.com/augusto-romero-arango/mefisto-consumer-certification/issues/12#issuecomment-5655078692).
El [addendum final](https://github.com/augusto-romero-arango/mefisto-consumer-certification/issues/11#issuecomment-5655087957)
registra la limpieza posterior. Los datos siguientes son su indice verificable;
no reproducen streams ni logs crudos.

| Campo | Valor verificado |
|---|---|
| Release e identidad | `v0.37.16`, commit fuente `e9054d5f7576e13edf09b6ca304b79f8d95b0884`; el diagnostico de instalacion informo `aligned`. |
| Baseline | SHA inicial y final de `main`: `c96e10ca129662a6bcc3cedcd8b08618f67f2d6e`. |
| Fixtures | Los issues [#11](https://github.com/augusto-romero-arango/mefisto-consumer-certification/issues/11) (Claude) y [#12](https://github.com/augusto-romero-arango/mefisto-consumer-certification/issues/12) (OpenCode) se crearon desde el planner publicado, con `tipo:tooling`, `dom:certificacion` y `estado:listo`, templates canonicos y un baseline comun. |
| PRs | [#18](https://github.com/augusto-romero-arango/mefisto-consumer-certification/pull/18), SHA `55ff30c2a08e82335781317ca08c7fbd5e81955a`, y [#19](https://github.com/augusto-romero-arango/mefisto-consumer-certification/pull/19), SHA `680b0226cc0f12a4f608ca26a854e4452bcf6303`, fueron PRs reales. Cada uno tuvo `Closes` hacia su issue, comentario de pipeline y un unico documento determinista bajo `docs/testing/mefisto-certification/`. |
| Checks | `NO_APLICAN`: ambos PRs modificaron solo `docs/testing/mefisto-certification/**`; el unico workflow `pull_request`, `Infra CD`, filtra `infra/**`. Los SHA de ambos PRs tuvieron cero Actions runs y cero check-runs. No se declaro un verde inexistente. |
| Limpieza | PRs cerrados sin merge, ramas remotas eliminadas, issues cerrados como `not planned`, cero worktrees, arbol limpio y baseline restaurado. |

### Corte E2E/Herdr certificado

La invocacion real de `herdr-workspace.sh` sobre el consumidor monto el workspace
con identidad `aligned`: arriba `planner [claude]` y `ejecucion [claude]`; abajo
`planner [opencode]` y `ejecucion [opencode]`. Las dos filas heredaron su
`MEFISTO_RUNTIME`, el `--kind` correspondiente y pools de panes distintos. La
fila Claude inicio el planner con `mefisto:planner`; la fila OpenCode no uso
`--agent`, degradacion declarada que no cambia la semantica del corte. Ninguna
fila fijo proveedor, modelo o credenciales.

Desde los panes de ejecucion se ejecutaron exactamente dos invocaciones reales:

```text
/mefisto:tooling 11
/mefisto:tooling 12 --models 'writer=openai/gpt-5.6-terra,reviewer=openai/gpt-5.6-sol'
```

La primera no recibio `--models`; Claude resolvio automaticamente los perfiles
por adaptador. La segunda conservo el override explicito de OpenCode. En ambas,
el flujo efectivo fue `/mefisto:tooling` -> `tmux-pipeline.sh` ->
`herdr-pipeline.sh` -> `tooling-pipeline.sh` -> `mefisto-run-agent.sh` ->
adaptador de runtime, y ejecuto exactamente `tooling-writer` y
`tooling-reviewer`. No se uso `--variant`, ni se modifico infraestructura o
logica de dominio.

Durante writer/reviewer, cada issue tuvo un solo reporte de `stream-watch.sh`
filtrado por issue. `herdr-report-panes.txt` conserva panes del mismo workspace
con identidades `claude` y `opencode`; panes, streams, worktrees, ramas, status y
logs no se reutilizaron entre filas. La cobertura de poda y reutilizacion no se
amplio con una tercera corrida y permanece en las suites Herdr dedicadas.

### Correlacion, redaccion y veredicto

Los expedientes enlazados correlacionan por issue, stage y sesion los streams
neutrales redactados, logs derivados, `events.log`, metricas,
`pipeline-history.jsonl`, sesiones interactivas y summaries copiados al body de
cada PR. Cada stage registra runtime, agente, perfil, modelo solicitado y
efectivo, origen de seleccion, session id, resultado, version y commit fuente.
Cada stream tiene un unico terminal exitoso y el history enlaza el PR de su mismo
issue.

| Issue | Runtime | Stage/agente | Perfil | Seleccion | Modelo efectivo | Session ID (SHA-256) |
|---|---|---|---|---|---|---|
| #11 | Claude | writer / `tooling-writer` | `balanced` | automatica, alias `sonnet` | `claude-sonnet-5` | `115c96113f02405900871df517fc7ee286e3d9e58dcf31c740fd4f363f29a3c3` |
| #11 | Claude | reviewer / `tooling-reviewer` | `deep` | automatica, alias `opus` | `claude-opus-5` | `1ec0d1bb80d6de0767a857e7719683f8b74126042c251a6c3b13e00950516d2e` |
| #12 | OpenCode | writer / `tooling-writer` | `balanced` | override explicito | `openai/gpt-5.6-terra` | `8cc48c328dd974ddb846caa8fab29fdc57b7b193136e53791cda0a4da1f14870` |
| #12 | OpenCode | reviewer / `tooling-reviewer` | `deep` | override explicito | `openai/gpt-5.6-sol` | `2a69c0b570317cb8b62070bec23156657e3a264e2da92efc1d6c2cd446369a57` |

Los cuatro stages terminaron exitosamente con version `0.37.16` y commit fuente
`e9054d5f7576e13edf09b6ca304b79f8d95b0884`. En Claude, que el runner recibiera
los aliases ya resueltos por perfil y registrara `inherited=false` fue la
resolucion automatica normal del adaptador, no un override del usuario. OpenCode
registro los dos overrides explicitos solicitados. Los centinelas sobre los
artefactos persistentes informaron cero coincidencias para prompts, system
prompts, eventos `message`, inputs de tools, raw, stderr, headers, auth stores,
API keys y tokens. Solo se preservaron timestamps, comandos sanitizados, hashes,
URLs y conclusiones.

Por tanto, Herdr, observabilidad y centinelas **PASA** y los checks son
`NO_APLICAN` por el filtro declarado del workflow consumidor. Esta evidencia
satisface CA-1 a CA-6 de MEF-ADR-0053. Un gap futuro exige abrir un bug en
Mefisto, declararlo dependencia y repetir ambas filas sobre una release nueva.

Se abren **dos issues distintos**, ambos en el consumidor, con labels
`tipo:tooling`, `dom:certificacion` y `estado:listo`: uno para Claude y uno para
OpenCode. Cada issue produce su propia rama y PR. Esa separacion hace comparables
las dos ejecuciones sin compartir worktree, logs, estado de pipeline ni commit
de salida. No se usa `--variant`: una variante conserva una rama local y no abre
PR, por lo que no ofrece la evidencia independiente requerida por el gate.

Defina `<run-id>` como `YYYYMMDD-HHMMSS-<tag-certificable>` normalizado (sin la
`v` inicial si se necesita un nombre de archivo portable). Las plantillas son
intencionalmente identicas salvo por runtime, ruta y contenido esperado.
Al crear cada uno se pasan los tres labels de forma explicita, por ejemplo con
`gh issue create --repo augusto-romero-arango/mefisto-consumer-certification
--label tipo:tooling --label dom:certificacion --label estado:listo --title
<titulo> --body-file <template-runtime.md>`. La salida de ese comando fija `<issue-claude>` o
`<issue-opencode>`; no se reutiliza un numero entre filas.

### Template: Claude

````markdown
# Certificar tooling publicado bajo Claude (<run-id>)

## Contexto

Certificar la release `<tag-certificable>` (`<version>`, commit fuente
`<commit-fuente>`) desde una instalacion publicada real en este consumidor.

## Alcance

Crear exclusivamente `docs/testing/mefisto-certification/<run-id>-claude.md`.
No modificar otro archivo ni usar `--variant`.

## Contenido determinista

El archivo debe contener exactamente:

```text
runtime=claude
tag=<tag-certificable>
version=<version>
commit=<commit-fuente>
run=<run-id>
```

## Verificacion

Ejecutar `git diff --check` y verificar que el unico archivo versionado cambiado
sea `docs/testing/mefisto-certification/<run-id>-claude.md`, con las cinco lineas
exactas anteriores. El pipeline debe llegar a un PR real.

## Dependencias

- Ninguna.
````

### Template: OpenCode

````markdown
# Certificar tooling publicado bajo OpenCode (<run-id>)

## Contexto

Certificar la release `<tag-certificable>` (`<version>`, commit fuente
`<commit-fuente>`) desde una instalacion publicada real en este consumidor.

## Alcance

Crear exclusivamente `docs/testing/mefisto-certification/<run-id>-opencode.md`.
No modificar otro archivo ni usar `--variant`.

## Contenido determinista

El archivo debe contener exactamente:

```text
runtime=opencode
tag=<tag-certificable>
version=<version>
commit=<commit-fuente>
run=<run-id>
```

## Verificacion

Ejecutar `git diff --check` y verificar que el unico archivo versionado cambiado
sea `docs/testing/mefisto-certification/<run-id>-opencode.md`, con las cinco lineas
exactas anteriores. El pipeline debe llegar a un PR real.

## Dependencias

- Ninguna.
````

## Procedimiento reproducible

Ejecute las filas en este orden desde el clone limpio del consumidor. Sustituya
solo los placeholders documentados y capture el argv sanitizado de cada comando;
nunca capture variables de entorno completas.

1. **Preparar baseline.** Clonee el repositorio fixture, haga checkout de
   `<sha-baseline-inicial>` y compruebe `git status --porcelain=v1` vacio.
   Provisionar el repositorio y ejecutar directamente `/mefisto:onboard` en
   modo diagnostico son prerrequisitos hechos desde este clone antes de fijar el
   baseline; no forman parte del catalogo que migra este protocolo. Durante la
   certificacion no acepte la provision opt-in de labels o CI. Registre remoto,
   SHA y URL y no cree enlaces hacia Mefisto.
2. **Instalar la misma release.** Antes de actualizar, registre las raices y
   versiones activas para el rollback. El catalogo del marketplace y el GitHub
   Release deben exponer exactamente `<tag-certificable>`; si solo puede
   afirmarse que es `latest`, aborte. En Claude Code puede ejecutar directamente
   `/mefisto:upgrade` desde la instalacion anterior, sin poda, seguido de
   `/reload-plugins`; para un bootstrap registre el marketplace como documenta
   `README.md` y ejecute `claude plugin install
   mefisto@augusto-romero-arango-harness --scope user`. Despues del reload,
   defina `<raiz-claude-instalada>` como la raiz
   autocontenida realmente cargada y confirme su `mefisto-manifest.json`.

   Para el primer bootstrap OpenCode, ejecute desde un directorio temporal la
   secuencia publicada; no ejecute ningun archivo antes de validar el checksum:

   ```bash
   VERSION=<version>
   BASE="https://github.com/augusto-romero-arango/eda-evsourcing-azure-harness/releases/download/v$VERSION"
   curl -fL "$BASE/mefisto-opencode-v$VERSION.tar.gz" -o "mefisto-opencode-v$VERSION.tar.gz"
   curl -fL "$BASE/mefisto-opencode-v$VERSION.tar.gz.sha256" -o "mefisto-opencode-v$VERSION.tar.gz.sha256"
   shasum -a 256 -c "mefisto-opencode-v$VERSION.tar.gz.sha256"
   mkdir mefisto-opencode-release
   tar -xzf "mefisto-opencode-v$VERSION.tar.gz" -C mefisto-opencode-release
   ./mefisto-opencode-release/install.sh install "$VERSION"
   ```

   Elimine el directorio temporal cuando haya registrado
   `<checksum-opencode>`. Si ya existe una instalacion verificada, use su punto
   de entrada absoluto `<mefisto-opencode>` (el instalador no crea un comando en
   `PATH`) para actualizar y proyectar:

   ```bash
   <mefisto-opencode> install <version>
   <mefisto-opencode> project
   <mefisto-opencode> status
   ```

   El instalador descarga `mefisto-opencode-v<version>.tar.gz`, valida su
   SHA-256 contra el `.sha256` del release y activa solo una release valida e
   inmutable. Guarde el digest y el resultado, no el tarball ni datos de auth.
3. **Alinear identidad y preparar fixtures.** Desde la raiz del consumidor,
   ejecute el diagnostico de la release instalada proporcionando la raiz Claude
   observada y el
   `active` OpenCode cuando no sean los defaults:

   ```bash
   <mefisto-opencode> status
   <mefisto-opencode> package-root
   <raiz-opencode-activa>/diagnose-installation-identity.sh \
     --claude-root <raiz-claude-instalada> \
     --opencode-root <raiz-opencode-activa>
   ```

   La salida de `package-root` fija `<raiz-opencode-activa>`. En el JSON,
   `status=aligned` y `claude`/`opencode` con `version=<version>` y
   `commit=<commit-fuente>` son precondiciones fail-closed. La ruta Claude es la
   de la instalacion cargada, no una ruta de checkout; obtengala del marker
   canonico de release o de la propia sesion despues del reload. Desde el
   planner **publicado** del consumidor, cree los dos issues abiertos e
   independientes con los templates exactos de las secciones anteriores y los
   tres labels explicitos. Registre sus numeros, URLs y el mismo
   `<sha-baseline-inicial>` antes de abrir Herdr. No cree, cierre ni modifique
   esos fixtures con el planner interno de Mefisto ni con `gh -R`; los issues y
   PRs pertenecen exclusivamente al consumidor.
4. **Discovery separado.** En cada runtime descubra y registre, sin ejecutar
   tooling: comandos, agentes, Agent Skills, scripts/runner,
   permisos, hooks y MCP. Para Claude use `/help`, `/agents`, `/skills`,
   `/hooks` y `/mcp`, ademas del inventario de la raiz cargada. Para OpenCode
   use `opencode debug config`, `opencode agent list` y las rutas globales
   proyectadas (`commands`, `agents`, `skills`, `plugins`); compruebe tambien
   que el estado del proyector no reporte capacidades ausentes. Registre en
   ambos `/mefisto:tooling`, `tooling-writer`, `tooling-reviewer`, la clausura
   exacta enumerada en la matriz y los permisos efectivos. Registre
   `projections`/`code-comments` en Claude frente a
   `mefisto-projections`/`mefisto-code-comments` en OpenCode, el adaptador de
   hooks, `microsoft-learn` y `terraform` como dependencia externa. Discovery
   prueba disponibilidad, no
   ejercita una tool MCP ni un hook ajeno al flujo. Si una version del runtime
   no ofrece alguno de esos listados, registre el comando de discovery
   equivalente realmente usado; no sustituya discovery por presencia de
   archivos.
5. **Workspace Herdr.** Una vez por baseline alineado y con los dos issues
   abiertos, ejecute la invocacion
   real distribuida:

   ```bash
   <raiz-claude-instalada>/scripts/herdr-workspace.sh <ruta-del-consumidor>
   ```

   Compruebe identidad `aligned`, la fila superior
   `planner [claude]`/`ejecucion [claude]`, la inferior
   `planner [opencode]`/`ejecucion [opencode]`, sus pools de panes separados,
   `MEFISTO_RUNTIME` y el `--kind` heredados. La fila Claude inicia el planner
   con `mefisto:planner`; la OpenCode no usa `--agent`. Ninguna fila fija
   proveedor, modelo ni credenciales. Herdr monta y enfoca; no sustituye las
   dos ejecuciones independientes de abajo.
6. **Fila Claude.** Desde `ejecucion [claude]`, en la sesion Claude instalada,
   ejecute directamente:

   ```text
   /mefisto:tooling <issue-claude>
   ```

   No agregue `--models` ni `--variant`. Esta invocacion directa es el smoke
   interactivo de la fila; el pipeline que lanza ejecuta en print mode
   headless. Espere un PR real con `Closes #<issue-claude>`, comentario del
   pipeline y checks requeridos verdes. Confirme que los hooks naturales de
   inicio, cambios y cierre dejaron eventos correlacionables con la sesion. El
   comando despacha transitivamente `tmux-pipeline.sh`, `herdr-pipeline.sh`,
   `tooling-pipeline.sh`, el runner neutral, exactamente `tooling-writer` y
   `tooling-reviewer`; no invoque directamente ninguno de esos scripts o
   agentes.
7. **Fila OpenCode.** Con el baseline restaurado al SHA inicial, desde
    `ejecucion [opencode]` en la sesion OpenCode instalada, ejecute directamente:

   ```text
   /mefisto:tooling <issue-opencode> --models 'writer=<modelo-verificado>,reviewer=<modelo-verificado>'
   ```

   Los dos valores de `<modelo-verificado>` se obtienen del discovery efectivo
   de OpenCode, no se infieren ni se sustituyen por un alias. No use
   `--variant`. Igual que en Claude, esta invocacion directa es el smoke
   interactivo y la escritura/revision ocurren headless. Espere un PR real con
   `Closes #<issue-opencode>`, comentario del pipeline y checks requeridos
   verdes; confirme eventos de los hooks naturales correlacionables con la
   sesion. `tmux-pipeline.sh`, `herdr-pipeline.sh`, `tooling-pipeline.sh`, el
   runner neutral, writer y reviewer son transitivos, no ejecuciones manuales.
8. **Comparar y preservar.** Compruebe que cada PR cambia solo su archivo
   fixture de cinco lineas, contra el template correspondiente, y que ambos
   conservan tag, version, commit fuente, baseline y resultado. Runtime,
   modelo, IDs, timestamps y URLs son deliberadamente distintos. Compruebe que
   el pipeline copio los summaries al body de cada PR antes de retirar los
   worktrees; registre ademas el comentario del pipeline, commits y checks.

Los agentes de tooling exponen solo lectura, edicion y shell: tienen Agent
Skills y MCP denegados. Por ello `projections`,
`code-comments` y `microsoft-learn` se comprueban solo por discovery separado
y no se fuerzan dentro de los issues fixture. Los hooks se descubren y se
observan en la sesion/pipeline que naturalmente los activa; no se llama un hook
como script directo. Esta distincion evita certificar una capacidad por una via
que el corte vertical no usa.

## Manifiesto de evidencia y redaccion

Guarde un manifiesto por `<run-id>` fuera del PR fixture o como artefacto privado
de su ejecucion. Debe contener solo metadatos y rutas observables:

| Campo | Requisito |
|---|---|
| timestamp y zona horaria | inicio/fin de cada paso y de cada runtime |
| argv sanitizado | programa, subcomando, flags y placeholders; sin variables ni valores sensibles |
| identidad | runtime, modelo reportado, `<tag-certificable>`, `<version>`, `<commit-fuente>`, `<checksum-opencode>` y las tres versiones de runtime |
| baseline | remoto, SHA inicial/final, estado limpio y hash de los archivos baseline |
| trazabilidad GitHub | URLs de issue y PR por runtime, SHA de rama y checks/conclusiones |
| Herdr | workspace, filas, labels, IDs de pane y runtime de cada pane; `.mefisto/pipeline/herdr-report-panes.txt` debe listar panes del mismo workspace con identidades `claude` y `opencode` |
| stages | por issue y stage: runtime, agente, perfil, modelo solicitado/efectivo, herencia, session id, resultado, version y commit fuente completos; Claude registra el camino heredado y OpenCode el override explicito |
| artefactos | rutas relativas y hash SHA-256 de streams neutrales redactados, logs derivados, metricas, `pipeline-history.jsonl`, sesiones, `events.log`, summaries y markers de release |
| veredicto | pasa/falla/bloqueado, divergencias y URL del bug si existe |

Durante writer/reviewer cada corrida conserva un unico pane de reporte de
`stream-watch.sh` filtrado por su issue. No se reutilizan ni mezclan panes,
streams, worktrees, ramas, status o logs entre los issues; esta corrida no agrega
una tercera fila ni una tercera ejecucion. La poda y reutilizacion posterior se
prueban por separado en `test-herdr-parallel.sh` y
`test-herdr-collapse-panes.sh`.

Verifique que cada stream neutral redactado tiene exactamente un terminal exitoso
y que `pipeline-history.jsonl` enlaza el PR correcto del mismo issue. No copie
prompts, system prompts, eventos `message`, inputs de tools, salida raw,
stderr, headers, auth stores, API keys o tokens. En su
lugar, registre para cada artefacto inspeccionado su ruta relativa, SHA-256,
patron, conteo y veredicto, nunca la linea coincidente. Aplique como minimo estos
centinelas case-insensitive salvo donde el patron explicite caracteres:

```text
("|')?(prompt|system[ _-]?prompt|question|confirmation|approval|raw|stderr|message|tool[ _-]?input)("|')?[[:space:]]*[:=]
(authorization|cookie|set-cookie|x-api-key)[[:space:]]*:
auth\.json|credentials|((api[_-]?key|access[_-]?token|refresh[_-]?token)[[:space:]]*[:=])
Bearer[[:space:]]+[A-Za-z0-9._~+/-]+=*|sk-[A-Za-z0-9]{16,}
```

Una coincidencia implica redaccion local antes de persistir evidencia y abre una
divergencia si no puede demostrarse que pertenece solo al propio reporte de
centinelas. La ausencia se demuestra por conteo cero sobre los artefactos ya
sanitizados, no afirmandola de memoria. Nunca se abre, copia ni sube el contenido
de un auth store: cada runtime conserva sus credenciales, conforme a
MEF-ADR-0025.

## Veredicto, fallos y limpieza

La ejecucion es fail-closed. Falla y bloquea el veredicto cualquier desalineacion
de identidad, checksum, baseline, discovery requerido, fila/pane Herdr,
contenido de fixture, PR/check, observabilidad correlacionable, prompt no
atendido o centinela no redactable. Cree un issue `tipo:bug` en Mefisto con el
manifiesto sanitizado, el paso fallido, hashes, URLs y diferencia observada;
añadalo como dependencia de #1181 y no migre ningun comando adicional mientras
siga abierto. Repita **ambas** corridas desde un baseline limpio sobre una
release nueva que contenga la correccion; una sola repeticion no restablece la
comparabilidad. El protocolo solo certifica `/mefisto:tooling`.

La limpieza corre tambien tras un fallo parcial. Tras capturar la evidencia,
cierre sin merge ambos PRs fixture y elimine sus ramas remotas; cierre ambos
issues como `not planned` con un comentario que enlace la certificacion. Retire
los worktrees de las dos corridas, restaure el baseline a su SHA inicial y
compruebe que no queda ninguno, que el arbol esta limpio y que
`<sha-baseline-final>` coincide con `<sha-baseline-inicial>`. La limpieza es
idempotente: repetirla sobre PR/issue ya cerrados, ramas ausentes o un árbol ya
restaurado no debe alterar el resultado. Restaure la instalacion
Claude/OpenCode previa cuando la corrida hubiera cambiado su release activa;
conserve los punteros y versiones previos en el manifiesto para poder verificar
esa restauracion. No pode releases ni migre otro comando como parte de esta
certificacion.

## Veredicto final del corte vertical (#1066)

### Identidad de ambos expedientes y desviacion declarada de MEF-ADR-0053 §6.1

| Expediente | Release | Commit etiquetado | Commit fuente (padre unico) | Asset OpenCode | SHA-256 |
|---|---|---|---|---|---|
| #1180 | `v0.37.14` | `b5facdda76492991ecb4e24935a5bf8a46f6a699` | `e8f6043be71a0a9cf71d50bc027007a466c53cdb` | `mefisto-opencode-v0.37.14.tar.gz` | `3c24e89fc885b59c99add310c8cf688d52118d92c2d2a0d75339f48448c5da3f` |
| #1181 | `v0.37.16` | `51cdd558c6b7cfe1d43246b76e22a1011392a92b` | `e9054d5f7576e13edf09b6ca304b79f8d95b0884` | `mefisto-opencode-v0.37.16.tar.gz` | `3196fc5892ddaf3d6ebdb5b54bb22b26403cb2ea5f08f56440c0c5082a22e252` |

Verificado desde Mefisto -- nunca desde checkout, cache o Git del consumidor --
el 2026-09-13 y reverificado al emitir este veredicto el 2026-09-14: el tag
`v0.37.14` resuelve al commit `b5facdd…`, con padre unico `e8f6043…`; el tag
`v0.37.16` resuelve a `51cdd55…`, con padre unico `e9054d5…`. Ambos releases de
GitHub exponen `mefisto-opencode-v<version>.tar.gz` junto con su `.sha256`, y el
digest publicado por GitHub para cada tarball coincide con el de la tabla.

MEF-ADR-0053 §6.1 exige instalar la **misma** version/tag en Claude Code y
OpenCode. #1180 certifico esa instalacion sobre `v0.37.14`; #1181 certifico las
corridas E2E sobre `v0.37.16`, una version posterior. Este veredicto declara esa
diferencia como **desviacion documentada** de §6.1 -- no una enmienda del ADR --,
sostenida por tres hechos verificables desde este repositorio:

a. **Identidad re-verificada en `v0.37.16`**: `herdr-workspace.sh` confirmo
   `aligned` (mismo `version` y commit fuente en Claude y OpenCode) al montar el
   workspace de #1181, y las dos filas ejercitaron `/mefisto:tooling`,
   `tooling-writer` y `tooling-reviewer` bajo ambos runtimes.
b. **Las superficies de discovery exclusivas de #1180 no cambiaron**:
   `git diff --stat e8f6043..e9054d5` no toca `skills/`, `hooks/` ni `.mcp.json`
   -- las tres superficies cuyo discovery solo consta en `v0.37.14`.
c. **Las superficies que si cambiaron fueron re-ejercitadas por #1181**: el
   mismo diff toca, entre otros, `commands/tooling.md`,
   `agents/tooling-reviewer.md`, `scripts/tooling-pipeline.sh`,
   `src/runtime/lib/runtime-claude.sh` y
   `src/published/scripts/lib/adapter-claude.sh` -- exactamente las rutas fuente
   que `/mefisto:tooling` despacha en su camino real (`tmux-pipeline.sh` ->
   `herdr-pipeline.sh` -> `tooling-pipeline.sh` -> `mefisto-run-agent.sh` ->
   adaptador de runtime), y las dos corridas de #1181 las ejercitaron hasta PR
   real.

Los dos defectos abiertos durante #1180 (#1270, #1281) estan `CLOSED` y se
corrigieron antes de su veredicto `PASA`; ninguno se parcheo en el consumidor.

### Matriz de trazabilidad contra los cinco requisitos de MEF-ADR-0053 §6

| Requisito §6 | Evidencia | Release | Modalidad |
|---|---|---|---|
| 1. Instalacion real de la misma version/tag en Claude y OpenCode, con checksum del artefacto OpenCode | "Certificacion de instalacion y discovery (#1180)", subsecciones "Instalacion Claude Code a scope de usuario" e "Instalacion y proyeccion OpenCode"; identidad `aligned` re-verificada por `herdr-workspace.sh` en "Matriz de corridas e issues fixture (#1181)" | `v0.37.14` (instalacion + checksum completos) y `v0.37.16` (identidad `aligned` re-verificada) | invocado |
| 2. Discovery de comandos, agentes, Skills, scripts, permisos, hooks y MCP en ambos runtimes | "Certificacion de instalacion y discovery (#1180)", subseccion "Matriz de discovery y alineacion" | `v0.37.14` | descubierto (Skills y MCP nunca se invocaron) |
| 3. Ejecucion headless hasta PR real + smoke interactivo de la misma version, con observabilidad correlacionable | "Matriz de corridas e issues fixture (#1181)", subsecciones "Corte E2E/Herdr certificado" y "Correlacion, redaccion y veredicto": `/mefisto:tooling 11` y `/mefisto:tooling 12 --models ...` invocados en sesion interactiva, cada uno despacho headless de writer/reviewer hasta PR real (#18, #19) | `v0.37.16` | invocado |
| 4. Herdr con Claude en fila superior, OpenCode en fila inferior y pools de panes separados | "Matriz de corridas e issues fixture (#1181)", subseccion "Corte E2E/Herdr certificado" | `v0.37.16` | invocado |
| 5. Logs, metricas y sesiones con `runtime`, `modelo`, `version` y `commit fuente`, sin secretos ni inputs sensibles | "Certificacion de instalacion y discovery (#1180)", CA-6 (identidad sanitizada) y "Matriz de corridas e issues fixture (#1181)", subseccion "Correlacion, redaccion y veredicto" (tabla de stages, session IDs, centinelas en cero) | `v0.37.14` (identidad) y `v0.37.16` (stages y sesiones completos) | descubierto en `v0.37.14`; invocado en `v0.37.16` |

Los agentes del corte declaran solo `read`/`edit`/`shell`: Skills y MCP
bundleado quedan certificados por **discovery** en `v0.37.14`, no por
invocacion. Ninguna otra fila del catalogo se apoya en esta matriz.

### Barrido centinela sobre este documento

Los cuatro centinelas de "Manifiesto de evidencia y redaccion" se ejecutaron
sobre este archivo al emitir el veredicto. Conteo de contenido sensible: cero.
Las dos unicas coincidencias pertenecen al propio aparato de redaccion y no a
evidencia capturada -- el campo de reporte `centinelas.contenido-prompt=0` del
expediente minimo de #1180 y la linea que define los patrones en el bloque de
centinelas --, exactamente la excepcion que esa seccion admite. No hay prompts,
salida raw, stderr, headers, auth stores, API keys ni tokens en el documento.

### Veredicto

**PASA (2026-09-14).** La cadena `v0.37.14` -> `v0.37.16` (commits fuente
`e8f6043be71a0a9cf71d50bc027007a466c53cdb` ->
`e9054d5f7576e13edf09b6ca304b79f8d95b0884`) satisface los cinco requisitos de
MEF-ADR-0053 §6 con la desviacion documentada de §6.1 registrada arriba.
`/mefisto:tooling` queda certificado para consumidores publicados sobre ambos
runtimes; ninguna otra capacidad del catalogo queda habilitada por este
veredicto. Este resultado retira el bloqueo de #1262 y de cualquier otra
migracion publicada posterior al corte `/mefisto:tooling`.

La desviacion de §6.1 es la **unica** aceptada, y se acepta declarada, no
inferida como cumplimiento (MEF-ADR-0031). El regimen fail-closed de "Veredicto,
fallos y limpieza" siguio vigente durante la auditoria: cualquier evidencia
ausente, degradacion no prevista o diferencia Claude/OpenCode distinta de esa
desviacion habria producido `NO PASA`, un bug `tipo:bug` en Mefisto enlazado
como dependencia de #1066, la repeticion de ambas corridas sobre una release
nueva y la permanencia de #1066 abierto y bloqueado. No se detecto ninguna. No
se concedieron waivers adicionales ni se aplicaron correcciones manuales en el
consumidor para sostener este resultado.

## Referencias

- MEF-ADR-0053, secciones 2, 3 y 6: instalacion versionada, identidad comparable
  y gate reproducible del corte vertical.
- MEF-ADR-0019: separacion de repositorios y routing cross-repo limitado.
- MEF-ADR-0022: baseline completo con CI hacia Azure autenticada por OIDC.
- MEF-ADR-0025: custodia de credenciales por runtime.
- MEF-ADR-0031: un gate requiere comandos y resultados repetibles, no archivos
  presentes.
- MEF-ADR-0050: el mismo comando publicado debe conservar la intencion neutral
  entre adaptadores.
- `docs/testing/herdr-workspace.md`: filas y labels canonicos del workspace.
- `src/published/scripts/install-opencode-release.sh`: contrato de instalacion,
  checksum y activacion OpenCode.
