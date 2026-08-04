// Fallback en vivo para búsquedas de SECOP que no encuentran nada en la muestra
// local (api/secop/por_entidad.json, expediente_contratos.json — que solo cubre
// los ~5000 contratos más recientes ingeridos por scripts/generar_json.py, no el
// dataset completo). Usa la búsqueda de texto completo de Socrata ($q), que
// consulta TODO el dataset en vivo, no solo nuestra muestra.
//
// Más simple que fallback-jurisprudencia.mjs: Socrata devuelve JSON directo,
// no hay que parsear HTML.
import { getStore } from "@netlify/blobs";

const DOMINIO = "https://www.datos.gov.co";
const DATASET_ID = "jbjy-vk9h";
const USER_AGENT = "DataLexLab-fallback-bot/0.1 (contacto: juanpablo.lopez.mejia@gmail.com)";
const LIMITE_DIARIO = Number(process.env.LIMITE_DIARIO_SECOP || 5);

export default async (req, context) => {
  const ip = context.ip || "desconocida";
  const termino = new URL(req.url).searchParams.get("q")?.trim();

  if (!termino || termino.length < 3) {
    return Response.json(
      { error: "Falta el parámetro de búsqueda (q, mínimo 3 caracteres)." },
      { status: 400 },
    );
  }

  const contador = getStore("rate-limit-secop");
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

  const params = new URLSearchParams({ $q: termino, $limit: "10" });

  let resultados = [];
  let registrosCrudos = [];
  try {
    const headers = { "User-Agent": USER_AGENT };
    if (process.env.SOCRATA_APP_TOKEN) headers["X-App-Token"] = process.env.SOCRATA_APP_TOKEN;

    const resp = await fetch(`${DOMINIO}/resource/${DATASET_ID}.json?${params.toString()}`, { headers });
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
    return Response.json(
      { error: "No se pudo consultar Datos Abiertos Colombia en este momento. Intenta de nuevo más tarde." },
      { status: 502 },
    );
  }

  await contador.set(claveContador, String(usoActual + 1));

  // Cachear la búsqueda (evita repetir la misma consulta en vivo el mismo día).
  const cache = getStore("cache-busquedas-secop");
  await cache.setJSON(`${hoy}:${termino.toLowerCase()}`, resultados);

  // Cada contrato encontrado en vivo se guarda para que
  // scripts/absorber_pendientes_secop.mjs (corrido desde GitHub Actions) lo
  // recoja y scripts/generar_json.py lo fusione al histórico acumulado —
  // así "contratos analizados" también crece con lo que la gente busca, no
  // solo con la ventana de ingesta normal.
  //
  // OJO: se guarda el registro CRUDO de Socrata completo (registrosCrudos),
  // no el `resultados` curado que se le devuelve al frontend — el `resultados`
  // solo tiene 6 campos para mostrar en la tarjeta de expediente, pero
  // limpiar()/calcular_desviacion_temporal() en Python necesitan
  // fecha_de_inicio_del_contrato, fecha_de_fin_del_contrato, dias_adicionados
  // y proveedor_adjudicado/documento_proveedor, que solo están en el crudo.
  // Sin id_contrato no hay forma de fusionar por id ni de tener una clave
  // válida en el store, así que se descartan esos registros (raro, pero
  // posible si Socrata devuelve algo incompleto).
  const pendientes = getStore("pendientes-secop");
  await Promise.all(
    registrosCrudos
      .filter((r) => r.id_contrato)
      .map((r) => pendientes.setJSON(r.id_contrato, r)),
  );

  return Response.json({
    resultados,
    busquedas_restantes_hoy: LIMITE_DIARIO - (usoActual + 1),
  });
};

export const config = {
  path: "/api/fallback-secop",
  rateLimit: {
    windowLimit: 10,
    windowSize: 60,
    aggregateBy: ["ip", "domain"],
    action: "block",
  },
};
