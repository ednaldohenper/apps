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
async function api(token, p){
  const sep=p.includes("?")?"&":"?";
  const r=await fetch(`${API}/${p}${sep}access_token=${encodeURIComponent(token)}`);
  const j=await r.json();
  if(j.error) throw new Error(j.error.message||JSON.stringify(j.error));
  return j;
}
function accMetric(d,n){ return (d?.data||[]).find(x=>x.name===n)?.total_value?.value ?? null; }
async function acc28One(token,name){ // 28 dias, métrica a métrica (uma falha não derruba as outras)
  const j=await api(token,`${IG_ID}/insights?metric=${name}&period=days_28&metric_type=total_value`).catch(()=>null);
  const v=j?.data?.[0]?.total_value?.value;
  return v==null?null:{name,total_value:{value:v}};
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
  }catch(e){ console.error("Falha ao renovar token:",e.message); }
  return token;
}

/* ---------- Coleta ---------- */
function parsePost(p){
  const ins={}; (p.insights?.data||[]).forEach(m=>ins[m.name]=m.values?.[0]?.value ?? 0);
  return {id:p.id,cap:(p.caption||"").replace(/\s+/g," ").slice(0,160),
    type:p.media_product_type||p.media_type,link:p.permalink,ts:p.timestamp,cover:coverOf(p),
    reach:ins.reach||0,views:ins.views||0,inter:ins.total_interactions||0,
    saves:ins.saved||0,shares:ins.shares||0,likes:p.like_count||0,comments:p.comments_count||0};
}

async function main(){
  IG_ID=need("IG_ID"); PASS=need("DASH_PASSWORD");
  APP_ID=process.env.FB_APP_ID||""; APP_SECRET=process.env.FB_APP_SECRET||"";
  let token=loadToken();
  if(!token){ console.error("Sem token. Defina o secret IG_TOKEN na 1ª execução."); process.exit(1); }
  token=await refresh(token);
  saveToken(token);

  const profile=await api(token,`${IG_ID}?fields=username,name,followers_count,follows_count,media_count,profile_picture_url,biography`);
  const accDay =await api(token,`${IG_ID}/insights?metric=reach,profile_views,accounts_engaged,total_interactions,likes,comments,saves,shares,views&period=day&metric_type=total_value`).catch(()=>null);
  const acc28parts=await Promise.all(["reach","views","total_interactions"].map(m=>acc28One(token,m)));
  const acc28={data:acc28parts.filter(Boolean)};
  const mediaR =await api(token,`${IG_ID}/media?fields=id,caption,media_type,media_product_type,timestamp,permalink,media_url,thumbnail_url,like_count,comments_count,children{media_url,thumbnail_url,media_type},insights.metric(reach,views,total_interactions,saved,shares)&limit=50`).catch(()=>({data:[]}));
  const media=(mediaR.data||[]).map(parsePost);
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

  const bundle={ updated:new Date().toISOString(), profile, accDay, acc28, media, demo:demoData, history };
  fs.mkdirSync(DIR,{recursive:true});
  fs.writeFileSync(DATA, encrypt(bundle,PASS));
  console.log(`OK — ${profile.username}: ${profile.followers_count} seguidores · ${Object.keys(history).length} dia(s) no histórico.`);
}

// export para testes
export { encrypt, decrypt };
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main();
