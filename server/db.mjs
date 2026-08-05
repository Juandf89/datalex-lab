// Pool de conexión a la base MySQL del tier gratuito (separada de la que use
// el servicio de pago, ver docs/plan-evolucion-plataforma.md del repo
// privado). Este servidor vive en el mismo hosting que la base de datos, así
// que puede usar el mismo host que GitHub Actions (Remote MySQL "Any Host")
// sin el salto extra de una conexión pública — connectionLimit bajo a
// propósito: un pico de tráfico gratuito no debe agotar conexiones que
// necesite el servicio de pago en la misma cuenta de Hostinger.
import mysql from "mysql2/promise";

let pool;

export function obtenerPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.SECOP_MYSQL_HOST,
      port: Number(process.env.SECOP_MYSQL_PORT || 3306),
      user: process.env.SECOP_MYSQL_USER,
      password: process.env.SECOP_MYSQL_PASSWORD,
      database: process.env.SECOP_MYSQL_DATABASE,
      connectionLimit: 3,
      waitForConnections: true,
      charset: "utf8mb4",
    });
  }
  return pool;
}
