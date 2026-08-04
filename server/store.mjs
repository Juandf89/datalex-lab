// Reemplazo de @netlify/blobs para el Node.js Web App de Hostinger: a diferencia
// de una Netlify Function (sin estado entre invocaciones, por eso necesitaba un
// KV externo), este es un proceso Node persistente con disco local propio — así
// que el estado (contadores de rate-limit, colas "pendientes-*") se guarda
// directo en archivos JSON bajo server/data/ (gitignored).
//
// `actualizar()` serializa lecturas+escrituras por archivo con una cola de
// promesas en memoria, para que dos requests concurrentes no se pisen la
// escritura (un solo proceso Node, pero el event loop sí intercala awaits).
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// app.mjs pasa rutas como `new URL(..., import.meta.url)` (evita ambigüedad de
// rutas relativas según el cwd del proceso). dirname() de node:path exige un
// string, no un objeto URL — se normaliza acá una sola vez, y de paso sirve
// como clave estable para la cola de escrituras (dos URL con el mismo href no
// son === entre sí, un string sí).
function aRutaString(ruta) {
  return ruta instanceof URL ? fileURLToPath(ruta) : ruta;
}

const colas = new Map();

function encolar(ruta, tarea) {
  const anterior = colas.get(ruta) || Promise.resolve();
  const actual = anterior.then(tarea, tarea);
  colas.set(ruta, actual.catch(() => {}));
  return actual;
}

export async function leer(rutaEntrada, valorInicial) {
  const ruta = aRutaString(rutaEntrada);
  try {
    const contenido = await readFile(ruta, "utf-8");
    return JSON.parse(contenido);
  } catch (e) {
    if (e.code === "ENOENT") return valorInicial;
    throw e;
  }
}

async function escribirAtomico(ruta, datos) {
  await mkdir(dirname(ruta), { recursive: true });
  // Escribe a un archivo temporal y renombra — un crash a mitad de escritura
  // deja el archivo original intacto en vez de un JSON truncado/corrupto.
  const temporal = `${ruta}.${process.pid}.tmp`;
  await writeFile(temporal, JSON.stringify(datos), "utf-8");
  await rename(temporal, ruta);
}

// Lee, transforma con `mutador` (puede ser async) y escribe atómicamente el
// resultado. `mutador` recibe los datos actuales (o valorInicial si el archivo
// no existe todavía) y devuelve los datos nuevos.
export function actualizar(rutaEntrada, valorInicial, mutador) {
  const ruta = aRutaString(rutaEntrada);
  return encolar(ruta, async () => {
    const datos = await leer(ruta, valorInicial);
    const nuevos = await mutador(datos);
    await escribirAtomico(ruta, nuevos);
    return nuevos;
  });
}
