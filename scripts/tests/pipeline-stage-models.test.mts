import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  PIPELINE_AGENT_EFFORT_LEVELS,
  formatStageModelsForLog,
  parseStageModels,
  pipelineAgentEffortLevel,
  resolveDeclaredAgentModel,
  resolvePipelineAgentEffort,
  resolveStageModel,
} from '../lib/pipeline/stage-models.mts'
import type { StageModels } from '../lib/pipeline/stage-models.mts'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const RUNTIME_LIB_DIR = join(REPO_ROOT, 'src', 'runtime', 'lib')

const AGENT_FIXTURES: Readonly<Record<string, string>> = {
  'con-modelo': '---\nname: fixture-con-modelo\nmodel: "modelo-fixture"\n---\n',
  'sin-comillas': '---\nname: fixture-sin-comillas\nmodel: modelo-sin-comillas\n---\n',
  'sin-modelo': '---\nname: fixture-sin-modelo\n---\n',
  'modelo-vacio': '---\nname: fixture-modelo-vacio\nmodel:\nmodel: no-debe-leerse\n---\n',
  'con-comentario': '---\nmodel:\t"opus"   # el reviewer piensa mas\n---\n',
  'solo-comentario': '---\nmodel: # pendiente\nmodel: no-debe-leerse\n---\n',
  'sin-espacio': '---\nmodel:pegado\nmodels: otro\nmodel: despues\n---\n',
  'fuera-del-frontmatter': 'model: antes\n---\nname: x\n---\nmodel: despues\n',
  'sin-cierre': '---\nname: x\nmodel: sin-cierre',
  'comilla-suelta': '---\nmodel: "\n---\n',
  'comillas-vacias': '---\nmodel: ""\n---\n',
  'almohadilla-pegada': '---\nmodel: claude#5 "x"\n---\n',
  'fin-de-linea-windows': '---\r\nmodel: sonnet\r\n---\r\n',
}

let work = ''
let plugin = ''
let agentsDir = ''
let eventsLog = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto stage models '))
  plugin = join(work, 'plugin')
  agentsDir = join(plugin, 'agents')
  mkdirSync(agentsDir, { recursive: true })
  for (const [agent, content] of Object.entries(AGENT_FIXTURES)) writeFileSync(join(agentsDir, `${agent}.md`), content)
  mkdirSync(join(agentsDir, 'es-carpeta.md'))
  eventsLog = join(work, 'events.log')
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

function models(spec: string): StageModels {
  const parsed = parseStageModels(spec)
  assert.ok('models' in parsed, `spec invalido: ${spec}`)
  return parsed.models
}

function parseError(spec: string): string {
  const parsed = parseStageModels(spec)
  assert.ok('error' in parsed, `el spec debio fallar: ${spec}`)
  return parsed.error
}

describe('resolveDeclaredAgentModel', () => {
  test('[0] lee la primera clave model del frontmatter', () => {
    assert.equal(resolveDeclaredAgentModel('con-modelo', agentsDir), 'modelo-fixture')
    assert.equal(resolveDeclaredAgentModel('sin-comillas', agentsDir), 'modelo-sin-comillas')
    assert.equal(resolveDeclaredAgentModel('sin-modelo', agentsDir), '')
    assert.equal(resolveDeclaredAgentModel('modelo-vacio', agentsDir), '')
    assert.equal(resolveDeclaredAgentModel('agente-inexistente', agentsDir), '')
    assert.equal(resolveDeclaredAgentModel('es-carpeta', agentsDir), '')
    assert.equal(resolveDeclaredAgentModel('con-modelo', join(work, 'no-existe')), '')
    assert.equal(resolveDeclaredAgentModel('', agentsDir), '')
  })

  test('descarta el comentario, los espacios y las comillas del valor', () => {
    assert.equal(resolveDeclaredAgentModel('con-comentario', agentsDir), 'opus')
    assert.equal(resolveDeclaredAgentModel('solo-comentario', agentsDir), '')
    assert.equal(resolveDeclaredAgentModel('sin-espacio', agentsDir), 'despues')
    assert.equal(resolveDeclaredAgentModel('fuera-del-frontmatter', agentsDir), '')
    assert.equal(resolveDeclaredAgentModel('sin-cierre', agentsDir), 'sin-cierre')
    assert.equal(resolveDeclaredAgentModel('comilla-suelta', agentsDir), '"')
    assert.equal(resolveDeclaredAgentModel('comillas-vacias', agentsDir), '')
    assert.equal(resolveDeclaredAgentModel('almohadilla-pegada', agentsDir), 'claude#5 "x"')
    assert.equal(resolveDeclaredAgentModel('fin-de-linea-windows', agentsDir), '')
  })

  test('[0] por defecto lee los agentes publicados del plugin, sin depender del cwd', () => {
    const expected: Record<string, string> = {
      'infra-writer': 'sonnet',
      'infra-reviewer': 'opus',
      'domain-scaffolder': 'sonnet',
      'test-writer': 'sonnet',
      implementer: 'sonnet',
      reviewer: 'opus',
      'smoke-test-writer': 'sonnet',
      'projection-test-writer': 'sonnet',
      'projection-implementer': 'sonnet',
    }
    for (const [agent, model] of Object.entries(expected)) assert.equal(resolveDeclaredAgentModel(agent), model, agent)
  })
})

describe('pipelineAgentEffortLevel', () => {
  const sourcesDir = join(REPO_ROOT, 'src', 'published', 'agents')

  function sourceEffort(file: string): unknown {
    const lines = readFileSync(join(sourcesDir, file), 'utf8').split('\n')
    const end = lines.indexOf('---', 1)
    return (JSON.parse(lines.slice(1, end).join('\n')) as { effort?: unknown }).effort
  }

  test('[CA-2] la tabla coincide con el effort de src/published/agents', () => {
    const sources = readdirSync(sourcesDir)
      .filter((file) => file.endsWith('.md'))
      .sort()
    assert.equal(sources.length, 22)
    for (const file of sources) {
      const agent = file.slice(0, -'.md'.length)
      assert.equal(pipelineAgentEffortLevel(agent), sourceEffort(file), agent)
    }
    assert.deepEqual(
      Object.keys(PIPELINE_AGENT_EFFORT_LEVELS).sort(),
      sources.map((file) => file.slice(0, -'.md'.length)),
    )
  })

  test('[CA-1] un agente fuera de la tabla no tiene nivel', () => {
    assert.equal(pipelineAgentEffortLevel('agente-inexistente'), null)
    assert.equal(pipelineAgentEffortLevel(''), null)
    assert.equal(pipelineAgentEffortLevel('toString'), null)
  })
})

describe('resolvePipelineAgentEffort', () => {
  const MAPPING =
    '{"fake":{"efforts":{"levels":{"light":"n-light","standard":"n-standard","thorough":"n-thorough"},"agents":{"tooling-reviewer":"thorough"}}}}\n'
  const NOW = new Date(2026, 5, 15, 9, 5, 7)

  function request(key: string, agentId: string, mappingFile: string, env: NodeJS.ProcessEnv = {}) {
    return { key, agentId, runtime: 'fake', mappingFile, eventsLog, env, libDir: RUNTIME_LIB_DIR, now: NOW }
  }

  test('[CA-1] sin mapping ni default hereda y anota <heredado> con el nivel', async () => {
    writeFileSync(eventsLog, '')
    assert.deepEqual(await resolvePipelineAgentEffort(request('writer', 'tooling-writer', join(work, 'ausente.json'))), {
      effort: '',
      level: 'light',
    })
    assert.equal(readFileSync(eventsLog, 'utf8'), '[09:05:07] EFFORTS: writer -> <heredado> (nivel light)\n')
  })

  test('[CA-1] el default del adaptador llega al effort resuelto', async () => {
    const env = { MEFISTO_FAKE_DEFAULT_EFFORT: 'fx-default' }
    assert.deepEqual(await resolvePipelineAgentEffort(request('reviewer', 'tooling-reviewer', '', env)), {
      effort: 'fx-default',
      level: 'standard',
    })
  })

  test('[CA-1] el nivel de fabrica y efforts.agents se traducen con efforts.levels', async () => {
    const mapping = join(work, 'models.json')
    writeFileSync(mapping, MAPPING)
    writeFileSync(eventsLog, '')
    const effort = async (key: string, agentId: string): Promise<string> => {
      const resolved = await resolvePipelineAgentEffort(request(key, agentId, mapping))
      assert.ok('effort' in resolved)
      return resolved.effort
    }
    assert.equal(await effort('writer', 'tooling-writer'), 'n-light')
    assert.equal(await effort('implementer', 'implementer'), 'n-standard')
    assert.equal(await effort('reviewer', 'tooling-reviewer'), 'n-thorough')
    assert.deepEqual(readFileSync(eventsLog, 'utf8').split('\n'), [
      '[09:05:07] EFFORTS: writer -> n-light (nivel light)',
      '[09:05:07] EFFORTS: implementer -> n-standard (nivel standard)',
      '[09:05:07] EFFORTS: reviewer -> n-thorough (nivel standard)',
      '',
    ])
  })

  test('[CA-1] un agente desconocido o un mapping invalido fallan con su motivo, sin anotar', async () => {
    writeFileSync(eventsLog, '')
    assert.deepEqual(await resolvePipelineAgentEffort(request('x', 'agente-inexistente', '')), {
      error: "agente 'agente-inexistente' sin nivel de effort de fabrica en pipeline_agent_effort_level",
    })
    const invalid = join(work, 'invalido.json')
    writeFileSync(invalid, '{"fake":{"efforts":{"levels":"no-es-un-objeto"}}}\n')
    const failed = await resolvePipelineAgentEffort(request('writer', 'tooling-writer', invalid))
    assert.ok('error' in failed)
    assert.match(failed.error, /invalido\.json: fake\.efforts\.levels: se esperaba un objeto$/)
    const unknownRuntime = await resolvePipelineAgentEffort({ ...request('writer', 'tooling-writer', ''), runtime: 'no_existe' })
    assert.ok('error' in unknownRuntime)
    assert.match(unknownRuntime.error, /^runtime 'no_existe' no tiene adaptador/)
    assert.deepEqual(await resolvePipelineAgentEffort({ ...request('writer', 'tooling-writer', ''), runtime: 'No-Valido' }), {
      error: "runtime invalido: 'No-Valido'",
    })
    const broken = join(work, 'roto.json')
    writeFileSync(broken, '{"fake":')
    assert.deepEqual(await resolvePipelineAgentEffort(request('writer', 'tooling-writer', broken)), {
      error: `${broken}: no es JSON valido`,
    })
    assert.equal(readFileSync(eventsLog, 'utf8'), '')
  })

  test('el adaptador claude traduce el nivel de fabrica', async () => {
    assert.deepEqual(
      await resolvePipelineAgentEffort({ key: 'scaffold', agentId: 'domain-scaffolder', runtime: 'claude', env: {}, libDir: RUNTIME_LIB_DIR }),
      { effort: 'medium', level: 'light' },
    )
  })

  test('sin events.log no anota, y uno que no se puede escribir no impide resolver', async () => {
    const base = { key: 'writer', agentId: 'tooling-writer', runtime: 'fake', env: {}, libDir: RUNTIME_LIB_DIR }
    assert.deepEqual(await resolvePipelineAgentEffort(base), { effort: '', level: 'light' })
    assert.deepEqual(await resolvePipelineAgentEffort({ ...base, eventsLog: join(work, 'no-existe', 'events.log') }), {
      effort: '',
      level: 'light',
    })
  })
})

describe('parseStageModels', () => {
  test('[1] un spec vacio deja el mapa vacio', () => {
    assert.equal(models('').size, 0)
    assert.equal(models(',,').size, 0)
  })

  test('[2][3] lee una o varias entradas separadas por coma, en orden', () => {
    assert.deepEqual([...models('reviewer=opus')], [['reviewer', 'opus']])
    assert.deepEqual(
      [...models('writer=sonnet,,reviewer=opus,')],
      [
        ['writer', 'sonnet'],
        ['reviewer', 'opus'],
      ],
    )
  })

  test('[4] el nombre del modelo pasa tal cual, sin allowlist', () => {
    assert.equal(resolveStageModel(models('writer=claude-opus-5[1m]'), 'writer', 'default-no-usado'), 'claude-opus-5[1m]')
    assert.deepEqual([...models('a=b=c')], [['a', 'b=c']])
  })

  test('[5] una entrada sin = falla nombrandola', () => {
    assert.equal(parseError('reviewer-opus'), "entrada 'reviewer-opus' no tiene la forma agente=modelo")
    assert.equal(parseError('writer=sonnet,reviewer-opus'), "entrada 'reviewer-opus' no tiene la forma agente=modelo")
  })

  test('[6] una clave o un valor vacio fallan', () => {
    assert.equal(parseError('='), "entrada '=': agente y modelo no pueden estar vacios")
    assert.equal(parseError('=opus'), "entrada '=opus': agente y modelo no pueden estar vacios")
    assert.equal(parseError('reviewer='), "entrada 'reviewer=': agente y modelo no pueden estar vacios")
  })

  test('[7] un agente repetido falla nombrandolo', () => {
    assert.equal(parseError('writer=sonnet,writer=opus'), "el agente 'writer' esta repetido")
  })

  test('no recorta espacios ni interpreta el valor', () => {
    assert.equal(models(',').size, 0)
    assert.deepEqual([...models(' a = b ')], [[' a ', ' b ']])
    assert.deepEqual(
      [...models('a=*,writer=$HOME')],
      [
        ['a', '*'],
        ['writer', '$HOME'],
      ],
    )
    assert.equal(resolveStageModel(models(' a = b '), 'a', 'por-defecto'), 'por-defecto')
    assert.equal(resolveStageModel(models('writer=sonnet'), '', 'por-defecto'), 'por-defecto')
  })

  test('solo lee la primera linea del spec', () => {
    assert.deepEqual([...models('a=b\nc=d')], [['a', 'b']])
  })
})

describe('resolveStageModel', () => {
  test('[3][8] el override gana por clave exacta y sin el vale el default', () => {
    const map = models('writer=sonnet,reviewer=opus')
    assert.equal(resolveStageModel(map, 'writer', 'default-no-usado'), 'sonnet')
    assert.equal(resolveStageModel(map, 'reviewer', 'default-no-usado'), 'opus')
    assert.equal(resolveStageModel(models('reviewer=opus'), 'writer', 'sonnet'), 'sonnet')
    assert.equal(resolveStageModel(models('reviewer=opus'), 'review', 'sonnet'), 'sonnet')
  })

  test('[9] sin --models siempre vale el default', () => {
    const empty = models('')
    assert.equal(resolveStageModel(empty, 'reviewer', 'opus'), 'opus')
    assert.equal(resolveStageModel(empty, 'writer', 'sonnet'), 'sonnet')
    assert.equal(resolveStageModel(empty, 'merge-writer', 'sonnet'), 'sonnet')
  })

  test('[9b] con default vacio solo el override fija un modelo', () => {
    assert.equal(resolveStageModel(models(''), 'test-writer', ''), '')
    const map = models('test-writer=opus')
    assert.equal(resolveStageModel(map, 'test-writer', ''), 'opus')
    assert.equal(resolveStageModel(map, 'implementer', ''), '')
  })

  test('[9c] un sub-stage de patch hereda el modelo del agente que relanza si no tiene clave propia', () => {
    const chain = (spec: string, key: string, agent: string): string => {
      const map = models(spec)
      return resolveStageModel(map, key, resolveStageModel(map, agent, ''))
    }
    assert.equal(chain('test-writer=opus', 'patch-test-writer', 'test-writer'), 'opus')
    assert.equal(chain('test-writer=opus,patch-test-writer=haiku', 'patch-test-writer', 'test-writer'), 'haiku')
    assert.equal(chain('reviewer=opus', 'patch-implementer', 'implementer'), '')
    assert.equal(chain('projection-test-writer=sonnet', 'patch-test-writer', 'projection-test-writer'), 'sonnet')
  })
})

test('[10] formatStageModelsForLog: vacio sin mapa, una linea con el', () => {
  assert.equal(formatStageModelsForLog(models('')), '')
  assert.equal(formatStageModelsForLog(models('reviewer=opus')), 'reviewer=opus')
  assert.equal(formatStageModelsForLog(models('writer=sonnet,reviewer=opus')), 'writer=sonnet, reviewer=opus')
})
