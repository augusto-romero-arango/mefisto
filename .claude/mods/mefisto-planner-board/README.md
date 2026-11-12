# mefisto-planner-board

Mod de Claude Code para la sesion del planner (MEF-ADR-0055): una banda sobre el prompt que dice que se esta
haciendo (refinar #N o explorar un tema) y da acceso a los borradores y listos en el orden de
`mefisto-next-order.mts`.

## Cargarlo

Una sola vez por checkout. Los mods se instalan en alcance `local` (`.claude/settings.local.json`, no
versionado) desde el marketplace de carpeta `.claude/mods/`:

```bash
claude plugin marketplace add ./.claude/mods --scope local
claude plugin install mefisto-divine-wager@mefisto-mods --scope local
claude plugin install mefisto-planner-board@mefisto-mods --scope local
```

Desde ahi cargan solos en toda sesion de este checkout, sin `--plugin-dir`, y se leen de la carpeta: un cambio
se aplica con `/reload-plugins`. Los worktrees de los pipelines no tienen `settings.local.json`, asi que sus
sesiones `-p` no los cargan. Para probar una copia suelta: `claude --plugin-dir .claude/mods/<mod>`.

Solo se activa en una sesion interactiva cuyo proceso es `claude --agent mefisto-planner` (lo lee de la linea
de comando del proceso, o del transcript como respaldo). Un planner lanzado como subagente o con `-p` no lo ve.
En otra sesion, `/mefisto-planner-board on` lo enciende a mano.

`/clear`, `/resume` y `/branch` conservan el tablero: reaparece en reposo en menos de un segundo y recarga las
listas sin esperar un mensaje (solo si estaba activo; una sesion que no es del planner y no se encendio a mano no
lo enciende). Lo reactiva un reloj de un segundo que compara la intencion del modulo con el atom: `session.start`
no se repite en esos casos, el engine no entrega eventos `classic.*` a un plugin de tier user y un `ui.render` no
puede hacerlo porque dibujar es puro y el engine rechaza su `state.set`. `/mefisto-planner-board off`
dura toda la sesion, tambien tras mensajes y `/clear`, hasta un `/mefisto-planner-board on`.

## Estados

- **refinar #N**: empieza con un mensaje que dice `refina #N`; termina cuando #N pasa a `estado:listo` o con
  el cierre del planner (`mefisto-field-note.mts`).
- **explorar**: cualquier otro mensaje desde reposo; el tema es su primera linea. Termina con el cierre.
- Los `gh issue create` de ambos se anotan como `creó #…`.

Con foco, la cabecera dice que se hace y desde cuando (`● refinar #N · 4 min`) y el cuerpo junto a la mascota
lo que la conversacion no muestra:

- **refinar**: el titulo completo y la ficha del issue: labels, de que depende (`#N ✓` si ya cerro, o su
  estado) y a quien bloquea (los de next-order que van tras el). Se relee con cada cambio de issues.
- **explorar**: el tema completo y una linea por borrador creado (`#N titulo · tipo:x`).

## Teclas (prompt vacio)

| Tecla | Accion |
|---|---|
| `1` / `2` | En reposo: `Quiero explorar: ` / `Refina el borrador #N` en el prompt |
| `3` / `4` | Abre o cierra la lista de borradores / listos. En `explorar`, tras crear el primer borrador la banda muestra sola la lista de borradores (`5`-`9`, `0` pagina) y un borrador nuevo la refresca al instante; sin creados se ve el tema |
| `5`-`9` | Borradores: `Refina el borrador #N` en el prompt. Listos es solo lectura: el planner no lanza trabajo |
| `0` | Siguiente pagina |

`/mefisto-planner-board [refresh|borradores|listos|cerrar|cerrar-sesion|on|off]` cubre lo mismo sin teclas.
`cerrar-sesion` hace lo mismo que el boton `1: cerrar sesión`: pide al planner su rutina de cierre sin confirmar
(`cerrar` solo cierra el foco, sin pedirla).

### Cuando un digito llega como texto

Un digito con el prompt vacio solo presiona un boton si la banda lo tiene armado: no lo esta con la banda
colapsada, con el boton fuera de la ventana visible o con una encuesta en la banda. Si no, el digito se escribe
en el prompt y viaja como mensaje. Se vio una vez, intermitente, con `1` en `explorar` justo tras pegar una
imagen (#2210, sin reproducir). El mod deja en el log de debug cada render de la cabecera (foco, teclas dibujadas,
`isWorking`, `hasSurvey`, `maxRows`) y cada `ui.press`: si falla de nuevo, ese log dice si el boton estaba en el
arbol y si llego la pulsacion. Mientras tanto, usar `/mefisto-planner-board cerrar-sesion`.

## Verificar un cambio

```bash
claude plugin validate .claude/mods/mefisto-planner-board
claude plugin test .claude/mods/mefisto-planner-board
```

## Quita optimista al refinar

Cuando el planner pasa #N a `estado:listo` o lo cierra (`gh issue close N`), el tablero lo quita de la lista de
borradores en el acto, antes de cualquier refresco: "siguiente a refinar", `2 refinar #N` y las teclas `5`-`9`
apuntan ya a la lista corregida. #N queda como transicion pendiente y todo refresco lo filtra de borradores hasta
que GitHub confirme el cambio (o pasen 60 s); mientras tanto el contador muestra `actualizando…`. La lista de
listos no se toca de forma optimista: #N aparece cuando un refresco lo trae, en el orden de `mefisto-next-order.mts`
(MEF-ADR-0055, decisiones 1, 8 y 11).
