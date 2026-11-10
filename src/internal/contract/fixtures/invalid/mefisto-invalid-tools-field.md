---
{
  "kind": "agent",
  "effort": "standard",
  "id": "mefisto-invalid-tools-field",
  "description": "Fixture invalido: declara 'tools', lista plana de tools de Claude Code prohibida en la fuente neutral.",
  "mode": "subagent",
  "tools": "Bash, Read, Write"
}
---

Fixture de `fixtures/invalid/` (issue #853): debe rechazarse por `tools` como
propiedad adicional no declarada en el schema.
