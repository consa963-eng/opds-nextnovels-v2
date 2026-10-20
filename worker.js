const REPO = "https://raw.githubusercontent.com/consa963-eng/opds-nextnovels-v2/main";
const DATA_URL = `${REPO}/catalogo/catalogo.json`;

// Nueva API que soporta leer dentro de carpetas (subcarpetas)
const TERABOX_API = "https://api.teraboxdownloader.com/api/v1/terabox?url=";
const TERABOX_DL_API = "https://api.teraboxdownloader.com/api/v1/terabox/download";

function xmlEscape(value = "") {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function xmlCdata(value = "") {
  return String(value).replace(/]]>/g, "]]]]><![CDATA[>");
}

function entry(book) {
  const title = xmlEscape(book.title || "Sin título");
  const id = xmlEscape(book.id || book.url || title);
  const url = xmlEscape(book.url || "");
  const cover = book.cover ? xmlEscape(book.cover) : "";
  const author = book.author ? xmlEscape(book.author) : "";
  const summary = book.summary || "";

  let xml = `\n<entry>\n<title>${title}</title>\n<id>${id}</id>\n<link rel="alternate" href="${url}" type="text/html"/>\n`;
  if (cover) xml += `<link rel="http://opds-spec.org/image" href="${cover}"/>\n<link rel="http://opds-spec.org/image/thumbnail" href="${cover}"/>\n`;
  if (author) xml += `<author><name>${author}</name></author>\n`;
  for (const genre of book.genres || []) xml += `<category term="${xmlEscape(genre)}" label="${xmlEscape(genre)}"/>\n`;
  if (summary) xml += `<content type="html"><![CDATA[${xmlCdata(summary)}]]></content>\n`;

  if (book.downloads && book.downloads.length) {
    for (const download of book.downloads) {
      xml += `\n<link rel="http://opds-spec.org/acquisition" href="${xmlEscape(download.url)}" type="${xmlEscape(download.type || "application/epub+zip")}" title="${xmlEscape(download.title || "Descarga")}"/>\n`;
    }
  } else {
    xml += `\n<link rel="http://opds-spec.org/acquisition" href="${url}" type="text/html" title="Abrir en Next Novels"/>\n`;
  }

  xml += `</entry>`;
  return xml;
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
  return `<?xml version="1.0" encoding="UTF-8"?>\n<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">\n<ShortName>Next Novels</ShortName>\n<Description>Buscar novelas de Next Novels</Description>\n<InputEncoding>UTF-8</InputEncoding>\n<Url type="application/atom+xml;profile=opds-catalog;kind=acquisition" template="${xmlEscape(base)}/search?q={searchTerms}"/>\n</OpenSearchDescription>`;
}

async function getBooks() {
  const response = await fetch(DATA_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!response.ok) throw new Error(`No se pudo descargar catalogo.json: ${response.status}`);
  return await response.json();
}

function headers(type = "application/atom+xml; charset=UTF-8") {
  return { "Content-Type": type, "Cache-Control": "public, max-age=300" };
}

async function resolverTerabox(teraboxUrl) {
  // Pedimos la información a la nueva API
  const resp = await fetch(TERABOX_API + encodeURIComponent(teraboxUrl));
  if (!resp.ok) throw new Error(`API Terabox respondió ${resp.status}`);
  const data = await resp.json();
  
  if (!data.status || !data.list || data.list.length === 0) {
    throw new Error("Enlace privado, caducado o API caída");
  }

  let targetFile = null;

  // Buscamos el archivo dentro de la lista (la API ya navega por las subcarpetas si es necesario)
  for (const file of data.list) {
    if (file.is_dir === 0 && file.server_filename.toLowerCase().endsWith(".epub")) {
      targetFile = file;
      break; // Nos quedamos con el primer EPUB que encuentre
    }
  }

  // Si no hay EPUB, probamos con PDF
  if (!targetFile) {
    for (const file of data.list) {
      if (file.is_dir === 0 && file.server_filename.toLowerCase().endsWith(".pdf")) {
        targetFile = file;
        break;
      }
    }
  }

  if (!targetFile) throw new Error("No se encontraron archivos .epub o .pdf válidos");

  // Pedimos el enlace de descarga directa para ese archivo
  const dlinkResp = await fetch(TERABOX_DL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      shareid: data.shareid,
      uk: data.uk,
      fs_id: targetFile.fs_id,
      timestamp: data.timestamp,
      sign: data.sign
    })
  });

  const dlinkData = await dlinkResp.json();
  if (!dlinkData.status || !dlinkData.dlink) {
    throw new Error("No se pudo generar el enlace directo");
  }

  return {
    directUrl: dlinkData.dlink,
    fileName: targetFile.server_filename
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/" || url.pathname === "/index.xml") return new Response(rootFeed(request.url), { headers: headers() });
      if (url.pathname === "/opensearch.xml") return new Response(openSearch(request.url), { headers: headers("application/opensearchdescription+xml; charset=UTF-8") });

      if (url.pathname === "/descargar") {
        const teraboxUrl = url.searchParams.get("url");
        if (!teraboxUrl) return new Response("Falta el parámetro 'url'", { status: 400 });

        try {
          const { directUrl, fileName } = await resolverTerabox(teraboxUrl);
          
          const fileResp = await fetch(directUrl, {
            headers: {
              "Referer": "https://www.terabox.com/",
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
          });

          if (!fileResp.ok) return new Response(`Error al descargar desde Terabox: ${fileResp.status}`, { status: 502 });

          const outHeaders = new Headers();
          outHeaders.set("Content-Type", "application/epub+zip");
          outHeaders.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
          outHeaders.set("Cache-Control", "no-store");
          
          const length = fileResp.headers.get("Content-Length");
          if (length) outHeaders.set("Content-Length", length);

          return new Response(fileResp.body, { status: 200, headers: outHeaders });
        } catch (err) {
          return new Response(`Error en el proxy: ${err.message}`, { status: 502 });
        }
      }

      if (url.pathname === "/search") {
        const query = (url.searchParams.get("q") || "").trim().toLowerCase();
        if (!query) return new Response(feed("Buscar", `${url.origin}/search`, [], request.url), { headers: headers() });
        const books = await getBooks();
        const results = books.filter(book => [book.title, book.author, book.type, book.status, ...(book.genres || []), book.summary].filter(Boolean).join(" ").toLowerCase().includes(query));
        return new Response(feed(`Resultados: ${query}`, `${url.origin}/search?q=${encodeURIComponent(query)}`, results.slice(0, 200), request.url), { headers: headers() });
      }

      if (url.pathname.startsWith("/catalogo/")) {
        const target = `${REPO}${url.pathname}`;
        const response = await fetch(target);
        const isXml = url.pathname.endsWith(".xml") || url.pathname.endsWith(".opds");
        const contentType = isXml ? "application/atom+xml; charset=UTF-8" : response.headers.get("Content-Type") || "application/octet-stream";
        return new Response(response.body, { status: response.status, headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=300" } });
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      return new Response(`Error: ${error.message}`, { status: 502, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
    }
  }
};
