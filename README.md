# AnimeSub.info Stremio Addon - Vercel

Wtyczka Stremio z polskimi napisami do anime z animesub.info, dostosowana do wdrożenia na Vercel.

## Wdrożenie na Vercel

### 1. Zainstaluj Vercel CLI (opcjonalnie)
```bash
npm i -g vercel
```

### 2. Wdróż projekt
```bash
# Z katalogu projektu
vercel

# Lub połącz z GitHub i wdróż automatycznie przez vercel.com
```

### 3. Zmienna środowiskowa (opcjonalna)
W panelu Vercel dodaj zmienną:
- `BASE_URL` = `https://twoja-domena.vercel.app`

Jeśli jej nie ustawisz, addon automatycznie wykryje URL z nagłówków requestu.

### 4. Dodaj do Stremio
Po wdrożeniu dodaj addon wklejając URL do Stremio:
```
https://twoja-domena.vercel.app/manifest.json
```

## Struktura projektu

```
├── api/
│   ├── manifest.js     # Endpoint /manifest.json
│   ├── download.js     # Endpoint pobierania napisów
│   └── stremio.js      # Główny handler żądań Stremio
├── core.js             # Współdzielona logika (scraping, dekodowanie)
├── manifest.js         # Definicja manifestu
├── package.json
└── vercel.json         # Konfiguracja routingu Vercel
```

## Różnice względem wersji HuggingFace

- Usunięto `http.createServer` i `server.listen` (serverless)
- Usunięto `setInterval` dla cache (bez persystentnego procesu)
- Usunięto obsługę 7z (binarki systemowe niedostępne na Vercel)
- Cache działa w pamięci (per instancja cold-start)
- BASE_URL wykrywany z `VERCEL_URL` lub nagłówków requestu
- Routing przez `vercel.json` zamiast własnego serwera HTTP

## Uwagi

- Vercel Functions mają limit 30s na wykonanie (ustawiony w `vercel.json`)
- Plan Free Vercel ma limit 12s, może wymagać planu Pro dla niektórych żądań
- Cache in-memory jest nietrwały między wywołaniami serverless (cold starts)
