// Gate de pines OpenTelemetry del scaffold de un dominio: cada `.csproj` lleva exactamente una
// `PackageReference` del paquete, con el pin canonico en su atributo `Version`.
//
// Lee el XML con un analizador minimo que rechaza los documentos mal formados (etiquetas que no
// cierran, entidades desconocidas, basura fuera de la raiz). La causa que reporta imita la de
// expat (`mismatched tag: line 1, column 30`), pero no siempre coincide palabra por palabra.

import { readFileSync, statSync } from 'node:fs'

export const OTEL_PIN_CANONICO = '1.15.3'

export interface XmlElement {
  /** Nombre sin prefijo de espacio de nombres. */
  localName: string
  attributes: ReadonlyMap<string, string>
}

export class XmlError extends Error {
  constructor(reason: string, text: string, index: number) {
    const before = text.slice(0, index).split('\n')
    super(`${reason}: line ${before.length}, column ${(before.at(-1) ?? '').length}`)
    this.name = 'XmlError'
  }
}

const NAME = /[A-Za-z_:][A-Za-z0-9_:.\-]*/y
const SPACE = /[ \t\r\n]*/y
const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decode(raw: string, text: string, offset: number): string {
  return raw.replace(/&([^;&<]*);?/g, (match, ref: string, at: number) => {
    if (!match.endsWith(';')) throw new XmlError('not well-formed (invalid token)', text, offset + at)
    if (Object.hasOwn(ENTITIES, ref)) return ENTITIES[ref] ?? ''
    const numeric = /^#(?:x([0-9A-Fa-f]+)|([0-9]+))$/.exec(ref)
    if (numeric === null) throw new XmlError('undefined entity', text, offset + at)
    const code = numeric[1] !== undefined ? Number.parseInt(numeric[1], 16) : Number(numeric[2])
    if (code === 0 || code > 0x10ffff) throw new XmlError('reference to invalid character number', text, offset + at)
    return String.fromCodePoint(code)
  })
}

/** Elementos del documento en orden; lanza `XmlError` si no esta bien formado. */
export function parseXmlElements(text: string): XmlElement[] {
  const elements: XmlElement[] = []
  const open: string[] = []
  let rootClosed = false
  let rootSeen = false
  let i = text.startsWith('﻿') ? 1 : 0

  const match = (pattern: RegExp): string => {
    pattern.lastIndex = i
    const found = pattern.exec(text)
    if (found === null) return ''
    i += found[0].length
    return found[0]
  }
  const skipTo = (terminator: string): void => {
    const end = text.indexOf(terminator, i)
    if (end === -1) throw new XmlError('unclosed token', text, i)
    i = end + terminator.length
  }

  while (i < text.length) {
    const lt = text.indexOf('<', i)
    const chunk = text.slice(i, lt === -1 ? text.length : lt)
    if (chunk.length > 0) {
      if (open.length > 0) decode(chunk, text, i)
      else if (/[^ \t\r\n]/.test(chunk)) {
        const at = i + chunk.search(/[^ \t\r\n]/)
        throw new XmlError(rootClosed ? 'junk after document element' : 'not well-formed (invalid token)', text, at)
      }
      i += chunk.length
    }
    if (lt === -1) break
    const start = i
    if (text.startsWith('<?', i)) {
      skipTo('?>')
    } else if (text.startsWith('<!--', i)) {
      skipTo('-->')
    } else if (text.startsWith('<![CDATA[', i)) {
      if (open.length === 0) throw new XmlError('syntax error', text, start)
      skipTo(']]>')
    } else if (text.startsWith('<!DOCTYPE', i)) {
      if (rootSeen) throw new XmlError('syntax error', text, start)
      const bracket = text.indexOf('[', i)
      const close = text.indexOf('>', i)
      if (bracket !== -1 && (close === -1 || bracket < close)) skipTo(']')
      skipTo('>')
    } else if (text.startsWith('</', i)) {
      i += 2
      const name = match(NAME)
      match(SPACE)
      if (name.length === 0 || text[i] !== '>') throw new XmlError('not well-formed (invalid token)', text, i)
      if (open.at(-1) !== name) throw new XmlError('mismatched tag', text, start + 2)
      open.pop()
      i++
      if (open.length === 0) rootClosed = true
    } else {
      i++
      const name = match(NAME)
      if (name.length === 0) throw new XmlError('not well-formed (invalid token)', text, i)
      if (rootClosed) throw new XmlError('junk after document element', text, start)
      const attributes = new Map<string, string>()
      for (;;) {
        const space = match(SPACE)
        if (text.startsWith('/>', i) || text[i] === '>') break
        const attributeStart = i
        const attribute = space.length > 0 ? match(NAME) : ''
        if (attribute.length === 0) throw new XmlError('not well-formed (invalid token)', text, i)
        match(SPACE)
        if (text[i] !== '=') throw new XmlError('not well-formed (invalid token)', text, i)
        i++
        match(SPACE)
        const quote = text[i]
        if (quote !== '"' && quote !== "'") throw new XmlError('not well-formed (invalid token)', text, i)
        const end = text.indexOf(quote, i + 1)
        if (end === -1) throw new XmlError('unclosed token', text, start)
        const raw = text.slice(i + 1, end)
        const bad = raw.indexOf('<')
        if (bad !== -1) throw new XmlError('not well-formed (invalid token)', text, i + 1 + bad)
        if (attributes.has(attribute)) throw new XmlError('duplicate attribute', text, attributeStart)
        attributes.set(attribute, decode(raw, text, i + 1).replace(/[\t\n\r]/g, ' '))
        i = end + 1
      }
      const localName = name.slice(name.lastIndexOf(':') + 1)
      elements.push({ localName, attributes })
      rootSeen = true
      if (text[i] === '/') {
        i += 2
        if (open.length === 0) rootClosed = true
      } else {
        i++
        open.push(name)
      }
    }
  }
  if (!rootSeen || open.length > 0) throw new XmlError('no element found', text, text.length)
  return elements
}

/**
 * `null` si `file` trae exactamente una referencia a `paquete` con `version`; si no, el
 * diagnostico que nombra paquete, pin y archivo.
 */
export function checkOtelPin(paquete: string, version: string, file: string): string | null {
  let isFile = false
  try {
    isFile = statSync(file).isFile()
  } catch {
    isFile = false
  }
  if (!isFile) return `ERROR: paquete ${paquete}: se esperaba el pin ${version} en ${file}, pero el archivo no existe.`
  let elements: XmlElement[]
  try {
    elements = parseXmlElements(readFileSync(file, 'utf8'))
  } catch (error) {
    if (!(error instanceof XmlError)) throw error
    return `ERROR: paquete ${paquete}: se esperaba el pin ${version} en ${file}, pero el XML no es valido: ${error.message}.`
  }
  const references = elements.filter((element) => element.localName === 'PackageReference' && element.attributes.get('Include') === paquete)
  if (references.length !== 1) {
    return `ERROR: paquete ${paquete}: se esperaba exactamente una referencia con pin ${version} en ${file}; se encontraron ${references.length}.`
  }
  const actual = references[0]?.attributes.get('Version')
  if (actual !== version) {
    return `ERROR: paquete ${paquete}: se esperaba el pin ${version} en ${file}; se encontro ${actual === undefined || actual.length === 0 ? 'ningun valor' : actual} como atributo Version.`
  }
  return null
}
