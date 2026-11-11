// Adaptador de prueba: solo Markdown, con el marcador en la primera linea.

import { basename } from 'node:path'

import type { PublishedAdapter } from '../../../lib/published-adapter.mts'

export function createAdapter(): PublishedAdapter {
  return {
    name: 'adapter-alpha.mts',
    root: () => 'dist/alpha',
    path: (relSource) => `artefactos/${basename(relSource)}`,
    render: (source, marker) => `${marker}\nalpha:${basename(source)}\n`,
  }
}
