---
{"kind":"agent","effort":"light","id":"agent-completo","description":"Lee, \"edita\" y ejecuta.","mode":"subagent","profile":"deep","capabilities":["read","edit","shell","web","skill","task"],"skills":["projections","comment-cleanup"]}
---
{{mefisto:assert-consumer-repo}}
Rutas: {{mefisto:config-path}}, {{mefisto:instructions-path}} y {{mefisto:package-root}}.
{{mefisto:state-path logs/con-espacio.log}}
Ejecuta {{mefisto:run prueba.sh "$ARGUMENTS con espacios"}} ahora.
Consulta {{mefisto:command otra-orden}}.
