import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { computeStageMetrics, deriveStageLogFromStream } from '../../../src/internal/scripts/lib/mefisto-stage-metrics.mts'
import { translateStream } from '../../../src/runtime/lib/runtime-claude.mts'
import {
  ERROR_AS_TEXT,
  INTERNAL_EVENTS,
  REPO_ROOT,
  completed,
  failed,
  message,
  toolCompleted,
  toolStarted,
  writeFixtures,
} from './mefisto-agents-fixtures.mts'

let work = ''
let events: Record<string, string> = {}
let translated = ''
let counter = 0

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto stage metrics '))
  events = writeFixtures(work, INTERNAL_EVENTS, '.jsonl')
  const raw = readFileSync(join(REPO_ROOT, '.claude', 'scripts', 'tests', 'fixtures', 'runtime-claude', 'success.jsonl'), 'utf8')
  translated = fileWith(translateStream(raw, 'claude', 'claude-sonnet-5', 0, '').map((event) => `${JSON.stringify(event)}\n`).join(''))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

const file = (name: string): string => events[name] ?? assert.fail(`sin fixture ${name}`)

function fileWith(content: string): string {
  const path = join(work, `archivo-${counter++}.txt`)
  writeFileSync(path, content)
  return path
}

function derive(eventsFile: string, stderrFile: string = fileWith('')): string {
  const out = join(work, `derivado-${counter++}.log`)
  deriveStageLogFromStream(eventsFile, stderrFile, out)
  return readFileSync(out, 'utf8')
}

const metrics = (eventsFile: string): Record<string, unknown> => JSON.parse(computeStageMetrics(eventsFile)) as Record<string, unknown>

describe('deriveStageLogFromStream', () => {
  test('[A] el texto de los mensajes y una linea por tool call, en el orden del JSONL', () => {
    assert.equal(
      derive(file('mensajes-y-tools')),
      'Voy a leer el archivo relevante.\n[tool] Read\n[tool] Write\nListo, hice el cambio.\n',
    )
  })

  test('[B] una linea truncada se ignora sin perder el texto anterior', () => {
    assert.equal(derive(file('texto-y-tool-truncada')), 'primera linea completa\n')
  })

  test('[C] una traza vacia deja el log vacio', () => {
    assert.equal(derive(file('vacio')), '')
    assert.equal(derive(join(work, 'no-existe.jsonl')), '')
    assert.equal(derive(''), '')
  })

  test('[D] el stderr se anexa tal cual', () => {
    assert.equal(derive(file('vacio'), fileWith('API Error: 500 Internal Server Error\n')), 'API Error: 500 Internal Server Error\n')
    assert.equal(derive(join(work, 'no-existe.jsonl'), fileWith('sin salto final')), 'sin salto final')
  })

  test('el stderr va tras una linea en blanco cuando el log ya tiene texto', () => {
    assert.equal(derive(file('sin-terminal'), fileWith('API Error: 500\nsegunda\n')), 'trabajando\n\nAPI Error: 500\nsegunda\n')
    assert.equal(derive(file('sin-terminal'), join(work, 'no-existe.log')), 'trabajando\n')
    assert.equal(derive(file('sin-terminal'), ''), 'trabajando\n')
  })

  test('el stderr se copia byte a byte', () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x0a])
    const stderr = join(work, 'stderr-binario.log')
    writeFileSync(stderr, bytes)
    const out = join(work, 'derivado-binario.log')
    deriveStageLogFromStream(file('vacio'), stderr, out)
    assert.deepEqual(readFileSync(out), bytes)
  })

  test('[G-1][G-3][G-4][G-5] el terminal con error deja "<kind>: <detail>" tras el texto previo', () => {
    assert.equal(derive(file('error-del-proveedor-con-texto')), 'Empiezo a trabajar.\napi_error: API Error: 500 Overloaded\n')
    assert.equal(derive(file('cliente')), 'api_error: API Error: 400 Bad Request\n')
    assert.equal(derive(file('corte-de-stream')), 'trabajando...\nstream_cut: el stream se corto a mitad de escritura\n')
  })

  test('[G-7] un terminal sin error no agrega nada', () => {
    assert.equal(derive(fileWith(message('Listo.') + completed())), 'Listo.\n')
    assert.equal(derive(file('error-false')), '')
  })

  test('un error sin kind o sin detail usa "error" y el detalle vacio', () => {
    assert.equal(derive(file('error-vacio')), 'error: \n')
    assert.equal(derive(file('error-con-kind-numerico')), 'error: solo detalle\nsolo kind: \n')
  })

  test('solo los mensajes de texto llegan al log, con su valor como lo imprime jq', () => {
    assert.equal(derive(file('mensaje-de-otro-kind')), 'visible\nsin kind\n\n7\n{\n  "a": [\n    1,\n    {\n      "b": null\n    }\n  ]\n}\n')
  })

  test('un evento que no se puede formatear se salta sin cortar los siguientes', () => {
    // El nombre vacio cuenta como presente: solo `null` y `false` dan "?".
    assert.equal(derive(file('tool-con-nombre-numerico')), '[tool] Read\n[tool] \ndespues del fallo\n')
    assert.equal(derive(file('tool-sin-nombre')), '[tool] ?\n')
    assert.equal(derive(file('tools-de-tipos-mezclados')), '[tool] Write\n[tool] ?\n[tool] Bash\n')
    assert.equal(derive(file('kind-objeto')), '')
    assert.equal(derive(fileWith(ERROR_AS_TEXT)), 'antes\n')
  })

  test('no interpreta el stream nativo de un runtime', () => {
    const raw = join(REPO_ROOT, '.claude', 'scripts', 'tests', 'fixtures', 'runtime-claude', 'success.jsonl')
    assert.equal(derive(raw, fileWith('stderr\n')), 'stderr\n')
  })

  test('sobreescribe el log anterior y no falla si no puede escribirlo', () => {
    const out = join(work, 'ya-existia.log')
    writeFileSync(out, 'contenido viejo\n')
    deriveStageLogFromStream(file('sin-terminal'), '', out)
    assert.equal(readFileSync(out, 'utf8'), 'trabajando\n')
    assert.doesNotThrow(() => deriveStageLogFromStream(file('sin-terminal'), '', join(work, 'no-existe', 'derivado.log')))
  })

  test('un stderr que no se puede leer no detiene nada', () => {
    const directory = join(work, 'stderr-que-es-carpeta')
    mkdirSync(directory)
    assert.doesNotThrow(() => derive(file('vacio'), directory))
  })
})

describe('computeStageMetrics', () => {
  test('[A] deriva todos los campos del terminal y el histograma de tool calls', () => {
    assert.equal(
      computeStageMetrics(file('metricas-completas')),
      '{"runtime":"claude","model":"claude-sonnet-5","status":"success","error_kind":null,"duration_ms":9451,"api_duration_ms":5289,' +
        '"non_api_ms":4162,"ttft_ms":3797,"turns":4,"estimated_cost_usd":0.0234,' +
        '"tokens":{"input":1200,"output":340,"cache_read":500,"cache_write":120,"reasoning":80},"denials":2,' +
        '"tool_calls":[{"name":"Read","count":2,"duration_ms_sum":1100,"duration_ms_median":550},' +
        '{"name":"Write","count":1,"duration_ms_sum":1000,"duration_ms_median":1000}]}',
    )
  })

  test('[B][C] sin terminal, sin archivo o con el archivo vacio da null', () => {
    for (const path of [file('sin-terminal'), file('vacio'), file('solo-saltos'), join(work, 'no-existe.jsonl'), '', work]) {
      assert.equal(computeStageMetrics(path), 'null', path)
    }
  })

  test('[D] una linea truncada se ignora y el terminal posterior se deriva', () => {
    const derived = metrics(file('tool-truncada-y-terminal'))
    assert.equal(derived.turns, 1)
    assert.equal(derived.duration_ms, 100)
    assert.equal(derived.non_api_ms, 20)
    assert.equal(derived.estimated_cost_usd, null)
    assert.deepEqual(derived.tokens, { input: null, output: null, cache_read: null, cache_write: null, reasoning: null })
    assert.deepEqual(derived.tool_calls, [])
  })

  test('[F] estimated_cost_usd 0 se preserva y cost_usd legado no se rebautiza', () => {
    assert.equal(metrics(file('costo-cero')).estimated_cost_usd, 0)
    const legacy = metrics(file('costo-legado'))
    assert.equal(legacy.estimated_cost_usd, null)
    assert.equal('cost_usd' in legacy, false)
  })

  test('[G][H] una tool call sin duracion o sin completar cuenta, sin suma ni mediana', () => {
    const empty = [{ name: 'Bash', count: 1, duration_ms_sum: null, duration_ms_median: null }]
    assert.deepEqual(metrics(file('tool-sin-duracion')).tool_calls, empty)
    assert.deepEqual(metrics(file('tool-sin-completar')).tool_calls, empty)
  })

  test('un tool.completed sin su tool.started no aparece', () => {
    assert.deepEqual(metrics(file('tool-completada-sin-empezar')).tool_calls, [
      { name: 'Read', count: 1, duration_ms_sum: null, duration_ms_median: null },
    ])
  })

  test('[I] los campos ausentes del terminal dan null sin abortar', () => {
    const derived = metrics(file('campos-ausentes'))
    assert.equal(derived.turns, 2)
    assert.equal(derived.ttft_ms, null)
    assert.equal(derived.denials, null)
    assert.equal(derived.error_kind, null)
    assert.equal(derived.non_api_ms, 200)
    assert.deepEqual(derived.tool_calls, [{ name: 'Grep', count: 1, duration_ms_sum: 150, duration_ms_median: 150 }])
  })

  test('[M] exito con tools sobre la traza real traducida', () => {
    const derived = metrics(translated)
    assert.equal(derived.status, 'success')
    assert.equal(derived.runtime, 'claude')
    assert.deepEqual(Object.keys((derived.tool_calls as Record<string, unknown>[])[0] ?? {}), ['name', 'count', 'duration_ms_sum', 'duration_ms_median'])
    assert.deepEqual((derived.tool_calls as Record<string, unknown>[]).map((call) => [call.name, call.count]), [['Read', 1]])
    assert.ok(derived.ttft_ms !== null && derived.turns !== null && derived.api_duration_ms !== null)
  })

  test('[N] un fallo conserva status y error_kind con las cifras pobladas o en null', () => {
    for (const name of ['fallo-con-cifras', 'fallo-sin-cifras']) {
      assert.equal(metrics(file(name)).status, 'failed', name)
      assert.equal(metrics(file(name)).error_kind, 'api_error', name)
    }
    assert.equal(metrics(file('tiempo-agotado')).status, 'timeout')
    assert.equal(metrics(file('tiempo-agotado')).error_kind, 'timeout')
    assert.equal(metrics(file('fallo-con-cifras')).non_api_ms, 5000)
    assert.equal(metrics(file('fallo-sin-cifras')).non_api_ms, null)
  })

  test('las claves salen en el orden del contrato del historial', () => {
    assert.deepEqual(Object.keys(metrics(file('fallo-sin-cifras'))), [
      'runtime',
      'model',
      'status',
      'error_kind',
      'duration_ms',
      'api_duration_ms',
      'non_api_ms',
      'ttft_ms',
      'turns',
      'estimated_cost_usd',
      'tokens',
      'denials',
      'tool_calls',
    ])
  })

  test('solo cuenta el ultimo terminal', () => {
    assert.equal(metrics(file('dos-terminales')).error_kind, 'api_error')
    assert.equal(metrics(file('fallo-y-despues-exito')).status, 'success')
  })

  test('la mediana ordena las duraciones y promedia las dos centrales', () => {
    assert.deepEqual(metrics(file('tres-duraciones')).tool_calls, [{ name: 'Bash', count: 3, duration_ms_sum: 60, duration_ms_median: 20 }])
    assert.deepEqual(metrics(file('cuatro-duraciones')).tool_calls, [{ name: 'Edit', count: 4, duration_ms_sum: 76, duration_ms_median: 15.5 }])
  })

  test('agrupa por nombre en el orden de jq, tambien los nombres que no son texto', () => {
    assert.deepEqual(metrics(file('tools-de-tipos-mezclados')).tool_calls, [
      { name: null, count: 1, duration_ms_sum: 3, duration_ms_median: 3 },
      { name: 5, count: 2, duration_ms_sum: 7, duration_ms_median: 7 },
      { name: 'Bash', count: 1, duration_ms_sum: null, duration_ms_median: null },
      { name: 'Write', count: 1, duration_ms_sum: null, duration_ms_median: null },
    ])
  })

  test('un terminal que no tiene la forma del contrato da null', () => {
    for (const name of ['tokens-que-no-son-objeto', 'duraciones-de-texto-en-el-terminal', 'duraciones-de-texto-en-par', 'duraciones-que-no-suman']) {
      assert.equal(computeStageMetrics(file(name)), 'null', name)
    }
    assert.equal(computeStageMetrics(fileWith(ERROR_AS_TEXT)), 'null')
  })

  test('los numeros que copia conservan su literal y los que calcula no', () => {
    const terminal =
      '{"type":"run.completed","status":"success","duration_ms":10.0,"api_duration_ms":2.50,"estimated_cost_usd":0.10,"tokens":{"input":1e3}}\n'
    const stream = toolStarted('A') + toolCompleted('A', 1.5).replace('1.5', '1.50') + terminal
    assert.equal(
      computeStageMetrics(fileWith(stream)),
      '{"runtime":null,"model":null,"status":"success","error_kind":null,"duration_ms":10.0,"api_duration_ms":2.50,"non_api_ms":7.5,' +
        '"ttft_ms":null,"turns":null,"estimated_cost_usd":0.10,' +
        '"tokens":{"input":1E+3,"output":null,"cache_read":null,"cache_write":null,"reasoning":null},"denials":null,' +
        '"tool_calls":[{"name":"A","count":1,"duration_ms_sum":1.50,"duration_ms_median":1.50}]}',
    )
  })

  test('un terminal con status que no es de exito tambien se copia', () => {
    assert.equal(metrics(fileWith(failed({ status: 'killed', error: { kind: 'killed' } }))).status, 'killed')
  })
})

describe('salida esperada sobre todos los fixtures', () => {
  const expected = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'stage-metrics', 'esperado.json'), 'utf8')) as Record<
    'metrics' | 'log',
    Record<string, string>
  >
  const contract = (name: string): string => join(REPO_ROOT, 'src', 'runtime', 'contract', 'fixtures', 'run-events', `${name}.jsonl`)
  const pathOf = (name: string): string => (name.startsWith('contrato/') ? contract(name.slice('contrato/'.length)) : file(name))

  test('cada fixture tiene su salida esperada', () => {
    for (const name of Object.keys(INTERNAL_EVENTS)) assert.ok(name in expected.metrics && name in expected.log, name)
  })

  test('computeStageMetrics', () => {
    for (const [name, metricsText] of Object.entries(expected.metrics)) assert.equal(computeStageMetrics(pathOf(name)), metricsText, name)
  })

  test('deriveStageLogFromStream sin stderr', () => {
    for (const [name, log] of Object.entries(expected.log)) assert.equal(derive(pathOf(name), ''), log, name)
  })
})
