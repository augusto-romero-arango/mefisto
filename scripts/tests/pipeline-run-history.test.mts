import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  appendCompletedHistory,
  buildAgentsHistoryJson,
  renderRunMetricCount,
  renderRunMetricsTable,
} from '../lib/pipeline/run-history.mts'
import type { AgentStage, RunStage } from '../lib/pipeline/run-history.mts'

const WRITER =
  '{"model":"openai/gpt-5.6-terra","tokens":{"input":117000,"output":5700,"cache_read":1300000,"cache_write":22000,"reasoning":3000},"estimated_cost_usd":0.59}'
const REVIEWER =
  '{"model":"openai/gpt-5.6-sol","tokens":{"input":76000,"output":4300,"cache_read":1050000,"cache_write":1500,"reasoning":8500},"estimated_cost_usd":0.84}'
const NO_COST =
  '{"model":"modelo-sin-costo","tokens":{"input":10,"output":20,"cache_read":30,"cache_write":40,"reasoning":50},"estimated_cost_usd":null}'
const ZERO_COST =
  '{"model":"modelo-cero","tokens":{"input":1,"output":2,"cache_read":3,"cache_write":4,"reasoning":5},"estimated_cost_usd":0,"cost_usd":99}'
const INCOMPLETE =
  '{"model":"modelo-incompleto","tokens":{"input":10,"output":20,"cache_read":30,"cache_write":40},"estimated_cost_usd":1.25}'
const FULL = '{"model":"modelo-a","tokens":{"input":10,"output":20,"cache_read":30,"cache_write":40,"reasoning":50},"estimated_cost_usd":0.25}'
const HEADER = '| Etapa | Modelo | Tokens | in/out/cache/reasoning | Tiempo | Costo estimado |\n|---|---|---:|---|---:|---:|\n'

const stage = (label: string, duration: string | number | null, metrics: string): RunStage => ({ label, duration, metrics })
const agent = (key: string, name: string, duration: string, metrics: string): AgentStage => ({ key, agent: name, duration, metrics })
const tokens = (input: unknown, rest = '"output":2,"cache_read":3,"cache_write":4,"reasoning":5'): string =>
  `{"model":"m","tokens":{"input":${String(input)},${rest}},"estimated_cost_usd":0.5}`

// Tablas de ejemplo, con cada forma de degradar; sus filas esperadas estan en fixtures/run-history/metrics-tables.json.
const TABLES: Record<string, RunStage[]> = {
  'metricas completas': [stage('Writer', 907, WRITER), stage('Reviewer', 292, REVIEWER)],
  'metricas null y costo null': [stage('Writer', 60, 'null'), stage('Reviewer', 30, NO_COST)],
  'costo cero': [stage('Cero', 1, ZERO_COST), stage('SinCosto', 2, NO_COST)],
  'contador ausente': [stage('Incompleta', 5, INCOMPLETE)],
  'corrida tdd completa': [
    stage('Scaffolder', 10, FULL),
    stage('Projection Test Writer', 20, FULL),
    stage('Projection Implementer', 30, FULL),
    stage('Smoke Test Writer', 40, FULL),
    stage('Reviewer', 50, FULL),
    stage('coverage-gate', 60, ''),
  ],
  'solo reviewer': [stage('Reviewer', 45, FULL)],
  'sin etapas': [],
  'duraciones que no son enteros': [stage('A', '', FULL), stage('B', '1.5', FULL), stage('C', '-3', FULL), stage('D', 'null', FULL), stage('E', null, FULL)],
  'etiqueta y modelo con barras y saltos': [stage('Uno | dos\ntres', 5, '{"model":"a|b","tokens":{},"estimated_cost_usd":1}')],
  'modelo con salto de linea': [stage('X', 5, '{"model":"a\\nb","tokens":{"input":1},"estimated_cost_usd":1}')],
  'metricas invalidas': [stage('A', 5, '{'), stage('B', 5, '[1]'), stage('C', 5, '"texto"'), stage('D', 5, '{"tokens":"n/d"}'), stage('E', 5, ' ')],
  'dos valores en las metricas': [stage('A', 5, `${FULL} ${WRITER}`), stage('B', 5, `${FULL} {`), stage('C', 5, `5 ${FULL}`)],
  'modelo ausente o vacio': [stage('A', 5, '{"model":"","tokens":{}}'), stage('B', 5, '{"model":7}'), stage('C', 5, '{}')],
  'contadores que no son enteros': [
    stage('A', 5, tokens(1.5)),
    stage('B', 5, tokens(-1)),
    stage('C', 5, tokens('"7"')),
    stage('D', 5, tokens('1.0')),
    stage('E', 5, tokens('1e3')),
    stage('F', 5, tokens('-0')),
    stage('G', 5, tokens('007')),
  ],
  'cache incompleto': [stage('A', 5, tokens(1, '"output":2,"cache_read":3,"reasoning":5')), stage('B', 5, tokens(1, '"output":2,"cache_write":4,"reasoning":5'))],
  umbrales: [999, 1000, 1049, 1050, 1950, 999949, 999950, 999999, 1000000, 1004999, 1005000, 1125000, 1135000, 123456789].map((count) =>
    stage(`n${count}`, count, tokens(count, '"output":0,"cache_read":0,"cache_write":0,"reasoning":0')),
  ),
  'costos con redondeo': ['0.125', '0.135', '0.005', '0.015', '2.675', '1e-7', '5E-7', '1.50', '1e2', '0.1', '0.2', '-1', '"1"'].map((cost) =>
    stage(`c${cost}`, 61, `{"model":"m","tokens":{"input":1,"output":1,"cache_read":1,"cache_write":1,"reasoning":1},"estimated_cost_usd":${cost}}`),
  ),
  'duracion larga': [stage('Larga', 3599, FULL), stage('Mas larga', 86400, FULL), stage('Cero', 0, FULL)],
}

// Grupos de ejemplo del objeto `agents`.
const AGENTS: Record<string, AgentStage[]> = {
  'dos grupos': [agent('test-writer', 'projection-test-writer', '125', WRITER), agent('reviewer', 'reviewer', '300', 'null')],
  'metricas vacias': [agent('implementer', 'projection-implementer', '', '')],
  'agente vacio': [agent('reviewer', '', '300', '{"turns":5}')],
  'siete grupos': [
    agent('test-writer', 'test-writer', '60', 'null'),
    agent('implementer', 'implementer', '90', 'null'),
    agent('smoke-test-writer', 'smoke-test-writer', '40', 'null'),
    agent('reviewer', 'reviewer', '120', 'null'),
    agent('scaffolder', 'domain-scaffolder', '300', 'null'),
    agent('patch-test-writer', 'test-writer', '30', 'null'),
    agent('patch-implementer', 'implementer', '20', 'null'),
  ],
  'sin grupos': [],
  'metricas con agent previo': [agent('writer', 'nuevo', '1', '{"agent":"viejo","turns":1}')],
  'clave repetida': [agent('a', 'x', '1', '{"n":1}'), agent('b', 'y', '2', 'null'), agent('a', 'z', '3', '{"n":2}')],
  'duraciones raras': [
    agent('a', '', 'null', 'null'),
    agent('b', '', '1.50', 'null'),
    agent('c', '', 'abc', 'null'),
    agent('e', '', '1e3', 'null'),
    agent('f', '', '007', 'null'),
    agent('g', '', 'true', 'null'),
    agent('h', '', 'nan', 'null'),
  ],
  'metricas invalidas': [agent('a', 'x', '1', '{'), agent('b', 'x', '2', 'no json'), agent('c', 'x', '3', '{"a":1} {"b":2}')],
  'metricas con literales': [agent('a', 'x', '1', '{"cost":0.10,"ms":1e3,"t":{"n":1.0}}')],
  'clave con caracteres que se escapan': [agent('con "comillas"', 'ñ\t', '1', '{"a":1}')],
  'metricas que no son objeto, sin agente': [agent('a', '', '1', '5'), agent('b', '', '2', '[1,2]'), agent('c', '', '3', 'false')],
  'metricas que no son objeto, con agente': [agent('a', 'x', '125', '5'), agent('b', '', '', '{"a":1}')],
  'metricas false con agente': [agent('a', 'x', '', 'false')],
}

let work = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto run history '))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('renderRunMetricsTable', () => {
  test('metricas completas con cache y razonamiento', () => {
    assert.equal(
      renderRunMetricsTable(TABLES['metricas completas'] ?? []),
      `${HEADER}| Writer | openai/gpt-5.6-terra | 1.45M | 117k / 5.7k / 1.32M / 3k | 15m 7s | $0.59 |\n` +
        '| Reviewer | openai/gpt-5.6-sol | 1.14M | 76k / 4.3k / 1.05M / 8.5k | 4m 52s | $0.84 |\n' +
        '| **Total** | - | **2.59M** | - | **19m 59s** | **$1.43** |\n',
    )
  })

  test('metricas null y costo null degradan a - y dejan el total parcial', () => {
    assert.equal(
      renderRunMetricsTable(TABLES['metricas null y costo null'] ?? []),
      `${HEADER}| Writer | - | - | - | 1m 0s | - |\n` +
        '| Reviewer | modelo-sin-costo | 150 | 10 / 20 / 70 / 50 | 0m 30s | - |\n' +
        '| **Total (parcial)** | - | - | - | **1m 30s** | - |\n',
    )
  })

  test('un costo estimado de cero es presente; el costo legado se ignora', () => {
    assert.equal(
      renderRunMetricsTable(TABLES['costo cero'] ?? []),
      `${HEADER}| Cero | modelo-cero | 15 | 1 / 2 / 7 / 5 | 0m 1s | $0.00 |\n` +
        '| SinCosto | modelo-sin-costo | 150 | 10 / 20 / 70 / 50 | 0m 2s | - |\n' +
        '| **Total (parcial)** | - | **165** | - | **0m 3s** | **$0.00** |\n',
    )
  })

  test('un contador ausente no se inventa como cero', () => {
    assert.equal(
      renderRunMetricsTable(TABLES['contador ausente'] ?? []),
      `${HEADER}| Incompleta | modelo-incompleto | - | 10 / 20 / 70 / - | 0m 5s | $1.25 |\n` +
        '| **Total (parcial)** | - | - | - | **0m 5s** | **$1.25** |\n',
    )
  })

  test('corrida tdd completa: una etapa sin metricas vuelve parcial el total', () => {
    const table = renderRunMetricsTable(TABLES['corrida tdd completa'] ?? [])
    assert.match(table, /^\| Projection Test Writer \| modelo-a \| 150 \| 10 \/ 20 \/ 70 \/ 50 \| 0m 20s \| \$0\.25 \|$/m)
    assert.match(table, /^\| coverage-gate \| - \| - \| - \| 1m 0s \| - \|$/m)
    assert.match(table, /^\| \*\*Total \(parcial\)\*\* \| - \| - \| - \| \*\*3m 30s\*\* \| \*\*\$1\.25\*\* \|$/m)
  })

  test('remediaciones con metricas null conservan el total parcial', () => {
    const table = renderRunMetricsTable([
      stage('Reviewer', 15, 'null'),
      stage('Remediacion: Projection Test Writer', 30, FULL),
      stage('Remediacion: Projection Implementer', 45, FULL),
      stage('coverage-gate', 12, ''),
    ])
    assert.match(table, /^\| Reviewer \| - \| - \| - \| 0m 15s \| - \|$/m)
    assert.match(table, /^\| Remediacion: Projection Implementer \| modelo-a \| 150 \| 10 \/ 20 \/ 70 \/ 50 \| 0m 45s \| \$0\.25 \|$/m)
    assert.match(table, /^\| \*\*Total \(parcial\)\*\* \| - \| - \| - \| \*\*1m 42s\*\* \| \*\*\$0\.50\*\* \|$/m)
  })

  test('sin etapas solo queda el total completo en cero', () => {
    assert.equal(renderRunMetricsTable([]), `${HEADER}| **Total** | - | **0** | - | **0m 0s** | - |\n`)
  })

  test('las barras de la etiqueta y del modelo se escapan', () => {
    assert.match(renderRunMetricsTable(TABLES['etiqueta y modelo con barras y saltos'] ?? []), /^\| Uno \\\| dos tres \| a\\\|b \| - \|/m)
  })

  test('renderRunMetricCount compacta miles y millones', () => {
    assert.deepEqual(
      ['0', '999', '1000', '1050', '117000', '5700', '999950', '1000000', '1320000', '', '1.5', '-1', 'x'].map(renderRunMetricCount),
      ['0', '999', '1k', '1.1k', '117k', '5.7k', '1000k', '1.00M', '1.32M', '-', '-', '-', '-'],
    )
  })
})

describe('buildAgentsHistoryJson', () => {
  test('dos grupos: conserva la duracion y anida el agente real en metrics.agent', () => {
    const agents = JSON.parse(buildAgentsHistoryJson(AGENTS['dos grupos'] ?? [])) as Record<string, { duration: unknown; metrics: Record<string, unknown> | null }>
    assert.equal(agents['test-writer']?.duration, 125)
    assert.equal(agents.reviewer?.duration, 300)
    assert.equal(agents['test-writer']?.metrics?.model, 'openai/gpt-5.6-terra')
    assert.equal(agents['test-writer']?.metrics?.agent, 'projection-test-writer')
    assert.equal(agents.reviewer?.metrics, null)
  })

  test('sin metricas no hay donde anidar el agente', () => {
    assert.equal(buildAgentsHistoryJson(AGENTS['metricas vacias'] ?? []), '{"implementer":{"duration":null,"metrics":null}}')
  })

  test('un agente vacio no agrega metrics.agent', () => {
    assert.equal(buildAgentsHistoryJson(AGENTS['agente vacio'] ?? []), '{"reviewer":{"duration":300,"metrics":{"turns":5}}}')
  })

  test('tantas claves como grupos, en su orden', () => {
    const agents = JSON.parse(buildAgentsHistoryJson(AGENTS['siete grupos'] ?? [])) as Record<string, { duration: number }>
    assert.deepEqual(Object.keys(agents), [
      'test-writer',
      'implementer',
      'smoke-test-writer',
      'reviewer',
      'scaffolder',
      'patch-test-writer',
      'patch-implementer',
    ])
    assert.equal(agents.scaffolder?.duration, 300)
    assert.equal(agents['patch-implementer']?.duration, 20)
  })

  test('unas metricas que no son un objeto degradan a solo duration por clave', () => {
    assert.equal(
      buildAgentsHistoryJson(AGENTS['metricas que no son objeto, con agente'] ?? []),
      '{"a":{"duration":125},"b":{"duration":null}}',
    )
  })

  test('la entrada del historial que lo contiene es JSON valido de una linea', () => {
    const agents = buildAgentsHistoryJson(AGENTS['dos grupos'] ?? [])
    const line = `{"issue":"646","state":"completed","agents":${agents},"tests":10}`
    assert.equal(line.includes('\n'), false)
    const entry = JSON.parse(line) as { agents: Record<string, { duration: number; metrics: { tokens: { input: number } } }> }
    assert.equal(entry.agents['test-writer']?.duration, 125)
    assert.equal(entry.agents['test-writer']?.metrics.tokens.input, 117000)
  })
})

describe('appendCompletedHistory', () => {
  const NOW = new Date(2026, 7, 16, 9, 5, 7)

  test('agrega la entrada al historial', () => {
    const history = join(work, 'ok-history.jsonl')
    const events = join(work, 'ok-events.log')
    const warnings: string[] = []
    const deps = { warn: (message: string) => warnings.push(message), now: () => NOW }
    assert.equal(appendCompletedHistory(history, events, () => '{"tests":null}', deps), true)
    assert.equal(appendCompletedHistory(history, events, () => '{"tests":3}\n', deps), true)
    assert.equal(readFileSync(history, 'utf8'), '{"tests":null}\n{"tests":3}\n')
    assert.deepEqual(warnings, [])
    assert.equal(existsSync(events), false)
  })

  test('un fallo al producir la entrada avisa, deja evento y no detiene el cierre', () => {
    const history = join(work, 'fallo-history.jsonl')
    const events = join(work, 'fallo-events.log')
    writeFileSync(events, 'previo\n')
    const warnings: string[] = []
    const fail = (): string => {
      throw new Error('jq: invalid JSON text passed to --argjson')
    }
    assert.equal(appendCompletedHistory(history, events, fail, { warn: (message) => warnings.push(message), now: () => NOW }), false)
    assert.equal(readFileSync(history, 'utf8'), '')
    assert.deepEqual(warnings, ['No se pudo registrar el historial completado; el PR ya fue creado'])
    assert.equal(readFileSync(events, 'utf8'), 'previo\n[09:05:07] WARN: no se pudo registrar el historial completado; el PR ya fue creado\n')
  })

  test('sin poder abrir el historial ni el events log tampoco falla', () => {
    const missing = join(work, 'no-existe')
    const warn = (): void => {
      throw new Error('warn roto')
    }
    assert.equal(appendCompletedHistory(join(missing, 'history.jsonl'), join(missing, 'events.log'), () => '{}', { warn, now: () => NOW }), false)
  })
})

describe('casos de ejemplo', () => {
  const ROWS = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'run-history', 'metrics-tables.json'), 'utf8')) as Record<string, string[]>

  test('cada tabla de ejemplo tiene sus filas esperadas', () => {
    assert.deepEqual(Object.keys(ROWS), Object.keys(TABLES))
    for (const [name, stages] of Object.entries(TABLES)) {
      assert.equal(renderRunMetricsTable(stages), `${HEADER}${(ROWS[name] ?? []).map((row) => `${row}\n`).join('')}`, name)
    }
  })

  test('renderRunMetricCount en los umbrales de redondeo', () => {
    const cases: [string, string][] = [
      ['7', '7'],
      ['1049', '1k'],
      ['1950', '1.9k'],
      ['99950', '100k'],
      ['999949', '999.9k'],
      ['1005000', '1.00M'],
      ['1125000', '1.12M'],
    ]
    for (const [count, text] of cases) assert.equal(renderRunMetricCount(count), text, count)
  })

  test('cada grupo de ejemplo da su objeto agents', () => {
    const expected: [string, string][] = [
      ['dos grupos', '{"test-writer":{"duration":125,"metrics":{"model":"openai/gpt-5.6-terra","tokens":{"input":117000,"output":5700,"cache_read":1300000,"cache_write":22000,"reasoning":3000},"estimated_cost_usd":0.59,"agent":"projection-test-writer"}},"reviewer":{"duration":300,"metrics":null}}'],
      ['metricas vacias', '{"implementer":{"duration":null,"metrics":null}}'],
      ['agente vacio', '{"reviewer":{"duration":300,"metrics":{"turns":5}}}'],
      ['siete grupos', '{"test-writer":{"duration":60,"metrics":null},"implementer":{"duration":90,"metrics":null},"smoke-test-writer":{"duration":40,"metrics":null},"reviewer":{"duration":120,"metrics":null},"scaffolder":{"duration":300,"metrics":null},"patch-test-writer":{"duration":30,"metrics":null},"patch-implementer":{"duration":20,"metrics":null}}'],
      ['sin grupos', '{}'],
      ['metricas con agent previo', '{"writer":{"duration":1,"metrics":{"agent":"nuevo","turns":1}}}'],
      ['clave repetida', '{"a":{"duration":3,"metrics":{"n":2,"agent":"z"}},"b":{"duration":2,"metrics":null}}'],
      ['duraciones raras', '{"a":{"duration":null,"metrics":null},"b":{"duration":1.50,"metrics":null},"c":{"duration":null,"metrics":null},"e":{"duration":1E+3,"metrics":null},"f":{"duration":7,"metrics":null},"g":{"duration":null,"metrics":null},"h":{"duration":null,"metrics":null}}'],
      ['metricas invalidas', '{"a":{"duration":1,"metrics":null},"b":{"duration":2,"metrics":null},"c":{"duration":3,"metrics":null}}'],
      ['metricas con literales', '{"a":{"duration":1,"metrics":{"cost":0.10,"ms":1E+3,"t":{"n":1.0},"agent":"x"}}}'],
      ['clave con caracteres que se escapan', '{"con \\"comillas\\"":{"duration":1,"metrics":{"a":1,"agent":"ñ\\t"}}}'],
      ['metricas que no son objeto, sin agente', '{"a":{"duration":1,"metrics":5},"b":{"duration":2,"metrics":[1,2]},"c":{"duration":3,"metrics":false}}'],
      ['metricas que no son objeto, con agente', '{"a":{"duration":125},"b":{"duration":null}}'],
      ['metricas false con agente', '{"a":{"duration":null}}'],
    ]
    assert.deepEqual(expected.map(([name]) => name), Object.keys(AGENTS))
    for (const [name, json] of expected) assert.equal(buildAgentsHistoryJson(AGENTS[name] ?? []), json, name)
  })
})
