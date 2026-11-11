// Contrato del comando implement neutral y su proyeccion publicada.

import { describe } from 'node:test'

import {
  absentAll,
  check,
  claudeOutputExists,
  commandContract,
  contains,
  generatorIsUpToDate,
  guardPrecedesOperation,
  hasExactMetadata,
  inventoryAssets,
  lineCount,
  mirrorMatches,
  sourceValidates,
} from './command-contract-kit.mts'

const command = commandContract('implement')
const { body, claude, mirror } = command

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  hasExactMetadata(
    command,
    {
      profile: 'fast',
      arguments: "<issue> [--models 'agente=modelo[,agente=modelo...]'] [--variant <label>]",
    },
    'metadata sin capacidades ni runtime',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor antes del proceso')
  guardPrecedesOperation(command, /gh issue view/)
  contains(body, 'primer token numerico', 'extrae el issue sin consumir flags')
  contains(body, 'no contiene un token compuesto solo por digitos', 'rechaza entrada sin issue')
  contains(body, 'incluye un flag sin valor', 'rechaza flags incompletos antes de consultar GitHub')
  contains(body, 'Reenvia `$ARGUMENTS` intacto', 'delega el parsing definitivo al wrapper')
  contains(
    body,
    'Si no es consultable, no existe o esta cerrado (`CLOSED`)',
    'exige un issue abierto y consultable',
  )
  contains(body, 'Cuenta todos los labels `tipo:*` y exige exactamente uno', 'exige un unico label de tipo')
  contains(body, 'tipo:feature', 'admite feature')
  contains(body, 'tipo:refactor', 'admite refactor')
  contains(body, 'tipo:projection', 'admite projection')
  contains(body, '{{mefisto:command tooling}}', 'tooling se remite al comando especializado')
  contains(
    body,
    '{{mefisto:package-root}}/docs/adr/mef-adr-0011-definition-of-ready.md',
    'DoR se lee desde package root',
  )
  contains(body, 'todos los criterios vigentes', 'DoR no memoriza cantidad fija')
  contains(body, 'Depende de #N', 'dependencias declaradas se filtran')
  contains(body, 'Bloqueado por #N', 'dependencias bloqueadas se filtran')
  contains(body, 'lineas `Bloquea #N`', 'no confunde dependientes con prerequisitos')
  contains(body, 'consulta primero titulo y estado con `gh pr view`', 'consulta PR antes que issue')
  contains(
    body,
    'cualquier otro fallo de la consulta del PR es no consultable y bloquea',
    'falla cerrado al consultar dependencias',
  )
  contains(body, 'Ignora cualquier otro `#N`', 'ignora referencias ajenas a dependencias')
  contains(
    body,
    'Si no hay una dependencia canonica consultable',
    'bloqueado sin prerequisitos validos falla cerrado',
  )
  contains(body, 'Con `--variant`, nunca mutas labels', 'variante no muta labels')
  contains(body, 'no hace push, no abre PR ni muta el issue', 'variante no tiene efectos remotos')
  contains(body, '{{mefisto:config-path}}', 'configuracion usa directiva neutral')
  contains(body, '`namespacePrefix` falta o esta vacio', 'configuracion invalida bloquea scaffold')
  contains(body, 'Conserva `namespacePrefix` literalmente', 'namespacePrefix no se transforma')
  contains(
    body,
    'convierte solo el nombre del dominio de kebab-case a PascalCase',
    'solo el dominio se convierte a PascalCase',
  )
  contains(body, '## Impacto', 'deteccion limitada a impacto')
  contains(body, '1. Scaffoldear el dominio antes de lanzar el pipeline.', 'ofrece scaffold como opcion 1')
  contains(body, '2. Continuar sin scaffold', 'ofrece continuar como opcion 2')
  contains(body, '3. Abortar sin lanzar el pipeline.', 'ofrece abortar como opcion 3')
  contains(body, 'Function App:', 'opcion de scaffold describe la Function App')
  contains(body, 'Tests:', 'opcion de scaffold describe los tests')
  contains(body, 'Terraform:', 'opcion de scaffold describe Terraform')
  contains(body, 'Workflow:', 'opcion de scaffold describe el workflow')
  contains(body, 'dentro del worktree del issue', 'scaffold y TDD comparten worktree')
  contains(body, 'solo se admite un scaffold por invocacion', 'limita scaffold por invocacion')
  contains(body, '{{mefisto:run launch-pipeline.sh $ARGUMENTS}}', 'despacho sin scaffold')
  contains(
    body,
    '{{mefisto:run launch-pipeline.sh $ARGUMENTS --scaffold-domain <dominio-kebab-confirmado>}}',
    'despacho con scaffold confirmado',
  )
  check(
    'existen dos rutas de lanzamiento',
    () => lineCount(command.source, '{{mefisto:run launch-pipeline.sh') === 2,
    'las rutas de lanzamiento no son dos',
  )
  absentAll(
    body,
    [
      'Claude',
      '.claude/',
      'cache',
      'model:',
      'tools:',
      'allowed-tools:',
      'permission:',
      'SCAFFOLD_FLAG',
      '/work-status',
    ],
    (token) => `fuente no publica token prohibido: ${token}`,
  )
})

describe('[salidas] adaptador y mirror', () => {
  claudeOutputExists(command)
  check(
    'Claude inventaria implement',
    () =>
      inventoryAssets().some(
        (asset) =>
          asset.source === 'src/published/commands/implement.md' &&
          asset.destination === 'commands/implement.md' &&
          asset.mode === '0644' &&
          /^[0-9a-f]{64}$/.test(asset.sha256),
      ),
    'Claude no inventaria implement',
  )
  contains(claude, 'model: "haiku"', 'Claude materializa el perfil fast')
  contains(claude, 'MEFISTO_PACKAGE_ROOT', 'Claude resuelve package root una vez')
  check(
    'Claude tiene un preambulo de package root',
    () => lineCount(claude, /^MEFISTO_PACKAGE_ROOT=/) === 1,
    'Claude duplica package root',
  )
  contains(
    claude,
    'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/launch-pipeline.sh" $ARGUMENTS',
    'Claude conserva package root con espacios y fija su runtime',
  )
  mirrorMatches(command)
  contains(
    mirror,
    '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/implement.md. No editar a mano. -->',
    'mirror conserva marcador generado',
  )
  generatorIsUpToDate()
})
