#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin
import requests
from bs4 import BeautifulSoup

BASE = "https://nextnovels.com"
UPDATES = BASE + "/actualzaciones-orientales/"
OUT = Path("catalogo")
DATA = OUT / "catalogo.json"

S = requests.Session()
S.headers.update({"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36"})

def get_soup(url):
    try:
        r = S.get(url, timeout=15)
        r.raise_for_status()
        return BeautifulSoup(r.text, "html.parser")
    except Exception as e:
        print(f"Error entrando a {url}: {e}")
        return None

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    existing_books = {}
    
    if DATA.exists():
        try:
            for b in json.loads(DATA.read_text(encoding="utf-8")):
                existing_books[b["url"]] = b
        except: pass

    print("Buscando actualizaciones en NextNovels...")
    soup = get_soup(UPDATES)
    
    if soup:
        # Buscamos los artículos de las novelas
        articles = soup.find_all("article") or soup.select(".post")
        for article in articles:
            link = article.find("a", href=True)
            if not link: continue
            
            url = link["href"]
            title_el = article.find(["h2", "h3"]) or link
            title = title_el.text.strip()
            img = article.find("img")
            cover = img["src"] if img else ""
            
            # Si no está en el catálogo, lo añadimos
            if url not in existing_books and title:
                existing_books[url] = {
                    "title": title,
                    "url": url,
                    "cover": cover,
                    "updated": datetime.now(timezone.utc).date().isoformat(),
                    "id": url
                }
                print(f"  -> Añadida: {title}")

    # Guardar el catálogo final
    final_books = list(existing_books.values())
    # Ordenar por fecha (los más nuevos primero)
    final_books.sort(key=lambda x: x.get("updated", ""), reverse=True)
    
    for b in final_books:
        b.pop("downloads", None)
    DATA.write_text(json.dumps(final_books, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"¡Terminado! Total de novelas en el catálogo: {len(final_books)}")

if __name__ == "__main__":
    main()
