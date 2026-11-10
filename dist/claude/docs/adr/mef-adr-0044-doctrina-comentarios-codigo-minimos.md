# MEF-ADR-0044: Doctrina de comentarios de codigo minimos

- **Fecha**: 2026-08-15 (enmendado 2026-11-10)
- **Estado**: aceptado
- **Aplica a**: doctrina del marco que fija que dice un comentario de codigo, que se borra, que queda blindado y quien lo revisa. Rige todo codigo que escriben o revisan los agentes del marco, del proyecto consumidor y del propio plugin (lado publicado e interno, MEF-ADR-0019): C#, HCL (al escribir **y** al revisar), bash, TypeScript y comentarios en YAML. Queda fuera la prosa Markdown de agentes, comandos, ADRs y docs, porque es doctrina y no comentario de codigo. Fuera de este ADR: los scaffolders y sus plantillas (no se obliga a limpiar plantillas existentes). Este ADR fija criterio, alcance, blindados y responsabilidad; la mecanica operativa vive en el Agent Skill `code-comments` (MEF-ADR-0033).

## Contexto

Los agentes del harness generan comentarios en exceso sobre el codigo. El patron se repite en tres formas:

- **Narracion del codigo**: un comentario que repite en prosa lo que la linea siguiente ya dice (`// Incrementa el contador` sobre `contador++`).
- **Provenance**: la convencion `// HU-XX` que `test-writer` antepone a sus tests, y citas sueltas a un issue, PR o tarea que origino el codigo -- informacion que pertenece al commit/PR, no al archivo.
- **Resumen de implementacion**: un bloque que describe que hizo el cambio o narra su historia temporal ("ahora usamos X en vez de Y"), en vez de documentar el estado presente del codigo.

La doctrina anterior de este ADR podaba pero no decia que si escribir: su criterio era abstracto, su alcance estrecho (`.cs` pleno, HCL solo al escribir, bash/TypeScript/plugin fuera) y el reviewer solo podaba -- nunca marcaba el porque o la precision que faltaban. El resultado es codigo que tiene a la vez comentarios que sobran y silencio donde un lector necesitaria una frase.

La enmienda adopta una heuristica concreta, basada en John Ousterhout, *A Philosophy of Software Design* (caps. 12-16), en una version **mas corta** que la del libro: un comentario dice lo que no es obvio al leer el codigo, en una frase si se puede. La seccion "Donde nos apartamos del libro" deja explicitas las diferencias.

> «Comments should describe things that are not obvious from the code.» -- Ousterhout, [CS190, *Writing Comments*](https://web.stanford.edu/~ouster/cgi-bin/cs190-winter18/lecture.php?topic=comments)

"No obvio" es mas amplio que "el codigo no puede decirlo": algo que se deduciria leyendo tres archivos tambien es no obvio y vale una linea. Lo que sobra es el **como**, contado al mismo nivel de detalle que el codigo.

## Decision

### 1. Jerarquia: codigo autodocumentado > comentario > documentacion externa

1. **Codigo autodocumentado** (nombres claros, tipos expresivos, estructura que refleja la intencion) es siempre la primera opcion. Si un nombre mejor o una extraccion de metodo eliminan la necesidad de explicar algo, esa refactorizacion se prefiere sobre escribir un comentario. Si el comentario es mas preciso que el nombre, se acorta el nombre, no el comentario.
2. **Comentario** es la segunda opcion, para lo que quien lee el codigo necesita y no ve en el (seccion 2).
3. **Documentacion externa** (ADRs del marco o del consumidor, `docs/`) es el ultimo recurso para doctrina que trasciende un archivo o un modulo -- nunca un sustituto de un comentario que documenta algo local que el lector necesita.

**Default: sin comentario.** Ante la duda entre escribir y no escribir, no se escribe; ante la duda entre borrar y acortar, se acorta.

### 2. Criterio: un comentario dice lo que no es obvio, en una frase si se puede

Se queda lo que quien lee el codigo por primera vez no veria en el. Seis categorias:

1. **El porque**: la regla de negocio, la decision de diseno, la restriccion de la plataforma o la trampa ya pisada que explica por que el codigo es asi y no de la forma "obvia".
2. **La precision que la firma no da**: la unidad o el formato (`ms`, centavos, `YYYY-MM-DD`), que significa `null` (¿no existe?, ¿cargando?, ¿fallo?), si un limite es inclusivo o exclusivo, un invariante, quien libera un recurso.
3. **Las dependencias**: "si cambias esto, cambia tambien X". Nombrar otro archivo es valido para eso o para remitir a donde vive el porque.
4. **El comportamiento no obvio de una API externa**, con la URL de su documentacion oficial: un campo ausente que deniega, una operacion que cuenta como otra, un limite de cuota, el fallo sin red, el orden de los eventos. Si no se abrio la documentacion, se dice "sin verificar".
5. **La interfaz**, solo cuando quien llama tendria que leer el cuerpo para usar bien la funcion, la clase o el campo. Dice el que y el contrato en palabras del dominio, nunca el como.
6. **Lo truculento**: el orden que importa, el caso borde que se rompio, la condicion de carrera evitada.

**Test operativo**: antes de escribir, *"¿que no vería alguien que lee este codigo por primera vez?"*; si la respuesta es "nada", no se escribe. Antes de borrar, *"¿lleva un porque, una precision, una dependencia o una API no obvia?"*; si lleva uno, se acorta a eso; si no lleva ninguno, se borra.

### 3. Lo que sobra (se borra)

- **Repetir el codigo o el nombre** con otras palabras (`// incrementa i`, un resumen que dice "obtiene el usuario" sobre `ObtenerUsuario()`).
- **Narrar los pasos** que se leen igual en el codigo.
- **Explicar como funciona otro modulo**: se lo nombra o se remite a el; su explicacion vive en el.
- **La misma explicacion copiada en varios archivos**: va una vez, junto al codigo que la origina o en un documento, y los demas remiten a ella.
- **Historia y narracion temporal**: "antes era...", "se movio de...", "ya no usamos...", fechas. Eso vive en `git log`/`git blame`.
- **Resumen del cambio o del PR** y **razonamiento del agente** ("pense en X pero elegi Y"): pertenecen al mensaje de commit y a la descripcion del PR.
- **Un issue, ticket o HU sin su porque** (`// HU-XX`, `#123`, `TICKET-45` sueltos). Junto al porque es una referencia valida (seccion 4); solo, es ruido. Esto proscribe la convencion `// HU-XX` de `test-writer`, que no tiene ningun consumidor mecanico.
- **La URL de la documentacion de un uso normal** de una API: esa cita va en la descripcion del PR.
- **Explicar sintaxis o librerias estandar** (que hace un `foreach`, un `using` o un metodo bien documentado de una libreria).
- **Codigo comentado**: para eso esta el historial.

### 4. Referencias a issues, tickets y ADRs

- Un issue o ticket **junto a su porque** es una referencia valida: el comentario lleva el porque y la referencia es el puntero para profundizar. **Solo**, es ruido y se borra.
- Una cita a `MEF-ADR-XXXX` (o a un ADR del consumidor) se conserva unicamente cuando acompana una restriccion local que el comentario explica. La cita sola indica de donde vino la decision, no que rige el codigo presente, y se borra.

### 5. Comentarios blindados

Los siguientes comentarios existen porque un ADR o una plantilla los exige; ninguna revision ni limpieza los borra ni los acorta:

- **MEF-ADR-0027** y **MEF-ADR-0032**: comentarios HCL que son el hogar canonico de doctrina -- la topologia de enrutamiento *"en los comentarios de Terraform de la subscription"* (0027) y las notas de la politica APIM, que *"van en comentarios HCL (`#`), nunca dentro del `xml_content`"* (0032, trampa B6). Podarlos destruiria la unica copia de esa doctrina.
- **MEF-ADR-0029**: el comentario junto al test de composicion del contenedor DI que documenta los limites de `ValidateOnBuild`.
- **MEF-ADR-0034** (seccion 10): el "comentario gemelo" de `AddSource`/`ActivitySource` junto a la fuente de OpenTelemetry que registran `domain-scaffolder` y `projections-scaffolder`.
- **Guardrails deliberados de scaffolders**, como el "No 'limpies' `using OpenTelemetry;` por parecer redundante" de `agents/projections-scaffolder.md` (sin ese `using`, `ConfigureResource`/`WithTracing` fallan con `CS1061`).

### 6. Alcance

Rige todo codigo que escriben o revisan los agentes del marco, del consumidor y del propio plugin (MEF-ADR-0019):

- **C#** (produccion, tests, smoke tests).
- **HCL (Terraform)**, tanto al **escribir** como al **revisar**: un comentario HCL se puede acortar o borrar con el mismo criterio, salvo los blindados de la seccion 5. La infraestructura pide mas precision y mas porques; la regla de fondo no cambia.
- **bash**, **TypeScript** y **comentarios en YAML** (workflows, configuracion).
- **Fuera**: la prosa Markdown de agentes, comandos, ADRs y docs. Es doctrina, no comentario de codigo, y la gobiernan las convenciones de documentacion del repo. JSON no admite comentarios (MEF-ADR-0038, seccion 7).
- **Scaffolders y plantillas**: fuera de este plan. El ADR no obliga a limpiar las plantillas existentes ni a reescribir lo que emiten; los guardrails de la seccion 5 siguen blindados.

### 7. Cuando NO aplica

- **Directivas**: `eslint-disable`, `# type: ignore`, `#pragma`, `@ts-expect-error`, `// +build`, `# noqa`, `#nullable`. Son instrucciones para una herramienta, no comentarios para el lector.
- **Licencias y cabeceras legales** que exige el proyecto.
- **Comentarios que otra herramienta consume**: docstrings que generan documentacion publica de una libreria, anotaciones de un framework o marcadores que exige el repo. En una API publica de libreria, manda el libro: interfaz completa.
- **Convenciones del proyecto** que pidan un comentario fijo (un ID de pantalla, una etiqueta de regla). Las define el `AGENTS.md` o las reglas del repo y mandan sobre este ADR.
- **Codigo de infraestructura** (reglas de seguridad, migraciones, concurrencia, criptografia): lleva mas precision y mas porques. La regla de fondo no cambia; cambia cuanto no es obvio.

### 8. Al cambiar codigo

- Un comentario que **contradice al codigo** se corrige si dice algo util y se borra si no. Nunca se deja falso y nunca se deja pendiente de otra persona. *«The documentation must get updated as the code changes»* (Ousterhout, CS190).
- Al renombrar o mover algo se buscan (`grep` del nombre viejo) los comentarios de otros archivos que lo nombran.
- Lo que el proximo lector necesita va en el codigo, no solo en el mensaje del commit: nadie lo busca ahi.

### 9. Responsabilidad: las revisiones marcan en los dos sentidos

El **reviewer** (fase refactor del pipeline TDD, `agents/reviewer.md`) y los demas revisores del marco marcan como hallazgo tanto el comentario que **sobra** como el porque o la precision que **falta**. Esto aplica sobre el lenguaje que corresponda segun la seccion 6, con tres restricciones:

- **Exclusivamente sobre archivos que el PR del issue ya interviene**: nunca se abre ni edita un archivo externo al diff del PR para ajustar comentarios.
- **Behavior-preserving estricto**: tocar un comentario nunca cambia el comportamiento. Es una operacion puramente textual.
- **Un comentario contradictorio se resuelve en la revision** (se corrige o se borra, seccion 8); si la discrepancia delata ademas un posible defecto del codigo, ese defecto se anota como hallazgo aparte.

La mecanica -- como escribir corto, como revisar, la limpieza masiva con verificacion por parser y los ejemplos -- **no vive en este ADR**: vive en el Agent Skill `code-comments` (MEF-ADR-0033, progressive disclosure). El ADR es liviano y estable; la mecanica solo se paga cuando un agente la ejecuta.

### 10. Donde nos apartamos del libro

Ousterhout defiende **mas** comentarios de los que pide este ADR. Se deja explicito para que nadie lea esta doctrina como el libro tal cual:

| Tema | El libro | El marco |
|---|---|---|
| Interfaz | En todo metodo y clase («Interface comment blocks for every method, every class») | Solo cuando quien llama tendria que leer el cuerpo |
| Ante la duda | Se conserva («As long as the comment is not misleading and at least a few people found it helpful, I would retain it») | No se escribe; si ya existe, se acorta |
| El riesgo mayor | Que falten: «the cost of missing comments is easily 10-100x the cost of incorrect comments» | Que sobreexpliquen y nadie los lea |
| Comentarios primero | Escribir la interfaz antes del cuerpo, como herramienta de diseno | Opcional |

En lo demas se coincide: no repetir el como, documentar cada cosa una sola vez («Document each thing exactly once»), remitir en vez de copiar y actualizar el comentario cuando cambia el codigo. Que el codigo de producto necesite menos documentacion que el de infraestructura es una **decision propia del marco**, no una cita de esas fuentes.

Fuentes (las dos del autor): CS190, *Writing Comments* (https://web.stanford.edu/~ouster/cgi-bin/cs190-winter18/lecture.php?topic=comments) y el dialogo aposd-vs-clean-code (https://github.com/johnousterhout/aposd-vs-clean-code). Las citas textuales de este ADR se verificaron contra ellas el 2026-11-10. El texto de los capitulos 13-16 del libro no esta publicado en abierto: lo que no sale de esas dos fuentes queda **sin verificar**.

## Alternativas consideradas

### Alt 1: prohibir todo comentario, sin excepciones

**Descartada**: el marco ya tiene comentarios **mandatados** por otros ADRs (seccion 5) que documentan restricciones reales no inferibles del codigo. Una prohibicion absoluta chocaria con doctrina aceptada o forzaria a mover su contenido a documentacion externa -- peor ergonomia para un agente que edita el archivo y nunca abre el ADR.

### Alt 2: conservar toda cita a ADR o ticket, aunque vaya sola

**Descartada**: una cita sin lo que documenta es provenance disfrazada de documentacion. Ademas envejece mal: si el ADR se enmienda o se retira, el comentario sigue apuntando a una version que ya no rige.

### Alt 3: mantener HCL sin modo revision

**Descartada**: dejar HCL fuera de la revision dejaba pasar exceso y tambien falta de precision en la capa donde mas se necesita. Se resuelve el riesgo de borrar doctrina con la lista de blindados (seccion 5), no con una exencion por lenguaje.

### Alt 4: adoptar la postura del libro tal cual (interfaz en todo, conservar ante la duda)

**Descartada** (seccion 10): el problema que motiva el ADR es el exceso de comentarios que nadie lee. El marco prefiere un default corto y marcar la falta de un porque como hallazgo explicito.

### Alt 5: incluir la mecanica de escritura y limpieza en este ADR

**Descartada**: MEF-ADR-0033 fija que la doctrina operativa pesada vive en un Agent Skill de progressive disclosure. Meterla aqui inflaria un ADR que casi toda consulta lee solo para saber si un comentario debe existir.

## Consecuencias

### Positivas

- **El criterio dice que escribir, no solo que podar**: seis categorias concretas y una lista de lo que sobra dan una pregunta decidible a cualquier agente o desarrollador.
- **Las revisiones cierran el hueco de la falta**: marcar el porque o la precision ausente evita que la limpieza deje el codigo mudo donde importa.
- **Un comentario falso deja de tener salida intermedia**: se corrige o se borra, nunca se deja engañando al proximo lector.
- **Un solo criterio para todo el codigo**: C#, HCL, bash, TypeScript y YAML, del consumidor y del plugin, con la infraestructura pidiendo mas precision sin cambiar la regla.
- **Doctrina blindada explicita**: los comentarios que exigen MEF-ADR-0027/0029/0032/0034 y los guardrails de scaffolders no se tocan.
- **Progressive disclosure**: la mecanica vive en el Skill `code-comments` (MEF-ADR-0033).

### Negativas

- **Doctrina sin propagacion inmediata**: este ADR no cambia por si solo el comportamiento de ningun agente; existe una ventana en la que esta aceptado pero no aplicado hasta que los issues dependientes lo propaguen y creen el Skill.
- **Ambiguedad residual**: "no obvio" es un criterio de juicio, no una regla mecanica; dos agentes pueden discrepar. El test operativo la acota pero no la elimina.
- **Riesgo de falta**: al invertir el default hacia "no escribir", un porque que nadie anoto puede quedar sin documentar; las revisiones en los dos sentidos son el contrapeso.
- **Los blindados exigen conocer los ADRs**: quien revise debe reconocer los comentarios de la seccion 5 para no tocarlos; la lista no es autocontenida en el codigo.

## Referencias

- **[1]** Apache Airflow, `AGENTS.md`, estandares de codigo: *"Comment sparingly — code says _what_, comments say _why_. Add a comment only when the reasoning is non-obvious and cannot be carried by a clear name or the code itself."* https://github.com/apache/airflow/blob/main/AGENTS.md
- **[2]** OpenHands `software-agent-sdk`, `AGENTS.md`, "Comments policy": *"Do NOT add comments that restate what the code already says, summarize the surrounding diff/PR, or narrate the change history ('previously we did X, now we do Y')."* https://github.com/OpenHands/software-agent-sdk/blob/main/AGENTS.md
- **[3]** Vercel `eve`, `AGENTS.md`, principio #10: *"Comment why, not what. Default to no comment; well-named code is the documentation. Comment only what the code cannot say itself — a non-obvious why, an invariant, a surprising edge case."* https://github.com/vercel/eve/blob/main/AGENTS.md
- **[4]** OpenAI `apps-sdk-ui`, `AGENTS.md`, "Contributing": *"Do not add comments for obvious behaviors, and do not change build settings."* https://github.com/openai/apps-sdk-ui/blob/main/AGENTS.md
- **Verificacion de [1]-[4]**: consultadas el 2026-08-15 contra la rama `main` de cada repositorio; resolvieron y las citas son textuales de esa lectura. Al ser archivos de rama viva, su contenido puede cambiar despues.
- **[5]** Ousterhout, *CS190, Writing Comments*: https://web.stanford.edu/~ouster/cgi-bin/cs190-winter18/lecture.php?topic=comments (verificada el 2026-11-10; fuente de «Comments should describe things that are not obvious from the code», «Document each thing exactly once», «The documentation must get updated as the code changes» e «Interface comment blocks for every method, every class»).
- **[6]** Ousterhout, *aposd-vs-clean-code*: https://github.com/johnousterhout/aposd-vs-clean-code (verificada el 2026-11-10; fuente de «As long as the comment is not misleading and at least a few people found it helpful, I would retain it» y «the cost of missing comments is easily 10-100x the cost of incorrect comments»).
- **[7]** Ousterhout, *A Philosophy of Software Design*, caps. 12-16: base de la heuristica; texto no publicado en abierto, sin verificar.
- MEF-ADR-0019 (separacion de tooling publicado e interno): el alcance cubre tambien el codigo del propio plugin.
- MEF-ADR-0027 (enrutamiento multidestinatario por correlation filter): la topologia de Service Bus se documenta en comentarios de Terraform; blindado (seccion 5). No se enmienda.
- MEF-ADR-0029 (test de composicion del contenedor DI): mandata el comentario sobre los limites de `ValidateOnBuild`; blindado. No se enmienda.
- MEF-ADR-0030 (esquema de identificacion de ADRs): fija el numero `MEF-ADR-0044`.
- MEF-ADR-0032 (identidad y autenticacion en el borde): trampa B6, notas de la politica APIM en comentarios HCL; blindado. No se enmienda.
- MEF-ADR-0033 (adopcion de Agent Skills): la mecanica vive en el Skill `code-comments`.
- MEF-ADR-0034 (worker de proyecciones y read models, seccion 10): "comentario gemelo" de `AddSource`; blindado. No se enmienda.
- MEF-ADR-0038 (control de volumen de telemetria, seccion 7): JSON no admite comentarios.
- `agents/projections-scaffolder.md`: guardrail deliberado sobre `using OpenTelemetry;`; blindado.
- Principio de verificacion de fuentes de `AGENTS.md`: donde una afirmacion tecnica no tenga fuente abierta, se declara "sin verificar".
- Issue #632: origen de este ADR. Issue #2527: enmienda.

## Control de cambios

- 2026-08-15: creacion como `aceptado` (issue #632). Fijo jerarquia codigo-autodocumentado > comentario > documentacion externa con default "sin comentario"; el umbral doble Context Delta + Decision Delta con su test operativo; la lista de proscritos (narracion del codigo, explicacion de sintaxis/librerias estandar, resumen de implementacion, razonamiento del agente, provenance incluyendo `// HU-XX`, narracion temporal); la regla de precedencia de citas a ADR con los blindados de MEF-ADR-0029/MEF-ADR-0034 y guardrails de scaffolders; el alcance por lenguaje (`.cs` pleno, HCL solo escritura, JSON/YAML de workflows y Markdown/bash del plugin fuera); y la limpieza del reviewer acotada al diff del PR, con comentarios contradictorios reportados sin resolver.
- 2026-11-10: enmienda (issue #2527). El criterio pasa a ser la heuristica de Ousterhout adaptada: se queda lo no obvio (porque, precision que la firma no da, dependencias, API externa no obvia con URL o "sin verificar", interfaz solo cuando quien llama tendria que leer el cuerpo, lo truculento) y sobra el resto; el umbral doble Context Delta/Decision Delta sale del cuerpo, junto con la terminologia propia que lo acompanaba. Un issue o ticket junto a su porque es referencia valida; solo, es ruido. Un comentario que contradice al codigo siempre se corrige o se borra (reemplaza la regla de reportarlo sin tocar). Las revisiones marcan hallazgos en los dos sentidos: el comentario que sobra y el porque o la precision que falta. El alcance pasa a todo codigo que escriben o revisan los agentes del marco, del consumidor y del propio plugin (C#, HCL al escribir y al revisar, bash, TypeScript, comentarios YAML), con la prosa Markdown fuera, los blindados ampliados a MEF-ADR-0027/0032 y los scaffolders y sus plantillas fuera del plan. Se agregan "Cuando NO aplica" y "Donde nos apartamos del libro" (citas verificadas el 2026-11-10). La mecanica pasa al Agent Skill `code-comments`.
