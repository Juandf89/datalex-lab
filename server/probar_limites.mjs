// Pruebas de los límites del servidor público (limites.mjs). Sin red, sin la
// Corte, sin Socrata: el almacén es un archivo temporal y el reloj es falso.
//
//   npm run probar        (dentro de server/)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  numeroDeEntorno, crearLimiteDeRafaga, crearLimiteDiario, cuerpoLimiteDiario,
  VENTANA_MS, LIMITE_VENTANA, MAX_CLAVES_RAFAGA,
} from "./limites.mjs";

let fallas = 0;
function afirmar(descripcion, condicion) {
  if (condicion) console.log(`[ok] ${descripcion}`);
  else { console.error(`[FALLA] ${descripcion}`); fallas++; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "limites-"));
let n = 0;
const nuevaRuta = () => path.join(dir, `cuotas-${++n}.json`);
const leerArchivo = (ruta) => (fs.existsSync(ruta) ? JSON.parse(fs.readFileSync(ruta, "utf8")) : {});

try {
  /* ============ La variable de entorno que desactivaba el límite ============ */

  console.log("\n=== numeroDeEntorno: un valor mal escrito no desactiva el límite ===");
  {
    const avisos = [];
    const aviso = (m) => avisos.push(m);
    afirmar("sin la variable, el valor por defecto y sin aviso", numeroDeEntorno("X", 5, {}, aviso) === 5 && avisos.length === 0);
    afirmar("vacía, el valor por defecto y sin aviso", numeroDeEntorno("X", 5, { X: "" }, aviso) === 5 && avisos.length === 0);
    afirmar("un número válido se respeta", numeroDeEntorno("X", 5, { X: "12" }, aviso) === 12);
    afirmar("y también en notación científica", numeroDeEntorno("X", 5, { X: "1e2" }, aviso) === 100);

    // El caso real: `Number("abc")` es NaN y `uso >= NaN` es siempre falso.
    afirmar("texto (lo que dejó el incidente del panel): el valor por defecto, NO NaN",
      numeroDeEntorno("LIMITE", 5, { LIMITE: "abc" }, aviso) === 5);
    afirmar("y avisa, nombrando la variable", avisos.length === 1 && avisos[0].includes("LIMITE"));

    // El aviso va al log del hosting. Nunca debe repetir el valor: el incidente del
    // panel pegó `SECOP_MYSQL_HOST=...` dentro de otra variable, y podría ser una clave.
    const secretos = [];
    numeroDeEntorno("LIMITE", 5, { LIMITE: "20'SECOP_MYSQL_PASSWORD=hunter2" }, (m) => secretos.push(m));
    afirmar("el aviso NO imprime el contenido del valor, para no filtrar lo que arrastre",
      secretos.length === 1 && !secretos[0].includes("hunter2") && !secretos[0].includes("PASSWORD"));
    afirmar("'0' no bloquea a todo el mundo: el valor por defecto", numeroDeEntorno("X", 5, { X: "0" }, aviso) === 5);
    afirmar("un negativo tampoco", numeroDeEntorno("X", 5, { X: "-3" }, aviso) === 5);
    afirmar("ni el texto pegado con otra variable", numeroDeEntorno("X", 5, { X: "20'SECOP_MYSQL_HOST=srv1" }, aviso) === 5);
  }

  /* ============ Freno de ráfaga ============ */

  console.log("\n=== Ráfaga: 10 por minuto por clave ===");
  {
    let t = 1_000_000;
    const freno = crearLimiteDeRafaga({ ahora: () => t });
    const resultados = Array.from({ length: LIMITE_VENTANA + 2 }, () => freno.superado("1.2.3.4"));
    afirmar("las primeras 10 pasan", resultados.slice(0, LIMITE_VENTANA).every((r) => r === false));
    afirmar("la 11 y la 12 se frenan", resultados[LIMITE_VENTANA] === true && resultados[LIMITE_VENTANA + 1] === true);
    afirmar("otra clave no se ve afectada", freno.superado("5.6.7.8") === false);
    t += VENTANA_MS + 1;
    afirmar("pasada la ventana, la clave vuelve a pasar", freno.superado("1.2.3.4") === false);
  }

  console.log("\n=== Ráfaga: el mapa no crece sin límite con claves inventadas ===");
  {
    let t = 0;
    const freno = crearLimiteDeRafaga({ maxClaves: 50, ahora: () => t });
    for (let i = 0; i < 150; i++) freno.superado(`10.0.0.${i}`);
    afirmar("las claves recientes se conservan mientras están vivas", freno.tamano() === 150);
    t = VENTANA_MS + 500;
    for (let i = 0; i < 60; i++) freno.superado(`vivas-${i}`);
    afirmar("las vencidas se barren al pasar el tope, las vivas se quedan", freno.tamano() === 60);
    afirmar("y barrer no le borra la historia a una clave viva: la siguiente cuenta bien",
      freno.superado("vivas-0") === false && freno.tamano() === 60);
    afirmar("el tope por defecto es finito", Number.isFinite(MAX_CLAVES_RAFAGA) && MAX_CLAVES_RAFAGA > 0);
  }

  /* ============ Cuota diaria ============ */

  console.log("\n=== Cuota diaria: por IP ===");
  {
    const ruta = nuevaRuta();
    const q = crearLimiteDiario({ ruta, globales: {}, ahora: () => new Date("2026-09-21T10:00:00Z") });
    const a = await q.verificar("secop", "1.2.3.4", 5);
    afirmar("una IP nueva parte de cero y no está limitada", a.usoActual === 0 && a.alcanzado === false && a.motivo === null);

    // Comprobar NO consume: una consulta que falla contra la fuente no cuesta cuota.
    await q.verificar("secop", "1.2.3.4", 5);
    afirmar("verificar no consume nada", (await q.verificar("secop", "1.2.3.4", 5)).usoActual === 0);

    for (let i = 0; i < 5; i++) await (await q.verificar("secop", "1.2.3.4", 5)).confirmar();
    const b = await q.verificar("secop", "1.2.3.4", 5);
    afirmar("agotada la cuota, se limita y dice que fue la de la IP", b.alcanzado === true && b.motivo === "ip" && b.usoActual === 5);
    afirmar("otra IP no se ve afectada", (await q.verificar("secop", "9.9.9.9", 5)).alcanzado === false);
    afirmar("y la IPv6 (con ':' dentro) tampoco", (await q.verificar("secop", "2001:db8::1", 5)).alcanzado === false);

    // Una IPv6 lleva ':' dentro. Si el día se leyera contando desde el INICIO, la poda
    // no reconocería su clave de hoy y le borraría la cuenta en cada confirmación. Hacen
    // falta varias: la poda corre ANTES de insertar, así que la primera clave sobrevive.
    for (let k = 0; k < 3; k++) await (await q.verificar("secop", "2001:db8::1", 5)).confirmar();
    afirmar("la cuenta de una IPv6 sobrevive a las podas (el día se lee desde el final)",
      (await q.verificar("secop", "2001:db8::1", 5)).usoActual === 3);
    afirmar("cada servicio lleva su propia cuenta", (await q.verificar("jurisprudencia", "1.2.3.4", 20)).usoActual === 0);
  }

  console.log("\n=== Cuota diaria: el tope GLOBAL, que no depende de quién dice ser el cliente ===");
  {
    const ruta = nuevaRuta();
    const avisos = [];
    const q = crearLimiteDiario({
      ruta, globales: { jurisprudencia: 3 }, aviso: (m) => avisos.push(m),
      ahora: () => new Date("2026-09-21T10:00:00Z"),
    });
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) await (await q.verificar("jurisprudencia", ip, 20)).confirmar();
    const cuarta = await q.verificar("jurisprudencia", "4.4.4.4", 20);
    afirmar("agotado el global, una IP NUEVA con cuota propia intacta también se limita",
      cuarta.usoActual === 0 && cuarta.alcanzado === true && cuarta.motivo === "global");
    afirmar("y el aviso salió una sola vez, al alcanzarse, nombrando el servicio",
      avisos.length === 1 && avisos[0].includes("jurisprudencia"));
    afirmar("el otro servicio no se ve afectado", (await q.verificar("secop", "4.4.4.4", 5)).alcanzado === false);

    const g = cuerpoLimiteDiario("global", 20, 3);
    afirmar("el 429 global lo dice, sin afirmar que fue culpa del usuario",
      /para todos los visitantes/.test(g.error) && g.limite_diario_global === 3 && g.busquedas_restantes_hoy === 0);
    const i = cuerpoLimiteDiario("ip", 20, 3);
    afirmar("el 429 por IP conserva su forma de siempre",
      /Alcanzaste el límite/.test(i.error) && i.limite_diario === 20 && i.busquedas_restantes_hoy === 0);

    const sinTope = crearLimiteDiario({ ruta: nuevaRuta(), globales: {}, ahora: () => new Date("2026-09-21T10:00:00Z") });
    for (let k = 0; k < 40; k++) await (await sinTope.verificar("secop", `10.0.0.${k}`, 5)).confirmar();
    afirmar("un servicio sin tope global configurado no se limita por ese lado",
      (await sinTope.verificar("secop", "10.9.9.9", 5)).alcanzado === false);
  }

  console.log("\n=== Cuota diaria: el ataque real — IPs inventadas, una tras otra ===");
  {
    // Lo MEDIDO el 21-09: con un X-Forwarded-For distinto en cada petición, todas pasan.
    // Cada una trae una cuota por IP nueva. Sin tope global, todas las búsquedas salen.
    const TOPE = 30, INTENTOS = 1000;
    const ruta = nuevaRuta();
    const q = crearLimiteDiario({ ruta, globales: { jurisprudencia: TOPE }, aviso: () => {},
      ahora: () => new Date("2026-09-21T10:00:00Z") });
    let salieron = 0, frenadas = 0;
    for (let k = 0; k < INTENTOS; k++) {
      const c = await q.verificar("jurisprudencia", `198.51.100.${k % 250}.${k}`, 20);
      if (c.alcanzado) { frenadas++; continue; }
      await c.confirmar();
      salieron++;
    }
    afirmar(`de ${INTENTOS} IPs distintas solo salen ${TOPE} búsquedas`, salieron === TOPE && frenadas === INTENTOS - TOPE);
    const claves = Object.keys(leerArchivo(ruta));
    afirmar("y el almacén queda acotado: una clave por búsqueda que salió, más la global",
      claves.length === TOPE + 1);
    afirmar("el contador global quedó exactamente en el tope",
      leerArchivo(ruta)["global:2026-09-21:jurisprudencia"] === TOPE);
  }

  console.log("\n=== Cuota diaria: las claves de días anteriores ya no se acumulan ===");
  {
    const ruta = nuevaRuta();
    // Lo que había en el almacén local de desarrollo: claves de días viejos, para siempre.
    fs.writeFileSync(ruta, JSON.stringify({
      "::1:2026-08-04:jurisprudencia": 2, "::1:2026-08-05:secop": 1,
      "1.2.3.4:2026-09-20:secop": 5, "global:2026-09-20:secop": 40,
    }));
    let hoy = new Date("2026-09-21T10:00:00Z");
    const q = crearLimiteDiario({ ruta, globales: { secop: 100 }, ahora: () => hoy });
    await (await q.verificar("secop", "::1", 5)).confirmar();
    const claves = Object.keys(leerArchivo(ruta));
    afirmar("se podan las de días anteriores, incluida la IPv6 (el día se lee desde el final)",
      claves.length === 2 && claves.every((k) => k.split(":").at(-2) === "2026-09-21"));

    hoy = new Date("2026-09-22T00:00:01Z");
    const manana = await q.verificar("secop", "::1", 5);
    afirmar("al día siguiente la cuota y el tope global parten de cero",
      manana.usoActual === 0 && manana.usoGlobal === 0 && manana.alcanzado === false);
    await manana.confirmar();
    afirmar("y confirmar poda también lo de ayer", Object.keys(leerArchivo(ruta)).every((k) => k.split(":").at(-2) === "2026-09-22"));
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(fallas ? `\n${fallas} falla(s).` : "\nTodo pasó.");
process.exit(fallas ? 1 : 0);
