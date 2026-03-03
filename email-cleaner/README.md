# 📧 Email Cleaner

Script Node.js para selecionar automaticamente o melhor email de cold outreach a partir de uma coluna de emails separados por `:` num arquivo CSV.

## Como usar

1. Instale o [Node.js](https://nodejs.org) se ainda não tiver
2. **Arraste o arquivo `.csv` em cima do `run.bat`** — é só isso

## O que faz

- Lê a coluna `emails` do CSV (emails separados por `:`)
- Seleciona o melhor email com base numa lista de prioridades:
  - `contact`, `info`, `hello`, `support`, `sales`, `marketing`, etc.
  - Descarta: `admin`, `noreply`, `complaints`, `billing`, `abuse`, etc.
- Salva na pasta `output_<nome_do_arquivo>/`:
  - **`_best_emails.csv`** → apenas contatos com email válido (pronto para campanha)
  - **`_full_with_best_email.csv`** → todos os contatos + coluna `best_email`
  - **`relatorio.txt`** → resumo detalhado com breakdown de motivos

## Funcionalidades

- ✅ **Checkpoint / Resume** — salva progresso a cada 50 linhas. Se interromper, retoma de onde parou
- ✅ **Progresso visual** — barra em tempo real com %, contagem, tempo e ETA
- ✅ **Parser CSV robusto** — lida com campos com vírgulas, aspas e quebras de linha
- ✅ **Suporta arquivos grandes** — testado com 80k+ linhas

## Exemplo de seleção

| Emails brutos | Melhor email escolhido |
|---|---|
| `00info@x.com:info@x.com:complaints@x.com` | `info@x.com` |
| `admin@x.com:info@x.com` | `info@x.com` |
| `accounts@x.com:service@x.com:support@x.com` | `support@x.com` |
