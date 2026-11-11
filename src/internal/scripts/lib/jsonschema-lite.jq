# jsonschema-lite.jq -- Subconjunto de JSON Schema implementado como programa jq
# (MEF-ADR-0049 CA-6, issue #853): un filtro jq que devuelve la lista de
# motivos, no un validador JSON Schema externo.
#
# Gemela de lib/jsonschema-lite.mts, la que usa validate-internal-artifacts.mts
# (MEF-ADR-0057); validate-internal-artifacts.test.mts compara las dos.
#
# Palabras clave soportadas: type, required, properties, additionalProperties
# (solo el valor `false`), enum, items, pattern, minLength, oneOf (solo la
# forma "dispatch por kind": cada rama declara properties.kind.enum con un
# unico valor; se elige la rama cuyo kind coincide con el de la instancia y se
# valida SOLO esa rama en profundidad -- mensajes de error especificos por
# campo, en vez del generico "0/N ramas coinciden" de un oneOf JSON Schema
# estandar).
#
# No implementadas (no hacen falta para este contrato): $ref, allOf, anyOf,
# if/then/else, const, not, contains, patternProperties, $schema/meta-validacion.
#
# Invocacion:
#   jq -n --argjson schema "$(cat internal-artifact.schema.json)" --argjson instance "$frontmatter_json" -f jsonschema-lite.jq
#   (en una sola linea: jq 1.8 continua en la linea siguiente un comentario que
#   termina en contrabarra)
#
# Salida: un array JSON de strings "<campo>: <motivo>" (vacio si $instance es
# valida contra $schema). $path usa "." como separador de segmentos; la raiz
# es "" (sin punto colgante).

def jtype:
    if type == "object" then "object"
    elif type == "array" then "array"
    elif type == "string" then "string"
    elif type == "number" then "number"
    elif type == "boolean" then "boolean"
    else "null"
    end;

# pfx($path; $key) -- concatena un segmento de path con "." salvo en la raiz
# (evita un "." colgante inicial como ".mode").
def pfx($path; $key):
    if $path == "" then $key else ($path + "." + $key) end;

def validate($schema; $instance; $path):
    [
        (if ($schema | has("type")) and (($instance | jtype) != $schema.type)
         then "\($path): tipo esperado \($schema.type), encontrado \($instance | jtype)"
         else empty end),

        (if ($schema | has("enum")) and (($schema.enum | index($instance)) == null)
         then "\($path): valor \($instance | tojson) no esta en el vocabulario permitido \($schema.enum | tojson)"
         else empty end),

        (if ($schema | has("minLength")) and (($instance | jtype) == "string")
            and (($instance | length) < $schema.minLength)
         then "\($path): longitud minima \($schema.minLength), encontrado \($instance | length)"
         else empty end),

        (if ($schema | has("pattern")) and (($instance | jtype) == "string")
            and (($instance | test($schema.pattern)) | not)
         then "\($path): '\($instance)' no coincide con el patron \($schema.pattern)"
         else empty end),

        (if ($schema | has("required")) and (($instance | jtype) == "object")
         then ($schema.required[] as $req
               | if ($instance | has($req)) then empty
                 else "\(pfx($path; $req)): campo requerido ausente" end)
         else empty end),

        (if ($schema | has("additionalProperties")) and ($schema.additionalProperties == false)
            and (($instance | jtype) == "object")
         then ($instance | keys_unsorted[] as $k
               | if (($schema.properties // {}) | has($k)) then empty
                 else "\(pfx($path; $k)): propiedad adicional no permitida" end)
         else empty end),

        (if ($schema | has("properties")) and (($instance | jtype) == "object")
         then ($schema.properties | keys_unsorted[] as $k
               | if ($instance | has($k))
                 then validate($schema.properties[$k]; $instance[$k]; pfx($path; $k))[]
                 else empty end)
         else empty end),

        (if ($schema | has("items")) and (($instance | jtype) == "array")
         then (range(0; ($instance | length)) as $i
               | validate($schema.items; $instance[$i]; pfx($path; ($i | tostring)))[])
         else empty end),

        (if ($schema | has("oneOf"))
         then (
             if ($instance | jtype) != "object"
             then ["\(if $path == "" then "(raiz)" else $path end): se esperaba un objeto JSON, encontrado \($instance | jtype)"]
             elif ($instance | has("kind")) | not
             then ["\(pfx($path; "kind")): campo requerido ausente"]
             else (
                 ($schema.oneOf | map(select((.properties.kind.enum // []) | index($instance.kind)))) as $matches
                 | if ($matches | length) == 0
                   then ["\(pfx($path; "kind")): valor \($instance.kind | tojson) no coincide con ningun 'kind' declarado en oneOf"]
                   else validate($matches[0]; $instance; $path)
                   end
             )
             end
         )[]
         else empty end)
    ];

validate($schema; $instance; "")
