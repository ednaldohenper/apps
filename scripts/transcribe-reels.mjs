#!/usr/bin/env node
/* transcribe-reels.mjs — transcreve a FALA de Reels do Instagram via Apify.
 *
 * Roda SOB DEMANDA e é isolado: não importa nem altera o robô de mercado.
 * Não mexe em nenhum ator/tarefa que você já tem no Apify — só faz chamadas
 * novas e independentes com o mesmo token.
 *
 * Modo padrão (DIRECT): manda a URL do post direto pro ator de transcrição
 * (é assim que atores tipo apple_yang/instagram-transcripts-scraper funcionam).
 * Como cada ator nomeia a entrada de um jeito, tentamos os formatos mais comuns
 * até um responder, e lemos os campos de saída mais comuns.
 *
 * Requer:  APIFY_TOKEN
 * Opcionais:
 *   TRANSCRIBE_ACTOR  default apple_yang~instagram-transcripts-scraper
 *   REEL_URLS         JSON array de URLs (vazio = os 10 parceiros padrão)
 *   LANG2 / LANG      idioma (default "pt")
 *   DIRECT_URL        "0" usa o modo fallback (resolve videoUrl antes, p/ atores Whisper genéricos)
 *   IG_ACTOR          ator de Instagram p/ o fallback (default apify~instagram-scraper)
 *   VAULT_DIR         pasta do vault pra salvar o .md (senão salva ao lado)
 */
import fs from "node:fs";
import path from "node:path";

const TOKEN = (process.env.APIFY_TOKEN || "").trim();
if (!TOKEN) { console.error("ERRO: faltou APIFY_TOKEN."); process.exit(1); }
const TRANSCRIBE_ACTOR = (process.env.TRANSCRIBE_ACTOR || "apple_yang~instagram-transcripts-scraper").trim();
const IG_ACTOR = (process.env.IG_ACTOR || "apify~instagram-scraper").trim();
const LANG = process.env.LANG2 || process.env.LANG || "pt";
const DIRECT = (process.env.DIRECT_URL || "1") !== "0";
const OUT_DIR = process.env.VAULT_DIR ? path.join(process.env.VAULT_DIR, "Conteúdos Instagram") : ".";

const DEFAULT_URLS = [
  "https://www.instagram.com/p/DZqYh-0B4F-/", // Veridiana — Globo + "digite DIAGNÓSTICO"
  "https://www.instagram.com/p/DZlRCrqJc70/", // Veridiana — 76% / Geração Z / Gallup
  "https://www.instagram.com/p/DZyJDKRpaOe/", // Veridiana — paixão x obrigação
  "https://www.instagram.com/p/DZoA93fKTQl/", // Veridiana — Ancelotti
  "https://www.instagram.com/p/DZ3SnBIppMF/", // Veridiana — Google / 3 perfis
  "https://www.instagram.com/p/DZn3NU-Cex_/", // André Menezes — short curto (polêmica)
  "https://www.instagram.com/p/DZyCJiLEUYE/", // Marcus Marques — "CONTRATAÇÃO 10"
  "https://www.instagram.com/p/DZ2aLVZxvu9/", // Marcus Marques — visão expansiva
  "https://www.instagram.com/p/DZ2qpPiuZYJ/", // Campanholo — delegar x dependência
  "https://www.instagram.com/p/DZ5Wq2VEQqs/", // Hélio Tatsuo — "trabalham por elas mesmas"
];
const URLS = process.env.REEL_URLS ? JSON.parse(process.env.REEL_URLS) : DEFAULT_URLS;

async function apifyRun(actor, input, timeoutS = 600) {
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(TOKEN)}&timeout=${timeoutS}`;
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`HTTP ${r.status} ${t.slice(0, 200)}`); }
  const j = await r.json();
  return Array.isArray(j) ? j : (j.items || []);
}

// lê o texto da transcrição de qualquer formato comum de saída
function extractText(it) {
  if (!it || typeof it !== "object") return "";
  const direct = it.text || it.transcript || it.transcription || it.captions || it.subtitle || it.subtitles;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const arr = it.segments || it.transcripts || it.results || it.chunks;
  if (Array.isArray(arr)) { const t = arr.map(s => (typeof s === "string" ? s : (s?.text || s?.transcript || ""))).join(" ").trim(); if (t) return t; }
  return "";
}
function itemUrl(it) { return it?.url || it?.inputUrl || it?.postUrl || it?.link || it?.originalUrl || it?.shortCode || ""; }
function owner(it) { return it?.ownerUsername || it?.ownerUserName || it?.username || it?.author || ""; }
function caption(it) { return it?.caption || it?.description || it?.postCaption || ""; }
const shortcode = u => (String(u).match(/\/(?:p|reel|reels|tv)\/([^/?#]+)/) || [])[1] || "";

// Modo DIRECT: manda as URLs direto pro ator de transcrição, tentando formatos comuns.
// Registra um diagnóstico (DIAG) de cada tentativa pra eu acertar o mapeamento sem ver o schema.
const DIAG = [];
async function transcribeBatch(urls) {
  const shapes = [
    ["urls", u => ({ urls: u })],
    ["startUrls", u => ({ startUrls: u.map(x => ({ url: x })) })],
    ["directUrls", u => ({ directUrls: u })],
    ["postUrls", u => ({ postUrls: u })],
    ["instagramUrls", u => ({ instagramUrls: u })],
    ["reels", u => ({ reels: u })],
    ["links", u => ({ links: u })],
  ];
  for (const [name, make] of shapes) {
    try {
      const items = await apifyRun(TRANSCRIBE_ACTOR, { ...make(urls), language: LANG });
      const got = items.some(extractText);
      DIAG.push({ shape: name, items: items.length, extraiu: got, amostra: items[0] ? JSON.stringify(items[0]).slice(0, 1200) : null });
      if (items.length && got) return items;
    } catch (e) { DIAG.push({ shape: name, erro: String(e.message).slice(0, 200) }); }
  }
  return [];
}

// Fallback (DIRECT_URL=0): resolve videoUrl e manda pro ator (atores Whisper genéricos)
async function resolveVideo(u) {
  try {
    const items = await apifyRun(IG_ACTOR, { directUrls: [u], resultsType: "posts", resultsLimit: 1 }, 300);
    const it = items.find(x => x.videoUrl || x.videoUrlHd) || items[0] || {};
    return { videoUrl: it.videoUrl || it.videoUrlHd || null, caption: it.caption || "", owner: it.ownerUsername || "" };
  } catch (e) { console.error(`  videoUrl falhou (${u}): ${e.message}`); return { videoUrl: null, caption: "", owner: "" }; }
}
async function transcribeOne(videoUrl) {
  const input = { videoUrl, url: videoUrl, audioUrl: videoUrl, videoUrls: [videoUrl], language: LANG };
  return extractText((await apifyRun(TRANSCRIBE_ACTOR, input))[0] || {});
}

(async () => {
  const out = URLS.map(u => ({ url: u, owner: "", caption: "", transcricao: "" }));

  if (DIRECT) {
    console.log(`Transcrevendo ${URLS.length} URLs em lote via ${TRANSCRIBE_ACTOR} …`);
    const items = await transcribeBatch(URLS);
    if (!items.length) console.log("Nenhum item retornado — confira o id do ator e o formato de entrada (veja o aviso no fim).");
    for (const it of items) {
      const sc = shortcode(itemUrl(it));
      let row = sc ? out.find(o => shortcode(o.url) === sc) : null;
      if (!row) row = out.find(o => !o.transcricao); // sem url casável: preenche em ordem
      if (!row) continue;
      row.transcricao = extractText(it);
      row.owner = owner(it) || row.owner;
      row.caption = caption(it) || row.caption;
    }
  } else {
    for (let i = 0; i < URLS.length; i++) {
      process.stdout.write(`(${i + 1}/${URLS.length}) ${URLS[i]} … `);
      const v = await resolveVideo(URLS[i]);
      out[i].owner = v.owner; out[i].caption = v.caption;
      out[i].transcricao = v.videoUrl ? await transcribeOne(v.videoUrl).catch(e => `[falha: ${e.message}]`) : "[sem videoUrl]";
      console.log(out[i].transcricao && !out[i].transcricao.startsWith("[") ? `ok (${out[i].transcricao.length} chars)` : out[i].transcricao);
    }
  }

  const ok = out.filter(o => o.transcricao && !o.transcricao.startsWith("[")).length;
  const L = [];
  L.push(`---\ntags: [instagram, transcricoes, referencias, carrossel, ednaldo-henper]\ntipo: transcricoes\ngerado: ${new Date().toISOString().slice(0, 10)}\n---\n`);
  L.push(`# 🎙️ Transcrições — Fala dos Reels de Referência\n`);
  L.push(`> Transcrição automática (Apify · ${TRANSCRIBE_ACTOR}) da FALA dos vídeos. Copy-base para carrossel. Confira nomes próprios e números antes de publicar. ${ok}/${out.length} transcritos.\n`);
  out.forEach((o, i) => {
    L.push(`\n## ${i + 1}. @${o.owner || "?"} · [ver post](${o.url})`);
    if (o.caption) L.push(`**Legenda:** ${String(o.caption).replace(/\n+/g, " ").trim()}`);
    L.push(`\n**Fala (transcrição):**`);
    L.push(`> ${String(o.transcricao || "[vazio — ver aviso no rodapé]").replace(/\n+/g, "\n> ")}`);
  });
  if (ok < out.length) L.push(`\n---\n> ⚠️ ${out.length - ok} item(ns) sem transcrição. Foi gravado um diagnóstico em \`_debug-transcribe.json\` (na mesma pasta) com o que o ator devolveu — é o que destrava o ajuste.`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (ok < out.length && DIAG.length) { try { fs.writeFileSync(path.join(OUT_DIR, "_debug-transcribe.json"), JSON.stringify(DIAG, null, 2)); console.log("Diagnóstico salvo em _debug-transcribe.json"); } catch {} }
  const file = path.join(OUT_DIR, "Transcrições — Referências (carrossel).md");
  fs.writeFileSync(file, L.join("\n"));
  console.log(`\nSalvo: ${file} (${ok}/${out.length} transcritos)`);
})();
