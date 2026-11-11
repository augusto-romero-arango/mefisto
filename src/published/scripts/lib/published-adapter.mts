// Interfaz que el generador publicado exige a cada `adapters/adapter-<runtime>.mts`. El motor no
// interpreta frontmatter, directivas, capacidades, modelos ni permisos: eso es del adaptador.

export interface AdapterContext {
  /** Raiz real del repo cuyas fuentes se renderizan. */
  repoRoot: string
}

export interface PublishedAdapter {
  /** Identidad del adaptador en el inventario y en los diagnosticos. */
  name: string
  /** Raiz relativa bajo la salida; debe ser `dist/<runtime>`. */
  root(): string
  /** Ruta, relativa a su raiz, del archivo que renderiza `relSource`. */
  path(relSource: string): string
  /** Contenido completo del archivo; incluye `marker` como una linea completa. */
  render(source: string, marker: string): string
  /** Assets suplementarios: objetos con `id`, `source`, `destination` y `mode` (0644 o 0755). */
  assets?(): unknown
  renderAsset?(id: string, source: string): string
}

/** Modulo `adapter-<runtime>.mts`: exporta la fabrica de su adaptador. */
export interface AdapterModule {
  createAdapter(context: AdapterContext): PublishedAdapter
}

/** Fallo previsto de un adaptador; su mensaje va tal cual a stderr. */
export class AdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdapterError'
  }
}
