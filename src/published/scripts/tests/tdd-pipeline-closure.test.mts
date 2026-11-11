// Los pipelines bash de TDD y de tooling solo referencian assets declarados en la clausura
// publicada (`TOOLING_CLOSURE_ASSETS`). El arranque de TDD desde `dist/claude`, que ejecuta el
// pipeline, lo cubre test-tdd-pipeline-closure.sh.

import { describe } from 'node:test'

import { check, scanPipelineClosure } from './agent-contract-kit.mts'

describe('[pre] sintaxis y dependencias de clausura', () => {
  for (const pipeline of ['tdd-pipeline.sh', 'tooling-pipeline.sh']) {
    const scan = scanPipelineClosure(`scripts/${pipeline}`)
    check(
      `${pipeline} solo referencia dependencias declaradas en la clausura (${scan.references} verificadas)`,
      () => scan.problem === '',
      `${pipeline} referencia assets fuera de TOOLING_CLOSURE_ASSETS: ${scan.problem}`,
    )
  }
})
