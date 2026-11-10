---
{
  "kind": "agent",
  "effort": "standard",
  "id": "mefisto-invalid-capability-value",
  "description": "Fixture invalido: declara una capacidad fuera del vocabulario cerrado (issue #853 CA-3).",
  "mode": "subagent",
  "capabilities": ["read", "bash"]
}
---

Fixture de `fixtures/invalid/` (issue #853): debe rechazarse por
`capabilities` con un valor fuera del vocabulario cerrado (`bash` es una clave
de permiso de un runtime, no una capacidad semantica del contrato).
