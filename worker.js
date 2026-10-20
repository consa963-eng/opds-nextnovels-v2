const REPO = "https://raw.githubusercontent.com/consa963-eng/opds-nextnovels-v2/main";
const DATA_URL = `${REPO}/catalogo/catalogo.json`;
const TERABOX_API = "https://terabox-dl.vercel.app/api/info?url=";
const TERABOX_DL_API = "https://terabox-dl.vercel.app/api/download";
const TERABOX_HOSTS = new Set([
  "terabox.com", "terabox.app", "teraboxlink.com", "freeterabox.com",
  "1024tera.com", "4funbox.com", "mirrobox.com", "nephobox.com",
  "teraboxshare.com", "terabox.fun", "teraboxapp.com"
]);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";

function xmlEscape(value = "") {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}
function xmlCdata(value = "") { return String(value).replace(/\]\]>/g, "]]]]><![CDATA[>"); }
function headers(type = "application/atom+xml; charset=UTF-8") {
  return { "Content-Type": type, "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" };
}
function textError(message, status = 502) {
  return new Response(String(message), {
    status,
    headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });
}
function entry(book) {
  const title = xmlEscape(book.title || "Sin título");
  const id = xmlEscape(book.id || book.url || title);
  const url = xmlEscape(book.url || "");
  const cover = book.cover ? xmlEscape(book.cover) : "";
  const author = book.author ? xmlEscape(book.author) : "";
  let xml = `\n<entry>\n<title>${title}</title>\n<id>${id}</id>\n<link rel="alternate" href="${url}" type="text/html"/>\n`;
  if (cover) xml += `\n<link rel="http://opds-spec.org/image" href="${cover}"/>\n<link rel="http://opds-spec.org/image/thumbnail" href="${cover}"/>\n`;
  if (author) xml += `<author><name>${author}</name></author>\n`;
  for (const genre of book.genres || []) xml += `<category term="${xmlEscape(genre)}" label="${xmlEscape(genre)}"/>\n`;
  if (book.summary) xml += `<content type="html"><![CDATA[${xmlCdata(book.summary)}]]></content>\n`;
  for (const download of book.downloads || []) {
    if (!download.url) continue;
    xml += `\n<link rel="http://opds-spec.org/acquisition" href="${xmlEscape(download.url)}" type="${xmlEscape(download.type || "application/epub+zip")}" title="${xmlEscape(download.title || "Descargar")}"/>\n`;
  }
  if ((!book.downloads || !book.downloads.length) && book.url) {
    xml += `\n<link rel="http://opds-spec.org/acquisition" href="${url}" type="text/html" title="Abrir en Next Novels"/>\n`;
  }
  return xml + "</entry>";
}
function feed(title, id, books, requestUrl, kind = "acquisition") {
  const now = new Date().toISOString();
  const entries = books.map(entry).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">\n<title>${xmlEscape(title)}</title>\n<id>${xmlEscape(id)}</id>\n<updated>${now}</updated>\n<link rel="self" href="${xmlEscape(requestUrl)}" type="application/atom+xml;profile=opds-catalog;kind=${kind}"/>\n<link rel="start" href="${xmlEscape(new URL("/", requestUrl).href)}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>\n<link rel="search" href="${xmlEscape(new URL("/opensearch.xml", requestUrl).href)}" type="application/opensearchdescription+xml"/>\n<opensearch:totalResults>${books.length}</opensearch:totalResults>\n${entries}\n</feed>`;
}
function rootFeed(requestUrl) {
  const base = new URL(requestUrl).origin;
  const items = [
    ["Novedades", "/catalogo/novedades.xml", "Últimas novelas actualizadas", "acquisition"],
    ["Todas las novelas", "/catalogo/todos.xml", "Catálogo completo", "acquisition"],
    ["Autores", "/catalogo/autores.xml", "Novelas agrupadas por autor", "navigation"],
    ["Géneros", "/catalogo/generos.xml", "Novelas agrupadas por género", "navigation"],
    ["Títulos A-Z", "/catalogo/titulos.xml", "Novelas ordenadas alfabéticamente", "acquisition"]
  ];
  const entries = items.map(([title, path, description, kind]) => `\n<entry>\n<title>${xmlEscape(title)}</title>\n<id>${xmlEscape(base + path)}</id>\n<content type="text">${xmlEscape(description)}</content>\n<link rel="subsection" href="${xmlEscape(base + path)}" type="application/atom+xml;profile=opds-catalog;kind=${kind}"/>\n</entry>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">\n<title>Next Novels</title>\n<id>${xmlEscape(base + "/")}</id>\n<updated>${new Date().toISOString()}</updated>\n<link rel="self" href="${xmlEscape(base + "/")}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>\n<link rel="search" href="${xmlEscape(base + "/opensearch.xml")}" type="application/opensearchdescription+xml"/>\n${entries}\n</feed>`;
}
function openSearch(requestUrl) {
  const base = new URL(requestUrl).origin;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">\n<ShortName>Next Novels</ShortName>\n<Description>Buscar novelas de Next Novels</Description>\n<InputEncoding>UTF-8</InputEncoding>\n<Url type="application/atom+xml;profile=opds-catalog;kind=acquisition" template="${xmlEscape(base)}/search?q={searchTerms}"/>\n</OpenSearchDescription>`;
}
async function getBooks() {
  const response = await fetch(DATA_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!response.ok) throw new Error(`No se pudo descargar catalogo.json: ${response.status}`);
  return response.json();
}

function isAllowedShareUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:" && [...TERABOX_HOSTS].some(d => host === d || host.endsWith(`.${d}`)) && !parsed.username && !parsed.password;
  } catch { return false; }
}
function cleanFilename(name, fallback = "descarga.bin") {
  let value = String(name || fallback).replace(/[\\/\0-\x1F\x7F]/g, "_").trim();
  if (!value || value === "." || value === "..") value = fallback;
  return value.slice(0, 240);
}
async function jsonResponse(response, label) {
  const type = (response.headers.get("Content-Type") || "").toLowerCase();
  if (type.includes("text/html")) throw new Error(`${label}: TeraBox o el intermediario devolvió HTML en lugar de JSON.`);
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error(`${label}: respuesta JSON no válida.`); }
  return payload;
}
async function resolverTerabox(teraboxUrl, fsId) {
  if (!isAllowedShareUrl(teraboxUrl)) throw new Error("La URL de almacenamiento no es válida o no está admitida.");
  if (!/^\d{1,30}$/.test(String(fsId || ""))) throw new Error("Falta fs_id o no tiene un formato válido.");

  const infoResp = await fetch(TERABOX_API + encodeURIComponent(teraboxUrl), {
    headers: { "Accept": "application/json", "User-Agent": UA }
  });
  if (!infoResp.ok) throw new Error(`El servicio de resolución respondió HTTP ${infoResp.status}.`);
  const info = await jsonResponse(infoResp, "Información del enlace");
  if (!info.ok || !info.sign || !info.timestamp || !info.shareid || !info.uk) {
    throw new Error("No se pudieron obtener los metadatos del enlace público. Puede que haya caducado o que el servicio externo no esté disponible.");
  }

  const downloadResp = await fetch(TERABOX_DL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": UA, "Referer": "https://www.terabox.com/" },
    body: JSON.stringify({
      sign: info.sign,
      timestamp: info.timestamp,
      shareid: info.shareid,
      uk: info.uk,
      fs_id: /^\d+$/.test(String(fsId)) ? Number(fsId) : String(fsId)
    })
  });
  if (!downloadResp.ok) throw new Error(`El servicio de enlaces respondió HTTP ${downloadResp.status}.`);
  const downloadData = await jsonResponse(downloadResp, "Creación de enlace de descarga");
  if (!downloadData.ok || !downloadData.dlink) {
    throw new Error("No se pudo generar el enlace para el fs_id seleccionado. Comprueba que el archivo pertenezca a esta carpeta compartida.");
  }
  return downloadData.dlink;
}

async function handleDownload(requestUrl) {
  const teraboxUrl = requestUrl.searchParams.get("url") || requestUrl.searchParams.get("storage_url");
  const fsId = requestUrl.searchParams.get("fs_id");
  const filename = cleanFilename(requestUrl.searchParams.get("name"), "descarga.bin");
  if (!teraboxUrl) return textError("Falta el parámetro url.", 400);
  if (!fsId) return textError("Falta el parámetro fs_id. Actualiza el catálogo para generar enlaces individuales.", 400);
  const requestedExtension = filename.toLowerCase().split(".").pop();
  if (!["epub", "pdf"].includes(requestedExtension)) {
    return textError("Solo se admiten archivos EPUB y PDF.", 400);
  }

  let directUrl;
  try { directUrl = await resolverTerabox(teraboxUrl, fsId); }
  catch (error) { return textError(`No se pudo preparar la descarga: ${error.message}`, 502); }

  let fileResponse;
  try {
    fileResponse = await fetch(directUrl, {
      headers: { "Referer": "https://www.terabox.com/", "User-Agent": UA, "Accept": "*/*" },
      redirect: "follow"
    });
  } catch {
    return textError("No se pudo conectar con el servidor del archivo.", 502);
  }
  if (!fileResponse.ok) return textError(`El servidor del archivo respondió HTTP ${fileResponse.status}.`, 502);
  const contentType = (fileResponse.headers.get("Content-Type") || "").toLowerCase();
  if (contentType.includes("text/html")) {
    return textError("TeraBox devolvió una página HTML en lugar del archivo. El enlace puede requerir verificación o estar temporalmente bloqueado.", 502);
  }

  const extension = filename.toLowerCase().split(".").pop();
  let mime = fileResponse.headers.get("Content-Type") || "application/octet-stream";
  if (extension === "epub") mime = "application/epub+zip";
  else if (extension === "pdf") mime = "application/pdf";
  if (!["epub", "pdf"].includes(extension)) return textError("Solo se admiten archivos EPUB y PDF.", 400);

  const outputHeaders = new Headers();
  outputHeaders.set("Content-Type", mime);
  outputHeaders.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  outputHeaders.set("Cache-Control", "no-store");
  outputHeaders.set("X-Content-Type-Options", "nosniff");
  const length = fileResponse.headers.get("Content-Length");
  if (length) outputHeaders.set("Content-Length", length);
  return new Response(fileResponse.body, { status: 200, headers: outputHeaders });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/" || url.pathname === "/index.xml") {
        return new Response(rootFeed(request.url), { headers: headers() });
      }
      if (url.pathname === "/opensearch.xml") {
        return new Response(openSearch(request.url), { headers: headers("application/opensearchdescription+xml; charset=UTF-8") });
      }
      if (url.pathname === "/descargar" || url.pathname === "/bajar") {
        if (request.method !== "GET" && request.method !== "HEAD") return textError("Método no permitido.", 405);
        if (request.method === "HEAD") return textError("HEAD no está disponible para este enlace.", 405);
        return handleDownload(url);
      }
      if (url.pathname === "/search") {
        const query = (url.searchParams.get("q") || "").trim().toLowerCase();
        if (!query) return new Response(feed("Buscar", `${url.origin}/search`, [], request.url), { headers: headers() });
        const books = await getBooks();
        const results = books.filter(book => [book.title, book.author, ...(book.genres || [])].filter(Boolean).join(" ").toLowerCase().includes(query));
        return new Response(feed(`Resultados: ${query}`, `${url.origin}/search?q=${encodeURIComponent(query)}`, results.slice(0, 200), request.url), { headers: headers() });
      }
      if (url.pathname.startsWith("/catalogo/")) {
        const target = `${REPO}${url.pathname}`;
        const response = await fetch(target);
        if (!response.ok) return textError("Catálogo no encontrado.", response.status);
        const isXml = url.pathname.endsWith(".xml") || url.pathname.endsWith(".opds");
        const contentType = isXml ? "application/atom+xml; charset=UTF-8" : (response.headers.get("Content-Type") || "application/octet-stream");
        return new Response(response.body, { status: response.status, headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" } });
      }
      return textError("Ruta no encontrada.", 404);
    } catch (error) {
      return textError(`Error del servidor: ${error?.message || "error desconocido"}`, 502);
    }
  }
};
