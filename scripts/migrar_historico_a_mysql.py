"""
Script de migración de UNA SOLA VEZ (no corre en el cron regular).

Sube el historico_contratos.json local (acumulador de git, a punto de tocar
el límite de 100MB de GitHub) a la tabla MySQL nueva en Hostinger — ver
docs/plan-evolucion-plataforma.md (repo privado) para el porqué de una base
separada del servicio de pago.

Requiere las mismas variables de entorno que generar_json.py usa para MySQL
(SECOP_MYSQL_HOST/PORT/USER/PASSWORD/DATABASE).

Uso: python scripts/migrar_historico_a_mysql.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pandas as pd  # noqa: E402

from generar_json import COLUMNAS_FECHA, guardar_historico  # noqa: E402

_RAIZ_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HISTORICO_PATH = os.path.join(_RAIZ_REPO, "api", "secop", "historico_contratos.json")


def main():
    with open(HISTORICO_PATH, encoding="utf-8") as f:
        registros = json.load(f)
    print(f"[info] {len(registros)} contratos en {HISTORICO_PATH}.")

    df = pd.DataFrame.from_records(registros)
    for col in COLUMNAS_FECHA:
        df[col] = pd.to_datetime(df[col], errors="coerce")

    print("[info] subiendo a MySQL (puede tardar varios minutos)...")
    guardar_historico(df)
    print(f"[ok] {len(df)} contratos migrados a la tabla MySQL.")


if __name__ == "__main__":
    main()
