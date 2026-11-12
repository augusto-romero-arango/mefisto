// Decisiones del pipeline TDD que no lanzan procesos: perfiles, rama read-side, senales del
// test-writer, gates de fase roja, verde y refactor, deteccion del Stage 2b y composicion de las
// metricas. Su cableado en la corrida lo cubre tdd-pipeline.test.mts.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { coverageClassifyFile } from '../lib/pipeline/coverage.mts'
import { renderRunMetricsTable } from '../lib/pipeline/run-history.mts'
import {
  ISSUE_INCOMPLETE_HEADING,
  READ_SIDE,
  WRITE_SIDE,
  abortHistoryStages,
  greenGate,
  issueLabelNames,
  redGate,
  removedTests,
  runMetricsStages,
  signalField,
  smokeFiles,
  smokeTarget,
  stage1Output,
  stageAgentsFor,
  tddAgentProfile,
  testLossGate,
  touchedSmokeProjects,
} from '../lib/pipeline/tdd-gates.mts'
import type { RunStages } from '../lib/pipeline/tdd-gates.mts'
import { pascalCase, tddFileSlug, tddIssueSlug } from '../lib/pipeline/tdd-texts.mts'
import { extractTestCount } from '../lib/pipeline/test-results.mts'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO_ROOT, ...rel.split('/')), 'utf8')

describe('tabla agente -> perfil', () => {
  const TABLE = [
    ['test-writer', 'balanced'],
    ['projection-test-writer', 'balanced'],
    ['implementer', 'balanced'],
    ['projection-implementer', 'balanced'],
    ['smoke-test-writer', 'balanced'],
    ['domain-scaffolder', 'balanced'],
    ['reviewer', 'deep'],
  ] as const

  for (const [agent, profile] of TABLE) {
    test(`${agent}: ${profile}, igual que el profile de src/published/agents/${agent}.md`, () => {
      assert.equal(tddAgentProfile(agent), profile)
      const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(read(`src/published/agents/${agent}.md`))?.[1] ?? ''
      assert.equal((JSON.parse(frontmatter) as { profile?: string }).profile, profile)
    })
  }

  test('un agente fuera de la tabla no hereda en silencio', () => {
    assert.equal(tddAgentProfile('tooling-writer'), null)
    assert.equal(tddAgentProfile(''), null)
  })
})

describe('rama read-side por el label tipo:projection (issue #371)', () => {
  const issue = (labels: unknown): string => JSON.stringify({ labels, number: 999, state: 'OPEN', title: 'x' })

  test('tipo:projection despacha la pareja read-side con sus etiquetas', () => {
    const agents = stageAgentsFor(issueLabelNames(issue([{ id: 'LA_1', name: 'tipo:projection' }, { name: 'estado:listo' }])))
    assert.deepEqual(agents, READ_SIDE)
    assert.equal(agents.stage1Agent, 'projection-test-writer')
    assert.equal(agents.stage2Agent, 'projection-implementer')
    assert.equal(agents.stage1Label, 'Projection Test Writer')
    assert.equal(agents.stage2Label, 'Projection Implementer')
  })

  test('sin el label, o sin labels, queda la pareja write-side', () => {
    assert.deepEqual(stageAgentsFor(issueLabelNames(issue([{ name: 'tipo:feature' }]))), WRITE_SIDE)
    assert.deepEqual(stageAgentsFor(issueLabelNames(issue([]))), WRITE_SIDE)
    assert.deepEqual(stageAgentsFor(issueLabelNames(issue(null))), WRITE_SIDE)
  })

  test('un label con prefijo tipo:projection- no activa la rama', () => {
    assert.deepEqual(stageAgentsFor(issueLabelNames(issue([{ name: 'tipo:projection-experimental' }]))), WRITE_SIDE)
  })

  test('el JSON se parsea: indentado sigue activando la rama', () => {
    const indented = JSON.stringify({ labels: [{ name: 'tipo:projection' }], state: 'OPEN' }, null, 4)
    assert.deepEqual(stageAgentsFor(issueLabelNames(indented)), READ_SIDE)
  })

  test('un JSON ilegible o labels sin nombre no activan nada', () => {
    assert.deepEqual(issueLabelNames('no es json'), [])
    assert.deepEqual(issueLabelNames(issue([{ id: 'sin-nombre' }, { name: 'tipo:projection' }])), [])
    assert.deepEqual(issueLabelNames(issue([{ name: 7 }])), [])
  })
})

describe('senales del test-writer en pipeline-state/', () => {
  test('JUSTIFICATION conserva los = internos', () => {
    assert.equal(
      signalField('JUSTIFICATION=Config-test del worker: Inline=0 y MetadataConfig ya alineado\n', 'JUSTIFICATION', 'no especificada'),
      'Config-test del worker: Inline=0 y MetadataConfig ya alineado',
    )
  })
  test('sin la clave, o sin archivo legible, queda el valor por defecto', () => {
    assert.equal(signalField('REFACTOR_ONLY=true\n', 'JUSTIFICATION', 'no especificada'), 'no especificada')
    assert.equal(signalField(null, 'JUSTIFICATION', 'no especificada'), 'no especificada')
  })
  test('REMOVED_TESTS: 0 por defecto, el entero declarado, o se informa el invalido', () => {
    assert.deepEqual(removedTests('REFACTOR_ONLY=true\nJUSTIFICATION=senal vieja\n'), { value: 0 })
    assert.deepEqual(removedTests('JUSTIFICATION=x\nREMOVED_TESTS=2\n'), { value: 2 })
    assert.deepEqual(removedTests('REMOVED_TESTS=dos\n'), { invalid: 'dos' })
  })
})

describe('gate del Stage 1: refactor, tests o nada (MEF-ADR-0017)', () => {
  test('con senal de refactor gana el refactor aunque no haya cambios', () => {
    assert.equal(stage1Output(true, false, null), 'refactor')
  })
  test('cambios en tests/src: tests generados', () => {
    assert.equal(stage1Output(false, true, 'tests escritos'), 'tests')
  })
  test('sin cambios y el log dice refactor puro: falta la senal', () => {
    const log = 'El directorio .claude/ esta bloqueado.\nResultado: Refactoring Puro - No se requieren tests nuevos.\n'
    assert.equal(stage1Output(false, false, log), 'abort-signal-missing')
    assert.equal(stage1Output(false, false, 'REFACTOR_ONLY=true'), 'abort-signal-missing')
  })
  test('sin cambios ni evidencia: el agente no produjo nada', () => {
    assert.equal(stage1Output(false, false, 'Error: API timeout.\n'), 'abort-nothing')
    assert.equal(stage1Output(false, false, null), 'abort-nothing')
  })
  test('la evidencia de refactor no cruza lineas', () => {
    assert.equal(stage1Output(false, false, 'refactor\npuro'), 'abort-nothing')
  })
})

describe('gate 1b: fase roja (issue #585)', () => {
  test('exit 0 con la senal no-red continua; sin ella aborta', () => {
    assert.equal(redGate(0, true), 'continue-no-red')
    assert.equal(redGate(0, false), 'abort-all-green')
  })
  test('exit 8 (sin tests) aborta aunque haya senal', () => {
    assert.equal(redGate(8, true), 'abort-no-tests')
    assert.equal(redGate(8, false), 'abort-no-tests')
  })
  test('exit 2 o 1 (agregado mixto) es fase roja confirmada', () => {
    assert.equal(redGate(2, true), 'red-confirmed')
    assert.equal(redGate(1, true), 'red-confirmed')
    assert.equal(redGate(2, false), 'red-confirmed')
  })
})

describe('gate 2: dos motivos de blockage-report.md (issue #1561)', () => {
  const INCOMPLETE = `${ISSUE_INCOMPLETE_HEADING}\n\nFalta la seccion \`## ADRs aplicables\` en el issue.\n`
  const BLOCKED = '## Reporte de bloqueo - Implementer\n\n### Tests bloqueados\n| Test | Error | Intentos |\n'

  test('tests rojos + issue incompleto detiene el pipeline', () => {
    assert.equal(greenGate(1, INCOMPLETE), 'stop-blocked')
  })
  test('tests rojos + tests bloqueados continua al reviewer', () => {
    assert.equal(greenGate(1, BLOCKED), 'continue-blocked')
  })
  test('sin reporte decide el analisis de rojos preexistentes', () => {
    assert.equal(greenGate(1, null), 'check-preexisting')
  })
  test('tests en verde no consultan el reporte', () => {
    assert.equal(greenGate(0, INCOMPLETE), 'passed')
  })
  test('con los dos motivos gana issue incompleto', () => {
    assert.equal(greenGate(1, `${INCOMPLETE}\n${BLOCKED}`), 'stop-blocked')
  })
  test('el encabezado vale solo como linea exacta', () => {
    assert.equal(greenGate(1, '## Issue incompleto: casi\n'), 'continue-blocked')
    assert.equal(greenGate(1, '  ## Issue incompleto\n'), 'continue-blocked')
  })
  test('implementer.md fija el encabezado canonico como primera linea y no escribe codigo antes', () => {
    const doc = read('src/published/agents/implementer.md')
    assert.ok(doc.includes('`## Issue incompleto`'))
    assert.ok(doc.includes('primera linea'))
    assert.ok(doc.includes('No escribas codigo'))
  })
})

describe('gate del refactor: no se pierden tests (issue #294)', () => {
  test('la caida declarada exacta pasa; una mayor aborta', () => {
    assert.equal(testLossGate(425, 423, 2), 'ok')
    assert.equal(testLossGate(425, 422, 2), 'abort')
  })
  test('sin caida y sin tests declarados pasa; una caida no declarada aborta', () => {
    assert.equal(testLossGate(425, 425, 0), 'ok')
    assert.equal(testLossGate(425, 424, 0), 'abort')
  })
  test('sin conteo de un lado no se compara', () => {
    assert.equal(testLossGate(null, 100, 0), 'not-comparable')
    assert.equal(testLossGate(100, null, 0), 'not-comparable')
  })
  test('reubicar tests entre proyectos conserva el total de la suite', () => {
    const baseline = extractTestCount('correcto: 100\ncorrecto: 325')
    const post = extractTestCount('correcto: 60\ncorrecto: 365')
    assert.equal(baseline, 425)
    assert.equal(post, 425)
    assert.equal(testLossGate(baseline, post, 0), 'ok')
  })
})

describe('Stage 2b: que pide smoke tests (issues #371, #791, #1562)', () => {
  const NS = 'Foo.Bar'

  test('una tool MCP dispara en las dos ramas; su infraestructura no', () => {
    const diff = ['src/Foo.Bar.Mcp.Consultas/X/ListarXTool.cs', 'src/Foo.Bar.Mcp.Consultas/Infraestructura/XApi.cs']
    assert.deepEqual(smokeFiles(diff, NS, false), ['src/Foo.Bar.Mcp.Consultas/X/ListarXTool.cs'])
    assert.deepEqual(smokeFiles(diff, NS, true), ['src/Foo.Bar.Mcp.Consultas/X/ListarXTool.cs'])
  })
  test('un *Tool.cs fuera de un servidor MCP no dispara', () => {
    assert.deepEqual(smokeFiles(['src/Foo.Bar/CatalogoTurnos/CatalogoTurnosTool.cs'], NS, false), [])
  })
  test('Functions de comando en las dos ramas; queries GET solo en la read-side', () => {
    assert.deepEqual(smokeFiles(['src/Foo.Bar/CrearTurnoFunction/FunctionEndpoint.cs'], NS, false), ['src/Foo.Bar/CrearTurnoFunction/FunctionEndpoint.cs'])
    const queries = ['src/Foo.Bar/ObtenerTurno/FunctionEndpoint.cs', 'src/Foo.Bar/ListarTurnos/FunctionEndpoint.cs', 'src/Foo.Bar.ReadModels/TurnoView.cs']
    assert.deepEqual(smokeFiles(queries, NS, true), queries.slice(0, 2))
    assert.deepEqual(smokeFiles(queries, NS, false), [])
  })
  test('un match de tests/ no entra aunque contenga Function/', () => {
    const diff = ['src/Foo.Bar/CrearTurnoFunction/FunctionEndpoint.cs', 'tests/Foo.Bar.SmokeTests/CrearTurnoFunction/CrearTurnoSmokeTests.cs']
    assert.deepEqual(smokeFiles(diff, NS, false), diff.slice(0, 1))
    assert.deepEqual(smokeFiles(diff.slice(1), NS, false), [])
  })
  test('el proyecto smoke de una tool MCP es el del servidor', () => {
    const target = smokeTarget(['src/Foo.Bar.Mcp.Consultas/X/ListarXTool.cs'], NS)
    assert.equal(target.project, 'tests/Foo.Bar.Mcp.Consultas.SmokeTests')
    assert.equal(target.isMcp, true)
    assert.equal(target.anomaly, false)
  })
  test('un dominio bien formado resuelve su proyecto y no es anomalia', () => {
    const target = smokeTarget(['src/Foo.Bar.Turnos/CrearTurnoFunction/FunctionEndpoint.cs'], NS)
    assert.equal(target.project, 'tests/Foo.Bar.Turnos.SmokeTests')
    assert.equal(target.isMcp, false)
    assert.equal(target.anomaly, false)
  })
  test('una ruta sin la forma src/<ns>.<Dominio>/ o anidada es anomalia', () => {
    assert.equal(smokeTarget(['src/Foo.Bar/SharedFunction/FunctionEndpoint.cs'], NS).anomaly, true)
    const nested = smokeTarget(['src/Legacy/src/Foo.Bar.Turnos/CrearTurnoFunction/FunctionEndpoint.cs'], NS)
    assert.equal(nested.domain, 'src/Legacy/Turnos')
    assert.equal(nested.anomaly, true)
  })
  test('proyectos smoke tocados, sin repetir y en orden', () => {
    assert.deepEqual(
      touchedSmokeProjects(['tests/B.SmokeTests/x.cs', 'src/a.cs', 'tests/A.SmokeTests/y/z.cs', 'tests/B.SmokeTests/w.cs', 'tests/A.Tests/q.cs']),
      ['tests/A.SmokeTests', 'tests/B.SmokeTests'],
    )
  })
  test('el FunctionEndpoint de una query GET se excluye del coverage solo en la read-side', () => {
    const classify = (projection: boolean, path: string): string => coverageClassifyFile(path, REPO_ROOT, projection)
    assert.equal(classify(true, 'src/Foo.Bar/ObtenerTurno/FunctionEndpoint.cs'), 'excluded')
    assert.equal(classify(true, 'src/Foo.Bar/ListarEventosDeTurno/FunctionEndpoint.cs'), 'excluded')
    assert.equal(classify(true, 'src/Foo.Bar/CrearTurnoFunction/FunctionEndpoint.cs'), 'logic')
    assert.equal(classify(true, 'src/Foo.Bar/ObtenerCodigoFunction/FunctionEndpoint.cs'), 'logic')
    assert.equal(classify(false, 'src/Foo.Bar/ObtenerTurno/FunctionEndpoint.cs'), 'logic')
  })
})

describe('metricas de la corrida: una sola lista para el PR y el historial (issue #1313)', () => {
  const FULL = '{"model":"modelo-a","tokens":{"input":10,"output":20,"cache_read":30,"cache_write":40,"reasoning":50},"estimated_cost_usd":0.25}'
  const none = { duration: null, metrics: '' }
  const EMPTY: RunStages = { scaffold: none, stage1: none, stage2: none, smoke: none, reviewer: none, patchStage1: none, patchStage2: none, coverageSeconds: null }

  test('corrida completa: seis etapas con sus etiquetas y el total parcial por el gate', () => {
    const composition = runMetricsStages(
      {
        ...EMPTY,
        scaffold: { duration: 10, metrics: FULL },
        stage1: { duration: 20, metrics: FULL },
        stage2: { duration: 30, metrics: FULL },
        smoke: { duration: 40, metrics: FULL },
        reviewer: { duration: 50, metrics: FULL },
        coverageSeconds: 60,
      },
      READ_SIDE,
    )
    const table = renderRunMetricsTable(composition.table)
    assert.equal(composition.table.length, 6)
    assert.equal(composition.history.length, 5)
    assert.equal(composition.coverageGate, true)
    for (const row of ['| Projection Test Writer | modelo-a |', '| Projection Implementer | modelo-a |', '| Smoke Test Writer | modelo-a |', '| coverage-gate | - | - | - | 1m 0s | - |', '| **Total (parcial)** | - | - | - | **3m 30s** | **$1.25** |']) {
      assert.ok(table.includes(row), row)
    }
  })

  test('refactor puro: solo el reviewer, sin gate', () => {
    const composition = runMetricsStages({ ...EMPTY, reviewer: { duration: 45, metrics: FULL } }, READ_SIDE)
    const table = renderRunMetricsTable(composition.table)
    assert.equal(composition.table.length, 1)
    assert.ok(table.includes('| Reviewer | modelo-a |'))
    assert.equal(/Writer|coverage-gate/.test(table), false)
    assert.equal(composition.coverageGate, false)
  })

  test('remediaciones con metricas, reviewer sin metricas y gate: total parcial', () => {
    const composition = runMetricsStages(
      { ...EMPTY, reviewer: { duration: 15, metrics: 'null' }, patchStage1: { duration: 30, metrics: FULL }, patchStage2: { duration: 45, metrics: FULL }, coverageSeconds: 12 },
      READ_SIDE,
    )
    const table = renderRunMetricsTable(composition.table)
    for (const row of [
      '| Reviewer | - | - | - | 0m 15s | - |',
      '| Remediacion: Projection Test Writer | modelo-a | 150 | 10 / 20 / 70 / 50 | 0m 30s | $0.25 |',
      '| Remediacion: Projection Implementer | modelo-a | 150 | 10 / 20 / 70 / 50 | 0m 45s | $0.25 |',
      '| coverage-gate | - | - | - | 0m 12s | - |',
      '| **Total (parcial)** | - | - | - | **1m 42s** | **$0.50** |',
    ]) {
      assert.ok(table.includes(row), row)
    }
    assert.deepEqual(
      composition.history.map((stage) => [stage.key, stage.agent]),
      [['reviewer', 'reviewer'], ['patch-test-writer', 'projection-test-writer'], ['patch-implementer', 'projection-implementer']],
    )
  })

  test('el historial de un aborto lleva las tres centrales siempre y las demas solo con metricas', () => {
    const stages = abortHistoryStages({ ...EMPTY, smoke: { duration: 4, metrics: FULL }, patchStage2: { duration: 9, metrics: '' } }, WRITE_SIDE)
    assert.deepEqual(
      stages.map((stage) => [stage.key, stage.agent, stage.duration]),
      [['test-writer', 'test-writer', ''], ['implementer', 'implementer', ''], ['reviewer', 'reviewer', ''], ['smoke-test-writer', 'smoke-test-writer', '4']],
    )
  })
})

describe('nombres de rama y de proyecto', () => {
  test('slug de un issue: acentos a su base, sin signos, sin guiones del titulo y 40 caracteres', () => {
    assert.equal(tddIssueSlug('Registrar Ausencia del Colaborador'), 'registrar-ausencia-del-colaborador')
    assert.equal(tddIssueSlug('Crear jornada día ÚNICO (versión 2)'), 'crear-jornada-dia-unico-version-2')
    assert.equal(tddIssueSlug('Pre-cargar Ñandú: año'), 'precargar-andu-ao')
    assert.equal(tddIssueSlug('Un titulo muy largo que pasa de los cuarenta caracteres'), 'un-titulo-muy-largo-que-pasa-de-los-cuar')
    assert.equal(tddIssueSlug('Termina en espacio de corte xxxxxxxxxxx yy'), 'termina-en-espacio-de-corte-xxxxxxxxxxx')
    assert.equal(tddIssueSlug(' Espacio inicial y  doble'), '-espacio-inicial-y-doble')
  })
  test('slug de un archivo de HU: cada signo un guion', () => {
    assert.equal(tddFileSlug('HU-25 Registrar turno'), 'hu-25-registrar-turno')
    assert.equal(tddFileSlug('HU  25__día'), 'hu-25-d-a')
    assert.equal(tddFileSlug(' Espacio inicial y  doble'), '-espacio-inicial-y-doble')
    assert.equal(tddFileSlug('Pre-cargar xandx: axo'), 'pre-cargar-xandx-axo')
  })
  test('dominio kebab a PascalCase', () => {
    assert.equal(pascalCase('control-horas'), 'ControlHoras')
    assert.equal(pascalCase('ventas'), 'Ventas')
  })
})
