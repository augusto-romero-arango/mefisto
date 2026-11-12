// Guardas de los scripts internos: solo corren dentro del repo de Mefisto.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Run } from '../../../../scripts/lib/azure-cli.mts'
import { CliError, capture, commandExists, gitOutput, repoRoot } from '../../../../scripts/lib/cli.mts'

export interface MefistoRepo {
  root: string
  projectName: string
  /** `owner/repo`, o vacio si `gh` no esta o no responde. */
  repoSlug: string
}

/** Como se consulta `gh`; por defecto, el real. */
export interface MefistoRepoTools {
  run?: Run
  hasCommand?: (command: string) => boolean
}

/** Lanza `CliError` si `cwd` no esta dentro del repo de Mefisto. */
export function assertInMefisto(cwd: string = process.cwd(), tools: MefistoRepoTools = {}): MefistoRepo {
  const root = repoRoot(cwd)
  if (root === null) throw new CliError('ERROR: no estas en un repositorio git')
  const manifest = join(root, '.claude-plugin', 'plugin.json')
  if (!existsSync(manifest)) {
    throw new CliError(
      [
        'ERROR: este pipeline solo se ejecuta dentro del repo de Mefisto',
        `  No se encontro ${root}/.claude-plugin/plugin.json`,
        '  Si querias trabajar sobre tu proyecto consumidor, usa los skills',
        '  publicados (/tooling, /implement, etc.) desde la raiz de ese repo.',
      ].join('\n'),
    )
  }
  return { root, projectName: projectNameOf(manifest), repoSlug: repoSlugOf(root, tools) }
}

function projectNameOf(manifest: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && 'name' in parsed) {
      const { name } = parsed
      if (typeof name === 'string' && name.length > 0) return name
    }
  } catch {
    // Un manifiesto ilegible no impide trabajar: se usa el nombre por defecto.
  }
  return 'mefisto'
}

function repoSlugOf(root: string, tools: MefistoRepoTools): string {
  if (!(tools.hasCommand ?? ((command: string): boolean => commandExists(command)))('gh')) return ''
  const result = (tools.run ?? capture)('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
    cwd: root,
  })
  return result.status === 0 ? result.stdout.trim() : ''
}

const HOOKS_PATH = 'src/internal/githooks'

/**
 * Activa los hooks de git versionados si `core.hooksPath` esta vacio. Devuelve el aviso a
 * mostrar, o `null` si no hay nada que decir. Nunca falla.
 */
export function ensureGithooksInstalled(root: string): string | null {
  const current = gitOutput(['config', '--get', 'core.hooksPath'], root) ?? ''
  if (current.length === 0) {
    const set = capture('git', ['config', 'core.hooksPath', HOOKS_PATH], { cwd: root })
    return set.status === 0
      ? `AVISO: core.hooksPath configurado a ${HOOKS_PATH} (hook pre-push que desvia a PR los push directos a main).`
      : null
  }
  const accepted = [HOOKS_PATH, `${HOOKS_PATH}/`, `${root}/${HOOKS_PATH}`, `${root}/${HOOKS_PATH}/`]
  if (accepted.includes(current)) return null
  return `AVISO: core.hooksPath apunta a '${current}'; no se pisa, y el hook pre-push de ${HOOKS_PATH} no queda activo.`
}
