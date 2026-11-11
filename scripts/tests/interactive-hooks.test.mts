import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BINDINGS,
  REMINDER_TEXT,
  appendDotnetTestResult,
  appendFileChange,
  appendSession,
  appendSessionModel,
  appendTerraformResult,
  recordActiveRelease,
  releaseIdentity,
  remindFieldNotes,
} from '../interactive-hooks.mts'
import type { HookContext } from '../interactive-hooks.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SCRIPT = join(HERE, '..', 'interactive-hooks.mts')
const FIXTURES = join(REPO_ROOT, 'src', 'published', 'scripts', 'tests', 'fixtures', 'claude-hooks')
const NOW = new Date('2026-11-10T12:34:56.789Z')
const MANIFEST = {
  schemaVersion: 1,
  runtime: 'claude',
  version: '1.2.3',
  commit: '0123456789abcdef0123456789abcdef01234567',
}

let work = ''
let root = ''
let pluginRoot = ''

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as unknown
}

function context(input: unknown, overrides: Partial<HookContext> = {}): HookContext {
  return { root, pluginRoot, input, now: NOW, ...overrides }
}

function pipeline(file: string): string {
  return join(root, '.mefisto', 'pipeline', file)
}

function lines(file: string): string[] {
  if (!existsSync(pipeline(file))) return []
  return readFileSync(pipeline(file), 'utf8').split('\n').filter((line) => line.length > 0)
}

function records(file: string): Array<Record<string, unknown>> {
  return lines(file).map((line) => JSON.parse(line) as Record<string, unknown>)
}

function writeManifest(manifest: unknown): void {
  writeFileSync(join(pluginRoot, 'mefisto-manifest.json'), JSON.stringify(manifest))
}

function transcript(name: string, fixtureName: string): string {
  const path = join(work, name)
  copyFileSync(join(FIXTURES, fixtureName), path)
  return path
}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto hooks '))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

beforeEach(() => {
  root = mkdtempSync(join(work, 'repo con espacios '))
  pluginRoot = mkdtempSync(join(work, 'distribucion con espacios '))
  execFileSync('git', ['init', '--quiet', root])
  writeManifest(MANIFEST)
})

describe('record-active-release', () => {
  test('escribe los dos markers sin salto de linea y retira el marker previo', () => {
    const legacy = join(root, '.claude', 'pipeline')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, '.plugin-root.previous'), 'anterior')
    writeFileSync(join(legacy, 'otro-estado'), 'conservar')

    recordActiveRelease(context({}, { pluginRoot: '/plugins/con espacios/1.2.3' }))

    assert.equal(readFileSync(pipeline('.plugin-root'), 'utf8'), '/plugins/con espacios/1.2.3')
    assert.equal(readFileSync(join(legacy, '.plugin-root'), 'utf8'), '/plugins/con espacios/1.2.3')
    assert.equal(existsSync(join(legacy, '.plugin-root.previous')), false)
    assert.equal(readFileSync(join(legacy, 'otro-estado'), 'utf8'), 'conservar')
  })

  test('sin raiz de distribucion no escribe nada', () => {
    recordActiveRelease(context({}, { pluginRoot: '' }))
    assert.equal(existsSync(join(root, '.mefisto')), false)
  })
})

describe('append-session', () => {
  test('anexa el inicio con modelo e identidad, en el orden del contrato', () => {
    appendSession(context(fixture('startup-model.json')))
    assert.deepEqual(lines('sessions.jsonl'), [
      JSON.stringify({
        record_type: 'session.started',
        session_id: 'inicio-modelo',
        transcript_path: '/tmp/con espacios/inicio.jsonl',
        cwd: '/tmp/con espacios',
        source: 'startup',
        timestamp: '2026-11-10T12:34:56Z',
        runtime: 'claude',
        model: 'claude-sonnet-4-6',
        harness_version: '1.2.3',
        harness_commit: MANIFEST.commit,
      }),
    ])
  })

  test('sin modelo ni distribucion degrada a null', () => {
    appendSession(context(fixture('session.json'), { pluginRoot: '' }))
    const [record] = records('sessions.jsonl')
    assert.equal(record?.source, 'clear')
    assert.equal(record?.model, null)
    assert.equal(record?.harness_version, null)
    assert.equal(record?.harness_commit, null)
  })

  test('un manifiesto fuera de contrato degrada la identidad a null', () => {
    for (const manifest of [
      { malformado: true },
      { ...MANIFEST, extra: 1 },
      { ...MANIFEST, runtime: 'otro' },
      { ...MANIFEST, version: '1.2' },
      { ...MANIFEST, commit: 'abc' },
    ]) {
      writeManifest(manifest)
      assert.equal(releaseIdentity(pluginRoot), null)
    }
    writeFileSync(join(pluginRoot, 'mefisto-manifest.json'), '{no es json')
    assert.equal(releaseIdentity(pluginRoot), null)
    appendSession(context(fixture('session.json')))
    assert.equal(records('sessions.jsonl')[0]?.harness_version, null)
  })

  test('no persiste campos sensibles del evento', () => {
    appendSession(context(fixture('session.json')))
    assert.doesNotMatch(readFileSync(pipeline('sessions.jsonl'), 'utf8'), /SENTINELA/)
  })

  test('un evento que no es un objeto JSON no escribe', () => {
    for (const input of [undefined, null, 'texto', 7, ['lista']]) appendSession(context(input))
    assert.deepEqual(lines('sessions.jsonl'), [])
  })
})

describe('append-session-model', () => {
  function observe(sessionId: string, transcriptPath: string): void {
    appendSessionModel(context({ session_id: sessionId, transcript_path: transcriptPath }))
  }

  test('A repetido se omite y cada cambio de modelo queda como un hecho', () => {
    const path = join(work, 'transcript con espacios.jsonl')
    const use = (name: string): void => copyFileSync(join(FIXTURES, name), path)

    use('transcript-model-a.jsonl')
    observe('modelo', path)
    observe('modelo', path)
    use('transcript-model-b.jsonl')
    observe('modelo', path)
    observe('modelo', path)
    use('transcript-model-a.jsonl')
    observe('modelo', path)

    const observed = records('sessions.jsonl')
    assert.deepEqual(
      observed.map((record) => record.model),
      ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-sonnet-4-6'],
    )
    assert.deepEqual(Object.keys(observed[0] ?? {}), [
      'record_type',
      'session_id',
      'timestamp',
      'runtime',
      'model',
      'harness_version',
      'harness_commit',
    ])
    assert.equal(observed[0]?.record_type, 'session.model-observed')
    assert.equal(observed[0]?.harness_version, '1.2.3')
    assert.doesNotMatch(readFileSync(pipeline('sessions.jsonl'), 'utf8'), /SENTINELA/)
  })

  test('el modelo de otra sesion no cuenta como observado', () => {
    const path = transcript('otra.jsonl', 'transcript-model-a.jsonl')
    observe('una', path)
    observe('otra', path)
    assert.deepEqual(
      records('sessions.jsonl').map((record) => record.session_id),
      ['una', 'otra'],
    )
  })

  test('transcript sin respuesta, ausente o ilegible no escribe', () => {
    observe('vacio', transcript('vacio.jsonl', 'transcript-no-assistant.jsonl'))
    observe('ausente', join(work, 'no existe.jsonl'))
    observe('ilegible', transcript('ilegible.jsonl', 'transcript-malformed.jsonl'))
    appendSessionModel(context({ session_id: '', transcript_path: 'x' }))
    appendSessionModel(context(undefined))
    assert.deepEqual(lines('sessions.jsonl'), [])
  })
})

describe('remind-field-notes', () => {
  test('sin cambios de archivo no hay recordatorio ni marker', () => {
    const path = transcript('sin-cambios.jsonl', 'transcript-model-a.jsonl')
    assert.equal(remindFieldNotes(context({ session_id: 'ro', transcript_path: path })), null)
    assert.equal(existsSync(pipeline('field-notes-reminded-ro')), false)
  })

  test('con cambios recuerda una sola vez por sesion', () => {
    const path = transcript('con-cambios.jsonl', 'transcript-edit.jsonl')
    const input = { session_id: 'rw', transcript_path: path }
    assert.equal(remindFieldNotes(context(input)), JSON.stringify({ systemMessage: REMINDER_TEXT }))
    assert.equal(remindFieldNotes(context(input)), null)
    assert.equal(existsSync(pipeline('field-notes-reminded-rw')), true)
    assert.match(REMINDER_TEXT, /docs\/bitacora\/field-notes\//)
  })

  test('un session_id que no es seguro como nombre de archivo se ignora', () => {
    const path = transcript('inseguro.jsonl', 'transcript-edit.jsonl')
    for (const sessionId of ['../fuera', 'con espacio', '', 'a/b']) {
      assert.equal(remindFieldNotes(context({ session_id: sessionId, transcript_path: path })), null)
    }
    assert.equal(existsSync(join(root, '.mefisto')), false)
  })
})

describe('eventos de herramientas', () => {
  test('append-file-change anexa la ruta con la hora UTC', () => {
    appendFileChange(context(fixture('file-change.json')))
    appendFileChange(context({ tool_input: { path: 'b.txt' } }))
    appendFileChange(context({}))
    assert.deepEqual(lines('events.log'), [
      '[12:34:56][archivo] /tmp/con espacios.txt',
      '[12:34:56][archivo] b.txt',
      '[12:34:56][archivo] (desconocido)',
    ])
  })

  test('append-dotnet-test-result solo registra dotnet test', () => {
    appendDotnetTestResult(context(fixture('dotnet-pass.json')))
    appendDotnetTestResult(context(fixture('bash-negative.json')))
    appendDotnetTestResult(context({ tool_input: { command: 'dotnet test' } }))
    appendDotnetTestResult(context({ tool_input: { command: 'dotnet test' }, tool_result: 'Superado' }))
    appendDotnetTestResult(context({ tool_input: { command: 'dotnet test' }, tool_result: { x: 1 } }))
    assert.deepEqual(lines('events.log'), [
      '[12:34:56][test] PASS',
      '[12:34:56][test] FAIL',
      '[12:34:56][test] PASS',
    ])
  })

  test('append-terraform-result registra subcomando y veredicto', () => {
    appendTerraformResult(context(fixture('terraform-error.json')))
    appendTerraformResult(context(fixture('bash-negative.json')))
    appendTerraformResult(context({ tool_input: { command: 'terraform plan' } }))
    appendTerraformResult(
      context({ tool_input: { command: 'terraform validate' }, tool_result: { exitCode: 0 } }),
    )
    assert.deepEqual(lines('events.log'), [
      '[12:34:56][terraform] apply: ERROR',
      '[12:34:56][terraform] plan: OK',
      '[12:34:56][terraform] validate: OK',
    ])
  })

  test('ningun evento persiste comandos ni salidas', () => {
    appendFileChange(context(fixture('file-change.json')))
    appendDotnetTestResult(context(fixture('dotnet-pass.json')))
    appendTerraformResult(context(fixture('terraform-error.json')))
    assert.doesNotMatch(readFileSync(pipeline('events.log'), 'utf8'), /SENTINELA/)
  })
})

describe('contrato y linea de comando', () => {
  function run(binding: string, input: string, cwd: string, env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [SCRIPT, binding], {
      cwd,
      input,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: '', ...env },
    })
  }

  test('los bindings del script son los del contrato publicado', () => {
    const contract = JSON.parse(
      readFileSync(join(REPO_ROOT, 'src', 'published', 'hooks', 'interactive-hooks.json'), 'utf8'),
    ) as { bindings: Array<{ id: string }> }
    assert.deepEqual(Object.keys(BINDINGS).sort(), contract.bindings.map((b) => b.id).sort())
  })

  test('desde un subdirectorio escribe en la raiz del repo', () => {
    const subdir = join(root, 'infra', 'environments', 'dev')
    mkdirSync(subdir, { recursive: true })
    const result = run('append-session', readFileSync(join(FIXTURES, 'startup-model.json'), 'utf8'), subdir, {
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    })
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
    const [record] = records('sessions.jsonl')
    assert.equal(record?.session_id, 'inicio-modelo')
    assert.equal(record?.harness_version, '1.2.3')
  })

  test('remind-field-notes imprime el mensaje como una linea JSON', () => {
    const path = transcript('cli.jsonl', 'transcript-edit.jsonl')
    const result = run('remind-field-notes', JSON.stringify({ session_id: 'cli', transcript_path: path }), root)
    assert.equal(result.status, 0)
    assert.deepEqual(JSON.parse(result.stdout), { systemMessage: REMINDER_TEXT })
  })

  test('fuera de un repo git termina en 0 sin escribir', () => {
    const outside = mkdtempSync(join(tmpdir(), 'mefisto sin repo '))
    try {
      const result = run('append-file-change', '{}', outside, { GIT_CEILING_DIRECTORIES: dirname(outside) })
      assert.equal(result.status, 0)
      assert.equal(existsSync(join(outside, '.mefisto')), false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('una entrada que no es JSON termina en 0 sin escribir', () => {
    const result = run('append-session', 'no es json', root)
    assert.equal(result.status, 0)
    assert.deepEqual(lines('sessions.jsonl'), [])
  })

  test('un binding desconocido termina en 1', () => {
    const result = run('no-existe', '{}', root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /binding desconocido/)
  })
})
