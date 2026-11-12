import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  computeStageMetrics,
  deriveStageLogFromStream,
  enrichStageMetrics,
  enrichToolingStageMetrics,
  stageMetricsFromStream,
} from '../lib/pipeline/stage-metrics.mts'
import type { StageCorrelation } from '../lib/pipeline/stage-metrics.mts'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'tooling-observability')
const jsonl = (...events: unknown[]): string => events.map((event) => `${JSON.stringify(event)}\n`).join('')
const text = (content: unknown): { type: string; message: unknown } => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text: content }] },
})

const NEUTRAL_COMPLETE = [
  '{"v":1,"type":"run.started","runtime":"fake","agent":"writer","model":null}',
  '{"v":1,"type":"run.completed","status":"success","runtime":"fake","model":"openai/gpt-5","session_id":"abc","duration_ms":1000,"api_duration_ms":700,"estimated_cost_usd":0.01,"tokens":{"input":100,"output":50,"cache_read":10,"cache_write":0,"reasoning":7},"turns":2,"denials":0,"ttft_ms":20,"error":null}',
  '',
].join('\n')
const NEUTRAL_NULLS =
  '{"v":1,"type":"run.completed","status":"success","runtime":"fake","model":"openai/gpt-5","session_id":"ses-null","duration_ms":1,"api_duration_ms":null,"estimated_cost_usd":null,"tokens":{"input":null,"output":null,"cache_read":null,"cache_write":null,"reasoning":null},"turns":null,"denials":0,"ttft_ms":null,"error":null}\n'
const NEUTRAL_ZEROS =
  '{"v":1,"type":"run.completed","status":"success","runtime":"fake","model":"openai/gpt-5","session_id":"ses-null","duration_ms":0,"api_duration_ms":0,"estimated_cost_usd":0,"tokens":{"input":0,"output":0,"cache_read":0,"cache_write":0,"reasoning":0},"turns":0,"denials":0,"ttft_ms":0,"error":null}\n'
const NEUTRAL_LEGACY_TERMINAL =
  '{"v":1,"type":"run.completed","status":"success","runtime":"claude","model":"claude-sonnet-5","session_id":"ses-legacy","duration_ms":1,"api_duration_ms":1,"cost_usd":0.5,"tokens":{"input":1,"output":2,"cache_read":3,"cache_creation":4},"turns":1,"denials":0,"ttft_ms":1,"error":null}\n'
const CLAUDE_RESULT = [
  '{"type":"system","subtype":"init","model":"claude-sonnet-5"}',
  '{"type":"result","num_turns":2,"duration_ms":1000,"duration_api_ms":700,"total_cost_usd":0.01,"is_error":false,"stop_reason":"end_turn","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":10,"cache_creation_input_tokens":0}}',
  '',
].join('\n')
const CLAUDE_TOOL_CALLS = [
  '{"type":"system","subtype":"init","session_id":"abc"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Voy a leer el archivo relevante."}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"x"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"contenido"}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_2","name":"Write","input":{"file_path":"y"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_2","content":"ok"}]}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Listo, hice el cambio."}]}}',
  '{"type":"result","num_turns":4,"duration_ms":4200,"duration_api_ms":3000,"total_cost_usd":0.02,"is_error":false}',
  '',
].join('\n')
const TRUNCATED =
  '{"type":"assistant","message":{"content":[{"type":"text","text":"primera linea completa"}]}}\n{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_9","name":"Bash","input":{"command":"ls'
const RESULT_5XX = [
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Empiezo a trabajar."}]}}',
  '{"type":"result","is_error":true,"terminal_reason":"api_error","api_error_status":500,"subtype":"success","result":"Overloaded","num_turns":3,"duration_ms":90000}',
  '',
].join('\n')
const RESULT_4XX =
  '{"type":"result","is_error":true,"terminal_reason":"api_error","api_error_status":404,"subtype":"success","result":"There\'s an issue with the selected model."}\n'
const RESULT_OK = [
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Listo."}]}}',
  '{"type":"result","is_error":false,"subtype":"success","result":"ok","num_turns":2,"duration_ms":3490,"duration_api_ms":1727}',
  '',
].join('\n')
const NON_OBJECT_LINE =
  '"una linea suelta"\n{"type":"assistant","message":{"content":[{"type":"text","text":"texto posterior"}]}}\n'

const use = (id: unknown, name: unknown, timestamp?: unknown): unknown => ({
  type: 'assistant',
  timestamp,
  message: { model: 'claude-opus-5', content: [{ type: 'tool_use', id, name }] },
})
const done = (id: unknown, timestamp?: unknown): unknown => ({
  type: 'user',
  timestamp,
  message: { content: [{ type: 'tool_result', tool_use_id: id }] },
})
const RESULT = { type: 'result', num_turns: 9, duration_ms: 5000, duration_api_ms: 4100, total_cost_usd: 0.25 }

// Streams de ejemplo que ejercitan cada rama del filtro; sus salidas esperadas estan en fixtures/stage-metrics/expected.json.
const STREAMS: Record<string, string> = {
  'neutral completo': NEUTRAL_COMPLETE,
  'neutral con nulos': NEUTRAL_NULLS,
  'neutral con ceros': NEUTRAL_ZEROS,
  'neutral con terminal legado': NEUTRAL_LEGACY_TERMINAL,
  'claude con result': CLAUDE_RESULT,
  'claude con tool calls sin fecha': CLAUDE_TOOL_CALLS,
  'sin evento final': jsonl(text('trabajando')),
  'linea truncada': TRUNCATED,
  'result 5xx': RESULT_5XX,
  'result 4xx': RESULT_4XX,
  'result sano': RESULT_OK,
  'linea que no es objeto': NON_OBJECT_LINE,
  'fixture success': readFileSync(join(FIXTURES, 'success.events.jsonl'), 'utf8'),
  'fixture hold': readFileSync(join(FIXTURES, 'hold.events.jsonl'), 'utf8'),
  'fixture truncated-input': readFileSync(join(FIXTURES, 'truncated-input.events.jsonl'), 'utf8'),
  'tool calls fechadas': jsonl(
    { type: 'system', subtype: 'init', model: 'claude-sonnet-5' },
    use('a', 'Read', '2026-08-16T10:00:00.000Z'),
    done('a', '2026-08-16T10:00:01.500Z'),
    use('b', 'Bash', '2026-08-16T10:00:02Z'),
    done('b', '2026-08-16T10:00:12.25Z'),
    use('c', 'Read', '2026-08-16T10:00:13.1Z'),
    done('c', '2026-08-16T10:00:13.9004Z'),
    use('d', 'Read', '2026-08-16T10:01:00Z'),
    done('d', '2026-08-16T10:01:04Z'),
    use('e', 'Bash', '2026-08-16T10:02:00Z'),
    done('e', '2026-08-16T10:02:03Z'),
    use('f', 'Glob', '2026-08-16T10:03:00Z'),
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
    { type: 'rate_limit_event' },
    { ...RESULT, permission_denials: [{ tool: 'Bash' }, { tool: 'Write' }], usage: { input_tokens: 5, reasoning_tokens: 2 } },
  ),
  'tool calls con fechas raras': jsonl(
    use('a', 'Read', '2026-02-31T23:59:60Z'),
    done('a', '2026-03-04T00:00:01Z'),
    use('b', 'Read', '2026-13-01T00:00:00Z'),
    done('b', '2026-01-01T00:00:01Z'),
    use('c', 'Read', '2026-01-01 00:00:00'),
    done('c', 20260101),
    use('d', 'Read', '2026-01-01T00:00:00Z\n'),
    done('d', '2026-01-01T00:00:05Z'),
    use('e', 'Read', 'x\n2026-01-01T00:00:00Z'),
    done('e', '2026-01-01T00:00:05Z'),
    RESULT,
  ),
  'tool_use sin id y resultados repetidos': jsonl(
    use(null, 'Read', '2026-08-16T10:00:00Z'),
    use(undefined, 'Read', '2026-08-16T10:00:00Z'),
    use('x', 'Read', '2026-08-16T10:00:00Z'),
    done('x', '2026-08-16T10:00:01Z'),
    done('x', '2026-08-16T10:00:07Z'),
    done('', '2026-08-16T10:00:09Z'),
    RESULT,
  ),
  'nombres de tool de tipos mezclados': jsonl(use('a', 'Write'), use('b', 5), use('c', null), use('d', 'Bash'), use('e', 5.0), RESULT),
  'tool_use con id numerico': jsonl(use(7, 'Read'), RESULT),
  'contenido que no es lista': jsonl(
    { type: 'assistant', message: { content: 'texto' } },
    { type: 'assistant', message: { content: { a: { type: 'tool_use', id: 'k', name: 'Read' } } } },
    { type: 'assistant', message: { content: 5 } },
    { type: 'assistant' },
    RESULT,
  ),
  'mensaje que no es objeto': jsonl({ type: 'assistant', message: 'texto' }, RESULT),
  'bloque de contenido que no es objeto': jsonl({ type: 'assistant', message: { content: ['texto'] } }, RESULT),
  'usage que no es objeto': jsonl({ ...RESULT, usage: 'n/d' }),
  'duraciones que no son numeros': jsonl({ ...RESULT, duration_ms: '5000' }),
  'dos result': jsonl({ ...RESULT, num_turns: 1 }, { ...RESULT, num_turns: 2, is_error: true, stop_reason: 'max_turns' }),
  'modelo solo en assistant': jsonl(use('a', 'Read'), RESULT),
  'literales de numero': [
    '{"type":"run.completed","status":"success","model":"m","duration_ms":1000.0,"api_duration_ms":2.50e2,"effective_model":3.5e9,"estimated_cost_usd":5e-7,"tokens":{"input":1e2,"output":0.10,"cache_read":100000000000000000000,"cache_write":-0,"reasoning":1.5E3},"turns":007,"denials":0.000001,"ttft_ms":1E-7}',
    '',
  ].join('\n'),
  'literales en el stream de claude': [
    '{"type":"result","num_turns":3.0,"duration_ms":1e3,"duration_api_ms":0.5,"total_cost_usd":0.0000001,"usage":{"input_tokens":12.50}}',
    '',
  ].join('\n'),
  'neutral con fallo': jsonl(
    { type: 'run.started', runtime: 'claude', model: 'sonnet', effort: 'high' },
    { type: 'tool.started', tool: 'Edit' },
    { type: 'tool.started', name: 'Bash' },
    { type: 'tool.started' },
    { type: 'run.failed', status: 'failed', runtime: 'claude', error: { kind: 'rate_limit', detail: 'limite' }, duration: 9, duration_api_ms: 4, num_turns: 3, effective_model: 'x' },
  ),
  'neutral con usage': jsonl({
    type: 'run.completed',
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, reasoning_tokens: 5 },
    denials: false,
    turns: false,
    num_turns: 4,
  }),
  'neutral con tokens que no son objeto': jsonl({ type: 'run.completed', status: 'success', tokens: 'n/d' }),
  'neutral con error que no es objeto': jsonl({ type: 'run.failed', status: 'failed', error: 'boom' }),
  'no objeto antes del terminal': '"suelta"\n{"type":"run.completed","status":"success","turns":1}\n',
  'no objeto despues del terminal': '{"type":"run.completed","status":"success","turns":1}\n[1,2]\n',
  'null y numero sueltos': 'null\n{"type":"result","num_turns":1}\n',
  'solo run.started': jsonl({ type: 'run.started', runtime: 'fake', model: 'm' }, { type: 'tool.started', tool: 'Read' }),
  'bom y crlf': '\uFEFF{"type":"result","num_turns":1}\r\n{"type":"assistant","message":{"content":[{"type":"text","text":"hola"}]}}\r\n',
  'eventos de texto variados': jsonl(
    { type: 'message', text: 'mensaje' },
    { type: 'message' },
    { type: 'message', text: { a: [1, 2], b: 'x' } },
    { type: 'message', text: 'varias\nlineas' },
    { type: 'tool.started', tool: 'Grep' },
    { type: 'tool.started' },
    { type: 'tool.started', tool: 5 },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }, { type: 'tool_use', name: 5 }, { type: 'text', text: 'b' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use' }, { type: 'text' }, { type: 'image' }] } },
    { type: 'result', is_error: true },
    { type: 'result', is_error: true, api_error_status: false, error: { code: 1 } },
    { type: 'result', is_error: true, api_error_status: 529, terminal_reason: 'api_error' },
    { type: 'result', is_error: 'true', result: 'no cuenta' },
  ),
  'run.failed en un stream legado sin terminal neutral valido': '5\n{"type":"run.failed","error":{"detail":{"code":7}}}\n',
}

let work = ''
let counter = 0

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto stage metrics '))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

function fileWith(content: string): string {
  const file = join(work, `stream-${counter++}.jsonl`)
  writeFileSync(file, content)
  return file
}

const metricsOf = (stream: string): Record<string, unknown> => JSON.parse(stageMetricsFromStream(stream)) as Record<string, unknown>

function derive(stream: string, stderr: string | null = ''): string {
  const out = join(work, `out-${counter++}.log`)
  deriveStageLogFromStream(fileWith(stream), stderr === null ? '' : fileWith(stderr), out)
  return readFileSync(out, 'utf8')
}

const IDENTITY = '{"harness_version":"1.2.3","harness_commit":"0123456789abcdef0123456789abcdef01234567","identity_state":"complete"}'

function correlation(stream: string, extra: Partial<StageCorrelation> = {}): StageCorrelation {
  return {
    pipeline: 'tdd',
    eventsFile: fileWith(stream),
    baseMetrics: stageMetricsFromStream(stream),
    issue: '1063',
    variantJson: '"variante-a"',
    stage: '1',
    agent: 'tooling-writer',
    profile: 'balanced',
    identityJson: IDENTITY,
    ...extra,
  }
}

describe('computeStageMetrics', () => {
  test('terminal neutral completo: copia costo estimado y los cinco tokens', () => {
    const output = computeStageMetrics(fileWith(NEUTRAL_COMPLETE))
    assert.equal(
      output,
      '{"turns":2,"duration_ms":1000,"duration_api_ms":700,"non_api_ms":300,"estimated_cost_usd":0.01,"tokens":{"input":100,"output":50,"cache_read":10,"cache_write":0,"reasoning":7},"model":"openai/gpt-5","is_error":false,"stop_reason":"success","terminal_reason":null,"ttft_ms":20,"permission_denials":0,"rate_limit_events":null,"tool_calls":[]}',
    )
  })

  test('terminal neutral: los nulos y los ceros presentes no se confunden', () => {
    const nulls = metricsOf(NEUTRAL_NULLS)
    assert.equal(nulls.estimated_cost_usd, null)
    assert.deepEqual(nulls.tokens, { input: null, output: null, cache_read: null, cache_write: null, reasoning: null })
    assert.equal('cost_usd' in nulls, false)
    const zeros = metricsOf(NEUTRAL_ZEROS)
    assert.equal(zeros.estimated_cost_usd, 0)
    assert.equal(zeros.non_api_ms, 0)
    assert.deepEqual(zeros.tokens, { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0 })
  })

  test('terminal neutral legado: normaliza los tokens y no rebautiza su costo', () => {
    const metrics = metricsOf(NEUTRAL_LEGACY_TERMINAL)
    assert.equal(metrics.estimated_cost_usd, null)
    assert.equal('cost_usd' in metrics, false)
    assert.deepEqual(metrics.tokens, { input: 1, output: 2, cache_read: 3, cache_write: 4, reasoning: null })
  })

  test('stream de Claude previo al contrato: total_cost_usd queda como cost_usd legado', () => {
    assert.equal(
      stageMetricsFromStream(CLAUDE_RESULT),
      '{"turns":2,"duration_ms":1000,"duration_api_ms":700,"non_api_ms":300,"estimated_cost_usd":null,"cost_usd":0.01,"tokens":{"input":100,"output":50,"cache_read":10,"cache_write":0,"reasoning":null},"model":"claude-sonnet-5","is_error":false,"stop_reason":"end_turn","terminal_reason":null,"ttft_ms":null,"permission_denials":null,"rate_limit_events":0,"tool_calls":[]}',
    )
  })

  test('sin evento final, con el stream vacio o sin archivo da null', () => {
    assert.equal(stageMetricsFromStream(STREAMS['sin evento final'] ?? ''), 'null')
    assert.equal(computeStageMetrics(fileWith('')), 'null')
    assert.equal(computeStageMetrics(join(work, 'no-existe.jsonl')), 'null')
    assert.equal(computeStageMetrics(work), 'null')
  })

  test('histograma de tool calls: cuenta, suma y mediana del tiempo hasta su tool_result', () => {
    const metrics = metricsOf(STREAMS['tool calls fechadas'] ?? '')
    assert.deepEqual(metrics.tool_calls, [
      { name: 'Bash', count: 2, duration_ms_sum: 13250, duration_ms_median: 6625 },
      { name: 'Glob', count: 1, duration_ms_sum: null, duration_ms_median: null },
      { name: 'Read', count: 3, duration_ms_sum: 6300, duration_ms_median: 1500 },
    ])
    assert.equal(metrics.model, 'claude-sonnet-5')
    assert.equal(metrics.permission_denials, 2)
    assert.equal(metrics.rate_limit_events, 2)
  })

  test('un tool_use sin id sigue contando y no tumba las demas metricas', () => {
    const metrics = metricsOf(STREAMS['tool_use sin id y resultados repetidos'] ?? '')
    assert.deepEqual(metrics.tool_calls, [{ name: 'Read', count: 3, duration_ms_sum: 25000, duration_ms_median: 9000 }])
    assert.equal(metrics.turns, 9)
  })

  test('un numero que el filtro copia conserva su literal; el que calcula, no', () => {
    assert.equal(
      stageMetricsFromStream(STREAMS['literales de numero'] ?? ''),
      '{"turns":7,"duration_ms":1000.0,"duration_api_ms":250,"non_api_ms":750,"estimated_cost_usd":5E-7,"tokens":{"input":1E+2,"output":0.10,"cache_read":100000000000000000000,"cache_write":-0,"reasoning":1.5E+3},"model":"m","is_error":false,"stop_reason":"success","terminal_reason":null,"ttft_ms":1E-7,"permission_denials":0.000001,"rate_limit_events":null,"tool_calls":[]}',
    )
  })

  test('un evento con una forma que jq no puede recorrer deja el stage sin metricas', () => {
    for (const name of ['tool_use con id numerico', 'mensaje que no es objeto', 'usage que no es objeto', 'no objeto despues del terminal']) {
      assert.equal(stageMetricsFromStream(STREAMS[name] ?? ''), 'null', name)
    }
  })
})

describe('enrichStageMetrics', () => {
  test('conserva las metricas base y agrega las dimensiones de correlacion', () => {
    const stream = [
      '{"v":1,"type":"run.started","runtime":"fake","agent":"tooling-writer","model":null}',
      '{"v":1,"type":"run.completed","status":"success","runtime":"fake","model":"openai/gpt-5","session_id":"ses-1","duration_ms":900,"tokens":{"input":12,"output":4,"cache_read":3,"cache_write":2,"reasoning":1},"estimated_cost_usd":0.1,"turns":3,"denials":0,"ttft_ms":20,"api_duration_ms":700,"error":null}',
      '',
    ].join('\n')
    const { pipeline: _pipeline, ...tooling } = correlation(stream)
    const enriched = JSON.parse(enrichToolingStageMetrics(tooling)) as Record<string, unknown>
    assert.deepEqual(
      {
        pipeline: enriched.pipeline,
        issue: enriched.issue,
        variant: enriched.variant,
        stage: enriched.stage,
        agent: enriched.agent,
        runtime: enriched.runtime,
        profile: enriched.profile,
        requested_model: enriched.requested_model,
        requested_effort: enriched.requested_effort,
        effective_model: enriched.effective_model,
        inherited: enriched.inherited,
        session_id: enriched.session_id,
        result: enriched.result,
        error_kind: enriched.error_kind,
        harness_version: enriched.harness_version,
        identity_state: enriched.identity_state,
      },
      {
        pipeline: 'tooling',
        issue: '1063',
        variant: 'variante-a',
        stage: '1',
        agent: 'tooling-writer',
        runtime: 'fake',
        profile: 'balanced',
        requested_model: null,
        requested_effort: null,
        effective_model: 'openai/gpt-5',
        inherited: true,
        session_id: 'ses-1',
        result: 'success',
        error_kind: null,
        harness_version: '1.2.3',
        identity_state: 'complete',
      },
    )
    assert.equal(enriched.duration_api_ms, 700)
    assert.equal(enriched.non_api_ms, 200)
    assert.equal(enriched.estimated_cost_usd, 0.1)
    assert.deepEqual(enriched.tokens, { input: 12, output: 4, cache_read: 3, cache_write: 2, reasoning: 1 })
    assert.equal('cost_usd' in enriched, false)
  })

  test('requested_effort sale de run.started.effort', () => {
    const stream = [
      '{"v":1,"type":"run.started","runtime":"claude","agent":"tooling-writer","model":null,"effort":"low"}',
      '{"v":1,"type":"run.completed","status":"success","runtime":"claude","model":"m","session_id":"ses-e","duration_ms":900,"turns":1,"denials":0,"error":null}',
      '',
    ].join('\n')
    const enriched = JSON.parse(enrichStageMetrics(correlation(stream, { variantJson: 'null', identityJson: '{}' }))) as Record<string, unknown>
    assert.equal(enriched.requested_effort, 'low')
    assert.equal(enriched.variant, null)
    assert.equal(enriched.harness_version, null)
  })

  test('pipeline tdd: modelo pedido y efectivo distintos', () => {
    const stream = [
      '{"type":"run.started","runtime":"fake","model":"vendor/requested"}',
      '{"type":"run.completed","runtime":"fake","model":"vendor/effective","session_id":"session-tdd","status":"success","error":null}',
      '',
    ].join('\n')
    const input = correlation(stream, { baseMetrics: '{"tokens":{"input":7}}', issue: '1363', stage: '4b', agent: 'projection-test-writer' })
    assert.equal(
      enrichStageMetrics(input),
      '{"tokens":{"input":7},"pipeline":"tdd","issue":"1363","variant":"variante-a","stage":"4b","agent":"projection-test-writer","runtime":"fake","profile":"balanced","requested_model":"vendor/requested","requested_effort":null,"effective_model":"vendor/effective","inherited":false,"session_id":"session-tdd","result":"success","error_kind":null,"harness_version":"1.2.3","harness_commit":"0123456789abcdef0123456789abcdef01234567","identity_state":"complete"}',
    )
  })

  test('un fallo en espera conserva la correlacion y la identidad degradada', () => {
    const eventsFile = join(FIXTURES, 'hold.events.jsonl')
    const enriched = JSON.parse(
      enrichToolingStageMetrics({
        eventsFile,
        baseMetrics: computeStageMetrics(eventsFile),
        issue: '1063',
        variantJson: 'null',
        stage: '2',
        agent: 'tooling-reviewer',
        profile: 'deep',
        identityJson: '{"harness_version":null,"harness_commit":null,"identity_state":"metadata_missing"}',
      }),
    ) as Record<string, unknown>
    assert.equal(enriched.runtime, 'fake')
    assert.equal(enriched.requested_model, null)
    assert.equal(enriched.effective_model, 'openai/gpt-5')
    assert.equal(enriched.inherited, true)
    assert.equal(enriched.session_id, 'ses-hold')
    assert.equal(enriched.result, 'failed')
    assert.equal(enriched.error_kind, 'rate_limit')
    assert.equal(enriched.identity_state, 'metadata_missing')
  })

  test('sin metricas base parte de un objeto vacio; un JSON invalido da null', () => {
    const base = correlation(NEUTRAL_COMPLETE)
    assert.match(enrichStageMetrics({ ...base, baseMetrics: '' }), /^\{"pipeline":"tdd",/)
    assert.match(enrichStageMetrics({ ...base, baseMetrics: 'null' }), /^\{"pipeline":"tdd",/)
    assert.equal(enrichStageMetrics({ ...base, baseMetrics: '{' }), 'null')
    assert.equal(enrichStageMetrics({ ...base, baseMetrics: '5' }), 'null')
    assert.equal(enrichStageMetrics({ ...base, variantJson: '' }), 'null')
    assert.equal(enrichStageMetrics({ ...base, identityJson: '"texto"' }), 'null')
  })

  test('sin archivo de eventos da las metricas sin correlacion de eventos y una segunda linea null', () => {
    const input = { ...correlation(NEUTRAL_COMPLETE), baseMetrics: '{"turns":1}', eventsFile: join(work, 'no-existe.jsonl') }
    const [metrics = '', rest] = enrichStageMetrics(input).split('\n')
    assert.equal(rest, 'null')
    assert.deepEqual(JSON.parse(metrics), {
      turns: 1,
      pipeline: 'tdd',
      issue: '1063',
      variant: 'variante-a',
      stage: '1',
      agent: 'tooling-writer',
      runtime: null,
      profile: 'balanced',
      requested_model: null,
      requested_effort: null,
      effective_model: null,
      inherited: true,
      session_id: null,
      result: null,
      error_kind: null,
      harness_version: '1.2.3',
      harness_commit: '0123456789abcdef0123456789abcdef01234567',
      identity_state: 'complete',
    })
    assert.equal(enrichStageMetrics({ ...input, baseMetrics: '{' }), 'null')
  })
})

describe('deriveStageLogFromStream', () => {
  test('stream con tool calls: texto del asistente y una linea por tool call, en orden', () => {
    assert.equal(derive(CLAUDE_TOOL_CALLS), 'Voy a leer el archivo relevante.\n[tool] Read\n[tool] Write\nListo, hice el cambio.\n')
  })

  test('una linea truncada se ignora sin perder el texto anterior', () => {
    assert.equal(derive(TRUNCATED), 'primera linea completa\n')
  })

  test('traza vacia: el log existe y queda vacio', () => {
    assert.equal(derive(''), '')
  })

  test('el stderr de un stream legado llega al log, donde se clasifica el fallo', () => {
    assert.equal(derive('', 'API Error: 500 Internal Server Error\n'), 'API Error: 500 Internal Server Error\n')
    assert.equal(derive('', 'API Error: 400 Bad Request\n'), 'API Error: 400 Bad Request\n')
    assert.equal(derive(RESULT_OK, 'ruido\n'), 'Listo.\n\nruido\n')
  })

  test('un error que solo llega en el evento result se deriva con su estado', () => {
    assert.equal(derive(RESULT_5XX), 'Empiezo a trabajar.\nAPI Error: 500 Overloaded\n')
    assert.equal(derive(RESULT_4XX), "API Error: 404 There's an issue with the selected model.\n")
  })

  test('un result sano no agrega nada', () => {
    assert.equal(derive(RESULT_OK), 'Listo.\n')
  })

  test('una linea de JSON que no es objeto no corta la derivacion', () => {
    assert.equal(derive(NON_OBJECT_LINE), 'texto posterior\n')
  })

  test('eventos neutrales: solo tools y desenlace, sin texto, inputs ni stderr', () => {
    const out = join(work, 'success.log')
    deriveStageLogFromStream(join(FIXTURES, 'success.events.jsonl'), '', out)
    assert.equal(readFileSync(out, 'utf8'), '[tool] Edit\nsuccess\n')
    deriveStageLogFromStream(join(FIXTURES, 'truncated-input.events.jsonl'), fileWith('CENTINELA en stderr\n'), out)
    assert.equal(readFileSync(out, 'utf8'), '[tool] write\n')
  })

  test('sin archivo de stream anexa el stderr; si no puede escribir el log, no falla', () => {
    const out = join(work, 'sin-stream.log')
    deriveStageLogFromStream(join(work, 'no-existe.jsonl'), fileWith('solo stderr\n'), out)
    assert.equal(readFileSync(out, 'utf8'), 'solo stderr\n')
    deriveStageLogFromStream(fileWith(RESULT_OK), '', join(work, 'no-existe', 'out.log'))
  })
})

describe('streams de ejemplo', () => {
  interface Expected {
    metrics: string
    log: string
    logSinStderr: string
    enriched: string
    enrichedSinBase: string
  }
  const EXPECTED = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'stage-metrics', 'expected.json'), 'utf8')) as {
    streams: Record<string, Expected>
    invalidArguments: [string, string][]
  }

  test('cada stream de ejemplo tiene sus salidas esperadas', () => {
    assert.deepEqual(Object.keys(EXPECTED.streams), Object.keys(STREAMS))
  })

  for (const [name, stream] of Object.entries(STREAMS)) {
    test(name, () => {
      const expected = EXPECTED.streams[name] ?? assert.fail(`sin esperado para ${name}`)
      assert.equal(computeStageMetrics(fileWith(stream)), expected.metrics)
      assert.equal(derive(stream, 'API Error: 500 desde stderr\nsegunda linea'), expected.log)
      assert.equal(derive(stream, null), expected.logSinStderr)
      assert.equal(derive(stream, ''), expected.logSinStderr)
      const input = correlation(stream)
      assert.equal(enrichStageMetrics(input), expected.enriched)
      assert.equal(enrichStageMetrics({ ...input, baseMetrics: '', variantJson: 'null', identityJson: '{}' }), expected.enrichedSinBase)
    })
  }

  test('enrichStageMetrics y enrichToolingStageMetrics con argumentos invalidos', () => {
    const base = correlation(NEUTRAL_COMPLETE)
    const cases: Partial<StageCorrelation>[] = [
      { baseMetrics: '{' },
      { baseMetrics: '5' },
      { baseMetrics: 'false' },
      { baseMetrics: '{"pipeline":"viejo","issue":1,"extra":1.50}' },
      { variantJson: '' },
      { variantJson: '{"a":1.0}' },
      { identityJson: '"texto"' },
      { identityJson: 'null' },
      { eventsFile: join(work, 'no-existe.jsonl') },
      { issue: 'con "comillas" y \\ barra', agent: 'ñandú\t' },
    ]
    assert.equal(cases.length, EXPECTED.invalidArguments.length)
    cases.forEach((extra, index) => {
      const input = { ...base, ...extra }
      assert.deepEqual([enrichStageMetrics(input), enrichToolingStageMetrics(input)], EXPECTED.invalidArguments[index], JSON.stringify(extra))
    })
  })
})
