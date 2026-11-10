---
{
  "kind": "agent",
  "effort": "standard",
  "id": "mefisto-missing-mode",
  "description": "Fixture invalido: un agente sin 'mode', obligatorio solo para kind=agent (CA-2)."
}
---

Fixture de `fixtures/invalid/` (issue #853): debe rechazarse porque `mode` es
obligatorio en todo agente y este fixture no lo declara.
