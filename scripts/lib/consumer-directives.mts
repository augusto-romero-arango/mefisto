// Diagnostico de las directivas del consumidor: `AGENTS.md` con sus dos secciones contractuales
// y el puente `CLAUDE.md`, que solo exige el runtime `claude` (MEF-ADR-0050/0053).

import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { discoverRuntime } from './upgrade-runtime.mts'

export const CONTRACT_HEADINGS = ['Tokens del harness', 'Verificación de fuentes'] as const
export const CONTRACT_TOKENS = [
  'RootNamespace',
  'SolutionFile',
  'ProjectDisplayName',
  'BoundedContext',
  'BoundedContextDomains',
] as const

export interface DirectivesCheck {
  agentsState: 'OK' | 'FALTA' | 'NV'
  agentsDetail: string
  bridgeState: 'OK' | 'FALTA' | 'NV' | 'INFO'
  bridgeDetail: string
  bridgeHasImport: boolean
  bridgeHasLegacy: boolean
}

// `[[:space:]]` de POSIX sin el salto de linea, que ya separa las lineas.
const SPACE = '[ \\t\\v\\f\\r]'
const HEADING_PREFIX = new RegExp(`^${SPACE}*#{1,6}${SPACE}+`)
const TRAILING_SPACE = new RegExp(`${SPACE}+$`)
const IMPORT_LINE = new RegExp(`^${SPACE}*@AGENTS\\.md${SPACE}*$`)

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function lines(content: string): string[] {
  const all = content.split('\n')
  if (all.at(-1) === '') all.pop()
  return all
}

/** `true` si alguna linea es el encabezado Markdown `heading`, con un parentesis opcional detras. */
export function hasContractHeading(content: string, heading: string): boolean {
  const pattern = new RegExp(
    `^${SPACE}*#{1,6}${SPACE}+${escapeRegExp(heading)}(${SPACE}*\\([^)]*\\))?${SPACE}*$`,
  )
  return lines(content).some((line) => pattern.test(line))
}

/** `true` si `**token**` aparece dentro de la seccion "Tokens del harness", no en otra. */
export function contractSectionHasToken(content: string, token: string): boolean {
  const tokensHeading = new RegExp(`^Tokens del harness(${SPACE}*\\([^)]*\\))?$`)
  let inTokens = false
  for (const line of lines(content)) {
    if (HEADING_PREFIX.test(line)) {
      inTokens = tokensHeading.test(line.replace(HEADING_PREFIX, '').replace(TRAILING_SPACE, ''))
      continue
    }
    if (inTokens && line.includes(`**${token}**`)) return true
  }
  return false
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/** Contenido para buscar; vacio si la ruta no se puede leer como archivo. */
function contentOf(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Runtime activo: `MEFISTO_RUNTIME` o el unico adaptador disponible; sin resolver, `claude`. */
export function resolveOnboardRuntime(
  env: NodeJS.ProcessEnv,
  scriptDir: string,
  hasCommand: (command: string) => boolean,
): string {
  const fixed = env.MEFISTO_RUNTIME ?? ''
  if (fixed.length > 0) return fixed
  const override = env.MEFISTO_RUNTIME_LIB_DIR ?? ''
  const libDir = override.length > 0 ? override : join(scriptDir, '..', 'src', 'runtime', 'lib')
  if (!isFile(join(libDir, 'mefisto-runtime.sh'))) return 'claude'
  const found = discoverRuntime(libDir, env, hasCommand)
  return 'runtime' in found ? found.runtime : 'claude'
}

/** Estado de `AGENTS.md` y del puente `CLAUDE.md`; fuera de `claude` el puente nunca es FALTA ni NV. */
export function checkConsumerDirectives(
  agentsPath: string,
  claudePath: string,
  runtime: string,
): DirectivesCheck {
  const check: DirectivesCheck = {
    agentsState: 'FALTA',
    agentsDetail: '',
    bridgeState: 'FALTA',
    bridgeDetail: '',
    bridgeHasImport: false,
    bridgeHasLegacy: false,
  }

  if (!existsSync(agentsPath)) {
    check.agentsDetail =
      'AGENTS.md no existe: crea las secciones "Tokens del harness" y "Verificación de fuentes" con los 5 tokens obligatorios'
  } else if (!isReadable(agentsPath)) {
    check.agentsState = 'NV'
    check.agentsDetail = 'AGENTS.md existe pero no es legible'
  } else {
    const content = contentOf(agentsPath)
    const missing = [
      ...CONTRACT_HEADINGS.filter((heading) => !hasContractHeading(content, heading)).map(
        (heading) => `encabezado "${heading}"`,
      ),
      ...CONTRACT_TOKENS.filter((token) => !contractSectionHasToken(content, token)),
    ]
    if (missing.length === 0) {
      check.agentsState = 'OK'
      check.agentsDetail = 'AGENTS.md contiene las dos secciones obligatorias y los 5 tokens'
    } else {
      check.agentsDetail = `AGENTS.md esta incompleto; faltan: ${missing.join(' ')}`
    }
  }

  if (!existsSync(claudePath)) {
    check.bridgeDetail = 'CLAUDE.md no existe: crea el puente con una linea independiente @AGENTS.md'
  } else if (!isReadable(claudePath)) {
    check.bridgeState = 'NV'
    check.bridgeDetail = 'CLAUDE.md existe pero no es legible'
  } else {
    const content = contentOf(claudePath)
    const hasImport = lines(content).some((line) => IMPORT_LINE.test(line))
    const hasLegacy = CONTRACT_HEADINGS.some((heading) => hasContractHeading(content, heading))
    check.bridgeHasImport = hasImport
    check.bridgeHasLegacy = hasLegacy
    if (hasImport && !hasLegacy) {
      check.bridgeState = 'OK'
      check.bridgeDetail =
        'CLAUDE.md contiene el puente exacto @AGENTS.md sin secciones contractuales duplicadas'
    } else if (!hasImport && hasLegacy) {
      check.bridgeDetail =
        'CLAUDE.md legacy legible: faltan el puente exacto @AGENTS.md y la limpieza manual de las secciones contractuales duplicadas'
    } else if (!hasImport) {
      check.bridgeDetail =
        'CLAUDE.md no contiene una linea independiente @AGENTS.md; agrega el puente hacia AGENTS.md'
    } else {
      check.bridgeDetail =
        'CLAUDE.md contiene @AGENTS.md pero conserva secciones contractuales legacy duplicadas; eliminalas manualmente'
    }
  }

  if (runtime !== 'claude' && (check.bridgeState === 'FALTA' || check.bridgeState === 'NV')) {
    check.bridgeDetail = existsSync(claudePath)
      ? `opcional (solo lo requiere Claude Code): ${check.bridgeDetail}`
      : 'puente CLAUDE.md ausente: solo lo requiere Claude Code; si tu equipo tambien usa Claude, crealo con una linea independiente @AGENTS.md'
    check.bridgeState = 'INFO'
  }
  return check
}
