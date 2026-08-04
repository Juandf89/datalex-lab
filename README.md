# DataLex Lab

Blog personal de LegalTech (Juan Pablo Lopez Mejia) + dos proyectos aplicados de Legal Engineering:
auditoría automatizada de contratación pública (SECOP II) y exploración en vivo de jurisprudencia
constitucional. Desplegado en Hostinger.

## Estructura

- `index.html` — página principal del blog (contenido real, único). `datalex_lab.html` es solo un
  stub de redirección (`meta refresh` + `canonical` a `/`) para no romper enlaces/bookmarks
  externos viejos.
- `secop-clm.html` — dashboard de auditoría SECOP II (Isolation Forest, red flags, benchmarking
  valor/duración con filtro por sector, concentración por sector/proveedor). Consume los JSON
  estáticos de `api/secop/` y llama en vivo a `server/app.mjs` cuando busca algo fuera de la muestra.
- `jurisprudencia.html` — explorador de jurisprudencia constitucional. Sin índice acumulado a
  propósito (ver sección abajo): cada búsqueda consulta la Relatoría de la Corte Constitucional
  en tiempo real, por tema o por número de sentencia.
- `api/secop/*.json` — API estática con los resultados ya calculados del pipeline de SECOP. Se
  regeneran solos cada hora.
- `scripts/generar_json.py` — pipeline que ingiere datos de la API Socrata (Datos Abiertos
  Colombia, dataset `jbjy-vk9h`), limpia, calcula riesgo temporal y corre el modelo de anomalías.
- `server/` — Node.js Web App (Express) desplegado en `api.datalexlab.com`: búsqueda en vivo para
  SECOP y jurisprudencia, con estado (contadores de rate-limit, colas de absorción) en disco local.
- `.github/workflows/actualizar-secop.yml` — cron horario que corre el pipeline de SECOP y hace
  commit de los JSON actualizados solo si algo cambió realmente.
- `.htaccess` — bloquea acceso público a `scripts/`, `server/`, `netlify/`, `.github/`, `docs/` en
  el hosting estático (el deploy por Git copia el repo completo a `public_html`).

## Despliegue (Hostinger)

- **Sitio estático** (`datalexlab.com`): deploy por Git desde este repo, auto-deploy en cada push.
- **Backend de búsqueda en vivo** (`api.datalexlab.com`): Node.js Web App, root directory `server/`,
  entry file `app.mjs`. Corre detrás del módulo `lsnode` de LiteSpeed — escucha por socket Unix
  (`process.env.LSNODE_SOCKET`), no por un puerto TCP fijo.
- Variables de entorno del backend: `ABSORBER_TOKEN` (autentica los endpoints `/internal/*` que usa
  GitHub Actions), `ALLOWED_ORIGIN` (`https://datalexlab.com`, para CORS), `SOCRATA_APP_TOKEN`
  (opcional), `LIMITE_DIARIO_SECOP` / `LIMITE_DIARIO_JURISPRUDENCIA` (opcionales).
- `netlify.toml` y `netlify/functions/` se mantienen temporalmente como respaldo de la migración
  (el sitio ya no corre en Netlify) — se eliminan una vez confirmada la estabilidad en Hostinger.

## SECOP II: pipeline de datos

`scripts/generar_json.py` corre cada hora vía GitHub Actions:

1. **Ingesta**: trae los contratos más recientes de Socrata con filtros de completitud aplicados
   en la consulta misma (no después), y excluye `tipo_de_contrato` = "Prestación de servicios" o
   "Decreto 092 de 2017" — ambas son la misma categoría real (contratación de personas naturales
   para apoyo/servicios profesionales) bajo dos etiquetas distintas; verificado que es el 88.7% de
   los contratos por conteo pero solo el 40.7% del valor, así que distorsiona más de lo que aporta
   a un modelo de riesgo.
2. **Backfill histórico**: además de la ventana reciente, retrocede 5 ventanas de 90 días por
   corrida hacia atrás en el tiempo (hasta 2015) — GitHub Actions no dispara el cron programado con
   la puntualidad configurada (verificado: corridas reales cada ~2-3h, no cada hora), así que se
   compensa cubriendo más terreno por corrida en vez de depender de la frecuencia nominal.
3. **Filtro de valores implausibles**: descarta contratos cuyo `valor_del_contrato` es un outlier
   estadístico extremo (> 50x el percentil 99.9 de la muestra) — encontrado en producción un
   contrato real con valor de 6.45 cuatrillones de COP (error de digitación en el dato fuente de
   SECOP), que por sí solo inflaba el total de su año varios órdenes de magnitud.
4. **Modelo**: Isolation Forest sobre desviación temporal, valor, duración y sector, para señalar
   contratos que se salen de lo normal para su categoría.

## Búsqueda en vivo y absorción (`server/app.mjs`)

Cuando alguien busca una entidad/contrato de SECOP que no está en la muestra local, el frontend
llama a `/fallback-secop`, que consulta en vivo **todo** Datos Abiertos Colombia (no solo la
muestra) y guarda el resultado en una cola interna (`pendientes-secop`, JSON en disco). El cron de
GitHub Actions recoge esa cola con `scripts/absorber_pendientes_secop.mjs` (HTTP, autenticado con
`ABSORBER_TOKEN`) antes de correr `generar_json.py`, y confirma el borrado solo si la fusión al
histórico terminó bien — así lo que la gente busca se vuelve parte de la base acumulada, no se
pierde. Diseño en dos fases (fetch/confirm) para no perder datos si el proceso falla a mitad de
camino.

## Jurisprudencia: por qué no hay índice acumulado

A diferencia de SECOP, el explorador de jurisprudencia **no mantiene un grafo de citas acumulado**
— decisión de producto: el servicio se consume directo de la Relatoría de la Corte Constitucional
en cada búsqueda, por tema o por número de sentencia, sin necesidad de acumular información.

- Búsqueda por tema → `GET /fallback-jurisprudencia?q=...` (texto completo, en vivo).
- Búsqueda por número (ej. `T-388-2019`) o "explorar" una sentencia citada → `GET
  /jurisprudencia/grafo?id=...` — el servidor resuelve la URL directamente (los números de
  sentencia siguen una convención de citación fija: mínimo 3 dígitos, ej. `T-021-19`, verificado
  contra URLs reales), trae el texto y extrae sus citas con regex. Cada búsqueda solo revela el
  vecindario directo de una sentencia (ella + lo que cita) — no hay conteo global de "veces citada"
  ni efecto de citas-de-citas, porque eso requeriría escanear todo el corpus.

Queda anotado para una fase futura del proyecto (cuando sí tenga sentido acumular): recuperar el
conteo global de citas y la red completa de citas-de-citas.

## Correr el pipeline de SECOP en local

```bash
pip install -r scripts/requirements.txt
python scripts/generar_json.py
```

Variables de entorno opcionales: `SOCRATA_APP_TOKEN` (evita el *throttling* anónimo),
`SOCRATA_MAX_REGISTROS`, `DIAS_POR_LOTE_BACKFILL`, `MAX_REGISTROS_BACKFILL`,
`ITERACIONES_BACKFILL_POR_CORRIDA`, `OUTPUT_DIR`.

## Notas sobre calidad de datos

- El dataset `jbjy-vk9h` **no** tiene un campo de fecha de liquidación real. La "desviación
  temporal" se calcula a partir de `dias_adicionados` (días de plazo adicionados formalmente vía
  otrosí/modificación), el campo real más cercano disponible en la API.
- `scripts/purgar_contaminacion_historica.py` es un script de mantenimiento de una sola vez (ya
  corrido) que limpió del histórico acumulado los contratos "Decreto 092 de 2017" que se colaron
  antes de corregir el filtro de exclusión.
