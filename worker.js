// Next Novels · catálogo OPDS (Cloudflare Worker)
// Sirve el catálogo generado en el repositorio y añade búsqueda con
// ranking y paginación. Los XML de /catalogo/ se sirven desde el repo.

const DEFAULT_REPO = "https://raw.githubusercontent.com/consa963-eng/opds-nextnovels-v2/main";
const CACHE_SECONDS = 300;
const PAGE_SIZE = 50;
const MAX_QUERY_LENGTH = 200;
const MAX_SUMMARY = 5000;
// Debe coincidir con VERSION_REL de generador.py.
const VERSION_REL = "http://opds-spec.org/acquisition";

const ATOM_TYPE = "application/atom+xml";
const ATOM_CT = `${ATOM_TYPE}; charset=UTF-8`;
const ACQ_TYPE = `${ATOM_TYPE};profile=opds-catalog;kind=acquisition`;
const NAV_TYPE = `${ATOM_TYPE};profile=opds-catalog;kind=navigation`;
const OPENSEARCH_TYPE = "application/opensearchdescription+xml";
const OPENSEARCH_CT = `${OPENSEARCH_TYPE}; charset=UTF-8`;

// Solo se sirven los XML planos del catálogo (evita proxyar rutas arbitrarias).
const CATALOG_FILE = /^\/catalogo\/[A-Za-z0-9._-]+\.xml$/;

const ROOT_ITEMS = [
  ["Novedades", "novedades.xml", "Últimas novelas actualizadas", ACQ_TYPE],
  ["Todas las novelas", "todos.xml", "Catálogo completo", ACQ_TYPE],
  ["Autores", "autores.xml", "Novelas agrupadas por autor", NAV_TYPE],
  ["Géneros", "generos.xml", "Novelas agrupadas por género", NAV_TYPE],
  ["Títulos A-Z", "titulos.xml", "Novelas ordenadas alfabéticamente", ACQ_TYPE],
];

// Caché en memoria del índice de búsqueda (por isolate).
let memo = { at: 0, index: null };

// ---------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------

function repoBase(env) {
  return (env?.REPO_BASE || DEFAULT_REPO).replace(/\/+$/, "");
}

function xmlEscape(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Minúsculas y sin acentos, para que "accion" encuentre "Acción".
function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Atom exige fecha-hora RFC 3339; los datos traen solo AAAA-MM-DD.
function atomDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "")
    ? `${value}T00:00:00Z`
    : "1970-01-01T00:00:00Z";
}

function link(rel, href, type, title) {
  let attrs = ` rel="${xmlEscape(rel)}" href="${xmlEscape(href)}"`;
  if (type) attrs += ` type="${xmlEscape(type)}"`;
  if (title) attrs += ` title="${xmlEscape(title)}"`;
  return `<link${attrs}/>`;
}

function xmlHeaders(type = ATOM_CT) {
  return {
    "Content-Type": type,
    "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
  };
}

function text(body, status) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=UTF-8" },
  });
}

// ---------------------------------------------------------------
// Atom / OPDS
// ---------------------------------------------------------------

// "Nombre (12 volúmenes)", o solo el nombre si no se conoce el número.
function versionTitle(v) {
  const nombre = v.nombre || "Versión";
  const n = v.volumenes;
  if (!n) return nombre;
  return `${nombre} (${n} ${n === 1 ? "volumen" : "volúmenes"})`;
}

function entry(book) {
  const url = book.url || "";
  const title = book.title || "Sin título";

  const x = [
    "<entry>",
    `<title>${xmlEscape(title)}</title>`,
    `<id>${xmlEscape(book.id || url || title)}</id>`,
    `<updated>${atomDate(book.updated)}</updated>`,
    link("alternate", url, "text/html"),
  ];

  if (book.cover) {
    x.push(link("http://opds-spec.org/image", book.cover));
    x.push(link("http://opds-spec.org/image/thumbnail", book.cover));
  }

  if (book.author) {
    x.push(`<author><name>${xmlEscape(book.author)}</name></author>`);
  }

  for (const genre of book.genres || []) {
    x.push(`<category term="${xmlEscape(genre)}" label="${xmlEscape(genre)}"/>`);
  }

  if (book.summary) {
    const summary = String(book.summary).slice(0, MAX_SUMMARY);
    x.push(`<content type="text">${xmlEscape(summary)}</content>`);
  }

  // Mismas versiones que en los feeds estáticos. Sin ellas, la búsqueda
  // no ofrecería descargas.
  const versiones = Array.isArray(book.versiones) && book.versiones.length
    ? book.versiones
    : [{ nombre: "Abrir en Next Novels", url }];

  for (const v of versiones) {
    if (v.url) {
      x.push(link(VERSION_REL, v.url, "text/html", versionTitle(v)));
    }
  }

  x.push("</entry>");
  return x.join("\n");
}

function feedXml({ id, title, updated, links, entries, total }) {
  const totalLine = total === undefined
    ? ""
    : `<opensearch:totalResults>${total}</opensearch:totalResults>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opds="http://opds-spec.org/2010/catalog"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
<id>${xmlEscape(id)}</id>
<title>${xmlEscape(title)}</title>
<updated>${updated}</updated>
${links.join("\n")}
${totalLine}
${entries.join("\n")}
</feed>`;
}

function rootFeed(url, updated) {
  const base = url.origin;

  const entries = ROOT_ITEMS.map(([title, file, description, type]) =>
    [
      "<entry>",
      `<title>${xmlEscape(title)}</title>`,
      `<id>${xmlEscape(`${base}/catalogo/${file}`)}</id>`,
      `<updated>${updated}</updated>`,
      `<content type="text">${xmlEscape(description)}</content>`,
      link("subsection", `${base}/catalogo/${file}`, type),
      "</entry>",
    ].join("\n")
  );

  return feedXml({
    id: `${base}/`,
    title: "Next Novels",
    updated,
    links: [
      link("self", `${base}/`, NAV_TYPE),
      link("start", `${base}/`, NAV_TYPE),
      link("search", `${base}/opensearch.xml`, OPENSEARCH_TYPE),
    ],
    entries,
  });
}

function openSearch(url) {
  const template = `${url.origin}/search?q={searchTerms}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
<ShortName>Next Novels</ShortName>
<Description>Buscar novelas de Next Novels</Description>
<InputEncoding>UTF-8</InputEncoding>
<Language>es</Language>
<Url type="${ACQ_TYPE}" template="${xmlEscape(template)}"/>
</OpenSearchDescription>`;
}

// ---------------------------------------------------------------
// Datos y búsqueda
// ---------------------------------------------------------------

async function fetchBooks(env) {
  const response = await fetch(`${repoBase(env)}/catalogo/catalogo.json`, {
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
  });

  if (!response.ok) {
    throw new Error(`catalogo.json: HTTP ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

function indexBook(book) {
  return {
    book,
    fields: [
      [normalize(book.title), 5],
      [normalize(book.author), 3],
      [normalize(book.translator), 2],
      [normalize((book.genres || []).join(" ")), 2],
      [normalize(book.type), 1],
      [normalize(book.status), 1],
      [normalize(book.summary), 1],
    ],
  };
}

async function getIndex(env) {
  const now = Date.now();
  if (memo.index && now - memo.at < CACHE_SECONDS * 1000) {
    return memo.index;
  }

  const books = await fetchBooks(env);
  memo = { at: now, index: books.map(indexBook) };
  return memo.index;
}

// Cada término debe aparecer en algún campo, en cualquier orden.
// La puntuación premia coincidencias en título y autor.
function scoreFields(fields, terms) {
  let score = 0;

  for (const term of terms) {
    let best = 0;
    for (const [text, weight] of fields) {
      if (weight > best && text.includes(term)) best = weight;
    }
    if (best === 0) return 0;
    score += best;
  }

  return score;
}

function rank(index, terms) {
  return index
    .map(({ book, fields }) => ({ book, score: scoreFields(fields, terms) }))
    .filter(r => r.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      String(a.book.title || "").localeCompare(String(b.book.title || ""), "es")
    );
}

async function handleSearch(url, env) {
  const rawQuery = (url.searchParams.get("q") || "")
    .slice(0, MAX_QUERY_LENGTH)
    .trim();
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const origin = url.origin;
  const terms = normalize(rawQuery).split(" ").filter(Boolean);
  const updated = new Date().toISOString();

  const pageUrl = (n) => {
    const u = new URL(`${origin}/search`);
    if (rawQuery) u.searchParams.set("q", rawQuery);
    if (n > 1) u.searchParams.set("page", String(n));
    return u.href;
  };

  const results = terms.length ? rank(await getIndex(env), terms) : [];
  const total = results.length;
  const offset = (page - 1) * PAGE_SIZE;
  const items = results.slice(offset, offset + PAGE_SIZE).map(r => r.book);

  const links = [
    link("self", pageUrl(page), ACQ_TYPE),
    link("start", `${origin}/`, NAV_TYPE),
    link("search", `${origin}/opensearch.xml`, OPENSEARCH_TYPE),
  ];
  if (page > 1) links.push(link("previous", pageUrl(page - 1), ACQ_TYPE));
  if (offset + PAGE_SIZE < total) links.push(link("next", pageUrl(page + 1), ACQ_TYPE));

  return feedXml({
    id: `${origin}/search?q=${encodeURIComponent(rawQuery)}`,
    title: rawQuery ? `Resultados: ${rawQuery}` : "Buscar en Next Novels",
    updated,
    total,
    links,
    entries: items.map(entry),
  });
}

async function proxyCatalogFile(pathname, env) {
  if (!CATALOG_FILE.test(pathname)) {
    return text("Not Found", 404);
  }

  const upstream = await fetch(`${repoBase(env)}${pathname}`, {
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
  });

  if (!upstream.ok) {
    return text("Not Found", upstream.status === 404 ? 404 : 502);
  }

  return new Response(upstream.body, { headers: xmlHeaders(ATOM_CT) });
}

// ---------------------------------------------------------------
// Enrutado
// ---------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/" || url.pathname === "/index.xml") {
        return new Response(rootFeed(url, new Date().toISOString()), {
          headers: xmlHeaders(),
        });
      }

      if (url.pathname === "/opensearch.xml") {
        return new Response(openSearch(url), {
          headers: xmlHeaders(OPENSEARCH_CT),
        });
      }

      if (url.pathname === "/search") {
        return new Response(await handleSearch(url, env), {
          headers: xmlHeaders(),
        });
      }

      if (url.pathname.startsWith("/catalogo/")) {
        return proxyCatalogFile(url.pathname, env);
      }

      return text("Not Found", 404);
    } catch (error) {
      console.error("OPDS error:", error);
      return text("Error temporal del catálogo. Inténtalo de nuevo en unos minutos.", 502);
    }
  },
};
