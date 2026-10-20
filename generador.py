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
