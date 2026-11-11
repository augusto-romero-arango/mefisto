// Salida y `gh` inyectables: un test los sustituye sin tocar el proceso ni el PATH.

import { capture } from '../../../../scripts/lib/cli.mts'
import type { CommandResult } from '../../../../scripts/lib/cli.mts'

/** Con `live` escribe en el proceso; sin el acumula en `stdout` y `stderr`. */
export class Output {
  stdout = ''
  stderr = ''
  readonly live: boolean

  constructor(live = false) {
    this.live = live
  }

  out(line: string): void {
    this.writeOut(`${line}\n`)
  }

  err(line: string): void {
    this.writeErr(`${line}\n`)
  }

  writeOut(text: string): void {
    if (text.length === 0) return
    if (this.live) process.stdout.write(text)
    else this.stdout += text
  }

  writeErr(text: string): void {
    if (text.length === 0) return
    if (this.live) process.stderr.write(text)
    else this.stderr += text
  }
}

export type Gh = (args: string[]) => CommandResult

export const runGh: Gh = (args) => capture('gh', args)

/** Quita los saltos finales, como la sustitucion de comandos de bash. */
export function chomp(text: string): string {
  return text.replace(/\n+$/, '')
}
