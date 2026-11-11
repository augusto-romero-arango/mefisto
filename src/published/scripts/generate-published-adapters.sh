#!/usr/bin/env bash
# generate-published-adapters.sh -- Orquesta los adaptadores publicados desde
# src/published/{agents,commands}. No conoce formatos de runtime: cada
# adapter-<runtime>.sh declara su raiz y renderiza sus propios archivos.
#
# Uso: generate-published-adapters.sh [--check] [--out <raiz>] [archivo...]
# Sin archivos valida y procesa src/published/{agents,commands}/*.md en orden
# LC_ALL=C. --out es la raiz que contiene dist/ (principalmente para tests).
# --check nunca crea --out y lista <ruta>: faltante|distinta|huerfana|sin
# marcador|modo divergente|inventario inconsistente|enlace simbolico.
#
# Interfaz de un adaptador ejecutable adapter-<runtime>.sh:
#   root                          imprime su raiz relativa bajo --out (p.ej. dist/foo)
#   path <fuente-relativa>        imprime la ruta relativa del archivo renderizado
#   render <fuente> <marcador>    imprime el contenido completo del archivo
#   assets                        opcional: imprime un array JSON de assets
#   render-asset <id> <fuente>    imprime el contenido completo de un asset
#
# `root` y `path` deben imprimir una unica ruta relativa segura. Las raices de
# adaptadores distintos no pueden coincidir ni anidarse. `render` debe incluir
# el marcador recibido como una linea completa; puede ubicarlo despues del
# frontmatter que exija el runtime. El core no interpreta frontmatter,
# directivas, capacidades, namespaces, modelos ni permisos.
#
# Cada elemento de `assets` tiene `id`, `source`, `destination` y `mode`.
# `source` y `destination` son rutas repo-relativas y relativas a la raiz del
# adaptador, respectivamente; `mode` es 0644 o 0755. Los adaptadores previos a
# esta extension pueden rechazar `assets` sin salida y conservan su conducta.
# La ausencia heredada se indica rechazando `assets` sin salida. Cualquier
# salida junto a un exit no-cero se considera un fallo de enumeracion. El motor
# escribe `.mefisto-generated-assets.json` como inventario versionado
# (schemaVersion 1) de las salidas Markdown y los assets de cada raiz; no es el
# manifest de releases.
#
# Clausura ejecutable del primer corte publicado de tooling (MEF-ADR-0053).
# Es una frontera de producto deliberadamente plana y ordenada: no se amplia
# mediante find/globs porque eso expondria pipelines, fixtures o adaptadores de
# prueba que todavia no pertenecen a una release. El inventario generado en
# cada dist/<runtime> atribuye cada copia a su fuente exacta sin insertar un
# marcador que pudiera romper un shebang Bash o un programa jq.

set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd -P)"
VALIDATOR="$SCRIPT_DIR/validate-published-artifacts.sh"
ADAPTER_DIR="$SCRIPT_DIR/adapters"
MARKER_SCRIPT="src/published/scripts/generate-published-adapters.sh"
CHECK_MODE=0
OUT_ROOT="$REPO_ROOT"
FILES=()
TOOLING_CLOSURE_ASSETS=(
    'scripts/_pipeline-common.sh|0755'
    'scripts/lib/cli.mts|0644'
    'scripts/lib/state.mts|0644'
    'scripts/lib/field-note.mts|0644'
    'scripts/lib/harness-config.mts|0644'
    'scripts/lib/tfstate-naming.mts|0644'
    'scripts/lib/azure-cli.mts|0644'
    'scripts/launch-pipeline.sh|0755'
    'scripts/herdr-workspace.sh|0755'
    'scripts/herdr-pipeline.sh|0755'
    'scripts/stream-watch.sh|0755'
    'scripts/tooling-pipeline.sh|0755'
    'scripts/tdd-pipeline.sh|0755'
    'scripts/pr-sync.sh|0755'
    'scripts/worktree-clean.sh|0755'
    'scripts/worktree-clean.mts|0644'
    'scripts/work-status-collect.sh|0755'
    'scripts/batch-pipeline.sh|0755'
    'scripts/parallel-pipeline.sh|0755'
    'scripts/iac-pipeline.sh|0755'
    'scripts/scaffold-pipeline.sh|0755'
    'scripts/field-note.sh|0755'
    'scripts/field-note.mts|0644'
    'scripts/register-harness-secret.sh|0755'
    'scripts/seed-secret.sh|0755'
    'scripts/next-order.sh|0755'
    'scripts/next-order.mts|0644'
    'scripts/lib/next-order.mts|0644'
    'scripts/lib/issue-dependencies.mts|0644'
    'scripts/warnings-diff.sh|0755'
    'scripts/warnings-diff.mts|0644'
    'scripts/metrics-report.sh|0755'
    'scripts/validate-dockerfile.sh|0755'
    'scripts/azure-account-info.sh|0755'
    'scripts/azure-account-info.mts|0644'
    'scripts/bootstrap-backend.sh|0755'
    'scripts/bootstrap-backend.mts|0644'
    'scripts/setup-github-ci.sh|0755'
    'scripts/setup-github-ci.mts|0644'
    'scripts/setup-github-labels.sh|0755'
    'scripts/appinsights-query.sh|0755'
    'scripts/appinsights-query.mts|0644'
    'scripts/purge-store.sh|0755'
    'scripts/purge-store.mts|0644'
    'scripts/onboard-diagnose.sh|0755'
    'scripts/onboard-migrate-directives.sh|0755'
    'scripts/onboard-provision-appinsights.sh|0755'
    'scripts/onboard-activate-repo.sh|0755'
    'scripts/_plugin-scopes.sh|0644'
    'scripts/update-plugin.sh|0755'
    'scripts/upgrade.sh|0755'
    'scripts/upgrade.mts|0644'
    'scripts/lib/upgrade-runtime.mts|0644'
    'src/runtime/mefisto-run-agent.sh|0755'
    'src/runtime/lib/mefisto-runtime.sh|0755'
    'src/runtime/lib/mefisto-models.sh|0644'
    'src/runtime/lib/mefisto-process.sh|0755'
    'src/runtime/lib/runtime-claude.sh|0755'
    'src/runtime/lib/runtime-claude.jq|0644'
    'src/runtime/contract/models.validate.jq|0644'
)
# Conocimiento no ejecutable requerido por el flujo TDD. Los ADRs se descubren
# por convencion para que uno nuevo entre en cada runtime sin una lista manual;
# el cheatsheet es una dependencia explicita de test-writer.
KNOWLEDGE_CLOSURE_ASSETS=()
# El marketplace Claude instala hoy la raiz del checkout (`source: "./"`).
# Hasta que esa raiz sea una proyeccion autocontenida, los entrypoints y roles
# publicados se reflejan alli desde la misma renderizacion Claude.
CLAUDE_ROOT_MIRRORS=(
    'src/published/commands/tooling.md|commands/tooling.md'
    'src/published/commands/draft.md|commands/draft.md'
    'src/published/commands/implement.md|commands/implement.md'
    'src/published/commands/merge.md|commands/merge.md'
    'src/published/commands/sequential.md|commands/sequential.md'
    'src/published/commands/batch-stop.md|commands/batch-stop.md'
    'src/published/commands/parallel.md|commands/parallel.md'
    'src/published/commands/infra.md|commands/infra.md'
    'src/published/commands/infra-base.md|commands/infra-base.md'
    'src/published/commands/scaffold-projections.md|commands/scaffold-projections.md'
    'src/published/commands/scaffold-mcp.md|commands/scaffold-mcp.md'
    'src/published/commands/scaffold.md|commands/scaffold.md'
    'src/published/commands/seed-secret.md|commands/seed-secret.md'
    'src/published/commands/install-workos.md|commands/install-workos.md'
    'src/published/commands/install-apim.md|commands/install-apim.md'
    'src/published/commands/install-auth.md|commands/install-auth.md'
    'src/published/commands/next-order.md|commands/next-order.md'
    'src/published/commands/upgrade.md|commands/upgrade.md'
    'src/published/commands/health-check.md|commands/health-check.md'
    'src/published/commands/purge-store.md|commands/purge-store.md'
    'src/published/commands/fix-review.md|commands/fix-review.md'
    'src/published/commands/eraser-diagram.md|commands/eraser-diagram.md'
    'src/published/commands/bug.md|commands/bug.md'
    'src/published/commands/bitacora.md|commands/bitacora.md'
    'src/published/commands/onboard.md|commands/onboard.md'
    'src/published/agents/tooling-writer.md|agents/tooling-writer.md'
    'src/published/agents/tooling-reviewer.md|agents/tooling-reviewer.md'
    'src/published/agents/test-writer.md|agents/test-writer.md'
    'src/published/agents/implementer.md|agents/implementer.md'
    'src/published/agents/reviewer.md|agents/reviewer.md'
    'src/published/agents/smoke-test-writer.md|agents/smoke-test-writer.md'
    'src/published/agents/projection-test-writer.md|agents/projection-test-writer.md'
    'src/published/agents/projection-implementer.md|agents/projection-implementer.md'
    'src/published/agents/domain-scaffolder.md|agents/domain-scaffolder.md'
    'src/published/agents/infra-writer.md|agents/infra-writer.md'
    'src/published/agents/infra-reviewer.md|agents/infra-reviewer.md'
    'src/published/agents/pr-sync.md|agents/pr-sync.md'
    'src/published/agents/infra-bootstrap.md|agents/infra-bootstrap.md'
    'src/published/agents/planner.md|agents/planner.md'
    'src/published/agents/infra-base-scaffolder.md|agents/infra-base-scaffolder.md'
    'src/published/agents/projections-scaffolder.md|agents/projections-scaffolder.md'
    'src/published/agents/workos-identity-scaffolder.md|agents/workos-identity-scaffolder.md'
    'src/published/agents/apim-gateway-scaffolder.md|agents/apim-gateway-scaffolder.md'
    'src/published/agents/mcp-scaffolder.md|agents/mcp-scaffolder.md'
    'src/published/agents/bug-investigator.md|agents/bug-investigator.md'
    'src/published/agents/tooling-investigator.md|agents/tooling-investigator.md'
    'src/published/agents/historiador.md|agents/historiador.md'
)

usage_error() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

safe_relative_path() {
    local value="$1" segment
    local segments=()
    case "$value" in
        ''|/*|*/|*//*|*$'\n'*|*$'\r'*) return 1 ;;
    esac
    IFS='/' read -r -a segments <<< "$value"
    for segment in "${segments[@]}"; do
        case "$segment" in ''|.|..) return 1 ;; esac
    done
    return 0
}

paths_overlap() {
    case "$1/" in "$2/"*) return 0 ;; esac
    case "$2/" in "$1/"*) return 0 ;; esac
    return 1
}

has_marker() {
    # Coincidencia de linea completa: evita aceptar un prefijo parecido y
    # permite frontmatter antes del marcador.
    LC_ALL=C grep -Fqx "${1}" "$2" 2>/dev/null
}

has_any_generated_marker() {
    local line
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            "<!-- GENERADO por $MARKER_SCRIPT desde "*". No editar a mano. -->") return 0 ;;
        esac
    done < "$1"
    return 1
}

file_mode() {
    stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

output_path_has_symlink() {
    local relpath="$1" current="$OUT_ROOT" segment
    local segments=()
    [ ! -L "$current" ] || return 0
    IFS='/' read -r -a segments <<< "$relpath"
    for segment in "${segments[@]}"; do
        current="$current/$segment"
        [ ! -L "$current" ] || return 0
    done
    return 1
}

sha256() {
    local digest
    if command -v shasum >/dev/null 2>&1; then
        digest="$(shasum -a 256 "$1")" || return 1
    else
        digest="$(sha256sum "$1")" || return 1
    fi
    printf '%s\n' "${digest%% *}"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --check) CHECK_MODE=1; shift ;;
        --out)
            [ $# -ge 2 ] || usage_error "--out requiere una raiz"
            OUT_ROOT="$2"; shift 2 ;;
        --*) usage_error "opcion desconocida: $1" ;;
        *) FILES+=("$1"); shift ;;
    esac
done

# La validacion es deliberadamente la primera operacion sobre los artefactos:
# ningun rechazo puede crear ni modificar la salida.
[ -x "$VALIDATOR" ] || usage_error "no existe o no es ejecutable el validador publicado"
if [ ${#FILES[@]} -eq 0 ]; then
    VALIDATION="$($VALIDATOR 2>&1)"; VALIDATION_RC=$?
else
    VALIDATION="$($VALIDATOR "${FILES[@]}" 2>&1)"; VALIDATION_RC=$?
fi
if [ "$VALIDATION_RC" -ne 0 ]; then
    [ -n "$VALIDATION" ] && printf '%s\n' "$VALIDATION" >&2
    exit 1
fi

if [ ${#FILES[@]} -eq 0 ]; then
    while IFS= read -r file; do
        [ -n "$file" ] && FILES+=("$file")
    done < <(find "$REPO_ROOT/src/published/agents" "$REPO_ROOT/src/published/commands" -name '*.md' -type f 2>/dev/null | sort)
fi

ADAPTERS=()
if [ -d "$ADAPTER_DIR" ]; then
    while IFS= read -r adapter; do
        [ -n "$adapter" ] && ADAPTERS+=("$adapter")
    done < <(find "$ADAPTER_DIR" -maxdepth 1 -type f -name 'adapter-*.sh' 2>/dev/null | sort)
fi
if [ ${#ADAPTERS[@]} -eq 0 ]; then
    if [ ${#FILES[@]} -eq 0 ]; then
        exit 0
    fi
    usage_error "no hay adapter-<runtime>.sh registrados para renderizar fuentes explicitas"
fi

if ! command -v jq >/dev/null 2>&1; then
    usage_error "jq no esta instalado (MEF-ADR-0049: bash + jq)"
fi

ROOTS=()
for adapter in "${ADAPTERS[@]}"; do
    adapter_name="$(basename "$adapter")"
    [ -x "$adapter" ] || usage_error "adaptador no ejecutable: $adapter_name"
    root="$($adapter root)" || usage_error "$adapter_name no pudo declarar su raiz"
    safe_relative_path "$root" || usage_error "$adapter_name declaro una raiz insegura"
    case "$root" in
        dist/*) ;;
        *) usage_error "$adapter_name debe declarar una raiz dist/<runtime>" ;;
    esac
    for registered_root in ${ROOTS[@]+"${ROOTS[@]}"}; do
        paths_overlap "$root" "$registered_root" && usage_error "$adapter_name declaro una raiz duplicada o anidada: $root"
    done
    ROOTS+=("$root")
done

STAGE_DIR="$(mktemp -d)" || usage_error "no se pudo crear el staging temporal"
PUBLISH_DIR=""
cleanup() {
    rm -rf "$STAGE_DIR"
    [ -z "$PUBLISH_DIR" ] || rm -rf "$PUBLISH_DIR"
}
trap cleanup EXIT
GENERATED=()
ASSET_PLANS=()
# Arrays paralelos a ASSET_PLANS (mismo indice) con los campos que los tres
# bucles de deteccion de colisiones consultaban antes con un `jq -r` por plan
# acumulado; evitan la cuadratica de lanzar un proceso jq por cada asset ya
# procesado, por cada asset o archivo nuevo.
ASSET_PLAN_ADAPTERS=()
ASSET_PLAN_IDS=()
ASSET_PLAN_DESTINATIONS=()
RENDERED_PLANS=()
ASSET_COUNT=0
ASSET_ROOTS=()

for root in "${ROOTS[@]}"; do
    mkdir -p "$STAGE_DIR/$root" || usage_error "no se pudo preparar el staging"
done

for file in ${FILES[@]+"${FILES[@]}"}; do
    file_dir="$(cd "$(dirname "$file")" 2>/dev/null && pwd -P)" || usage_error "fuente inaccesible"
    absolute_source="$file_dir/$(basename "$file")"
    case "$absolute_source" in
        "$REPO_ROOT"/*) rel_source="${absolute_source#"$REPO_ROOT"/}" ;;
        *) usage_error "fuente fuera del repositorio" ;;
    esac
    marker="<!-- GENERADO por $MARKER_SCRIPT desde $rel_source. No editar a mano. -->"
    adapter_index=0
    for adapter in "${ADAPTERS[@]}"; do
        adapter_name="$(basename "$adapter")"
        root="${ROOTS[$adapter_index]}"
        adapter_index=$((adapter_index + 1))
        relpath="$($adapter path "$rel_source")" || usage_error "$adapter_name no pudo calcular la ruta de $rel_source"
        safe_relative_path "$relpath" || usage_error "$adapter_name devolvio una ruta insegura para $rel_source"
        full_rel="$root/$relpath"
        generated_contains=0
        for generated_path in ${GENERATED[@]+"${GENERATED[@]}"}; do
            [ "$generated_path" = "$full_rel" ] && generated_contains=1
        done
        [ "$generated_contains" -eq 0 ] || usage_error "$adapter_name produjo una ruta duplicada: $full_rel"
        mkdir -p "$(dirname "$STAGE_DIR/$full_rel")" || usage_error "no se pudo preparar $full_rel"
        if ! "$adapter" render "$absolute_source" "$marker" > "$STAGE_DIR/$full_rel"; then
            printf "ERROR: %s no pudo renderizar '%s'; no se escribio nada\n" "$adapter_name" "$rel_source" >&2
            exit 1
        fi
        has_marker "$marker" "$STAGE_DIR/$full_rel" || usage_error "$adapter_name no escribio el marcador estable para $rel_source"
        chmod 0644 "$STAGE_DIR/$full_rel" || usage_error "no se pudo fijar el modo de $full_rel"
        RENDERED_PLANS+=("$(jq -cn --arg adapter "$adapter_name" --arg id "$rel_source" --arg source "$rel_source" --arg destination "$full_rel" --arg sha256 "$(sha256 "$STAGE_DIR/$full_rel")" '{adapter: $adapter, id: $id, source: $source, destination: $destination, mode: "0644", sha256: $sha256}')")
        GENERATED+=("$full_rel")
    done
done

generated_contains() {
    local needle="$1" candidate
    for candidate in ${GENERATED[@]+"${GENERATED[@]}"}; do
        [ "$candidate" = "$needle" ] && return 0
    done
    return 1
}

project_static_assets() {
    local collection_name="$1" declared_asset root asset_source asset_mode asset_id asset_destination asset_source_parent asset_source_dir absolute_asset_source asset_sha full_rel plan_destination stage_parent resolved_index
    # La resolucion de la fuente y su checksum no dependen de la raiz: se
    # calculan en la primera pasada y se reutilizan por indice en las raices
    # siguientes (el orden de los assets es identico en todas).
    local resolved_sources=() resolved_shas=()
    shift
    for root in "${ROOTS[@]}"; do
        resolved_index=0
        for declared_asset in "$@"; do
            asset_source="${declared_asset%%|*}"
            asset_mode="${declared_asset##*|}"
            asset_id="$collection_name/$asset_source"
            asset_destination="$asset_source"
            safe_relative_path "$asset_source" || usage_error "$collection_name declaro una fuente insegura: $asset_source"
            case "$asset_mode" in 0644|0755) ;; *) usage_error "$collection_name declaro un modo desconocido: $asset_mode" ;; esac
            if [ "$resolved_index" -lt "${#resolved_sources[@]}" ]; then
                absolute_asset_source="${resolved_sources[$resolved_index]}"
                asset_sha="${resolved_shas[$resolved_index]}"
            else
                case "$asset_source" in */*) asset_source_parent="$REPO_ROOT/${asset_source%/*}" ;; *) asset_source_parent="$REPO_ROOT" ;; esac
                asset_source_dir="$(cd "$asset_source_parent" 2>/dev/null && pwd -P)" || usage_error "$collection_name declaro una fuente ausente: $asset_source"
                absolute_asset_source="$asset_source_dir/${asset_source##*/}"
                case "$absolute_asset_source" in "$REPO_ROOT"/*) ;; *) usage_error "$collection_name declaro una fuente fuera del repositorio: $asset_source" ;; esac
                [ -f "$absolute_asset_source" ] || usage_error "$collection_name declaro una fuente ausente o no regular: $asset_source"
                [ ! -L "$absolute_asset_source" ] || usage_error "$collection_name declaro una fuente mediante symlink: $asset_source"
                asset_sha="$(sha256 "$absolute_asset_source")"
                resolved_sources+=("$absolute_asset_source")
                resolved_shas+=("$asset_sha")
            fi
            resolved_index=$((resolved_index + 1))
            full_rel="$root/$asset_destination"
            paths_overlap "$full_rel" "$root/.mefisto-generated-assets.json" && usage_error "$collection_name colisiona con el inventario del motor: $full_rel"
            for plan_destination in ${ASSET_PLAN_DESTINATIONS[@]+"${ASSET_PLAN_DESTINATIONS[@]}"}; do
                ! paths_overlap "$plan_destination" "$full_rel" || usage_error "$collection_name colisiona en destino: $full_rel"
            done
            for generated_path in ${GENERATED[@]+"${GENERATED[@]}"}; do
                ! paths_overlap "$generated_path" "$full_rel" || usage_error "$collection_name colisiona con salida agent/command: $full_rel"
            done
            stage_parent="$STAGE_DIR/${full_rel%/*}"
            [ -d "$stage_parent" ] || mkdir -p "$stage_parent" || usage_error "no se pudo preparar $full_rel"
            cp "$absolute_asset_source" "$STAGE_DIR/$full_rel" || usage_error "no se pudo copiar $collection_name: $asset_source"
            chmod "$asset_mode" "$STAGE_DIR/$full_rel" || usage_error "no se pudo fijar el modo de $full_rel"
            ASSET_PLANS+=("$(jq -cn --arg adapter "$collection_name" --arg id "$asset_id" --arg source "$asset_source" --arg destination "$full_rel" --arg mode "$asset_mode" --arg sha256 "$asset_sha" '{adapter: $adapter, id: $id, source: $source, destination: $destination, mode: $mode, sha256: $sha256}')")
            ASSET_PLAN_ADAPTERS+=("$collection_name")
            ASSET_PLAN_IDS+=("$asset_id")
            ASSET_PLAN_DESTINATIONS+=("$full_rel")
            ASSET_COUNT=$((ASSET_COUNT + 1))
            GENERATED+=("$full_rel")
        done
    done
}

# Los mirrors transitorios de la raiz instalada por el marketplace no son una
# tercera fuente: reutilizan byte a byte la salida ya renderizada por Claude.
# Se mantienen fuera de dist/ porque el marketplace aun apunta a `./`.
for declared_mirror in "${CLAUDE_ROOT_MIRRORS[@]}"; do
    mirror_source="${declared_mirror%%|*}"
    mirror_destination="${declared_mirror##*|}"
    mirror_generated="dist/claude/${mirror_source#src/published/}"
    safe_relative_path "$mirror_destination" || usage_error "mirror Claude declaro un destino inseguro: $mirror_destination"
    generated_contains "$mirror_generated" || continue
    paths_overlap "$mirror_destination" "dist" && usage_error "mirror Claude colisiona con dist/: $mirror_destination"
    mkdir -p "$(dirname "$STAGE_DIR/$mirror_destination")" || usage_error "no se pudo preparar el mirror Claude: $mirror_destination"
    cp "$STAGE_DIR/$mirror_generated" "$STAGE_DIR/$mirror_destination" || usage_error "no se pudo preparar el mirror Claude: $mirror_destination"
    GENERATED+=("$mirror_destination")
done

# Los assets se enumeran despues de los Markdown para poder rechazar cualquier
# colision contra sus salidas antes de publicar una sola raiz real.
for adapter_index in "${!ADAPTERS[@]}"; do
    adapter="${ADAPTERS[$adapter_index]}"
    adapter_name="$(basename "$adapter")"
    root="${ROOTS[$adapter_index]}"
    assets_stdout="$STAGE_DIR/assets-$adapter_index.json"
    assets_stderr="$STAGE_DIR/assets-$adapter_index.stderr"
    if ! "$adapter" assets > "$assets_stdout" 2> "$assets_stderr"; then
        # Los adaptadores sin extension existentes rechazan la operacion sin
        # salida. Un diagnostico identifica en cambio un fallo real.
        if [ -s "$assets_stdout" ] || [ -s "$assets_stderr" ]; then
            printf 'ERROR: %s no pudo enumerar assets suplementarios\n' "$adapter_name" >&2
            [ ! -s "$assets_stderr" ] || cat "$assets_stderr" >&2
            exit 1
        fi
        continue
    fi
    ASSET_ROOTS+=("$root")
    jq -e 'type == "array" and all(.[]; type == "object" and (keys | sort) == ["destination", "id", "mode", "source"] and (.id | type == "string") and (.source | type == "string") and (.destination | type == "string") and (.mode | type == "string"))' "$assets_stdout" >/dev/null 2>&1 || usage_error "$adapter_name declaro assets suplementarios invalidos"
    while IFS= read -r asset; do
        # Un `jq -r` por campo: `@tsv` escaparia \\t, \\n y \\\\ dentro de los valores,
        # y un destino con salto de linea real dejaria de ser rechazado por
        # safe_relative_path. Son 4 procesos por asset (lineal), no por par.
        asset_id="$(printf '%s' "$asset" | jq -r '.id')"
        asset_source="$(printf '%s' "$asset" | jq -r '.source')"
        asset_destination="$(printf '%s' "$asset" | jq -r '.destination')"
        asset_mode="$(printf '%s' "$asset" | jq -r '.mode')"
        safe_relative_path "$asset_id" || usage_error "$adapter_name asset '$asset_id' declaro un id inseguro"
        safe_relative_path "$asset_source" || usage_error "$adapter_name asset '$asset_id' declaro una fuente insegura"
        safe_relative_path "$asset_destination" || usage_error "$adapter_name asset '$asset_id' declaro un destino inseguro"
        case "$asset_mode" in 0644|0755) ;; *) usage_error "$adapter_name asset '$asset_id' declaro un modo desconocido: $asset_mode" ;; esac
        case "$asset_source" in */*) asset_source_parent="$REPO_ROOT/${asset_source%/*}" ;; *) asset_source_parent="$REPO_ROOT" ;; esac
        asset_source_dir="$(cd "$asset_source_parent" 2>/dev/null && pwd -P)" || usage_error "$adapter_name asset '$asset_id' declaro una fuente ausente: $asset_source"
        absolute_asset_source="$asset_source_dir/${asset_source##*/}"
        case "$absolute_asset_source" in "$REPO_ROOT"/*) ;; *) usage_error "$adapter_name asset '$asset_id' declaro una fuente fuera del repositorio: $asset_source" ;; esac
        [ -f "$absolute_asset_source" ] || usage_error "$adapter_name asset '$asset_id' declaro una fuente ausente: $asset_source"
        [ ! -L "$absolute_asset_source" ] || usage_error "$adapter_name asset '$asset_id' declaro una fuente fuera del repositorio mediante symlink: $asset_source"
        full_rel="$root/$asset_destination"
        paths_overlap "$full_rel" "$root/.mefisto-generated-assets.json" && usage_error "$adapter_name asset '$asset_id' colisiona con el inventario del motor: $full_rel"
        for plan_index in "${!ASSET_PLAN_DESTINATIONS[@]}"; do
            plan_adapter="${ASSET_PLAN_ADAPTERS[$plan_index]}"
            plan_id="${ASSET_PLAN_IDS[$plan_index]}"
            plan_destination="${ASSET_PLAN_DESTINATIONS[$plan_index]}"
            [ "$plan_adapter:$plan_id" != "$adapter_name:$asset_id" ] || usage_error "$adapter_name asset '$asset_id' repite un id"
            ! paths_overlap "$plan_destination" "$full_rel" || usage_error "$adapter_name asset '$asset_id' colisiona en destino con otro asset: $full_rel"
        done
        for generated_path in ${GENERATED[@]+"${GENERATED[@]}"}; do
            ! paths_overlap "$generated_path" "$full_rel" || usage_error "$adapter_name asset '$asset_id' colisiona con salida agent/command: $full_rel"
        done
        stage_parent="$STAGE_DIR/${full_rel%/*}"
        [ -d "$stage_parent" ] || mkdir -p "$stage_parent" || usage_error "no se pudo preparar $full_rel"
        if ! "$adapter" render-asset "$asset_id" "$absolute_asset_source" > "$STAGE_DIR/$full_rel"; then
            printf "ERROR: %s no pudo renderizar el asset '%s'; no se escribio nada\n" "$adapter_name" "$asset_id" >&2
            exit 1
        fi
        chmod "$asset_mode" "$STAGE_DIR/$full_rel" || usage_error "no se pudo fijar el modo de $full_rel"
        ASSET_PLANS+=("$(jq -cn --arg adapter "$adapter_name" --arg id "$asset_id" --arg source "$asset_source" --arg destination "$full_rel" --arg mode "$asset_mode" --arg sha256 "$(sha256 "$STAGE_DIR/$full_rel")" '{adapter: $adapter, id: $id, source: $source, destination: $destination, mode: $mode, sha256: $sha256}')")
        ASSET_PLAN_ADAPTERS+=("$adapter_name")
        ASSET_PLAN_IDS+=("$asset_id")
        ASSET_PLAN_DESTINATIONS+=("$full_rel")
        ASSET_COUNT=$((ASSET_COUNT + 1))
        GENERATED+=("$full_rel")
    done < <(jq -c '.[]' "$assets_stdout")
done

# Proyecta la clausura estatica en CADA raiz publicada. A diferencia de los
# assets propios de un adaptador, esta lista es neutral a runtime: conserva el
# mismo layout relativo que el checkout para que el runner y los pipelines se
# resuelvan igual desde la raiz de cualquier paquete.
# Toda raiz recibe ahora assets, incluso si su adaptador Markdown es heredado y
# no implementa `assets`; por eso el inventario se deriva de las raices, no de
# esa capacidad opcional del adaptador.
ASSET_ROOTS=("${ROOTS[@]}")
while IFS= read -r knowledge_source; do
    [ -n "$knowledge_source" ] && KNOWLEDGE_CLOSURE_ASSETS+=("${knowledge_source#"$REPO_ROOT/"}|0644")
done < <(find "$REPO_ROOT/docs/adr" -maxdepth 1 -type f -name 'mef-adr-*.md' | sort)
[ "${#KNOWLEDGE_CLOSURE_ASSETS[@]}" -gt 0 ] || usage_error "tooling-knowledge no descubrio ningun docs/adr/mef-adr-*.md"
KNOWLEDGE_CLOSURE_ASSETS+=('docs/testing/harness-cheatsheet.md|0644')
project_static_assets 'tooling-closure' "${TOOLING_CLOSURE_ASSETS[@]}"
project_static_assets 'tooling-knowledge' "${KNOWLEDGE_CLOSURE_ASSETS[@]}"

for root in ${ASSET_ROOTS[@]+"${ASSET_ROOTS[@]}"}; do
    inventory="$root/.mefisto-generated-assets.json"
    if [ "$ASSET_COUNT" -eq 0 ] && [ ${#RENDERED_PLANS[@]} -eq 0 ]; then
        inventory_assets='[]'
    else
        inventory_assets="$({ printf '%s\n' ${ASSET_PLANS[@]+"${ASSET_PLANS[@]}"}; printf '%s\n' ${RENDERED_PLANS[@]+"${RENDERED_PLANS[@]}"}; } | jq -s --arg root "$root" '[.[] | select(.destination | startswith($root + "/")) | {adapter, id, source, destination: (.destination | ltrimstr($root + "/")), mode, sha256}] | sort_by(.adapter, .id)')"
    fi
    jq -cn --argjson assets "$inventory_assets" '{schemaVersion: 1, assets: $assets}' > "$STAGE_DIR/$inventory" || usage_error "no se pudo escribir el inventario de $root"
    chmod 0644 "$STAGE_DIR/$inventory" || usage_error "no se pudo fijar el modo de $inventory"
    GENERATED+=("$inventory")
done

is_supplemental_asset() {
    local needle="$1" plan_destination
    [ "$ASSET_COUNT" -gt 0 ] || return 1
    for plan_destination in "${ASSET_PLAN_DESTINATIONS[@]}"; do
        [ "$plan_destination" = "$needle" ] && return 0
    done
    return 1
}

was_supplemental_asset() {
    local inventory="$1" needle="$2" destination
    [ -f "$inventory" ] || return 1
    while IFS= read -r destination; do
        [ "$destination" = "$needle" ] && return 0
    done < <(jq -r '.assets[]?.destination // empty' "$inventory" 2>/dev/null)
    return 1
}

if [ "$CHECK_MODE" -eq 1 ]; then
    divergent=0
    for relpath in ${GENERATED[@]+"${GENERATED[@]}"}; do
        existing="$OUT_ROOT/$relpath"
        if output_path_has_symlink "$relpath"; then
            printf '%s: enlace simbolico\n' "$relpath"; divergent=1
        elif [ ! -f "$existing" ]; then
            printf '%s: faltante\n' "$relpath"; divergent=1
        elif [ "${relpath##*/}" = '.mefisto-generated-assets.json' ]; then
            if ! cmp -s "$STAGE_DIR/$relpath" "$existing"; then
                printf '%s: inventario inconsistente\n' "$relpath"
                divergent=1
            elif [ "$(file_mode "$STAGE_DIR/$relpath")" != "$(file_mode "$existing")" ]; then
                printf '%s: modo divergente\n' "$relpath"; divergent=1
            fi
        elif is_supplemental_asset "$relpath"; then
            if ! cmp -s "$STAGE_DIR/$relpath" "$existing"; then
                printf '%s: distinta\n' "$relpath"; divergent=1
            elif [ "$(file_mode "$STAGE_DIR/$relpath")" != "$(file_mode "$existing")" ]; then
                printf '%s: modo divergente\n' "$relpath"; divergent=1
            fi
        elif ! has_any_generated_marker "$existing"; then
            printf '%s: sin marcador\n' "$relpath"; divergent=1
        elif ! cmp -s "$STAGE_DIR/$relpath" "$existing"; then
            printf '%s: distinta\n' "$relpath"; divergent=1
        elif [ "$(file_mode "$STAGE_DIR/$relpath")" != "$(file_mode "$existing")" ]; then
            printf '%s: modo divergente\n' "$relpath"; divergent=1
        fi
    done
    for root in "${ROOTS[@]}"; do
        existing_inventory="$OUT_ROOT/$root/.mefisto-generated-assets.json"
        while IFS= read -r existing; do
            [ -n "$existing" ] || continue
            relpath="${existing#"$OUT_ROOT"/}"
            generated_contains "$relpath" && continue
            if [ -L "$existing" ]; then
                printf '%s: enlace simbolico\n' "$relpath"
            elif has_any_generated_marker "$existing"; then
                printf '%s: huerfana\n' "$relpath"
            elif was_supplemental_asset "$existing_inventory" "${relpath#"$root"/}"; then
                printf '%s: huerfana\n' "$relpath"
            elif [ "${existing##*/}" = '.mefisto-generated-assets.json' ]; then
                printf '%s: inventario inconsistente\n' "$relpath"
            else
                printf '%s: sin marcador\n' "$relpath"
            fi
            divergent=1
        done < <(find "$OUT_ROOT/$root" \( -type f -o -type l \) 2>/dev/null | sort)
    done
    exit "$divergent"
fi

# Valida los destinos fuera de dist/ antes de reemplazar las raices publicadas.
# Ademas de evitar escrituras a traves de symlinks, este preflight impide que un
# destino incompatible deje dist/ actualizado y el mirror raiz sin publicar.
for declared_mirror in "${CLAUDE_ROOT_MIRRORS[@]}"; do
    mirror_source="${declared_mirror%%|*}"
    mirror_destination="${declared_mirror##*|}"
    mirror_generated="dist/claude/${mirror_source#src/published/}"
    generated_contains "$mirror_generated" || continue
    output_path_has_symlink "$mirror_destination" && usage_error "mirror Claude atraviesa un enlace simbolico: $mirror_destination"
    if [ -e "$OUT_ROOT/$mirror_destination" ] && [ ! -f "$OUT_ROOT/$mirror_destination" ]; then
        usage_error "mirror Claude tiene un destino no regular: $mirror_destination"
    fi
done

# Se preparan arboles completos antes de reemplazar las raices declaradas. Esto
# elimina huerfanos y archivos manuales, de modo que escribir y luego comprobar
# siempre converge al mismo arbol.
mkdir -p "$OUT_ROOT" || usage_error "no se pudo crear la raiz de salida"
PUBLISH_DIR="$(mktemp -d "$OUT_ROOT/.published-adapters.XXXXXX")" || usage_error "no se pudo preparar la publicacion"
mkdir -p "$PUBLISH_DIR/candidates" "$PUBLISH_DIR/backups" || usage_error "no se pudo preparar la publicacion"
index=0
for root in "${ROOTS[@]}"; do
    mkdir -p "$PUBLISH_DIR/candidates/$index" || usage_error "no se pudo preparar $root"
    cp -R "$STAGE_DIR/$root/." "$PUBLISH_DIR/candidates/$index/" || usage_error "no se pudo preparar $root"
    index=$((index + 1))
done

swapped=0
index=0
for root in "${ROOTS[@]}"; do
    destination="$OUT_ROOT/$root"
    mkdir -p "$(dirname "$destination")" || break
    if [ -e "$destination" ] || [ -L "$destination" ]; then
        mv "$destination" "$PUBLISH_DIR/backups/$index" || break
    fi
    if mv "$PUBLISH_DIR/candidates/$index" "$destination"; then
        swapped=$((swapped + 1))
    else
        [ ! -e "$PUBLISH_DIR/backups/$index" ] || mv "$PUBLISH_DIR/backups/$index" "$destination"
        break
    fi
    index=$((index + 1))
done

if [ "$swapped" -ne "${#ROOTS[@]}" ]; then
    index=$((swapped - 1))
    while [ "$index" -ge 0 ]; do
        root="${ROOTS[$index]}"
        rm -rf "$OUT_ROOT/$root"
        [ ! -e "$PUBLISH_DIR/backups/$index" ] || mv "$PUBLISH_DIR/backups/$index" "$OUT_ROOT/$root"
        index=$((index - 1))
    done
    usage_error "no se pudieron publicar todas las raices; se restauro la salida anterior"
fi

for declared_mirror in "${CLAUDE_ROOT_MIRRORS[@]}"; do
    mirror_source="${declared_mirror%%|*}"
    mirror_destination="${declared_mirror##*|}"
    mirror_generated="dist/claude/${mirror_source#src/published/}"
    generated_contains "$mirror_generated" || continue
    mkdir -p "$(dirname "$OUT_ROOT/$mirror_destination")" || usage_error "no se pudo preparar el mirror Claude: $mirror_destination"
    cp "$STAGE_DIR/$mirror_destination" "$OUT_ROOT/$mirror_destination" || usage_error "no se pudo publicar el mirror Claude: $mirror_destination"
    chmod 0644 "$OUT_ROOT/$mirror_destination" || usage_error "no se pudo fijar el modo del mirror Claude: $mirror_destination"
done

exit 0
