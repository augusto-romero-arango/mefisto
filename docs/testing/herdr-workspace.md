# Workspace Herdr de consumidores

`scripts/herdr-workspace.sh` monta en un consumidor una sola fila, la de
`claude`: el planner a la izquierda y ejecucion a la derecha. Sus labels
estables son `planner [claude]` y `ejecucion [claude]`; ambos panes heredan
`MEFISTO_RUNTIME=claude` y arrancan con `--kind claude`. El planner abre
`--agent mefisto:planner`; el pane de ejecucion arranca sin `--agent`. Los
agentes se registran como `planner-<slug>-claude` y `ejecucion-<slug>-claude`.
En un consumidor, `MEFISTO_RUNTIMES` y `MEFISTO_RUNTIME` no cambian la fila. El
script se distribuye en `dist/claude/scripts/`.

En el repo de Mefisto el planner es `mefisto-planner` y el default tambien es
una fila `claude`. Solo ahi se montan varias filas: `MEFISTO_RUNTIMES` (lista
separada por comas) monta una fila planner+ejecucion por cada id, en el orden
de la lista, con labels `planner [<kind>]`/`ejecucion [<kind>]`, `--kind <kind>`
y `MEFISTO_RUNTIME=<kind>`. `MEFISTO_RUNTIMES` tiene precedencia;
`MEFISTO_RUNTIME` selecciona una sola fila si la lista no esta definida. La
idempotencia es por (workspace, runtime): una fila cuyo label
`planner [<kind>]` ya existe no se toca, y las faltantes se agregan debajo del
planner de la ultima fila existente.

Si ya existe un workspace con el label del repo pero sin ningun pane de rol de
Mefisto (el caso de Herdr abriendo un pane en la carpeta del repo), el script
lo adopta: monta las filas debajo del pane raiz, que queda como estaba, sin
rename, sin agente y sin cambiar su cwd.

Al reenfocar un workspace de consumidor creado antes de esta convencion, el
script detecta los labels exactos legacy `planner` y `ejecucion` y los renombra
in-place. No cierra ni divide panes, no reinicia agentes y no modifica el cwd.
La migracion se completa por rol para poder reintentarse si un rename anterior
quedo a medias. Si falta el planner, un mismo rol esta duplicado o conserva a
la vez su label legacy y normalizado, informa un warning accionable y conserva
el layout existente. Si hubo una normalizacion, la invocacion solo enfoca. Un
workspace ya normalizado solo se enfoca, sin duplicar panes ni agentes.

Si el consumidor no tiene `.mefisto/harness.config.json` ni el fallback legacy
`.claude/harness.config.json`, el script avisa que el repo parece no estar
onboardeado y abre el workspace igual. Si un agente no arranca, el pane queda
con su shell y el script lo avisa.

La cobertura con el stub de Herdr esta en
`scripts/tests/test-herdr-workspace.sh`: verifica argv, paths con espacios,
el preflight de configuracion, fallos de arranque, migracion legacy,
ambiguedad, adopcion de un workspace sin panes de Mefisto e idempotencia de
las filas.
