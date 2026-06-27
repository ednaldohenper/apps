#!/usr/bin/env node
/* transcribe-reels.mjs — transcreve a FALA de Reels do Instagram via Apify.
 *
 * Isolado: não importa nem altera o robô de mercado. Não mexe em nenhum
 * ator/tarefa existente — só faz chamadas novas com o mesmo token.
 *
 * O ator apple_yang~instagram-transcripts-scraper espera UMA URL por execução,
 * no campo singular `videoUrl`. Então chamamos uma URL de cada vez.
 *
 * Requer:  APIFY_TOKEN
 * Opcionais:
 *   TRANSCRIBE_ACTOR  default apple_yang~instagram-transcripts-scraper
 *   REEL_URLS         JSON array de URLs (vazio = os 10 parceiros padrão)
 *   LANG2 / LANG      idioma (default "pt")
 *   VAULT_DIR         pasta do vault pra salvar o .md (senão salva ao lado)
 */
import fs from "node:fs";
import path from "node:path";

const TOKEN = (process.env.APIFY_TOKEN || "").trim();
if (!TOKEN) { console.error("ERRO: faltou APIFY_TOKEN."); process.exit(1); }
const TRANSCRIBE_ACTOR = (process.env.TRANSCRIBE_ACTOR || "apple_yang~instagram-transcripts-scraper").trim();
const LANG = process.env.LANG2 || process.env.LANG || "pt";
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
  const direct = it.text || it.transcript || it.transcription || it.transcriptText || it.captions || it.caption || it.subtitle || it.subtitles;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const arr = it.segments || it.transcripts || it.results || it.chunks;
  if (Array.isArray(arr)) { const t = arr.map(s => (typeof s === "string" ? s : (s?.text || s?.transcript || ""))).join(" ").trim(); if (t) return t; }
  return "";
}
function owner(it) { return it?.ownerUsername || it?.ownerUserName || it?.username || it?.author || ""; }
function metaCaption(it) { return it?.postCaption || it?.description || ""; }

const DIAG = [];
async function transcribeOne(u) {
  // o ator quer videoUrl no singular; mandamos também url como redundância inofensiva
  const items = await apifyRun(TRANSCRIBE_ACTOR, { videoUrl: u, url: u, language: LANG });
  const it = items[0] || {};
  const text = extractText(it);
  if (!text && (items.length)) DIAG.push({ url: u, itens: items.length, amostra: JSON.stringify(it).slice(0, 1500) });
  return { it, text };
}

(async () => {
  const out = [];
  for (let i = 0; i < URLS.length; i++) {
    const u = URLS[i];
    process.stdout.write(`(${i + 1}/${URLS.length}) ${u} … `);
    let row = { url: u, owner: "", caption: "", transcricao: "" };
    try {
      const { it, text } = await transcribeOne(u);
      row.transcricao = text || "[vazio — ver diagnóstico]";
      row.owner = owner(it);
      row.caption = metaCaption(it);
      console.log(text ? `ok (${text.length} chars)` : "vazio");
    } catch (e) {
      row.transcricao = `[falha: ${e.message}]`;
      DIAG.push({ url: u, erro: String(e.message).slice(0, 300) });
      console.log(`falha: ${e.message}`);
    }
    out.push(row);
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
    L.push(`> ${String(o.transcricao || "[vazio]").replace(/\n+/g, "\n> ")}`);
  });
  if (ok < out.length) L.push(`\n---\n> ⚠️ ${out.length - ok} item(ns) sem transcrição. Diagnóstico em \`_debug-transcribe.json\`.`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "Transcrições — Referências (carrossel).md"), L.join("\n"));
  if (DIAG.length) { try { fs.writeFileSync(path.join(OUT_DIR, "_debug-transcribe.json"), JSON.stringify(DIAG, null, 2)); } catch {} }
  else { try { fs.rmSync(path.join(OUT_DIR, "_debug-transcribe.json")); } catch {} }
  console.log(`\nSalvo (${ok}/${out.length} transcritos).`);
})();
