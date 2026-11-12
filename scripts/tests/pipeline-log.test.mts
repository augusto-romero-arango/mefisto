import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { COLOR, capture } from '../lib/cli.mts'
import { PipelineAbort } from '../lib/pipeline/pipeline-exit.mts'
import {
  ASCII_GLYPHS,
  appendText,
  createAbort,
  createPipelineLog,
  lastLines,
  loggedThrough,
  runLogged,
  stripAnsi,
  tailLogForAbort,
} from '../lib/pipeline/pipeline-log.mts'
import { NO_BASH } from './pipeline-agents-parity.mts'

const work = mkdtempSync(join(tmpdir(), 'mefisto pipeline log '))
after(() => rmSync(work, { recursive: true, force: true }))

const NOW = new Date(2026, 4, 6, 7, 8, 9)
let counter = 0
function logFile(): string {
  counter++
  return join(work, `pipeline-${counter}.log`)
}

function screen(): { text: string; out: (text: string) => void } {
  const sink = { text: '', out: (text: string): void => void (sink.text += text) }
  return sink
}

describe('createPipelineLog', () => {
  test('cada mensaje va a pantalla con color y al archivo sin color', () => {
    const file = logFile()
    const sink = screen()
    const log = createPipelineLog({ logFile: () => file, out: sink.out, now: () => NOW })
    log.log('descargando')
    log.success('listo')
    log.warn('cuidado')
    log.header('Stage 1')
    assert.equal(
      sink.text,
      [
        `${COLOR.blue}[07:08:09]${COLOR.reset} descargando`,
        `${COLOR.green}${COLOR.bold}v${COLOR.reset} listo`,
        `${COLOR.yellow}!${COLOR.reset} cuidado`,
        `\n${COLOR.cyan}${COLOR.bold}-- Stage 1 --${COLOR.reset}`,
        '',
      ].join('\n'),
    )
    assert.equal(readFileSync(file, 'utf8'), '[07:08:09] descargando\nv listo\n! cuidado\n\n-- Stage 1 --\n')
  })

  test('las marcas son un parametro: otro pipeline usa las suyas', () => {
    const file = logFile()
    const sink = screen()
    const log = createPipelineLog({
      logFile: () => file,
      out: sink.out,
      glyphs: { success: 'OK', warn: 'WARN', error: 'ERR', rule: '==' },
    })
    log.success('a')
    log.warn('b')
    log.header('c')
    assert.equal(stripAnsi(sink.text), 'OK a\nWARN b\n\n== c ==\n')
  })

  test('la linea del archivo es un parametro: un pipeline puede anotar con sus propias etiquetas', () => {
    const file = logFile()
    const sink = screen()
    const log = createPipelineLog({
      logFile: () => file,
      out: sink.out,
      now: () => NOW,
      fileLine: (kind, message, clock) => (kind === 'log' ? `[${clock}] ${message}` : `${kind.toUpperCase()} ${message}`),
    })
    log.log('a')
    log.success('b')
    log.header('c')
    assert.equal(readFileSync(file, 'utf8'), '[07:08:09] a\nSUCCESS b\nHEADER c\n')
    assert.equal(stripAnsi(sink.text), '[07:08:09] a\nv b\n\n-- c --\n')
  })

  test('un mensaje con barras invertidas se imprime literal', () => {
    const file = logFile()
    const sink = screen()
    createPipelineLog({ logFile: () => file, out: sink.out, now: () => NOW }).log('C:\\repo\\nuevo\\tabla')
    assert.equal(stripAnsi(sink.text), '[07:08:09] C:\\repo\\nuevo\\tabla\n')
    assert.equal(readFileSync(file, 'utf8'), '[07:08:09] C:\\repo\\nuevo\\tabla\n')
  })

  test('sigue al archivo vigente y no falla si no puede escribirlo', () => {
    let file = join(work, 'no-existe', 'pipeline.log')
    const sink = screen()
    const log = createPipelineLog({ logFile: () => file, out: sink.out, now: () => NOW })
    log.log('sin archivo')
    assert.equal(stripAnsi(sink.text), '[07:08:09] sin archivo\n')
    file = logFile()
    log.log('con archivo')
    log.append('crudo\n')
    log.print('solo pantalla\n')
    assert.equal(readFileSync(file, 'utf8'), '[07:08:09] con archivo\ncrudo\n')
    assert.equal(log.logFile(), file)
    assert.ok(sink.text.endsWith('solo pantalla\n'))
  })
})

describe('lastLines y tailLogForAbort', () => {
  test('lastLines no cuenta el salto final como linea', () => {
    assert.equal(lastLines('a\nb\nc\n', 2), 'b\nc')
    assert.equal(lastLines('a\nb\nc', 2), 'b\nc')
    assert.equal(lastLines('a\n', 20), 'a')
    assert.equal(lastLines('\n', 20), '')
  })

  test('un log ausente o vacio no aporta nada', () => {
    assert.equal(tailLogForAbort(join(work, 'ausente.log'), 20), '')
    const file = logFile()
    writeFileSync(file, '')
    assert.equal(tailLogForAbort(file, 20), '')
  })

  test('devuelve las ultimas lineas sin color bajo su encabezado', () => {
    const file = logFile()
    writeFileSync(file, `${Array.from({ length: 30 }, (_, index) => `linea ${index + 1}`).join('\n')}\n${COLOR.red}fatal: sin red${COLOR.reset}\n`)
    const tail = tailLogForAbort(file, 3)
    assert.equal(tail, `${COLOR.yellow}Ultimas 3 lineas del log:${COLOR.reset}\nlinea 29\nlinea 30\nfatal: sin red`)
  })

  test('un log mas corto que el pedido sale entero', () => {
    const file = logFile()
    writeFileSync(file, 'a\nb\nc\n')
    assert.equal(stripAnsi(tailLogForAbort(file, 20)), 'Ultimas 20 lineas del log:\na\nb\nc')
  })

  test('paridad con tail y sed de los pipelines bash', { skip: NO_BASH }, () => {
    for (const content of ['a\nb\nc\n', 'una sola', `x\n\n${COLOR.red}rojo${COLOR.reset}\n\n\n`, `${'l\n'.repeat(40)}fin`]) {
      const file = logFile()
      writeFileSync(file, content)
      const bash = capture('bash', ['-c', `t="$(tail -n 5 "$1" | sed 's/\\x1b\\[[0-9;]*m//g')"; [ -n "$t" ] && printf '%s' "$t"`, 'bash', file])
      const tail = tailLogForAbort(file, 5)
      assert.equal(tail.length === 0 ? '' : tail.slice(tail.indexOf('\n') + 1), bash.stdout, JSON.stringify(content))
    }
  })
})

describe('createAbort', () => {
  function setup(overrides: { tailLines?: number; worktree?: string } = {}) {
    const file = logFile()
    const sink = screen()
    const order: string[] = []
    const log = createPipelineLog({ logFile: () => file, out: sink.out, now: () => NOW })
    const abort = createAbort({
      log,
      tailLines: overrides.tailLines ?? 20,
      worktree: () => overrides.worktree ?? '',
      onStart: (message, state) => void order.push(`start:${message}:${state}`),
      record: (message, state) => void order.push(`record:${message}:${state}:${readFileSync(file, 'utf8').includes('ERROR: ')}`),
    })
    return { file, sink, order, log, abort }
  }

  test('imprime el error, el log y su cola; anota el error en el log con color y lanza PipelineAbort', () => {
    const { file, sink, order, abort } = setup()
    writeFileSync(file, 'fatal: unable to access remote\n')
    assert.throws(() => abort('No se pudo hacer fetch'), PipelineAbort)
    assert.equal(
      sink.text,
      [
        '',
        `${COLOR.red}${COLOR.bold}x ERROR: No se pudo hacer fetch${COLOR.reset}`,
        `${COLOR.yellow}Revisa el log: ${file}${COLOR.reset}`,
        `${COLOR.yellow}Ultimas 20 lineas del log:${COLOR.reset}`,
        'fatal: unable to access remote',
        '',
      ].join('\n'),
    )
    assert.equal(readFileSync(file, 'utf8'), `fatal: unable to access remote\n\n${COLOR.red}${COLOR.bold}x ERROR: No se pudo hacer fetch${COLOR.reset}\n`)
    assert.deepEqual(order, ['start:No se pudo hacer fetch:failed', 'record:No se pudo hacer fetch:failed:true'])
  })

  test('la cola se lee antes de anotar el error: no repite el mensaje recien impreso', () => {
    const { file, sink, abort } = setup()
    writeFileSync(file, 'contexto real\n')
    assert.throws(() => abort('mensaje-unico'), PipelineAbort)
    const tail = sink.text.slice(sink.text.indexOf('Ultimas 20 lineas'))
    assert.equal(tail.includes('mensaje-unico'), false)
    assert.ok(tail.includes('contexto real'))
  })

  test('sin log previo no hay cola, y el log nace con el error', () => {
    const { file, sink, abort } = setup()
    assert.throws(() => abort('Falta el numero de issue'), PipelineAbort)
    assert.equal(sink.text.includes('Ultimas'), false)
    assert.ok(readFileSync(file, 'utf8').includes('x ERROR: Falta el numero de issue'))
  })

  test('con tailLines en 0 no reemite el log', () => {
    const { file, sink, abort } = setup({ tailLines: 0 })
    writeFileSync(file, 'algo\n')
    assert.throws(() => abort('fallo'), PipelineAbort)
    assert.equal(sink.text.includes('Ultimas'), false)
  })

  test('dice donde queda el worktree solo si existe', () => {
    const worktree = join(work, 'wt')
    mkdirSync(worktree)
    const present = setup({ worktree })
    assert.throws(() => present.abort('fallo'), PipelineAbort)
    assert.ok(present.sink.text.includes(`${COLOR.yellow}El worktree queda en: ${worktree}${COLOR.reset}\n${COLOR.yellow}Para inspeccionar: cd ${worktree}${COLOR.reset}\n`))
    const missing = setup({ worktree: join(work, 'no-existe') })
    assert.throws(() => missing.abort('fallo'), PipelineAbort)
    assert.equal(missing.sink.text.includes('El worktree queda en'), false)
  })

  test('el estado final es un parametro y el destino de la pantalla tambien', () => {
    const file = logFile()
    const sink = screen()
    const stderr = screen()
    const states: string[] = []
    const log = createPipelineLog({ logFile: () => file, out: sink.out, glyphs: { ...ASCII_GLYPHS, error: 'ERR' } })
    const abort = createAbort({ log, worktree: () => '', record: (_message, state) => void states.push(state), stream: stderr.out })
    assert.throws(() => abort('issue incompleto', 'blocked'), PipelineAbort)
    assert.deepEqual(states, ['blocked'])
    assert.equal(sink.text, '')
    assert.ok(stripAnsi(stderr.text).startsWith('\nERR ERROR: issue incompleto\n'))
  })

  test('sin linea en blanco ni sugerencia de inspeccion en pantalla, el log conserva el error igual', () => {
    const file = logFile()
    const stderr = screen()
    const worktree = join(work, 'wt-compacto')
    mkdirSync(worktree)
    const log = createPipelineLog({ logFile: () => file, out: () => {} })
    const abort = createAbort({ log, worktree: () => worktree, stream: stderr.out, leadingBlankLine: false, inspectHint: false })
    assert.throws(() => abort('fallo'), PipelineAbort)
    assert.equal(
      stripAnsi(stderr.text),
      `x ERROR: fallo\nRevisa el log: ${file}\nEl worktree queda en: ${worktree}\n`,
    )
    assert.equal(stripAnsi(readFileSync(file, 'utf8')), '\nx ERROR: fallo\n')
  })

  test('el texto del error es un parametro y sin detalles no se nombra el log, su cola ni el worktree', () => {
    const file = logFile()
    writeFileSync(file, 'contexto\n')
    const sink = screen()
    const stderr = screen()
    const worktree = join(work, 'wt-sin-detalles')
    mkdirSync(worktree)
    const recorded: string[] = []
    const log = createPipelineLog({ logFile: () => file, out: sink.out })
    const abort = createAbort({
      log,
      tailLines: 20,
      worktree: () => worktree,
      stream: stderr.out,
      render: (message) => ({ stream: `\nx ${message}\n`, file: `ABORT ${message}\n` }),
      details: false,
      record: (message) => void recorded.push(message),
    })
    assert.throws(() => abort('dominio invalido'), PipelineAbort)
    assert.equal(stderr.text, '\nx dominio invalido\n')
    assert.equal(sink.text, '')
    assert.equal(readFileSync(file, 'utf8'), 'contexto\nABORT dominio invalido\n')
    assert.deepEqual(recorded, ['dominio invalido'])
  })

  test('con render y detalles, la ruta del log sigue al error propio', () => {
    const file = logFile()
    const sink = screen()
    const log = createPipelineLog({ logFile: () => file, out: sink.out })
    const abort = createAbort({ log, worktree: () => '', render: (message) => ({ stream: `<${message}>\n`, file: '' }) })
    assert.throws(() => abort('m'), PipelineAbort)
    assert.ok(sink.text.startsWith('<m>\n'))
    assert.match(stripAnsi(sink.text), /Revisa el log: /)
  })

  test('las opciones de los dos pipelines se combinan: render gana a leadingBlankLine, y sin detalles no hay worktree', () => {
    const file = logFile()
    const stderr = screen()
    const worktree = join(work, 'wt-combinado')
    mkdirSync(worktree)
    const log = createPipelineLog({ logFile: () => file, out: () => {} })
    const rendered = createAbort({
      log,
      worktree: () => worktree,
      stream: stderr.out,
      leadingBlankLine: false,
      inspectHint: false,
      render: (message) => ({ stream: `<${message}>\n`, file: `[${message}]\n` }),
    })
    assert.throws(() => rendered('a'), PipelineAbort)
    assert.equal(stripAnsi(stderr.text), `<a>\nRevisa el log: ${file}\nEl worktree queda en: ${worktree}\n`)
    assert.equal(readFileSync(file, 'utf8'), '[a]\n')

    const quiet = screen()
    const compact = createAbort({ log, worktree: () => worktree, stream: quiet.out, leadingBlankLine: false, details: false })
    assert.throws(() => compact('b'), PipelineAbort)
    assert.equal(stripAnsi(quiet.text), 'x ERROR: b\n')
  })
})

describe('runLogged y loggedThrough', () => {
  test('runLogged anexa la salida estandar y la de error del proceso y devuelve su codigo', () => {
    const file = logFile()
    writeFileSync(file, 'antes\n')
    const status = runLogged(process.execPath, ['-e', 'process.stdout.write("salida\\n"); process.stderr.write("error\\n"); process.exit(3)'], file)
    assert.equal(status, 3)
    const content = readFileSync(file, 'utf8')
    assert.ok(content.startsWith('antes\n'))
    assert.ok(content.includes('salida\n') && content.includes('error\n'))
  })

  test('runLogged honra cwd y env', () => {
    const file = logFile()
    const status = runLogged(process.execPath, ['-e', 'process.stdout.write(process.env.PRUEBA + " " + process.cwd())'], file, {
      cwd: work,
      env: { ...process.env, PRUEBA: 'valor' },
    })
    assert.equal(status, 0)
    assert.match(readFileSync(file, 'utf8'), /^valor .*mefisto pipeline log /)
  })

  test('runLogged sin poder abrir el log no corre nada y devuelve 1', () => {
    assert.equal(runLogged(process.execPath, ['-e', ''], join(work, 'no-existe', 'x.log')), 1)
  })

  test('loggedThrough anexa lo capturado y pasa las opciones', () => {
    const file = logFile()
    const seen: unknown[] = []
    const logged = loggedThrough((command, args, options) => {
      seen.push([command, args, options])
      return { status: 2, stdout: 'out\n', stderr: 'err\n' }
    })
    assert.equal(logged('git', ['fetch'], file, { cwd: work }), 2)
    assert.equal(readFileSync(file, 'utf8'), 'out\nerr\n')
    assert.deepEqual(seen, [['git', ['fetch'], { cwd: work }]])
  })

  test('appendText avisa si no pudo escribir', () => {
    assert.equal(appendText(join(work, 'no-existe', 'x.log'), 'a'), false)
    assert.equal(appendText(logFile(), 'a'), true)
  })
})
