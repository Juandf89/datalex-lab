// Pruebas de estado.mjs: que las cuotas y la cola sobrevivan a un despliegue.
// Sin MySQL real: un pool falso que guarda las filas en un Map y anota cada
// llamada. Prueba el flujo (transacción, rollback, liberar la conexión, caer al
// disco) — NO que el SQL sea válido en el MySQL de Hostinger: eso solo se ve
// desplegado (la línea `[estado]` del log de ejecución, y la tabla en phpMyAdmin).
//
//   npm run probar        (dentro de server/)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { crearEstado, TABLA_ESTADO } from "./estado.mjs";
import { crearLimiteDiario } from "./limites.mjs";

let fallas = 0;
function afirmar(descripcion, condicion) {
  if (condicion) console.log(`[ok] ${descripcion}`);
  else { console.error(`[FALLA] ${descripcion}`); fallas++; }
}

/** Que una promesa que se cuelga falle con un mensaje, en vez de colgar la prueba. */
function aTiempo(promesa, ms = 2000) {
  let t;
  const tarde = new Promise((r) => { t = setTimeout(() => r({ colgada: true }), ms); });
  return Promise.race([promesa.then((v) => ({ valor: v }), (e) => ({ error: e })), tarde]).finally(() => clearTimeout(t));
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Un pool con la forma de mysql2/promise. `filas` es la "base": sobrevive a crear
 * un estado nuevo, igual que la base real sobrevive a un despliegue.
 */
function poolFalso({ filas = new Map(), fallaAlCrear = null, colgarAlCrear = false, latenciaMs = 0 } = {}) {
  const registro = { consultas: [], transacciones: 0, commits: 0, rollbacks: 0, liberadas: 0, pedidas: 0 };
  const lento = () => (latenciaMs ? esperar(latenciaMs) : Promise.resolve());
  async function ejecutar(sql, params = []) {
    registro.consultas.push(sql);
    await lento();
    if (sql.startsWith("CREATE TABLE")) {
      if (colgarAlCrear) return new Promise(() => {});
      if (fallaAlCrear) throw fallaAlCrear;
      return [[]];
    }
    if (sql.startsWith("SELECT valor")) {
      const v = filas.get(params[0]);
      return [v === undefined ? [] : [{ valor: v }]];
    }
    if (sql.startsWith("INSERT INTO")) {
      filas.set(params[0], params[1]);
      return [{ affectedRows: 1 }];
    }
    throw new Error(`SQL inesperado en la prueba: ${sql}`);
  }
  return {
    filas,
    registro,
    query: ejecutar,
    async getConnection() {
      registro.pedidas++;
      return {
        query: ejecutar,
        async beginTransaction() { registro.transacciones++; },
        async commit() { registro.commits++; },
        async rollback() { registro.rollbacks++; },
        release() { registro.liberadas++; },
      };
    },
  };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "estado-"));
let n = 0;
/** Una carpeta nueva: lo que ve una versión recién desplegada (server/data/ no viaja). */
const carpetaNueva = () => {
  const c = path.join(dir, `version-${++n}`);
  fs.mkdirSync(c);
  return pathToFileURL(c + path.sep);
};

try {
  console.log("\n=== El bug: en disco, una versión nueva empieza de cero ===");
  {
    const hoy = () => new Date("2026-09-22T10:00:00Z");
    const antes = crearLimiteDiario({ almacen: crearEstado({ carpetaDisco: carpetaNueva(), hayMysql: false, log: () => {} })
      .celda("rate-limits"), globales: { jurisprudencia: 600 }, ahora: hoy });
    for (let i = 0; i < 3; i++) await (await antes.verificar("jurisprudencia", "1.1.1.1", 20)).confirmar();
    // El despliegue: misma lógica, carpeta nueva.
    const despues = crearLimiteDiario({ almacen: crearEstado({ carpetaDisco: carpetaNueva(), hayMysql: false, log: () => {} })
      .celda("rate-limits"), globales: { jurisprudencia: 600 }, ahora: hoy });
    const v = await despues.verificar("jurisprudencia", "1.1.1.1", 20);
    afirmar("en disco, tras un despliegue la cuota por IP vuelve a 0 (era 3): así estaba producción", v.usoActual === 0);
    afirmar("y el tope global también vuelve a 0", v.usoGlobal === 0);
  }

  console.log("\n=== El arreglo: en MySQL, la cuota sobrevive al despliegue ===");
  {
    const hoy = () => new Date("2026-09-22T10:00:00Z");
    const base = new Map(); // la base real: la misma antes y después del despliegue
    const carpetas = [carpetaNueva(), carpetaNueva()];
    const antes = crearLimiteDiario({ almacen: crearEstado({ obtenerPool: () => poolFalso({ filas: base }),
      carpetaDisco: carpetas[0], log: () => {} }).celda("rate-limits"), globales: { jurisprudencia: 600 }, ahora: hoy });
    for (let i = 0; i < 3; i++) await (await antes.verificar("jurisprudencia", "1.1.1.1", 20)).confirmar();
    const despues = crearLimiteDiario({ almacen: crearEstado({ obtenerPool: () => poolFalso({ filas: base }),
      carpetaDisco: carpetas[1], log: () => {} }).celda("rate-limits"), globales: { jurisprudencia: 600 }, ahora: hoy });
    const v = await despues.verificar("jurisprudencia", "1.1.1.1", 20);
    afirmar("tras el despliegue la cuota por IP sigue en 3", v.usoActual === 3);
    afirmar("y el tope global también sigue en 3", v.usoGlobal === 3);
    afirmar("la fila vive bajo la clave `rate-limits`, como JSON", base.has("rate-limits") && JSON.parse(base.get("rate-limits"))["1.1.1.1:2026-09-22:jurisprudencia"] === 3);
    afirmar("y no se escribió nada en disco", carpetas.every((c) => fs.readdirSync(c).length === 0));
  }

  console.log("\n=== Transacción: leer bloqueando, guardar, confirmar; y soltar la conexión siempre ===");
  {
    const pool = poolFalso();
    const estado = crearEstado({ obtenerPool: () => pool, carpetaDisco: carpetaNueva(), log: () => {} });
    const celda = estado.celda("pendientes-secop");
    await celda.actualizar({}, (d) => ({ ...d, "CO1.PCCNTR.1": { id_contrato: "CO1.PCCNTR.1" } }));
    afirmar("una transacción, un commit, ningún rollback", pool.registro.transacciones === 1 && pool.registro.commits === 1 && pool.registro.rollbacks === 0);
    afirmar("la lectura dentro de la transacción es FOR UPDATE", pool.registro.consultas.some((q) => q.endsWith("FOR UPDATE")));
    afirmar("la conexión se devolvió al pool", pool.registro.liberadas === pool.registro.pedidas && pool.registro.pedidas === 1);
    afirmar("leer devuelve lo guardado", (await celda.leer({}))["CO1.PCCNTR.1"]?.id_contrato === "CO1.PCCNTR.1");
    afirmar("una clave que no existe devuelve el valor inicial", (await estado.celda("otra").leer({ vacio: true })).vacio === true);

    const antes = pool.filas.get("pendientes-secop");
    const r = await aTiempo(celda.actualizar({}, () => { throw new Error("el mutador falló"); }));
    afirmar("si el mutador falla, el error le llega a quien llamó", r.error?.message === "el mutador falló");
    afirmar("se hace rollback", pool.registro.rollbacks === 1);
    afirmar("no se guarda nada a medias", pool.filas.get("pendientes-secop") === antes);
    afirmar("y la conexión se devuelve igual", pool.registro.liberadas === pool.registro.pedidas);
  }

  console.log("\n=== Escrituras simultáneas de la misma clave no se pisan ===");
  {
    // Con latencia, sin la fila de escrituras dos incrementos leerían el mismo valor
    // y uno se perdería. (El FOR UPDATE de MySQL cubriría además a OTRO proceso; el
    // pool falso no lo simula.)
    const pool = poolFalso({ latenciaMs: 2 });
    const celda = crearEstado({ obtenerPool: () => pool, carpetaDisco: carpetaNueva(), log: () => {} }).celda("rate-limits");
    await Promise.all(Array.from({ length: 20 }, () => celda.actualizar({ n: 0 }, (d) => ({ n: d.n + 1 }))));
    afirmar("20 incrementos simultáneos dejan 20", (await celda.leer({ n: 0 })).n === 20);
  }

  console.log("\n=== Si MySQL no está al arrancar: disco, y una línea en el log sin secretos ===");
  {
    const lineas = [];
    // Usuario y host INVENTADOS: la prueba solo necesita que el mensaje los traiga. Nunca usar
    // aquí los reales de la cuenta: este repo es público.
    const e = Object.assign(new Error("Access denied for user 'u000000000_ejemplo'@'srv0000.ejemplo.invalid' (using password: YES)"),
      { code: "ER_TABLEACCESS_DENIED_ERROR" });
    const estado = crearEstado({ obtenerPool: () => poolFalso({ fallaAlCrear: e }), carpetaDisco: carpetaNueva(), log: (m) => lineas.push(m) });
    afirmar("cae al disco", (await estado.almacen()) === "disco");
    afirmar("y sigue funcionando", (await estado.celda("rate-limits").actualizar({ n: 0 }, (d) => ({ n: d.n + 1 }))).n === 1);
    const log = lineas.join("\n");
    afirmar("el log dice qué pasó, con el código del error", /MySQL no disponible \(ER_TABLEACCESS_DENIED_ERROR\)/.test(log));
    afirmar("y advierte que en disco se pierde en cada despliegue", /Se PIERDEN en cada despliegue/.test(log));
    afirmar("el log NO lleva usuario ni host (el mensaje de mysql2 sí los trae)", !/u000000000|ejemplo\.invalid|srv0000|Access denied/.test(log));
    afirmar("una sola línea, no una por petición", lineas.length === 1);
  }
  {
    const lineas = [];
    const estado = crearEstado({ obtenerPool: () => poolFalso({ colgarAlCrear: true }), carpetaDisco: carpetaNueva(),
      esperaMs: 50, log: (m) => lineas.push(m) });
    const r = await aTiempo(estado.almacen());
    afirmar("si MySQL no responde, no cuelga el servidor: a los esperaMs cae al disco", r.valor === "disco");
    afirmar("y lo dice", /TIEMPO_AGOTADO/.test(lineas.join("")));
  }
  {
    const lineas = [];
    let pedidoElPool = false;
    const estado = crearEstado({ obtenerPool: () => { pedidoElPool = true; return poolFalso(); },
      carpetaDisco: carpetaNueva(), hayMysql: false, log: (m) => lineas.push(m) });
    afirmar("sin variables de MySQL ni lo intenta: disco", (await estado.almacen()) === "disco" && !pedidoElPool);
    afirmar("y lo dice", /sin variables de MySQL/.test(lineas.join("")));
  }
  {
    const lineas = [];
    const pool = poolFalso();
    const estado = crearEstado({ obtenerPool: () => pool, carpetaDisco: carpetaNueva(), log: (m) => lineas.push(m) });
    await Promise.all([estado.almacen(), estado.celda("rate-limits").leer({}), estado.celda("pendientes-secop").leer({})]);
    afirmar("con MySQL, crea la tabla UNA vez aunque lleguen varias peticiones a la vez",
      pool.registro.consultas.filter((q) => q.startsWith("CREATE TABLE")).length === 1);
    afirmar(`y el log dice que usa la tabla ${TABLA_ESTADO}`, lineas.length === 1 && lineas[0].includes(TABLA_ESTADO));
  }

  console.log("\n=== Claves ===");
  {
    const estado = crearEstado({ carpetaDisco: carpetaNueva(), hayMysql: false, log: () => {} });
    let error = null;
    try { estado.celda("../../etc/passwd"); } catch (e) { error = e; }
    afirmar("una clave con ruta se rechaza (en disco sería un archivo fuera de data/)", /clave de estado inválida/.test(error?.message ?? ""));
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(fallas ? `\n${fallas} falla(s).` : "\nTodo pasó.");
process.exit(fallas ? 1 : 0);
