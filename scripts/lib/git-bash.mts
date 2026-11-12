// Ubicacion del `bash.exe` de Git for Windows, el shell con el que Claude Code ejecuta en Windows
// los bloques de bash de comandos y agentes (MEF-ADR-0057, decision 9). Solo comprueba archivos:
// no lanza ningun shell. https://code.claude.com/docs/en/setup nombra la variable
// `CLAUDE_CODE_GIT_BASH_PATH` y la ruta por defecto `C:\Program Files\Git\bin\bash.exe`.

import { win32 } from 'node:path'

import { envValue } from './cli.mts'

export const GIT_BASH_DEFAULT = 'C:\\Program Files\\Git\\bin\\bash.exe'

export interface GitBashProbe {
  env: NodeJS.ProcessEnv
  isFile: (path: string) => boolean
}

function candidates(env: NodeJS.ProcessEnv, isFile: (path: string) => boolean): string[] {
  const found: string[] = []
  for (const variable of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']) {
    const base = envValue(env, variable)
    if (base) found.push(win32.join(base, 'Git', 'bin', 'bash.exe'))
  }
  const local = envValue(env, 'LOCALAPPDATA')
  if (local) found.push(win32.join(local, 'Programs', 'Git', 'bin', 'bash.exe'))
  found.push(GIT_BASH_DEFAULT)
  // Instalado en otra carpeta, Git for Windows deja `<Git>\cmd\git.exe` en el PATH, junto a `<Git>\bin`.
  for (const dir of (envValue(env, 'PATH') ?? '').split(';')) {
    if (dir.length > 0 && isFile(win32.join(dir, 'git.exe'))) found.push(win32.join(dir, '..', 'bin', 'bash.exe'))
  }
  return found
}

/** Ruta de Git Bash, o `null`; si `CLAUDE_CODE_GIT_BASH_PATH` tiene valor, solo vale ese archivo. */
export function findGitBash({ env, isFile }: GitBashProbe): string | null {
  const declared = envValue(env, 'CLAUDE_CODE_GIT_BASH_PATH')
  if (declared) return isFile(declared) ? declared : null
  return candidates(env, isFile).find(isFile) ?? null
}
