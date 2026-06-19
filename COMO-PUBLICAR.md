# 🚀 Publicar os apps (mono-repo `apps`) — Nível 2

Resultado: um **link** — `https://ednaldohenper.github.io/apps/instagram/` — que você abre no celular, digita **uma senha** e vê tudo. Um robô atualiza os dados **sozinho todo dia** e **renova o token sozinho**. O token nunca fica no celular. Apps futuros entram como novas pastas (`apps/financeiro/`, etc.).

## Estrutura do repositório
```
apps/                              (público, GitHub Pages ligado)
├── index.html                     ← portal (menu dos sistemas)
├── instagram/
│   ├── index.html                 ← painel
│   └── data.enc                   ← dados cifrados (criados pelo robô)
├── scripts/
│   └── instagram-fetch.mjs        ← robô do Instagram
├── .github/workflows/
│   └── instagram-daily.yml        ← agenda diária
└── .secrets/
    └── instagram-token.enc        ← token cifrado (criado pelo robô)
```

## Passo 1 — Token novo de 60 dias
1. [Graph API Explorer](https://developers.facebook.com/tools/explorer) → app **App_Social_Med_ia** → permissões `instagram_basic`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement` → **Generate Access Token** (Página + Instagram).
2. [Depurador de Token](https://developers.facebook.com/tools/debug/accesstoken) → cole → **Extend Access Token** → copie o token de 60 dias.

## Passo 2 — Secrets (cofre)
Repositório `apps` → **Settings → Secrets and variables → Actions → New repository secret**:

| Nome | Valor |
|---|---|
| `IG_ID` | `17841404877753330` |
| `IG_TOKEN` | (token de 60 dias do Passo 1) |
| `DASH_PASSWORD` | **senha forte** (abre o painel e cifra os dados) — 12+ caracteres |
| `FB_APP_ID` | `2395800074242647` |
| `FB_APP_SECRET` | (Chave Secreta do app — *Meta → Configurações → Básico*) |

> Convenção de nomes: prefixe por app (`IG_…`). O próximo app usa o seu prefixo (`FIN_…`), sem conflito.

## Passo 3 — Rodar o robô uma vez
Aba **Actions** → **Instagram Daily** → **Run workflow**. Em ~1 min cria `instagram/data.enc`. Depois roda sozinho toda madrugada (06:00 BRT).

## Passo 4 — Ligar o GitHub Pages
**Settings → Pages** → Source: **Deploy from a branch** → Branch **main** / **/(root)** → Save.

## Passo 5 — Abrir no celular
`https://ednaldohenper.github.io/apps/instagram/` → digite a `DASH_PASSWORD`.
- iPhone (Safari) / Android (Chrome): menu → **Adicionar à Tela de Início** → vira um ícone, igual a um app.
- O portal geral fica em `https://ednaldohenper.github.io/apps/`.

## Segurança
- Página pública, mas **sem a senha não há dados** — tudo cifrado (AES-256-GCM, chave derivada da senha por PBKDF2).
- Token vive nos secrets e depois cifrado em `.secrets/`. Nunca em texto puro, nunca no celular.
- Com `FB_APP_ID` + `FB_APP_SECRET`, o robô **renova o token automaticamente**. Você não mexe mais nisso.

## Adicionar um app novo no futuro
1. Crie a pasta `apps/<novo>/index.html`.
2. (Se tiver coleta) adicione `scripts/<novo>-fetch.mjs` e um workflow `.github/workflows/<novo>-daily.yml`.
3. Adicione o card no `index.html` (portal).
