---
fecha: 2026-10-28
hora: 12:53
sesion: mefisto-planner
tema: Refinar #2476 (ejemplo de Endpoint ServiceBus del implementer fuera de ServiceBusEndpointBase)
---

## Contexto
Refinamiento del borrador #2476, creado al refinar #2470: el ejemplo de "Endpoint ServiceBus" del `implementer` liquida a mano porque traduce evento -> comando y la base no sabe traducir.

## Descubrimientos
- La politica de liquidacion vive en dos lugares que ya divergen (el inline no trata lock perdido aparte y usa `ToObjectFromJson`).
- El consumidor lo resolvio con `ProcesarMensaje<TComando>(..., Func<TEvento, TComando> crearComando, ct)` en su base (PR #1191 de Bitakora.ControlAsistencia).

## Decisiones
- Sobrecarga en la base (usuario); la firma sin traduccion delega con identidad.
- La traduccion falla como el handler; `PrivateEventEndpointBase` sin sobrecarga; sin migracion de oficio.
- #2476 pasa a `estado:listo`, conserva `bloqueado` (depende de #2470).

## Descartado
- Cerrar #2476 y aceptar la duplicacion tras la alineacion de #2470.

## Preguntas abiertas
- Ninguna.

## Referencias
Refinados: #2476.
