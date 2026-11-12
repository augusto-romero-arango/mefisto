// Lee y escribe valores JSON desde los bloques de bash de comandos y agentes, sin `jq` ni
// `python3` (MEF-ADR-0057, decision 9). `-` como archivo lee la entrada estandar. Cada forma
// reproduce la salida del filtro de jq de su derecha:
//
//   get <archivo|-> <ruta>                    jq -r '.ruta'  (lo ausente imprime `null`)
//   get ... --or-empty                        jq -r '.ruta // empty'
//   get ... --default <texto>                 jq -r '.ruta // "texto"'
//   each <archivo|-> <ruta>                   jq -r '.ruta[]'
//   each ... --or-empty                       jq -r '.ruta // [] | .[]'
//   each ... --where <c>=<v> --field <f>      jq -r '.ruta | map(select(.c == "v")) | .[].f'
//   each ... --last <n>                       solo los ultimos n ('.[-n:]')
//   each ... --join <sep>                     jq -r '.ruta | join(sep)'
//   length <archivo|-> <ruta>                 jq -r '.ruta // [] | length'
//   pick <archivo|-> <clave>...               jq -r '{clave, ...}'
//   set <archivo> <a.b> <texto>               jq '.a = ((.a // {}) + {b: $texto})', sobre el archivo
//   from-lines                                jq -R . | jq -s -c .
//   validate <archivo|->                      python3 -m json.tool > /dev/null
//   csproj-pin <paquete> <version> <csproj>   un solo PackageReference del paquete, con ese Version
//
// Codigos de salida: 0; 2 si la entrada no se puede leer, no es JSON o el uso es invalido; 5 si
// el dato no admite la ruta (el de jq). `validate` y `csproj-pin` salen con 1 al fallar.

import { readFileSync } from 'node:fs'

import { isEntryPoint } from './lib/cli.mts'
import { replaceFile } from './lib/harness-config.mts'
import { parseJqStream } from './lib/jq-literals.mts'
import type { JqValue } from './lib/jq-literals.mts'
import { JqError } from './lib/jq-values.mts'
import {
  PathError,
  documentText,
  eachValues,
  getLines,
  isJsonDocument,
  joinValues,
  lengthText,
  linesToArray,
  parsePath,
  pick,
  rawText,
  setText,
} from './lib/json-value.mts'
import type { Fallback, FieldEquals } from './lib/json-value.mts'
import { packagePinError } from './lib/package-reference-pin.mts'

export const USAGE = [
  'Uso: node json-value.mts <subcomando> ...',
  '  get <archivo|-> <ruta> [--default <texto> | --or-empty]',
  '  each <archivo|-> <ruta> [--or-empty] [--where <campo>=<valor>]... [--field <campo>] [--last <n>] [--join <separador>]',
  '  length <archivo|-> <ruta>',
  '  pick <archivo|-> <clave>...',
  '  set <archivo> <ruta> <texto>',
  '  from-lines',
  '  validate <archivo|->',
  '  csproj-pin <paquete> <version> <archivo.csproj>',
  'Ruta: claves separadas por punto, con indices entre corchetes (boundedContext.domains[0]); "." es la raiz.',
].join('\n')

export interface Io {
  /** Lanza si el archivo no se puede leer. */
  readFile: (path: string) => string
  readStdin: () => string
  replaceFile: (path: string, content: string) => void
  out: (text: string) => void
  err: (text: string) => void
}

class UsageError extends Error {}

const SWITCHES = ['--or-empty']

interface Parsed {
  positional: string[]
  values: Map<string, string[]>
  switches: Set<string>
}

function parseArguments(argv: readonly string[], allowed: readonly string[]): Parsed {
  const parsed: Parsed = { positional: [], values: new Map(), switches: new Set() }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? ''
    if (!argument.startsWith('--')) {
      parsed.positional.push(argument)
    } else if (!allowed.includes(argument)) {
      throw new UsageError(`opcion desconocida: ${argument}`)
    } else if (SWITCHES.includes(argument)) {
      parsed.switches.add(argument)
    } else {
      const value = argv[++index]
      if (value === undefined) throw new UsageError(`falta el valor de ${argument}`)
      parsed.values.set(argument, [...(parsed.values.get(argument) ?? []), value])
    }
  }
  return parsed
}

function single(parsed: Parsed, flag: string): string | undefined {
  const values = parsed.values.get(flag) ?? []
  if (values.length > 1) throw new UsageError(`${flag} solo se admite una vez`)
  return values[0]
}

function positionals(parsed: Parsed, count: number): string[] {
  if (parsed.positional.length !== count) throw new UsageError('numero de argumentos invalido')
  return parsed.positional
}

function condition(text: string): FieldEquals {
  const separator = text.indexOf('=')
  if (separator <= 0) throw new UsageError(`--where espera <campo>=<valor>: ${text}`)
  return { field: text.slice(0, separator), value: text.slice(separator + 1) }
}

function count(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  if (!/^[1-9]\d*$/.test(text)) throw new UsageError(`--last espera un entero positivo: ${text}`)
  return Number(text)
}

function fail(io: Io, message: string, code: number): number {
  io.err(`json-value: ${message}\n`)
  return code
}

function readSource(io: Io, source: string): string | null {
  try {
    return source === '-' ? io.readStdin() : io.readFile(source)
  } catch {
    return null
  }
}

/** Aplica `lines` a cada valor JSON de la entrada, como jq: lo ya impreso se queda si despues falla. */
function evaluate(io: Io, source: string, lines: (root: JqValue) => Iterable<string>): number {
  const text = readSource(io, source)
  if (text === null) return fail(io, `no se pudo leer ${source}`, 2)
  const stream = parseJqStream(text)
  let code = 0
  for (const root of stream.values) {
    try {
      for (const line of lines(root)) io.out(`${line}\n`)
    } catch (error) {
      if (!(error instanceof JqError)) throw error
      code = fail(io, error.message, 5)
    }
  }
  return stream.clean ? code : fail(io, `${source === '-' ? 'la entrada' : source} no es JSON valido`, 2)
}

function get(io: Io, argv: readonly string[]): number {
  const parsed = parseArguments(argv, ['--default', '--or-empty'])
  const [source = '', path = ''] = positionals(parsed, 2)
  const text = single(parsed, '--default')
  const orEmpty = parsed.switches.has('--or-empty')
  if (text !== undefined && orEmpty) throw new UsageError('--default y --or-empty son excluyentes')
  const fallback: Fallback =
    text !== undefined ? { kind: 'text', text } : orEmpty ? { kind: 'empty' } : { kind: 'raw' }
  const steps = parsePath(path)
  return evaluate(io, source, (root) => getLines(root, steps, fallback))
}

function each(io: Io, argv: readonly string[]): number {
  const parsed = parseArguments(argv, ['--or-empty', '--where', '--field', '--last', '--join'])
  const [source = '', path = ''] = positionals(parsed, 2)
  const steps = parsePath(path)
  const options = {
    orEmpty: parsed.switches.has('--or-empty'),
    where: (parsed.values.get('--where') ?? []).map(condition),
    field: single(parsed, '--field'),
    last: count(single(parsed, '--last')),
  }
  const separator = single(parsed, '--join')
  return evaluate(io, source, (root) => {
    const values = eachValues(root, steps, options)
    return separator === undefined ? values.map(rawText) : [joinValues(values, separator)]
  })
}

function set(io: Io, argv: readonly string[]): number {
  if (argv.length !== 3) throw new UsageError('numero de argumentos invalido')
  const [file = '', path = '', text = ''] = argv
  const steps = parsePath(path)
  const keys = steps.filter((step) => typeof step === 'string')
  if (keys.length !== steps.length) throw new UsageError('set no admite indices en la ruta')
  const content = readSource(io, file)
  if (content === null) return fail(io, `no se pudo leer ${file}`, 2)
  const stream = parseJqStream(content)
  const [root] = stream.values
  if (!stream.clean || stream.values.length !== 1 || root === undefined) {
    return fail(io, `${file} no es un unico documento JSON; no se modifico`, 2)
  }
  let updated: JqValue
  try {
    updated = setText(root, keys, text)
  } catch (error) {
    if (!(error instanceof JqError)) throw error
    return fail(io, `${error.message}; no se modifico ${file}`, 5)
  }
  io.replaceFile(file, documentText(updated))
  return 0
}

function validate(io: Io, argv: readonly string[]): number {
  const [source = ''] = positionals(parseArguments(argv, []), 1)
  const text = readSource(io, source)
  const name = source === '-' ? 'la entrada' : source
  if (text === null) return fail(io, `no se pudo leer ${name}`, 1)
  return isJsonDocument(text) ? 0 : fail(io, `${name} no es un documento JSON valido`, 1)
}

function csprojPin(io: Io, argv: readonly string[]): number {
  if (argv.length !== 3) throw new UsageError('numero de argumentos invalido')
  const [packageId = '', expected = '', file = ''] = argv
  const content = readSource(io, file)
  const error =
    content === null
      ? `ERROR: paquete ${packageId}: se esperaba el pin ${expected} en ${file}, pero el archivo no se pudo leer.`
      : packagePinError(packageId, expected, file, content)
  if (error === null) return 0
  io.out(`${error}\n`)
  return 1
}

const COMMANDS: Record<string, (io: Io, argv: readonly string[]) => number> = {
  get,
  each,
  length: (io, argv) => {
    const [source = '', path = ''] = positionals(parseArguments(argv, []), 2)
    const steps = parsePath(path)
    return evaluate(io, source, (root) => [lengthText(root, steps)])
  },
  pick: (io, argv) => {
    const [source, ...keys] = parseArguments(argv, []).positional
    if (source === undefined || keys.length === 0) throw new UsageError('numero de argumentos invalido')
    return evaluate(io, source, (root) => [rawText(pick(root, keys))])
  },
  set,
  'from-lines': (io, argv) => {
    positionals(parseArguments(argv, []), 0)
    io.out(`${linesToArray(io.readStdin())}\n`)
    return 0
  },
  validate,
  'csproj-pin': csprojPin,
}

export function jsonValue(argv: readonly string[], io: Io): number {
  const [name, ...rest] = argv
  const command = name !== undefined && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined
  try {
    if (command === undefined) throw new UsageError(`subcomando desconocido: ${name ?? ''}`)
    return command(io, rest)
  } catch (error) {
    if (!(error instanceof UsageError) && !(error instanceof PathError)) throw error
    return fail(io, `${error.message}\n${USAGE}`, 2)
  }
}

const PROCESS_IO: Io = {
  readFile: (path) => readFileSync(path, 'utf8'),
  readStdin: () => {
    try {
      return readFileSync(0, 'utf8')
    } catch {
      return ''
    }
  },
  replaceFile,
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = jsonValue(process.argv.slice(2), PROCESS_IO)
}
