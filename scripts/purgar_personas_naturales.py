"""
Script de mantenimiento de UNA SOLA VEZ (no corre en el cron regular).

Motivo: hasta ahora FILTRO_TIPOS_EXCLUIDOS en generar_json.py solo excluía
tipo_de_contrato = 'Prestación de servicios'/'Decreto 092 de 2017', pero
personas naturales también reciben contratos de Compraventa, Suministros,
Arrendamiento, Obra, etc. — tipos que ese filtro no toca. Encontrado en
producción: "Yesid Avila Torres" (cédula de ciudadanía) en el top de
proveedores nacional con 2.39 billones COP en 31 contratos de esos tipos.

generar_json.py ya filtra esto en la ingesta (FILTRO_PERSONA_JURIDICA), pero
eso solo protege contratos nuevos — hay que volver a preguntarle a Socrata el
tipodocproveedor de cada id_contrato ya acumulado en historico_contratos.json,
porque ese campo nunca se guardó localmente (no estaba en COLUMNAS_NECESARIAS).

De paso, aprovecha la misma pasada para aplicar sanear_texto_legado() a
nombre_entidad/proveedor_adjudicado de TODO el histórico — ese arreglo no
necesita consultar Socrata (el texto corrupto ya está completo en el archivo
local, solo mal decodificado).

Uso: python scripts/purgar_personas_naturales.py
(usa SOCRATA_APP_TOKEN del entorno si existe, opcional).
"""

import json
import os
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generar_json import sanear_texto_legado  # noqa: E402

DATASET_ID = "jbjy-vk9h"
DOMINIO = "https://www.datos.gov.co"
TAMANO_LOTE = 150

_RAIZ_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HISTORICO_PATH = os.path.join(_RAIZ_REPO, "api", "secop", "historico_contratos.json")


def lotes(lista, tamano):
    for i in range(0, len(lista), tamano):
        yield lista[i:i + tamano]


def ids_persona_natural(ids_lote, headers, reintentos=4):
    ids_sql = ",".join(f"'{i}'" for i in ids_lote)
    where = f"id_contrato IN ({ids_sql}) AND tipodocproveedor <> 'NIT'"
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

    print(f"[info] {len(registros)} contratos en historico_contratos.json.")

    afectados_encoding = 0
    for r in registros:
        for campo in ("nombre_entidad", "proveedor_adjudicado"):
            original = r.get(campo)
            arreglado = sanear_texto_legado(original)
            if arreglado != original:
                r[campo] = arreglado
                afectados_encoding += 1
    print(f"[info] {afectados_encoding} campo(s) con encoding corregido (nombre_entidad/proveedor_adjudicado).")

    ids = [r["id_contrato"] for r in registros]
    token = os.getenv("SOCRATA_APP_TOKEN")
    headers = {"X-App-Token": token} if token else {}

    personas_naturales = set()
    total_lotes = (len(ids) + TAMANO_LOTE - 1) // TAMANO_LOTE
    for i, lote in enumerate(lotes(ids, TAMANO_LOTE), start=1):
        encontrados = ids_persona_natural(lote, headers)
        personas_naturales |= encontrados
        if i % 20 == 0 or i == total_lotes:
            print(f"[info] lote {i}/{total_lotes} — {len(personas_naturales)} personas naturales encontradas hasta ahora")
        if not token:
            time.sleep(0.2)

    print(f"[info] total personas naturales a purgar: {len(personas_naturales)}")

    limpios = [r for r in registros if r["id_contrato"] not in personas_naturales]
    with open(HISTORICO_PATH, "w", encoding="utf-8") as f:
        json.dump(limpios, f, ensure_ascii=False, indent=2)

    print(f"[ok] historico_contratos.json: {len(registros)} -> {len(limpios)} contratos "
          f"({len(personas_naturales)} purgados, {afectados_encoding} encoding corregido).")


if __name__ == "__main__":
    main()
