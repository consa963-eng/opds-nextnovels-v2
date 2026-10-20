#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generador OPDS de NextNovels. No enumera archivos de TeraBox durante el escaneo."""

import hashlib
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urljoin, urlparse
from xml.sax.saxutils import escape, quoteattr

import requests
from bs4 import BeautifulSoup

BASE = "https://nextnovels.com"
CATEGORY = BASE + "/"
UPDATES = BASE + "/actualzaciones-orientales/"
WORKER_BASE = "https://opds-nextnovels-v2.consa963.workers.dev"
BASE_FEED = WORKER_BASE + "/catalogo"
OUT = Path("catalogo")
DATA = OUT / "catalogo.json"
STATE = OUT / "estado.json"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
MAX_PAGES = 80
MIN_VALID = 10
DELAY = 0.5
TERABOX_HOSTS = (
    "terabox.com", "terabox.app", "teraboxlink.com", "freeterabox.com",
    "1024terabox.com", "1024tera.com", "4funbox.com", "mirrobox.com", "nephobox.com",
    "teraboxshare.com", "terabox.fun", "teraboxapp.com",
)
FILE_TYPES = {".epub": "application/epub+zip", ".pdf": "application/pdf"}
S = requests.Session()
S.headers.update({"User-Agent": UA, "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"})
MONTHS = {"enero": 1, "febrero": 2, "marzo": 3, "abril": 4, "mayo": 5,
          "junio": 6, "julio": 7, "agosto": 8, "septiembre": 9,
          "octubre": 10, "noviembre": 11, "diciembre": 12}


def clean(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def absu(value):
    return urljoin(BASE, value) if value else ""


def get(url):
    response = S.get(url, timeout=30)
    response.raise_for_status()
    return BeautifulSoup(response.text, "html.parser")


def article_url(url):
    parsed = urlparse(url)
    path = parsed.path.rstrip("/")
    host = (parsed.hostname or "").lower()
    if parsed.netloc and host != "nextnovels.com" and not host.endswith(".nextnovels.com"):
        return False
    segments = [segment.lower() for segment in path.split("/") if segment]
    bad = {"category", "tag", "author", "page", "genero", "wp-admin"}
    if any(segment in bad for segment in segments) or path.startswith(("/wp-", "/indice-")):
        return False
    return path not in ("", "/")


def label(soup, label_text):
    match = re.search(rf"{re.escape(label_text)}\s*:?\s*([^\n]+)", soup.get_text("\n", strip=True), re.I)
    return clean(match.group(1)) if match else ""


def is_terabox(url):
    host = (urlparse(url).hostname or "").lower()
    return any(host == domain or host.endswith("." + domain) for domain in TERABOX_HOSTS)


def today():
    return datetime.now(timezone.utc).date().isoformat()


def load_books():
    try:
        value = json.loads(DATA.read_text(encoding="utf-8"))
        return value if isinstance(value, list) else []
    except Exception:
        return []


def save_books(books):
    DATA.write_text(json.dumps(books, ensure_ascii=False, indent=2), encoding="utf-8")


def load_state():
    try:
        value = json.loads(STATE.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def save_state(state):
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def parse(url, updated=None):
    soup = get(url)
    h1 = soup.find("h1")
    title = clean(h1.get_text(" ", strip=True) if h1 else (soup.title.get_text() if soup.title else ""))
    title = re.sub(r"\s+-\s+Next Novels\s*$", "", title, flags=re.I)
    main = soup.select_one("article,.entry-content,.post-content,main") or soup

    cover = ""
    og = soup.find("meta", property="og:image")
    if og and og.get("content"):
        cover = urljoin(url, og["content"])
    if not cover:
        image = main.find("img")
        if image:
            cover = urljoin(url, image.get("src") or image.get("data-src") or "")

    author = label(main, "Autor")
    status = label(main, "Estado")
    novel_type = label(main, "Tipo")
    genres, downloads, terabox_links = [], [], []
    for anchor in main.select("a[href]"):
        genre_href = anchor.get("href", "")
        if "/genero/" in genre_href or "/tag/" in genre_href:
            genre = clean(anchor.get_text(" ", strip=True))
            if genre and genre.casefold() not in {g.casefold() for g in genres}:
                genres.append(genre)

        target = urljoin(url, anchor.get("href", ""))
        if not target:
            continue
        if is_terabox(target):
            if target not in terabox_links:
                terabox_links.append(target)
            continue
        ext = Path(urlparse(target.split("?", 1)[0]).path).suffix.lower()
        if ext in FILE_TYPES:
            text = clean(anchor.get_text(" ", strip=True))
            downloads.append({"url": target, "title": text or Path(urlparse(target).path).name,
                              "type": FILE_TYPES[ext]})

    summary = ""
    for heading in main.find_all(["h2", "h3", "h4"]):
        if "sinopsis" in clean(heading.get_text()).lower():
            paragraphs = []
            for node in heading.find_all_next():
                if node.name in ("h2", "h3", "h4"):
                    break
                if node.name == "p":
                    text = clean(node.get_text(" ", strip=True))
                    if text:
                        paragraphs.append(text)
            summary = "\n\n".join(paragraphs)
            break

    # Importante: aquí solo guardamos enlaces compartidos; no consultamos TeraBox.
    return {
        "id": url, "url": url, "title": title, "cover": cover, "author": author,
        "status": status, "type": novel_type, "genres": genres, "summary": summary,
        "downloads": downloads, "terabox_links": terabox_links, "updated": updated or today(),
    }


def discover():
    out, seen = [], set()
    for page in range(1, MAX_PAGES + 1):
        page_url = CATEGORY if page == 1 else f"{CATEGORY}page/{page}/"
        try:
            soup = get(page_url)
        except Exception as exc:
            print(f"[WARN] No se pudo leer {page_url}: {exc}")
            break
        found = []
        for anchor in soup.select("h2 a,h3 a,article a,.entry-title a"):
            url = absu(anchor.get("href"))
            if article_url(url) and url not in seen:
                found.append(url)
        new = 0
        for url in found:
            if url not in seen:
                seen.add(url)
                out.append(url)
                new += 1
        print(f"[DESCUBRIR] página {page}: +{new}")
        if not new:
            break
        time.sleep(DELAY)
    return out


def get_date(text):
    match = re.search(r"(\d{1,2})\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+(\d{4})", text, re.I)
    if not match:
        return ""
    day, month, year = int(match.group(1)), MONTHS[match.group(2).lower()], int(match.group(3))
    return f"{year:04d}-{month:02d}-{day:02d}"


def get_updates(last_date):
    changes, latest_date = [], last_date
    for page in range(1, 100):
        page_url = UPDATES if page == 1 else f"{UPDATES}page/{page}/"
        try:
            soup = get(page_url)
        except Exception as exc:
            print("[WARN] No se pudo consultar Actualizaciones:", exc)
            return None, latest_date
        articles = soup.select("article")
        if not articles:
            break
        page_old, new_on_page = False, 0
        for article in articles:
            text = clean(article.get_text(" ", strip=True))
            date = get_date(text)
            if not date:
                continue
            latest_date = max(latest_date, date)
            if last_date and date <= last_date:
                page_old = True
                continue
            low = text.lower()
            if "novela ligera" not in low or not any(x in low for x in ("[añadido]", "[añadidos]", "[nueva novela]", "[novela nueva]")):
                continue
            novel_url = next((absu(a.get("href")) for a in article.select("h2 a,h3 a,.entry-title a,a[href]")
                              if article_url(absu(a.get("href")))), None)
            if novel_url:
                changes.append({"url": novel_url, "date": date})
                new_on_page += 1
        if last_date and page_old and not new_on_page:
            break
        if not last_date:
            break
        time.sleep(DELAY)
    return list({item["url"]: item for item in changes}.values()), latest_date


def incremental(books):
    state = load_state()
    last_date = state.get("last_update", "")
    print("[INFO] Última actualización:", last_date or "ninguna")
    result = get_updates(last_date)
    if result is None:
        print("[WARN] Se conserva el catálogo actual.")
        return books
    changes, latest_date = result
    if not last_date:
        save_state({"last_update": latest_date})
        print("[INFO] Punto de partida establecido:", latest_date)
        return books
    if not changes:
        print("[INFO] No hay novedades.")
        if latest_date > last_date:
            save_state({"last_update": latest_date})
        return books
    by_url = {book["url"]: book for book in books}
    for change in sorted(changes, key=lambda item: item["date"]):
        try:
            print("[ACTUALIZAR]", change["url"])
            book = parse(change["url"], updated=change["date"])
            if not book["title"]:
                continue
            if book.get("type") and "ligera" not in book["type"].lower():
                print("[IGNORADA] No es novela ligera:", book["title"])
                continue
            by_url[book["url"]] = book
            print("[OK]", book["title"])
        except Exception as exc:
            print("[WARN]", change["url"], exc)
        time.sleep(DELAY)
    save_state({"last_update": latest_date})
    return list(by_url.values())


def detail_url(book):
    return WORKER_BASE + "/novela?url=" + quote(book.get("url", ""), safe="")


def image_type(url):
    ext = Path(urlparse(url).path).suffix.lower()
    return {".png": "image/png", ".webp": "image/webp", ".gif": "image/gif"}.get(ext, "image/jpeg")


def ent(book):
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
