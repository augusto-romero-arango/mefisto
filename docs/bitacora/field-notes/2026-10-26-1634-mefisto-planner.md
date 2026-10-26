---
fecha: 2026-10-26
hora: 16:34
sesion: mefisto-planner
tema: Refinar #2470 (dead letter en el primer intento en las bases de endpoint de Service Bus)
---

## Contexto
Refinamiento del borrador #2470, creado desde Bitakora.ControlAsistencia (#1172, #1175, #1177): un conflicto de concurrencia de Marten fue directo a dead letter y se perdio una marcacion.

## Descubrimientos
- Las tres bases del `domain-scaffolder` (Pasos 10c-10e) hacen dead letter ante cualquier excepcion; MEF-ADR-0004 capa 5 lo autoriza explicitamente ("excepto en endpoints de ServiceBus donde se hace dead letter explicito").
- En el fan-in, `DespacharPorSubject` mezcla interpretar e invocar, asi que la base no distingue mensaje ilegible de fallo del handler.
- El ejemplo de "Endpoint ServiceBus" del `implementer` duplica inline la liquidacion porque la base no traduce evento a comando.
- Microsoft Learn: el abandono incrementa el delivery count; al superar el maximo, la plataforma hace dead letter con `MaxDeliveryCountExceeded`.

## Decisiones
- Fan-in: `Interpretar(message) -> Func<CancellationToken, Task>` (patron del consumidor, PR #1198).
- Abandono inmediato sin backoff; `DeadLetterReason` con el tipo de la excepcion; `max_delivery_count` sin cambios; sin migracion de oficio en consumidores.
- Se enmiendan MEF-ADR-0004 capa 5 y MEF-ADR-0026 seccion 5.
- #2470 pasa a `estado:listo` con label `bug`.

## Descartado
- Excepcion tipada `MensajeIlegibleException` conservando `DespacharPorSubject`.

## Preguntas abiertas
- #2476 (unificar el ejemplo del `implementer` sobre la base) queda en borrador.

## Referencias
Refinados: #2470. Creados: #2476.
