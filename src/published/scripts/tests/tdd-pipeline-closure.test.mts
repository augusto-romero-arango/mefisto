// Los pipelines de TDD y de tooling solo referencian assets declarados en la clausura publicada
// (`TOOLING_CLOSURE_ASSETS`): el de TDD, bash, por lo que carga y nombra; el de tooling, ya en
// TypeScript, por lo que importa. El arranque de TDD desde `dist/claude`, que ejecuta el
// pipeline, lo cubre test-tdd-pipeline-closure.sh.

import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { describe } from 'node:test'

import { REPO_ROOT, TOOLING_CLOSURE_ASSETS } from '../generate-published-adapters.mts'
import { check, closureAssets, scanPipelineClosure } from './agent-contract-kit.mts'

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

describe('[pre] sintaxis y dependencias de clausura', () => {
  const scan = scanPipelineClosure('scripts/tdd-pipeline.sh')
  check(
    `tdd-pipeline.sh solo referencia dependencias declaradas en la clausura (${scan.references} verificadas)`,
    () => scan.problem === '',
    `tdd-pipeline.sh referencia assets fuera de TOOLING_CLOSURE_ASSETS: ${scan.problem}`,
  )

  const declared = new Set(closureAssets(TOOLING_CLOSURE_ASSETS).map((asset) => asset.source))
  const imported = importClosure('scripts/tooling-pipeline.mts')
  const missing = imported.filter((module) => !declared.has(module))
  check(
    `tooling-pipeline.mts solo importa modulos declarados en la clausura (${imported.length} verificados)`,
    () => missing.length === 0 && imported.length >= 20,
    `tooling-pipeline.mts importa modulos fuera de TOOLING_CLOSURE_ASSETS: ${missing.join(', ')}`,
  )
  check(
    'tooling-pipeline.sh es el shim que lanza tooling-pipeline.mts',
    () => readFileSync(join(REPO_ROOT, 'scripts', 'tooling-pipeline.sh'), 'utf8').includes('/tooling-pipeline.mts" "$@"'),
    'tooling-pipeline.sh dejo de delegar en tooling-pipeline.mts',
  )
})
