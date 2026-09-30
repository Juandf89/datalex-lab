#!/usr/bin/env bash
# Copia la consola de LATIO desde su repositorio fuente (TOOL-KIT-CIIVL,
# toolkit-api/index.html) a latio/index.html, que es lo que sirve
# datalexlab.com/latio/. La fuente es siempre el otro repositorio: aquí no se
# edita la consola a mano, o el próximo sincronizado la pisa.
#
# Solo toca el archivo de destino y solo si cambió. Antes de copiar comprueba
# que lo descargado sea de verdad la consola (una página de error de GitHub, un
# archivo truncado o una consola apuntando a otra API no deben llegar a
# producción). Si algo falla, sale con código 1 sin escribir nada y el sitio
# conserva la consola que ya tenía.
#
# Variables (todas opcionales; los valores por defecto son los de producción):
#   REPO_FUENTE    repositorio de origen                (Juandf89/TOOL-KIT-CIIVL)
#   RUTA_FUENTE    ruta del archivo dentro del origen   (toolkit-api/index.html)
#   DESTINO        archivo que se actualiza             (latio/index.html)
#   ARCHIVO_LOCAL  usar este archivo en vez de descargar (solo para pruebas)
set -euo pipefail

REPO_FUENTE="${REPO_FUENTE:-Juandf89/TOOL-KIT-CIIVL}"
RUTA_FUENTE="${RUTA_FUENTE:-toolkit-api/index.html}"
DESTINO="${DESTINO:-latio/index.html}"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

fallar() {
  echo "::error::$1"
  exit 1
}

if [ -n "${ARCHIVO_LOCAL:-}" ]; then
  cp "$ARCHIVO_LOCAL" "$tmp"
  sha="local"
else
  # Se fija el commit y se descarga ESE commit: si alguien empuja al origen
  # entre las dos lecturas, no se mezclan versiones. ls-remote no consume el
  # límite de la API de GitHub.
  sha="$(git ls-remote "https://github.com/${REPO_FUENTE}.git" refs/heads/main | cut -f1)"
  [ -n "$sha" ] || fallar "no se pudo leer la rama main de ${REPO_FUENTE}"
  curl -fsS --retry 3 --retry-delay 5 -o "$tmp" \
    "https://raw.githubusercontent.com/${REPO_FUENTE}/${sha}/${RUTA_FUENTE}" \
    || fallar "no se pudo descargar ${RUTA_FUENTE} de ${REPO_FUENTE}@${sha}"
fi

tamano="$(wc -c < "$tmp")"
[ "$tamano" -gt 20000 ] || fallar "el archivo descargado pesa solo ${tamano} bytes; no parece la consola"
head -c 200 "$tmp" | grep -qi '<!doctype html' || fallar "el archivo descargado no es un documento HTML"
grep -q 'id="connection-status-pill"' "$tmp" || fallar "el archivo descargado no tiene la estructura de la consola"
grep -q "const PRODUCTION_API_BASE = 'https://api-latio.datalexlab.com';" "$tmp" \
  || fallar "la consola descargada no apunta a la API de producción (api-latio.datalexlab.com)"

# Las dos copias se comparan sin los CR: en Windows git puede dejar CRLF.
if [ -f "$DESTINO" ] && diff -q <(tr -d '\r' < "$DESTINO") <(tr -d '\r' < "$tmp") > /dev/null; then
  echo "La consola de LATIO ya está al día (${REPO_FUENTE}@${sha:0:7})."
  cambio=0
else
  cp "$tmp" "$DESTINO"
  echo "Consola de LATIO actualizada desde ${REPO_FUENTE}@${sha:0:7}."
  cambio=1
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "cambio=${cambio}"
    echo "sha=${sha:0:7}"
  } >> "$GITHUB_OUTPUT"
fi
