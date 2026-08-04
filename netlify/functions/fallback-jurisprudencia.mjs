// Fallback en vivo para búsquedas de jurisprudencia que no encuentran nada en el
// índice pre-construido (api/jurisprudencia/indice_temas.json). Hace UNA sola
// consulta (no recursiva, no sigue citas) al buscador real de la Corte
// Constitucional, cachea el resultado para que el próximo cron batch lo absorba
// (scripts/generar_grafo_jurisprudencia.py) y así la misma búsqueda no dispare
// dos veces un scrape en vivo.
//
// Netlify Functions solo soporta JS/TS/Go (no Python) — por eso este archivo
// existe separado del scraper batch en Python.
import { getStore } from "@netlify/blobs";
import * as cheerio from "cheerio";

// OJO: esta URL con "buscar_por=<termino>&searchOption=prov_sentencia" vía GET
// NO devuelve resultados por tema — ese modo es para buscar por NÚMERO de
// sentencia (ej. "T-388 DE 2019"), y su respuesta es solo el shell de la SPA
// (jQuery + DataTables) sin resultados en el HTML. Verificado en vivo: la
// búsqueda temática real usa searchOption=texto (texto completo) vía POST a
// /index.php con FormData — confirmado observando el request real del propio
// formulario del sitio.
const BUSCADOR = "https://www.corteconstitucional.gov.co/relatoria/buscador_new//index.php";
const USER_AGENT = "DataLexLab-fallback-bot/0.1 (contacto: juanpablo.lopez.mejia@gmail.com)";
const LIMITE_DIARIO = Number(process.env.LIMITE_DIARIO_JURISPRUDENCIA || 5);
const PATRON_URL_SENTENCIA = /\/relatoria\/(\d{4})\/(SU|[TC])-(\d+)-(\d+)\.htm/i;

function normalizarId(tipo, numero, anioCorto) {
  let anio = parseInt(anioCorto, 10);
  if (anio < 100) anio += anio < 50 ? 2000 : 1900;
  return `${tipo.toUpperCase()}-${parseInt(numero, 10)}-${anio}`;
}

export function extraerResultados(html) {
  const $ = cheerio.load(html);
  const resultados = [];

  $("table tr").each((_, tr) => {
    const enlace = $(tr).find(`a[href*="/relatoria/"]`).filter((_, a) => PATRON_URL_SENTENCIA.test($(a).attr("href") || "")).first();
    if (!enlace.length) return;

    const href = enlace.attr("href");
    const m = href.match(PATRON_URL_SENTENCIA);
    if (!m) return;
    const [, , tipo, numero, anioCorto] = m;
    const id = normalizarId(tipo, numero, anioCorto);

    const celdas = $(tr).find("td");
    const fechaSentencia = celdas.length > 1 ? $(celdas[1]).text().trim() : null;
    const tema = celdas.length > 2 ? $(celdas[2]).text().trim() : null;

    resultados.push({ id, url: href, fecha_sentencia: fechaSentencia, tema });
  });

  return resultados;
}

export default async (req, context) => {
  const ip = context.ip || "desconocida";
  const termino = new URL(req.url).searchParams.get("q")?.trim();

  if (!termino || termino.length < 3) {
    return Response.json(
      { error: "Falta el parámetro de búsqueda (q, mínimo 3 caracteres)." },
      { status: 400 },
    );
  }

  const contador = getStore("rate-limit-jurisprudencia");
  const hoy = new Date().toISOString().slice(0, 10);
  const claveContador = `${ip}:${hoy}`;
  const usoActual = Number((await contador.get(claveContador)) || 0);

  if (usoActual >= LIMITE_DIARIO) {
    return Response.json(
      {
        error: "Alcanzaste el límite de búsquedas en vivo gratis por hoy.",
        limite_diario: LIMITE_DIARIO,
        busquedas_restantes_hoy: 0,
      },
      { status: 429 },
    );
  }

  const cuerpo = new URLSearchParams({
    searchOption: "texto", // texto completo — no "prov_sentencia" (eso es búsqueda por número, no por tema)
    fini: "1992-01-01",
    ffin: new Date().toISOString().slice(0, 10),
    buscar_por: termino,
    accion: "search",
    verform: "si",
    slop: "1",
    buscador: "buscador",
    qu: "search_principalMatch",
    maxprov: "10",
    OrderbyOption: "des__score",
  });

  let resultados = [];
  try {
    const resp = await fetch(BUSCADOR, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: cuerpo.toString(),
    });
    const html = await resp.text();
    resultados = extraerResultados(html);
  } catch (e) {
    return Response.json(
      { error: "No se pudo consultar la Corte Constitucional en este momento. Intenta de nuevo más tarde." },
      { status: 502 },
    );
  }

  await contador.set(claveContador, String(usoActual + 1));

  // Cachear para que el próximo cron batch lo absorba (evita repetir el scrape en vivo).
  const pendientes = getStore("pendientes-jurisprudencia");
  await Promise.all(resultados.map((r) => pendientes.setJSON(r.id, r)));

  return Response.json({
    resultados,
    busquedas_restantes_hoy: LIMITE_DIARIO - (usoActual + 1),
  });
};

export const config = {
  path: "/api/fallback-jurisprudencia",
  rateLimit: {
    windowLimit: 10,
    windowSize: 60,
    aggregateBy: ["ip", "domain"],
    action: "block",
  },
};
