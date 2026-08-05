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
import { obtenerPool } from "./db.mjs";

// El Node.js Web App de Hostinger corre detrás del módulo propio de LiteSpeed
// ("lsnode"): ignora cualquier puerto TCP que la app pida y en vez de eso la
// conecta por un socket Unix cuya ruta llega en LSNODE_SOCKET — confirmado
// via runtime logs (la app escuchaba bien en :3000 pero LiteSpeed devolvía
// 503 igual, porque nunca la buscó ahí). http.Server.listen() de Node acepta
// un string de ruta como "puerto" y automáticamente escucha por socket Unix.
const PUERTO = process.env.LSNODE_SOCKET || process.env.PORT || 3000;
const ORIGEN_PERMITIDO = process.env.ALLOWED_ORIGIN || "https://datalexlab.com";
const TOKEN_INTERNO = process.env.ABSORBER_TOKEN;
const LIMITE_DIARIO_SECOP = Number(process.env.LIMITE_DIARIO_SECOP || 5);
// Antes cada "búsqueda" era una sola acción (una consulta = un resultado).
// Ahora, sin índice acumulado, explorar el grafo (clic en una cita para ver
// sus propias citas) también consulta la Relatoría en vivo — una sesión
// normal de exploración fácilmente hace varias consultas encadenadas, así
// que el límite por defecto sube para no frustrar el uso normal del feature.
const LIMITE_DIARIO_JURISPRUDENCIA = Number(process.env.LIMITE_DIARIO_JURISPRUDENCIA || 20);
const USER_AGENT = "DataLexLab-fallback-bot/0.1 (contacto: juanpablo.lopez.mejia@gmail.com)";

const RUTA_RATE_LIMITS = new URL("./data/rate-limits.json", import.meta.url);
const RUTA_PENDIENTES_SECOP = new URL("./data/pendientes-secop.json", import.meta.url);

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
// con una muestra real de 20,000 registros), y "Decreto 092 de 2017" es la
// MISMA categoría bajo otra etiqueta (régimen especial para prestación de
// servicios profesionales/apoyo a la gestión) — ambas se excluyen para que la
// búsqueda en vivo sea consistente con lo que ya excluye el batch.
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
    $where: "tipo_de_contrato NOT IN ('Prestación de servicios', 'Decreto 092 de 2017')",
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

// Reemplaza la carga completa de expediente_contratos.json (76MB) en el
// navegador — antes se descargaba el detalle de ~145,000 contratos para
// buscar con Fuse.js en el cliente, ahora se consulta la tabla MySQL en vivo,
// igual que ya hace secop-clm.html para el buscador por entidad
// (por_entidad.json, que sí se queda estático por ser pequeño). Sin límite
// diario propio (no consume cupo de una API externa, solo nuestra propia
// base de datos) — el rate limit de ráfaga ya existente basta para evitar abuso.
app.get("/secop/buscar", async (req, res) => {
  const ip = obtenerIP(req);
  const termino = (req.query.q || "").toString().trim();

  if (limiteDeRafagaSuperado(ip)) {
    return res.status(429).json({ error: "Demasiadas solicitudes, intenta en un minuto." });
  }
  if (!termino || termino.length < 3) {
    return res.status(400).json({ error: "Falta el parámetro de búsqueda (q, mínimo 3 caracteres)." });
  }

  const comodin = `%${termino}%`;
  try {
    const pool = obtenerPool();
    const [filas] = await pool.query(
      `SELECT id_contrato, nombre_entidad, sector, anio_contrato AS anio, valor_del_contrato,
              duracion_contrato_dias, fecha_de_firma, fecha_de_inicio_del_contrato,
              fecha_de_fin_del_contrato, dias_adicionados, proveedor_adjudicado AS proveedor,
              puntaje_anomalia, bandera_roja
       FROM contratos
       WHERE id_contrato LIKE ? OR nombre_entidad LIKE ? OR proveedor_adjudicado LIKE ?
       LIMIT 20`,
      [comodin, comodin, comodin]
    );
    // mysql2 devuelve TINYINT(1) como Number (0/1), no boolean — el frontend
    // (tarjetaExpediente en secop-clm.html) compara bandera_roja con
    // === true/false estricto, igual que ya hacía con expediente_contratos.json.
    const resultados = filas.map((f) => ({
      ...f,
      bandera_roja: f.bandera_roja === null ? null : Boolean(f.bandera_roja),
    }));
    res.json({ resultados });
  } catch (e) {
    console.error("[secop/buscar] error de conexión/consulta MySQL:", e.message);
    res.status(502).json({ error: "No se pudo consultar la base de datos en este momento. Intenta de nuevo más tarde." });
  }
});

// "¿Tiene contratos atípicos?" en la tarjeta de una entidad (secop-clm.html)
// necesita el conteo real sobre TODOS sus contratos, no la muestra acotada de
// benchmark_contratos.json (esa muestra es solo para la forma del scatter, no
// para conteos exactos por entidad) — se agrega en la base, no se escanea en
// el navegador.
app.get("/secop/riesgo-entidad", async (req, res) => {
  const ip = obtenerIP(req);
  const entidad = (req.query.entidad || "").toString().trim();

  if (limiteDeRafagaSuperado(ip)) {
    return res.status(429).json({ error: "Demasiadas solicitudes, intenta en un minuto." });
  }
  if (!entidad) {
    return res.status(400).json({ error: "Falta el parámetro entidad." });
  }

  try {
    const pool = obtenerPool();
    const [[fila]] = await pool.query(
      `SELECT COUNT(puntaje_anomalia) AS evaluados,
              SUM(CASE WHEN puntaje_anomalia < 0 THEN 1 ELSE 0 END) AS atipicos,
              SUM(CASE WHEN bandera_roja = 1 THEN 1 ELSE 0 END) AS alertas
       FROM contratos WHERE nombre_entidad = ?`,
      [entidad]
    );
    res.json({
      evaluados: Number(fila.evaluados) || 0,
      atipicos: Number(fila.atipicos) || 0,
      alertas: Number(fila.alertas) || 0,
    });
  } catch (e) {
    console.error("[secop/riesgo-entidad] error de conexión/consulta MySQL:", e.message);
    res.status(502).json({ error: "No se pudo consultar la base de datos en este momento." });
  }
});

// ========================= JURISPRUDENCIA =========================
// OJO: searchOption=texto (texto completo) vía POST, no searchOption=prov_sentencia
// (eso es búsqueda por NÚMERO de sentencia) — confirmado observando el request
// real del formulario del sitio.
const DOMINIO_JURISPRUDENCIA = "https://www.corteconstitucional.gov.co";
const BUSCADOR_JURISPRUDENCIA = `${DOMINIO_JURISPRUDENCIA}/relatoria/buscador_new//index.php`;
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

  res.json({ resultados, busquedas_restantes_hoy: LIMITE_DIARIO_JURISPRUDENCIA - (usoActual + 1) });
});

// --- Grafo en vivo (sin acumular nada en disco) ---
// Decisión de producto: este servicio se consume directo de la Relatoría en
// cada búsqueda (por palabra o por número), no manteniendo un índice/grafo
// acumulado en el servidor. Por eso solo se calcula el vecindario directo de
// UNA sentencia por consulta (ella + lo que cita), no citas-de-citas — eso
// requeriría escanear el corpus, que es justo lo que se está evitando.

// Mismo bug ya encontrado y corregido en scripts/generar_grafo_jurisprudencia.py:
// separadores de miles en años viejos (ej. "T-432 de 1.992") rompen el regex
// de citas — el "." corta la racha de dígitos y solo captura "992". La Corte
// existe desde 1991, así que un año fuera de [1991, año actual + 1] es casi
// con certeza un falso positivo, no una sentencia real.
const PATRON_CITA = /\b(SU|[TC])[-.\s]?(\d{1,4})\s*(?:\/|\s+de\s+)\s*(\d{2,4})\b/gi;

function normalizarIdValidado(tipo, numero, anioCorto) {
  let anio = parseInt(anioCorto, 10);
  if (anio < 100) anio += anio < 50 ? 2000 : 1900;
  if (anio < 1991 || anio > new Date().getFullYear() + 1) return null;
  return `${tipo.toUpperCase()}-${parseInt(numero, 10)}-${anio}`;
}

function extraerCitas(html, idPropio) {
  const texto = cheerio.load(html).text();
  const patron = new RegExp(PATRON_CITA); // instancia propia (lastIndex propio) por llamada
  const citas = new Set();
  let m;
  while ((m = patron.exec(texto))) {
    const candidato = normalizarIdValidado(m[1], m[2], m[3]);
    if (candidato && candidato !== idPropio) citas.add(candidato);
  }
  return [...citas].sort();
}

// Construye la URL directa de una sentencia sin pasar por el buscador —
// verificado en vivo: los números de sentencia se escriben con al menos 3
// dígitos en la URL (ej. "T-021-19", no "T-21-19"; convención de citación
// colombiana estándar), y el año en la URL va en 2 dígitos.
function urlSentencia(id) {
  const m = id.match(/^(SU|T|C)-(\d+)-(\d{4})$/);
  if (!m) return null;
  const [, tipo, numeroStr, anioStr] = m;
  const anio = parseInt(anioStr, 10);
  const anioCorto = String(anio % 100).padStart(2, "0");
  const numeroPadded = String(parseInt(numeroStr, 10)).padStart(3, "0");
  return `${DOMINIO_JURISPRUDENCIA}/relatoria/${anio}/${tipo}-${numeroPadded}-${anioCorto}.htm`;
}

// Verificado en vivo: una URL de sentencia inexistente NO da 404 — el sitio
// devuelve con 200 el shell genérico de la SPA. Las páginas reales de
// sentencia son documentos exportados de Word con esta meta etiqueta.
async function obtenerSentencia(url) {
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok) return null;
  const html = await resp.text();
  if (!html.includes("Microsoft Word")) return null;
  return html;
}

// Búsqueda por número (ej. "T-388-2019") y "explorar una cita" (un nodo del
// grafo sin URL conocida) llegan ambas aquí sin "url" — un solo endpoint para
// las dos, en vez de un endpoint separado solo para validar/resolver, porque
// obtenerSentencia() ya trae la página completa de todos modos (verificarla
// no cuesta menos que además extraerle las citas).
//
// El "id" alcanza (sin "url") tanto para una búsqueda directa por número como
// para explorar una sentencia que salió como cita dentro de un grafo anterior
// — en ambos casos el endpoint resuelve la URL con urlSentencia() antes de
// pedir las citas. Así cuesta 1 sola búsqueda del límite diario en vez de 2
// (resolver URL + pedir grafo por separado) — el visitante no nota ni le
// importa que internamente sean dos peticiones a la Relatoría.
app.get("/jurisprudencia/grafo", async (req, res) => {
  const ip = obtenerIP(req);
  const id = (req.query.id || "").toString().trim();
  let url = (req.query.url || "").toString().trim() || null;

  if (limiteDeRafagaSuperado(ip)) {
    return res.status(429).json({ error: "Demasiadas solicitudes, intenta en un minuto." });
  }
  // Guarda contra SSRF: solo se permite pedirle al servidor que consulte URLs
  // del propio dominio de la Corte Constitucional, nunca una URL arbitraria
  // que el visitante mande.
  if (url && !url.startsWith(`${DOMINIO_JURISPRUDENCIA}/relatoria/`)) {
    return res.status(400).json({ error: "La URL no es de la Corte Constitucional." });
  }
  if (!url) {
    url = urlSentencia(id);
  }
  if (!id || !url) {
    return res.status(400).json({ error: "Falta el parámetro id, o no tiene el formato de una sentencia (ej. T-388-2019)." });
  }

  const { clave, usoActual, alcanzado } = await verificarLimiteDiario("jurisprudencia", ip, LIMITE_DIARIO_JURISPRUDENCIA);
  if (alcanzado) {
    return res.status(429).json({
      error: "Alcanzaste el límite de búsquedas en vivo gratis por hoy.",
      limite_diario: LIMITE_DIARIO_JURISPRUDENCIA,
      busquedas_restantes_hoy: 0,
    });
  }

  let html;
  try {
    html = await obtenerSentencia(url);
  } catch (e) {
    return res.status(502).json({ error: "No se pudo consultar la Corte Constitucional en este momento. Intenta de nuevo más tarde." });
  }

  await incrementarLimiteDiario(clave);
  const restantes = LIMITE_DIARIO_JURISPRUDENCIA - (usoActual + 1);

  if (!html) {
    return res.status(404).json({ error: `No se pudo cargar el texto de ${id}.`, busquedas_restantes_hoy: restantes });
  }

  const citas = extraerCitas(html, id);
  res.json({
    nodos: [{ id, url }, ...citas.map((c) => ({ id: c, url: null }))],
    aristas: citas.map((destino) => ({ origen: id, destino })),
    busquedas_restantes_hoy: restantes,
  });
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

app.listen(PUERTO, () => {
  console.log(`[ok] servidor de fallbacks escuchando en ${PUERTO}`);
});
