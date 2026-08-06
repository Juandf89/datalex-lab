// Semáforo de salud contractual por entidad (verde/amarillo/rojo).
//
// Decisión de producto (2026-08-05): semáforo de 3 estados, no un puntaje
// 0-100 — se lee de un vistazo en una reunión y no finge una precisión que
// las señales de abajo no respaldan.
//
// Los umbrales NO son números absolutos, a propósito: se expresan como
// múltiplos de la tasa global de alertas del histórico acumulado. Una tasa
// absoluta ("más del 8% es rojo") quedaría obsoleta sola, porque depende de
// la contaminación configurada en el Isolation Forest y del tamaño del
// histórico, que crece en cada corrida del cron. Comparar contra la propia
// distribución del dataset se mantiene válido con el tiempo.

const MULTIPLO_AMARILLO = Number(process.env.SEMAFORO_MULTIPLO_AMARILLO || 1);
const MULTIPLO_ROJO = Number(process.env.SEMAFORO_MULTIPLO_ROJO || 2);

// Por debajo de esto, la tasa de una entidad es ruido: con 2 contratos, una
// sola alerta da 50% y pintaría rojo sin significar nada. Es más honesto
// decir "no hay datos suficientes" que mostrar un color inventado.
const MINIMO_EVALUADOS = 5;

/**
 * @param {{evaluados: number, alertas: number, tasaGlobalAlertas: number}} datos
 * @returns {{estado: 'verde'|'amarillo'|'rojo'|'sin_datos', tasa: number|null, tasa_global: number, explicacion: string}}
 */
export function clasificarSalud({ evaluados, alertas, tasaGlobalAlertas }) {
  const totalEvaluados = Number(evaluados) || 0;
  const totalAlertas = Number(alertas) || 0;
  const tasaGlobal = Number(tasaGlobalAlertas) || 0;

  if (totalEvaluados < MINIMO_EVALUADOS) {
    return {
      estado: "sin_datos",
      tasa: null,
      tasa_global: tasaGlobal,
      explicacion:
        `Solo hay ${totalEvaluados} contrato(s) analizables de esta entidad — ` +
        "muy pocos para decir algo confiable sobre su comportamiento.",
    };
  }

  const tasa = totalAlertas / totalEvaluados;

  // Sin alertas en todo el histórico no hay contra qué comparar: se cae a un
  // criterio absoluto simple en vez de dividir por cero.
  const referencia = tasaGlobal > 0 ? tasaGlobal : null;

  let estado;
  if (referencia === null) {
    estado = tasa > 0 ? "amarillo" : "verde";
  } else if (tasa > referencia * MULTIPLO_ROJO) {
    estado = "rojo";
  } else if (tasa > referencia * MULTIPLO_AMARILLO) {
    estado = "amarillo";
  } else {
    estado = "verde";
  }

  const porcentaje = (tasa * 100).toFixed(1);
  const porcentajeGlobal = (tasaGlobal * 100).toFixed(1);
  const explicaciones = {
    verde:
      `${porcentaje}% de sus contratos tienen alertas, en línea o por debajo del ` +
      `promedio general (${porcentajeGlobal}%).`,
    amarillo:
      `${porcentaje}% de sus contratos tienen alertas, por encima del promedio ` +
      `general (${porcentajeGlobal}%). Vale la pena mirar de cerca.`,
    rojo:
      `${porcentaje}% de sus contratos tienen alertas, muy por encima del promedio ` +
      `general (${porcentajeGlobal}%).`,
  };

  return { estado, tasa, tasa_global: tasaGlobal, explicacion: explicaciones[estado] };
}
