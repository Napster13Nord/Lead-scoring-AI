# 📧 Email Cleaner + Lead Scoring

Pipeline de 3 passos para preparar listas de **cold email de WooCommerce** — do CSV bruto até a lista final dos melhores leads.

---

## 🗂️ Estrutura

```
email-cleaner/
  bat/              ← Arraste o CSV aqui (os 3 botões do pipeline)
    run.bat         Passo 1 — limpa os emails
    sort.bat        Passo 2 — ordena por vendas
    score.bat       Passo 3 — pontua 0-100 por potencial
  scripts/          ← Lógica em Node.js (não mexer)
    email_cleaner.js
    lead_sorter.js
    lead_scorer.js
  data/             ← Coloque seus CSVs aqui
  output/           ← Resultados gerados automaticamente
```

---

## 🚀 Como usar (ordem)

> Requer [Node.js](https://nodejs.org) instalado.

### 1️⃣ `run.bat` — Email Cleaner
Arraste o CSV → seleciona o **melhor email** de cada linha (coluna `emails` separados por `:`).

**Output:** `output/output_<nome>/`
- `_best_emails.csv` → pronto para seguir para o passo 2
- `_full_with_best_email.csv` → todos os contatos com coluna `best_email`
- `relatorio.txt`

**Prioridade:** `contact` › `info` › `hello` › `support` › `sales` › `marketing` › ...  
**Descartados:** `admin`, `noreply`, `complaints`, `billing`, `abuse` ...

---

### 2️⃣ `sort.bat` — Lead Sorter
Arraste o CSV → ordena do **maior potencial para o menor**.

| Tier | Critério | Ordem |
|---|---|---|
| 🏆 A | `estimated_monthly_sales` > $500 | Maior → menor |
| 💛 B | `estimated_monthly_sales` = $500 (sem dados reais) | Maior `combined_followers` |
| ⬜ C | Sem dados | Maior `combined_followers` |

**Output:** `output/output_sorted_<nome>/`
- `_sorted.csv` + `_tier_A_real_sales.csv` + `_tier_B_no_sales.csv` + `relatorio_sort.txt`

---

### 3️⃣ `score.bat` — Lead Scorer ⭐
Arraste o CSV → atribui um **score 0–100** a cada lead e classifica por grade.

| Fator | Máx |
|---|---|
| `estimated_monthly_sales` no sweet spot $3k–$25k | 40pts |
| `employee_count` 1–5 (dono opera) | 20pts |
| `combined_followers` (audiência ativa) | 20pts |
| `products_sold` (loja ativa) | 10pts |
| `woo_verified = YES` | 10pts |

**Grades:** 🔥 S (≥75) › ✅ A (60) › 👍 B (45) › 🟡 C (30) › ⬜ D (<30)

**Output:** `output/output_scored_<nome>/`
- `_top_leads_S_A.csv` → **sua lista final de campanha**
- `_scored_all.csv` → lista completa com scores
- `relatorio_score.txt`

---

## ✨ Funcionalidades técnicas

- ✅ **Checkpoint / Resume** (email_cleaner) — salva a cada 50 linhas, retoma se interromper
- ✅ **Progresso visual** — barra em tempo real com %, ETA e velocidade
- ✅ **Parser CSV robusto** — lida com campos com vírgulas, aspas, quebras de linha
- ✅ **Suporta 80k+ linhas**
