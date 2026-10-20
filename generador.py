#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse
from xml.sax.saxutils import escape, quoteattr

import requests
from bs4 import BeautifulSoup


BASE = "https://nextnovels.com"
CATEGORY = BASE + "/category/novela-ligera/"
UPDATES = BASE + "/actualzaciones-orientales/"

OUT = Path("catalogo")
DATA = OUT / "catalogo.json"
STATE = OUT / "estado.json"

RAW_BASE = (
    "https://raw.githubusercontent.com/"
    "consa963-eng/opds-nextnovels-v2/main/catalogo"
)

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

    bad = (
        "/category/",
        "/tag/",
        "/author/",
        "/page/",
        "/genero/",
        "/indice-",
        "/wp-",
    )

    return path not in ("", "/") and not any(x in path + "/" for x in bad)


def label(s, text):
    m = re.search(
        rf"{re.escape(text)}\s*:?\s*([^\n]+)",
        s.get_text("\n", strip=True),
        re.I
    )
    return clean(m.group(1)) if m else ""


# ============================================================
# DATOS
# ============================================================

def load_books():
    if not DATA.exists():
        return []
    try:
        return json.loads(DATA.read_text(encoding="utf-8"))
    except Exception:
        return []


def save_books(books):
    DATA.write_text(
        json.dumps(books, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )


def load_state():
    if not STATE.exists():
        return {}
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(state):
    STATE.write_text(
        json.dumps(state, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )


# ============================================================
# PRIMERA EJECUCIÓN
# ============================================================

def discover():
    out = []
    seen = set()

    for n in range(1, MAX_PAGES + 1):
        url = CATEGORY if n == 1 else f"{CATEGORY}page/{n}/"

        try:
            s = get(url)
        except Exception:
            break

        found = []
        for a in s.select("h2 a,h3 a,article a,.entry-title a"):
            u = absu(a.get("href"))
            if article_url(u) and u not in seen:
                found.append(u)

        new = 0
        for u in found:
            if u not in seen:
                seen.add(u)
                out.append(u)
                new += 1

        print(f"[DESCUBRIR] página {n}: +{new}")

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
    title = clean(h.get_text(" ", strip=True)) if h else clean(
        s.title.get_text() if s.title else ""
    )
    title = re.sub(r"\s+-\s+Next Novels\s*$", "", title, flags=re.I)

    main = s.select_one("article,.entry-content,.post-content,main") or s

    # Portada
    cover = ""
    og = s.find("meta", property="og:image")
    if og and og.get("content"):
        cover = absu(og["content"])
    if not cover:
        img = main.find("img")
        if img:
            cover = absu(img.get("src") or img.get("data-src"))

    author = label(main, "Autor")
    status = label(main, "Estado")
    typ = label(main, "Tipo")

    # Géneros
    genres = []
    for a in main.select("a[href*='/genero/'],a[href*='/tag/']"):
        t = clean(a.get_text(" ", strip=True))
        if t and t.lower() not in [x.lower() for x in genres]:
            genres.append(t)

    # Sinopsis
    summary = ""
    for hh in main.find_all(["h2", "h3", "h4"]):
        if "sinopsis" in clean(hh.get_text()).lower():
            paragraphs = []
            for x in hh.find_all_next():
                if x.name in ["h2", "h3", "h4"]:
                    break
                if x.name == "p":
                    t = clean(x.get_text(" ", strip=True))
                    if t:
                        paragraphs.append(t)
            summary = "\n\n".join(paragraphs)
            break

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
        "updated": updated or datetime.now(timezone.utc).date().isoformat(),
    }


# ============================================================
# FECHA DE ACTUALIZACIÓN
# ============================================================

MONTHS = {
    "enero": 1, "febrero": 2, "marzo": 3, "abril": 4,
    "mayo": 5, "junio": 6, "julio": 7, "agosto": 8,
    "septiembre": 9, "octubre": 10, "noviembre": 11, "diciembre": 12,
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
        url = UPDATES if page == 1 else f"{UPDATES}page/{page}/"

        try:
            s = get(url)
        except Exception as e:
            print("[WARN] No se pudo consultar Actualizaciones:", e)
            return None, latest_date

        articles = s.select("article")
        if not articles:
            break

        page_old = False

        for article in articles:
            text = clean(article.get_text(" ", strip=True))
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
            if not any(x in lower for x in (
                "[añadido]", "[añadidos]", "[nueva novela]", "[novela nueva]"
            )):
                continue

            link = None
            for a in article.select("h2 a,h3 a,.entry-title a,a[href]"):
                u = absu(a.get("href"))
                if article_url(u):
                    link =
