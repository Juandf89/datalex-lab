"""
Script de mantenimiento de UNA SOLA VEZ (no corre en el cron regular).

Motivo: hasta ahora, FILTRO_TIPOS_EXCLUIDOS en generar_json.py solo excluía
tipo_de_contrato = 'Prestación de servicios', pero 'Decreto 092 de 2017' es la
MISMA categoría bajo otra etiqueta (régimen especial para prestación de
servicios profesionales/apoyo a la gestión) y se coló en historico_contratos.json
durante meses de acumulación, antes de corregir el filtro. Como
COLUMNAS_NECESARIAS no guardaba tipo_de_contrato, no se puede filtrar
localmente — hay que volver a preguntarle a Socrata el tipo de cada
id_contrato ya acumulado.

Uso: python scripts/purgar_contaminacion_historica.py
(usa SOCRATA_APP_TOKEN del entorno si existe, opcional).
"""

import json
import os
import time

import requests

DATASET_ID = "jbjy-vk9h"
DOMINIO = "https://www.datos.gov.co"
TIPOS_A_PURGAR = ["Prestación de servicios", "Decreto 092 de 2017"]
TAMANO_LOTE = 150

_RAIZ_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HISTORICO_PATH = os.path.join(_RAIZ_REPO, "api", "secop", "historico_contratos.json")


def lotes(lista, tamano):
    for i in range(0, len(lista), tamano):
        yield lista[i:i + tamano]


def ids_contaminados(ids_lote, headers, reintentos=4):
    ids_sql = ",".join(f"'{i}'" for i in ids_lote)
    tipos_sql = ",".join(f"'{t}'" for t in TIPOS_A_PURGAR)
    where = f"id_contrato IN ({ids_sql}) AND tipo_de_contrato IN ({tipos_sql})"
    # Corriendo esto muchas veces en el mismo día contra la API anónima de
    # Socrata (sin SOCRATA_APP_TOKEN) produce 500s transitorios ocasionales —
    # no es un error real de la consulta, se reintenta con backoff antes de
    # rendirse.
    for intento in range(reintentos):
        try:
            resp = requests.get(
                f"{DOMINIO}/resource/{DATASET_ID}.json",
                params={"$select": "id_contrato", "$where": where, "$limit": str(len(ids_lote))},
                headers=headers,
                timeout=30,
            )
            resp.raise_for_status()
            return {r["id_contrato"] for r in resp.json()}
        except requests.exceptions.RequestException as e:
            if intento == reintentos - 1:
                raise
            espera = 2 ** intento
            print(f"[warn] lote falló ({e}) — reintentando en {espera}s...")
            time.sleep(espera)


def main():
    with open(HISTORICO_PATH, encoding="utf-8") as f:
        registros = json.load(f)

    ids = [r["id_contrato"] for r in registros]
    print(f"[info] {len(ids)} contratos en historico_contratos.json a revisar.")

    token = os.getenv("SOCRATA_APP_TOKEN")
    headers = {"X-App-Token": token} if token else {}

    contaminados = set()
    total_lotes = (len(ids) + TAMANO_LOTE - 1) // TAMANO_LOTE
    for i, lote in enumerate(lotes(ids, TAMANO_LOTE), start=1):
        encontrados = ids_contaminados(lote, headers)
        contaminados |= encontrados
        if i % 20 == 0 or i == total_lotes:
            print(f"[info] lote {i}/{total_lotes} — {len(contaminados)} contaminados encontrados hasta ahora")
        if not token:
            time.sleep(0.2)  # sin token, más suave con el rate limit anónimo

    print(f"[info] total contaminados a purgar: {len(contaminados)}")

    if not contaminados:
        print("[ok] nada que purgar.")
        return

    limpios = [r for r in registros if r["id_contrato"] not in contaminados]
    with open(HISTORICO_PATH, "w", encoding="utf-8") as f:
        json.dump(limpios, f, ensure_ascii=False, indent=2)

    print(f"[ok] historico_contratos.json: {len(registros)} -> {len(limpios)} contratos "
          f"({len(contaminados)} purgados).")


if __name__ == "__main__":
    main()
