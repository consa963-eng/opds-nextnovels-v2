const REPO = "https://raw.githubusercontent.com/Deiviz25/opds-nextnovels/main";

const DATA_URL = `${REPO}/catalogo/catalogo.json`;

// API pública que resuelve enlaces de Terabox a enlaces directos temporales.
const TERABOX_API =
  "https://terabox-worker.robinkumarshakya103.workers.dev/api?url=";

function xmlEscape(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlCdata(value = "") {
  return String(value)
    .replace(/]]>/g, "]]]]><![CDATA[>");
}

function entry(book) {
  const title = xmlEscape(book.title || "Sin título");
  const id = xmlEscape(book.id || book.url || title);
  const url = xmlEscape(book.url || "");
  const cover = book.cover ? xmlEscape(book.cover) : "";
  const author = book.author ? xmlEscape(book.author) : "";
  const summary = book.summary || "";

  let xml = `
<entry>
<title>${title}</title>
<id>${id}</id>
<link rel="alternate" href="${url}" type="text/html"/>
`;

  if (cover) {
    xml += `
<link rel="http://opds-spec.org/image" href="${cover}"/>
<link rel="http://opds-spec.org/image/thumbnail" href="${cover}"/>
`;
  }

  if (author) {
    xml += `<author><name>${author}</name></author>\n`;
  }

  for (const genre of book.genres || []) {
    xml += `<category term="${xmlEscape(genre)}" label="${xmlEscape(genre)}"/>\n`;
  }

  if (summary) {
    xml += `<content type="html"><![CDATA[${xmlCdata(summary)}]]></content>\n`;
  }

  if (book.downloads && book.downloads.length) {
    for (const download of book.downloads) {
      xml += `
<link
 rel="http://opds-spec.org/acquisition"
 href="${xmlEscape(download.url)}"
 type="${xmlEscape(download.type || "application/octet-stream")}"
 title="${xmlEscape(download.title || "Descarga")}"
/>
`;
    }
  } else {
    // Solo si NO hay descarga real, ofrecemos abrir la web como fallback.
    xml += `
<link
 rel="http://opds-spec.org/acquisition"
 href="${url}"
 type="text/html"
 title="Abrir en Next Novels"
/>
`;
  }

  xml += `</entry>`;

  return xml;
}

function feed(title, id, books, requestUrl, kind = "acquisition") {
  const now = new Date().toISOString();

  const entries = books.map(entry).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opds="http://opds-spec.org/2010/catalog"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">

<title>${xmlEscape(title)}</title>
<id>${xmlEscape(id)}</id>
<updated>${now}</updated>

<link
 rel="self"
 href="${xmlEscape(requestUrl)}"
 type="application/atom+xml;profile=opds-catalog;kind=${kind}"
/>

<link
 rel="start"
 href="${xmlEscape(new URL("/", requestUrl).href)}"
 type="application/atom+xml;profile=opds-catalog;kind=navigation"
/>

<link
 rel="search"
 href="${xmlEscape(new URL("/opensearch.xml", requestUrl).href)}"
 type="application/opensearchdescription+xml"
/>

<opensearch:totalResults>${books.length}</opensearch:totalResults>

${entries}

</feed>`;
}

function rootFeed(requestUrl) {
  const base = new URL(requestUrl).origin;

  // [title, path, description, kind]
  const items = [
    ["Novedades", "/catalogo/novedades.xml", "Últimas novelas actualizadas", "acquisition"],
    ["Todas las novelas", "/catalogo/todos.xml", "Catálogo completo", "acquisition"],
    ["Autores", "/catalogo/autores.xml", "Novelas agrupadas por autor", "navigation"],
    ["Géneros", "/catalogo/generos.xml", "Novelas agrupadas por género", "navigation"],
    ["Títulos A-Z", "/catalogo/titulos.xml", "Novelas ordenadas alfabéticamente", "acquisition"],
  ];

  const entries = items.map(([title, path, description, kind]) => `
<entry>
<title>${xmlEscape(title)}</title>
<id>${xmlEscape(base + path)}</id>
<content type="text">${xmlEscape(description)}</content>
<link
 rel="subsection"
 href="${xmlEscape(base + path)}"
 type="application/atom+xml;profile=opds-catalog;kind=${kind}"
/>
</entry>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opds="http://opds-spec.org/2010/catalog">

<title>Next Novels</title>
<id>${xmlEscape(base + "/")}</id>
<updated>${new Date().toISOString()}</updated>

<link
 rel="self"
 href="${xmlEscape(base + "/")}"
 type="application/atom+xml;profile=opds-catalog;kind=navigation"
/>

<link
 rel="search"
 href="${xmlEscape(base + "/opensearch.xml")}"
 type="application/opensearchdescription+xml"
/>

${entries}

</feed>`;
}

function openSearch(requestUrl) {
  const base = new URL(requestUrl).origin;

  return `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription
 xmlns="http://a9.com/-/spec/opensearch/1.1/"
 xmlns:atom="http://www.w3.org/2005/Atom">

<ShortName>Next Novels</ShortName>
<Description>Buscar novelas de Next Novels</Description>
<InputEncoding>UTF-8</InputEncoding>

<Url
 type="application/atom+xml;profile=opds-catalog;kind=acquisition"
 template="${xmlEscape(base)}/search?q={searchTerms}"
/>

</OpenSearchDescription>`;
}

async function getBooks() {
  const response = await fetch(DATA_URL, {
    cf: {
      cacheTtl: 300,
      cacheEverything: true
    }
  });

  if (!response.ok) {
    throw new Error(`No se pudo descargar catalogo.json: ${response.status}`);
  }

  return await response.json();
}

function headers(type = "application/atom+xml; charset=UTF-8") {
  return {
    "Content-Type": type,
    "Cache-Control": "public, max-age=300"
  };
}

// Resuelve un enlace de Terabox a un enlace directo temporal.
async function resolverTerabox(teraboxUrl) {
  const resp = await fetch(TERABOX_API + encodeURIComponent(teraboxUrl));
  if (!resp.ok) {
    throw new Error(`API Terabox respondió ${resp.status}`);
  }
  const data = await resp.json();

  const file = data?.files?.[0];
  const directUrl =
    file?.original_download_url ||
    file?.download_url ||
    data?.original_download_url ||
    data?.download_url;

  if (!directUrl) {
    throw new Error(
      `No se pudo resolver el enlace de Terabox: ${data?.error || "respuesta sin dlink"}`
    );
  }

  return {
    directUrl,
    fileName: file?.file_name || data?.file_name || "archivo"
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    try {
      // Catálogo principal
      if (url.pathname === "/" || url.pathname === "/index.xml") {
        return new Response(rootFeed(request.url), {
          headers: headers()
        });
      }

      // OpenSearch
      if (url.pathname === "/opensearch.xml") {
        return new Response(openSearch(request.url), {
          headers: headers("application/opensearchdescription+xml; charset=UTF-8")
        });
      }

      // Proxy de descarga directa (Terabox → archivo al cliente)
      if (url.pathname === "/descargar") {
        const teraboxUrl = url.searchParams.get("url");

        if (!teraboxUrl) {
          return new Response("Falta el parámetro 'url'", { status: 400 });
        }

        try {
          const { directUrl, fileName } = await resolverTerabox(teraboxUrl);

          const fileResp = await fetch(directUrl, {
            headers: {
              "Referer": "https://www.terabox.com/",
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            }
          });

          if (!fileResp.ok) {
            return new Response(
              `Error al descargar desde Terabox: ${fileResp.status}`,
              { status: 502 }
            );
          }

          const outHeaders = new Headers();
          outHeaders.set(
            "Content-Type",
            fileResp.headers.get("Content-Type") || "application/octet-stream"
          );
          outHeaders.set(
            "Content-Disposition",
            `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
          );
          // Los dlinks de Terabox caducan: no cachear.
          outHeaders.set("Cache-Control", "no-store");

          const length = fileResp.headers.get("Content-Length");
          if (length) outHeaders.set("Content-Length", length);

          return new Response(fileResp.body, {
            status: 200,
            headers: outHeaders
          });
        } catch (err) {
          return new Response(`Error en el proxy de descarga: ${err.message}`, {
            status: 502,
            headers: { "Content-Type": "text/plain; charset=UTF-8" }
          });
        }
      }

      // Búsqueda real
      if (url.pathname === "/search") {
        const query = (url.searchParams.get("q") || "").trim().toLowerCase();

        if (!query) {
          return new Response(
            feed("Buscar en Next Novels", `${url.origin}/search`, [], request.url),
            { headers: headers() }
          );
        }

        const books = await getBooks();

        const results = books.filter(book => {
          const text = [
            book.title,
            book.author,
            book.translator,
            book.type,
            book.status,
            ...(book.genres || []),
            book.summary
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

          return text.includes(query);
        });

        return new Response(
          feed(
            `Resultados: ${query}`,
            `${url.origin}/search?q=${encodeURIComponent(query)}`,
            results.slice(0, 200),
            request.url
          ),
          { headers: headers() }
        );
      }

      // XMLs estáticos generados por GitHub. Forzamos Content-Type XML.
      if (url.pathname.startsWith("/catalogo/")) {
        const target = `${REPO}${url.pathname}`;

        const response = await fetch(target);

        const isXml =
          url.pathname.endsWith(".xml") || url.pathname.endsWith(".opds");

        const contentType = isXml
          ? "application/atom+xml; charset=UTF-8"
          : response.headers.get("Content-Type") || "application/octet-stream";

        return new Response(response.body, {
          status: response.status,
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=300"
          }
        });
      }

      return new Response("Not Found", { status: 404 });

    } catch (error) {
      return new Response(
        `Error del catálogo OPDS: ${error.message}`,
        {
          status: 502,
          headers: {
            "Content-Type": "text/plain; charset=UTF-8"
          }
        }
      );
    }
  }
};
