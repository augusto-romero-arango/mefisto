import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  countStopped,
  runWithWatchdog,
  shellExitCode,
  treeKillCommand,
  watchdogPollSeconds,
} from '../lib/mefisto-process.mts'
import type { WatchdogRun } from '../lib/mefisto-process.mts'

const POSIX_ONLY = process.platform === 'win32' ? 'Windows no tiene senales ni grupos de procesos POSIX' : false

let work = ''
let serial = 0

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto process '))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

/** Corre un programa de Node bajo el watchdog y devuelve tambien sus archivos. */
function watched(script: string, options: Partial<WatchdogRun> = {}) {
  const base = join(work, `run-${++serial}`)
  const run: WatchdogRun = {
    argv: [process.execPath, '-e', script],
    cwd: work,
    timeoutSeconds: 30,
    stdoutFile: `${base}.out`,
    stderrFile: `${base}.err`,
    eventsLog: `${base}.events`,
    label: 'writer',
    pollSeconds: 1,
    ...options,
  }
  const read = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '')
  return runWithWatchdog(run).then((result) => ({
    ...result,
    stdout: read(run.stdoutFile),
    stderr: read(run.stderrFile),
    events: read(run.eventsLog),
  }))
}

describe('funciones puras', () => {
  test('en Windows el arbol se mata con taskkill sobre el PID concreto; en POSIX, por grupo', () => {
    assert.deepEqual(treeKillCommand(4321, 'win32'), { command: 'taskkill', args: ['/PID', '4321', '/T', '/F'] })
    assert.equal(treeKillCommand(4321, 'linux'), null)
    assert.equal(treeKillCommand(4321, 'darwin'), null)
  })

  test('shellExitCode informa una muerte por senal como 128 mas su numero', () => {
    assert.equal(shellExitCode(0, null), 0)
    assert.equal(shellExitCode(7, null), 7)
    assert.equal(shellExitCode(null, 'SIGKILL'), 137)
    assert.equal(shellExitCode(null, 'SIGTERM'), 143)
    assert.equal(shellExitCode(null, null), 1)
  })

  test('la rebanada del watchdog nunca es cero ni un valor invalido', () => {
    assert.equal(watchdogPollSeconds(undefined), 5)
    assert.equal(watchdogPollSeconds(''), 5)
    assert.equal(watchdogPollSeconds('abc'), 5)
    assert.equal(watchdogPollSeconds('-1'), 5)
    assert.equal(watchdogPollSeconds('0'), 1)
    assert.equal(watchdogPollSeconds('3'), 3)
  })

  test('countStopped cuenta solo los procesos detenidos del grupo pedido', () => {
    const ps = ['  10   10 Ss', '  11   10 T', '  12   10 T+', '  13   99 T', '  14   10 R', '  15   10 t', ''].join('\n')
    assert.equal(countStopped(ps, 10), 3)
    assert.equal(countStopped(ps, 99), 1)
    assert.equal(countStopped(ps, 7), 0)
  })
})

describe('runWithWatchdog', () => {
  test('devuelve el codigo de salida y separa stdout de stderr', async () => {
    const ok = await watched('process.stdout.write("fuera"); process.stderr.write("error")')
    assert.deepEqual(
      { exitCode: ok.exitCode, timedOut: ok.timedOut, stdout: ok.stdout, stderr: ok.stderr, events: ok.events },
      { exitCode: 0, timedOut: false, stdout: 'fuera', stderr: 'error', events: '' },
    )
    assert.equal((await watched('process.exit(7)')).exitCode, 7)
  })

  test('el argv viaja intacto, sin shell, y el proceso corre en el cwd pedido', async () => {
    const run = await watched('process.stdout.write(JSON.stringify([process.argv[1], process.cwd()]))', {
      argv: [process.execPath, '-e', 'process.stdout.write(JSON.stringify([process.argv[1], process.cwd()]))', '$(echo x) `y` "z"; rm'],
    })
    const [arg, cwd] = JSON.parse(run.stdout) as [string, string]
    assert.equal(arg, '$(echo x) `y` "z"; rm')
    assert.equal(cwd.length > 0, true)
  })

  test('sin archivo de entrada el proceso ve la entrada cerrada; con el, lo lee byte a byte', async () => {
    const script =
      'const c=[];process.stdin.on("data",(d)=>c.push(d)).on("end",()=>process.stdout.write(process.stdin.isTTY ? "tty" : Buffer.concat(c).toString("hex")))'
    assert.equal((await watched(script)).stdout, '')
    const stdinFile = join(work, 'entrada.bin')
    const bytes = Buffer.from([0x00, 0xff, 0x0a, 0x0d, 0x24, 0x60])
    writeFileSync(stdinFile, bytes)
    assert.equal((await watched(script, { stdinFile })).stdout, bytes.toString('hex'))
  })

  test('un programa que no existe no arranca: codigo 127 y el motivo en stderr', async () => {
    const run = await watched('', { argv: ['mefisto-no-existe-este-programa'] })
    assert.equal(run.exitCode, 127)
    assert.equal(run.timedOut, false)
    assert.match(run.stderr, /no se pudo ejecutar 'mefisto-no-existe-este-programa'/)
  })

  test('al agotar el timeout mata al proceso, lo informa y deja la linea TIMEOUT', async () => {
    const started = Date.now()
    const run = await watched('process.stdout.write("vivo"); setTimeout(() => {}, 600000)', { timeoutSeconds: 1 })
    assert.equal(run.timedOut, true)
    assert.equal(run.exitCode, 137)
    assert.equal(run.stdout, 'vivo')
    assert.match(run.events, /^\[\d\d:\d\d:\d\d\] TIMEOUT: writer supero 1s\n$/)
    assert.equal(Date.now() - started >= 1000, true)
  })

  test('un proceso que termina solo no deja TIMEOUT ni cuenta como tal', async () => {
    const run = await watched('setTimeout(() => process.exit(3), 300)', { timeoutSeconds: 2 })
    assert.deepEqual({ exitCode: run.exitCode, timedOut: run.timedOut, events: run.events }, {
      exitCode: 3,
      timedOut: false,
      events: '',
    })
  })

  test('una solicitud de terminacion corta al proceso sin que sea un timeout', async () => {
    const run = await watched('setTimeout(() => {}, 600000)', { timeoutSeconds: 60, terminateRequested: () => true })
    assert.equal(run.timedOut, false)
    assert.equal(run.exitCode, process.platform === 'win32' ? 137 : 143)
    assert.match(run.events, /TERMINATE: writer -- SIGTERM al grupo por solicitud/)
    assert.doesNotMatch(run.events, /TIMEOUT/)
  })

  test('el timeout alcanza tambien a los nietos del proceso', { skip: POSIX_ONLY }, async () => {
    const pidFile = join(work, 'nieto.pid')
    const script = `
      const { spawn } = require('node:child_process')
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' })
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
      setTimeout(() => {}, 600000)`
    const run = await watched(script, { timeoutSeconds: 2 })
    assert.equal(run.timedOut, true)
    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    for (let tries = 0; tries < 50; tries++) {
      try {
        process.kill(grandchild, 0)
      } catch {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.fail(`el nieto ${grandchild} sobrevivio al timeout`)
  })

  test('un proceso detenido se reanuda con SIGCONT y termina por su cuenta', { skip: POSIX_ONLY }, async () => {
    const run = await watched('process.kill(process.pid, "SIGSTOP"); process.stdout.write("reanudado")', {
      timeoutSeconds: 20,
    })
    assert.equal(run.exitCode, 0)
    assert.equal(run.timedOut, false)
    assert.equal(run.stdout, 'reanudado')
    assert.match(run.events, /STOPPED: writer tenia 1 proceso\(s\) detenido\(s\) -- SIGCONT enviado/)
    assert.doesNotMatch(run.events, /TIMEOUT/)
  })

  test('el proceso no hereda la terminal de control', { skip: POSIX_ONLY }, async () => {
    const script =
      'try { require("node:fs").openSync("/dev/tty", "r"); process.stdout.write("tty") } catch (e) { process.stdout.write(e.code) }'
    assert.notEqual((await watched(script)).stdout, 'tty')
  })
})
