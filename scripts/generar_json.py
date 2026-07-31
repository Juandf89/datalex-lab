"""
Genera los JSON estáticos de la API SECOP II (Ruta A: sin backend, solo archivos
estáticos servidos por Netlify) a partir de la API Socrata de Datos Abiertos Colombia.

Diseñado para correr en un job programado (GitHub Actions), no en una máquina personal:
- No depende de credenciales obligatorias (usa SOCRATA_APP_TOKEN si existe, si no,
  cae a modo anónimo con throttling).
- Escribe los resultados en OUTPUT_DIR (por defecto ./api/secop) como JSON versionable.
"""

import json
import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import LabelEncoder
from sodapy import Socrata

DATASET_ID = "jbjy-vk9h"
DOMINIO = "www.datos.gov.co"
MAX_REGISTROS = int(os.getenv("SOCRATA_MAX_REGISTROS", "5000"))
OUTPUT_DIR = os.getenv("OUTPUT_DIR", "./api/secop")


def ingerir():
    token = os.getenv("SOCRATA_APP_TOKEN")
    cliente = Socrata(DOMINIO, token, timeout=60)
    registros = cliente.get(DATASET_ID, limit=MAX_REGISTROS, offset=0)
    return pd.DataFrame.from_records(registros)


def limpiar(df):
    df["valor_del_contrato"] = df["valor_del_contrato"].astype(str).str.replace(",", "", regex=False)
    df["valor_del_contrato"] = pd.to_numeric(df["valor_del_contrato"], errors="coerce")

    for col in ["fecha_de_firma", "fecha_de_inicio_del_contrato", "fecha_de_fin_del_contrato"]:
        df[col] = pd.to_datetime(df[col], errors="coerce")

    df = df.dropna(subset=["fecha_de_firma", "fecha_de_inicio_del_contrato",
                            "fecha_de_fin_del_contrato", "valor_del_contrato"]).copy()

    df["duracion_contrato_dias"] = (df["fecha_de_fin_del_contrato"] - df["fecha_de_inicio_del_contrato"]).dt.days
    df["año_contrato"] = df["fecha_de_firma"].dt.year
    return df


def calcular_desviacion_temporal(df):
    # 'fecha_de_liquidacion' NO existe en el esquema real de jbjy-vk9h; el campo real
    # disponible más cercano a una desviación temporal es 'dias_adicionados' (días de
    # plazo adicionados formalmente al contrato mediante modificaciones/otrosíes).
    df["dias_adicionados"] = pd.to_numeric(df.get("dias_adicionados"), errors="coerce").fillna(0)
    df["desviacion_temporal_real"] = df["dias_adicionados"]
    df["retraso_critico"] = df["desviacion_temporal_real"] > 365
    return df


def construir_features_riesgo(df):
    df["ratio_desviacion_temporal"] = df["desviacion_temporal_real"] / df["duracion_contrato_dias"].replace(0, np.nan)

    riesgo = df.dropna(subset=["ratio_desviacion_temporal", "valor_del_contrato", "sector"]).copy()
    riesgo = riesgo[np.isfinite(riesgo["ratio_desviacion_temporal"])]
    # Contratos con valor $0 son registros incompletos/erróneos: distorsionan la escala
    # financiera del modelo y no pueden representarse en un eje logarítmico.
    riesgo = riesgo[riesgo["valor_del_contrato"] > 0]

    codificador_sector = LabelEncoder()
    riesgo["sector_codificado"] = codificador_sector.fit_transform(riesgo["sector"].astype(str))
    return riesgo


def detectar_anomalias(riesgo):
    columnas_modelo = ["desviacion_temporal_real", "ratio_desviacion_temporal", "valor_del_contrato",
                        "duracion_contrato_dias", "sector_codificado"]
    X = riesgo[columnas_modelo]

    modelo = IsolationForest(n_estimators=200, contamination=0.05, random_state=42)
    riesgo["anomalia"] = modelo.fit_predict(X)
    riesgo["puntaje_anomalia"] = modelo.decision_function(X)
    riesgo["bandera_roja"] = (riesgo["anomalia"] == -1) & (riesgo["retraso_critico"])
    return riesgo


def construir_agregaciones(df, riesgo):
    por_sector = (
        df.groupby("sector")["valor_del_contrato"]
        .agg(total_contratos="count", valor_total="sum", valor_promedio="mean")
        .reset_index()
        .sort_values("valor_total", ascending=False)
    )

    por_anio = (
        df.groupby("año_contrato")["valor_del_contrato"]
        .agg(total_contratos="count", valor_total="sum", valor_promedio="mean")
        .reset_index()
        .rename(columns={"año_contrato": "anio"})
        .sort_values("anio")
    )

    col_proveedor = "proveedor_adjudicado" if "proveedor_adjudicado" in df.columns else "documento_proveedor"
    top_proveedores = (
        df.groupby(col_proveedor)["valor_del_contrato"]
        .sum()
        .reset_index()
        .rename(columns={col_proveedor: "proveedor", "valor_del_contrato": "valor_total"})
        .sort_values("valor_total", ascending=False)
        .head(10)
    )

    return por_sector, por_anio, top_proveedores


def a_registros_json(df):
    return json.loads(df.to_json(orient="records", date_format="iso", force_ascii=False))


def escribir_json(nombre, datos):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    ruta = os.path.join(OUTPUT_DIR, nombre)
    with open(ruta, "w", encoding="utf-8") as f:
        json.dump(datos, f, ensure_ascii=False, indent=2)
    print(f"[ok] {ruta}")


def main():
    df = ingerir()
    total_ingeridos = len(df)

    df = limpiar(df)
    total_limpios = len(df)

    df = calcular_desviacion_temporal(df)
    riesgo = construir_features_riesgo(df)
    total_valor_cero = total_limpios - len(riesgo)

    riesgo = detectar_anomalias(riesgo)

    red_flags = riesgo[riesgo["bandera_roja"]].sort_values("puntaje_anomalia")
    columnas_red_flag = ["id_contrato", "nombre_entidad", "sector", "año_contrato", "valor_del_contrato",
                          "duracion_contrato_dias", "desviacion_temporal_real", "ratio_desviacion_temporal",
                          "puntaje_anomalia"]
    red_flags_out = red_flags[columnas_red_flag].rename(columns={"año_contrato": "anio"})

    por_sector, por_anio, top_proveedores = construir_agregaciones(df, riesgo)

    resumen = {
        "generado_en": datetime.now(timezone.utc).isoformat(),
        "fuente": {
            "dataset": DATASET_ID,
            "dominio": DOMINIO,
            "descripcion": "SECOP II - Contratos Electrónicos, Datos Abiertos Colombia",
        },
        "muestra": {
            "ingeridos": total_ingeridos,
            "limpios": total_limpios,
            "aptos_modelo": len(riesgo),
            "descartados_valor_cero": int(total_valor_cero),
        },
        "modelo": {
            "algoritmo": "IsolationForest",
            "anomalias_detectadas": int((riesgo["anomalia"] == -1).sum()),
            "red_flags": len(red_flags_out),
        },
        "red_flags_resumen": {
            "valor_total_cop": float(red_flags_out["valor_del_contrato"].sum()) if len(red_flags_out) else 0,
            "desviacion_promedio_dias": float(red_flags_out["desviacion_temporal_real"].mean()) if len(red_flags_out) else 0,
        },
    }

    escribir_json("resumen.json", resumen)
    escribir_json("red_flags.json", a_registros_json(red_flags_out))
    escribir_json("por_sector.json", a_registros_json(por_sector))
    escribir_json("por_anio.json", a_registros_json(por_anio))
    escribir_json("top_proveedores.json", a_registros_json(top_proveedores))

    print(f"\nResumen: {total_ingeridos} ingeridos, {total_limpios} limpios, "
          f"{len(riesgo)} aptos, {len(red_flags_out)} red flags.")


if __name__ == "__main__":
    main()
