/**
 * ╔══════════════════════════════════════════════╗
 * ║       LEAD SORTER  v1.0                     ║
 * ║  Ordena leads pelo maior potencial primeiro ║
 * ╚══════════════════════════════════════════════╝
 *
 * Lógica de ordenação:
 *   1. estimated_monthly_sales > $500  → ordenado do MAIOR para o menor
 *   2. estimated_monthly_sales = $500  → "sem dados reais", vai para o fim
 *      e dentro desse grupo ordena por combined_followers do maior para o menor
 *   3. Sem valor de vendas → vai para o final absoluto
 *
 * Uso: node lead_sorter.js <arquivo.csv>
 * Ou:  arraste o CSV no sort.bat
 */

'use strict';
const fs = require('fs');
const path = require('path');

// ── Valor placeholder (sem dados reais de vendas) ──
const PLACEHOLDER_SALES = 500.00;

// ── Cores ANSI ─────────────────────────────────────
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m',
    red: '\x1b[31m', white: '\x1b[37m', magenta: '\x1b[35m',
};
const clr = (color, txt) => C[color] + txt + C.reset;

// ════════════════════════════════════════════════════
// CSV PARSER  (handles quoted fields)
// ════════════════════════════════════════════════════
function parseCSV(content) {
    const rows = [];
    let i = 0;
    const len = content.length;
    while (i < len) {
        const row = [];
        while (i < len && (content[i] === '\r' || content[i] === '\n')) i++;
        if (i >= len) break;
        while (i < len && content[i] !== '\n') {
            if (content[i] === '"') {
                i++;
                let field = '';
                while (i < len) {
                    if (content[i] === '"' && content[i + 1] === '"') { field += '"'; i += 2; }
                    else if (content[i] === '"') { i++; break; }
                    else { field += content[i++]; }
                }
                row.push(field);
                if (i < len && content[i] === ',') i++;
            } else {
                let start = i;
                while (i < len && content[i] !== ',' && content[i] !== '\n' && content[i] !== '\r') i++;
                row.push(content.slice(start, i).trim());
                if (i < len && content[i] === ',') i++;
            }
        }
        if (row.length > 0 && !(row.length === 1 && row[0] === '')) rows.push(row);
    }
    return rows;
}

function toCSVRow(fields) {
    return fields.map(f => {
        const s = String(f ?? '');
        if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
            return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
    }).join(',');
}

// ════════════════════════════════════════════════════
// PARSE VALUE HELPERS
// ════════════════════════════════════════════════════

/**
 * Parses "USD $29,200.10" or "29200.10" or "$500" → number
 * Returns NaN if not parseable.
 */
function parseSales(raw) {
    if (!raw || raw.trim() === '') return NaN;
    // Remove currency symbols, letters, spaces — keep digits, dots, commas
    const cleaned = raw.replace(/[^0-9.,]/g, '').replace(/,/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? NaN : num;
}

/**
 * Parses follower count (integer). Returns 0 if empty/invalid.
 */
function parseFollowers(raw) {
    if (!raw || raw.trim() === '') return 0;
    const cleaned = raw.replace(/[^0-9]/g, '');
    const num = parseInt(cleaned, 10);
    return isNaN(num) ? 0 : num;
}

// ════════════════════════════════════════════════════
// PROGRESS BAR
// ════════════════════════════════════════════════════
function formatTime(ms) {
    if (ms < 60000) return Math.floor(ms / 1000) + 's';
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}m${s}s`;
}

function drawBar(current, total, label) {
    const pct = total > 0 ? current / total : 0;
    const barWidth = 30;
    const filled = Math.round(pct * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
    const pctStr = (pct * 100).toFixed(1).padStart(5) + '%';
    process.stdout.write(`\r${clr('cyan', `[${bar}]`)} ${clr('bold', pctStr)} ${clr('dim', label)}   `);
}

// ════════════════════════════════════════════════════
// SORT TIER CLASSIFICATION
// ════════════════════════════════════════════════════
//  Tier 0 → real sales > $500     (best)
//  Tier 1 → placeholder $500      (medium, sorted by followers)
//  Tier 2 → no/invalid sales data (worst)
function classifyRow(salesRaw, followersRaw) {
    const sales = parseSales(salesRaw);
    const followers = parseFollowers(followersRaw);

    if (isNaN(sales)) {
        return { tier: 2, sales: 0, followers };
    }
    if (Math.abs(sales - PLACEHOLDER_SALES) < 0.01) {
        // Exactly $500 → placeholder
        return { tier: 1, sales, followers };
    }
    return { tier: 0, sales, followers };
}

// ════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════
function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error(clr('red', '\n❌ Uso: node lead_sorter.js <arquivo.csv>'));
        console.error('   Ou arraste o CSV para o sort.bat\n');
        process.exit(1);
    }

    const inputPath = path.resolve(args[0]);
    if (!fs.existsSync(inputPath)) {
        console.error(clr('red', `\n❌ Arquivo não encontrado: ${inputPath}\n`));
        process.exit(1);
    }

    // ── Banner ──────────────────────────────────────
    console.log('\n' + clr('magenta', '╔══════════════════════════════════════════════╗'));
    console.log(clr('magenta', '║') + clr('bold', '        LEAD SORTER  v1.0                    ') + clr('magenta', '║'));
    console.log(clr('magenta', '╚══════════════════════════════════════════════╝'));
    console.log();
    console.log(clr('dim', '📂 Arquivo: ') + clr('white', path.basename(inputPath)));

    // ── Load CSV ─────────────────────────────────────
    process.stdout.write(clr('dim', '⏳ Carregando CSV... '));
    const rawContent = fs.readFileSync(inputPath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const rows = parseCSV(rawContent);
    console.log(clr('green', 'OK'));

    if (rows.length < 2) {
        console.error(clr('red', '❌ CSV vazio ou sem dados.'));
        process.exit(1);
    }

    const header = rows[0];
    const dataRows = rows.slice(1);
    const totalRows = dataRows.length;

    const salesCol = header.findIndex(h => h.trim().toLowerCase() === 'estimated_monthly_sales');
    const followersCol = header.findIndex(h => h.trim().toLowerCase() === 'combined_followers');

    if (salesCol === -1) {
        console.error(clr('red', '❌ Coluna "estimated_monthly_sales" não encontrada.'));
        console.error('   Colunas: ' + header.join(', '));
        process.exit(1);
    }

    console.log(clr('dim', '📊 Total de leads: ') + clr('bold', totalRows.toLocaleString()));
    console.log(clr('dim', '💰 Coluna vendas:  ') + clr('cyan', `idx ${salesCol} — "${header[salesCol]}"`));
    if (followersCol !== -1) {
        console.log(clr('dim', '👥 Coluna seguid.: ') + clr('cyan', `idx ${followersCol} — "${header[followersCol]}"`));
    } else {
        console.log(clr('yellow', '⚠️  Coluna "combined_followers" não encontrada — usando 0 como fallback'));
    }

    // ── Classify & tag each row ──────────────────────
    console.log('\n' + clr('bold', '⚙️  Classificando leads...\n'));
    const startTime = Date.now();

    const tagged = [];
    let stats = { tier0: 0, tier1: 0, tier2: 0 };

    for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        while (row.length < header.length) row.push('');

        const salesRaw = row[salesCol] || '';
        const followersRaw = followersCol !== -1 ? (row[followersCol] || '') : '';
        const { tier, sales, followers } = classifyRow(salesRaw, followersRaw);

        stats[`tier${tier}`]++;
        tagged.push({ row, tier, sales, followers, originalIndex: i });

        if (i % 500 === 0 || i === dataRows.length - 1) {
            drawBar(i + 1, dataRows.length, `${(i + 1).toLocaleString()}/${dataRows.length.toLocaleString()}`);
        }
    }

    console.log('\n');

    // ── Sort ─────────────────────────────────────────
    process.stdout.write(clr('dim', '🔃 Ordenando... '));
    tagged.sort((a, b) => {
        // First: sort by tier (0 → best, 2 → worst)
        if (a.tier !== b.tier) return a.tier - b.tier;

        if (a.tier === 0) {
            // Tier 0: sort by sales DESC
            return b.sales - a.sales;
        }
        if (a.tier === 1) {
            // Tier 1 ($500 placeholder): sort by followers DESC
            return b.followers - a.followers;
        }
        // Tier 2: sort by followers DESC too (best effort)
        return b.followers - a.followers;
    });
    console.log(clr('green', 'OK'));

    // ── Add rank column ──────────────────────────────
    const outputHeader = [...header, 'lead_rank', 'lead_tier', 'lead_score_note'];
    const outputRows = [outputHeader];

    for (let i = 0; i < tagged.length; i++) {
        const { row, tier, sales, followers } = tagged[i];
        const rank = i + 1;

        let tierLabel, note;
        if (tier === 0) {
            tierLabel = 'A - Real Sales';
            note = `sales=${sales.toFixed(2)}`;
        } else if (tier === 1) {
            tierLabel = 'B - No Sales Data ($500)';
            note = `followers=${followers.toLocaleString()}`;
        } else {
            tierLabel = 'C - No Data';
            note = followers > 0 ? `followers=${followers.toLocaleString()}` : 'no data';
        }

        outputRows.push([...row, rank, tierLabel, note]);
    }

    // ── Write output ─────────────────────────────────
    const inputDir = path.dirname(inputPath);
    const inputBase = path.basename(inputPath, path.extname(inputPath));
    const outputDir = path.join(inputDir, 'output_sorted_' + inputBase);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const sortedPath = path.join(outputDir, inputBase + '_sorted.csv');
    const tier0Path = path.join(outputDir, inputBase + '_tier_A_real_sales.csv');
    const tier1Path = path.join(outputDir, inputBase + '_tier_B_no_sales.csv');
    const reportPath = path.join(outputDir, 'relatorio_sort.txt');

    process.stdout.write(clr('dim', '💾 Salvando arquivos... '));

    // Full sorted CSV
    fs.writeFileSync(sortedPath, outputRows.map(toCSVRow).join('\n'), 'utf8');

    // Tier A only (real sales > $500)
    const tier0Rows = outputRows.filter((r, i) => i === 0 || tagged[i - 1]?.tier === 0);
    fs.writeFileSync(tier0Path, tier0Rows.map(toCSVRow).join('\n'), 'utf8');

    // Tier B only ($500 placeholder)
    const tier1Rows = outputRows.filter((r, i) => i === 0 || tagged[i - 1]?.tier === 1);
    fs.writeFileSync(tier1Path, tier1Rows.map(toCSVRow).join('\n'), 'utf8');

    console.log(clr('green', 'OK\n'));

    // ── Report ───────────────────────────────────────
    const elapsed = Date.now() - startTime;
    const throughput = totalRows > 0 ? Math.round(totalRows / (elapsed / 1000)) : 0;
    const now = new Date().toLocaleString('pt-BR');

    // Find top 5 leads for the report
    const top5 = tagged.slice(0, 5).map((t, idx) => {
        const domain = t.row[header.indexOf('domain')] || '(sem domínio)';
        const salesRaw = t.row[salesCol] || '';
        const followersRaw = followersCol !== -1 ? (t.row[followersCol] || '') : '';
        return `  #${idx + 1}  ${domain.padEnd(35)} sales=${salesRaw.padEnd(18)} followers=${followersRaw}`;
    });

    const report = [
        '╔══════════════════════════════════════════════════════════╗',
        '║               RELATÓRIO - LEAD SORTER v1.0              ║',
        '╚══════════════════════════════════════════════════════════╝',
        `Data/Hora       : ${now}`,
        `Arquivo entrada : ${path.basename(inputPath)}`,
        `Tempo total     : ${formatTime(elapsed)}`,
        `Velocidade      : ~${throughput.toLocaleString()} leads/segundo`,
        `Pasta de saída  : ${outputDir}`,
        '',
        '── CRITÉRIO DE ORDENAÇÃO ──────────────────────────────────',
        '  Tier A → estimated_monthly_sales > $500  (ordenado: maior → menor)',
        '  Tier B → estimated_monthly_sales = $500  (placeholder sem dados reais)',
        '           ordenado por: combined_followers (maior → menor)',
        '  Tier C → sem dados de vendas válidos',
        '           ordenado por: combined_followers (maior → menor)',
        '',
        '── COMPOSIÇÃO DA LISTA ────────────────────────────────────',
        `  Tier A (vendas reais)   : ${stats.tier0.toLocaleString().padStart(8)}  (${((stats.tier0 / totalRows) * 100).toFixed(1)}%)`,
        `  Tier B ($500 padrão)    : ${stats.tier1.toLocaleString().padStart(8)}  (${((stats.tier1 / totalRows) * 100).toFixed(1)}%)`,
        `  Tier C (sem dados)      : ${stats.tier2.toLocaleString().padStart(8)}  (${((stats.tier2 / totalRows) * 100).toFixed(1)}%)`,
        `  TOTAL                   : ${totalRows.toLocaleString().padStart(8)}`,
        '',
        '── TOP 5 LEADS ────────────────────────────────────────────',
        ...top5,
        '',
        '── ARQUIVOS GERADOS ───────────────────────────────────────',
        `1. ${path.basename(sortedPath)}`,
        '   → Lista COMPLETA ordenada por potencial (colunas: lead_rank, lead_tier, lead_score_note)',
        `2. ${path.basename(tier0Path)}`,
        '   → Somente Tier A: lojas com vendas reais confirmadas',
        `3. ${path.basename(tier1Path)}`,
        '   → Somente Tier B: sem dados de vendas, ordenado por seguidores',
        '══════════════════════════════════════════════════════════',
    ].join('\n');

    fs.writeFileSync(reportPath, report, 'utf8');

    // ── Console summary ──────────────────────────────
    console.log(clr('green', '✅ CONCLUÍDO!\n'));
    console.log(clr('bold', '── COMPOSIÇÃO ──────────────────────────────────'));
    console.log(clr('green', `   🏆 Tier A (vendas reais)  : ${stats.tier0.toLocaleString()}`) +
        clr('dim', `  (${((stats.tier0 / totalRows) * 100).toFixed(1)}%)`));
    console.log(clr('yellow', `   💛 Tier B ($500 padrão)   : ${stats.tier1.toLocaleString()}`) +
        clr('dim', `  (${((stats.tier1 / totalRows) * 100).toFixed(1)}%)`));
    console.log(clr('dim', `   ⬜ Tier C (sem dados)     : ${stats.tier2.toLocaleString()}`) +
        clr('dim', `  (${((stats.tier2 / totalRows) * 100).toFixed(1)}%)`));
    console.log(clr('bold', '────────────────────────────────────────────────'));
    console.log('\n' + clr('magenta', '📁 Arquivos salvos em:'));
    console.log('   ' + clr('white', outputDir));
    console.log();
}

main();
