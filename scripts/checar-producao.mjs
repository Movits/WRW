// Exame de saúde de produção: confirma em um comando que o site no ar está
// inteiro depois de um deploy. Roda uma bateria de checagens reais contra a
// aplicação e o banco usando DUAS contas QA que ele mesmo cria e apaga
// (qa_exame_presidente e qa_exame_prata), com login de verdade por e-mail e
// senha. Nunca usa a conta de uma pessoa real e nunca imprime dado que venha do
// servidor (nomes, e-mails, textos): só contagens, status HTTP e nomes de chaves.
//
// Uso (a partir da raiz do repositório; o caminho de --env é relativo ao diretório atual):
//   node scripts/checar-producao.mjs --env .env.producao            # bateria padrão
//   node scripts/checar-producao.mjs --env .env.producao --com-ia   # inclui FAQ e Memória (gasta cota)
//   node scripts/checar-producao.mjs --env .env.producao --somente-faxina   # só apaga resíduos QA
//   Git Bash:    EXAME_BASE_URL=http://localhost:3000 node scripts/checar-producao.mjs --env .env.local
//   PowerShell:  $env:EXAME_BASE_URL="http://localhost:3000"; node scripts/checar-producao.mjs --env .env.local
//
// Requisitos: um arquivo de ambiente com DATABASE_URL do banco examinado. Sem --env,
// lê .env.producao se existir, senão .env (e avisa: o .env de trabalho não deveria
// carregar segredo de produção). JWT_SECRET NÃO é necessário: o exame não forja
// sessão. EXAME_BASE_URL (variável de ambiente vence o arquivo) aponta o site;
// padrão https://mmm-gud5.onrender.com.
//
// Saída: uma linha por checagem (OK, FALHA, PULADO, ALERTA, LIMITE, INFO, EXCECAO,
// LIMPEZA COM ERRO) e um resumo final. Código de saída 0 SÓ se nada reprovou: falha
// (ALERTA conta como falha), exceção no meio, limite de requisições (429)
// persistente ou erro de limpeza devolvem 1. PULADO quer dizer "não foi possível
// provar" (ex.: sem termo do Smart Match publicado) e é repetido no resumo como NÃO
// PROVADO. Em --somente-faxina o ALERTA de órfão é informativo (achar resíduo é o
// serviço desse modo): só erro de limpeza ou exceção devolvem 1.
//
// Efeitos colaterais conhecidos (declarados de propósito):
// - Até 2 chamadas de IA por execução mesmo sem --com-ia: o compliance na criação da
//   oportunidade QA, sempre; o alerta de compatibilidade só quando a oportunidade é
//   aprovada (não nasce rejeitada pelo compliance) E há ao menos uma conta Ouro/
//   presidente/admin REAL com perfil, e o prompt dele leva setor/possui/procura
//   dessas contas ao Gemini. O exame imprime esse número como INFO antes de criar.
// - O Smart Match tenta um e-mail para o endereço .invalid da conta QA; o servidor não o
//   manda à Resend (TLD reservado, nunca entrega), então não há envio nem devolução.
// - O contato QA fica marcado 'ouro' por poucos segundos; a oportunidade QA
//   (confidencial, ativa) fica visível para contas Ouro reais até o fim da
//   execução: dezenas de segundos, mais de dois minutos com --com-ia ou quando a
//   sondagem do alerta espera os 120 s.
// - As linhas GOLD_ACERVO_READ e REVOKED_SESSION_ACCESS_ATTEMPT das contas QA ficam
//   na trilha de auditoria (decisão do Roberto, 02/09/2026); o resto do ruído sai.
// - Os routers de rede/contextos devolvem HTTP 500 com "NOT_FOUND" para contato de
//   outra dona (dívida conhecida); o exame aceita exatamente isso, não "qualquer erro".
// - Não rode do mesmo IP de saída de quem está usando o site: o limite da API é por
//   IP (100 req/min) e o exame consome ~70 dele.

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";
import { parse as analisarEnv } from "dotenv";
import { Relatorio, Ritmo, avaliar, avaliarNegativa, avaliarTermoGeralVigente, avaliarRedirecionamentoComCache } from "./exame/relatorio.mjs";
import { planejarLimpeza, planejarFaxinaDuravel, planejarColetaDeConexoes } from "./exame/limpeza.mjs";

// ── Argumentos e ambiente ────────────────────────────────────────────────────
const AQUI = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const COM_IA = args.includes("--com-ia");
const SOMENTE_FAXINA = args.includes("--somente-faxina");
const posEnv = args.indexOf("--env");
const arquivoEnv = posEnv >= 0 ? args[posEnv + 1] : (existsSync(".env.producao") ? ".env.producao" : ".env");
if (posEnv >= 0 && !arquivoEnv) {
  console.error("Uso: node scripts/checar-producao.mjs --env <arquivo> [--com-ia] [--somente-faxina]");
  process.exit(2);
}
if (!existsSync(arquivoEnv)) {
  console.error(`Arquivo de ambiente não encontrado: ${arquivoEnv} (o caminho é relativo ao diretório atual; rode da raiz).`);
  process.exit(2);
}
const env = analisarEnv(readFileSync(arquivoEnv));
const DATABASE_URL = env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(`${arquivoEnv} precisa de DATABASE_URL (a do banco examinado). JWT_SECRET não é mais necessário.`);
  process.exit(2);
}
const BASE = (process.env.EXAME_BASE_URL || env.EXAME_BASE_URL || "https://mmm-gud5.onrender.com").replace(/\/$/, "");

// ── Constantes do exame ──────────────────────────────────────────────────────
const PREFIXO_QA = "qa_exame";
const QA = {
  P: { openId: "qa_exame_presidente", email: "qa-exame-presidente@exame.invalid", nome: "Exame QA Presidente", role: "president" },
  S: { openId: "qa_exame_prata", email: "qa-exame-prata@exame.invalid", nome: "Exame QA Prata", role: "silver" },
};
const OPENIDS_LEGADOS = ["qa_exame_de_saude"]; // conta QA do exame antigo, caso tenha sobrado
const CIDADE_QA = "Cidade Exame QA";
// O compliance por IA classifica toda oportunidade nova; um texto que se declara
// "não real" foi marcado como red (nasce rejeitada) e o bloco inteiro virou PULADO.
// A descrição precisa parecer uma parceria comum e documentada, e ainda dizer que
// é registro automático do exame, apagado ao final.
const EXAME_TITULO_OPP = "Exame de saúde de produção: parceria de distribuição de vinhos";
const EXAME_DESCRICAO_OPP = "Parceria de distribuição entre uma vinícola exportadora e uma importadora, com contrato, notas fiscais e certificados sanitários já disponíveis para análise. Registro automático do exame de saúde da plataforma, usado só para conferir a visibilidade por nível de acesso e apagado ao final da execução.";
const RAZAO_GRANT = "Concessão automática do exame de saúde de produção.";
const RAZAO_REVOKE = "Revogação automática do exame de saúde de produção.";
// PNG transparente de 1x1 (68 bytes): o menor upload válido para o storage.
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const CHAVES_PESSOAIS = ["phone", "whatsapp", "email", "linkedinUrl", "instagram", "photoUrl", "cardImageUrl", "notes", "ownerId", "id"];
const CHAVES_VITRINE = new Set(["contatoRef", "country", "city", "possui", "procura"]);

// Regras de resposta negativa aceitas (status, mensagem, código tRPC).
const SEM_SESSAO = s => s === 401;
const BARRADO_OURO = (s, e) => s === 403 && /Ouro|restrit/i.test(e);
const NAO_ENCONTRADO = (s, e) => s === 404 || (s === 500 && e === "NOT_FOUND");
const SEM_CONSENTIMENTO = (s, e) => s === 403 && /SMART_MATCH_CONSENT_REQUIRED/.test(e);

const rel = new Relatorio();
const ritmo = new Ritmo();
const dormir = ms => new Promise(r => setTimeout(r, ms));

/** Interrupção controlada: registra o motivo e cai na limpeza, sem virar EXCECAO. */
class Parada extends Error {}

// Tudo que o exame cria, para a limpeza saber o que apagar mesmo se algo falhar no meio.
const estado = {
  ids: [], openIds: [], emails: [], oppIds: [],
  contatos: { P: [], S: [] }, contextos: [],
  sessao: { P: null, S: null }, elegiveisAoAlerta: 0, oportunidadeAprovada: false,
};

// ── Cliente HTTP do tRPC (uma requisição por procedure; sem batching de propósito:
//    o limite de 15 MB do upload casa pelo caminho exato) ───────────────────────
async function chamar(metodo, proc, input, cookie, tentativa = 0) {
  pararSeInterrompido();
  await ritmo.antes();
  const temInput = input !== undefined;
  const url = `${BASE}/api/trpc/${proc}` + (metodo === "GET" && temInput ? `?input=${encodeURIComponent(JSON.stringify({ json: input }))}` : "");
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (metodo === "POST") headers["content-type"] = "application/json";
  const r = await fetch(url, {
    method: metodo, headers,
    body: metodo === "POST" ? JSON.stringify(temInput ? { json: input } : {}) : undefined,
    signal: AbortSignal.timeout(45_000),
  });
  ritmo.depois(r.headers);
  if (r.status === 429 && tentativa === 0) {
    const espera = ritmo.esperaAposLimite();
    rel.info(`429 em ${proc}: esperando ${Math.ceil(espera / 1000)} s e tentando uma vez mais`);
    await dormir(espera);
    return chamar(metodo, proc, input, cookie, 1);
  }
  const corpo = await r.json().catch(() => null);
  return {
    status: r.status,
    dado: corpo?.result?.data?.json,
    erro: corpo?.error?.json?.message,
    codigo: corpo?.error?.json?.data?.code,
    setCookie: r.headers.get("set-cookie") || "",
  };
}
const sessao = cookie => ({
  cookie,
  get: (proc, input) => chamar("GET", proc, input, cookie),
  post: (proc, input) => chamar("POST", proc, input, cookie),
});
const cookieDe = resposta => {
  const m = /app_session_id=([^;]+)/.exec(resposta.setCookie || "");
  return m ? `app_session_id=${m[1]}` : null;
};

/** Checagem positiva: exige 200 e o predicado sobre o dado. Um 429 persistente vira LIMITE. */
function checar(nome, resposta, predicado, extra = "") {
  const j = avaliar(resposta, predicado);
  if (j.ok) return rel.ok(nome, true, extra);
  if (j.motivo === "limite") return rel.limite(nome, j.detalhe);
  return rel.falha(nome, j.detalhe || extra);
}
/** Checagem negativa: o servidor tem que barrar exatamente pelo motivo esperado. */
function checarNegativa(nome, resposta, regras) {
  const j = avaliarNegativa(resposta, regras);
  if (j.ok) return rel.ok(nome, true, j.detalhe);
  if (j.motivo === "limite") return rel.limite(nome, j.detalhe);
  return rel.falha(nome, j.detalhe);
}
function pararSeLimite() {
  if (rel.houveLimite) throw new Parada("limite de requisições: as checagens seguintes não rodaram");
}
const lista = d => (Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : Array.isArray(d?.matches) ? d.matches : []);
const chavesDe = obj => Object.keys(obj || {});

// ── Banco ────────────────────────────────────────────────────────────────────
let conn = null;
async function contar(sql, params = []) {
  const [[linha]] = await conn.query(sql, params);
  return Number(linha?.n ?? 0);
}
/** Ids de conexoes_registradas das QA colhidos pelas limpezas deste processo; a verificação confere que sumiram. */
const conexoesDoExame = new Set();

/**
 * Apaga tudo das contas QA indicadas. Idempotente; cada comando que falhar vira
 * LIMPEZA COM ERRO (e reprova). Linhas de terceiros que apontem para a QA só
 * contam e alertam.
 */
async function executarLimpeza(chaves) {
  let apagadas = 0;
  let alertasNaOportunidade = 0;
  // Ponteiro para objeto no bucket: se a API não conseguiu apagar o anexo, a linha
  // de context_media é a única referência ao arquivo no B2. Não apagar às cegas.
  let pularContextMedia = false;
  if (chaves.openIds.length) {
    const [midias] = await conn.query("SELECT `storage_path` FROM `context_media` WHERE `owner_id` IN (?)", [chaves.openIds]);
    if (midias.length) {
      pularContextMedia = true;
      for (const m of midias) rel.limpezaComErro(`objeto pode ter ficado no bucket: ${m.storage_path} (linha de context_media mantida como ponteiro)`);
    }
  }
  // Cabeçalho de conexoes_registradas ocupado só pelas QA: sem coluna de usuária, só
  // se acha pelos participantes, então a coleta vem antes de apagá-los. Se a coleta
  // ou o DELETE do cabeçalho falhar, os participantes ficam no banco: são a única
  // pista para a próxima faxina achar o cabeçalho.
  let manterParticipantesDeConexao = false;
  const coleta = planejarColetaDeConexoes(chaves);
  if (coleta) {
    try {
      const [linhas] = await conn.query(coleta.sql, coleta.params);
      chaves = { ...chaves, conexaoIds: linhas.map(l => l.id) };
      for (const id of chaves.conexaoIds) conexoesDoExame.add(id);
    } catch (e) {
      manterParticipantesDeConexao = true;
      rel.limpezaComErro(`${coleta.descricao}: ${e.code || e.message}`);
    }
  }
  const comandos = planejarLimpeza({ ...chaves, prefixoQa: PREFIXO_QA });
  // Duas passadas: primeiro CONTAR o que é de terceiros (alertar), depois apagar. A
  // decisão "esconder a oportunidade em vez de apagar" depende das contagens, e a
  // ordem do plano não pode decidir isso por acidente.
  for (const cmd of comandos.filter(c => c.acao === "alertar")) {
    try {
      const [[linha]] = await conn.query(cmd.sql, cmd.params);
      const n = Number(linha?.n ?? 0);
      if (n > 0) {
        rel.alerta(`limpeza: ${cmd.descricao}`, `${n} linha(s) de terceiros referenciam a conta ou a oportunidade QA; não apagadas`);
        if (cmd.descricao.includes("(opp)")) alertasNaOportunidade += n;
      }
    } catch (e) {
      rel.limpezaComErro(`${cmd.descricao}: ${e.code || e.message}`);
    }
  }
  for (const cmd of comandos.filter(c => c.acao === "apagar")) {
    if (pularContextMedia && cmd.descricao.startsWith("context_media.")) continue;
    if (manterParticipantesDeConexao && cmd.descricao.startsWith("conexoes_participantes.")) continue;
    try {
      if (alertasNaOportunidade > 0 && cmd.descricao.startsWith("opportunities.publishedBy")) continue; // tratada logo abaixo
      if (cmd.descricao.startsWith("opportunities.id") && alertasNaOportunidade > 0) {
        // Gente real interagiu com a oportunidade do exame: esconder em vez de apagar,
        // para um humano decidir com as linhas ainda no banco.
        const [res] = await conn.query("UPDATE `opportunities` SET `status` = 'removed' WHERE `id` IN (?)", [chaves.oppIds]);
        rel.alerta("limpeza: oportunidade QA marcada como 'removed' em vez de apagada", `${res.affectedRows} linha(s); há interesse/sala de conta real`);
        continue;
      }
      const [res] = await conn.query(cmd.sql, cmd.params);
      apagadas += Number(res.affectedRows || 0);
    } catch (e) {
      rel.limpezaComErro(`${cmd.descricao}: ${e.code || e.message}`);
      if (cmd.descricao.startsWith("conexoes_registradas.")) manterParticipantesDeConexao = true;
    }
  }
  for (const cmd of planejarFaxinaDuravel({ tituloDaOportunidade: EXAME_TITULO_OPP })) {
    try {
      const [res] = await conn.query(cmd.sql, cmd.params);
      apagadas += Number(res.affectedRows || 0);
    } catch (e) {
      rel.limpezaComErro(`${cmd.descricao}: ${e.code || e.message}`);
    }
  }
  return apagadas;
}

/** Descobre as contas QA que existem no banco (desta ou de execuções anteriores). */
async function chavesQaNoBanco() {
  const openIds = [QA.P.openId, QA.S.openId, ...OPENIDS_LEGADOS];
  const [contas] = await conn.query("SELECT `id`, `openId`, `email`, `createdAt` FROM `users` WHERE `openId` IN (?)", [openIds]);
  const ids = contas.map(c => c.id);
  // As chaves duráveis vêm das CONSTANTES, não do que sobrou em users: se uma execução
  // anterior apagou a conta e deixou linha para trás, a faxina ainda alcança tudo.
  const emails = [...new Set([QA.P.email, QA.S.email, ...contas.map(c => c.email).filter(Boolean)])];
  const [opps] = ids.length
    ? await conn.query("SELECT `id` FROM `opportunities` WHERE `title` = ? AND (`publishedBy` IN (?) OR `publishedBy` NOT IN (SELECT `id` FROM `users`))", [EXAME_TITULO_OPP, ids])
    : await conn.query("SELECT `id` FROM `opportunities` WHERE `title` = ? AND `publishedBy` NOT IN (SELECT `id` FROM `users`)", [EXAME_TITULO_OPP]);
  return { contas, chaves: { ids, openIds, emails, oppIds: opps.map(o => o.id) } };
}

async function faxinaDeAbertura() {
  const { contas, chaves } = await chavesQaNoBanco();
  if (contas.length) {
    const maisAntiga = Math.min(...contas.map(c => new Date(c.createdAt).getTime()));
    const minutos = Math.round((Date.now() - maisAntiga) / 60_000);
    rel.alerta("órfão de execução anterior", `${contas.length} conta(s) QA sobraram no banco (a mais antiga há ${minutos} min); apagando antes de começar`);
  }
  const apagadas = await executarLimpeza(chaves);
  rel.info(`faxina de abertura: ${apagadas} linha(s) removida(s)`);
}

async function verificarLimpeza() {
  const { chaves } = await chavesQaNoBanco();
  const openIdsTodos = [QA.P.openId, QA.S.openId, ...OPENIDS_LEGADOS];
  const restos = {
    users: chaves.ids.length,
    private_contacts: await contar("SELECT COUNT(*) n FROM `private_contacts` WHERE `ownerId` IN (?)", [openIdsTodos]),
    contexts: await contar("SELECT COUNT(*) n FROM `contexts` WHERE `owner_id` IN (?)", [openIdsTodos]),
    opportunities: await contar(
      "SELECT COUNT(*) n FROM `opportunities` WHERE `title` = ? AND `status` <> 'removed' AND (`publishedBy` IN (SELECT `id` FROM `users` WHERE `openId` LIKE ?) OR `publishedBy` NOT IN (SELECT `id` FROM `users`))",
      [EXAME_TITULO_OPP, `${PREFIXO_QA}%`],
    ),
    platform_notifications: await contar("SELECT COUNT(*) n FROM `platform_notifications` WHERE `body` LIKE ?", [`"${EXAME_TITULO_OPP}%`]),
    // Os participantes já saíram: o cabeçalho só é conferível pelos ids colhidos antes.
    conexoes_registradas: conexoesDoExame.size
      ? await contar("SELECT COUNT(*) n FROM `conexoes_registradas` WHERE `id` IN (?)", [[...conexoesDoExame]])
      : 0,
  };
  const sobras = Object.entries(restos).filter(([, n]) => n > 0);
  if (sobras.length) rel.limpezaComErro("sobrou dado do exame: " + sobras.map(([t, n]) => `${t}=${n}`).join(", "));
  else rel.ok(`limpeza verificada (users, private_contacts, contexts, opportunities, platform_notifications das QA = 0; ${conexoesDoExame.size} conexão(ões) registrada(s) do exame apagada(s))`, true);
}

// ── Blocos do exame ──────────────────────────────────────────────────────────

async function aquecer() {
  const inicio = Date.now();
  let ultimo = null;
  for (let tentativa = 1; tentativa <= 6; tentativa++) {
    try {
      const r = await fetch(BASE + "/", { signal: AbortSignal.timeout(20_000) });
      ultimo = { status: r.status, html: r.status === 200 ? await r.text() : "", headers: r.headers };
      if (r.status === 200) break;
    } catch (e) {
      ultimo = { status: 0, html: "", headers: new Headers(), erro: e.name };
    }
    if (tentativa < 6) await dormir(15_000);
  }
  const segundos = Math.round((Date.now() - inicio) / 1000);
  if (segundos > 5) rel.info(`instância acordou em ${segundos} s (o plano gratuito do Render hiberna)`);
  if (!rel.ok("site no ar", ultimo && ultimo.status === 200, ultimo ? `status ${ultimo.status}${ultimo.erro ? " " + ultimo.erro : ""}` : "")) {
    throw new Parada("site fora do ar: nada mais pode ser examinado");
  }
  return ultimo;
}

async function blocoInfra(home) {
  const bundle = (home.html.match(/assets\/index-[A-Za-z0-9_-]+\.js/) || [])[0];
  if (!bundle) rel.falha("assets com cache de 1 ano", "bundle não encontrado no HTML da página inicial");
  else {
    const asset = await fetch(`${BASE}/${bundle}`, { method: "HEAD", signal: AbortSignal.timeout(20_000) });
    rel.ok("assets com cache de 1 ano", /immutable/.test(asset.headers.get("cache-control") || ""));
  }
  // Sem no-cache no index.html, quem já abriu o site ficaria presa numa versão
  // antiga depois do deploy (o HTML antigo aponta para bundles que já não existem).
  rel.ok("index.html sem cache (Cache-Control: no-cache)", /no-cache/.test(home.headers.get("cache-control") || ""), home.headers.get("cache-control") || "sem cabeçalho");
  const csp = home.headers.get("content-security-policy") || "";
  const scriptSrc = (csp.split(";").map(d => d.trim()).find(d => d.startsWith("script-src ")) || "").replace(/^script-src\s+/, "");
  rel.ok("CSP estrita (script-src só 'self')", scriptSrc === "'self'", scriptSrc || "sem cabeçalho CSP");
  rel.ok("página de privacidade", (await fetch(BASE + "/privacidade", { signal: AbortSignal.timeout(20_000) })).status === 200);
  rel.ok("html declara pt-BR (tradutor do Chrome quieto)", /<html lang="pt-BR"/.test(home.html));

  // system.health é a checagem de banco desenhada para monitores: exige input.
  const saude = await chamar("GET", "system.health", { timestamp: Date.now() });
  if (saude.status === 503) {
    rel.falha("banco responde (system.health)", "503: banco fora do ar");
    throw new Parada("banco fora do ar segundo system.health");
  }
  if (saude.status !== 200) rel.falha("banco responde (system.health)", `status ${saude.status}: o exame chamou errado ou o servidor mudou, não é queda de banco`);
  else rel.ok("banco responde (system.health)", saude.dado?.ok === true);
  // O servidor expõe o SHA curto do commit que o Render construiu (RENDER_GIT_COMMIT):
  // compare com `git log -1 --oneline origin/main` para saber se o deploy já saiu.
  rel.info(`commit no ar: ${saude.dado?.commit ?? "não informado (versão anterior a esta checagem ou fora do Render)"}`);

  const stats = await chamar("GET", "stats.platform");
  checar("servidor enxerga o banco (stats.platform)", stats, d => (d?.users ?? 0) > 0);

  // Migrações: comparar o journal do repositório com a tabela _migracoes do banco
  // (migrar() em modo relatório devolve ok:true mesmo com pendência).
  const journal = JSON.parse((await readFile(join(AQUI, "..", "drizzle", "meta", "_journal.json"), "utf8")).replace(/^\uFEFF/, ""));
  const tags = journal.entries.map(e => e.tag);
  try {
    const [linhas] = await conn.query("SELECT `tag` FROM `_migracoes`");
    const aplicadas = new Set(linhas.map(l => l.tag));
    const pendentes = tags.filter(t => !aplicadas.has(t));
    rel.ok("migrações pendentes: nenhuma", pendentes.length === 0, pendentes.length ? `pendentes: ${pendentes.join(", ")}` : `${aplicadas.size} aplicada(s)`);
  } catch (e) {
    rel.falha("migrações pendentes: nenhuma", `sem tabela _migracoes legível: ${e.code || e.message}`);
  }

  // Sem Termo Geral vigente o cadastro novo não conclui (server/termo-geral-de-uso.ts).
  // Com a 0013 pendente o enum não tem o valor e a contagem dá 0: as duas FALHAs juntas.
  const termoGeral = avaliarTermoGeralVigente(
    await contar("SELECT COUNT(*) n FROM `document_versions` WHERE `type` = ? AND `isCurrent` = 1", ["termo_geral_de_uso"]),
  );
  rel.ok("Termo Geral de Uso vigente (sem ele nenhum cadastro novo conclui)", termoGeral.ok, termoGeral.detalhe);
}

async function blocoIdentidades() {
  rel.ok("banco tem usuárias", await contar("SELECT COUNT(*) n FROM `users`") > 0);
  const chefes = await contar("SELECT COUNT(*) n FROM `users` WHERE `role` IN ('president','admin') AND `openId` NOT LIKE ?", [`${PREFIXO_QA}%`]);
  const ouros = await contar("SELECT COUNT(*) n FROM `users` WHERE `role` = 'gold' AND `openId` NOT LIKE ?", [`${PREFIXO_QA}%`]);
  rel.ok("existe conta presidente ou admin real em produção", chefes > 0,
    chefes ? `${chefes} conta(s)` : `NENHUMA presidente/admin: ${ouros} conta(s) Ouro conseguem aprovar (presidentProcedure aceita gold) mas recebem 403 ao abrir oportunidade pendente`);
  const residuosContatos = await contar("SELECT COUNT(*) n FROM `private_contacts` WHERE `fullName` LIKE 'Exame %' AND `ownerId` NOT LIKE ?", [`${PREFIXO_QA}%`]);
  const residuosOpps = await contar("SELECT COUNT(*) n FROM `opportunities` WHERE `title` LIKE 'Exame de saúde%' AND `publishedBy` NOT IN (SELECT `id` FROM `users` WHERE `openId` LIKE ?)", [`${PREFIXO_QA}%`]);
  if (residuosContatos || residuosOpps) rel.info(`resíduos de exames antigos em contas REAIS (não apagados; decida à mão): ${residuosContatos} contato(s), ${residuosOpps} oportunidade(s)`);

  pararSeInterrompido();
  for (const papel of ["P", "S"]) {
    const conta = QA[papel];
    conta.senha = randomBytes(24).toString("base64url");
    const hash = await bcrypt.hash(conta.senha, 12);
    const [ins] = await conn.query(
      "INSERT INTO `users` (`openId`, `name`, `email`, `passwordHash`, `role`, `loginMethod`, `isActive`, `emailVerified`, `onboardingCompleted`) VALUES (?, ?, ?, ?, ?, 'email', 1, 1, 1)",
      [conta.openId, conta.nome, conta.email, hash, conta.role],
    );
    conta.id = ins.insertId;
    estado.ids.push(conta.id);
    estado.openIds.push(conta.openId);
    estado.emails.push(conta.email);
  }
  rel.ok("contas QA criadas (presidente e prata, senha aleatória, hash bcrypt)", estado.ids.length === 2);
}

async function blocoAutenticacao() {
  const errado = await chamar("POST", "auth.login", { email: QA.S.email, password: QA.S.senha + "x" });
  checarNegativa("senha errada é recusada", errado, [SEM_SESSAO]);

  for (const papel of ["P", "S"]) {
    const conta = QA[papel];
    const r = await chamar("POST", "auth.login", { email: conta.email, password: conta.senha });
    const cookie = cookieDe(r);
    const ok = checar(`login com e-mail e senha (${papel === "P" ? "presidente" : "prata"} QA)`, r, d => d?.success === true && !!cookie, cookie ? "" : "sem Set-Cookie");
    if (!ok) throw new Parada(`sem sessão da conta QA ${papel}: as checagens autenticadas não rodaram`);
    estado.sessao[papel] = sessao(cookie);
  }
  rel.info("o banco inspecionado é o que o servidor usa: as contas inseridas por SQL logaram pela API");
  const P = estado.sessao.P, S = estado.sessao.S;

  const euP = await P.get("auth.me");
  checar("auth.me devolve a identidade da sessão (presidente)", euP, d => d?.id === QA.P.id && d?.role === "president");
  rel.ok("auth.me não vaza hash de senha", !chavesDe(euP.dado).includes("passwordHash"));
  const euS = await S.get("auth.me");
  checar("auth.me devolve a identidade da sessão (prata)", euS, d => d?.id === QA.S.id && d?.role === "silver");
  const perfilS = await S.get("profile.get");
  checar("profile.get não vaza hash de senha", perfilS, d => !JSON.stringify(d || {}).includes("passwordHash"));

  const valido = await S.get("network.list", {});
  checar("cookie válido entra na rota protegida", valido, d => Array.isArray(lista(d)));
  const lixo = await sessao("app_session_id=token-invalido-de-proposito").get("network.list", {});
  checarNegativa("cookie inválido é rejeitado na rota protegida", lixo, [SEM_SESSAO]);
  const anonimo = await fetch(BASE + "/manus-storage/qualquer/coisa.txt", { redirect: "manual", signal: AbortSignal.timeout(20_000) });
  rel.ok("arquivos exigem sessão (anônimo barrado)", anonimo.status === 401, `status ${anonimo.status}`);
}

async function blocoContatos() {
  const P = estado.sessao.P, S = estado.sessao.S;
  const c1 = await P.post("network.create", { fullName: "Exame Exportadora", company: "Vinícola Exame", city: CIDADE_QA, country: "BR" });
  const c2 = await P.post("network.create", { fullName: "Exame Importadora", company: "Importadora Exame", city: CIDADE_QA, country: "BR" });
  if (c1.dado?.id) estado.contatos.P.push(c1.dado.id);
  if (c2.dado?.id) estado.contatos.P.push(c2.dado.id);
  checar("criar contato", c1.status === 200 ? c2 : c1, d => !!d?.id);
  const busca = await P.get("network.list", { q: "Exame Exportadora" });
  checar("buscar contato", busca, d => lista(d).some(c => c.id === c1.dado?.id));
  const edicao = await P.post("network.update", { id: c1.dado?.id, company: "Vinícola Exame Editada" });
  checar("editar contato", edicao, d => d?.success === true || d === undefined);

  const s1 = await S.post("network.create", { fullName: "Exame Prata Oferta", company: "Cafeicultora Exame", city: CIDADE_QA, country: "BR" });
  const s2 = await S.post("network.create", { fullName: "Exame Prata Procura", company: "Torrefação Exame", city: CIDADE_QA, country: "BR" });
  if (s1.dado?.id) estado.contatos.S.push(s1.dado.id);
  if (s2.dado?.id) estado.contatos.S.push(s2.dado.id);
  checar("criar contato (prata)", s1.status === 200 ? s2 : s1, d => !!d?.id);

  const listaS = await S.get("network.list", {});
  checar("ISOLAMENTO: prata vê só os próprios contatos (2, nenhum da presidente)", listaS, d => {
    const ids = lista(d).map(c => c.id);
    return ids.length === estado.contatos.S.length && estado.contatos.S.every(id => ids.includes(id)) && !estado.contatos.P.some(id => ids.includes(id));
  });
  const direto = await S.get("network.get", { id: c1.dado?.id ?? 0 });
  checarNegativa("ISOLAMENTO: acesso direto ao contato de outra dona é barrado", direto, [NAO_ENCONTRADO, BARRADO_OURO]);
  const listaP = await P.get("network.list", {});
  checar("ISOLAMENTO: presidente vê só os próprios contatos", listaP, d => {
    const ids = lista(d).map(c => c.id);
    return estado.contatos.P.every(id => ids.includes(id)) && !estado.contatos.S.some(id => ids.includes(id));
  });
}

async function blocoConsentimentoAbertura() {
  const S = estado.sessao.S, P = estado.sessao.P;
  const status = await S.get("consent.status", { type: "termo_smart_match" });
  if (!checar("consent.status responde", status, d => d && typeof d.accepted === "boolean")) return false;
  const vigentes = await contar("SELECT COUNT(*) n FROM `document_versions` WHERE `type` = 'termo_smart_match' AND `isCurrent` = 1");
  rel.info(`termo_smart_match vigente em document_versions: ${vigentes} (o exame nunca publica termo)`);
  const temTermo = status.dado.document !== null && status.dado.pendingText === false;
  if (!temTermo) {
    rel.pulado("trava do Smart Match (403 sem aceite, aceitar, revogar, histórico)", "NÃO PROVADA: sem termo publicado em produção (tarefa do Nicolas, 03/09); o cruzamento libera por omissão");
    return false;
  }
  const antes = await S.get("intelligentMatches.list");
  checarNegativa("Smart Match barra quem não aceitou o termo", antes, [SEM_CONSENTIMENTO]);
  const aceiteP = await P.post("consent.accept", { type: "termo_smart_match" });
  checar("aceitar o termo do Smart Match (presidente QA)", aceiteP, d => d?.success === true);
  const aceiteS = await S.post("consent.accept", { type: "termo_smart_match" });
  checar("aceitar o termo do Smart Match (prata QA)", aceiteS, d => d?.success === true);
  const depois = await S.get("consent.status", { type: "termo_smart_match" });
  checar("consent.status reflete o aceite", depois, d => d?.accepted === true && !!d?.acceptedAt);
  const hist = await S.get("consent.history");
  checar("histórico de consentimento registra o aceite", hist, d => lista(d).length >= 1);
  return true;
}

async function blocoMatch() {
  const P = estado.sessao.P, S = estado.sessao.S;
  const [p1, p2] = estado.contatos.P;
  const [s1, s2] = estado.contatos.S;
  checar("registrar 'possui' (Exportar vinho)", await P.post("intelligentMatches.addAsset", { contactId: p1, tagLabel: "Exportar vinho" }), () => true);
  checar("registrar 'procura' (Importar vinho)", await P.post("intelligentMatches.addNeed", { contactId: p2, tagLabel: "Importar vinho" }), () => true);
  await P.post("intelligentMatches.recalculate");
  const sugestoes = await P.get("intelligentMatches.list");
  checar("match por direção (Exportar x Importar = 100%, tipo exact)", sugestoes, d =>
    lista(d).some(m => m.matchScore === 100 && m.matchType === "exact" && [m.contactAId, m.contactBId].includes(p1) && [m.contactAId, m.contactBId].includes(p2)));

  checar("registrar 'possui' na conta prata (Exportar café)", await S.post("intelligentMatches.addAsset", { contactId: s1, tagLabel: "Exportar café" }), () => true);
  checar("registrar 'procura' na conta prata (Importar café)", await S.post("intelligentMatches.addNeed", { contactId: s2, tagLabel: "Importar café" }), () => true);
  const sugestoesS = await S.get("intelligentMatches.list");
  checar("ISOLAMENTO: prata vê só as próprias sugestões (≥1, nenhuma com contato da presidente)", sugestoesS, d => {
    const itens = lista(d);
    return itens.length >= 1 && itens.every(m => estado.contatos.S.includes(m.contactAId) && estado.contatos.S.includes(m.contactBId));
  });
  rel.info("o Smart Match tenta um e-mail para o endereço .invalid da conta QA; o servidor não o manda à Resend (TLD reservado), e o notified_at fica vazio");
  const notificadas = await contar("SELECT COUNT(*) n FROM `ai_match_suggestions` WHERE `owner_id` = ? AND `notified_at` IS NOT NULL", [QA.P.openId]);
  rel.info(`sugestões da presidente QA com notified_at preenchido: ${notificadas}`);
}

async function blocoContextosEStorage() {
  const P = estado.sessao.P, S = estado.sessao.S;
  const tipos = await P.get("contexts.listTypes");
  checar("catálogo de tipos de contexto populado", tipos, d => lista(d).length > 0, `${lista(tipos.dado).length} tipos`);
  const ctx = await P.post("contexts.create", { name: "Exame Contexto QA", city: CIDADE_QA });
  const ctxId = ctx.dado?.id;
  if (ctxId) estado.contextos.push(ctxId);
  if (!checar("criar contexto", ctx, d => !!d?.id)) return;
  const buscaCtx = await P.get("contexts.list", { q: "Exame Contexto QA" });
  checar("buscar contexto", buscaCtx, d => JSON.stringify(d || "").includes(ctxId));

  const up = await P.post("contexts.uploadMedia", { contextId: ctxId, fileName: "exame.png", mimeType: "image/png", dataBase64: PNG_1X1.toString("base64") });
  const caminho = up.dado?.storagePath;
  if (!checar("upload para o storage (contexts.uploadMedia)", up, d => typeof d?.storagePath === "string" && d.storagePath.startsWith("/manus-storage/contexts/"))) return;

  pararSeInterrompido();
  const abrirComoDona = () => fetch(BASE + caminho, { headers: { cookie: P.cookie }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  const proxy = await abrirComoDona();
  const location = proxy.headers.get("location") || "";
  // Segunda abertura, como a tela reaberta: imagem da dona volta com a MESMA URL
  // assinada e o mesmo cache curto (ver avaliarRedirecionamentoComCache).
  const proxyDeNovo = await abrirComoDona();
  const redirecionamento = avaliarRedirecionamentoComCache(
    { status: proxy.status, cacheControl: proxy.headers.get("cache-control"), location },
    { status: proxyDeNovo.status, location: proxyDeNovo.headers.get("location") },
  );
  rel.ok("proxy autenticado redireciona a dona (307 + private, max-age=300) e repete a URL assinada", redirecionamento.ok, redirecionamento.detalhe);
  if (location) {
    const objeto = await fetch(location, { signal: AbortSignal.timeout(30_000) });
    const bytes = Buffer.from(await objeto.arrayBuffer());
    rel.ok("download devolve os bytes exatos que subiram (B2 de ponta a ponta)", objeto.status === 200 && bytes.equals(PNG_1X1), `status ${objeto.status}, ${bytes.length} bytes`);
  } else rel.falha("download devolve os bytes exatos que subiram (B2 de ponta a ponta)", "sem Location");
  const outra = await fetch(BASE + caminho, { headers: { cookie: S.cookie }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  rel.ok("ISOLAMENTO: outra usuária não baixa o arquivo (403)", outra.status === 403, `status ${outra.status}`);
  const prefixo = await fetch(BASE + "/manus-storage/exame/nao-existe.txt", { headers: { cookie: P.cookie }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  rel.ok("prefixo desconhecido no storage é negado (403)", prefixo.status === 403, `status ${prefixo.status}`);

  const del = await P.post("contexts.deleteMedia", { mediaId: up.dado.id });
  checar("apagar anexo (contexts.deleteMedia)", del, d => d?.success === true);
  // A resposta do deleteMedia não prova nada sobre o bucket (erro engolido no servidor):
  // pedir URL nova para a mesma chave (307, é por prefixo) e conferir no B2.
  const proxy2 = await fetch(BASE + caminho, { headers: { cookie: P.cookie }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  const location2 = proxy2.headers.get("location") || "";
  if (location2) {
    const sumiu = await fetch(location2, { signal: AbortSignal.timeout(30_000) });
    if (sumiu.status === 404) rel.ok("objeto apagado do bucket (404 no B2)", true);
    else if (sumiu.status === 200) rel.falha("objeto apagado do bucket", "o B2 ainda devolve o arquivo (200): objeto ficou no bucket");
    else rel.falha("objeto apagado do bucket", `INDETERMINADO: B2 devolveu ${sumiu.status} (esperado 404)`);
  } else rel.falha("objeto apagado do bucket", `proxy não redirecionou após o delete (status ${proxy2.status})`);
  const ctxDepois = await P.get("contexts.get", { id: ctxId });
  checar("contexto sem anexos após o delete", ctxDepois, d => lista(d?.media).length === 0);
  const delCtx = await P.post("contexts.delete", { id: ctxId });
  if (checar("apagar contexto", delCtx, d => d?.success === true)) estado.contextos = estado.contextos.filter(id => id !== ctxId);
}

async function blocoVitrine() {
  const P = estado.sessao.P, S = estado.sessao.S;
  const [p1] = estado.contatos.P;
  const publicos = await contar("SELECT COUNT(*) n FROM `private_contacts` WHERE `nivel_visibilidade` = 'publico'");
  if (publicos >= 200) {
    rel.pulado("vitrine coletiva por nível", `NÃO PROVADA: ${publicos} contatos públicos, a vitrine lê 200 sem ordenação (abrir tarefa)`);
    return;
  }
  checar("marcar contato como público", await P.post("network.update", { id: p1, nivelVisibilidade: "publico" }), () => true);
  const vitrine = await S.get("network.vitrine");
  checar("vitrine mostra o contato público só com país, cidade e possui/procura", vitrine, d => {
    const item = lista(d).find(i => i.city === CIDADE_QA);
    if (!item) return false;
    const chaves = chavesDe(item);
    return chaves.every(k => CHAVES_VITRINE.has(k)) && !chaves.some(k => ["fullName", "company", "phone", "email"].includes(k));
  });
  checar("voltar contato a privado", await P.post("network.update", { id: p1, nivelVisibilidade: "privado" }), () => true);
  const vitrine2 = await S.get("network.vitrine");
  checar("contato privado some da vitrine na leitura seguinte", vitrine2, d => !lista(d).some(i => i.city === CIDADE_QA));
}

async function blocoOportunidades() {
  const P = estado.sessao.P, S = estado.sessao.S;
  // Espelha matching.ts: até 200 perfis (sem ordem) de quem não é a publicadora,
  // depois só gold/president/admin. É estimativa, porque o servidor corta em 200
  // antes de filtrar o papel.
  // O servidor só alerta quem, além do papel elevado, ACEITOU o termo vigente
  // do Smart Match (matching.ts filtra por consentimento). Sem o mesmo filtro
  // aqui, a estimativa dava > 0 com zero aceites reais e o exame esperava os
  // 120 s inteiros à toa em toda execução pós-publicação do termo.
  const [[termoVigente]] = await conn.query(
    "SELECT `id` FROM `document_versions` WHERE `type` = 'termo_smart_match' AND `isCurrent` = TRUE",
  );
  const [perfis] = await conn.query(
    termoVigente
      ? "SELECT u.`role`, u.`openId` FROM `user_profiles` up INNER JOIN `users` u ON u.`id` = up.`userId` INNER JOIN `consents` c ON c.`userId` = u.`id` AND c.`documentVersionId` = ? AND c.`revokedAt` IS NULL WHERE up.`userId` <> ? LIMIT 200"
      : "SELECT u.`role`, u.`openId` FROM `user_profiles` up INNER JOIN `users` u ON u.`id` = up.`userId` WHERE up.`userId` <> ? LIMIT 200",
    termoVigente ? [termoVigente.id, QA.P.id] : [QA.P.id],
  );
  estado.elegiveisAoAlerta = perfis.filter(p => ["gold", "president", "admin"].includes(p.role) && !String(p.openId).startsWith(PREFIXO_QA)).length;
  rel.info(`perfis reais elegíveis ao alerta de compatibilidade da aprovação (estimativa${termoVigente ? ", já filtrada pelo aceite do termo vigente" : ""}): ${estado.elegiveisAoAlerta}`);
  const opp = await P.post("opportunities.create", { title: EXAME_TITULO_OPP, description: EXAME_DESCRICAO_OPP, type: "partnership", sector: "Alimentos e bebidas", country: "BR", isConfidential: true, tags: ["exame", "vinho"] });
  const oppId = opp.dado?.id;
  if (oppId) estado.oppIds.push(oppId);
  if (!checar("criar oportunidade confidencial", opp, d => !!d?.id)) return null;
  if (opp.dado.status === "rejected") {
    rel.pulado("aprovação e visibilidade da oportunidade confidencial", "NÃO PROVADA: o LLM de compliance marcou a oportunidade do exame como red (nasce rejeitada)");
    return null;
  }
  const aval = await P.post("president.validateOpportunity", { opportunityId: oppId, status: "approved" });
  if (!checar("presidente aprova oportunidade", aval, d => d?.success === true)) return null;
  estado.oportunidadeAprovada = true;
  const auditada = await contar("SELECT COUNT(*) n FROM `audit_logs` WHERE `action` = 'PRESIDENT_VALIDATE_OPPORTUNITY' AND `userId` = ? AND `resourceId` = ?", [QA.P.id, String(oppId)]);
  const validacoes = await contar("SELECT COUNT(*) n FROM `president_validations` WHERE `opportunityId` = ?", [oppId]);
  rel.ok("aprovação deixa auditoria e registro de validação", auditada >= 1 && validacoes === 1, `audit=${auditada}, validações=${validacoes}`);
  const notifP = await P.get("notifications.list");
  checar("publicadora é notificada da aprovação", notifP, d => lista(d).some(n => n.type === "opportunity_approved"));

  const listaP = await P.get("opportunities.list", { search: EXAME_TITULO_OPP, limit: 50 });
  checar("presidente vê a confidencial ativa na lista", listaP, d => lista(d).filter(o => o.id === oppId).length === 1);
  const listaS = await S.get("opportunities.list", { search: EXAME_TITULO_OPP, limit: 50 });
  checar("ISOLAMENTO: prata não vê a confidencial na lista (200 e zero itens)", listaS, d => lista(d).length === 0);
  const controle = await S.get("opportunities.list", { limit: 50 });
  if (controle.status === 200 && lista(controle.dado).length === 0) rel.pulado("controle positivo da lista de oportunidades", "NÃO PROVADO: produção não tem oportunidade ativa não confidencial para a prata ver");
  else checar("controle positivo: prata vê as oportunidades públicas", controle, d => lista(d).length >= 1);
  const direto = await S.get("opportunities.get", { id: oppId });
  checarNegativa("ISOLAMENTO: prata barrada no acesso direto à confidencial", direto, [BARRADO_OURO]);
  return oppId;
}

async function blocoOuro(oppId) {
  const P = estado.sessao.P, S = estado.sessao.S;
  const [, p2] = estado.contatos.P;
  const termoOuro = await P.get("consent.status", { type: "termo_acesso_ouro" });
  if (termoOuro.status === 200 && termoOuro.dado?.document) {
    checar("dona aceita o termo de acesso Ouro (versão vigente)", await P.post("consent.accept", { type: "termo_acesso_ouro" }), d => d?.success === true);
    rel.info(`acervo Ouro sob termo_acesso_ouro vigente v${termoOuro.dado.document.version}, aceito pela conta QA`);
  } else rel.info("sem termo de acesso Ouro publicado: acervo liberado por omissão da dona");

  checar("marcar contato como compartilhado com Ouro", await P.post("network.update", { id: p2, nivelVisibilidade: "ouro" }), () => true);
  const barrado = await S.get("network.acervoOuro");
  checarNegativa("prata não lê o acervo Ouro (403)", barrado, [BARRADO_OURO]);
  const leituras0 = await contar("SELECT COUNT(*) n FROM `audit_logs` WHERE `action` = 'GOLD_ACERVO_READ' AND `userId` = ?", [QA.S.id]);
  rel.ok("leitura barrada não gera auditoria de acervo", leituras0 === 0, `${leituras0}`);

  const grant = await P.post("president.grantGold", { userId: QA.S.id, reason: RAZAO_GRANT });
  if (!checar("presidente concede Ouro", grant, d => d?.success === true)) return;
  const euS = await S.get("auth.me");
  checar("conta promovida passa a ler como Ouro na requisição seguinte", euS, d => d?.role === "gold");
  const grants = await contar("SELECT COUNT(*) n FROM `gold_access_grants` WHERE `grantedTo` = ? AND `grantedBy` = ? AND `revokedAt` IS NULL", [QA.S.id, QA.P.id]);
  const auditGrant = await contar("SELECT COUNT(*) n FROM `audit_logs` WHERE `action` = 'PRESIDENT_GRANT_GOLD' AND `userId` = ? AND `resourceId` = ?", [QA.P.id, String(QA.S.id)]);
  rel.ok("concessão deixa grant e auditoria", grants === 1 && auditGrant >= 1, `grants=${grants}, audit=${auditGrant}`);
  const notifS = await S.get("notifications.list");
  checar("promovida é notificada (gold_granted)", notifS, d => lista(d).some(n => n.type === "gold_granted"));

  const acervo = await S.get("network.acervoOuro");
  let itensAcervo = 0;
  checar("Ouro lê o acervo: o contato compartilhado aparece, sem canais pessoais", acervo, d => {
    const itens = lista(d);
    itensAcervo = itens.length;
    const item = itens.find(i => i.city === CIDADE_QA && i.fullName === "Exame Importadora");
    if (!item || !item.contatoRef) return false;
    const chaves = chavesDe(item);
    return !chaves.some(k => CHAVES_PESSOAIS.includes(k));
  });
  const leituras1 = await contar("SELECT COUNT(*) n FROM `audit_logs` WHERE `action` = 'GOLD_ACERVO_READ' AND `userId` = ?", [QA.S.id]);
  rel.ok("leitura do acervo fica auditada (GOLD_ACERVO_READ)", leituras1 === 1, `${leituras1}`);
  rel.info(`conta QA leu o acervo Ouro: ${itensAcervo} item(ns) (linha de auditoria preservada na limpeza)`);
  if (oppId) checar("Ouro vê a oportunidade confidencial", await S.get("opportunities.get", { id: oppId }), d => d?.id === oppId);
  checar("voltar contato compartilhado a privado", await P.post("network.update", { id: p2, nivelVisibilidade: "privado" }), () => true);

  const revoke = await P.post("president.revokeGold", { userId: QA.S.id, reason: RAZAO_REVOKE });
  checar("presidente revoga Ouro", revoke, d => d?.success === true);
  const euS2 = await S.get("auth.me");
  // O nível de volta sai do perfil (Prata só se ele atende à régua de
  // qualificação). A conta QA é inserida por SQL, sem user_profiles: cai em Bronze.
  checar("conta revogada cai no nível do perfil na requisição seguinte (QA sem perfil: Bronze)", euS2, d => d?.role === "bronze");
  const auditRevoke = await contar("SELECT COUNT(*) n FROM `audit_logs` WHERE `action` = 'PRESIDENT_REVOKE_GOLD' AND `userId` = ? AND `resourceId` = ?", [QA.P.id, String(QA.S.id)]);
  rel.ok("revogação deixa auditoria", auditRevoke >= 1, `${auditRevoke}`);
  checarNegativa("revogada não lê mais o acervo (403)", await S.get("network.acervoOuro"), [BARRADO_OURO]);
  if (oppId) checarNegativa("revogada não vê mais a confidencial (403)", await S.get("opportunities.get", { id: oppId }), [BARRADO_OURO]);
}

async function blocoConsentimentoFecho() {
  const S = estado.sessao.S, P = estado.sessao.P;
  checar("revogar o termo do Smart Match", await S.post("consent.revoke", { type: "termo_smart_match" }), d => d?.success === true);
  checarNegativa("Smart Match volta a barrar após a revogação", await S.get("intelligentMatches.list"), [SEM_CONSENTIMENTO]);
  checar("histórico guarda a revogação (revokedAt)", await S.get("consent.history"), d => lista(d).some(h => h.revokedAt));
  // A conta S chega aqui Bronze (o blocoOuro a revoga, e sem perfil ela cai em
  // Bronze), e desde a U3 matches.list sai vazio para a Bronze ANTES de olhar o
  // termo: esta linha prova só a trava do nível, e diz isso.
  checar("matches.list da Bronze: 200 e lista vazia, antes do termo (U3)", await S.get("matches.list", {}), d => Array.isArray(d) && d.length === 0);
  // O número das conexões possíveis passa pela trava do termo em qualquer nível:
  // sem termo, 200 e zero, e não 403.
  checar("matches.conexoesPossiveis sem termo (Bronze): 200, zero e a lista trancada", await S.get("matches.conexoesPossiveis"),
    d => d?.total === 0 && d?.listaLiberada === false);
  // A degradação da LISTA sem termo se prova com quem vê a lista: a presidente QA
  // também revoga o dela. A conta QA nunca tem linha em `matches`, então [] não
  // distingue trava de tabela vazia; o que estas linhas provam é que as rotas
  // DEGRADAM com 200 em vez de 403.
  if (checar("revogar o termo do Smart Match (presidente QA)", await P.post("consent.revoke", { type: "termo_smart_match" }), d => d?.success === true)) {
    checar("matches.list degrada (200 com lista) em vez de 403 sem termo (presidente QA, que vê a lista)", await P.get("matches.list", {}),
      d => Array.isArray(d) && d.length === 0);
    checar("matches.conexoesPossiveis sem termo (presidente QA): 200, zero e a lista liberada", await P.get("matches.conexoesPossiveis"),
      d => d?.total === 0 && d?.listaLiberada === true);
  }
}

async function blocoSessao() {
  const r = await chamar("POST", "auth.login", { email: QA.S.email, password: QA.S.senha });
  const cookieB = cookieDe(r);
  if (!checar("segundo login da conta prata", r, d => d?.success === true && !!cookieB)) return;
  const B = sessao(cookieB);
  checar("logout", await B.post("auth.logout"), d => d?.success === true);
  checarNegativa("sessão encerrada é recusada no banco (revogação real)", await B.get("network.list", {}), [SEM_SESSAO]);
  checar("a outra sessão da mesma conta continua válida", await estado.sessao.S.get("network.list", {}), d => Array.isArray(lista(d)));
}

async function blocoIA() {
  const P = estado.sessao.P;
  const faq = await chamar("POST", "faq.ask", { question: "O que é a Marquesa Global Match?" });
  const faqErro = faq.erro || "";
  const emCota = /429|quota|RESOURCE_EXHAUSTED|limite|rate/i.test(faqErro) || faq.status === 429;
  if (emCota) rel.pulado("IA responde (FAQ)", "cota por minuto do Gemini");
  else checar("IA responde (FAQ)", faq, d => !!d?.answer);
  await dormir(15_000);
  const rei = await P.post("memory.reindex");
  const limitada = /429|limite|rate|muitas/i.test(rei.erro || "");
  if (limitada) rel.pulado("memória reindexa", "ritmo do embedding");
  else checar("memória reindexa", rei, () => true);
  await dormir(15_000);
  const pergunta = await P.post("memory.search", { query: "Quem eu conheci na Antártida em 1990?" });
  const resposta = pergunta.dado?.answer || "";
  const cota = /429|quota|RESOURCE_EXHAUSTED|limite|rate|muitas/i.test(pergunta.erro || "");
  if (cota) rel.pulado("memória responde com honestidade", "cota da IA");
  else if (/não conseguiu redigir/i.test(resposta)) rel.alerta("memória responde com honestidade", "a busca achou as fontes mas a IA não redigiu a resposta (conferir chave e cota do Gemini)");
  else checar("memória responde com honestidade", pergunta, d => /não encontrei|não há|nenhum|não localiz|não tenho|não constam/i.test(d?.answer || ""));
}

// Alerta de compatibilidade da aprovação é assíncrono no servidor (LLM sem await):
// dar tempo para as notificações aterrissarem antes de apagá-las. O LLM pode
// legitimamente não alertar ninguém, então esgotar a espera NÃO é falha: a faxina
// de abertura da próxima execução apaga pelo título o que chegar depois.
async function aguardarAlertaDeCompatibilidade() {
  if (!estado.oportunidadeAprovada || estado.elegiveisAoAlerta === 0 || !estado.oppIds.length) return;
  // 120 s: o cliente de LLM do servidor retenta com atraso de até 30 s e sem timeout.
  const inicio = Date.now();
  while (Date.now() - inicio < 120_000) {
    const n = await contar("SELECT COUNT(*) n FROM `platform_notifications` WHERE `actionUrl` = ?", [`/opportunities/${estado.oppIds[0]}`]);
    if (n > 1) { rel.info(`alerta de compatibilidade aterrissou em ${Math.round((Date.now() - inicio) / 1000)} s (${n - 1} notificação(ões), apagadas na limpeza)`); return; }
    await dormir(2_000);
  }
  rel.info("alerta de compatibilidade não gerou notificação em 120 s (o LLM pode não ter casado ninguém); se chegar depois, a próxima execução apaga pelo título");
}

// ── Limpeza final, à prova de interrupção ────────────────────────────────────
let limpezaEmCurso = null;
let interrompido = false;
let encerrando = false;
/** Depois de um sinal, o fluxo principal não pode criar mais nada (a limpeza já corre). */
function pararSeInterrompido() {
  if (interrompido && !limpezaEmCurso) throw new Parada("exame interrompido por sinal");
}
async function limpezaFinal() {
  if (limpezaEmCurso) return limpezaEmCurso;
  limpezaEmCurso = (async () => {
    if (!conn) return;
    try {
      if (!interrompido) await aguardarAlertaDeCompatibilidade();
      const P = estado.sessao.P, S = estado.sessao.S;
      if (P) {
        for (const id of estado.contextos) await P.post("contexts.delete", { id }).catch(() => {});
        for (const id of estado.contatos.P) await P.post("network.delete", { id }).catch(() => {});
      }
      if (S) for (const id of estado.contatos.S) await S.post("network.delete", { id }).catch(() => {});
      const { chaves } = await chavesQaNoBanco();
      const apagadas = await executarLimpeza(chaves);
      rel.info(`limpeza: ${apagadas} linha(s) removida(s) por SQL`);
      await verificarLimpeza();
    } catch (e) {
      rel.limpezaComErro(`limpeza interrompida: ${e.message}`);
    } finally {
      try { await conn.query("SELECT RELEASE_LOCK('exame_de_producao')"); } catch { /* conexão pode ter caído */ }
      await conn.end().catch(() => {});
      conn = null;
    }
  })();
  return limpezaEmCurso;
}

function imprimirEEncerrar() {
  console.log(rel.texto());
  process.exit(rel.codigoDeSaida());
}

async function encerrarPorSinal(motivo) {
  interrompido = true;
  if (encerrando) return; // segundo Ctrl-C: a limpeza já está em curso
  encerrando = true;
  rel.info(`encerrando por ${motivo}: limpeza antes de sair`);
  rel.houveExcecao = true;
  await limpezaFinal();
  imprimirEEncerrar();
}
process.on("SIGINT", () => { encerrarPorSinal("SIGINT"); });
process.on("SIGTERM", () => { encerrarPorSinal("SIGTERM"); });
process.on("uncaughtException", e => { rel.excecao(e); encerrarPorSinal("uncaughtException"); });
process.on("unhandledRejection", e => { rel.excecao(e); encerrarPorSinal("unhandledRejection"); });

// ── Execução ─────────────────────────────────────────────────────────────────
rel.info(`exame de ${BASE} com o ambiente de ${arquivoEnv}${arquivoEnv === ".env" ? " (recomendado: .env.producao separado do .env de trabalho)" : ""}${COM_IA ? ", com IA" : ""}`);
try {
  conn = await mysql.createConnection(DATABASE_URL);
  const [[trava]] = await conn.query("SELECT GET_LOCK('exame_de_producao', 0) AS l");
  if (Number(trava.l) !== 1) {
    console.error("Outra execução do exame está em andamento neste banco (GET_LOCK). Nada foi feito.");
    await conn.end();
    process.exit(1);
  }
  if (SOMENTE_FAXINA) {
    await faxinaDeAbertura();
    await verificarLimpeza();
    await conn.query("SELECT RELEASE_LOCK('exame_de_producao')");
    await conn.end();
    conn = null;
    // Neste modo achar órfão é o serviço, não anomalia: o ALERTA fica no relatório,
    // mas só erro de limpeza ou exceção reprovam.
    console.log(rel.texto());
    process.exit(rel.houveErroDeLimpeza || rel.houveExcecao ? 1 : 0);
  }

  const home = await aquecer();
  await faxinaDeAbertura();
  await blocoInfra(home); pararSeLimite();
  await blocoIdentidades();
  await blocoAutenticacao(); pararSeLimite();
  await blocoContatos(); pararSeLimite();
  const temTermo = await blocoConsentimentoAbertura(); pararSeLimite();
  await blocoMatch(); pararSeLimite();
  await blocoContextosEStorage(); pararSeLimite();
  await blocoVitrine(); pararSeLimite();
  const oppId = await blocoOportunidades(); pararSeLimite();
  await blocoOuro(oppId); pararSeLimite();
  if (temTermo) { await blocoConsentimentoFecho(); pararSeLimite(); }
  await blocoSessao(); pararSeLimite();
  if (COM_IA) await blocoIA();
  else rel.info("checagens de IA puladas (rode com --com-ia para incluí-las)");
} catch (e) {
  if (e instanceof Parada) rel.naoExecutada("checagens seguintes", e.message);
  else rel.excecao(e);
} finally {
  await limpezaFinal();
  if (ritmo.esperasMs > 0) rel.info(`ritmo: ${Math.round(ritmo.esperasMs / 1000)} s de espera para respeitar o limite de requisições`);
  imprimirEEncerrar();
}
