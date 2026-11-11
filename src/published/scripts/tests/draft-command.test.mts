// Contrato del comando draft neutral y su proyeccion publicada
// (issue #1641: migracion desde el formato Claude-only commands/draft.md).

import { describe } from 'node:test'

import {
  absent,
  absentAll,
  check,
  claudeOutputExists,
  commandContract,
  contains,
  generatorIsUpToDate,
  guardPrecedesOperation,
  hasExactMetadata,
  inventoryHasDestination,
  mirrorMatches,
  sourceValidates,
} from './command-contract-kit.mts'

const command = commandContract('draft')
const { body, claude, mirror } = command

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  hasExactMetadata(
    command,
    { profile: 'fast', arguments: '<descripcion de la idea>' },
    'metadata sin agent ni capabilities (CA-1)',
  )
})

describe('[fuente] guard y directivas (CA-2)', () => {
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  guardPrecedesOperation(command, /gh issue create/)
  contains(body, 'domainLabels` de {{mefisto:config-path}}', 'domainLabels se lee desde config-path')
  contains(
    body,
    'json-value.mts" get "{{mefisto:config-path}}" repoSlug --or-empty',
    'repoSlug se lee desde config-path con el molde del planner',
  )
  contains(
    body,
    'REPO_SLUG="augusto-romero-arango/mefisto"',
    'mismo default que el planner cuando el campo falta',
  )
  contains(body, 'gh issue create -R "$REPO_SLUG"', 'draft cross-repo usa -R con el slug resuelto')
  absent(body, 'HARNESS_REPO_SLUG', 'HARNESS_REPO_SLUG desaparece de la fuente (CA-2/CA-6c)')
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
      '.plugin-root',
      'CLAUDE_',
      'plugins/cache',
    ],
    (token) => `fuente no publica token prohibido: ${token}`,
  )
})

describe('[fuente] comportamiento conservado (CA-3/CA-4)', () => {
  contains(body, '[verbo infinitivo] [que cosa]', 'formato de titulo conservado')
  contains(body, 'Maximo 70 caracteres', 'limite de 70 caracteres conservado')
  contains(body, 'tipo:feature` (default)', 'default tipo:feature conservado')
  contains(body, 'agrega ademas el label `bug`', 'label bug en defectos conservado')
  contains(body, 'default `tipo:refactor` para defectos', 'default tipo:refactor para defectos conservado')
  contains(body, '## Idea', 'body con seccion Idea')
  contains(body, '## Notas', 'body con seccion Notas')
  contains(body, 'estado:borrador', 'siempre estado:borrador')
  contains(
    body,
    'Uso: {{mefisto:command draft}} [descripcion de la idea]',
    'mensaje de uso vacio via directiva command',
  )
  contains(body, 'agente `planner` (modo `refinar`)', 'confirmacion remite al agente planner en modo refinar')
  contains(body, '/mefisto-plan', 'regla cross-repo remite a /mefisto-plan para refinar en Mefisto')
  contains(body, 'NUNCA agregues `dom:` ni `estado:listo`', 'draft cross-repo nunca ofrece estado:listo')
})

describe('[salidas] adaptador y mirror', () => {
  claudeOutputExists(command)
  contains(claude, 'model: "haiku"', 'Claude materializa el perfil fast (CA-5)')
  contains(claude, 'argument-hint: "<descripcion de la idea>"', 'Claude emite argument-hint')
  contains(claude, '/mefisto:draft', 'Claude resuelve la directiva command a /mefisto:draft')
  contains(claude, 'MEFISTO_CONFIG_PATH', 'claude resuelve MEFISTO_CONFIG_PATH (CA-2)')
  contains(
    claude,
    'REPO_SLUG=$(node "${MEFISTO_PACKAGE_ROOT}/scripts/json-value.mts" get "${MEFISTO_CONFIG_PATH}" repoSlug',
    'claude conserva la lectura de repoSlug',
  )
  absent(claude, 'HARNESS_REPO_SLUG', 'claude no nombra HARNESS_REPO_SLUG (CA-6c)')
  absent(claude, 'plugins/cache', 'claude no reimplementa token prohibido: plugins/cache')
  mirrorMatches(command, 'mirror Claude coincide byte a byte (CA-5e)', 'mirror Claude diverge')
  contains(
    mirror,
    '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/draft.md. No editar a mano. -->',
    'mirror conserva marcador generado',
  )
  check(
    'inventariado en dist/claude/.mefisto-generated-assets.json',
    () => inventoryHasDestination('commands/draft.md'),
    'falta en el inventario Claude',
  )
  generatorIsUpToDate()
})
