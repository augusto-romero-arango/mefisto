---
description: "Lee, \"edita\" y ejecuta."
mode: "subagent"
permission: {"external_directory":{"*":"deny","~/Library/Application Support/mefisto/*":"allow","~/.local/share/mefisto/*":"allow","~/.config/opencode/agents/*":"allow","~/.config/opencode/commands/*":"allow","~/.config/opencode/skills/*":"allow"},"doom_loop":"deny","lsp":"deny","todowrite":"deny","question":"deny","webfetch":"allow","websearch":"allow","skill":{"*":"deny","mefisto-projections":"allow","mefisto-code-comments":"allow"},"task":"allow","list":"allow","glob":"allow","grep":"allow","bash":{"*":"deny","git *":"allow","gh *":"allow","jq *":"allow","cat *":"allow","ls":"allow","ls *":"allow","basename *":"allow","find *":"allow","grep *":"allow","sort":"allow","sort *":"allow","bash scripts/*":"allow","sh scripts/*":"allow","scripts/*":"allow","./scripts/*":"allow","${MEFISTO_PACKAGE_ROOT}/scripts/*":"allow","mkdir *":"allow","mktemp":"allow","mktemp *":"allow","rm *":"deny","dotnet *":"allow","func init *":"allow","terraform init -backend=false*":"allow","terraform validate*":"allow","terraform fmt*":"allow","python3 - *":"allow","python3 -m json.tool*":"allow","cd *":"allow","echo *":"allow","date":"allow","date *":"allow","printf *":"allow","\"$mefisto_opencode_launcher\" package-root":"allow","export MEFISTO_PACKAGE_ROOT":"allow","exit 1":"allow","test *":"allow","[ *":"allow","touch *":"allow","tr *":"allow","head *":"allow","tail *":"allow","awk *":"allow","sed *":"allow","mv *":"allow","ilspycmd *":"allow","diff *":"allow","rm -f src/*":"allow","rm -rf src/*":"allow","rm -f tests/*":"allow","rm -f \"src/*":"allow","rm -rf \"src/*":"allow","rm -f \"tests/*":"allow","curl *":"deny","ssh *":"deny","scp *":"deny","sudo *":"deny","touch *Application*Support/mefisto*":"deny","touch *.local/share/mefisto*":"deny","touch *mefisto/releases*":"deny","touch *mefisto/active*":"deny","touch *.config/opencode/*":"deny","touch *MEFISTO_PACKAGE_ROOT*":"deny","mv *Application*Support/mefisto*":"deny","mv *.local/share/mefisto*":"deny","mv *mefisto/releases*":"deny","mv *mefisto/active*":"deny","mv *.config/opencode/*":"deny","mv *MEFISTO_PACKAGE_ROOT*":"deny","mkdir *Application*Support/mefisto*":"deny","mkdir *.local/share/mefisto*":"deny","mkdir *mefisto/releases*":"deny","mkdir *mefisto/active*":"deny","mkdir *.config/opencode/*":"deny","mkdir *MEFISTO_PACKAGE_ROOT*":"deny","rm *Application*Support/mefisto*":"deny","rm *.local/share/mefisto*":"deny","rm *mefisto/releases*":"deny","rm *mefisto/active*":"deny","rm *.config/opencode/*":"deny","rm *MEFISTO_PACKAGE_ROOT*":"deny","cp *Application*Support/mefisto*":"deny","cp *.local/share/mefisto*":"deny","cp *mefisto/releases*":"deny","cp *mefisto/active*":"deny","cp *.config/opencode/*":"deny","cp *MEFISTO_PACKAGE_ROOT*":"deny","sed *-i*Application*Support/mefisto*":"deny","sed *-i*.local/share/mefisto*":"deny","sed *-i*mefisto/releases*":"deny","sed *-i*mefisto/active*":"deny","sed *-i*.config/opencode/*":"deny","sed *-i*MEFISTO_PACKAGE_ROOT*":"deny"},"edit":{"*":"allow","commands/**":"deny","skills/**":"deny","agents/**":"deny","hooks/**":"deny",".claude-plugin/**":"deny","src/published/**":"deny","src/runtime/**":"deny","dist/**":"deny","docs/adr/mef-adr-*":"deny","../*":"deny","~/Library/Application Support/mefisto/**":"deny","~/.local/share/mefisto/**":"deny","~/.config/opencode/**":"deny"},"write":{"*":"allow","commands/**":"deny","skills/**":"deny","agents/**":"deny","hooks/**":"deny",".claude-plugin/**":"deny","src/published/**":"deny","src/runtime/**":"deny","dist/**":"deny","docs/adr/mef-adr-*":"deny","../*":"deny","~/Library/Application Support/mefisto/**":"deny","~/.local/share/mefisto/**":"deny","~/.config/opencode/**":"deny"},"patch":{"*":"allow","commands/**":"deny","skills/**":"deny","agents/**":"deny","hooks/**":"deny",".claude-plugin/**":"deny","src/published/**":"deny","src/runtime/**":"deny","dist/**":"deny","docs/adr/mef-adr-*":"deny","../*":"deny","~/Library/Application Support/mefisto/**":"deny","~/.local/share/mefisto/**":"deny","~/.config/opencode/**":"deny"},"read":{"*":"allow",".env":"deny",".env.*":"deny","**/.env":"deny","**/.env.*":"deny","**/auth.json":"deny","**/opencode.jsonc":"deny","**/.local/share/opencode/**":"deny","**/.aws/**":"deny","**/.ssh/**":"deny"}}
tools: {"microsoft-learn_*":false,"terraform_*":false}
---
<!-- GENERADO por prueba desde fixture. No editar a mano. -->
Antes de ejecutar este body, usa la tool nativa `skill` para cargar, en este orden: `mefisto-projections`, `mefisto-code-comments`. Si una carga es denegada o falla, detén la ejecución.
```bash
# Cada llamada bash que use ${MEFISTO_PACKAGE_ROOT} debe incluir este bloque antes de sus comandos: no se asume estado de shell persistente entre llamadas.
if [ -n "${XDG_DATA_HOME:-}" ]; then mefisto_opencode_launcher="$XDG_DATA_HOME/mefisto/active/bin/mefisto-opencode"
elif [ "${OSTYPE%%[0-9.]*}" = darwin ]; then mefisto_opencode_launcher="$HOME/Library/Application Support/mefisto/active/bin/mefisto-opencode"
else mefisto_opencode_launcher="$HOME/.local/share/mefisto/active/bin/mefisto-opencode"; fi
if [ ! -f "$mefisto_opencode_launcher" ] || [ -L "$mefisto_opencode_launcher" ] || [ ! -x "$mefisto_opencode_launcher" ]; then
    printf '%s\n' 'ERROR OpenCode: no hay una release activa valida; instale o active la release OpenCode.' >&2; exit 1
fi
MEFISTO_PACKAGE_ROOT="$("$mefisto_opencode_launcher" package-root)" || {
    printf '%s\n' 'ERROR OpenCode: no se pudo resolver la release activa; instale o active la release OpenCode.' >&2; exit 1;
}
case "$MEFISTO_PACKAGE_ROOT" in
    /*) ;;
    *) printf '%s\n' 'ERROR OpenCode: la release activa no devolvio una raiz absoluta; reinstale o active la release OpenCode.' >&2; exit 1 ;;
esac
MEFISTO_PACKAGE_ROOT="$(cd -P "$MEFISTO_PACKAGE_ROOT" 2>/dev/null && printf '%s\n' "$PWD")" || {
    printf '%s\n' 'ERROR OpenCode: la release activa no existe; reinstale o active la release OpenCode.' >&2; exit 1;
}
export MEFISTO_PACKAGE_ROOT
```
```bash
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
```
Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.sh`: ese directorio es el repositorio de Mefisto, no un consumidor.
Rutas: ${MEFISTO_CONFIG_PATH}, ${MEFISTO_INSTRUCTIONS_PATH} y ${MEFISTO_PACKAGE_ROOT}.
.mefisto/pipeline/logs/con-espacio.log
Ejecuta MEFISTO_RUNTIME=opencode "${MEFISTO_PACKAGE_ROOT}/scripts/prueba.sh" "$ARGUMENTS con espacios" ahora.
Consulta /mefisto:otra-orden.
