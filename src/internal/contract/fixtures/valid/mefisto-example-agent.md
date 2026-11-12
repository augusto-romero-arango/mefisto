---
{
  "kind": "agent",
  "effort": "standard",
  "id": "mefisto-example-agent",
  "description": "Agente de ejemplo para validar el contrato neutral de agentes (issue #853). No se invoca en produccion.",
  "mode": "subagent",
  "profile": "balanced",
  "capabilities": ["read", "edit", "shell"],
  "skills": ["agent-skill-authoring"]
}
---

Cuerpo de ejemplo de un agente neutral. Este archivo es un fixture de
`fixtures/valid/` (issue #853): valida que un agente completo, con todos los
campos opcionales poblados, pasa `validate-internal-artifacts.mts` sin
rechazos.

No se referencia desde ningun agente real ni desde ningun generador todavia
(el generador es alcance del issue #854).
