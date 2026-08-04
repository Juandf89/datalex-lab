// Reemplazo de netlify/functions/fallback-secop.mjs y fallback-jurisprudencia.mjs
// para el Node.js Web App de Hostinger. La lógica de negocio (filtros de Socrata,
// parseo de la Relatoría, normalización de IDs) es la misma ya verificada en
// producción — lo único que cambia es el transporte de estado: @netlify/blobs
// (KV externo, necesario porque las Functions no tienen disco persistente) pasa
// a ser JSON en disco local (./store.mjs), porque este sí es un proceso
// persistente con su propio filesystem.
import express from "express";
import * as cheerio from "cheerio";
import { actualizar, leer } from "./store.mjs";

const PUERTO = process.env.PORT || 3000;
const ORIGEN_PERMITIDO = process.env.ALLOWED_ORIGIN || "https://datalexlab.com";
const TOKEN_INTERNO = process.env.ABSORBER_TOKEN;
const LIMITE_DIARIO_SECOP = Number(process.env.LIMITE_DIARIO_SECOP || 5);
const LIMITE_DIARIO_JURISPRUDENCIA = Number(process.env.LIMITE_DIARIO_JURISPRUDENCIA || 5);
const USER_AGENT = "DataLexLab-fallback-bot/0.1 (contacto: juanpablo.lopez.mejia@gmail.com)";

const RUTA_RATE_LIMITS = new URL("./data/rate-limits.json", import.meta.url);
const RUTA_PENDIENTES_SECOP = new URL("./data/pendientes-secop.json", import.meta.url);
const RUTA_PENDIENTES_JURISPRUDENCIA = new URL("./data/pendientes-jurisprudencia.json", import.meta.url);

function obtenerIP(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return xff.split(",")[0].trim();
  return req.socket.remoteAddress || "desconocida";
}

const app = express();
app.disable("x-powered-by");

// --- CORS: solo el dominio del sitio, nada de "*" (el endpoint hace fetch en
// nombre del visitante y escribe en el store, no queremos que cualquier otro
// sitio pueda dispararlo desde el navegador de un visitante). ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ORIGEN_PERMITIDO);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Token");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- Rate limit de ráfaga (equivalente al `config.rateLimit` nativo que tenían
// las Netlify Functions: 10 req/60s por IP). Ventana deslizante en memoria —
// suficiente con un solo proceso/1 vCPU, no necesita persistir a disco. ---
const VENTANA_MS = 60_000;
const LIMITE_VENTANA = 10;
const historialPorIP = new Map();

function limiteDeRafagaSuperado(ip) {
  const ahora = Date.now();
  const historial = (historialPorIP.get(ip) || []).filter((t) => ahora - t < VENTANA_MS);
  historial.push(ahora);
  historialPorIP.set(ip, historial);
  return historial.length > LIMITE_VENTANA;
}

async function verificarLimiteDiario(servicio, ip, limiteDiario) {
  const hoy = new Date().toISOString().slice(0, 10);
  const clave = `${ip}:${hoy}:${servicio}`;
  const datos = await leer(RUTA_RATE_LIMITS, {});
  const usoActual = Number(datos[clave] || 0);
  return { clave, usoActual, alcanzado: usoActual >= limiteDiario };
}

async function incrementarLimiteDiario(clave) {
  const nuevos = await actualizar(RUTA_RATE_LIMITS, {}, (datos) => ({
    ...datos,
    [clave]: Number(datos[clave] || 0) + 1,
  }));
  return nuevos[clave];
}

// ============================== SECOP ==============================
// Mismo filtro que scripts/generar_json.py: "Prestación de servicios" es el
// 88.7% de los contratos por conteo pero solo el 40.7% del valor (verificado
// con una muestra real de 20,000 registros) — se excluye para que la búsqueda
// en vivo sea consistente con lo que ya excluye el batch.
const DOMINIO_SECOP = "https://www.datos.gov.co";
const DATASET_ID_SECOP = "jbjy-vk9h";

app.get("/fallback-secop", async (req, res) => {
  const ip = obtenerIP(req);
  const termino = (req.query.q || "").toString().trim();

  if (limiteDeRafagaSuperado(ip)) {
    return res.status(429).json({ error: "Demasiadas solicitudes, intenta en un minuto." });
  }
  if (!termino || termino.length < 3) {
    return res.status(400).json({ error: "Falta el parámetro de búsqueda (q, mínimo 3 caracteres)." });
  }

  const { clave, usoActual, alcanzado } = await verificarLimiteDiario("secop", ip, LIMITE_DIARIO_SECOP);
  if (alcanzado) {
    return res.status(429).json({
      error: "Alcanzaste el límite de búsquedas en vivo gratis por hoy.",
      limite_diario: LIMITE_DIARIO_SECOP,
      busquedas_restantes_hoy: 0,
    });
  }

  const params = new URLSearchParams({
    $q: termino,
    $where: "tipo_de_contrato != 'Prestación de servicios'",
    $limit: "10",
  });

  let resultados = [];
  let registrosCrudos = [];
  try {
    const headers = { "User-Agent": USER_AGENT };
    if (process.env.SOCRATA_APP_TOKEN) headers["X-App-Token"] = process.env.SOCRATA_APP_TOKEN;

    const resp = await fetch(`${DOMINIO_SECOP}/resource/${DATASET_ID_SECOP}.json?${params.toString()}`, { headers });
    if (!resp.ok) throw new Error(`Socrata respondió ${resp.status}`);
    registrosCrudos = await resp.json();

    resultados = registrosCrudos.map((r) => ({
      id_contrato: r.id_contrato,
      nombre_entidad: r.nombre_entidad,
      sector: r.sector,
      valor_del_contrato: Number(r.valor_del_contrato) || null,
      fecha_de_firma: r.fecha_de_firma,
      objeto: r.descripcion_del_proceso || null,
    }));
  } catch (e) {
    return res.status(502).json({ error: "No se pudo consultar Datos Abiertos Colombia en este momento. Intenta de nuevo más tarde." });
  }

  await incrementarLimiteDiario(clave);

  // Cada contrato encontrado en vivo se guarda para que el workflow de GitHub
  // Actions lo absorba (scripts/absorber_pendientes_secop.mjs) y
  // scripts/generar_json.py lo fusione al histórico acumulado. Se guarda el
  // registro CRUDO completo, no el `resultados` curado (limpiar()/
  // calcular_desviacion_temporal() en Python necesitan fecha_de_inicio,
  // fecha_de_fin, dias_adicionados, proveedor_adjudicado — solo están en el
  // crudo). Sin id_contrato no hay clave válida, se descartan esos registros.
  await actualizar(RUTA_PENDIENTES_SECOP, {}, (datos) => {
    const nuevos = { ...datos };
    for (const r of registrosCrudos) {
      if (r.id_contrato) nuevos[r.id_contrato] = r;
    }
    return nuevos;
  });

  res.json({ resultados, busquedas_restantes_hoy: LIMITE_DIARIO_SECOP - (usoActual + 1) });
});

// ========================= JURISPRUDENCIA =========================
// OJO: searchOption=texto (texto completo) vía POST, no searchOption=prov_sentencia
// (eso es búsqueda por NÚMERO de sentencia) — confirmado observando el request
// real del formulario del sitio. Ver docs/plan-evolucion-plataforma.md, Fase 2.
const BUSCADOR_JURISPRUDENCIA = "https://www.corteconstitucional.gov.co/relatoria/buscador_new//index.php";
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

app.get("/fallback-jurisprudencia", async (req, res) => {
  const ip = obtenerIP(req);
  const termino = (req.query.q || "").toString().trim();

  if (limiteDeRafagaSuperado(ip)) {
    return res.status(429).json({ error: "Demasiadas solicitudes, intenta en un minuto." });
  }
  if (!termino || termino.length < 3) {
    return res.status(400).json({ error: "Falta el parámetro de búsqueda (q, mínimo 3 caracteres)." });
  }

  const { clave, usoActual, alcanzado } = await verificarLimiteDiario("jurisprudencia", ip, LIMITE_DIARIO_JURISPRUDENCIA);
  if (alcanzado) {
    return res.status(429).json({
      error: "Alcanzaste el límite de búsquedas en vivo gratis por hoy.",
      limite_diario: LIMITE_DIARIO_JURISPRUDENCIA,
      busquedas_restantes_hoy: 0,
    });
  }

  const cuerpo = new URLSearchParams({
    searchOption: "texto",
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
    const resp = await fetch(BUSCADOR_JURISPRUDENCIA, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
      body: cuerpo.toString(),
    });
    const html = await resp.text();
    resultados = extraerResultados(html);
  } catch (e) {
    return res.status(502).json({ error: "No se pudo consultar la Corte Constitucional en este momento. Intenta de nuevo más tarde." });
  }

  await incrementarLimiteDiario(clave);

  await actualizar(RUTA_PENDIENTES_JURISPRUDENCIA, {}, (datos) => {
    const nuevos = { ...datos };
    for (const r of resultados) nuevos[r.id] = r;
    return nuevos;
  });

  res.json({ resultados, busquedas_restantes_hoy: LIMITE_DIARIO_JURISPRUDENCIA - (usoActual + 1) });
});

// ============================ INTERNAS ============================
// Reemplaza el modo "manual" del SDK de @netlify/blobs que usaba
// scripts/absorber_pendientes_secop.mjs (siteID+token) para leer el store desde
// GitHub Actions. Mismo diseño en dos fases que antes, para no perder datos si
// generar_json.py falla a mitad de camino:
//   1. GET  /internal/pendientes-<servicio>            → devuelve TODO lo pendiente
//      (no borra nada).
//   2. POST /internal/pendientes-<servicio>/confirmar   → borra solo las claves
//      confirmadas (no todo lo que haya en ese momento — si llegó algo nuevo
//      entre el paso 1 y el 2, no se pierde).
function exigirTokenInterno(req, res, next) {
  if (!TOKEN_INTERNO) {
    return res.status(503).json({ error: "ABSORBER_TOKEN no configurado en el servidor." });
  }
  if (req.headers["x-internal-token"] !== TOKEN_INTERNO) {
    return res.status(401).json({ error: "Token inválido." });
  }
  next();
}

function registrarRutasInternas(servicio, ruta) {
  app.get(`/internal/pendientes-${servicio}`, exigirTokenInterno, async (req, res) => {
    const datos = await leer(ruta, {});
    res.json({ registros: Object.values(datos), claves: Object.keys(datos) });
  });

  app.post(`/internal/pendientes-${servicio}/confirmar`, express.json(), exigirTokenInterno, async (req, res) => {
    const claves = Array.isArray(req.body?.claves) ? req.body.claves : [];
    await actualizar(ruta, {}, (datos) => {
      const nuevos = { ...datos };
      for (const clave of claves) delete nuevos[clave];
      return nuevos;
    });
    res.json({ borradas: claves.length });
  });
}

registrarRutasInternas("secop", RUTA_PENDIENTES_SECOP);
registrarRutasInternas("jurisprudencia", RUTA_PENDIENTES_JURISPRUDENCIA);

app.listen(PUERTO, () => {
  console.log(`[ok] servidor de fallbacks escuchando en el puerto ${PUERTO}`);
  // Diagnóstico temporal: el 503 de LiteSpeed sugiere que espera un puerto
  // distinto a nuestro default. Solo se listan NOMBRES de variables (nunca
  // valores) para no filtrar secretos en los logs — sirve para ver si
  // Hostinger inyecta algo tipo PORT/APP_PORT que no estamos leyendo.
  console.log("[debug] variables de entorno disponibles:", Object.keys(process.env).sort().join(", "));
});
