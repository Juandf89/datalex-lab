"""
Prueba de concepto: scraping de CENDOJ (jurisprudencia.ramajudicial.gov.co) sin headless browser.

Confirma que el mecanismo de ViewState/postback de JSF+PrimeFaces es replicable con
`requests` puro, extrayendo el token de la página inicial y simulando el POST de AJAX
que dispara el boton "Buscar". Validado contra el formulario de Corte Constitucional
(/WebRelatoria/cc/index.xhtml); el mismo patron aplica al formulario unificado de
jurisprudencia.ramajudicial.gov.co (con checkboxes por corte) y presumiblemente a
Corte Suprema / Consejo de Estado si comparten el mismo stack JSF.

Buena práctica de scraping: User-Agent identificable, pausa entre requests, y no
paralelizar contra el servidor de la Rama Judicial.
"""
import re
import time

import requests
from bs4 import BeautifulSoup

BASE_URL = "https://jurisprudencia.ramajudicial.gov.co/WebRelatoria/cc/index.xhtml"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) DataLexLab-poc-research/0.1 "
    "(contacto: juanpablo.lopez.mejia@gmail.com)"
)


def obtener_viewstate(session):
    r = session.get(BASE_URL, timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "lxml")
    return soup.find("input", {"name": "javax.faces.ViewState"})["value"]


def buscar(session, texto, viewstate):
    payload = {
        "javax.faces.partial.ajax": "true",
        "javax.faces.source": "searchForm:j_idt35",
        "javax.faces.partial.execute": "searchForm",
        "javax.faces.partial.render": "resultForm:jurisTable resultForm:pagText resultForm:pagText2",
        "searchForm:j_idt35": "searchForm:j_idt35",
        "searchForm": "searchForm",
        "searchForm:temaInput": texto,
        "javax.faces.ViewState": viewstate,
    }
    headers = {
        "Faces-Request": "partial/ajax",
        "X-Requested-With": "XMLHttpRequest",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Referer": BASE_URL,
    }
    r = session.post(BASE_URL, data=payload, headers=headers, timeout=30)
    r.raise_for_status()
    return r.text


def extraer_resultados(xml_respuesta):
    resultados = []
    for bloque in re.findall(r'id="resultForm:jurisTable:\d+:descrip">(.*?)</span>', xml_respuesta, re.DOTALL):
        texto = BeautifulSoup(bloque, "lxml").get_text(" ", strip=True)
        resultados.append(texto)
    return resultados


if __name__ == "__main__":
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    viewstate = obtener_viewstate(session)
    time.sleep(1)  # pausa entre requests, buen ciudadano

    xml_respuesta = buscar(session, "estabilidad laboral reforzada", viewstate)
    for resultado in extraer_resultados(xml_respuesta):
        print(resultado[:300])
        print("---")
