// Corre en GitHub Actions (Node), no en el runtime del servidor — recoge los
// contratos que la gente encontró en vivo (búsquedas que no estaban en la
// muestra local, resueltas por server/app.mjs en Hostinger) y los deja en
// scripts/pendientes_absorbidos.json para que Python los fusione al histórico
// acumulado.
//
// Reemplaza el mecanismo anterior basado en @netlify/blobs "modo manual"
// (siteID+token) por dos llamadas HTTP simples contra el Node.js Web App de
// Hostinger (server/app.mjs), autenticadas con un token compartido.
//
// Mismo diseño en dos fases que antes, para no perder datos si algo falla a
// mitad de la corrida:
//   1. `fetch`   — pide TODO lo pendiente al servidor (GET, no borra nada),
//                  lo vuelca a PENDIENTES_JSON y anota las claves recibidas en
//                  PENDIENTES_KEYS.
//   2. `confirm` — se corre solo si scripts/generar_json.py terminó bien; le
//                  pide al servidor que borre exactamente esas claves (POST).
// Si el proceso se cae entre el paso 1 y el 2, el peor caso es reprocesar los
// mismos contratos en la próxima corrida — inofensivo, porque el merge en
// Python es idempotente por id_contrato (scripts/generar_json.py,
// fusionar_historico: drop_duplicates(subset="id_contrato", keep="last")).
//
// Si API_BASE_URL / ABSORBER_TOKEN no están configurados (secrets del repo),
// el script no falla: registra un aviso y no hace nada, para que el resto del
// pipeline (ingesta normal de Socrata) siga funcionando igual.
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

const PENDIENTES_JSON = process.env.PENDIENTES_SECOP_JSON || "./scripts/pendientes_absorbidos.json";
const PENDIENTES_KEYS = process.env.PENDIENTES_SECOP_KEYS || "./scripts/pendientes_absorbidos.keys.json";

function credencialesDisponibles() {
  const baseURL = process.env.API_BASE_URL;
  const token = process.env.ABSORBER_TOKEN;
  if (!baseURL || !token) {
    console.log(
      "[info] API_BASE_URL/ABSORBER_TOKEN no configurados — se omite la absorción de pendientes-secop " +
      "(el resto del pipeline sigue igual).",
    );
    return null;
  }
  return { baseURL: baseURL.replace(/\/$/, ""), token };
}

async function modoFetch({ baseURL, token }) {
  const resp = await fetch(`${baseURL}/internal/pendientes-secop`, {
    headers: { "X-Internal-Token": token },
  });
  if (!resp.ok) throw new Error(`GET /internal/pendientes-secop respondió ${resp.status}`);
  const { registros, claves } = await resp.json();

  if (!registros.length) {
    console.log("[info] pendientes-secop: sin registros pendientes.");
    return;
  }

  writeFileSync(PENDIENTES_JSON, JSON.stringify(registros), "utf-8");
  writeFileSync(PENDIENTES_KEYS, JSON.stringify(claves), "utf-8");
  console.log(`[ok] ${registros.length} contratos pendientes volcados a ${PENDIENTES_JSON}.`);
}

async function modoConfirm({ baseURL, token }) {
  if (!existsSync(PENDIENTES_KEYS)) {
    console.log("[info] no hay manifiesto de claves pendiente de confirmar — nada que borrar.");
    return;
  }
  const claves = JSON.parse(readFileSync(PENDIENTES_KEYS, "utf-8"));

  const resp = await fetch(`${baseURL}/internal/pendientes-secop/confirmar`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Token": token },
    body: JSON.stringify({ claves }),
  });
  if (!resp.ok) throw new Error(`POST /internal/pendientes-secop/confirmar respondió ${resp.status}`);
  console.log(`[ok] ${claves.length} claves eliminadas de pendientes-secop tras confirmar la fusión.`);

  for (const ruta of [PENDIENTES_JSON, PENDIENTES_KEYS]) {
    if (existsSync(ruta)) unlinkSync(ruta);
  }
}

async function main() {
  const modo = process.argv[2];
  if (modo !== "fetch" && modo !== "confirm") {
    console.error("[error] uso: node absorber_pendientes_secop.mjs <fetch|confirm>");
    process.exitCode = 1;
    return;
  }

  const credenciales = credencialesDisponibles();
  if (!credenciales) return;

  if (modo === "fetch") await modoFetch(credenciales);
  else await modoConfirm(credenciales);
}

main().catch((e) => {
  // No tumba el pipeline completo por un fallo aquí — la ingesta normal de
  // Socrata (ingerir() en generar_json.py) es independiente de este mecanismo.
  console.error(`[error] fallo en absorber_pendientes_secop.mjs (${process.argv[2]}): ${e.message}`);
});
