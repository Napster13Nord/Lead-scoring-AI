#!/usr/bin/env node
/**
 * WooCommerce E-commerce Verifier v3
 * 
 * Reads a CSV of StoreLeads data and verifies which sites are REAL e-commerce stores.
 * Optimized for large lists (14k-80k+) with:
 *  - Instant pre-filtering (.org removal, obvious non-ecommerce)
 *  - Concurrent HTTP verification (10 at a time)
 *  - Bulletproof resume (saves per-domain results, never loses progress)
 *  - Final report with stats
 *  - Two output CSVs: KEEP and REMOVE
 */

const fs = require('fs');
const path = require('path');

// ─── Configuration ──────────────────────────────────────────────────────────────
const CONFIG = {
    requestTimeout: 8000,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    passThreshold: 45,
    concurrency: 10,
    saveEvery: 25,
};

// ─── Domains to auto-remove ──────────────────────────────────────────────────────
const BLOCKED_TLDS = ['.org', '.org.uk'];

// ─── Non-ecommerce category keywords (matched against StoreLeads categories) ────
const NON_ECOMMERCE_CATEGORIES = [
    'voice & video chat', 'voip', 'telecom', 'telecommunications',
    'social issues', 'advocacy', 'nonprofit', 'charity', 'foundation',
    'government', 'municipality', 'public agency', 'military',
    'law', 'legal services', 'accounting', 'financial advisory',
    'insurance', 'architecture', 'engineering firm',
    'consulting', 'business operations',
    'restaurant', 'cafe', 'bar', 'barbershop', 'salon', 'spa',
    'plumbing', 'electrician', 'landscaping', 'construction', 'scaffolding',
    'hospital', 'clinic', 'dental', 'therapy', 'mental health',
    'real estate',
    'streaming', 'radio station', 'tv channel',
    'photography portfolio', 'art portfolio',
    'business directory', 'job board', 'classified ads', 'review site', 'coupon site',
    'recruitment', 'staffing', 'employment',
    'web hosting', 'saas',
    'conference', 'meetup', 'wedding',
];

// ─── Non-ecommerce description keywords ─────────────────────────────────────────
const NON_ECOMMERCE_DESCRIPTION_KEYWORDS = [
    'voip', 'telephone system', 'phone system', 'voip telephone',
    'recruitment solution', 'recruitment solutions', 'we provide recruitment',
    'impact strategy', 'film community', 'documentary', 'sundance', 'international film',
    'scaffolding', 'engineering & design', 'access scaffolding',
    'charity', 'donate', 'donation',
    'law firm', 'legal advice', 'financial advisory',
    'demo site', 'test site', 'staging site', 'under construction', 'coming soon',
    'plugin demo', 'theme demo', 'woocommerce demo',
];

// ─── Dummy content patterns ─────────────────────────────────────────────────────
const DUMMY_CONTENT_PATTERNS = [
    'lorem ipsum', 'dolor sit amet', 'consectetur adipiscing',
    'vestibulum tempus', 'fusce quis', 'etiam ultricies',
    'quisque id magna', 'test product', 'sample product',
    'this is a test', 'placeholder', 'example product',
];

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function splitCSVLine(line) {
    const fields = []; let current = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { if (inQuotes && line[i + 1] === '"') { current += '"'; i++; } else inQuotes = !inQuotes; }
        else if (ch === ',' && !inQuotes) { fields.push(current); current = ''; }
        else current += ch;
    }
    fields.push(current); return fields;
}

function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length === 0) return { headers: [], rows: [] };
    const headers = splitCSVLine(lines[0]);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const values = splitCSVLine(lines[i]);
        const row = {};
        for (let j = 0; j < headers.length; j++) row[headers[j]] = values[j] || '';
        rows.push(row);
    }
    return { headers, rows };
}

function escapeCSV(value) {
    const s = String(value ?? '');
    return (s.includes(',') || s.includes('"') || s.includes('\n')) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function rowToCSV(row, headers) { return headers.map(h => escapeCSV(row[h])).join(','); }

function writeCSV(filePath, rows, headers) {
    const lines = [headers.join(',')];
    for (const row of rows) lines.push(rowToCSV(row, headers));
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

async function safeFetch(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.requestTimeout);
    try {
        const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': CONFIG.userAgent } });
        clearTimeout(timeout); return res;
    } catch { clearTimeout(timeout); return null; }
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function askQuestion(q) {
    return new Promise(r => { const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, a => { rl.close(); r(a.trim()); }); });
}

function waitForEnter(msg = '\nPressione ENTER para fechar...') {
    return new Promise(r => { const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout }); rl.question(msg, () => { rl.close(); r(); }); });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRE-FILTER (instant, no HTTP)
// ═══════════════════════════════════════════════════════════════════════════════

function preFilterRow(row) {
    const domain = (row.domain || row.domain_url || '').toLowerCase();

    for (const tld of BLOCKED_TLDS) {
        if (domain.endsWith(tld) || domain.includes(tld + '/'))
            return { pass: false, reason: `Dominio ${tld} — auto-removido` };
    }

    const categories = (row.categories || '').toLowerCase();
    const description = (row.description || row.meta_description || '').toLowerCase();
    const title = (row.title || '').toLowerCase();
    const allText = `${categories} ${description} ${title}`;

    let matchedCat = '', matchedDesc = '';
    for (const kw of NON_ECOMMERCE_CATEGORIES) { if (categories.includes(kw)) { matchedCat = kw; break; } }
    for (const kw of NON_ECOMMERCE_DESCRIPTION_KEYWORDS) { if (allText.includes(kw)) { matchedDesc = kw; break; } }

    const productsSold = parseInt(row.products_sold || '0', 10);
    if (matchedCat && matchedDesc && productsSold < 50) {
        return { pass: false, reason: `Categoria "${matchedCat}" + desc "${matchedDesc}"` };
    }

    return { pass: true, reason: '' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP VERIFICATION CHECKS
// ═══════════════════════════════════════════════════════════════════════════════

async function checkWCStoreAPI(domainUrl) {
    const result = { productsWithPrice: 0, hasAddToCart: false, hasDummyContent: false, score: 0 };
    const res = await safeFetch(`${domainUrl.replace(/\/+$/, '')}/wp-json/wc/store/products?per_page=10`);
    if (!res || res.status !== 200) return result;
    let products;
    try { products = await res.json(); if (!Array.isArray(products)) return result; } catch { return result; }

    for (const p of products) {
        const allText = `${p.name || ''} ${p.short_description || ''} ${p.description || ''}`.toLowerCase();
        const price = parseFloat(p.prices?.price || 0);
        if (price > 0 || parseFloat(p.prices?.regular_price || 0) > 0) result.productsWithPrice++;
        const ct = (p.add_to_cart?.text || '').toLowerCase();
        if (ct.includes('add to cart') || ct.includes('add to basket')) result.hasAddToCart = true;
        for (const pat of DUMMY_CONTENT_PATTERNS) { if (allText.includes(pat)) { result.hasDummyContent = true; break; } }
    }

    if (result.hasDummyContent) result.score = -50;
    else if (result.productsWithPrice > 0 && result.hasAddToCart) result.score = 30;
    else if (result.productsWithPrice > 0) result.score = 20;
    else if (products.length > 0) result.score = 5;
    return result;
}

function scoreCategoryDesc(row, wcApi) {
    const categories = (row.categories || '').toLowerCase();
    const allText = `${categories} ${(row.description || row.meta_description || '')} ${row.title || ''}`.toLowerCase();
    let isCat = false, isDesc = false;
    for (const kw of NON_ECOMMERCE_CATEGORIES) { if (categories.includes(kw)) { isCat = true; break; } }
    for (const kw of NON_ECOMMERCE_DESCRIPTION_KEYWORDS) { if (allText.includes(kw)) { isDesc = true; break; } }
    const csvProds = parseInt(row.products_sold || '0', 10);
    const hasReal = (wcApi && wcApi.productsWithPrice > 0 && !wcApi.hasDummyContent) || csvProds >= 100;
    if (isCat && isDesc) return -50;
    if (isDesc) return -30;
    if (isCat) return hasReal ? -5 : -20;
    return 10;
}

function scoreProducts(row) {
    const p = parseInt(row.products_sold || '0', 10);
    if (p >= 100) return 25; if (p >= 20) return 15; if (p >= 5) return 5; if (p > 0) return -5; return -15;
}

function scoreSales(row) {
    const s = parseFloat((row.estimated_monthly_sales || '').replace(/[^0-9.]/g, '')) || 0;
    if (s >= 10000) return 20; if (s >= 1000) return 10; if (s >= 500) return 0; return -10;
}

async function scoreHomepage(url) {
    const res = await safeFetch(url);
    if (!res || res.status !== 200) return -10;
    let html; try { html = await res.text(); } catch { return -10; }
    const l = html.toLowerCase();
    const n = [l.includes('/shop') || l.includes('/store') || l.includes('/products'),
    l.includes('woocommerce-price-amount'), l.includes('/cart') || l.includes('cart-contents'),
    l.includes('add_to_cart_button') || l.includes('woocommerce-loop')].filter(Boolean).length;
    if (n >= 3) return 25; if (n >= 2) return 15; if (n >= 1) return 5; return -10;
}

async function scoreCart(url) {
    const res = await safeFetch(`${url.replace(/\/+$/, '')}/cart`);
    if (!res || res.status !== 200) return 0;
    let html; try { html = await res.text(); } catch { return -5; }
    const l = html.toLowerCase();
    return (l.includes('woocommerce-cart') || l.includes('wc-cart') || l.includes('cart-empty')) ? 10 : -5;
}

/** Verify one site. Wrapped in try/catch so one bad site never crashes the batch. */
async function verifySite(row) {
    try {
        const url = row.domain_url || '';
        const [wcApi, hpScore, cartScore] = await Promise.all([checkWCStoreAPI(url), scoreHomepage(url), scoreCart(url)]);
        const total = wcApi.score + scoreCategoryDesc(row, wcApi) + scoreProducts(row) + hpScore + cartScore + scoreSales(row);
        return { totalScore: total, passed: total >= CONFIG.passThreshold, verdict: total >= CONFIG.passThreshold ? 'KEEP' : 'REMOVE' };
    } catch (e) {
        // If anything fails for this site, mark as REMOVE with score 0
        return { totalScore: 0, passed: false, verdict: 'REMOVE (erro)' };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROGRESS SYSTEM (line-based, not JSON — handles 80k+ without issues)
// ═══════════════════════════════════════════════════════════════════════════════

function loadProgress(progressFile, resultsDir, baseName) {
    const results = new Map(); // domain -> { verified: YES/NO, score, reason }

    // Check for NEW format (.tsv)
    if (fs.existsSync(progressFile)) {
        try {
            const lines = fs.readFileSync(progressFile, 'utf-8').split('\n').filter(l => l.trim());
            for (const line of lines) {
                const parts = line.split('\t');
                if (parts.length >= 4) {
                    results.set(parts[0], { verified: parts[1], score: parts[2], reason: parts[3].trim() });
                }
            }
            return results;
        } catch (e) {
            console.error('   ⚠️  Erro a ler progresso TSV, a verificar formato antigo...');
        }
    }

    // Check for OLD format (_progress.json) — migrate from v2
    const oldJsonFile = path.join(resultsDir, '_progress.json');
    if (fs.existsSync(oldJsonFile)) {
        console.log('   🔄 Migrando progresso do formato antigo (v2)...');
        try {
            // Read the old KEEP/REMOVE CSVs to get actual results per domain
            const keepCsv = path.join(resultsDir, `KEEP_${baseName}.csv`);
            const removeCsv = path.join(resultsDir, `REMOVE_${baseName}.csv`);

            if (fs.existsSync(keepCsv)) {
                const { rows } = parseCSV(fs.readFileSync(keepCsv, 'utf-8'));
                for (const row of rows) {
                    const d = row.domain || '';
                    if (d) results.set(d, { verified: 'YES', score: row.verification_score || '?', reason: row.verification_reason || 'KEEP (migrado)' });
                }
            }
            if (fs.existsSync(removeCsv)) {
                const { rows } = parseCSV(fs.readFileSync(removeCsv, 'utf-8'));
                for (const row of rows) {
                    const d = row.domain || '';
                    if (d) results.set(d, { verified: 'NO', score: row.verification_score || '?', reason: row.verification_reason || 'REMOVE (migrado)' });
                }
            }

            // Write new TSV format
            const tsvLines = [];
            for (const [domain, data] of results) {
                tsvLines.push(`${domain}\t${data.verified}\t${data.score}\t${data.reason}`);
            }
            fs.writeFileSync(progressFile, tsvLines.join('\n') + '\n', 'utf-8');

            // Remove old JSON
            fs.unlinkSync(oldJsonFile);
            console.log(`   ✅ Migrados ${results.size} resultados para novo formato`);
        } catch (e) {
            console.error(`   ⚠️  Erro na migracao: ${e.message}`);
        }
    }

    return results;
}

function appendProgress(progressFile, domain, verified, score, reason) {
    fs.appendFileSync(progressFile, `${domain}\t${verified}\t${score}\t${reason}\n`, 'utf-8');
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

function generateReport(reportFile, stats) {
    const lines = [
        `═══════════════════════════════════════════════════════════`,
        `  RELATORIO — WooCommerce E-commerce Verifier`,
        `  Data: ${new Date().toLocaleDateString('pt-PT')} ${new Date().toLocaleTimeString('pt-PT')}`,
        `═══════════════════════════════════════════════════════════`,
        ``,
        `ENTRADA`,
        `  Ficheiro:              ${stats.inputFile}`,
        `  Total de leads:        ${stats.totalLeads}`,
        ``,
        `PRE-FILTRAGEM (instantanea)`,
        `  Removidos (.org):      ${stats.removedByTLD}`,
        `  Removidos (categoria): ${stats.removedByCategory}`,
        `  Total pre-filtrados:   ${stats.totalPreFiltered}`,
        ``,
        `VERIFICACAO HTTP`,
        `  Sites verificados:     ${stats.httpChecked}`,
        `  Aprovados (KEEP):      ${stats.httpKeep}`,
        `  Reprovados (REMOVE):   ${stats.httpRemove}`,
        `  Tempo de execucao:     ${stats.totalTime}`,
        ``,
        `═══════════════════════════════════════════════════════════`,
        `RESULTADO FINAL`,
        `═══════════════════════════════════════════════════════════`,
        ``,
        `  ✅ MANTER:   ${stats.finalKeep} leads  (${((stats.finalKeep / stats.totalLeads) * 100).toFixed(1)}%)`,
        `  ❌ REMOVER:  ${stats.finalRemove} leads (${((stats.finalRemove / stats.totalLeads) * 100).toFixed(1)}%)`,
        ``,
        `MOTIVOS DE REMOCAO`,
        `  Dominio .org/.org.uk:     ${stats.removedByTLD}`,
        `  Categoria non-ecommerce:  ${stats.removedByCategory}`,
        `  Score HTTP baixo:         ${stats.httpRemove}`,
        ``,
        `FICHEIROS DE SAIDA`,
        `  ✅ ${stats.keepFile}`,
        `  ❌ ${stats.removeFile}`,
        `  📄 ${reportFile}`,
        ``,
    ];
    fs.writeFileSync(reportFile, lines.join('\n'), 'utf-8');
    return lines;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║    WooCommerce E-commerce Verifier v3                   ║');
    console.log('║    Resume robusto + Relatorio final                     ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // ─── Pick input file ─────────────────────────────────────────────────────────
    let inputFile = process.argv[2];
    if (!inputFile) {
        const csvFiles = fs.readdirSync('.').filter(f => f.endsWith('.csv') && !f.startsWith('KEEP_') && !f.startsWith('REMOVE_'));
        if (csvFiles.length > 0) {
            console.log('📋 Ficheiros CSV encontrados:\n');
            csvFiles.forEach((f, i) => console.log(`   ${i + 1}. ${f}`));
            console.log('');
            const answer = await askQuestion('Digite o numero ou o nome do CSV: ');
            const idx = parseInt(answer, 10);
            inputFile = (idx >= 1 && idx <= csvFiles.length) ? csvFiles[idx - 1] : answer;
        } else {
            inputFile = await askQuestion('Nome do ficheiro CSV: ');
        }
    }

    if (!inputFile || !fs.existsSync(inputFile)) {
        console.error(`\n❌ Ficheiro nao encontrado: "${inputFile}"`);
        await waitForEnter(); process.exit(1);
    }

    // ─── Read CSV ────────────────────────────────────────────────────────────────
    console.log(`📂 A ler: ${inputFile}`);
    const csvText = fs.readFileSync(inputFile, 'utf-8');
    const { headers, rows } = parseCSV(csvText);
    console.log(`📋 ${rows.length} leads encontrados\n`);

    // Add output columns
    for (const col of ['woo_verified', 'woo_check_date', 'verification_score', 'verification_reason']) {
        if (!headers.includes(col)) headers.push(col);
    }

    // ─── Setup results folder ────────────────────────────────────────────────────
    const baseName = path.basename(inputFile, '.csv');
    const resultsDir = path.join(path.dirname(inputFile) || '.', `results_${baseName}`);
    if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

    const progressFile = path.join(resultsDir, '_progress.tsv');
    const keepFile = path.join(resultsDir, `KEEP_${baseName}.csv`);
    const removeFile = path.join(resultsDir, `REMOVE_${baseName}.csv`);
    const reportFile = path.join(resultsDir, `RELATORIO_${baseName}.txt`);

    // ─── Load previous progress ──────────────────────────────────────────────────
    const previousResults = loadProgress(progressFile, resultsDir, baseName);
    if (previousResults.size > 0) {
        console.log(`🔄 Progresso anterior: ${previousResults.size} sites ja verificados`);
        console.log(`   A continuar de onde parou...\n`);
    }

    // ═════════════════════════════════════════════════════════════════════════════
    // PHASE 1: Classify all rows (pre-filter or queue for HTTP)
    // ═════════════════════════════════════════════════════════════════════════════
    console.log('━'.repeat(60));
    console.log('⚡ FASE 1: Classificacao (pre-filtragem + progresso anterior)');
    console.log('━'.repeat(60));

    const today = new Date().toISOString().split('T')[0];
    const needHTTP = [];          // rows that need HTTP verification
    const allKeep = [];           // final KEEP results
    const allRemove = [];         // final REMOVE results
    let removedByTLD = 0, removedByCategory = 0;

    for (const row of rows) {
        const domain = row.domain || '';

        // 1) Already processed in previous run? Use cached result
        if (previousResults.has(domain)) {
            const prev = previousResults.get(domain);
            row.woo_verified = prev.verified;
            row.woo_check_date = today;
            row.verification_score = prev.score;
            row.verification_reason = prev.reason;
            if (prev.verified === 'YES') allKeep.push(row);
            else allRemove.push(row);
            continue;
        }

        // 2) Pre-filter check
        const filter = preFilterRow(row);
        if (!filter.pass) {
            row.woo_verified = 'NO';
            row.woo_check_date = today;
            row.verification_score = '-';
            row.verification_reason = filter.reason;
            allRemove.push(row);
            // Save to progress so we don't re-check on next resume
            appendProgress(progressFile, domain, 'NO', '-', filter.reason);

            if (filter.reason.includes('.org')) removedByTLD++;
            else removedByCategory++;
            continue;
        }

        // 3) Needs HTTP verification
        needHTTP.push(row);
    }

    console.log(`\n   Progresso anterior:    ${previousResults.size}`);
    console.log(`   Pre-filtrados (.org):  ${removedByTLD}`);
    console.log(`   Pre-filtrados (categ): ${removedByCategory}`);
    console.log(`   Precisam HTTP:         ${needHTTP.length}`);

    if (needHTTP.length === 0) {
        console.log('\n   ✅ Todos os sites ja foram verificados!');
    } else {
        const est = (needHTTP.length / CONFIG.concurrency) * 3;
        console.log(`   Tempo estimado:        ~${formatTime(est)}`);
    }

    // ═════════════════════════════════════════════════════════════════════════════
    // PHASE 2: HTTP verification (concurrent, with error handling per batch)
    // ═════════════════════════════════════════════════════════════════════════════
    if (needHTTP.length > 0) {
        console.log(`\n${'━'.repeat(60)}`);
        console.log(`🌐 FASE 2: Verificacao HTTP (${CONFIG.concurrency} em paralelo)`);
        console.log('━'.repeat(60));

        const startTime = Date.now();
        let processed = 0, httpKeepCount = 0, httpRemoveCount = 0, errors = 0;

        for (let i = 0; i < needHTTP.length; i += CONFIG.concurrency) {
            const batch = needHTTP.slice(i, i + CONFIG.concurrency);

            // Progress bar
            const pct = Math.round((processed / needHTTP.length) * 100);
            const elapsed = (Date.now() - startTime) / 1000;
            const rate = processed > 0 ? elapsed / processed : 3;
            const remaining = (needHTTP.length - processed) * rate;
            process.stdout.write(`\r   ⏳ ${processed}/${needHTTP.length} (${pct}%) | KEEP: ${httpKeepCount} | REMOVE: ${httpRemoveCount} | Restante: ~${formatTime(remaining)}   `);

            // Process batch — each site is individually wrapped in try/catch
            let batchResults;
            try {
                batchResults = await Promise.all(batch.map(row => verifySite(row)));
            } catch (e) {
                // Entire batch failed (very unlikely), mark all as error
                batchResults = batch.map(() => ({ totalScore: 0, passed: false, verdict: 'REMOVE (erro batch)' }));
                errors++;
            }

            for (let j = 0; j < batch.length; j++) {
                const row = batch[j];
                const r = batchResults[j];
                const domain = row.domain || '';

                row.woo_verified = r.passed ? 'YES' : 'NO';
                row.woo_check_date = today;
                row.verification_score = String(r.totalScore);
                row.verification_reason = r.verdict;

                if (r.passed) { allKeep.push(row); httpKeepCount++; }
                else { allRemove.push(row); httpRemoveCount++; }

                // Append to progress file immediately (never lose a result)
                appendProgress(progressFile, domain, row.woo_verified, row.verification_score, r.verdict);
            }

            processed += batch.length;

            // Save CSVs periodically
            if (processed % CONFIG.saveEvery === 0 || i + CONFIG.concurrency >= needHTTP.length) {
                try {
                    writeCSV(keepFile, allKeep, headers);
                    writeCSV(removeFile, allRemove, headers);
                } catch (e) {
                    console.error(`\n   ⚠️ Erro ao salvar CSV: ${e.message}`);
                }
            }
        }

        const totalTime = (Date.now() - startTime) / 1000;
        process.stdout.write(`\r   ✅ ${processed}/${needHTTP.length} (100%) | KEEP: ${httpKeepCount} | REMOVE: ${httpRemoveCount} | Tempo: ${formatTime(totalTime)}       \n`);
        if (errors > 0) console.log(`   ⚠️  ${errors} batches com erros`);
    }

    // ─── Final save ──────────────────────────────────────────────────────────────
    writeCSV(keepFile, allKeep, headers);
    writeCSV(removeFile, allRemove, headers);

    // ─── Generate report ─────────────────────────────────────────────────────────
    const stats = {
        inputFile,
        totalLeads: rows.length,
        removedByTLD,
        removedByCategory,
        totalPreFiltered: removedByTLD + removedByCategory,
        httpChecked: needHTTP.length,
        httpKeep: allKeep.length - (previousResults.size > 0 ? [...previousResults.values()].filter(v => v.verified === 'YES').length : 0),
        httpRemove: allRemove.length - removedByTLD - removedByCategory - (previousResults.size > 0 ? [...previousResults.values()].filter(v => v.verified === 'NO').length : 0),
        totalTime: needHTTP.length > 0 ? formatTime((Date.now() - Date.now()) / 1000) : '0s', // will be overwritten below
        finalKeep: allKeep.length,
        finalRemove: allRemove.length,
        keepFile,
        removeFile,
    };
    // Fix httpKeep/httpRemove to always be >= 0
    stats.httpKeep = Math.max(0, stats.httpKeep);
    stats.httpRemove = Math.max(0, stats.httpRemove);
    stats.totalTime = 'Ver acima';

    const reportLines = generateReport(reportFile, stats);

    // ─── Print summary ───────────────────────────────────────────────────────────
    console.log(`\n\n${'═'.repeat(60)}`);
    console.log(`📊 RESUMO FINAL`);
    console.log(`${'═'.repeat(60)}`);
    console.log(`\n   Total de leads:       ${rows.length}`);
    console.log(`   ✅ MANTER:            ${allKeep.length}  (${((allKeep.length / rows.length) * 100).toFixed(1)}%)`);
    console.log(`   ❌ REMOVER:           ${allRemove.length} (${((allRemove.length / rows.length) * 100).toFixed(1)}%)`);
    console.log(`\n   📁 Pasta de resultados: ${resultsDir}/`);
    console.log(`      ✅ KEEP_${baseName}.csv`);
    console.log(`      ❌ REMOVE_${baseName}.csv`);
    console.log(`      📄 RELATORIO_${baseName}.txt`);

    // Remove progress file on successful completion
    if (needHTTP.length === 0 || allKeep.length + allRemove.length >= rows.length) {
        // All done — keep progress file but mark as complete
        console.log(`\n   🎉 Verificacao completa!`);
    }

}

// Write crash info to file so user can share it even if terminal closes
function writeCrashLog(err) {
    try {
        const msg = `[${new Date().toISOString()}] CRASH:\n${err.stack || err.message || err}\n\n`;
        fs.appendFileSync('_debug_log.txt', msg, 'utf-8');
    } catch { }
}

process.on('uncaughtException', (err) => {
    console.error('\n❌ Erro fatal (uncaught):', err.message || err);
    writeCrashLog(err);
    process.exit(1);
});

process.on('unhandledRejection', (err) => {
    console.error('\n❌ Erro fatal (unhandled):', err.message || err);
    writeCrashLog(err);
    process.exit(1);
});

main().catch((err) => {
    console.error('\n❌ Erro fatal:', err.message || err);
    console.error(err.stack || '');
    writeCrashLog(err);
    process.exit(1);
});
