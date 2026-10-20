const REPO = "https://raw.githubusercontent.com/consa963-eng/opds-nextnovels-v2/main";
const DATA_URL = `${REPO}/catalogo/catalogo.json`;

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

async function getBooks() {
  const response = await fetch(DATA_URL, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!response.ok) throw new Error("No se pudo descargar catalogo.json");
  return await response.json();
}

// Genera el feed del menú principal
function rootFeed(requestUrl) {
  const base = new URL(requestUrl).origin;
  const items = [
    ["Novedades", "/catalogo/novedades", "Últimas novelas actualizadas"],
    ["Todas las novelas", "/catalogo/todos", "Catálogo completo"]
  ];
  const entries = items.map(([title, path, desc]) => `
    <entry>
      <title>${xmlEscape(title)}</title>
      <id>${xmlEscape(base + path)}</id>
      <content type="text">${xmlEscape(desc)}</content>
      <link rel="subsection" href="${xmlEscape(base + path)}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
    </entry>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog"><title>Next Novels</title><id>${xmlEscape(base)}</id><updated>${new Date().toISOString()}</updated>${entries}</feed>`;
}

// Genera la lista de libros
function listFeed(title, books, requestUrl) {
  const base = new URL(requestUrl).origin;
  const entries = books.map(book => `
    <entry>
      <title>${xmlEscape(book.title)}</title>
      <id>${xmlEscape(book.id)}</id>
      <updated>${new Date().toISOString()}</updated>
      ${book.cover ? `<link rel="http://opds-spec.org/image" href="${xmlEscape(book.cover)}"/>` : ""}
      <link rel="alternate" href="${xmlEscape(book.url)}" type="text/html"/>
      <link rel="subsection" href="${xmlEscape(base + '/novela?url=' + encodeURIComponent(book.url))}" type="application/atom+xml;profile=opds-catalog;kind=acquisition" title="Ver enlaces"/>
    </entry>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog"><title>${xmlEscape(title)}</title><id>${xmlEscape(requestUrl)}</id><updated>${new Date().toISOString()}</updated>${entries}</feed>`;
}

// Genera la pantalla final del libro (aquí está el truco)
function detailFeed(book, requestUrl) {
  const base = new URL(requestUrl).origin;
  
  // En lugar de intentar descargar, creamos un enlace directo a NextNovels
  // para que el usuario lo abra en su navegador.
  const finalUrl = book.url; 
  
  const entry = `
    <entry>
      <title>Descargar: ${xmlEscape(book.title)}</title>
      <id>${xmlEscape(book.id)}</id>
      <updated>${new Date().toISOString()}</updated>
      ${book.cover ? `<link rel="http://opds-spec.org/image" href="${xmlEscape(book.cover)}"/>` : ""}
      <!-- Este enlace hará que Stremio abra la página de NextNovels en tu navegador -->
      <link rel="http://opds-spec.org/acquisition" href="${xmlEscape(finalUrl)}" type="text/html" title="Abrir en el navegador para descargar"/>
    </entry>`;

  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog"><title>${xmlEscape(book.title)}</title><id>${xmlEscape(requestUrl)}</id><updated>${new Date().toISOString()}</updated>${entry}</feed>`;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    try {
      // Menú principal
      if (url.pathname === "/" || url.pathname === "/index.xml") {
        return new Response(rootFeed(request.url), { headers: headers() });
      }
      
      // Listas
      if (url.pathname === "/catalogo/novedades" || url.pathname === "/catalogo/todos") {
        const books = await getBooks();
        const title = url.pathname.includes("novedades") ? "Novedades" : "Todas las novelas";
        // Si es novedades, mostramos las 50 primeras
        const list = url.pathname.includes("novedades") ? books.slice(0, 50) : books;
        return new Response(listFeed(title, list, request.url), { headers: headers() });
      }

      // Detalle del libro (Enlaces)
      if (url.pathname === "/novela") {
        const articleUrl = url.searchParams.get("url");
        if (!articleUrl) return textError("Falta la URL del libro.", 400);
        
        const books = await getBooks();
        const book = books.find(b => b.url === articleUrl);
        
        if (!book) return textError("Libro no encontrado en el catálogo.", 404);
        return new Response(detailFeed(book, request.url), { headers: headers() });
      }

      return textError("Ruta no encontrada", 404);
    } catch (e) {
      return textError(`Error: ${e.message}`, 500);
    }
  }
};
