const REPO = "https://raw.githubusercontent.com/consa963-eng/opds-nextnovels-v2/main";
const DATA_URL = `${REPO}/catalogo/catalogo.json`;
const SITE_NAME = "Next Novels";
const PAGE_SIZE = 50;
const DATA_TTL_MS = 60_000;

const MIME = {
  nav: "application/atom+xml;profile=opds-catalog;kind=navigation",
  acq: "application/atom+xml;profile=opds-catalog;kind=acquisition",
  search: "application/opensearchdescription+xml",
  atom: "application/atom+xml; charset=UTF-8",
};

let cache = { at: 0, books: null };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function xmlEscape(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function normalizeText(text = "") {
  return String(text).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function toIsoDate(value, fallback) {
  const date = value ? new Date(value) : null;
  return date && !isNaN(date) ? date.toISOString() : fallback;
}

function textError(message, status = 502) {
  return new Response(String(message), {
    status,
    headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store" },
  });
}

function xmlResponse(xml, maxAge = 300) {
  return new Response(xml, {
    headers: { "Content-Type": MIME.atom, "Cache-Control": `public, max-age=${maxAge}` },
  });
}

async function getBooks() {
  const now = Date.now();
  if (cache.books && now - cache.at < DATA_TTL_MS) return cache.books;

  const response = await fetch(DATA_URL, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!response.ok) throw new HttpError(502, "No se pudo descargar catalogo.json");

  const raw = await response.json();
  if (!Array.isArray(raw)) throw new HttpError(502, "catalogo.json debe contener una lista");

  const fallbackDate = new Date(now).toISOString();
  const books = raw
    .filter(b => b && b.title && safeHttpUrl(b.url))
    .map(b => ({
      id: String(b.id || b.url),
      title: String(b.title),
      url: safeHttpUrl(b.url),
      cover: safeHttpUrl(b.cover),
      author: b.author ? String(b.author) : "",
      synopsis: b.summary || b.synopsis ? String(b.summary || b.synopsis) : "",
      status: b.status ? String(b.status) : "",
      updated: toIsoDate(b.updated || b.date, fallbackDate),
    }))
    .sort((a, b) => b.updated.localeCompare(a.updated));

  cache = { at: now, books };
  return books;
}

function feedXml({ id, title, updated, links = [], entries = "" }) {
  const linkXml = links
    .map(l => `  <link rel="${xmlEscape(l.rel)}" href="${xmlEscape(l.href)}" type="${xmlEscape(l.type)}"/>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>${xmlEscape(id)}</id>
  <title>${xmlEscape(title)}</title>
  <updated>${updated}</updated>
${linkXml}
${entries}
</feed>`;
}

function bookEntry(book, base) {
  const detailHref = `${base}/novela?url=${encodeURIComponent(book.url)}`;
  return `
  <entry>
    <title>${xmlEscape(book.title)}</title>
    <id>${xmlEscape(book.id)}</id>
    <updated>${book.updated}</updated>
    ${book.author ? `<author><name>${xmlEscape(book.author)}</name></author>` : ""}
    ${book.synopsis ? `<summary type="text">${xmlEscape(book.synopsis)}</summary>` : ""}
    ${book.cover ? `<link rel="http://opds-spec.org/image" href="${xmlEscape(book.cover)}" type="image/jpeg"/>` : ""}
    <link rel="subsection" href="${xmlEscape(detailHref)}" type="${MIME.acq}" title="Ficha"/>
    <link rel="alternate" href="${xmlEscape(book.url)}" type="text/html" title="Abrir en ${xmlEscape(SITE_NAME)}"/>
  </entry>`;
}

function paginate(books, page) {
  const total = Math.max(1, Math.ceil(books.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), total);
  return {
    items: books.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE),
    current,
    total,
  };
}

function parsePage(url) {
  const n = parseInt(url.searchParams.get("page") || "1", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function pageHref(base, path, params, page) {
  const query = new URLSearchParams({ ...params, page: String(page) });
  return `${base}${path}?${query.toString()}`;
}

function listingResponse({ base, path, title, books, page, params = {} }) {
  const { items, current, total } = paginate(books, page);
  const links = [
    { rel: "self", href: pageHref(base, path, params, current), type: MIME.acq },
    { rel: "start", href: `${base}/`, type: MIME.nav },
    { rel: "search", href: `${base}/opensearch.xml`, type: MIME.search },
  ];
  if (current > 1) links.push({ rel: "previous", href: pageHref(base, path, params, current - 1), type: MIME.acq });
  if (current < total) links.push({ rel: "next", href: pageHref(base, path, params, current + 1), type: MIME.acq });

  const updated = books[0]?.updated || new Date().toISOString();
  const entries = items.map(b => bookEntry(b, base)).join("");
  return xmlResponse(feedXml({
    id: pageHref(base, path, params, current),
    title: total > 1 ? `${title} (${current}/${total})` : title,
    updated,
    links,
    entries,
  }));
}

function rootResponse(base) {
  const now = new Date().toISOString();
  const sections = [
    { title: "Novedades", path: "/catalogo/novedades", desc: "Últimas novelas actualizadas" },
    { title: "Todas las novelas", path: "/catalogo/todos", desc: "Catálogo completo" },
  ];
  const entries = sections.map(s => `
  <entry>
    <title>${xmlEscape(s.title)}</title>
    <id>${xmlEscape(base + s.path)}</id>
    <updated>${now}</updated>
    <content type="text">${xmlEscape(s.desc)}</content>
    <link rel="subsection" href="${xmlEscape(base + s.path)}" type="${MIME.acq}"/>
  </entry>`).join("");

  return xmlResponse(feedXml({
    id: base + "/",
    title: SITE_NAME,
    updated: now,
    links: [
      { rel: "self", href: base + "/", type: MIME.nav },
      { rel: "start", href: base + "/", type: MIME.nav },
      { rel: "search", href: `${base}/opensearch.xml`, type: MIME.search },
    ],
    entries,
  }));
}

function openSearchResponse(base) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>${xmlEscape(SITE_NAME)}</ShortName>
  <Description>Buscar en el catálogo de ${xmlEscape(SITE_NAME)}</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Url type="${MIME.acq}" template="${xmlEscape(base)}/buscar?q={searchTerms}"/>
</OpenSearchDescription>`;
  return new Response(xml, {
    headers: { "Content-Type": MIME.search, "Cache-Control": "public, max-age=86400" },
  });
}

function detailResponse(book, base, requestUrl) {
  const now = new Date().toISOString();
  const entry = `
  <entry>
    <title>${xmlEscape(book.title)}</title>
    <id>${xmlEscape(book.id)}</id>
    <updated>${book.updated}</updated>
    ${book.author ? `<author><name>${xmlEscape(book.author)}</name></author>` : ""}
    ${book.status ? `<category term="${xmlEscape(book.status)}" label="${xmlEscape(book.status)}"/>` : ""}
    ${book.synopsis ? `<content type="text">${xmlEscape(book.synopsis)}</content>` : ""}
    ${book.cover ? `<link rel="http://opds-spec.org/image" href="${xmlEscape(book.cover)}" type="image/jpeg"/>` : ""}
    <link rel="alternate" href="${xmlEscape(book.url)}" type="text/html" title="Leer la ficha en ${xmlEscape(SITE_NAME)}"/>
  </entry>`;

  return xmlResponse(feedXml({
    id: requestUrl,
    title: book.title,
    updated: now,
    links: [
      { rel: "self", href: requestUrl, type: MIME.acq },
      { rel: "start", href: `${base}/`, type: MIME.nav },
    ],
    entries: entry,
  }), 600);
}

export default {
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return textError("Método no permitido", 405);
    }

    const url = new URL(request.url);
    const base = url.origin;
    const path = url.pathname.replace(/\.xml$/, "");

    try {
      if (path === "/" || path === "/index") return rootResponse(base);
      if (url.pathname === "/opensearch.xml") return openSearchResponse(base);

      if (path === "/catalogo/novedades") {
        const books = await getBooks();
        return listingResponse({
          base, path: "/catalogo/novedades", title: "Novedades",
          books, page: parsePage(url),
        });
      }

      if (path === "/catalogo/todos") {
        const books = await getBooks();
        return listingResponse({
          base, path: "/catalogo/todos", title: "Todas las novelas",
          books, page: parsePage(url),
        });
      }

      if (path === "/buscar") {
        const term = (url.searchParams.get("q") || "").trim();
        if (!term) return textError("Falta el término de búsqueda (q).", 400);

        const needle = normalizeText(term);
        const books = await getBooks();
        const matches = books.filter(b =>
          normalizeText(b.title).includes(needle) ||
          normalizeText(b.author).includes(needle) ||
          normalizeText(b.synopsis).includes(needle)
        );

        return listingResponse({
          base, path: "/buscar", title: `Resultados para "${term}"`,
          books: matches, page: parsePage(url), params: { q: term },
        });
      }

      if (path === "/novela") {
        const articleUrl = url.searchParams.get("url");
        if (!articleUrl) return textError("Falta el parámetro url.", 400);

        const books = await getBooks();
        const book = books.find(b => b.url === articleUrl);
        if (!book) return textError("Libro no encontrado en el catálogo.", 404);

        return detailResponse(book, base, request.url);
      }

      return textError("Ruta no encontrada", 404);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      return textError(`Error: ${error.message}`, status);
    }
  },
};
