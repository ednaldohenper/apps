#!/usr/bin/env node
/* transcribe-reels.mjs — transcreve a FALA de Reels do Instagram via Apify.
 *
 * Roda SOB DEMANDA e é totalmente isolado: não importa nem altera o robô de
 * mercado (market-fetch.mjs). Não mexe em nenhum ator/tarefa que você já tem
 * no Apify — só faz chamadas novas e independentes com o mesmo token.
 *
 * Requer:
 *   APIFY_TOKEN         o mesmo token que você já usa.
 *   TRANSCRIBE_ACTOR    id do ator de transcrição da Apify Store (ex.: "user~actor").
 *                       Busque "instagram transcript" ou "whisper" no Apify Store.
 * Opcionais:
 *   IG_ACTOR            ator que resolve o videoUrl (default apify~instagram-scraper).
 *   REEL_URLS           JSON array de URLs. Se vazio, usa a lista dos 10 parceiros.
 *   VAULT_DIR           pasta do vault pra salvar o .md (senão salva ao lado).
 *   LANG                idioma da transcrição (default "pt").
 *
 * Uso:
 *   APIFY_TOKEN=xxx TRANSCRIBE_ACTOR=user~actor node scripts/transcribe-reels.mjs
 */
import fs from "node:fs";
import path from "node:path";

const TOKEN = (process.env.APIFY_TOKEN || "").trim();
if (!TOKEN) { console.error("ERRO: faltou APIFY_TOKEN."); process.exit(1); }
const IG_ACTOR = process.env.IG_ACTOR || "apify~instagram-scraper";
const TRANSCRIBE_ACTOR = (process.env.TRANSCRIBE_ACTOR || "").trim();
const LANG = process.env.LANG2 || process.env.LANG || "pt";
const OUT_DIR = process.env.VAULT_DIR ? path.join(process.env.VAULT_DIR, "Conteúdos Instagram") : ".";

// Os 10 parceiros selecionados (sobrescreva com REEL_URLS se quiser outra lista).
const DEFAULT_URLS = [
  "https://www.instagram.com/p/DZqYh-0B4F-/", // Veridiana — Globo + "digite DIAGNÓSTICO"
  "https://www.instagram.com/p/DZlRCrqJc70/", // Veridiana — 76% / Geração Z / Gallup
  "https://www.instagram.com/p/DZyJDKRpaOe/", // Veridiana — paixão x obrigação
  "https://www.instagram.com/p/DZoA93fKTQl/", // Veridiana — Ancelotti (liderança sob pressão)
  "https://www.instagram.com/p/DZ3SnBIppMF/", // Veridiana — Google / 3 perfis
  "https://www.instagram.com/p/DZn3NU-Cex_/", // André Menezes — short curto (polêmica)
  "https://www.instagram.com/p/DZyCJiLEUYE/", // Marcus Marques — "CONTRATAÇÃO 10"
  "https://www.instagram.com/p/DZ2aLVZxvu9/", // Marcus Marques — visão expansiva
  "https://www.instagram.com/p/DZ2qpPiuZYJ/", // Campanholo — delegar x transferir dependência
  "https://www.instagram.com/p/DZ5Wq2VEQqs/", // Hélio Tatsuo — "as pessoas trabalham por elas mesmas"
];
const URLS = process.env.REEL_URLS ? JSON.parse(process.env.REEL_URLS) : DEFAULT_URLS;

async function apifyRun(actor, input, timeoutS = 300) {
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(TOKEN)}&timeout=${timeoutS}`;
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`HTTP ${r.status} ${t.slice(0, 200)}`); }
  const j = await r.json();
  return Array.isArray(j) ? j : (j.items || []);
}

// 1) resolve videoUrl + legenda de cada Reel (mesmo ator de Instagram que você já usa)
async function resolveVideo(u) {
  try {
    const items = await apifyRun(IG_ACTOR, { directUrls: [u], resultsType: "posts", resultsLimit: 1, addParentData: false });
    const it = items.find(x => x.videoUrl || x.videoUrlHd) || items[0] || {};
    return { url: u, videoUrl: it.videoUrl || it.videoUrlHd || null, caption: it.caption || "", owner: it.ownerUsername || it.ownerUserName || "" };
  } catch (e) { console.error(`  videoUrl falhou (${u}): ${e.message}`); return { url: u, videoUrl: null, caption: "", owner: "" }; }
}

// 2) transcreve a partir do videoUrl. Mandamos as chaves de input mais comuns e
//    lemos as saídas mais comuns — assim funciona com a maioria dos atores de transcrição.
async function transcribe(videoUrl) {
  if (!TRANSCRIBE_ACTOR) throw new Error("defina TRANSCRIBE_ACTOR (id do ator de transcrição da Apify Store).");
  const input = { videoUrl, url: videoUrl, audioUrl: videoUrl, videoUrls: [videoUrl], urls: [videoUrl], language: LANG };
  const items = await apifyRun(TRANSCRIBE_ACTOR, input, 600);
  const it = items[0] || {};
  return it.text || it.transcript || it.transcription || it.captions
    || (Array.isArray(it.segments) ? it.segments.map(s => s.text || "").join(" ") : "") || "";
}

(async () => {
  if (!TRANSCRIBE_ACTOR) console.log("AVISO: TRANSCRIBE_ACTOR não definido — só vou resolver os vídeos, sem transcrever.\n");
  const out = [];
  for (let i = 0; i < URLS.length; i++) {
    const u = URLS[i];
    process.stdout.write(`(${i + 1}/${URLS.length}) ${u} … `);
    const v = await resolveVideo(u);
    let texto = "";
    if (v.videoUrl && TRANSCRIBE_ACTOR) {
      try { texto = await transcribe(v.videoUrl); }
      catch (e) { texto = `[falha na transcrição: ${e.message}]`; }
    } else if (!v.videoUrl) texto = "[sem videoUrl — pode não ser vídeo, ou o ator não retornou esse campo]";
    console.log(texto && !texto.startsWith("[") ? `ok (${texto.length} chars)` : (texto || "só videoUrl"));
    out.push({ ...v, transcricao: texto });
  }

  const L = [];
  L.push(`---\ntags: [instagram, transcricoes, referencias, carrossel, ednaldo-henper]\ntipo: transcricoes\ngerado: ${new Date().toISOString().slice(0, 10)}\n---\n`);
  L.push(`# 🎙️ Transcrições — Fala dos Reels de Referência\n`);
  L.push(`> Transcrição automática (Apify) da FALA dos vídeos. Copy-base para carrossel. Confira nomes próprios e números antes de publicar.\n`);
  out.forEach((o, i) => {
    L.push(`\n## ${i + 1}. @${o.owner || "?"} · [ver post](${o.url})`);
    if (o.caption) L.push(`**Legenda:** ${String(o.caption).replace(/\n+/g, " ").trim()}`);
    L.push(`\n**Fala (transcrição):**`);
    L.push(`> ${String(o.transcricao || "[vazio]").replace(/\n+/g, "\n> ")}`);
  });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, "Transcrições — Referências (carrossel).md");
  fs.writeFileSync(file, L.join("\n"));
  console.log(`\nSalvo: ${file}`);
})();
