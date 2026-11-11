import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { buildAgentsHistoryJson } from '../../../src/internal/scripts/lib/mefisto-run-history.mts'
import type { AgentRun } from '../../../src/internal/scripts/lib/mefisto-run-history.mts'
import { computeStageMetrics } from '../../../src/internal/scripts/lib/mefisto-stage-metrics.mts'
import { INTERNAL_EVENTS, NO_BASH_JQ, RECORD, mefistoBash } from './mefisto-agents-parity.mts'

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
})

describe('paridad con la gemela bash', { skip: NO_BASH_JQ }, () => {
  test('build_agents_history_json', () => {
    const metrics = [
      writerMetrics,
      '',
      'null',
      '{}',
      '{"runtime":"fake","turns":2}',
      '{"runtime":null}',
      '{"runtime":{"a":1},"tokens":{"input":5}}',
      '{',
      'no json',
      '5',
      '[1,2]',
      '"texto"',
      'true',
      'false',
      ' {"runtime":"espacios"} ',
    ]
    const durations = ['125', '', '0', 'null', 'abc', '-3', '"7"', 'true']
    // Cada metrica y cada duracion, del lado del writer y del reviewer.
    const cases: [string, string, string, string][] = [
      ...metrics.flatMap((value): [string, string, string, string][] => [
        ['125', value, '210', 'null'],
        ['', '', '30', value],
      ]),
      ...durations.flatMap((value): [string, string, string, string][] => [
        [value, writerMetrics, '210', ''],
        ['5', '{"runtime":"x"}', value, 'null'],
      ]),
    ]
    const script = `while [ "$#" -gt 0 ]; do build_agents_history_json "$1" "$2" "$3" "$4"; printf '\\036'; shift 4; done`
    const fromBash = mefistoBash(script, cases.flat()).stdout.split(RECORD)
    // La entrada completa sale de un `echo`; la plana, de un `printf` sin salto final.
    const own = cases.map(([writerDuration, writerText, reviewerDuration, reviewerText]) =>
      buildAgentsHistoryJson(run(writerDuration, writerText), run(reviewerDuration, reviewerText)),
    )
    assert.deepEqual([...own, ''], fromBash.map((text) => text.replace(/\n$/, '')))
    assert.ok(own.some((text) => text.includes('"metrics"')) && own.some((text) => !text.includes('"metrics"')))
  })
})
