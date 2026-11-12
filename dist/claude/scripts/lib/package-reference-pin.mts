// Pin de un `PackageReference` en un `.csproj`, leido como XML: el formato del elemento (orden de
// atributos, varias lineas, etiqueta de cierre) no cambia el resultado.

export interface XmlElement {
  /** Nombre sin prefijo de espacio de nombres. */
  name: string
  attributes: Map<string, string>
}

export class XmlError extends Error {}

const NAME = /[^\s<>/=!?"'&]+/y
const SPACE = /\s*/y
const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_][\w.-]*);/g
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(value: string): string {
  if (value.replace(ENTITY, '').includes('&')) throw new XmlError("'&' sin escapar")
  return value.replace(ENTITY, (_, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    const named = NAMED_ENTITIES[entity]
    if (named === undefined) throw new XmlError(`entidad sin definir &${entity};`)
    return named
  })
}

function matchAt(pattern: RegExp, text: string, position: number): string | null {
  pattern.lastIndex = position
  return pattern.exec(text)?.[0] ?? null
}

function closing(text: string, position: number, mark: string, what: string): number {
  const end = text.indexOf(mark, position)
  if (end === -1) throw new XmlError(`${what} sin cerrar`)
  return end + mark.length
}

/** Elementos del documento en orden de aparicion; lanza `XmlError` si no esta bien formado. */
export function xmlElements(source: string): XmlElement[] {
  const text = source.startsWith('﻿') ? source.slice(1) : source
  const elements: XmlElement[] = []
  const open: string[] = []
  let rootClosed = false
  let position = 0

  while (position < text.length) {
    const next = text.indexOf('<', position)
    const between = text.slice(position, next === -1 ? text.length : next)
    if (open.length === 0 && between.trim() !== '') throw new XmlError('texto fuera del elemento raiz')
    if (open.length > 0) decode(between)
    if (next === -1) break
    position = next

    if (text.startsWith('<!--', position)) {
      position = closing(text, position + 4, '-->', 'comentario')
    } else if (text.startsWith('<?', position)) {
      position = closing(text, position + 2, '?>', 'instruccion de proceso')
    } else if (text.startsWith('<![CDATA[', position)) {
      if (open.length === 0) throw new XmlError('CDATA fuera del elemento raiz')
      position = closing(text, position + 9, ']]>', 'CDATA')
    } else if (text.startsWith('<!', position)) {
      if (elements.length > 0) throw new XmlError('declaracion despues del elemento raiz')
      position = closing(text, position + 2, '>', 'declaracion')
    } else if (text.startsWith('</', position)) {
      const name = matchAt(NAME, text, position + 2)
      if (name === null) throw new XmlError('etiqueta de cierre sin nombre')
      const end = position + 2 + name.length + (matchAt(SPACE, text, position + 2 + name.length) ?? '').length
      if (text[end] !== '>') throw new XmlError(`etiqueta de cierre </${name}> mal formada`)
      if (open.pop() !== name) throw new XmlError(`etiqueta de cierre </${name}> sin su apertura`)
      rootClosed = open.length === 0
      position = end + 1
    } else {
      if (rootClosed) throw new XmlError('mas de un elemento raiz')
      const name = matchAt(NAME, text, position + 1)
      if (name === null) throw new XmlError("'<' sin nombre de elemento")
      const attributes = new Map<string, string>()
      position += 1 + name.length
      for (;;) {
        const gap = matchAt(SPACE, text, position) ?? ''
        position += gap.length
        if (text.startsWith('/>', position)) {
          rootClosed = open.length === 0
          position += 2
          break
        }
        if (text[position] === '>') {
          open.push(name)
          position += 1
          break
        }
        const attribute = matchAt(NAME, text, position)
        if (attribute === null || gap === '') throw new XmlError(`elemento <${name}> mal formado`)
        position += attribute.length
        position += (matchAt(SPACE, text, position) ?? '').length
        if (text[position] !== '=') throw new XmlError(`atributo ${attribute} sin valor en <${name}>`)
        position += 1 + (matchAt(SPACE, text, position + 1) ?? '').length
        const quote = text[position]
        if (quote !== '"' && quote !== "'") throw new XmlError(`atributo ${attribute} sin comillas en <${name}>`)
        const end = text.indexOf(quote, position + 1)
        if (end === -1) throw new XmlError(`atributo ${attribute} sin cerrar en <${name}>`)
        const value = text.slice(position + 1, end)
        if (value.includes('<')) throw new XmlError(`'<' dentro del atributo ${attribute} de <${name}>`)
        if (attributes.has(attribute)) throw new XmlError(`atributo ${attribute} repetido en <${name}>`)
        attributes.set(attribute, decode(value))
        position = end + 1
      }
      elements.push({ name: name.slice(name.lastIndexOf(':') + 1), attributes })
    }
  }

  if (open.length > 0) throw new XmlError(`elemento <${open.at(-1) ?? ''}> sin cerrar`)
  if (elements.length === 0) throw new XmlError('no hay elemento raiz')
  return elements
}

/** `null` si `content` declara una sola vez `packageId` con `Version` igual a `expected`; si no, el mensaje de error. */
export function packagePinError(
  packageId: string,
  expected: string,
  file: string,
  content: string,
): string | null {
  const prefix = `ERROR: paquete ${packageId}: se esperaba`
  let elements: XmlElement[]
  try {
    elements = xmlElements(content)
  } catch (error) {
    if (!(error instanceof XmlError)) throw error
    return `${prefix} el pin ${expected} en ${file}, pero el XML no es valido: ${error.message}.`
  }
  const references = elements.filter(
    (element) => element.name === 'PackageReference' && element.attributes.get('Include') === packageId,
  )
  const [reference] = references
  if (references.length !== 1 || reference === undefined) {
    return `${prefix} exactamente una referencia con pin ${expected} en ${file}; se encontraron ${references.length}.`
  }
  const version = reference.attributes.get('Version')
  if (version === expected) return null
  return `${prefix} el pin ${expected} en ${file}; se encontro ${version || 'ningun valor'} como atributo Version.`
}
