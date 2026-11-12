---
{
  "kind": "command",
  "id": "infra-base",
  "description": "Genera la infraestructura base del consumidor (modulos Terraform + esqueleto del entorno + infra-cd.yml) delegando en infra-base-scaffolder.",
  "profile": "fast",
  "arguments": "[dev|staging|prod]"
}
---

{{mefisto:assert-consumer-repo}}

Genera la infraestructura base del consumidor (8 modulos Terraform + esqueleto del entorno con outputs + el workflow de CI `infra-cd.yml`) delegando en el agente `infra-base-scaffolder`. Es el eslabon greenfield entre `bootstrap-backend.mts` (crea el `tfstate`) y el primer `{{mefisto:command infra}}`, que solo escribe y revisa el HCL: el `apply` real lo ejecuta CI al mergear el PR (MEF-ADR-0021, MEF-ADR-0022). El contrato de configuracion es `.mefisto/harness.config.json` (MEF-ADR-0053); un config legado solo se acepta como fallback de **lectura** cuando el canonico no existe, sin copiarlo ni migrarlo. Si el BC declara `projections.enabled` en el config efectivo, el mismo agente suma los 3 modulos **opt-in** del worker de proyecciones (`container-registry`, `container-app-environment`, `container-app`) y su wiring en el entorno (MEF-ADR-0034); sin ese token no genera ninguno. Comunicate en **espanol**.

## Entrada

`$ARGUMENTS` (opcional): el ambiente -- `dev` (default), `staging` o `prod`.

## Proceso

### 1. Resolver el ambiente

Si `$ARGUMENTS` esta vacio, usa `dev`. Si trae un valor, validalo (`dev`/`staging`/`prod`); si no coincide, informa el error y detente. Desde aqui trabaja solo con el ambiente ya resuelto (`<env>`), nunca con `$ARGUMENTS` crudo.

### 2. Informar que se va a generar

```
Se va a generar la infraestructura base del consumidor (ambiente: <env>):

  - infra/modules/{resource-group, monitoring, postgresql, service-bus,
                   service-plan, storage, function-app}/main.tf
  - infra/environments/<env>/{main, variables, providers, outputs}.tf
    (NO se genera backend.tf: lo escribe bootstrap-backend.mts)
  - .github/workflows/infra-cd.yml (si no existe aun): plan en cada PR sobre
    infra/**, apply al mergear a main, autenticado por OIDC (MEF-ADR-0022)

El generador es idempotente: si ya existen archivos, los respeta y solo crea lo que falta.
```

### 3. Lanzar el agente

Sustituye `<env>` por el ambiente ya resuelto y validado en el paso 1:

{{mefisto:launch-agent infra-base-scaffolder Genera la infraestructura base. Ambiente: <env>}}

### 4. Tras terminar

Recuerda al usuario el orden del flujo greenfield:

```
Infraestructura base generada. Siguiente:
  1. Si el backend del tfstate aun no existe, un administrador ejecuta una sola vez
     node {{mefisto:package-root}}/scripts/bootstrap-backend.mts y luego
     node {{mefisto:package-root}}/scripts/setup-github-ci.mts. Son operaciones privilegiadas
     de una sola vez (MEF-ADR-0022); este comando no las ejecuta.
  2. Crea la GitHub variable ALERT_EMAIL y el GitHub secret
     TF_VAR_POSTGRESQL_ADMIN_PASSWORD (Settings > Secrets and variables > Actions;
     setup-github-ci.mts no los crea) -- infra-cd.yml los inyecta como
     TF_VAR_alert_email/TF_VAR_postgresql_admin_password, nunca via terraform.tfvars
     commiteado (MEF-ADR-0025). subscription_id ya no es una variable: se resuelve de
     ARM_SUBSCRIPTION_ID. Revisa tambien los defaults derivados en variables.tf
     (project, project_short, postgresql_location, postgresql_region_short).
     Si PostgreSQL debe ir a otra region por oferta, versiona juntos sus dos defaults no
     sensibles en infra/environments/<env>/variables.tf, para que CI los reciba. Por ejemplo:
     `variable "postgresql_location" { default = "centralus" }` y
     `variable "postgresql_region_short" { default = "cus" }`. No derives la abreviatura:
     declarala segun la convencion regional del consumidor (MEF-ADR-0045). No cambies
     `location` ni `azure_region_short`: siguen describiendo los recursos primarios en eastus2.
     terraform.tfvars permanece ignorado y solo sirve para overrides locales no versionados;
     nunca guardes alli postgresql_admin_password ni otro secreto.
  3. Primer {{mefisto:command infra}}: escribe y revisa el HCL, abre un PR. El apply real
     ocurre en CI al mergear a main (workflow Infra CD), nunca en local.
  4. {{mefisto:command scaffold}} <dominio> agrega su service-plan/storage/function-app a este entorno.
```

## Reglas

- **No generes la infraestructura tu mismo.** Solo valida el ambiente, informa y delega en el agente.
- El agente nunca corre `terraform plan`/`apply`: solo `fmt`, `init -backend=false` y `validate`. El plan real corre en CI al abrir el PR y el apply real al mergearlo a `main` (workflow `infra-cd.yml`, MEF-ADR-0021, MEF-ADR-0022).
- El agente es idempotente: no sobrescribe archivos `.tf` ni el workflow `infra-cd.yml` existentes (MEF-ADR-0021).
- Este comando no ejecuta `bootstrap-backend.mts` ni `setup-github-ci.mts`: solo los cita en el recordatorio.
