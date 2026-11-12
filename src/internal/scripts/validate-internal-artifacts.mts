// Valida agentes y comandos de src/internal/{agents,commands}/*.md contra el contrato neutral
// (MEF-ADR-0049) y el frontmatter YAML portable de src/internal/skills/<id>/SKILL.md.
//
// Uso: node src/internal/scripts/validate-internal-artifacts.mts [archivo...]
//   Sin argumentos valida todo src/internal/{agents,commands}/*.md y
//   src/internal/skills/*/SKILL.md, en orden determinista.
//
// Sale con 0 si todos los archivos son validos y con 1 si alguno se rechaza. Cada rechazo es
// una linea "<archivo>: <campo>: <motivo>".
//
// internal-artifact.schema.json es la unica declaracion de campos. Aqui solo vive lo que el
// schema no puede expresar porque no depende solo del frontmatter: la estructura del archivo,
// el `id` contra el nombre del archivo y la neutralidad del body.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isEntryPoint, runMain } from '../../../scripts/lib/cli.mts'
import { findSorted, isFile, stripRoot, toPosix } from './lib/artifact-sources.mts'
import { extractFrontmatter, fileLines } from './lib/frontmatter.mts'
import { isJsonObject } from './lib/jq-json.mts'
import type { Json, JsonObject } from './lib/jq-json.mts'
import { validateSchema } from './lib/jsonschema-lite.mts'
import { Output, chomp } from './lib/mefisto-script-io.mts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const SKILL_FILE = /^.*\/skills\/.*\/SKILL\.md$/s
const SKILL_RESOURCE = /^.*\/skills\/.*\/.*$/s

function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? ''
}

/** Fuentes que se validan cuando no se pasa ningun archivo. */
export function defaultValidatorSources(repoRoot: string): string[] {
  const internal = `${toPosix(repoRoot)}/src/internal`
  return [
    ...findSorted([`${internal}/agents`, `${internal}/commands`], (entry) => entry.name.endsWith('.md')),
    ...findSorted([`${internal}/skills`], (entry) => entry.name === 'SKILL.md'),
  ]
}

/**
 * Numeros de linea del body que nombran un runtime concreto: la fuente neutral describe
 * intenciones y esas referencias las introduce el generador. Dos formas literales quedan
 * fuera: `.claude-plugin` es el manifiesto fisico del plugin, identico en cualquier runtime, y
 * `.claude/scripts` guarda el hook de scope del adaptador y los tests internos.
 */
export function bodyRuntimeReferences(content: string): number[] {
  const lines = fileLines(content)
  if (lines[0] !== '---') return []
  const hits: number[] = []
  let inBody = false
  for (const [index, line] of lines.entries()) {
    if (index > 0 && line === '---' && !inBody) {
      inBody = true
      continue
    }
    if (!inBody) continue
    const rest = line.replace(/\.claude-plugin/g, '').replace(/\.claude\/scripts/g, '')
    if (/claude/i.test(rest)) hits.push(index + 1)
  }
  return hits
}

function validateFile(file: string, rel: string, schema: JsonObject, output: Output): boolean {
  if (!isFile(file)) {
    output.out(`${rel}: archivo: no existe o no es un archivo regular`)
    return false
  }
  const content = readFileSync(file, 'utf8')
  const extraction = extractFrontmatter(content)
  if (extraction.status === 1) {
    output.out(`${rel}: frontmatter: ausente (se esperaba un bloque '---' JSON al inicio del archivo)`)
    return false
  }
  if (extraction.status === 2) {
    output.out(
      `${rel}: frontmatter: sin delimitador de cierre (falta una linea '---' tras el objeto JSON)`,
    )
    return false
  }
  const frontmatter = chomp(extraction.text)
  if (frontmatter.length === 0) {
    output.out(`${rel}: frontmatter: bloque vacio (se esperaba un objeto JSON)`)
    return false
  }
  let instance: Json
  try {
    instance = JSON.parse(frontmatter) as Json
  } catch {
    output.out(`${rel}: frontmatter: no es JSON valido`)
    return false
  }

  let valid = true
  // El schema juzga primero: si `id` falta o no es una cadena, el motivo es el suyo.
  for (const error of validateSchema(schema, instance)) {
    output.out(`${rel}: ${error}`)
    valid = false
  }

  const id = isJsonObject(instance) && typeof instance.id === 'string' ? instance.id : ''
  const name = baseName(toPosix(file))
  const expected = name.endsWith('.md') && name !== '.md' ? name.slice(0, -'.md'.length) : name
  if (id.length > 0 && id !== expected) {
    output.out(`${rel}: id: '${id}' distinto del nombre de archivo '${expected}'`)
    valid = false
  }

  for (const line of bodyRuntimeReferences(content)) {
    output.out(
      `${rel}: body: linea ${line} nombra un runtime concreto; la fuente neutral es agnostica (CA-1)`,
    )
    valid = false
  }
  return valid
}

// Chequeo textual sobre las claves de primer nivel. El body de un Skill no pasa por la regla
// de neutralidad: documenta los adaptadores.
function validateSkill(file: string, rel: string, output: Output): boolean {
  if (!isFile(file)) {
    output.out(`${rel}: archivo: no existe o no es un archivo regular`)
    return false
  }
  const extraction = extractFrontmatter(readFileSync(file, 'utf8'))
  if (extraction.status === 1) {
    output.out(`${rel}: frontmatter: ausente (se esperaba un bloque '---' al inicio del archivo)`)
    return false
  }
  if (extraction.status === 2) {
    output.out(`${rel}: frontmatter: sin delimitador de cierre`)
    return false
  }
  const lines = chomp(extraction.text).split('\n')
  const directory = baseName(toPosix(file).replace(/\/+$/, '').replace(/\/[^/]*$/, ''))

  let valid = true
  const nameLine = lines.find((line) => line.startsWith('name:')) ?? ''
  const name = nameLine
    .replace(/^name:/, '')
    .replace(/^[ \t\n\v\f\r]+/, '')
    .replace(/[ \t\n\v\f\r]+$/, '')
    .replace(/^"(.*)"$/s, '$1')
  if (name.length === 0) {
    output.out(`${rel}: name: ausente`)
    valid = false
  } else if (name !== directory) {
    output.out(`${rel}: name: '${name}' distinto del directorio '${directory}'`)
    valid = false
  }
  if (!lines.some((line) => /^description:[ \t\n\v\f\r]*[^ \t\n\v\f\r]/.test(line))) {
    output.out(`${rel}: description: ausente o vacia`)
    valid = false
  }
  if (lines.some((line) => /^allowed-tools[ \t\n\v\f\r]*:/.test(line))) {
    output.out(`${rel}: allowed-tools: prohibido en un SKILL.md portable (MEF-ADR-0033)`)
    valid = false
  }
  return valid
}

/** Valida `files` (o las fuentes por defecto) e imprime un rechazo por linea. */
export function runValidator(files: string[], output: Output, repoRoot: string = REPO_ROOT): number {
  const schemaFile = `${toPosix(repoRoot)}/src/internal/contract/internal-artifact.schema.json`
  if (!isFile(schemaFile)) {
    output.err(`ERROR: no existe '${schemaFile}'`)
    return 1
  }
  const schema = JSON.parse(readFileSync(schemaFile, 'utf8')) as Json
  if (!isJsonObject(schema)) {
    output.err(`ERROR: '${schemaFile}' no es un objeto JSON`)
    return 1
  }

  let status = 0
  for (const file of files.length > 0 ? files : defaultValidatorSources(repoRoot)) {
    const path = toPosix(file)
    const rel = stripRoot(file, repoRoot)
    if (SKILL_FILE.test(path)) {
      if (!validateSkill(file, rel, output)) status = 1
    } else if (SKILL_RESOURCE.test(path)) {
      // Recurso de Nivel 3: no lleva frontmatter propio.
    } else if (!validateFile(file, rel, schema, output)) {
      status = 1
    }
  }
  return status
}

if (isEntryPoint(import.meta.url)) {
  runMain(() => runValidator(process.argv.slice(2), new Output(true)))
}
