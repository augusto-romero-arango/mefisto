// Adaptador de prueba con assets suplementarios; `scenario` elige la declaracion, valida o rota.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import type { PublishedAdapter } from '../../../lib/published-adapter.mts'

const CONFIG = 'src/published/assets/config.txt'
const LAUNCHER = 'src/published/assets/launcher.txt'
const MARKDOWN = 'artefactos/valida con espacios.md'

const asset = (id: string, source: string, destination: string, mode = '0644'): Record<string, string> => ({
  id,
  source,
  destination,
  mode,
})

const NORMAL = [
  asset('config', CONFIG, 'runtime/config.json'),
  asset('launcher', LAUNCHER, 'bin/launcher', '0755'),
]

const SCENARIOS: Record<string, unknown> = {
  normal: NORMAL,
  'render-fallar': NORMAL,
  uno: [asset('config', CONFIG, 'runtime/config.json')],
  colision: [asset('colision', CONFIG, MARKDOWN)],
  'colision-anidada': [asset('colision', CONFIG, `${MARKDOWN}/hijo`)],
  duplicado: [asset('repetido', CONFIG, 'uno'), asset('repetido', LAUNCHER, 'dos')],
  'mismo-destino': [asset('uno', CONFIG, 'repetido'), asset('dos', LAUNCHER, 'repetido')],
  'destinos-anidados': [asset('uno', CONFIG, 'repetido'), asset('dos', LAUNCHER, 'repetido/hijo')],
  inventario: [asset('inventario', CONFIG, '.mefisto-generated-assets.json')],
  inseguro: [asset('inseguro', '../secret', 'x')],
  'id-inseguro': [asset('../inseguro', CONFIG, 'x')],
  'destino-inseguro': [asset('inseguro', CONFIG, '../x')],
  ausente: [asset('ausente', 'src/published/assets/no-existe', 'x')],
  symlink: [asset('symlink', 'src/published/assets/link', 'x')],
  modo: [asset('modo', CONFIG, 'x', '0600')],
  invalido: '{no-json}',
}

export function assetsAdapter(scenario = 'normal'): PublishedAdapter {
  return {
    name: 'adapter-assets.mts',
    root: () => 'dist/assets',
    path: (relSource) => `artefactos/${basename(relSource)}`,
    render: (source, marker) => `${marker}\nasset-adapter:${basename(source)}\n`,
    assets: () => {
      if (scenario === 'fallar') throw new Error('adapter-assets.mts: fallo al enumerar assets')
      return SCENARIOS[scenario]
    },
    renderAsset: (_id, source) => {
      if (scenario === 'render-fallar') throw new Error('adapter-assets.mts: fallo al renderizar asset')
      return `renderizado:${readFileSync(source, 'utf8').replace(/\n+$/, '')}\n`
    },
  }
}

export const createAdapter = (): PublishedAdapter => assetsAdapter()
