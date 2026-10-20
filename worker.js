const REPO = "https://raw.githubusercontent.com/consa963-eng/opds-nextnovels-v2/main";
const DATA_URL = `${REPO}/catalogo/catalogo.json`;

// --------------------------------------------------
// UTILIDADES XML
// --------------------------------------------------

function xmlEscape(value = "") {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function xmlCdata(value = "") {
  return String(value).replace(/]]>/g, "]]]]><![CDATA[>");
}

// --------------------------------------------------
// ENTRADAS DEL CATÁLOGO
// --------------------------------------------------

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

  if (Array.isArray(book.downloads) && book.downloads.length > 0) {
    for (const download of book.downloads) {
      if (!download.url) continue;
      xml += `\n<link rel="http://opds-spec.org/acquisition" href="${xmlEscape(download.url)}" type="${xmlEscape(download.type || "application/epub+zip")}" title="${xmlEscape(download.title || "Descarga")}"/>\n`;
    }
  } else if (book.url) {
    xml += `\n<link rel="http://opds-spec.org/acquisition" href="${url}" type="text/html" title="Abrir en Next Novels"/>\n`;
  }

  xml += "</entry>";
  return xml;
}

// --------------------------------------------------
// FEED OPDS
// --------------------------------------------------

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
  const books = await response.json();
  if (!Array.isArray(books)) throw new Error("El catálogo no contiene una lista de novelas");
  return books;
}

function headers(type = "application/atom+xml; charset=UTF-8") {
  return { "Content-Type": type, "Cache-Control": "public, max-age=300" };
}

// --------------------------------------------------
// RESOLVER TERABOX (USANDO COOKIE)
// --------------------------------------------------
async function resolverTerabox(teraboxUrl, cookie) {
  let surl = "";
  const urlObj = new URL(teraboxUrl);
  
  if (urlObj.searchParams.has("surl")) {
    surl = urlObj.searchParams.get("surl");
  } else {
    const match = teraboxUrl.match(/\/s\/([^?]+)/);
    if (match) surl = match[1];
  }

  if (!surl) throw new Error("No se pudo extraer el código de Terabox");

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Cookie": cookie,
    "Referer": "https://www.terabox.com/"
  };

  // 1. Pedir lista del nivel 1
  const apiUrl = `https://www.terabox.com/share/list?app_id=250528&shorturl=${surl}&root=1&web=1&clienttype=0`;
  const resp = await fetch(apiUrl, { headers });
  const data = await resp.json();
  
  if (!data.list || data.list.length === 0) throw new Error("Terabox no devolvió archivos (cookie caducada o enlace privado)");

  const findFile = (list) => {
    let epub = list.find(f => f.isdir === "0" && f.server_filename.toLowerCase().endsWith(".epub"));
    if (epub) return epub;
    let pdf = list.find(f => f.isdir === "0" && f.server_filename.toLowerCase().endsWith(".pdf"));
    if (pdf) return pdf;
    return null;
  };

  let targetFile = findFile(data.list);
  let folderPath = "/";

  // 2. Si es una carpeta, entrar (Nivel 2)
  if (!targetFile && data.list[0].isdir === "1") {
    const folder1 = data.list[0];
    const folder1ApiUrl = `https://www.terabox.com/share/list?app_id=250528&shorturl=${surl}&root=1&dir=${encodeURIComponent(folder1.path)}&web=1&clienttype=0`;
    const resp1 = await fetch(folder1ApiUrl, { headers });
    const data1 = await resp1.json();
    
    if (data1.list) {
      targetFile = findFile(data1.list);
      folderPath = folder1.path;
      
      // Si dentro de esa carpeta hay OTRA carpeta, entramos (Nivel 3)
      if (!targetFile && data1.list[0] && data1.list[0].isdir === "1") {
        const folder2 = data1.list[0];
        const folder2ApiUrl = `https://www.terabox.com/share/list?app_id=250528&shorturl=${surl}&root=1&dir=${encodeURIComponent(folder2.path)}&web=1&clienttype=0`;
        const resp2 = await fetch(folder2ApiUrl, { headers });
        const data2 = await resp2.json();
        if (data2.list) {
          targetFile = findFile(data2.list);
          folderPath = folder2.path;
        }
      }
    }
  }

  if (!targetFile) throw new Error("No se encontraron archivos EPUB o PDF en la carpeta");

  // 3. Generar dlink
  const dlinkApiUrl = `https://www.terabox.com/api/download?app_id=250528&web=1&channel=chunlei&clienttype=0&sign=${data.sign}&timestamp=${data.timestamp}&fs_id=${targetFile.fs_id}&dir=${encodeURIComponent(folderPath)}`;
  const dlinkResp = await fetch(dlinkApiUrl, { headers });
  const dlinkData = await dlinkResp.json();
  
  let directUrl = dlinkData.dlink;
  if (!directUrl || dlinkData.errno !== 0) {
    directUrl = `https://www.terabox.com/download?app_id=250528&web=1&sign=${data.sign}&timestamp=${data.timestamp}&fs_id=${targetFile.fs_id}&dir=${encodeURIComponent(folderPath)}`;
  }

  return { directUrl, fileName: targetFile.server_filename };
}

// --------------------------------------------------
// WORKER
// --------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/" || url.pathname === "/index.xml") return new Response(rootFeed(request.url), { headers: headers() });
      if (url.pathname === "/opensearch.xml") return new Response(openSearch(request.url), { headers: headers("application/opensearchdescription+xml; charset=UTF-8") });

      if (url.pathname === "/descargar") {
        const teraboxUrl = url.searchParams.get("url");
        if (!teraboxUrl) return new Response("Falta el parámetro url", { status: 400 });

        let parsed;
        try { parsed = new URL(teraboxUrl); } catch { return new Response("URL inválida", { status: 400 }); }

        const host = parsed.hostname.toLowerCase();
        const esTerabox =
          host === "terabox.com" || host.endsWith(".terabox.com") ||
          host === "terabox.app" || host.endsWith(".terabox.app") ||
          host === "1024tera.com" || host.endsWith(".1024tera.com") ||
          host === "teraboxapp.com" || host.endsWith(".teraboxapp.com");

        if (parsed.protocol !== "https:" || !esTerabox) return new Response("El enlace no es de Terabox", { status: 400 });

        // Verificamos que tenemos la cookie guardada en Cloudflare
        const cookie = env.TERABOX_COOKIE;
        if (!cookie) return new Response("Falta configurar el secreto TERABOX_COOKIE en Cloudflare", { status: 500 });

        try {
          const { directUrl, fileName } = await resolverTerabox(teraboxUrl, cookie);
          const fileResp = await fetch(directUrl, {
            headers: {
              "Referer": "https://www.terabox.com/",
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
          });

          if (!fileResp.ok) return new Response(`Error al descargar archivo: ${fileResp.status}`, { status: 502 });

          const isPdf = fileName.toLowerCase().endsWith(".pdf");
          const outHeaders = new Headers();
          outHeaders.set("Content-Type", isPdf ? "application/pdf" : "application/epub+zip");
          outHeaders.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
          outHeaders.set("Cache-Control", "no-store");

          const length = fileResp.headers.get("Content-Length");
          if (length) outHeaders.set("Content-Length", length);

          return new Response(fileResp.body, { status: 200, headers: outHeaders });
        } catch (err) {
          return new Response(`Error en el proxy: ${err.message}`, { status: 502, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
        }
      }

      if (url.pathname === "/search") {
        const query = (url.searchParams.get("q") || "").trim().toLowerCase();
        if (!query) return new Response(feed("Buscar", `${url.origin}/search`, [], request.url), { headers: headers() });
        const books = await getBooks();
        const results = books.filter(book => [book.title, book.author, book.type, book.status, ...(Array.isArray(book.genres) ? book.genres : []), book.summary].filter(Boolean).join(" ").toLowerCase().includes(query));
        return new Response(feed(`Resultados: ${query}`, `${url.origin}/search?q=${encodeURIComponent(query)}`, results.slice(0, 200), request.url), { headers: headers() });
      }

      if (url.pathname.st
