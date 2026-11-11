// Rama base del checkout principal al arrancar un batch interno, y la remediacion de los commits
// locales que el hook pre-push ya rescato.
//
// Gemela de `remediate_main_after_rescue` y `ensure_repo_on_base_branch` de `_mefisto-common.sh`:
// mientras tengan llamadores en bash, un cambio va en los dos lados. La paridad la verifica
// `.claude/scripts/tests/mefisto-base-branch.test.mts`.

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Run } from '../../../../scripts/lib/azure-cli.mts'
import { capture } from '../../../../scripts/lib/cli.mts'
import type { CommandResult } from '../../../../scripts/lib/cli.mts'
import { chomp } from './mefisto-script-io.mts'

/** Lineas de la lista de SHAs rescatados; `null` si no es un archivo legible. */
function rescuedLines(file: string): string[] | null {
  try {
    if (!statSync(file).isFile()) return null
    // latin1 conserva byte a byte las lineas ajenas al reescribir la lista.
    const lines = readFileSync(file, 'latin1').split('\n')
    if (lines.at(-1) === '') lines.pop()
    return lines
  } catch {
    return null
  }
}

/**
 * Si todos los commits de `branch` ausentes de `remoteRef` figuran en
 * `.mefisto/pipeline/rescued-main.txt` y el arbol esta limpio, hace `git reset --keep remoteRef`
 * sobre `branch` (la rama activa de `repoRoot`), retira esos SHAs de la lista y devuelve el aviso.
 * En cualquier otro caso devuelve `null` sin tocar nada. Los commits viven en la rama remota de
 * rescate: resetear no pierde nada, y `--keep` se niega a pisar cambios locales.
 */
export function remediateMainAfterRescue(
  repoRoot: string,
  branch: string,
  remoteRef: string,
  run: Run = capture,
): string | null {
  const rescuedFile = join(repoRoot, '.mefisto', 'pipeline', 'rescued-main.txt')
  const rescued = rescuedLines(rescuedFile)
  if (rescued === null) return null
  const git = (...args: string[]): CommandResult => run('git', ['-C', repoRoot, ...args])
  if (chomp(git('rev-parse', '--abbrev-ref', 'HEAD').stdout) !== branch) return null
  if (chomp(git('status', '--porcelain').stdout).length > 0) return null

  const ahead = git('rev-list', `${remoteRef}..${branch}`)
  if (ahead.status !== 0) return null
  const aheadList = chomp(ahead.stdout)
  if (aheadList.length === 0) return null
  const localShas = aheadList.split('\n')
  if (!localShas.every((sha) => rescued.includes(sha))) return null

  if (git('reset', '--keep', remoteRef).status !== 0) return null

  try {
    const kept = rescued.filter((line) => !localShas.includes(line))
    writeFileSync(rescuedFile, kept.map((line) => `${line}\n`).join(''), 'latin1')
  } catch {
    // La rama ya quedo remediada: no poder reescribir la lista no lo deshace.
  }
  return `'${branch}' local tenia commits ya rescatados por el hook pre-push; se hizo 'git reset --keep ${remoteRef}' y se retiraron de rescued-main.txt (issue #2112).`
}

export interface BaseBranchOptions {
  /** Raiz del checkout principal; sin ella se resuelve con git desde `cwd`. */
  repoRoot?: string
  cwd?: string
  run?: Run
}

export type BaseBranchCheck =
  | {
      ok: true
      /** Rama base en la que queda el checkout principal. */
      mainBranch: string
      /** Avisos para el usuario, en orden. */
      warnings: string[]
      gitStderr: string
    }
  | {
      ok: false
      /** Motivo, listo para abortar el batch. */
      abort: string
      /** Lo que git escribio en stderr en los pasos que la gemela bash deja pasar a la terminal. */
      gitStderr: string
    }

/**
 * Gate de arranque de un batch interno: deja el checkout principal en `main` o `master`. Si ya
 * esta ahi no hace nada. Fuera de esas ramas solo se recupera un arbol limpio: cambia a `main`
 * (o a `master` si no hay `main`) y hace `git pull --ff-only`. Un arbol sucio, una base ausente
 * o un pull fallido abortan sin stash, reset ni switch forzado, salvo el pull fallido cuyos
 * commits locales de mas ya rescato el hook pre-push.
 */
export function ensureRepoOnBaseBranch(options: BaseBranchOptions = {}): BaseBranchCheck {
  const run = options.run ?? capture
  let gitStderr = ''
  const abort = (reason: string): BaseBranchCheck => ({ ok: false, abort: reason, gitStderr })

  let repoRoot = options.repoRoot ?? ''
  if (repoRoot.length === 0) {
    const toplevel = run('git', ['rev-parse', '--show-toplevel'], { cwd: options.cwd })
    if (toplevel.status !== 0) return abort('No se pudo resolver la raiz del repo para prevalidar el batch.')
    repoRoot = chomp(toplevel.stdout)
  }
  const git = (...args: string[]): CommandResult => run('git', ['-C', repoRoot, ...args])
  const gitLoud = (...args: string[]): CommandResult => {
    const result = git(...args)
    gitStderr += result.stderr
    return result
  }

  const head = gitLoud('rev-parse', '--abbrev-ref', 'HEAD')
  if (head.status !== 0) {
    return abort('No se pudo determinar la rama activa del repo principal antes de arrancar el batch.')
  }
  const currentBranch = chomp(head.stdout)
  if (currentBranch === 'main' || currentBranch === 'master') {
    return { ok: true, mainBranch: currentBranch, warnings: [], gitStderr }
  }

  if (chomp(gitLoud('status', '--porcelain').stdout).length > 0) {
    return abort(
      `El repo principal esta en la rama '${currentBranch}', no en main/master, y el arbol de trabajo no esta limpio (cambios sin commitear, staged o archivos sin trackear). Cada worktree del tooling-pipeline nace de origin/main sin importar la rama activa (issue #66), pero el batch tambien mantiene la base local sincronizada. La auto-recuperacion solo aplica con el arbol de trabajo LIMPIO; con cambios pendientes se requiere resolucion humana: conservalos, commitealos o resuelvelos y haz 'git switch main' a mano antes de lanzar el batch.`,
    )
  }

  const hasLocalBranch = (name: string): boolean =>
    git('rev-parse', '--verify', '-q', `refs/heads/${name}`).status === 0
  const baseBranch = hasLocalBranch('main') ? 'main' : hasLocalBranch('master') ? 'master' : null
  if (baseBranch === null) {
    return abort(
      `El repo principal esta en la rama '${currentBranch}' y no existe ni 'main' ni 'master' local para auto-recuperar el gate. Crea o rescata una de las dos antes de lanzar el batch.`,
    )
  }

  if (gitLoud('switch', '-q', baseBranch).status !== 0) {
    return abort(
      `El repo principal esta en la rama '${currentBranch}' (arbol limpio), pero 'git switch ${baseBranch}' fallo. Resuelve a mano antes de lanzar el batch.`,
    )
  }

  const warnings: string[] = []
  const pull = git('pull', '--ff-only')
  if (pull.status !== 0) {
    const remediated = remediateMainAfterRescue(repoRoot, baseBranch, `origin/${baseBranch}`, run)
    if (remediated === null) {
      const pullOutput = chomp(pull.stdout + pull.stderr).replaceAll('\n', ' ')
      return abort(
        `El repo principal estaba en la rama '${currentBranch}' (arbol limpio); el gate lo auto-recupero a '${baseBranch}', pero 'git pull --ff-only' fallo ahi -- tipicamente porque '${baseBranch}' local divergio de origin/${baseBranch} (tambien cae aqui una base sin upstream configurado). La premisa de higiene no se puede cumplir asi: resuelve la divergencia a mano (el repo quedo en '${baseBranch}') antes de relanzar el batch. Salida de git: ${pullOutput}`,
      )
    }
    warnings.push(remediated)
  }

  warnings.push(
    `El repo principal estaba en la rama '${currentBranch}' (arbol limpio) al arrancar el batch; el gate se auto-recupero a '${baseBranch}' y lo sincronizo con origin/${baseBranch} (issue #726). Los commits de '${currentBranch}' siguen intactos en su rama.`,
  )
  return { ok: true, mainBranch: baseBranch, warnings, gitStderr }
}
