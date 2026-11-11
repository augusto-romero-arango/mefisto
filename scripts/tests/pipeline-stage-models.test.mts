import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
import { BASH_LIBRARY, NO_BASH, NO_BASH_JQ, REPO_ROOT, RUNTIME_LIB_DIR, bashLibrary, chomp } from './pipeline-agents-parity.mts'

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
  mkdirSync(join(plugin, 'scripts'), { recursive: true })
  mkdirSync(agentsDir)
  copyFileSync(BASH_LIBRARY, join(plugin, 'scripts', '_pipeline-common.sh'))
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
    assert.equal(readFileSync(eventsLog, 'utf8'), '')
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
    assert.equal(parseError('=opus'), "entrada '=opus': agente y modelo no pueden estar vacios")
    assert.equal(parseError('reviewer='), "entrada 'reviewer=': agente y modelo no pueden estar vacios")
  })

  test('[7] un agente repetido falla nombrandolo', () => {
    assert.equal(parseError('writer=sonnet,writer=opus'), "el agente 'writer' esta repetido")
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

describe('paridad con la gemela bash', { skip: NO_BASH }, () => {
  test('resolve_declared_agent_model', () => {
    const library = join(plugin, 'scripts', '_pipeline-common.sh')
    const agents = [...Object.keys(AGENT_FIXTURES), 'agente-inexistente', 'es-carpeta', '']
    const script = 'for agent in "$@"; do model=$(resolve_declared_agent_model "$agent"); printf "%s %s\\n" "$?" "$model"; done'
    assert.deepEqual(
      agents.map((agent) => `0 ${resolveDeclaredAgentModel(agent, agentsDir)}`),
      chomp(bashLibrary(script, agents, { library }).stdout).split('\n'),
    )
  })

  test('pipeline_agent_effort_level', () => {
    const agents = [...Object.keys(PIPELINE_AGENT_EFFORT_LEVELS), 'agente-inexistente', 'toString', '']
    const script = 'for agent in "$@"; do level=$(pipeline_agent_effort_level "$agent"); printf "%s %s\\n" "$?" "$level"; done'
    assert.deepEqual(
      agents.map((agent) => {
        const level = pipelineAgentEffortLevel(agent)
        return level === null ? '1 ' : `0 ${level}`
      }),
      chomp(bashLibrary(script, agents).stdout).split('\n'),
    )
  })

  test('resolve_pipeline_agent_effort', { skip: NO_BASH_JQ }, async () => {
    const mapping = join(work, 'paridad-models.json')
    writeFileSync(
      mapping,
      '{"fake":{"efforts":{"levels":{"light":"n-light","thorough":"n-thorough"},"agents":{"tooling-reviewer":"thorough"}}}}\n',
    )
    const invalid = join(work, 'paridad-invalido.json')
    writeFileSync(invalid, '{"fake":{"efforts":{"levels":"no-es-un-objeto"}}}\n')
    const broken = join(work, 'paridad-roto.json')
    writeFileSync(broken, '{"fake":')
    const script = [
      'source "$1/mefisto-models.sh"',
      'MEFISTO_RUNTIME_RESUELTO="$2"; CONSUMER_MODELS_FILE="$3"; EVENTS_LOG_ABS="$4"',
      'resolve_pipeline_agent_effort "$5" "$6"',
      'printf "%s\\n%s\\n%s\\n" "$?" "$RESOLVED_PIPELINE_EFFORT" "$PIPELINE_EFFORT_ERROR"',
    ].join('\n')
    const cases: [runtime: string, mappingFile: string, key: string, agent: string, env: Record<string, string>][] = [
      ['fake', '', 'writer', 'tooling-writer', {}],
      ['fake', join(work, 'ausente.json'), 'writer', 'tooling-writer', {}],
      ['fake', '', 'reviewer', 'tooling-reviewer', { MEFISTO_FAKE_DEFAULT_EFFORT: 'fx-default' }],
      ['fake', mapping, 'writer', 'tooling-writer', {}],
      ['fake', mapping, 'implementer', 'implementer', { MEFISTO_FAKE_DEFAULT_EFFORT: 'fx-default' }],
      ['fake', mapping, 'reviewer', 'tooling-reviewer', {}],
      ['fake', mapping, 'x', 'agente-inexistente', {}],
      ['fake', invalid, 'writer', 'tooling-writer', {}],
      ['fake', broken, 'writer', 'tooling-writer', {}],
      ['no_existe', '', 'writer', 'tooling-writer', {}],
      ['No-Valido', '', 'writer', 'tooling-writer', {}],
      ['claude', '', 'scaffold', 'domain-scaffolder', {}],
    ]
    for (const [runtime, mappingFile, key, agent, extra] of cases) {
      const env = { PATH: process.env.PATH ?? '', MEFISTO_RUNTIME_LIB_DIR: RUNTIME_LIB_DIR, ...extra }
      const bashLog = join(work, 'paridad-bash.log')
      const ownLog = join(work, 'paridad-ts.log')
      for (const log of [bashLog, ownLog]) writeFileSync(log, '')
      const fromBash = bashLibrary(script, [RUNTIME_LIB_DIR, runtime, mappingFile, bashLog, key, agent], { env })
      const resolved = await resolvePipelineAgentEffort({ key, agentId: agent, runtime, mappingFile, eventsLog: ownLog, env })
      const label = `${runtime} ${key} ${agent} ${mappingFile}`
      assert.equal(
        'error' in resolved ? `1\n\n${resolved.error}\n` : `0\n${resolved.effort}\n\n`,
        // El adaptador bash vive en un `.sh` y el de TypeScript en un `.mts`.
        fromBash.stdout.replace(/(runtime-[a-z0-9_]+)\.sh\)/, '$1.mts)'),
        label,
      )
      const withoutClock = (log: string): string => readFileSync(log, 'utf8').replace(/^\[\d{2}:\d{2}:\d{2}\]/gm, '[]')
      assert.equal(withoutClock(ownLog), withoutClock(bashLog), label)
    }
  })

  test('parse_stage_models, resolve_stage_model y format_stage_models_for_log', () => {
    // Tras un spec invalido el llamador aborta: el mapa a medias de la gemela no se compara.
    const script = [
      'for spec in "$@"; do (',
      '  parse_stage_models "$spec" || { printf "1\\n%s\\n\\036" "$PIPELINE_STAGE_MODELS_ERROR"; exit 0; }',
      '  printf "0\\n%s\\n%s\\n" "$PIPELINE_STAGE_MODELS_ERROR" "$(format_stage_models_for_log)"',
      '  for agent in writer reviewer a " a " test-writer write ""; do resolve_stage_model "$agent" "por-defecto"; done',
      '  printf "\\036"',
      '); done',
    ].join('\n')
    const agents = ['writer', 'reviewer', 'a', ' a ', 'test-writer', 'write', '']
    const specs = [
      '',
      'reviewer=opus',
      'writer=sonnet,reviewer=opus',
      'writer=claude-opus-5[1m]',
      'reviewer-opus',
      '=opus',
      'reviewer=',
      '=',
      'writer=sonnet,writer=opus',
      'writer=sonnet,reviewer-opus',
      ',,a=b,,',
      ',',
      'a=b=c',
      'a=b,',
      ' a = b ',
      'a=*,writer=$HOME',
      'a=b\nc=d',
      'test-writer=opus,patch-test-writer=haiku',
    ]
    const fromBash = bashLibrary(script, specs).stdout.split('\u001e')
    assert.equal(fromBash.length, specs.length + 1)
    specs.forEach((spec, index) => {
      const parsed = parseStageModels(spec)
      const expected =
        'error' in parsed
          ? ['1', parsed.error, '']
          : [
              '0',
              '',
              formatStageModelsForLog(parsed.models),
              ...agents.map((agent) => resolveStageModel(parsed.models, agent, 'por-defecto')),
              '',
            ]
      assert.equal(expected.join('\n'), fromBash[index], JSON.stringify(spec))
    })
  })
})
