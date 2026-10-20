const REPO = "https://raw.githubusercontent.com/consa963-eng/opds-nextnovels-v2/main";
const DATA_URL = `${REPO}/catalogo/catalogo.json`;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TERABOX_HOSTS = new Set([
  "terabox.com", "terabox.app", "teraboxlink.com", "freeterabox.com",
  "1024tera.com", "4funbox.com", "mirrobox.com", "nephobox.com",
  "teraboxshare.com", "terabox.fun", "teraboxapp.com"
]);

function xmlEscape(value = "") {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function headers(type = "application/atom+xml; charset=UTF-8") {
  return { "Content-Type": type, "Cache-Control": "public, max-age=300" };
}
function textError(message, status = 502) {
  return new Response(String(message), { status, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
}
function isTerabox(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return [...TERABOX_HOSTS].some(d => host === d || host.endsWith(`.${d}`));
  } catch { return false; }
}

async function getBooks() {
  const response = await fetch(DATA_URL, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!response.ok) throw new Error("No se pudo descargar catalogo.json");
  return await response.json();
}

// 1. Entra a NextNovels y extrae los enlaces de TeraBox
async function getTeraboxLinksFromNextNovels(url) {
  console.log(`Entrando a NextNovels: ${url}`);
  const response = await fetch(url, { 
    headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml" } 
  });
  
  if (!response.ok) throw new Error(`NextNovels respondió HTTP ${response.status}`);
  
  const html = await response.text();
  const links = new Set();
  
  // Buscamos todos los enlaces <a href="...">
  const re = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match;
  while ((match = re.exec(html))) {
    let href = (match[1] ?? match[2] ?? match[3] ?? "").replace(/&amp;/g, "&").trim();
    if (href.startsWith("//")) href = "https:" + href;
    if (isTerabox(href)) links.add(href);
  }
  
  if (links.size === 0) throw new Error("No se encontraron enlaces de TeraBox en la página de NextNovels.");
  return [...links];
}

// 2. Lista los archivos dentro del enlace de TeraBox usando su API oficial
async function listTeraboxFiles(shareUrl) {
  // Obtenemos el HTML de TeraBox para sacar el jsToken y el shorturl
  const res = await fetch(shareUrl, { headers: { "User-Agent": UA } });
  const html = await res.text();
  
  // Extraer shorturl (ej: 1abcde...)
  const shorturlMatch = html.match(/shorturl\s*=\s*["']([^"']+)["']/i) || html.match(/surl=([^&"']+)/i);
  if (!shorturlMatch) throw new Error("No se pudo extraer el ID del enlace de TeraBox.");
  let shorturl = shorturlMatch[1];
  if (shorturl.startsWith("1")) shorturl = shorturl.substring(1);
  
  // Extraer jsToken
  const tokenMatch = html.match(/jsToken\s*=\s*["']([^"']+)["']/i) || html.match(/"jsToken":"([^"]+)"/i);
  const jsToken = tokenMatch ? tokenMatch[1] : "";
  
  // Hacer petición a la API oficial de listado
  const apiUrl = `https://www.terabox.com/share/list?app_id=250528&shorturl=${shorturl}&root=1&page=1&num=100&jsToken=${jsToken}`;
  const apiRes = await fetch(apiUrl, { 
    headers: { "User-Agent": UA, "Referer": shareUrl, "Accept": "application/json" } 
  });
  
  const data = await apiRes.json();
  if (String(data.errno) !== "0") {
    throw new Error(`TeraBox rechazó el listado: ${data.errmsg || "Error desconocido"}`);
  }
  
  const files = [];
  if (data.list) {
    for (const item of data.list) {
      if (item.isdir === 0 || item.isdir === "0") {
        files.push({
          name: item.server_filename,
          fs_id: item.fs_id,
          size: item.size
        });
      }
    }
  }
  return files;
}

// 3. Genera el enlace de descarga final
async function getDownloadLink(shareUrl, fsId) {
  const res = await fetch(shareUrl, { headers: { "User-Agent": UA } });
  const html = await res.text();
  
  const shorturlMatch = html.match(/shorturl\s*=\s*["']([^"']+)["']/i) || html.match(/surl=([^&"']+)/i);
  let shorturl = shorturlMatch[1];
  if (shorturl.startsWith("1")) shorturl = shorturl.substring(1);
  
  const tokenMatch = html.match(/jsToken\s*=\s*["']([^"']+)["']/i) || html.match(/"jsToken":"([^"]+)"/i);
  const jsToken = tokenMatch ? tokenMatch[1] : "";
  
  const signMatch = html.match(/"sign":"([^"]+)"/i);
  const timestampMatch = html.match(/"timestamp":(\d+)/i);
  
  if (!signMatch || !timestampMatch) throw new Error("No se pudieron obtener los tokens de descarga.");
  
  const params = new URLSearchParams({
    app_id: "250528",
    sign: signMatch[1],
    timestamp: timestampMatch[1],
    shorturl: shorturl,
    fs_id: fsId,
    jsToken: jsToken
  });

  const dlRes = await fetch(`https://www.terabox.com/share/download?${params}`, {
    headers: { "User-Agent": UA, "Referer": shareUrl }
  });
  
  const data = await dlRes.json();
  if (String(data.errno) !== "0" || !data.dlink) {
    throw new Error(`TeraBox rechazó la descarga: ${data.errmsg || "Error"}`);
  }
  return data.dlink;
}

// 4. Genera el feed XML para OPDS/Stremio
function detailFeed(book, entries, requestUrl, message = "") {
  const base = new URL(requestUrl).origin, now = new Date().toISOString();
  let extra = message ? `<entry><title>Aviso</title><id>${xmlEscape(base + "/error")}</id><content type="text">${xmlEscape(message)}</content></entry>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog"><title>${xmlEscape(book.title)}</title><id>${xmlEscape(requestUrl)}</id><updated>${now}</updated>${book.cover ? `<link rel="http://opds-spec.org/image" href="${xmlEscape(book.cover)}"/>` : ""}${entries.join("\n")}${extra}</feed>`;
}

async function handleNovel(requestUrl) {
  const articleParam = requestUrl.searchParams.get("url");
  if (!articleParam) return textError("Falta la URL.", 400);
  
  const books = await getBooks();
  const book = books.find(b => b.url === articleParam);
  if (!book) return textError("Novela no encontrada en el catálogo.", 404);

  const origin = new URL(requestUrl).origin;
  const items = [];
  
  try {
    // 1. Entramos a NextNovels y sacamos los enlaces de TeraBox
    const shareLinks = await getTeraboxLinksFromNextNovels(book.url);
    
    // 2. Listamos los archivos de esos enlaces
    for (const share of shareLinks) {
      const files = await listTeraboxFiles(share);
      
      for (const file of files) {
        // Creamos la URL de descarga que apunta a nuestro propio Worker
        const dlUrl = `${origin}/descargar?share=${encodeURIComponent(share)}&fs_id=${file.fs_id}&name=${encodeURIComponent(file.name)}`;
        
        items.push(`<entry>
          <title>${xmlEscape(file.name)}</title>
          <id>${xmlEscape(file.fs_id)}</id>
          <updated>${new Date().toISOString()}</updated>
          <link rel="http://opds-spec.org/acquisition" href="${xmlEscape(dlUrl)}" type="application/epub+zip" title="${xmlEscape(file.name)}"/>
        </entry>`);
      }
    }
    
    if (items.length === 0) {
      return new Response(detailFeed(book, items, requestUrl, "No se encontraron archivos EPUB o PDF en los enlaces de TeraBox."), { headers: headers() });
    }
    
    return new Response(detailFeed(book, items, requestUrl), { headers: headers() });
    
  } catch (error) {
    return new Response(detailFeed(book, [], requestUrl, `Error: ${error.message}`), { headers: headers() });
  }
}

async function handleDownload(requestUrl) {
  const shareUrl = requestUrl.searchParams.get("share");
  const fsId = requestUrl.searchParams.get("fs_id");
  const filename = requestUrl.searchParams.get("name") || "archivo.epub";
  
  try {
    // Obtenemos el enlace directo de TeraBox
    const directUrl = await getDownloadLink(shareUrl, fsId);
    
    // Descargamos el archivo y lo enviamos al usuario
    const fileRes = await fetch(directUrl, { 
      headers: { "User-Agent": UA, "Referer": "https://www.terabox.com/" } 
    });
    
    if (!fileRes.ok) throw new Error("TeraBox no permitió descargar el archivo directamente.");
    
    return new Response(fileRes.body, {
      headers: {
        "Content-Type": "application/epub+zip",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
      }
    });
  } catch (error) {
    return textError(`Error al descargar: ${error.message}`, 502);
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/") return Response.redirect(`${url.origin}/catalogo/novedades.xml`, 302);
      if (url.pathname === "/novela") return handleNovel(url);
      if (url.pathname === "/descargar") return handleDownload(url);
      
      if (url.pathname.startsWith("/catalogo/")) {
        const response = await fetch(`${REPO}${url.pathname}`);
        if (!response.ok) return textError("Archivo no encontrado.", 404);
        const isXml = url.pathname.endsWith(".xml");
        return new Response(response.body, { 
          headers: { "Content-Type": isXml ? "application/atom+xml" : "application/json" } 
        });
      }
      return textError("Ruta no encontrada", 404);
    } catch (e) {
      return textError(`Error global: ${e.message}`, 500);
    }
  }
};
