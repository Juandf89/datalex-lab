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
- `bitacora/<slug>/index.html` — artículos del blog, generados desde Notion. No se editan a mano:
  los sobrescribe `scripts/generar_bitacora.mjs` en cada corrida.
- `api/secop/*.json` — API estática con los resultados ya calculados del pipeline de SECOP. Se
  regeneran solos cada hora.
- `api/bitacora/index.json` — índice de artículos publicados que consume `loadBitacora()` en
  `index.html`. `api/bitacora/estado.json` es el estado de sincronización (no tocar a mano).
- `assets/bitacora/` — imágenes de los artículos, rehospedadas desde Notion.
  `assets/og-datalexlab.png` es la imagen por defecto para compartir en redes.
- `scripts/generar_json.py` — pipeline que ingiere datos de la API Socrata (Datos Abiertos
  Colombia, dataset `jbjy-vk9h`), limpia, calcula riesgo temporal y corre el modelo de anomalías.
- `scripts/generar_bitacora.mjs` — generador de la Bitácora a partir de la base de datos de Notion
  (ver sección abajo).
- `server/` — Node.js Web App (Express) desplegado en `api.datalexlab.com`: búsqueda en vivo para
  SECOP y jurisprudencia, con estado (contadores de rate-limit, colas de absorción) en disco local.
- `.github/workflows/actualizar-secop.yml` — cron horario que corre el pipeline de SECOP y hace
  commit de los JSON actualizados solo si algo cambió realmente.
- `.github/workflows/actualizar-bitacora.yml` — cron cada 6 horas que sincroniza la Bitácora desde
  Notion. Comparte el grupo de `concurrency` con el de SECOP a propósito: los dos pushean a `main`.
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
- **Al escribir variables en el panel: valor crudo, sin comillas y una por campo.** Incidente real
  (2026-08-05): `ALLOWED_ORIGIN` quedó guardada como
  `'https://datalexlab.com'SECOP_MYSQL_HOST=srv1456.hstgr.io` — dos variables fusionadas y con
  comillas. El navegador rechazó la cabecera CORS y la búsqueda en vivo dejó de funcionar para todos
  los visitantes, mientras el servidor seguía respondiendo 200 sin ningún error en el log. Desde
  entonces `app.mjs` valida el origen al arrancar (`origenValido`): si no es un origen bien formado
  lo ignora, usa el valor por defecto y escribe un `[cors]` de error en el log. Tras cambiar
  variables hay que **reiniciar la app** para que Node relea el entorno.
- Migración a Hostinger confirmada estable (2026-08-08): `netlify.toml` y `netlify/functions/`
  eliminados del repo, ambos dominios sirven desde Hostinger (`platform: hostinger` en las
  cabeceras HTTP).

## Bitácora: Notion como editor, no como destino

Los artículos se escriben en Notion y se publican **dentro de datalexlab.com**, en
`/bitacora/<slug>`. Antes la tarjeta de la Bitácora redirigía a `notion.so`: el lector salía del
dominio, la vista previa al compartir la generaba Notion (título con sufijo "| Notion" y el nombre
del espacio de trabajo personal como `og:site_name`) y se perdían los parámetros UTM.

`scripts/generar_bitacora.mjs` consulta la base de datos de Notion, lee los bloques de cada página
publicada y escribe el HTML ya renderizado en el repo. Hostinger solo sirve archivos —no hay build
step en el hosting—, así que el HTML tiene que llegar commiteado, igual que los JSON de SECOP.

### La base de datos en Notion

Una fila por artículo. Los nombres de columna se buscan sin distinguir tildes ni mayúsculas, y
cada una acepta varios tipos (texto, select, status, etc.):

| Columna | Tipo sugerido | Para qué sirve |
|---|---|---|
| Nombre | Título | Título del artículo y, si no hay `Slug`, origen de la URL |
| Estado | Select o Status | Solo se publica lo que diga `Publicado` |
| Fecha | Fecha | Píldora de fecha en la tarjeta y `article:published_time` |
| Slug | Texto | Opcional. Si está, manda sobre el título |
| Autor | Texto, select o persona | Por defecto, `AUTOR_POR_DEFECTO` |
| Etiqueta | Texto o select | Línea en versalitas de la tarjeta. Por defecto, `AUTOR: <autor>` |
| Tipo | Select | `DOCUMENTO` o `VIDEO`; decide el ícono de la tarjeta |
| Descripción | Texto | Opcional. Si falta, se usa el primer párrafo del artículo |
| Portada | Archivo | Opcional. Manda sobre la portada de la página de Notion |

Si la base no tiene columna `Estado`, se publican todas las filas con título (y se avisa en el
log). Las filas sin título se ignoran.

### Puesta en marcha

1. Crear una integración interna en `notion.so/my-integrations` y copiar su token (`ntn_…`).
2. **Compartir la base de datos con la integración** desde el menú `···` de la página. Sin este
   paso la API devuelve 404 aunque la página sea pública en la web — es el error más común.
3. Guardar en los secrets del repo: `TOKEN_NOTION` y `NOTION_DATABASE_ID` (el ID es el bloque
   hexadecimal de la URL de la base). **Ningún token va versionado.**
4. Correr el workflow `Actualizar Bitácora desde Notion` a mano la primera vez.

### Qué se renderiza

Párrafo, encabezados 1 a 3, listas con y sin viñeta (incluidas anidadas), cita, código, divisor,
imagen y tabla; en línea, negrita, cursiva, enlace y código.

Las tablas respetan la cabecera de columna y de fila que traigan de Notion, y van dentro de un
contenedor con scroll horizontal propio: una tabla ancha no puede hacer que la página entera se
desplace en un teléfono.

Fuera de alcance en esta versión: bases de datos embebidas, columnas, toggles anidados y
ecuaciones. **No rompen el build**: se cuentan y se reportan en un `[info]` al final de la corrida,
y se omiten del HTML, nombrando el artículo donde aparecieron. Si uno de esos empieza a hacer
falta, se agrega un `case` en `renderBloque` **y se sube `VERSION_PLANTILLA`** — así se añadió
el soporte de tablas.

Todo el texto que sale de Notion pasa por `escaparHtml` antes de entrar al HTML, atributos
incluidos: el contenido viene de un editor y no puede inyectar marcado. Los enlaces con esquema
distinto de `http`, `https` o `mailto` se descartan y queda solo el texto. Un enlace interno de
Notion a otro artículo publicado se reescribe a su ruta en datalexlab.com.

### Imágenes: por qué se rehospedan

Notion firma las URLs de archivo y la firma caduca en ~1 hora. Un `<img>` apuntando ahí se ve bien
el día del build y aparece roto al siguiente. Se descargan en tiempo de build a
`assets/bitacora/<sha256-16>.<ext>`, con el nombre derivado del hash del **contenido**: la misma
imagen usada en dos artículos ocupa un solo archivo.

La clave de caché no es la URL completa (cambia en cada consulta por la firma) sino la URL sin
query string, que sí es estable. Por eso una segunda corrida no vuelve a bajar nada.

### Sincronización incremental e idempotencia

Correr el proceso dos veces seguidas no produce ni un byte de diferencia. Se regenera un artículo
solo si cambió su `last_edited_time` en Notion, cambió su slug, o subió `VERSION_PLANTILLA`.

**`VERSION_PLANTILLA` hay que subirla a mano cada vez que se toque la plantilla o el renderizador
de bloques.** El `last_edited_time` de Notion no cambia cuando el que cambia es nuestro código, así
que sin ese salto los artículos viejos se quedarían con el HTML antiguo. Verificado en desarrollo:
es exactamente lo que pasa si se olvida.

Ninguna salida lleva marca de tiempo de generación, y `estado.json` se serializa con las claves
ordenadas — si algo de eso cambia, la idempotencia se rompe y el cron empieza a commitear ruido
cada 6 horas.

### Qué pasa cuando algo falla

- **La API de Notion no responde, el token venció o la base se movió**: el script sale con código 1
  sin escribir nada. El job se detiene antes del commit y el sitio conserva los artículos que ya
  estaban publicados.
- **Falla una página concreta**: se conserva su HTML anterior y su entrada de estado, y el resto
  del lote sigue. Un artículo solo entra al índice si su archivo existe de verdad en disco, para
  que ninguna tarjeta apunte a un 404.
- **Un artículo cambia de slug**: la ruta vieja no se borra, se reemplaza por un stub de
  redirección (`meta refresh` + `canonical`), el mismo mecanismo de `datalex_lab.html`.
- **Un artículo sale de la base o deja de estar `Publicado`**: se retira del índice pero el HTML se
  conserva en disco, para no romper enlaces ya compartidos.

### Correr el generador en local

```bash
TOKEN_NOTION=ntn_... NOTION_DATABASE_ID=... node scripts/generar_bitacora.mjs
```

Para tocar la plantilla sin gastar llamadas a la API ni necesitar el token, hay un modo de prueba
con respuestas enlatadas: `BITACORA_FIXTURE_DIR` apuntando a una carpeta con `base.json` (la
respuesta de `/databases/{id}/query`) y `bloques/<id>.json` (la de `/blocks/{id}/children`).
`BITACORA_OUTPUT_DIR` permite escribir fuera del repo mientras se prueba.

Otras variables opcionales: `SITIO_BASE_URL`, `AUTOR_POR_DEFECTO`, `OG_IMAGE_DEFECTO`.

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
