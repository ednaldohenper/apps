#!/usr/bin/env node
/* transcribe-reels.mjs — transcreve a FALA de Reels do Instagram via Apify.
 *
 * Isolado: não importa nem altera o robô de mercado. Não mexe em nenhum
 * ator/tarefa existente — só faz chamadas novas com o mesmo token.
 *
 * O ator apple_yang~instagram-transcripts-scraper espera UMA URL por execução
 * no campo `videoUrl`. Ele devolve a legenda completa em `title`, a fala em
 * `text`/`segments`, e `audioUrl`/`videoUrl`. Posts sem áudio (imagem/carrossel)
 * voltam sem fala — aí guardamos só a legenda.
 *
 * Requer: APIFY_TOKEN. Opcionais: TRANSCRIBE_ACTOR, REEL_URLS (JSON), LANG, VAULT_DIR.
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

function extractText(it) {
  if (!it || typeof it !== "object") return "";
  const direct = it.text || it.transcript || it.transcription || it.transcriptText;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const arr = it.segments || it.transcripts;
  if (Array.isArray(arr) && arr.length) { const t = arr.map(s => (typeof s === "string" ? s : (s?.text || ""))).join(" ").trim(); if (t) return t; }
  return "";
}
const fullCaption = it => (it?.title || it?.postCaption || it?.caption || it?.description || "").trim();
const owner = it => it?.userName || it?.ownerUsername || it?.username || "";
const hasAudio = it => !!(it?.audioUrl || it?.videoUrl);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callActor(u) { return (await apifyRun(TRANSCRIBE_ACTOR, { videoUrl: u, url: u, language: LANG }))[0] || {}; }

const DIAG = [];
async function transcribeOne(u) {
  let it = await callActor(u);
  let text = extractText(it);
  // vídeo longo às vezes volta sem texto na 1ª; tenta mais 2x com folga
  for (let k = 0; k < 2 && !text && hasAudio(it); k++) {
    await sleep(5000);
    const it2 = await callActor(u);
    const t2 = extractText(it2);
    if (Object.keys(it2).length) it = it2;
    if (t2) { text = t2; break; }
  }
  if (!text && hasAudio(it)) DIAG.push({ url: u, motivo: "vídeo com áudio mas sem texto após retentativas", amostra: JSON.stringify(it).slice(0, 800) });
  return { it, text };
}

const hasFala = r => r && r.transcricao && !r.transcricao.startsWith("[");

(async () => {
  // ACUMULA entre rodadas (ator é instável): carrega o que já temos e só rebusca o que falta.
  const DATA_FILE = path.join(OUT_DIR, "_transcribe-data.json");
  const store = {};
  try { JSON.parse(fs.readFileSync(DATA_FILE, "utf8")).forEach(r => { store[r.url] = r; }); } catch {}

  const out = [];
  for (let i = 0; i < URLS.length; i++) {
    const u = URLS[i];
    const prev = store[u] || { url: u, owner: "", caption: "", transcricao: "" };
    process.stdout.write(`(${i + 1}/${URLS.length}) ${u} … `);
    if (hasFala(prev)) { console.log("já tinha fala — mantém"); out.push(prev); continue; }
    const row = { url: u, owner: prev.owner || "", caption: prev.caption || "", transcricao: prev.transcricao || "" };
    try {
      const { it, text } = await transcribeOne(u);
      const cap = fullCaption(it); if (cap.length > (row.caption || "").length) row.caption = cap;
      if (owner(it)) row.owner = owner(it);
      if (text) row.transcricao = text;
      else if (!row.transcricao) row.transcricao = hasAudio(it) ? "[fala não capturada — ator instável; rode de novo pra tentar]" : "[post sem áudio (imagem/carrossel) — use a legenda completa acima]";
      console.log(text ? `ok (${text.length} chars)` : (row.caption ? "só legenda" : "vazio"));
    } catch (e) {
      if (!row.transcricao) row.transcricao = `[falha: ${e.message}]`;
      DIAG.push({ url: u, erro: String(e.message).slice(0, 300) });
      console.log(`falha: ${e.message}`);
    }
    store[u] = row; out.push(row);
  }
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(URLS.map(u => store[u]).filter(Boolean), null, 2)); } catch {}

  // Só entram no arquivo os que foram transcritos 100% (fala real).
  const done = out.filter(hasFala);
  const L = [];
  L.push(`---\ntags: [instagram, transcricoes, referencias, carrossel, ednaldo-henper]\ntipo: transcricoes\ngerado: ${new Date().toISOString().slice(0, 10)}\n---\n`);
  L.push(`# 🎙️ Transcrições — Fala dos Reels de Referência\n`);
  L.push(`> Apenas os Reels com fala transcrita 100% (${done.length} de ${out.length}). Confira nomes próprios e números antes de usar.\n`);
  done.forEach((o, i) => {
    L.push(`\n---\n\n## ${i + 1}. @${o.owner || "?"} · [ver post](${o.url})\n`);
    L.push(`> ${String(o.transcricao).replace(/\n+/g, "\n> ")}`);
  });
  if (DIAG.length) L.push(`\n---\n> ⚠️ ${DIAG.length} item(ns) precisaram de atenção — ver \`_debug-transcribe.json\`.`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "Transcrições — Referências (carrossel).md"), L.join("\n"));
  if (DIAG.length) { try { fs.writeFileSync(path.join(OUT_DIR, "_debug-transcribe.json"), JSON.stringify(DIAG, null, 2)); } catch {} }
  else { try { fs.rmSync(path.join(OUT_DIR, "_debug-transcribe.json")); } catch {} }
  console.log(`\nSalvo: ${okFala}/${out.length} com fala, ${comLegenda}/${out.length} com legenda.`);
})();
