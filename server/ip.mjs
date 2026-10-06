// Identidad del cliente para los límites de uso.
//
// POR QUÉ NO EL PRIMER VALOR DE `X-Forwarded-For`
// -----------------------------------------------
// El primer valor lo escribe el cliente: MEDIDO el 2026-09-21 que con un valor
// distinto en cada petición, todas pasaban el freno de ráfaga (ver limites.mjs).
// Un proxy confiable AGREGA al final la IP que él vio. Con N proxies confiables
// delante de Node, la IP real es la N-ésima contando desde la DERECHA; todo lo que
// quede a su izquierda lo puso el cliente y se ignora.
//
// SUPUESTO A VERIFICAR EN PRODUCCIÓN: que LiteSpeed agregue (no deje pasar tal cual)
// la IP al final. Si no lo hace, el último valor sigue siendo del cliente y esto no
// mejora ni empeora lo anterior. Se comprueba con `curl -H "X-Forwarded-For: 1.2.3.4"`
// y mirando que la IP resuelta NO sea 1.2.3.4. Ajustable con TRUSTED_PROXY_HOPS.

import net from "node:net";

export function saltosDeProxyConfiables(env = process.env, aviso = console.error) {
  const crudo = env.TRUSTED_PROXY_HOPS;
  if (crudo === undefined || crudo === "") return 1;
  const n = Number(crudo);
  if (Number.isInteger(n) && n >= 0 && n <= 10) return n;
  aviso("[ip] TRUSTED_PROXY_HOPS inválido (se espera un entero 0-10); se usa 1.");
  return 1;
}

export function obtenerIP(req, saltos = saltosDeProxyConfiables()) {
  const directa = req.socket?.remoteAddress || "desconocida";
  if (saltos === 0) return directa;
  const cabecera = req.headers["x-forwarded-for"];
  const crudo = Array.isArray(cabecera) ? cabecera.join(",") : cabecera;
  if (!crudo) return directa;
  const partes = crudo.split(",").map((p) => p.trim()).filter(Boolean);
  const candidata = partes[partes.length - saltos];
  // Solo se acepta una IP válida: un valor basura no debe terminar como clave de cuota.
  return candidata && net.isIP(candidata) ? candidata : directa;
}
