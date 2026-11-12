import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { USAGE, jsonValue } from '../json-value.mts'
import type { Io } from '../json-value.mts'
import { commandExists } from '../lib/cli.mts'
import { DIST_SCRIPTS, SCRIPTS, assertDistributed } from './azure-cli-sandbox.mts'

const SCRIPT = join(SCRIPTS, 'json-value.mts')
const NO_SHELL = process.platform === 'win32'
const NO_JQ = NO_SHELL || !commandExists('jq')

const CONFIG = {
  projectName: 'Demo',
  namespacePrefix: 'Acme',
  solutionFile: 'Acme.slnx',
  repoSlug: 'org/fork',
  projections: { enabled: true },
  boundedContext: { name: 'Principal', domains: ['control-horas', 'nomina'] },
  domainLabels: ['Control-Horas', 'nomina', 'turnos'],
  serviceBus: {
    internal: { secretName: 'sb-interno' },
    external: [
      { alias: 'BACKBONE', alcance: 'compartido', secretName: 's1' },
      { alias: 'SOCIO', alcance: 'externo', secretName: 's2' },
      { alias: 'OTRO', alcance: 'compartido', secretName: 's3' },
    ],
  },
  tenancy: { strategy: 'multi-tenant-header', otro: 'se conserva' },
  secrets: [{ name: 'a' }, { name: 'b' }],
}
const MINIMAL = { projectName: 'Demo', projections: { enabled: false }, tenancy: null, repoSlug: '' }
const MANIFEST = { schemaVersion: 1, runtime: 'claude', version: '1.2.3', commit: 'a'.repeat(40) }

interface Run {
  status: number
  out: string
  err: string
  files: Map<string, string>
}

function run(argv: string[], files: Record<string, string> = {}, stdin = ''): Run {
  const store = new Map(Object.entries(files))
  let [out, err] = ['', '']
  const io: Io = {
    readFile: (path) => {
      const content = store.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    },
    readStdin: () => stdin,
    replaceFile: (path, content) => void store.set(path, content),
    out: (text) => void (out += text),
    err: (text) => void (err += text),
  }
  const status = jsonValue(argv, io)
  return { status, out, err, files: store }
}

const FILES = { 'c.json': JSON.stringify(CONFIG), 'm.json': JSON.stringify(MINIMAL), 'roto.json': '{"a":' }

describe('get', () => {
  test('imprime una cadena sin comillas y un booleano como texto', () => {
    assert.deepEqual(run(['get', 'c.json', 'namespacePrefix'], FILES), { status: 0, out: 'Acme\n', err: '', files: new Map(Object.entries(FILES)) })
    assert.equal(run(['get', 'c.json', 'projections.enabled'], FILES).out, 'true\n')
    assert.equal(run(['get', 'm.json', 'projections.enabled'], FILES).out, 'false\n')
    assert.equal(run(['get', 'c.json', 'boundedContext.domains[1]'], FILES).out, 'nomina\n')
  })

  test('sin opciones, un valor ausente o null imprime null', () => {
    assert.equal(run(['get', 'm.json', 'noExiste'], FILES).out, 'null\n')
    assert.equal(run(['get', 'm.json', 'tenancy.strategy'], FILES).out, 'null\n')
  })

  test('--or-empty no imprime nada si el valor falta, es null o es false', () => {
    for (const path of ['noExiste', 'tenancy', 'projections.enabled']) {
      assert.deepEqual([run(['get', 'm.json', path, '--or-empty'], FILES).out, path], ['', path])
    }
    assert.equal(run(['get', 'm.json', 'repoSlug', '--or-empty'], FILES).out, '\n')
    assert.equal(run(['get', 'c.json', 'repoSlug', '--or-empty'], FILES).out, 'org/fork\n')
  })

  test('--default sustituye lo ausente, null y false', () => {
    assert.equal(run(['get', 'm.json', 'tenancy.strategy', '--default', 'mono-tenant-transitorio'], FILES).out, 'mono-tenant-transitorio\n')
    assert.equal(run(['get', 'm.json', 'projections.enabled', '--default', 'false'], FILES).out, 'false\n')
    assert.equal(run(['get', 'm.json', 'solutionFile', '--default', ''], FILES).out, '\n')
    assert.equal(run(['get', 'c.json', 'tenancy.strategy', '--default', 'x'], FILES).out, 'multi-tenant-header\n')
  })

  test('un objeto sale como JSON con sangria de 2', () => {
    assert.equal(run(['get', 'c.json', 'projections'], FILES).out, '{\n  "enabled": true\n}\n')
  })

  test('lee la entrada estandar con -', () => {
    assert.equal(run(['get', '-', 'ultima', '--or-empty'], {}, '{"ultima":"rev-1","lista":null}').out, 'rev-1\n')
    assert.equal(run(['get', '-', 'lista', '--or-empty'], {}, '{"ultima":"rev-1","lista":null}').out, '')
  })

  test('una entrada vacia no imprime nada y termina en 0', () => {
    assert.deepEqual([run(['get', '-', 'a'], {}, '').status, run(['get', '-', 'a'], {}, ' \n').out], [0, ''])
  })

  test('aplica la ruta a cada valor de la entrada', () => {
    assert.equal(run(['get', '-', 'a'], {}, '{"a":1}\n{"a":2}').out, '1\n2\n')
  })

  test('termina en 2 si el archivo no existe o no es JSON, sin salida', () => {
    const missing = run(['get', 'nada.json', 'a'], FILES)
    assert.deepEqual([missing.status, missing.out, missing.err], [2, '', 'json-value: no se pudo leer nada.json\n'])
    const broken = run(['get', 'roto.json', 'a'], FILES)
    assert.deepEqual([broken.status, broken.out, broken.err], [2, '', 'json-value: roto.json no es JSON valido\n'])
  })

  test('termina en 5 si el dato no admite la ruta', () => {
    const result = run(['get', 'c.json', 'projectName.x'], FILES)
    assert.deepEqual([result.status, result.out], [5, ''])
    assert.match(result.err, /^json-value: Cannot index string with "x"\n$/)
  })

  test('--default y --or-empty son excluyentes', () => {
    const result = run(['get', 'c.json', 'a', '--default', 'x', '--or-empty'], FILES)
    assert.equal(result.status, 2)
    assert.equal(result.err, `json-value: --default y --or-empty son excluyentes\n${USAGE}\n`)
  })
})

describe('each', () => {
  test('imprime un elemento por linea', () => {
    assert.equal(run(['each', 'c.json', 'boundedContext.domains'], FILES).out, 'control-horas\nnomina\n')
  })

  test('sin --or-empty falla con 5 sobre un valor ausente; con --or-empty no imprime nada', () => {
    assert.deepEqual([run(['each', 'm.json', 'domainLabels'], FILES).status, run(['each', 'm.json', 'domainLabels'], FILES).out], [5, ''])
    const optional = run(['each', 'm.json', 'domainLabels', '--or-empty'], FILES)
    assert.deepEqual([optional.status, optional.out, optional.err], [0, '', ''])
  })

  test('--where filtra por igualdad de campo y --field proyecta', () => {
    const argv = ['each', 'c.json', 'serviceBus.external', '--or-empty', '--where', 'alcance=compartido', '--field', 'alias']
    assert.equal(run(argv, FILES).out, 'BACKBONE\nOTRO\n')
    assert.equal(run(['each', 'm.json', 'serviceBus.external', '--or-empty', '--where', 'alcance=compartido', '--field', 'alias'], FILES).out, '')
    assert.equal(run(['each', 'c.json', 'secrets', '--field', 'name'], FILES).out, 'a\nb\n')
  })

  test('--where admite un valor con =', () => {
    const files = { 'x.json': '{"l":[{"k":"a=b","v":1},{"k":"a","v":2}]}' }
    assert.equal(run(['each', 'x.json', 'l', '--where', 'k=a=b', '--field', 'v'], files).out, '1\n')
  })

  test('--join une los elementos en una linea', () => {
    assert.equal(run(['each', 'c.json', 'domainLabels', '--or-empty', '--join', ', '], FILES).out, 'Control-Horas, nomina, turnos\n')
    assert.equal(run(['each', 'm.json', 'domainLabels', '--or-empty', '--join', ', '], FILES).out, '\n')
  })

  test('--last deja los ultimos elementos', () => {
    const search = JSON.stringify({ searchResult: [{ packages: ['1', '2', '3', '4', '5', '6', '7'].map((version) => ({ id: 'WorkOS.net', version })) }] })
    const argv = ['each', '-', 'searchResult[0].packages', '--field', 'version', '--last', '5']
    assert.equal(run(argv, {}, search).out, '3\n4\n5\n6\n7\n')
    assert.equal(run(argv, {}, '{"problems":[]}').status, 5)
    assert.equal(run(argv, {}, 'sin red').status, 2)
    assert.equal(run([...argv.slice(0, -1), '0'], {}, search).status, 2)
  })
})

describe('length y pick', () => {
  test('length cuenta los elementos y da 0 si el valor falta', () => {
    assert.equal(run(['length', 'c.json', 'secrets'], FILES).out, '2\n')
    assert.equal(run(['length', 'm.json', 'secrets'], FILES).out, '0\n')
    assert.equal(run(['length', '-', '.'], {}, '[1,2,3]').out, '3\n')
  })

  test('pick imprime el objeto con las claves pedidas', () => {
    assert.equal(
      run(['pick', 'm.json', 'projectName', 'azureLocation', 'projections'], FILES).out,
      '{\n  "projectName": "Demo",\n  "azureLocation": null,\n  "projections": {\n    "enabled": false\n  }\n}\n',
    )
    assert.equal(run(['pick', 'nada.json', 'a'], FILES).status, 2)
    assert.equal(run(['pick', 'c.json'], FILES).status, 2)
  })
})

describe('set', () => {
  test('fija el valor, conserva el resto y deja sangria de 2 con salto final', () => {
    const result = run(['set', 'x.json', 'tenancy.strategy', 'multi-tenant-header'], { 'x.json': '{"a": 1,\n"tenancy":{"otro":true}, "z": [1.0]}' })
    assert.deepEqual([result.status, result.out, result.err], [0, '', ''])
    assert.equal(
      result.files.get('x.json'),
      '{\n  "a": 1,\n  "tenancy": {\n    "otro": true,\n    "strategy": "multi-tenant-header"\n  },\n  "z": [\n    1.0\n  ]\n}\n',
    )
  })

  test('crea el objeto que falta y admite un texto que empieza por --', () => {
    const result = run(['set', 'x.json', 'tenancy.strategy', '--raro'], { 'x.json': '{}' })
    assert.equal(result.files.get('x.json'), '{\n  "tenancy": {\n    "strategy": "--raro"\n  }\n}\n')
  })

  test('no toca el archivo si no es un unico documento JSON', () => {
    for (const content of ['', '{"a":', '{} {}']) {
      const result = run(['set', 'x.json', 'tenancy.strategy', 'v'], { 'x.json': content })
      assert.deepEqual([result.status, result.files.get('x.json')], [2, content])
      assert.equal(result.err, 'json-value: x.json no es un unico documento JSON; no se modifico\n')
    }
  })

  test('no toca el archivo si un intermedio no es objeto', () => {
    const result = run(['set', 'x.json', 'tenancy.strategy', 'v'], { 'x.json': '{"tenancy":"x"}' })
    assert.deepEqual([result.status, result.files.get('x.json')], [5, '{"tenancy":"x"}'])
    assert.equal(result.err, 'json-value: string and object cannot be added; no se modifico x.json\n')
  })

  test('termina en 2 si el archivo no existe o la ruta lleva un indice', () => {
    assert.equal(run(['set', 'nada.json', 'a', 'v']).status, 2)
    assert.equal(run(['set', 'x.json', 'a[0]', 'v'], { 'x.json': '{}' }).status, 2)
    assert.equal(run(['set', 'x.json', 'a'], { 'x.json': '{}' }).status, 2)
  })
})

describe('from-lines', () => {
  test('arma un arreglo compacto con las lineas de la entrada', () => {
    assert.equal(run(['from-lines'], {}, 'https://a.test\nhttps://b.test\n').out, '["https://a.test","https://b.test"]\n')
    assert.equal(run(['from-lines'], {}, '').out, '[]\n')
  })
})

describe('validate', () => {
  test('termina en 0 sin salida si es un documento JSON', () => {
    assert.deepEqual(run(['validate', 'c.json'], FILES).status, 0)
    const result = run(['validate', '-'], {}, '{"dominio":"X"}\n')
    assert.deepEqual([result.status, result.out, result.err], [0, '', ''])
  })

  test('termina en 1 si no lo es, si esta vacio o si no existe', () => {
    assert.deepEqual([run(['validate', 'roto.json'], FILES).status, run(['validate', 'roto.json'], FILES).err], [1, 'json-value: roto.json no es un documento JSON valido\n'])
    assert.equal(run(['validate', '-'], {}, '').status, 1)
    assert.equal(run(['validate', '-'], {}, '{} {}').status, 1)
    assert.deepEqual([run(['validate', 'nada.json']).status, run(['validate', 'nada.json']).err], [1, 'json-value: no se pudo leer nada.json\n'])
  })
})

describe('csproj-pin', () => {
  const PACKAGE = 'OpenTelemetry.Extensions.Hosting'
  const csproj = (version: string): string =>
    `<Project><ItemGroup><PackageReference Include="${PACKAGE}" Version="${version}" /></ItemGroup></Project>`

  test('termina en 0 sin salida con el pin exacto', () => {
    const result = run(['csproj-pin', PACKAGE, '1.15.3', 'a.csproj'], { 'a.csproj': csproj('1.15.3') })
    assert.deepEqual([result.status, result.out, result.err], [0, '', ''])
  })

  test('termina en 1 y explica por stdout el pin distinto o el archivo ilegible', () => {
    const mismatch = run(['csproj-pin', PACKAGE, '1.15.3', 'a.csproj'], { 'a.csproj': csproj('1.13.1') })
    assert.deepEqual(
      [mismatch.status, mismatch.out, mismatch.err],
      [1, `ERROR: paquete ${PACKAGE}: se esperaba el pin 1.15.3 en a.csproj; se encontro 1.13.1 como atributo Version.\n`, ''],
    )
    const missing = run(['csproj-pin', PACKAGE, '1.15.3', 'a.csproj'])
    assert.deepEqual(
      [missing.status, missing.out],
      [1, `ERROR: paquete ${PACKAGE}: se esperaba el pin 1.15.3 en a.csproj, pero el archivo no se pudo leer.\n`],
    )
  })
})

describe('uso', () => {
  test('un subcomando desconocido o ausente termina en 2 con el uso', () => {
    for (const argv of [[], ['nada'], ['toString'], ['get'], ['get', 'c.json'], ['each', 'c.json', 'a', '--otra'], ['get', 'c.json', 'a', '--default']]) {
      const result = run(argv, FILES)
      assert.deepEqual([result.status, result.out], [2, ''], argv.join(' '))
      assert.ok(result.err.endsWith(`${USAGE}\n`), argv.join(' '))
    }
  })

  test('una ruta invalida termina en 2', () => {
    assert.equal(run(['get', 'c.json', 'a..b'], FILES).err, `json-value: ruta invalida: 'a..b'\n${USAGE}\n`)
  })
})

interface Spawned {
  status: number | null
  stdout: string
  stderr: string
}

function spawnTool(script: string, args: string[], input = ''): Spawned {
  const result = spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('proceso', () => {
  let work = ''
  let config = ''

  before(() => {
    work = mkdtempSync(join(tmpdir(), 'mefisto json value '))
    mkdirSync(join(work, '.mefisto'))
    config = join(work, '.mefisto', 'harness.config.json')
    writeFileSync(config, `${JSON.stringify(CONFIG, null, 2)}\n`)
  })

  after(() => {
    rmSync(work, { recursive: true, force: true })
  })

  test('lee un archivo en una ruta con espacios', () => {
    assert.deepEqual(spawnTool(SCRIPT, ['get', config, 'repoSlug', '--or-empty']), { status: 0, stdout: 'org/fork\n', stderr: '' })
  })

  test('lee la entrada estandar', () => {
    assert.deepEqual(spawnTool(SCRIPT, ['from-lines'], 'a\nb\n'), { status: 0, stdout: '["a","b"]\n', stderr: '' })
    assert.deepEqual(spawnTool(SCRIPT, ['get', '-', 'a'], '{"a":"x"}'), { status: 0, stdout: 'x\n', stderr: '' })
  })

  test('un archivo ausente termina en 2 con el motivo por stderr', () => {
    const missing = join(work, 'nada.json')
    assert.deepEqual(spawnTool(SCRIPT, ['get', missing, 'a']), {
      status: 2,
      stdout: '',
      stderr: `json-value: no se pudo leer ${missing}\n`,
    })
  })

  test('set reemplaza el archivo sin dejar temporales', () => {
    const target = join(work, '.mefisto', 'escritura.json')
    writeFileSync(target, '{"a":1}')
    assert.deepEqual(spawnTool(SCRIPT, ['set', target, 'tenancy.strategy', 'multi-tenant-header']), { status: 0, stdout: '', stderr: '' })
    assert.equal(readFileSync(target, 'utf8'), '{\n  "a": 1,\n  "tenancy": {\n    "strategy": "multi-tenant-header"\n  }\n}\n')
    assert.deepEqual(readdirSync(join(work, '.mefisto')).sort(), ['escritura.json', 'harness.config.json'])
  })

  test('set deja intacto un archivo que no es JSON', () => {
    const target = join(work, 'roto.json')
    writeFileSync(target, '{"a":')
    assert.equal(spawnTool(SCRIPT, ['set', target, 'tenancy.strategy', 'v']).status, 2)
    assert.equal(readFileSync(target, 'utf8'), '{"a":')
  })
})

describe('distribucion', () => {
  test('dist/claude trae el script y sus modulos identicos a scripts/, y los inventaria', () => {
    assertDistributed(['json-value.mts', 'lib/json-value.mts', 'lib/package-reference-pin.mts'])
  })

  test('la copia de dist resuelve sus modulos', () => {
    assert.deepEqual(spawnTool(join(DIST_SCRIPTS, 'json-value.mts'), ['get', '-', 'version'], JSON.stringify(MANIFEST)), {
      status: 0,
      stdout: '1.2.3\n',
      stderr: '',
    })
  })
})

// Cada caso es un filtro de jq que algun comando o agente usaba, con la invocacion que lo reemplazo.
// Las entradas evitan lo que cambia entre versiones de jq (numeros con decimales, codigos de salida
// distintos de cero): solo se compara la salida y si el codigo es cero o no.
interface Parity {
  jq: string[]
  tool: string[]
  /** Contenido del archivo; `null` si el archivo no existe. */
  inputs: (string | null)[]
  stdin?: boolean
}

const DOCUMENTS = [JSON.stringify(CONFIG), JSON.stringify(MINIMAL), JSON.stringify(MANIFEST), '{}', 'null']
const JSON_INPUTS = [...DOCUMENTS, '', '{"a":', 'texto suelto', null]

const PARITY: Parity[] = [
  { jq: ['-r', '.namespacePrefix // empty'], tool: ['get', '@', 'namespacePrefix', '--or-empty'], inputs: JSON_INPUTS },
  { jq: ['-r', '.repoSlug // empty'], tool: ['get', '@', 'repoSlug', '--or-empty'], inputs: JSON_INPUTS },
  { jq: ['-r', '.projections.enabled'], tool: ['get', '@', 'projections.enabled'], inputs: [...JSON_INPUTS, '{"projections":"si"}'] },
  { jq: ['-r', '.projections.enabled // false'], tool: ['get', '@', 'projections.enabled', '--default', 'false'], inputs: JSON_INPUTS },
  {
    jq: ['-r', '.tenancy.strategy // "mono-tenant-transitorio"'],
    tool: ['get', '@', 'tenancy.strategy', '--default', 'mono-tenant-transitorio'],
    inputs: [...JSON_INPUTS, '{"tenancy":"plano"}', '{"tenancy":{"strategy":false}}'],
  },
  { jq: ['-r', '.namespacePrefix // ""'], tool: ['get', '@', 'namespacePrefix', '--default', ''], inputs: JSON_INPUTS },
  { jq: ['-r', '.solutionFile // ""'], tool: ['get', '@', 'solutionFile', '--default', ''], inputs: JSON_INPUTS },
  {
    jq: ['-r', '.boundedContext.domains[0] // ""'],
    tool: ['get', '@', 'boundedContext.domains[0]', '--default', ''],
    inputs: [...JSON_INPUTS, '{"boundedContext":{"domains":[]}}', '{"boundedContext":{"domains":"x"}}'],
  },
  { jq: ['-r', '.version'], tool: ['get', '@', 'version'], inputs: JSON_INPUTS },
  {
    jq: ['-r', '.boundedContext.domains[]'],
    tool: ['each', '@', 'boundedContext.domains'],
    inputs: [...JSON_INPUTS, '{"boundedContext":{"domains":[]}}', '{"boundedContext":{"domains":{"a":"x","b":"y"}}}'],
  },
  { jq: ['-r', '.domainLabels[]?'], tool: ['each', '@', 'domainLabels', '--or-empty'], inputs: [...JSON_INPUTS, '{"domainLabels":[]}'] },
  {
    jq: ['-r', '.domainLabels // [] | join(", ")'],
    tool: ['each', '@', 'domainLabels', '--or-empty', '--join', ', '],
    inputs: [...JSON_INPUTS, '{"domainLabels":["a",null,3,true]}', '{"domainLabels":["a",{}]}', '{"domainLabels":"x"}'],
  },
  {
    jq: ['-r', '.serviceBus.external // [] | map(select(.alcance == "compartido")) | .[].alias'],
    tool: ['each', '@', 'serviceBus.external', '--or-empty', '--where', 'alcance=compartido', '--field', 'alias'],
    inputs: [
      ...JSON_INPUTS,
      '{"serviceBus":{"external":[{"alcance":"compartido"},{"alias":"A","alcance":"compartido"}]}}',
      '{"serviceBus":{"external":["suelto"]}}',
      '{"serviceBus":"x"}',
    ],
  },
  {
    jq: ['-r', '{projectName, infraResourceGroupPrefix, terraformStateStorage, azureLocation, azureRegionShort, resourceSequence, serviceBus, projections}'],
    tool: ['pick', '@', 'projectName', 'infraResourceGroupPrefix', 'terraformStateStorage', 'azureLocation', 'azureRegionShort', 'resourceSequence', 'serviceBus', 'projections'],
    inputs: [...JSON_INPUTS, '[1]'],
  },
  { jq: ['-r', '.secrets // [] | length'], tool: ['length', '@', 'secrets'], inputs: [...JSON_INPUTS, '{"secrets":"abc"}', '{"secrets":true}'] },
  {
    jq: ['-r', '[.searchResult[].packages[].version] | .[-5:][]'],
    tool: ['each', '-', 'searchResult[0].packages', '--field', 'version', '--last', '5'],
    inputs: [
      JSON.stringify({ searchResult: [{ packages: ['1', '2', '3', '4', '5', '6'].map((version) => ({ version })) }] }),
      JSON.stringify({ searchResult: [{ packages: [{ version: '5.5.0' }] }] }),
      JSON.stringify({ searchResult: [{ packages: [] }] }),
      '{"problems":[]}',
      'error: sin red',
      '',
    ],
    stdin: true,
  },
]

describe('paridad con jq', { skip: NO_JQ }, () => {
  let work = ''

  before(() => {
    work = mkdtempSync(join(tmpdir(), 'mefisto-json-paridad-'))
  })

  after(() => {
    rmSync(work, { recursive: true, force: true })
  })

  function outcome(result: { status: number | null; stdout: string }): { ok: boolean; stdout: string } {
    return { ok: result.status === 0, stdout: result.stdout }
  }

  for (const [index, parity] of PARITY.entries()) {
    test(`jq ${parity.jq.join(' ')}`, () => {
      for (const [position, input] of parity.inputs.entries()) {
        const file = join(work, `caso-${index}-${position}.json`)
        if (input !== null) writeFileSync(file, input)
        const stdin = parity.stdin === true ? (input ?? '') : ''
        const jq = spawnSync('jq', parity.stdin === true ? parity.jq : [...parity.jq, file], { input: stdin, encoding: 'utf8' })
        const tool = spawnTool(SCRIPT, parity.tool.map((argument) => (argument === '@' ? file : argument)), stdin)
        assert.deepEqual(outcome(tool), outcome(jq), `entrada: ${input ?? '(archivo ausente)'}`)
      }
    })
  }

  test("jq --arg s <texto> '.tenancy = ((.tenancy // {}) + {strategy: $s})'", () => {
    const inputs = [...DOCUMENTS, '{"tenancy":{"strategy":"mono-tenant-transitorio","z":["a"]},"despues":{"k":[]}}', '{"tenancy":false}', '{"tenancy":"x"}', '{"tenancy":[]}', '[1]', '"x"', '{"a":']
    for (const [position, input] of inputs.entries()) {
      for (const text of ['multi-tenant-header', 'con "comillas" y \\ barra']) {
        const file = join(work, `set-${position}.json`)
        writeFileSync(file, input)
        const jq = spawnSync('jq', ['--arg', 's', text, '.tenancy = ((.tenancy // {}) + {strategy: $s})', file], { encoding: 'utf8' })
        const tool = spawnTool(SCRIPT, ['set', file, 'tenancy.strategy', text])
        assert.equal(tool.status === 0, jq.status === 0, `entrada: ${input}`)
        assert.equal(readFileSync(file, 'utf8'), jq.status === 0 ? jq.stdout : input, `entrada: ${input}`)
      }
    }
  })

  test('jq -R . | jq -s -c .', () => {
    for (const input of ['https://a.test\nhttps://b.test\n', 'una sola\n', 'sin salto final', '\n', '', 'a\n\nb\n', 'con "comillas", \\barra y tab\taqui\n']) {
      const lines = spawnSync('jq', ['-R', '.'], { input, encoding: 'utf8' })
      const jq = spawnSync('jq', ['-s', '-c', '.'], { input: lines.stdout, encoding: 'utf8' })
      assert.deepEqual(outcome(spawnTool(SCRIPT, ['from-lines'], input)), outcome(jq), JSON.stringify(input))
    }
  })

  test('el dominio canonico de purge-store: jq select(ascii_downcase | gsub) | head -1', () => {
    const file = join(work, 'dominios.json')
    writeFileSync(file, JSON.stringify(CONFIG))
    const before = `jq -r --arg flat "$1" '.domainLabels[]? | select((ascii_downcase | gsub("-";"")) == $flat)' "$2" 2>/dev/null | head -1`
    const now = `node "$3" each "$2" domainLabels --or-empty 2>/dev/null | awk -v flat="$1" '{ label = tolower($0); gsub(/-/, "", label); if (label == flat) { print; exit } }'`
    for (const flat of ['controlhoras', 'nomina', 'turnos', 'noexiste', '']) {
      const [old, current] = [before, now].map((script) => spawnSync('bash', ['-c', script, '_', flat, file, SCRIPT], { encoding: 'utf8' }).stdout)
      assert.equal(current, old, flat)
    }
  })

  test('el catalogo grande de mcp-scaffolder: jq -n range(1;61)', () => {
    const jq = spawnSync(
      'jq',
      ['-n', '[range(1;61) | {id: ("elem-" + (. | tostring)), nombre: ("Elemento de ejemplo " + (. | tostring)), detalle: null}]'],
      { encoding: 'utf8' },
    )
    const loop = [
      'echo "["',
      'for i in $(seq 1 59); do',
      `    printf '  { "id": "elem-%s", "nombre": "Elemento de ejemplo %s", "detalle": null },\\n' "$i" "$i"`,
      'done',
      `echo '  { "id": "elem-60", "nombre": "Elemento de ejemplo 60", "detalle": null }'`,
      'echo "]"',
    ].join('\n')
    const bash = spawnSync('bash', ['-c', loop], { encoding: 'utf8' })
    assert.deepEqual(JSON.parse(bash.stdout), JSON.parse(jq.stdout))
  })
})
