// Ruta del `harness.config.json` del consumidor para los bloques de bash de comandos y agentes,
// sin cargar `_pipeline-common.sh` (MEF-ADR-0057, decision 9).
//
// Uso: node harness-config-path.mts <read|write|valid> [raiz]
//   read   la ruta efectiva de lectura: la canonica o, si falta, la legacy
//   write  la ruta canonica, exista o no
//   valid  la ruta efectiva de lectura, solo si el config que hay ahi es valido
// Sin raiz, parte de la raiz Git del directorio actual. La ruta va a stdout; avisos y errores, a
// stderr. Sale con 1 si la ruta no se resuelve o el config no es valido, y con 2 si el uso es
// invalido.

import { CliError, isEntryPoint } from './lib/cli.mts'
import { loadHarnessConfig, resolveHarnessConfigPath } from './lib/harness-config.mts'

export const USAGE = 'Uso: node harness-config-path.mts <read|write|valid> [raiz]'

export interface Io {
  cwd: string
  out: (line: string) => void
  err: (line: string) => void
}

export function harnessConfigPath(argv: readonly string[], io: Io): number {
  const [mode, root, ...rest] = argv
  if ((mode !== 'read' && mode !== 'write' && mode !== 'valid') || rest.length > 0) {
    io.err(USAGE)
    return 2
  }
  const options = { cwd: io.cwd, warn: io.err }
  try {
    if (mode === 'valid') {
      const config = resolveHarnessConfigPath('read', root, options)
      io.out(loadHarnessConfig(config, options).configPath)
    } else {
      io.out(resolveHarnessConfigPath(mode, root, options))
    }
    return 0
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    io.err(error.message)
    return error.exitCode
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = harnessConfigPath(process.argv.slice(2), {
    cwd: process.cwd(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  })
}
