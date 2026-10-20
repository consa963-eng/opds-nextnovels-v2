const REPO = "https://raw.githubusercontent.com/consa963-eng/opds-nextnovels-v2/main";
const DATA_URL = `${REPO}/catalogo/catalogo.json`;

// API oficial del proyecto terabox-dl
const TERABOX_API = "https://terabox-dl.vercel.app/api/info?url=";
const TERABOX_DL_API = "https://terabox-dl.vercel.app/api/download";

function xmlEscape(value = "") {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function xmlCdata(value = "") { return String(value).replace(/]]>/g, "]]]]><![CDATA[>"); }

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
      xml += `\n<link rel="http://opds-spec.org/acquisition" href="${xmlEscape(download.url)}" type="${xmlEscape(download.type || "application/epub+zip")}" title="${xmlEscape(download.title || "Descargar")}"/>\n`;
    }
  } else if (book.url) {
    xml += `\n<link rel="http://opds-spec.org/acquisition" href="${url}" type="text/html" title="Abrir en Next Novels"/>\n`;
  }
  xml += "</entry>";
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
  return `<?xml version="1.0" encoding="UTF-8"?>\n<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">\n<ShortName>Next Novels</ShortName>\n<Description>Buscar novelas de Next Novels</Description>\n<InputEncoding>UTF-8</InputEncoding>\n<Url type="application/atom+xml;profile=opds-catalog;kind=acquisition" template="${xmlEscape(base)}/search?q={searchTerms}"/>\n</OpenSearchDescription>`;
}

async function getBooks() {
  const response = await fetch(DATA_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!response.ok) throw new Error(`No se pudo descargar catalogo.json: ${response.status}`);
  return await response.json();
}

function headers(type = "application/atom+xml; charset=UTF-8") { return { "Content-Type": type, "Cache-Control": "public, max-age=300" }; }

async function resolverTerabox(teraboxUrl) {
  const resp = await fetch(TERABOX_API + encodeURIComponent(teraboxUrl));
  if (!resp.ok) throw new Error(`API respondió ${resp.status}`);
  
  const data = await resp.json();
  
  if (!data.ok || !data.list || data.list.length === 0) {
    throw new Error("Terabox bloqueó la petición o el enlace está roto.");
  }

  // Buscamos el primer EPUB o PDF (soporta que estén en carpetas)
  let targetFile = data.list.find(f => (f.is_dir === 0 || f.is_dir === "0") && f.server_filename.toLowerCase().endsWith(".epub"));
  if (!targetFile) {
    targetFile = data.list.find(f => (f.is_dir === 0 || f.is_dir === "0") && f.server_filename.toLowerCase().endsWith(".pdf"));
  }
  
  if (!targetFile) throw new Error("No hay archivos .epub o .pdf en la carpeta");

  const dlinkResp = await fetch(TERABOX_DL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sign: data.sign,
      timestamp: data.timestamp,
      shareid: data.shareid,
      uk: data.uk,
      fs_id: targetFile.fs_id
    })
  });

  const dlinkData = await dlinkResp.json();
  if (!dlinkData.ok || !dlinkData.dlink) throw new Error("No se pudo generar el enlace de descarga directo");

  return { directUrl: dlinkData.dlink, fileName: targetFile.server_filename };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/" || url.pathname === "/index.xml") return new Response(rootFeed(request.url), { headers: headers() });
      if (url.pathname === "/opensearch.xml") return new Response(openSearch(request.url), { headers: headers("application/opensearchdescription+xml; charset=UTF-8") });

      if (url.pathname === "/descargar") {
        const teraboxUrl = url.searchParams.get("url");
        if (!teraboxUrl) return new Response("Falta el parámetro url", { status: 400 });

        try {
          const { directUrl, fileName } = await resolverTerabox(teraboxUrl);
          
          const fileResp = await fetch(directUrl, {
            headers: { "Referer": "https://www.terabox.com/", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
          });

          if (!fileResp.ok) return new Response(`Error al descargar desde los servidores de Terabox (${fileResp.status}).`, { status: 502 });

          const outHeaders = new Headers();
          outHeaders.set("Content-Type", fileName.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/epub+zip");
          outHeaders.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
          
          return new Response(fileResp.body, { status: 200, headers: outHeaders });
        } catch (err) {
          // Si falla, devolvemos un error de texto (así Readest no se queda en blanco)
          return new Response(`Error del servidor: ${err.message}`, { status: 502, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
        }
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
        if (!response.ok) return new Response("Catálogo no encontrado", { status: response.status });
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
