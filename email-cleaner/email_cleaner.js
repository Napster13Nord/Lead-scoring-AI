/**
 * ╔══════════════════════════════════════════════╗
 * ║        EMAIL CLEANER  v2.0                  ║
 * ║  • CSV parser robusto (campos com vírgulas) ║
 * ║  • Checkpoint / Resume automático           ║
 * ║  • Progresso visual em tempo real           ║
 * ║  • Relatório detalhado ao final             ║
 * ╚══════════════════════════════════════════════╝
 *
 * Uso: node email_cleaner.js <arquivo.csv>
 */

'use strict';
const fs = require('fs');
const path = require('path');

// ── Checkpoint: quantas linhas salvar por batch ──
const BATCH_SIZE = 50;

// ── Cores ANSI ────────────────────────────────────
const C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    cyan: '\x1b[36m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    white: '\x1b[37m',
    bgBlue: '\x1b[44m',
};
const clr = (color, txt) => C[color] + txt + C.reset;

// ── Priority list: lower index = higher preference ──
const PRIORITY_PREFIXES = [
    'contact', 'info', 'hello', 'hi', 'hey', 'support', 'help',
    'sales', 'marketing', 'enquiries', 'enquiry', 'inquiries', 'inquiry',
    'business', 'partnerships', 'partner', 'press', 'media', 'general',
    'office', 'team', 'mail', 'post', 'studio', 'shop', 'store',
    'orders', 'service', 'services',
];

// ── Deprioritised prefixes ────────────────────────
const DEPRIORITISED_PREFIXES = [
    'admin', 'administrator', 'webmaster', 'noreply', 'no-reply',
    'donotreply', 'do-not-reply', 'unsubscribe', 'bounce', 'mailer',
    'postmaster', 'hostmaster', 'abuse', 'spam', 'root',
    'errors', 'error', 'notifications', 'notification', 'alert', 'alerts',
    'billing', 'invoice', 'invoices', 'accounts', 'accounting',
    'finance', 'it', 'tech', 'technical', 'dev', 'developer',
    'jobs', 'careers', 'recruitment', 'hr', 'humanresources',
    'legal', 'compliance', 'privacy', 'gdpr', 'security',
    'warehouse', 'logistics', 'dispatch', 'delivery', 'returns',
    'refunds', 'complaints',
];

// ════════════════════════════════════════════════════════
// CSV PARSER  (handles quoted fields with commas/newlines)
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
        if (row.length > 0 && !(row.length === 1 && row[0] === '')) {
            rows.push(row);
        }
    }
    return rows;
}

// ════════════════════════════════════════════════
// CSV WRITER
// ════════════════════════════════════════════════
function toCSVRow(fields) {
    return fields.map(f => {
        const s = String(f ?? '');
        if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
            return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
    }).join(',');
}

// ════════════════════════════════════════════════
// EMAIL HELPERS
// ════════════════════════════════════════════════
function isValidEmail(str) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(str.trim());
}

function pickBestEmail(rawEmails) {
    if (!rawEmails || rawEmails.trim() === '') return { email: '', reason: 'no_emails' };

    const all = rawEmails
        .split(':')
        .map(e => e.trim().toLowerCase())
        .filter(isValidEmail);

    const unique = [...new Set(all)];

    if (unique.length === 0) return { email: '', reason: 'no_valid_emails' };
    if (unique.length === 1) return { email: unique[0], reason: 'only_one' };

    for (const prefix of PRIORITY_PREFIXES) {
        const match = unique.find(e => e.startsWith(prefix + '@'));
        if (match) return { email: match, reason: `priority:${prefix}` };
    }

    const neutral = unique.filter(e => {
        const lp = e.split('@')[0];
        return !DEPRIORITISED_PREFIXES.some(d => lp === d || lp.startsWith(d + '.'));
    });

    if (neutral.length > 0) return { email: neutral[0], reason: 'neutral' };

    const hardBlocked = ['noreply', 'no-reply', 'donotreply', 'do-not-reply', 'bounce', 'mailer', 'postmaster', 'abuse', 'spam'];
    const softDeprio = unique.filter(e => {
        const lp = e.split('@')[0];
        return !hardBlocked.some(h => lp === h || lp.startsWith(h + '.'));
    });

    if (softDeprio.length > 0) return { email: softDeprio[0], reason: 'deprioritised' };
    return { email: unique[0], reason: 'last_resort' };
}

// ════════════════════════════════════════════════
// PROGRESS BAR
// ════════════════════════════════════════════════
function formatTime(ms) {
    if (ms < 60000) return Math.floor(ms / 1000) + 's';
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}m${s}s`;
}

function drawProgress(current, total, startTime, found, noEmail) {
    const now = Date.now();
    const elapsed = now - startTime;
    const pct = total > 0 ? current / total : 0;
    const barWidth = 30;
    const filled = Math.round(pct * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

    let eta = '';
    if (current > 0 && pct < 1) {
        const msLeft = (elapsed / current) * (total - current);
        eta = ' ETA ' + formatTime(msLeft);
    }

    const pctStr = (pct * 100).toFixed(1).padStart(5) + '%';
    const line = [
        clr('cyan', `[${bar}]`),
        clr('bold', pctStr),
        clr('dim', `${current.toLocaleString()}/${total.toLocaleString()}`),
        clr('green', `✓${found.toLocaleString()}`),
        clr('yellow', `✗${noEmail.toLocaleString()}`),
        clr('dim', elapsed > 0 ? formatTime(elapsed) + ' elapsed' + eta : ''),
    ].join('  ');

    process.stdout.write('\r' + line + '   ');
}

// ════════════════════════════════════════════════
// CHECKPOINT SYSTEM
// ════════════════════════════════════════════════
function checkpointPath(outputDir, inputBase) {
    return path.join(outputDir, '.' + inputBase + '.checkpoint.json');
}

function loadCheckpoint(cpPath) {
    try {
        if (fs.existsSync(cpPath)) {
            const data = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
            return data;
        }
    } catch (e) { /* ignore corrupt checkpoint */ }
    return null;
}

function saveCheckpoint(cpPath, data) {
    fs.writeFileSync(cpPath, JSON.stringify(data, null, 2), 'utf8');
}

function deleteCheckpoint(cpPath) {
    try { fs.unlinkSync(cpPath); } catch (e) { }
}

// ════════════════════════════════════════════════
// APPEND BATCH TO FILE
// (efficient: we append directly without rewriting)
// ════════════════════════════════════════════════
function appendBatchToFile(filePath, rows, isFirst) {
    const content = rows.map(toCSVRow).join('\n') + '\n';
    if (isFirst) {
        fs.writeFileSync(filePath, content, 'utf8');
    } else {
        fs.appendFileSync(filePath, content, 'utf8');
    }
}

// ════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════
function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error(clr('red', '\n❌ Uso: node email_cleaner.js <arquivo.csv>'));
        console.error('   Ou arraste o CSV para o arquivo run.bat\n');
        process.exit(1);
    }

    const inputPath = path.resolve(args[0]);
    if (!fs.existsSync(inputPath)) {
        console.error(clr('red', `\n❌ Arquivo não encontrado: ${inputPath}\n`));
        process.exit(1);
    }

    // ── Header banner ──────────────────────────────
    console.log('\n' + clr('cyan', '╔══════════════════════════════════════════════╗'));
    console.log(clr('cyan', '║') + clr('bold', '        EMAIL CLEANER  v2.0                  ') + clr('cyan', '║'));
    console.log(clr('cyan', '╚══════════════════════════════════════════════╝'));
    console.log();
    console.log(clr('dim', '📂 Arquivo: ') + clr('white', path.basename(inputPath)));

    // ── Read & parse CSV ───────────────────────────
    process.stdout.write(clr('dim', '⏳ Carregando CSV... '));
    const rawContent = fs.readFileSync(inputPath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const rows = parseCSV(rawContent);
    console.log(clr('green', 'OK'));

    if (rows.length < 2) {
        console.error(clr('red', '❌ CSV vazio ou sem dados.'));
        process.exit(1);
    }

    const header = rows[0];
    const emailColIndex = header.findIndex(h => h.trim().toLowerCase() === 'emails');
    if (emailColIndex === -1) {
        console.error(clr('red', '❌ Coluna "emails" não encontrada.'));
        console.error('   Colunas disponíveis: ' + header.join(', '));
        process.exit(1);
    }

    const totalData = rows.length - 1;
    console.log(clr('dim', '📊 Total de contatos: ') + clr('bold', totalData.toLocaleString()));
    console.log(clr('dim', '📧 Coluna emails: ') + clr('cyan', `índice ${emailColIndex} ("${header[emailColIndex]}")`));

    // ── Setup output dir ───────────────────────────
    const inputDir = path.dirname(inputPath);
    const inputBase = path.basename(inputPath, path.extname(inputPath));
    const outputDir = path.join(inputDir, 'output_' + inputBase);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const filteredPath = path.join(outputDir, inputBase + '_best_emails.csv');
    const fullPath = path.join(outputDir, inputBase + '_full_with_best_email.csv');
    const reportPath = path.join(outputDir, 'relatorio.txt');
    const cpPath = checkpointPath(outputDir, inputBase);

    // ── New output header ──────────────────────────
    const outputHeader = [...header, 'best_email', 'email_pick_reason'];

    // ── Check for existing checkpoint ───────────────
    const cp = loadCheckpoint(cpPath);
    let startRow = 1;  // index into `rows` (1 = first data row)
    let stats = {
        total: 0, withEmail: 0, noEmail: 0,
        singleEmail: 0, multiEmail: 0, reasons: {}
    };

    if (cp) {
        console.log('\n' + clr('yellow', '⚡ Checkpoint encontrado!'));
        console.log(clr('dim', `   Processadas até agora: `) + clr('bold', cp.processedRows.toLocaleString()) + clr('dim', ` de ${totalData.toLocaleString()}`));
        console.log(clr('dim', `   Retomando do contato #`) + clr('bold', (cp.processedRows + 1).toLocaleString()));
        startRow = cp.processedRows + 1;
        stats = cp.stats;
    } else {
        console.log();
        // Write headers to fresh output files
        appendBatchToFile(filteredPath, [outputHeader], true);
        appendBatchToFile(fullPath, [outputHeader], true);
    }

    // ── Process ────────────────────────────────────
    console.log('\n' + clr('bold', '⚙️  Processando...\n'));

    const startTime = Date.now() - (cp ? (cp.elapsedMs || 0) : 0);
    let batchFiltered = [];
    let batchFull = [];
    let totalElapsedMs = cp ? (cp.elapsedMs || 0) : 0;

    for (let i = startRow; i < rows.length; i++) {
        const row = [...rows[i]];
        while (row.length < header.length) row.push('');

        const rawEmails = row[emailColIndex] || '';
        const { email, reason } = pickBestEmail(rawEmails);
        const emailCount = rawEmails ? rawEmails.split(':').filter(isValidEmail).length : 0;

        stats.total++;
        if (email) stats.withEmail++; else stats.noEmail++;
        if (emailCount === 1) stats.singleEmail++;
        if (emailCount > 1) stats.multiEmail++;
        stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;

        const outRow = [...row, email, reason];
        batchFull.push(outRow);
        if (email) batchFiltered.push(outRow);

        // Draw progress every row
        drawProgress(stats.total, totalData, startTime, stats.withEmail, stats.noEmail);

        // ── Flush batch every BATCH_SIZE rows ──
        if (stats.total % BATCH_SIZE === 0 || i === rows.length - 1) {
            // Append to files
            if (batchFull.length) appendBatchToFile(fullPath, batchFull, false);
            if (batchFiltered.length) appendBatchToFile(filteredPath, batchFiltered, false);

            // Save checkpoint
            totalElapsedMs = Date.now() - startTime;
            saveCheckpoint(cpPath, {
                processedRows: stats.total,
                totalRows: totalData,
                elapsedMs: totalElapsedMs,
                stats,
                inputPath,
                timestamp: new Date().toISOString(),
            });

            batchFull = [];
            batchFiltered = [];
        }
    }

    // ── Done! ──────────────────────────────────────
    console.log('\n');

    // Delete checkpoint since we're done
    deleteCheckpoint(cpPath);

    // ── Write report ───────────────────────────────
    const elapsed = Date.now() - startTime;
    const now = new Date().toLocaleString('pt-BR');
    const throughput = totalData > 0 ? Math.round(totalData / (elapsed / 1000)) : 0;

    const breakdownLines = Object.entries(stats.reasons)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => {
            const bar = '▓'.repeat(Math.round((count / stats.total) * 20));
            const pct = ((count / stats.total) * 100).toFixed(1);
            return `  ${reason.padEnd(30)} : ${String(count).padStart(6)}  (${pct}%)  ${bar}`;
        });

    const report = [
        '╔══════════════════════════════════════════════════════════╗',
        '║               RELATÓRIO - EMAIL CLEANER v2.0            ║',
        '╚══════════════════════════════════════════════════════════╝',
        `Data/Hora       : ${now}`,
        `Arquivo entrada : ${path.basename(inputPath)}`,
        `Tempo total     : ${formatTime(elapsed)}`,
        `Velocidade      : ~${throughput.toLocaleString()} contatos/segundo`,
        `Pasta de saída  : ${outputDir}`,
        '',
        '── RESUMO GERAL ───────────────────────────────────────────',
        `Total processados          : ${stats.total.toLocaleString()}`,
        `Com email válido           : ${stats.withEmail.toLocaleString()}  (${((stats.withEmail / stats.total) * 100).toFixed(1)}%)`,
        `Sem nenhum email válido    : ${stats.noEmail.toLocaleString()}  (${((stats.noEmail / stats.total) * 100).toFixed(1)}%)`,
        '',
        '── EMAILS ─────────────────────────────────────────────────',
        `Contatos com 1 email       : ${stats.singleEmail.toLocaleString()}`,
        `Contatos com múltiplos     : ${stats.multiEmail.toLocaleString()}`,
        '',
        '── MOTIVO DA ESCOLHA ──────────────────────────────────────',
        ...breakdownLines,
        '',
        '── ARQUIVOS GERADOS ───────────────────────────────────────',
        `1. ${path.basename(filteredPath)}`,
        '   → Somente linhas COM email válido (pronto para campanha)',
        `2. ${path.basename(fullPath)}`,
        '   → Todos os contatos + coluna "best_email" adicionada',
        '══════════════════════════════════════════════════════════',
    ].join('\n');

    fs.writeFileSync(reportPath, report, 'utf8');

    // Print final summary to console
    console.log(clr('green', '✅ CONCLUÍDO!\n'));
    console.log(clr('bold', '── RESUMO ──────────────────────────────────'));
    console.log(clr('green', `   ✓ Com email  : ${stats.withEmail.toLocaleString()}`) +
        clr('dim', `  (${((stats.withEmail / stats.total) * 100).toFixed(1)}%)`));
    console.log(clr('yellow', `   ✗ Sem email  : ${stats.noEmail.toLocaleString()}`) +
        clr('dim', `  (${((stats.noEmail / stats.total) * 100).toFixed(1)}%)`));
    console.log(clr('dim', `   ⏱ Tempo      : ${formatTime(elapsed)}`));
    console.log(clr('dim', `   ⚡ Velocidade : ~${throughput.toLocaleString()} contatos/s`));
    console.log(clr('bold', '────────────────────────────────────────────'));
    console.log('\n' + clr('cyan', '📁 Arquivos salvos em:'));
    console.log('   ' + clr('white', outputDir));
    console.log();
}

main();
