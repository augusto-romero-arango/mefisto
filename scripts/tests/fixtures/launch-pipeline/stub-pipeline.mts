// Pipeline falso de los tests de los lanzadores: imprime con que nombre lo lanzaron, su argv y
// el entorno que recibio. Su salida termina en el report log de la corrida.

import { basename } from 'node:path'

const env = process.env
const lines = [
  `script: ${basename(process.argv[1] ?? '')}`,
  `argv:${process.argv
    .slice(2)
    .map((arg) => ` [${arg}]`)
    .join('')}`,
  `runtime: ${env.MEFISTO_RUNTIME ?? ''}`,
  `models-file: ${env.MEFISTO_MODELS_FILE ?? ''}`,
  `ui: ${env.MEFISTO_UI ?? ''}`,
  `herdr: ${Object.keys(env)
    .filter((key) => key.startsWith('HERDR_'))
    .join(',')}`,
]
process.stdout.write(`${lines.join('\n')}\n`)
