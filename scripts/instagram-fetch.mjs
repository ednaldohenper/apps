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
async function adsVisible(token){
  // Lista as contas de anúncio que o token enxerga (com nome/status).
  try{
    const j=await api(token,`me/adaccounts?fields=id,account_id,name,account_status&limit=100`);
    return j?.data||[];
  }catch(e){ console.log(`Ads — não consegui listar contas: ${e.message}`); return []; }
}
async function adsResolveAccount(token){
  // Decide qual conta usar:
  // 1) se AD_ACCOUNT_ID aponta para uma conta que o token acessa, usa essa (override do dono);
  // 2) senão, escolhe automaticamente a conta com MAIOR gasto nos últimos 90 dias.
  const want=adsAcct();
  const visible=await adsVisible(token);
  if(!visible.length){ console.log("Ads — token não enxerga nenhuma conta (verifique ads_read e atribuição do usuário)."); return null; }
  console.log(`Ads — contas visíveis (${visible.length}): ${visible.map(a=>`${a.id} (${a.name||"?"}, status ${a.account_status})`).join(" | ")}`);
  if(want && visible.some(a=>a.id===want)){ console.log(`Ads — usando conta fixada em AD_ACCOUNT_ID: ${want}.`); return want; }
  if(want){ console.log(`Ads — AD_ACCOUNT_ID (${want}) não está entre as contas acessíveis; escolhendo automaticamente pela de maior gasto.`); }
  let best=null,bestSpend=-1;
  for(const a of visible){ const p=await adsPeriod(token,a.id,90); const s=p?.spend||0; if(s>bestSpend){ bestSpend=s; best=a.id; } }
  if(best && bestSpend>0){ console.log(`Ads — conta auto-selecionada: ${best} (maior gasto 90d: ${bestSpend}).`); return best; }
  console.log("Ads — nenhuma conta com gasto nos últimos 90 dias."); return best||visible[0].id;
}
async function adsCampaigns(token,acct,days,limit=50){
  // Performance por campanha + status/orçamento (pra propor pausar/escalar/cortar).
  const tr=encodeURIComponent(JSON.stringify({since:_ymd(Date.now()-days*864e5),until:_ymd(Date.now())}));
  try{
    const ins=await api(token,`${acct}/insights?level=campaign&limit=${limit}&fields=campaign_id,campaign_name,spend,impressions,reach,frequency,clicks,ctr,cpm,actions,cost_per_action_type&time_range=${tr}`);
    const meta=await api(token,`${acct}/campaigns?fields=id,name,status,effective_status,objective,daily_budget,lifetime_budget&limit=200`).catch(()=>({data:[]}));
    const m={}; (meta?.data||[]).forEach(c=>m[c.id]={status:c.status,effective_status:c.effective_status,objetivo:c.objective,
      orcamento_diario:c.daily_budget?+c.daily_budget/100:null,orcamento_total:c.lifetime_budget?+c.lifetime_budget/100:null});
    const rows=(ins?.data||[]).map(r=>{const actions={};(r.actions||[]).forEach(a=>actions[a.action_type]=+a.value);
      const cpa={};(r.cost_per_action_type||[]).forEach(a=>cpa[a.action_type]=+a.value);
      return {id:r.campaign_id,name:r.campaign_name,spend:+r.spend||0,reach:+r.reach||0,impressions:+r.impressions||0,
        clicks:+r.clicks||0,ctr:+r.ctr||0,cpm:+r.cpm||0,frequency:+r.frequency||0,actions,cpa,...(m[r.campaign_id]||{})};});
    rows.sort((a,b)=>b.spend-a.spend);
    return rows.slice(0,limit);
  }catch(e){ console.error(`ads campanhas ${days}d: ${e.message}`); return []; }
}
async function adsAttachCreatives(token,ads){
  // Para cada top anúncio, busca o criativo e descobre se ele usa um post do feed (impulsionamento).
  for(const ad of ads||[]){
    try{
      const j=await api(token,`${ad.id}?fields=creative{id,object_type,instagram_permalink_url,effective_instagram_media_id,effective_object_story_id,thumbnail_url,image_url}`);
      const c=j&&j.creative; if(!c) continue;
      ad.igMediaId=c.effective_instagram_media_id||null;     // id do post do feed usado (se houver)
      ad.permalink=c.instagram_permalink_url||null;          // link público do post (se houver)
      ad.thumb=c.thumbnail_url||c.image_url||null;
      ad.objType=c.object_type||null;                        // SHARE costuma ser post impulsionado
    }catch(e){ /* silencioso por anúncio — não derruba a coleta */ }
  }
}
async function buildAds(token){
  const t=(process.env.ADS_TOKEN||"").trim()||token;
  const acct=await adsResolveAccount(t); if(!acct){ console.log("Anúncios pulados (sem conta acessível)."); return null; }
  const periods={}; for(const d of [7,28,90]) periods[d]=await adsPeriod(t,acct,d);
  const topAds=await adsTop(t,acct,28,12);
  await adsAttachCreatives(t,topAds);
  const usados=topAds.filter(a=>a.igMediaId||a.permalink).length;
  if(usados) console.log(`Anúncios — ${usados}/${topAds.length} top anúncios usam post do feed (impulsionamento).`);
  const campaigns=await adsCampaigns(t,acct,28,50);
  const ok=Object.values(periods).some(Boolean)||topAds.length;
  console.log(ok?`Anúncios coletados (${acct}) · ${campaigns.length} campanha(s).`:`Anúncios: conta ${acct} sem dados no período.`);
  return {account:acct, updated:new Date().toISOString(), periods, topAds, campaigns};
}
/* ---------- Windsor.ai (multicanal: ads + orgânico, ~28 dias) ---------- */
const WINDSOR_FIELDS_DEFAULT="source,date,account_name,campaign,clicks,impressions,spend,reach,ctr,cpm,cpc,frequency,conversions,conversion_values,results,likes,comments,shares,saves,video_views,video_plays,total_engagements,total_interactions,engagement,followers,profile_visits,profile_views,plays,accounts_reached,accounts_engaged";
async function windsorFetch(key,fields,from,to,preset){
  const base="https://connectors.windsor.ai/all";
  const range=preset?`date_preset=${encodeURIComponent(preset)}`:`date_from=${from}&date_to=${to}`;
  const url=`${base}?api_key=${encodeURIComponent(key)}&${range}&fields=${encodeURIComponent(fields)}&_renderer=json`;
  for(let i=1;i<=3;i++){
    try{
      const r=await fetch(url); const j=await r.json();
      if(j && j.error) throw new Error(typeof j.error==="string"?j.error:JSON.stringify(j.error));
      return j?.data||[];
    }catch(e){
      const net=/fetch failed|ETIMEDOUT|ENETUNREACH|ECONNRESET|EAI_AGAIN|socket|network/i.test(String(e.message||e));
      if(net && i<3){ await new Promise(r=>setTimeout(r,1000*i)); continue; }
      throw e;
    }
  }
}
const WINDSOR_SKIP=new Set(["source","date","account_name","campaign","account_id","campaign_id","ad_id","ad_name","adset_name"]);
const WINDSOR_LAST=new Set(["followers"]); // métricas acumuladas: usar o último dia, não somar
const r2=n=>Math.round(n*100)/100;
function validSource(s){ return typeof s==="string" && /^[a-z0-9_]{1,40}$/i.test(s); } // descarta source=URL/lixo
function windsorAgg(rows){
  // descobre campos numéricos e agrega por fonte (totais + série diária)
  const NUM=new Set();
  rows.forEach(r=>{ if(!validSource(r.source)) return;
    Object.entries(r).forEach(([k,v])=>{ if(!WINDSOR_SKIP.has(k) && v!=="" && v!=null && !isNaN(+v)) NUM.add(k); }); });
  const bySource={};
  for(const r of rows){
    if(!validSource(r.source)) continue;
    const s=r.source; const o=bySource[s]||(bySource[s]={source:s,dias:new Set(),totais:{},_last:{},serie:{}});
    if(r.date) o.dias.add(r.date);
    for(const k of NUM){ const raw=r[k]; if(raw===""||raw==null||isNaN(+raw)) continue; const v=+raw;
      if(WINDSOR_LAST.has(k)){ const d=r.date||""; if(!o._last[k]||d>=o._last[k].d) o._last[k]={d,v}; }
      else o.totais[k]=(o.totais[k]||0)+v;
      if(r.date){ const cell=(o.serie[r.date]=o.serie[r.date]||{}); cell[k]=WINDSOR_LAST.has(k)?v:((cell[k]||0)+v); } }
  }
  return Object.values(bySource).map(o=>{
    const t=o.totais; for(const k in o._last) t[k]=o._last[k].v; // injeta os "último valor"
    // taxas derivadas dos totais (exatas), em vez de somar/averaging
    if(t.impressions>0 && t.clicks!=null) t.ctr=r2(t.clicks/t.impressions*100); else delete t.ctr;
    if(t.impressions>0 && t.spend>0) t.cpm=r2(t.spend/t.impressions*1000); else delete t.cpm;
    if(t.clicks>0 && t.spend>0) t.cpc=r2(t.spend/t.clicks); else delete t.cpc;
    if(t.reach>0 && t.impressions>0) t.frequency=r2(t.impressions/t.reach); else delete t.frequency;
    return {source:o.source,dias:o.dias.size,
      totais:Object.fromEntries(Object.entries(t).map(([k,v])=>[k,r2(v)])),
      serie:Object.entries(o.serie).sort((a,b)=>a[0]<b[0]?-1:1).map(([date,m])=>({date,...m}))};
  });
}
async function buildWindsor(){
  const key=(process.env.WINDSOR_API_KEY||"").trim();
  if(!key){ console.log("Sem WINDSOR_API_KEY — multicanal (Windsor) pulado."); return null; }
  const fields=process.env.WINDSOR_FIELDS||WINDSOR_FIELDS_DEFAULT;
  const preset=process.env.WINDSOR_PRESET||""; // se vazio, usa intervalo de 28 dias
  const _d=ms=>new Date(ms).toISOString().slice(0,10);
  const to=_d(Date.now()), from=_d(Date.now()-27*864e5);
  try{
    const rows=await windsorFetch(key,fields,from,to,preset);
    if(!rows.length){ console.log("Windsor: nenhuma linha retornada (confira conectores conectados e período no Windsor)."); return {updated:new Date().toISOString(),from,to,sources:[],rowCount:0}; }
    const sources=windsorAgg(rows);
    const campos=Object.keys(rows[0]||{});
    console.log(`Windsor: ${rows.length} linha(s) · fontes: ${sources.map(s=>`${s.source}(${s.dias}d)`).join(", ")} · campos: ${campos.join(",")}`);
    return {updated:new Date().toISOString(),from,to,fields:campos,sources,rowCount:rows.length};
  }catch(e){ console.error("Falha no Windsor:",e.message); return null; }
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
  const multicanal=(b.windsor&&b.windsor.sources&&b.windsor.sources.length)
    ? {janela:`${b.windsor.from} a ${b.windsor.to}`, por_plataforma:b.windsor.sources.map(s=>({plataforma:s.source,dias:s.dias,totais:s.totais}))}
    : null;
  return {perfil:{nome:p.name,usuario:p.username,seguidores:p.followers_count,posts:p.media_count},
    estatisticas:aiStats(b.media||[]),historico_diario:historico,tendencia_90d:tendencia90,multicanal,posts};
}
const REGRA_CERTEZA=`

===== REGRA DE CERTEZA (vale para TODA análise deste painel) =====
A credibilidade vale mais que um insight a mais. Antes de afirmar qualquer coisa:
- Separe FATO (um número presente nos dados) de HIPÓTESE (a sua explicação para ele). Nunca apresente hipótese como se fosse fato.
- Quando algo for hipótese, use linguagem de verificação ("vale conferir", "confirmar antes de agir"), nunca alarme cravado. É melhor perder um possível insight do que dar um alarme falso.
- Só chame algo de "problema", "perda", "queda", "sangria" ou "vazamento" quando o próprio número PROVAR. Se não dá pra provar com o dado em mãos, é item de CONFERIR, não de AGIR.
- Em especial: NÃO trate a diferença entre métricas que medem coisas diferentes (ex.: "cliques no link" × "visitas à página/landing page view") como perda ou vazamento — explique que são métricas diferentes e proponha conferir destino e medição, sem cravar problema.
- Nunca invente números, datas ou resultados que não estão nos dados.`;
function loadContext(){
  // Lê o método AO VIVO do vault (se montado em VAULT_DIR); senão usa o contexto.md commitado.
  const dir=process.env.VAULT_DIR;
  const files=(process.env.CONTEXTO_FILES||[
    "CLAUDE.md",
    "Estudo para modelar conteudo/REGRAS — Copy Humanizada e Vitrine que Vende.md",
    "Fichas/FICHA — METODO MAMAN CONTEUDO VIRAL.md"
  ].join("\n")).split(/\n/).map(s=>s.trim()).filter(Boolean);
  let base="";
  if(dir && fs.existsSync(dir)){
    const out=[]; let total=0;
    for(const f of files){
      try{ let t=fs.readFileSync(path.join(dir,f),"utf8");
        if(t.length>7000) t=t.slice(0,7000)+"\n…(trecho)";
        if(total+t.length>40000) break; total+=t.length;
        out.push(`\n\n===== ${f} =====\n${t}`);
      }catch{}
    }
    if(out.length){ console.log(`Contexto: ${out.length} arquivo(s) lidos do vault ao vivo.`); base=out.join(""); }
    else console.error("VAULT_DIR existe mas nenhum arquivo de método foi lido — caindo para contexto.md.");
  }
  if(!base){ try{ console.log("Contexto: contexto.md (fallback)."); base=fs.readFileSync(new URL("./contexto.md",import.meta.url),"utf8"); }catch{ base=""; } }
  return base+REGRA_CERTEZA;
}
async function aiDiagnosis(bundle, prevAi){
  const key=process.env.ANTHROPIC_API_KEY;
  if(!key){ console.log("Sem ANTHROPIC_API_KEY — diagnóstico de IA pulado (resto do painel segue normal)."); return prevAi||null; }
  const model=process.env.AI_MODEL||"claude-opus-4-8";
  const contexto=loadContext();
  const system=`${contexto}\n\nVocê é o motor de análise de um painel de Instagram do Ednaldo. Escreva em português do Brasil, no tom dele (cientista do comportamento + estrategista; NUNCA "coach"). Sua tarefa é interpretar TENDÊNCIAS ao longo do tempo e o comportamento da audiência — não repetir números que o painel já mostra. Use o método acima (GNC, Maman, regras de copy, vitrine vende o destino) como lente. Baseie cada afirmação nos dados. Se vier o bloco "multicanal" (dados do Windsor: Meta Ads, Instagram, Facebook e TikTok dos últimos ~28 dias), cruze as plataformas — onde o alcance/engajamento está migrando, o que uma puxa que a outra não puxa — e traga isso nas tendências.`;
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
function adsDossier(ads){
  // Normaliza por dia p/ a IA comparar janelas (7⊂28⊂90 são acumuladas).
  const win=(p,dias)=>{ if(!p) return {sem_dados:true};
    const perDia=v=>+( (v||0)/dias ).toFixed(2);
    const results={}; Object.entries(p.actions||{}).forEach(([k,v])=>results[k]=v);
    const custo={}; Object.entries(p.cpa||{}).forEach(([k,v])=>custo[k]=v);
    return {investimento:Math.round(p.spend),investimento_por_dia:perDia(p.spend),
      alcance:p.reach,impressoes:p.impressions,frequencia:+p.frequency?.toFixed?.(2)||p.frequency,
      cliques:p.clicks,ctr_pct:p.ctr,cpm:p.cpm,resultados:results,custo_por_resultado:custo};
  };
  const top=(ads.topAds||[]).slice(0,8).map(a=>({nome:a.name,investimento:Math.round(a.spend),
    alcance:a.reach,ctr_pct:a.ctr,cpm:a.cpm,resultados:a.actions}));
  return {conta:ads.account, janela_7d:win(ads.periods?.[7],7), janela_28d:win(ads.periods?.[28],28),
    janela_90d:win(ads.periods?.[90],90), top_criativos_28d:top};
}
async function aiAds(bundle, prev){
  const key=process.env.ANTHROPIC_API_KEY; if(!key){ console.log("Sem ANTHROPIC_API_KEY — inteligência de anúncios pulada."); return prev||null; }
  const ads=bundle.ads; if(!ads || !ads.periods || !Object.values(ads.periods).some(Boolean)){ return prev||null; }
  const model=process.env.AI_MODEL||"claude-opus-4-8";
  const contexto=loadContext();
  const system=`${contexto}\n\nVocê é o motor de análise de TRÁFEGO PAGO do painel do Ednaldo (cientista do comportamento + estrategista; NUNCA "coach"). Português do Brasil, tom dele. As janelas 7/28/90 dias são ACUMULADAS (a de 7 está contida na de 28, que está na de 90), então leia MOMENTUM comparando as taxas: se o CTR/CPM/custo-por-resultado dos últimos 7 dias está melhor ou pior que o dos 90, as mexidas recentes (criativo, orçamento, público) estão ajudando ou atrapalhando. A vitrine vende o destino, não o método. Baseie cada afirmação nos números.

REGRA DE CERTEZA (inegociável — a credibilidade com o gestor de tráfego vale mais que um insight a mais):
- Separe FATO de HIPÓTESE. Fato é um número que está nos DADOS. Hipótese é a sua explicação para ele. Nunca apresente hipótese como se fosse fato.
- Quando algo for hipótese, use linguagem de verificação ("vale conferir", "confirmar antes de mexer"), nunca alarme cravado. É melhor perder um possível insight do que dar alarme falso.
- NÃO trate a diferença entre "cliques no link" e "visitas à página/landing_page_view" como vazamento ou perda. São métricas DIFERENTES: "cliques no link" conta TODO clique (que pode ir para a landing page, mas também para a página do Facebook, o perfil do Instagram, o WhatsApp/Direct, etc.); "landing_page_view" só conta quando AQUELA landing page específica carrega COM o pixel instalado. Então uma diferença grande entre os dois pode ser totalmente normal — o clique pode ter ido de propósito para outro destino (página do Facebook, perfil, WhatsApp), OU o pixel pode não estar naquela página. Antes de chamar de problema, liste essas explicações benignas e proponha CONFERIR o destino do anúncio e a instalação do pixel — não afirme "vazamento" e não recomende mexer no orçamento por causa disso.
- Só chame algo de problema/perda quando o próprio número provar (ex.: custo por resultado subindo, CTR caindo com frequência alta, gasto sem nenhum resultado rastreado). Se não dá pra provar com o dado, é item de "conferir", não de "agir".`;
  const instr=`Responda, pela lente do método: os anúncios estão indo bem? As mexidas em criativos/orçamento se justificam? Há oportunidade clara? Devolva SOMENTE um JSON válido neste formato:
{"resumo":"2-4 frases: os anúncios estão indo bem e o investimento se paga?","veredito":"uma das opções: 'rendendo' | 'no limite' | 'sangrando' + meia frase","tendencias":[{"titulo":"...","texto":"compare 7 vs 28 vs 90: o que melhorou/piorou e o que isso diz sobre as mexidas recentes"}],"oportunidades":[{"titulo":"...","texto":"onde colocar mais verba ou o que testar, com base no que já performa"}],"atencao":[{"titulo":"...","texto":"o que está caro/saturado (frequência alta, CTR caindo, custo subindo)"}],"acoes":["ação específica: escalar X, cortar Y, testar Z"],"criativos":"1 parágrafo: o que os top criativos revelam — o que escalar e o que aposentar"}
Regras: 2 a 4 itens por lista; 2 a 4 ações; cite números reais (R$, CTR%, CPM, custo por resultado, frequência); se faltar dado de resultado/conversão, diga com honestidade em vez de inventar. Em "atencao" e "acoes" só entra o que o número PROVA; quando for hipótese (ex.: diferença entre cliques e visitas à LP), não crave problema nem mande mexer no orçamento — escreva como "conferir o destino do anúncio e o pixel antes de decidir".
DADOS:
${JSON.stringify(adsDossier(ads))}`;
  try{
    const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",
      headers:{"content-type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({model,max_tokens:3000,system,messages:[{role:"user",content:instr}]})});
    const j=await res.json(); if(j.error) throw new Error(j.error.message||JSON.stringify(j.error));
    const text=(j.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
    const mm=text.match(/\{[\s\S]*\}/); const parsed=JSON.parse(mm?mm[0]:text);
    console.log("Inteligência de anúncios gerada.");
    return {generated:new Date().toISOString(),model,...parsed};
  }catch(e){ console.error("Falha na inteligência de anúncios (mantendo a anterior):",e.message); return prev||null; }
}
/* ---------- Central de Campanhas: proposta de ação por campanha (IA) ---------- */
function campDossier(ads){
  const r2=n=>Math.round(n*100)/100;
  return (ads.campaigns||[]).map(c=>{
    const principais=Object.entries(c.actions||{}).filter(([k])=>/lead|purchase|messaging|complete_registration|link_click|landing_page_view/i.test(k))
      .map(([k,v])=>({tipo:k,qtd:v,custo:c.cpa?.[k]!=null?r2(c.cpa[k]):null}));
    return {id:c.id,campanha:c.name,status:c.effective_status||c.status,objetivo:c.objetivo,
      orcamento_diario:c.orcamento_diario,orcamento_total:c.orcamento_total,
      gasto_28d:r2(c.spend),alcance:c.reach,ctr:r2(c.ctr),cpm:r2(c.cpm),frequencia:r2(c.frequency),cliques:c.clicks,
      resultados:principais};
  });
}
async function aiCampaigns(bundle, prev){
  const key=process.env.ANTHROPIC_API_KEY; if(!key) return prev||null;
  const ads=bundle.ads; if(!ads || !(ads.campaigns||[]).length) return prev||null;
  const model=process.env.AI_MODEL||"claude-opus-4-8";
  const contexto=loadContext();
  const system=`${contexto}\n\nVocê é o GESTOR DE CAMPANHAS de tráfego pago do Ednaldo (cientista do comportamento + estrategista; NUNCA "coach"). Português do Brasil, tom dele. Você recebe as campanhas do Meta Ads dos últimos 28 dias (gasto, CTR, CPM, frequência, resultados e custo por resultado, status e orçamento) e propõe, para CADA campanha, UMA ação clara. Pense como dono que cuida do próprio dinheiro: corte o que sangra, escale o que rende, e seja honesto quando faltar dado de resultado/conversão (não invente). Frequência alta (>3-4) com CTR caindo = saturação. Custo por resultado muito acima das outras = candidata a pausar ou revisar. A decisão final e a execução são SEMPRE do Ednaldo (você só propõe).`;
  const instr=`Para cada campanha em DADOS, proponha uma ação. Registre chamando a ferramenta responder.
acao: uma de [escalar, manter, observar, cortar_orcamento, pausar, revisar_criativo, revisar_publico].
Para escalar/cortar_orcamento, sugira o novo orçamento diário em "sugestao" (número em reais) com base no orçamento atual e no desempenho. Em "motivo", 1-2 frases citando o número que justifica (custo por resultado, CTR, frequência, gasto sem resultado). prioridade: alta|media|baixa (alta = mexer hoje). Não invente resultados: se a campanha não tem conversão/resultado rastreado, diga isso no motivo e seja conservador.
DADOS (campanhas, 28 dias):
${JSON.stringify(campDossier(ads)).slice(0,80000)}`;
  const item={type:"object",properties:{
    campanha:{type:"string"},acao:{type:"string",enum:["escalar","manter","observar","cortar_orcamento","pausar","revisar_criativo","revisar_publico"]},
    motivo:{type:"string"},sugestao:{type:"number"},prioridade:{type:"string",enum:["alta","media","baixa"]}},
    required:["campanha","acao","motivo","prioridade"]};
  const schema={type:"object",properties:{resumo:{type:"string"},campanhas:{type:"array",items:item}},required:["resumo","campanhas"]};
  try{
    const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",
      headers:{"content-type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({model,max_tokens:4000,system,
        tools:[{name:"responder",description:"Registra as propostas de ação por campanha.",input_schema:schema}],
        tool_choice:{type:"tool",name:"responder"},messages:[{role:"user",content:instr}]})});
    const j=await res.json(); if(j.error) throw new Error(j.error.message||JSON.stringify(j.error));
    const tu=(j.content||[]).find(b=>b.type==="tool_use"); if(!tu||!tu.input) throw new Error("sem tool_use");
    console.log(`Central de campanhas gerada: ${(tu.input.campanhas||[]).length} proposta(s).`);
    return {generated:new Date().toISOString(),model,...tu.input};
  }catch(e){ console.error("Falha na central de campanhas (mantendo anterior):",e.message); return prev||null; }
}
/* ---------- Leitura multicanal (Windsor) com IA ---------- */
const WSRC_LABEL={facebook:"Meta Ads",instagram:"Instagram orgânico",instagram_public:"Instagram orgânico",facebook_organic:"Facebook orgânico",tiktok_organic:"TikTok orgânico",tiktok:"TikTok Ads",youtube:"YouTube",google_ads:"Google Ads",linkedin_organic:"LinkedIn orgânico"};
function multiDossier(w){
  const r2=n=>Math.round(n*100)/100;
  return (w.sources||[]).map(s=>{
    const t=s.totais||{}; const d={canal:WSRC_LABEL[s.source]||s.source, slug:s.source, dias:s.dias, totais:{...t}};
    const eng=t.total_interactions||t.total_engagements||((t.likes||0)+(t.comments||0)+(t.shares||0)+(t.saves||0))||t.engagement||0;
    if(t.reach>0){ d.taxa_engajamento_pct=r2(eng/t.reach*100); d.alcance_por_dia=Math.round(t.reach/(s.dias||1)); }
    if(t.results>0 && t.spend>0) d.custo_por_resultado=r2(t.spend/t.results);
    if(t.conversions>0 && t.spend>0) d.custo_por_conversao=r2(t.spend/t.conversions);
    if(t.followers) d.seguidores=t.followers;
    return d;
  });
}
async function aiMulti(bundle, prev){
  const key=process.env.ANTHROPIC_API_KEY; if(!key) return prev||null;
  const w=bundle.windsor; if(!w || !w.sources || !w.sources.length){ return prev||null; }
  const model=process.env.AI_MODEL||"claude-opus-4-8";
  const contexto=loadContext();
  const dossie=multiDossier(w);
  const system=`${contexto}\n\nVocê é o motor de LEITURA MULTICANAL do painel do Ednaldo (cientista do comportamento + estrategista; NUNCA "coach"). Português do Brasil, tom dele. Os canais são HETEROGÊNEOS: o Meta Ads tem investimento e resultados/leads (compare por custo por resultado e eficiência); os canais orgânicos (Instagram/TikTok/etc.) não têm verba, então compare por taxa de engajamento, alcance por dia e crescimento. NÃO compare maçã com laranja em números brutos — compare cada canal pela sua própria régua e diga, no geral, ONDE ele está colhendo melhor resultado pelo esforço/investimento. A vitrine vende o destino, não o método. Baseie cada afirmação nos números.`;
  const instr=`Analise os canais (janela ~${w.from} a ${w.to}). Diga qual está melhor e por quê, e o que fazer pra potencializar. Registre o resultado chamando a ferramenta responder.
Regras: em ranking, ordene do melhor (posicao 1) ao pior, com uma frase de porque por canal (use custo por resultado pro Ads e engajamento/alcance pros orgânicos); em potencializar, uma ação concreta por canal (onde dobrar a aposta, o que testar, o que cortar); se só houver 1 canal, foque em como potencializá-lo; alerta só se houver algo caro/ineficiente.
DADOS:
${JSON.stringify(dossie)}`;
  const schema={type:"object",properties:{
    resumo:{type:"string"},
    vencedor:{type:"string"},
    ranking:{type:"array",items:{type:"object",properties:{canal:{type:"string"},posicao:{type:"integer"},porque:{type:"string"}},required:["canal","posicao","porque"]}},
    potencializar:{type:"array",items:{type:"object",properties:{canal:{type:"string"},acao:{type:"string"}},required:["canal","acao"]}},
    alerta:{type:"string"}
  },required:["resumo","vencedor","ranking","potencializar"]};
  try{
    const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",
      headers:{"content-type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({model,max_tokens:3000,system,
        tools:[{name:"responder",description:"Registra a leitura multicanal.",input_schema:schema}],
        tool_choice:{type:"tool",name:"responder"},
        messages:[{role:"user",content:instr}]})});
    const j=await res.json(); if(j.error) throw new Error(j.error.message||JSON.stringify(j.error));
    const tu=(j.content||[]).find(b=>b.type==="tool_use"); if(!tu||!tu.input) throw new Error("sem tool_use");
    console.log("Leitura multicanal gerada.");
    return {generated:new Date().toISOString(),model,...tu.input};
  }catch(e){ console.error("Falha na leitura multicanal (mantendo anterior):",e.message); return prev||null; }
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
    const outDir=path.join(dir,"Geração de Demanda","Instagram","Dados & Inteligência"); fs.mkdirSync(outDir,{recursive:true});
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
  const windsor=await buildWindsor().catch(e=>{console.error("Falha no Windsor:",e.message);return null;});
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

  const bundle={ updated:new Date().toISOString(), profile, accDay, acc28, media, series, totals, ads, windsor, demo:demoData, history };
  bundle.ai=await aiDiagnosis(bundle, prev.ai);
  bundle.compare=await aiCompare(bundle, prev.compare);
  if(bundle.ads){ bundle.ads.ai=await aiAds(bundle, prev.ads?.ai); bundle.ads.campaignsAI=await aiCampaigns(bundle, prev.ads?.campaignsAI); }
  if(bundle.windsor){ bundle.windsor.ai=await aiMulti(bundle, prev.windsor?.ai); }
  writeVaultDoc(bundle);
  fs.mkdirSync(DIR,{recursive:true});
  fs.writeFileSync(DATA, encrypt(bundle,PASS));
  console.log(`OK — ${profile.username}: ${profile.followers_count} seguidores · ${Object.keys(history).length} dia(s) no histórico.`);
}

// export para testes
export { encrypt, decrypt };
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main();
