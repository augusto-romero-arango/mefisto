# MEF-ADR-0057: Portabilidad a macOS, Linux y Windows con TypeScript sobre Node

- **Fecha**: 2026-11-10
- **Estado**: aceptado
- **Aplica a**: todos los scripts, hooks, pipelines, tests y workflows de CI del plugin, en su lado publicado y en el interno; los prerrequisitos que declaran `README.md` y `/onboard`.

## Contexto

Mefisto solo corre donde hay bash, `jq`, `python3` y `tmux`. Linea base medida sobre v0.56.0, sin `dist/`:

- 408 archivos `.sh` con 104686 lineas; 313 de ellos son tests (63584 lineas).
- `jq` aparece en 200 de esos archivos, `awk` en 156, `sed` en 97 y `python3` en 29. `python3` no figura entre los requisitos de `README.md`.
- 21 archivos `.jq`.
- 132 llamadas a `tmux` repartidas en los dos despachadores (`scripts/tmux-pipeline.sh` y `src/internal/scripts/mefisto-tmux-pipeline.sh`).
- 87 archivos llevan `opencode` en la ruta (unas 11 mil lineas).

En Windows nativo nada de eso esta garantizado: Claude Code no exige Git for Windows y, sin el, ejecuta los comandos con PowerShell. tmux no existe en Windows nativo.

El repo ya tiene TypeScript: 12944 lineas en `hooks/` y `.claude/mods/`, con tests.

Los despachadores ya ofrecen tres modos de UI: sesion tmux, panes de herdr y el modo desacoplado de MEF-ADR-0055. Herdr declara soporte nativo de Windows desde su version 0.9.3.

El dueno del proyecto ya casi no usa OpenCode.

## Decision

### 1. Lenguaje de los scripts

Los scripts se escriben en TypeScript y Node los ejecuta directo (`node x.mts`), sin paso de build.

- Version minima: Node 22.18, la primera linea 22 que trae el type stripping activo por defecto.
- Sin dependencias npm en ejecucion: solo modulos `node:`.
- El type stripping no transforma codigo. Quedan fuera `enum`, `namespace` con codigo, parameter properties, alias de import, decoradores, `.tsx` y los `paths` de `tsconfig`. Los imports llevan la extension `.mts`.
- Node no chequea tipos: lo hace `tsc --noEmit`. TypeScript es herramienta de verificacion, nunca dependencia de ejecucion.
- Modulos ES, marcados por la extension `.mts`. Un `.ts` hereda el tipo de modulo del `package.json` mas cercano hacia arriba, y falla si alguna carpeta por encima del plugin declara `"type": "commonjs"` (el home del consumidor, por ejemplo); `.mts` es siempre modulo ES y no exige ningun `package.json`.
- `tsc` corre con `erasableSyntaxOnly`, que rechaza la sintaxis que el type stripping no soporta.

### 2. Ubicacion

Cada `.mts` vive junto al `.sh` que reemplaza, con el mismo nombre base. Sus tests son `*.test.mts` en los mismos directorios `tests/`. La configuracion de tipos es `src/internal/tsconfig.json`. No nace ninguna raiz nueva: las rutas ya estan en los gates de scope. Un archivo nuevo en la raiz del repo se registra primero en los gates, en un PR anterior al que lo crea (MEF-ADR-0019, seccion E).

### 3. Invocacion

- Comandos, agentes y hooks invocan `node <ruta>.mts <args>`.
- Ningun comando que se entrega a un shell ajeno (un hook, un pane de herdr) usa sintaxis de shell: ni prefijos `VAR=x`, ni `&&`, ni pipes. En Windows ese shell es PowerShell o `cmd`.
- Los procesos hijos se lanzan con lista de argumentos y sin shell intermedio.
- El JSON se lee y escribe con las APIs nativas; desaparecen `jq`, `awk`, `sed` y `python3`.

### 4. Port incremental sobre `main`

- Un script se porta completo, con sus tests, en un PR.
- El `.sh` queda como shim (`exec node x.mts "$@"`) solo mientras tenga llamadores en bash.
- Una libreria con llamadores en bash convive en sus dos versiones; un cambio en una funcion ya portada va en las dos.
- No hay rama larga de nueva version.

### 5. tmux se retira

Quedan dos modos de UI:

- **herdr**: panes, cuando la sesion corre dentro de herdr (`HERDR_ENV=1` y `HERDR_PANE_ID`).
- **desacoplado**: el default. El pipeline corre como proceso separado con su salida en un archivo de log. Quien no tiene el mod ni herdr sigue la corrida con `stream-watch` en otra terminal.

`MEFISTO_UI=tmux` termina con un error que nombra los dos modos. `--attach` e `--if-exists` desaparecen: solo tenian sentido con sesiones tmux.

### 6. Herdr se conserva

El modo de panes se porta. Para Windows cambia en dos puntos:

- **Ocupacion de un pane**: la marca Mefisto con un archivo propio. Herdr no soporta en Windows los grupos de foreground de Unix, que es lo que hoy consulta `herdr pane process-info`.
- **Comando que se teclea en el pane**: `node <script>.mts <args>`, con el entorno en el archivo del token de despacho (decision 3).

### 7. Runtime unico

OpenCode sale del repo. El unico runtime soportado es Claude Code y no hay un segundo runtime en los planes: el objetivo es que Mefisto funcione completo en macOS y Windows con Claude Code.

Se conservan, porque retirarlos no es parte del port:

- el contrato de eventos JSONL (MEF-ADR-0049);
- la interfaz de runtime, con una sola implementacion;
- la fuente neutral `src/internal/` y su generador.

Las enmiendas a MEF-ADR-0049, MEF-ADR-0050, MEF-ADR-0053 y MEF-ADR-0055 van en los mismos PRs que borran el codigo, para que ADRs y codigo no se contradigan.

### 8. Verificacion

- Tests con el runner nativo de Node (`node --test`), sin framework externo. Se le pasan los globs de los `*.test.mts`, porque su descubrimiento por defecto recogeria tambien los tests de los mods, que corren con otro runner.
- El workflow `typescript.yml` corre `tsc` y `node --test` en macOS, Linux y Windows, sobre Node 22.18 y sobre la linea LTS vigente. Se dispara en los PRs que tocan TypeScript, en la nightly y a mano.
- Ese workflow es una excepcion acotada a la politica de que ningun PR corre tests (issue #1766), con la misma forma que `plugin-validate.yml`: sin secretos, sin CLIs de agente y sin ser check obligatorio del ruleset. La razon: la maquina de desarrollo es macOS, asi que Linux y Windows no se pueden verificar en local.
- La suite bash sigue en la nightly mientras exista.

### 9. Prerrequisitos y declaracion de soporte

- Node >= 22.18 pasa a ser prerrequisito del consumidor desde el primer script publicado que se porte. `/onboard` lo comprueba.
- En Windows, Git for Windows es prerrequisito: los bloques de bash que Claude ejecuta desde comandos, agentes y skills siguen en bash, y Claude Code los corre en Git Bash; sin Git for Windows usaria PowerShell (Claude Code, *Advanced setup*). Esos bloques no usan nada que Git Bash no traiga: `jq` y `python3` se reemplazan por invocaciones de `node`. `/onboard` comprueba que Git Bash este disponible.
- Los scripts del harness no dependen de bash: cuando no quede ninguno en bash, `README.md` y `/onboard` dejan de pedir `jq` y tmux.
- El criterio de cierre es macOS y Windows. Linux se verifica en el workflow de la decision 8, pero no condiciona la declaracion de soporte.
- Windows se declara soportado solo cuando se cumple la completitud de `docs/portabilidad/ESTADO.md`, que incluye una verificacion manual en una maquina Windows nativa. Ningun agente puede cerrar esa verificacion.
- `src/internal/githooks/pre-push` se queda en shell POSIX. Si la verificacion manual muestra que Git for Windows no lo ejecuta, se porta.

### 10. Seguimiento

`docs/portabilidad/ESTADO.md` es la unica fuente del avance: pasos, metricas medidas con git y verificacion manual. El trabajo va fuera de los pipelines de Mefisto, sin issues; los fragmentos de `changelog.d/` se nombran con el numero del PR, que el consolidador acepta porque solo exige un prefijo numerico.

## Alternativas consideradas

### Alt 1: C# con file-based apps (`dotnet run x.cs`)

No agrega prerrequisitos: el consumidor ya tiene .NET 10. Descartada por tres razones: compila en la primera corrida; las invocaciones concurrentes del mismo script chocan por el cache de build, que es el caso de `/parallel`; y los scripts multiarchivo (`#:include`) exigen SDK 10.0.300 o posterior.

### Alt 2: Python

Ya se usa inline en 29 scripts. Descartada: en Windows conviven `python`, `python3` y `py`, y no hay verificacion de tipos por defecto. Es conocimiento general, sin fuente.

### Alt 3: PowerShell 7

Corre en los tres sistemas, pero hay que instalarlo en macOS y Linux, y reemplaza un lenguaje de shell por otro sin ganar tipos ni un runner de tests comun con los mods. Es conocimiento general, sin fuente.

### Alt 4: Go o Rust

Exigen un binario por plataforma. Rompen la distribucion del plugin como texto y un agente no puede corregir un script en sitio.

### Alt 5: Mantener bash y exigir Git Bash o WSL en Windows

Git Bash no trae `jq`, `python3` ni tmux, y Claude Code no lo exige. WSL convierte el soporte de Windows en soporte de Linux.

### Alt 6: Conservar tmux como modo opcional en Unix

Obliga a portar y probar 132 llamadas para un modo que ya tiene reemplazo (desacoplado) y que no existe en uno de los tres sistemas.

### Alt 7: Conservar OpenCode

Obliga a portar 87 archivos para un runtime que el dueno ya casi no usa. Su documentacion recomienda WSL en Windows.

### Alt 8: Rama larga de nueva version

Diverge de `main` mientras este sigue recibiendo cambios en bash y obliga a portar dos veces.

### Alt 9: Bun o Deno

Traen mejores utilidades de shell, pero estan menos instalados que Node. Es conocimiento general, sin fuente.

## Consecuencias

### Positivas

- Un prerrequisito (Node) reemplaza a cuatro (bash, `jq`, `python3`, tmux).
- Scripts con tipos verificados y JSON nativo.
- Un solo lenguaje para scripts, hooks y mods.
- Unas 14 mil lineas dejan de portarse al retirar tmux y OpenCode.
- CI en los tres sistemas en vez de solo macOS.

### Negativas

- Node pasa a ser prerrequisito del consumidor antes de que Windows este soportado.
- Mientras dura el port conviven dos lenguajes y, en las librerias, dos versiones de la misma funcion.
- Quien usaba OpenCode o sesiones tmux pierde ese modo.
- El type stripping restringe la sintaxis de TypeScript disponible.
- El soporte de Windows depende de una verificacion manual que no cubre CI, en particular el modo herdr.

## Referencias

- Node.js, *Modules: TypeScript*: https://nodejs.org/api/typescript.html (type stripping activo por defecto desde v22.18.0 y v23.6.0, estable desde v24.12.0 y v25.2.0; sintaxis no soportada; extension obligatoria en imports).
- Node.js, *Test runner*: https://nodejs.org/api/test.html (estable desde v20.0.0; descubre `*.test.mts` salvo con `--no-strip-types`).
- Node.js, *Child process*, `options.detached`: https://nodejs.org/api/child_process.html (proceso que sobrevive al padre en Windows y en Unix, con `unref()` y stdio no heredado).
- Claude Code, *Advanced setup*: https://code.claude.com/docs/en/setup (en Windows nativo Git for Windows es opcional para Claude Code: con el la herramienta Bash usa Git Bash; sin el se usa la herramienta PowerShell).
- Herdr, *Windows support* (0.9.3): https://herdr.dev/docs/0.9.3/windows-beta/ (soporte nativo sobre ConPTY; grupos de foreground de Unix no soportados).
- Microsoft Learn, *File-based apps*: https://learn.microsoft.com/dotnet/core/sdk/file-based-apps (cache de build, contencion entre invocaciones concurrentes, `#:include` desde SDK 10.0.300).
- OpenCode, *Windows (WSL)*: https://opencode.ai/docs/windows-wsl/ (recomienda WSL).
- MEF-ADR-0019 (publicado vs interno): seccion E, registro de rutas antes de poblarlas.
- MEF-ADR-0049 y MEF-ADR-0050 (arquitectura y principio de neutralidad de runtime): se conserva el contrato; se enmiendan al retirar OpenCode.
- MEF-ADR-0053 (distribucion multi-runtime): se enmienda al retirar OpenCode.
- MEF-ADR-0055 (superficie de observacion por mods): origen del modo desacoplado; se enmienda al retirar tmux.
- Issue #1766: politica de que ningun PR corre la suite.
- `docs/portabilidad/ESTADO.md`: pasos, metricas y verificacion manual.

## Control de cambios

- 2026-11-10: creacion como `aceptado`. Fija TypeScript sobre Node >= 22.18 sin build, el port incremental sobre `main`, el retiro de tmux y de OpenCode, la conservacion de herdr y del contrato neutral de runtime, y el workflow de verificacion en tres sistemas.
- 2026-11-10: enmienda de las decisiones 7 y 9. Sale la evaluacion de un segundo runtime: el objetivo es que Mefisto funcione completo en macOS y Windows solo con Claude Code; Linux se verifica en CI sin ser criterio de cierre.
- 2026-11-10: enmienda de las decisiones 1, 2, 3, 4, 6 y 8 al montar la base TypeScript. La extension pasa de `.ts` a `.mts`, porque un `.ts` depende del `package.json` de las carpetas superiores; se fija `src/internal/tsconfig.json` y el workflow `typescript.yml`.
- 2026-11-11: enmienda de la decision 9. Git for Windows pasa a ser prerrequisito en Windows: los bloques de bash del markdown de comandos, agentes y skills se quedan en bash y corren en Git Bash, y solo se reemplaza lo que Git Bash no trae (`jq`, `python3`). Se descarto reescribir cada bloque como invocacion de `node` para no exigir Git for Windows: tocaba casi todos los comandos y agentes.
