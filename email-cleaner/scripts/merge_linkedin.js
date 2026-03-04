/**
 * ╔══════════════════════════════════════════════╗
 * ║      LINKEDIN MERGE  v1.0                   ║
 * ║  Junta leads list + LinkedIn contacts       ║
 * ╚══════════════════════════════════════════════╝
 *
 * Faz o match entre:
 *   FILE 1: Lista de lojas WooCommerce (com domain, linkedin_url, etc.)
 *   FILE 2: Output do Apify leads-finder (com nome, email pessoal, cargo)
 *
 * Match em cascata (mais confiável → menos confiável):
 *   1. domain (File1) ↔ company_domain (File2)        — melhor
 *   2. linkedin_account (File1) ↔ company_linkedin_uid(File2)  — fallback
 *   3. linkedin_url slug ↔ company_linkedin slug       — último recurso
 *
 * Uso: node merge_linkedin.js  (usa os arquivos hardcoded abaixo)
 * Ou:  node merge_linkedin.js <file1.xlsx> <file2.xlsx>
 */

'use strict';
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// ── Default file paths (relative to scripts/ folder) ──
const DEFAULT_FILE1 = path.join(__dirname, '..', 'data', 'Linkedin Scrape, v1 - need to merge with linkedin output.xlsx');
const DEFAULT_FILE2 = path.join(__dirname, '..', 'data', 'merged_leads_finder.xlsx');

// ── Columns to pull from File2 into the merged output ──
const COLS_FROM_FILE2 = [
    'first_name', 'last_name', 'full_name', 'email', 'personal_email',
    'mobile_number', 'linkedin',        // personal linkedin URL
    'job_title', 'seniority_level', 'functional_level',
    'company_name', 'company_size',
    'city', 'state', 'country',
];

// ── Colors ───────────────────────────────────────────
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m',
    red: '\x1b[31m', white: '\x1b[37m', magenta: '\x1b[35m', blue: '\x1b[34m',
};
const clr = (c, t) => C[c] + t + C.reset;

// ════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════

/** Normalize a domain/URL to a bare domain for comparison */
function normalizeDomain(raw) {
    if (!raw) return '';
    let s = String(raw).trim().toLowerCase();
    // Remove protocol
    s = s.replace(/^https?:\/\//, '');
    // Remove www.
    s = s.replace(/^www\./, '');
    // Remove trailing slash and path
    s = s.split('/')[0].split('?')[0].split('#')[0];
    return s;
}

/** Extract company slug from LinkedIn company URL */
function linkedinCompanySlug(raw) {
    if (!raw) return '';
    const s = String(raw).trim().toLowerCase();
    // https://www.linkedin.com/company/rapidbi → "rapidbi"
    const m = s.match(/linkedin\.com\/company\/([^/?#]+)/);
    return m ? m[1].replace(/\/$/, '') : '';
}

/** Normalize a numeric LinkedIn account id */
function normalizeLinkedinId(raw) {
    if (!raw) return '';
    return String(raw).trim().replace(/\D/g, '');
}

// ════════════════════════════════════════════════════
// BUILD LOOKUP MAPS from File2
// ════════════════════════════════════════════════════
function buildLookups(file2Rows) {
    // Map: normalized_domain → [rows]  (can be multiple people per company)
    const byDomain = new Map();
    // Map: linkedin_uid → [rows]
    const byLinkedinId = new Map();
    // Map: linkedin_slug → [rows]
    const bySlug = new Map();

    for (const row of file2Rows) {
        const domain = normalizeDomain(row.company_domain || row.company_website || '');
        const uid = normalizeLinkedinId(row.company_linkedin_uid || '');
        const slug = linkedinCompanySlug(row.company_linkedin || '');

        if (domain) { if (!byDomain.has(domain)) byDomain.set(domain, []); byDomain.get(domain).push(row); }
        if (uid) { if (!byLinkedinId.has(uid)) byLinkedinId.set(uid, []); byLinkedinId.get(uid).push(row); }
        if (slug) { if (!bySlug.has(slug)) bySlug.set(slug, []); bySlug.get(slug).push(row); }
    }
    return { byDomain, byLinkedinId, bySlug };
}

/** Pick the best contact from multiple matches (owner/founder/ceo first) */
function pickBestContact(candidates) {
    if (!candidates || candidates.length === 0) return null;
    const topTitles = ['founder', 'owner', 'ceo', 'managing director', 'director', 'president', 'co-founder'];
    for (const title of topTitles) {
        const match = candidates.find(r => {
            const jt = (r.job_title || '').toLowerCase();
            const sl = (r.seniority_level || '').toLowerCase();
            const fl = (r.functional_level || '').toLowerCase();
            return jt.includes(title) || sl.includes(title) || fl.includes(title);
        });
        if (match) return match;
    }
    // Return the first one if no preferred title found
    return candidates[0];
}

/** Look up File2 match for a File1 row */
function findMatch(row1, lookups) {
    const { byDomain, byLinkedinId, bySlug } = lookups;

    // 1. Domain match
    const domain = normalizeDomain(row1.domain || row1.domain_url || '');
    if (domain && byDomain.has(domain)) {
        return { contact: pickBestContact(byDomain.get(domain)), method: 'domain', candidates: byDomain.get(domain).length };
    }

    // 2. LinkedIn numeric ID match
    const uid = normalizeLinkedinId(row1.linkedin_account || '');
    if (uid && byLinkedinId.has(uid)) {
        return { contact: pickBestContact(byLinkedinId.get(uid)), method: 'linkedin_id', candidates: byLinkedinId.get(uid).length };
    }

    // 3. LinkedIn slug match
    const slug = linkedinCompanySlug(row1.linkedin_url || '');
    if (slug && bySlug.has(slug)) {
        return { contact: pickBestContact(bySlug.get(slug)), method: 'linkedin_slug', candidates: bySlug.get(slug).length };
    }

    return { contact: null, method: 'no_match', candidates: 0 };
}

// ════════════════════════════════════════════════════
// FORMAT TIME
// ════════════════════════════════════════════════════
function formatTime(ms) {
    if (ms < 60000) return Math.floor(ms / 1000) + 's';
    return Math.floor(ms / 60000) + 'm' + Math.floor((ms % 60000) / 1000) + 's';
}

// ════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════
function main() {
    const args = process.argv.slice(2);
    const file1Path = args[0] ? path.resolve(args[0]) : DEFAULT_FILE1;
    const file2Path = args[1] ? path.resolve(args[1]) : DEFAULT_FILE2;

    console.log('\n' + clr('magenta', '╔══════════════════════════════════════════════╗'));
    console.log(clr('magenta', '║') + clr('bold', '       LINKEDIN MERGE  v1.0                  ') + clr('magenta', '║'));
    console.log(clr('magenta', '╚══════════════════════════════════════════════╝'));
    console.log();
    console.log(clr('dim', '📂 File 1 (leads list):     ') + path.basename(file1Path));
    console.log(clr('dim', '📂 File 2 (LinkedIn data):  ') + path.basename(file2Path));

    if (!fs.existsSync(file1Path)) { console.error(clr('red', `\n❌ Não encontrado: ${file1Path}`)); process.exit(1); }
    if (!fs.existsSync(file2Path)) { console.error(clr('red', `\n❌ Não encontrado: ${file2Path}`)); process.exit(1); }

    // ── Load both files ───────────────────────────────
    process.stdout.write(clr('dim', '\n⏳ Carregando File 1... '));
    const wb1 = XLSX.readFile(file1Path);
    const data1 = XLSX.utils.sheet_to_json(wb1.Sheets[wb1.SheetNames[0]], { defval: '' });
    console.log(clr('green', `OK`) + clr('dim', ` (${data1.length.toLocaleString()} linhas)`));

    process.stdout.write(clr('dim', '⏳ Carregando File 2... '));
    const wb2 = XLSX.readFile(file2Path);
    const data2 = XLSX.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]], { defval: '' });
    console.log(clr('green', `OK`) + clr('dim', ` (${data2.length.toLocaleString()} linhas)`));

    // ── Build lookups ─────────────────────────────────
    process.stdout.write(clr('dim', '🔍 Construindo índice de lookup... '));
    const lookups = buildLookups(data2);
    console.log(clr('green', 'OK'));
    console.log(clr('dim', `   → ${lookups.byDomain.size} domínios`));
    console.log(clr('dim', `   → ${lookups.byLinkedinId.size} IDs LinkedIn`));
    console.log(clr('dim', `   → ${lookups.bySlug.size} slugs LinkedIn`));

    // ── Process each row ──────────────────────────────
    console.log('\n' + clr('bold', '⚙️  Mergindo...\n'));
    const startTime = Date.now();

    const stats = { domain: 0, linkedin_id: 0, linkedin_slug: 0, no_match: 0, multi_candidates: 0 };
    const outputRows = [];

    for (let i = 0; i < data1.length; i++) {
        const row1 = data1[i];
        const { contact, method, candidates } = findMatch(row1, lookups);

        stats[method]++;
        if (candidates > 1) stats.multi_candidates++;

        // Build output row: all of File1 + selected columns from File2
        const merged = { ...row1 };

        // Add File2 columns (prefixed with "li_" to avoid collision)
        for (const col of COLS_FROM_FILE2) {
            merged[`li_${col}`] = contact ? (contact[col] || '') : '';
        }
        merged['li_match_method'] = method;
        merged['li_candidates_found'] = candidates;

        outputRows.push(merged);

        // Progress every 100 rows
        if (i % 100 === 0 || i === data1.length - 1) {
            const pct = ((i + 1) / data1.length * 100).toFixed(1);
            const filled = Math.round((i + 1) / data1.length * 30);
            const bar = '█'.repeat(filled) + '░'.repeat(30 - filled);
            process.stdout.write(`\r${clr('cyan', `[${bar}]`)} ${clr('bold', pct + '%')} ${clr('dim', `${(i + 1).toLocaleString()}/${data1.length.toLocaleString()}`)}   `);
        }
    }

    console.log('\n');

    // ── Write output ──────────────────────────────────
    const inputDir = path.dirname(file1Path);
    const inputBase = path.basename(file1Path, path.extname(file1Path));
    const outputDir = path.join(inputDir, '..', 'output', 'output_linkedin_merge');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const allPath = path.join(outputDir, 'merged_all.xlsx');
    const matchedPath = path.join(outputDir, 'merged_matched_only.xlsx');
    const noMatchPath = path.join(outputDir, 'merged_no_match.xlsx');
    const reportPath = path.join(outputDir, 'relatorio_merge.txt');

    process.stdout.write(clr('dim', '💾 Salvando XLSX... '));
    const matched = outputRows.filter(r => r.li_match_method !== 'no_match');
    const unmatched = outputRows.filter(r => r.li_match_method === 'no_match');

    const writeXLSX = (rows, filePath) => {
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
        XLSX.writeFile(wb, filePath);
    };

    writeXLSX(outputRows, allPath);
    writeXLSX(matched, matchedPath);
    writeXLSX(unmatched, noMatchPath);
    console.log(clr('green', 'OK'));

    // ── Report ────────────────────────────────────────
    const elapsed = Date.now() - startTime;
    const totalMatched = stats.domain + stats.linkedin_id + stats.linkedin_slug;
    const matchRate = ((totalMatched / data1.length) * 100).toFixed(1);

    const report = [
        '╔══════════════════════════════════════════════════════════╗',
        '║               RELATÓRIO - LINKEDIN MERGE v1.0           ║',
        '╚══════════════════════════════════════════════════════════╝',
        `Data/Hora       : ${new Date().toLocaleString('pt-BR')}`,
        `File 1          : ${path.basename(file1Path)}  (${data1.length.toLocaleString()} linhas)`,
        `File 2          : ${path.basename(file2Path)}  (${data2.length.toLocaleString()} contatos)`,
        `Tempo total     : ${formatTime(elapsed)}`,
        `Pasta de saída  : ${outputDir}`,
        '',
        '── RESULTADO DO MATCH ─────────────────────────────────────',
        `  Total File 1                  : ${data1.length.toLocaleString().padStart(7)}`,
        `  ✅ Match encontrado           : ${totalMatched.toLocaleString().padStart(7)}  (${matchRate}%)`,
        `  ❌ Sem match                  : ${stats.no_match.toLocaleString().padStart(7)}  (${(100 - parseFloat(matchRate)).toFixed(1)}%)`,
        '',
        '── MÉTODO DE MATCH ────────────────────────────────────────',
        `  Via domain              : ${stats.domain.toLocaleString().padStart(7)}  (mais confiável)`,
        `  Via linkedin_id         : ${stats.linkedin_id.toLocaleString().padStart(7)}`,
        `  Via linkedin_slug       : ${stats.linkedin_slug.toLocaleString().padStart(7)}`,
        `  Múltiplos candidatos    : ${stats.multi_candidates.toLocaleString().padStart(7)}  (escolheu Founder/Owner/CEO)`,
        '',
        '── COLUNAS ADICIONADAS (prefixo li_) ──────────────────────',
        ...COLS_FROM_FILE2.map(c => `  li_${c}`),
        '  li_match_method     (domain / linkedin_id / linkedin_slug / no_match)',
        '  li_candidates_found (quantos contatos do File2 tinham essa empresa)',
        '',
        '── ARQUIVOS GERADOS ───────────────────────────────────────',
        `1. merged_all.xlsx`,
        '   → Todas as linhas do File1 + dados LinkedIn quando encontrado',
        `2. merged_matched_only.xlsx`,
        '   → Só linhas onde encontrou o contato LinkedIn (pronto para campanha pessoal)',
        `3. merged_no_match.xlsx`,
        '   → Lojas sem contato LinkedIn encontrado',
        '══════════════════════════════════════════════════════════',
    ].join('\n');

    fs.writeFileSync(reportPath, report, 'utf8');

    // ── Console summary ───────────────────────────────
    console.log(clr('green', '✅ CONCLUÍDO!\n'));
    console.log(clr('bold', '── RESULTADO ───────────────────────────────────'));
    console.log(clr('green', `   ✅ Com match LinkedIn   : ${totalMatched.toLocaleString().padStart(6)}  (${matchRate}%)`));
    console.log(clr('dim', `      → via domain         : ${stats.domain.toLocaleString().padStart(6)}`));
    console.log(clr('dim', `      → via linkedin_id    : ${stats.linkedin_id.toLocaleString().padStart(6)}`));
    console.log(clr('dim', `      → via linkedin_slug  : ${stats.linkedin_slug.toLocaleString().padStart(6)}`));
    console.log(clr('yellow', `   ❌ Sem match             : ${stats.no_match.toLocaleString().padStart(6)}  (${(100 - parseFloat(matchRate)).toFixed(1)}%)`));
    console.log(clr('bold', '────────────────────────────────────────────────'));
    console.log('\n' + clr('magenta', '📁 Arquivos salvos em:'));
    console.log('   ' + clr('white', outputDir));
    console.log();
}

main();
