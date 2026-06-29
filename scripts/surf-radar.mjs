#!/usr/bin/env node
/**
 * Radar de Surf (newsjack) — assuntos quentes das últimas 72h no Brasil que o Ednaldo
 * pode surfar em Reels, lidos pela lente de comportamento/gestão/liderança.
 * Tavily (notícias/tendências) + IA (filtro de surfabilidade + ângulos) → vault markdown.
 *
 * Secrets: TAVILY_API_KEY, ANTHROPIC_API_KEY, (opcional) APIFY_TOKEN, VAULT_DIR.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/* ---------- Tavily ---------- */
async function tavily(query,{topic="general",days=3,max=6,domains=null}={}){
  const key=process.env.TAVILY_API_KEY; if(!key) return null;
  try{
    const body={api_key:key,query,search_depth:"advanced",max_results:max,include_answer:true,topic};
    if(topic==="news") body.days=days;
    if(domains&&domains.length) body.include_domains=domains;
    const r=await fetch("https://api.tavily.com/search",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    const j=await r.json(); if(j.error||j.detail) throw new Error(JSON.stringify(j.error||j.detail));
    return {q:query,answer:j.answer||"",results:(j.results||[]).map(x=>({title:x.title,url:x.url,content:(x.content||"").slice(0,400),published:x.published_date||null}))};
  }catch(e){ console.error(`Tavily "${query.slice(0,40)}…": ${e.message}`); return {q:query,answer:"",results:[],erro:e.message}; }
}
const BR=["g1.globo.com","ge.globo.com","gshow.globo.com","folha.uol.com.br","estadao.com.br","uol.com.br","cnnbrasil.com.br","infomoney.com.br","exame.com","valor.globo.com","metropoles.com","oglobo.globo.com","terra.com.br","veja.abril.com.br","band.uol.com.br"];
const QUERIES=[
  {q:"assuntos mais comentados, virais e polêmicas em alta no Brasil esta semana",topic:"news",domains:BR},
  {q:"empresas e mercado no Brasil: demissões, aquisições, escândalos, falências, casos de gestão e liderança",topic:"news",domains:BR},
  {q:"repercussão do esporte no Brasil esta semana: futebol, seleção, técnicos e atletas",topic:"news",domains:BR},
  {q:"famosos, novela, BBB, cultura pop e celebridades em alta no Brasil esta semana",topic:"news",domains:BR},
  {q:"debates sobre trabalho, liderança, geração Z, home office e gestão de pessoas no Brasil",topic:"general"},
  {q:"o que está em alta no Google Trends Brasil e trending topics do Twitter Brasil hoje",topic:"general"},
];

/* ---------- Apify (trends — opcional, best-effort) ---------- */
async function apifyTrends(){
  const token=process.env.APIFY_TOKEN; if(!token) return [];
  const actor=process.env.SURF_TRENDS_ACTOR; if(!actor) return []; // só roda se configurado explicitamente
  try{
    const url=`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=120`;
    const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({geo:"BR",country:"BR"})});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const j=await r.json(); const items=Array.isArray(j)?j:(j.items||[]);
    const terms=items.map(x=>x.title||x.query||x.term||x.name||x.keyword).filter(Boolean).slice(0,25);
    console.log(`Apify trends: ${terms.length} termo(s).`);
    return terms;
  }catch(e){ console.error("Apify trends (best-effort) falhou:",e.message); return []; }
}

/* ---------- Contexto (voz/método) ---------- */
function loadContext(){
  const dir=process.env.VAULT_DIR;
  const files=["CLAUDE.md","Estudo para modelar conteudo/REGRAS — Copy Humanizada e Vitrine que Vende.md","Fichas/FICHA — METODO MAMAN CONTEUDO VIRAL.md"];
  if(dir && fs.existsSync(dir)){ const out=[]; let total=0;
    for(const f of files){ try{ let t=fs.readFileSync(path.join(dir,f),"utf8"); if(t.length>6000)t=t.slice(0,6000)+"\n…"; if(total+t.length>30000)break; total+=t.length; out.push(`\n\n===== ${f} =====\n${t}`);}catch{} }
    if(out.length){ console.log(`Contexto: ${out.length} arquivo(s) do vault ao vivo.`); return out.join(""); } }
  return "";
}

/* ---------- IA (filtro de surfabilidade + formato) ---------- */
// Recupera os temas caso o modelo vaze a sintaxe da ferramenta no texto (temas chega vazio).
function recoverTemas(input,content){
  if(Array.isArray(input.temas)&&input.temas.length) return input;
  const hay=(input.resumo||"")+"\n"+((content||[]).map(b=>b.text||"").join("\n"));
  const m=hay.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if(m){ try{ input.temas=JSON.parse(m[0]); }catch{} }
  if(input.resumo) input.resumo=input.resumo.split(/<\/?parameter|\[\s*\{/)[0].replace(/<[^>]*>/g,"").trim();
  return input;
}
async function aiRadar(radar,trends){
  const key=process.env.ANTHROPIC_API_KEY; if(!key){ console.error("Sem ANTHROPIC_API_KEY."); return null; }
  const model=process.env.AI_MODEL||"claude-opus-4-8";
  const contexto=loadContext();
  const dossie={ buscas:radar.map(r=>({tema:r.q,resposta:r.answer,fontes:(r.results||[]).map(x=>({titulo:x.title,url:x.url,trecho:x.content,data:x.published}))})),
    trends_apify:trends };
  const system=`${contexto}\n\nVocê é o RADAR DE SURF do Ednaldo Henper — cientista do comportamento e estrategista de negócios (NUNCA "coach"). Público: donos de pequenas e médias empresas, sobrecarregados, que centralizam tudo e vivem apagando incêndio. Você gera os assuntos quentes da semana que ele pode surfar em Reels para VIRALIZAR (newsjack), lendo cada acontecimento pela lente de COMPORTAMENTO, GESTÃO e LIDERANÇA.
FILTRO DE SURFABILIDADE: só entram acontecimentos que conectam de forma HONESTA com comportamento, gestão, liderança, equipe, decisão ou dependência do dono. Descarte o que não tem ponte natural — não force. Melhor 5 ótimos que 20 fracos.
REGRAS: Português do Brasil. NÃO invente fatos nem números — cada tema precisa de uma fonte REAL e recente vinda das buscas (use a URL real). NÃO glorificar o sofrimento do empresário (ângulo morto). Voz direta, sem "não é X, é Y" repetido, sem emoji decorativo, vende o destino. Acontecimento sensível (tragédia, morte, política partidária pesada): marque Surfabilidade "Baixa" e explique o risco no campo risco — nunca force humor ou oportunismo.`;
  const instr=`As buscas JÁ FORAM EXECUTADAS pelo robô e os resultados REAIS (com URLs verdadeiras) estão no bloco DADOS abaixo. Você NÃO precisa e NÃO deve buscar nada nem dizer que não tem acesso — apenas SELECIONE e INTERPRETE os acontecimentos que já estão em DADOS. Use SOMENTE URLs que aparecem em DADOS.
Gere ATÉ 8 temas surfáveis, ordenados por potencial viral (maior primeiro). Registre chamando a ferramenta responder.
Para cada tema: acontecimento (1 linha), quente_porque (por que está em alta + sinal de volume: manchetes/repercussão), janela (quente até quando — ex: 48h, fim de semana), angulo (a leitura de gestão/comportamento do Ednaldo, 1-2 frases), gancho (frase de abertura de 2 segundos, pronta pra gravar), surfabilidade (Alta|Média|Baixa), palavra_chave (palavra do Direct, ex: MAESTRO, DIAGNÓSTICO), fonte (uma URL EXATA copiada de DADOS), risco (só se sensível).
Se um acontecimento não tiver ponte honesta com comportamento/gestão/liderança, descarte-o. Se realmente nenhum dos resultados em DADOS for surfável, devolva temas:[] e explique no resumo — mas isso é raro, quase sempre há ângulo.
DADOS (resultados reais das buscas — escolha daqui):
${JSON.stringify(dossie).slice(0,120000)}`;
  const tema={type:"object",properties:{
    acontecimento:{type:"string"},quente_porque:{type:"string"},janela:{type:"string"},
    angulo:{type:"string"},gancho:{type:"string"},
    surfabilidade:{type:"string",enum:["Alta","Média","Baixa"]},
    palavra_chave:{type:"string"},fonte:{type:"string"},risco:{type:"string"}},
    required:["acontecimento","quente_porque","janela","angulo","gancho","surfabilidade","palavra_chave","fonte"]};
  const schema={type:"object",properties:{resumo:{type:"string"},temas:{type:"array",items:tema}},required:["resumo","temas"]};
  try{
    const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",
      headers:{"content-type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({model,max_tokens:8000,system,
        tools:[{name:"responder",description:"Registra o radar de surf.",input_schema:schema}],
        tool_choice:{type:"tool",name:"responder"},
        messages:[{role:"user",content:instr}]})});
    const j=await res.json(); if(j.error) throw new Error(j.error.message||JSON.stringify(j.error));
    const tu=(j.content||[]).find(b=>b.type==="tool_use"); if(!tu||!tu.input) throw new Error("sem tool_use");
    const out=recoverTemas({...tu.input},j.content);
    console.log(`Radar gerado pela IA (${model}): ${(out.temas||[]).length} tema(s).`);
    return {model,...out};
  }catch(e){ console.error("Falha na IA do radar:",e.message); return null; }
}

/* ---------- Markdown ---------- */
function dominio(u){ try{ return new URL(u).hostname.replace(/^www\./,""); }catch{ return "fonte"; } }
function buildMd(ai,radar){
  const dataBR=new Date().toLocaleDateString("pt-BR");
  const L=[];
  L.push(`---\ntags: [instagram, newsjack, radar, surf, auto]\ngerado: ${new Date().toISOString()}\ntipo: radar-surf-auto\n---\n`);
  L.push(`# 🔥 Radar de Surf — Assuntos Quentes da Semana\n`);
  const temas=(ai&&ai.temas)||[];
  L.push(`> ${ai?.resumo?ai.resumo+" — ":""}${temas.length} tema(s) · ${dataBR}. Pegue os de **Surfabilidade Alta** e transforme em roteiro enquanto está quente.\n`);
  if(!temas.length){
    L.push(`_A IA não retornou temas surfáveis nesta rodada. Manchetes captadas (brutas):_\n`);
    radar.forEach(r=>(r.results||[]).slice(0,3).forEach(x=>L.push(`- [${(x.title||x.url||"").replace(/\n/g," ")}](${x.url})`)));
  }
  temas.forEach(t=>{
    L.push(`### 🔥 ${t.acontecimento}`);
    L.push(`- **Quente porque:** ${t.quente_porque||"—"}`);
    L.push(`- **Janela:** ${t.janela||"—"}`);
    L.push(`- **Ângulo comportamental:** ${t.angulo||"—"}`);
    L.push(`- **Gancho (2 seg):** "${(t.gancho||"").replace(/^"+|"+$/g,"")}"`);
    L.push(`- **Surfabilidade:** ${t.surfabilidade||"—"}`);
    L.push(`- **Palavra-chave Direct:** ${t.palavra_chave||"—"}`);
    if(t.risco) L.push(`- **Risco:** ${t.risco}`);
    L.push(`- **Fonte:** [${dominio(t.fonte)}](${t.fonte})`);
    L.push("");
  });
  L.push(`---\n*Gerado automaticamente pelo Radar de Surf (Tavily + IA). Janela: últimas 72h. Não editar à mão — é sobrescrito a cada rodada.*`);
  return L.join("\n")+"\n";
}

async function main(){
  const radar=[];
  for(const it of QUERIES) radar.push(await tavily(it.q,{topic:it.topic,domains:it.domains}));
  const got=radar.reduce((s,r)=>s+((r&&r.results)?r.results.length:0),0);
  console.log(`Radar (Tavily): ${radar.length} buscas · ${got} resultado(s).`);
  const trends=await apifyTrends();
  const ai=await aiRadar(radar,trends);
  const md=buildMd(ai,radar);
  const dir=process.env.VAULT_DIR;
  if(dir && fs.existsSync(dir)){
    const p=path.join(dir,"Geração de Demanda","Instagram","Dados & Inteligência"); fs.mkdirSync(p,{recursive:true});
    fs.writeFileSync(path.join(p,"Radar de Surf (auto).md"),md);
    console.log(`Radar escrito no vault: Geração de Demanda/Instagram/Dados & Inteligência/Radar de Surf (auto).md (${md.length} chars · ${(ai&&ai.temas||[]).length} temas).`);
  } else {
    console.error("VAULT_DIR ausente — radar não gravado.");
    process.exitCode=1;
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main();
