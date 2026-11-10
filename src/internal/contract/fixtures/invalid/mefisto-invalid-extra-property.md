---
{
  "kind": "agent",
  "effort": "standard",
  "id": "mefisto-invalid-extra-property",
  "description": "Fixture invalido: declara una propiedad generica no contemplada por el contrato.",
  "mode": "subagent",
  "foo": "bar"
}
---

Fixture de `fixtures/invalid/` (issue #853): debe rechazarse por `foo` como
propiedad adicional (`additionalProperties: false` en todos los niveles,
CA-2).
