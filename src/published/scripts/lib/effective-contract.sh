#!/usr/bin/env bash
# Resolucion compartida entre adaptadores de las rutas efectivas de lectura
# del contrato consumidor (MEF-ADR-0053 seccion 4): config-path e
# instructions-path seleccionan primero la ubicacion canonica, aceptan el
# fallback legacy solo si la canonica falta y abortan si no existe ninguna.
# Solo lo que este archivo emite conoce los nombres legacy; la fuente neutral
# y el validador publicado no los nombran (MEF-ADR-0050).
# Gemela de lib/effective-contract.mts, que es la que usa el generador; esta
# queda solo para tests/test-tdd-agents.sh.

published_effective_contract_needs_config() {
    case "$1" in *'{{mefisto:config-path}}'*) return 0 ;; *) return 1 ;; esac
}

published_effective_contract_needs_instructions() {
    case "$1" in *'{{mefisto:instructions-path}}'*) return 0 ;; *) return 1 ;; esac
}

# Replica exactamente mensajes y precedencia de
# resolve_harness_config_path read (scripts/_pipeline-common.sh).
published_effective_contract_config_block() {
    cat <<'EOF'
if [ -f ".mefisto/harness.config.json" ]; then
    if [ -f ".claude/harness.config.json" ]; then
        printf '%s\n' 'AVISO: se usara el config canonico .mefisto/harness.config.json; se ignora el legacy .claude/harness.config.json. Migra o elimina conscientemente el archivo legacy para evitar divergencias.' >&2
    fi
    MEFISTO_CONFIG_PATH=".mefisto/harness.config.json"
elif [ -f ".claude/harness.config.json" ]; then
    MEFISTO_CONFIG_PATH=".claude/harness.config.json"
else
    printf '%s\n' 'ERROR: no se encontro el config canonico requerido .mefisto/harness.config.json.' >&2
    printf '%s\n' '  Se acepta solo para lectura el fallback legacy .claude/harness.config.json.' >&2
    exit 1
fi
export MEFISTO_CONFIG_PATH
EOF
}

# Misma politica que el bloque de config, aplicada a AGENTS.md/CLAUDE.md
# (MEF-ADR-0049 decision 3). La ausencia total apunta a /mefisto:onboard.
published_effective_contract_instructions_block() {
    cat <<'EOF'
if [ -f "AGENTS.md" ]; then
    if [ -f "CLAUDE.md" ]; then
        printf '%s\n' 'AVISO: se usara AGENTS.md; se ignora el legacy CLAUDE.md. Migra o elimina conscientemente el archivo legacy para evitar divergencias.' >&2
    fi
    MEFISTO_INSTRUCTIONS_PATH="AGENTS.md"
elif [ -f "CLAUDE.md" ]; then
    MEFISTO_INSTRUCTIONS_PATH="CLAUDE.md"
else
    printf '%s\n' 'ERROR: no se encontro AGENTS.md, la fuente canonica de directivas del consumidor.' >&2
    printf '%s\n' '  Se acepta solo para lectura el fallback legacy CLAUDE.md.' >&2
    printf '%s\n' '  Ejecuta /mefisto:onboard para diagnosticar y completar el contrato del consumidor.' >&2
    exit 1
fi
export MEFISTO_INSTRUCTIONS_PATH
EOF
}

# published_effective_contract_preamble <needs_config:0|1> <needs_instructions:0|1>
#
# Emite un unico bloque ```bash``` con exactamente las resoluciones
# solicitadas. Nunca se llama con ambos argumentos en 0.
published_effective_contract_preamble() {
    local needs_config="$1" needs_instructions="$2"
    printf '%s\n' '```bash'
    [ "$needs_config" -eq 1 ] && published_effective_contract_config_block
    [ "$needs_instructions" -eq 1 ] && published_effective_contract_instructions_block
    printf '%s\n' '```'
}
