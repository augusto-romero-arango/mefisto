// Adaptador de prueba: ubica el marcador despues de su frontmatter y falla con las fuentes `fallar`.

import { basename } from 'node:path'

import type { PublishedAdapter } from '../../../lib/published-adapter.mts'

export function createAdapter(): PublishedAdapter {
  return {
    name: 'adapter-beta.mts',
    root: () => 'dist/beta',
    path: (relSource) => `artefactos/${basename(relSource)}`,
    render: (source, marker) => {
      if (basename(source).includes('fallar')) throw new Error('fallo fixture beta')
      return `---\nruntime: beta\n---\n${marker}\nbeta:${basename(source)}\n`
    },
  }
}
