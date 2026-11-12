// Consulta de PRs que un pipeline hace antes de crear el suyo.

import { parseJson } from '../azure-cli.mts'
import type { Run } from '../azure-cli.mts'
import { capture } from '../cli.mts'

export interface FindOpenPrOptions {
  /** `owner/repo`, para cuando `gh` no corre dentro del repo. */
  repo?: string
  /** GitHub admite un PR abierto por par (rama, base): sin este filtro se reutilizaria el de otra base. */
  base?: string
  run?: Run
}

/**
 * URL del PR abierto de `branch` hacia `base` (por defecto `main`), para reutilizarlo en vez de
 * fallar al crearlo. `null` si no hay ninguno o si `gh` no pudo responder: es un chequeo
 * defensivo, y un `gh` roto lo reporta la creacion del PR que sigue.
 */
export function findOpenPrForBranch(branch: string, options: FindOpenPrOptions = {}): string | null {
  if (branch.length === 0) return null
  const run = options.run ?? capture
  const args = ['pr', 'list', '--head', branch, '--base', options.base ?? 'main', '--state', 'open', '--json', 'url']
  if (options.repo !== undefined && options.repo.length > 0) args.push('--repo', options.repo)
  const result = run('gh', args)
  if (result.status !== 0) return null
  const list = parseJson(result.stdout)?.value
  const first: unknown = Array.isArray(list) ? list[0] : null
  const url = typeof first === 'object' && first !== null ? (first as Record<string, unknown>).url : null
  return typeof url === 'string' && url.length > 0 && url !== 'null' ? url : null
}
