#!/usr/bin/env bash
# mefisto-release.sh -- Versionado y publicacion del plugin Mefisto.
#
# Implementacion CANONICA (MEF-ADR-0049 decision 2, issue #864). El shim de
# compatibilidad .claude/scripts/mefisto-release.sh reenvia aqui via `exec`
# (plantilla documentada en src/internal/scripts/README.md); invocar por
# cualquiera de las dos rutas es equivalente.
#
# Uso:
#   src/internal/scripts/mefisto-release.sh patch     # prepare + merge + sync + publish
#   src/internal/scripts/mefisto-release.sh minor     # idem, bumpeando Y
#   src/internal/scripts/mefisto-release.sh major     # idem, bumpeando X
#   src/internal/scripts/mefisto-release.sh patch --prepare-only   # solo el PR de release
#   src/internal/scripts/mefisto-release.sh           # fase publish (tag + GH release)
#
# Dos fases en una invocacion logica:
#   prepare (plugin.json.version == ultimo tag)
#     - crea rama release/vX.Y.Z
#     - mueve [Unreleased] del CHANGELOG.md a [X.Y.Z] - YYYY-MM-DD
#     - actualiza links de comparacion al pie
#     - bumpea .claude-plugin/plugin.json con jq
#     - commitea, pushea, abre PR contra main
#     - encadena el remate (issue #759, default): mergea el PR (squash +
#       delete-branch), sincroniza main de forma verificada y se re-invoca sin
#       argumentos para aterrizar en publish. Con --prepare-only se detiene
#       tras crear el PR e imprime los tres pasos manuales.
#   publish (plugin.json.version > ultimo tag)
#     - exige main + working tree limpio + al dia con origin/main + gh auth
#     - extrae notas de la seccion [X.Y.Z] del CHANGELOG
#     - crea tag anotado, lo pushea
#     - crea GitHub Release con esas notas
#
# Sigue SemVer y Keep a Changelog (formato declarado en el header del CHANGELOG).

set -euo pipefail

# _mefisto-common.sh ya vive en src/internal/scripts/lib/ (issue #869): se
# resuelve relativo a este propio archivo, igual que el resto de la libreria
# (mefisto-state.sh, mefisto-runtime.sh...), sin pasar por .claude/scripts/.
# assert_in_mefisto (definida dentro) exporta MEFISTO_REPO_ROOT.
source "$(dirname "${BASH_SOURCE[0]}")/lib/_mefisto-common.sh"
assert_in_mefisto || exit 1

# Ruta absoluta del propio script, resuelta ANTES del cd: la fase prepare se
# re-invoca para encadenar la publish (issue #759) y "$0" relativo dejaria de
# resolver una vez cambiado el directorio de trabajo.
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

cd "$MEFISTO_REPO_ROOT"

# --- Colores y logging ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_info()    { echo -e "${CYAN}[$(date +%H:%M:%S)]${NC} $1"; }
log_success() { echo -e "${GREEN}${BOLD}v${NC} $1"; }
log_warn()    { echo -e "${YELLOW}!${NC} $1" >&2; }
log_error()   { echo -e "${RED}${BOLD}x ERROR:${NC} $1" >&2; }
abort()       { log_error "$1"; exit 1; }

# --- Dependencias ---
for cmd in jq git gh python3; do
    command -v "$cmd" >/dev/null 2>&1 || abort "Falta comando requerido: $cmd"
done

PLUGIN_JSON="$MEFISTO_REPO_ROOT/.claude-plugin/plugin.json"
CHANGELOG="$MEFISTO_REPO_ROOT/CHANGELOG.md"
PUBLISHED_GENERATOR="$MEFISTO_REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
RELEASE_IDENTITY="$MEFISTO_REPO_ROOT/src/published/release-identity.json"
CLAUDE_MANIFEST="$MEFISTO_REPO_ROOT/mefisto-manifest.json"
DIST_CLAUDE_MANIFEST="$MEFISTO_REPO_ROOT/dist/claude/mefisto-manifest.json"
[ -f "$PLUGIN_JSON" ] || abort "No existe $PLUGIN_JSON"
[ -f "$CHANGELOG" ]   || abort "No existe $CHANGELOG"
[ -x "$PUBLISHED_GENERATOR" ] || abort "No existe o no es ejecutable el generador publicado: $PUBLISHED_GENERATOR"

REPO_SLUG="${MEFISTO_REPO_SLUG:-}"
if [ -z "$REPO_SLUG" ]; then
    REPO_SLUG=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")
fi
[ -n "$REPO_SLUG" ] || abort "No se pudo determinar el repo slug (gh repo view fallo)"

REPO_URL="https://github.com/${REPO_SLUG}"

# --- Helpers ---

# current_plugin_version: imprime la version actual de plugin.json
current_plugin_version() {
    jq -r '.version' "$PLUGIN_JSON"
}

# latest_tag_version: imprime la version (sin prefijo v) del ultimo tag SemVer,
# o cadena vacia si no hay ninguno.
latest_tag_version() {
    git tag -l 'v[0-9]*.[0-9]*.[0-9]*' \
        | sed 's/^v//' \
        | sort -V \
        | tail -n1
}

# bump_version <current> <part>  -> nueva version segun SemVer
bump_version() {
    local current="$1" part="$2"
    [[ "$current" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] \
        || abort "La version actual no es SemVer X.Y.Z: $current"
    local major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}" patch="${BASH_REMATCH[3]}"
    case "$part" in
        major) echo "$((major+1)).0.0" ;;
        minor) echo "${major}.$((minor+1)).0" ;;
        patch) echo "${major}.${minor}.$((patch+1))" ;;
        *)     abort "Parte SemVer invalida: $part (esperado patch|minor|major)" ;;
    esac
}

# extract_unreleased_section: extrae el contenido del bloque [Unreleased]
# (sin el header). Imprime en stdout.
extract_unreleased_section() {
    python3 - "$CHANGELOG" <<'PYEOF'
import re, sys
path = sys.argv[1]
with open(path, encoding='utf-8') as f:
    text = f.read()
m = re.search(r'(?ms)^##\s*\[Unreleased\][^\n]*\n(.*?)(?=^##\s*\[|\Z)', text)
if not m:
    sys.exit(0)
sys.stdout.write(m.group(1).rstrip() + "\n" if m.group(1).strip() else "")
PYEOF
}

# extract_version_section <version>: extrae el contenido de [X.Y.Z]
# (sin el header), apto para usar como notas de release.
extract_version_section() {
    local version="$1"
    python3 - "$CHANGELOG" "$version" <<'PYEOF'
import re, sys
path, version = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as f:
    text = f.read()
pattern = r'(?ms)^##\s*\[' + re.escape(version) + r'\][^\n]*\n(.*?)(?=^##\s*\[|^\[Unreleased\]:|\Z)'
m = re.search(pattern, text)
if not m:
    sys.exit(1)
body = m.group(1).strip()
sys.stdout.write(body + "\n")
PYEOF
}

# summarize_version_section <notas>: recibe el cuerpo de una seccion
# versionada (la salida de extract_version_section) y emite, por cada
# categoria Keep a Changelog presente (Added/Changed/Fixed/Removed, en ese
# orden), una linea con el conteo de entradas de primer nivel ("- ...").
# Cota superior de tamano garantizada: el numero de categorias es fijo (4),
# a diferencia de las notas completas cuyo tamano crece con cada entrada.
# No modifica ni trunca las notas originales -- solo alimenta el resumen del
# body del PR de release; el CHANGELOG.md y el GitHub Release (fase publish)
# siguen llevando las notas integras via extract_version_section.
# El texto viaja por variable de entorno (no por stdin ni argv): un heredoc
# `python3 - <<'PYEOF'` ya usa stdin para pasar el propio script a python, y
# el texto puede superar los ~100K caracteres de una seccion real.
summarize_version_section() {
    SUMMARIZE_INPUT="$1" python3 - <<'PYEOF'
import os, re

text = os.environ['SUMMARIZE_INPUT']
order = ["Added", "Changed", "Fixed", "Removed"]

# Descartar los bloques cercados (```) antes de contar: una entrada del
# CHANGELOG de este repo puede embeber un snippet, y una linea "- ..." dentro
# del snippet no es una entrada -- contarla inflaria el indice en silencio.
kept, fenced = [], False
for line in text.split("\n"):
    if re.match(r'^\s*```', line):
        fenced = not fenced
        continue
    if not fenced:
        kept.append(line)
text = "\n".join(kept)

counts = {}
for m in re.finditer(r'(?ms)^###\s*(\w+)[^\n]*\n(.*?)(?=^###\s|\Z)', text):
    name = m.group(1)
    entries = len(re.findall(r'(?m)^-\s', m.group(2)))
    counts[name] = counts.get(name, 0) + entries

for name in order:
    if name in counts:
        print(f"- **{name}**: {counts[name]} entrada(s)")
for name, count in counts.items():
    if name not in order:
        print(f"- **{name}**: {count} entrada(s)")
PYEOF
}

# rewrite_changelog_prepare <new_version> <prev_version> <date>
# Reescribe el CHANGELOG: mueve [Unreleased] a [new] y actualiza/agrega
# links de comparacion al pie.
rewrite_changelog_prepare() {
    local new_version="$1" prev_version="$2" date="$3" tmp
    tmp=$(mktemp)
    REPO_URL="$REPO_URL" \
    NEW_VERSION="$new_version" \
    PREV_VERSION="$prev_version" \
    RELEASE_DATE="$date" \
    python3 - "$CHANGELOG" "$tmp" <<'PYEOF'
import os, re, sys

src, dst = sys.argv[1], sys.argv[2]
new_version = os.environ['NEW_VERSION']
prev_version = os.environ['PREV_VERSION']
date = os.environ['RELEASE_DATE']
repo_url = os.environ['REPO_URL']

with open(src, encoding='utf-8') as f:
    text = f.read()

# 1. Mover bloque [Unreleased] a una seccion versionada y dejar [Unreleased] vacio.
m = re.search(
    r'(?ms)^(##\s*\[Unreleased\][^\n]*\n)(.*?)(?=^##\s*\[|\Z)',
    text,
)
if not m:
    print("ERROR: no se encontro la seccion [Unreleased]", file=sys.stderr)
    sys.exit(1)

unreleased_header = m.group(1)
unreleased_body = m.group(2)
if not unreleased_body.strip():
    print("ERROR: la seccion [Unreleased] esta vacia, nada que liberar", file=sys.stderr)
    sys.exit(1)

new_block = (
    unreleased_header
    + "\n"
    + f"## [{new_version}] - {date}\n"
    + (unreleased_body if unreleased_body.endswith("\n") else unreleased_body + "\n")
)
text = text[:m.start()] + new_block + text[m.end():]

# 2. Actualizar link [Unreleased] al pie. Si no existe, anadirlo al final.
unreleased_link = f"[Unreleased]: {repo_url}/compare/v{new_version}...HEAD"
new_version_link = f"[{new_version}]: {repo_url}/compare/v{prev_version}...v{new_version}"

if re.search(r'(?m)^\[Unreleased\]:[^\n]*$', text):
    text = re.sub(
        r'(?m)^\[Unreleased\]:[^\n]*$',
        unreleased_link,
        text,
        count=1,
    )
else:
    if not text.endswith("\n"):
        text += "\n"
    text += unreleased_link + "\n"

# 3. Insertar el link de la nueva version justo debajo del de [Unreleased].
text = re.sub(
    r'(?m)^(\[Unreleased\]:[^\n]*\n)',
    r'\1' + new_version_link + "\n",
    text,
    count=1,
)

with open(dst, "w", encoding='utf-8') as f:
    f.write(text)
PYEOF
    mv "$tmp" "$CHANGELOG"
}

# bump_plugin_json <new_version>
bump_plugin_json() {
    local new_version="$1" tmp
    tmp=$(mktemp)
    jq --arg v "$new_version" '.version = $v' "$PLUGIN_JSON" > "$tmp"
    mv "$tmp" "$PLUGIN_JSON"
}

# write_release_identity <version> <source-commit>: la identidad se escribe en
# un temporal y se publica con rename para que nunca exista JSON truncado.
write_release_identity() {
    local version="$1" source_commit="$2" tmp
    tmp=$(mktemp "${RELEASE_IDENTITY}.XXXXXX") || return 1
    jq -cn --arg version "$version" --arg commit "$source_commit" \
        '{schemaVersion:1,version:$version,commit:$commit}' > "$tmp" \
        && mv "$tmp" "$RELEASE_IDENTITY" || { rm -f "$tmp"; return 1; }
}

# write_claude_manifest: el mirror de raiz y dist/claude se comparan por bytes
# durante publish; jq -c conserva una representacion canonica identica.
write_claude_manifest() {
    local tmp
    tmp=$(mktemp "${CLAUDE_MANIFEST}.XXXXXX") || return 1
    jq -c '{schemaVersion:.schemaVersion,runtime:"claude",version:.version,commit:.commit}' \
        "$RELEASE_IDENTITY" > "$tmp" \
        && mv "$tmp" "$CLAUDE_MANIFEST" || { rm -f "$tmp"; return 1; }
}

discard_release_branch() {
    local original_branch="$1" release_branch="$2"
    git reset --hard >/dev/null 2>&1 || true
    # reset --hard no elimina archivos no trackeados. El mirror raiz nace en
    # el primer release posterior a #1131, por lo que un generador fallido lo
    # dejaria visible al volver a la rama original si no se limpia de forma
    # explicita junto con las salidas Claude que el generador pudo crear.
    git clean -fd -- mefisto-manifest.json dist/claude >/dev/null 2>&1 || true
    git switch "$original_branch" >/dev/null 2>&1 || true
    git branch -D "$release_branch" >/dev/null 2>&1 || true
}

prepare_metadata() {
    local version="$1" source_commit="$2"
    write_release_identity "$version" "$source_commit" \
        || return 1
    write_claude_manifest \
        || return 1
    bump_plugin_json "$version" \
        || return 1
    "$PUBLISHED_GENERATOR" \
        || return 1
    cmp -s "$CLAUDE_MANIFEST" "$DIST_CLAUDE_MANIFEST" \
        || return 1
}

validate_release_identity() {
    jq -e '
        (keys | sort) == ["commit", "schemaVersion", "version"] and
        .schemaVersion == 1 and
        (.version | type == "string" and test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$")) and
        (.commit | type == "string" and test("^[0-9a-f]{40}$"))
    ' "$RELEASE_IDENTITY" >/dev/null 2>&1
}

validate_publish_delta() {
    local source_commit="$1" status path delta
    # Una sustitucion de proceso ocultaria el exit code de git diff y podria
    # convertir un objeto ausente/corrupto en un delta vacio valido.
    delta=$(git diff --name-status "$source_commit..HEAD") || return 1
    while IFS=$'\t' read -r status path; do
        [ -n "$path" ] || continue
        case "$path" in
            CHANGELOG.md|docs/adr/INDICE-TEMATICO.md|.claude-plugin/plugin.json|src/published/release-identity.json|mefisto-manifest.json|dist/claude/mefisto-manifest.json|dist/claude/.mefisto-generated-assets.json) ;;
            changelog.d/*.md)
                [ "$status" = "D" ] && [ "$path" != "changelog.d/README.md" ] \
                    || return 1 ;;
            *) return 1 ;;
        esac
    done <<< "$delta"
}

# tag_exists_local <tag>
tag_exists_local() {
    git rev-parse -q --verify "refs/tags/$1" >/dev/null 2>&1
}

# tag_exists_remote <tag>
tag_exists_remote() {
    git ls-remote --tags --exit-code origin "$1" >/dev/null 2>&1
}

# release_exists <tag>
release_exists() {
    gh release view "$1" >/dev/null 2>&1
}

# require_clean_tree
require_clean_tree() {
    if [ -n "$(git status --porcelain)" ]; then
        abort "Hay cambios sin commitear. Limpia el working tree antes de continuar."
    fi
}

# require_gh_auth
require_gh_auth() {
    gh auth status >/dev/null 2>&1 || abort "gh no esta autenticado. Ejecuta 'gh auth login' y reintenta."
}

# ============================================================================
# Deteccion de fase
# ============================================================================
CURRENT_VERSION=$(current_plugin_version)
LAST_TAG_VERSION=$(latest_tag_version)

[ -n "$CURRENT_VERSION" ] || abort "No se pudo leer .claude-plugin/plugin.json (.version)"
[ -n "$LAST_TAG_VERSION" ] || abort "El repo no tiene tags vX.Y.Z previos. Crea al menos uno manualmente antes de usar este skill."

log_info "Version en plugin.json: ${CURRENT_VERSION}"
log_info "Ultimo tag SemVer:      v${LAST_TAG_VERSION}"

if [ "$CURRENT_VERSION" = "$LAST_TAG_VERSION" ]; then
    PHASE="prepare"
elif [ "$(printf '%s\n%s\n' "$CURRENT_VERSION" "$LAST_TAG_VERSION" | sort -V | tail -n1)" = "$CURRENT_VERSION" ]; then
    PHASE="publish"
else
    abort "Inconsistencia: plugin.json.version (${CURRENT_VERSION}) es menor que el ultimo tag (v${LAST_TAG_VERSION})."
fi

# ============================================================================
# FASE PREPARE
# ============================================================================
if [ "$PHASE" = "prepare" ]; then
    echo -e "\n${CYAN}${BOLD}=== Fase prepare ===${NC}"

    BUMP_PART=""
    PREPARE_ONLY=false
    for arg in "$@"; do
        case "$arg" in
            patch|minor|major)
                [ -z "$BUMP_PART" ] || abort "Solo se admite una magnitud de bump (patch|minor|major); recibido tambien '$arg'."
                BUMP_PART="$arg"
                ;;
            --prepare-only)
                PREPARE_ONLY=true
                ;;
            *)
                abort "Argumento invalido: '$arg'. Esperado patch|minor|major [--prepare-only]."
                ;;
        esac
    done

    if [ -z "$BUMP_PART" ]; then
        cat >&2 <<EOF
Uso: $(basename "$0") {patch|minor|major} [--prepare-only]

plugin.json.version (${CURRENT_VERSION}) ya coincide con el ultimo tag (v${LAST_TAG_VERSION}).
Necesitas indicar la magnitud del bump para preparar el PR de release.
EOF
        exit 1
    fi

    NEW_VERSION=$(bump_version "$CURRENT_VERSION" "$BUMP_PART")
    NEW_TAG="v${NEW_VERSION}"
    PREV_VERSION="$CURRENT_VERSION"
    RELEASE_BRANCH="release/${NEW_TAG}"
    RELEASE_DATE=$(date -u +%Y-%m-%d)

    log_info "Bump: ${PREV_VERSION} -> ${NEW_VERSION} (${BUMP_PART})"
    log_info "Rama de release: ${RELEASE_BRANCH}"
    log_info "Fecha (UTC): ${RELEASE_DATE}"

    # Precondiciones
    require_clean_tree
    require_gh_auth

    if tag_exists_local "$NEW_TAG" || tag_exists_remote "$NEW_TAG"; then
        abort "Ya existe el tag ${NEW_TAG}. Aborta para no pisar historia."
    fi
    if release_exists "$NEW_TAG"; then
        abort "Ya existe un GitHub Release ${NEW_TAG}. Aborta."
    fi

    if git show-ref --verify --quiet "refs/heads/$RELEASE_BRANCH"; then
        abort "Ya existe localmente la rama ${RELEASE_BRANCH}. Borrala o renombra antes de continuar."
    fi

    # Asegurar que main esta al dia antes de ramificar
    CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
    log_info "Rama actual: ${CURRENT_BRANCH}"

    log_info "Actualizando refs desde origin..."
    git fetch origin --tags --quiet || abort "No se pudo hacer fetch desde origin"

    # La identidad de una release es el commit que alimenta el squash, no el
    # commit etiquetable que resultara del merge. Se captura una sola vez, desde
    # la misma ref usada para crear la rama, antes de tocar metadata.
    SOURCE_COMMIT=$(git rev-parse --verify 'origin/main^{commit}') \
        || abort "No se pudo resolver origin/main como commit fuente"
    [[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] \
        || abort "origin/main no resolvio un SHA completo y valido; no se modifico metadata"
    [ "$(git rev-parse origin/main)" = "$SOURCE_COMMIT" ] \
        || abort "origin/main divergio al capturar el commit fuente; reintenta antes de modificar metadata"
    log_info "Commit fuente capturado: ${SOURCE_COMMIT}"

    log_info "Creando rama ${RELEASE_BRANCH} desde origin/main..."
    git switch -c "$RELEASE_BRANCH" origin/main >/dev/null 2>&1 \
        || abort "No se pudo crear la rama ${RELEASE_BRANCH} (verifica que origin/main existe)"
    if [ "$(git rev-parse HEAD)" != "$SOURCE_COMMIT" ]; then
        discard_release_branch "$CURRENT_BRANCH" "$RELEASE_BRANCH"
        abort "La rama ${RELEASE_BRANCH} no se creo exactamente desde el commit fuente ${SOURCE_COMMIT}; no se modifico metadata"
    fi

    # Gate de neutralidad de runtime (MEF-ADR-0049, issue #914): sobre la rama
    # de release recien creada, antes de consolidar changelog.d/ -- misma
    # degradacion que el gate de tooling (mefisto-tooling-pipeline.sh): lista
    # de violaciones "<ruta>:<linea>: <regla>" y aborto si mefisto-neutrality-gate.sh
    # sale en 1. Sin --root: a diferencia del pipeline de tooling (que juzga un
    # WORKTREE separado desde el checkout principal), aqui no hay dos arboles
    # -- el propio script resuelve su repo (este mismo checkout, ya en
    # ${RELEASE_BRANCH}) por defecto. "publish" no repite este gate (CA-2).
    log_info "Verificando neutralidad de runtime (MEF-ADR-0049)..."
    NEUTRALITY_OUT=""
    if NEUTRALITY_OUT="$("$MEFISTO_REPO_ROOT/src/internal/scripts/mefisto-neutrality-gate.sh" 2>&1)"; then
        log_success "Gate de neutralidad: sin fugas"
    else
        # La rama de release aun no tiene commits propios y el arbol esta limpio
        # (require_clean_tree): se deshace antes de abortar, para que el
        # reintento no tropiece con "Ya existe localmente la rama". Las fugas
        # vienen de origin/main, asi que la rama de release tampoco era el
        # lugar para corregirlas.
        git switch "$CURRENT_BRANCH" >/dev/null 2>&1 && git branch -D "$RELEASE_BRANCH" >/dev/null 2>&1 || true
        # Remedio por regla (issue #1469): misma funcion que consume el
        # pipeline de tooling (mefisto-tooling-pipeline.sh), sin duplicar el
        # texto -- solo cambia el marco alrededor (fuga en origin/main, rama
        # de release ya deshecha, reintento del propio comando de release).
        NEUTRALITY_REMEDY="$(echo "$NEUTRALITY_OUT" | mefisto_neutrality_remedy)"
        abort "Fuga(s) de neutralidad de runtime (MEF-ADR-0049) en origin/main:
$NEUTRALITY_OUT
$NEUTRALITY_REMEDY
Una release no se publica con fugas: corrigelas en main via PR de issue (el pipeline de tooling corre este mismo gate) y reintenta '/mefisto-release ${BUMP_PART}'. La rama ${RELEASE_BRANCH} se deshizo (no tenia commits propios); estas de vuelta en ${CURRENT_BRANCH}."
    fi

    # Consolidar fragmentos de changelog.d/ (issue #380): cada PR anoto su
    # cambio como fragmento propio en vez de editar CHANGELOG.md/docs/adr/
    # INDICE-TEMATICO.md directo. Se consolida AQUI -- ya en la rama de release, ramificada de
    # origin/main -- para leer el estado real y completo de los fragmentos
    # mergeados, no el working tree previo (potencialmente desactualizado).
    log_info "Consolidando fragmentos de changelog.d/..."
    consolidate_changelog_fragments "$MEFISTO_REPO_ROOT" \
        || abort "Fallo al consolidar los fragmentos de CHANGELOG (changelog.d/): revisa el nombre de cada fragmento (<issue>.<categoria>.md)"
    consolidate_adr_index_fragments "$MEFISTO_REPO_ROOT" \
        || abort "Fallo al consolidar los fragmentos del indice de ADRs (changelog.d/*.adr-index.md)"

    UNRELEASED_BODY=$(extract_unreleased_section || true)
    if [ -z "$UNRELEASED_BODY" ] || [ -z "$(echo "$UNRELEASED_BODY" | tr -d '[:space:]')" ]; then
        abort "La seccion [Unreleased] del CHANGELOG esta vacia (ni fragmentos en changelog.d/ ni entradas previas). Agrega notas antes de hacer release."
    fi

    # Reescribir CHANGELOG e identidad publicada. Si la generacion de cualquier
    # manifest falla, se descarta toda la rama local antes de dejar un artefacto
    # parcial que pudiera confundirse con una release preparada.
    log_info "Reescribiendo CHANGELOG.md..."
    if ! rewrite_changelog_prepare "$NEW_VERSION" "$PREV_VERSION" "$RELEASE_DATE" \
        || ! prepare_metadata "$NEW_VERSION" "$SOURCE_COMMIT"; then
        discard_release_branch "$CURRENT_BRANCH" "$RELEASE_BRANCH"
        abort "Fallo al generar la identidad o los manifiestos de release; la rama ${RELEASE_BRANCH} se descarto sin salida parcial"
    fi

    # Verificar que tenemos cambios stage-ables (incluye docs/adr/INDICE-TEMATICO.md
    # y el borrado de fragmentos consumidos en changelog.d/, ademas del CHANGELOG,
    # plugin.json, la fuente neutral y todos los manifests generados).
    # changelog.d/ se stagea aparte y bajo guarda: git no versiona directorios, asi
    # que la carpeta no existe en un checkout donde no quede ningun archivo dentro,
    # y con 'set -e' un pathspec sin match abortaria el release entero.
    git add CHANGELOG.md docs/adr/INDICE-TEMATICO.md .claude-plugin/plugin.json \
        src/published/release-identity.json mefisto-manifest.json \
        dist/claude/mefisto-manifest.json dist/claude/.mefisto-generated-assets.json
    if [ -d changelog.d ]; then
        git add -A changelog.d/
    fi
    if git diff --cached --quiet; then
        abort "No se produjeron cambios mecanicos de release (algo va mal)"
    fi

    COMMIT_MSG="chore(release): ${NEW_TAG}"
    log_info "Commiteando: ${COMMIT_MSG}"
    git commit -m "$COMMIT_MSG" >/dev/null

    log_info "Pusheando rama ${RELEASE_BRANCH}..."
    git push -u origin "$RELEASE_BRANCH" >/dev/null 2>&1 \
        || abort "No se pudo pushear la rama ${RELEASE_BRANCH}"

    # Extraer notas de la nueva seccion versionada. El body del PR NO las
    # vuelca completas (issue #405: la API de GitHub rechaza un body de PR de
    # mas de 65536 caracteres, y una sola seccion versionada de este repo ya
    # supera ese limite 1.66x) -- se resumen a un indice de categorias con
    # conteo (cota superior de tamano fija) y se enlaza el CHANGELOG completo
    # en la rama de release. Las notas integras siguen viviendo en el diff del
    # propio PR y, en la fase publish, en el GitHub Release.
    RELEASE_NOTES=$(extract_version_section "$NEW_VERSION") \
        || abort "No se pudieron extraer las notas de [${NEW_VERSION}] del CHANGELOG"
    RELEASE_SUMMARY=$(summarize_version_section "$RELEASE_NOTES") \
        || abort "No se pudo resumir las notas de [${NEW_VERSION}] para el body del PR"
    # Fallback: la seccion no traia subsecciones "### Categoria" (entradas
    # escritas a mano directo bajo [Unreleased], sin pasar por changelog.d/).
    # El indice queda vacio, pero el body no debe degradar a una seccion muda.
    if [ -z "$RELEASE_SUMMARY" ]; then
        RELEASE_SUMMARY="- Sin subsecciones \`### Categoria\` en \`[${NEW_VERSION}]\`; ver las notas completas."
    fi
    CHANGELOG_LINK="${REPO_URL}/blob/${RELEASE_BRANCH}/CHANGELOG.md"

    PR_BODY_FILE=$(mktemp)
    cat > "$PR_BODY_FILE" <<EOF
## Resumen

PR de release ${NEW_TAG} (${BUMP_PART}: ${PREV_VERSION} -> ${NEW_VERSION}).

- Consolida los fragmentos de \`changelog.d/\` (CHANGELOG e indice de ADRs de \`docs/adr/INDICE-TEMATICO.md\`) y los borra.
- Mueve \`[Unreleased]\` a \`[${NEW_VERSION}] - ${RELEASE_DATE}\` en \`CHANGELOG.md\`.
- Bumpea \`.claude-plugin/plugin.json\` a ${NEW_VERSION}.
- Persiste la identidad fuente \`${SOURCE_COMMIT}\` y regenera los manifiestos Claude.
- Actualiza links de comparacion al pie del CHANGELOG.

## Categorias del release

${RELEASE_SUMMARY}

Notas completas: [\`CHANGELOG.md\`](${CHANGELOG_LINK}) en esta rama (\`${RELEASE_BRANCH}\`).

## Siguiente paso

Por defecto (issue #759) el propio \`/mefisto-release ${BUMP_PART}\` remata solo: mergea este PR (squash + delete-branch), sincroniza \`main\` y publica el tag ${NEW_TAG} con su GitHub Release.

Si se invoco con \`--prepare-only\`, el remate es manual:

1. \`/mefisto-merge <pr>\` para mergear este PR a \`main\`.
2. \`git switch main && git pull --ff-only\` para sincronizar local.
3. \`/mefisto-release\` (sin argumentos) para crear el tag ${NEW_TAG} y el GitHub Release.
EOF

    log_info "Creando PR contra main..."
    PR_URL=$(gh pr create \
        --base main \
        --head "$RELEASE_BRANCH" \
        --title "${COMMIT_MSG}" \
        --body-file "$PR_BODY_FILE") \
        || abort "No se pudo crear el PR"
    rm -f "$PR_BODY_FILE"

    log_success "PR de release creado: ${PR_URL}"
    PR_NUM=$(echo "$PR_URL" | grep -oE '[0-9]+$' || true)
    [ -n "$PR_NUM" ] || abort "No se pudo extraer el numero del PR de la salida de gh: '${PR_URL}'. El PR quedo creado; retoma con /mefisto-merge <pr>, luego git switch main && git pull --ff-only, luego /mefisto-release (sin argumentos)."

    echo ""
    echo -e "${CYAN}${BOLD}=== Resumen prepare ===${NC}"
    echo "  Version:  ${PREV_VERSION} -> ${NEW_VERSION} (${BUMP_PART})"
    echo "  Rama:     ${RELEASE_BRANCH}"
    echo "  PR:       ${PR_URL}"

    if [ "$PREPARE_ONLY" = true ]; then
        echo ""
        echo "Siguiente paso (--prepare-only):"
        echo "  /mefisto-merge ${PR_NUM}"
        echo "  git switch main && git pull --ff-only"
        echo "  /mefisto-release   # (sin argumentos) para publicar el tag y el release"
        exit 0
    fi

    # ------------------------------------------------------------------------
    # Encadenamiento (default): merge -> sync verificado -> fase publish.
    # Cada eslabon es fail-loud (issue #759): si falla, aborta reportando que
    # quedo hecho y el paso manual restante -- los mismos tres pasos de
    # --prepare-only siguen siendo el camino de recuperacion.
    # ------------------------------------------------------------------------
    echo ""
    echo -e "${CYAN}${BOLD}=== Encadenando merge + sync + publish ===${NC}"

    log_info "Mergeando PR #${PR_NUM} (squash + delete-branch)..."
    gh pr merge "$PR_NUM" --squash --delete-branch \
        || abort "Fallo el merge del PR #${PR_NUM}. Hecho: PR ${PR_URL} creado (sigue abierto). Paso manual: /mefisto-merge ${PR_NUM}; luego git switch main && git pull --ff-only; luego /mefisto-release (sin argumentos)."

    log_info "Confirmando estado MERGED y commit de merge del PR #${PR_NUM}..."
    MERGE_SHA="" PR_STATE=""
    for attempt in 1 2 3; do
        PR_JSON=$(gh pr view "$PR_NUM" --json state,mergeCommit 2>/dev/null || echo "")
        PR_STATE=$(echo "$PR_JSON" | jq -r '.state // empty')
        MERGE_SHA=$(echo "$PR_JSON" | jq -r '.mergeCommit.oid // empty')
        [ "$PR_STATE" = "MERGED" ] && [ -n "$MERGE_SHA" ] && break
        sleep 2
    done
    if [ "$PR_STATE" != "MERGED" ] || [ -z "$MERGE_SHA" ]; then
        abort "No se pudo confirmar el estado MERGED del PR #${PR_NUM} tras reintentos. Hecho: merge disparado contra GitHub. Paso manual: verifica 'gh pr view ${PR_NUM}'; luego git switch main && git pull --ff-only; luego /mefisto-release (sin argumentos)."
    fi
    log_success "PR #${PR_NUM} MERGED (commit ${MERGE_SHA})."

    log_info "Sincronizando origin/main..."
    git fetch origin main --quiet \
        || abort "git fetch origin main fallo. Hecho: PR #${PR_NUM} mergeado (commit ${MERGE_SHA}). Paso manual: git switch main && git pull --ff-only; luego /mefisto-release (sin argumentos)."

    PRESENT=false
    for attempt in 1 2 3; do
        if git merge-base --is-ancestor "$MERGE_SHA" origin/main 2>/dev/null; then
            PRESENT=true
            break
        fi
        sleep 2
        git fetch origin main --quiet || true
    done
    if [ "$PRESENT" != true ]; then
        abort "El commit de merge ${MERGE_SHA} no aparece como ancestro de origin/main tras reintentos. Hecho: PR #${PR_NUM} mergeado. Paso manual: git switch main && git pull --ff-only; luego /mefisto-release (sin argumentos)."
    fi

    log_info "Sincronizando main local (switch + merge --ff-only)..."
    git switch main >/dev/null 2>&1 \
        || abort "No se pudo hacer 'git switch main'. Hecho: merge #${PR_NUM} confirmado en origin/main (${MERGE_SHA}). Paso manual: git switch main && git pull --ff-only; luego /mefisto-release (sin argumentos)."
    git merge --ff-only origin/main >/dev/null 2>&1 \
        || abort "'git merge --ff-only origin/main' fallo. Hecho: merge #${PR_NUM} confirmado en origin/main (${MERGE_SHA}), ya en rama main. Paso manual: git merge --ff-only origin/main; luego /mefisto-release (sin argumentos)."

    log_success "main sincronizado con origin/main (${MERGE_SHA})."

    echo ""
    log_info "Encadenando fase publish (re-invocando $(basename "$SCRIPT_PATH") sin argumentos)..."
    "$SCRIPT_PATH" \
        || abort "La fase publish fallo. Hecho: PR #${PR_NUM} mergeado y main sincronizado (commit ${MERGE_SHA}). Paso manual: resuelve la precondicion reportada arriba y reintenta con '/mefisto-release' (sin argumentos)."

    exit 0
fi

# ============================================================================
# FASE PUBLISH
# ============================================================================
echo -e "\n${CYAN}${BOLD}=== Fase publish ===${NC}"

if [ "$#" -gt 0 ]; then
    log_warn "Argumento '${1}' ignorado en fase publish (plugin.json ya esta bumpeado)."
fi

NEW_VERSION="$CURRENT_VERSION"
NEW_TAG="v${NEW_VERSION}"
PREV_VERSION="$LAST_TAG_VERSION"

log_info "Tag a crear: ${NEW_TAG} (publicando ${PREV_VERSION} -> ${NEW_VERSION})"

# Precondiciones
require_gh_auth

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
    abort "Debes estar en 'main' para publicar el release (rama actual: ${CURRENT_BRANCH})."
fi

require_clean_tree

log_info "Actualizando refs de origin..."
git fetch origin main --tags --quiet || abort "No se pudo hacer fetch de origin"

BEHIND_COUNT=$(git rev-list --count HEAD..origin/main)
AHEAD_COUNT=$(git rev-list --count origin/main..HEAD)
if [ "$BEHIND_COUNT" -gt 0 ]; then
    abort "main local esta ${BEHIND_COUNT} commit(s) detras de origin/main. Ejecuta 'git pull --ff-only' y reintenta."
fi
if [ "$AHEAD_COUNT" -gt 0 ]; then
    abort "main local tiene ${AHEAD_COUNT} commit(s) que no estan en origin/main. Pushea o resetea antes de publicar."
fi

HEAD_COMMIT=$(git rev-parse HEAD) || abort "No se pudo resolver HEAD para validar publish"
ORIGIN_MAIN_COMMIT=$(git rev-parse origin/main) || abort "No se pudo resolver origin/main para validar publish"
[ "$HEAD_COMMIT" = "$ORIGIN_MAIN_COMMIT" ] \
    || abort "HEAD no coincide exactamente con origin/main; sincroniza main y reintenta antes de crear el tag"

# Publish no reescribe ni recalcula la identidad: comprueba la que dejo
# prepare, su padre directo tras el squash y todas sus proyecciones publicadas.
validate_release_identity \
    || abort "release-identity.json es invalido; regenera la metadata con /mefisto-release <bump> antes de publicar"
SOURCE_COMMIT=$(jq -r '.commit' "$RELEASE_IDENTITY")
IDENTITY_VERSION=$(jq -r '.version' "$RELEASE_IDENTITY")
HEAD_PARENT=$(git rev-parse 'HEAD^') \
    || abort "HEAD no tiene padre directo para validar el commit fuente; regenera la metadata"
[ "$HEAD_PARENT" = "$SOURCE_COMMIT" ] \
    || abort "El padre directo de HEAD no coincide con el commit fuente de release-identity.json; la release debe mergearse por squash y regenerarse"
[ "$IDENTITY_VERSION" = "$NEW_VERSION" ] \
    || abort "release-identity.json reporta ${IDENTITY_VERSION}, no ${NEW_VERSION}; regenera la metadata"

for manifest in "$CLAUDE_MANIFEST" "$DIST_CLAUDE_MANIFEST"; do
    jq -e --arg version "$NEW_VERSION" --arg commit "$SOURCE_COMMIT" \
        '. == {schemaVersion:1,runtime:"claude",version:$version,commit:$commit}' "$manifest" >/dev/null 2>&1 \
        || abort "El manifiesto Claude ${manifest#$MEFISTO_REPO_ROOT/} no coincide con release-identity.json; regenera la metadata"
done
cmp -s "$CLAUDE_MANIFEST" "$DIST_CLAUDE_MANIFEST" \
    || abort "Los manifiestos Claude de raiz y dist/claude difieren por bytes; regenera la metadata"
validate_publish_delta "$SOURCE_COMMIT" \
    || abort "El delta ${SOURCE_COMMIT}..HEAD contiene rutas ajenas a la allowlist mecanica de release; regenera la metadata en un squash limpio"

# Verificar coherencia: el plugin.json mergeado debe coincidir con el actual
MAIN_PLUGIN_VERSION=$(git show "origin/main:.claude-plugin/plugin.json" | jq -r '.version')
if [ "$MAIN_PLUGIN_VERSION" != "$NEW_VERSION" ]; then
    abort "plugin.json en origin/main reporta ${MAIN_PLUGIN_VERSION}, no ${NEW_VERSION}. El PR de release aun no esta mergeado."
fi

if tag_exists_local "$NEW_TAG"; then
    abort "Ya existe el tag local ${NEW_TAG}. Aborta."
fi
if tag_exists_remote "$NEW_TAG"; then
    abort "Ya existe el tag remoto ${NEW_TAG}. Aborta."
fi
if release_exists "$NEW_TAG"; then
    abort "Ya existe un GitHub Release ${NEW_TAG}. Aborta."
fi

NOTES_FILE=""
cleanup_publish_temporaries() {
    [ -n "$NOTES_FILE" ] && rm -f "$NOTES_FILE"
}
trap cleanup_publish_temporaries EXIT
# Un trap de senal que solo limpia y retorna permitiria que Bash continuara el
# publish. Salir explicitamente garantiza que nunca se alcance el tag despues
# de una interrupcion; el trap EXIT realiza la limpieza una sola vez.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Extraer notas del bloque versionado. A diferencia del body del PR (issue
# #405), aqui SI se publican integras. La documentacion oficial de la REST API
# no declara un maximo para 'body':
#   https://docs.github.com/en/rest/releases/releases#create-a-release
# El limite real que aplica la API es 125000 caracteres, verificado en el
# mensaje de error que devuelve (HTTP 422 "body is too long (maximum is 125000
# characters)") segun dos reportes independientes:
#   https://github.com/cli/cli/issues/7705
#   https://github.com/changesets/action/issues/304
# Es casi el doble del limite de 65536 de PRs/issues (GraphQL) que origino este
# issue. La seccion [0.18.0] medida en #405 (109010 caracteres, la mayor hasta
# la fecha) queda por debajo con margen (~16000 caracteres), asi que se deja
# esta fase sin truncar. Si una seccion futura se acerca a 125000, revisar
# esta cuenta.
RELEASE_NOTES=$(extract_version_section "$NEW_VERSION") \
    || abort "No se encontro la seccion [${NEW_VERSION}] en el CHANGELOG. Faltan notas en main?"

NOTES_FILE=$(mktemp)
printf '%s\n' "$RELEASE_NOTES" > "$NOTES_FILE"

# Crear y pushear tag anotado
log_info "Creando tag anotado ${NEW_TAG}..."
git tag -a "$NEW_TAG" -m "Release ${NEW_TAG}" \
    || abort "No se pudo crear el tag ${NEW_TAG}"

log_info "Pusheando tag ${NEW_TAG}..."
if ! git push origin "$NEW_TAG" >/dev/null 2>&1; then
    git tag -d "$NEW_TAG" >/dev/null 2>&1 || true
    abort "No se pudo pushear el tag ${NEW_TAG} (tag local revertido)"
fi

# Crear GitHub Release
log_info "Creando GitHub Release ${NEW_TAG}..."
if ! RELEASE_URL=$(gh release create "$NEW_TAG" \
        --title "${NEW_TAG}" \
        --notes-file "$NOTES_FILE"); then
    log_error "No se pudo crear el GitHub Release ${NEW_TAG}. El tag ya esta pusheado; no reedites la version ni el tag."
    cat >&2 <<EOF
Recuperacion (ejecuta el bloque completo desde la raiz del repo):
  recovery_notes=\$(mktemp)
  trap 'rm -f "\$recovery_notes"' EXIT
  python3 -c 'import re,sys; text=open(sys.argv[1], encoding="utf-8").read(); match=re.search(r"(?ms)^##\\s*\\[" + re.escape(sys.argv[2]) + r"\\][^\\n]*\\n(.*?)(?=^##\\s*\\[|^\\[Unreleased\\]:|\\Z)", text); print(match.group(1).strip()) if match else sys.exit(1)' CHANGELOG.md "${NEW_VERSION}" > "\$recovery_notes"
  gh release create "${NEW_TAG}" --title "${NEW_TAG}" --notes-file "\$recovery_notes"
EOF
    exit 1
fi

log_success "GitHub Release publicado: ${RELEASE_URL}"

echo ""
echo -e "${CYAN}${BOLD}=== Resumen publish ===${NC}"
echo "  v${PREV_VERSION} -> v${NEW_VERSION}"
echo "  Tag:     ${NEW_TAG}"
echo "  Release: ${RELEASE_URL}"
