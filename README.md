<p align="center">
  <img src="docs/assets/mefisto-banner.svg" alt="Mefisto" width="100%">
</p>

<p align="center">
  <a href="https://github.com/augusto-romero-arango/mefisto/releases"><img alt="Última release" src="https://img.shields.io/github/v/release/augusto-romero-arango/mefisto"></a>
  <a href="LICENSE"><img alt="Licencia" src="https://img.shields.io/github/license/augusto-romero-arango/mefisto"></a>
  <a href="https://mefisto.io"><img alt="mefisto.io" src="https://img.shields.io/badge/sitio-mefisto.io-blueviolet"></a>
</p>

# Mefisto

Mefisto es un harness opinionado para agentes de código que orquesta el desarrollo asistido de aplicaciones .NET 10 serverless en Azure con Event Driven Architecture y Event Sourcing.

Conoce más en [mefisto.io](https://mefisto.io).

## El nombre

Un guiño a Mefistófeles, el espíritu de *Fausto* de Goethe: quien invoca el harness encarna a Fausto, fija la intención y firma el pacto; el plugin, como Mefisto, la ejecuta bajo las reglas del marco (EDA, Event Sourcing, TDD). *Fausto decide, Mefisto ejecuta* ([MEF-ADR-0055](docs/adr/mef-adr-0055-superficie-observacion-mods-claude-code.md)).

## Por qué

Los agentes de código improvisan arquitectura: cada sesión reinventa convenciones, tests y pipelines. Mefisto fija el marco una sola vez (ADRs, skills, agentes y pipelines) para equipos que construyen sistemas .NET sobre Azure con Event Sourcing y quieren que el agente trabaje dentro de esas reglas, de la idea al PR.

## Características

- **Skills** (slash commands) para onboarding, scaffolding de dominios, ciclo TDD, infraestructura, auth, merge y bitácora.
- **Agentes** especializados: planner, escritores de tests, implementadores, revisores y scaffolders.
- **Pipelines en TypeScript (Node)** sobre `git worktree`, con ejecución paralela y secuencial.
- **ADRs** del marco (prefijo `MEF-ADR-`) como fuente de verdad arquitectónica.
- **Servidor MCP** bundleado de Microsoft Learn para verificar documentación oficial.

## Stack del marco

.NET 10 · Azure Functions (isolated worker) · PostgreSQL + Marten · Wolverine · Azure Service Bus · Terraform · GitHub Actions.

## Runtimes soportados

Claude Code, con adaptador en el repo. La doctrina es neutral a runtime y el conjunto de runtimes es abierto: "soportado" significa "tiene adaptador" ([MEF-ADR-0049](docs/adr/mef-adr-0049-arquitectura-neutral-runtime-proveedor.md), [MEF-ADR-0057](docs/adr/mef-adr-0057-portabilidad-typescript-node.md)).

## Requisitos

Node 22.18+, `gh` autenticado, `git` 2.x con worktrees, `dotnet` 10.x y `terraform` 1.6+. En Windows, además, [Git for Windows](https://git-scm.com/downloads/win): Claude Code ejecuta con Git Bash los bloques de bash de comandos y agentes, y sin él usaría PowerShell. `/mefisto:onboard` comprueba Node y, en Windows, Git Bash.

Los scripts y los hooks corren con Node, sin `jq` ni `python3` ([MEF-ADR-0057](docs/adr/mef-adr-0057-portabilidad-typescript-node.md), decisión 9). Única excepción: cuando el planner actualiza el glosario YAML al cerrar la sesión, `field-note.mts` lo valida con un validador que ya esté en el PATH (`python3` con PyYAML, `ruby` o `yq`); sin ninguno, el cierre aborta con un mensaje y no stagea nada. Windows se declara soportado cuando se cierre la verificación manual de [docs/portabilidad/ESTADO.md](docs/portabilidad/ESTADO.md).

## Instalación rápida

**Claude Code** (>= 2.1.287): Mefisto se instala una vez por usuario **deshabilitado**, y solo se activa en los repos que lo habilitan en su `.claude/settings.json` commiteado. Así no se carga en repos que no lo usan ([MEF-ADR-0053](docs/adr/mef-adr-0053-distribucion-multi-runtime-consumidores.md), decisión 2). Registra el marketplace dentro de la sesión y, desde una terminal, instálalo y deshabilítalo a nivel usuario:

```
/plugin marketplace add augusto-romero-arango-harness
claude plugin install mefisto@augusto-romero-arango-harness --scope user
claude plugin disable mefisto@augusto-romero-arango-harness --scope user
```

En cada repo consumidor, commitea el `.claude/settings.json` con `enabledPlugins` (ver la [guía del consumidor](docs/guia-del-consumidor.md#1-configurar-claudesettingsjson-del-repo-consumidor), paso 1). Los pipelines entregan a sus agentes la raíz de su propia versión, así que los worktrees no dependen de esta instalación.

## Primer uso

1. Ejecuta `/mefisto:onboard` para diagnosticar config, labels y CI del repo.
2. Captura una idea con `/mefisto:draft`, refínala hasta `estado:listo` y córrela con `/mefisto:implement <issue>`: del issue al PR.

## Documentación

- [Guía del consumidor](docs/guia-del-consumidor.md)
- [Migración y versionado](docs/migracion-y-versionado.md)
- [Desarrollo del plugin](docs/desarrollo-del-plugin.md)
- [Quickstart greenfield](docs/greenfield-quickstart.md)
- [ADRs e índice temático](docs/adr/INDICE-TEMATICO.md)

## Contribuir

El trabajo sobre el propio plugin nace como issue: `/mefisto-plan` captura y refina, el pipeline interno implementa en una rama propia (nunca contra `main`) y se entrega por Pull Request con `Closes #<n>`. Cada cambio notable se anota como fragmento en `changelog.d/`, sin editar `CHANGELOG.md`. Detalle en [Desarrollo del plugin](docs/desarrollo-del-plugin.md).

## Licencia

Apache-2.0. Ver [`LICENSE`](LICENSE) y [`NOTICE`](NOTICE).

Se permite uso, modificación y uso comercial conservando los avisos de licencia y atribución.

## Autor

Augusto Romero Arango · [@augusto-romero-arango](https://github.com/augusto-romero-arango)
