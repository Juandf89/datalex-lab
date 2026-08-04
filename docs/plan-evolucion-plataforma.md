# Plan de evolución: de dashboard estático a plataforma LegalTech

**Estado de ejecución:** Fase 1 (Expediente + Benchmarking) y Fase 2 (grafo de
jurisprudencia) implementadas y verificadas en navegador — ver detalle al final de
cada sección de fase. Ejecutado con una rejilla de validación fija por fase (ver
sección 6).

## 1. Motivación

El dashboard SECOP II actual (Isolation Forest sobre contratación pública) es estático:
gráficas agregadas, sin exploración interactiva, sin impacto real medible en la
comunidad. Este plan traza cómo evolucionarlo, junto con un nuevo servicio de
jurisprudencia basado en grafos, hacia una plataforma con capas gratuita y de pago,
manteniendo el principio original de la arquitectura: **el uptime del sitio público
nunca depende de una máquina personal**.

## 2. Arquitectura actual ("Ruta A")

- Netlify sirve `datalex-lab` (repo público `Juandf89/datalex-lab`) como sitio
  estático, sin build step.
- GitHub Actions corre `scripts/generar_json.py` cada 12h: ingiere SECOP II
  (`jbjy-vk9h` vía Socrata), corre Isolation Forest, escribe JSON estáticos en
  `api/secop/`, comitea y pushea solo si los datos cambian.
- El frontend hace `fetch()` client-side de esos JSON — cero backend en tiempo real.

**Verificado en esta sesión (dashboard de Netlify, periodo Jul 8–Ago 7 2026):**
136 de 300 créditos del plan Free consumidos, 9 deploys de producción (135 créditos),
bandwidth y compute casi nulos. Margen real disponible antes de necesitar plan pago:
~135-150 créditos/mes.

## 3. Hoja de ruta por fases

### Auditoría de puntos ciegos del pipeline SECOP (2026-08-03)

Motivada por una pregunta directa: "si el número de contratos analizados no cambia
tras cada corrida del cron, y buscar por palabra clave es más fácil que por
contrato, ¿qué más se nos está escapando en `generar_json.py`?" Se encontraron y
corrigieron **dos bugs de correctitud encadenados**, no solo uno:

1. **`ingerir()` traía el mismo slice congelado en cada corrida.** Verificado
   empíricamente: dos llamadas idénticas a Socrata (`limit=5000, offset=0`, sin
   `$order`) devolvieron exactamente los mismos registros en el mismo orden. El
   dataset fuente sí se actualiza en vivo (`rowsUpdatedAt` de hoy), pero
   `ingerir()` nunca se lo pedía. Primer intento de arreglo:
   `order='fecha_de_firma DESC'` + `where='fecha_de_firma IS NOT NULL'`.
2. **Ese primer arreglo expuso un segundo problema, peor:** SECOP recibe miles de
   contratos firmados por día, así que "los 5000 más recientes por fecha de
   firma" quedaban casi todos concentrados en 1-2 días — y un contrato recién
   firmado normalmente **no tiene aún fecha de inicio/fin**, así que
   `limpiar()` los descartaba después. Verificado: solo el **10.9%** sobrevivía,
   dejando ~516 registros útiles en una ventana de 2 días — muestra demasiado
   pequeña y poco diversa para el modelo de Isolation Forest. **Arreglo final:**
   mover el filtro de completitud (`fecha_de_inicio_del_contrato IS NOT NULL`,
   `fecha_de_fin_del_contrato IS NOT NULL`, `valor_del_contrato IS NOT NULL`) a
   la propia consulta a Socrata, no como limpieza posterior — verificado: ahora
   sobrevive el **100%**, con una ventana fresca de ~5 días y 24 sectores
   distintos representados, en vez de 2 días y una muestra sesgada.

**Lección:** un fix que soluciona la corrección obvia (datos congelados) puede
introducir un problema más sutil (datos frescos pero incompletos/sesgados) si no
se verifica el efecto de extremo a extremo — no basta con confirmar que el dato
"cambia", hay que confirmar que sigue siendo *utilizable* tras el resto del
pipeline.

**Rediseño a acumulación real + cron horario (2026-08-03):** motivado por la
pregunta "¿de verdad no podemos aumentar la frecuencia del cron?". Se encontró,
vía historial real de Actions/commits del repo, que **el 100% de las corridas
del cron generaban un deploy**, sin importar si los contratos realmente
cambiaban — porque `resumen.json` llevaba un timestamp que siempre difiere.
Proyección real: a 12h eso ya son ~900 créditos Netlify/mes (por encima del
plan gratis); a cada hora, ~10,800 créditos/mes — insostenible.

**Arreglo de raíz:** `generar_json.py` ahora acumula en vez de reemplazar
(`historico_contratos.json`, fusionado por `id_contrato` en cada corrida, igual
principio que el grafo de jurisprudencia) y calcula un hash de contenido antes
y después de fusionar — solo escribe un `generado_en` nuevo si el acumulado
**de verdad** cambió. Esto significa: "contratos analizados" ahora crece con el
tiempo en vez de resetearse cada corrida, y el costo de subir la frecuencia del
cron pasó a depender de cuántas corridas encuentran datos genuinamente nuevos,
no de la frecuencia en sí. Cron actualizado a cada hora en
`.github/workflows/actualizar-secop.yml`.

**Bug encontrado y corregido durante la verificación:** la primera versión del
hash comparaba `historico` (recién cargado de disco) contra `df` (recién
fusionado en memoria) — verificado con dos corridas reales seguidas, mismos
3000 contratos, cero campos distintos campo por campo, pero el hash igual
marcaba "cambio" por una diferencia de tipos de datos introducida por el propio
`pd.concat`, no por datos reales. Arreglado comparando ambos lados después de
guardar y releer el histórico (mismo pipeline de carga en los dos lados).
Verificado con tres corridas reales: sin cambios → `False` y mismo
`generado_en`; con una ventana más grande → `True` y el acumulado crece
correctamente (3000 → 3500).

**Fallback de SECOP también escribe a `pendientes-secop`** (Netlify Blobs).

**✅ Absorción implementada (2026-08-03):** `scripts/absorber_pendientes_secop.mjs` (Node, con
`@netlify/blobs` en modo manual — `siteID`/`token`, ver `scripts/package.json`) corre en
`.github/workflows/actualizar-secop.yml` antes de `generar_json.py`, en dos fases (`fetch` /
`confirm`) para no perder registros si algo falla a la mitad. `generar_json.py` fusiona lo
absorbido con `cargar_pendientes_absorbidos()`, mismo tratamiento que el backfill (pasa por
`limpiar()`/`calcular_desviacion_temporal()`).

- **Bug real encontrado y corregido en el camino:** `fallback-secop.mjs` solo guardaba 6 campos
  curados (para la tarjeta del frontend) en `pendientes-secop`, sin `fecha_de_inicio_del_contrato`
  ni `fecha_de_fin_del_contrato`. Verificado con un registro sintético: con ese esquema,
  `limpiar()` no descartaba el registro con gracia — **crasheaba con `KeyError`**, lo que habría
  tumbado toda la corrida horaria la primera vez que se absorbiera una búsqueda en vivo. Corregido
  guardando el registro crudo completo de Socrata (mismo esquema que `ingerir()`) en vez del
  curado; reverificado con el mismo registro sintético — sobrevive `limpiar()` completo.
- **Bug real encontrado y corregido en el script Node:** la primera versión de `modoFetch` asumía
  paginación por `cursor` (`store.list({ cursor })`), pero el SDK instalado no tiene ese campo —
  la paginación real es un iterable asíncrono (`for await (const pagina of store.list({ paginate:
  true }))`), verificado contra `node_modules/@netlify/blobs/dist/main.d.ts`. Con el código
  original solo se habría leído la primera página, perdiendo pendientes en silencio si alguna vez
  hubiera más de una página. Corregido y revalidada la lógica completa (paginación, fetch, confirm,
  borrado, limpieza de archivos locales) contra un store simulado en memoria.
- **No verificado contra un store real de Netlify Blobs** (sin `NETLIFY_SITE_ID`/
  `NETLIFY_AUTH_TOKEN` reales disponibles en esta sesión) — antes de confiar en esto en producción,
  configurar esos dos secrets del repo y correr el workflow manualmente una vez
  (`Actions → Run workflow`) para confirmar que la lectura/borrado real funciona.
- **Gap de jurisprudencia (`pendientes-jurisprudencia`) sigue sin implementar** — mismo patrón,
  pendiente de replicar si se decide priorizarlo.

**Fallback de búsqueda por palabra clave (SECOP):** `netlify/functions/fallback-secop.mjs`
— mismo patrón que el de jurisprudencia (rate limiting nativo + contador diario en
Blobs), pero más simple: Socrata devuelve JSON directo vía `$q` (texto completo
sobre *todo* el dataset en vivo, no solo la muestra local), sin necesitar parseo
de HTML. Verificado con Node real contra el sitio en vivo. `secop-clm.html`
actualizado con el mismo flujo de debounce + fallback que `jurisprudencia.html`,
verificado en navegador (regresión de coincidencia local + fallo con gracia sin
función real desplegada).

### Fase 1 — Expediente de Contratación + Benchmarking (SECOP freemium, des-estaticizar)
- **Qué:** exponer el detalle por contrato (entidad, presupuesto, plazos, estado) como
  tarjeta navegable vía búsqueda/autocompletar client-side (Fuse.js). Extender
  `por_sector`/`por_anio` con dispersión y comparativos (benchmarking).
- **Costo:** ~$0 adicional. Reutiliza 100% los datos que ya ingiere el cron de 12h;
  solo se agregan JSON nuevos (`por_entidad.json`, detalle por contrato).
- **Por qué primero:** resuelve la queja original ("muy estático") sin tocar
  arquitectura ni presupuesto de créditos.
- **✅ Implementado y verificado (2026-08-03):** `construir_por_entidad` y
  `construir_expediente_contratos` en `scripts/generar_json.py`; buscador
  (Fuse.js, `ignoreLocation: true`), tarjeta de expediente y scatter de
  benchmarking en `secop-clm.html`. Probado en navegador con datos sintéticos
  (borrados del repo tras la prueba) — búsqueda, tarjeta de entidad/contrato y
  gráfico funcionando sin errores de consola. Bug encontrado y corregido en el
  camino: el CDN de Fuse.js (`fuse.js@7`) resolvía al build ESM, no al global —
  corregido a `fuse.js@7/dist/fuse.min.js`.

### Fase 2 — Grafo de jurisprudencia (Corte Constitucional) + rate limiting
- **Qué:** scraper batch (mismo patrón de cron) sobre `/relatoria/` de la Corte
  Constitucional → extrae texto + citas → construye `grafo_citas.json` (nodos =
  sentencias, aristas = citas, in-degree = relevancia). Búsqueda client-side
  (Fuse.js) sobre un índice de temas; grafo explorado con Cytoscape.js/D3-force.
- **Validado en esta sesión:**
  - `robots.txt` de corteconstitucional.gov.co permite explícitamente `/relatoria/`.
  - Páginas de sentencias son HTML plano, sin JS, con decenas de citas parseables
    por regex (`T-719 de 2003`, `C-355/06`, etc.).
- **Fallback en vivo (opcional, para cobertura de temas no indexados):** función
  serverless que hace **una sola consulta** (no grafo recursivo) cuando el índice
  local no tiene resultados; cada resultado de fallback se cachea y se promueve al
  próximo batch para no repetir el scrape.
- **Rate limiting freemium (aplica también a Fase 3):** contador por IP/día en
  Netlify Blobs o Upstash Redis (free tier), N búsquedas gratis/24h, sin necesidad
  de cuenta de usuario para este límite básico.
- **Costo estimado:** +60-110 créditos/mes de Netlify (deploy semanal + compute del
  fallback + bandwidth extra) — sumado a lo de Fase 1, proyecta ~220-275
  créditos/mes, probablemente aún dentro del plan Free.
- **✅ Implementado y verificado (2026-08-03):**
  `scripts/generar_grafo_jurisprudencia.py` (scraper real, no solo exploratorio) +
  `.github/workflows/actualizar-jurisprudencia.yml` (cron semanal, lunes 07:00 UTC,
  con cursor de fecha para avanzar incrementalmente sin re-scrapear el histórico) +
  `jurisprudencia.html` (buscador Fuse.js + grafo Cytoscape.js + panel de detalle),
  enlazada desde "Proyectos" en `datalex_lab.html`.
  - Antes de escribir el script se confirmó con una petición real que el buscador
    de la Corte permite navegar por rango de fechas sin término de búsqueda,
    devolviendo una tabla `[Providencia, F.Sentencia, Tema/Resumen, F.Publicación]`
    — de ahí sale el índice temático sin visitar cada sentencia individualmente.
  - Prueba real acotada (10 sentencias, ventana de 10 días, con pausa entre
    requests): 434 nodos y 456 aristas construidos correctamente; nodos más
    citados fueron sentencias SU (unificación), consistente con lo esperado.
  - Bug encontrado y corregido: el `threshold`/`distance` por defecto de Fuse.js
    fallaba en buscar palabras que aparecen después del carácter ~100 de un texto
    largo (confirmado: "ICETEX" en la posición 94 de un tema real no se
    encontraba) — corregido con `ignoreLocation: true` (aplicado también en
    Fase 1 por consistencia, aunque ahí el riesgo era bajo).
  - Encoding verificado correcto (UTF-8 válido) — un "�" visto en la terminal de
    Windows al imprimir fue solo un artefacto de la consola, no un bug real.
  - **✅ Fallback en vivo + rate limiting implementados (2026-08-03):**
    `netlify/functions/fallback-jurisprudencia.mjs` — una sola consulta (no
    recursiva) al buscador real cuando el índice local no tiene resultados,
    con doble capa de protección: (1) rate limiting nativo de Netlify (10
    req/60s por IP+dominio, vía `export const config`) para frenar ráfagas, y
    (2) contador propio en Netlify Blobs para el límite de N búsquedas
    gratis/día (variable `LIMITE_DIARIO_JURISPRUDENCIA`, default 5). Cada
    resultado del fallback se cachea en el store `pendientes-jurisprudencia`
    para que el próximo cron batch lo absorba sin repetir el scrape en vivo.
    `jurisprudencia.html` ya llama a `/api/fallback-jurisprudencia?q=...` con
    debounce de 600ms cuando la búsqueda local no encuentra nada, muestra
    "búsquedas restantes hoy" y maneja el 429 (límite alcanzado) con un
    mensaje claro, no un muro silencioso.
    - **Corrección importante encontrada al investigar:** Netlify Functions
      solo soporta JS/TS/Go, no Python — por eso este archivo está en
      JavaScript (`cheerio` para parsear HTML, equivalente a BeautifulSoup),
      separado del scraper batch en Python.
    - **Verificado:** la función `extraerResultados` (parseo HTML → resultados)
      se probó con Node real contra el HTML guardado de una consulta real a la
      Corte — 102 resultados extraídos correctamente, con el mismo criterio de
      normalización de ID que el scraper Python (`T-021-25` → `T-21-2025` en
      ambos). El flujo completo del frontend (coincidencia local, debounce,
      fallo con gracia cuando no hay función real corriendo) se verificó en
      navegador sin errores de consola.
    - **No verificado todavía (requiere `netlify dev` o despliegue real, no
      hecho en esta sesión):** la escritura/lectura real de Netlify Blobs y el
      rate limiting nativo en producción. Antes de confiar en esto en vivo,
      correr `netlify dev` localmente o probar en un despliegue de preview.
    - **Tres bugs de correctitud más encontrados y corregidos en
      `scripts/generar_grafo_jurisprudencia.py` (2026-08-03), en la misma
      auditoría que encontró los de SECOP:**
      1. **Cada corrida sobrescribía el índice/grafo completo** con solo lo de
         esa corrida, en vez de fusionar con lo ya existente — el progreso de
         corridas anteriores se perdía cada semana. El grafo nunca habría
         crecido más allá de lo último procesado.
      2. **El cursor arrancaba en 1992 y avanzaba hacia adelante.** Con ~50
         sentencias por corrida semanal, la jurisprudencia reciente (lo que un
         usuario realmente busca) habría tardado años en aparecer. Invertido:
         ahora arranca en HOY y retrocede hacia 1992.
      3. **Pérdida silenciosa de datos dentro de una ventana:** si una ventana
         de fechas tenía más resultados que el presupuesto de la corrida
         (frecuente — verificado: una ventana de 10 días trajo 95-102
         sentencias, muy por encima de las 50 procesables), el resto se perdía
         para siempre porque el cursor avanzaba igual. Ahora se guardan como
         `pendientes` en `cursor.json` y se procesan primero en la siguiente
         corrida, antes de abrir una ventana nueva.
      - **Verificado con corridas reales repetidas** (no solo una): 2 corridas
        consecutivas confirmaron fusión correcta (5 + 5 = 10 en el índice
        acumulado, no reseteado), manejo correcto de pendientes (97 → 92,
        decrementando sin perder registros) y que el cursor no avanza la
        ventana hasta agotar los pendientes.
    - **Gap conocido, no cerrado todavía:** el store `pendientes-jurisprudencia`
      que escribe el fallback en vivo sigue sin ser consumido por el script
      batch — requeriría que el script en Python (GitHub Actions) lea Netlify
      Blobs vía su API REST (necesita `NETLIFY_SITE_ID`/`NETLIFY_AUTH_TOKEN`
      como secretos de GitHub), no implementado por no poder probarse sin
      credenciales reales en esta sesión.
    - **Bug real encontrado y corregido (2026-08-03):** la primera versión del
      fallback usaba `searchOption=prov_sentencia` (búsqueda por **número** de
      sentencia, ej. "T-388 DE 2019") para búsquedas por **tema** — por eso
      "arrendamiento comercial" no devolvía nada, sin importar que la función
      estuviera desplegada o no. Se confirmó abriendo el sitio real en un
      navegador con JS activo, capturando la petición POST real que dispara el
      botón "Ejecutar búsqueda" (`FormData` de `#myFormSearch` →
      `searchOption=texto`, `POST` a `/relatoria/buscador_new//index.php` con
      campos `fini/ffin/verform/slop/buscador/qu/maxprov`, distintos de los
      usados en la navegación por rango de fechas del scraper batch). Corregido
      y reverificado en vivo: la misma búsqueda ahora devuelve 7 resultados
      reales y correctos (incluyendo `C-409-2020`, sobre terminación unilateral
      de arrendamiento comercial). Lección: no asumir que un mismo endpoint
      usa el mismo conjunto de parámetros para modos de búsqueda distintos —
      hay que observar la petición real del sitio, no solo reusar un patrón
      validado en otro contexto.

### Revisión exhaustiva de copy en las páginas freemium (2026-08-03)

Motivada por retroalimentación directa: las descripciones de los gráficos de
SECOP y del grafo de jurisprudencia no se explicaban bien. Aplica
[[feedback-public-copy-style]] (ya documentado en memoria: evitar jerga técnica,
la audiencia es de abogados, no de ingenieros) de forma sistemática en ambas
páginas:

- **"Isolation Forest" aparecía dos veces en `secop-clm.html`** (intro del
  header y descripción de "Red Flags") sin ninguna explicación — reemplazado
  por lenguaje de resultado ("señalamos automáticamente los contratos que se
  salen del comportamiento normal").
- **"similar al mecanismo detrás de Shepard's/KeyCite"** en `jurisprudencia.html`
  — una referencia a productos legales estadounidenses que nadie en la
  audiencia real (Colombia) reconocería. Reemplazado por una explicación
  directa de qué significa el tamaño del nodo.
- Cada descripción de gráfico se reescribió para explicar **por qué le importa
  al usuario**, no solo qué datos muestra (ej. "Concentración por sector" pasó
  de "valor total adjudicado por sector" a explicar qué se puede inferir de
  eso).
- El "Puntaje de anomalía" (número crudo del modelo, ilegible sin contexto) se
  convirtió en una pregunta con respuesta en español plano: "¿Es un contrato
  atípico? Sí/No, dentro o fuera de lo esperado para su sector" — derivado del
  signo del puntaje (negativo = atípico, por convención de Isolation Forest),
  sin exponer el número ni el nombre del algoritmo.
- "Red Flag" → "Alerta" / "Alerta de alto riesgo" en toda la interfaz de SECOP,
  consistente con el título de la sección.
- "Subgrafo" → "mapa de sentencias relacionadas" en jurisprudencia.

**Bug real encontrado en el camino (no de copy, de funcionalidad):** al
rediseñar `generar_json.py` para acumular (ver más arriba), los nombres de
campos de `resumen.json` cambiaron (`ingeridos`/`limpios` →
`ingeridos_esta_corrida`/`acumulados_total`) pero **el frontend nunca se
actualizó** — `cargarResumen()` en `secop-clm.html` seguía leyendo los campos
viejos, lo que habría roto el dashboard completo (mostrando "no se pudo cargar
el resumen") en el próximo despliegue. Corregido y verificado.

**Verificado en navegador:** ambas páginas cargan sin errores de consola con
los nuevos textos; la tarjeta de expediente muestra el nuevo lenguaje plano
correctamente para una entidad real de prueba.

**Los 5 gráficos de SECOP ahora reaccionan a la búsqueda (2026-08-03):**
motivado por retroalimentación directa — antes, buscar una entidad o contrato
solo actualizaba la tarjeta de texto; los gráficos (sector, tendencia anual,
proveedores, benchmarking, alertas) seguían mostrando el agregado global sin
importar qué se buscara, lo cual le quitaba sentido a la mejora de búsqueda.

- Se agregó `proveedor` a `expediente_contratos.json` (antes no existía a nivel
  de contrato individual, solo agregado en `top_proveedores.json`) para poder
  cruzar contrato ↔ proveedor.
- Cada uno de los 5 gráficos ahora guarda su instancia de Chart.js y sus datos
  crudos en un objeto de estado compartido (`graficos`), y una selección en el
  buscador dispara `aplicarSeleccion(item)`, que:
  - Resalta la barra del sector correspondiente (`sectorChart`) y atenúa el resto.
  - Resalta el punto del año correspondiente (`anioChart`) — solo para
    selección de contrato específico (una entidad puede tener contratos en
    varios años, no hay un único año que resaltar).
  - Resalta la barra del proveedor si aparece en el top 10 (`proveedoresChart`)
    — igual, solo para contrato específico.
  - Agrega un dataset resaltado con los contratos de la entidad seleccionada
    sobre el `benchmarkChart` existente, sin quitar el contexto del resto.
  - Filtra la lista y el scatter de alertas de alto riesgo a solo esa entidad,
    con un mensaje claro si no tiene ninguna ("X no tiene contratos marcados
    como alerta de alto riesgo").
  - Un control "✕ Ver todos" limpia el filtro y regresa las 5 vistas a su
    estado agregado original.
- **Verificado en navegador** con datos sintéticos coordinados (mismo sector,
  año y proveedor reales que ya existían en los JSON agregados committeados):
  seleccionar una entidad resaltó correctamente su sector y sus contratos en
  el benchmarking, y filtró la lista de alertas a solo sus propios casos;
  seleccionar un contrato específico además resaltó su año y su proveedor;
  "Ver todos" restauró los 5 gráficos a su estado original. Sin errores de
  consola.

### Fase 3 — Buscador semántico + monetización
- **Buscador semántico (Producto 1):** embeddings del objeto contractual (SECOP) y/o
  descriptores de sentencias (grafo), generados en el batch job.
  - **Proveedor recomendado: Voyage AI** — 200 millones de tokens gratis al crear
    cuenta (~400k documentos). Alternativa: OpenAI `text-embedding-3-small`
    ($0.02/millón de tokens).
  - **Costo real estimado:** con ~5,000 contratos y reindexación cada 12h, ~30M
    tokens/mes — dentro de la capa gratuita de Voyage por meses, o ~$0.60/mes con
    OpenAI. Las búsquedas de usuarios (10-20 tokens c/u) son insignificantes.
  - **Conclusión de costo:** el cuello de botella no es el proveedor de embeddings
    (barato/gratis), es la ingeniería (función serverless + caché + rate limit).
- **Netlify Pro (~$19-20/mes, 3,000 créditos):** NO es requisito técnico para llamar
  a un proveedor de embeddings (cualquier función, incluso en Free, hace esa
  llamada HTTP). Solo se vuelve necesario si el conjunto de crons + tráfico +
  features apiladas supera el presupuesto de 300 créditos del plan Free — evaluar
  cuando se acerque el límite real, no de antemano.
- **Pagos (botones premium):**
  - **Stripe descartado como opción directa:** verificado que no tiene soporte
    oficial para comercios colombianos (requiere condiciones especiales, típicamente
    cuenta bancaria en EE.UU.).
  - **Recomendado: procesador colombiano nativo** (Wompi, ePayco o PayU) — settlement
    en COP, sin entidad extranjera. *Pendiente: decidir cuál de los tres entre Wompi
    y ePayco.*
  - **Diseño:** usar un link/checkout hospedado por el proveedor (no un formulario de
    tarjeta custom) — evita tocar datos de tarjeta y minimiza el alcance de
    cumplimiento PCI.
  - **Modelo de precio:** paquete o suscripción (ej. "$5/mes ilimitado"), no
    microcobros de $1 — la comisión de un procesador (~2.9% + cargo fijo) hace que
    cobrar $1 por unidad sea económicamente malo.
- **Autenticación de usuarios premium:**
  - Sin contraseña (magic link por correo) — evita almacenar contraseñas.
  - **Netlify Identity** es una opción nativa viable (verificado en esta sesión:
    Netlify anunció su descontinuación pero la revirtió en febrero 2026 — sigue
    soportado). Alternativa con más funcionalidad: Supabase Auth.
- **Seguridad — idempotencia:**
  - Toda creación de sesión/link de pago debe llevar un `Idempotency-Key` único
    (derivado de la sesión del usuario) para que un doble clic o reintento de red no
    genere cobro duplicado.
  - El webhook que confirma el pago debe ser idempotente: verificar el ID del evento
    antes de otorgar acceso premium, para no activarlo dos veces por el mismo pago.
- **UX/UI de estos incrementos:**
  - Botón de pago con estados explícitos (cargando / éxito / error).
  - Indicador visible de "X búsquedas gratis restantes hoy" antes de tocar el límite.
  - Página de confirmación post-pago que active el acceso premium de inmediato.

### Fase 4 — Radar de Oportunidades y Alertas (pospuesto)
- **Por qué al final:** es el único producto que rompe la arquitectura de raíz —
  necesita cuentas de usuario con criterios guardados, un job que compare snapshots
  por usuario, y envío de correos (costo por email). Deja de ser "sitio estático" y
  pasa a ser un SaaS con estado persistente. Posponer hasta validar tracción real de
  las fases anteriores.

### Fase 5 — Expansión de jurisprudencia a otras altas cortes (no comprometida aún)
- **Hallazgos de esta sesión:**
  - No existe dato abierto integral para Corte Suprema ni Consejo de Estado (solo
    datasets puntuales en datos.gov.co, ej. "Jurisprudencia Indígena del Consejo de
    Estado" — no sirven como corpus general).
  - **CENDOJ** (`jurisprudencia.ramajudicial.gov.co`) ofrece búsqueda unificada real
    sobre Corte Suprema, Corte Constitucional, Consejo de Estado, Sala Disciplinaria
    y Comisión Nacional de Disciplina Judicial — un solo objetivo técnico en vez de
    4+ scrapers distintos.
  - **PoC validado en esta sesión:** CENDOJ es JSF+PrimeFaces (no una SPA con API
    REST). El mecanismo de ViewState/postback **es replicable con `requests` puro,
    sin headless browser** — confirmado con una búsqueda real ("estabilidad laboral
    reforzada") que devolvió resultados correctos, incluyendo un campo
    "Descriptor-Restrictor" con temas ya curados por juristas (simplifica el índice
    de búsqueda, no hace falta generar resúmenes con NLP). Script de referencia:
    `scripts/poc_cendoj.py`.
  - Ni `jurisprudencia.ramajudicial.gov.co` ni cortesuprema.gov.co ni
    consejodeestado.gov.co publican `robots.txt` (zona gris — a diferencia de la
    Corte Constitucional, que permite `/relatoria/` explícitamente).
- **Recomendación antes de escalar:** escribir a `info.cendoj@ramajudicial.gov.co`
  (contacto oficial encontrado en el sitio) preguntando por un canal de datos
  masivos/API antes de construir el scraper de producción — más legítimo para un
  producto comercial que scrapear en zona gris, y podría ahorrar el trabajo de
  ingeniería si la respuesta es positiva.

### Tarjetas de resumen: bug de esquema + rediseño de la tarjeta de Isolation Forest (2026-08-03)

- **Bug real encontrado:** el `resumen.json` real committeado todavía tiene el
  esquema viejo (`ingeridos`/`limpios`, de antes del rediseño de acumulación),
  mientras `cargarResumen()` ya esperaba `acumulados_total` — esto habría roto
  las tarjetas superiores ("Datos no disponibles") en la ventana entre
  desplegar el código nuevo y que corra el próximo cron real. Corregido con
  una cadena de fallback (`acumulados_total ?? limpios ?? ingeridos ?? 0`) y
  verificado con ambos esquemas (viejo → degrada mostrando el dato disponible
  sin romperse; nuevo → funciona completo).
- **Rediseño de las tarjetas:** ninguna de las 4 tarjetas superiores muestra ya
  un conteo o valor derivado de "alertas"/"anomalías" — esa pregunta se
  responde en contexto (tarjeta de expediente + lista de alertas ya filtrada
  por entidad), no como número flotante desconectado de cualquier búsqueda.
  Se quitaron, en dos rondas de la misma retroalimentación: "Contratos
  atípicos detectados" (Isolation Forest) y luego "Alertas de alto riesgo" +
  "Valor en riesgo (COP)" (ambas derivadas del mismo agregado de red flags).
  Las 4 tarjetas finales son puramente de escala/cobertura, sin relación con
  ninguna búsqueda específica: **Contratos analizados (acumulado)**,
  **Entidades que puedes buscar** (`entidades_distintas`), **Valor total en la
  muestra (COP)** (`valor_total_acumulado_cop`, suma de *todos* los contratos,
  no solo los marcados de riesgo) y **Sectores cubiertos**
  (`sectores_distintos`). Los tres campos nuevos se agregaron a `resumen.json`
  en `scripts/generar_json.py`.

### Congruencia de datos: 4 problemas reales encontrados y corregidos (2026-08-03)

Motivado por retroalimentación directa cuestionando la credibilidad de las
cifras mostradas. Los cuatro puntos eran reales, no percepción:

1. **Ambigüedad "B"/"M" al estilo inglés.** `formatoCOP` dividía entre `1e9` y
   ponía sufijo "B" — en español un billón es 10¹², no 10⁹ como el "billion"
   inglés. Una cifra de prueba (812 mil millones) se mostraba como "$812.0B",
   que cualquier lector hispanohablante leería como 812 billones — 1000 veces
   más de lo real. Corregido escribiendo la escala explícita: "mil millones"
   / "millones" / "billones", sin abreviaturas ambiguas.
2. **Cifras grandes sin rango de fechas.** "Valor total en la muestra" no
   decía de cuándo a cuándo, haciendo la cifra imposible de contrastar contra
   una referencia real (ej. el Presupuesto General de la Nación). Se agregó
   `fecha_firma_min`/`fecha_firma_max` a `resumen.json` y un subtítulo visible
   bajo las tarjetas relevantes con el rango real cubierto.
3. **Isolation Forest no conectado a la búsqueda por entidad.** La conexión de
   Fase 3 (cross-filtering) ya cubría selección de contrato específico, pero
   al buscar una **entidad** (el caso más común) no se mostraba nada sobre
   contratos atípicos. Se agregó `resumenAtipicosEntidad()` en
   `secop-clm.html`, calculado en el cliente a partir de los contratos ya
   cargados — sin tocar el backend.
4. **La causa de fondo, la más grave: "Tendencia anual" y la concentración por
   sector/proveedor no eran reales.** `ingerir()` solo pide "lo más
   reciente", y como SECOP recibe miles de contratos/día, el histórico
   acumulado quedaba (y se quedaría para siempre) concentrado en apenas un
   par de semanas — los años anteriores nunca se volvían a consultar. Para
   veedores públicos, la concentración de la contratación es precisamente lo
   que hay que poder ver evolucionar en el tiempo, y no lo hacía.
   - **Arreglo real (no cosmético):** un mecanismo de backfill histórico
     independiente (`ingerir_backfill()`, `cursor_backfill.json`), que en cada
     corrida retrocede una ventana adicional en el histórico real (verificado:
     hay datos completos desde 2015-06), aparte de la ventana de frescura que
     ya existía. Arranca en hoy y retrocede hacia 2015; al llegar ahí, reinicia
     desde hoy (el merge por `id_contrato` hace que reprocesar algo ya
     conocido no cause daño).
   - **Bug propio encontrado al verificar (no asumido, medido):** la primera
     versión de `ingerir_ventana_historica` usaba `order="fecha_de_firma
     DESC"` — con una ventana ancha (180 días) y un límite menor al volumen
     real de esa ventana, eso devuelve los registros más **recientes** dentro
     de la ventana, no los más viejos — confirmé con una corrida real que una
     ventana de 180 días con `DESC` solo trajo del 2026-07-29 al 2026-07-31,
     ni un día más atrás. Cambiado a `order="fecha_de_firma ASC"` y
     reverificado: la misma ventana ahora sí llega hasta 2026-02-04 (el
     extremo viejo real).
   - **Verificado con dos corridas reales consecutivas:** el histórico
     acumulado pasó de cubrir solo 2026 a cubrir 2025 y 2026 genuinamente
     (1000 contratos de cada año), con el cursor retrocediendo correctamente
     (2026-02-04 → 2025-08-08). Con la cadencia horaria ya configurada, el
     histórico completo (2015-2026) se cubriría en cuestión de días, no de
     meses.

### Nombres truncados en "Riesgo de concentración" (2026-08-03)

Los nombres de proveedor se cortaban a 28 caracteres con "…" — para un veedor
público, el nombre completo del proveedor es justo el dato que necesita, no
algo prescindible. Corregido: `envolverTexto()` parte el nombre en varias
líneas (Chart.js acepta un array de strings como etiqueta) en vez de truncar;
el nombre completo también se agregó como título del tooltip. Verificado
visualmente con nombres largos reales (ej. "UNION TEMPORAL SALUD Y BIENESTAR
PARA TODOS LOS COLOMBIANOS" en 3 líneas) — se lee completo, sin cortes.

## 4. Pendientes de decisión (antes de programar Fase 3 en adelante)

- [ ] Elegir Wompi vs. ePayco como procesador de pago.
- [ ] Confirmar límites de timeout de funciones síncronas/background en Netlify Pro
      (no se pudo verificar el detalle exacto en esta sesión).
- [ ] Verificar implicaciones fiscales/DIAN de recibir pagos recurrentes por un
      servicio digital antes de activar cualquier cobro.
- [ ] Redactar y enviar el correo a CENDOJ antes de iniciar la Fase 5.
- [ ] Definir el número exacto de búsquedas gratis/día para el rate limiting.

## 5. Principio rector

Cada fase se evalúa contra el mismo criterio que se usó en esta sesión: verificar
antes de asumir (robots.txt, estructura real del sitio, consumo real de créditos,
soporte real de un proveedor) en vez de diseñar sobre supuestos.
