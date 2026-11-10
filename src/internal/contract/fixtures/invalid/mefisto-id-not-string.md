---
{
  "kind": "agent",
  "effort": "standard",
  "id": 853,
  "description": "Fixture invalido: 'id' no es un string, asi que el motivo debe venir del schema (tipo), no del chequeo de nombre de archivo.",
  "mode": "subagent"
}
---

Fixture de `fixtures/invalid/` (issue #853): debe rechazarse por el tipo de
`id`. Fija que el validador delega en el schema el juicio sobre los campos y
no reporta un generico "id ausente" cuando el campo si esta presente pero mal
tipado.
