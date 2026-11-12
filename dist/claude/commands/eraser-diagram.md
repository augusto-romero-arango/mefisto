---
description: "Genera diagramas profesionales con la API de Eraser (sequence, architecture, flowchart, ERD y BPMN) y los renderiza con ERASER_API_TOKEN."
argument-hint: "<descripcion del diagrama>"
model: "sonnet"
---
<!-- GENERADO por src/published/scripts/generate-published-adapters.mts desde src/published/commands/eraser-diagram.md. No editar a mano. -->

Genera diagramas profesionales usando la API de Eraser. Soporta 5 tipos: sequence, architecture, flowchart, ERD y BPMN.

Antes de continuar, aborta si existe `src/internal/scripts/generate-internal-adapters.mts`: ese directorio es el repositorio de Mefisto, no un consumidor.

## Paso 1 - Determinar el tipo de diagrama

Analiza lo que el usuario pide y elige el tipo apropiado:

| Tipo | diagramType | Usar para |
|------|-------------|-----------|
| Sequence | `sequence-diagram` | Flujos EDA, interacciones entre servicios, request/response |
| Architecture | `cloud-architecture-diagram` | Topologia de infraestructura, dominios, Service Bus |
| Flowchart | `flowchart-diagram` | Procesos, decisiones, user journeys |
| ERD | `entity-relationship-diagram` | Modelos de datos, entidades, relaciones |
| BPMN | `bpmn-diagram` | Procesos de negocio, swimlanes, roles |

## Paso 2 - Generar el DSL de Eraser

Genera el codigo DSL siguiendo estrictamente la sintaxis documentada abajo segun el tipo.

**REGLAS CRITICAS:**
- Los labels DEBEN estar en una sola linea - NUNCA uses saltos de linea dentro de atributos label
- Los nombres de nodos/columnas deben ser unicos
- Si un nombre contiene caracteres especiales, envuelvelo en comillas dobles: `"Service Bus"`
- Un nodo por linea, pero los labels siempre en la misma linea
- Usa `typeface clean` y `colorMode pastel` como defaults para legibilidad

## Paso 3 - Llamar al API de Eraser

IMPORTANTE: SIEMPRE ejecuta el curl despues de generar el DSL. Nunca te detengas solo con el DSL.

```bash
curl -s -X POST https://app.eraser.io/api/render/elements \
  -H "Content-Type: application/json" \
  -H "X-Skill-Source: mefisto" \
  -H "Authorization: Bearer ${ERASER_API_TOKEN}" \
  -d '{
    "elements": [{
      "type": "diagram",
      "id": "diagram-1",
      "code": "<DSL_GENERADO>",
      "diagramType": "<TIPO>"
    }],
    "scale": 2,
    "theme": "dark",
    "background": true
  }'
```

## Paso 4 - Mostrar resultado

```
## Diagrama
![Titulo](imageUrl)

## Editar en Eraser
[Abrir editor](createEraserFileUrl)

## DSL
\`\`\`eraser
<DSL>
\`\`\`
```

Si falla por falta de `ERASER_API_TOKEN`, muestra el DSL y explica que se puede pegar en https://app.eraser.io para renderizar.

---

# Referencia de sintaxis: Sequence diagrams

Cada linea tiene dos columnas (entidades), una flecha (direccion), y un mensaje.

```
Web App > DB: Start transaction
```

## Flechas

| Flecha | Sintaxis | Descripcion |
|--------|----------|-------------|
| Flecha derecha | `>` | Izquierda a derecha |
| Flecha izquierda | `<` | Derecha a izquierda |
| Bidireccional | `<>` | Ambas direcciones |
| Linea | `-` | Sin punta |
| Linea punteada | `--` | Punteada sin punta |
| Flecha punteada | `-->` | Punteada con punta |

Cada linea se parsea secuencialmente de arriba a abajo. Si una columna no ha sido usada antes, se crea automaticamente.

## Propiedades de columnas

```
Web App [icon: monitor, color: blue] > DB [icon: database, color: green]: Start transaction
```

| Propiedad | Descripcion | Valor |
|-----------|-------------|-------|
| icon | Icono | Nombres (ej: aws-ec2, azure-functions, monitor, database) |
| color | Color | Nombre (blue) o hex ("#000000") |
| label | Etiqueta | String. Comillas si tiene espacios. |
| colorMode | Relleno | pastel, bold, outline |
| styleMode | Estilo | shadow, plain, watercolor |
| typeface | Tipografia | rough, clean, mono |

## Propiedades de flechas

```
Web App > DB: Start transaction [color: blue]
```

## Bloques (control de flujo)

```
opt [label: if complete] {
  Server > Client: Success
}
```

| Tipo | Descripcion |
|------|-------------|
| loop | Bucle |
| alt (else) | Alternativa |
| opt | Opcional |
| par (and) | Paralelo |
| break | Interrupcion |

Ejemplo alt/else:

```
alt [label: if complete] {
  Server > Client: Success
}
else [label: if failed] {
  Server > Client: Failure
}
```

## Activations

```
Client > Server: Data request
activate Server
Server > Client: Return data
deactivate Server
```

## Escape de caracteres

```
User > "https://localhost:8080": GET
```

## Estilos globales

| Propiedad | Valores | Default |
|-----------|---------|---------|
| colorMode | pastel, bold, outline | pastel |
| styleMode | shadow, plain, watercolor | shadow |
| typeface | rough, clean, mono | rough |
| autoNumber | on, nested, off | off |

---

# Referencia de sintaxis: Cloud Architecture diagrams

## Nodos

```
compute [icon: aws-ec2]
```

## Grupos (contenedores)

```
VPC Subnet {
  Main Server {
    Server [icon: aws-ec2]
    Data [icon: aws-rds]
  }
}
```

## Propiedades de nodos y grupos

| Propiedad | Descripcion | Valor |
|-----------|-------------|-------|
| icon | Icono | Nombres (ej: azure-functions, azure-service-bus) |
| color | Color | Nombre o hex |
| label | Etiqueta | String entre comillas si tiene espacios |
| colorMode | Relleno | pastel, bold, outline |
| styleMode | Estilo | shadow, plain, watercolor |
| typeface | Tipografia | rough, clean, mono |

## Conexiones

```
Server > Worker1, Worker2, Worker3
Storage > Server: Cache Hit [color: green]
```

Mismos tipos de flecha que sequence diagrams.

## Direccion

```
direction down   // down (default), up, right, left
```

## Ejemplo Azure

```
AD tenant [icon: azure-active-directory]
Load Balancers [icon: azure-load-balancers]
Virtual Network [icon: azure-virtual-networks] {
  Web Tier [icon: azure-network-security-groups] {
    vm1 [icon: azure-virtual-machine]
    vm2 [icon: azure-virtual-machine]
  }
}
AD tenant > Load Balancers > vm1, vm2
```

---

# Referencia de sintaxis: Flowchart diagrams

## Nodos

```
Start [shape: oval, icon: flag]
```

Shapes disponibles: rectangle (default), cylinder, diamond, document, ellipse, hexagon, oval, parallelogram, star, trapezoid, triangle

## Grupos

```
Loop {
  Issue1
  Issue2
}
```

## Conexiones

```
Issue > Bug: Triage
Issue > Bug, Feature
Issue > Bug > Duplicate?
```

## Direccion

```
direction right   // down (default), up, right, left
```

---

# Referencia de sintaxis: ERD diagrams

## Entidades

```
users [icon: user, color: blue] {
  id string pk
  displayName string
  teamId string
}
```

## Relaciones

```
users.teamId > teams.id
```

| Conector | Cardinalidad |
|----------|-------------|
| `<` | One-to-many |
| `>` | Many-to-one |
| `-` | One-to-one |
| `<>` | Many-to-many |

## Estilos

`notation crows-feet` o `notation chen` (default)

---

# Referencia de sintaxis: BPMN diagrams

## Flow objects

```
Place order [type: activity]
Shipped [type: event]
Approved? [type: gateway]
```

Tipos: activity (default), event, gateway

## Pools y Lanes

```
Online store {
  Warehouse {
    Place order [type: activity]
    Shipped [type: event]
  }
}
```

Pool = contenedor exterior. Lane = contenedor interior.

## Conexiones

Misma sintaxis que flowcharts. Usa `--` (linea punteada) para message flows entre pools.

---

# Iconos utiles para EDA / Azure

| Icono | Nombre |
|-------|--------|
| Azure Functions | `azure-functions` |
| Azure Service Bus | `azure-service-bus` |
| Azure Storage | `azure-storage` |
| Azure Cosmos DB | `azure-cosmos-db` |
| Azure App Insights | `azure-application-insights` |
| Azure Virtual Networks | `azure-virtual-networks` |
| Database | `database` |
| Server | `server` |
| Monitor | `monitor` |
| User | `user` |
| Cloud | `cloud` |
| Kafka | `kafka` |
| Settings/Gear | `settings` |
| Zap/Lightning | `zap` |
| Mail | `mail` |
