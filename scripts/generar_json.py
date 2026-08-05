"""
Genera los JSON estáticos de la API SECOP II (Ruta A: sin backend, solo archivos
estáticos servidos por Netlify) a partir de la API Socrata de Datos Abiertos Colombia.

Diseñado para correr en un job programado (GitHub Actions), no en una máquina personal:
- No depende de credenciales obligatorias (usa SOCRATA_APP_TOKEN si existe, si no,
  cae a modo anónimo con throttling).
- Escribe los resultados en OUTPUT_DIR (por defecto ./api/secop) como JSON versionable.
"""

import hashlib
import json
import os
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import LabelEncoder
from sodapy import Socrata

DATASET_ID = "jbjy-vk9h"
DOMINIO = "www.datos.gov.co"
# 5000 registros era una muestra demasiado angosta (~5 días de contratación) para
# un dataset al que tenemos acceso completo en vivo. Verificado empíricamente:
# pedir 20,000 funciona de forma confiable (anónimo, ~49s) y amplía la ventana a
# ~13 días con 1,637 entidades distintas — mucha más cobertura para el buscador
# de la Fase 1, sin costo adicional (GitHub Actions sigue gratis para el repo
# público). Con SOCRATA_APP_TOKEN configurado, límites mayores son más confiables.
MAX_REGISTROS = int(os.getenv("SOCRATA_MAX_REGISTROS", "20000"))
# "Prestación de servicios" (contratación individual de personas para apoyo/
# servicios profesionales) distorsiona tanto los agregados como el modelo de
# riesgo — verificado con una muestra real de 20,000 registros: es el 88.7% de
# TODOS los contratos por conteo, pero solo el 40.7% del valor total. Incluirlo
# desperdicia la mayor parte del cupo de cada corrida en el tipo de contrato
# menos relevante para auditoría de contratación pública (obra, suministros,
# interventoría, consultoría son los que de verdad importan para detectar
# riesgo), y arrastra la mediana de valor muy por debajo de lo representativo.
# Se excluye en la consulta misma, no después, mismo principio que los filtros
# de completitud de más abajo.
#
# "Decreto 092 de 2017" es OTRA etiqueta de tipo_de_contrato para la MISMA
# categoría real: ese decreto crea el régimen especial para contratar personas
# naturales para prestación de servicios profesionales y de apoyo a la gestión
# (usado mucho por ESE/hospitales). El filtro original solo excluía la
# etiqueta literal "Prestación de servicios" y dejaba pasar esta — verificado
# con un registro real: tipo_de_contrato="Decreto 092 de 2017" con
# descripcion_del_proceso="PRESTACION DE SERVICIOS COMO COORDINADOR...". Sin
# esto, ~208,000 contratos de prestación de servicios (el 3er tipo más común)
# seguían colándose en el histórico y distorsionando "Tendencia anual".
FILTRO_TIPOS_EXCLUIDOS = "tipo_de_contrato NOT IN ('Prestación de servicios', 'Decreto 092 de 2017')"
# Default relativo a la ubicación del script (no al directorio de trabajo
# actual) — un "./api/secop" ingenuo escribe en el lugar equivocado si el
# script se corre desde scripts/ en vez de la raíz del repo (le pasó a esta
# misma sesión: los datos reales quedaron en scripts/api/secop/ en vez de
# api/secop/). El workflow de GitHub Actions ya fija OUTPUT_DIR explícito, así
# que esto solo protege corridas manuales.
_RAIZ_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT_DIR = os.getenv("OUTPUT_DIR", os.path.join(_RAIZ_REPO, "api", "secop"))
HISTORICO_FILE = "historico_contratos.json"
COLUMNAS_FECHA = ["fecha_de_firma", "fecha_de_inicio_del_contrato", "fecha_de_fin_del_contrato"]

# Backfill histórico: ingerir() solo trae "lo más reciente" — con miles de
# contratos firmados por día, eso deja la ventana acumulada concentrada en
# apenas un par de semanas para siempre (nunca se vuelve a pedir nada más
# viejo). Verificado: eso hace que "Tendencia anual" y la concentración por
# sector/proveedor no reflejen años reales, solo la ventana reciente — dos
# gráficas clave para veedores públicos quedaban sin sentido. Por eso, además
# de la ventana reciente, cada corrida retrocede un poco más en el tiempo
# (independiente de la ventana de frescura) hasta llegar al histórico real del
# dataset (verificado empíricamente: hay contratos completos desde 2015-06).
CURSOR_BACKFILL_FILE = "cursor_backfill.json"
DIAS_POR_LOTE_BACKFILL = int(os.getenv("DIAS_POR_LOTE_BACKFILL", "90"))
MAX_REGISTROS_BACKFILL = int(os.getenv("MAX_REGISTROS_BACKFILL", "5000"))
FECHA_LIMITE_HISTORICA_SECOP = "2015-01-01"
# El cron dice "cada hora" (actualizar-secop.yml), pero GitHub Actions no lo
# cumple así en la práctica: verificado con el historial real de corridas —
# están cayendo cada ~2-3 horas, no cada hora (limitación conocida de GH
# Actions: retrasa/salta corridas programadas en repos de poca actividad). Con
# una sola ventana de 90 días por corrida, cubrir 2015->hoy (~4000 días)
# tomaría semanas reales — mientras tanto "Tendencia anual" queda dominada por
# un par de años recientes con miles de contratos y años viejos con un puñado,
# una muestra demasiado chica para ser representativa. Se retrocede varias
# ventanas por corrida para compensar, sin depender de que GH Actions dispare
# el cron con la frecuencia nominal.
ITERACIONES_BACKFILL_POR_CORRIDA = int(os.getenv("ITERACIONES_BACKFILL_POR_CORRIDA", "5"))

# Contratos encontrados en vivo por server/app.mjs (Hostinger) cuando alguien
# buscó algo que no estaba en la muestra local (por_entidad.json /
# expediente_contratos.json). scripts/absorber_pendientes_secop.mjs (Node) los
# recoge por HTTP y los vuelca aquí ANTES de correr este script — Python no le
# habla al servidor directamente. Si el archivo no existe (sin
# API_BASE_URL/ABSORBER_TOKEN configurados, o sin búsquedas en vivo desde la
# última corrida), simplemente no hay nada que fusionar.
PENDIENTES_ABSORBIDOS_FILE = os.path.join(_RAIZ_REPO, "scripts", "pendientes_absorbidos.json")


def ingerir():
    # Sin $order, Socrata devuelve el mismo slice congelado en cada corrida
    # (verificado empíricamente: dos pulls idénticos con offset=0 y sin order
    # devuelven exactamente los mismos registros, en el mismo orden) — el
    # "análisis en vivo" nunca reflejaba contratos nuevos aunque el dataset
    # fuente sí se actualiza en tiempo real.
    #
    # Ordenar solo por fecha_de_firma DESC no basta: SECOP recibe miles de
    # contratos firmados por día, así que "los 5000 más recientes" quedan
    # casi todos dentro de los últimos 1-2 días — y un contrato recién
    # firmado normalmente no tiene aún fecha de inicio/fin ni fue liquidado,
    # así que limpiar() los descartaba después (verificado: sobrevivía solo
    # el 10.9%, dejando apenas ~500 registros útiles concentrados en 2 días,
    # una muestra demasiado pequeña y poco diversa para el modelo de
    # anomalías). Por eso la completitud se filtra aquí, en la consulta, no
    # después: así "los 5000 más recientes" ya vienen completos por
    # construcción (verificado: da una ventana de ~5 días, 100% utilizable).
    token = os.getenv("SOCRATA_APP_TOKEN")
    cliente = Socrata(DOMINIO, token, timeout=60)
    registros = cliente.get(
        DATASET_ID,
        limit=MAX_REGISTROS,
        where=(
            "fecha_de_firma IS NOT NULL "
            "AND fecha_de_inicio_del_contrato IS NOT NULL "
            "AND fecha_de_fin_del_contrato IS NOT NULL "
            "AND valor_del_contrato IS NOT NULL "
            f"AND {FILTRO_TIPOS_EXCLUIDOS}"
        ),
        order="fecha_de_firma DESC",
    )
    return pd.DataFrame.from_records(registros)


def leer_cursor_backfill():
    ruta = os.path.join(OUTPUT_DIR, CURSOR_BACKFILL_FILE)
    if os.path.exists(ruta):
        with open(ruta, encoding="utf-8") as f:
            return json.load(f)
    # Primera corrida: arranca en hoy y retrocede hacia el histórico real.
    return {"fecha_cursor_backfill": date.today().isoformat()}


def escribir_cursor_backfill(fecha_cursor):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(os.path.join(OUTPUT_DIR, CURSOR_BACKFILL_FILE), "w", encoding="utf-8") as f:
        json.dump({"fecha_cursor_backfill": fecha_cursor}, f)


def ingerir_ventana_historica(fecha_inicio, fecha_fin, limite):
    """Igual que ingerir(), pero acotado a una ventana de fechas específica —
    para retroceder progresivamente por el histórico en vez de siempre pedir
    'lo más reciente'.

    OJO: usa order ASC, no DESC. Verificado empíricamente: con DESC + un
    límite menor que el tamaño real de la ventana, Socrata devuelve los
    registros más RECIENTES dentro de esa ventana ancha — es decir, vuelve a
    traer casi lo mismo que ingerir() en vez de alcanzar genuinamente el
    extremo más viejo de la ventana (confirmado con una corrida real: pedir
    una ventana de 180 días con límite 1000 y order DESC devolvió solo del
    2026-07-29 al 2026-07-31, ni un día antes). Con ASC sí se llega al extremo
    viejo de la ventana."""
    token = os.getenv("SOCRATA_APP_TOKEN")
    cliente = Socrata(DOMINIO, token, timeout=60)
    registros = cliente.get(
        DATASET_ID,
        limit=limite,
        where=(
            f"fecha_de_firma >= '{fecha_inicio}' AND fecha_de_firma <= '{fecha_fin}' "
            "AND fecha_de_firma IS NOT NULL "
            "AND fecha_de_inicio_del_contrato IS NOT NULL "
            "AND fecha_de_fin_del_contrato IS NOT NULL "
            "AND valor_del_contrato IS NOT NULL "
            f"AND {FILTRO_TIPOS_EXCLUIDOS}"
        ),
        order="fecha_de_firma ASC",
    )
    return pd.DataFrame.from_records(registros)


def _paso_backfill(fecha_fin):
    """Retrocede UNA ventana de DIAS_POR_LOTE_BACKFILL días terminando en
    fecha_fin. Si ya se alcanzó el límite histórico, reinicia desde hoy para
    volver a recorrerlo — el propio merge por id_contrato hace que reprocesar
    un contrato ya conocido no cause daño, solo trabajo redundante ocasional."""
    fecha_inicio = max(
        (date.fromisoformat(fecha_fin) - timedelta(days=DIAS_POR_LOTE_BACKFILL)),
        date.fromisoformat(FECHA_LIMITE_HISTORICA_SECOP),
    ).isoformat()

    if fecha_inicio == fecha_fin:
        print("[info] Backfill histórico alcanzó el límite (2015) — reiniciando desde hoy.")
        fecha_fin = date.today().isoformat()
        fecha_inicio = max(
            (date.fromisoformat(fecha_fin) - timedelta(days=DIAS_POR_LOTE_BACKFILL)),
            date.fromisoformat(FECHA_LIMITE_HISTORICA_SECOP),
        ).isoformat()

    print(f"[info] Backfill histórico: ventana {fecha_inicio} -> {fecha_fin}")
    df_ventana = ingerir_ventana_historica(fecha_inicio, fecha_fin, MAX_REGISTROS_BACKFILL)
    print(f"[info] Backfill histórico: {len(df_ventana)} contratos encontrados en la ventana")
    return df_ventana, fecha_inicio


def ingerir_backfill():
    """Retrocede ITERACIONES_BACKFILL_POR_CORRIDA ventanas del histórico real
    del dataset (independiente de ingerir(), que solo trae lo más reciente) en
    una sola corrida, y devuelve (dataframe acumulado, cursor final)."""
    cursor = leer_cursor_backfill()
    fecha_cursor = cursor["fecha_cursor_backfill"]

    dfs = []
    for _ in range(ITERACIONES_BACKFILL_POR_CORRIDA):
        df_ventana, fecha_cursor = _paso_backfill(fecha_cursor)
        if not df_ventana.empty:
            dfs.append(df_ventana)

    df_backfill = pd.concat(dfs, ignore_index=True) if dfs else pd.DataFrame()
    return df_backfill, fecha_cursor


def cargar_pendientes_absorbidos():
    """Lee los contratos de búsquedas en vivo que absorber_pendientes_secop.mjs
    volcó a disco antes de esta corrida (ver PENDIENTES_ABSORBIDOS_FILE). Son
    registros CRUDOS de Socrata (mismo esquema que ingerir()), así que pasan
    por el mismo limpiar()/calcular_desviacion_temporal() que el resto — un
    registro incompleto se descarta igual que cualquier otro, no se le da
    trato especial."""
    if not os.path.exists(PENDIENTES_ABSORBIDOS_FILE):
        return pd.DataFrame()
    with open(PENDIENTES_ABSORBIDOS_FILE, encoding="utf-8") as f:
        registros = json.load(f)
    if not registros:
        return pd.DataFrame()
    print(f"[info] {len(registros)} contratos de búsquedas en vivo absorbidos desde pendientes-secop.")
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


# Socrata devuelve 85+ columnas por contrato (datos bancarios, representante
# legal, etc.) pero todo el pipeline — agregaciones, expediente, modelo de
# riesgo — solo usa este subconjunto fijo (verificado revisando cada función
# downstream: construir_agregaciones, construir_por_entidad,
# construir_expediente_contratos, construir_features_riesgo). Sin recortar,
# historico_contratos.json crece sin control: con ~25,000 contratos y todas
# las columnas crudas llegó a 113 MB en pruebas locales — por encima del
# límite duro de GitHub (100 MB) — sin que ese archivo se consuma nunca desde
# el frontend (es solo el acumulador interno entre corridas de Python).
COLUMNAS_NECESARIAS = [
    "id_contrato", "nombre_entidad", "sector", "valor_del_contrato",
    "fecha_de_firma", "fecha_de_inicio_del_contrato", "fecha_de_fin_del_contrato",
    "dias_adicionados", "duracion_contrato_dias", "año_contrato",
    "desviacion_temporal_real", "retraso_critico", "tipo_de_contrato",
]


def recortar_columnas_necesarias(df):
    """Se aplica a cada lote recién limpiado (ingesta normal, backfill,
    pendientes absorbidos) ANTES de fusionarlo con el histórico — así la
    fusión nunca vuelve a traer las columnas crudas de vuelta, y tanto el
    archivo persistido como el resto del pipeline en esta misma corrida
    trabajan sobre el mismo esquema angosto."""
    col_proveedor = columna_proveedor(df)
    columnas = [c for c in COLUMNAS_NECESARIAS if c in df.columns]
    if col_proveedor in df.columns and col_proveedor not in columnas:
        columnas.append(col_proveedor)
    return df[columnas].copy()


def _hash_contenido(df):
    """Huella del contenido (no del orden) para detectar si algo realmente
    cambió entre corridas — evita que un timestamp por sí solo dispare un
    deploy cuando no hay contratos nuevos ni actualizados."""
    if df.empty:
        return hashlib.sha256(b"vacio").hexdigest()
    ordenado = df.sort_values("id_contrato").reset_index(drop=True)
    return hashlib.sha256(ordenado.to_json(orient="records", date_format="iso").encode("utf-8")).hexdigest()


def cargar_historico():
    ruta = os.path.join(OUTPUT_DIR, HISTORICO_FILE)
    if not os.path.exists(ruta):
        return pd.DataFrame()
    with open(ruta, encoding="utf-8") as f:
        registros = json.load(f)
    if not registros:
        return pd.DataFrame()
    df = pd.DataFrame.from_records(registros)
    for col in COLUMNAS_FECHA:
        df[col] = pd.to_datetime(df[col], errors="coerce")
    return df


def fusionar_historico(historico, nuevo):
    # keep="last" hace que el dato recién ingerido gane si un contrato ya
    # existente cambió (ej. se le adicionaron más días) — nunca se pierde un
    # contrato ya acumulado, solo se actualiza si Socrata trae algo distinto.
    combinado = pd.concat([historico, nuevo], ignore_index=True)
    return combinado.drop_duplicates(subset="id_contrato", keep="last").reset_index(drop=True)


def filtrar_valores_implausibles(df):
    # Encontrado en producción: un solo contrato con valor_del_contrato =
    # 6,453,840,000,000,000 COP (6.45 CUATRILLONES) — una mejora de
    # infraestructura de UN colegio, verificado directo contra Socrata (no es
    # un bug de parseo nuestro: el dato fuente de SECOP ya viene así, un
    # evidente error de digitación). El siguiente valor más alto en toda la
    # muestra es ~2.39 billones/trillion COP — casi 2700x más chico. Ese solo
    # registro inflaba el total y promedio de su año por varios órdenes de
    # magnitud, dejando "Tendencia anual" ilegible (los demás años quedaban
    # invisibles al lado).
    #
    # El umbral se recalcula en cada corrida a partir del percentil 99.9 de la
    # MUESTRA ACTUAL (no un número fijo que se vuelva obsoleto a medida que la
    # muestra crece) con un margen x50 — generoso a propósito: el contrato
    # legítimo más grande verificado en la muestra real (~2.39 billones) queda
    # muy por debajo, así que esto no debería tocar contratos grandes pero
    # reales (obra pública, defensa), solo el caso claramente absurdo.
    if len(df) < 100:
        return df  # muestra muy chica para que un percentil tenga sentido
    umbral = df["valor_del_contrato"].quantile(0.999) * 50
    descartados = df[df["valor_del_contrato"] > umbral]
    if len(descartados):
        print(f"[info] {len(descartados)} contrato(s) descartado(s) por valor implausible "
              f"(> {umbral:,.0f} COP): {descartados['id_contrato'].tolist()}")
    return df[df["valor_del_contrato"] <= umbral].copy()


def guardar_historico(df):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    ruta = os.path.join(OUTPUT_DIR, HISTORICO_FILE)
    with open(ruta, "w", encoding="utf-8") as f:
        f.write(df.to_json(orient="records", date_format="iso", force_ascii=False, indent=2))


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


def columna_proveedor(df):
    return "proveedor_adjudicado" if "proveedor_adjudicado" in df.columns else "documento_proveedor"


def construir_agregaciones(df, riesgo):
    por_sector = (
        df.groupby("sector")["valor_del_contrato"]
        .agg(total_contratos="count", valor_total="sum", valor_promedio="mean")
        .reset_index()
        .sort_values("valor_total", ascending=False)
    )

    # "Riesgo de concentración" real es que UN MISMO contratista se lleve varios
    # contratos por un monto significativo — no simplemente tener el valor_total
    # más alto. Un proveedor con un solo contrato gigante (ej. un banco que le
    # prestó una vez al Estado) no es una señal de concentración/favoritismo,
    # aunque su valor_total sea enorme. Bug real encontrado en producción: sin
    # el filtro de abajo, "PROSPERIDAD SOCIAL" y "CONSORCIO THC CORREDOR VERDE 99"
    # (1 solo contrato cada uno) aparecían en el top 10 etiquetados como "señal
    # de riesgo de monopolio", mientras proveedores con concentración real (ej.
    # "ETB SA ESP" con 68 contratos) quedaban más abajo en el ranking solo por
    # tener un valor_total menor. Se exige total_contratos >= 2 para calificar.
    col_proveedor = columna_proveedor(df)
    top_proveedores = (
        df.groupby(col_proveedor)["valor_del_contrato"]
        .agg(total_contratos="count", valor_total="sum")
        .reset_index()
        .rename(columns={col_proveedor: "proveedor"})
    )
    top_proveedores = (
        top_proveedores[top_proveedores["total_contratos"] >= 2]
        .sort_values("valor_total", ascending=False)
        .head(10)
    )

    return por_sector, top_proveedores


def construir_por_entidad(df):
    por_entidad = (
        df.groupby("nombre_entidad")
        .agg(
            total_contratos=("valor_del_contrato", "count"),
            valor_total=("valor_del_contrato", "sum"),
            valor_promedio=("valor_del_contrato", "mean"),
            sector=("sector", lambda s: s.mode().iat[0] if not s.mode().empty else None),
        )
        .reset_index()
        .sort_values("valor_total", ascending=False)
    )
    return por_entidad


def construir_expediente_contratos(df, riesgo):
    col_proveedor = columna_proveedor(df)
    columnas_expediente = ["id_contrato", "nombre_entidad", "sector", "año_contrato",
                            "valor_del_contrato", "duracion_contrato_dias",
                            "fecha_de_firma", "fecha_de_inicio_del_contrato",
                            "fecha_de_fin_del_contrato", "dias_adicionados", col_proveedor]
    expediente = df[columnas_expediente].rename(
        columns={"año_contrato": "anio", col_proveedor: "proveedor"}
    ).copy()

    # bandera_roja solo existe para las filas que sobrevivieron construir_features_riesgo();
    # el resto del corpus (valor $0, sector nulo, etc.) no tiene puntaje del modelo.
    expediente = expediente.merge(
        riesgo[["id_contrato", "puntaje_anomalia", "bandera_roja"]],
        on="id_contrato", how="left",
    )
    return expediente


def a_registros_json(df):
    return json.loads(df.to_json(orient="records", date_format="iso", force_ascii=False))


def escribir_json(nombre, datos):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    ruta = os.path.join(OUTPUT_DIR, nombre)
    with open(ruta, "w", encoding="utf-8") as f:
        json.dump(datos, f, ensure_ascii=False, indent=2)
    print(f"[ok] {ruta}")


def cargar_json_si_existe(nombre):
    ruta = os.path.join(OUTPUT_DIR, nombre)
    if not os.path.exists(ruta):
        return None
    with open(ruta, encoding="utf-8") as f:
        return json.load(f)


def main():
    # "Contratos analizados" antes se reemplazaba en cada corrida por la
    # ventana fresca del momento — nunca crecía, y el timestamp de resumen.json
    # cambiaba siempre así no hubiera nada nuevo, forzando un deploy en el 100%
    # de las corridas (verificado en el historial real de Actions/commits del
    # repo). Ahora se acumula: cada corrida fusiona lo nuevo con
    # historico_contratos.json en vez de reemplazarlo, así la métrica crece de
    # verdad con el tiempo, y solo se toca resumen.json cuando algo cambió
    # de verdad (no por el simple paso del reloj).
    df_nuevo = ingerir()
    total_ingeridos_corrida = len(df_nuevo)

    df_nuevo = limpiar(df_nuevo)
    df_nuevo = calcular_desviacion_temporal(df_nuevo)
    df_nuevo = recortar_columnas_necesarias(df_nuevo)

    # Backfill: además de la ventana reciente (arriba), retrocede un poco más
    # en el histórico real en cada corrida — sin esto, "Tendencia anual" y la
    # concentración por sector/proveedor solo reflejarían las últimas semanas
    # para siempre, sin importar cuánto tiempo pase.
    df_backfill, nuevo_cursor_backfill = ingerir_backfill()
    if not df_backfill.empty:
        df_backfill = limpiar(df_backfill)
        df_backfill = calcular_desviacion_temporal(df_backfill)
        df_backfill = recortar_columnas_necesarias(df_backfill)
        df_nuevo = pd.concat([df_nuevo, df_backfill], ignore_index=True).drop_duplicates(
            subset="id_contrato", keep="last"
        )

    # Pendientes de búsquedas en vivo (fallback-secop.mjs): mismo tratamiento
    # que el backfill, mismo motivo — son registros crudos de Socrata, pasan
    # por el mismo pipeline de limpieza antes de fusionarse.
    df_pendientes = cargar_pendientes_absorbidos()
    if not df_pendientes.empty:
        df_pendientes = limpiar(df_pendientes)
        df_pendientes = calcular_desviacion_temporal(df_pendientes)
        df_pendientes = recortar_columnas_necesarias(df_pendientes)
        df_nuevo = pd.concat([df_nuevo, df_pendientes], ignore_index=True).drop_duplicates(
            subset="id_contrato", keep="last"
        )

    historico = cargar_historico()
    hash_previo = _hash_contenido(historico)

    df = fusionar_historico(historico, df_nuevo)
    df = filtrar_valores_implausibles(df)
    total_acumulado = len(df)
    total_nuevos_o_actualizados = total_acumulado - len(historico) if not historico.empty else total_acumulado

    # Guardar y releer antes de comparar: el dataframe recién fusionado en
    # memoria puede tener dtypes distintos al de "historico" (cargado de
    # disco) por el propio concat, aunque el contenido lógico sea idéntico —
    # eso hacía que el hash cambiara "solo" (verificado: con el mismo set
    # exacto de contratos y cero campos distintos entre dos corridas
    # seguidas, el hash igual difería). Comparar ambos lados tras pasar por
    # el mismo pipeline de carga elimina ese falso positivo.
    guardar_historico(df)
    escribir_cursor_backfill(nuevo_cursor_backfill)
    hash_actual = _hash_contenido(cargar_historico())
    hubo_cambios = hash_actual != hash_previo

    riesgo = construir_features_riesgo(df)
    riesgo = detectar_anomalias(riesgo)

    red_flags = riesgo[riesgo["bandera_roja"]].sort_values("puntaje_anomalia")
    columnas_red_flag = ["id_contrato", "nombre_entidad", "sector", "año_contrato", "valor_del_contrato",
                          "duracion_contrato_dias", "desviacion_temporal_real", "ratio_desviacion_temporal",
                          "puntaje_anomalia"]
    red_flags_out = red_flags[columnas_red_flag].rename(columns={"año_contrato": "anio"})

    por_sector, top_proveedores = construir_agregaciones(df, riesgo)
    por_entidad = construir_por_entidad(df)
    expediente_contratos = construir_expediente_contratos(df, riesgo)

    # Si nada cambió, reusar el generado_en anterior — así resumen.json queda
    # byte-idéntico y el workflow no commitea un "cambio" que no existió.
    generado_en = datetime.now(timezone.utc).isoformat()
    if not hubo_cambios:
        resumen_previo = cargar_json_si_existe("resumen.json")
        if resumen_previo:
            generado_en = resumen_previo["generado_en"]

    resumen = {
        "generado_en": generado_en,
        "fuente": {
            "dataset": DATASET_ID,
            "dominio": DOMINIO,
            "descripcion": "SECOP II - Contratos Electrónicos, Datos Abiertos Colombia",
        },
        "muestra": {
            "ingeridos_esta_corrida": total_ingeridos_corrida,
            "acumulados_total": total_acumulado,
            "nuevos_o_actualizados_esta_corrida": int(total_nuevos_o_actualizados),
            "aptos_modelo": len(riesgo),
            "entidades_distintas": len(por_entidad),
            "valor_total_acumulado_cop": float(df["valor_del_contrato"].sum()),
            "sectores_distintos": int(df["sector"].nunique()),
            "fecha_firma_min": df["fecha_de_firma"].min().date().isoformat(),
            "fecha_firma_max": df["fecha_de_firma"].max().date().isoformat(),
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
    escribir_json("top_proveedores.json", a_registros_json(top_proveedores))
    escribir_json("por_entidad.json", a_registros_json(por_entidad))
    escribir_json("expediente_contratos.json", a_registros_json(expediente_contratos))

    print(f"\nResumen: {total_ingeridos_corrida} ingeridos esta corrida, "
          f"{total_acumulado} acumulados en total, {len(riesgo)} aptos para el modelo, "
          f"{len(red_flags_out)} red flags. Cambios reales: {hubo_cambios}.")


if __name__ == "__main__":
    main()
