#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Genera el catálogo OPDS de Next Novels a partir de nextnovels.com.

  python generador.py               sincroniza catalogo/ y regenera los XML
  python generador.py --debug URL   lista las versiones de una ficha
"""

import hashlib
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urljoin, urlparse, urlsplit, urlunsplit
from xml.sax.saxutils import escape, quoteattr

import requests
from bs4 import BeautifulSoup


BASE = "https://nextnovels.com"
CATEGORY = BASE + "/category/novela-ligera/"
UPDATES = BASE + "/actualzaciones-orientales/"

OUT = Path("catalogo")
DATA = OUT / "catalogo.json"
STATE = OUT / "estado.json"

# Base pública de los XML. Si la defines (p. ej. OPDS_BASE=https://<worker>/catalogo),
# los enlaces de los feeds pasan por el worker, con caché y búsqueda.
PUBLIC_BASE = (
    os.environ.get("OPDS_BASE")
    or "https://raw.githubusercontent.com/consa963-eng/opds-nextnovels-v2/main/catalogo"
).rstrip("/")

# Escaneo completo: vuelve a descargar todas las fichas (lo activa el workflow).
FULL_SCAN = os.environ.get("FULL_SCAN", "").strip().lower() == "true"

UA = "Mozilla/5.0 (compatible; NextNovels-OPDS/1.2)"

MAX_PAGES = 1000     # límite de seguridad; el corte real es la página vacía
MIN_VALID = 10       # mínimo de novelas para considerar válido el catálogo
DELAY = 1.0          # segundos entre peticiones (cortesía con la web)
WORKERS = 2          # hilos para fichas
TIMEOUT = 25
RETRIES = 4
BATCH = 100          # guarda y regenera cada N fichas
SUMMARY_MAX = 5000
RETRY_CODES = (429, 500, 502, 503, 504)

ACQ = "application/atom+xml;profile=opds-catalog;kind=acquisition"
NAV = "application/atom+xml;profile=opds-catalog;kind=navigation"
HTML = "text/html"
# Tipo de enlace de cada versión. "http://opds-spec.org/acquisition" hace que
# algunos lectores muestren "Descargar"; "alternate" muestra solo el título.
VERSION_REL = "http://opds-spec.org/acquisition"
# Sube este número si cambia la lógica de portadas: las fichas con otra versión
# se vuelven a leer en la siguiente actualización.
COVER_VERSION = 2
EPOCH = "1970-01-01T00:00:00Z"

PETICIONES = 0

S = requests.Session()
S.headers.update({"User-Agent": UA, "Accept-Language": "es"})


# ============================================================
# UTILIDADES
# ============================================================

def clean(x):
    return re.sub(r"\s+", " ", str(x or "")).strip()


def absu(x):
    # Se quita el fragmento (#comentarios) para no duplicar URLs.
    return urljoin(BASE, x).split("#")[0] if x else ""


def get(url):
    """Descarga una página. Devuelve None si no existe (404)."""
    global PETICIONES

    for intento in range(RETRIES):
        try:
            PETICIONES += 1
            r = S.get(url, timeout=TIMEOUT)
            if r.status_code == 404:
                return None
            if r.status_code in RETRY_CODES:
                raise requests.HTTPError(f"HTTP {r.status_code}")
            r.raise_for_status()
            return BeautifulSoup(r.text, "html.parser")
        except requests.RequestException:
            if intento == RETRIES - 1:
                raise
            espera = 5 * (2 ** intento)
            print(f"[REINTENTO] {url} en {espera}s")
            time.sleep(espera)


def article_url(u):
    if not u:
        return False

    p = urlparse(u)
    if p.netloc and "nextnovels.com" not in p.netloc:
        return False
    if "replytocom" in p.query:
        return False

    path = p.path.rstrip("/")
    bad = (
        "/category/",
        "/tag/",
        "/author/",
        "/page/",
        "/genero/",
        "/indice-",
        "/wp-",
        "/feed",
    )

    return path not in ("", "/") and not any(x in path + "/" for x in bad)


def label(s, text):
    """Valor de una etiqueta tipo 'Autor: X' o 'Autor' seguido de X en la línea siguiente.
    Ancla al inicio de línea para no capturar 'Autores' ni texto de la sinopsis."""
    patron = (
        rf"^{re.escape(text)}"
        rf"(?=\s*:|[ \t]*\n)"
        rf"\s*:?[ \t]*\n?[ \t]*(.+)$"
    )
    m = re.search(patron, s.get_text("\n", strip=True), re.I | re.M)
    return clean(m.group(1)) if m else ""


def write_text(path, texto):
    """Escribe en un archivo temporal y lo sustituye: nunca queda un XML a medias."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(texto, encoding="utf-8")
    tmp.replace(path)


# ============================================================
# DATOS
# ============================================================

def dedupe(books):
    return list({b["url"]: b for b in books if b.get("url")}.values())


def load_books():
    if not DATA.exists():
        return []
    try:
        return json.loads(DATA.read_text(encoding="utf-8"))
    except Exception:
        return []


def save_books(books):
    write_text(DATA, json.dumps(books, ensure_ascii=False, indent=2))


def load_state():
    if not STATE.exists():
        return {}
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(state):
    write_text(STATE, json.dumps(state, ensure_ascii=False, indent=2))


# ============================================================
# DESCUBRIMIENTO
# ============================================================

def find_categories():
    cats = {CATEGORY}
    try:
        s = get(BASE + "/")
        if s:
            for a in s.select("a[href]"):
                u = absu(a.get("href"))
                if "/category/" in u and "novela" in u.lower():
                    cats.add(u if u.endswith("/") else u + "/")
    except Exception as e:
        print("[WARN] No se pudieron leer las categorías:", e)
    print("[CATEGORIAS]", sorted(cats))
    return sorted(cats)


def discover():
    """Recorre los listados y devuelve todas las URLs de novelas."""
    out = []
    seen = set()

    for cat in find_categories():
        for n in range(1, MAX_PAGES + 1):
            url = cat if n == 1 else f"{cat}page/{n}/"

            try:
                s = get(url)
            except Exception as e:
                print("[WARN] Listado", url, e)
                break

            if s is None:
                break

            links = [
                absu(a.get("href"))
                for a in s.select("h2 a,h3 a,article a,.entry-title a")
            ]
            links = [u for u in links if article_url(u)]

            if not links:
                break

            new = 0
            for u in links:
                if u not in seen:
                    seen.add(u)
                    out.append(u)
                    new += 1

            print(f"[DESCUBRIR] {cat} página {n}: {len(links)} enlaces, +{new} nuevos")
            time.sleep(DELAY)

    print(f"[INFO] Novelas encontradas en los listados: {len(out)}")
    return out


# ============================================================
# VERSIONES
# ============================================================

VOL_RANGO = re.compile(r"(?:vol(?:[uú]menes?|\.)?|tomos?)\s*(\d+)\s*[-–]\s*(\d+)", re.I)
VOL_TOTAL = re.compile(r"(\d+)\s*(?:vol(?:[uú]menes?|\.)|tomos?)", re.I)


def contar_volumenes(texto):
    """Devuelve el número de volúmenes del texto, o None si no lo indica.
    Acepta '12 volúmenes', '12 vol.', '12 tomos' y rangos como 'Vol. 1-12'."""
    m = VOL_RANGO.search(texto)
    if m:
        inicio, fin = int(m.group(1)), int(m.group(2))
        if fin >= inicio:
            return fin - inicio + 1
    m = VOL_TOTAL.search(texto)
    if m:
        return int(m.group(1))
    return None


def parse_versiones(s, url):
    """Versiones de la ficha: cada botón 'Descargar' del contenido principal,
    con el nombre del bloque que lo contiene."""
    versiones = []
    vistos = set()

    zona = s.select_one("article") or s  # evita la barra lateral

    for a in zona.select("a[href]"):
        texto = clean(a.get_text(" ", strip=True)).lower()
        href = absu(a.get("href"))

        if texto not in ("descargar", "download"):
            continue
        if not href or href in vistos or href == url:
            continue

        bloque = a.find_parent(class_=re.compile(r"et_pb_column"))
        titulo = None
        if bloque:
            titulo = bloque.find(["h2", "h3", "h4"])
        if not titulo:
            titulo = a.find_previous(["h2", "h3", "h4"])

        nombre = clean(titulo.get_text(" ", strip=True)) if titulo else ""
        nombre = re.sub(r"(?i)^versi[oó]n de\s+", "", nombre).strip()

        if bloque:
            texto_bloque = bloque.get_text(" ", strip=True)
        elif titulo:
            texto_bloque = titulo.get_text(" ", strip=True)
        else:
            texto_bloque = ""

        vistos.add(href)
        versiones.append({
            "nombre": nombre or "Versión",
            "url": href,
            "volumenes": contar_volumenes(f"{nombre} {texto_bloque}"),
        })

    return versiones


# ============================================================
# FICHA
# ============================================================

def url_segura(u):
    """Codifica espacios y caracteres no ASCII de la URL sin volver a codificar
    lo que ya está codificado (%20 se queda igual)."""
    p = urlsplit(u)
    path = quote(p.path, safe="/%:@!$&'()*+,;=-._~")
    query = quote(p.query, safe="%=&+-._~/:@!$'()*,;")
    return urlunsplit((p.scheme, p.netloc, path, query, ""))


def mejor_imagen(img):
    """URL real de una imagen. Ignora marcadores de carga diferida (data:...)
    y prefiere el atributo que el tema usa para la imagen completa."""
    candidatos = []

    for attr in ("data-lazy-src", "data-src", "data-original"):
        if img.get(attr):
            candidatos.append(img[attr].strip())

    # srcset: "url 300w, url 1200w". Se toma la más ancha.
    srcset = img.get("data-srcset") or img.get("srcset") or ""
    ancho_url = []
    for parte in srcset.split(","):
        trozos = parte.strip().split()
        if not trozos:
            continue
        ancho = 0
        if len(trozos) > 1 and trozos[1].endswith("w") and trozos[1][:-1].isdigit():
            ancho = int(trozos[1][:-1])
        ancho_url.append((ancho, trozos[0]))
    ancho_url.sort(reverse=True)
    candidatos += [u for _, u in ancho_url]

    if img.get("src"):
        candidatos.append(img["src"].strip())

    for c in candidatos:
        if c and not c.lower().startswith("data:"):
            return url_segura(absu(c))
    return ""


def portada_de(main):
    """Primera imagen real del contenido, sin logos ni de cabecera/menú/pie."""
    for img in main.find_all("img"):
        if img.find_parent(["header", "nav", "footer"]):
            continue
        u = mejor_imagen(img)
        if u and "logo" not in u.lower():
            return u
    return ""


def parse(url, updated=None):
    """Devuelve la ficha, o None si la página ya no existe (404)."""
    s = get(url)
    if s is None:
        return None

    h = s.find("h1")
    if h:
        title = clean(h.get_text(" ", strip=True))
    else:
        title = clean(s.title.get_text() if s.title else "")
    title = re.sub(r"\s+-\s+Next Novels\s*$", "", title, flags=re.I)

    main = s.select_one("article,.entry-content,.post-content,main") or s

    cover = ""
    og = s.find("meta", property="og:image")
    if og and og.get("content") and not og["content"].lower().startswith("data:"):
        cover = url_segura(absu(og["content"]))
    if not cover:
        cover = portada_de(main)

    author = label(main, "Autor")
    status = label(main, "Estado")
    typ = label(main, "Tipo")

    genres = []
    for a in main.select("a[href*='/genero/'],a[href*='/tag/']"):
        t = clean(a.get_text(" ", strip=True))
        if t and t.lower() not in [x.lower() for x in genres]:
            genres.append(t)

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
        "versiones": parse_versiones(s, url),
        "updated": updated or datetime.now(timezone.utc).date().isoformat(),
        "cover_v": COVER_VERSION,
    }


def scan_one(url, updated=None):
    """Devuelve (estado, ficha). estado: 'ok', 'gone' (404) o 'error'."""
    try:
        b = parse(url, updated)
        time.sleep(DELAY)
        if b is None:
            return "gone", None
        if b["title"]:
            return "ok", b
        return "error", None
    except Exception as e:
        print("[WARN]", url, e)
        return "error", None


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
        re.I,
    )
    if not m:
        return ""

    day = int(m.group(1))
    month = MONTHS[m.group(2).lower()]
    year = int(m.group(3))
    return f"{year:04d}-{month:02d}-{day:02d}"


def get_updates(last_date):
    """Devuelve (cambios, última_fecha). cambios es None si falla la consulta.
    La primera ejecución (sin last_date) solo mira la primera página, que basta
    para fijar la línea base."""
    changes = []
    latest_date = last_date
    paginas = 1 if not last_date else 99

    for page in range(1, paginas + 1):
        url = UPDATES if page == 1 else f"{UPDATES}page/{page}/"

        try:
            s = get(url)
        except Exception as e:
            print("[WARN] No se pudo consultar Actualizaciones:", e)
            return None, last_date

        if s is None:
            break

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

            for a in article.select("a[href]"):
                u = absu(a.get("href"))
                if article_url(u):
                    changes.append({"url": u, "date": date})
                    break

        if page_old:
            break

        time.sleep(DELAY)

    unique = {item["url"]: item for item in changes}
    return list(unique.values()), latest_date


# ============================================================
# OPDS
# ============================================================

def atom_date(value):
    if value and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return f"{value}T00:00:00Z"
    return EPOCH


def feed_updated(books):
    """Fecha del feed = la más reciente de las novelas. Así, si no hay cambios,
    los XML son idénticos y el repositorio no recibe commits vacíos."""
    return atom_date(max((b.get("updated") or "" for b in books), default=""))


def link(rel, href, tipo=None, title=None):
    out = f"<link rel={quoteattr(rel)} href={quoteattr(href)}"
    if tipo:
        out += f" type={quoteattr(tipo)}"
    if title:
        out += f" title={quoteattr(title)}"
    return out + "/>"


def titulo_version(v):
    nombre = v.get("nombre") or "Versión"
    n = v.get("volumenes")
    if not n:
        return nombre
    return f"{nombre} ({n} {'volumen' if n == 1 else 'volúmenes'})"


def ent(b):
    url = b.get("url") or b["id"]

    x = [
        "<entry>",
        f"<title>{escape(b.get('title') or 'Sin título')}</title>",
        f"<id>{escape(b['id'])}</id>",
        f"<updated>{atom_date(b.get('updated'))}</updated>",
        link("alternate", url, HTML),
    ]

    if b.get("cover"):
        x.append(link("http://opds-spec.org/image", b["cover"]))
        x.append(link("http://opds-spec.org/image/thumbnail", b["cover"]))

    if b.get("author"):
        # Atom exige <name>; la versión anterior escribía <n>, que no es válido.
        x.append(f"<author><name>{escape(b['author'])}</name></author>")

    for g in b.get("genres", []):
        x.append(f"<category term={quoteattr(g)} label={quoteattr(g)}/>")

    if b.get("summary"):
        x.append(f'<content type="text">{escape(b["summary"][:SUMMARY_MAX])}</content>')

    versiones = b.get("versiones") or [{"nombre": "Abrir en Next Novels", "url": url}]
    for v in versiones:
        x.append(link(VERSION_REL, v["url"], HTML, titulo_version(v)))

    x.append("</entry>")
    return "\n".join(x)


def feed_xml(titulo, fid, updated, enlaces, entradas):
    x = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<feed xmlns="http://www.w3.org/2005/Atom" '
        'xmlns:opds="http://opds-spec.org/2010/catalog">',
        f"<id>{escape(fid)}</id>",
        f"<title>{escape(titulo)}</title>",
        f"<updated>{updated}</updated>",
    ]
    x += enlaces
    x += entradas
    x.append("</feed>")
    return "\n".join(x)


def list_feed(titulo, fid, items, filename, updated, parent=None):
    enlaces = [
        link("self", f"{PUBLIC_BASE}/{filename}", ACQ),
        link("start", f"{PUBLIC_BASE}/index.xml", NAV),
    ]
    if parent:
        enlaces.append(link("up", parent, NAV))
    return feed_xml(titulo, fid, updated, enlaces, [ent(b) for b in items])


def nav_entry(titulo, eid, href, updated, descripcion="", tipo=ACQ):
    x = [
        "<entry>",
        f"<title>{escape(titulo)}</title>",
        f"<id>{escape(eid)}</id>",
        f"<updated>{updated}</updated>",
    ]
    if descripcion:
        x.append(f'<content type="text">{escape(descripcion)}</content>')
    x.append(link("subsection", href, tipo))
    x.append("</entry>")
    return "\n".join(x)


def nav_feed(titulo, fid, self_href, updated, entradas, parent=None):
    enlaces = [
        link("self", self_href, NAV),
        link("start", f"{PUBLIC_BASE}/index.xml", NAV),
    ]
    if parent:
        enlaces.append(link("up", parent, NAV))
    return feed_xml(titulo, fid, updated, enlaces, entradas)


def group_filename(kind, name):
    """Nombre estable: depende del nombre, no de su posición en la lista."""
    digest = hashlib.sha1(name.encode("utf-8")).hexdigest()[:12]
    return f"{kind}-{digest}.xml"


# ============================================================
# GENERAR XML
# ============================================================

def generate(books):
    books = dedupe(books)
    books.sort(key=lambda b: (b.get("title") or "").lower())
    save_books(books)

    updated = feed_updated(books)
    escritos = set()

    def put(nombre, contenido):
        write_text(OUT / nombre, contenido)
        escritos.add(nombre)

    indice = [
        ("Novedades", "novedades.xml", "Últimas novelas actualizadas", ACQ),
        ("Todas las novelas", "todos.xml", "Catálogo completo", ACQ),
        ("Autores", "autores.xml", "Novelas agrupadas por autor", NAV),
        ("Géneros", "generos.xml", "Novelas agrupadas por género", NAV),
        ("Títulos A-Z", "titulos.xml", "Novelas ordenadas alfabéticamente", ACQ),
    ]
    put("index.xml", nav_feed(
        "Next Novels",
        "nextnovels:root",
        f"{PUBLIC_BASE}/index.xml",
        updated,
        [nav_entry(t, f"nextnovels:{f}", f"{PUBLIC_BASE}/{f}", updated, d, tipo)
         for t, f, d, tipo in indice],
    ))

    put("todos.xml", list_feed(
        "Todas las novelas", "nextnovels:all", books, "todos.xml", updated,
        parent=f"{PUBLIC_BASE}/index.xml",
    ))
    put("titulos.xml", list_feed(
        "Títulos A-Z", "nextnovels:titles", books, "titulos.xml", updated,
        parent=f"{PUBLIC_BASE}/index.xml",
    ))

    recientes = sorted(
        books,
        key=lambda b: (b.get("updated") or "", (b.get("title") or "").lower()),
        reverse=True,
    )[:200]
    put("novedades.xml", list_feed(
        "Novedades", "nextnovels:new", recientes, "novedades.xml", updated,
        parent=f"{PUBLIC_BASE}/index.xml",
    ))

    grupos = {"autores": {}, "generos": {}}
    for b in books:
        if b.get("author"):
            grupos["autores"].setdefault(b["author"], []).append(b)
        for g in b.get("genres", []):
            grupos["generos"].setdefault(g, []).append(b)

    titulos = {"autores": "Autores", "generos": "Géneros"}

    for kind, gs in grupos.items():
        entradas = []

        for nombre in sorted(gs, key=str.lower):
            fn = group_filename(kind, nombre)
            put(fn, list_feed(
                nombre,
                f"nextnovels:{kind}:{nombre}",
                gs[nombre],
                fn,
                updated,
                parent=f"{PUBLIC_BASE}/{kind}.xml",
            ))

            n = len(gs[nombre])
            entradas.append(nav_entry(
                nombre,
                f"nextnovels:{kind}:{nombre}",
                f"{PUBLIC_BASE}/{fn}",
                updated,
                f"{n} novela{'s' if n != 1 else ''}",
                ACQ,
            ))

        put(f"{kind}.xml", nav_feed(
            titulos[kind],
            f"nextnovels:{kind}",
            f"{PUBLIC_BASE}/{kind}.xml",
            updated,
            entradas,
            parent=f"{PUBLIC_BASE}/index.xml",
        ))

        # Elimina archivos de autores o géneros que ya no existen.
        for ruta in OUT.glob(f"{kind}-*.xml"):
            if ruta.name not in escritos:
                ruta.unlink()

    print(f"[OK] Catálogo generado: {len(books)} novelas, {len(escritos)} archivos")


# ============================================================
# SINCRONIZACIÓN
# ============================================================

def sync():
    OUT.mkdir(exist_ok=True)

    books = dedupe(load_books())
    known = {b["url"]: b for b in books}
    state = load_state()
    last_date = state.get("last_update", "")
    reintentar = state.get("reintentar", [])

    print(f"[INFO] Catálogo actual: {len(known)} novelas")

    # 1) Fichas que aparecen en los listados y aún no tenemos
    listados = discover()
    nuevas = [u for u in listados if u not in known]
    print(f"[INFO] Fichas nuevas en los listados: {len(nuevas)}")

    # 2) Fichas modificadas según la página de Actualizaciones
    cambios, ultima_fecha = get_updates(last_date)
    if cambios is None:
        print("[WARN] Actualizaciones no disponibles; se omite esta parte.")
        cambios, ultima_fecha = [], last_date
    elif not last_date:
        # Primera vez: la línea base se fija aquí y las fichas
        # se descargan completas más abajo.
        cambios = []

    fechas = {c["url"]: c["date"] for c in cambios}

    pendientes = {}
    for u in nuevas:
        pendientes[u] = fechas.get(u)
    for c in cambios:
        pendientes[c["url"]] = c["date"]

    # 3) Fichas antiguas sin versiones: se completan una vez
    for u, b in known.items():
        if "versiones" not in b and u not in pendientes:
            pendientes[u] = b.get("updated")

    # 3a) Migración: fichas cuyas versiones no tienen el dato de volúmenes
    for u, b in known.items():
        if u not in pendientes and any(
            "volumenes" not in v for v in b.get("versiones", [])
        ):
            pendientes[u] = b.get("updated")

    # 3a2) Migración: fichas leídas con otra lógica de portadas
    for u, b in known.items():
        if u not in pendientes and b.get("cover_v") != COVER_VERSION:
            pendientes[u] = b.get("updated")

    # 3b) Escaneo completo: vuelve a descargar todas las fichas conocidas
    if FULL_SCAN:
        for u, b in known.items():
            pendientes.setdefault(u, b.get("updated"))
        print("[INFO] Escaneo completo activado")

    # 4) Fichas que fallaron en la ejecución anterior
    for u in reintentar:
        if u not in pendientes:
            pendientes[u] = known.get(u, {}).get("updated")

    tareas = list(pendientes.items())
    print(f"[INFO] Fichas por descargar: {len(tareas)}")

    if not known and not tareas:
        raise RuntimeError("NextNovels no devolvió ninguna novela.")

    # 5) Descargar por lotes, guardando y regenerando tras cada lote
    descargadas = 0
    eliminadas = 0
    fallidas = []

    for i in range(0, len(tareas), BATCH):
        lote = tareas[i:i + BATCH]

        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            resultados = list(pool.map(lambda t: scan_one(*t), lote))

        for (url, _), (estado, b) in zip(lote, resultados):
            if estado == "ok":
                known[url] = b
                descargadas += 1
            elif estado == "gone":
                known.pop(url, None)
                eliminadas += 1
            else:
                fallidas.append(url)

        generate(list(known.values()))
        print(f"[PROGRESO] {min(i + BATCH, len(tareas))}/{len(tareas)}")

    if len(known) < MIN_VALID:
        raise RuntimeError(f"Catálogo demasiado pequeño: {len(known)} novelas")

    # El estado se guarda solo cuando todo lo anterior ha salido bien.
    # Las fichas fallidas se reintentan en la siguiente ejecución.
    save_state({
        "last_update": ultima_fecha or last_date,
        "reintentar": fallidas,
    })

    # Siempre se regenera: es determinista, así que sin cambios no hay diferencias.
    generate(list(known.values()))

    print(
        f"[OK] Descargadas o actualizadas: {descargadas} · "
        f"eliminadas: {eliminadas} · pendientes de reintento: {len(fallidas)}"
    )


def check_covers():
    """Comprueba cada portada del catálogo con una petición normal, como haría
    un lector OPDS. Escribe las que fallan en diagnostico/portadas_fallidas.txt."""
    books = dedupe(load_books())
    urls = sorted({b["cover"] for b in books if b.get("cover")})
    sin = [b["url"] for b in books if not b.get("cover")]
    print(f"[INFO] Portadas distintas: {len(urls)} · novelas sin portada: {len(sin)}")

    def probar(u):
        try:
            r = requests.get(u, stream=True, timeout=TIMEOUT, headers={"User-Agent": UA})
            tipo = r.headers.get("Content-Type", "")
            codigo = r.status_code
            r.close()
            ok = codigo == 200 and tipo.startswith("image/")
            return u, ok, f"HTTP {codigo} · {tipo or 'sin Content-Type'}"
        except requests.RequestException as e:
            return u, False, f"error de red: {str(e)[:120]}"

    with ThreadPoolExecutor(max_workers=4) as pool:
        resultados = list(pool.map(probar, urls))

    fallos = [(u, info) for u, ok, info in resultados if not ok]

    lineas = [f"{info}\t{u}" for u, info in fallos]
    lineas += [f"SIN PORTADA\t{u}" for u in sin]

    carpeta = Path("diagnostico")
    carpeta.mkdir(exist_ok=True)
    (carpeta / "portadas_fallidas.txt").write_text("\n".join(lineas) + "\n", encoding="utf-8")

    print(f"[OK] Portadas correctas: {len(urls) - len(fallos)} · fallidas: {len(fallos)}")
    print("[OK] Detalle en diagnostico/portadas_fallidas.txt")


def main():
    sync()
    print(f"[STATS] Peticiones totales: {PETICIONES}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--check-covers":
        check_covers()
    elif len(sys.argv) > 2 and sys.argv[1] == "--debug":
        s = get(sys.argv[2])
        if s is None:
            print("La página no existe (404)")
            sys.exit(1)
        for v in parse_versiones(s, sys.argv[2]):
            print(titulo_version(v), "| volúmenes:", v["volumenes"], "->", v["url"])
    else:
        main()
