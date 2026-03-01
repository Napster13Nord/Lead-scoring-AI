#!/usr/bin/env node
/**
 * WooCommerce E-commerce Verifier
 * 
 * Reads a CSV of StoreLeads data and verifies which sites are REAL e-commerce stores
 * vs. sites that merely have WooCommerce installed but aren't actively selling products.
 * 
 * Usage: node verify_ecommerce.js <input.csv> [output.csv]
 */

const fs = require('fs');
const path = require('path');

// ─── Configuration ──────────────────────────────────────────────────────────────
const CONFIG = {
    requestTimeout: 10000,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    // Score thresholds
    passThreshold: 45,       // Score >= this = KEEP
    // Delay between requests per domain (ms)
    delayBetweenSites: 1500,
};

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

/**
 * Parse CSV text into an array of row objects.
 * Uses simple line splitting (safe for CSVs without newlines inside quoted fields).
 */
function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length === 0) return [];

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
    return rows;
}

function splitCSVLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (ch === ',' && !inQuotes) {
            fields.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    fields.push(current);
    return fields;
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

/**
 * Fetch with timeout and error handling.
 */
async function safeFetch(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.requestTimeout);

    try {
        const res = await fetch(url, {
            ...options,
            signal: controller.signal,
            headers: {
                'User-Agent': CONFIG.userAgent,
                ...(options.headers || {}),
            },
        });
        clearTimeout(timeout);
        return res;
    } catch (e) {
        clearTimeout(timeout);
        return null;
    }
}

// ─── Verification Checks ─────────────────────────────────────────────────────────

/**
 * Check 1: WooCommerce Store API — fetch products and analyze content quality.
 */
async function checkWCStoreAPI(domainUrl) {
    const baseUrl = domainUrl.replace(/\/+$/, '');
    const apiUrl = `${baseUrl}/wp-json/wc/store/products?per_page=10`;

    const result = {
        apiAccessible: false,
        productCount: 0,
        productsWithPrice: 0,
        hasAddToCart: false,
        hasDummyContent: false,
        dummyContentDetails: [],
        productNames: [],
        score: 0,
    };

    const res = await safeFetch(apiUrl);
    if (!res || res.status !== 200) {
        return result;
    }

    let products;
    try {
        products = await res.json();
        if (!Array.isArray(products)) return result;
    } catch {
        return result;
    }

    result.apiAccessible = true;
    result.productCount = products.length;

    // Analyze each product
    for (const p of products) {
        const name = (p.name || '').toLowerCase();
        const shortDesc = (p.short_description || '').toLowerCase();
        const desc = (p.description || '').toLowerCase();
        const allText = `${name} ${shortDesc} ${desc}`;

        result.productNames.push(p.name || 'unnamed');

        // Check prices
        const price = parseFloat(p.prices?.price || 0);
        const regularPrice = parseFloat(p.prices?.regular_price || 0);
        if (price > 0 || regularPrice > 0) {
            result.productsWithPrice++;
        }

        // Check add to cart
        const cartText = (p.add_to_cart?.text || '').toLowerCase();
        if (cartText.includes('add to cart') || cartText.includes('add to basket')) {
            result.hasAddToCart = true;
        }

        // Check for dummy/lorem ipsum content
        for (const pattern of DUMMY_CONTENT_PATTERNS) {
            if (allText.includes(pattern)) {
                result.hasDummyContent = true;
                result.dummyContentDetails.push(`"${p.name}": contains "${pattern}"`);
                break;
            }
        }
    }

    // Scoring
    if (result.hasDummyContent) {
        result.score = -50; // Strong negative signal
    } else if (result.productsWithPrice > 0 && result.hasAddToCart) {
        result.score = 30;
    } else if (result.productsWithPrice > 0) {
        result.score = 20;
    } else if (result.productCount > 0) {
        result.score = 5;
    }

    return result;
}

/**
 * Check 2: Category & Description analysis from CSV data.
 * Determines if the business type is fundamentally non-ecommerce.
 */
function checkCategoryAndDescription(row, wcApiResult) {
    const result = {
        isNonEcommCategory: false,
        isNonEcommDescription: false,
        matchedCategory: '',
        matchedDescKeyword: '',
        score: 0,
    };

    const categories = (row.categories || '').toLowerCase();
    const description = (row.description || row.meta_description || '').toLowerCase();
    const title = (row.title || '').toLowerCase();
    const allText = `${categories} ${description} ${title}`;

    // Check categories
    for (const keyword of NON_ECOMMERCE_CATEGORIES) {
        if (categories.includes(keyword)) {
            result.isNonEcommCategory = true;
            result.matchedCategory = keyword;
            break;
        }
    }

    // Check description
    for (const keyword of NON_ECOMMERCE_DESCRIPTION_KEYWORDS) {
        if (allText.includes(keyword)) {
            result.isNonEcommDescription = true;
            result.matchedDescKeyword = keyword;
            break;
        }
    }

    // If we have evidence of real products (from WC API or StoreLeads product count),
    // reduce category-only penalty — many legitimate stores have non-ecommerce categories
    const csvProductCount = parseInt(row.products_sold || '0', 10);
    const hasRealProducts = (wcApiResult && wcApiResult.productsWithPrice > 0 && !wcApiResult.hasDummyContent)
        || csvProductCount >= 100;

    // Scoring
    if (result.isNonEcommCategory && result.isNonEcommDescription) {
        result.score = -50; // Very strong non-ecommerce signal
    } else if (result.isNonEcommDescription) {
        result.score = -30; // Description is a stronger signal than category alone
    } else if (result.isNonEcommCategory) {
        // Category alone is weaker — many real stores have non-ecommerce categories
        result.score = hasRealProducts ? -5 : -20;
    } else {
        result.score = 10; // Category seems e-commerce compatible
    }

    return result;
}

/**
 * Check 3: Analyze product count from StoreLeads data.
 */
function checkProductCount(row) {
    const productsSold = parseInt(row.products_sold || '0', 10);

    const result = {
        productsSold,
        score: 0,
    };

    if (productsSold >= 100) {
        result.score = 25; // Strong signal of real store
    } else if (productsSold >= 20) {
        result.score = 15;
    } else if (productsSold >= 5) {
        result.score = 5;
    } else if (productsSold > 0) {
        result.score = -5; // Very few products, suspicious
    } else {
        result.score = -15; // No products at all
    }

    return result;
}

/**
 * Check 4: Homepage scrape — look for e-commerce signals in the HTML.
 */
async function checkHomepage(domainUrl) {
    const result = {
        accessible: false,
        hasShopLink: false,
        hasProductPrices: false,
        hasCartLink: false,
        hasWooProductMarkup: false,
        score: 0,
    };

    const res = await safeFetch(domainUrl);
    if (!res || res.status !== 200) {
        return result;
    }

    let html;
    try {
        html = await res.text();
    } catch {
        return result;
    }

    result.accessible = true;
    const lower = html.toLowerCase();

    // Check for shop/store links
    result.hasShopLink = lower.includes('/shop') || lower.includes('/store') ||
        lower.includes('/products') || lower.includes('href="/shop"') ||
        lower.includes("href='/shop'");

    // Check for product prices on homepage
    result.hasProductPrices = lower.includes('woocommerce-price-amount') ||
        lower.includes('price-amount');

    // Check for cart link
    result.hasCartLink = lower.includes('/cart') || lower.includes('/basket') ||
        lower.includes('cart-contents');

    // Check for WooCommerce product markup
    result.hasWooProductMarkup = lower.includes('add_to_cart_button') ||
        lower.includes('woocommerce-loop') ||
        lower.includes('products columns') ||
        lower.includes('product-category');

    // Scoring
    let signalCount = [result.hasShopLink, result.hasProductPrices, result.hasCartLink, result.hasWooProductMarkup]
        .filter(Boolean).length;

    if (signalCount >= 3) {
        result.score = 25;
    } else if (signalCount >= 2) {
        result.score = 15;
    } else if (signalCount >= 1) {
        result.score = 5;
    } else {
        result.score = -10;
    }

    return result;
}

/**
 * Check 5: Cart page — verify it has real WooCommerce e-commerce content.
 */
async function checkCartPage(domainUrl) {
    const baseUrl = domainUrl.replace(/\/+$/, '');
    const cartUrl = `${baseUrl}/cart`;

    const result = {
        accessible: false,
        hasWooCartMarkup: false,
        score: 0,
    };

    const res = await safeFetch(cartUrl);
    if (!res || res.status !== 200) {
        return result;
    }

    let html;
    try {
        html = await res.text();
    } catch {
        return result;
    }

    result.accessible = true;
    const lower = html.toLowerCase();

    result.hasWooCartMarkup = lower.includes('woocommerce-cart') ||
        lower.includes('woocommerce-checkout') ||
        lower.includes('wc-cart') ||
        lower.includes('woocommerce_cart_nonce') ||
        lower.includes('cart-empty');

    result.score = result.hasWooCartMarkup ? 10 : -5;
    return result;
}

/**
 * Check 6: Estimated monthly sales — use StoreLeads data.
 */
function checkMonthlySales(row) {
    // Parse the sales value (format: "USD $5,129.03")
    const salesStr = (row.estimated_monthly_sales || '').replace(/[^0-9.]/g, '');
    const sales = parseFloat(salesStr) || 0;

    const result = {
        monthlySales: sales,
        score: 0,
    };

    if (sales >= 10000) {
        result.score = 20; // Solid sales volume
    } else if (sales >= 1000) {
        result.score = 10;
    } else if (sales >= 500) {
        result.score = 0;  // Borderline
    } else {
        result.score = -10; // Very low or no sales
    }

    return result;
}

// ─── Main Verification Pipeline ──────────────────────────────────────────────────

async function verifySite(row) {
    const domain = row.domain || '';
    const domainUrl = row.domain_url || '';

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🔍 Verifying: ${domain} (${domainUrl})`);
    console.log(`${'═'.repeat(60)}`);

    // Run all checks
    const [wcApi, homepage, cartPage] = await Promise.all([
        checkWCStoreAPI(domainUrl),
        checkHomepage(domainUrl),
        checkCartPage(domainUrl),
    ]);

    const categoryCheck = checkCategoryAndDescription(row, wcApi);
    const productCountCheck = checkProductCount(row);
    const salesCheck = checkMonthlySales(row);

    // Calculate total score
    const totalScore = wcApi.score + categoryCheck.score + productCountCheck.score +
        homepage.score + cartPage.score + salesCheck.score;

    // Build reasons
    const reasons = [];

    if (wcApi.hasDummyContent) {
        reasons.push(`❌ DUMMY CONTENT detected: ${wcApi.dummyContentDetails.join('; ')}`);
    }
    if (wcApi.apiAccessible) {
        reasons.push(`API: ${wcApi.productCount} products, ${wcApi.productsWithPrice} with price (score: ${wcApi.score})`);
    } else {
        reasons.push(`API: not accessible (score: ${wcApi.score})`);
    }
    if (categoryCheck.isNonEcommCategory) {
        reasons.push(`❌ Non-ecommerce category: "${categoryCheck.matchedCategory}" (score: ${categoryCheck.score})`);
    }
    if (categoryCheck.isNonEcommDescription) {
        reasons.push(`❌ Non-ecommerce description keyword: "${categoryCheck.matchedDescKeyword}" (score: ${categoryCheck.score})`);
    }
    reasons.push(`Products sold: ${productCountCheck.productsSold} (score: ${productCountCheck.score})`);
    reasons.push(`Monthly sales: $${salesCheck.monthlySales.toFixed(2)} (score: ${salesCheck.score})`);
    reasons.push(`Homepage signals: shop=${homepage.hasShopLink}, prices=${homepage.hasProductPrices}, cart=${homepage.hasCartLink}, woo=${homepage.hasWooProductMarkup} (score: ${homepage.score})`);
    reasons.push(`Cart page: ${cartPage.hasWooCartMarkup ? 'has WC markup' : 'no WC markup'} (score: ${cartPage.score})`);

    const passed = totalScore >= CONFIG.passThreshold;
    const verdict = passed ? '✅ KEEP — Real ecommerce store' : '❌ REMOVE — Not a real ecommerce store';

    // Print results
    console.log(`\n📊 Score breakdown:`);
    console.log(`   WC API:        ${String(wcApi.score).padStart(4)}`);
    console.log(`   Category/Desc: ${String(categoryCheck.score).padStart(4)}`);
    console.log(`   Product Count: ${String(productCountCheck.score).padStart(4)}`);
    console.log(`   Homepage:      ${String(homepage.score).padStart(4)}`);
    console.log(`   Cart Page:     ${String(cartPage.score).padStart(4)}`);
    console.log(`   Monthly Sales: ${String(salesCheck.score).padStart(4)}`);
    console.log(`   ─────────────────────`);
    console.log(`   TOTAL:         ${String(totalScore).padStart(4)} (threshold: ${CONFIG.passThreshold})`);
    console.log(`\n   ${verdict}`);

    return {
        totalScore,
        passed,
        verdict,
        reasons: reasons.join(' | '),
        details: { wcApi, categoryCheck, productCountCheck, homepage, cartPage, salesCheck },
    };
}

// ─── Main ────────────────────────────────────────────────────────────────────────

/**
 * Prompt user for input in the terminal.
 */
function askQuestion(question) {
    return new Promise((resolve) => {
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

/**
 * Wait for Enter key before closing the window.
 */
function waitForEnter(message = '\nPressione ENTER para fechar...') {
    return new Promise((resolve) => {
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(message, () => {
            rl.close();
            resolve();
        });
    });
}

async function main() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║    WooCommerce E-commerce Verifier                      ║');
    console.log('║    Verifica se sites WooCommerce vendem de verdade       ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    let inputFile = process.argv[2];

    // If no file provided, ask the user
    if (!inputFile) {
        // List CSV files in the current directory
        const csvFiles = fs.readdirSync('.').filter(f => f.endsWith('.csv'));
        if (csvFiles.length > 0) {
            console.log('📋 Ficheiros CSV encontrados nesta pasta:\n');
            csvFiles.forEach((f, i) => console.log(`   ${i + 1}. ${f}`));
            console.log('');
            const answer = await askQuestion('Digite o número ou o nome do ficheiro CSV: ');

            // Check if answer is a number (index)
            const idx = parseInt(answer, 10);
            if (idx >= 1 && idx <= csvFiles.length) {
                inputFile = csvFiles[idx - 1];
            } else {
                inputFile = answer;
            }
        } else {
            inputFile = await askQuestion('Digite o nome do ficheiro CSV: ');
        }
    }

    // Validate input file
    if (!inputFile || !fs.existsSync(inputFile)) {
        console.error(`\n❌ Ficheiro não encontrado: "${inputFile}"`);
        console.error('   Coloque o ficheiro CSV na mesma pasta que este script.');
        await waitForEnter();
        process.exit(1);
    }

    console.log(`\n📂 A ler: ${inputFile}`);
    const csvText = fs.readFileSync(inputFile, 'utf-8');
    const rows = parseCSV(csvText);
    console.log(`📋 ${rows.length} leads encontrados para verificar\n`);

    // Get headers from original file
    const firstLine = csvText.split(/\r?\n/)[0];
    const headers = splitCSVLine(firstLine);

    // Add new columns if not present
    if (!headers.includes('woo_verified')) headers.push('woo_verified');
    if (!headers.includes('woo_check_date')) headers.push('woo_check_date');
    if (!headers.includes('verification_score')) headers.push('verification_score');
    if (!headers.includes('verification_reason')) headers.push('verification_reason');

    const results = [];
    const today = new Date().toISOString().split('T')[0];

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        console.log(`\n⏳ [${i + 1}/${rows.length}] A verificar ${row.domain || row.domain_url}...`);

        const verification = await verifySite(row);

        row.woo_verified = verification.passed ? 'YES' : 'NO';
        row.woo_check_date = today;
        row.verification_score = String(verification.totalScore);
        row.verification_reason = verification.verdict;

        results.push(row);

        // Delay between sites to be polite
        if (i < rows.length - 1) {
            await sleep(CONFIG.delayBetweenSites);
        }
    }

    // ─── Create results folder ──────────────────────────────────────────────────
    const baseName = path.basename(inputFile, '.csv');
    const resultsDir = path.join(path.dirname(inputFile) || '.', `results_${baseName}`);

    if (!fs.existsSync(resultsDir)) {
        fs.mkdirSync(resultsDir, { recursive: true });
    }

    const kept = results.filter(r => r.woo_verified === 'YES');
    const removed = results.filter(r => r.woo_verified === 'NO');

    // Write KEEP CSV
    const keepFile = path.join(resultsDir, `KEEP_${baseName}.csv`);
    const keepLines = [headers.join(',')];
    for (const row of kept) {
        keepLines.push(rowToCSV(row, headers));
    }
    fs.writeFileSync(keepFile, keepLines.join('\n'), 'utf-8');

    // Write REMOVE CSV
    const removeFile = path.join(resultsDir, `REMOVE_${baseName}.csv`);
    const removeLines = [headers.join(',')];
    for (const row of removed) {
        removeLines.push(rowToCSV(row, headers));
    }
    fs.writeFileSync(removeFile, removeLines.join('\n'), 'utf-8');

    // ─── Print summary ──────────────────────────────────────────────────────────
    console.log(`\n\n${'═'.repeat(60)}`);
    console.log(`📊 RESUMO FINAL`);
    console.log(`${'═'.repeat(60)}`);

    console.log(`\n✅ MANTER (${kept.length}):`);
    for (const r of kept) {
        console.log(`   • ${r.domain} (score: ${r.verification_score})`);
    }

    console.log(`\n❌ REMOVER (${removed.length}):`);
    for (const r of removed) {
        console.log(`   • ${r.domain} (score: ${r.verification_score})`);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📁 Resultados salvos em: ${resultsDir}/`);
    console.log(`   ✅ ${keepFile}`);
    console.log(`   ❌ ${removeFile}`);

    await waitForEnter();
}

main().catch(async (err) => {
    console.error('\n❌ Erro fatal:', err.message || err);
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise(r => rl.question('\nPressione ENTER para fechar...', () => { rl.close(); r(); }));
    process.exit(1);
});
