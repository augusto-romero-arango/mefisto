# MEF-ADR-0054: Estimacion reproducible del costo de agentes

- **Fecha**: 2026-09-13
- **Estado**: aceptado
- **Aplica a**: el contrato neutral de telemetria de ejecuciones de agentes y sus adaptadores de runtime, en los lados interno y publicado de MEF-ADR-0019. Define la semantica del campo de costo `estimated_cost_usd`, su degradacion a `null` y su separacion del costo reportado legado. Complementa MEF-ADR-0049 (el adaptador traduce las senales de su runtime), MEF-ADR-0050 (los consumidores solo leen el contrato neutral), MEF-ADR-0025 (sin acceso a credenciales ni caches privadas) y MEF-ADR-0030 (reserva el identificador `0054`).

## Contexto

El campo historico `cost_usd` no tiene una semantica comparable entre runtimes: su nombre no declara si el importe es el consumo equivalente a tarifas API o la facturacion marginal de una suscripcion, que puede ser cero aunque haya consumo. Tratar ambos como el mismo costo ocultaria el costo relativo entre writer y reviewer y volveria enganosa la tabla de #1311. Claude Code expone su importe como `total_cost_usd` en el evento terminal de la corrida.

### Alcance

Este ADR fija la semantica, la degradacion y la migracion del campo neutral `estimated_cost_usd`, que emiten el runner y los adaptadores y que leen las metricas y los reportes.

### Que queda fuera de este ADR

- La facturacion real de una cuenta, suscripcion, API key o proveedor. Mefisto no pretende conciliar una factura.
- Consultar el auth store, configuracion privada o cache privada de un runtime o de cualquier proveedor.
- Fijar o duplicar en el repositorio las tarifas de un proveedor.
- Implementar los cambios de contrato, adaptadores, metricas o reportes de #1311-#1313.

## Decision

### 1. `estimated_cost_usd` es equivalencia a tarifa API, no costo marginal (CA-1)

Todo escritor nuevo de telemetria emite `estimated_cost_usd`, cuyo valor es el costo USD equivalente de los tokens consumidos a las tarifas API publicas del modelo resuelto. El campo es independiente de la forma de autenticacion, del plan de suscripcion y de la facturacion marginal que un runtime informe.

Un cero que exprese la facturacion marginal de una suscripcion **no es una estimacion** y queda prohibido propagarlo como `estimated_cost_usd: 0`. Cuando el runtime no aporta un importe de equivalencia API, el campo es `null` conforme a la decision 4. Un cero solo es valido cuando el consumo valorado a tarifa API es matematicamente cero.

El contrato neutral conserva separadas las responsabilidades:

- El adaptador traduce los eventos y contadores crudos de su runtime a modelo y tokens, y traduce a `estimated_cost_usd` un importe nativo cuya semantica de equivalencia API este verificada: el de Claude Code copia `total_cost_usd` (`src/runtime/lib/runtime-claude.jq`). No expone su wire format a consumidores.
- Un adaptador cuyo runtime no aporta ese importe emite `estimated_cost_usd: null`. Ningun componente del harness resuelve tarifas ni recalcula precios.
- Pipelines, tablas, metricas y consumidores usan `estimated_cost_usd` para estimaciones y totales; no inspeccionan la autenticacion, `total_cost_usd` ni otro campo del runtime. La unica excepcion de lectura es el historial legacy separado que fija la decision 5.

### 4. Telemetria degradable: `null`, nunca aborto (CA-4)

La estimacion es observabilidad auxiliar y no condiciona la ejecucion del agente ni el resultado funcional del pipeline.

Cuando el runtime no aporta un importe de equivalencia API, o el runner sintetiza el terminal de una corrida que no produjo uno, se emite `estimated_cost_usd: null`; nunca un cero ni otro valor inventado. Los reportes muestran el dato ausente como tal (`n/d` o `-`) y marcan la cobertura de cada corrida como `completa`, `parcial` o `sin estimacion`.

La corrida nunca aborta, se reintenta ni se marca fallida por la telemetria de costo.

### 5. Corte de contrato y lectura legacy separada (CA-5)

Desde la implementacion de este ADR, los escritores nuevos emiten **solo** `estimated_cost_usd`; no escriben el alias `cost_usd`, aunque el runtime aporte un campo con ese nombre. Los lectores aceptan indefinidamente historial que solo contenga `cost_usd`, pero lo etiquetan y presentan separado como **costo reportado legado**.

Un total estimado suma exclusivamente valores numéricos de `estimated_cost_usd`; ignora `null` y expone su cobertura/degradacion. Nunca mezcla, suma, sustituye ni renombra `cost_usd` dentro de un total estimado. Esta separacion evita tanto presentar un cero de facturacion marginal como estimacion como combinar una cifra de factura/runtime con una equivalencia API.

### 6. Rollout por dependencias (CA-6)

El rollout debe respetar este orden, sin adelantar reportes que vuelvan a interpretar el formato crudo:

1. **Contrato neutral y runner**: añadir `estimated_cost_usd` y la semantica `null`; mantener lectura legacy separada.
2. **Adaptadores de runtime**: traducir tokens, modelo resuelto y el importe nativo de equivalencia API, sin consultar secretos.
3. **Metricas internas**: persistir y visualizar estimados, cobertura y degradaciones sin abortar pipelines.
4. **Lado publicado**: consumir el mismo contrato neutral y proyectar la misma distincion entre estimado y costo reportado legado.
5. **#1311-#1313**: reconstruir la tabla y comparativas solo cuando los pasos anteriores produzcan evidencia reproducible.

## Alternativas consideradas

### Alt a: conservar `cost_usd` como costo comun

**Descartada**: el nombre no declara si el importe es equivalencia API o facturacion marginal; un cero de suscripcion haria parecer gratuitos pasos que tienen uso relativo significativo.

### Alt b: fijar tarifas en codigo o en el repositorio

**Descartada**: envejece silenciosamente, no permite saber cuando se validaron los datos y convierte precios externos en constantes del harness.

### Alt d: abortar cuando el costo no es resoluble

**Descartada**: una telemetria auxiliar no debe impedir un cambio funcional. `null` preserva la continuidad y hace visible la incertidumbre.

## Consecuencias

### Positivas

- Writer, reviewer y cualquier runtime se pueden comparar con una semantica explicita de equivalencia API.
- La degradacion evita tanto inventar costos como bloquear pipelines por observabilidad.
- El corte legacy permite leer historial sin contaminar nuevos totales estimados.

### Negativas

- La estimacion no es una factura y puede diferir de descuentos, suscripciones o precios privados.
- Un runtime que no aporta un importe de equivalencia API reduce la cobertura mediante `null`.

## Referencias

- MEF-ADR-0025: custodia de secretos; Mefisto no lee estado privado del runtime.
- MEF-ADR-0030: esquema de identificacion y reserva de `MEF-ADR-0054` como siguiente numero libre verificado.
- MEF-ADR-0049: arquitectura neutral de runtime/proveedor; los adaptadores traducen senales de runtime al contrato neutral.
- MEF-ADR-0050: neutralidad de toda operacion; consumidores no reinterpretan wire formats ni autenticacion.
- MEF-ADR-0057, decision 7: Claude Code es el unico runtime con adaptador.
- `src/runtime/contract/README.md` y `src/runtime/contract/run-events.schema.json`: contrato de eventos que define `estimated_cost_usd` y la lectura legacy de `cost_usd`.
- Issue #1321: origen de este ADR; #1311-#1313: consumidores y comparativa relacionados.

## Control de cambios

- 2026-09-13: creacion como `aceptado` (issue #1321). Define `estimated_cost_usd` como equivalencia a tarifa API y proscribe propagar ceros OAuth (seccion 1); fija formula por paso con input no cacheado, cache read/write, output visible y reasoning a tarifa de output, y tier por contexto antes de sumar (seccion 2); adopta Models.dev por `https://models.opencode.ai/api.json` con cache propia bajo `MEFISTO_STATE_DIR`, validacion UTC diaria y reemplazo atomico posterior a validar JSON/tarifas no negativas (seccion 3); degrada a ultima cache valida o `null` con aviso sin abortar la corrida (seccion 4); corta escritores a `estimated_cost_usd` y mantiene lectura legacy separada de `cost_usd` (seccion 5); y ordena el rollout hacia contrato, adaptadores, metricas, publicado y #1311-#1313, con las fuentes verificadas (seccion 6).
- 2026-11-10: enmienda por el retiro de OpenCode como runtime soportado (MEF-ADR-0057, decision 7). Salen del cuerpo la formula por paso (decision 2), el catalogo Models.dev con su cache (decision 3), la tabla de degradacion por catalogo de la decision 4, las fuentes verificadas de la decision 6 y la alternativa c, porque el estimador vivia solo en el adaptador de OpenCode; permanecen la semantica de `estimated_cost_usd` (decision 1), la degradacion a `null` sin abortar (decision 4), el corte de contrato con lectura legacy separada (decision 5) y el orden de rollout (decision 6).
