---
{
  "kind": "command",
  "id": "mefisto-body-runtime-reference",
  "description": "Fixture invalido: el frontmatter es correcto, pero el body nombra runtimes concretos (CA-1).",
  "profile": "fast"
}
---

Fixture de `fixtures/invalid/` (issue #853): el frontmatter pasa el schema,
pero el body debe rechazarse porque nombra un runtime concreto en vez de
describir la intencion de forma neutral.

Corre `claude --agent mefisto-planner` y deja el resultado en `.claude/agents/`.
