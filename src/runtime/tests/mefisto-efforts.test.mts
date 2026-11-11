import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { resolveEffort } from '../lib/mefisto-models.mts'
import type { EffortRequest } from '../lib/mefisto-models.mts'
import { adapterPath } from '../lib/mefisto-runtime.mts'
import { LIB_DIR } from './runner-sandbox.mts'

let work = ''
let mapping = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto efforts '))
  mapping = join(work, 'm.json')
  writeFileSync(
    mapping,
    '{"claude":{"efforts":{"agents":{"implementer":"thorough"},"levels":{"thorough":"high"}}}}\n',
  )
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

function claude(agentId: string, level: string, mappingFile?: string) {
  const request: EffortRequest = { runtime: 'claude', agentId, level, libDir: LIB_DIR, env: {} }
  return resolveEffort(mappingFile === undefined ? request : { ...request, mappingFile })
}

function invalid(content: string) {
  const path = join(work, 'v.json')
  writeFileSync(path, content)
  return claude('a', 'quick', path).then((result) => ({ result, path }))
}

describe('precedencia', () => {
  test('el override del agente cambia el nivel y `levels` cambia su valor nativo', async () => {
    assert.deepEqual(await claude('implementer', 'light', mapping), { effort: 'high' })
    assert.deepEqual(await claude('other', 'thorough', mapping), { effort: 'high' })
    assert.deepEqual(await claude('other', 'exhaustive', mapping), { effort: 'max' })
  })

  test('sin mapping rige la tabla del adaptador', async () => {
    assert.deepEqual(await claude('other', 'light'), { effort: 'medium' })
    assert.deepEqual(await claude('other', 'standard', join(work, 'no-existe.json')), { effort: 'high' })
    writeFileSync(join(work, 'vacio.json'), '')
    assert.deepEqual(await claude('other', 'thorough', join(work, 'vacio.json')), { effort: 'xhigh' })
    assert.deepEqual(await claude('other', 'exhaustive', ''), { effort: 'max' })
    assert.deepEqual(await claude('a', 'quick'), { effort: 'low' })
  })

  test('un nivel de fabrica vacio o fuera del vocabulario falla citando el valor', async () => {
    assert.deepEqual(await claude('other', 'bogus'), {
      error: "nivel de fabrica: 'bogus' no esta en el vocabulario quick|light|standard|thorough|exhaustive",
    })
    assert.deepEqual(await claude('other', ''), {
      error: "nivel de fabrica: '' no esta en el vocabulario quick|light|standard|thorough|exhaustive",
    })
  })
})

describe('adaptadores', () => {
  test('un adaptador con default lo aplica y uno sin default hereda', async () => {
    const adapter = adapterPath(work, 'nodef2')
    writeFileSync(adapter, "export function defaultEffort() { return 'nodef' }\n")
    const request: EffortRequest = { runtime: 'nodef2', agentId: 'a', level: 'quick', libDir: work, env: {} }
    assert.deepEqual(await resolveEffort(request), { effort: 'nodef' })
    writeFileSync(adapter, 'export const nada = 1\n')
    assert.deepEqual(await resolveEffort(request), { effort: '' })
  })

  test('el fake toma su default del entorno', async () => {
    assert.deepEqual(
      await resolveEffort({
        runtime: 'fake',
        agentId: 'a',
        level: 'quick',
        libDir: LIB_DIR,
        env: { MEFISTO_FAKE_DEFAULT_EFFORT: 'zz' },
      }),
      { effort: 'zz' },
    )
  })

  test('runtime invalido, sin adaptador o que rechaza el nivel', async () => {
    const base = { agentId: 'a', level: 'quick', libDir: work, env: {} }
    assert.deepEqual(await resolveEffort({ ...base, runtime: 'bad-id' }), { error: "runtime invalido: 'bad-id'" })
    assert.deepEqual(await resolveEffort({ ...base, runtime: 'missing' }), {
      error: `runtime 'missing' no tiene adaptador (${adapterPath(work, 'missing')})`,
    })
    writeFileSync(adapterPath(work, 'terco'), 'export function defaultEffort() { return null }\n')
    assert.deepEqual(await resolveEffort({ ...base, runtime: 'terco' }), {
      error: "runtime_terco_default_effort: no acepta el nivel 'quick'",
    })
  })
})

describe('bloque efforts invalido', () => {
  const cases: [string, string, string][] = [
    ['nivel desconocido en levels', '{"claude":{"efforts":{"levels":{"alto":"high"}}}}', 'claude.efforts.levels.alto: nivel desconocido'],
    ['valor nativo vacio', '{"claude":{"efforts":{"levels":{"quick":""}}}}', 'claude.efforts.levels.quick: se esperaba un string no vacio'],
    ['nivel invalido de un agente', '{"claude":{"efforts":{"agents":{"x":"alto"}}}}', 'claude.efforts.agents.x: nivel desconocido'],
    ['campo desconocido', '{"claude":{"efforts":{"otro":{}}}}', 'claude.efforts.otro: campo desconocido'],
    ['un perfil de modelo no es un nivel', '{"claude":{"efforts":{"agents":{"x":"deep"}}}}', 'claude.efforts.agents.x: nivel desconocido'],
  ]
  for (const [name, content, reason] of cases) {
    test(name, async () => {
      const { result, path } = await invalid(content)
      assert.deepEqual(result, { error: `${path}: ${reason}` })
    })
  }
})
