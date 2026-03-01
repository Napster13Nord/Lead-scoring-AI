#!/usr/bin/env node
/**
 * WooCommerce E-commerce Verifier (v2 — Optimized for large lists)
 * 
 * Reads a CSV of StoreLeads data and verifies which sites are REAL e-commerce stores.
 * Optimized for 80k+ contacts with:
 *  - Instant pre-filtering (removes .org, obvious non-ecommerce from CSV data alone)
 *  - Concurrent HTTP verification (10 sites at a time)
 *  - Resume capability (saves progress every batch)
 *  - Two output CSVs: KEEP and REMOVE
 * 
 * Usage: node verify_ecommerce.js <input.csv>
 *    or: double-click VERIFICAR.bat
 */

const fs = require('fs');
const path = require('path');

// ─── Configuration ──────────────────────────────────────────────────────────────
const CONFIG = {
    requestTimeout: 8000,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    passThreshold: 45,
    // Concurrency: how many sites to check at the same time
    concurrency: 10,
    // Save progress every N sites
    saveEvery: 50,
};

// ─── Domains to auto-remove ──────────────────────────────────────────────────────
const BLOCKED_TLDS = ['.org', '.org.uk'];

// ─── Non-ecommerce category keywords ────────────────────────────────────────────
const NON_ECOMMERCE_CATEGORIES = [
    'voice & video chat', 'voip', 'telecom', 'telecommunications',
    'social issues', 'advocacy', 'nonprofit', 'charity',
    'film', 'films', 'cinema', 'movie', 'movies',
    'arts & entertainment',
    'recruitment', 'staffing', 'jobs', 'employment',
    'education', 'training & certification', 'courses',
    'consulting', 'business operations',
    'real estate', 'construction', 'scaffolding',
    'internet', 'web hosting', 'saas',
];

// ─── Non-ecommerce description keywords ─────────────────────────────────────────
const NON_ECOMMERCE_DESCRIPTION_KEYWORDS = [
    'voip', 'telephone system', 'phone system', 'cloud hosted', 'voip telephone',
    'recruitment solution', 'free online training', 'online courses', 'recruitment solutions',
    'impact strategy', 'film community', 'documentary', 'sundance', 'international film',
    'scaffolding', 'engineering & design', 'access scaffolding',
    'we provide recruitment', 'screening',
    'charity', 'donate', 'donation',
];

// ─── Lorem ipsum / dummy content patterns ────────────────────────────────────────
const DUMMY_CONTENT_PATTERNS = [
    'lorem ipsum', 'dolor sit amet', 'consectetur adipiscing',
    'vestibulum tempus', 'fusce quis', 'etiam ultricies',
    'quisque id magna', 'test product', 'sample product',
    'this is a test', 'placeholder', 'example product',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function splitCSVLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
            else { inQuotes = !inQuotes; }
        } else if (ch === ',' && !inQuotes) {
            fields.push(current); current = '';
        } else {
            current += ch;
        }
    }
    fields.push(current);
    return fields;
}

function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length === 0) return { headers: [], rows: [] };
    const headers = splitCSVLine(lines[0]);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const values = splitCSVLine(lines[i]);
        const row = {};
        for (let j = 0; j < headers.length; j++) {
            row[headers[j]] = values[j] || '';
        }
        rows.push(row);
    }
    return { headers, rows };
}

function escapeCSVField(value) {
    const str = String(value ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

function rowToCSV(row, headers) {
    return headers.map(h => escapeCSVField(row[h])).join(',');
}

async function safeFetch(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.requestTimeout);
    try {
        const res = await fetch(url, {
            ...options,
            signal: controller.signal,
            headers: { 'User-Agent': CONFIG.userAgent, ...(options.headers || {}) },
        });
        clearTimeout(timeout);
        return res;
    } catch (e) {
        clearTimeout(timeout);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1: CSV-only pre-filtering (instant, no HTTP requests)
// ═══════════════════════════════════════════════════════════════════════════════

function preFilterRow(row) {
    const domain = (row.domain || row.domain_url || '').toLowerCase();

    // 1) Block .org TLDs
    for (const tld of BLOCKED_TLDS) {
        if (domain.endsWith(tld) || domain.includes(tld + '/')) {
            return { pass: false, reason: `Dominio ${tld} — auto-removido` };
        }
    }

    // 2) Check category + description combo (strongest signal)
    const categories = (row.categories || '').toLowerCase();
    const description = (row.description || row.meta_description || '').toLowerCase();
    const title = (row.title || '').toLowerCase();
    const allText = `${categories} ${description} ${title}`;

    let hasNonEcommCategory = false;
    let matchedCat = '';
    for (const kw of NON_ECOMMERCE_CATEGORIES) {
        if (categories.includes(kw)) { hasNonEcommCategory = true; matchedCat = kw; break; }
    }

    let hasNonEcommDesc = false;
    let matchedDesc = '';
    for (const kw of NON_ECOMMERCE_DESCRIPTION_KEYWORDS) {
        if (allText.includes(kw)) { hasNonEcommDesc = true; matchedDesc = kw; break; }
    }

    // If BOTH category and description match non-ecommerce → instant remove
    const productsSold = parseInt(row.products_sold || '0', 10);
    if (hasNonEcommCategory && hasNonEcommDesc && productsSold < 50) {
        return { pass: false, reason: `Categoria "${matchedCat}" + descrição "${matchedDesc}" = não é ecommerce` };
    }

    return { pass: true, reason: '' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2: HTTP-based verification checks
// ═══════════════════════════════════════════════════════════════════════════════

async function checkWCStoreAPI(domainUrl) {
    const baseUrl = domainUrl.replace(/\/+$/, '');
    const result = {
        apiAccessible: false, productCount: 0, productsWithPrice: 0,
        hasAddToCart: false, hasDummyContent: false, dummyContentDetails: [], score: 0
    };

    const res = await safeFetch(`${baseUrl}/wp-json/wc/store/products?per_page=10`);
    if (!res || res.status !== 200) return result;

    let products;
    try { products = await res.json(); if (!Array.isArray(products)) return result; }
    catch { return result; }

    result.apiAccessible = true;
    result.productCount = products.length;

    for (const p of products) {
        const allText = `${p.name || ''} ${p.short_description || ''} ${p.description || ''}`.toLowerCase();
        const price = parseFloat(p.prices?.price || 0);
        const regular = parseFloat(p.prices?.regular_price || 0);
        if (price > 0 || regular > 0) result.productsWithPrice++;
        const cartText = (p.add_to_cart?.text || '').toLowerCase();
        if (cartText.includes('add to cart') || cartText.includes('add to basket')) result.hasAddToCart = true;
        for (const pat of DUMMY_CONTENT_PATTERNS) {
            if (allText.includes(pat)) { result.hasDummyContent = true; result.dummyContentDetails.push(pat); break; }
        }
    }

    if (result.hasDummyContent) result.score = -50;
    else if (result.productsWithPrice > 0 && result.hasAddToCart) result.score = 30;
    else if (result.productsWithPrice > 0) result.score = 20;
    else if (result.productCount > 0) result.score = 5;

    return result;
}

function checkCategoryAndDescription(row, wcApiResult) {
    const categories = (row.categories || '').toLowerCase();
    const description = (row.description || row.meta_description || '').toLowerCase();
    const title = (row.title || '').toLowerCase();
    const allText = `${categories} ${description} ${title}`;

    let isNonEcommCategory = false, isNonEcommDescription = false;
    for (const kw of NON_ECOMMERCE_CATEGORIES) { if (categories.includes(kw)) { isNonEcommCategory = true; break; } }
    for (const kw of NON_ECOMMERCE_DESCRIPTION_KEYWORDS) { if (allText.includes(kw)) { isNonEcommDescription = true; break; } }

    const csvProductCount = parseInt(row.products_sold || '0', 10);
    const hasRealProducts = (wcApiResult && wcApiResult.productsWithPrice > 0 && !wcApiResult.hasDummyContent)
        || csvProductCount >= 100;

    if (isNonEcommCategory && isNonEcommDescription) return -50;
    if (isNonEcommDescription) return -30;
    if (isNonEcommCategory) return hasRealProducts ? -5 : -20;
    return 10;
}

function checkProductCount(row) {
    const p = parseInt(row.products_sold || '0', 10);
    if (p >= 100) return 25;
    if (p >= 20) return 15;
    if (p >= 5) return 5;
    if (p > 0) return -5;
    return -15;
}

function checkMonthlySales(row) {
    const sales = parseFloat((row.estimated_monthly_sales || '').replace(/[^0-9.]/g, '')) || 0;
    if (sales >= 10000) return 20;
    if (sales >= 1000) return 10;
    if (sales >= 500) return 0;
    return -10;
}

async function checkHomepage(domainUrl) {
    const result = { score: 0 };
    const res = await safeFetch(domainUrl);
    if (!res || res.status !== 200) { result.score = -10; return result; }
    let html;
    try { html = await res.text(); } catch { result.score = -10; return result; }
    const lower = html.toLowerCase();
    const signals = [
        lower.includes('/shop') || lower.includes('/store') || lower.includes('/products'),
        lower.includes('woocommerce-price-amount') || lower.includes('price-amount'),
        lower.includes('/cart') || lower.includes('/basket') || lower.includes('cart-contents'),
        lower.includes('add_to_cart_button') || lower.includes('woocommerce-loop') || lower.includes('product-category'),
    ].filter(Boolean).length;
    if (signals >= 3) result.score = 25;
    else if (signals >= 2) result.score = 15;
    else if (signals >= 1) result.score = 5;
    else result.score = -10;
    return result;
}

async function checkCartPage(domainUrl) {
    const res = await safeFetch(`${domainUrl.replace(/\/+$/, '')}/cart`);
    if (!res || res.status !== 200) return 0;
    let html;
    try { html = await res.text(); } catch { return -5; }
    const lower = html.toLowerCase();
    const hasWoo = lower.includes('woocommerce-cart') || lower.includes('woocommerce-checkout')
        || lower.includes('wc-cart') || lower.includes('woocommerce_cart_nonce') || lower.includes('cart-empty');
    return hasWoo ? 10 : -5;
}

/** Full HTTP verification for one site. Returns { totalScore, passed, verdict } */
async function verifySite(row) {
    const domainUrl = row.domain_url || '';

    const [wcApi, homepage, cartScore] = await Promise.all([
        checkWCStoreAPI(domainUrl),
        checkHomepage(domainUrl),
        checkCartPage(domainUrl),
    ]);

    const catScore = checkCategoryAndDescription(row, wcApi);
    const prodScore = checkProductCount(row);
    const salesScore = checkMonthlySales(row);

    const totalScore = wcApi.score + catScore + prodScore + homepage.score + cartScore + salesScore;
    const passed = totalScore >= CONFIG.passThreshold;

    return {
        totalScore,
        passed,
        verdict: passed ? 'KEEP' : 'REMOVE',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONCURRENT BATCH PROCESSOR
// ═══════════════════════════════════════════════════════════════════════════════

async function processBatch(rows, concurrency) {
    const results = [];
    for (let i = 0; i < rows.length; i += concurrency) {
        const batch = rows.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map(row => verifySite(row)));
        for (let j = 0; j < batch.length; j++) {
            const r = batchResults[j];
            batch[j].woo_verified = r.passed ? 'YES' : 'NO';
            batch[j].verification_score = String(r.totalScore);
            batch[j].verification_reason = r.verdict;
            results.push(batch[j]);
        }
    }
    return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OUTPUT
// ═══════════════════════════════════════════════════════════════════════════════

function writeResultCSV(filePath, rows, headers) {
    const lines = [headers.join(',')];
    for (const row of rows) lines.push(rowToCSV(row, headers));
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERACTIVE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function askQuestion(question) {
    return new Promise((resolve) => {
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
    });
}

function waitForEnter(msg = '\nPressione ENTER para fechar...') {
    return new Promise((resolve) => {
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(msg, () => { rl.close(); resolve(); });
    });
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║    WooCommerce E-commerce Verifier v2                   ║');
    console.log('║    Otimizado para listas grandes (80k+)                 ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    let inputFile = process.argv[2];

    // Interactive file picker
    if (!inputFile) {
        const csvFiles = fs.readdirSync('.').filter(f => f.endsWith('.csv'));
        if (csvFiles.length > 0) {
            console.log('📋 Ficheiros CSV encontrados nesta pasta:\n');
            csvFiles.forEach((f, i) => console.log(`   ${i + 1}. ${f}`));
            console.log('');
            const answer = await askQuestion('Digite o número ou o nome do ficheiro CSV: ');
            const idx = parseInt(answer, 10);
            inputFile = (idx >= 1 && idx <= csvFiles.length) ? csvFiles[idx - 1] : answer;
        } else {
            inputFile = await askQuestion('Digite o nome do ficheiro CSV: ');
        }
    }

    if (!inputFile || !fs.existsSync(inputFile)) {
        console.error(`\n❌ Ficheiro não encontrado: "${inputFile}"`);
        await waitForEnter();
        process.exit(1);
    }

    // ─── Read CSV ────────────────────────────────────────────────────────────────
    console.log(`\n📂 A ler: ${inputFile}`);
    const csvText = fs.readFileSync(inputFile, 'utf-8');
    const { headers, rows } = parseCSV(csvText);
    console.log(`📋 ${rows.length} leads encontrados\n`);

    // Add output columns
    if (!headers.includes('woo_verified')) headers.push('woo_verified');
    if (!headers.includes('woo_check_date')) headers.push('woo_check_date');
    if (!headers.includes('verification_score')) headers.push('verification_score');
    if (!headers.includes('verification_reason')) headers.push('verification_reason');

    // ─── Setup results folder ────────────────────────────────────────────────────
    const baseName = path.basename(inputFile, '.csv');
    const resultsDir = path.join(path.dirname(inputFile) || '.', `results_${baseName}`);
    if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
    const progressFile = path.join(resultsDir, '_progress.json');

    // ─── Check for resume ────────────────────────────────────────────────────────
    let alreadyChecked = new Set();
    if (fs.existsSync(progressFile)) {
        const progress = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
        alreadyChecked = new Set(progress.checked || []);
        console.log(`🔄 Progresso anterior encontrado: ${alreadyChecked.size} sites já verificados`);
        console.log(`   A continuar de onde parou...\n`);
    }

    // ═════════════════════════════════════════════════════════════════════════════
    // PHASE 1: Pre-filtering (instant)
    // ═════════════════════════════════════════════════════════════════════════════
    console.log('━'.repeat(60));
    console.log('⚡ FASE 1: Pré-filtragem (dados da planilha, sem HTTP)');
    console.log('━'.repeat(60));

    const today = new Date().toISOString().split('T')[0];
    const keepForHTTP = [];
    const preFilterRemoved = [];

    for (const row of rows) {
        const domain = row.domain || '';

        // Skip if already processed in a previous run
        if (alreadyChecked.has(domain)) continue;

        const filter = preFilterRow(row);
        if (!filter.pass) {
            row.woo_verified = 'NO';
            row.woo_check_date = today;
            row.verification_score = '-';
            row.verification_reason = filter.reason;
            preFilterRemoved.push(row);
        } else {
            keepForHTTP.push(row);
        }
    }

    console.log(`\n   ❌ Removidos pela pré-filtragem: ${preFilterRemoved.length}`);
    console.log(`   ✅ Precisam de verificação HTTP:  ${keepForHTTP.length}`);

    // Estimate time
    const estimatedSeconds = (keepForHTTP.length / CONFIG.concurrency) * 3; // ~3s per batch
    console.log(`   ⏱️  Tempo estimado: ~${formatTime(estimatedSeconds)}`);

    // ═════════════════════════════════════════════════════════════════════════════
    // PHASE 2: HTTP verification (concurrent)
    // ═════════════════════════════════════════════════════════════════════════════
    console.log(`\n${'━'.repeat(60)}`);
    console.log(`🌐 FASE 2: Verificação HTTP (${CONFIG.concurrency} sites em paralelo)`);
    console.log('━'.repeat(60));

    const httpKeep = [];
    const httpRemove = [];
    const startTime = Date.now();
    let processed = 0;

    // Load previous results if resuming
    const keepFile = path.join(resultsDir, `KEEP_${baseName}.csv`);
    const removeFile = path.join(resultsDir, `REMOVE_${baseName}.csv`);

    if (alreadyChecked.size > 0) {
        // Re-read previous results
        if (fs.existsSync(keepFile)) {
            const prev = parseCSV(fs.readFileSync(keepFile, 'utf-8'));
            httpKeep.push(...prev.rows);
        }
        if (fs.existsSync(removeFile)) {
            const prev = parseCSV(fs.readFileSync(removeFile, 'utf-8'));
            httpRemove.push(...prev.rows);
        }
    }

    for (let i = 0; i < keepForHTTP.length; i += CONFIG.concurrency) {
        const batch = keepForHTTP.slice(i, i + CONFIG.concurrency);
        const batchDomains = batch.map(r => r.domain || '???').join(', ');

        // Progress display
        const pct = Math.round(((processed) / keepForHTTP.length) * 100);
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = processed > 0 ? elapsed / processed : 3;
        const remaining = (keepForHTTP.length - processed) * rate;

        process.stdout.write(`\r   ⏳ ${processed}/${keepForHTTP.length} (${pct}%) | Restante: ~${formatTime(remaining)}   `);

        // Process batch concurrently
        const batchResults = await Promise.all(batch.map(row => verifySite(row)));

        for (let j = 0; j < batch.length; j++) {
            const row = batch[j];
            const r = batchResults[j];
            row.woo_verified = r.passed ? 'YES' : 'NO';
            row.woo_check_date = today;
            row.verification_score = String(r.totalScore);
            row.verification_reason = r.verdict;

            if (r.passed) httpKeep.push(row);
            else httpRemove.push(row);

            alreadyChecked.add(row.domain || '');
        }

        processed += batch.length;

        // Save progress periodically
        if (processed % CONFIG.saveEvery === 0 || i + CONFIG.concurrency >= keepForHTTP.length) {
            writeResultCSV(keepFile, httpKeep, headers);
            writeResultCSV(removeFile, [...preFilterRemoved, ...httpRemove], headers);
            fs.writeFileSync(progressFile, JSON.stringify({
                checked: [...alreadyChecked],
                lastUpdate: new Date().toISOString(),
            }), 'utf-8');
        }
    }

    // ─── Final save ──────────────────────────────────────────────────────────────
    const allRemoved = [...preFilterRemoved, ...httpRemove];
    writeResultCSV(keepFile, httpKeep, headers);
    writeResultCSV(removeFile, allRemoved, headers);

    // Clean up progress file on completion
    if (fs.existsSync(progressFile)) fs.unlinkSync(progressFile);

    // ─── Summary ─────────────────────────────────────────────────────────────────
    const totalTime = (Date.now() - startTime) / 1000;

    console.log(`\n\n${'═'.repeat(60)}`);
    console.log(`📊 RESUMO FINAL`);
    console.log(`${'═'.repeat(60)}`);
    console.log(`\n   Total analisados:     ${rows.length}`);
    console.log(`   Pré-filtrados (inst): ${preFilterRemoved.length}`);
    console.log(`   Verificados (HTTP):   ${keepForHTTP.length}`);
    console.log(`   Tempo total:          ${formatTime(totalTime)}`);
    console.log(`\n   ✅ MANTER:  ${httpKeep.length} leads`);
    console.log(`   ❌ REMOVER: ${allRemoved.length} leads`);
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📁 Resultados em: ${resultsDir}/`);
    console.log(`   ✅ KEEP_${baseName}.csv`);
    console.log(`   ❌ REMOVE_${baseName}.csv`);

    await waitForEnter();
}

main().catch(async (err) => {
    console.error('\n❌ Erro fatal:', err.message || err);
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise(r => rl.question('\nPressione ENTER para fechar...', () => { rl.close(); r(); }));
    process.exit(1);
});
