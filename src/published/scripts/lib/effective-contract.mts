// Resolucion de las rutas efectivas de lectura del contrato consumidor (MEF-ADR-0053 seccion 4):
// config-path e instructions-path eligen la ubicacion canonica, aceptan el fallback legacy solo si
// la canonica falta y abortan si no existe ninguna. Solo lo que este modulo emite nombra las rutas
// legacy (MEF-ADR-0050).

export function needsConfigPath(body: string): boolean {
  return body.includes('{{mefisto:config-path}}')
}

export function needsInstructionsPath(body: string): boolean {
  return body.includes('{{mefisto:instructions-path}}')
}

// Replica mensajes y precedencia de `resolve_harness_config_path read` (scripts/_pipeline-common.sh).
const CONFIG_BLOCK = [
  'if [ -f ".mefisto/harness.config.json" ]; then',
  '    if [ -f ".claude/harness.config.json" ]; then',
  "        printf '%s\\n' 'AVISO: se usara el config canonico .mefisto/harness.config.json; se ignora el legacy .claude/harness.config.json. Migra o elimina conscientemente el archivo legacy para evitar divergencias.' >&2",
  '    fi',
  '    MEFISTO_CONFIG_PATH=".mefisto/harness.config.json"',
  'elif [ -f ".claude/harness.config.json" ]; then',
  '    MEFISTO_CONFIG_PATH=".claude/harness.config.json"',
  'else',
  "    printf '%s\\n' 'ERROR: no se encontro el config canonico requerido .mefisto/harness.config.json.' >&2",
  "    printf '%s\\n' '  Se acepta solo para lectura el fallback legacy .claude/harness.config.json.' >&2",
  '    exit 1',
  'fi',
  'export MEFISTO_CONFIG_PATH',
]

// La ausencia total apunta a /mefisto:onboard (MEF-ADR-0049 decision 3).
const INSTRUCTIONS_BLOCK = [
  'if [ -f "AGENTS.md" ]; then',
  '    if [ -f "CLAUDE.md" ]; then',
  "        printf '%s\\n' 'AVISO: se usara AGENTS.md; se ignora el legacy CLAUDE.md. Migra o elimina conscientemente el archivo legacy para evitar divergencias.' >&2",
  '    fi',
  '    MEFISTO_INSTRUCTIONS_PATH="AGENTS.md"',
  'elif [ -f "CLAUDE.md" ]; then',
  '    MEFISTO_INSTRUCTIONS_PATH="CLAUDE.md"',
  'else',
  "    printf '%s\\n' 'ERROR: no se encontro AGENTS.md, la fuente canonica de directivas del consumidor.' >&2",
  "    printf '%s\\n' '  Se acepta solo para lectura el fallback legacy CLAUDE.md.' >&2",
  "    printf '%s\\n' '  Ejecuta /mefisto:onboard para diagnosticar y completar el contrato del consumidor.' >&2",
  '    exit 1',
  'fi',
  'export MEFISTO_INSTRUCTIONS_PATH',
]

/** Un unico bloque de shell con las resoluciones pedidas, sin salto final. */
export function effectiveContractPreamble(config: boolean, instructions: boolean): string {
  return [
    '```bash',
    ...(config ? CONFIG_BLOCK : []),
    ...(instructions ? INSTRUCTIONS_BLOCK : []),
    '```',
  ].join('\n')
}
