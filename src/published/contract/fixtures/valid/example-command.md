---
{"kind":"command","id":"example-command","description":"Fixture válido de comando publicado.","capabilities":["shell"],"arguments":"<issue>","mcp":["terraform"]}
---

{{mefisto:assert-consumer-repo}}
{{mefisto:launch-agent bug-investigator Resume el estado de $ARGUMENTS}}
{{mefisto:launch-agent bug-investigator Diagnostica el sintoma alternativo}}
{{mefisto:run tooling-pipeline.mts $ARGUMENTS}}
{{mefisto:package-root}}
{{mefisto:state-path pipeline/events.log}}
{{mefisto:command example-command}}
