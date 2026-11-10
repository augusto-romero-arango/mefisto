---
{
  "kind": "command",
  "id": "mefisto-invalid-permission-field",
  "description": "Fixture invalido: declara 'permission', clave de permisos propia de un adaptador, prohibida en la fuente neutral.",
  "permission": { "bash": "allow" }
}
---

Fixture de `fixtures/invalid/` (issue #853): debe rechazarse por `permission`
como propiedad adicional no declarada en el schema.
