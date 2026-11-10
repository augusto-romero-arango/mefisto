#!/usr/bin/env bash
# Test de contrato de external_directory (issue #1761): evalua el permission
# generado con la semantica de src/published/contract/README.md (ultima
# coincidencia, * cruza /, ~ se expande a HOME). Sin OpenCode real.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
ADAPTER="$REPO_ROOT/src/published/scripts/adapters/adapter-opencode.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

printf '%s\n' '---' '{"kind":"agent","effort":"light","id":"lector","description":"Prueba.","mode":"subagent","capabilities":["read","edit","shell"]}' '---' '{{mefisto:assert-consumer-repo}}' > "$WORK/lector.md"
"$ADAPTER" render "$WORK/lector.md" '<!-- GENERADO por prueba. -->' | awk '/^permission: /{sub(/^permission: /,""); print; exit}' > "$WORK/permission.json"
[ -s "$WORK/permission.json" ] || { fail 'no se pudo generar permission'; exit 1; }

HOME_DIR="/Users/ana"
WORKTREE="$HOME_DIR/code/proj"
export HOME_DIR WORKTREE
evaluate() {
    python3 - "$WORK/permission.json" "$1" "$2" <<'PY'
import json, os, posixpath, re, sys
perm = json.load(open(sys.argv[1])); kind, path = sys.argv[2], sys.argv[3]
home, worktree = os.environ["HOME_DIR"], os.environ["WORKTREE"]
def rx(p):
    if p.startswith("~/"): p = home + p[1:]
    return re.compile("^" + ".*".join(re.escape(x) for x in p.split("*")) + "$", re.S)
def decide(rule, cand):
    if isinstance(rule, str): return rule
    last = "ask"
    for pat, val in rule.items():
        if rx(pat).match(cand): last = val
    return last
path = posixpath.normpath(path)
ext = decide(perm["external_directory"], posixpath.dirname(path) + "/*") if not path.startswith(worktree + "/") else "allow"
rel = posixpath.relpath(path, worktree)
if kind == "read": act = decide(perm["read"], rel)
else: act = decide(perm[kind], rel)
print("allow" if ext == "allow" and act == "allow" else "deny")
PY
}
check() { local want="$1" kind="$2" path="$3" label="$4" got; got="$(evaluate "$kind" "$path")"; [ "$got" = "$want" ] && pass "$label" || fail "$label (esperado $want, obtuvo $got)"; }
bash_decision() {
    python3 - "$WORK/permission.json" "$1" <<'PY'
import json, re, sys
rules = json.load(open(sys.argv[1]))["bash"]; cand = sys.argv[2]; last = "ask"
for pat, val in rules.items():
    if re.match("^" + ".*".join(re.escape(x) for x in pat.split("*")) + "$", cand, re.S): last = val
print(last)
PY
}
check_bash() { local want="$1" cmd="$2" got; got="$(bash_decision "$cmd")"; [ "$got" = "$want" ] && pass "bash $want: $cmd" || fail "bash $cmd (esperado $want, obtuvo $got)"; }

MAC="$HOME_DIR/Library/Application Support/mefisto"
printf '%s\n' '[allow] lectura de la lista blanca'
check allow read "$MAC/releases/0.40.1/docs/adr/mef-adr-0002-x.md" 'ADR bajo release con espacios en la raiz (macOS)'
check allow read "$HOME_DIR/.local/share/mefisto/releases/0.40.1/docs/cheatsheet.md" 'release en Linux'
check allow read "$HOME_DIR/.config/opencode/skills/x/SKILL.md" 'skill instalado'
check allow read "$HOME_DIR/.config/opencode/agents/mefisto-x.md" 'agente instalado'
printf '%s\n' '[deny] fuera de la lista blanca'
check deny read "$HOME_DIR/.config/opencode/opencode.jsonc" 'opencode.jsonc'
check deny read "$HOME_DIR/.config/opencode/plugins/p.js" 'plugins'
check deny read "$HOME_DIR/.config/opencode/node_modules/m/index.js" 'node_modules'
check deny read "$HOME_DIR/.local/share/opencode/auth.json" 'credenciales del runtime'
check deny read "$HOME_DIR/.ssh/id_rsa" '.ssh'
check deny read "/tmp/x" '/tmp'
check deny read "$HOME_DIR/code/hermano/README.md" 'repo hermano'
printf '%s\n' '[deny] solo lectura'
check deny edit "$MAC/releases/0.40.1/docs/adr/mef-adr-0002-x.md" 'editar archivo de la release'
check deny write "$MAC/releases/0.40.1/x.md" 'escribir en la release'
check deny patch "$HOME_DIR/.local/share/mefisto/active/x" 'patch en la release'
check deny edit "$HOME_DIR/.config/opencode/skills/x/SKILL.md" 'editar skill instalado'
check allow edit "$WORKTREE/src/Foo.cs" 'editar el worktree sigue permitido'
check_bash deny "touch \"$MAC/releases/0.40.1/x\""
check_bash deny "mv a.txt $HOME_DIR/.config/opencode/skills/x/a.txt"
check_bash deny "sed -i s/a/b/ \"$MAC/releases/0.40.1/f\""
check_bash deny 'mkdir -p ${MEFISTO_PACKAGE_ROOT}/nuevo'
check_bash deny "rm -f $HOME_DIR/.local/share/mefisto/releases/0.40.1/f"
check_bash allow 'cat docs/adr/x.md'
check_bash allow 'touch .mefisto/pipeline/tmp/x'
printf '\nPASS=%s FAIL=%s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
