    """Una novela es navegación; los volúmenes se enumeran al entrar en su ficha."""
    title = escape(book.get("title") or "Sin título")
    book_url = book.get("url", "")
    parts = ["<entry>", f"<title>{title}</title>", f"<id>{escape(book.get('id') or book_url)}</id>"]
    if book.get("summary"):
        parts.append(f"<content type=\"text\">{escape(book['summary'][:1500])}</content>")
    if book.get("author"):
        parts.append(f"<author><name>{escape(book['author'])}</name></author>")
    if book.get("cover"):
        mime = image_type(book["cover"])
        parts.append(f"<link rel=\"http://opds-spec.org/image\" href={quoteattr(book['cover'])} type={quoteattr(mime)}/>")
        parts.append(f"<link rel=\"http://opds-spec.org/image/thumbnail\" href={quoteattr(book['cover'])} type={quoteattr(mime)}/>")
    if book_url:
        parts.append(f"<link rel=\"alternate\" href={quoteattr(book_url)} type=\"text/html\"/>")
        parts.append(f"<link rel=\"subsection\" href={quoteattr(detail_url(book))} type=\"application/atom+xml;profile=opds-catalog;kind=acquisition\" title=\"Ver EPUB y PDF\"/>")
    parts.append("</entry>")
    return "\n".join(parts)


def feed(title, feed_id, items, self_url, kind="navigation"):
    parts = ['<?xml version="1.0" encoding="utf-8"?>',
             '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">',
             f"<id>{escape(feed_id)}</id>", f"<title>{escape(title)}</title>",
             f"<updated>{datetime.now(timezone.utc).isoformat()}</updated>",
             f'<link rel="self" href={quoteattr(self_url)} type="application/atom+xml;profile=opds-catalog;kind={kind}"/>',
             f'<link rel="start" href={quoteattr(WORKER_BASE + "/")} type="application/atom+xml;profile=opds-catalog;kind=navigation"/>']
    parts.extend(ent(book) for book in items)
    parts.append("</feed>")
    return "\n".join(parts)


def clean_old_feeds():
    for pattern, regex in (("autores-*.xml", r"autores-[0-9a-f]{10}\.xml"),
                           ("generos-*.xml", r"generos-[0-9a-f]{10}\.xml")):
        for file in OUT.glob(pattern):
            if not re.fullmatch(regex, file.name):
                file.unlink()


def generate(books):
    books = list({book["url"]: book for book in books if book.get("url")}.values())
    books.sort(key=lambda book: book.get("title", "").lower())
    save_books(books)
    clean_old_feeds()
    nav = [("Novedades", "novedades.xml"), ("Todas las novelas", "todos.xml"),
           ("Autores", "autores.xml"), ("Géneros", "generos.xml"), ("Títulos A-Z", "titulos.xml")]
    root = ['<?xml version="1.0" encoding="utf-8"?>',
            '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">',
            '<id>nextnovels:root</id>', '<title>Next Novels</title>',
            f'<updated>{datetime.now(timezone.utc).isoformat()}</updated>',
            f'<link rel="self" href={quoteattr(BASE_FEED + "/index.xml")} type="application/atom+xml;profile=opds-catalog;kind=navigation"/>']
    for title, filename in nav:
        root.append(f'<entry><title>{escape(title)}</title><id>nextnovels:{filename}</id><content type="text">Abrir {escape(title.lower())}</content><link rel="subsection" href={quoteattr(BASE_FEED + "/" + filename)} type="application/atom+xml;profile=opds-catalog;kind={"navigation" if filename != "todos.xml" and filename != "titulos.xml" and filename != "novedades.xml" else "navigation"}"/></entry>')
    root.append("</feed>")
    (OUT / "index.xml").write_text("\n".join(root), encoding="utf-8")

    (OUT / "todos.xml").write_text(feed("Todas las novelas", "nextnovels:all", books, BASE_FEED + "/todos.xml"), encoding="utf-8")
    (OUT / "titulos.xml").write_text(feed("Títulos A-Z", "nextnovels:titles", books, BASE_FEED + "/titulos.xml"), encoding="utf-8")
    novidades = sorted(books, key=lambda book: book.get("updated", ""), reverse=True)[:200]
    (OUT / "novedades.xml").write_text(feed("Novedades", "nextnovels:new", novidades, BASE_FEED + "/novedades.xml"), encoding="utf-8")

    groups = {"autores": {}, "generos": {}}
    for book in books:
        if book.get("author"):
            groups["autores"].setdefault(book["author"], []).append(book)
        for genre in book.get("genres", []):
            groups["generos"].setdefault(genre, []).append(book)
    for kind, group_map in groups.items():
        group_parts = ['<?xml version="1.0" encoding="utf-8"?>',
                       '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">',
                       f"<id>nextnovels:{kind}</id>", f"<title>{kind.title()}</title>",
                       f'<link rel="self" href={quoteattr(BASE_FEED + "/" + kind + ".xml")} type="application/atom+xml;profile=opds-catalog;kind=navigation"/>']
        for name in sorted(group_map, key=str.lower):
            slug = hashlib.md5(name.encode("utf-8")).hexdigest()[:10]
            filename = f"{kind}-{slug}.xml"
            group_parts.append(f'<entry><title>{escape(name)}</title><id>nextnovels:{filename}</id><link rel="subsection" href={quoteattr(BASE_FEED + "/" + filename)} type="application/atom+xml;profile=opds-catalog;kind=navigation"/></entry>')
            (OUT / filename).write_text(feed(name, f"nextnovels:{kind}:{slug}", group_map[name], BASE_FEED + "/" + filename), encoding="utf-8")
        group_parts.append("</feed>")
        (OUT / f"{kind}.xml").write_text("\n".join(group_parts), encoding="utf-8")

    opensearch = ('<?xml version="1.0" encoding="UTF-8"?>\n'
                  '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">\n'
                  '<ShortName>Next Novels</ShortName><Description>Buscar en Next Novels</Description>\n'
                  '<InputEncoding>UTF-8</InputEncoding>\n'
                  f'<Url type="application/atom+xml;profile=opds-catalog;kind=navigation" template="{WORKER_BASE}/search?q={{searchTerms}}"/>\n'
                  '</OpenSearchDescription>')
    (OUT / "opensearch.xml").write_text(opensearch, encoding="utf-8")
    print(f"[OK] Catálogo generado: {len(books)} novelas; archivos TeraBox bajo demanda")


def main():
    OUT.mkdir(exist_ok=True)
    books = load_books()
    if len(books) < MIN_VALID:
        print("[INFO] Primera ejecución: escaneo de novelas sin enumerar archivos de TeraBox.")
        urls = discover()
        new_books = []
        for index, url in enumerate(urls, 1):
            try:
                print(f"[{index}/{len(urls)}] {url}")
                book = parse(url)
                if book.get("title"):
                    new_books.append(book)
            except Exception as exc:
                print("[WARN]", url, exc)
            time.sleep(DELAY)
        if len(new_books) < MIN_VALID:
            raise RuntimeError(f"NextNovels devolvió muy pocos resultados: {len(new_books)}")
        books = new_books
        save_state({"last_update": ""})
    else:
        print(f"[INFO] Catálogo existente: {len(books)} novelas; no se vuelve a rastrear TeraBox.")
        # Conservar títulos antiguos; sus páginas se consultarán solo al entrar en cada ficha.
        books = incremental(books)
    generate(books)


if __name__ == "__main__":
    main()
