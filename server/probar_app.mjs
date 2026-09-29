// Pruebas del servidor ARRANCADO de verdad (app.mjs arranca al importarse, así que
// se levanta en un proceso aparte). Sin red: solo rutas que no salen a Socrata ni a
// la Corte. Corre sobre una COPIA de server/ en una carpeta temporal, para no tocar
// server/data/.
//
//   node server/probar_app.mjs
//
// Cubre la revisión de seguridad del 28-09: un fallo del almacén a mitad de una
// petición ya no tumba el proceso, y los errores salen en JSON sin stack ni rutas.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

let fallas = 0;
function afirmar(descripcion, condicion) {
  if (condicion) console.log(`[ok] ${descripcion}`);
  else { console.error(`[FALLA] ${descripcion}`); fallas++; }
}

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "token-de-prueba-suficientemente-largo";

const puertoLibre = () => new Promise((r) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); });
});

// Copia de server/ sin node_modules ni data; node_modules se enlaza.
const base = fs.mkdtempSync(path.join(os.tmpdir(), "servidor-publico-"));
const copia = path.join(base, "server");
fs.mkdirSync(copia);
for (const n of fs.readdirSync(AQUI)) {
  if (n === "node_modules" || n === "data") continue;
  fs.cpSync(path.join(AQUI, n), path.join(copia, n), { recursive: true });
}
fs.symlinkSync(path.join(AQUI, "node_modules"), path.join(copia, "node_modules"), "junction");
fs.mkdirSync(path.join(copia, "data"));

// Entorno limpio: sin MySQL (el estado va a disco) y sin nada de producción.
const entorno = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !/^(SECOP_MYSQL_|LSNODE_SOCKET$|ABSORBER_TOKEN$|ALLOWED_ORIGIN$|NODE_ENV$)/.test(k)));
const puerto = await puertoLibre();
const hijo = spawn(process.execPath, ["--no-warnings", path.join(copia, "app.mjs")],
  { env: { ...entorno, PORT: String(puerto), ABSORBER_TOKEN: TOKEN }, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
hijo.stdout.on("data", (d) => { log += d; });
hijo.stderr.on("data", (d) => { log += d; });
let salioCon = null;
const salio = new Promise((r) => hijo.on("exit", (c) => { salioCon = c; r(); }));
const url = `http://127.0.0.1:${puerto}`;

try {
  for (let i = 0; i < 100 && !/escuchando/.test(log); i++) await new Promise((r) => setTimeout(r, 50));
  afirmar("el servidor arrancó", /escuchando/.test(log));

  console.log("\n=== Errores en JSON, sin stack ni rutas del servidor ===");
  {
    // El JSON de /confirmar se lee ANTES de revisar el token: esto se podía provocar sin token.
    const r = await fetch(`${url}/internal/pendientes-secop/confirmar`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: '{"claves": ["texto-del-cliente"',
    });
    const cuerpo = await r.text();
    afirmar("JSON mal formado, sin token: 400", r.status === 400);
    afirmar("en JSON, no la página HTML de Express", /application\/json/.test(r.headers.get("content-type") ?? ""));
    afirmar("sin stack ni rutas", !/at |node_modules|[A-Z]:\\|\/home\/|\/tmp\//.test(cuerpo));
    afirmar("y el log no repite lo que mandó el cliente", !log.includes("texto-del-cliente"));
  }

  console.log("\n=== El token interno ===");
  {
    const sin = await fetch(`${url}/internal/pendientes-secop`);
    const otro = await fetch(`${url}/internal/pendientes-secop`, { headers: { "X-Internal-Token": "otro" } });
    const casi = await fetch(`${url}/internal/pendientes-secop`, { headers: { "X-Internal-Token": TOKEN.slice(0, -1) } });
    const bien = await fetch(`${url}/internal/pendientes-secop`, { headers: { "X-Internal-Token": TOKEN } });
    afirmar("sin token, con otro o con uno casi igual: 401", sin.status === 401 && otro.status === 401 && casi.status === 401);
    afirmar("con el correcto: 200", bien.status === 200);
  }

  console.log("\n=== Un fallo del almacén a mitad de la petición no tumba el proceso ===");
  {
    // Un estado corrupto en disco hace que `leer` lance, como lo haría MySQL caído a
    // mitad de una petición. Antes: rechazo sin manejar y Node terminaba el proceso.
    fs.writeFileSync(path.join(copia, "data", "pendientes-secop.json"), "{corrupto");
    // Si el proceso muere, fetch lanza: eso es una FALLA de la prueba, no un crash de ella.
    const pedir = () => fetch(`${url}/internal/pendientes-secop`, { headers: { "X-Internal-Token": TOKEN } })
      .then(async (r) => ({ status: r.status, cuerpo: await r.text() }), () => ({ status: 0, cuerpo: "" }));
    const r = await pedir();
    let error = null;
    try { error = JSON.parse(r.cuerpo).error; } catch { /* sin JSON */ }
    afirmar("responde 500 en JSON (antes el proceso moría y la conexión se cortaba)", r.status === 500 && typeof error === "string");
    afirmar("sin el mensaje interno ni rutas", typeof error === "string" && !/Unexpected|JSON|at |[A-Z]:\\/.test(error));
    await new Promise((x) => setTimeout(x, 200));
    afirmar("y el proceso SIGUE vivo", salioCon === null);
    afirmar("atiende la petición siguiente", (await pedir()).status === 500);
  }
} finally {
  hijo.kill();
  await salio;
  fs.rmSync(base, { recursive: true, force: true });
}

console.log(fallas ? `\n${fallas} falla(s).` : "\nTodo pasó.");
process.exit(fallas ? 1 : 0);
