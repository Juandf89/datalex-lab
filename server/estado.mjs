// Estado del servidor que debe sobrevivir a un despliegue: las cuotas diarias
// (rate-limits) y la cola de absorción de SECOP (pendientes-secop).
//
// POR QUÉ NO BASTA EL DISCO
// -------------------------
// store.mjs guardaba todo en JSON bajo server/data/, suponiendo "un proceso Node
// persistente con su propio filesystem". No lo es. Soporte de Hostinger, 2026-09-22:
// cada push a la rama conectada crea una versión NUEVA de la app
// (hbuilds/versions/<uuid>, con `current` apuntando a la activa), y lo que la app
// escribe en tiempo de ejecución "puede perderse al cambiar la versión desplegada";
// no hay carpeta persistente documentada. MEDIDO el mismo día: en la única versión
// desplegada no existía server/data/. Como el workflow de SECOP empuja a `main`
// cada hora, el tope diario —por IP y global— se reiniciaba a lo largo del día, y
// lo pendiente de absorber se perdía en cada push.
//
// Por eso el estado va a una tabla del MySQL que este servidor ya usa (db.mjs).
// Se guarda como pares clave → JSON, con el mismo contrato de store.mjs
// (`leer` / `actualizar`): la lógica de las cuotas no cambia, solo dónde vive.
//
// SI MYSQL NO ESTÁ DISPONIBLE AL ARRANCAR
// ---------------------------------------
// Se usa el disco, como antes, y se deja UNA línea en el log que lo dice. Así el
// servidor nunca queda peor que antes del cambio. El log solo lleva el código del
// error, nunca su mensaje: el de mysql2 trae host y usuario, y el host de esta
// base ya se filtró una vez en una cabecera HTTP (incidente del 2026-08-05).

import { leer as leerArchivo, actualizar as actualizarArchivo } from "./store.mjs";

export const TABLA_ESTADO = "estado_servidor";
// Cuánto se espera a MySQL al arrancar antes de caer al disco. Mientras tanto las
// peticiones que necesitan estado esperan: más vale un arranque lento que un
// servidor colgado para siempre por una base que no responde.
export const ESPERA_ARRANQUE_MS = 10_000;

const SQL_CREAR = `CREATE TABLE IF NOT EXISTS ${TABLA_ESTADO} (
  clave VARCHAR(64) NOT NULL PRIMARY KEY,
  valor MEDIUMTEXT NOT NULL,
  actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
const SQL_LEER = `SELECT valor FROM ${TABLA_ESTADO} WHERE clave = ?`;
const SQL_LEER_BLOQUEANDO = `SELECT valor FROM ${TABLA_ESTADO} WHERE clave = ? FOR UPDATE`;
// El valor va dos veces en vez de `VALUES(valor)`, que MySQL 8 marca como obsoleto.
const SQL_GUARDAR = `INSERT INTO ${TABLA_ESTADO} (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = ?`;

/** El código de un error, sin su mensaje (ver arriba). */
const codigoDe = (e) => (e && typeof e.code === "string" && /^[A-Z0-9_]+$/.test(e.code) ? e.code : "sin código");

/**
 * @param {{obtenerPool?: () => any, carpetaDisco: URL, hayMysql?: boolean,
 *          esperaMs?: number, log?: (m: string) => void}} opciones
 *   `carpetaDisco`: URL de carpeta, terminada en `/` (ej. `new URL("./data/", import.meta.url)`).
 *   `hayMysql`: si las variables de MySQL están configuradas. Sin ellas ni se intenta.
 * @returns {{celda: (clave: string) => {leer: Function, actualizar: Function},
 *            almacen: () => Promise<"mysql"|"disco">}}
 */
export function crearEstado({ obtenerPool, carpetaDisco, hayMysql = true, esperaMs = ESPERA_ARRANQUE_MS, log = console.log }) {
  const rutaDisco = (clave) => new URL(`${clave}.json`, carpetaDisco);
  let pool = null;

  // Se decide UNA vez, al primer uso, y no se cambia: alternar entre MySQL y disco
  // partiría el estado en dos mitades que no se ven.
  let decision = null;
  function almacen() {
    if (!decision) decision = decidir();
    return decision;
  }

  async function decidir() {
    if (!hayMysql || !obtenerPool) {
      log("[estado] sin variables de MySQL: cuotas y cola en disco. Se PIERDEN en cada despliegue.");
      return "disco";
    }
    let temporizador;
    try {
      pool = obtenerPool();
      const tarde = new Promise((_, rechazar) => {
        temporizador = setTimeout(() => rechazar(Object.assign(new Error("tiempo agotado"), { code: "TIEMPO_AGOTADO" })), esperaMs);
      });
      await Promise.race([pool.query(SQL_CREAR), tarde]);
      log(`[estado] cuotas y cola en MySQL (tabla ${TABLA_ESTADO}): sobreviven a los despliegues.`);
      return "mysql";
    } catch (e) {
      log(`[estado] MySQL no disponible (${codigoDe(e)}): cuotas y cola en disco. Se PIERDEN en cada despliegue.`);
      return "disco";
    } finally {
      clearTimeout(temporizador);
    }
  }

  // Dentro de un proceso, las escrituras de una misma clave van en fila (como en
  // store.mjs). El `FOR UPDATE` cubre además a otro proceso: durante un despliegue
  // pueden convivir un momento la versión vieja y la nueva.
  const colas = new Map();
  function enFila(clave, tarea) {
    const anterior = colas.get(clave) || Promise.resolve();
    const actual = anterior.then(tarea, tarea);
    colas.set(clave, actual.catch(() => {}));
    return actual;
  }

  async function leerMysql(clave, valorInicial) {
    const [filas] = await pool.query(SQL_LEER, [clave]);
    return filas.length ? JSON.parse(filas[0].valor) : valorInicial;
  }

  async function actualizarMysql(clave, valorInicial, mutador) {
    const conexion = await pool.getConnection();
    try {
      await conexion.beginTransaction();
      const [filas] = await conexion.query(SQL_LEER_BLOQUEANDO, [clave]);
      const datos = filas.length ? JSON.parse(filas[0].valor) : valorInicial;
      const nuevos = await mutador(datos);
      const json = JSON.stringify(nuevos);
      await conexion.query(SQL_GUARDAR, [clave, json, json]);
      await conexion.commit();
      return nuevos;
    } catch (e) {
      // Si el rollback también falla, el error que importa es el primero.
      await conexion.rollback().catch(() => {});
      throw e;
    } finally {
      conexion.release();
    }
  }

  /** Un valor con nombre, con el contrato de store.mjs pero sin ruta. */
  function celda(clave) {
    if (!/^[a-z0-9-]{1,64}$/.test(clave)) throw new Error(`clave de estado inválida: ${clave}`);
    return {
      async leer(valorInicial) {
        return (await almacen()) === "mysql"
          ? leerMysql(clave, valorInicial)
          : leerArchivo(rutaDisco(clave), valorInicial);
      },
      async actualizar(valorInicial, mutador) {
        return (await almacen()) === "mysql"
          ? enFila(clave, () => actualizarMysql(clave, valorInicial, mutador))
          : actualizarArchivo(rutaDisco(clave), valorInicial, mutador);
      },
    };
  }

  return { celda, almacen };
}
