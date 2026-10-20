const REPO = "https://raw.githubusercontent.com/consa963-eng/opds-nextnovels-v2/main";
const DATA_URL = `${REPO}/catalogo/catalogo.json`;
const TERABOX_API = "https://terabox-dl.vercel.app/api/info?url=";
const TERABOX_DL_API = "https://terabox-dl.vercel.app/api/download";
const TERABOX_LIST_API = "https://www.terabox.com/share/list";
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
function headers(type = "application/atom+xml; charset=UTF-8") {
  return { "Content-Type": type, "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" };
}
function textError(message, status = 502) {
  return new Response(String(message), { status, headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
function isAllowedShareUrl(value) {
  try {
    const parsed = new URL(value), host = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:" && [...TERABOX_HOSTS].some(d => host === d || host.endsWith(`.${d}`)) && !parsed.username && !parsed.password;
  } catch { return false; }
}
function isAllowedArticleUrl(value) {
  try {
    const parsed = new URL(value), host = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:" && (host === "nextnovels.com" || host.endsWith(".nextnovels.com")) && !parsed.username && !parsed.password;
  } catch { return false; }
}
function cleanFilename(name, fallback = "descarga.bin") {
  let value = String(name || fallback).replace(/[\\/\0-\x1F\x7F]/g, "_").trim();
  if (!value || value === "." || value === "..") value = fallback;
  return value.slice(0, 240);
}
function normalArticle(value) {
  const u = new URL(value); u.hash = ""; u.search = ""; u.pathname = u.pathname.replace(/\/+$/, "") || "/";
  return u.href.toLowerCase();
}
function novelDetailUrl(bookUrl, origin) { return `${origin}/novela?url=${encodeURIComponent(bookUrl)}`; }

function navEntry(book, origin) {
  const title = xmlEscape(book.title || "Sin título"), id = xmlEscape(book.id || book.url || title);
  let xml = `<entry><title>${title}</title><id>${id}</id><updated>${new Date().toISOString()}</updated>`;
  if (book.summary) xml += `<content type="text">${xmlEscape(String(book.summary).slice(0, 1500))}</content>`;
  if (book.author) xml += `<author><name>${xmlEscape(book.author)}</name></author>`;
  if (book.cover) xml += `<link rel="http://opds-spec.org/image" href="${xmlEscape(book.cover)}"/>`;
  if (book.url) {
    xml += `<link rel="alternate" href="${xmlEscape(book.url)}" type="text/html"/>`;
    xml += `<link rel="subsection" href="${xmlEscape(novelDetailUrl(book.url, origin))}" type="application/atom+xml;profile=opds-catalog;kind=acquisition" title="Ver EPUB y PDF"/>`;
  }
  return xml + "</entry>";
}

function feed(title, id, books, requestUrl, kind = "navigation") {
  const now = new Date().toISOString(), origin = new URL(requestUrl).origin;
  const entries = books.map(book => navEntry(book, origin)).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">\n<title>${xmlEscape(title)}</title><id>${xmlEscape(id)}</id><updated>${now}</updated><link rel="self" href="${xmlEscape(requestUrl)}" type="application/atom+xml;profile=opds-catalog;kind=${kind}"/><link rel="start" href="${xmlEscape(origin + "/")}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/><link rel="search" href="${xmlEscape(origin + "/opensearch.xml")}" type="application/opensearchdescription+xml"/>\n<opensearch:totalResults>${books.length}</opensearch:totalResults>\n${entries}\n</feed>`;
}

function rootFeed(requestUrl) {
  const base = new URL(requestUrl).origin;
  const items = [
    ["Novedades", "/catalogo/novedades.xml", "Últimas novelas actualizadas"],
    ["Todas las novelas", "/catalogo/todos.xml", "Catálogo de novelas; los volúmenes se consultan al abrir cada título"],
    ["Autores", "/catalogo/autores.xml", "Novelas agrupadas por autor"],
    ["Géneros", "/catalogo/generos.xml", "Novelas agrupadas por género"],
    ["Títulos A-Z", "/catalogo/titulos.xml", "Novelas ordenadas alfabéticamente"]
  ];
  const entries = items.map(([title, path, description]) => `<entry><title>${xmlEscape(title)}</title><id>${xmlEscape(base + path)}</id><content type="text">${xmlEscape(description)}</content><link rel="subsection" href="${xmlEscape(base + path)}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/></entry>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog"><title>Next Novels</title><id>${xmlEscape(base + "/")}</id><updated>${new Date().toISOString()}</updated><link rel="self" href="${xmlEscape(base + "/")}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/><link rel="search" href="${xmlEscape(base + "/opensearch.xml")}" type="application/opensearchdescription+xml"/>${entries}</feed>`;
}

function openSearch(requestUrl) {
  const base = new URL(requestUrl).origin;
  return `<?xml version="1.0" encoding="UTF-8"?><OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><ShortName>Next Novels</ShortName><Description>Buscar novelas de Next Novels</Description><InputEncoding>UTF-8</InputEncoding><Url type="application/atom+xml;profile=opds-catalog;kind=navigation" template="${xmlEscape(base)}/search?q={searchTerms}"/></OpenSearchDescription>`;
}

async function getBooks() {
  const response = await fetch(DATA_URL, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!response.ok) throw new Error(`No se pudo descargar catalogo.json: ${response.status}`);
  const books = await response.json();
  if (!Array.isArray(books)) throw new Error("catalogo.json no contiene una lista de novelas.");
  return books;
}

async function jsonResponse(response, label) {
  const type = (response.headers.get("Content-Type") || "").toLowerCase();
  if (type.includes("text/html")) throw new Error(`${label}: TeraBox o el intermediario devolvió HTML en lugar de JSON.`);
  try { return await response.json(); }
  catch { throw new Error(`${label}: respuesta JSON no válida.`); }
}

function shorturlFromShare(value) {
  try {
    const u = new URL(value), params = u.searchParams;
    for (const key of ["surl", "shorturl"]) {
      const v = params.get(key); if (v) return v.startsWith("1") ? v.slice(1) : v;
    }
    const parts = u.pathname.split("/").filter(Boolean);
    for (let i = 0; i < parts.length - 1; i++) {
      if (["s", "share", "sharing"].includes(parts[i].toLowerCase())) {
        const v = parts[i + 1]; return v.startsWith("1") ? v.slice(1) : v;
      }
    }
    if (parts.length && parts[parts.length - 1].startsWith("1")) return parts[parts.length - 1].slice(1);
  } catch {}
  return "";
}

function extractJsToken(html) {
  const patterns = [
    /window\.jsToken\s*=\s*["']([^"']+)["']/i,
    /(?:window\.)?jsToken\s*[:=]\s*["']([^"']+)["']/i,
    /["']jsToken["']\s*:\s*["']([^"']+)["']/i,
    /jsToken%22%3A%22([^%"']+)/i
  ];
  for (const pattern of patterns) { const match = html.match(pattern); if (match) return match[1]; }
  return "";
}

async function teraboxContext(shareUrl) {
  if (!isAllowedShareUrl(shareUrl)) throw new Error("El enlace compartido no pertenece a un dominio TeraBox admitido.");
  const response = await fetch(shareUrl, { headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*" }, redirect: "follow" });
  if (!response.ok) throw new Error(`No se pudo abrir el enlace público de TeraBox (HTTP ${response.status}).`);
  const html = await response.text();
  const shorturl = shorturlFromShare(response.url || shareUrl) || shorturlFromShare(shareUrl);
  if (!shorturl) throw new Error("No se encontró el identificador público de la carpeta compartida.");
  const jsToken = extractJsToken(html);
  return { shorturl, jsToken, referer: `https://www.terabox.com/s/1${shorturl}` };
}

async function teraboxList(context, folderPath, page = 1) {
  const params = new URLSearchParams({ app_id: "250528", shorturl: context.shorturl, page: String(page), num: "100" });
  if (context.jsToken) params.set("jsToken", context.jsToken);
  if (folderPath) params.set("dir", folderPath); else params.set("root", "1");
  const response = await fetch(`${TERABOX_LIST_API}?${params}`, {
    headers: { "User-Agent": UA, "Accept": "application/json, text/plain, */*", "Referer": context.referer }, redirect: "follow"
  });
  if (!response.ok) throw new Error(`El listado público de TeraBox respondió HTTP ${response.status}.`);
  const data = await jsonResponse(response, "Listado de archivos");
  if (String(data.errno ?? "0") !== "0") throw new Error(`TeraBox rechazó el listado: ${data.errmsg || data.show_msg || "error desconocido"}`);
  return Array.isArray(data.list) ? data.list : [];
}

async function listTeraboxFiles(shareUrl) {
  const context = await teraboxContext(shareUrl), files = [], visited = new Set();
  let visitedFolders = 0;
  async function walk(folderPath = "", depth = 0) {
    if (depth > 12 || visitedFolders >= 40) return;
    const key = folderPath || "/";
    if (visited.has(key)) return;
    visited.add(key); visitedFolders++;
    let items = [];
    for (let page = 1; page <= 20; page++) {
      const batch = await teraboxList(context, folderPath, page);
      items.push(...batch);
      if (batch.length < 100) break;
    }
    for (const item of items) {
      const name = String(item.server_filename || item.filename || "").trim();
      if (!name) continue;
      const isDir = [1, "1", true, "true"].includes(item.isdir ?? item.is_dir);
      const path = item.path || (folderPath ? `${folderPath.replace(/\/$/, "")}/${name}` : `/${name}`);
      if (isDir) { await walk(path, depth + 1); continue; }
      const ext = name.toLowerCase().match(/\.(epub|pdf)$/)?.[1];
      const fsId = item.fs_id ?? item.fid;
      if (!ext || fsId === undefined || fsId === null) continue;
      files.push({ fs_id: String(fsId), name, path, type: ext === "epub" ? "application/epub+zip" : "application/pdf", size: item.size });
    }
  }
  await walk();
  const unique = new Map();
  for (const file of files) unique.set(file.fs_id, file);
  return [...unique.values()];
}

function extractShareLinks(html, pageUrl) {
  const results = new Set();
  const re = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match;
  while ((match = re.exec(html))) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").replace(/&amp;/g, "&").replace(/&#038;/g, "&").trim();
    try {
      const target = new URL(raw, pageUrl).href;
      if (isAllowedShareUrl(target)) results.add(target);
    } catch {}
  }
  return [...results];
}

function downloadUrl(origin, shareUrl, file) {
  const params = new URLSearchParams({ url: shareUrl, fs_id: file.fs_id, name: cleanFilename(file.name, "descarga.bin") });
  return `${origin}/descargar?${params}`;
}

function fileEntry(file, href, idSuffix = "") {
  const title = xmlEscape(file.title || file.name || "Archivo");
  const id = xmlEscape(`nextnovels:file:${file.fs_id || href}${idSuffix}`);
  const type = xmlEscape(file.type || (String(file.name || "").toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/epub+zip"));
  return `<entry><title>${title}</title><id>${id}</id><updated>${new Date().toISOString()}</updated><link rel="http://opds-spec.org/acquisition" href="${xmlEscape(href)}" type="${type}" title="${title}"/></entry>`;
}

function detailFeed(book, fileEntries, requestUrl, message = "") {
  const base = new URL(requestUrl).origin, now = new Date().toISOString();
  let extra = "";
  if (message) extra = `<entry><title>No se pudieron listar los archivos</title><id>${xmlEscape(base + "/novela/error")}</id><content type="text">${xmlEscape(message)}</content></entry>`;
  if (!fileEntries.length && !message) extra = `<entry><title>No hay archivos EPUB o PDF detectados</title><id>${xmlEscape(base + "/novela/vacio")}</id><content type="text">Esta página no mostró archivos públicos compatibles. TeraBox puede limitar el acceso o requerir una verificación.</content></entry>`;
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog"><title>${xmlEscape(book.title || "Archivos de la novela")}</title><id>${xmlEscape(base + "/novela?url=" + encodeURIComponent(book.url || ""))}</id><updated>${now}</updated><link rel="self" href="${xmlEscape(requestUrl)}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/><link rel="start" href="${xmlEscape(base + "/")}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>${book.cover ? `<link rel="http://opds-spec.org/image" href="${xmlEscape(book.cover)}"/>` : ""}${fileEntries.join("\n")}${extra}</feed>`;
}

async function handleNovel(requestUrl) {
  const articleParam = requestUrl.searchParams.get("url");
  if (!articleParam || !isAllowedArticleUrl(articleParam)) return textError("Falta una URL válida de una novela de NextNovels.", 400);
  let requestedKey;
  try { requestedKey = normalArticle(articleParam); } catch { return textError("La URL de la novela no es válida.", 400); }
  let books;
  try { books = await getBooks(); } catch (error) { return textError(error.message, 502); }
  const book = books.find(item => {
    try { return item.url && normalArticle(item.url) === requestedKey; } catch { return false; }
  });
  if (!book) return textError("La novela no aparece en catalogo.json. Ejecuta el workflow para actualizar el catálogo.", 404);

  const cacheKey = new Request(`${new URL(requestUrl).origin}/_lazy_cache/novela?url=${encodeURIComponent(book.url)}`);
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;
  } catch {}

  let shareLinks = Array.isArray(book.terabox_links) ? book.terabox_links.filter(isAllowedShareUrl) : [];
  // EL CATÁLOGO AHORA ES LIGERO: siempre entrará aquí a buscar enlaces si no los tiene guardados
  let articleHtml = "";
  if (!shareLinks.length) {
    const page = await fetch(book.url, { headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*" }, redirect: "follow" });
    if (!page.ok) return textError(`No se pudo abrir la página de la novela (HTTP ${page.status}).`, 502);
    articleHtml = await page.text();
    shareLinks = extractShareLinks(articleHtml, page.url || book.url);
  }
  shareLinks = [...new Set(shareLinks)];
  const origin = new URL(requestUrl).origin, items = [], failures = [];

  for (const old of (Array.isArray(book.downloads) ? book.downloads : [])) {
    if (!old?.url || old.storage_url) continue;
    try {
      const u = new URL(old.url), ext = u.pathname.toLowerCase().match(/\.(epub|pdf)$/)?.[1];
      if (!ext || u.pathname === "/descargar" || u.pathname === "/bajar") continue;
      if (u.hostname === new URL(origin).hostname) continue;
      items.push({ file: { fs_id: `direct-${items.length}`, name: old.title || u.pathname.split("/").pop(), type: ext === "epub" ? "application/epub+zip" : "application/pdf" }, href: u.href });
    } catch {}
  }
  if (!shareLinks.length && !items.length) failures.push("No se encontraron enlaces públicos de TeraBox en la página de esta novela.");
  for (const share of shareLinks) {
    try {
      const files = await listTeraboxFiles(share);
      for (const file of files) items.push({ file, href: downloadUrl(origin, share, file) });
      if (!files.length) failures.push("Un enlace compartido no contiene archivos EPUB/PDF visibles.");
    } catch (error) {
      failures.push(`${new URL(share).hostname}: ${error?.message || "error al consultar TeraBox"}`);
    }
  }
  const seen = new Set(), unique = [];
  for (const item of items) {
    const key = `${item.file.fs_id}:${item.href}`;
    if (!seen.has(key)) { seen.add(key); unique.push(item); }
  }
  unique.sort((a, b) => String(a.file.name).localeCompare(String(b.file.name), "es", { numeric: true, sensitivity: "base" }));
  const message = unique.length ? "" : (failures.join("; ") || "No se encontraron archivos descargables.");
  const xmlItems = unique.map(item => fileEntry(item.file, item.href));
  const response = new Response(detailFeed(book, xmlItems, requestUrl, message), {
    status: 200,
    headers: { ...headers(), "Cache-Control": unique.length ? "public, max-age=300" : "no-store" }
  });
  if (unique.length) { try { await caches.default.put(cacheKey, response.clone()); } catch {} }
  return response;
}

async function resolverTerabox(teraboxUrl, fsId) {
  if (!isAllowedShareUrl(teraboxUrl)) throw new Error("La URL de almacenamiento no es válida o no está admitida.");
  if (!/^\d{1,30}$/.test(String(fsId || ""))) throw new Error("Falta fs_id o no tiene un formato válido.");
  const infoResp = await fetch(TERABOX_API + encodeURIComponent(teraboxUrl), { headers: { "Accept": "application/json", "User-Agent": UA } });
  if (!infoResp.ok) throw new Error(`El servicio de resolución respondió HTTP ${infoResp.status}.`);
  const info = await jsonResponse(infoResp, "Información del enlace");
  if (!info.ok || !info.sign || !info.timestamp || !info.shareid || !info.uk) {
    throw new Error("No se pudieron obtener los metadatos del enlace público. Puede que TeraBox o el servicio externo lo esté limitando.");
  }
  const numericId = Number(fsId);
  const downloadResp = await fetch(TERABOX_DL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": UA, "Referer": "https://www.terabox.com/" },
    body: JSON.stringify({ sign: info.sign, timestamp: info.timestamp, shareid: info.shareid, uk: info.uk,
      fs_id: Number.isSafeInteger(numericId) ? numericId : String(fsId) })
  });
  if (!downloadResp.ok) throw new Error(`El servicio de enlaces respondió HTTP ${downloadResp.status}.`);
  const data = await jsonResponse(downloadResp, "Creación de enlace de descarga");
  if (!data.ok || !data.dlink) throw new Error("No se pudo generar el enlace para el archivo seleccionado. Puede que TeraBox no lo permita mediante enlace público.");
  return data.dlink;
}

async function handleDownload(requestUrl) {
  const teraboxUrl = requestUrl.searchParams.get("url") || requestUrl.searchParams.get("storage_url");
  const fsId = requestUrl.searchParams.get("fs_id");
  const filename = cleanFilename(requestUrl.searchParams.get("name"), "descarga.bin");
  if (!teraboxUrl) return textError("Falta el parámetro url.", 400);
  if (!fsId) return textError("Falta el parámetro fs_id.", 400);
  const extension = filename.toLowerCase().split(".").pop();
  if (!["epub", "pdf"].includes(extension)) return textError("Solo se admiten archivos EPUB y PDF.", 400);
  let directUrl;
  try { directUrl = await resolverTerabox(teraboxUrl, fsId); }
  catch (error) { return textError(`No se pudo preparar la descarga: ${error.message}`, 502); }
  let fileResponse;
  try { fileResponse = await fetch(directUrl, { headers: { "Referer": "https://www.terabox.com/", "User-Agent": UA, "Accept": "*/*" }, redirect: "follow" }); }
  catch { return textError("No se pudo conectar con el servidor del archivo.", 502); }
  if (!fileResponse.ok) return textError(`El servidor del archivo respondió HTTP ${fileResponse.status}.`, 502);
  const contentType = (fileResponse.headers.get("Content-Type") || "").toLowerCase();
  if (contentType.includes("text/html")) return textError("TeraBox devolvió HTML en lugar del archivo. Puede requerir verificación o estar temporalmente bloqueado.", 502);
  const mime = extension === "epub" ? "application/epub+zip" : "application/pdf";
  const outputHeaders = new Headers({ "Content-Type": mime, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  const length = fileResponse.headers.get("Content-Length");
  if (length) outputHeaders.set("Content-Length", length);
  return new Response(fileResponse.body, { status: 200, headers: outputHeaders });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/" || url.pathname === "/index.xml") return new Response(rootFeed(request.url), { headers: headers() });
      if (url.pathname === "/opensearch.xml") return new Response(openSearch(request.url), { headers: headers("application/opensearchdescription+xml; charset=UTF-8") });
      if (url.pathname === "/novela") {
        if (request.method !== "GET") return textError("Método no permitido.", 405);
        return handleNovel(url);
      }
      if (url.pathname === "/descargar" || url.pathname === "/bajar") {
        if (request.method !== "GET") return textError("Método no permitido.", 405);
        return handleDownload(url);
      }
      if (url.pathname === "/search") {
        const query = (url.searchParams.get("q") || "").trim().toLowerCase();
        const books = await getBooks();
        const results = query ? books.filter(book => [book.title, book.author, ...(book.genres || [])].filter(Boolean).join(" ").toLowerCase().includes(query)).slice(0, 200) : [];
        return new Response(feed(`Resultados: ${query}`, `${url.origin}/search?q=${encodeURIComponent(query)}`, results, request.url, "navigation"), { headers: headers() });
      }
      if (url.pathname.startsWith("/catalogo/")) {
        if (url.pathname.includes("..") || !/^\/catalogo\/[a-zA-Z0-9._-]+$/.test(url.pathname)) return textError("Ruta de catálogo no válida.", 400);
        const response = await fetch(`${REPO}${url.pathname}`, { cf: { cacheTtl: 60, cacheEverything: true } });
        if (!response.ok) return textError("Catálogo no encontrado.", response.status);
        const isXml = /\.(xml|opds)$/i.test(url.pathname);
        return new Response(response.body, { status: response.status, headers: { "Content-Type": isXml ? "application/atom+xml; charset=UTF-8" : (response.headers.get("Content-Type") || "application/octet-stream"), "Cache-Control": "public, max-age=60", "X-Content-Type-Options": "nosniff" } });
      }
      return textError("Ruta no encontrada.", 404);
    } catch (error) {
      return textError(`Error del servidor: ${error?.message || "error desconocido"}`, 502);
    }
  }
};
