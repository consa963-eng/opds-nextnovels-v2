const REPO = "https://raw.githubusercontent.com/consa963-eng/opds-nextnovels-v2/main";
const DATA_URL = `${REPO}/catalogo/catalogo.json`;

function xmlEscape(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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

  xml += `
<link
 rel="http://opds-spec.org/acquisition"
 href="${url}"
 type="text/html"
 title="Abrir en Next Novels"
/>
`;

  xml += `</entry>`;
  return xml;
}

function feed(title, id, books, requestUrl) {
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
 type="application/atom+xml;profile=opds-catalog;kind=acquisition"
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

  const items = [
    ["Novedades", "/catalogo/novedades.xml", "Últimas novelas actualizadas"],
    ["Todas las novelas", "/catalogo/todos.xml", "Catálogo completo"],
    ["Autores", "/catalogo/autores.xml", "Novelas agrupadas por autor"],
    ["Géneros", "/catalogo/generos.xml", "Novelas agrupadas por género"],
    ["Títulos A-Z", "/catalogo/titulos.xml", "Novelas ordenadas alfabéticamente"],
  ];

  const entries = items
    .map(([title, path, description]) => `
<entry>
<title>${xmlEscape(title)}</title>
<id>${xmlEscape(base + path)}</id>
<content type="text">${xmlEscape(description)}</content>
<link
 rel="subsection"
 href="${xmlEscape(base + path)}"
 type="application/atom+xml;profile=opds-catalog;kind=acquisition"
/>
</entry>`)
    .join("\n");

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
    cf: { cacheTtl: 300, cacheEverything: true },
  });

  if (!response.ok) {
    throw new Error(`No se pudo descargar catalogo.json: ${response.status}`);
  }

  return await response.json();
}

function headers(type = "application/atom+xml; charset=UTF-8") {
  return {
    "Content-Type": type,
    "Cache-Control": "public, max-age=300",
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/" || url.pathname === "/index.xml") {
        return new Response(rootFeed(request.url), { headers: headers() });
      }

      if (url.pathname === "/opensearch.xml") {
        return new Response(openSearch(request.url), {
          headers: headers("application/opensearchdescription+xml; charset=UTF-8"),
        });
      }

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
            book.summary,
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

      if (url.pathname.startsWith("/catalogo/")) {
        const response = await fetch(`${REPO}${url.pathname}`);

        return new Response(response.body, {
          status: response.status,
          headers: {
            "Content-Type":
              response.headers.get("Content-Type") ||
              "application/atom+xml; charset=UTF-8",
            "Cache-Control": "public, max-age=300",
          },
        });
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      return new Response(`Error del catálogo OPDS: ${error.message}`, {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=UTF-8" },
      });
    }
  },
};
