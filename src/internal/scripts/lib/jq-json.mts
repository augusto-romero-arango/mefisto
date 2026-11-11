// JSON compacto con el escapado de jq (`tojson`, `@json`, `-c`): los adaptadores generados
// llevan esos bytes versionados.

export type Json = null | boolean | number | string | Json[] | JsonObject
export interface JsonObject {
  [key: string]: Json
}

export function isJsonObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const SHORT_ESCAPES = new Map([
  ['"', '\\"'],
  ['\\', '\\\\'],
  ['\n', '\\n'],
  ['\t', '\\t'],
  ['\r', '\\r'],
  ['\b', '\\b'],
  ['\f', '\\f'],
])

function jqString(text: string): string {
  let out = '"'
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const short = SHORT_ESCAPES.get(char)
    if (short !== undefined) out += short
    // jq escapa tambien DEL, que JSON.stringify deja pasar.
    else if (code < 32 || code === 127) out += `\\u${code.toString(16).padStart(4, '0')}`
    // jq sustituye un surrogate suelto por U+FFFD.
    else if (code >= 0xd800 && code <= 0xdfff) out += '�'
    else out += char
  }
  return `${out}"`
}

export function jqJson(value: Json): string {
  if (typeof value === 'string') return jqString(value)
  if (Array.isArray(value)) return `[${value.map(jqJson).join(',')}]`
  if (isJsonObject(value)) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${jqString(key)}:${jqJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** Como `jq -r`: una cadena sale sin comillas; lo demas, como JSON compacto. */
export function jqRaw(value: Json): string {
  return typeof value === 'string' ? value : jqJson(value)
}
