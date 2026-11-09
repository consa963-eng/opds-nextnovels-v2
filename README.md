# opds-nextnovels-v2

Catálogo OPDS 1.2 de Next Novels, para lectores compatibles (Readest y otros).

Tiene dos piezas:

- **`generador.py`**: rastrea nextnovels.com y genera los XML y `catalogo/catalogo.json` dentro de `catalogo/`.
- **`worker.js`**: Cloudflare Worker que sirve el catálogo, añade búsqueda con paginación y expone el descriptor OpenSearch.

## Endpoints del worker

| Ruta | Contenido |
|---|---|
| `/` o `/index.xml` | Raíz del catálogo (navegación) |
| `/catalogo/<archivo>.xml` | Feeds generados (novedades, todos, títulos, autores, géneros) |
| `/search?q=<texto>&page=<n>` | Búsqueda sin acentos, con varios términos y paginación |
| `/opensearch.xml` | Descriptor OpenSearch para que el lector pueda buscar |

La búsqueda exige que aparezcan todos los términos en cualquier orden. Puntúa más si coinciden con el título (5), luego el autor (3), los géneros (2) y el resto de campos (1). Las entradas de búsqueda incluyen las mismas versiones de descarga que los feeds estáticos.

## Generador

```bash
pip install -r requirements.txt
python generador.py                 # sincroniza y regenera catalogo/
python generador.py --debug URL     # lista las versiones de una ficha
```

Cada ejecución:

1. Recorre los listados y busca fichas nuevas.
2. Lee la página de Actualizaciones desde la última fecha guardada y descarga las fichas modificadas.
3. Reintenta las fichas que fallaron la vez anterior.
4. Elimina las novelas que devuelven 404.
5. Guarda el estado y regenera los XML. Si no hay cambios, los archivos salen idénticos y no se crea ningún commit.

Variables de entorno:

- `OPDS_BASE`: base pública de los XML. Recomendado: `https://<tu-worker>/catalogo`, para que los enlaces pasen por el worker (caché y búsqueda). Por defecto apunta a GitHub Raw.

## Despliegue del worker

```bash
npx wrangler deploy
```

`REPO_BASE` está en `wrangler.toml` (`[vars]`). Cámbialo ahí si el repositorio se mueve.

## Notas

- El worker cachea el índice de búsqueda en memoria durante 5 minutos por instancia.
- Solo se sirven los archivos `.xml` planos de `/catalogo/`. Cualquier otra ruta devuelve 404.
