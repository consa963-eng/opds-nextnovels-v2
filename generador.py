#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generador OPDS de NextNovels incremental. Solo lee actualizaciones y las primeras páginas."""
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse
import requests
from bs4 import BeautifulSoup

BASE = "https://nextnovels.com"
CATEGORY = BASE + "/"
UPDATES = BASE + "/actualzaciones-orientales/"
WORKER_BASE = "https://opds-nextnovels-v2.consa963.workers.dev" # Tu worker
OUT = Path("catalogo")
DATA = OUT / "catalogo.json"
STATE = OUT / "estado.json"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"

# Configuración para actualización incremental
MAX_PAGES = 3  # Solo leerá las 3 primeras páginas del catálogo general
DELAY = 0.5

S = requests.Session()
S.headers.update({"User-Agent": UA, "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"})

def clean(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()

def absu(value):
    return urljoin(BASE, value) if value else ""

def get(url):
    try:
        response = S.get(url, timeout=30)
        response.raise_for_status()
        return BeautifulSoup(response.text, "html.parser")
    except Exception as e:
        print(f"Error cargando {url}: {e}")
        return None

def is_valid_article(url):
    parsed = urlparse(url)
    path = parsed.path.rstrip("/")
    host = (parsed.hostname or "").lower()
    if parsed.netloc and host != "nextnovels.com" and not host.endswith(".nextnovels.com"):
        return False
    bad = {"category", "tag", "author", "page", "genero", "wp-admin"}
    segments = [s.lower() for s in path.split("/") if s]
    if any(seg in bad for seg in segments) or path.startswith(("/wp-", "/indice-")):
        return False
    return path not in ("", "/")

def load_books():
    try:
        return json.loads(DATA.read_text(encoding="utf-8"))
    except Exception:
        return []

def save_books(books):
    OUT.mkdir(parents=True, exist_ok=True)
    DATA.write_text(json.dumps(books, ensure_ascii=False, indent=2), encoding="utf-8")

def load_state():
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except Exception:
        return {}

def save_state(state):
    OUT.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

def extract_books_from_page(soup, base_url):
    books = []
    # Buscamos los artículos (ajusta el selector según la web de NextNovels si es necesario)
    for article in soup.find_all("article"):
        link = article.find("a", href=True)
        if not link: continue
        
        url = absu(link["href"])
        if not is_valid_article(url): continue
        
        # Título
        title_el = article.find(["h2", "h3"]) or link
        title = clean(title_el.text)
        
        # Portada (buscamos la primera imagen)
        img = article.find("img")
        cover = img["src"] if img else ""
        if cover and cover.startswith("data:"): continue # Ignorar imágenes de carga
        
        # Extraer la fecha si está en el texto del artículo (esto depende del tema de la web)
        date_str = "2024-01-01" # Fallback
        time_el = article.find("time")
        if time_el and time_el.get("datetime"):
            date_str = time_el["datetime"][:10]
            
        books.append({
            "title": title,
            "url": url,
            "cover": cover,
            "updated": date_str,
            "id": url
        })
    return books

def main():
    print("Iniciando actualización incremental...")
    all_books = load_books()
    # Diccionario rápido para buscar si ya tenemos la novela
    book_dict = {b["url"]: b for b in all_books}
    state = load_state()
    
    urls_to_scrape = [UPDATES]
    for i in range(1, MAX_PAGES + 1):
        # Si es la primera página, la URL base no suele llevar /page/1/
        page_url = CATEGORY if i == 1 else f"{CATEGORY}page/{i}/"
        urls_to_scrape.append(page_url)
        
    nuevas = 0
    for url in urls_to_scrape:
        print(f"Leyendo: {url}")
        soup = get(url)
        if not soup: continue
        
        page_books = extract_books_from_page(soup, url)
        for book in page_books:
            # Si la novela es nueva o la fecha de actualización es distinta
            if book["url"] not in state or state[book["url"]] != book["updated"]:
                book_dict[book["url"]] = book
                state[book["url"]] = book["updated"]
                nuevas += 1
                
    # Convertimos de vuelta a lista y ordenamos por fecha de actualización (más nuevas primero)
    final_books = list(book_dict.values())
    final_books.sort(key=lambda x: x.get("updated", ""), reverse=True)
    
    save_books(final_books)
    save_state(state)
    print(f"¡Terminado! Se añadieron/actualizaron {nuevas} novelas. Total en catálogo: {len(final_books)}")

if __name__ == "__main__":
    main()
