// Límites de uso del servidor público: el freno de ráfaga y la cuota diaria.
//
// Vivían dentro de app.mjs, que arranca el servidor al importarse y por eso no
// se podían probar. Aquí están aparte, con el reloj y la ruta inyectables.
//
// POR QUÉ HAY UN TOPE GLOBAL además del de por IP
// ------------------------------------------------
// Ambos límites identifican al cliente por `X-Forwarded-For`, y MEDIDO el
// 2026-09-21 contra api.datalexlab.com que ese header NO es confiable: con un
// valor distinto en cada petición, 12 de 12 pasaron el freno de ráfaga. La cuota
// diaria usa la misma clave, así que cada IP inventada trae una cuota nueva: se
// podía usar este servidor como intermediario sin tope hacia la Corte
// Constitucional y Socrata (se INFIERE; no se probó, porque probarlo consume
// cuota real y consulta a la Corte).
//
// El tope global no depende de la identidad del cliente, así que sigue valiendo
// aunque el header sea falsificable. Y acota también el tamaño del almacén de
// cuotas: solo las búsquedas que salen bien crean claves, y el tope limita
// cuántas puede haber por día.
//
// EL COSTO, dicho de frente: con un tope global, quien rote IPs puede AGOTARLO y
// dejar sin búsqueda en vivo a los demás visitantes por el resto del día. Es
// preferible a las alternativas —abuso sin tope de una fuente pública, o un
// almacén que crece sin límite— porque lo que se apaga es el complemento en vivo:
// el sitio sigue sirviendo el JSON pre-computado (SRS §5.2). Y deja de ser barato
// de hacer cuando se resuelva la identidad del cliente.

import { leer, actualizar } from "./store.mjs";

/**
 * Un número positivo de una variable de entorno; si no lo es, el valor por
 * defecto y un aviso visible. Antes: `Number(process.env.X || 5)`. Con un valor
 * mal pegado en el panel (el incidente del 2026-08-05 con ALLOWED_ORIGIN ya pasó
 * una vez) eso da NaN, y `usoActual >= NaN` es siempre falso: el límite quedaba
 * DESACTIVADO en silencio. Con "0" bloqueaba a todo el mundo.
 */
export function numeroDeEntorno(nombre, porDefecto, env = process.env, aviso = console.error) {
  const crudo = env[nombre];
  if (crudo === undefined || crudo === "") return porDefecto;
  const n = Number(crudo);
  if (Number.isFinite(n) && n > 0) return n;
  // NUNCA se imprime el valor: en el incidente del panel el texto pegado arrastró
  // `SECOP_MYSQL_HOST=...`, y si hubiera arrastrado una contraseña este aviso la
  // habría escrito en el log. Se dice cuál variable y cuánto mide, nada más.
  aviso(
    `[limites] ${nombre} no es un número positivo (el valor mide ${String(crudo).length} caracteres) ` +
    `y fue ignorado. Se usa ${porDefecto}. Revisa la variable en el panel de hosting.`
  );
  return porDefecto;
}

/* ------------------------------------------------------------------
   Freno de ráfaga: 10 peticiones por minuto por clave, en memoria
   ------------------------------------------------------------------ */

export const VENTANA_MS = 60_000;
export const LIMITE_VENTANA = 10;
// Cuántas claves puede tener el mapa antes de barrer las vencidas. Antes nunca
// se borraba ninguna, y cada IP inventada dejaba una entrada para siempre.
export const MAX_CLAVES_RAFAGA = 10_000;

export function crearLimiteDeRafaga({
  ventanaMs = VENTANA_MS,
  limite = LIMITE_VENTANA,
  maxClaves = MAX_CLAVES_RAFAGA,
  ahora = Date.now,
} = {}) {
  const historial = new Map();
  let ultimoBarrido = -Infinity;

  // Una clave cuya marca MÁS RECIENTE ya salió de la ventana no tiene nada vivo:
  // borrarla no cambia ninguna respuesta.
  function barrer(t) {
    for (const [clave, marcas] of historial) {
      if (t - marcas[marcas.length - 1] >= ventanaMs) historial.delete(clave);
    }
    ultimoBarrido = t;
  }

  return {
    /** Registra la petición y dice si esa clave ya pasó el límite en la ventana. */
    superado(clave) {
      const t = ahora();
      const vivas = (historial.get(clave) || []).filter((m) => t - m < ventanaMs);
      vivas.push(t);
      historial.set(clave, vivas);
      // A lo sumo un barrido por segundo: si todas las claves están vivas el barrido
      // no libera nada, y repetirlo en cada petición costaría O(n) cada vez.
      if (historial.size > maxClaves && t - ultimoBarrido >= 1000) barrer(t);
      return vivas.length > limite;
    },
    /** Para vigilarlo y para las pruebas. */
    tamano: () => historial.size,
  };
}

/* ------------------------------------------------------------------
   Cuota diaria: por IP y global, en el JSON de store.mjs
   ------------------------------------------------------------------ */

// Las claves son `${ip}:${dia}:${servicio}` y `global:${dia}:${servicio}`. La IP
// puede llevar `:` (IPv6: `::1`), así que el día se lee contando DESDE EL FINAL.
const esDeEseDia = (clave, dia) => clave.split(":").at(-2) === dia;

/**
 * @param {{ruta: string|URL, globales: Record<string, number>,
 *          ahora?: () => Date, aviso?: (m: string) => void}} opciones
 *        `globales` es el tope global por servicio, ej. { secop: 300, jurisprudencia: 600 }.
 */
export function crearLimiteDiario({ ruta, globales, ahora = () => new Date(), aviso = console.warn }) {
  const dia = () => ahora().toISOString().slice(0, 10); // el día UTC, como antes

  return {
    /**
     * Comprueba la cuota de esta IP y la global. NO consume nada: eso lo hace
     * `confirmar()`, y solo cuando la búsqueda salió bien (una consulta que falla
     * contra la fuente no le cuesta cuota a nadie, como antes).
     */
    async verificar(servicio, ip, limitePorIP) {
      const hoy = dia();
      const clave = `${ip}:${hoy}:${servicio}`;
      const claveGlobal = `global:${hoy}:${servicio}`;
      const datos = await leer(ruta, {});
      const usoActual = Number(datos[clave] || 0);
      const usoGlobal = Number(datos[claveGlobal] || 0);
      const limiteGlobal = globales[servicio];
      const globalAgotado = Number.isFinite(limiteGlobal) && usoGlobal >= limiteGlobal;
      const ipAgotada = usoActual >= limitePorIP;

      return {
        clave,
        usoActual,
        usoGlobal,
        limiteGlobal,
        alcanzado: globalAgotado || ipAgotada,
        // Cuál fue: la respuesta al usuario no es la misma ("alcanzaste tu límite"
        // frente a "se agotó el de hoy para todos").
        motivo: globalAgotado ? "global" : ipAgotada ? "ip" : null,
        /** Consume una búsqueda de la cuota de esta IP y de la global. */
        async confirmar() {
          const dHoy = dia();
          const nuevos = await actualizar(ruta, {}, (actuales) => {
            // Se descartan las claves de días anteriores: no sirven para nada
            // (el límite se reinicia cada día) y antes se acumulaban para siempre.
            const vigentes = {};
            for (const [k, v] of Object.entries(actuales)) if (esDeEseDia(k, dHoy)) vigentes[k] = v;
            vigentes[clave] = Number(vigentes[clave] || 0) + 1;
            vigentes[claveGlobal] = Number(vigentes[claveGlobal] || 0) + 1;
            return vigentes;
          });
          if (Number.isFinite(limiteGlobal) && nuevos[claveGlobal] === limiteGlobal) {
            // Una sola línea, cuando se alcanza: visible en los logs del hosting.
            aviso(`[limites] tope global diario de "${servicio}" alcanzado (${limiteGlobal}): ` +
                  `la búsqueda en vivo queda apagada hasta mañana (UTC).`);
          }
          return nuevos[clave];
        },
      };
    },
  };
}

/** El cuerpo del 429, según cuál límite se alcanzó. */
export function cuerpoLimiteDiario(motivo, limitePorIP, limiteGlobal) {
  if (motivo === "global") {
    return {
      error: "La búsqueda en vivo gratuita alcanzó su tope de hoy para todos los visitantes. Vuelve a intentarlo mañana.",
      limite_diario_global: limiteGlobal,
      busquedas_restantes_hoy: 0,
    };
  }
  return {
    error: "Alcanzaste el límite de búsquedas en vivo gratis por hoy.",
    limite_diario: limitePorIP,
    busquedas_restantes_hoy: 0,
  };
}
