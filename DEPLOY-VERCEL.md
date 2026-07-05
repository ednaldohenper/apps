# 🚀 Publicar o painel na Vercel

O sistema é **estático** (HTML + dados cifrados). A Vercel serve isso sem build.
Quem atualiza os dados é o **robô do GitHub Actions** — ele faz commit do `data.enc`
novo todo dia. Por isso o jeito certo é conectar a Vercel ao repositório: cada
commit do robô dispara um redeploy automático e o painel fica sempre atualizado.

## Caminho recomendado — conectar ao GitHub (deploy automático)

1. Entre em **vercel.com** → **Add New… → Project**.
2. **Import Git Repository** → escolha `ednaldohenper/apps`.
   (Se não aparecer, clique em *Adjust GitHub App Permissions* e libere o repo.)
3. Na tela de configuração, deixe assim:
   - **Framework Preset:** `Other`
   - **Root Directory:** `./` (a raiz do repo)
   - **Build Command:** *vazio* (não há build)
   - **Output Directory:** *vazio* (serve a raiz)
   - O `vercel.json` na raiz já cuida do resto (não cachear os `.enc`).
4. **Deploy.** Em ~30s sai um link tipo `https://apps-xxxx.vercel.app`.
   - Portal geral: `/`
   - Painel do Instagram: `/instagram/`
5. **Abrir no celular:** cole o link, digite a `DASH_PASSWORD`. Safari/Chrome →
   *Adicionar à Tela de Início* pra virar ícone de app.

Pronto. Daí em diante, toda vez que o robô rodar (madrugada) e commitar os dados
novos, a Vercel redeploya sozinha. Você não faz mais nada.

## Domínio próprio (opcional)

Vercel → projeto → **Settings → Domains** → adicione `painel.seudominio.com`
(ou o que preferir) e aponte o DNS conforme as instruções da Vercel.

## Sobre segurança (igual ao GitHub Pages)

- A página é pública, mas **sem a senha não há dados** — tudo cifrado (AES-256-GCM,
  chave derivada da `DASH_PASSWORD` por PBKDF2). O token nunca vai pro navegador.
- Nada muda nesse modelo ao trocar de hospedagem: a Vercel só serve os mesmos
  arquivos estáticos.

## Alternativa rápida (teste manual, sem auto-update)

Vercel → **Add New… → Project → Deploy** e **arraste a pasta** com `index.html` +
`instagram/`. Serve pra testar, mas **não atualiza sozinho** — o robô continua
commitando no GitHub, e esse deploy manual não enxerga esses commits. Para produção,
use o caminho conectado ao GitHub acima.
