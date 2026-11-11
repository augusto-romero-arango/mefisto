import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  checkConsumerDirectives,
  contractSectionHasToken,
  hasContractHeading,
  resolveOnboardRuntime,
} from '../lib/consumer-directives.mts'

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..')
const COMPLETE = [
  '## Tokens del harness',
  '**RootNamespace** **SolutionFile** **ProjectDisplayName** **BoundedContext** **BoundedContextDomains**',
  '## Verificación de fuentes',
  '',
].join('\n')

let work = ''
let sequence = 0

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto directivas lib '))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

/** Rutas de AGENTS.md y CLAUDE.md en una carpeta nueva; `null` deja el archivo sin crear. */
function files(agents: string | null, claude: string | null): [string, string] {
  const dir = mkdtempSync(join(work, `caso-${++sequence}-`))
  const paths: [string, string] = [join(dir, 'AGENTS.md'), join(dir, 'CLAUDE.md')]
  if (agents !== null) writeFileSync(paths[0], agents)
  if (claude !== null) writeFileSync(paths[1], claude)
  return paths
}

describe('hasContractHeading', () => {
  test('reconoce el encabezado de cualquier nivel, con sangria y con parentesis detras', () => {
    for (const line of [
      '# Tokens del harness',
      '###### Tokens del harness',
      '  ##\tTokens del harness  ',
      '### Tokens del harness (obligatorio)',
      '## Tokens del harness\r',
    ]) {
      assert.equal(hasContractHeading(`intro\n${line}\nfin\n`, 'Tokens del harness'), true, line)
    }
  })

  test('no confunde texto corriente, siete almohadillas ni un titulo mas largo', () => {
    for (const line of [
      'Tokens del harness',
      '####### Tokens del harness',
      '##Tokens del harness',
      '## Tokens del harness y mas',
      '## Los Tokens del harness',
    ]) {
      assert.equal(hasContractHeading(`${line}\n`, 'Tokens del harness'), false, line)
    }
  })
})

describe('contractSectionHasToken', () => {
  test('solo cuenta el token dentro de la seccion de tokens', () => {
    const content = '## Tokens del harness (x)\n- **Uno**: a\n## Otra\n- **Dos**: b\n'
    assert.equal(contractSectionHasToken(content, 'Uno'), true)
    assert.equal(contractSectionHasToken(content, 'Dos'), false)
    assert.equal(contractSectionHasToken('- **Uno**: a\n', 'Uno'), false)
  })

  test('un token escrito en un encabezado cierra la seccion y no cuenta', () => {
    assert.equal(contractSectionHasToken('## Tokens del harness\n### **Uno**\n', 'Uno'), false)
  })
})

describe('checkConsumerDirectives', () => {
  test('contrato completo con el puente exacto', () => {
    const check = checkConsumerDirectives(...files(COMPLETE, '  @AGENTS.md  \n'), 'claude')
    assert.deepEqual(check, {
      agentsState: 'OK',
      agentsDetail: 'AGENTS.md contiene las dos secciones obligatorias y los 5 tokens',
      bridgeState: 'OK',
      bridgeDetail: 'CLAUDE.md contiene el puente exacto @AGENTS.md sin secciones contractuales duplicadas',
      bridgeHasImport: true,
      bridgeHasLegacy: false,
    })
  })

  test('sin archivos, los dos faltan', () => {
    const check = checkConsumerDirectives(...files(null, null), 'claude')
    assert.equal(check.agentsState, 'FALTA')
    assert.equal(
      check.agentsDetail,
      'AGENTS.md no existe: crea las secciones "Tokens del harness" y "Verificación de fuentes" con los 5 tokens obligatorios',
    )
    assert.equal(check.bridgeState, 'FALTA')
    assert.equal(
      check.bridgeDetail,
      'CLAUDE.md no existe: crea el puente con una linea independiente @AGENTS.md',
    )
  })

  test('un AGENTS.md incompleto enumera lo que falta', () => {
    const check = checkConsumerDirectives(
      ...files('## Tokens del harness\n**RootNamespace** **SolutionFile**\n', null),
      'claude',
    )
    assert.equal(check.agentsState, 'FALTA')
    assert.equal(
      check.agentsDetail,
      'AGENTS.md esta incompleto; faltan: encabezado "Verificación de fuentes" ProjectDisplayName BoundedContext BoundedContextDomains',
    )
  })

  test('distingue el CLAUDE.md legacy, el que no importa y el que importa con secciones duplicadas', () => {
    const legacy = '## Tokens del harness\n'
    const cases: [string, boolean, boolean, string][] = [
      [
        legacy,
        false,
        true,
        'CLAUDE.md legacy legible: faltan el puente exacto @AGENTS.md y la limpieza manual de las secciones contractuales duplicadas',
      ],
      [
        'texto @AGENTS.md\n',
        false,
        false,
        'CLAUDE.md no contiene una linea independiente @AGENTS.md; agrega el puente hacia AGENTS.md',
      ],
      [
        `${legacy}@AGENTS.md\n`,
        true,
        true,
        'CLAUDE.md contiene @AGENTS.md pero conserva secciones contractuales legacy duplicadas; eliminalas manualmente',
      ],
    ]
    for (const [content, hasImport, hasLegacy, detail] of cases) {
      const check = checkConsumerDirectives(...files(COMPLETE, content), 'claude')
      assert.equal(check.bridgeState, 'FALTA')
      assert.equal(check.bridgeHasImport, hasImport)
      assert.equal(check.bridgeHasLegacy, hasLegacy)
      assert.equal(check.bridgeDetail, detail)
    }
  })

  test('fuera de claude el puente que falta es informativo', () => {
    const missing = checkConsumerDirectives(...files(COMPLETE, null), 'otro')
    assert.equal(missing.bridgeState, 'INFO')
    assert.equal(
      missing.bridgeDetail,
      'puente CLAUDE.md ausente: solo lo requiere Claude Code; si tu equipo tambien usa Claude, crealo con una linea independiente @AGENTS.md',
    )
    const incomplete = checkConsumerDirectives(...files(COMPLETE, 'propio\n'), 'otro')
    assert.equal(incomplete.bridgeState, 'INFO')
    assert.equal(
      incomplete.bridgeDetail,
      'opcional (solo lo requiere Claude Code): CLAUDE.md no contiene una linea independiente @AGENTS.md; agrega el puente hacia AGENTS.md',
    )
    assert.equal(checkConsumerDirectives(...files(COMPLETE, '@AGENTS.md\n'), 'otro').bridgeState, 'OK')
  })
})

describe('resolveOnboardRuntime', () => {
  test('MEFISTO_RUNTIME manda', () => {
    assert.equal(
      resolveOnboardRuntime({ MEFISTO_RUNTIME: 'otro' }, SCRIPTS, () => true),
      'otro',
    )
  })

  test('sin fijar, usa el unico adaptador disponible', () => {
    assert.equal(
      resolveOnboardRuntime({}, SCRIPTS, (command) => command === 'claude'),
      'claude',
    )
    assert.equal(
      resolveOnboardRuntime({ MEFISTO_FAKE_AVAILABLE: '1' }, SCRIPTS, () => false),
      'fake',
    )
  })

  test('sin runtime detectable, con varios o sin la libreria de runtimes cae en claude', () => {
    assert.equal(
      resolveOnboardRuntime({}, SCRIPTS, () => false),
      'claude',
    )
    assert.equal(
      resolveOnboardRuntime({ MEFISTO_FAKE_AVAILABLE: '1' }, SCRIPTS, () => true),
      'claude',
    )
    assert.equal(
      resolveOnboardRuntime({ MEFISTO_FAKE_AVAILABLE: '1' }, work, () => false),
      'claude',
    )
  })
})
