# DataLex Lab

Blog personal de LegalTech (Juan Pablo Lopez Mejia) + proyecto de auditoría automatizada de
contratación pública (SECOP II), desplegados juntos en Netlify.

## Estructura

- `datalex_lab.html` — página principal del blog.
- `secop-clm.html` — dashboard del proyecto de auditoría SECOP II (Isolation Forest, red flags,
  concentración por sector/proveedor). Consume los JSON de `api/secop/`.
- `api/secop/*.json` — API estática: resultados ya calculados, sin backend. Se regeneran solos.
- `scripts/generar_json.py` — pipeline que ingiere datos de la API Socrata (Datos Abiertos
  Colombia, dataset `jbjy-vk9h`), limpia, calcula riesgo temporal y corre el modelo de anomalías.
- `.github/workflows/actualizar-secop.yml` — job programado (cron, cada 12 horas) que corre el
  pipeline y hace commit de los JSON actualizados. Netlify redespliega automáticamente con cada
  push (una vez conectado el repo).

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

## Nota sobre el esquema de datos

El dataset `jbjy-vk9h` **no** tiene un campo de fecha de liquidación real. La "desviación
temporal" se calcula a partir de `dias_adicionados` (días de plazo adicionados formalmente vía
otrosí/modificación), el campo real más cercano disponible en la API.
