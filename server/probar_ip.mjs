import { obtenerIP, saltosDeProxyConfiables } from "./ip.mjs";

let fallos = 0;
function afirmar(nombre, ok) {
  console.log(`${ok ? "  ok " : "  FALLA"} ${nombre}`);
  if (!ok) fallos++;
}
const req = (xff, remota = "127.0.0.1") => ({
  headers: xff === undefined ? {} : { "x-forwarded-for": xff },
  socket: { remoteAddress: remota },
});

console.log("=== obtenerIP: el cliente no elige su identidad ===");
afirmar("sin header: la IP del socket", obtenerIP(req(undefined, "10.1.1.1"), 1) === "10.1.1.1");
afirmar("un proxy agregó la IP real", obtenerIP(req("203.0.113.7"), 1) === "203.0.113.7");
afirmar("el cliente inventó una IP: gana la que agregó el proxy",
  obtenerIP(req("1.2.3.4, 203.0.113.7"), 1) === "203.0.113.7");
afirmar("muchos valores inventados: sigue ganando el último",
  obtenerIP(req("1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.7"), 1) === "203.0.113.7");
afirmar("dos proxies confiables: se salta uno desde la derecha",
  obtenerIP(req("1.2.3.4, 203.0.113.7, 10.0.0.2"), 2) === "203.0.113.7");
afirmar("valor basura: cae a la IP del socket", obtenerIP(req("no-es-una-ip"), 1) === "127.0.0.1");
afirmar("cabecera con menos valores que saltos: cae al socket", obtenerIP(req("203.0.113.7"), 2) === "127.0.0.1");
afirmar("0 saltos ignora el header", obtenerIP(req("1.2.3.4"), 0) === "127.0.0.1");
afirmar("IPv6 válida se acepta", obtenerIP(req("2001:db8::1"), 1) === "2001:db8::1");

console.log("\n=== TRUSTED_PROXY_HOPS ===");
const avisos = [];
const av = (m) => avisos.push(m);
afirmar("sin variable: 1", saltosDeProxyConfiables({}, av) === 1);
afirmar("valor válido", saltosDeProxyConfiables({ TRUSTED_PROXY_HOPS: "2" }, av) === 2);
afirmar("0 es válido", saltosDeProxyConfiables({ TRUSTED_PROXY_HOPS: "0" }, av) === 0);
afirmar("basura: 1 y avisa", saltosDeProxyConfiables({ TRUSTED_PROXY_HOPS: "abc" }, av) === 1 && avisos.length === 1);
afirmar("negativo: 1", saltosDeProxyConfiables({ TRUSTED_PROXY_HOPS: "-1" }, av) === 1);

if (fallos) { console.error(`\n${fallos} fallo(s)`); process.exit(1); }
console.log("\ntodo bien");
