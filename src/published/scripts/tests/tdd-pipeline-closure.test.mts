// Los pipelines de TDD y de tooling, ya en TypeScript, solo importan modulos declarados en la
// clausura publicada (`TOOLING_CLOSURE_ASSETS`), y sus `.sh` son los shims que los lanzan. El
// arranque de TDD desde `dist/claude` lo cubre scripts/tests/tdd-pipeline.test.mts.

import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { describe } from 'node:test'

import { REPO_ROOT, TOOLING_CLOSURE_ASSETS } from '../generate-published-adapters.mts'
import { check, closureAssets } from './agent-contract-kit.mts'

/** Modulos que `entry` importa, directa o transitivamente, como rutas del repo. */
function importClosure(entry: string): string[] {
  const seen = new Set<string>()
  const pending = [entry]
  for (let module = pending.pop(); module !== undefined; module = pending.pop()) {
    if (seen.has(module)) continue
    seen.add(module)
    const source = readFileSync(join(REPO_ROOT, ...module.split('/')), 'utf8')
    for (const match of source.matchAll(/^(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]/gms)) {
      pending.push(posix.normalize(posix.join(posix.dirname(module), match[1] ?? '')))
    }
  }
  return [...seen].sort()
}

describe('[pre] dependencias de clausura', () => {
  const declared = new Set(closureAssets(TOOLING_CLOSURE_ASSETS).map((asset) => asset.source))
  for (const pipeline of ['tdd-pipeline', 'tooling-pipeline']) {
    const imported = importClosure(`scripts/${pipeline}.mts`)
    const missing = imported.filter((module) => !declared.has(module))
    check(
      `${pipeline}.mts solo importa modulos declarados en la clausura (${imported.length} verificados)`,
      () => missing.length === 0 && imported.length >= 20,
      `${pipeline}.mts importa modulos fuera de TOOLING_CLOSURE_ASSETS: ${missing.join(', ')}`,
    )
    check(
      `${pipeline}.sh es el shim que lanza ${pipeline}.mts`,
      () => readFileSync(join(REPO_ROOT, 'scripts', `${pipeline}.sh`), 'utf8').includes(`/${pipeline}.mts" "$@"`),
      `${pipeline}.sh dejo de delegar en ${pipeline}.mts`,
    )
  }
})
