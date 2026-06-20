#!/usr/bin/env node
/**
 * Robô diário — Central de Inteligência Instagram (Nível 2)
 * - Lê o token do cofre (secret IG_TOKEN na 1ª vez; depois token.enc)
 * - Renova o token de longa duração (auto-renovação)
 * - Busca métricas na Graph API
 * - Acrescenta o snapshot do dia ao histórico
 * - Grava tudo CRIPTOGRAFADO (data.enc) com a senha do painel (DASH_PASSWORD)
 *
 * Variáveis de ambiente (secrets do GitHub):
 *   IG_ID          (obrigatório) id da conta Instagram
 *   DASH_PASSWORD  (obrigatório) senha que abre/descriptografa o painel
 *   IG_TOKEN       (1ª execução) token de 60 dias para bootstrap
 *   FB_APP_ID      (opcional)   para auto-renovar o token
 *   FB_APP_SECRET  (opcional)   para auto-renovar o token
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const API = "https://graph.facebook.com/v22.0";
const APP = process.env.APP_DIR || "instagram"; // subpasta do app no mono-repo
const DIR = path.resolve(APP);                  // ex: ./instagram (servido pelo Pages)
const DATA = path.join(DIR, "data.enc");
const TOKF = path.resolve(".secrets", `${APP}-token.enc`);

// configurados dentro de main() para não exigir env ao apenas importar o módulo
let IG_ID, PASS, APP_ID="", APP_SECRET="";
function need(k){ const v=process.env[k]; if(!v){console.error("Falta secret:",k);process.exit(1);} return v; }

/* ---------- Cripto (compatível com WebCrypto do navegador) ----------
   Formato base64( salt[16] | iv[12] | ciphertext+tag ), AES-256-GCM, PBKDF2-SHA256 100k */
function deriveKey(pass, salt){ return crypto.pbkdf2Sync(pass, salt, 100000, 32, "sha256"); }
function encrypt(obj, pass){
  const salt=crypto.randomBytes(16), iv=crypto.randomBytes(12);
  const key=deriveKey(pass,salt);
  const c=crypto.createCipheriv("aes-256-gcm",key,iv);
  const pt=Buffer.from(JSON.stringify(obj),"utf8");
  const ct=Buffer.concat([c.update(pt),c.final()]);
  const tag=c.getAuthTag();
  return Buffer.concat([salt,iv,ct,tag]).toString("base64");
}
function decrypt(b64, pass){
  const raw=Buffer.from(b64,"base64");
  const salt=raw.subarray(0,16), iv=raw.subarray(16,28);
  const tag=raw.subarray(raw.length-16);
  const ct=raw.subarray(28,raw.length-16);
  const key=deriveKey(pass,salt);
  const d=crypto.createDecipheriv("aes-256-gcm",key,iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct),d.final()]).toString("utf8"));
}

/* ---------- API ---------- */
async function api(token, p, tries=3){
  const sep=p.includes("?")?"&":"?";
  const url=`${API}/${p}${sep}access_token=${encodeURIComponent(token)}`;
  for(let i=1;i<=tries;i++){
    try{
      const r=await fetch(url);
      const j=await r.json();
      if(j.error) throw new Error(j.error.message||JSON.stringify(j.error));
      return j;
    }catch(e){
      const net=/fetch failed|ETIMEDOUT|ENETUNREACH|ECONNRESET|EAI_AGAIN|socket|network/i.test(String(e.message||e));
      if(net && i<tries){ await new Promise(r=>setTimeout(r,1000*i)); continue; }
      throw e;
    }
  }
}
function accMetric(d,n){ return (d?.data||[]).find(x=>x.name===n)?.total_value?.value ?? null; }
async function acc28One(token,name){ // 28 dias via intervalo de datas (days_28 foi descontinuado na v22)
  const until=Math.floor(Date.now()/1000), since=until-28*86400;
  try{
    const j=await api(token,`${IG_ID}/insights?metric=${name}&metric_type=total_value&period=day&since=${since}&until=${until}`);
    const v=j?.data?.[0]?.total_value?.value;
    if(v==null) console.error(`28d ${name}: resposta sem valor -> ${JSON.stringify(j?.data?.[0]||j)}`);
    return v==null?null:{name,total_value:{value:v}};
  }catch(e){ console.error(`28d ${name}: ${e.message}`); return null; }
}
async function seriesMetric(token,name,since,until){ // série diária (time_series)
  try{
    const j=await api(token,`${IG_ID}/insights?metric=${name}&metric_type=time_series&period=day&since=${since}&until=${until}`);
    const vals=j?.data?.[0]?.values;
    if(!Array.isArray(vals)){ console.error(`série ${name}: shape inesperado -> ${JSON.stringify(j?.data?.[0]||j).slice(0,200)}`); return []; }
    return vals.map(v=>({d:(v.end_time||"").slice(0,10), v:v.value??0}));
  }catch(e){ console.error(`série ${name}: ${e.message}`); return []; }
}
async function buildSeries(token){ // alcance diário ~90d (só "reach" aceita time_series)
  const DAY=86400, now=Math.floor(Date.now()/1000), byDate={};
  for(let c=0;c<3;c++){
    const until=now-c*30*DAY, since=until-30*DAY;
    for(const {d,v} of await seriesMetric(token,"reach",since,until)){ if(d) byDate[d]=v; }
  }
  return Object.entries(byDate).sort((a,b)=>a[0]<b[0]?-1:1).map(([d,reach])=>({d,reach}));
}
async function totalOver(token,name,days){ // soma do período via total_value, em janelas de <=30 dias
  const DAY=86400; let until=Math.floor(Date.now()/1000), left=days, total=0, got=false;
  while(left>0){ const span=Math.min(30,left), since=until-span*DAY;
    try{ const j=await api(token,`${IG_ID}/insights?metric=${name}&metric_type=total_value&period=day&since=${since}&until=${until}`);
      const v=j?.data?.[0]?.total_value?.value; if(v!=null){ total+=v; got=true; }
    }catch(e){ console.error(`total ${name}/${days}d: ${e.message}`); }
    until=since; left-=span;
  }
  return got?total:null;
}
async function buildTotals(token){ // totais por período: 7/28/90 dias
  const out={};
  for(const days of [7,28,90]){
    const o={
      views:await totalOver(token,"views",days),
      inter:await totalOver(token,"total_interactions",days),
      saves:await totalOver(token,"saves",days),
      profile_views:await totalOver(token,"profile_views",days) };
    if(days<=30){ // métricas "únicas": só em janela <=30d
      o.reach=await totalOver(token,"reach",days);
      o.engaged=await totalOver(token,"accounts_engaged",days);
    }
    out[days]=o;
  }
  return out;
}
/* ---------- Anúncios (Marketing API) ---------- */
function adsAcct(){ let a=(process.env.AD_ACCOUNT_ID||"").trim(); if(!a) return ""; return a.startsWith("act_")?a:("act_"+a.replace(/^act_/,"")); }
const _ymd=ms=>new Date(ms).toISOString().slice(0,10);
async function adsPeriod(token,acct,days){
  const tr=encodeURIComponent(JSON.stringify({since:_ymd(Date.now()-days*864e5),until:_ymd(Date.now())}));
  try{
    const j=await api(token,`${acct}/insights?fields=spend,impressions,reach,frequency,clicks,ctr,cpm,actions,cost_per_action_type&time_range=${tr}`);
    const r=j?.data?.[0]; if(!r) return null;
    const actions={}; (r.actions||[]).forEach(a=>actions[a.action_type]=+a.value);
    const cpa={}; (r.cost_per_action_type||[]).forEach(a=>cpa[a.action_type]=+a.value);
    return {spend:+r.spend||0,impressions:+r.impressions||0,reach:+r.reach||0,frequency:+r.frequency||0,clicks:+r.clicks||0,ctr:+r.ctr||0,cpm:+r.cpm||0,actions,cpa};
  }catch(e){ console.error(`ads ${days}d: ${e.message}`); return null; }
}
async function adsTop(token,acct,days,limit=12){
  const tr=encodeURIComponent(JSON.stringify({since:_ymd(Date.now()-days*864e5),until:_ymd(Date.now())}));
  try{
    const j=await api(token,`${acct}/insights?level=ad&limit=200&fields=ad_id,ad_name,spend,impressions,reach,frequency,clicks,ctr,cpm,actions&time_range=${tr}`);
    const rows=(j?.data||[]).map(r=>{const actions={};(r.actions||[]).forEach(a=>actions[a.action_type]=+a.value);
      return {id:r.ad_id,name:r.ad_name,spend:+r.spend||0,reach:+r.reach||0,impressions:+r.impressions||0,clicks:+r.clicks||0,ctr:+r.ctr||0,cpm:+r.cpm||0,actions};});
    rows.sort((a,b)=>b.spend-a.spend);
    return rows.slice(0,limit);
  }catch(e){ console.error(`ads top ${days}d: ${e.message}`); return []; }
}
async function buildAds(token){
  const acct=adsAcct(); if(!acct){ console.log("Sem AD_ACCOUNT_ID — anúncios pulados."); return null; }
  const t=(process.env.ADS_TOKEN||"").trim()||token;
  const periods={}; for(const d of [7,28,90]) periods[d]=await adsPeriod(t,acct,d);
  const topAds=await adsTop(t,acct,28,12);
  const ok=Object.values(periods).some(Boolean)||topAds.length;
  console.log(ok?`Anúncios coletados (${acct}).`:`Anúncios: nada retornado (confira ads_read no token e gasto no período) — ${acct}.`);
  return {account:acct, updated:new Date().toISOString(), periods, topAds};
}
/* ---------- Diagnóstico com IA (vault × Instagram) ---------- */
function aiStats(media){
  const r=media.map(p=>p.reach).filter(x=>x>0).sort((a,b)=>a-b);
  const medianaAlcance=r.length?r[Math.floor(r.length/2)]:0;
  const byT={}; media.forEach(p=>{(byT[p.type]=byT[p.type]||[]).push(p);});
  const formatos=Object.entries(byT).map(([t,a])=>({formato:t,posts:a.length,
    alcanceMedio:Math.round(a.reduce((s,x)=>s+x.reach,0)/a.length),
    salvMedio:Math.round(a.reduce((s,x)=>s+x.saves,0)/a.length)})).sort((a,b)=>b.alcanceMedio-a.alcanceMedio);
  const STOP=new Set("para com uma dos das que como mais mas sem sobre quando onde qual quais isso este esta esse essa voce seus suas meu minha tem ser nao sim nas nos pra pro por ele ela eles elas".split(/\s+/));
  const freq={}; media.forEach(p=>{const seen=new Set();(p.cap||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9#\s]/g," ").split(/\s+/).forEach(w=>{if(w.length<4||STOP.has(w)||seen.has(w))return;seen.add(w);(freq[w]=freq[w]||{n:0,r:0});freq[w].n++;freq[w].r+=p.reach;});});
  const temas=Object.entries(freq).filter(([w,o])=>o.n>=2).map(([w,o])=>({tema:w,vezes:o.n,alcanceMedio:Math.round(o.r/o.n)})).sort((a,b)=>b.alcanceMedio-a.alcanceMedio).slice(0,10);
  return {medianaAlcance,formatos,temas};
}
function buildDossier(b){
  const p=b.profile;
  const posts=(b.media||[]).slice().sort((a,c)=> (a.ts<c.ts?-1:1)).map(x=>({
    data:(x.ts||"").slice(0,10),tipo:x.type,alcance:x.reach,views:x.views,interacoes:x.inter,
    salvamentos:x.saves,compart:x.shares,coment:x.comments,legenda:(x.cap||"").slice(0,140)}));
  const historico=Object.values(b.history||{}).sort((a,c)=>a.date<c.date?-1:1)
    .map(h=>({data:h.date,seguidores:h.followers,alcance28:h.reach28,views28:h.views28,interacoes28:h.inter28}));
  const serie=b.series||[]; const t90=(b.totals||{})["90"]||{};
  const tendencia90={dias:serie.length,
    alcance_medio_diario:serie.length?Math.round(serie.reduce((s,x)=>s+(x.reach||0),0)/serie.length):0,
    views_total_90d:t90.views??null, interacoes_total_90d:t90.inter??null, alcance_diario:serie};
  return {perfil:{nome:p.name,usuario:p.username,seguidores:p.followers_count,posts:p.media_count},
    estatisticas:aiStats(b.media||[]),historico_diario:historico,tendencia_90d:tendencia90,posts};
}
function loadContext(){
  // Lê o método AO VIVO do vault (se montado em VAULT_DIR); senão usa o contexto.md commitado.
  const dir=process.env.VAULT_DIR;
  const files=(process.env.CONTEXTO_FILES||[
    "CLAUDE.md",
    "Estudo para modelar conteudo/REGRAS — Copy Humanizada e Vitrine que Vende.md",
    "Fichas/FICHA — METODO MAMAN CONTEUDO VIRAL.md"
  ].join("\n")).split(/\n/).map(s=>s.trim()).filter(Boolean);
  if(dir && fs.existsSync(dir)){
    const out=[]; let total=0;
    for(const f of files){
      try{ let t=fs.readFileSync(path.join(dir,f),"utf8");
        if(t.length>7000) t=t.slice(0,7000)+"\n…(trecho)";
        if(total+t.length>40000) break; total+=t.length;
        out.push(`\n\n===== ${f} =====\n${t}`);
      }catch{}
    }
    if(out.length){ console.log(`Contexto: ${out.length} arquivo(s) lidos do vault ao vivo.`); return out.join(""); }
    console.error("VAULT_DIR existe mas nenhum arquivo de método foi lido — caindo para contexto.md.");
  }
  try{ console.log("Contexto: contexto.md (fallback)."); return fs.readFileSync(new URL("./contexto.md",import.meta.url),"utf8"); }catch{ return ""; }
}
async function aiDiagnosis(bundle, prevAi){
  const key=process.env.ANTHROPIC_API_KEY;
  if(!key){ console.log("Sem ANTHROPIC_API_KEY — diagnóstico de IA pulado (resto do painel segue normal)."); return prevAi||null; }
  const model=process.env.AI_MODEL||"claude-opus-4-8";
  const contexto=loadContext();
  const system=`${contexto}\n\nVocê é o motor de análise de um painel de Instagram do Ednaldo. Escreva em português do Brasil, no tom dele (cientista do comportamento + estrategista; NUNCA "coach"). Sua tarefa é interpretar TENDÊNCIAS ao longo do tempo e o comportamento da audiência — não repetir números que o painel já mostra. Use o método acima (GNC, Maman, regras de copy, vitrine vende o destino) como lente. Baseie cada afirmação nos dados.`;
  const instr=`Analise os dados (perfil, estatísticas, histórico diário e posts em ordem cronológica) e devolva SOMENTE um JSON válido, sem nada fora do JSON, neste formato:
{"resumo":"2-4 frases: momento da conta e a tendência principal","tendencias":[{"titulo":"...","texto":"..."}],"o_que_funciona":[{"titulo":"...","texto":"..."}],"atencao":[{"titulo":"...","texto":"..."}],"pauta":["ideia de conteúdo específica p/ a próxima semana usando ganchos/gatilhos do Maman e temas que performam","..."],"leitura_comportamental":"1 parágrafo: o que salvamentos/compartilhamentos/temas revelam sobre a relação da audiência com o conteúdo"}
Regras: 2 a 4 itens por lista; 3 a 5 ideias em "pauta"; cite números/temas reais; se o histórico diário tiver poucos dias, leia a tendência pela evolução dos posts ao longo das datas.

DADOS:
${JSON.stringify(buildDossier(bundle))}`;
  try{
    const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",
      headers:{"content-type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({model,max_tokens:4096,system,messages:[{role:"user",content:instr}]})});
    const j=await res.json();
    if(j.error) throw new Error(j.error.message||JSON.stringify(j.error));
    const text=(j.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
    const m=text.match(/\{[\s\S]*\}/);
    const parsed=JSON.parse(m?m[0]:text);
    console.log(`Diagnóstico de IA gerado (${model}).`);
    return {generated:new Date().toISOString(),model,...parsed};
  }catch(e){ console.error("Falha no diagnóstico de IA (mantendo o anterior):",e.message); return prevAi||null; }
}
function compareAgg(media,startDaysAgo,endDaysAgo){ // agrega posts da janela [now-start, now-end]
  const now=Date.now(), from=now-startDaysAgo*864e5, to=now-endDaysAgo*864e5;
  const m=media.filter(p=>{const t=new Date(p.ts).getTime(); return t>=from&&t<to;});
  if(!m.length) return {posts:0};
  const avg=k=>Math.round(m.reduce((s,x)=>s+(x[k]||0),0)/m.length);
  const er=+(m.reduce((s,x)=>s+(x.reach>0?x.inter/x.reach*100:0),0)/m.length).toFixed(1);
  const bt={}; m.forEach(p=>bt[p.type]=(bt[p.type]||0)+1);
  const formato=Object.entries(bt).sort((a,b)=>b[1]-a[1])[0]?.[0]||null;
  const STOP=new Set("para com uma dos das que como mais mas sem sobre quando onde qual quais isso este esta esse essa voce seus suas tem ser nao sim".split(/\s+/));
  const freq={}; m.forEach(p=>{const seen=new Set();(p.cap||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9#\s]/g," ").split(/\s+/).forEach(w=>{if(w.length<4||STOP.has(w)||seen.has(w))return;seen.add(w);freq[w]=(freq[w]||0)+1;});});
  const temas=Object.entries(freq).filter(([w,n])=>n>=2).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([w])=>w);
  return {posts:m.length,alcance_medio:avg("reach"),salvamentos_medio:avg("saves"),compart_medio:avg("shares"),engajamento:er,formato_dominante:formato,temas};
}
async function aiCompare(bundle, prev){ // diagnóstico comparativo atual × anterior (7 e 28 dias)
  const key=process.env.ANTHROPIC_API_KEY; if(!key) return prev||null;
  const model=process.env.AI_MODEL||"claude-opus-4-8";
  const media=bundle.media||[];
  const dossie={ janela_7d:{atual:compareAgg(media,7,0),anterior:compareAgg(media,14,7)},
                 janela_28d:{atual:compareAgg(media,28,0),anterior:compareAgg(media,56,28)} };
  const contexto=loadContext();
  const system=`${contexto}\n\nVocê é o motor de comparação de um painel de Instagram do Ednaldo. Compare o período ATUAL com o ANTERIOR pela lente do método (GNC, Maman, regras de copy, vitrine vende o destino). Português do Brasil, no tom dele (cientista do comportamento + estrategista; NUNCA "coach"). Foque no comportamento: o que ele trouxe de novo que funcionou, o que deixou de fazer e custou, e o que ajustar.`;
  const instr=`Compare atual × anterior em DUAS janelas (7 e 28 dias). Devolva SOMENTE um JSON válido neste formato:
{"d7":{"resumo":"1-2 frases","melhorou":[{"titulo":"...","texto":"..."}],"largou":[{"titulo":"...","texto":"..."}],"acoes":["ação específica: continuar/parar/testar"]},"d28":{...mesmo formato...}}
Regras: 2 a 3 itens em "melhorou" e em "largou"; 2 a 3 em "acoes"; cite números reais da comparação; se um período tiver poucos posts, diga isso com honestidade em vez de inventar.
DADOS:
${JSON.stringify(dossie)}`;
  try{
    const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",
      headers:{"content-type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({model,max_tokens:3000,system,messages:[{role:"user",content:instr}]})});
    const j=await res.json(); if(j.error) throw new Error(j.error.message||JSON.stringify(j.error));
    const text=(j.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
    const mm=text.match(/\{[\s\S]*\}/); const parsed=JSON.parse(mm?mm[0]:text);
    console.log("Comparação de IA gerada.");
    return {generated:new Date().toISOString(),model,...parsed};
  }catch(e){ console.error("Falha na comparação de IA (mantendo a anterior):",e.message); return prev||null; }
}
/* ---------- Documento de inteligência para o vault ---------- */
function vaultDoc(b){
  const p=b.profile, media=(b.media||[]).filter(x=>x.type!=="AD");
  const st=aiStats(media);
  const PT={REELS:"Reels",FEED:"Feed",STORY:"Story",CAROUSEL_ALBUM:"Carrossel",VIDEO:"Vídeo",IMAGE:"Imagem"};
  const nf=n=>(n==null?"—":Number(n).toLocaleString("pt-BR"));
  const L=[];
  L.push(`---\ntags: [instagram, dados, base-conteudo, ednaldo-henper]\natualizado: ${new Date().toISOString().slice(0,10)}\nfonte: painel-instagram (auto)\n---\n`);
  L.push(`# Inteligência Instagram — @${p.username}`);
  L.push(`> Atualizado automaticamente pelo robô em ${new Date().toLocaleString("pt-BR")}. ${nf(p.followers_count)} seguidores · ${nf(p.media_count)} posts. Dados orgânicos (anúncios excluídos).\n`);
  const a=b.ai;
  if(a){ L.push(`## Diagnóstico (IA, pela lente do método)`); if(a.resumo)L.push(a.resumo+"\n");
    const sec=(t,arr)=>{if(arr&&arr.length){L.push(`### ${t}`);arr.forEach(r=>L.push(`- **${r.titulo}** — ${r.texto}`));L.push("");}};
    sec("Tendências",a.tendencias);sec("O que está funcionando",a.o_que_funciona);sec("Pontos de atenção",a.atencao);
    if(a.pauta&&a.pauta.length){L.push(`### Pauta sugerida`);a.pauta.forEach(x=>L.push(`- ${x}`));L.push("");}
    if(a.leitura_comportamental)L.push(`### Leitura comportamental\n${a.leitura_comportamental}\n`);
  }
  const c=b.compare&&b.compare.d28;
  if(c){ L.push(`## Evolução — 28 dias × 28 anteriores`); if(c.resumo)L.push(c.resumo+"\n");
    const sec=(t,arr)=>{if(arr&&arr.length){L.push(`### ${t}`);arr.forEach(r=>L.push(`- **${r.titulo}** — ${r.texto}`));L.push("");}};
    sec("Trouxe de novo (e funcionou)",c.melhorou);sec("Deixou de fazer (e custou)",c.largou);
    if(c.acoes&&c.acoes.length){L.push(`### Continuar / Parar / Testar`);c.acoes.forEach(x=>L.push(`- ${x}`));L.push("");}
  }
  if(media.length>=4){
    L.push(`## Inteligência dos posts (${media.length} posts)`);
    L.push(`- Alcance típico (mediana): **${nf(st.medianaAlcance)}**\n`);
    L.push(`### Alcance médio por formato`);
    st.formatos.forEach(f=>L.push(`- ${PT[f.formato]||f.formato} (${f.posts}): ${nf(f.alcanceMedio)} de alcance · ${nf(f.salvMedio)} salvamentos médios`));
    L.push("");
    if(st.temas&&st.temas.length){L.push(`### Temas que mais performam`);st.temas.slice(0,8).forEach(t=>L.push(`- **${t.tema}** — ${t.vezes}x, alcance médio ${nf(t.alcanceMedio)}`));L.push("");}
    L.push(`### Top 5 posts por alcance`);
    [...media].sort((x,y)=>y.reach-x.reach).slice(0,5).forEach(x=>L.push(`- **${nf(x.reach)}** alcance · ${PT[x.type]||x.type} · ${(x.ts||"").slice(0,10)} — ${(x.cap||"(sem legenda)").slice(0,110)}`));
    L.push("");
  }
  L.push(`---`);
  L.push(`## Como usar para criar Reels`);
  L.push(`- Repita os **temas e formatos** de maior alcance/salvamento acima.`);
  L.push(`- Estruture o Reel pelo **Método Maman**: gancho (0-3s) → identificação → desenvolvimento com prova → gatilho emocional → virada → CTA.`);
  L.push(`- Copy sem vício de IA; **venda o destino, não o método**.`);
  L.push(`- Parta da **Pauta sugerida** e do bloco **Continuar / Parar / Testar**.`);
  return L.join("\n");
}
function writeVaultDoc(bundle){
  const dir=process.env.VAULT_DIR;
  if(!dir||!fs.existsSync(dir)){ console.log("Vault não montado — documento de inteligência não escrito."); return; }
  try{
    const outDir=path.join(dir,"Instagram"); fs.mkdirSync(outDir,{recursive:true});
    const file=path.join(outDir,"Inteligência Instagram (auto).md");
    fs.writeFileSync(file, vaultDoc(bundle));
    console.log(`Inteligência escrita no vault: ${file}`);
  }catch(e){ console.error("Falha ao escrever documento no vault:",e.message); }
}

// capa: vídeo/reels -> thumbnail_url; imagem -> media_url; carrossel -> 1º filho
function coverOf(p){
  if(p.thumbnail_url) return p.thumbnail_url;
  if(p.media_url && p.media_type!=="VIDEO") return p.media_url;
  const c=p.children?.data?.[0];
  if(c) return c.thumbnail_url||c.media_url||"";
  return p.media_url||"";
}
async function demo(token,dim){
  const j=await api(token,`${IG_ID}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=${dim}`);
  const res=j.data?.[0]?.total_value?.breakdowns?.[0]?.results||[];
  return res.map(r=>({k:r.dimension_values[0],v:r.value})).sort((a,b)=>b.v-a.v);
}

/* ---------- Token (cofre + auto-renovação) ---------- */
function loadToken(){
  if(fs.existsSync(TOKF)){
    try{ return decrypt(fs.readFileSync(TOKF,"utf8"),PASS).token; }
    catch(e){ console.error("Não consegui ler token.enc (senha mudou?). Usando IG_TOKEN."); }
  }
  return process.env.IG_TOKEN || null;
}
function saveToken(token){
  fs.mkdirSync(path.dirname(TOKF),{recursive:true});
  fs.writeFileSync(TOKF, encrypt({token,saved:new Date().toISOString()},PASS));
}
async function refresh(token){
  if(!APP_ID||!APP_SECRET) return token; // sem app secret não renova (segue com o atual)
  try{
    const j=await api(token,`oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${token}`);
    if(j.access_token){ console.log("Token renovado (+60 dias)."); return j.access_token; }
  }catch(e){ console.error("Falha ao renovar token:",e.message,
    `(FB_APP_ID: ${APP_ID.length} chars, só dígitos=${/^\d+$/.test(APP_ID)} | FB_APP_SECRET: ${APP_SECRET.length} chars)`); }
  return token;
}

/* ---------- Coleta ---------- */
function parsePost(p){
  const ins={}; (p.insights?.data||[]).forEach(m=>ins[m.name]=m.values?.[0]?.value ?? 0);
  return {id:p.id,cap:(p.caption||"").replace(/\s+/g," ").slice(0,280),
    type:p.media_product_type||p.media_type,link:p.permalink,ts:p.timestamp,cover:coverOf(p),
    reach:ins.reach||0,views:ins.views||0,inter:ins.total_interactions||0,
    saves:ins.saved||0,shares:ins.shares||0,likes:p.like_count||0,comments:p.comments_count||0};
}

async function main(){
  IG_ID=need("IG_ID"); PASS=need("DASH_PASSWORD");
  APP_ID=(process.env.FB_APP_ID||"").trim(); APP_SECRET=(process.env.FB_APP_SECRET||"").trim();
  let token=loadToken();
  if(!token){ console.error("Sem token. Defina o secret IG_TOKEN na 1ª execução."); process.exit(1); }
  token=await refresh(token);
  saveToken(token);

  const profile=await api(token,`${IG_ID}?fields=username,name,followers_count,follows_count,media_count,profile_picture_url,biography`);
  const accDay =await api(token,`${IG_ID}/insights?metric=reach,profile_views,accounts_engaged,total_interactions,likes,comments,saves,shares,views&period=day&metric_type=total_value`).catch(()=>null);
  const acc28parts=await Promise.all(["reach","views","total_interactions"].map(m=>acc28One(token,m)));
  const acc28={data:acc28parts.filter(Boolean)};
  const mediaR =await api(token,`${IG_ID}/media?fields=id,caption,media_type,media_product_type,timestamp,permalink,media_url,thumbnail_url,like_count,comments_count,children{media_url,thumbnail_url,media_type},insights.metric(reach,views,total_interactions,saved,shares)&limit=100`).catch(()=>({data:[]}));
  const media=(mediaR.data||[]).map(parsePost);
  const series=await buildSeries(token).catch(()=>[]);
  const totals=await buildTotals(token).catch(()=>({}));
  const ads=await buildAds(token).catch(e=>{console.error("Falha em anúncios:",e.message);return null;});
  const demoData={ city:await demo(token,"city").catch(()=>[]),
                   gender:await demo(token,"gender").catch(()=>[]),
                   age:await demo(token,"age").catch(()=>[]) };

  // histórico anterior (do data.enc já existente)
  let prev={history:{}};
  if(fs.existsSync(DATA)){ try{ prev=decrypt(fs.readFileSync(DATA,"utf8"),PASS); }catch{ prev={history:{}}; } }
  const history=prev.history||{};
  const day=new Date().toISOString().slice(0,10);
  history[day]={date:day,
    followers:profile.followers_count, media:profile.media_count,
    reach28:accMetric(acc28,"reach"), views28:accMetric(acc28,"views"), inter28:accMetric(acc28,"total_interactions"),
    reachDay:accMetric(accDay,"reach"), viewsDay:accMetric(accDay,"views"),
    profileViews:accMetric(accDay,"profile_views"), engaged:accMetric(accDay,"accounts_engaged")};

  const bundle={ updated:new Date().toISOString(), profile, accDay, acc28, media, series, totals, ads, demo:demoData, history };
  bundle.ai=await aiDiagnosis(bundle, prev.ai);
  bundle.compare=await aiCompare(bundle, prev.compare);
  writeVaultDoc(bundle);
  fs.mkdirSync(DIR,{recursive:true});
  fs.writeFileSync(DATA, encrypt(bundle,PASS));
  console.log(`OK — ${profile.username}: ${profile.followers_count} seguidores · ${Object.keys(history).length} dia(s) no histórico.`);
}

// export para testes
export { encrypt, decrypt };
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main();
