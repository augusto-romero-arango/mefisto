// Arnes de los tests de herdr: una CLI de herdr falsa que responde el JSON de herdr y registra
// cada invocacion, y un `gh` falso. Nunca toca un servidor herdr ni la red.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Run } from '../lib/azure-cli.mts'
import { capture } from '../lib/cli.mts'
import type { CommandResult } from '../lib/cli.mts'
import { readDispatchSpec } from '../lib/herdr.mts'
import type { DispatchSpec } from '../lib/herdr.mts'

export const ok = (stdout = '{"result":{"type":"ok"}}\n'): CommandResult => ({ status: 0, stdout, stderr: '' })
export const fail = (status = 1, stderr = ''): CommandResult => ({ status, stdout: '', stderr })

export function processInfoJson(shellPid: number, foreground: number): string {
  return `{"result":{"process_info":{"shell_pid":${shellPid},"foreground_process_group_id":${foreground}}}}\n`
}

/** Argumentos entre comillas dobles de la linea que se teclea en el pane. */
export function quotedArguments(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1] as string)
}

export interface TypedRun {
  pane: string
  line: string
  spec: DispatchSpec | null
}

export interface FakeHerdrOptions {
  /** Pane cuyo `process-info` reporta `ownerPid` como shell (el que despacha). */
  ownPane?: string
  ownerPid?: number
  dead?: string[]
  /** Panes con un comando en foreground. */
  occupied?: string[]
  /** Panes cuyo shell nunca ejecuta lo que se teclea. */
  neverConfirm?: string[]
  /** Siguiente pane de un `pane split`. */
  nextSplit?: () => string
  /** `gh issue view N`: estado y labels por issue. */
  issues?: Record<string, { state: string; labels: string[] }>
  /** Respuesta propia para una invocacion; `undefined` cae en la de defecto. */
  respond?: (args: string[]) => CommandResult | undefined
}

export class FakeHerdr {
  readonly calls: string[] = []
  readonly argvs: string[][] = []
  readonly typed: TypedRun[] = []
  readonly options: FakeHerdrOptions
  private counter = 0

  constructor(options: FakeHerdrOptions = {}) {
    this.options = options
  }

  reset(): void {
    this.calls.length = 0
    this.argvs.length = 0
    this.typed.length = 0
  }

  get log(): string {
    return this.calls.join('\n')
  }

  count(prefix: string): number {
    return this.calls.filter((call) => call.startsWith(prefix)).length
  }

  readonly run: Run = (command, args, options) => {
    if (command === 'herdr') return this.herdr(args)
    if (command === 'gh') return this.gh(args)
    if (command === 'git') return capture(command, args, options)
    return fail(127, `${command}: no disponible en el test\n`)
  }

  private herdr(args: string[]): CommandResult {
    this.calls.push(`herdr ${args.join(' ')}`)
    this.argvs.push([...args])
    const custom = this.options.respond?.(args)
    if (custom !== undefined) return custom
    const [group = '', action = ''] = args
    const key = `${group} ${action}`
    if (key === 'pane split') {
      const next = this.options.nextSplit?.() ?? `w1:p${++this.counter}`
      return ok(`{"result":{"pane":{"pane_id":"${next}"}}}\n`)
    }
    if (key === 'pane get') {
      return (this.options.dead ?? []).includes(args[2] ?? '') ? fail() : ok(`{"result":{"pane":{"pane_id":"${args[2]}"}}}\n`)
    }
    if (key === 'pane process-info') {
      const pane = args[3] ?? ''
      if (this.options.ownPane !== undefined && pane === this.options.ownPane && this.options.ownerPid !== undefined) {
        return ok(processInfoJson(this.options.ownerPid, this.options.ownerPid))
      }
      return ok((this.options.occupied ?? []).includes(pane) ? processInfoJson(100, 200) : processInfoJson(100, 100))
    }
    if (key === 'pane run') {
      const pane = args[2] ?? ''
      const line = args[3] ?? ''
      const quoted = quotedArguments(line)
      const at = quoted.indexOf('--dispatch')
      const spec = at >= 0 ? readDispatchSpec(quoted[at + 1] ?? '') : null
      this.typed.push({ pane, line, spec })
      if (spec !== null && !(this.options.neverConfirm ?? []).includes(pane)) {
        mkdirSync(dirname(spec.startedMarker), { recursive: true })
        if (!existsSync(spec.startedMarker)) writeFileSync(spec.startedMarker, '')
      }
      return ok()
    }
    return ok()
  }

  private gh(args: string[]): CommandResult {
    const issue = this.options.issues?.[args[2] ?? '']
    if (args[0] !== 'issue' || args[1] !== 'view' || issue === undefined) return fail()
    return ok(`${JSON.stringify({ state: issue.state, labels: issue.labels.map((name) => ({ name })) })}\n`)
  }
}

/** Reloj falso: `sleep` lo adelanta en vez de esperar. */
export class FakeClock {
  private ms: number

  constructor(start = Date.UTC(2026, 10, 12, 15, 0, 0)) {
    this.ms = start
  }

  readonly now = (): Date => new Date(this.ms)

  readonly sleep = async (seconds: number): Promise<void> => {
    this.ms += Math.round(seconds * 1000)
  }
}
