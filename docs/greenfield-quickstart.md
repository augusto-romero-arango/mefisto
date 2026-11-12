# Quickstart greenfield: arrancar Mefisto en un proyecto nuevo

Esto es lo que le contarías a un compañero que acaba de clonar un repo vacío y quiere adoptar Mefisto: qué se instala, quién necesita permisos de Azure y en qué orden se enciende todo. No repite reglas — cada una vive en su ADR y se enlaza desde aquí. El detalle exhaustivo, con cada comando y cada caveat de campo, sigue en la [guía del consumidor, sección "Primeros pasos con el harness (greenfield)"](guia-del-consumidor.md#primeros-pasos-con-el-harness-greenfield).

## Dos roles, no una persona haciendo de todo

Mefisto asume que **no todo el mundo en el equipo tiene permisos de Azure**, y diseña el arranque alrededor de eso:

- **Admin/infra**: la persona (o cuenta) con permisos elevados en la suscripción de Azure. Hace el bootstrap privilegiado (una sola vez) y siembra los secretos de Key Vault (recurrente, cada vez que aparece uno nuevo).
- **Dev ongoing**: cualquiera del equipo que use Mefisto día a día. **Cero credenciales de Azure.** Escribe y revisa Terraform de forma estática, corre los pipelines, abre PRs — nunca hace `terraform plan`/`apply` local ni toca el tfstate.

El modelo completo (con un tercer matiz de cadencia dentro del rol admin/infra) está en **[MEF-ADR-0025, decisión #10](adr/mef-adr-0025-custodia-de-secretos.md)**. Aquí solo hace falta saber a qué rol pertenece cada paso de abajo.

## El camino en 10 pasos

| # | Paso | Lo corre | En una frase |
|---|---|---|---|
| 1 | Instalar el plugin por usuario y habilitarlo en el repo | Dev | `claude plugin install mefisto@... --scope user` + `claude plugin disable ... --scope user`, y `.claude/settings.json` commiteado con `enabledPlugins` — Mefisto solo se carga en los repos que lo habilitan. |
| 2 | Crear `.claude/harness.config.json` + tokens en `CLAUDE.md` | Dev | Declara proyecto, dominios, Bounded Context; sin esto ningún skill sabe dónde está parado. |
| 3 | Provisionar labels de GitHub | Dev | `setup-github-labels.mts` (o `/onboard` con confirmación) — solo necesita `gh auth login`, nada de Azure. |
| 4 | Crear el backend del tfstate | **Admin/infra** | `bootstrap-backend.mts` — Resource Group, Storage Account y container donde vive el estado de Terraform. Privilegiado, una sola vez. |
| 5 | Configurar CI hacia Azure por OIDC | **Admin/infra** | `setup-github-ci.mts` — crea el Service Principal sin secret y le da los roles justos para que CI pueda aplicar infraestructura. Copia los tres secrets `AZURE_*` a GitHub. |
| 6 | Crear los 2 secrets/variables manuales de GitHub | **Admin/infra** | `ALERT_EMAIL` (variable) y `TF_VAR_POSTGRESQL_ADMIN_PASSWORD` (secret) — el password que elijas aquí es el mismo que sembrarás en `marten-connection` en el paso 9. |
| 7 | Generar la infraestructura base | Dev | `/infra-base` — escribe los 8 módulos Terraform y el esqueleto del entorno. Solo archivos locales, cero permisos de Azure. |
| 8 | Correr el primer `/infra` | Dev | Escribe y revisa el HCL de tu primer issue `tipo:infra` de forma estática y abre un PR. El `plan` real corre en el PR y el `apply` al mergear a `main` — ambos en CI, nunca en tu máquina. |
| 9 | Sembrar los secretos de Key Vault | **Admin/infra** | Tras el `apply` de CI, el Key Vault existe pero sin valores: `az keyvault secret set` a mano. Se repite con cada secreto nuevo, no es un evento único. |
| 10 | Scaffold del primer dominio + primer ciclo TDD | Dev | `/scaffold`, `/draft`, `/implement` — arranca el desarrollo normal del dominio. |

Los pasos 4-6 son el **bootstrap**: una ráfaga privilegiada de una sola vez, al principio de la vida del proyecto. El paso 9 es la **siembra de secretos**: mismo rol, pero recurrente — vuelve cada vez que Terraform crea un secreto nuevo o el Bounded Context suma un alias externo de Service Bus. Todo lo demás (1-3, 7-8, 10) es el flujo *ongoing* que corre cualquier dev, para siempre, sin tocar Azure directamente.

## Para el detalle exhaustivo

- Cada paso de arriba, con el comando completo, sus flags y los caveats verificados en campo (regiones restringidas, roles de datos, idempotencia parcial de condiciones ABAC): [guía del consumidor, "Primeros pasos con el harness (greenfield)"](guia-del-consumidor.md#primeros-pasos-con-el-harness-greenfield).
- Los 8 módulos Terraform base y el workflow de CI que generan los pasos 7-8: **[MEF-ADR-0021](adr/mef-adr-0021-infraestructura-base.md)**.
- El Service Principal, sus roles y los federated credentials del paso 5: **[MEF-ADR-0022](adr/mef-adr-0022-autenticacion-ci-azure-oidc.md)**.
- El modelo de dos roles y los tres perfiles de acceso (decisión #10), y por qué ningún secreto viaja en texto plano: **[MEF-ADR-0025](adr/mef-adr-0025-custodia-de-secretos.md)**.
