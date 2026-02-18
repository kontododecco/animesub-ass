# 🔧 Rozwiązanie problemu: Napisy nie wyświetlają się z libass experimental

## 🚨 Problem

- ❌ Z **libass experimental WŁĄCZONYM**: napisy w ogóle się nie wyświetlają
- ✅ Z **libass experimental WYŁĄCZONYM**: napisy działają ale bez stylów/ozdobników

## 🎯 Diagnoza

To klasyczny problem z **walidacją formatu ASS przez libass**. libass jest **BARDZO wymagający** i odrzuca pliki, które:

1. Mają whitespace przed nawiasami sekcji (np. ` [Script Info]`)
2. Nie mają `ScriptType: v4.00+`
3. Mają nieprawidłowe formaty timestampów
4. Mają BOM w niewłaściwym miejscu
5. Używają `\r\n` zamiast `\n`
6. Mają złą kolejność sekcji

## ✅ Rozwiązanie - index_fixed.js

Stworzyłem **znacznie zaostrzoną** wersję walidacji. Oto kluczowe zmiany:

### 1. Usunięcie whitespace przed sekcjami

```javascript
// PRZED (problematyczny):
"  [Script Info]"  // Whitespace przed [
" [V4+ Styles] "   // Whitespace przed i po [

// PO (poprawne):
"[Script Info]"    // Dokładnie bez whitespace
"[V4+ Styles]"     // Dokładnie bez whitespace
```

**Kod:**
```javascript
lines = lines.map(line => {
    if (line.match(/^\s*\[.*\]$/)) {
        return line.trim(); // Usuń WSZYSTKIE whitespace
    }
    return line;
});
```

### 2. Rebuild dla niepełnych plików

Jeśli plik nie ma którejkolwiek z sekcji, budujemy go OD ZERA:

```javascript
if (!hasScriptInfo || !hasStyles || !hasEvents || !hasScriptType) {
    console.log('[ASS] Niepełna struktura, rebuilding...');
    
    // Zachowaj tylko istniejące dialogi i style
    const existingDialogues = lines.filter(line => 
        line.startsWith('Dialogue:') || line.startsWith('Comment:')
    );
    
    // Zbuduj minimalny prawidłowy plik
    const newLines = [
        '[Script Info]',
        'Title: Subtitle',
        'ScriptType: v4.00+',  // KRYTYCZNE!
        'WrapStyle: 0',
        'PlayResX: 1920',
        'PlayResY: 1080',
        // ... reszta
    ];
}
```

### 3. Naprawa timestampów

libass wymaga **DOKŁADNIE** formatu `H:MM:SS.CS`:

```javascript
function normalizeTimestamp(timestamp) {
    // Przecinek → kropka
    timestamp = timestamp.replace(',', '.');
    
    // Brak centisekund → dodaj .00
    if (/^\d+:\d{2}:\d{2}$/.test(timestamp)) {
        timestamp += '.00';
    }
    
    // Leading zero w godzinach → usuń (0:00:00 → 0:00:00 OK, ale 00:00:00 → 0:00:00)
    timestamp = timestamp.replace(/^0+(\d:)/, '$1');
    
    return timestamp;
}
```

### 4. UTF-8 BEZ BOM dla ASS

**Odkrycie:** libass **preferuje czysty UTF-8 bez BOM**!

```javascript
// PRZED:
return Buffer.from('\uFEFF' + cleaned, 'utf8'); // BOM zawsze

// PO:
function toUtf8Buffer(text, addBOM = false) {
    if (addBOM) {
        return Buffer.from('\uFEFF' + cleaned, 'utf8'); // BOM tylko dla SRT
    } else {
        return Buffer.from(cleaned, 'utf8'); // Czysty UTF-8 dla ASS
    }
}

// Użycie:
const outBuf = toUtf8Buffer(textContent, 
    subtitleExtension !== '.ass' && subtitleExtension !== '.ssa'
);
```

### 5. Używaj \n zamiast \r\n

ASS specyfikacja wymaga `\n` (Unix), nie `\r\n` (Windows):

```javascript
// Czyszczenie przed walidacją:
textContent = textContent.replace(/\r/g, ''); // Usuń wszystkie \r

// W validateAndFixASS():
return lines.join('\n'); // Tylko \n, bez \r
```

### 6. Content-Type: text/plain

**Odkrycie:** Stremio z libass może mieć problem z `text/x-ssa`. Użyj po prostu:

```javascript
contentType = 'text/plain; charset=utf-8';
```

Rozszerzenie `.ass` w URL wystarcza dla libass do rozpoznania formatu.

### 7. Debug logging

Dodałem szczegółowe logi dla diagnozy:

```javascript
console.log(`[Download] ASS Debug:`);
console.log(`  - Rozmiar: ${outBuf.length} bajtów`);
console.log(`  - BOM: ${hasBOM ? 'TAK' : 'NIE'}`);
console.log(`  - Pierwsze 100 znaków: ${textContent.substring(0, 100)}`);
console.log(`  - Sekcje: ScriptInfo=${hasScriptInfo}, ...`);
```

## 🧪 Jak przetestować

### Test 1: Sprawdź logi serwera

```bash
node index_fixed.js
# W drugiej konsoli:
curl "http://localhost:7000/subtitles/download.ass?id=123&hash=abc&query=test&type=org&format=ass" > test.ass
```

Szukaj w logach:
```
[Download] ASS Debug:
  - Rozmiar: 1234 bajtów
  - BOM: NIE                          ← POWINNO BYĆ NIE
  - Pierwsze 100 znaków: [Script Info]\nTitle:...
  - Sekcje: ScriptInfo=true, Styles=true, Events=true, ScriptType=true
```

### Test 2: Waliduj strukturę

```bash
# Pobierz plik
curl "http://localhost:7000/subtitles/download.ass?id=123&hash=abc&query=test&type=org&format=ass" > test.ass

# Sprawdź BOM (powinno być PUSTE lub nie EF BB BF)
hexdump -C test.ass | head -n 1

# Sprawdź strukturę
head -n 20 test.ass

# Powinno wyglądać DOKŁADNIE tak:
# [Script Info]
# Title: Subtitle
# ScriptType: v4.00+
# WrapStyle: 0
# PlayResX: 1920
# PlayResY: 1080
# ScaledBorderAndShadow: yes
# YCbCr Matrix: TV.709
# 
# [V4+ Styles]
# Format: Name, Fontname, ...
# Style: Default,Arial,52,...
# 
# [Events]
# Format: Layer, Start, End, ...
# Dialogue: 0,0:00:01.00,0:00:05.00,Default,,0,0,0,,Tekst
```

### Test 3: Waliduj z narzędziem

```bash
# Jeśli masz Aegisub (edytor ASS)
aegisub test.ass
# Powinien otworzyć bez błędów

# Lub użyj ffmpeg
ffmpeg -i test.ass -f null -
# Nie powinno być błędów parsowania
```

### Test 4: Testuj na Android TV

1. Wdróż `index_fixed.js` na serwer
2. W Stremio:
   - Upewnij się że libass experimental jest **WŁĄCZONY**
   - **ZRESTARTUJ** Stremio (WAŻNE!)
3. Wybierz anime i odcinek
4. Wybierz napisy z AnimeSub.info
5. Sprawdź logi serwera podczas ładowania napisów

## 🔍 Dodatkowa diagnostyka

### Jeśli nadal nie działa:

#### Sprawdź wersję Stremio

```
Settings → About
```

libass experimental działa od wersji **1.6.x+** na Android TV.

#### Sprawdź format pliku źródłowego

Niektóre pliki z animesub.info mogą mieć BARDZO dziwną strukturę. Dodaj więcej logowania:

```javascript
// W downloadSubtitle(), przed walidacją:
console.log('[Download] RAW content (first 500 chars):');
console.log(textContent.substring(0, 500));
```

Sprawdź:
- Czy są dziwne znaki kontrolne?
- Czy sekcje są w dziwnej kolejności?
- Czy są dziwne escape sequences?

#### Test z minimalnym plikiem ASS

Stwórz test endpoint:

```javascript
// Dodaj do serwera:
if (url.pathname === '/test.ass') {
    const minimal = `[Script Info]
Title: Test
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,52,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,Test subtitle
`;
    
    const buf = Buffer.from(minimal, 'utf8');
    res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': buf.length
    });
    res.end(buf);
    return;
}
```

Test w Stremio:
```
Dodaj jako URL napisów: http://twoj-serwer:7000/test.ass
```

Jeśli ten minimalny plik działa, problem jest w plikach z animesub.info.

## 📊 Porównanie zmian

| Aspekt | Przed | Po (index_fixed.js) |
|--------|-------|---------------------|
| Whitespace w sekcjach | Możliwy | Zawsze usuwany |
| BOM dla ASS | Zawsze | Nigdy (czysty UTF-8) |
| Końce linii | Mieszane `\r\n` | Tylko `\n` |
| ScriptType | Czasami brakuje | Zawsze obecny |
| Rebuild | Tylko dodawanie | Pełny rebuild |
| Naprawa timestampów | Nie | Tak |
| Content-Type | `text/x-ssa` | `text/plain` |
| Debug logging | Podstawowy | Szczegółowy |

## 🎯 Możliwe dalsze problemy

### 1. Problem z specific anime

Niektóre pliki ASS z animesub.info mogą mieć:
- Zaawansowane style niemożliwe do wyrenderowania
- Zbyt wiele tagów override
- Skomplikowane animacje

**Rozwiązanie:** Fallback do SRT dla problematycznych plików.

### 2. Problem z ExoPlayer vs libVLC

Stremio Android TV używa różnych playerów. libass experimental działa tylko z:
- **ExoPlayer** z włączonym libass support

**Check:** Settings → Player Settings → Video Player → ExoPlayer

### 3. Problem z konkretnym TV/urządzeniem

Niektóre Android TV mają ograniczone:
- RAM (libass wymaga więcej pamięci)
- GPU (rendering ASS jest kosztowny)

**Rozwiązanie:** Test na innym urządzeniu.

## 📝 Checklist finałowy

Przed wdrożeniem upewnij się że:

- [ ] `index_fixed.js` jest wdrożony
- [ ] Logi pokazują `BOM: NIE` dla plików ASS
- [ ] Logi pokazują wszystkie sekcje jako `true`
- [ ] libass experimental jest WŁĄCZONY w Stremio
- [ ] Stremio został ZRESTARTOWANY po włączeniu
- [ ] Player ustawiony na ExoPlayer (nie libVLC)
- [ ] Testowałeś na znanym działającym anime (np. Attack on Titan)

## 💡 Pro tips

1. **Zawsze restartuj Stremio** po zmianie ustawień libass
2. **Testuj z popularnym anime** - mają dobre napisy
3. **Sprawdź logi** - debug info jest bardzo szczegółowy
4. **Porównaj z działającym plikiem** - jeśli masz ASS który działa, porównaj strukturę
5. **Fallback do SRT** - jeśli nic nie pomaga, oferuj też SRT

## 🆘 Jeśli NADAL nie działa

1. Wyślij mi:
   - Logi serwera (szczególnie sekcję `[Download] ASS Debug`)
   - Przykładowy plik ASS z serwera
   - Wersję Stremio Android TV
   - Model urządzenia

2. Możliwe że:
   - libass w Twojej wersji Stremio ma buga
   - Twoje urządzenie nie wspiera libass
   - Potrzebny inny Content-Type (możemy testować warianty)

---

**Powodzenia!** To powinna rozwiązać problem. Jeśli nie, mamy jeszcze kilka trików w rękawie.
