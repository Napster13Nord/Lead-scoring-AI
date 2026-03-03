/**
 * ╔══════════════════════════════════════════════╗
 * ║       LEAD SCORER  v1.0                     ║
 * ║  Score 0-100 para email automation leads    ║
 * ║  Oferta: WooCommerce email flows €300-700   ║
 * ╚══════════════════════════════════════════════╝
 *
 * Critérios de score (total 100 pts):
 *  - estimated_monthly_sales no sweet spot $1k-$50k  → até 40pts
 *  - employee_count 1-10 (dono opera, decide rápido)  → até 20pts
 *  - combined_followers (loja ativa)                  → até 20pts
 *  - products_sold (realmente vende)                  → até 10pts
 *  - woo_verified = YES (confirmado WooCommerce)      → 10pts
 *
 * Uso: node lead_scorer.js <arquivo.csv>
 */

'use strict';
const fs = require('fs');
const path = require('path');

// ── Cores ANSI ─────────────────────────────────────────
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m',
    red: '\x1b[31m', white: '\x1b[37m', magenta: '\x1b[35m', blue: '\x1b[34m',
};
const clr = (color, txt) => C[color] + txt + C.reset;

// ── Sales sweet spot boundaries ────────────────────────
const SWEET_MIN = 1000;   // $1k  — mínimo para a oferta fazer sentido
const SWEET_CORE_MIN = 3000;  // $3k  — core sweet spot começa
const SWEET_CORE_MAX = 25000; // $25k — core sweet spot termina
const SWEET_MAX = 50000;  // $50k — máximo antes de ser grande demais
const PLACEHOLDER = 500;    // $500 — valor padrão "sem dados reais"

// ════════════════════════════════════════════════════════
// CSV PARSER
// ════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════
// VALUE PARSERS
// ════════════════════════════════════════════════════════
function parseSales(raw) {
    if (!raw || raw.trim() === '') return NaN;
    const cleaned = raw.replace(/[^0-9.,]/g, '').replace(/,/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? NaN : num;
}
function parseNum(raw, fallback = 0) {
    if (!raw || raw.trim() === '') return fallback;
    const n = parseFloat(raw.replace(/[^0-9.]/g, ''));
    return isNaN(n) ? fallback : n;
}

// ════════════════════════════════════════════════════════
// SCORING LOGIC
// ════════════════════════════════════════════════════════
function scoreRow(row, colIdx) {
    const {
        salesCol, followersCol, employeeCol,
        productsCol, wooVerifiedCol
    } = colIdx;

    const salesRaw = row[salesCol] || '';
    const followers = parseNum(row[followersCol] || '');
    const employees = parseNum(row[employeeCol] || '', NaN);
    const products = parseNum(row[productsCol] || '');
    const wooVerified = (row[wooVerifiedCol] || '').trim().toUpperCase();

    const sales = parseSales(salesRaw);
    const isPlaceholder = !isNaN(sales) && Math.abs(sales - PLACEHOLDER) < 0.01;
    const hasRealSales = !isNaN(sales) && !isPlaceholder;

    const breakdown = {};
    let total = 0;

    // ── 1. SALES SCORE (max 40pts) ────────────────────────
    let salesScore = 0;
    let salesLabel = '';

    if (isPlaceholder) {
        // No real sales data — partial score, rely on followers
        salesScore = 12;
        salesLabel = 'sem_dados_vendas';
    } else if (isNaN(sales) || sales === 0) {
        salesScore = 0;
        salesLabel = 'sem_valor';
    } else if (sales >= SWEET_CORE_MIN && sales <= SWEET_CORE_MAX) {
        // Perfect sweet spot: $3k–$25k
        salesScore = 40;
        salesLabel = 'sweet_spot_ideal';
    } else if (sales >= SWEET_MIN && sales < SWEET_CORE_MIN) {
        // Smaller but viable: $1k–$3k
        salesScore = 28;
        salesLabel = 'sweet_spot_pequeno';
    } else if (sales > SWEET_CORE_MAX && sales <= SWEET_MAX) {
        // Bigger but still okay: $25k–$50k
        salesScore = 22;
        salesLabel = 'sweet_spot_grande';
    } else if (sales > SWEET_MAX) {
        // Too big — ROI pitch works but harder to close cold
        salesScore = 8;
        salesLabel = 'muito_grande';
    } else if (sales < SWEET_MIN && sales > 0) {
        // Too small — hard to justify the fee
        salesScore = 5;
        salesLabel = 'muito_pequeno';
    }

    breakdown.sales = salesScore;
    total += salesScore;

    // ── 2. EMPLOYEE COUNT SCORE (max 20pts) ───────────────
    // 1-5: owner-operated, quickest decision → 20pts
    // 6-10: small team, still nimble → 15pts
    // 11-25: medium, longer decision → 8pts
    // 26+: too corporate → 2pts
    // unknown: neutral 8pts
    let empScore = 0;
    if (isNaN(employees)) {
        empScore = 8; // unknown — neutral
        breakdown.employees = empScore;
        breakdown.employees_label = 'desconhecido';
    } else if (employees >= 1 && employees <= 5) {
        empScore = 20;
        breakdown.employees_label = '1-5_ideal';
    } else if (employees <= 10) {
        empScore = 15;
        breakdown.employees_label = '6-10_bom';
    } else if (employees <= 25) {
        empScore = 8;
        breakdown.employees_label = '11-25_ok';
    } else {
        empScore = 2;
        breakdown.employees_label = '26+_grande';
    }
    breakdown.employees = empScore;
    total += empScore;

    // ── 3. FOLLOWERS SCORE (max 20pts) ────────────────────
    // Shows the store has an audience worth marketing to
    let follScore = 0;
    if (followers >= 10000) { follScore = 20; }
    else if (followers >= 5000) { follScore = 17; }
    else if (followers >= 2000) { follScore = 14; }
    else if (followers >= 1000) { follScore = 11; }
    else if (followers >= 500) { follScore = 8; }
    else if (followers >= 200) { follScore = 5; }
    else if (followers >= 50) { follScore = 2; }
    else { follScore = 0; }
    breakdown.followers = follScore;
    total += follScore;

    // ── 4. PRODUCTS SOLD SCORE (max 10pts) ────────────────
    // Confirms this is an active store that sells things
    let prodScore = 0;
    if (products >= 100) { prodScore = 10; }
    else if (products >= 50) { prodScore = 8; }
    else if (products >= 10) { prodScore = 6; }
    else if (products > 0) { prodScore = 4; }
    else { prodScore = 0; }
    breakdown.products = prodScore;
    total += prodScore;

    // ── 5. WOO VERIFIED BONUS (max 10pts) ─────────────────
    // woo_verified = YES means we've confirmed it's running WooCommerce
    let wooScore = 0;
    if (wooVerified === 'YES' || wooVerified === 'TRUE' || wooVerified === '1') {
        wooScore = 10;
    } else if (wooVerified === '' || wooVerified === 'UNKNOWN') {
        wooScore = 5; // assume WooCommerce since that's the list
    } else {
        wooScore = 0;
    }
    breakdown.woo_verified = wooScore;
    total += wooScore;

    // ── Build grade label ──────────────────────────────────
    let grade, gradeLabel;
    if (total >= 75) { grade = 'S'; gradeLabel = '🔥 S - Top Lead'; }
    else if (total >= 60) { grade = 'A'; gradeLabel = '✅ A - Ótimo'; }
    else if (total >= 45) { grade = 'B'; gradeLabel = '👍 B - Bom'; }
    else if (total >= 30) { grade = 'C'; gradeLabel = '🟡 C - Médio'; }
    else { grade = 'D'; gradeLabel = '⬜ D - Fraco'; }

    return {
        score: Math.min(100, total),
        grade,
        gradeLabel,
        salesLabel,
        breakdown,
    };
}

// ════════════════════════════════════════════════════════
// PROGRESS BAR
// ════════════════════════════════════════════════════════
function formatTime(ms) {
    if (ms < 60000) return Math.floor(ms / 1000) + 's';
    return Math.floor(ms / 60000) + 'm' + Math.floor((ms % 60000) / 1000) + 's';
}
function drawBar(current, total, startTime) {
    const pct = total > 0 ? current / total : 0;
    const filled = Math.round(pct * 30);
    const bar = '█'.repeat(filled) + '░'.repeat(30 - filled);
    const eta = current > 0 && pct < 1
        ? ' ETA ' + formatTime(((Date.now() - startTime) / current) * (total - current))
        : '';
    process.stdout.write(`\r${clr('cyan', `[${bar}]`)} ${clr('bold', (pct * 100).toFixed(1) + '%')} ${clr('dim', `${current.toLocaleString()}/${total.toLocaleString()}${eta}`)}   `);
}

// ════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════
function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error(clr('red', '\n❌ Uso: node lead_scorer.js <arquivo.csv>'));
        console.error('   Ou arraste o CSV para o score.bat\n');
        process.exit(1);
    }

    const inputPath = path.resolve(args[0]);
    if (!fs.existsSync(inputPath)) {
        console.error(clr('red', `\n❌ Arquivo não encontrado: ${inputPath}\n`));
        process.exit(1);
    }

    console.log('\n' + clr('blue', '╔══════════════════════════════════════════════╗'));
    console.log(clr('blue', '║') + clr('bold', '         LEAD SCORER  v1.0                   ') + clr('blue', '║'));
    console.log(clr('blue', '╚══════════════════════════════════════════════╝'));
    console.log();
    console.log(clr('dim', '📂 Arquivo: ') + clr('white', path.basename(inputPath)));

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
    const total = dataRows.length;

    // Locate columns (case-insensitive)
    const findCol = name => header.findIndex(h => h.trim().toLowerCase() === name.toLowerCase());

    const colIdx = {
        salesCol: findCol('estimated_monthly_sales'),
        followersCol: findCol('combined_followers'),
        employeeCol: findCol('employee_count'),
        productsCol: findCol('products_sold'),
        wooVerifiedCol: findCol('woo_verified'),
    };

    // Report which cols were found
    const colReport = Object.entries(colIdx).map(([k, v]) =>
        `${k.replace('Col', '').padEnd(15)}: ${v === -1 ? clr('yellow', 'não encontrado') : clr('green', `idx ${v}`)}`
    ).join('\n  ');
    console.log(clr('dim', '\n📋 Colunas detectadas:\n  ') + colReport);
    console.log(clr('dim', '\n📊 Total de leads: ') + clr('bold', total.toLocaleString()));
    console.log('\n' + clr('bold', '⚙️  Calculando scores...\n'));

    const startTime = Date.now();
    const gradeStats = { S: 0, A: 0, B: 0, C: 0, D: 0 };
    const scored = [];

    for (let i = 0; i < dataRows.length; i++) {
        const row = [...dataRows[i]];
        while (row.length < header.length) row.push('');

        const result = scoreRow(row, colIdx);
        gradeStats[result.grade]++;
        scored.push({ row, ...result });

        if (i % 200 === 0 || i === dataRows.length - 1) {
            drawBar(i + 1, dataRows.length, startTime);
        }
    }

    console.log('\n');

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Build output rows
    const newCols = ['lead_score', 'lead_grade', 'lead_grade_label', 'score_sales', 'score_employees', 'score_followers', 'score_products', 'score_woo'];
    const outputHeader = [...header, ...newCols];
    const outputRows = [outputHeader];

    for (const s of scored) {
        outputRows.push([
            ...s.row,
            s.score,
            s.grade,
            s.gradeLabel.replace(/[🔥✅👍🟡⬜]/g, '').trim(),
            s.breakdown.sales || 0,
            s.breakdown.employees || 0,
            s.breakdown.followers || 0,
            s.breakdown.products || 0,
            s.breakdown.woo_verified || 0,
        ]);
    }

    // ── Write outputs ─────────────────────────────────────
    const inputDir = path.dirname(inputPath);
    const inputBase = path.basename(inputPath, path.extname(inputPath));
    const outputDir = path.join(inputDir, 'output_scored_' + inputBase);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const allPath = path.join(outputDir, inputBase + '_scored_all.csv');
    const topPath = path.join(outputDir, inputBase + '_top_leads_S_A.csv');
    const reportPath = path.join(outputDir, 'relatorio_score.txt');

    // Full sorted list
    fs.writeFileSync(allPath, outputRows.map(toCSVRow).join('\n'), 'utf8');

    // Top leads: Grade S and A only
    const topRows = outputRows.filter((r, i) => i === 0 || ['S', 'A'].includes(scored[i - 1]?.grade));
    fs.writeFileSync(topPath, topRows.map(toCSVRow).join('\n'), 'utf8');

    // ── Report ────────────────────────────────────────────
    const elapsed = Date.now() - startTime;
    const now = new Date().toLocaleString('pt-BR');
    const top10 = scored.slice(0, 10).map((s, i) => {
        const domain = s.row[findCol('domain')] || '(sem domínio)';
        const sales = s.row[colIdx.salesCol] || '';
        const followers = s.row[colIdx.followersCol] || '0';
        return `  #${String(i + 1).padEnd(3)} [${s.grade}] ${String(s.score).padEnd(4)} pts  ${domain.padEnd(35)} ${sales.substring(0, 20).padEnd(22)} followers: ${followers}`;
    });

    const report = [
        '╔══════════════════════════════════════════════════════════╗',
        '║               RELATÓRIO - LEAD SCORER v1.0              ║',
        '╚══════════════════════════════════════════════════════════╝',
        `Data/Hora       : ${now}`,
        `Arquivo entrada : ${path.basename(inputPath)}`,
        `Tempo total     : ${formatTime(elapsed)}`,
        `Pasta de saída  : ${outputDir}`,
        '',
        '── CRITÉRIO DE SCORE (max 100pts) ─────────────────────────',
        '  Sales $3k–$25k (sweet spot ideal)       : até 40pts',
        '  Sales $1k–$3k ou $25k–$50k (bordas)     : 22-28pts',
        '  Employee count 1-5 (dono opera)          : até 20pts',
        '  Combined followers (audiência ativa)     : até 20pts',
        '  Products sold (loja ativa)               : até 10pts',
        '  Woo verified = YES                       : até 10pts',
        '',
        '── DISTRIBUIÇÃO POR GRADE ─────────────────────────────────',
        `  🔥 S (≥75pts) - Top Lead    : ${String(gradeStats.S).padStart(6)} leads  (${((gradeStats.S / total) * 100).toFixed(1)}%)`,
        `  ✅ A (60-74)  - Ótimo       : ${String(gradeStats.A).padStart(6)} leads  (${((gradeStats.A / total) * 100).toFixed(1)}%)`,
        `  👍 B (45-59)  - Bom         : ${String(gradeStats.B).padStart(6)} leads  (${((gradeStats.B / total) * 100).toFixed(1)}%)`,
        `  🟡 C (30-44)  - Médio       : ${String(gradeStats.C).padStart(6)} leads  (${((gradeStats.C / total) * 100).toFixed(1)}%)`,
        `  ⬜ D (<30)    - Fraco       : ${String(gradeStats.D).padStart(6)} leads  (${((gradeStats.D / total) * 100).toFixed(1)}%)`,
        `  TOTAL                       : ${String(total).padStart(6)} leads`,
        '',
        '── TOP 10 LEADS ───────────────────────────────────────────',
        ...top10,
        '',
        '── ARQUIVOS GERADOS ───────────────────────────────────────',
        `1. ${path.basename(topPath)}`,
        '   → Apenas Grade S e A: seus melhores leads para a campanha',
        `2. ${path.basename(allPath)}`,
        '   → Lista completa ordenada por score (colunas: lead_score, lead_grade...)',
        '══════════════════════════════════════════════════════════',
    ].join('\n');

    fs.writeFileSync(reportPath, report, 'utf8');

    // ── Console summary ───────────────────────────────────
    console.log(clr('green', '✅ CONCLUÍDO!\n'));
    console.log(clr('bold', '── DISTRIBUIÇÃO DE GRADES ───────────────────────'));
    console.log(clr('red', `   🔥 S - Top Lead   : ${gradeStats.S.toLocaleString().padStart(7)}`) + clr('dim', `  (${((gradeStats.S / total) * 100).toFixed(1)}%)`));
    console.log(clr('green', `   ✅ A - Ótimo      : ${gradeStats.A.toLocaleString().padStart(7)}`) + clr('dim', `  (${((gradeStats.A / total) * 100).toFixed(1)}%)`));
    console.log(clr('cyan', `   👍 B - Bom        : ${gradeStats.B.toLocaleString().padStart(7)}`) + clr('dim', `  (${((gradeStats.B / total) * 100).toFixed(1)}%)`));
    console.log(clr('yellow', `   🟡 C - Médio      : ${gradeStats.C.toLocaleString().padStart(7)}`) + clr('dim', `  (${((gradeStats.C / total) * 100).toFixed(1)}%)`));
    console.log(clr('dim', `   ⬜ D - Fraco      : ${gradeStats.D.toLocaleString().padStart(7)}`) + clr('dim', `  (${((gradeStats.D / total) * 100).toFixed(1)}%)`));
    console.log(clr('bold', '────────────────────────────────────────────────'));
    console.log(clr('dim', `\n   S+A prontos para campanha: `) + clr('bold', (gradeStats.S + gradeStats.A).toLocaleString()) + clr('dim', ' leads'));
    console.log('\n' + clr('blue', '📁 Arquivos salvos em:'));
    console.log('   ' + clr('white', outputDir));
    console.log();
}

main();
