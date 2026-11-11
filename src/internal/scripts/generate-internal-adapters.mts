// Genera el adaptador .claude/ a partir de la fuente neutral src/internal/{agents,commands}/*.md
// y de los Agent Skills (MEF-ADR-0049, MEF-ADR-0033). Valida primero con
// validate-internal-artifacts.mts: si algun artefacto de origen falla, no escribe nada.
//
// Uso:
//   node src/internal/scripts/generate-internal-adapters.mts [--check] [--out <dir>] [archivo...]
//
//   Sin archivos procesa toda la fuente, en orden determinista. Con archivos procesa exactamente
//   esos, en el orden recibido.
//
//   --out <dir>   Raiz alternativa donde leer y escribir .claude/{agents,commands,skills}. Los
//                 tests la usan para no tocar el .claude/ real.
//   --check       No escribe nada: compara lo generado contra lo versionado bajo la raiz de
//                 salida. Imprime "<ruta>: faltante|distinta|huerfana|sin marcador" por
//                 divergencia y sale con 1; con 0 si todo coincide. Todo .md bajo
//                 .claude/{agents,commands} y todo SKILL.md bajo .claude/skills debe llevar el
//                 marcador de generado.
//
// Skills: la fuente canonica es src/internal/skills/<id>/ (SKILL.md con frontmatter YAML
// portable y recursos de Nivel 3) y sale a .claude/skills/<id>/, con el marcador tras el
// frontmatter de SKILL.md. Con el mismo tratamiento se proyectan los Skills publicados de
// skills/<id>/ cuyo id esta en PUBLISHED_PROJECTED_SKILLS: el plugin no se instala sobre si
// mismo, asi que ningun runtime los carga aqui sin esa proyeccion. Un id presente a la vez en
// src/internal/skills/ y en esa lista aborta.
//
// Sale con 1 si la validacion previa falla, si un archivo trae una directiva de body
// desconocida o una capacidad sin mapeo, o si --check encuentra divergencias.
//
// Determinismo: el marcador no lleva fecha ni hash, y dos corridas con la misma entrada
// producen los mismos bytes.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isEntryPoint, runMain } from '../../../scripts/lib/cli.mts'
import { AdapterError, claudeRender } from './lib/adapter-claude.mts'
import { findSorted, isDirectory, isFile, stripRoot, toPosix } from './lib/artifact-sources.mts'
import { extractBody, extractFrontmatter } from './lib/frontmatter.mts'
import { isJsonObject, jqRaw } from './lib/jq-json.mts'
import type { Json } from './lib/jq-json.mts'
import { Output, chomp } from './lib/mefisto-script-io.mts'
import { runValidator } from './validate-internal-artifacts.mts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// El marcador nombra el .sh: es el comando que se invoca y su texto esta en cada archivo generado.
const MARKER_SOURCE_SCRIPT = 'src/internal/scripts/generate-internal-adapters.sh'
const MARKER_PREFIX = `<!-- GENERADO por ${MARKER_SOURCE_SCRIPT} desde `
export const PUBLISHED_PROJECTED_SKILLS = ['code-comments']

const INTERNAL_SKILLS = 'src/internal/skills/'

function markerLine(relSource: string): string {
  return `${MARKER_PREFIX}${relSource}. No editar a mano. -->`
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function afterLast(path: string, marker: string): string {
  return path.slice(path.lastIndexOf(marker) + marker.length)
}

/**
 * "<id>/<ruta-en-el-skill>" si `path` cae bajo src/internal/skills/<id>/ o bajo skills/<id>/
 * con <id> proyectado; si no, ''. Acotado a esas raices para que un `skills/` en otra parte de
 * la ruta no desvie un agente o un comando.
 */
export function skillRelParts(path: string): string {
  if (/^(.*\/)?src\/internal\/skills\/.*\/.*$/s.test(path)) return afterLast(path, INTERNAL_SKILLS)
  for (const id of PUBLISHED_PROJECTED_SKILLS) {
    const root = `skills/${id}/`
    if (path.startsWith(root) || path.includes(`/${root}`)) return `${id}/${afterLast(path, root)}`
  }
  return ''
}

function isInternalSkill(path: string): boolean {
  return path.startsWith(INTERNAL_SKILLS) || path.includes(`/${INTERNAL_SKILLS}`)
}

function defaultSources(repoRoot: string, output: Output): string[] | null {
  const root = toPosix(repoRoot)
  const files = [
    ...findSorted([`${root}/src/internal/agents`, `${root}/src/internal/commands`], (entry) =>
      entry.name.endsWith('.md'),
    ),
    ...findSorted([`${root}/src/internal/skills`], (entry) => entry.isFile()),
  ]
  for (const id of PUBLISHED_PROJECTED_SKILLS) {
    if (!isDirectory(`${root}/skills/${id}`)) {
      output.err(`ERROR: skills/${id}/ no existe pero esta en PUBLISHED_PROJECTED_SKILLS`)
      return null
    }
    files.push(...findSorted([`${root}/skills/${id}`], (entry) => entry.isFile()))
  }
  return files
}

interface Staged {
  /** `null` si la fuente no se pudo leer. */
  content: Buffer | null
  /** Fuente que se copia tal cual (recurso de un Skill). */
  copyFrom?: string
}

function hasMarker(path: string): boolean {
  const content = readText(path)
  if (content === null) return false
  return (extractBody(content).text.split('\n')[0] ?? '').startsWith(MARKER_PREFIX)
}

export function runGenerator(argv: string[], output: Output, repoRoot: string = REPO_ROOT): number {
  let check = false
  let outRoot = repoRoot
  let files: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? ''
    if (arg === '--check') {
      check = true
    } else if (arg === '--out') {
      const dir = argv[index + 1]
      if (dir === undefined) {
        output.err('ERROR: --out requiere un directorio')
        return 1
      }
      outRoot = dir
      index++
    } else {
      files.push(arg)
    }
  }

  if (files.length === 0) {
    const sources = defaultSources(repoRoot, output)
    if (sources === null) return 1
    files = sources
  }

  const validation = new Output()
  if (runValidator(files, validation, repoRoot) !== 0) {
    const report = chomp(validation.stderr + validation.stdout)
    if (report.length > 0) output.err(report)
    output.err('ERROR: validacion previa (validate-internal-artifacts.sh) fallo; no se genero nada')
    return 1
  }

  // Con --check no se crea ni el directorio de salida: si falta, todo sale como "faltante".
  if (!check) mkdirSync(outRoot, { recursive: true })
  if (isDirectory(outRoot)) outRoot = resolve(outRoot)
  outRoot = toPosix(outRoot)

  const staged = new Map<string, Staged>()
  const generated: string[] = []
  const internalSkillIds = new Set<string>()
  const publishedSkillIds = new Set<string>()
  let failed = false

  for (const file of files) {
    const path = toPosix(file)
    const relSource = stripRoot(file, repoRoot)

    const skillPart = skillRelParts(path)
    if (skillPart.length > 0) {
      const id = skillPart.split('/')[0] ?? ''
      if (isInternalSkill(path)) internalSkillIds.add(id)
      else publishedSkillIds.add(id)
      const relPath = `.claude/skills/${skillPart}`
      if (skillPart.split('/').pop() === 'SKILL.md') {
        const content = readText(file) ?? ''
        const frontmatter = chomp(extractFrontmatter(content).text)
        if (frontmatter.length === 0) {
          output.err(
            `ERROR: ${relSource}: no se pudo extraer el frontmatter (deberia haber pasado la validacion previa)`,
          )
          failed = true
          continue
        }
        const body = chomp(extractBody(content).text)
        const text = ['---', frontmatter, '---', markerLine(relSource), body, ''].join('\n')
        staged.set(relPath, { content: Buffer.from(text) })
      } else {
        let content: Buffer | null = null
        try {
          content = readFileSync(file)
        } catch {
          output.err(`ERROR: ${relSource}: no se pudo leer`)
        }
        staged.set(relPath, { content, copyFrom: file })
      }
      generated.push(relPath)
      continue
    }

    // Skill publicado fuera de la lista: no se proyecta. Se ancla a la ruta relativa para que
    // un `skills/` ancestro del clon no salte agentes.
    if (/^skills\/.*\/.*$/s.test(relSource) || (isAbsolute(relSource) && /.\/skills\/.*\/.*$/s.test(relSource))) continue

    const content = readText(file) ?? ''
    const frontmatter = chomp(extractFrontmatter(content).text)
    if (frontmatter.length === 0) {
      output.err(
        `ERROR: ${relSource}: no se pudo extraer el frontmatter (deberia haber pasado la validacion previa)`,
      )
      failed = true
      continue
    }
    let instance: Json
    try {
      instance = JSON.parse(frontmatter) as Json
    } catch {
      output.err(
        `ERROR: ${relSource}: frontmatter no es JSON valido (deberia haber pasado la validacion previa)`,
      )
      failed = true
      continue
    }
    const fields = isJsonObject(instance) ? instance : {}
    const body = chomp(extractBody(content).text)
    let rendered: string
    try {
      rendered = claudeRender(relSource, fields, markerLine(relSource), body)
    } catch (error) {
      if (!(error instanceof AdapterError)) throw error
      output.err(error.message)
      failed = true
      continue
    }
    const relPath = `.claude/${jqRaw(fields.kind ?? null)}s/${jqRaw(fields.id ?? null)}.md`
    staged.set(relPath, { content: Buffer.from(`${chomp(rendered)}\n`) })
    generated.push(relPath)
  }

  for (const id of PUBLISHED_PROJECTED_SKILLS) {
    if (internalSkillIds.has(id) && publishedSkillIds.has(id)) {
      output.err(
        `ERROR: el id de Skill '${id}' existe en src/internal/skills/ y en la lista de Skills publicados proyectados (skills/${id}/); renombra uno o quita el duplicado`,
      )
      failed = true
    }
  }

  if (failed) {
    output.err('ERROR: la generacion aborto; no se escribio nada')
    return 1
  }

  if (check) {
    let divergence = 0
    const report = (relPath: string, state: string): void => {
      output.out(`${relPath}: ${state}`)
      divergence = 1
    }

    for (const relPath of generated) {
      const existing = `${outRoot}/${relPath}`
      const content = staged.get(relPath)?.content ?? null
      if (!isFile(existing)) report(relPath, 'faltante')
      else if (content === null || !content.equals(readFileSync(existing))) report(relPath, 'distinta')
    }

    const adapters = findSorted([`${outRoot}/.claude/agents`, `${outRoot}/.claude/commands`], (entry) =>
      entry.name.endsWith('.md'),
    )
    for (const existing of adapters) {
      const relPath = stripRoot(existing, outRoot)
      if (!hasMarker(existing)) report(relPath, 'sin marcador')
      else if (!generated.includes(relPath)) report(relPath, 'huerfana')
    }

    // Un SKILL.md exige marcador; todo archivo bajo .claude/skills debe estar entre lo generado.
    for (const existing of findSorted([`${outRoot}/.claude/skills`], (entry) => entry.isFile())) {
      const relPath = stripRoot(existing, outRoot)
      if (relPath.split('/').pop() === 'SKILL.md' && !hasMarker(existing)) {
        report(relPath, 'sin marcador')
      } else if (!generated.includes(relPath)) {
        report(relPath, 'huerfana')
      }
    }
    return divergence
  }

  for (const relPath of generated) {
    const entry = staged.get(relPath)
    if (entry === undefined || entry.content === null) continue
    const destination = `${outRoot}/${relPath}`
    mkdirSync(dirname(destination), { recursive: true })
    if (entry.copyFrom === undefined) writeFileSync(destination, entry.content)
    else copyFileSync(entry.copyFrom, destination)
  }
  return 0
}

if (isEntryPoint(import.meta.url)) {
  runMain(() => runGenerator(process.argv.slice(2), new Output(true)))
}
