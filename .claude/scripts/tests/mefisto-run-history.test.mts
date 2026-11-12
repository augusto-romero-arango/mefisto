import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { buildAgentsHistoryJson } from '../../../src/internal/scripts/lib/mefisto-run-history.mts'
import type { AgentRun } from '../../../src/internal/scripts/lib/mefisto-run-history.mts'
import { computeStageMetrics } from '../../../src/internal/scripts/lib/mefisto-stage-metrics.mts'
import { INTERNAL_EVENTS } from './mefisto-agents-fixtures.mts'

let work = ''
let writerMetrics = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto run history '))
  const events = join(work, 'writer.events.jsonl')
  writeFileSync(events, INTERNAL_EVENTS['metricas-completas'] ?? '')
  writerMetrics = computeStageMetrics(events)
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

const run = (duration: string, metrics: string): AgentRun => ({ duration, metrics })

interface AgentEntry {
  duration: unknown
  metrics: Record<string, unknown> | null
  runtime: unknown
}

const parse = (text: string): Record<'writer' | 'reviewer', AgentEntry> => JSON.parse(text) as Record<'writer' | 'reviewer', AgentEntry>

describe('buildAgentsHistoryJson', () => {
  test('[J-1..J-6] agrega metrics y runtime sin tocar duration', () => {
    const agents = parse(buildAgentsHistoryJson(run('125', writerMetrics), run('210', 'null')))
    assert.equal(agents.writer.duration, 125)
    assert.equal(agents.reviewer.duration, 210)
    assert.equal(agents.writer.metrics?.turns, 4)
    assert.equal(agents.reviewer.metrics, null)
    assert.equal(agents.writer.runtime, 'claude')
    assert.equal(agents.reviewer.runtime, null)
  })

  test('[J-7] las metricas no traen los nombres legados cost_usd ni cache_creation', () => {
    const text = buildAgentsHistoryJson(run('125', writerMetrics), run('210', 'null'))
    assert.ok(!text.includes('"cost_usd"') && !text.includes('cache_creation'))
  })

  test('el objeto es writer y reviewer, cada uno con duration, metrics y runtime, en ese orden', () => {
    assert.equal(
      buildAgentsHistoryJson(run('125', '{"runtime":"fake","turns":2}'), run('', '')),
      '{"writer":{"duration":125,"metrics":{"runtime":"fake","turns":2},"runtime":"fake"},"reviewer":{"duration":null,"metrics":null,"runtime":null}}',
    )
  })

  test('un stage que no corrio da duration, metrics y runtime null', () => {
    assert.equal(
      buildAgentsHistoryJson(run('', ''), run('', '')),
      '{"writer":{"duration":null,"metrics":null,"runtime":null},"reviewer":{"duration":null,"metrics":null,"runtime":null}}',
    )
  })

  test('[J-8] unas metricas o una duracion que no sirven degradan al formato plano, sin metrics ni runtime', () => {
    const flat = '{"writer":{"duration":125},"reviewer":{"duration":null}}'
    for (const metrics of ['{', 'no json', '5', '[1]', '"texto"', 'false', '{"a":1} {"b":2}']) {
      assert.equal(buildAgentsHistoryJson(run('125', metrics), run('', '')), flat, metrics)
      assert.equal(buildAgentsHistoryJson(run('125', ''), run('', metrics)), flat, metrics)
    }
    // La duracion se copia tal cual: una que no es JSON deja una entrada que tampoco lo es.
    assert.equal(buildAgentsHistoryJson(run('abc', ''), run('7', '')), '{"writer":{"duration":abc},"reviewer":{"duration":7}}')
    assert.equal(buildAgentsHistoryJson(run('1 2', writerMetrics), run('7', '')), '{"writer":{"duration":1 2},"reviewer":{"duration":7}}')
  })

  test('[K] la linea del historial es JSON valido de una sola linea', () => {
    const agents = buildAgentsHistoryJson(run('125', writerMetrics), run('210', 'null'))
    const entry = `{"issue":"907","state":"completed","agents":${agents},"pr":"https://github.com/x/y/pull/1"}`
    assert.equal(entry.includes('\n'), false)
    const parsed = JSON.parse(entry) as { agents: Record<'writer' | 'reviewer', AgentEntry> }
    assert.equal(parsed.agents.writer.duration, 125)
    assert.equal(parsed.agents.writer.metrics?.turns, 4)
    assert.equal(parsed.agents.writer.runtime, 'claude')
  })

  test('los numeros conservan su literal', () => {
    assert.equal(
      buildAgentsHistoryJson(run('1.50', '{"runtime":"x","c":0.10}'), run(' 12 ', ' null ')),
      '{"writer":{"duration":1.50,"metrics":{"runtime":"x","c":0.10},"runtime":"x"},"reviewer":{"duration":12,"metrics":null,"runtime":null}}',
    )
  })

  test('un runtime que no es texto se promueve igual', () => {
    assert.equal(parse(buildAgentsHistoryJson(run('1', '{"runtime":7}'), run('2', '{}'))).writer.runtime, 7)
    assert.equal(parse(buildAgentsHistoryJson(run('1', '{"runtime":7}'), run('2', '{}'))).reviewer.runtime, null)
  })

  test('metricas validas con espacios, runtime nulo o runtime objeto', () => {
    const reviewer = '"reviewer":{"duration":210,"metrics":null,"runtime":null}}'
    assert.equal(buildAgentsHistoryJson(run('125', '{"runtime":null}'), run('210', 'null')), `{"writer":{"duration":125,"metrics":{"runtime":null},"runtime":null},${reviewer}`)
    assert.equal(
      buildAgentsHistoryJson(run('125', '{"runtime":{"a":1},"tokens":{"input":5}}'), run('210', 'null')),
      `{"writer":{"duration":125,"metrics":{"runtime":{"a":1},"tokens":{"input":5}},"runtime":{"a":1}},${reviewer}`,
    )
    assert.equal(
      buildAgentsHistoryJson(run('125', ' {"runtime":"espacios"} '), run('210', 'null')),
      `{"writer":{"duration":125,"metrics":{"runtime":"espacios"},"runtime":"espacios"},${reviewer}`,
    )
    for (const metrics of ['true', '[1,2]']) {
      assert.equal(buildAgentsHistoryJson(run('125', metrics), run('210', 'null')), '{"writer":{"duration":125},"reviewer":{"duration":210}}', metrics)
    }
  })

  test('una duracion que es JSON se copia tal cual en los dos stages', () => {
    for (const duration of ['0', 'null', '-3', '"7"', 'true']) {
      assert.equal(
        buildAgentsHistoryJson(run(duration, '{"runtime":"x"}'), run('5', '')),
        `{"writer":{"duration":${duration},"metrics":{"runtime":"x"},"runtime":"x"},"reviewer":{"duration":5,"metrics":null,"runtime":null}}`,
      )
      assert.equal(
        buildAgentsHistoryJson(run('5', '{"runtime":"x"}'), run(duration, 'null')),
        `{"writer":{"duration":5,"metrics":{"runtime":"x"},"runtime":"x"},"reviewer":{"duration":${duration},"metrics":null,"runtime":null}}`,
      )
    }
  })
})
