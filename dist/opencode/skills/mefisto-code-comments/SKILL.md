---
name: mefisto-code-comments
description: "Mecanica de comentarios de codigo para escribirlos y revisarlos (MEF-ADR-0044) -- que se queda, que sobra, como escribirlo corto, como corregirlo al cambiar codigo, como marcar hallazgos en los dos sentidos al revisar y como limpiar en masa. Usar al escribir o revisar codigo en C#, HCL, bash o TypeScript: comentarios que narran el codigo, provenance (`// HU-XX`, citas sueltas de issue/PR/ADR), comentarios falsos tras un cambio, o un porque, una unidad o una API externa no obvia que falta documentar."
---

# Comentarios de codigo: escribir y revisar

Mecanica operativa de MEF-ADR-0044. Ese ADR fija el criterio, el alcance, los comentarios
blindados y la responsabilidad; este Skill fija **como** aplicarlos. Es la fuente unica de la
mecanica: los agentes que escriben o revisan codigo la cargan con `skills:` en vez de copiarla.

**Alcance, blindados y casos donde no aplica**: lee MEF-ADR-0044 (secciones 4, 5 y 8). Este Skill
no los repite; si una duda toca uno de ellos, manda el ADR.

**Default: sin comentario.** Un comentario dice lo que no es obvio al leer el codigo, en una
frase si se puede.

## 1. Al escribir

### Que se queda

Una pregunta decide: *¿que no veria alguien que lee este codigo por primera vez?* Si la
respuesta es "nada", no se escribe. Seis categorias pasan:

1. **El porque**: regla de negocio, decision de diseno, restriccion de la plataforma o trampa ya
   pisada que explica por que el codigo no es como se esperaria.
2. **La precision que la firma no da**: unidad o formato (`ms`, centavos, `YYYY-MM-DD`), que
   significa `null`, si un limite es inclusivo o exclusivo, un invariante, quien libera un recurso.
3. **Las dependencias**: "si cambias esto, cambia tambien X". Nombrar otro archivo es valido.
4. **El comportamiento no obvio de una API externa**, con la URL de su documentacion oficial. Si
   no abriste la documentacion, escribe "sin verificar".
5. **La interfaz**, solo cuando quien llama tendria que leer el cuerpo para usar bien la funcion,
   la clase o el campo: el que y el contrato en palabras del dominio, nunca el como.
6. **Lo truculento**: el orden que importa, el caso borde que se rompio, la condicion de carrera
   evitada.

### Que sobra

Repetir el codigo o el nombre, narrar pasos que se leen igual, explicar como funciona otro
modulo, copiar la misma explicacion en varios archivos, historia y narracion temporal ("antes
era..."), resumen del cambio, razonamiento del agente, un issue/ticket/HU sin su porque, la URL
de un uso normal de una API, explicar sintaxis o librerias estandar y codigo comentado. La lista
completa y su razon estan en MEF-ADR-0044 seccion 3.

### Como escribirlo corto

- **Una frase.** Si pasa de dos lineas, revisa el nombre o el diseno: probablemente el codigo
  pide una extraccion o un nombre mejor, no mas prosa.
- **Si el comentario es mas preciso que el nombre, se acorta el nombre**, no el comentario.
- **Un issue o ticket va junto a su porque**, como puntero para profundizar; solo, es ruido.
- **Una cita a un ADR va junto a la restriccion que explica**; sola, se borra.
- **En el idioma del codigo**: el de los identificadores y los comentarios vecinos del archivo.
- **Cada cosa se documenta una sola vez**: junto al codigo que la origina; los demas sitios
  remiten a ella.

Antes de escribir, intenta codificarlo: un nombre mas claro, un tipo mas expresivo, un metodo
extraido, un guard o una assertion que haga el invariante verificable. Si eso elimina la
necesidad, no hay comentario.

## 2. Al cambiar codigo

- Un comentario que **contradice al codigo** se corrige si dice algo util y se borra si no.
  Nunca se deja falso ni pendiente de otra persona.
- Al **renombrar o mover** algo, haz `grep` del nombre viejo: otros archivos pueden nombrarlo en
  sus comentarios.
- Lo que el proximo lector necesita va en el codigo, no solo en el mensaje del commit.

## 3. Al revisar

- **Hallazgos en los dos sentidos**: marca el comentario que **sobra** y tambien el porque, la
  precision, la dependencia o la API externa no obvia que **falta**. Limpiar no debe dejar el
  codigo mudo donde importa.
- **Clasifica antes de actuar**: para cada comentario, ¿lleva un porque, una precision, una
  dependencia o una API no obvia? Si lleva uno, se acorta a eso; si no lleva ninguno, se borra.
  Ver [ejemplos.md](ejemplos.md).
- **Ante la duda, acorta antes que borrar.**
- **Si mezcla narracion con algo valioso**, conserva lo valioso y borra la narracion.
- **Nunca por patron**: no borres por coincidencia de texto (`// HU-`, `// TODO`) sin leer cada
  comentario.
- **Frontera**: solo archivos que el diff del PR ya interviene. Nunca abras un archivo ajeno al
  diff para ajustar comentarios.
- **Behavior-preserving**: tocar un comentario es una operacion puramente textual y no cambia
  el comportamiento. Si la discrepancia entre un comentario y el codigo delata ademas un posible
  defecto, anota ese defecto como hallazgo aparte.
- **Releer el archivo completo** al terminar, no solo el diff: un comentario borrado puede dejar
  ambiguo un nombre generico, senal de que faltaba renombrar.

### Verificacion segun el lenguaje

Tras tocar comentarios en modo revision del pipeline, confirma que nada se rompio:

| Lenguaje | Verificacion |
|---|---|
| C# | `dotnet build` y `dotnet test` en verde |
| bash | `bash -n` sobre cada script tocado y los tests del script |
| HCL | `terraform fmt -check` y `terraform validate` cuando haya credenciales; sin ellas, solo `fmt` |
| TypeScript | el typecheck del proyecto |

## 4. Al limpiar en masa

Solo en **sesiones interactivas** sobre archivos que el usuario senala; **nunca en un pipeline
acotado al diff**, donde rige la frontera de la seccion 3.

1. **Mide antes**: cuenta lineas de comentario por archivo para poder reportar el antes y el
   despues.
2. **Aplica el criterio** de las secciones 1 y 3 comentario por comentario, sin borrar por patron.
3. **Verifica con el parser del lenguaje que solo cambiaron comentarios**: el arbol sintactico
   sin comentarios debe ser identico antes y despues (en C#, Roslyn modela los comentarios como
   trivia). Donde no haya como comparar el arbol, el diff solo toca lineas de comentario y la
   verificacion de la seccion 3 sigue en verde. Un cambio en algo que no sea comentario es un
   error.
4. **Haz una segunda pasada sobre lo borrado**, buscando lo que una poda apresurada pierde:
   unidades, formatos, el significado de `null`, avisos "si cambias...", URLs de API externa y
   marcas "sin verificar". Lo que aparezca se restaura, acortado.
5. **Mide despues** y reporta el antes y el despues.

## Senales de que lo estas haciendo mal

- Escribes un comentario antes de preguntarte que no veria quien lee el codigo.
- El comentario pasa de dos lineas y no revisaste el nombre ni el diseno.
- Borraste una unidad, un formato o un "si cambias..." porque "se entiende".
- Dejas un comentario que sabes falso para "que lo decida otro".
- Limpias un archivo que el diff del PR no toca.
- Borras un comentario blindado por parecer ruido (MEF-ADR-0044 seccion 4).
- Podas por `grep` sin leer cada comentario.

## Cuando NO aplica

Directivas de herramienta, licencias, comentarios que otra herramienta consume, convenciones
fijas del proyecto y codigo de infraestructura que pide mas precision: ver MEF-ADR-0044 seccion
8. La prosa Markdown de agentes, comandos, ADRs y docs queda fuera (seccion 5).

## Blindados

Los comentarios que un ADR o una plantilla exigen no se borran ni se acortan nunca; si uno
contradice al codigo, se corrige. La lista vive en MEF-ADR-0044 seccion 4 y no se copia aqui.

## Recursos

- **[ejemplos.md](ejemplos.md)** -- mal y bien en C#, HCL y bash del marco, y un ejemplo de API
  externa no obvia con URL.
