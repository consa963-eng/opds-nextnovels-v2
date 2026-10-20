#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generador OPDS para NextNovels con enumeración de archivos públicos de TeraBox."""

import hashlib
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, quote, urlencode, urljoin, urlparse
from xml.sax.saxutils import escape, quoteattr

import requests
from bs4 import BeautifulSoup

BASE = "https://nextnovels.com"
CATEGORY = BASE + "/"
UPDATES = BASE + "/actualzaciones-orientales/"
WORKER_BASE = "https://opds-nextnovels-v2.consa963.workers.dev"

TERABOX_HOSTS = (
    "terabox.com", "terabox.app", "teraboxlink.com", "freeterabox.com",
    "1024tera.com", "4funbox.com", "mirrobox.com", "nephobox.com",
    "teraboxshare.com", "terabox.fun", "teraboxapp.com",
)

OUT = Path("catalogo")
DATA = OUT / "catalogo.json"
STATE = OUT / "estado.json"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
MAX_PAGES = 80
MIN_VALID = 10
DELAY = 1.0
BASE_RAW = "https://raw.githubusercontent.com/consa963-eng/opds-nextnovels-v2/main/catalogo"
TB_LIST_ENDPOINT = "https://www.terabox.com/share/list"

S = requests.Session()
S.headers.update({"User-Agent": UA, "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"})

FILE_TYPES = {
    ".epub": "application/epub+zip",
    ".pdf": "application/pdf",
}


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
    if parsed.netloc and not (parsed.hostname or "").lower().endswith("nextnovels.com"):
        return False
    segments = [segment.lower() for segment in path.split("/") if segment]
    bad_segments = {"category", "tag", "author", "page", "genero", "wp-admin"}
    if any(segment in bad_segments for segment in segments):
        return False
    if path.startswith(("/wp-", "/indice-")):
        return False
    return path not in ("", "/")


def label(soup, label_text):
    match = re.search(
        rf"{re.escape(label_text)}\s*:?\s*([^\n]+)",
        soup.get_text("\n", strip=True), re.I
    )
    return clean(match.group(1)) if match else ""


def is_terabox(url):
    host = (urlparse(url).hostname or "").lower()
    return any(host == domain or host.endswith("." + domain) for domain in TERABOX_HOSTS)


def shorturl_from_share(url):
    """Obtiene el identificador de enlaces públicos del tipo /s/1AbCd..."""
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    for key in ("surl", "shorturl"):
        if query.get(key):
            return query[key][0]
    segments = [part for part in parsed.path.split("/") if part]
    for index, part in enumerate(segments[:-1]):
        if part.lower() in {"s", "share", "sharing"}:
            value = segments[index + 1]
            # TeraBox suele mostrar /s/1XXXXX, mientras que la API recibe XXXXX.
            return value[1:] if value.startswith("1") and len(value) > 1 else value
    if segments and segments[-1].startswith("1") and len(segments[-1]) > 1:
        return segments[-1][1:]
    return ""


def extract_js_token(html):
    patterns = (
        r'''(?:window\.)?jsToken\s*[:=]\s*["']([^"']+)["']''',
        r'''["']jsToken["']\s*:\s*["']([^"']+)["']''',
        r'''jsToken%22%3A%22([^%"']+)''',
    )
    for pattern in patterns:
        match = re.search(pattern, html, re.I)
        if match:
            return match.group(1)
    return ""


def terabox_public_context(share_url):
    """Obtiene jsToken y shorturl de la página compartida, sin cookie de sesión."""
    response = S.get(share_url, timeout=30, allow_redirects=True)
    response.raise_for_status()
    js_token = extract_js_token(response.text)
    shorturl = shorturl_from_share(response.url) or shorturl_from_share(share_url)
    if not shorturl:
        raise ValueError("No se pudo extraer el identificador de la carpeta compartida")
    return js_token, shorturl


def tb_json_list(js_token, shorturl, folder_path=None, page=1):
    params = {
        "app_id": "250528",
        "shorturl": shorturl,
        "page": str(page),
        "num": "100",
    }
    if js_token:
        params["jsToken"] = js_token
    if folder_path:
        params["dir"] = folder_path
    else:
        params["root"] = "1"

    # Las redirecciones entre dominios de TeraBox son habituales.
    response = S.get(
        TB_LIST_ENDPOINT,
        params=params,
        headers={"Referer": f"https://www.terabox.com/s/1{shorturl}", "Accept": "application/json, text/plain, */*"},
        timeout=30,
    )
    response.raise_for_status()
    content_type = (response.headers.get("Content-Type") or "").lower()
    if "html" in content_type:
        raise ValueError("TeraBox devolvió HTML en lugar de JSON; el listado público no está disponible")
    try:
        data = response.json()
    except ValueError as exc:
        raise ValueError("La respuesta del listado de TeraBox no es JSON válido") from exc
    if str(data.get("errno", "0")) not in ("0", "None"):
        message = clean(data.get("errmsg") or data.get("show_msg") or "error desconocido")
        raise ValueError(f"La API de TeraBox rechazó el listado: {message}")
    return data


def list_tb_folder(js_token, shorturl, folder_path=None):
    """Obtiene todos los elementos de una carpeta, incluyendo paginación."""
    entries = []
    for page in range(1, 101):
        data = tb_json_list(js_token, shorturl, folder_path, page)
        batch = data.get("list") or []
        entries.extend(batch)
        if len(batch) < 100:
            break
    return entries


def list_terabox_files(share_url, max_depth=20):
    """Recorre la carpeta compartida y devuelve cada EPUB/PDF con su fs_id."""
    js_token, shorturl = terabox_public_context(share_url)
    files = []
    visited = set()

    def walk(folder_path=None, depth=0):
        if depth > max_depth:
            print(f"[TB][WARN] Límite de profundidad alcanzado en {folder_path or '/'}")
            return
        path_key = folder_path or "/"
        if path_key in visited:
            return
        visited.add(path_key)
        try:
            items = list_tb_folder(js_token, shorturl, folder_path)
        except Exception as exc:
            print(f"[TB][WARN] No se pudo listar {path_key}: {exc}")
            return

        for item in items:
            name = clean(item.get("server_filename") or item.get("filename"))
            if not name:
                continue
            is_dir = str(item.get("isdir", item.get("is_dir", 0))) in ("1", "True", "true")
            path = item.get("path")
            if not path:
                path = (folder_path.rstrip("/") + "/" + name) if folder_path else "/" + name

            if is_dir:
                walk(path, depth + 1)
                continue

            extension = Path(name).suffix.lower()
            fs_id = item.get("fs_id") or item.get("fid")
            if extension not in FILE_TYPES or fs_id is None:
                continue
            files.append({
                "fs_id": str(fs_id),
                "name": name,
                "path": path,
                "type": FILE_TYPES[extension],
                "size": item.get("size"),
            })
        time.sleep(0.15)

    walk()
    # Deduplicar por identificador, manteniendo el orden de la API.
    unique = {}
    for item in files:
        unique[item["fs_id"]] = item
    return list(unique.values())


def worker_url(share_url, fs_id, filename):
    params = urlencode({"url": share_url, "fs_id": str(fs_id), "name": filename})
    return f"{WORKER_BASE}/descargar?{params}"


def today():
    return datetime.now(timezone.utc).date().isoformat()

# ----------------------------------------------------------------------
# Estado local
# ----------------------------------------------------------------------

def load_books():
    if not DATA.exists():
        return []
    try:
        value = json.loads(DATA.read_text(encoding="utf-8"))
        return value if isinstance(value, list) else []
    except Exception:
        return []


def save_books(books):
    DATA.write_text(json.dumps(books, ensure_ascii=False, indent=2), encoding="utf-8")


def load_state():
    if not STATE.exists():
        return {}
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(state):
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def limpiar_feeds_viejos():
    for pattern, regex in (("autores-*.xml", r"autores-[0-9a-f]{10}\.xml"),
                           ("generos-*.xml", r"generos-[0-9a-f]{10}\.xml")):
        for file in OUT.glob(pattern):
            if not re.fullmatch(regex, file.name):
                file.unlink()

# ----------------------------------------------------------------------
# Descubrimiento y ficha de NextNovels
# ----------------------------------------------------------------------

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

    genres = []
    for anchor in main.select("a[href*='/genero/'],a[href*='/tag/']"):
        genre = clean(anchor.get_text(" ", strip=True))
        if genre and genre.casefold() not in {g.casefold() for g in genres}:
            genres.append(genre)

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

    downloads, handled_tb = [], set()
    for anchor in main.select("a[href]"):
        target = urljoin(url, anchor.get("href", ""))
        if not target:
            continue
        text = clean(anchor.get_text(" ", strip=True))
        lowered = target.lower().split("?", 1)[0]
        extension = Path(urlparse(lowered).path).suffix.lower()

        if extension in FILE_TYPES:
            downloads.append({"url": target, "title": text or Path(urlparse(target).path).name,
                              "type": FILE_TYPES[extension]})
            continue

        if is_terabox(target):
            # Solo enumeramos el enlace de almacenamiento una vez por ficha.
            if target in handled_tb:
                continue
            handled_tb.add(target)
            try:
                files = list_terabox_files(target)
                for file_info in files:
                    downloads.append({
                        "url": worker_url(target, file_info["fs_id"], file_info["name"]),
                        "title": file_info["name"],
                        "type": file_info["type"],
                        "fs_id": file_info["fs_id"],
                        "storage_url": target,
                        "path": file_info.get("path", ""),
                    })
                print(f"[TB] {title}: {len(files)} EPUB/PDF encontrados")
            except Exception as exc:
                print(f"[TB][WARN] {title}: no se pudo enumerar {target}: {exc}")
            continue

        if "descargar" in text.casefold():
            # Los botones no compatibles no se presentan falsamente como EPUB.
            downloads.append({"url": target, "title": text or "Abrir descarga", "type": "text/html"})

    unique_downloads = {}
    for item in downloads:
        unique_downloads[item["url"]] = item

    return {
        "id": url,
        "url": url,
        "title": title,
        "cover": cover,
        "author": author,
        "status": status,
        "type": novel_type,
        "genres": genres,
        "summary": summary,
        "downloads": list(unique_downloads.values()),
        "updated": updated or today(),
    }

# ----------------------------------------------------------------------
# Actualizaciones incrementales
# ----------------------------------------------------------------------

MONTHS = {"enero": 1, "febrero": 2, "marzo": 3, "abril": 4, "mayo": 5,
          "junio": 6, "julio": 7, "agosto": 8, "septiembre": 9,
          "octubre": 10, "noviembre": 11, "diciembre": 12}


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
            novel_url = next((absu(a.get("href")) for a in article.select("h2 a,h3 a,.entry-title a,a[href]") if article_url(absu(a.get("href")))), None)
            if novel_url:
                changes.append({"url": novel_url, "date": date})
                new_on_page += 1
        if last_date and page_old and not new_on_page:
            break
        if not last_date:
            break
        time.sleep(DELAY)
    unique = {item["url"]: item for item in changes}
    return list(unique.values()), latest_date


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
            if book["type"] and "ligera" not in book["type"].lower():
                print("[IGNORADA] No es novela ligera:", book["title"])
                continue
            by_url[book["url"]] = book
            print("[OK]", book["title"])
        except Exception as exc:
            print("[WARN]", change["url"], exc)
        time.sleep(DELAY)
    save_state({"last_update": latest_date})
    return list(by_url.values())

# ----------------------------------------------------------------------
# Generación OPDS estática
# ----------------------------------------------------------------------

def ent(book):
    parts = ["<entry>", "<title>" + escape(book.get("title") or "Sin título") + "</title>",
             "<id>" + escape(book.get("id") or book.get("url") or "") + "</id>",
             f'<link rel="alternate" href={quoteattr(book.get("url", ""))} type="text/html"/>']
    if book.get("cover"):
        parts.append(f'<link rel="http://opds-spec.org/image" href={quoteattr(book["cover"])} />')
    if book.get("author"):
        parts.append("<author><name>" + escape(book["author"]) + "</name></author>")
    for genre in book.get("genres", []):
        parts.append(f'<category term={quoteattr(genre)} label={quoteattr(genre)}/>')
    if book.get("summary"):
        parts.append('<content type="text">' + escape(book["summary"][:5000]) + "</content>")
    for download in book.get("downloads", []):
        parts.append(f'<link rel="http://opds-spec.org/acquisition" href={quoteattr(download["url"])} type={quoteattr(download.get("type", "application/epub+zip"))} title={quoteattr(download.get("title", "Descargar"))} />')
    if not book.get("downloads"):
        parts.append(f'<link rel="http://opds-spec.org/acquisition" href={quoteattr(book.get("url", ""))} type="text/html" title="Abrir en Next Novels" />')
    parts.append("</entry>")
    return "\n".join(parts)


def feed(title, feed_id, items, self_url, kind="acquisition"):
    parts = ['<?xml version="1.0" encoding="utf-8"?>',
             '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">',
             f"<id>{escape(feed_id)}</id>", f"<title>{escape(title)}</title>",
             f"<updated>{datetime.now(timezone.utc).isoformat()}</updated>",
             f'<link rel="self" href={quoteattr(self_url)} type="application/atom+xml;profile=opds-catalog;kind={kind}"/>']
    parts.extend(ent(book) for book in items)
    parts.append("</feed>")
    return "\n".join(parts)


def generate(books):
    books = list({book["url"]: book for book in books}.values())
    books.sort(key=lambda book: book.get("title", "").lower())
    save_books(books)
    limpiar_feeds_viejos()
    base = BASE_RAW
    nav = [("Novedades", "novedades.xml", "acquisition"), ("Todas las novelas", "todos.xml", "acquisition"),
           ("Autores", "autores.xml", "navigation"), ("Géneros", "generos.xml", "navigation"),
           ("Títulos A-Z", "titulos.xml", "acquisition")]
    parts = ['<?xml version="1.0" encoding="utf-8"?>',
             '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">',
             "<id>nextnovels:root</id>", "<title>Next Novels</title>",
             f"<updated>{datetime.now(timezone.utc).isoformat()}</updated>",
             f'<link rel="self" href={quoteattr(base + "/index.xml")} type="application/atom+xml;profile=opds-catalog;kind=navigation"/>']
    for title, filename, kind in nav:
        parts.append(f'<entry><title>{escape(title)}</title><id>nextnovels:{filename}</id><link rel="subsection" href={quoteattr(base + "/" + filename)} type="application/atom+xml;profile=opds-catalog;kind={kind}"/></entry>')
    parts.append("</feed>")
    (OUT / "index.xml").write_text("\n".join(parts), encoding="utf-8")
    (OUT / "todos.xml").write_text(feed("Todas las novelas", "nextnovels:all", books, base + "/todos.xml"), encoding="utf-8")
    (OUT / "titulos.xml").write_text(feed("Títulos A-Z", "nextnovels:titles", books, base + "/titulos.xml"), encoding="utf-8")
    novidades = sorted(books, key=lambda book: book.get("updated", ""), reverse=True)[:200]
    (OUT / "novedades.xml").write_text(feed("Novedades", "nextnovels:new", novidades, base + "/novedades.xml"), encoding="utf-8")

    groups = {"autores": {}, "generos": {}}
    for book in books:
        if book.get("author"):
            groups["autores"].setdefault(book["author"], []).append(book)
        for genre in book.get("genres", []):
            groups["generos"].setdefault(genre, []).append(book)
    for kind, group_map in groups.items():
        group_parts = ['<?xml version="1.0" encoding="utf-8"?>',
                       '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">',
                       f"<id>nextnovels:{kind}</id>", f"<title>{kind.title()}</title>"]
        for name in sorted(group_map, key=str.lower):
            slug = hashlib.md5(name.encode("utf-8")).hexdigest()[:10]
            filename = f"{kind}-{slug}.xml"
            group_parts.append(f'<entry><title>{escape(name)}</title><id>nextnovels:{filename}</id><link rel="subsection" href={quoteattr(base + "/" + filename)} type="application/atom+xml;profile=opds-catalog;kind=acquisition"/></entry>')
            (OUT / filename).write_text(feed(name, f"nextnovels:{kind}:{slug}", group_map[name], base + "/" + filename), encoding="utf-8")
        group_parts.append("</feed>")
        (OUT / f"{kind}.xml").write_text("\n".join(group_parts), encoding="utf-8")

    (OUT / "opensearch.xml").write_text(
        f'<?xml version="1.0" encoding="UTF-8"?>\n<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">\n'
        f'<ShortName>Next Novels</ShortName>\n<Description>Buscar en Next Novels</Description>\n'
        f'<InputEncoding>UTF-8</InputEncoding>\n<Url type="application/atom+xml" template="{base}/search.xml?q={{searchTerms}}"/>\n</OpenSearchDescription>\n',
        encoding="utf-8")
    print(f"[OK] Catálogo generado: {len(books)} novelas")


def main():
    OUT.mkdir(exist_ok=True)
    books = load_books()
    if len(books) < MIN_VALID:
        print("[INFO] Primera ejecución: escaneo completo.")
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
            if len(books) >= MIN_VALID:
                print("[WARN] Se conserva el catálogo anterior.")
            else:
                raise RuntimeError(f"NextNovels devolvió muy pocos resultados: {len(new_books)}")
        else:
            books = new_books
        save_state({"last_update": ""})
    else:
        print(f"[INFO] Catálogo existente: {len(books)} novelas")
        books = incremental(books)
    generate(books)


if __name__ == "__main__":
    main()
