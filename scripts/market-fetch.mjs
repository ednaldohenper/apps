#!/usr/bin/env node
/**
 * Estudo de Mercado (manual) — Tavily (radar de tendências) + Apify (concorrentes) + IA.
 * Lê a config em instagram/market.json, grava CRIPTOGRAFADO em instagram/market.enc
 * (mesma senha DASH_PASSWORD do painel) e sobe um doc de inteligência pro vault.
 *
 * Secrets necessários:
 *   DASH_PASSWORD      (obrigatório) — mesma senha do painel
 *   TAVILY_API_KEY     (radar de mercado)
 *   APIFY_TOKEN        (concorrentes)
 *   ANTHROPIC_API_KEY  (síntese com IA)
 *   VAULT_DIR          (opcional) — método ao vivo p/ a lente da IA
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { encrypt } from "./instagram-fetch.mjs";

const APP = process.env.APP_DIR || "instagram";
const DIR = path.resolve(APP);
const CONF = path.join(DIR, "market.json");
const OUT  = path.join(DIR, "market.enc");
const PASS = process.env.DASH_PASSWORD;

const splitList=s=>(s||"").split(/[,\n;]/).map(x=>x.trim().replace(/^@/,"")).filter(Boolean);
function readConf(){
  let conf={};
  try{ conf=JSON.parse(fs.readFileSync(CONF,"utf8")); }
  catch(e){ console.error("Sem market.json válido:",e.message); }
  // Lista "do momento" (vinda do painel via workflow_dispatch) sobrepõe a do arquivo
  const ig=splitList(process.env.COMP_IG), tk=splitList(process.env.COMP_TIKTOK), yt=splitList(process.env.COMP_YOUTUBE);
  if(ig.length||tk.length||yt.length){
    if(ig.length) conf.competitors_instagram=ig;
    if(tk.length) conf.competitors_tiktok=tk;
    if(yt.length) conf.competitors_youtube=yt;
    console.log(`Lista do momento (painel): IG ${ig.length} · TikTok ${tk.length} · YouTube ${yt.length}.`);
  }
  return conf;
}
const STOP=new Set("para com uma dos das que como mais mas sem sobre quando onde qual quais isso este esta esse essa voce seus suas meu minha tem ser nao sim nas nos pra pro por ele ela eles elas the and for you your with this that have from".split(/\s+/));
function topThemes(texts,n=8){
  const freq={};
  texts.forEach(t=>{const seen=new Set();(t||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9#\s]/g," ").split(/\s+/).forEach(w=>{if(w.length<4||STOP.has(w)||seen.has(w))return;seen.add(w);freq[w]=(freq[w]||0)+1;});});
  return Object.entries(freq).filter(([w,c])=>c>=2).sort((a,b)=>b[1]-a[1]).slice(0,n).map(([w])=>w);
}

/* ---------- Tavily ---------- */
async function tavily(query,maxResults){
  const key=process.env.TAVILY_API_KEY; if(!key) return null;
  try{
    const r=await fetch("https://api.tavily.com/search",{method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({api_key:key,query,search_depth:"advanced",max_results:maxResults||6,include_answer:true,topic:"general"})});
    const j=await r.json();
    if(j.error||j.detail) throw new Error(JSON.stringify(j.error||j.detail));
    return {q:query,answer:j.answer||"",results:(j.results||[]).map(x=>({title:x.title,url:x.url,
      content:(x.content||"").slice(0,500),published:x.published_date||null}))};
  }catch(e){ console.error(`Tavily "${query.slice(0,40)}…": ${e.message}`); return {q:query,answer:"",results:[],erro:e.message}; }
}
async function buildRadar(conf){
  const key=process.env.TAVILY_API_KEY;
  if(!key){ console.log("Sem TAVILY_API_KEY — radar de mercado pulado."); return []; }
  const qs=conf.market_queries||[]; const out=[];
  for(const q of qs){ out.push(await tavily(q,conf.limits?.results_per_query)); }
  console.log(`Radar (Tavily): ${out.length} consulta(s), ${out.reduce((s,x)=>s+(x.results?.length||0),0)} resultado(s).`);
  return out;
}

/* ---------- Apify ---------- */
async function apifyRun(actor,input,timeoutS=180){
  const token=process.env.APIFY_TOKEN; if(!token) return [];
  const url=`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=${timeoutS}`;
  const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
  if(!r.ok){ const t=await r.text().catch(()=>""); throw new Error(`HTTP ${r.status} ${t.slice(0,180)}`); }
  const j=await r.json();
  return Array.isArray(j)?j:(j.items||[]);
}
const num=v=>{const n=+v;return isNaN(n)?0:n;};
// baixa a capa e devolve data URI (embutido, não expira). Pula se falhar ou for grande demais.
async function fetchImageDataUri(url,maxKB=320){
  if(!url||typeof url!=="string"||!/^https?:\/\//.test(url)) return null;
  try{
    const ctrl=new AbortController(); const to=setTimeout(()=>ctrl.abort(),12000);
    const r=await fetch(url,{signal:ctrl.signal,headers:{"user-agent":"Mozilla/5.0"}}); clearTimeout(to);
    if(!r.ok) return null;
    const ct=(r.headers.get("content-type")||"image/jpeg").split(";")[0];
    if(!/^image\//.test(ct)) return null;
    const buf=Buffer.from(await r.arrayBuffer());
    if(buf.length>maxKB*1024 || buf.length<200) return null;
    return `data:${ct};base64,${buf.toString("base64")}`;
  }catch{ return null; }
}
function summarize(handle,posts,kind){
  if(!posts.length) return {handle,kind,posts:0};
  const likes=posts.map(p=>p.likes), comments=posts.map(p=>p.comments), views=posts.map(p=>p.views).filter(x=>x>0);
  const avg=a=>a.length?Math.round(a.reduce((s,x)=>s+x,0)/a.length):0;
  const ts=posts.map(p=>p.ts).filter(Boolean).sort();
  let cadenceDays=null;
  if(ts.length>=2){ const span=(new Date(ts[ts.length-1])-new Date(ts[0]))/864e5; cadenceDays=Math.round((span/(ts.length-1))*10)/10; }
  const top=posts.slice().sort((a,b)=>(b.likes+b.comments*3)-(a.likes+a.comments*3)).slice(0,3)
    .map(p=>({texto:(p.text||"").slice(0,2200),likes:p.likes,comentarios:p.comments,views:p.views||null,url:p.url}));
  return {handle,kind,posts:posts.length,seguidores:posts[0].followers||null,
    media_likes:avg(likes),media_comentarios:avg(comments),media_views:views.length?avg(views):null,
    cadencia_dias:cadenceDays,temas:topThemes(posts.map(p=>p.text)),top_posts:top,
    _posts:posts.map(p=>({texto:(p.text||"").slice(0,2200),likes:p.likes,comments:p.comments,views:p.views||null,ts:p.ts,url:p.url,img:p.img||null,followers:posts[0].followers||null}))};
}
async function scrapeInstagram(handles,actor,limit){
  if(!handles.length) return [];
  const urls=handles.map(h=>`https://www.instagram.com/${String(h).replace(/^@/,"")}/`);
  try{
    const items=await apifyRun(actor,{directUrls:urls,resultsType:"posts",resultsLimit:limit,addParentData:true});
    const want=new Set(handles.map(h=>String(h).replace(/^@/,"").toLowerCase()));
    const byUser={};
    for(const it of items){ const u=it.ownerUsername||it.username||"?";
      if(want.size && !want.has(String(u).toLowerCase())) continue; // ignora perfil-fantasma (parent data)
      (byUser[u]=byUser[u]||[]).push({
      text:it.caption||"",likes:num(it.likesCount),comments:num(it.commentsCount),views:num(it.videoViewCount||it.videoPlayCount),
      ts:it.timestamp||it.takenAt||null,url:it.url||it.shortCode&&`https://instagram.com/p/${it.shortCode}`||null,
      img:it.displayUrl||(Array.isArray(it.images)&&it.images[0])||it.thumbnailUrl||null,
      followers:num(it.ownerFollowersCount||it.followersCount)});}
    return Object.entries(byUser).map(([u,ps])=>summarize(u,ps,"instagram"));
  }catch(e){ console.error(`Apify Instagram: ${e.message}`); return []; }
}
async function scrapeTiktok(handles,actor,limit){
  if(!handles.length) return [];
  try{
    const items=await apifyRun(actor,{profiles:handles.map(h=>String(h).replace(/^@/,"")),resultsPerPage:limit,shouldDownloadVideos:false,shouldDownloadCovers:false});
    const byUser={};
    for(const it of items){ const u=it.authorMeta?.name||it.authorMeta?.nickName||it.input||"?"; (byUser[u]=byUser[u]||[]).push({
      text:it.text||"",likes:num(it.diggCount),comments:num(it.commentCount),views:num(it.playCount),
      ts:it.createTimeISO||(it.createTime?new Date(it.createTime*1000).toISOString():null),url:it.webVideoUrl||null,
      img:it.videoMeta?.coverUrl||it.videoMeta?.originalCoverUrl||(Array.isArray(it.covers)&&it.covers[0])||it.cover||null,
      followers:num(it.authorMeta?.fans)});}
    return Object.entries(byUser).map(([u,ps])=>summarize(u,ps,"tiktok"));
  }catch(e){ console.error(`Apify TikTok: ${e.message}`); return []; }
}
async function scrapeYoutube(handles,actor,limit){
  if(!handles.length) return [];
  const urls=handles.map(h=>{const s=String(h).replace(/^@/,"");return s.startsWith("http")?s:`https://www.youtube.com/@${s}/videos`;});
  try{
    const items=await apifyRun(actor,{startUrls:urls.map(u=>({url:u})),maxResults:limit,maxResultsShorts:0},240);
    const byCh={};
    for(const it of items){ const u=it.channelName||it.channelUsername||"?"; (byCh[u]=byCh[u]||[]).push({
      text:it.title||"",likes:num(it.likes),comments:num(it.commentsCount),views:num(it.viewCount),
      ts:it.date||it.uploadDate||null,url:it.url||null,
      img:it.thumbnailUrl||it.thumbnail||null,
      followers:num(it.numberOfSubscribers)});}
    return Object.entries(byCh).map(([u,ps])=>summarize(u,ps,"youtube"));
  }catch(e){ console.error(`Apify YouTube: ${e.message}`); return []; }
}
async function buildCompetitors(conf){
  if(!process.env.APIFY_TOKEN){ console.log("Sem APIFY_TOKEN — concorrentes pulados."); return {instagram:[],tiktok:[],youtube:[]}; }
  const a=conf.actors||{}, lim=conf.limits?.posts_per_profile||12;
  const out={ instagram:await scrapeInstagram(conf.competitors_instagram||[],a.instagram||"apify~instagram-scraper",lim),
              tiktok:await scrapeTiktok(conf.competitors_tiktok||[],a.tiktok||"clockworks~tiktok-scraper",lim),
              youtube:await scrapeYoutube(conf.competitors_youtube||[],a.youtube||"streamers~youtube-scraper",lim) };
  const tot=out.instagram.length+out.tiktok.length+out.youtube.length;
  console.log(`Concorrentes (Apify): ${out.instagram.length} IG · ${out.tiktok.length} TikTok · ${out.youtube.length} YT (${tot} perfis).`);
  // Top N posts de CADA concorrente (preferindo os últimos 30 dias)
  const PER=conf.limits?.destaques_por_perfil||5;
  const cutoff=Date.now()-30*864e5;
  const score=p=>(p.views||0)*0.05 + p.likes + p.comments*4;
  let id=0; const groups=[]; const flat=[];
  for(const k of ["instagram","tiktok","youtube"]) for(const c of out[k]){
    const posts=c._posts||[]; delete c._posts;
    if(!posts.length) continue;
    const within=posts.filter(p=>{const t=p.ts?Date.parse(p.ts):NaN; return isNaN(t)||t>=cutoff;});
    const pool=within.length?within:posts; // se nada nos 30d, usa o histórico
    const top=pool.slice().sort((x,y)=>score(y)-score(x)).slice(0,PER).map(b=>{
      const er=b.followers?(b.likes+b.comments)/b.followers*100:null;
      const o={id:id++,texto:b.texto,likes:b.likes,comments:b.comments,views:b.views,ts:b.ts,url:b.url,img:b.img||null,
        engaj_pct:er!=null?Math.round(er*100)/100:null};
      flat.push(o); return o;
    });
    groups.push({handle:c.handle,kind:k,seguidores:c.seguidores||null,recente:within.length>0,posts:top});
  }
  // embute as capas (com orçamento p/ não inchar o arquivo)
  let budget=30;
  for(const p of flat){ if(budget>0){ p.thumb=await fetchImageDataUri(p.img); if(p.thumb) budget--; } }
  out.destaques=groups;
  const comThumb=flat.filter(p=>p.thumb).length;
  console.log(`Destaques: ${flat.length} post(s) de ${groups.length} concorrente(s) (até ${PER}/perfil) · ${comThumb} com capa embutida.`);
  return out;
}

/* ---------- Contexto (método ao vivo) ---------- */
function loadContext(){
  const dir=process.env.VAULT_DIR;
  const files=["CLAUDE.md","Estudo para modelar conteudo/REGRAS — Copy Humanizada e Vitrine que Vende.md","Fichas/FICHA — METODO MAMAN CONTEUDO VIRAL.md"];
  if(dir && fs.existsSync(dir)){ const out=[]; let total=0;
    for(const f of files){ try{ let t=fs.readFileSync(path.join(dir,f),"utf8"); if(t.length>6000)t=t.slice(0,6000)+"\n…"; if(total+t.length>32000)break; total+=t.length; out.push(`\n\n===== ${f} =====\n${t}`);}catch{} }
    if(out.length){ console.log(`Contexto: ${out.length} arquivo(s) do vault ao vivo.`); return out.join(""); } }
  try{ return fs.readFileSync(new URL("./contexto.md",import.meta.url),"utf8"); }catch{ return ""; }
}

/* ---------- Síntese com IA ---------- */
async function aiMarket(radar,competitors,prev){
  const key=process.env.ANTHROPIC_API_KEY; if(!key){ console.log("Sem ANTHROPIC_API_KEY — síntese pulada."); return prev||null; }
  const model=process.env.AI_MODEL||"claude-opus-4-8";
  const contexto=loadContext();
  const destaques=[];
  (competitors.destaques||[]).forEach(g=>(g.posts||[]).forEach(p=>destaques.push(
    {id:p.id,perfil:g.handle,plataforma:g.kind,texto:p.texto,likes:p.likes,comentarios:p.comments,views:p.views,engaj_pct:p.engaj_pct})));
  const dossie={ radar_mercado:(radar||[]).map(r=>({pergunta:r.q,resposta:r.answer,fontes:(r.results||[]).slice(0,4).map(x=>({titulo:x.title,trecho:x.content}))})),
    concorrentes:{instagram:competitors.instagram,tiktok:competitors.tiktok,youtube:competitors.youtube},
    posts_que_performaram:destaques };
  const system=`${contexto}\n\nVocê é o motor de ESTUDO DE MERCADO do Ednaldo (cientista do comportamento + estrategista; NUNCA "coach"). Português do Brasil, no tom dele. Sua tarefa é olhar PARA FORA — o que está se movendo no mercado e nos concorrentes — e traduzir em leitura estratégica pela lente do método (GNC, Maman, regras de copy, a vitrine vende o destino). Não repita dados crus: interprete. Baseie cada afirmação no que veio do radar/concorrentes.`;
  const instr=`Analise o radar de mercado (buscas web), os concorrentes (perfis raspados) e os posts que mais performaram, e registre o resultado chamando a ferramenta responder.
Regras: 3 a 5 itens em tendencias/oportunidades; 2 a 4 em ameacas; 4 a 6 em angulos (ganchos de conteudo no estilo Maman); cite nomes de concorrentes e numeros reais quando houver; se concorrentes vier vazio, foque no radar e diga que faltam perfis cadastrados.
OBRIGATORIO: posts_destaque DEVE conter EXATAMENTE um objeto para CADA id presente em posts_que_performaram (do menor ao maior, sem pular nenhum). Se houver N posts, devolva N objetos em posts_destaque.
DADOS:
${JSON.stringify(dossie).slice(0,120000)}`;
  const item={type:"object",properties:{titulo:{type:"string"},texto:{type:"string"}},required:["titulo","texto"]};
  const schema={type:"object",properties:{
    resumo:{type:"string"},
    tendencias:{type:"array",items:item},
    oportunidades:{type:"array",items:item},
    ameacas:{type:"array",items:item},
    concorrentes_leitura:{type:"string"},
    angulos:{type:"array",items:{type:"string"}},
    posts_destaque:{type:"array",items:{type:"object",properties:{id:{type:"integer"},porque:{type:"string"},licao:{type:"string"}},required:["id","porque","licao"]}}
  },required:["resumo","tendencias","oportunidades","ameacas","concorrentes_leitura","angulos","posts_destaque"]};
  try{
    const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",
      headers:{"content-type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({model,max_tokens:12000,system,
        tools:[{name:"responder",description:"Registra o estudo de mercado estruturado.",input_schema:schema}],
        tool_choice:{type:"tool",name:"responder"},
        messages:[{role:"user",content:instr}]})});
    const j=await res.json(); if(j.error) throw new Error(j.error.message||JSON.stringify(j.error));
    const tu=(j.content||[]).find(b=>b.type==="tool_use");
    if(!tu||!tu.input) throw new Error("resposta sem tool_use");
    if(j.stop_reason==="max_tokens") console.warn("Aviso: resposta da IA atingiu max_tokens.");
    console.log(`Sintese de mercado gerada (${model}).`);
    return {generated:new Date().toISOString(),model,...tu.input};
  }catch(e){ console.error("Falha na sintese de mercado (mantendo anterior):",e.message); return prev||null; }
}

/* ---------- Doc para o vault ---------- */
function writeVaultDoc(bundle){
  const dir=process.env.VAULT_DIR; if(!dir||!fs.existsSync(dir)) return;
  const a=bundle.ai;
  const nf=n=>(n==null?"—":Number(n).toLocaleString("pt-BR"));
  const KIND={instagram:"Instagram",tiktok:"TikTok",youtube:"YouTube"};
  const sec=(t,arr)=>arr&&arr.length?`\n## ${t}\n`+arr.map(x=>`- **${x.titulo||""}** — ${x.texto||""}`).join("\n"):"";
  const L=[];
  L.push(`---\ntags: [instagram, mercado, concorrencia, auto]\ngerado: ${new Date().toISOString()}\n---\n`);
  L.push(`# Estudo de Mercado (auto)\n`);
  L.push(`> Gerado automaticamente pelo robô de mercado (Tavily + Apify + IA). Não editar à mão — é sobrescrito a cada rodada.`);
  const C=bundle.competitors||{};
  const nIg=(C.instagram||[]).length, nTk=(C.tiktok||[]).length, nYt=(C.youtube||[]).length;
  const groups=C.destaques||[];
  const nPosts=groups.reduce((s,g)=>s+(g.posts?g.posts.length:0),0);
  L.push(`> Atualizado em ${new Date().toLocaleString("pt-BR")} · ${nIg+nTk+nYt} concorrente(s) (${nIg} IG · ${nTk} TikTok · ${nYt} YT) · ${nPosts} posts analisados · ${(bundle.radar||[]).length} buscas de radar.`);

  if(a){
    if(a.resumo) L.push(`\n## Leitura do momento\n${a.resumo}`);
    L.push(sec("Tendências",a.tendencias));
    L.push(sec("Oportunidades (brechas)",a.oportunidades));
    L.push(sec("Ameaças / movimentos",a.ameacas));
    if(a.angulos&&a.angulos.length) L.push(`\n## Ângulos para surfar\n`+a.angulos.map(x=>`- ${x}`).join("\n"));
    if(a.concorrentes_leitura) L.push(`\n## Leitura dos concorrentes\n${a.concorrentes_leitura}`);
  } else {
    L.push(`\n> ⚠️ A síntese de IA não rodou nesta coleta — abaixo seguem os dados crus coletados.`);
  }

  const statByHandle={};
  for(const k of ["instagram","tiktok","youtube"]) for(const c of (C[k]||[])) statByHandle[(c.handle||"").toLowerCase()]={...c,kind:k};
  if(groups.length){
    L.push(`\n---\n# Concorrentes — análise detalhada`);
    for(const g of groups){
      const st=statByHandle[(g.handle||"").toLowerCase()]||{};
      L.push(`\n## @${g.handle} · ${KIND[g.kind]||g.kind}`);
      const bits=[];
      const seg=st.seguidores!=null?st.seguidores:g.seguidores;
      if(seg!=null) bits.push(`👥 ${nf(seg)} seguidores`);
      if(st.posts!=null) bits.push(`📦 ${nf(st.posts)} posts coletados`);
      if(st.media_likes!=null) bits.push(`média ❤ ${nf(st.media_likes)}`);
      if(st.media_comentarios!=null) bits.push(`média 💬 ${nf(st.media_comentarios)}`);
      if(st.media_views) bits.push(`média ▶ ${nf(st.media_views)}`);
      if(st.cadencia_dias!=null) bits.push(`cadência ~${st.cadencia_dias} dia(s) entre posts`);
      if(bits.length) L.push(bits.join(" · "));
      if(st.temas&&st.temas.length) L.push(`**Temas recorrentes:** ${st.temas.join(", ")}`);
      L.push(`\n**Top posts (até 5, por engajamento):**`);
      (g.posts||[]).forEach((d,i)=>{
        const met=[`❤ ${nf(d.likes)}`,`💬 ${nf(d.comments)}`]; if(d.views)met.push(`▶ ${nf(d.views)}`); if(d.engaj_pct!=null)met.push(`📊 ${d.engaj_pct}% eng.`);
        const dt=d.ts?` · ${new Date(d.ts).toLocaleDateString("pt-BR")}`:"";
        L.push(`\n**${i+1}.** ${met.join(" · ")}${dt}${d.url?` · [ver post](${d.url})`:""}`);
        if(d.texto) L.push(`> ${String(d.texto).replace(/\n+/g," ").trim()}`);
        L.push(`- **Por que performou:** ${d.porque||"— (análise não gerada nesta rodada)"}`);
        L.push(`- **Lição p/ aplicar:** ${d.licao||"—"}`);
      });
    }
  }

  const R=bundle.radar||[];
  if(R.length){
    L.push(`\n---\n# Radar de mercado (buscas web — Tavily)`);
    for(const r of R){
      if(!r) continue;
      L.push(`\n## ${r.q||""}`);
      if(r.answer) L.push(r.answer);
      if((r.results||[]).length) L.push(`\n**Fontes:**`);
      (r.results||[]).forEach(x=>{
        L.push(`- **[${String(x.title||x.url||"").replace(/\n/g," ")}](${x.url})**${x.published?` · ${x.published}`:""}`);
        if(x.content) L.push(`  > ${String(x.content).replace(/\n/g," ").slice(0,500)}`);
      });
    }
  }

  L.push(`\n---\n*Estudo gerado por Tavily (radar de mercado) + Apify (concorrentes) + IA${a?` (${a.model})`:" (síntese não gerada)"}. Janela de concorrentes: últimos 30 dias.*`);
  const md=L.join("\n")+"\n";
  try{ const p=path.join(dir,"Geração de Demanda","Instagram","Dados & Inteligência"); fs.mkdirSync(p,{recursive:true});
    fs.writeFileSync(path.join(p,"Estudo de Mercado (auto).md"),md);
    console.log(`Estudo escrito no vault: Geração de Demanda/Instagram/Dados & Inteligência/Estudo de Mercado (auto).md (${md.length} chars).`); }catch(e){ console.error("Vault doc:",e.message); }
}

async function main(){
  if(!PASS){ console.error("Falta DASH_PASSWORD."); process.exit(1); }
  const conf=readConf();
  const radar=await buildRadar(conf);
  const competitors=await buildCompetitors(conf);
  const bundle={ updated:new Date().toISOString(), radar, competitors,
    config:{instagram:(conf.competitors_instagram||[]).length,tiktok:(conf.competitors_tiktok||[]).length,youtube:(conf.competitors_youtube||[]).length} };
  bundle.ai=await aiMarket(radar,competitors,null);
  // injeta a análise "por que performou" em cada post de destaque
  if(bundle.ai && Array.isArray(bundle.ai.posts_destaque) && competitors.destaques){
    const m={}; bundle.ai.posts_destaque.forEach(x=>{ if(x&&x.id!=null) m[x.id]=x; });
    competitors.destaques.forEach(g=>(g.posts||[]).forEach(d=>{ const a=m[d.id]; if(a){ d.porque=a.porque||""; d.licao=a.licao||""; } }));
  }
  writeVaultDoc(bundle);
  fs.mkdirSync(DIR,{recursive:true});
  fs.writeFileSync(OUT, encrypt(bundle,PASS));
  console.log(`OK — estudo de mercado salvo (${radar.length} consultas · ${competitors.instagram.length+competitors.tiktok.length+competitors.youtube.length} concorrentes).`);
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main();
