import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'

import { PIPELINE_SIGNALS, PipelineAbort, PipelineExit, SIGNAL_EXIT_CODES, runPipeline } from '../lib/pipeline/pipeline-exit.mts'

function harness(): { finalized: number[]; errors: string[]; signals: EventEmitter; exits: number[] } {
  return { finalized: [], errors: [], signals: new EventEmitter(), exits: [] }
}

describe('runPipeline', () => {
  test('devuelve el codigo de main y cierra una sola vez', async () => {
    const h = harness()
    const hooks = { finalize: (code: number) => void h.finalized.push(code), signals: h.signals }
    assert.equal(await runPipeline(() => Promise.resolve(0), hooks), 0)
    assert.equal(await runPipeline(() => Promise.resolve(7), hooks), 7)
    assert.equal(await runPipeline(async () => {}, hooks), 0)
    assert.deepEqual(h.finalized, [0, 7, 0])
    for (const signal of PIPELINE_SIGNALS) assert.equal(h.signals.listenerCount(signal), 0, 'no deja manejadores')
  })

  test('un aborto y una salida con codigo cierran con ese codigo y sin mensaje', async () => {
    const h = harness()
    const hooks = { finalize: (code: number) => void h.finalized.push(code), err: (text: string) => void h.errors.push(text), signals: h.signals }
    assert.equal(await runPipeline(() => Promise.reject(new PipelineAbort('ya informado')), hooks), 1)
    assert.equal(await runPipeline(() => Promise.reject(new PipelineExit(23)), hooks), 23)
    assert.deepEqual(h.finalized, [1, 23])
    assert.deepEqual(h.errors, [])
  })

  test('un error no previsto se imprime, cierra con 1 y no escapa', async () => {
    const h = harness()
    const code = await runPipeline(
      () => {
        throw new TypeError('diagnostico-no-previsto')
      },
      { finalize: (exit) => void h.finalized.push(exit), err: (text) => void h.errors.push(text), signals: h.signals },
    )
    assert.equal(code, 1)
    assert.deepEqual(h.finalized, [1])
    assert.match(h.errors.join(''), /TypeError: diagnostico-no-previsto/)
  })

  test('un cierre que falla no cambia el codigo de salida', async () => {
    const code = await runPipeline(() => Promise.resolve(0), {
      finalize: () => {
        throw new Error('cierre roto')
      },
      signals: new EventEmitter(),
    })
    assert.equal(code, 0)
  })

  for (const signal of PIPELINE_SIGNALS) {
    test(`${signal} avisa, cierra con ${SIGNAL_EXIT_CODES[signal]} y termina el proceso; el cierre no se repite`, async () => {
      const h = harness()
      const seen: string[] = []
      let release: () => void = () => {}
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      const running = runPipeline(
        async () => {
          await blocked
          return 0
        },
        {
          finalize: (code) => void h.finalized.push(code),
          onSignal: (received) => void seen.push(received),
          exit: (code) => void h.exits.push(code),
          signals: h.signals,
        },
      )
      h.signals.emit(signal, signal)
      assert.deepEqual(seen, [signal])
      assert.deepEqual(h.finalized, [SIGNAL_EXIT_CODES[signal]])
      assert.deepEqual(h.exits, [SIGNAL_EXIT_CODES[signal]])
      release()
      await running
      assert.deepEqual(h.finalized, [SIGNAL_EXIT_CODES[signal]], 'cerrar al volver main no repite el cierre')
    })
  }

  test('un onSignal que falla no impide el cierre', async () => {
    const h = harness()
    const running = runPipeline(() => new Promise<number>(() => {}), {
      finalize: (code) => void h.finalized.push(code),
      onSignal: () => {
        throw new Error('no pude matar al hijo')
      },
      exit: (code) => void h.exits.push(code),
      signals: h.signals,
    })
    h.signals.emit('SIGINT', 'SIGINT')
    assert.deepEqual(h.finalized, [130])
    assert.deepEqual(h.exits, [130])
    void running
  })
})
