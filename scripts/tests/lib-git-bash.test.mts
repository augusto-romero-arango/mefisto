import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { GIT_BASH_DEFAULT, findGitBash } from '../lib/git-bash.mts'

function probe(env: NodeJS.ProcessEnv, files: string[]): string | null {
  const present = new Set(files)
  return findGitBash({ env, isFile: (path) => present.has(path) })
}

describe('findGitBash', () => {
  test('la ruta por defecto de Git for Windows', () => {
    assert.equal(probe({}, [GIT_BASH_DEFAULT]), GIT_BASH_DEFAULT)
  })

  test('sin bash.exe en ninguna ruta conocida', () => {
    assert.equal(probe({ ProgramFiles: 'C:\\Program Files', PATH: 'C:\\Windows\\System32' }, []), null)
  })

  test('CLAUDE_CODE_GIT_BASH_PATH manda: vale si existe y anula las demas rutas', () => {
    const declared = 'D:\\Herramientas\\Git\\bin\\bash.exe'
    assert.equal(probe({ CLAUDE_CODE_GIT_BASH_PATH: declared }, [declared, GIT_BASH_DEFAULT]), declared)
    assert.equal(probe({ CLAUDE_CODE_GIT_BASH_PATH: declared }, [GIT_BASH_DEFAULT]), null)
  })

  test('una CLAUDE_CODE_GIT_BASH_PATH vacia no cuenta', () => {
    assert.equal(probe({ CLAUDE_CODE_GIT_BASH_PATH: '' }, [GIT_BASH_DEFAULT]), GIT_BASH_DEFAULT)
  })

  test('ProgramFiles y la instalacion por usuario', () => {
    assert.equal(probe({ ProgramFiles: 'E:\\Apps' }, ['E:\\Apps\\Git\\bin\\bash.exe']), 'E:\\Apps\\Git\\bin\\bash.exe')
    const user = 'C:\\Users\\ana\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'
    assert.equal(probe({ LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local' }, [user]), user)
  })

  test('una instalacion en otra carpeta, por el git.exe del PATH', () => {
    const files = ['F:\\Git\\cmd\\git.exe', 'F:\\Git\\bin\\bash.exe']
    assert.equal(probe({ Path: 'C:\\Windows;F:\\Git\\cmd' }, files), 'F:\\Git\\bin\\bash.exe')
    assert.equal(probe({ Path: 'C:\\Windows;F:\\Git\\cmd' }, ['F:\\Git\\bin\\bash.exe']), null)
  })
})
