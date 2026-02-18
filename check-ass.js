#!/usr/bin/env node

/**
 * Szybki test pliku ASS - sprawdza zgodność z libass
 */

const fs = require('fs');

function checkASS(filepath) {
    console.log(`\n🔍 Sprawdzanie: ${filepath}\n`);
    
    const buffer = fs.readFileSync(filepath);
    const content = buffer.toString('utf8');
    const lines = content.split(/\r?\n/);
    
    let issues = [];
    let warnings = [];
    
    // 1. Sprawdź BOM
    if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
        warnings.push('⚠️  Plik ma UTF-8 BOM (libass preferuje bez BOM)');
    } else {
        console.log('✅ Brak BOM (dobrze dla libass)');
    }
    
    // 2. Sprawdź końce linii
    if (content.includes('\r\n')) {
        warnings.push('⚠️  Używa \\r\\n (Windows) - libass preferuje \\n (Unix)');
    } else {
        console.log('✅ Używa \\n (Unix line endings)');
    }
    
    // 3. Sprawdź sekcje
    const hasScriptInfo = lines.some(l => l === '[Script Info]');
    const hasStyles = lines.some(l => l === '[V4+ Styles]');
    const hasEvents = lines.some(l => l === '[Events]');
    
    if (!hasScriptInfo) issues.push('❌ Brak sekcji [Script Info]');
    else console.log('✅ Sekcja [Script Info] obecna');
    
    if (!hasStyles) issues.push('❌ Brak sekcji [V4+ Styles]');
    else console.log('✅ Sekcja [V4+ Styles] obecna');
    
    if (!hasEvents) issues.push('❌ Brak sekcji [Events]');
    else console.log('✅ Sekcja [Events] obecna');
    
    // 4. Sprawdź ScriptType
    const hasScriptType = lines.some(l => l.startsWith('ScriptType:'));
    if (!hasScriptType) {
        issues.push('❌ Brak ScriptType: v4.00+ (KRYTYCZNE dla libass!)');
    } else {
        console.log('✅ ScriptType obecny');
    }
    
    // 5. Sprawdź whitespace przed sekcjami
    const sectionsWithWhitespace = lines.filter(l => /^\s+\[.*\]$/.test(l));
    if (sectionsWithWhitespace.length > 0) {
        issues.push(`❌ ${sectionsWithWhitespace.length} sekcji ma whitespace przed [ (libass odrzuci!)`);
        sectionsWithWhitespace.forEach(s => console.log(`   Problem: "${s}"`));
    } else {
        console.log('✅ Brak whitespace przed sekcjami');
    }
    
    // 6. Sprawdź Format lines
    if (hasStyles) {
        const stylesStart = lines.findIndex(l => l === '[V4+ Styles]');
        let hasStylesFormat = false;
        for (let i = stylesStart + 1; i < lines.length && !lines[i].startsWith('['); i++) {
            if (lines[i].startsWith('Format:')) {
                hasStylesFormat = true;
                break;
            }
        }
        if (!hasStylesFormat) {
            issues.push('❌ Brak Format: line w [V4+ Styles]');
        } else {
            console.log('✅ Format line w [V4+ Styles] obecny');
        }
    }
    
    if (hasEvents) {
        const eventsStart = lines.findIndex(l => l === '[Events]');
        let hasEventsFormat = false;
        for (let i = eventsStart + 1; i < lines.length && !lines[i].startsWith('['); i++) {
            if (lines[i].startsWith('Format:')) {
                hasEventsFormat = true;
                break;
            }
        }
        if (!hasEventsFormat) {
            issues.push('❌ Brak Format: line w [Events]');
        } else {
            console.log('✅ Format line w [Events] obecny');
        }
    }
    
    // 7. Sprawdź Default style
    const hasDefaultStyle = lines.some(l => l.startsWith('Style: Default'));
    if (!hasDefaultStyle) {
        warnings.push('⚠️  Brak stylu "Default" (może powodować problemy)');
    } else {
        console.log('✅ Styl "Default" obecny');
    }
    
    // 8. Sprawdź timestampy
    const dialogues = lines.filter(l => l.startsWith('Dialogue:'));
    let badTimestamps = 0;
    for (const d of dialogues.slice(0, 5)) { // Sprawdź pierwsze 5
        const parts = d.split(',');
        if (parts.length >= 3) {
            const start = parts[1].trim();
            const end = parts[2].trim();
            if (!/^\d+:\d{2}:\d{2}\.\d{2}$/.test(start)) {
                badTimestamps++;
            }
            if (!/^\d+:\d{2}:\d{2}\.\d{2}$/.test(end)) {
                badTimestamps++;
            }
        }
    }
    if (badTimestamps > 0) {
        warnings.push(`⚠️  ${badTimestamps} timestampów nie w formacie H:MM:SS.CS`);
    } else if (dialogues.length > 0) {
        console.log('✅ Timestampy w poprawnym formacie');
    }
    
    // Podsumowanie
    console.log('\n' + '='.repeat(60));
    if (issues.length === 0 && warnings.length === 0) {
        console.log('🎉 PLIK WYGLĄDA DOBRZE DLA LIBASS!');
    } else {
        if (issues.length > 0) {
            console.log('\n❌ PROBLEMY (libass odrzuci plik):');
            issues.forEach(i => console.log('  ' + i));
        }
        if (warnings.length > 0) {
            console.log('\n⚠️  OSTRZEŻENIA (może działać, ale lepiej naprawić):');
            warnings.forEach(w => console.log('  ' + w));
        }
    }
    console.log('='.repeat(60) + '\n');
    
    return issues.length === 0;
}

// Main
if (process.argv.length < 3) {
    console.log('Użycie: node check-ass.js <plik.ass>');
    process.exit(1);
}

const filepath = process.argv[2];
if (!fs.existsSync(filepath)) {
    console.error(`Plik nie istnieje: ${filepath}`);
    process.exit(1);
}

const ok = checkASS(filepath);
process.exit(ok ? 0 : 1);
