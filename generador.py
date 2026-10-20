#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse, quote
from xml.sax.saxutils import escape, quoteattr

import requests
from bs4 import BeautifulSoup


BASE = "https://nextnovels.com"
CATEGORY = BASE + "/category/novela-ligera/"
UPDATES = BASE + "/actualzaciones-orientales/"

# ⚠️ CAMBIA ESTO por la URL real de tu Worker de Cloudflare.
WORKER_BASE = "https://opds-nextnovels.tu-subdominio.workers.dev"

# Dominios de Terabox que hay que proxificar para que la app
# descargue directamente sin abrir la web.
TERABOX_HOSTS = (
    "terabox.com",
    "terabox.app",
    "teraboxlink.com",
    "freeterabox.com",
    "1024tera.com",
    "4funbox.com",
    "mirrobox.com",
    "nephobox.com",
)

OUT = Path("catalogo")
DATA = OUT / "catalogo.json"
STATE = OUT / "estado.json"

UA = "Mozilla/5.0 (compatible; NextNovels-OPDS/1.0)"

MAX_PAGES = 80
MIN_VALID = 10
DELAY = 1.0

S = requests.Session()
S.headers.update({"User-Agent": UA})


def clean(x):
    return re.sub(r"\s+", " ", str(x or "")).strip()


def absu(x):
    return urljoin(BASE, x) if x else ""


def get(url):
    r = S.get(url, timeout=25)
    r.raise_for_status()
    return BeautifulSoup(r.text, "html.parser")


def article_url(u):
    p = urlparse(u)
    path = p.path.rstrip("/")

    if p.netloc and "nextnovels.com" not in p.netloc:
        return False

    segments = [seg for seg in path.split("/") if seg]
    bad_segments = {"category", "tag", "author", "page", "genero"}

    if any(seg in bad_segments for seg in segments):
        return False

    if path.startswith(("/wp-", "/indice-")):
        return False

    return path not in ("", "/")


def label(s, label):
    m = re.search(
        rf"{re.escape(label)}\s*:?\s*([^\n]+)",
        s.get_text("\n", strip=True),
        re.I
    )
    return clean(m.group(1)) if m else ""


def proxify(url):
    """Devuelve la URL proxificada por el Worker si es de Terabox."""
    if any(h in url.lower() for h in TERABOX_HOSTS):
        return f"{WORKER_BASE}/descargar?url={quote(url, safe='')}"
    return url


# ============================================================
# DATOS
# ============================================================

def load_books():
    if not DATA.exists():
        return []

    try:
        return json.loads(
            DATA.read_text(encoding="utf-8")
        )
    except Exception:
        return []


def save_books(books):
    DATA.write_text(
        json.dumps(
            books,
            ensure_ascii=False,
            indent=2
        ),
        encoding="utf-8"
    )


def load_state():
    if not STATE.exists():
        return {}

    try:
        return json.loads(
            STATE.read_text(encoding="utf-8")
        )
    except Exception:
        return {}


def save_state(state):
    STATE.write_text(
        json.dumps(
            state,
            ensure_ascii=False,
            indent=2
        ),
        encoding="utf-8"
    )


# ============================================================
# PRIMERA EJECUCIÓN
# ============================================================

def discover():
    out = []
    seen = set()

    for n in range(1, MAX_PAGES + 1):

        url = (
            CATEGORY
            if n == 1
            else f"{CATEGORY}page/{n}/"
        )

        try:
            s = get(url)
        except Exception:
            break

        found = []

        for a in s.select(
            "h2 a,h3 a,article a,.entry-title a"
        ):
            u = absu(a.get("href"))

            if article_url(u) and u not in seen:
                found.append(u)

        new = 0

        for u in found:
            if u not in seen:
                seen.add(u)
                out.append(u)
                new += 1

        print(
            f"[DESCUBRIR] página {n}: +{new}"
        )

        if not new:
            break

        time.sleep(DELAY)

    return out


# ============================================================
# FICHA
# ============================================================

def parse(url, updated=None):

    s = get(url)

    h = s.find("h1")

    title = (
        clean(h.get_text(" ", strip=True))
        if h
        else clean(
            s.title.get_text()
            if s.title
            else ""
        )
    )

    title = re.sub(
        r"\s+-\s+Next Novels\s*$",
        "",
        title,
        flags=re.I
    )

    main = (
        s.select_one(
            "article,.entry-content,.post-content,main"
        )
        or s
    )

    # Portada
    cover = ""

    og = s.find(
        "meta",
        property="og:image"
    )

    if og and og.get("content"):
        cover = absu(og["content"])

    if not cover:
        img = main.find("img")

        if img:
            cover = absu(
                img.get("src")
                or img.get("data-src")
            )

    author = label(main, "Autor")
    status = label(main, "Estado")
    typ = label(main, "Tipo")

    # Géneros
    genres = []

    for a in main.select(
        "a[href*='/genero/'],"
        "a[href*='/tag/']"
    ):
        t = clean(a.get_text(" ", strip=True))

        if t and t.lower() not in [
            x.lower() for x in genres
        ]:
            genres.append(t)

    # Sinopsis
    summary = ""

    for h in main.find_all(
        ["h2", "h3", "h4"]
    ):

        if "sinopsis" in clean(
            h.get_text()
        ).lower():

            paragraphs = []

            for x in h.find_all_next():

                if x.name in [
                    "h2",
                    "h3",
                    "h4"
                ]:
                    break

                if x.name == "p":
                    t = clean(
                        x.get_text(
                            " ",
                            strip=True
                        )
                    )

                    if t:
                        paragraphs.append(t)

            summary = "\n\n".join(
                paragraphs
            )

            break

    # Descargas
    downloads = []

    for a in main.select("a[href]"):

        u = absu(a.get("href"))
        low = u.lower()

        for ext, mime in [
            (".epub", "application/epub+zip"),
            (".pdf", "application/pdf"),
            (".mobi", "application/x-mobipocket-ebook"),
            (".azw3", "application/vnd.amazon.ebook"),
            (".cbz", "application/vnd.comicbook+zip"),
            (".cbr", "application/vnd.comicbook-rar"),
        ]:

            if ext in low:

                downloads.append({
                    "url": u,
                    "title": (
                        clean(
                            a.get_text(
                                " ",
                                strip=True
                            )
                        )
                        or "Descarga"
                    ),
                    "type": mime
                })

                break

    # Deduplicar por URL.
    downloads = list({d["url"]: d for d in downloads}.values())

    # Reescribir enlaces de Terabox para que apunten al Worker.
    for d in downloads:
        d["url"] = proxify(d["url"])
        if any(h in proxify(d["url"]).lower() for h in TERABOX_HOSTS):
            # (no ocurrirá tras proxificar, pero por seguridad)
            pass
        if "/descargar?url=" in d["url"]:
            d["title"] = d["title"] + " (directo)"

    return {
        "id": url,
        "url": url,
        "title": title,
        "cover": cover,
        "author": author,
        "status": status,
        "type": typ,
        "genres": genres,
        "summary": summary,
        "downloads": downloads,
        "updated": (
            updated
            or datetime.now(
                timezone.utc
            ).isoformat()
        )
    }


# ============================================================
# FECHA DE ACTUALIZACIÓN
# ============================================================

MONTHS = {
    "enero": 1,
    "febrero": 2,
    "marzo": 3,
    "abril": 4,
    "mayo": 5,
    "junio": 6,
    "julio": 7,
    "agosto": 8,
    "septiembre": 9,
    "octubre": 10,
    "noviembre": 11,
    "diciembre": 12,
}


def get_date(text):

    m = re.search(
        r"(\d{1,2})\s+"
        r"(enero|febrero|marzo|abril|mayo|junio|"
        r"julio|agosto|septiembre|octubre|noviembre|diciembre)"
        r"\s+(\d{4})",
        text,
        re.I
    )

    if not m:
        return ""

    day = int(m.group(1))
    month = MONTHS[m.group(2).lower()]
    year = int(m.group(3))

    return f"{year:04d}-{month:02d}-{day:02d}"


# ============================================================
# ACTUALIZACIONES
# ============================================================

def get_updates(last_date):

    changes = []
    latest_date = last_date

    for page in range(1, 100):

        url = (
            UPDATES
            if page == 1
            else f"{UPDATES}page/{page}/"
        )

        try:
            s = get(url)
        except Exception as e:
            print(
                "[WARN] No se pudo consultar "
                "Actualizaciones:",
                e
            )
            return None, latest_date

        articles = s.select("article")

        if not articles:
            break

        page_old = False
        new_on_page = 0

        for article in articles:

            text = clean(
                article.get_text(
                    " ",
                    strip=True
                )
            )

            date = get_date(text)

            if not date:
                continue

            if date > latest_date:
                latest_date = date

            if last_date and date <= last_date:
                page_old = True
                continue

            if "novela ligera" not in text.lower():
                continue

            lower = text.lower()

            if not any(
                x in lower
                for x in (
                    "[añadido]",
                    "[añadidos]",
                    "[nueva novela]",
                    "[novela nueva]"
                )
            ):
                continue

            link = None

            for a in article.select(
                "h2 a,h3 a,.entry-title a,a[href]"
            ):
                u = absu(a.get("href"))

                if article_url(u):
                    link = u
                    break

            if not link:
                continue

            changes.append({
                "url": link,
                "date": date
            })
            new_on_page += 1

        if last_date and page_old and new_on_page == 0:
            break

        if not last_date:
            break

        time.sleep(DELAY)

    unique = {}

    for item in changes:
        unique[item["url"]] = item

    return list(unique.values()), latest_date


# ============================================================
# ACTUALIZACIÓN INCREMENTAL
# ============================================================

def incremental(books):

    state = load_state()
    last_date = state.get("last_update", "")

    print(
        "[INFO] Última actualización:",
        last_date or "ninguna"
    )

    result = get_updates(last_date)

    if result is None:
        print(
            "[WARN] Se conserva el catálogo actual."
        )
        return books

    changes, latest_date = result

    if not last_date:

        save_state({
            "last_update": latest_date
        })

        print(
            "[INFO] Punto de partida establecido:",
            latest_date
        )

        return books

    if not changes:

        print(
            "[INFO] No hay novedades."
        )

        if latest_date > last_date:
            save_state({
                "last_update": latest_date
            })

        return books

    print(
        f"[INFO] {len(changes)} actualización(es) encontrada(s)."
    )

    by_url = {
        b["url"]: b
        for b in books
    }

    for change in sorted(
        changes,
        key=lambda x: x["date"]
    ):

        url = change["url"]

        try:

            print(
                "[ACTUALIZAR]",
                url
            )

            book = parse(
                url,
                updated=change["date"]
            )

            if not book["title"]:
                continue

            if (
                book["type"]
                and "ligera"
                not in book["type"].lower()
            ):
                print(
                    "[IGNORADA] No es novela ligera:",
                    book["title"]
                )
                continue

            by_url[url] = book

            print(
                "[OK]",
                book["title"]
            )

        except Exception as e:

            print(
                "[WARN]",
                url,
                e
            )

        time.sleep(DELAY)

    save_state({
        "last_update": latest_date
    })

    return list(by_url.values())


# ============================================================
# OPDS
# ============================================================

def ent(b):

    x = [
        "<entry>",
        "<title>"
        + escape(
            b["title"] or "Sin título"
        )
        + "</title>",
        "<id>"
        + escape(b["id"])
        + "</id>",
        f'<link rel="alternate" '
        f'href={quoteattr(b["url"])} '
        f'type="text/html"/>'
    ]

    if b.get("cover"):
        x.append(
            f'<link rel="http://opds-spec.org/image" '
            f'href={quoteattr(b["cover"])} />'
        )

    if b.get("author"):
        x.append(
            "<author><name>"
            + escape(b["author"])
            + "</name></author>"
        )

    for g in b.get("genres", []):
        x.append(
            f'<category term={quoteattr(g)} '
            f'label={quoteattr(g)}/>'
        )

    if b.get("summary"):
        x.append(
            '<content type="text">'
            + escape(
                b["summary"][:5000]
            )
            + "</content>"
        )

    for d in b.get("downloads", []):

        x.append(
            f'<link rel="http://opds-spec.org/acquisition" '
            f'href={quoteattr(d["url"])} '
            f'type={quoteattr(d["type"])} '
            f'title={quoteattr(d["title"])} />'
        )

    if not b.get("downloads"):

        x.append(
            f'<link rel="http://opds-spec.org/acquisition" '
            f'href={quoteattr(b["url"])} '
            f'type="text/html" '
            f'title="Abrir en Next Novels" />'
        )

    x.append("</entry>")

    return "\n".join(x)


def feed(title, fid, items, selfurl, kind="acquisition"):

    x = [
        '<?xml version="1.0" encoding="utf-8"?>',

        '<feed xmlns="http://www.w3.org/2005/Atom" '
        'xmlns:opds="http://opds-spec.org/2010/catalog" '
        'xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">',

        f"<id>{escape(fid)}</id>",
        f"<title>{escape(title)}</title>",

        f"<updated>"
        f"{datetime.now(timezone.utc).isoformat()}"
        f"</updated>",

        f'<link rel="self" '
        f'href={quoteattr(selfurl)} '
        f'type="application/atom+xml;profile=opds-catalog;'
        f'kind={kind}"/>'
    ]

    x += [ent(b) for b in items]

    x.append("</feed>")

    return "\n".join(x)


# ============================================================
# GENERAR XML
# ============================================================

def generate(books):

    books = list({
        b["url"]: b
        for b in books
    }.values())

    books.sort(
        key=lambda b:
        b["title"].lower()
    )

    save_books(books)

    base = (
    "https://raw.githubusercontent.com/"
    "consa963-eng/opds-nextnovels-v2/main/catalogo"
)

    # [título, fichero, kind]
    nav = [
        ("Novedades", "novedades.xml", "acquisition"),
        ("Todas las novelas", "todos.xml", "acquisition"),
        ("Autores", "autores.xml", "navigation"),
        ("Géneros", "generos.xml", "navigation"),
        ("Títulos A-Z", "titulos.xml", "acquisition"),
    ]

    x = [
        '<?xml version="1.0" encoding="utf-8"?>',

        '<feed xmlns="http://www.w3.org/2005/Atom" '
        'xmlns:opds="http://opds-spec.org/2010/catalog">',

        "<id>nextnovels:root</id>",
        "<title>Next Novels</title>",

        f"<updated>"
        f"{datetime.now(timezone.utc).isoformat()}"
        f"</updated>",

        f'<link rel="self" '
        f'href={quoteattr(base + "/index.xml")} '
        f'type="application/atom+xml;profile=opds-catalog;'
        f'kind=navigation"/>'
    ]

    for title, filename, kind in nav:

        x.append(
            f'<entry>'
            f'<title>{escape(title)}</title>'
            f'<id>nextnovels:{filename}</id>'
            f'<link rel="subsection" '
            f'href={quoteattr(base + "/" + filename)} '
            f'type="application/atom+xml;profile=opds-catalog;'
            f'kind={kind}"/>'
            f'</entry>'
        )

    x.append("</feed>")

    (
        OUT / "index.xml"
    ).write_text(
        "\n".join(x),
        encoding="utf-8"
    )

    (
        OUT / "todos.xml"
    ).write_text(
        feed(
            "Todas las novelas",
            "nextnovels:all",
            books,
            base + "/todos.xml"
        ),
        encoding="utf-8"
    )

    (
        OUT / "titulos.xml"
    ).write_text(
        feed(
            "Títulos A-Z",
            "nextnovels:titles",
            books,
            base + "/titulos.xml"
        ),
        encoding="utf-8"
    )

    novedades = sorted(
        books,
        key=lambda b:
        b.get("updated", ""),
        reverse=True
    )[:200]

    (
        OUT / "novedades.xml"
    ).write_text(
        feed(
            "Novedades",
            "nextnovels:new",
            novedades,
            base + "/novedades.xml"
        ),
        encoding="utf-8"
    )

    groups = {
        "autores": {},
        "generos": {}
    }

    for b in books:

        if b.get("author"):
            groups["autores"].setdefault(
                b["author"],
                []
            ).append(b)

        for g in b.get("genres", []):

            groups["generos"].setdefault(
                g,
                []
            ).append(b)

    for kind, gs in groups.items():

        x = [
            '<?xml version="1.0" encoding="utf-8"?>',

            '<feed xmlns="http://www.w3.org/2005/Atom" '
            'xmlns:opds="http://opds-spec.org/2010/catalog">',

            f"<id>nextnovels:{kind}</id>",
            f"<title>{kind.title()}</title>"
        ]

        for i, name in enumerate(
            sorted(gs, key=str.lower)
        ):

            fn = f"{kind}-{i}.xml"

            x.append(
                f'<entry>'
                f'<title>{escape(name)}</title>'
                f'<id>nextnovels:{fn}</id>'
                f'<link rel="subsection" '
                f'href={quoteattr(base + "/" + fn)} '
                f'type="application/atom+xml;profile=opds-catalog;'
                f'kind=acquisition"/>'
                f'</entry>'
            )

            (
                OUT / fn
            ).write_text(
                feed(
                    name,
                    f"nextnovels:{kind}:{name}",
                    gs[name],
                    base + "/" + fn,
                    kind="acquisition"
                ),
                encoding="utf-8"
            )

        x.append("</feed>")

        (
            OUT / f"{kind}.xml"
        ).write_text(
            "\n".join(x),
            encoding="utf-8"
        )

    (
        OUT / "opensearch.xml"
    ).write_text(
        f'''<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
<ShortName>Next Novels</ShortName>
<Description>Buscar en Next Novels</Description>
<InputEncoding>UTF-8</InputEncoding>
<Url type="application/atom+xml" template="{base}/search.xml?q={{searchTerms}}"/>
</OpenSearchDescription>
''',
        encoding="utf-8"
    )

    print(
        f"[OK] Catálogo generado: "
        f"{len(books)} novelas"
    )


# ============================================================
# MAIN
# ============================================================

def main():

    OUT.mkdir(
        exist_ok=True
    )

    books = load_books()

    if len(books) < MIN_VALID:

        print(
            "[INFO] Primera ejecución: "
            "escaneo completo."
        )

        urls = discover()
        new_books = []

        for i, url in enumerate(
            urls,
            1
        ):

            try:

                print(
                    f"[{i}/{len(urls)}] {url}"
                )

                b = parse(url)

                if (
                    b["title"]
                    and (
                        not b["type"]
                        or "ligera"
                        in b["type"].lower()
                    )
                ):
                    new_books.append(b)

            except Exception as e:

                print(
                    "[WARN]",
                    url,
                    e
                )

            time.sleep(DELAY)

        if len(new_books) < MIN_VALID:

            if len(books) >= MIN_VALID:
                print(
                    "[WARN] Se conserva "
                    "el catálogo anterior."
                )
            else:
                raise RuntimeError(
                    f"NextNovels devolvió "
                    f"muy pocos resultados: "
                    f"{len(new_books)}"
                )

        else:
            books = new_books

        save_state({
            "last_update": ""
        })

    else:

        print(
            f"[INFO] Catálogo existente: "
            f"{len(books)} novelas"
        )

        books = incremental(
            books
        )

    generate(books)


if __name__ == "__main__":
    main()
