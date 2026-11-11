import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { USAGE, boundedContextDomains, migrateDirectives } from '../onboard-migrate-directives.mts'
import {
  CANONICAL_CONFIG,
  PLUGIN_MANIFEST,
  configJson,
  initRepo,
  pathIn,
  sink,
  writeIn,
} from './consumer-sandbox.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMMAND = join(HERE, '..', '..', 'commands', 'onboard.md')
const COMPLETE_AGENTS = [
  '## Tokens del harness',
  '**RootNamespace**: A',
  '**SolutionFile**: A',
  '**ProjectDisplayName**: A',
  '**BoundedContext**: A',
  '**BoundedContextDomains**: A',
  '## Verificación de fuentes',
  '',
].join('\n')
// Sin permisos Unix ni enlaces sin privilegio en Windows; root atraviesa los permisos.
const NO_PERMISSIONS = process.platform === 'win32' || process.getuid?.() === 0
const NO_LINKS = process.platform === 'win32'

let work = ''
let sequence = 0

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto directivas '))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

function makeRepo(files: Record<string, string> = {}): string {
  return initRepo(join(work, `repo-${++sequence}`), { [CANONICAL_CONFIG]: configJson(), ...files })
}

interface Run {
  status: number
  out: string[]
  err: string[]
}

function run(repo: string, argv: string[], env: NodeJS.ProcessEnv = { MEFISTO_RUNTIME: 'claude' }): Run {
  const output = sink()
  const status = migrateDirectives(argv, {
    cwd: repo,
    env,
    scriptDir: join(HERE, '..'),
    hasCommand: () => false,
    ...output.io,
  })
  return { status, out: output.out, err: output.err }
}

function read(repo: string, name: string): string {
  return readFileSync(join(repo, name), 'utf8')
}

/** Nombres de la raiz del repo, para comprobar que no quedo ningun temporal. */
function rootEntries(repo: string): string[] {
  return readdirSync(repo).sort()
}

describe('[M-1] preview y aplicacion explicita', () => {
  test('preview no escribe', () => {
    const repo = makeRepo()
    const result = run(repo, ['--preview'])
    assert.equal(result.status, 0)
    assert.deepEqual(result.out, [
      'Plan de migración de directivas:',
      `  - Crear AGENTS.md con las dos secciones contractuales y tokens derivados de ${pathIn(repo, CANONICAL_CONFIG)}.`,
      '  - Crear CLAUDE.md con el puente mínimo @AGENTS.md.',
      'Previsualización: no se escribió ningún archivo. Usa --apply solo tras la confirmación explícita de /onboard.',
    ])
    assert.deepEqual(rootEntries(repo), ['.git', '.mefisto'])
  })

  test('sin modo previsualiza', () => {
    const repo = makeRepo()
    assert.match(run(repo, []).out.at(-1) ?? '', /^Previsualización: no se escribió/)
    assert.equal(existsSync(join(repo, 'AGENTS.md')), false)
  })

  test('apply greenfield deriva los cinco tokens y crea el puente', () => {
    const repo = makeRepo()
    const result = run(repo, ['--apply'])
    assert.equal(result.status, 0)
    assert.equal(result.out.at(-1), 'OK: migración conservadora aplicada.')
    assert.equal(
      read(repo, 'AGENTS.md'),
      [
        '### Tokens del harness',
        '',
        '- **RootNamespace**: Empresa.Proyecto',
        '- **SolutionFile**: Proyecto.slnx',
        '- **ProjectDisplayName**: Proyecto',
        '- **BoundedContext**: Principal',
        '- **BoundedContextDomains**: ventas, cobros',
        '',
        '### Verificación de fuentes (obligatorio para agentes)',
        '',
        'Antes de proponer o aplicar un ajuste técnico, verifica el enfoque contra la',
        '**documentación oficial y vigente** de las tecnologías del stack (.NET, Azure',
        'Functions, Marten, Wolverine, Azure Service Bus, Terraform, …). No te apoyes en',
        'conocimiento memorizado: puede estar desactualizado. Al afirmar una best practice',
        'o recomendación, **cita la fuente** (URL oficial, versión del paquete, ADR). Si un',
        'dato no pudiste verificarlo contra la fuente, decláralo como *no verificado* en',
        'tu propuesta en vez de darlo por cierto.',
        '',
      ].join('\n'),
    )
    assert.equal(read(repo, 'CLAUDE.md'), '@AGENTS.md\n')
    assert.deepEqual(rootEntries(repo), ['.git', '.mefisto', 'AGENTS.md', 'CLAUDE.md'])
  })

  test('el comando condiciona la aplicacion al diagnostico y a la confirmacion explicita', () => {
    const command = readFileSync(COMMAND, 'utf8')
    for (const expected of [
      'Ofrece este paso **solo** cuando el diagnóstico reportó que falta `AGENTS.md` o, bajo el adaptador Claude, el puente exacto',
      'Sin un `si` explícito, no ejecutes ninguna escritura',
      '/scripts/onboard-migrate-directives.sh" --apply',
    ]) {
      assert.ok(command.includes(expected), expected)
    }
  })
})

describe('[M-2] idempotencia y preservacion', () => {
  test('sobre el contrato completo no cambia nada', () => {
    const repo = makeRepo()
    run(repo, ['--apply'])
    const before = [read(repo, 'AGENTS.md'), read(repo, 'CLAUDE.md')]
    const result = run(repo, ['--apply'])
    assert.equal(result.status, 0)
    assert.deepEqual(result.out, [
      'Plan de migración de directivas:',
      '  - Conservar AGENTS.md completo sin cambios.',
      '  - Conservar CLAUDE.md: ya contiene el puente exacto.',
      'OK: migración conservadora aplicada.',
    ])
    assert.deepEqual([read(repo, 'AGENTS.md'), read(repo, 'CLAUDE.md')], before)
  })

  test('un AGENTS.md completo se conserva y un CLAUDE.md propio recibe el import', () => {
    const repo = makeRepo({ 'AGENTS.md': COMPLETE_AGENTS, 'CLAUDE.md': '# Directiva propia\nNo perder.\n' })
    const result = run(repo, ['--apply'])
    assert.equal(result.status, 0)
    assert.ok(
      result.out.includes('  - Añadir una línea @AGENTS.md a CLAUDE.md, preservando todo su contenido.'),
    )
    assert.equal(read(repo, 'AGENTS.md'), COMPLETE_AGENTS)
    assert.equal(read(repo, 'CLAUDE.md'), '# Directiva propia\nNo perder.\n\n@AGENTS.md\n')
  })

  test('un CLAUDE.md sin salto final o vacio recibe el import en su propia linea', () => {
    const unterminated = makeRepo({ 'AGENTS.md': COMPLETE_AGENTS, 'CLAUDE.md': 'sin salto' })
    run(unterminated, ['--apply'])
    assert.equal(read(unterminated, 'CLAUDE.md'), 'sin salto\n@AGENTS.md\n')
    const empty = makeRepo({ 'AGENTS.md': COMPLETE_AGENTS, 'CLAUDE.md': '' })
    run(empty, ['--apply'])
    assert.equal(read(empty, 'CLAUDE.md'), '@AGENTS.md\n')
  })
})

describe('[M-3] rechazos sin escrituras parciales', () => {
  test('un AGENTS.md incompleto aborta, en apply y en preview, con la instruccion manual', () => {
    const repo = makeRepo({ 'AGENTS.md': '## Tokens del harness\n' })
    for (const mode of ['--apply', '--preview']) {
      const result = run(repo, [mode])
      assert.equal(result.status, 1)
      assert.deepEqual(result.err, [
        [
          'ERROR: AGENTS.md existe pero esta incompleto; no se fusiona por heurística.',
          '       Complétalo manualmente con "Tokens del harness" y "Verificación de fuentes", y reintenta.',
        ].join('\n'),
      ])
      assert.deepEqual(result.out, [])
      assert.equal(read(repo, 'AGENTS.md'), '## Tokens del harness\n')
      assert.equal(existsSync(join(repo, 'CLAUDE.md')), false)
    }
  })

  test('un config invalido aborta antes de escribir', () => {
    const repo = makeRepo({ [CANONICAL_CONFIG]: '{' })
    const result = run(repo, ['--apply'])
    assert.equal(result.status, 1)
    assert.match(
      result.err[0] ?? '',
      /\nERROR: no se modifico ninguna directiva porque el config efectivo no es valido\.$/,
    )
    assert.deepEqual(rootEntries(repo), ['.git', '.mefisto'])
  })

  test('un CLAUDE.md legacy se conserva, recibe el import y avisa la limpieza manual', () => {
    const legacy = '## Tokens del harness\nlegacy\n## Verificación de fuentes\n'
    const repo = makeRepo({ 'CLAUDE.md': legacy })
    const result = run(repo, ['--apply'])
    assert.equal(result.status, 0)
    assert.equal(read(repo, 'CLAUDE.md'), `${legacy}\n@AGENTS.md\n`)
    assert.ok(
      result.out.includes(
        '  - AVISO: CLAUDE.md conserva secciones contractuales legacy duplicadas; retíralas manualmente.',
      ),
    )
    assert.equal(
      result.out.at(-1),
      'AVISO: las secciones contractuales legacy de CLAUDE.md siguen allí y deben retirarse manualmente.',
    )
  })

  test('un enlace simbolico aborta sin escapar del consumidor', { skip: NO_LINKS }, () => {
    const repo = makeRepo()
    const external = writeIn(work, `externo-${sequence}`, 'fuera\n')
    symlinkSync(external, join(repo, 'AGENTS.md'))
    const result = run(repo, ['--apply'])
    assert.equal(result.status, 1)
    assert.deepEqual(result.err, [
      [
        'ERROR: AGENTS.md es un enlace simbólico; no se siguen destinos fuera del consumidor.',
        '       Reemplázalo conscientemente por un archivo regular y reintenta; no se modificó nada.',
      ].join('\n'),
    ])
    assert.equal(readFileSync(external, 'utf8'), 'fuera\n')
    assert.equal(existsSync(join(repo, 'CLAUDE.md')), false)
  })

  test('un destino que no es un archivo regular aborta', () => {
    const repo = makeRepo({ 'CLAUDE.md/dentro': '' })
    const result = run(repo, ['--apply'])
    assert.equal(result.status, 1)
    assert.deepEqual(result.err, [
      'ERROR: CLAUDE.md existe pero no es un archivo regular; no se modificó nada.',
    ])
    assert.equal(existsSync(join(repo, 'AGENTS.md')), false)
  })

  test('un CLAUDE.md no escribible aborta antes de crear AGENTS.md', { skip: NO_PERMISSIONS }, () => {
    const repo = makeRepo({ 'CLAUDE.md': 'contenido propio\n' })
    chmodSync(join(repo, 'CLAUDE.md'), 0o444)
    const result = run(repo, ['--apply'])
    chmodSync(join(repo, 'CLAUDE.md'), 0o644)
    assert.equal(result.status, 1)
    assert.deepEqual(result.err, ['ERROR: CLAUDE.md no es escribible; no se modifico nada.'])
    assert.equal(existsSync(join(repo, 'AGENTS.md')), false)
    assert.equal(read(repo, 'CLAUDE.md'), 'contenido propio\n')
  })

  test('una raiz no escribible aborta sin escrituras parciales', { skip: NO_PERMISSIONS }, () => {
    const repo = makeRepo()
    chmodSync(repo, 0o555)
    const result = run(repo, ['--apply'])
    chmodSync(repo, 0o755)
    assert.equal(result.status, 1)
    assert.deepEqual(result.err, ['ERROR: no hay permiso para crear AGENTS.md; no se modifico nada.'])
    assert.deepEqual(rootEntries(repo), ['.git', '.mefisto'])
  })
})

describe('runtime y puente', () => {
  test('fuera de claude el puente se omite y --with-claude-bridge lo crea', () => {
    const repo = makeRepo()
    const skipped = run(repo, ['--apply'], { MEFISTO_RUNTIME: 'otro' })
    assert.equal(skipped.status, 0)
    assert.ok(
      skipped.out.includes(
        '  - Omitido (opcional): puente CLAUDE.md; solo lo requiere Claude Code. Usa --with-claude-bridge para crearlo o completarlo.',
      ),
    )
    assert.equal(existsSync(join(repo, 'CLAUDE.md')), false)

    const bridged = run(repo, ['--apply', '--with-claude-bridge'], { MEFISTO_RUNTIME: 'otro' })
    assert.equal(bridged.status, 0)
    assert.equal(read(repo, 'CLAUDE.md'), '@AGENTS.md\n')
  })

  test('sin MEFISTO_RUNTIME ni runtime detectable trata el repo como claude', () => {
    const repo = makeRepo()
    const result = run(repo, ['--preview'], {})
    assert.ok(result.out.includes('  - Crear CLAUDE.md con el puente mínimo @AGENTS.md.'))
  })
})

describe('argumentos y guard', () => {
  test('un argumento desconocido o un modo repetido terminan en 2 con el uso', () => {
    const repo = makeRepo()
    for (const argv of [['--zzz'], ['--preview', '--apply'], ['--apply', '--apply']]) {
      const result = run(repo, argv)
      assert.equal(result.status, 2)
      assert.deepEqual(result.err, [USAGE])
    }
    assert.deepEqual(rootEntries(repo), ['.git', '.mefisto'])
  })

  test('en el repo de Mefisto se niega', () => {
    const mefisto = initRepo(join(work, 'mefisto'), {
      [PLUGIN_MANIFEST]: '{}',
      [CANONICAL_CONFIG]: configJson(),
    })
    const result = run(mefisto, ['--preview'])
    assert.equal(result.status, 1)
    assert.deepEqual(result.err, [
      [
        'ERROR: /onboard no aplica al repo de Mefisto.',
        '       scripts/onboard-migrate-directives.sh es del plugin publicado y solo aplica al consumidor.',
      ].join('\n'),
    ])
  })
})

describe('boundedContextDomains', () => {
  function domainsOf(domains: unknown): string | null {
    const path = join(work, `dominios-${++sequence}.json`)
    writeFileSync(path, JSON.stringify({ boundedContext: { name: 'X', domains } }))
    return boundedContextDomains(path)
  }

  test('une los dominios con coma y espacio, como join de jq', () => {
    assert.equal(domainsOf(['ventas', 'cobros']), 'ventas, cobros')
    assert.equal(domainsOf(['a', 7, null, true]), 'a, 7, , true')
    assert.equal(domainsOf({ k: 'a', j: 'b' }), 'a, b')
    assert.equal(domainsOf([]), '')
  })

  test('devuelve null donde jq falla', () => {
    for (const domains of ['a', 7, null, [['a']], [{ k: 1 }]]) assert.equal(domainsOf(domains), null)
  })
})
