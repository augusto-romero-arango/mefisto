// Adaptador de prueba de regresion (issue #1499): declara `count` assets sobre una misma fuente,
// para probar que detectar colisiones no vuelve a costar minutos.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import type { PublishedAdapter } from '../../../lib/published-adapter.mts'

export function manyAssetsAdapter(count = 160): PublishedAdapter {
  return {
    name: 'adapter-many-assets.mts',
    root: () => 'dist/many',
    path: (relSource) => `artefactos/${basename(relSource)}`,
    render: (source, marker) => `${marker}\nmany:${basename(source)}\n`,
    assets: () =>
      Array.from({ length: count }, (_, index) => ({
        id: `asset-${index + 1}`,
        source: 'src/published/assets/config.txt',
        destination: `generated/asset-${index + 1}.txt`,
        mode: '0644',
      })),
    renderAsset: (_id, source) => `renderizado:${readFileSync(source, 'utf8').replace(/\n+$/, '')}\n`,
  }
}

export const createAdapter = (): PublishedAdapter => manyAssetsAdapter()
