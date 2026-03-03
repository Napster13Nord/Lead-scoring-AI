# 📧 Email Cleaner + Lead Sorter

Dois scripts Node.js para preparar listas de cold email. Use-os em sequência:

**Passo 1 →** `run.bat` limpa os emails  
**Passo 2 →** `sort.bat` ordena pelos melhores leads

---

## 🛠️ Scripts

### 1. Email Cleaner (`run.bat`)
Seleciona automaticamente o melhor email de cada linha a partir da coluna `emails` (emails separados por `:`).

**Prioridade de seleção:**
- ✅ Prefixos prioritários: `contact`, `info`, `hello`, `support`, `sales`, `marketing`...
- ❌ Descartados: `admin`, `noreply`, `complaints`, `billing`, `abuse`...

**Output:** pasta `output_<nome>/`
- `_best_emails.csv` → pronto para campanha
- `_full_with_best_email.csv` → todos + coluna `best_email`
- `relatorio.txt` → resumo completo

---

### 2. Lead Sorter (`sort.bat`)
Ordena a lista do **melhor lead para o pior** com base em:
- **Tier A** 🏆 → `estimated_monthly_sales` > $500 → ordenado do maior para o menor
- **Tier B** 💛 → `estimated_monthly_sales` = $500 (placeholder/sem dados reais) → ordenado por `combined_followers` do maior para o menor
- **Tier C** ⬜ → sem dados de vendas → ordenado por `combined_followers`

**Output:** pasta `output_sorted_<nome>/`
- `_sorted.csv` → lista completa ordenada (+ colunas `lead_rank`, `lead_tier`, `lead_score_note`)
- `_tier_A_real_sales.csv` → só lojas com vendas reais confirmadas
- `_tier_B_no_sales.csv` → sem dados de vendas, ordenado por seguidores
- `relatorio_sort.txt` → resumo com top 5

---

## 🚀 Como usar

1. Instale o [Node.js](https://nodejs.org) se ainda não tiver
2. Arraste o `.csv` no `run.bat` → limpa os emails
3. Arraste o CSV gerado no `sort.bat` → ordena por potencial de lead

## ✨ Funcionalidades

- ✅ **Checkpoint / Resume** — salva a cada 50 linhas, retoma se interromper
- ✅ **Progresso visual** — barra em tempo real com %, ETA e velocidade
- ✅ **Parser CSV robusto** — lida com campos com vírgulas, aspas e quebras de linha
- ✅ **Suporta 80k+ linhas**

## 📊 Exemplo (Lead Sorter)

| Rank | Tier | Sales | Followers | Domain |
|---|---|---|---|---|
| 1 | A - Real Sales | USD $216,409.77 | 0 | example.co.uk |
| 2 | A - Real Sales | USD $130,763.78 | 1865 | example2.com |
| ... | | | | |
| 27 | B - No Sales ($500) | USD $500.00 | 1145 | followers-rich.co.uk |
| 28 | B - No Sales ($500) | USD $500.00 | 194 | another.co.uk |
