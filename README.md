# DataLex Lab

Blog personal de LegalTech (Juan Pablo Lopez Mejia) + proyecto de auditoría automatizada de
contratación pública (SECOP II), desplegados juntos en Netlify.

## Estructura

- `datalex_lab.html` — página principal del blog. `_redirects` reescribe `/` hacia este archivo
  (sin cambiar la URL) para no mantener dos copias idénticas (`index.html` + `datalex_lab.html`)
  sincronizadas a mano — ya divergieron una vez y causó un bug real.
- `secop-clm.html` — dashboard del proyecto de auditoría SECOP II (Isolation Forest, red flags,
  concentración por sector/proveedor). Consume los JSON de `api/secop/`.
- `api/secop/*.json` — API estática: resultados ya calculados, sin backend. Se regeneran solos.
- `scripts/generar_json.py` — pipeline que ingiere datos de la API Socrata (Datos Abiertos
  Colombia, dataset `jbjy-vk9h`), limpia, calcula riesgo temporal y corre el modelo de anomalías.
- `.github/workflows/actualizar-secop.yml` — job programado (cron, cada hora) que corre el
  pipeline y hace commit de los JSON actualizados solo si algo cambió. Netlify redespliega
  automáticamente con cada push (una vez conectado el repo).

## Arquitectura: API estática ("Ruta A")

En vez de un backend que llame a Socrata en cada visita (dependiente de la disponibilidad de un
tercero y del *throttling* anónimo), el pipeline corre en GitHub Actions —independiente de
cualquier máquina personal— y publica los resultados como archivos JSON versionados. El sitio
estático en Netlify solo los lee por `fetch()`. Si Socrata falla en una corrida, el sitio sigue
sirviendo el último resultado bueno en vez de romperse.

## Actualizar manualmente

Desde la pestaña **Actions** del repo en GitHub → *Actualizar datos SECOP II* → *Run workflow*.

## Correr el pipeline en local

```bash
pip install -r scripts/requirements.txt
python scripts/generar_json.py
```

Variables de entorno opcionales:

- `SOCRATA_APP_TOKEN` — token gratuito de [datos.gov.co](https://www.datos.gov.co/) para evitar el
  *throttling* anónimo. Configúralo como secret del repo (`Settings → Secrets and variables →
  Actions`) para que el workflow lo use.
- `SOCRATA_MAX_REGISTROS` — tamaño de la muestra ingerida (por defecto 5000).
- `OUTPUT_DIR` — carpeta de salida de los JSON (por defecto `./api/secop`).

## Absorber búsquedas en vivo (pendientes-secop)

Cuando alguien busca una entidad/contrato que no está en la muestra local, `secop-clm.html`
consulta `netlify/functions/fallback-secop.mjs`, que busca en vivo sobre todo Datos Abiertos
Colombia y guarda cada resultado en el store `pendientes-secop` (Netlify Blobs). El workflow
recoge esos contratos con `scripts/absorber_pendientes_secop.mjs` (Node) antes de correr
`generar_json.py`, y los borra del store solo si la fusión al histórico terminó bien.

Requiere dos secrets adicionales del repo (`Settings → Secrets and variables → Actions`):

- `NETLIFY_SITE_ID` — ID del sitio en Netlify (`Site configuration → General → Site details`).
- `NETLIFY_AUTH_TOKEN` — token personal de Netlify con acceso al sitio (`User settings →
  Applications → Personal access tokens`).

Sin estos dos secrets configurados, este paso simplemente no hace nada — el resto del pipeline
(ingesta normal de Socrata) sigue funcionando igual. **No verificado contra un store real en esta
sesión** (sin credenciales disponibles para probar) — la lógica se validó con un store simulado y
con la API documentada del SDK, pero conviene confirmar con una corrida manual real (`Actions →
Run workflow`) una vez configurados los secrets, antes de confiar en que el borrado funciona en
producción.

## Nota sobre el esquema de datos

El dataset `jbjy-vk9h` **no** tiene un campo de fecha de liquidación real. La "desviación
temporal" se calcula a partir de `dias_adicionados` (días de plazo adicionados formalmente vía
otrosí/modificación), el campo real más cercano disponible en la API.
