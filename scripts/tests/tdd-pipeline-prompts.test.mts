// Textos que arma `tdd-pipeline.mts`: prompts de cada stage, cuerpo del PR, tabla de metricas,
// tabla de cobertura y patch spec, byte a byte contra los que producia tdd-pipeline.mts
// (`fixtures/tdd-pipeline/`, generados con los mismos valores desde el bash).

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { renderReviewerTouchedTestsSection } from '../lib/pipeline/red-tests.mts'
import { renderRunMetricsTable } from '../lib/pipeline/run-history.mts'
import {
  COVERAGE_TABLE_HEADER,
  classificationRows,
  coveragePatchSpec,
  evaluateCoverage,
  extractFileCoverage,
} from '../lib/pipeline/tdd-coverage.mts'
import { READ_SIDE, WRITE_SIDE, runMetricsStages } from '../lib/pipeline/tdd-gates.mts'
import type { RunStages } from '../lib/pipeline/tdd-gates.mts'
import {
  agentDetails,
  blockagePromptNote,
  coverageSection,
  invokersBlock,
  mergePrompt,
  patchImplementerPrompt,
  patchTestWriterPrompt,
  prSummary,
  pullRequestBody,
  scaffoldPrompt,
  smokeAnomalySection,
  smokeOnlySection,
  smokeStageTexts,
  smokeUnchangedSection,
  stage1Prompt,
  stage2bPrompt,
  stage2Prompt,
  stage2SmokeOnlyPrompt,
  stage3RefactorPrompt,
  stage3ReviewerPrompt,
} from '../lib/pipeline/tdd-texts.mts'
import { renderWarningRemnantsSection } from '../lib/pipeline/warning-remnants.mts'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'tdd-pipeline')
const golden = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')
const work = mkdtempSync(join(tmpdir(), 'mefisto tdd prompts '))
after(() => rmSync(work, { recursive: true, force: true }))

// Los mismos valores con que se generaron los textos de referencia desde el bash.
const PROJECT = 'Control de Asistencias'
const CONTEXT = '# Issue #42: Registrar "turno" con $HOME y `backticks`\n\nCuerpo con $(subshell) y \\backslash.\nSegunda línea con acento.'
const STAGE1_FILES = 'tests/Empresa.Proyecto.Turnos.Tests/RegistrarTurnoTests.cs\nsrc/Empresa.Proyecto.Turnos/RegistrarTurno/Stub.cs'
const BASE = { projectName: PROJECT, issueContext: CONTEXT, stage1Agent: 'projection-test-writer' }

describe('prompts identicos a los de tdd-pipeline.mts', () => {
  test('test-writer (Stage 1)', () => {
    assert.equal(stage1Prompt(BASE), golden('stage-1.prompt.txt'))
  })
  test('implementer (Stage 2)', () => {
    const prompt = stage2Prompt({
      ...BASE,
      stage2Agent: 'projection-implementer',
      stage1Files: STAGE1_FILES,
      blockageReport: '/tmp/wt/.mefisto/pipeline/blockage-report.md',
    })
    assert.equal(prompt, golden('stage-2.prompt.txt'))
  })
  test('implementer en modo documental (solo smoke)', () => {
    assert.equal(stage2SmokeOnlyPrompt({ ...BASE, stage1Files: STAGE1_FILES }), golden('stage-2-solo-smoke.prompt.txt'))
  })

  const mcpListing =
    '- tests/Empresa.Proyecto.Mcp.Asistente.SmokeTests/A/ASmokeTests.cs (tool: crear_turno)\n- tests/Empresa.Proyecto.Mcp.Asistente.SmokeTests/B/BSmokeTests.cs (tool: crear_turno)'
  const routesListing = '- tests/Empresa.Proyecto.Turnos.SmokeTests/T/TSmokeTests.cs (ruta: turnos/{id})'
  for (const [name, isMcp, listing] of [
    ['mcp-con-smokes', true, mcpListing],
    ['mcp-sin-smokes', true, ''],
    ['endpoints-con-smokes', false, routesListing],
    ['endpoints-sin-smokes', false, ''],
  ] as const) {
    test(`smoke-test-writer (Stage 2b): ${name}`, () => {
      const texts = smokeStageTexts(isMcp, '42')
      const prompt = stage2bPrompt({
        projectName: PROJECT,
        issueContext: CONTEXT,
        stage2Agent: 'projection-implementer',
        filesDescription: texts.filesDescription,
        smokeFiles: 'src/Empresa.Proyecto.Mcp.Asistente/Turnos/CrearTurnoTool.cs',
        invokersBlock: invokersBlock(isMcp, listing, 'tests/Empresa.Proyecto.Mcp.Asistente.SmokeTests'),
        taskLine: texts.taskLine,
      })
      assert.equal(prompt, golden(`stage-2b-${name}.prompt.txt`))
    })
  }
  test('el commit del Stage 2b nombra lo que se cubrio', () => {
    assert.equal(smokeStageTexts(true, '42').commitSubject, 'test(hu-42): smoke tests para tools MCP')
    assert.equal(smokeStageTexts(false, '').commitSubject, 'test(hu-?): smoke tests para endpoints')
  })

  test('reviewer en refactor puro', () => {
    const prompt = stage3RefactorPrompt({
      projectName: PROJECT,
      issueContext: CONTEXT,
      issue: '42',
      justification: 'Extrae "Turno" a un value object; elimina 2 tests obsoletos',
      removedTests: 2,
    })
    assert.equal(prompt, golden('stage-3-refactor.prompt.txt'))
  })

  const REVIEWER = {
    projectName: PROJECT,
    issueContext: CONTEXT,
    snapshot: '0123456789abcdef0123456789abcdef01234567',
    writerHead: '89abcdef0123456789abcdef0123456789abcdef',
    diffStat: ' src/A.cs | 12 ++++++++++++\n 1 file changed, 12 insertions(+)',
    diffNameStatus: 'A\tsrc/A.cs',
    stage1Agent: 'projection-test-writer',
  }
  test('reviewer (Stage 3)', () => {
    assert.equal(stage3ReviewerPrompt({ ...REVIEWER, noRedJustification: null, smokeOnly: false }), golden('stage-3-reviewer.prompt.txt'))
  })
  test('reviewer con las notas de fase roja no aplicable, solo smoke y tests bloqueados', () => {
    const prompt =
      stage3ReviewerPrompt({ ...REVIEWER, noRedJustification: 'Unica capa posible: config-test del worker', smokeOnly: true }) +
      blockagePromptNote('/tmp/wt/.mefisto/pipeline/blockage-report.md')
    assert.equal(prompt, golden('stage-3-reviewer-notas.prompt.txt'))
  })
  test('resolucion de conflictos de merge', () => {
    assert.equal(mergePrompt({ projectName: PROJECT, conflictFiles: 'src/A.cs\ndocs/b.md' }), golden('merge.prompt.txt'))
  })
  test('domain-scaffolder (Stage 0)', () => {
    assert.equal(scaffoldPrompt('control-horas'), golden('scaffold.prompt.txt'))
  })
  test('remediaciones del coverage gate (4b y 4c)', () => {
    const patch = patchTestWriterPrompt({
      projectName: PROJECT,
      patchSpec: '/tmp/wt/.mefisto/pipeline/coverage-patch-spec.md',
      patchSpecContent: '## Coverage Patch Spec\n\nArchivos con brecha.',
      issue: '42',
    })
    assert.equal(patch, golden('patch-test-writer.prompt.txt'))
    assert.equal(patchImplementerPrompt({ projectName: PROJECT, stage1Agent: 'projection-test-writer' }), golden('patch-implementer.prompt.txt'))
  })
})

describe('coverage gate identico al de tdd-pipeline.mts', () => {
  const xml = golden('coverage.cobertura.xml')
  const logic = [
    'src/X.Turnos/RegistrarTurnoCommandHandler.cs',
    'src/X.Turnos/Turno/TurnoAggregateRoot.cs',
    'src/X.Turnos/Otro/ValidadorValidator.cs',
    'src/X.Turnos/Sin/NoMedidoEventHandler.cs',
  ]
  const data = extractFileCoverage(xml, logic)

  test('cobertura por archivo: redondeo de Python, primer paquete que lo trae y N/A al final', () => {
    assert.equal(data.map((file) => `${file.path}|${file.percent}\n`).join(''), golden('coverage-data.txt'))
  })
  test('tabla con medidos, excluidos y sin clasificar', () => {
    const evaluation = evaluateCoverage(data)
    const table = [COVERAGE_TABLE_HEADER, ...evaluation.rows, ...classificationRows(['src/X.Turnos/Program.cs'], ['src/X.Turnos/Raro.cs'])].join('\n')
    assert.equal(`${table}\n`, golden('coverage-table.txt'))
    assert.deepEqual(
      evaluation.gaps.map((gap) => gap.path),
      ['src/X.Turnos/RegistrarTurnoCommandHandler.cs', 'src/X.Turnos/Otro/ValidadorValidator.cs'],
    )
  })
  test('patch spec con las lineas sin cubrir de cada brecha', () => {
    assert.equal(coveragePatchSpec(xml, evaluateCoverage(data).gaps), golden('coverage-patch-spec.txt'))
  })
  test('un XML ilegible no da datos y el patch spec lo dice por archivo', () => {
    assert.deepEqual(extractFileCoverage('<coverage><packages>', logic), [])
    assert.equal(
      coveragePatchSpec('no es xml', [{ path: 'src/A.cs', percent: '10.0' }]).endsWith(
        '### src/A.cs (10.0% - requiere 95%)\n\n_(no se pudieron extraer lineas no cubiertas)_\n\n',
      ),
      true,
    )
  })
})

const FULL = '{"model":"modelo-a","tokens":{"input":1200,"output":340,"cache_read":50000,"cache_write":2000,"reasoning":0},"estimated_cost_usd":0.4321}'
const none = { duration: null, metrics: '' }
const EMPTY_STAGES: RunStages = {
  scaffold: none,
  stage1: none,
  stage2: none,
  smoke: none,
  reviewer: none,
  patchStage1: none,
  patchStage2: none,
  coverageSeconds: null,
}
const TW_SUMMARY = '## Tests\\n\\n- `RegistrarTurnoTests` con $VARIABLES sin expandir.'
const IM_SUMMARY = '_(El agente no generó resumen)_'
const COMMITS = '89abcde refactor(hu-42): revisión y refactor\n0123456 test(hu-42): tests fase roja'

describe('cuerpo del PR identico al de tdd-pipeline.mts', () => {
  test('corrida completa: todas las secciones opcionales en orden y la tabla de metricas', () => {
    const stages: RunStages = {
      scaffold: { duration: 10, metrics: FULL },
      stage1: { duration: 125, metrics: FULL },
      stage2: { duration: 61, metrics: 'null' },
      smoke: { duration: 40, metrics: FULL },
      reviewer: { duration: 300, metrics: FULL },
      patchStage1: { duration: 30, metrics: FULL },
      patchStage2: none,
      coverageSeconds: 12,
    }
    const composition = runMetricsStages(stages, READ_SIDE)
    const table = renderRunMetricsTable(composition.table).replace(/\n+$/, '')
    assert.equal(`${table}\n`, golden('metrics-table-completa.txt'))

    const worktree = join(work, 'completo')
    mkdirSync(join(worktree, '.mefisto', 'pipeline'), { recursive: true })
    writeFileSync(join(worktree, '.mefisto', 'pipeline', 'warnings-remanentes.txt'), '#77\nacme/otro#5\n')
    const remnants = renderWarningRemnantsSection(worktree).replace(/\n+$/, '')
    const reviewerTests = renderReviewerTouchedTestsSection(['tests/A.Tests/ATests.cs', 'tests/B.Tests/BTests.cs'], true).replace(/\n+$/, '')
    const body = pullRequestBody({
      summary: prSummary({ refactor: false, smokeOnly: false, justification: '', baselineTests: '?', smokeWritten: true, noRedJustification: 'Unica capa posible: config-test' }),
      stage1Label: READ_SIDE.stage1Label,
      stage1Seconds: 125,
      stage1Summary: TW_SUMMARY,
      implementerSection: agentDetails(`${READ_SIDE.stage2Label} (fase verde)`, 61, IM_SUMMARY),
      smokeSection: agentDetails('Smoke Test Writer', 40, 'Smokes escritos.'),
      reviewerSeconds: 300,
      reviewerSummary: 'Revisado.',
      extraSections: [
        smokeAnomalySection('src/Empresa.Proyecto/SharedFunction/FunctionEndpoint.cs'),
        smokeUnchangedSection([
          { target: 'crear_turno', file: 'tests/S.SmokeTests/Intacto.cs' },
          { target: 'turnos/{id}', file: 'tests/S.SmokeTests/Otro.cs' },
        ]),
        coverageSection({
          table: '| Archivo | Cobertura | Umbral | Estado |\n|---|---|---|---|\n| A.cs | 80.0% | 95% | gap |\n| B.cs | - | sin clasificar | ⚠ revisar |',
          hasNotEvaluated: true,
          remediation: 'Se agregaron tests de remediacion. Gaps restantes: A.cs (80.0%)',
          gapsRemaining: 1,
        }),
        `${remnants}\n\n`,
        `${reviewerTests}\n\n`,
      ].join(''),
      commits: COMMITS,
      metricsTable: table,
      closesLine: 'Closes #42',
    })
    assert.equal(body, golden('pr-body-completo.txt'))
  })

  const minimal = (overrides: Partial<Parameters<typeof pullRequestBody>[0]>, stages: RunStages): string =>
    pullRequestBody({
      summary: '',
      stage1Label: WRITE_SIDE.stage1Label,
      stage1Seconds: null,
      stage1Summary: TW_SUMMARY,
      implementerSection: '',
      smokeSection: '',
      reviewerSeconds: null,
      reviewerSummary: 'Revisado.',
      extraSections: '',
      commits: COMMITS,
      metricsTable: renderRunMetricsTable(runMetricsStages(stages, WRITE_SIDE).table).replace(/\n+$/, ''),
      closesLine: 'Closes #42',
      ...overrides,
    })

  test('refactor puro: sin implementer ni smoke y con el baseline', () => {
    const body = minimal(
      {
        summary: prSummary({ refactor: true, smokeOnly: false, justification: 'Extrae un value object', baselineTests: '425', smokeWritten: false, noRedJustification: null }),
        reviewerSeconds: 45,
      },
      { ...EMPTY_STAGES, reviewer: { duration: 45, metrics: FULL } },
    )
    assert.equal(body, golden('pr-body-refactor.txt'))
  })

  test('solo smoke: implementer documental y validacion pendiente post-deploy', () => {
    const body = minimal(
      {
        summary: prSummary({ refactor: false, smokeOnly: true, justification: '', baselineTests: '?', smokeWritten: false, noRedJustification: null }),
        stage1Seconds: 20,
        implementerSection: agentDetails(`${WRITE_SIDE.stage2Label} (modo documental)`, 5, IM_SUMMARY),
        smokeSection: smokeOnlySection(['tests/Empresa.Proyecto.Turnos.SmokeTests/A.cs', 'tests/Empresa.Proyecto.Turnos.SmokeTests/B.cs']),
        reviewerSeconds: 7,
      },
      { ...EMPTY_STAGES, stage1: { duration: 20, metrics: '' }, stage2: { duration: 5, metrics: '' }, reviewer: { duration: 7, metrics: '' } },
    )
    assert.equal(body, golden('pr-body-solo-smoke.txt'))
  })

  test('desde un archivo de HU: sin linea Closes y sin saltos finales', () => {
    const body = minimal(
      {
        summary: prSummary({ refactor: false, smokeOnly: false, justification: '', baselineTests: '?', smokeWritten: false, noRedJustification: null }),
        stage1Seconds: 20,
        implementerSection: agentDetails(`${WRITE_SIDE.stage2Label} (fase verde)`, 30, IM_SUMMARY),
        reviewerSeconds: 40,
        closesLine: '',
      },
      { ...EMPTY_STAGES, stage1: { duration: 20, metrics: '' }, stage2: { duration: 30, metrics: '' }, reviewer: { duration: 40, metrics: '' } },
    )
    assert.equal(body, golden('pr-body-minimo.txt'))
  })
})
