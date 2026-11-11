// Entrega la field note de cierre del planner publicado y, si se pide, el delta ya fusionado del
// glosario de lenguaje ubicuo, por un PR contra la rama por defecto del repo consumidor.
//
// Uso: node scripts/field-note.mts --session-id <id> --timestamp <YYYY-MM-DD-HHMM>
//        --field-note <archivo-local> [--glossary-path <ruta-repo> --glossary <archivo-local>]
//
// Repetir la invocacion con los mismos flags reanuda la entrega: reutiliza la rama, el worktree, el
// commit y el PR que ya existan. Sale con 0 si el PR quedo creado, reutilizado, reabierto o ya
// mergeado, y con 1 ante cualquier fallo.

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { CliError, isEntryPoint, repoRoot } from './lib/cli.mts'
import {
  FieldNoteDelivery,
  SYSTEM_TOOLS,
  exitCodeOf,
  isFile,
  isMerged,
  parseFlags,
  parsePrList,
  prField,
  requireCommands,
  trimTrailingNewlines,
  validateSlug,
  validateTimestamp,
} from './lib/field-note.mts'
import type { Tools } from './lib/field-note.mts'

const USAGE = `Uso: field-note.sh --session-id <id> --timestamp <YYYY-MM-DD-HHMM> --field-note <archivo-local> [--glossary-path <ruta-repo> --glossary <archivo-local>]

Entrega, en un worktree aislado del checkout principal, la field note de
cierre del planner (y opcionalmente el delta ya fusionado del glosario de
lenguaje ubicuo) via un PR idempotente contra la rama por defecto del repo.`

const FLAGS = ['--session-id', '--timestamp', '--field-note', '--glossary-path', '--glossary']

// Los dos unicos destinos que MEF-ADR-0040 reconoce para el glosario.
const GLOSSARY_PATHS = ['docs/ddd/ubiquitous-language.yaml', 'docs/eda/ubiquitous-language.yaml']

const PYTHON_YAML_CHECK = `
import sys
import yaml
with open(sys.argv[1], encoding="utf-8") as f:
    yaml.safe_load(f)
`

export interface DeliverOptions {
  cwd?: string
  tools?: Tools
}

/**
 * Valida YAML con el primer validador que ya este en el PATH: python3 con PyYAML, ruby o yq.
 * Devuelve el codigo del validador (0 si es valido) o 2 si no hay ninguno. Node no trae parser de
 * YAML y el script no instala nada.
 */
export function validateYamlFile(tools: Tools, cwd: string, file: string): number {
  const status = (command: string, args: string[]): number => tools.run(command, args, cwd).status ?? 1
  if (tools.has('python3') && status('python3', ['-c', 'import yaml']) === 0) {
    return status('python3', ['-c', PYTHON_YAML_CHECK, file])
  }
  if (tools.has('ruby') && status('ruby', ['-ryaml', '-e', '']) === 0) {
    return status('ruby', ['-ryaml', '-e', 'YAML.safe_load(File.read(ARGV[0]))', file])
  }
  if (tools.has('yq')) return status('yq', ['eval', '.', file])
  return 2
}

function readContent(path: string): Buffer {
  try {
    return trimTrailingNewlines(readFileSync(path))
  } catch {
    return Buffer.alloc(0)
  }
}

export function deliver(argv: string[], options: DeliverOptions = {}): number {
  const tools = options.tools ?? SYSTEM_TOOLS
  const cwd = options.cwd ?? process.cwd()

  return exitCodeOf(tools, () => {
    const root = repoRoot(cwd)
    if (root === null) throw new CliError('ERROR: no estas en un repositorio git')
    if (existsSync(join(root, '.claude-plugin', 'plugin.json'))) {
      throw new CliError(
        [
          'ERROR: scripts/field-note.sh es del plugin publicado y solo aplica al consumidor.',
          'Mefisto entrega sus propias field notes con src/internal/scripts/mefisto-field-note.sh.',
        ].join('\n'),
      )
    }

    const flags = parseFlags(argv, FLAGS, USAGE)
    const sessionId = flags.get('--session-id') ?? ''
    const timestamp = flags.get('--timestamp') ?? ''
    const noteSource = flags.get('--field-note') ?? ''
    const glossaryPath = flags.get('--glossary-path') ?? ''
    const glossarySource = flags.get('--glossary') ?? ''
    const withGlossary = glossarySource.length > 0 || glossaryPath.length > 0

    if (sessionId.length === 0 || timestamp.length === 0 || noteSource.length === 0) {
      throw new CliError(`ERROR: --session-id, --timestamp y --field-note son obligatorios\n${USAGE}`)
    }
    if (withGlossary) {
      if (glossarySource.length === 0 || glossaryPath.length === 0) {
        throw new CliError('ERROR: --glossary y --glossary-path deben pasarse juntos')
      }
      if (!GLOSSARY_PATHS.includes(glossaryPath)) {
        throw new CliError(
          [
            `ERROR: --glossary-path '${glossaryPath}' no es un destino admitido.`,
            'El unico archivo de glosario admisible es docs/ddd/ubiquitous-language.yaml',
            '(o docs/eda/ubiquitous-language.yaml como ruta legada); nunca crees una copia distinta.',
          ].join('\n'),
        )
      }
    }
    validateSlug(sessionId, '--session-id', 120)
    validateTimestamp(timestamp)
    if (!isFile(resolve(cwd, noteSource))) {
      throw new CliError(`ERROR: --field-note '${noteSource}' no existe o no es un archivo`)
    }
    if (withGlossary && !isFile(resolve(cwd, glossarySource))) {
      throw new CliError(`ERROR: --glossary '${glossarySource}' no existe o no es un archivo`)
    }
    requireCommands(tools, ['git', 'gh'])

    const note = readContent(resolve(cwd, noteSource))
    if (note.length === 0) throw new CliError(`ERROR: '${noteSource}' esta vacio`)
    let glossary: Buffer = Buffer.alloc(0)
    if (withGlossary) {
      glossary = readContent(resolve(cwd, glossarySource))
      if (glossary.length === 0) throw new CliError(`ERROR: '${glossarySource}' esta vacio`)

      const validation = validateYamlFile(tools, cwd, glossarySource)
      if (validation === 2) {
        throw new CliError(
          [
            `ERROR: ningun validador YAML esta ya presente en PATH (se probo python3+PyYAML, ruby y yq) y este script no instala nada nuevo, asi que no puede confirmar que '${glossarySource}' siga siendo YAML valido tras el delta.`,
            'Accion de recuperacion: deja disponible uno de esos tres validadores y reintenta con los mismos flags, o vuelve a invocar sin --glossary/--glossary-path para entregar solo la field note y llevar el delta del glosario aparte; no se toco git.',
          ].join('\n'),
        )
      }
      if (validation !== 0) {
        throw new CliError(
          [
            `ERROR: '${glossarySource}' dejo de ser YAML valido tras aplicar el delta.`,
            "Accion de recuperacion: reformula unicamente el delta del glosario contra la version en 'origin/<rama por defecto>' y reintenta; no se toco git.",
          ].join('\n'),
        )
      }
    }

    const noteRel = `docs/bitacora/field-notes/${timestamp}-planner.md`
    const docBranch = `docs/planner-field-notes-${sessionId}`
    const delivery = new FieldNoteDelivery({
      tools,
      cwd,
      root,
      sessionId,
      docBranch,
      retryFlags: '--session-id/--timestamp',
      invariant: 'CA-1',
      isolation: 'su aislamiento',
    })

    return delivery.run(() => {
      const repoSlug = delivery.quiet('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).value
      const repoFlag = repoSlug.length > 0 ? ['--repo', repoSlug] : []

      const branch = delivery.read('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])
      if (!branch.ok || branch.value.length === 0 || branch.value === 'null') {
        throw new CliError(
          `ERROR: no se pudo resolver la rama predeterminada del repo via 'gh repo view' (rc=${branch.status ?? 127}); revisa 'gh auth status'`,
        )
      }
      const defaultBranch = branch.value
      delivery.defaultBranch = defaultBranch

      delivery.mountWorktree(delivery.locatePrevious(), () =>
        mkdtempSync(join(tmpdir(), `planner-field-note-${sessionId}.`)),
      )
      const worktree = delivery.worktreeDir

      delivery.writeFile(noteRel, note)
      delivery.stage(noteRel, 'de la field note')
      if (withGlossary) {
        delivery.writeFile(glossaryPath, glossary)
        // Se valida el archivo ya escrito en el worktree, el mismo que se va a agregar.
        const validation = validateYamlFile(tools, cwd, join(worktree, ...glossaryPath.split('/')))
        if (validation === 2) {
          delivery.abort(
            'worktree',
            `Ningun validador YAML esta ya presente en PATH (python3+PyYAML, ruby o yq), asi que no se puede confirmar que '${glossaryPath}' siga siendo YAML valido. No se stageo nada. Deja disponible uno de esos validadores y reintenta con los mismos --session-id/--timestamp.`,
          )
        }
        if (validation !== 0) {
          delivery.abort(
            'worktree',
            `'${glossaryPath}' dejo de ser YAML valido tras escribir el delta en '${worktree}'. No se stageo nada. Reformula unicamente el delta del glosario contra la version en 'origin/${defaultBranch}' y reintenta con los mismos --session-id/--timestamp.`,
          )
        }
        delivery.stage(glossaryPath, 'del glosario')
      }

      const expected = withGlossary ? [noteRel, glossaryPath] : [noteRel]
      const unexpected = delivery.unexpectedChanges(expected)
      if (unexpected.length > 0) {
        const paths = expected.map((path) => `'${path}'`).join(', ')
        throw new CliError(
          [
            `ERROR: el worktree documental contiene cambios fuera de los paths esperados (${paths}):`,
            ...unexpected,
          ].join('\n'),
        )
      }

      delivery.commit({
        rel: noteRel,
        message: 'docs(bitacora): agregar field note del planner',
        noteInBase: 'la field note',
        subject: '',
        staged: 'los archivos siguen staged',
      })
      const commit = delivery.commitSha
      delivery.push()

      // A diferencia del interno, el PR se consulta despues del push y no hay reentrega: tras un
      // merge, contenido nuevo se empuja a la rama y se informa el PR ya mergeado.
      const list = delivery.read('gh', [
        'pr',
        'list',
        '--head',
        docBranch,
        '--base',
        defaultBranch,
        '--state',
        'all',
        '--json',
        'number,url,state,mergedAt',
        ...repoFlag,
      ])
      if (!list.ok) {
        delivery.abort(
          'consulta-pr',
          `'gh pr list' fallo para '${docBranch}'; la rama y el commit ${commit} ya estan en origin (no se perdio nada). Revisa 'gh auth status' y reintenta con los mismos flags.`,
        )
      }

      const pr = parsePrList(list.value)[0]
      let prUrl: string
      if (pr === undefined) {
        const created = delivery.read('gh', [
          'pr',
          'create',
          '--base',
          defaultBranch,
          '--head',
          docBranch,
          '--title',
          'docs(bitacora): field notes del planner',
          '--body',
          `Entrega aislada de la field note del planner de la sesión ${sessionId}. No incluye cambios preexistentes.`,
          ...repoFlag,
        ])
        if (!created.ok) {
          delivery.abort(
            'creacion-pr',
            `'gh pr create' fallo; la rama '${docBranch}' con el commit ${commit} ya esta empujada a origin. Revisa 'gh auth status' y reintenta con los mismos flags -- la proxima corrida encontrara la rama ya lista y solo reintentara el PR.`,
          )
        }
        prUrl = created.value
        delivery.say(`PR creado (no existia ninguno para '${docBranch}')`)
      } else {
        prUrl = prField(pr, 'url')
        if (isMerged(pr)) {
          delivery.say(`PR ya mergeado: la field note de esta sesion ya fue entregada (${prUrl})`)
        } else if (prField(pr, 'state') === 'OPEN') {
          delivery.say("PR ya existente reutilizado (no se llamo a 'gh pr create')")
        } else {
          if (!delivery.show('gh', ['pr', 'reopen', prField(pr, 'number'), ...repoFlag])) {
            delivery.abort(
              'reapertura-pr',
              `El PR ${prUrl} de '${docBranch}' esta cerrado sin merge y 'gh pr reopen' fallo; la rama y el commit ${commit} siguen intactos en origin. Reabrelo a mano en GitHub, o revisa 'gh auth status' y reintenta.`,
            )
          }
          delivery.say(`PR cerrado sin merge fue reabierto: ${prUrl}`)
        }
      }
      delivery.checkpoint = 'pr'

      delivery.say(`Field note: ${noteRel}`)
      if (withGlossary) delivery.say(`Glosario: ${glossaryPath}`)
      delivery.say(`Rama: ${docBranch}`)
      delivery.say(`Commit: ${commit}`)
      delivery.say(`PR: ${prUrl}`)
    })
  })
}

if (isEntryPoint(import.meta.url)) process.exitCode = deliver(process.argv.slice(2))
