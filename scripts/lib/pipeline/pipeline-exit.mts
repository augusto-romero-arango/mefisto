// Cierre de un pipeline: lo que el bash hacia en su `trap ... EXIT` corre una sola vez en todos
// los caminos de salida (exito, aborto, error no previsto y senal).
//
// En Windows solo llega `SIGINT` (Ctrl-C en la consola). Un pipeline terminado con `taskkill` o
// al cerrar la sesion muere sin ejecutar el cierre: su status queda en `running`.

/** Aborto ya informado por quien lo lanza: el pipeline termina con `exitCode` sin mas mensajes. */
export class PipelineAbort extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode = 1) {
    super(message)
    this.name = 'PipelineAbort'
    this.exitCode = exitCode
  }
}

/** Fin sin mensaje con un codigo dado, como `set -e` ante un comando que falla. */
export class PipelineExit extends Error {
  readonly exitCode: number

  constructor(exitCode: number) {
    super(`el pipeline termino con codigo ${exitCode}`)
    this.name = 'PipelineExit'
    this.exitCode = exitCode
  }
}

export const PIPELINE_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

/** Codigo con que termina un pipeline cortado por una senal: 128 mas su numero. */
export const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }

export interface SignalSource {
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown
  off(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown
}

export interface PipelineRunHooks {
  /** Estado final, historial de fallo y limpieza de temporales. Recibe el codigo de salida. */
  finalize: (exitCode: number) => void
  /** Corre antes del cierre cuando llega una senal: mata los procesos que el pipeline lanzo. */
  onSignal?: (signal: NodeJS.Signals) => void
  /** Recibe el error no previsto, ya como texto. */
  err?: (text: string) => void
  /** Termina el proceso tras una senal; inyectable para probar el camino sin matar al test. */
  exit?: (code: number) => void
  signals?: SignalSource
}

/**
 * Corre `main` y devuelve el codigo de salida del pipeline. `finalize` corre exactamente una
 * vez: al volver `main`, al abortar, ante un error no previsto (codigo 1) o al llegar `SIGINT`,
 * `SIGTERM` o `SIGHUP` (130, 143 o 129), caso en que ademas termina el proceso.
 */
export async function runPipeline(main: () => Promise<number | void>, hooks: PipelineRunHooks): Promise<number> {
  const signals = hooks.signals ?? process
  const err = hooks.err ?? ((text: string): void => void process.stderr.write(text))
  const exit = hooks.exit ?? ((status: number): void => process.exit(status))
  let finalized = false
  const finalizeOnce = (code: number): void => {
    if (finalized) return
    finalized = true
    try {
      hooks.finalize(code)
    } catch {
      // El cierre no cambia el codigo de salida.
    }
  }
  const onSignal = (signal: NodeJS.Signals): void => {
    const code = SIGNAL_EXIT_CODES[signal] ?? 1
    try {
      hooks.onSignal?.(signal)
    } catch {
      // Sin poder matar al hijo, el cierre igual deja el estado final.
    }
    finalizeOnce(code)
    exit(code)
  }
  for (const signal of PIPELINE_SIGNALS) signals.on(signal, onSignal)

  let code = 1
  try {
    code = (await main()) ?? 0
  } catch (error) {
    if (error instanceof PipelineAbort || error instanceof PipelineExit) {
      code = error.exitCode
    } else {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
      err(`${detail}\n`)
      code = 1
    }
  } finally {
    finalizeOnce(code)
    for (const signal of PIPELINE_SIGNALS) signals.off(signal, onSignal)
  }
  return code
}
