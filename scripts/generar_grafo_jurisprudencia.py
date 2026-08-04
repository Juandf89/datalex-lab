"""
Scraper batch de jurisprudencia de la Corte Constitucional (Relatoría).

Construye un índice temático (para búsqueda client-side) y un grafo de citas entre
sentencias (nodos = sentencias, aristas dirigidas = "A cita a B", in-degree = proxy
de relevancia — mismo principio que Shepard's/KeyCite). Corre en su propio cron
(semanal), separado del de SECOP II, mismo patrón de JSON estático + commit
condicional que scripts/generar_json.py.

Validado antes de escribir la primera versión (ver docs/plan-evolucion-plataforma.md):
- robots.txt de corteconstitucional.gov.co permite /relatoria/ explícitamente.
- El buscador (/relatoria/buscador_new/) filtra por rango de fechas sin necesitar
  término de búsqueda, devolviendo una tabla con columnas
  [Providencia, F.Sentencia, Tema/Resumen, F.Publicación].
- Cada sentencia vive en una URL fija /relatoria/{anio}/{TIPO}-{numero}-{aa}.htm,
  HTML plano con el texto completo, de donde se extraen las citas.

Corregido tras una auditoría de puntos ciegos (2026-08-03) — la primera versión
tenía tres bugs de correctitud que la hacían inútil para un servicio premium:
1. Cada corrida SOBRESCRIBÍA el índice/grafo completo con solo lo de esa corrida
   (no acumulaba) — el progreso de corridas anteriores se perdía cada semana.
   Ahora se fusiona con lo ya existente en OUTPUT_DIR.
2. El cursor arrancaba en 1992 y avanzaba hacia adelante — con ~50 sentencias
   procesadas por corrida semanal, la jurisprudencia reciente (lo que un usuario
   realmente busca) habría tardado años en aparecer en el índice. Ahora arranca
   en HOY y retrocede hacia 1992 — la cobertura útil empieza desde el día uno.
3. Si una ventana de fechas tenía más resultados que MAX_SENTENCIAS (frecuente:
   una ventana de 10 días puede traer ~100), el resto se perdía silenciosamente
   porque el cursor avanzaba igual. Ahora se guardan como "pendientes" en el
   cursor y se procesan primero en la siguiente corrida, antes de abrir una
   ventana nueva.

Buena práctica de scraping: User-Agent identificable, pausa entre requests,
alcance acotado por corrida (nunca se re-scrapea todo el corpus de una vez).
"""
import json
import os
import re
import time
from datetime import date, datetime, timedelta, timezone

import requests
from bs4 import BeautifulSoup

BASE = "https://www.corteconstitucional.gov.co"
BUSCADOR = f"{BASE}/relatoria/buscador_new/"
OUTPUT_DIR = os.getenv("OUTPUT_DIR", "./api/jurisprudencia")
CURSOR_FILE = os.path.join(OUTPUT_DIR, "cursor.json")
USER_AGENT = "DataLexLab-jurisprudencia-bot/0.1 (contacto: juanpablo.lopez.mejia@gmail.com)"
PAUSA_SEGUNDOS = float(os.getenv("PAUSA_SEGUNDOS", "1.5"))
MAX_SENTENCIAS = int(os.getenv("MAX_SENTENCIAS", "50"))  # cuántas visitar (citas) por corrida
MAX_RESULTADOS_POR_VENTANA = int(os.getenv("MAX_RESULTADOS_POR_VENTANA", "500"))  # cant_providencias pedido al buscador
DIAS_POR_LOTE = int(os.getenv("DIAS_POR_LOTE", "30"))
FECHA_LIMITE_HISTORICA = "1992-01-01"

PATRON_CITA = re.compile(
    r"\b(SU|[TC])[-\.\s]?(\d{1,4})\s*(?:/|\s+de\s+)\s*(\d{2,4})\b", re.IGNORECASE
)
PATRON_URL_SENTENCIA = re.compile(r"/relatoria/(\d{4})/(SU|[TC])-(\d+)-(\d+)\.htm", re.IGNORECASE)


def normalizar_id(tipo, numero, anio):
    tipo = tipo.upper()
    anio = int(anio)
    if anio < 100:  # "T-021/25" -> 2025, no 25
        anio += 2000 if anio < 50 else 1900
    return f"{tipo}-{int(numero)}-{anio}"


def leer_cursor():
    if os.path.exists(CURSOR_FILE):
        with open(CURSOR_FILE, encoding="utf-8") as f:
            return json.load(f)
    # Primera corrida: arranca en HOY y retrocede hacia 1992, no al revés —
    # así la jurisprudencia reciente queda indexada desde el primer día.
    return {"fecha_cursor": date.today().isoformat(), "pendientes": []}


def escribir_cursor(fecha_cursor, pendientes):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(CURSOR_FILE, "w", encoding="utf-8") as f:
        json.dump({"fecha_cursor": fecha_cursor, "pendientes": pendientes}, f, ensure_ascii=False)


def cargar_json_existente(nombre, por_defecto):
    ruta = os.path.join(OUTPUT_DIR, nombre)
    if os.path.exists(ruta):
        with open(ruta, encoding="utf-8") as f:
            return json.load(f)
    return por_defecto


def buscar_sentencias(session, fecha_inicio, fecha_fin, limite):
    """Busca por rango de fechas (sin término de búsqueda) y devuelve
    [{"id", "url", "fecha_sentencia", "tema"}, ...] leyendo la tabla de
    resultados directamente — sin visitar cada sentencia todavía."""
    params = {
        "searchOption": "prov_sentencia",
        "finicio": fecha_inicio,
        "ffin": fecha_fin,
        "buscar_por": "",
        "accion": "search",
        "ver_formulario": "si",
        "volver_a": "relatoria",
        "OrderbyOption": "asc__fecha",
        "cant_providencias": str(limite),
    }
    r = session.get(BUSCADOR, params=params, timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "lxml")

    resultados = []
    for tr in soup.select("table tr"):
        a = tr.find("a", href=PATRON_URL_SENTENCIA)
        if not a:
            continue
        m = PATRON_URL_SENTENCIA.search(a["href"])
        _anio_url, tipo, numero, anio_corto = m.groups()
        id_sentencia = normalizar_id(tipo, numero, anio_corto)
        tds = tr.find_all("td")
        tema = tds[2].get_text(" ", strip=True) if len(tds) > 2 else None
        fecha_sentencia = tds[1].get_text(strip=True) if len(tds) > 1 else None
        resultados.append({
            "id": id_sentencia,
            "url": a["href"],
            "fecha_sentencia": fecha_sentencia,
            "tema": tema,
        })
    return resultados


def extraer_citas(session, url, id_propio):
    r = session.get(url, timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "lxml")
    texto = soup.get_text(" ", strip=True)

    citas = set()
    for tipo, numero, anio in PATRON_CITA.findall(texto):
        candidato = normalizar_id(tipo, numero, anio)
        if candidato != id_propio:
            citas.add(candidato)
    return sorted(citas)


def main():
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    cursor = leer_cursor()
    pendientes = cursor.get("pendientes", [])
    fecha_cursor = cursor["fecha_cursor"]

    if pendientes:
        print(f"[info] Retomando {len(pendientes)} sentencias pendientes de la ventana anterior "
              f"(cursor en {fecha_cursor})")
        lote = pendientes[:MAX_SENTENCIAS]
        resto = pendientes[MAX_SENTENCIAS:]
        nueva_fecha_cursor = fecha_cursor  # la ventana actual no ha terminado, no se avanza
    else:
        fecha_fin = fecha_cursor
        fecha_inicio = max(
            (date.fromisoformat(fecha_fin) - timedelta(days=DIAS_POR_LOTE)),
            date.fromisoformat(FECHA_LIMITE_HISTORICA),
        ).isoformat()

        if fecha_inicio == fecha_fin:
            # Se llegó al límite histórico: reinicia desde hoy para capturar
            # sentencias nuevas que hayan aparecido desde que arrancamos.
            print("[info] Corpus histórico alcanzado (1992) — reiniciando desde hoy.")
            fecha_fin = date.today().isoformat()
            fecha_inicio = max(
                (date.fromisoformat(fecha_fin) - timedelta(days=DIAS_POR_LOTE)),
                date.fromisoformat(FECHA_LIMITE_HISTORICA),
            ).isoformat()

        print(f"[info] Nueva ventana {fecha_inicio} -> {fecha_fin}")
        encontrados = buscar_sentencias(session, fecha_inicio, fecha_fin, MAX_RESULTADOS_POR_VENTANA)
        print(f"[info] {len(encontrados)} sentencias encontradas en la ventana")
        lote = encontrados[:MAX_SENTENCIAS]
        resto = encontrados[MAX_SENTENCIAS:]
        nueva_fecha_cursor = fecha_inicio

    sentencias_con_citas = []
    for i, s in enumerate(lote):
        time.sleep(PAUSA_SEGUNDOS)
        try:
            citas = extraer_citas(session, s["url"], s["id"])
            sentencias_con_citas.append({**s, "citas": citas})
            print(f"[ok] ({i + 1}/{len(lote)}) {s['id']} — {len(citas)} citas")
        except Exception as e:
            print(f"[warn] fallo en {s['url']}: {e} — se reintenta en la próxima corrida")
            resto.append(s)

    # Fusionar con el índice y grafo ya existentes — nunca sobrescribir el
    # trabajo de corridas anteriores.
    indice_por_id = {s["id"]: s for s in cargar_json_existente("indice_temas.json", [])}
    for s in sentencias_con_citas:
        indice_por_id[s["id"]] = {
            "id": s["id"], "url": s["url"], "fecha_sentencia": s["fecha_sentencia"], "tema": s["tema"],
        }

    grafo_existente = cargar_json_existente("grafo_citas.json", {"nodos": [], "aristas": []})
    nodos_por_id = {n["id"]: n for n in grafo_existente.get("nodos", [])}
    aristas = grafo_existente.get("aristas", [])
    aristas_vistas = {(a["origen"], a["destino"]) for a in aristas}

    for s in sentencias_con_citas:
        nodo = nodos_por_id.setdefault(s["id"], {"id": s["id"], "url": s["url"], "tema": s["tema"], "in_degree": 0})
        nodo["url"] = nodo["url"] or s["url"]
        nodo["tema"] = nodo["tema"] or s["tema"]
        for destino in s["citas"]:
            if (s["id"], destino) in aristas_vistas:
                continue
            aristas_vistas.add((s["id"], destino))
            aristas.append({"origen": s["id"], "destino": destino})
            nodo_destino = nodos_por_id.setdefault(destino, {"id": destino, "url": None, "tema": None, "in_degree": 0})
            nodo_destino["in_degree"] += 1

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(os.path.join(OUTPUT_DIR, "grafo_citas.json"), "w", encoding="utf-8") as f:
        json.dump({
            "generado_en": datetime.now(timezone.utc).isoformat(),
            "nodos": list(nodos_por_id.values()),
            "aristas": aristas,
        }, f, ensure_ascii=False, indent=2)

    with open(os.path.join(OUTPUT_DIR, "indice_temas.json"), "w", encoding="utf-8") as f:
        json.dump(list(indice_por_id.values()), f, ensure_ascii=False, indent=2)

    escribir_cursor(nueva_fecha_cursor, resto)
    print(f"\nResumen: {len(sentencias_con_citas)} procesadas en esta corrida · "
          f"{len(indice_por_id)} en el índice acumulado · {len(nodos_por_id)} nodos totales · "
          f"{len(aristas)} aristas totales · {len(resto)} pendientes para la próxima corrida.")


if __name__ == "__main__":
    main()
