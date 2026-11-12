// Contrato del comando fix-review neutral y su proyeccion publicada.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  absent,
  absentAll,
  claudeOutputExists,
  commandContract,
  contains,
  generatorIsUpToDate,
  hasExactMetadata,
  mirrorMatches,
  misplacedOffsets,
  sourceValidates,
} from './command-contract-kit.mts'

const command = commandContract('fix-review')
const { body, claude, mirror } = command

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  hasExactMetadata(
    command,
    { profile: 'deep', arguments: '<numero-de-PR>' },
    'metadata sin agent ni capabilities',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  absentAll(
    body,
    [
      'EnterPlanMode',
      'ExitPlanMode',
      'Co-Authored-By',
      'Claude Opus',
      'Claude',
      '.claude/',
      'CLAUDE_',
      '.plugin-root',
      'plugins/cache',
      'model:',
      'tools:',
      'allowed-tools:',
      'permission:',
      '`Read`',
      '`Edit`',
      '`Write`',
    ],
    (token) => `fuente no publica token prohibido: ${token}`,
  )
  contains(body, 'Uso: {{mefisto:command fix-review}} <numero-de-PR>', 'uso vacio via directiva command')
  contains(body, '{{mefisto:package-root}}/agents/<id>.md', 'agentes del harness desde package-root')
  contains(body, '{{mefisto:package-root}}/docs/adr/mef-adr-0019-*.md', 'ADR-0019 desde package-root')
  contains(body, '{{mefisto:config-path}}', 'repoSlug desde config-path')
  contains(body, 'augusto-romero-arango/mefisto', 'default de repoSlug como el planner')
  contains(body, '**No avances a la Fase 3 sin aprobacion del plan.**', 'regla de gate del plan literal')
  contains(body, 'aprobacion explicita', 'aprobacion explicita exigida')
  contains(body, 'in_reply_to', 'respuestas via in_reply_to')
  contains(body, 'NO uses el sub-endpoint `/replies`', 'nunca /replies')
  contains(body, 'Nunca auto-resuelvas comentarios', 'regla: nunca auto-resolver')
  contains(body, 'aborta la Fase 5.4', 'guard de no main en 5.4')
  contains(body, 'docs/convenciones-pr-<numero-de-PR>', 'guard cambia de main a rama docs')
  contains(body, 'La field note siempre se genera', 'regla: field note siempre')
  contains(body, 'mismo idioma del comentario original', 'regla: idioma del comentario')
  absent(body, 'Modelo local', 'sin rama modelo local')
  for (const section of [
    'Comentarios a corregir',
    'Comentarios a explicar',
    'Comentarios ya resueltos',
    'Comentarios a investigar',
    'Orden de ejecucion',
    '## Verificacion',
    '## Contexto',
  ]) {
    contains(body, section, `plan conserva seccion: ${section}`)
  }
})

describe('[orden]', () => {
  test('guard -> triaje -> plan -> build/test -> push -> respuestas -> mejora -> field note', () => {
    const misplaced = misplacedOffsets(body, [
      '{{mefisto:assert-consumer-repo}}',
      '## Fase 1: Triaje',
      '## Fase 2: Plan',
      'No avances a la Fase 3 sin aprobacion del plan',
      'dotnet build',
      'Haz push a la rama del PR',
      'Espera aprobacion del usuario antes de publicar',
      '## Fase 5: Mejora continua',
      '### 5.5 Field note',
    ])
    assert.deepEqual(misplaced.map((marker) => `orden roto en: ${marker}`), [])
  })
})

describe('[salidas] adaptador y mirror', () => {
  claudeOutputExists(command)
  contains(claude, 'model: "opus"', 'Claude materializa el perfil deep')
  contains(claude, '${MEFISTO_PACKAGE_ROOT}/agents/', 'Claude lee agentes desde MEFISTO_PACKAGE_ROOT')
  contains(claude, 'repoSlug', 'Claude lee repoSlug')
  absent(claude, 'plugins/cache', 'salida Claude sin cache de plugins')
  contains(claude, 'Nunca auto-resuelvas comentarios', 'Claude conserva las reglas')
  mirrorMatches(command)
  contains(
    mirror,
    '<!-- GENERADO por src/published/scripts/generate-published-adapters.mts desde src/published/commands/fix-review.md. No editar a mano. -->',
    'mirror conserva marcador generado',
  )
  generatorIsUpToDate()
})
