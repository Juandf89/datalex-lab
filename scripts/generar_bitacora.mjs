// Corre en GitHub Actions (Node 20+), no en el runtime del servidor — genera
// las páginas de la Bitácora dentro de datalexlab.com a partir de la base de
// datos de Notion, y las commitea al repo para que el conector Git de
// Hostinger las publique. Mismo patrón que el pipeline de SECOP: el cron
// produce un artefacto estático, lo commitea, y el hosting solo sirve archivos
// (no hay build step en Hostinger, así que el HTML tiene que existir ya hecho).
//
// Notion queda como EDITOR, no como destino: se leen los bloques de cada
// página publicada y se renderizan como HTML propio en
// /bitacora/<slug>. Las tarjetas del índice dejan de apuntar a notion.so.
//
// Decisiones que no son obvias al leer el código:
//
// - Las imágenes se rehospedan. Notion firma las URLs de archivo y la firma
//   caduca en ~1 hora: un <img> apuntando ahí se queda en blanco al día
//   siguiente. Se descargan en tiempo de build y se guardan como
//   assets/bitacora/<sha256-16>.<ext>. La clave de caché NO es la URL completa
//   (cambia en cada consulta por la firma) sino la URL sin query string, que sí
//   es estable.
//
// - Idempotencia real: correr esto dos veces seguidas no produce ni un byte de
//   diferencia. Por eso no hay ninguna marca de tiempo de generación en la
//   salida y estado.json se serializa con las claves ordenadas.
//
// - Fallo con gracia: si la consulta al índice falla, el script no escribe NADA
//   y sale con error — el sitio conserva la última versión publicada. Si falla
//   una página concreta, se conserva su HTML anterior y su entrada de estado, y
//   el resto del lote sigue. Un artículo solo entra al índice si su HTML existe
//   de verdad en disco, para que ninguna tarjeta apunte a un 404.
//
// - Si el slug de un artículo cambia, la ruta vieja no se borra: se reemplaza
//   por un stub de redirección (meta refresh + canonical), el mismo mecanismo
//   que ya usa datalex_lab.html para no romper enlaces compartidos.
//
// Variables de entorno: TOKEN_NOTION y NOTION_DATABASE_ID son obligatorias
// (secrets del repo, nunca versionadas). Opcionales: SITIO_BASE_URL,
// BITACORA_OUTPUT_DIR, AUTOR_POR_DEFECTO, OG_IMAGE_DEFECTO.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

const RAIZ = process.env.BITACORA_OUTPUT_DIR || ".";
const SITIO_BASE = (process.env.SITIO_BASE_URL || "https://datalexlab.com").replace(/\/$/, "");
const NOMBRE_SITIO = "DataLex Lab";
const AUTOR_DEFECTO = process.env.AUTOR_POR_DEFECTO || "Juan Pablo Lopez Mejia";
const OG_DEFECTO = process.env.OG_IMAGE_DEFECTO || "assets/og-datalexlab.png";

const DIR_ARTICULOS = path.join(RAIZ, "bitacora");
const DIR_IMAGENES = path.join(RAIZ, "assets", "bitacora");
const DIR_API = path.join(RAIZ, "api", "bitacora");
const RUTA_INDICE = path.join(DIR_API, "index.json");
const RUTA_ESTADO = path.join(DIR_API, "estado.json");

// Subir este número fuerza la regeneración de TODOS los artículos aunque no
// hayan cambiado en Notion. Hay que hacerlo cada vez que se toque la plantilla
// o el renderizador de bloques, o los artículos viejos se quedarían con el
// HTML antiguo (la sincronización incremental mira last_edited_time, que no
// cambia cuando el que cambia es nuestro código).
const VERSION_PLANTILLA = 2;

const MAX_BYTES_IMAGEN = 15 * 1024 * 1024;
// Umbral de aviso, no de rechazo. Notion sirve las portadas al tamaño
// original: una foto de Unsplash entra a 4000 px y 1,2 MB, que es peso de
// más en la página, en la vista previa al compartir, y para siempre en el
// historial de git. Se avisa para poder cambiarla en origen.
const AVISO_BYTES_IMAGEN = 400 * 1024;
const LARGO_DESCRIPCION = 155;

// Bloques que esta primera versión no renderiza a propósito (tablas, bases
// embebidas, columnas, toggles, ecuaciones). No revientan el build: se anotan
// aquí para poder reportarlos al final en un solo resumen en vez de un log por
// bloque.
// tipo de bloque -> (título del artículo -> cuántas veces). Se guarda el
// artículo, no solo el tipo: saber que "hay una tabla" sin saber dónde obliga a
// abrir los tres artículos en Notion para encontrarla.
const bloquesOmitidos = new Map();

function anotarOmitido(tipo, titulo) {
  if (!bloquesOmitidos.has(tipo)) bloquesOmitidos.set(tipo, new Map());
  const porArticulo = bloquesOmitidos.get(tipo);
  porArticulo.set(titulo, (porArticulo.get(titulo) || 0) + 1);
}

// ---------------------------------------------------------------------------
// Utilidades de texto
// ---------------------------------------------------------------------------

// El contenido viene de un editor: todo lo que salga de Notion pasa por aquí
// antes de entrar al HTML, incluido lo que va dentro de atributos (de ahí que
// se escapen también comillas simples y dobles).
function escaparHtml(texto) {
  return String(texto ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function slugificar(texto) {
  const base = String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base.length <= 80) return base;
  // Se corta en frontera de palabra: un slug partido a mitad de palabra
  // ("...del-secreto-profesion") se lee como una errata en la barra de
  // direcciones.
  const cortado = base.slice(0, 80);
  const ultimoGuion = cortado.lastIndexOf("-");
  return (ultimoGuion > 40 ? cortado.slice(0, ultimoGuion) : cortado).replace(/-+$/g, "");
}

// Recorta en frontera de palabra para que la meta description no termine a
// media palabra.
function recortar(texto, maximo) {
  const limpio = String(texto ?? "").replace(/\s+/g, " ").trim();
  if (limpio.length <= maximo) return limpio;
  const cortado = limpio.slice(0, maximo);
  const ultimoEspacio = cortado.lastIndexOf(" ");
  return (ultimoEspacio > maximo * 0.6 ? cortado.slice(0, ultimoEspacio) : cortado).replace(/[.,;:\s]+$/, "") + "…";
}

// Solo esquemas navegables. Bloquea javascript:, data: y vbscript: que un
// enlace pegado en Notion podría traer.
function urlSegura(url) {
  if (!url) return null;
  try {
    const u = new URL(url, "https://www.notion.so");
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:") return u.href;
  } catch {
    return null;
  }
  return null;
}

// Los ids de Notion aparecen con y sin guiones según el endpoint; se comparan
// siempre normalizados.
function normalizarId(id) {
  return String(id ?? "").replace(/-/g, "").toLowerCase();
}

function jsonEstable(valor) {
  // Claves ordenadas para que el archivo no cambie de un run a otro solo
  // porque el objeto se construyó en otro orden — requisito de idempotencia.
  return JSON.stringify(valor, (_, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
    }
    return v;
  }, 2) + "\n";
}

function escribirSiCambia(ruta, contenido) {
  if (existsSync(ruta) && readFileSync(ruta, "utf-8") === contenido) return false;
  mkdirSync(path.dirname(ruta), { recursive: true });
  writeFileSync(ruta, contenido, "utf-8");
  return true;
}

// ---------------------------------------------------------------------------
// Cliente de la API de Notion
// ---------------------------------------------------------------------------

function credenciales() {
  // El secret del repo se llama TOKEN_NOTION; se acepta NOTION_TOKEN como
  // alias por si alguien lo exporta con el nombre que usa la documentación
  // oficial al correr esto en local.
  const token = (process.env.TOKEN_NOTION || process.env.NOTION_TOKEN || "").trim();
  const baseDatos = normalizarIdBase(process.env.NOTION_DATABASE_ID);
  if (!token || !baseDatos) {
    throw new Error(
      "faltan TOKEN_NOTION y/o NOTION_DATABASE_ID — se configuran como secrets del repo, nunca en el código",
    );
  }
  return { token, baseDatos };
}

// El ID de la base se copia a mano de la URL de Notion, y en la práctica llega
// de todo: la URL entera, el `?v=<vista>` pegado detrás, comillas alrededor, o
// un salto de línea del portapapeles. Notion responde a eso con un 400
// `invalid_request_url` que no dice nada útil (y en GitHub Actions el valor sale
// enmascarado como ***, así que ni se ve qué se mandó). Aquí se extrae el ID de
// verdad y, si no aparece, se falla con un mensaje que sí orienta.
function normalizarIdBase(valor) {
  const crudo = String(valor ?? "").trim().replace(/^['"]|['"]$/g, "");
  if (!crudo) return "";

  // Si viene una URL con vista, el ID es el que va ANTES del `?v=`; hay que
  // descartar la query primero o se acabaría cogiendo el id de la vista.
  const sinQuery = crudo.split("?")[0];
  const candidatos = sinQuery.match(/[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}/g);

  if (!candidatos) {
    throw new Error(
      `NOTION_DATABASE_ID no contiene un identificador válido (recibidos ${crudo.length} caracteres). ` +
      "Debe ser el bloque hexadecimal de 32 caracteres de la URL de la base, el que va ANTES del \"?v=\".",
    );
  }
  return candidatos[candidatos.length - 1].replace(/-/g, "");
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// La API oficial limita a ~3 peticiones por segundo. Se espacian las llamadas
// en vez de esperar al 429, y si aun así llega uno se reintenta respetando
// Retry-After.
async function notionFetch(token, ruta, opciones = {}, intento = 1) {
  await esperar(350);
  const resp = await fetch(`${NOTION_API}${ruta}`, {
    ...opciones,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(opciones.headers || {}),
    },
  });

  if ((resp.status === 429 || resp.status >= 500) && intento <= 4) {
    const espera = Number(resp.headers.get("retry-after") || intento * 2) * 1000;
    console.log(`[info] Notion respondió ${resp.status} en ${ruta} — reintento ${intento}/4 en ${espera / 1000}s`);
    await esperar(espera);
    return notionFetch(token, ruta, opciones, intento + 1);
  }

  if (!resp.ok) {
    const detalle = await resp.text().catch(() => "");
    throw new Error(`${opciones.method || "GET"} ${ruta} respondió ${resp.status}: ${detalle.slice(0, 300)}`);
  }
  return resp.json();
}

async function consultarBaseDeDatos(token, idBase) {
  const filas = [];
  let cursor;
  do {
    // Sin filtro de servidor a propósito: la propiedad "Estado" puede estar
    // creada como select o como status según cómo se arme la tabla en Notion, y
    // cada tipo exige una forma de filtro distinta. Filtrar en JS evita que el
    // build reviente por una diferencia de configuración de la base.
    const cuerpo = cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 };
    const datos = await notionFetch(token, `/databases/${idBase}/query`, {
      method: "POST",
      body: JSON.stringify(cuerpo),
    });
    filas.push(...datos.results);
    cursor = datos.has_more ? datos.next_cursor : null;
  } while (cursor);
  return filas;
}

// Trae los bloques hijos de un bloque/página, recursivamente. La profundidad
// máxima corta ciclos y estructuras patológicas; en la práctica un artículo no
// pasa de 2 niveles (lista dentro de lista).
async function obtenerBloques(token, idBloque, profundidad = 0) {
  if (profundidad > 3) return [];
  const bloques = [];
  let cursor;
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const datos = await notionFetch(token, `/blocks/${idBloque}/children?${query}`);
    bloques.push(...datos.results);
    cursor = datos.has_more ? datos.next_cursor : null;
  } while (cursor);

  for (const bloque of bloques) {
    if (bloque.has_children) {
      bloque.hijos = await obtenerBloques(token, bloque.id, profundidad + 1);
    }
  }
  return bloques;
}

// ---------------------------------------------------------------------------
// Lectura de propiedades de la base de datos
// ---------------------------------------------------------------------------

function clavePropiedad(nombre) {
  return String(nombre ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

// Busca una propiedad por cualquiera de sus nombres posibles, ignorando tildes
// y mayúsculas — la tabla la crea una persona a mano en Notion y "Descripción"
// / "Descripcion" / "descripcion" deben valer todas.
function propiedad(propiedades, ...nombres) {
  const buscados = nombres.map(clavePropiedad);
  for (const [nombre, valor] of Object.entries(propiedades || {})) {
    if (buscados.includes(clavePropiedad(nombre))) return valor;
  }
  return null;
}

function textoPlano(richText) {
  if (!Array.isArray(richText)) return "";
  return richText.map((t) => t.plain_text ?? "").join("");
}

// Devuelve el valor de una propiedad como texto plano, sea cual sea su tipo.
// Así la tabla puede usar select, texto o persona para "Autor" sin que el
// generador tenga que saberlo de antemano.
function valorTexto(prop) {
  return normalizarEspacios(valorTextoCrudo(prop));
}

// Los campos de la base se teclean a mano y llegan con dobles espacios o saltos
// de línea sueltos: son metadatos cortos (título, autor, etiqueta), así que se
// colapsan a un espacio antes de usarlos.
function normalizarEspacios(texto) {
  return String(texto ?? "").replace(/\s+/g, " ").trim();
}

function valorTextoCrudo(prop) {
  if (!prop) return "";
  switch (prop.type) {
    case "title":
    case "rich_text":
      return textoPlano(prop[prop.type]).trim();
    case "select":
      return prop.select?.name?.trim() ?? "";
    case "status":
      return prop.status?.name?.trim() ?? "";
    case "multi_select":
      return (prop.multi_select || []).map((o) => o.name).join(", ");
    case "people":
      return (prop.people || []).map((p) => p.name).filter(Boolean).join(", ");
    case "date":
      return prop.date?.start ?? "";
    case "url":
      return prop.url ?? "";
    case "checkbox":
      return prop.checkbox ? "true" : "";
    case "formula":
      return String(prop.formula?.string ?? prop.formula?.number ?? "");
    default:
      return "";
  }
}

// Notion entrega las fechas como ISO (2026-07-28 o con hora). Las tarjetas del
// sitio muestran dd/mm/aaaa, así que se conservan las dos formas: la ISO para
// <time> y article:published_time, la humana para la píldora de fecha.
function fechas(iso) {
  if (!iso) return { iso: "", humana: "" };
  const soloFecha = iso.slice(0, 10);
  const [a, m, d] = soloFecha.split("-");
  if (!a || !m || !d) return { iso: "", humana: "" };
  return { iso: soloFecha, humana: `${d}/${m}/${a}` };
}

// ---------------------------------------------------------------------------
// Renderizado de bloques a HTML
// ---------------------------------------------------------------------------

// Clases Tailwind por elemento. El sitio carga Tailwind por CDN (sin build
// step, igual que index.html) y no tiene el plugin de tipografía, así que cada
// elemento lleva sus clases explícitas. Los valores son los de la paleta del
// bloque de artículos: fondo slate-900, texto slate-300, enlaces indigo-400,
// acentos cyan-400.
const C = {
  parrafo: "text-slate-300 text-base md:text-lg leading-relaxed mb-6",
  h1: "text-3xl md:text-4xl font-serif font-bold text-white mt-14 mb-5",
  h2: "text-2xl md:text-3xl font-serif font-bold text-white mt-12 mb-4",
  h3: "text-xl md:text-2xl font-serif font-bold text-white mt-10 mb-3",
  ul: "list-disc list-outside pl-6 mb-6 space-y-2 text-slate-300 text-base md:text-lg leading-relaxed marker:text-indigo-400",
  ol: "list-decimal list-outside pl-6 mb-6 space-y-2 text-slate-300 text-base md:text-lg leading-relaxed marker:text-indigo-400",
  // Una lista dentro de un <li> no lleva el margen inferior de una lista
  // suelta: dejaría un hueco visible dentro del propio ítem.
  ulAnidada: "list-disc list-outside pl-6 mt-2 space-y-2 text-slate-300 text-base md:text-lg leading-relaxed marker:text-indigo-400",
  olAnidada: "list-decimal list-outside pl-6 mt-2 space-y-2 text-slate-300 text-base md:text-lg leading-relaxed marker:text-indigo-400",
  cita: "border-l-4 border-indigo-500 pl-6 my-8 text-slate-300 text-lg md:text-xl italic font-serif",
  codigo: "bg-slate-800 border border-slate-700 rounded-2xl p-5 my-8 overflow-x-auto text-sm text-slate-200",
  codigoEnLinea: "bg-slate-800 text-cyan-300 px-1.5 py-0.5 rounded text-[0.9em] font-mono",
  divisor: "border-0 border-t border-slate-700 my-12",
  figura: "my-10",
  imagen: "w-full h-auto rounded-2xl border border-slate-700",
  pie: "text-slate-400 text-xs mt-3 text-center italic",
  enlace: "text-indigo-400 hover:text-indigo-300 underline underline-offset-4 decoration-indigo-400/40",
  // La tabla va dentro de un contenedor con scroll propio: una tabla ancha
  // no puede hacer que la página entera se desplace en horizontal.
  tablaEnvoltura: "overflow-x-auto my-8 rounded-2xl border border-slate-700",
  tabla: "w-full text-left text-sm border-collapse",
  th: "bg-slate-800 text-white font-bold px-4 py-3 border-b border-slate-700 align-top",
  td: "text-slate-300 px-4 py-3 border-b border-slate-700 align-top",
};

// Un enlace interno de Notion (href que empieza por "/") apunta a otra página
// del workspace. Si esa página también está publicada, se reescribe a su ruta
// en datalexlab.com; si no, se pierde el enlace pero se conserva el texto —
// mandar al lector a notion.so es justo lo que este proyecto viene a quitar.
function resolverEnlace(href, mapaSlugs) {
  if (!href) return null;
  if (href.startsWith("/")) {
    const id = normalizarId(href.slice(1).split(/[?#]/)[0].split("-").pop());
    const slug = mapaSlugs.get(id);
    return slug ? `/bitacora/${slug}` : null;
  }
  const segura = urlSegura(href);
  if (!segura) return null;
  const interna = segura.match(/^https?:\/\/(?:www\.)?notion\.so\/(?:[^/]+\/)?([^?#]+)/);
  if (interna) {
    const slug = mapaSlugs.get(normalizarId(interna[1].split("-").pop()));
    return slug ? `/bitacora/${slug}` : segura;
  }
  return segura;
}

function renderRichText(richText, mapaSlugs) {
  if (!Array.isArray(richText)) return "";
  return richText
    .map((trozo) => {
      // Se escapa ANTES de envolver en etiquetas: lo que venga del editor no
      // puede inyectar HTML. Los saltos de línea dentro de un mismo bloque
      // (shift+enter en Notion) se conservan como <br>.
      let html = escaparHtml(trozo.plain_text ?? "").replace(/\n/g, "<br>");
      const a = trozo.annotations || {};
      if (a.code) html = `<code class="${C.codigoEnLinea}">${html}</code>`;
      if (a.bold) html = `<strong class="text-white font-bold">${html}</strong>`;
      if (a.italic) html = `<em>${html}</em>`;
      const destino = resolverEnlace(trozo.href, mapaSlugs);
      if (destino) {
        const externo = /^https?:/.test(destino);
        const extra = externo ? ' target="_blank" rel="noopener noreferrer"' : "";
        html = `<a href="${escaparHtml(destino)}" class="${C.enlace}"${extra}>${html}</a>`;
      }
      return html;
    })
    .join("");
}

// Renderiza una lista de bloques. Devuelve HTML. Los ítems de lista
// consecutivos se agrupan en un solo <ul>/<ol> — Notion los entrega sueltos,
// uno por bloque.
async function renderBloques(bloques, ctx, anidado = false) {
  const partes = [];
  let i = 0;

  while (i < bloques.length) {
    const bloque = bloques[i];
    const tipo = bloque.type;

    if (tipo === "bulleted_list_item" || tipo === "numbered_list_item") {
      const vinetas = tipo === "bulleted_list_item";
      const etiqueta = vinetas ? "ul" : "ol";
      const clase = anidado ? (vinetas ? C.ulAnidada : C.olAnidada) : (vinetas ? C.ul : C.ol);
      const items = [];
      while (i < bloques.length && bloques[i].type === tipo) {
        const item = bloques[i];
        let contenido = renderRichText(item[tipo].rich_text, ctx.mapaSlugs);
        if (item.hijos?.length) contenido += await renderBloques(item.hijos, ctx, true);
        items.push(`<li>${contenido}</li>`);
        i += 1;
      }
      partes.push(`<${etiqueta} class="${clase}">${items.join("")}</${etiqueta}>`);
      continue;
    }

    partes.push(await renderBloque(bloque, ctx));
    i += 1;
  }

  return partes.filter(Boolean).join("\n");
}

async function renderBloque(bloque, ctx) {
  const tipo = bloque.type;
  const datos = bloque[tipo] || {};

  switch (tipo) {
    case "paragraph": {
      const html = renderRichText(datos.rich_text, ctx.mapaSlugs);
      // Notion mete párrafos vacíos como separación visual; no se emiten.
      return html.trim() ? `<p class="${C.parrafo}">${html}</p>` : "";
    }
    case "heading_1":
    case "heading_2":
    case "heading_3": {
      const nivel = tipo.slice(-1);
      const html = renderRichText(datos.rich_text, ctx.mapaSlugs);
      if (!html.trim()) return "";
      // id derivado del texto para poder enlazar a una sección concreta.
      const id = slugificar(textoPlano(datos.rich_text));
      const clase = nivel === "1" ? C.h1 : nivel === "2" ? C.h2 : C.h3;
      return `<h${nivel} id="${escaparHtml(id)}" class="${clase}">${html}</h${nivel}>`;
    }
    case "quote": {
      const html = renderRichText(datos.rich_text, ctx.mapaSlugs);
      return html.trim() ? `<blockquote class="${C.cita}">${html}</blockquote>` : "";
    }
    case "code": {
      const texto = escaparHtml(textoPlano(datos.rich_text));
      if (!texto.trim()) return "";
      const lenguaje = escaparHtml(datos.language || "text");
      return `<pre class="${C.codigo}"><code class="language-${lenguaje}">${texto}</code></pre>`;
    }
    case "divider":
      return `<hr class="${C.divisor}">`;
    case "image": {
      const origen = datos.type === "external" ? datos.external?.url : datos.file?.url;
      const local = await ctx.rehospedar(origen);
      if (!local) return "";
      // El alt sale del pie de foto si lo hay; si no, del título del artículo,
      // para no dejar la imagen sin texto alternativo.
      const pieTexto = textoPlano(datos.caption).trim();
      const alt = escaparHtml(pieTexto || ctx.titulo);
      const pieHtml = renderRichText(datos.caption, ctx.mapaSlugs);
      const pie = pieTexto ? `<figcaption class="${C.pie}">${pieHtml}</figcaption>` : "";
      return `<figure class="${C.figura}"><img src="${escaparHtml(local)}" alt="${alt}" loading="lazy" class="${C.imagen}">${pie}</figure>`;
    }
    case "table": {
      // Notion entrega la tabla como un bloque contenedor y sus filas como
      // hijos (table_row), cada uno con un array de celdas; cada celda es a su
      // vez un array de rich text, así que pasa por el mismo renderizador que
      // el resto del texto — y por tanto por el mismo escapado.
      const filas = (bloque.hijos || []).filter((h) => h.type === "table_row");
      if (!filas.length) return "";

      const encabezadoColumna = datos.has_column_header === true;
      const encabezadoFila = datos.has_row_header === true;

      const filasHtml = filas.map((fila, i) => {
        const celdas = (fila.table_row?.cells || []).map((celda, j) => {
          const contenido = renderRichText(celda, ctx.mapaSlugs);
          const esCabecera = (encabezadoColumna && i === 0) || (encabezadoFila && j === 0);
          if (!esCabecera) return `<td class="${C.td}">${contenido}</td>`;
          const alcance = encabezadoColumna && i === 0 ? "col" : "row";
          return `<th scope="${alcance}" class="${C.th}">${contenido}</th>`;
        });
        return `<tr>${celdas.join("")}</tr>`;
      });

      const interior = encabezadoColumna
        ? `<thead>${filasHtml[0]}</thead><tbody>${filasHtml.slice(1).join("")}</tbody>`
        : `<tbody>${filasHtml.join("")}</tbody>`;
      return `<div class="${C.tablaEnvoltura}"><table class="${C.tabla}">${interior}</table></div>`;
    }
    case "table_row":
      // Las consume el caso "table" de arriba; si una llega suelta no es un
      // bloque no soportado, simplemente no le corresponde salida propia.
      return "";
    default:
      // Bases embebidas, columnas, toggles y ecuaciones caen aquí a
      // propósito (fuera del alcance de esta primera versión): se anotan y se
      // omiten, nunca tumban el build.
      anotarOmitido(tipo, ctx.titulo);
      return "";
  }
}

// ---------------------------------------------------------------------------
// Rehospedaje de imágenes
// ---------------------------------------------------------------------------

const EXTENSION_POR_TIPO = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
};

// Notion firma las URLs de archivo y la firma va en el query string, así que
// cambia en cada consulta aunque la imagen sea la misma. La parte estable es
// origen + ruta: esa es la clave de caché.
function claveImagen(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

function extensionDe(url, contentType) {
  const porTipo = EXTENSION_POR_TIPO[(contentType || "").split(";")[0].trim().toLowerCase()];
  if (porTipo) return porTipo;
  const enRuta = claveImagen(url).match(/\.(jpe?g|png|gif|webp|svg|avif)$/i);
  return enRuta ? "." + enRuta[1].toLowerCase().replace("jpeg", "jpg") : ".jpg";
}

// Descarga la imagen y la guarda como assets/bitacora/<sha256-16>.<ext>.
// Devuelve la ruta relativa a la raíz del sitio, o null si no se pudo traer
// (una imagen rota no debe tumbar el artículo entero).
async function rehospedarImagen(url, estadoImagenes) {
  if (!url) return null;
  const clave = claveImagen(url);

  const yaConocida = estadoImagenes[clave];
  if (yaConocida && existsSync(path.join(DIR_IMAGENES, yaConocida))) {
    return `/assets/bitacora/${yaConocida}`;
  }

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`respondió ${resp.status}`);
    const bytes = Buffer.from(await resp.arrayBuffer());
    if (bytes.length > MAX_BYTES_IMAGEN) {
      console.log(`[aviso] imagen omitida por tamaño (${(bytes.length / 1e6).toFixed(1)} MB): ${clave}`);
      return null;
    }
    // Nombre derivado del hash del contenido: si la misma imagen aparece en dos
    // artículos, o si Notion vuelve a firmar la misma URL, se reutiliza el
    // archivo que ya está en el repo en vez de duplicarlo.
    if (bytes.length > AVISO_BYTES_IMAGEN) {
      console.log(
        `[aviso] imagen pesada (${Math.round(bytes.length / 1024)} KB): ${clave} — ` +
        "conviene subirla a Notion ya redimensionada (1200 px de ancho basta para portada y og:image).",
      );
    }
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const archivo = hash + extensionDe(url, resp.headers.get("content-type"));
    mkdirSync(DIR_IMAGENES, { recursive: true });
    const destino = path.join(DIR_IMAGENES, archivo);
    if (!existsSync(destino)) writeFileSync(destino, bytes);
    estadoImagenes[clave] = archivo;
    return `/assets/bitacora/${archivo}`;
  } catch (e) {
    console.log(`[aviso] no se pudo rehospedar una imagen (${clave}): ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plantillas
// ---------------------------------------------------------------------------

// Stub de redirección para cuando un artículo cambia de slug: la ruta vieja
// sigue respondiendo y manda a la nueva. Mismo mecanismo que datalex_lab.html.
function plantillaRedireccion(destino) {
  const url = escaparHtml(`${SITIO_BASE}${destino}`);
  return [
    "<!DOCTYPE html>",
    '<html lang="es">',
    "<head>",
    '<meta charset="UTF-8">',
    `<title>Contenido movido | ${NOMBRE_SITIO}</title>`,
    `<link rel="canonical" href="${url}">`,
    `<meta http-equiv="refresh" content="0; url=${url}">`,
    '<meta name="robots" content="noindex, follow">',
    "</head>",
    "<body>",
    `<p>Este contenido se movió a <a href="${url}">${url}</a>.</p>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function plantillaArticulo(art) {
  const urlCanonica = `${SITIO_BASE}/bitacora/${art.slug}`;
  const urlOg = art.portada
    ? (art.portada.startsWith("http") ? art.portada : `${SITIO_BASE}${art.portada}`)
    : `${SITIO_BASE}/${OG_DEFECTO.replace(/^\//, "")}`;
  const tituloPagina = `${art.titulo} | ${NOMBRE_SITIO}`;

  const portadaHtml = art.portada
    ? `        <img src="${escaparHtml(art.portada)}" alt="${escaparHtml(art.titulo)}" class="w-full h-56 md:h-80 object-cover rounded-3xl border border-slate-700 mb-12">\n`
    : "";

  // Se declara con comillas escapadas dentro de la plantilla para que el CSS
  // inline conserve las comillas simples de las familias tipográficas.
  const fuentes = "@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=Merriweather:ital,wght@0,300;0,400;0,700;1,300&display=swap');";

  return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escaparHtml(tituloPagina)}</title>
    <meta name="description" content="${escaparHtml(art.descripcion)}">
    <meta name="author" content="${escaparHtml(art.autor)}">
    <link rel="canonical" href="${escaparHtml(urlCanonica)}">

    <meta property="og:type" content="article">
    <meta property="og:site_name" content="${NOMBRE_SITIO}">
    <meta property="og:locale" content="es_CO">
    <meta property="og:title" content="${escaparHtml(art.titulo)}">
    <meta property="og:description" content="${escaparHtml(art.descripcion)}">
    <meta property="og:url" content="${escaparHtml(urlCanonica)}">
    <meta property="og:image" content="${escaparHtml(urlOg)}">
    <meta property="article:published_time" content="${escaparHtml(art.fechaIso)}">
    <meta property="article:author" content="${escaparHtml(art.autor)}">

    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escaparHtml(art.titulo)}">
    <meta name="twitter:description" content="${escaparHtml(art.descripcion)}">
    <meta name="twitter:image" content="${escaparHtml(urlOg)}">

    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        // Sin esto, la utilidad .font-serif de Tailwind (inyectada en runtime,
        // o sea después del <style> de abajo y con la misma especificidad)
        // gana sobre la regla de tipografía y los títulos salen en Georgia en
        // vez de Merriweather. Se le enseña la familia a Tailwind en vez de
        // pelear la cascada a base de !important.
        tailwind.config = {
            theme: {
                extend: {
                    fontFamily: {
                        serif: ["Merriweather", "Georgia", "serif"],
                        sans: ["Plus Jakarta Sans", "system-ui", "sans-serif"],
                    },
                },
            },
        };
    </script>
    <style>
        ${fuentes}

        body {
            font-family: 'Plus Jakarta Sans', sans-serif;
            background-color: #0f172a;
            color: #cbd5e1;
            scroll-behavior: smooth;
        }
        h1, h2, h3, h4, .font-serif { font-family: 'Merriweather', serif; }
        .gradient-text {
            background: linear-gradient(135deg, #818cf8 0%, #22d3ee 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
    </style>
</head>
<body class="antialiased selection:bg-indigo-500 selection:text-white">

    <nav class="sticky top-0 z-50 bg-slate-900/80 backdrop-blur-md border-b border-slate-700">
        <div class="max-w-3xl mx-auto px-6 py-4 flex justify-between items-center">
            <a href="/" class="font-serif font-bold text-lg text-white">DataLex <span class="gradient-text">Lab</span></a>
            <a href="/#bitacora" class="text-slate-400 hover:text-indigo-400 text-xs font-bold uppercase tracking-widest transition-colors">&#8592; Bitácora</a>
        </div>
    </nav>

    <article class="max-w-3xl mx-auto px-6 py-16 md:py-24">
        <header class="mb-12">
            <span class="text-cyan-400 text-xs font-bold uppercase tracking-widest">${escaparHtml(art.etiqueta)}</span>
            <h1 class="text-3xl md:text-5xl font-serif font-bold text-white mt-4 mb-6 leading-tight">${escaparHtml(art.titulo)}</h1>
            <div class="flex flex-wrap items-center gap-3 text-xs">
                <span class="text-slate-300 font-bold bg-slate-900 px-3 py-1.5 rounded-full border border-slate-700 tracking-wider">
                    <time datetime="${escaparHtml(art.fechaIso)}">${escaparHtml(art.fechaHumana)}</time>
                </span>
                <span class="text-slate-400 uppercase tracking-widest font-bold">${escaparHtml(art.autor)}</span>
            </div>
        </header>

${portadaHtml}        <div class="article-body">
${art.cuerpo}
        </div>

        <footer class="mt-16 pt-8 border-t border-slate-700">
            <a href="/#bitacora" class="inline-block text-indigo-400 hover:text-indigo-300 text-xs font-bold uppercase tracking-wider">&#8592; Volver a la Bitácora</a>
            <p class="text-slate-500 text-[10px] mt-6 tracking-widest uppercase font-bold">Bogotá, 2026 · ${NOMBRE_SITIO}</p>
        </footer>
    </article>

</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Lectura del índice (base de datos de Notion)
// ---------------------------------------------------------------------------

// Modo de prueba sin token: si BITACORA_FIXTURE_DIR apunta a una carpeta con
// `base.json` (la respuesta de /databases/{id}/query) y `bloques/<id>.json`
// (la de /blocks/{id}/children), se leen de ahí en vez de llamar a la API.
// Sirve para verificar plantilla, escapado, slugs e idempotencia en local sin
// credenciales; en producción la variable simplemente no está definida.
const FIXTURES = process.env.BITACORA_FIXTURE_DIR || null;

async function leerIndice(token, idBase) {
  if (FIXTURES) {
    return JSON.parse(readFileSync(path.join(FIXTURES, "base.json"), "utf-8")).results;
  }
  return consultarBaseDeDatos(token, idBase);
}

async function leerBloques(token, idPagina) {
  if (FIXTURES) {
    const ruta = path.join(FIXTURES, "bloques", `${normalizarId(idPagina)}.json`);
    return existsSync(ruta) ? JSON.parse(readFileSync(ruta, "utf-8")) : [];
  }
  return obtenerBloques(token, idPagina);
}

function urlDeCover(fila) {
  // Una propiedad "Portada" de tipo archivo manda sobre la portada de la
  // página, para poder poner una imagen pensada para compartir en redes sin
  // cambiar la cabecera visual del artículo en Notion.
  const prop = propiedad(fila.properties, "Portada", "Cover", "Imagen");
  if (prop?.type === "files" && prop.files?.length) {
    const archivo = prop.files[0];
    return archivo.type === "external" ? archivo.external?.url : archivo.file?.url;
  }
  const cover = fila.cover;
  if (!cover) return null;
  return cover.type === "external" ? cover.external?.url : cover.file?.url;
}

// Convierte una fila de la base en los metadatos que necesitan la tarjeta y la
// plantilla. Devuelve null si la fila no es publicable (sin título, o con
// Estado distinto de "Publicado").
function leerFila(fila, hayColumnaEstado) {
  const props = fila.properties || {};

  const propTitulo = Object.values(props).find((p) => p?.type === "title");
  const titulo = valorTexto(propTitulo);
  if (!titulo) {
    console.log("[info] fila sin título — se omite.");
    return null;
  }

  if (hayColumnaEstado) {
    const estado = valorTexto(propiedad(props, "Estado", "Status", "Estado de publicacion"));
    if (clavePropiedad(estado) !== "publicado") {
      // Decir POR QUÉ se omite: sin esto una base recién creada produce
      // un índice vacío sin ninguna pista de qué falta rellenar.
      console.log(`[info] "${titulo}": Estado es "${estado || "(vacío)"}" y no "Publicado" — se omite.`);
      return null;
    }
  }

  const slugManual = valorTexto(propiedad(props, "Slug", "Ruta", "URL"));
  const slug = slugificar(slugManual) || slugificar(titulo);
  if (!slug) {
    console.log(`[info] "${titulo}" no produce un slug utilizable — se omite.`);
    return null;
  }

  const autor = valorTexto(propiedad(props, "Autor", "Author")) || AUTOR_DEFECTO;
  const etiquetaManual = valorTexto(propiedad(props, "Etiqueta", "Categoria", "Seccion"));
  const { iso, humana } = fechas(valorTexto(propiedad(props, "Fecha", "Fecha de lanzamiento", "Publicado el")));

  return {
    id: normalizarId(fila.id),
    idNotion: fila.id,
    lastEdited: fila.last_edited_time || "",
    titulo,
    slug,
    slugManual: Boolean(slugManual),
    autor,
    // La tarjeta actual usa la etiqueta para la línea de autoría; se conserva
    // ese comportamiento cuando no hay una etiqueta propia en la base.
    etiqueta: etiquetaManual || `AUTOR: ${autor.toUpperCase()}`,
    tipo: valorTexto(propiedad(props, "Tipo", "Formato")) || "DOCUMENTO",
    descripcionManual: valorTexto(propiedad(props, "Descripcion", "Resumen", "Extracto")),
    fechaIso: iso,
    fechaHumana: humana || "Próximamente",
    urlCover: urlDeCover(fila),
  };
}

// ---------------------------------------------------------------------------
// Generación de un artículo
// ---------------------------------------------------------------------------

async function generarArticulo(token, art, mapaSlugs, estadoImagenes) {
  const bloques = await leerBloques(token, art.idNotion);

  const rehospedar = (url) => rehospedarImagen(url, estadoImagenes);
  const cuerpo = await renderBloques(bloques, { mapaSlugs, titulo: art.titulo, rehospedar });

  if (!cuerpo.trim()) {
    console.log(`[aviso] "${art.titulo}" no produjo contenido renderizable (¿la página está compartida con la integración?)`);
  }

  const portada = art.urlCover ? await rehospedar(art.urlCover) : null;

  // La meta description sale del primer párrafo real, salvo que la base traiga
  // una escrita a mano.
  let descripcion = art.descripcionManual;
  if (!descripcion) {
    const primerParrafo = bloques.find(
      (b) => b.type === "paragraph" && textoPlano(b.paragraph?.rich_text).trim(),
    );
    descripcion = textoPlano(primerParrafo?.paragraph?.rich_text) || art.titulo;
  }
  descripcion = recortar(descripcion, LARGO_DESCRIPCION);

  const html = plantillaArticulo({ ...art, cuerpo, portada, descripcion });
  const ruta = path.join(DIR_ARTICULOS, art.slug, "index.html");
  const cambio = escribirSiCambia(ruta, html);

  return { descripcion, portada, ruta: `/bitacora/${art.slug}`, cambio };
}

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

async function main() {
  const { token, baseDatos } = credenciales();

  const estadoPrevio = existsSync(RUTA_ESTADO)
    ? JSON.parse(readFileSync(RUTA_ESTADO, "utf-8"))
    : { articulos: {}, imagenes: {} };
  const estadoArticulos = estadoPrevio.articulos || {};
  const estadoImagenes = estadoPrevio.imagenes || {};

  // Si esto falla no se escribe nada y el proceso sale con error: el sitio
  // conserva la última versión publicada en vez de quedarse sin artículos.
  const filas = await leerIndice(token, baseDatos);
  console.log(`[ok] ${filas.length} filas leídas de la base de datos de Notion.`);

  const hayColumnaEstado = filas.some((f) =>
    propiedad(f.properties, "Estado", "Status", "Estado de publicacion"),
  );
  if (!hayColumnaEstado) {
    console.log('[aviso] la base no tiene columna "Estado" — se publican todas las filas con título.');
  }

  const articulos = [];
  const slugsVistos = new Map();
  for (const fila of filas) {
    const art = leerFila(fila, hayColumnaEstado);
    if (!art) continue;
    const choque = slugsVistos.get(art.slug);
    if (choque) {
      // Deliberadamente ruidoso y sin auto-renombrar: un sufijo automático
      // dependería del orden en que Notion devuelva las filas, y ese orden
      // puede cambiar — el slug de un artículo ya publicado no puede moverse
      // solo.
      console.error(`[error] slug duplicado "${art.slug}": "${art.titulo}" choca con "${choque}". Define la propiedad Slug en una de las dos; se omite la segunda.`);
      continue;
    }
    slugsVistos.set(art.slug, art.titulo);
    articulos.push(art);
  }

  // El mapa id -> slug se arma antes de renderizar para poder reescribir los
  // enlaces internos entre artículos a rutas de datalexlab.com.
  const mapaSlugs = new Map(articulos.map((a) => [a.id, a.slug]));

  // Orden ascendente por fecha: es el orden en que se ven hoy las tarjetas en
  // el sitio, y esta tarea no cambia el diseño de la Bitácora.
  articulos.sort((a, b) => (a.fechaIso || "").localeCompare(b.fechaIso || ""));

  const nuevoEstado = { articulos: {}, imagenes: estadoImagenes };
  const indice = [];
  let generados = 0;
  let reutilizados = 0;
  let conservados = 0;

  for (const art of articulos) {
    const previo = estadoArticulos[art.id];
    const rutaArchivo = path.join(DIR_ARTICULOS, art.slug, "index.html");

    const alDia =
      previo &&
      previo.lastEdited === art.lastEdited &&
      previo.versionPlantilla === VERSION_PLANTILLA &&
      previo.slug === art.slug &&
      existsSync(rutaArchivo);

    let entrada;
    if (alDia) {
      entrada = { descripcion: previo.descripcion, portada: previo.portada, ruta: previo.ruta };
      reutilizados += 1;
    } else {
      try {
        const resultado = await generarArticulo(token, art, mapaSlugs, estadoImagenes);
        entrada = resultado;
        if (resultado.cambio) generados += 1;
        else reutilizados += 1;

        // Si el slug cambió, la ruta vieja no se borra: se deja un stub de
        // redirección para no romper lo que ya se compartió.
        //
        // Salvo que esa ruta pertenezca hoy a OTRO artículo publicado. Pasó en
        // producción: se corrigió a mano el Slug de un artículo que tenía por
        // error el de otro, y la redirección sobrescribió el HTML legítimo del
        // segundo con un stub que apuntaba al primero. `slugsVistos` se arma
        // completo antes de este bucle, así que la comprobación no depende del
        // orden en que se procesen los artículos.
        if (previo && previo.slug && previo.slug !== art.slug) {
          const duenoActual = slugsVistos.get(previo.slug);
          if (duenoActual) {
            console.log(`[info] la ruta anterior de "${art.titulo}" (/bitacora/${previo.slug}) hoy pertenece a "${duenoActual}" — no se deja redirección.`);
          } else {
            const rutaVieja = path.join(DIR_ARTICULOS, previo.slug, "index.html");
            escribirSiCambia(rutaVieja, plantillaRedireccion(`/bitacora/${art.slug}`));
            console.log(`[ok] slug cambiado (${previo.slug} -> ${art.slug}): redirección dejada en la ruta anterior.`);
          }
        }
      } catch (e) {
        // Un fallo puntual no borra el artículo del sitio: se conserva el HTML
        // ya publicado y su entrada de estado, y el lote sigue.
        console.error(`[error] "${art.titulo}" no se pudo regenerar: ${e.message}`);
        if (previo && existsSync(path.join(DIR_ARTICULOS, previo.slug, "index.html"))) {
          nuevoEstado.articulos[art.id] = previo;
          indice.push(entradaIndice(art, previo));
          conservados += 1;
        }
        continue;
      }
    }

    nuevoEstado.articulos[art.id] = {
      lastEdited: art.lastEdited,
      slug: art.slug,
      versionPlantilla: VERSION_PLANTILLA,
      descripcion: entrada.descripcion,
      portada: entrada.portada ?? null,
      ruta: entrada.ruta,
    };

    // Solo entra al índice si el HTML existe de verdad: ninguna tarjeta debe
    // apuntar a un 404.
    if (existsSync(path.join(DIR_ARTICULOS, art.slug, "index.html"))) {
      indice.push(entradaIndice(art, nuevoEstado.articulos[art.id]));
    } else {
      console.error(`[error] "${art.titulo}" quedó sin archivo en disco — se excluye del índice.`);
    }
  }

  // Los artículos que salieron de la base (o dejaron de estar publicados) se
  // quitan del índice pero NO se borran del disco: cualquier enlace ya
  // compartido sigue funcionando.
  for (const [id, previo] of Object.entries(estadoArticulos)) {
    if (!nuevoEstado.articulos[id]) {
      console.log(`[info] "${previo.slug}" ya no está publicado en Notion — se retira de la Bitácora, el HTML se conserva.`);
    }
  }

  const cambioIndice = escribirSiCambia(RUTA_INDICE, jsonEstable(indice));
  const cambioEstado = escribirSiCambia(RUTA_ESTADO, jsonEstable(nuevoEstado));

  for (const [tipo, porArticulo] of bloquesOmitidos) {
    const detalle = [...porArticulo].map(([t, n]) => `"${t}"${n > 1 ? ` x${n}` : ""}`).join(", ");
    console.log(`[info] bloque "${tipo}" no soportado en esta versión, omitido en: ${detalle}`);
  }

  console.log(
    `[ok] Bitácora sincronizada: ${indice.length} artículos publicados ` +
    `(${generados} regenerados, ${reutilizados} sin cambios, ${conservados} conservados por error). ` +
    `Índice ${cambioIndice ? "actualizado" : "sin cambios"}, estado ${cambioEstado ? "actualizado" : "sin cambios"}.`,
  );
}

function entradaIndice(art, estado) {
  return {
    slug: art.slug,
    ruta: estado.ruta || `/bitacora/${art.slug}`,
    titulo: art.titulo,
    descripcion: estado.descripcion || "",
    etiqueta: art.etiqueta,
    autor: art.autor,
    tipo: art.tipo,
    fecha: art.fechaHumana,
    fechaIso: art.fechaIso,
    portada: estado.portada ?? null,
  };
}

main().catch((e) => {
  // Salida con error a propósito: el workflow no commitea nada y el sitio se
  // queda exactamente como estaba, con sus artículos anteriores en su sitio.
  console.error(`[error] la sincronización de la Bitácora falló, no se escribió nada: ${e.message}`);
  process.exitCode = 1;
});
