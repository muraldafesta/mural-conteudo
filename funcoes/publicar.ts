// Edge Function "publicar" — Mural da Festa
// Publica no Instagram (API com login do Instagram) os posts aprovados cuja hora chegou.
// Chamada pelo cron a cada 5 min (corpo vazio) e pelo app:
//   { acao: "agora", post_id }   -> antecipa um post aprovado (exige membro logado)
//   { acao: "conectar", token }  -> grava o token do Instagram (exige admin logado)
// Configuração: desligar "Verify JWT" desta função (o cron chama sem login).
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const CHAVE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(URL_SB, CHAVE, { auth: { persistSession: false } });
const HOSTS: Record<string, string> = { ig: "https://graph.instagram.com/v21.0", fb: "https://graph.facebook.com/v21.0" };
let IG = HOSTS.ig;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const resp = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function quem(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  if (!jwt) return null;
  const { data } = await db.auth.getUser(jwt);
  const email = data?.user?.email?.toLowerCase();
  if (!email) return null;
  const { data: m } = await db.from("membros").select("*").eq("email", email).maybeSingle();
  return m;
}

async function ig(path: string, params: Record<string, string>, metodo = "POST") {
  const qs = new URLSearchParams(params);
  const r = await fetch(`${IG}/${path}` + (metodo === "GET" ? `?${qs}` : ""), {
    method: metodo,
    body: metodo === "POST" ? qs : undefined,
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.error_user_msg || j.error.message || JSON.stringify(j.error));
  return j;
}

async function conexao() {
  const { data } = await db.from("instagram_conexao").select("*").eq("id", 1).maybeSingle();
  if (!data?.token) throw new Error("Instagram ainda não conectado.");
  IG = HOSTS[data.api || "ig"];
  // Token do login do Instagram vale 60 dias: renova uma vez por semana.
  // Token de usuário do sistema (login unificado/Facebook) não expira.
  const velho = (data.api || "ig") === "ig" && (!data.renovado_em || Date.now() - new Date(data.renovado_em).getTime() > 7 * 864e5);
  if (velho) {
    try {
      const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${data.token}`);
      const j = await r.json();
      if (j.access_token) {
        data.token = j.access_token;
        await db.from("instagram_conexao").update({ token: j.access_token, renovado_em: new Date().toISOString() }).eq("id", 1);
      }
    } catch (_) { /* segue com o token atual */ }
  }
  return data as { ig_user_id: string; token: string };
}

const ehVideo = (u: string) => /\.(mp4|mov)(\?|$)/i.test(u);

async function criarContainer(c: { ig_user_id: string; token: string }, p: any) {
  const base: Record<string, string> = { access_token: c.token };
  const m: string[] = p.midia;
  if (p.tipo === "reel") {
    return (await ig(`${c.ig_user_id}/media`, { ...base, media_type: "REELS", video_url: m[0], caption: p.legenda || "", share_to_feed: "true" })).id;
  }
  if (p.tipo === "story") {
    const k = ehVideo(m[0]) ? { video_url: m[0] } : { image_url: m[0] };
    return (await ig(`${c.ig_user_id}/media`, { ...base, media_type: "STORIES", ...k })).id;
  }
  if (p.tipo === "foto") {
    return (await ig(`${c.ig_user_id}/media`, { ...base, image_url: m[0], caption: p.legenda || "" })).id;
  }
  // carrossel
  const filhos: string[] = [];
  for (const u of m.slice(0, 10)) {
    const k = ehVideo(u) ? { media_type: "VIDEO", video_url: u } : { image_url: u };
    filhos.push((await ig(`${c.ig_user_id}/media`, { ...base, is_carousel_item: "true", ...k })).id);
  }
  for (const f of filhos) await esperar(c, f, 60);
  return (await ig(`${c.ig_user_id}/media`, { ...base, media_type: "CAROUSEL", children: filhos.join(","), caption: p.legenda || "" })).id;
}

// Espera o Instagram processar o vídeo. true = pronto; false = ainda processando.
async function esperar(c: { token: string }, container: string, segundos: number) {
  const fim = Date.now() + segundos * 1000;
  while (true) {
    const s = await ig(container, { fields: "status_code,status", access_token: c.token }, "GET");
    if (s.status_code === "FINISHED") return true;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error("Instagram recusou a mídia: " + (s.status || s.status_code));
    if (Date.now() > fim) return false;
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function publicarUm(c: { ig_user_id: string; token: string }, p0: any) {
  // Reserva o post (evita que duas rodadas publiquem o mesmo)
  const limite = new Date(Date.now() - 3 * 60000).toISOString();
  const { data: rs } = await db.from("decisoes")
    .update({ status: "publicando", tocado_em: new Date().toISOString() })
    .eq("post_id", p0.post_id)
    .or(`status.eq.aprovado,and(status.eq.publicando,tocado_em.lt.${limite})`)
    .select();
  if (!rs?.length) return { post_id: p0.post_id, situacao: "em andamento" };
  const p = rs[0];
  try {
    let container = p.ig_container;
    if (!container) {
      container = await criarContainer(c, p);
      await db.from("decisoes").update({ ig_container: container, tentativas: p.tentativas + 1, erro: null }).eq("post_id", p.post_id);
    }
    const pronto = await esperar(c, container, 55);
    if (!pronto) { // termina numa próxima rodada
      await db.from("decisoes").update({ tocado_em: new Date(Date.now() - 4 * 60000).toISOString() }).eq("post_id", p.post_id);
      return { post_id: p.post_id, situacao: "processando" };
    }
    const pub = await ig(`${c.ig_user_id}/media_publish`, { access_token: c.token, creation_id: container });
    let link = null;
    try { link = (await ig(pub.id, { fields: "permalink", access_token: c.token }, "GET")).permalink; } catch (_) { /* story não tem link fixo */ }
    await db.from("decisoes").update({ status: "publicado", ig_media_id: pub.id, ig_link: link, publicado_em: new Date().toISOString(), erro: null }).eq("post_id", p.post_id);
    return { post_id: p.post_id, situacao: "publicado", link };
  } catch (e) {
    const msg = String((e as Error).message || e);
    const desistir = (p.tentativas + 1) >= 3;
    await db.from("decisoes").update({
      status: desistir ? "erro" : "aprovado", ig_container: null, tentativas: p.tentativas + (p.ig_container ? 0 : 1), erro: msg,
    }).eq("post_id", p.post_id);
    return { post_id: p.post_id, situacao: "erro", erro: msg };
  }
}


// Aprovação automática (pedido do Luciano em 18/11/2026): post que está nos lotes e
// ninguém decidiu é aprovado sozinho 30 min antes do horário. Recusar no app antes disso impede.
const SITE = "https://muraldafesta.github.io/mural-conteudo/";
async function autoAprovar() {
  try {
    const idx = await (await fetch(SITE + "lotes/index.json", { cache: "no-store" })).json();
    const agora = Date.now();
    for (const nome of (idx.lotes || []).slice(-10)) {
      const l = await (await fetch(SITE + "lotes/" + nome, { cache: "no-store" })).json();
      for (const p of l.posts || []) {
        const t = Date.parse(p.horario);
        if (!(t - agora <= 30 * 60000 && t > agora - 6 * 3600000)) continue;
        const { data: ja } = await db.from("decisoes").select("post_id").eq("post_id", p.id).maybeSingle();
        if (ja) continue;
        await db.from("decisoes").insert({
          post_id: p.id, lote: l.data, tipo: p.tipo, titulo: p.titulo || null, legenda: p.legenda || "",
          midia: (p.midia || []).map((u: string) => new URL(u, SITE).href),
          agendado_para: new Date(t).toISOString(), status: "aprovado", decidido_por: "automatico",
        });
      }
    }
  } catch (_) { /* segue sem travar a publicação */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let corpo: any = {};
  try { corpo = await req.json(); } catch (_) { /* vazio */ }

  if (corpo.acao === "conectar") {
    const m = await quem(req);
    if (m?.papel !== "admin") return resp({ erro: "Só administrador conecta o Instagram." }, 403);
    try {
      let api = "ig", igId = "", usuario = "";
      try {
        IG = HOSTS.ig;
        const me = await ig("me", { fields: "user_id,username", access_token: corpo.token }, "GET");
        igId = String(me.user_id || me.id); usuario = me.username;
      } catch (_) {
        // Login unificado (Facebook): acha a conta do Instagram ligada às Páginas que o token enxerga
        api = "fb"; IG = HOSTS.fb;
        const contas = await ig("me/accounts", { fields: "name,instagram_business_account{id,username}", access_token: corpo.token }, "GET");
        const achou = (contas.data || []).map((p: any) => p.instagram_business_account).filter(Boolean);
        const escolhida = achou.find((a: any) => a.username === "muraldafesta") || achou[0];
        if (!escolhida) throw new Error("o token não tem acesso a nenhuma conta do Instagram. Dê ao usuário do sistema acesso à Página e ao Instagram do Mural.");
        igId = String(escolhida.id); usuario = escolhida.username;
      }
      await db.from("instagram_conexao").upsert({
        id: 1, api, ig_user_id: igId, usuario, token: corpo.token,
        renovado_em: new Date().toISOString(), atualizado_em: new Date().toISOString(),
      });
      return resp({ ok: true, usuario });
    } catch (e) {
      return resp({ erro: "Token não aceito pelo Instagram: " + (e as Error).message }, 400);
    }
  }

  if (!corpo.acao) await autoAprovar();
  let filtro = db.from("decisoes").select("*");
  if (corpo.acao === "agora") {
    const m = await quem(req);
    if (!m) return resp({ erro: "Entre no app para publicar." }, 403);
    await db.from("decisoes").update({ agendado_para: new Date().toISOString() }).eq("post_id", corpo.post_id).eq("status", "aprovado");
    filtro = filtro.eq("post_id", corpo.post_id);
  }
  const { data: fila, error } = await filtro
    .in("status", ["aprovado", "publicando"])
    .lte("agendado_para", new Date().toISOString())
    .order("agendado_para")
    .limit(2);
  if (error) return resp({ erro: error.message }, 500);
  if (!fila?.length) return resp({ ok: true, publicados: [] });

  let c;
  try { c = await conexao(); } catch (e) { return resp({ erro: (e as Error).message }, 400); }
  const res = [];
  for (const p of fila) res.push(await publicarUm(c, p));
  return resp({ ok: true, publicados: res });
});
