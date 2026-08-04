// Corre en GitHub Actions (Node), no en el runtime de Netlify — por eso usa el
// modo "manual" del SDK de @netlify/blobs (siteID + token), documentado para
// acceder a un store desde fuera de una Function/Edge Function.
//
// Cierra el gap: netlify/functions/fallback-secop.mjs guarda en el store
// "pendientes-secop" cada contrato que alguien encontró en vivo (buscando algo
// que no estaba en la muestra local) — pero hasta ahora nada leía ese store,
// así que esos contratos nunca se sumaban al histórico acumulado.
//
// Diseño en dos fases (fetch / confirm) para no perder datos si algo falla
// a la mitad de la corrida:
//   1. `fetch`   — lee todo lo pendiente, lo vuelca a PENDIENTES_JSON y anota
//                  qué claves se leyeron en PENDIENTES_KEYS. NO borra nada.
//   2. `confirm` — se corre solo si scripts/generar_json.py terminó bien;
//                  borra del store las claves que sí se leyeron en el paso 1.
// Si el proceso se cae entre el paso 1 y el 2, el peor caso es reprocesar los
// mismos contratos en la próxima corrida — inofensivo, porque el merge en
// Python es idempotente por id_contrato (scripts/generar_json.py,
// fusionar_historico: drop_duplicates(subset="id_contrato", keep="last")).
//
// Si NETLIFY_SITE_ID / NETLIFY_AUTH_TOKEN no están configurados (secrets del
// repo), el script no falla: registra un aviso y no hace nada, para que el
// resto del pipeline (ingesta normal de Socrata) siga funcionando igual que
// antes de que existiera este mecanismo.
import { getStore } from "@netlify/blobs";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

const NOMBRE_STORE = "pendientes-secop";
const PENDIENTES_JSON = process.env.PENDIENTES_SECOP_JSON || "./scripts/pendientes_absorbidos.json";
const PENDIENTES_KEYS = process.env.PENDIENTES_SECOP_KEYS || "./scripts/pendientes_absorbidos.keys.json";

function credencialesDisponibles() {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!siteID || !token) {
    console.log(
      "[info] NETLIFY_SITE_ID/NETLIFY_AUTH_TOKEN no configurados — se omite la absorción de pendientes-secop " +
      "(el resto del pipeline sigue igual).",
    );
    return null;
  }
  return { siteID, token };
}

async function modoFetch(store) {
  // list() sin paginate:true devuelve como mucho una página; con paginate:true
  // devuelve un async-iterable de páginas (verificado contra los tipos del SDK
  // instalado, node_modules/@netlify/blobs/dist/main.d.ts — el resultado NO
  // trae un campo "cursor" manual como en otras APIs paginadas).
  const claves = [];
  for await (const pagina of store.list({ paginate: true })) {
    for (const { key } of pagina.blobs) claves.push(key);
  }

  if (!claves.length) {
    console.log(`[info] ${NOMBRE_STORE}: sin registros pendientes.`);
    return;
  }

  const registros = [];
  const clavesLeidas = [];
  for (const key of claves) {
    try {
      const valor = await store.get(key, { type: "json" });
      if (valor && valor.id_contrato) {
        registros.push(valor);
        clavesLeidas.push(key);
      } else {
        console.warn(`[warn] registro sin id_contrato en la clave ${key} — se ignora.`);
      }
    } catch (e) {
      console.warn(`[warn] no se pudo leer la clave ${key}: ${e.message} — se reintenta en la próxima corrida.`);
    }
  }

  if (!registros.length) {
    console.log(`[info] ${NOMBRE_STORE}: ninguna clave se pudo leer correctamente.`);
    return;
  }

  writeFileSync(PENDIENTES_JSON, JSON.stringify(registros), "utf-8");
  writeFileSync(PENDIENTES_KEYS, JSON.stringify(clavesLeidas), "utf-8");
  console.log(`[ok] ${registros.length} contratos pendientes volcados a ${PENDIENTES_JSON}.`);
}

async function modoConfirm(store) {
  if (!existsSync(PENDIENTES_KEYS)) {
    console.log("[info] no hay manifiesto de claves pendiente de confirmar — nada que borrar.");
    return;
  }
  const claves = JSON.parse(readFileSync(PENDIENTES_KEYS, "utf-8"));
  await Promise.all(claves.map((key) => store.delete(key)));
  console.log(`[ok] ${claves.length} claves eliminadas de ${NOMBRE_STORE} tras confirmar la fusión.`);

  for (const ruta of [PENDIENTES_JSON, PENDIENTES_KEYS]) {
    if (existsSync(ruta)) unlinkSync(ruta);
  }
}

async function main() {
  const modo = process.argv[2];
  if (modo !== "fetch" && modo !== "confirm") {
    console.error('[error] uso: node absorber_pendientes_secop.mjs <fetch|confirm>');
    process.exitCode = 1;
    return;
  }

  const credenciales = credencialesDisponibles();
  if (!credenciales) return;

  const store = getStore({ name: NOMBRE_STORE, siteID: credenciales.siteID, token: credenciales.token });

  if (modo === "fetch") await modoFetch(store);
  else await modoConfirm(store);
}

main().catch((e) => {
  // No tumba el pipeline completo por un fallo aquí — la ingesta normal de
  // Socrata (ingerir() en generar_json.py) es independiente de este mecanismo.
  console.error(`[error] fallo en absorber_pendientes_secop.mjs (${process.argv[2]}): ${e.message}`);
});
