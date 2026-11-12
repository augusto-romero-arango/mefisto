#!/usr/bin/env bash
# Ejecuta el guard `verificar_pin_otlp` del Paso 7 de domain-scaffolder (#1230, #1246).
# El contrato de pines que se verifica leyendo el texto esta en domain-scaffolder-otel-pins.test.mts.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AGENT="$REPO_ROOT/agents/domain-scaffolder.md"
# El guard lanza el script del paquete; el preambulo que fija su raiz no se extrae.
export MEFISTO_PACKAGE_ROOT="$REPO_ROOT"

python3 - "$AGENT" <<'PY'
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional

agente_path = Path(sys.argv[1])
agente = agente_path.read_text()
pasaron = 0
fallaron = 0


def verificar(condicion: bool, descripcion: str) -> None:
    global pasaron, fallaron
    if condicion:
        pasaron += 1
        print(f"  PASS: {descripcion}")
    else:
        fallaron += 1
        print(f"  FAIL: {descripcion}")


print("[comportamiento] el parser cuenta referencias XML, no lineas de texto")
inicio = agente.find("verificar_pin_otlp() {")
fin = agente.find("\n}\n\nverificar_pin_otlp \\", inicio)
if inicio < 0 or fin < 0:
    verificar(False, "la funcion de verificacion puede extraerse del Paso 7")
else:
    with tempfile.TemporaryDirectory() as temporal:
        raiz = Path(temporal)
        guard = raiz / "guard.sh"
        guard.write_text(agente[inicio : fin + 3])
        paquete = "OpenTelemetry.Extensions.Hosting"
        version = "1.15.3"

        def ejecutar(nombre: str, contenido: Optional[str]) -> subprocess.CompletedProcess:
            csproj = raiz / f"{nombre}.csproj"
            if contenido is not None:
                csproj.write_text(contenido)
            return subprocess.run(
                [
                    "bash",
                    "-c",
                    'source "$1"; verificar_pin_otlp "$2" "$3" "$4"',
                    "_",
                    str(guard),
                    paquete,
                    version,
                    str(csproj),
                ],
                text=True,
                capture_output=True,
                check=False,
            )

        sano = ejecutar(
            "sano",
            '<Project><ItemGroup><PackageReference Version="1.15.3"\n'
            ' Include="OpenTelemetry.Extensions.Hosting"></PackageReference></ItemGroup></Project>',
        )
        verificar(sano.returncode == 0, "acepta el unico pin exacto aunque cambie el formato XML")

        duplicado = ejecutar(
            "duplicado",
            '<Project><ItemGroup><PackageReference Include="OpenTelemetry.Extensions.Hosting" '
            'Version="1.15.3" /><PackageReference\nInclude="OpenTelemetry.Extensions.Hosting" '
            'Version="1.15.3"></PackageReference></ItemGroup></Project>',
        )
        verificar(duplicado.returncode != 0, "rechaza referencias duplicadas aunque una sea multilinea")
        verificar(
            all(valor in duplicado.stdout for valor in (paquete, version, "duplicado.csproj")),
            "el error de duplicado nombra paquete, pin y archivo",
        )

        mismatch = ejecutar(
            "mismatch",
            '<Project><ItemGroup><PackageReference Include="OpenTelemetry.Extensions.Hosting" '
            'Version="1.13.1" /></ItemGroup></Project>',
        )
        verificar(mismatch.returncode != 0, "rechaza un pin distinto")
        verificar(
            all(valor in mismatch.stdout for valor in (paquete, version, "mismatch.csproj")),
            "el error de mismatch nombra paquete, pin y archivo",
        )

        ausente = ejecutar("ausente", None)
        verificar(ausente.returncode != 0, "rechaza un csproj ausente")
        verificar(
            all(valor in ausente.stdout for valor in (paquete, version, "ausente.csproj")),
            "el error de archivo ausente nombra paquete, pin y archivo",
        )

print(f"\nRESULTADO: {pasaron} pasaron, {fallaron} fallaron")
raise SystemExit(1 if fallaron else 0)
PY
