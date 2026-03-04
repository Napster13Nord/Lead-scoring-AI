/**
 * ╔══════════════════════════════════════════════╗
 * ║     FINALIZE FOR INSTANTLY  v1.0            ║
 * ║  Corrige emails + exporta CSV para Instantly║
 * ╚══════════════════════════════════════════════╝
 *
 * O que faz:
 *  1. Lê o merged XLSX (output do merge_linkedin.js)
 *  2. Corrige o email: se li_email é de empresa DIFERENTE da loja,
 *     faz fallback para o best_email (email genérico da loja)
 *  3. Gera um CSV limpo pronto para importar no Instantly
 *
 * Colunas do output (padrão Instantly):
 *  email, first_name, last_name, company, website,
 *  job_title, linkedin, monthly_sales, is_personal_email, email_source
 *
 * Uso: node finalize_instantly.js <merged_file.xlsx>
 * Ou arraste no instantly.bat
 */

'use strict';
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// Helpers ────────────────────────────────────────────────
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m',
    red: '\x1b[31m', white: '\x1b[37m', magenta: '\x1b[35m',
};
const clr = (c, t) => C[c] + t + C.reset;

function normalizeDomain(raw) {
    if (!raw) return '';
    let s = String(raw).trim().toLowerCase()
        .replace(/^https?:\/\//, '').replace(/^www\./, '');
    return s.split('/')[0].split('?')[0].split('#')[0];
}

function domainRootWords(domain) {
    let root = domain.replace(/\.(co\.uk|com|net|org|uk|io|co|fr|de|eu|shop|store|edu|gov|info|ltd)$/i, '');
    return root.toLowerCase().split(/[-_.]+/).filter(w => w.length > 2);
}

function domainsRelated(d1, d2) {
    if (!d1 || !d2) return false;
    if (d1 === d2) return true;
    const w1 = new Set(domainRootWords(d1));
    const w2 = new Set(domainRootWords(d2));
    for (const w of w1) { if (w2.has(w)) return true; }
    return false;
}

function isValidEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim());
}

const PERSONAL_PROVIDERS = /gmail|hotmail|yahoo|outlook|icloud|proton|live\.|sky\.com|btinternet|aol\.|virginmedia|me\.com/;

function pickEmail(row) {
    const storeDomain = normalizeDomain(row.domain || row.domain_url || '');
    const liEmail = String(row.li_email || '').trim().toLowerCase();
    const bestEmail = String(row.best_email || '').trim().toLowerCase();

    // No li_email → use best_email
    if (!liEmail || !isValidEmail(liEmail)) {
        return { email: bestEmail, source: 'best_email_fallback', isPersonal: false };
    }

    const liDomain = liEmail.split('@')[1] || '';
    const liDomainNorm = normalizeDomain(liDomain);

    // Personal email (gmail, etc.) → always use it, valid
    if (PERSONAL_PROVIDERS.test(liDomain)) {
        return { email: liEmail, source: 'personal_email', isPersonal: true };
    }

    // Same domain → perfect
    if (normalizeDomain(storeDomain) === liDomainNorm) {
        return { email: liEmail, source: 'li_email_exact_domain', isPersonal: false };
    }

    // Related domain (.com vs .co.uk, trading name) → keep it, likely same company
    if (domainsRelated(storeDomain, liDomainNorm)) {
        return { email: liEmail, source: 'li_email_related_domain', isPersonal: false };
    }

    // Completely different domain → fallback to best_email
    return { email: bestEmail, source: 'best_email_fallback_mismatch', isPersonal: false };
}

function toCSV(rows) {
    if (rows.length === 0) return '';
    const headers = Object.keys(rows[0]);
    const escape = v => {
        const s = String(v ?? '');
        if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
        return s;
    };
    return [
        headers.join(','),
        ...rows.map(r => headers.map(h => escape(r[h])).join(',')),
    ].join('\n');
}

function formatTime(ms) {
    if (ms < 60000) return Math.floor(ms / 1000) + 's';
    return Math.floor(ms / 60000) + 'm' + Math.floor((ms % 60000) / 1000) + 's';
}

// MAIN ───────────────────────────────────────────────────
function main() {
    const args = process.argv.slice(2);
    if (!args[0]) {
        console.error(clr('red', '\n❌ Uso: node finalize_instantly.js <merged_file.xlsx>'));
        process.exit(1);
    }

    const inputPath = path.resolve(args[0]);
    if (!fs.existsSync(inputPath)) {
        console.error(clr('red', `\n❌ Arquivo não encontrado: ${inputPath}`));
        process.exit(1);
    }

    console.log('\n' + clr('cyan', '╔══════════════════════════════════════════════╗'));
    console.log(clr('cyan', '║') + clr('bold', '     FINALIZE FOR INSTANTLY  v1.0            ') + clr('cyan', '║'));
    console.log(clr('cyan', '╚══════════════════════════════════════════════╝'));
    console.log();
    console.log(clr('dim', '📂 Arquivo: ') + path.basename(inputPath));

    process.stdout.write(clr('dim', '⏳ Carregando... '));
    const wb = XLSX.readFile(inputPath);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    console.log(clr('green', 'OK') + clr('dim', ` (${rows.length.toLocaleString()} linhas)`));

    const startTime = Date.now();
    const stats = { personal: 0, liExact: 0, liRelated: 0, fallback: 0, noEmail: 0 };
    const output = [];

    console.log('\n' + clr('bold', '⚙️  Processando...\n'));

    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const { email, source, isPersonal } = pickEmail(r);

        if (!email || !isValidEmail(email)) { stats.noEmail++; continue; }

        // Count stats
        if (source === 'personal_email') stats.personal++;
        else if (source === 'li_email_exact_domain') stats.liExact++;
        else if (source === 'li_email_related_domain') stats.liRelated++;
        else stats.fallback++;

        // Keep ALL original columns + append fixed email columns at the end
        output.push({
            ...r,                                         // every original column
            email_final: email,                     // the fixed/chosen email
            email_source: source,                    // how it was picked
            is_personal_email: isPersonal ? 'yes' : 'no',// gmail/icloud etc?
        });

        if (i % 100 === 0 || i === rows.length - 1) {
            const pct = ((i + 1) / rows.length * 100).toFixed(1);
            const filled = Math.round((i + 1) / rows.length * 30);
            process.stdout.write(`\r${clr('cyan', '[' + '█'.repeat(filled) + '░'.repeat(30 - filled) + ']')} ${clr('bold', pct + '%')} ${clr('dim', `${(i + 1).toLocaleString()}/${rows.length.toLocaleString()}`)}   `);
        }
    }

    console.log('\n');

    // Write output ────────────────────────────────────────
    const inputDir = path.dirname(inputPath);
    const inputBase = path.basename(inputPath, path.extname(inputPath));
    const outCSV = path.join(inputDir, inputBase + '_INSTANTLY_READY.csv');
    const outReport = path.join(inputDir, inputBase + '_instantly_report.txt');

    fs.writeFileSync(outCSV, toCSV(output), 'utf8');

    const elapsed = Date.now() - startTime;
    const total = stats.personal + stats.liExact + stats.liRelated + stats.fallback;

    const report = [
        '╔══════════════════════════════════════════════════════════╗',
        '║         RELATÓRIO - FINALIZE FOR INSTANTLY              ║',
        '╚══════════════════════════════════════════════════════════╝',
        `Data/Hora       : ${new Date().toLocaleString('pt-BR')}`,
        `Arquivo entrada : ${path.basename(inputPath)}`,
        `Tempo           : ${formatTime(elapsed)}`,
        '',
        '── EMAILS USADOS ──────────────────────────────────────────',
        `  📧 Email pessoal (gmail/hotmail...)  : ${stats.personal.toLocaleString().padStart(6)}  (${((stats.personal / total) * 100).toFixed(1)}%)`,
        `  ✅ Email LinkedIn (mesmo domínio)    : ${stats.liExact.toLocaleString().padStart(6)}  (${((stats.liExact / total) * 100).toFixed(1)}%)`,
        `  🟡 Email LinkedIn (domínio similar) : ${stats.liRelated.toLocaleString().padStart(6)}  (${((stats.liRelated / total) * 100).toFixed(1)}%)`,
        `  🔄 Fallback para best_email          : ${stats.fallback.toLocaleString().padStart(6)}  (${((stats.fallback / total) * 100).toFixed(1)}%)`,
        `  ❌ Sem email válido (excluídos)      : ${stats.noEmail.toLocaleString().padStart(6)}`,
        `  ─────────────────────────────────────────────────────────`,
        `  TOTAL NO CSV                         : ${total.toLocaleString().padStart(6)}`,
        '',
        '── ARQUIVO GERADO ─────────────────────────────────────────',
        `  ${path.basename(outCSV)}`,
        '  Colunas: TODAS as originais + email_final, email_source, is_personal_email',
        '  Use a coluna "email_final" como o email para a campanha no Instantly',
        '══════════════════════════════════════════════════════════',
    ].join('\n');

    fs.writeFileSync(outReport, report, 'utf8');

    // Console summary
    console.log(clr('green', '✅ PRONTO PARA O INSTANTLY!\n'));
    console.log(clr('bold', '── EMAILS SELECIONADOS ──────────────────────────'));
    console.log(clr('magenta', `   📧 Pessoal (gmail/icloud)   : ${stats.personal.toLocaleString().padStart(6)}`));
    console.log(clr('green', `   ✅ LinkedIn (mesmo domínio)  : ${stats.liExact.toLocaleString().padStart(6)}`));
    console.log(clr('yellow', `   🟡 LinkedIn (dom. similar)  : ${stats.liRelated.toLocaleString().padStart(6)}`));
    console.log(clr('dim', `   🔄 Fallback best_email       : ${stats.fallback.toLocaleString().padStart(6)}`));
    console.log(clr('bold', `   ──────────────────────────────────────────`));
    console.log(clr('bold', `   TOTAL                        : ${total.toLocaleString().padStart(6)} contatos`));
    console.log('\n' + clr('cyan', '📁 CSV salvo em:'));
    console.log('   ' + clr('white', outCSV));
    console.log();
}

main();
