import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  CliError,
  capture,
  commandExists,
  escapeBatchArgument,
  gitOutput,
  repoRoot,
  resolveCommand,
  spawnTarget,
} from '../lib/cli.mts'

let work = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto cli '))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('procesos', () => {
  test('capture devuelve salida y codigo sin pasar por un shell', () => {
    const ok = capture(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'a b; echo c'])
    assert.deepEqual(ok, { status: 0, stdout: 'a b; echo c', stderr: '' })
    const failed = capture(process.execPath, ['-e', 'console.error("mal"); process.exit(3)'])
    assert.equal(failed.status, 3)
    assert.match(failed.stderr, /mal/)
  })

  test('capture entrega stdin y respeta cwd', () => {
    const script = 'process.stdin.on("data", (d) => process.stdout.write(process.cwd() + "|" + d))'
    const result = capture(process.execPath, ['-e', script], { cwd: work, input: 'hola' })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /\|hola$/)
  })

  test('un programa que no existe devuelve status null', () => {
    assert.equal(capture('mefisto-no-existe-este-programa', []).status, null)
  })

  test('commandExists encuentra programas del PATH', () => {
    assert.equal(commandExists('git'), true)
    assert.equal(commandExists('mefisto-no-existe-este-programa'), false)
    assert.equal(commandExists('git', { PATH: '' }), false)
  })
})

describe('resolucion de comandos', () => {
  test('resolveCommand devuelve el archivo del PATH o null', () => {
    assert.notEqual(resolveCommand('git'), null)
    assert.equal(resolveCommand('mefisto-no-existe-este-programa'), null)
    assert.equal(resolveCommand('git', { PATH: '' }), null)
  })

  test('en Windows prueba las extensiones de PATHEXT, tambien con la grafia Path', () => {
    const dir = join(work, 'bin pathext')
    mkdirSync(dir)
    writeFileSync(join(dir, 'herramienta.CMD'), '@echo off\r\n')
    const env = { Path: dir, PathExt: '.EXE;.CMD' }
    assert.equal(resolveCommand('herramienta', env, 'win32'), join(dir, 'herramienta.CMD'))
    assert.equal(resolveCommand('herramienta', env, 'linux'), null)
    assert.equal(resolveCommand(join(dir, 'herramienta'), env, 'win32'), join(dir, 'herramienta.CMD'))
  })

  test('un .cmd se lanza a traves de cmd.exe y un ejecutable real, directo', () => {
    const dir = join(work, 'bin target')
    mkdirSync(dir)
    writeFileSync(join(dir, 'az.CMD'), '@echo off\r\n')
    const env = { PATH: dir, PATHEXT: '.EXE;.CMD', ComSpec: 'C:\\Windows\\cmd.exe' }
    const target = spawnTarget('az', ['account', 'show'], env, 'win32')
    assert.equal(target.command, 'C:\\Windows\\cmd.exe')
    assert.equal(target.verbatim, true)
    assert.deepEqual(target.args.slice(0, 3), ['/d', '/s', '/c'])
    assert.match(target.args[3] ?? '', /az\.CMD.*account.*show/)
    assert.deepEqual(spawnTarget('az', ['x'], env, 'linux'), { command: 'az', args: ['x'], verbatim: false })
    assert.deepEqual(spawnTarget('no-existe', ['x'], env, 'win32'), {
      command: 'no-existe',
      args: ['x'],
      verbatim: false,
    })
  })

  test('escapeBatchArgument protege comillas, barras finales y metacaracteres', () => {
    assert.equal(escapeBatchArgument('abc'), '^^^"abc^^^"')
    assert.equal(escapeBatchArgument('a&b'), '^^^"a^^^&b^^^"')
    assert.equal(escapeBatchArgument('fin\\'), '^^^"fin\\\\^^^"')
    assert.equal(escapeBatchArgument('a"b'), '^^^"a\\^^^"b^^^"')
  })

  test(
    'un .cmd real recibe cada argumento intacto y devuelve su codigo de salida',
    { skip: process.platform === 'win32' ? false : 'solo hay cmd.exe en Windows' },
    () => {
      const dir = join(work, 'bin con espacios')
      mkdirSync(dir)
      writeFileSync(join(dir, 'eco.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))\n')
      writeFileSync(join(dir, 'eco.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0eco.mjs" %*\r\n`)
      writeFileSync(join(dir, 'falla.cmd'), '@echo off\r\nexit /b 3\r\n')
      const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` }
      const args = [
        'simple',
        'con espacio',
        'a&b',
        'a|b',
        'x>y<z',
        '(par)',
        'comilla"dentro',
        'barra\\',
        "[?name=='x'].id | [0]",
        '{id:id, tenant:tenantId}',
        'a^b',
        '',
      ]
      const result = capture('eco', args, { env })
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), args)
      assert.equal(capture('falla', [], { env }).status, 3)
    },
  )
})

describe('git', () => {
  test('repoRoot resuelve la raiz desde un subdirectorio y null fuera de un repo', () => {
    const repo = join(work, 'repo con espacios')
    const sub = join(repo, 'a', 'b')
    mkdirSync(sub, { recursive: true })
    execFileSync('git', ['init', '--quiet', repo])
    writeFileSync(join(sub, 'x.txt'), 'x')
    const root = repoRoot(sub)
    assert.notEqual(root, null)
    assert.equal(repoRoot(repo), root)
    assert.equal(gitOutput(['rev-parse', '--is-inside-work-tree'], sub), 'true')

    const outside = join(work, 'sin repo')
    mkdirSync(outside)
    const previous = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = work
    try {
      assert.equal(repoRoot(outside), null)
      assert.equal(gitOutput(['rev-parse', '--show-toplevel'], outside), null)
    } finally {
      if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = previous
    }
  })
})

describe('CliError', () => {
  test('lleva el mensaje y el codigo de salida', () => {
    const error = new CliError('ERROR: algo', 2)
    assert.equal(error.message, 'ERROR: algo')
    assert.equal(error.exitCode, 2)
    assert.equal(new CliError('x').exitCode, 1)
    assert.ok(error instanceof Error)
  })
})
