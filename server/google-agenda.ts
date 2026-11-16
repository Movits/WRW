import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FalhaDaConexaoGoogle } from "@shared/google-agenda";
import { auditLogs, googleAgendaConexoes } from "../drizzle/schema";
import { exigirDb } from "./db";
import {
  ConexaoGoogleRevogada,
  configuracaoDaGoogleAgenda,
  fetchGlobal,
  renovarAcesso,
  revogarToken,
  type ConfiguracaoDaGoogleAgenda,
  type Fetch,
} from "./google-oauth";
import { decryptData, encryptData } from "./security";

/**
 * A conexão da dona com a Google Agenda no banco (H16b do plano do gravador):
 * o estado para a tela, gravar a conexão que volta da Google, desconectar,
 * revogar na exclusão da conta e o token de acesso que a H16c usa para criar e
 * mudar os eventos.
 *
 * Só o refresh token fica no banco, cifrado (encryptData). O token de acesso
 * fica na memória do processo até 1 minuto antes de vencer (a instância é uma
 * só; outra instância renovaria por conta própria).
 *
 * A conexão e a desconexão são prova do consentimento da dona: a linha de
 * `audit_logs` entra na MESMA transação, por insert direto, que lança (o
 * `createAuditLog` engole o erro). Sem a prova, a conexão não fica. É o padrão
 * do link aberto (server/link-aberto-da-reuniao.ts).
 */

type Banco = Awaited<ReturnType<typeof exigirDb>>;

export const ACAO_GOOGLE_CONECTADA = "GOOGLE_CALENDAR_CONNECTED";
export const ACAO_GOOGLE_DESCONECTADA = "GOOGLE_CALENDAR_DISCONNECTED";

/** As variáveis não estão no ambiente: a função não existe agora. */
export class GoogleAgendaIndisponivel extends Error {
  constructor() {
    super("A conexão com a Google Agenda não está disponível: faltam variáveis no ambiente.");
    this.name = "GoogleAgendaIndisponivel";
  }
}

/** A dona não conectou a conta Google (ou desconectou). */
export class GoogleAgendaNaoConectada extends Error {
  constructor() {
    super("A Google Agenda não está conectada.");
    this.name = "GoogleAgendaNaoConectada";
  }
}

/** O IP e o navegador de quem pediu, para a prova. */
export type ProvaDoPedido = { ipAddress: string; userAgent: string | undefined };

/** O que a seção do Perfil precisa. Sem as variáveis, só `disponivel: false`. */
export type EstadoDaGoogleAgenda =
  | { disponivel: false }
  | { disponivel: true; origem: string; conectada: false }
  | { disponivel: true; origem: string; conectada: true; email: string | null; falha: FalhaDaConexaoGoogle | null };

export async function estadoDaGoogleAgenda(userId: number): Promise<EstadoDaGoogleAgenda> {
  const config = configuracaoDaGoogleAgenda();
  // Sem as variáveis a função some, e o Perfil nem pergunta ao banco.
  if (!config) return { disponivel: false };
  const db = await exigirDb();
  const [linha] = await db.select({ email: googleAgendaConexoes.emailGoogle, falha: googleAgendaConexoes.falha })
    .from(googleAgendaConexoes)
    .where(eq(googleAgendaConexoes.userId, userId))
    .limit(1);
  // A origem vai à tela: a conexão só começa pelo endereço do FRONTEND_URL, e a
  // tela manda para lá quem está noutro (o endereço do Render, por exemplo).
  if (!linha) return { disponivel: true, origem: config.origem, conectada: false };
  return { disponivel: true, origem: config.origem, conectada: true, email: linha.email, falha: linha.falha ?? null };
}

// ── o token de acesso, em memória ──────────────────────────────────────────

type AcessoGuardado = { token: string; expiraEm: number; versao: string };
const acessos = new Map<number, AcessoGuardado>();
/** Uma renovação por conexão de cada vez: quem chega no meio espera a mesma. */
const renovacoes = new Map<string, Promise<string>>();

/** O token guardado só serve até 1 minuto antes de vencer: a chamada não pode sair com ele vencendo no caminho. */
export const MARGEM_DO_ACESSO_MS = 60_000;

/**
 * `versao` é o refresh token cifrado da linha. O IV de encryptData é aleatório,
 * então cada conexão tem um valor próprio: reconectar muda a versão, e o token
 * de acesso da conexão anterior deixa de ser servido.
 */
function guardarAcesso(userId: number, versao: string, acesso: { token: string; expiraEm: number }) {
  acessos.set(userId, { token: acesso.token, expiraEm: acesso.expiraEm, versao });
}

export function esquecerAcesso(userId: number) {
  acessos.delete(userId);
}

/** Marca só a conexão que falhou: se a dona reconectou no meio, a linha nova fica como está. */
async function marcarRevogada(db: Banco, userId: number, versao: string) {
  esquecerAcesso(userId);
  await db.update(googleAgendaConexoes)
    .set({ falha: "revogada", updatedAt: Date.now() })
    .where(and(eq(googleAgendaConexoes.userId, userId), eq(googleAgendaConexoes.refreshTokenCifrado, versao)));
}

async function renovar(db: Banco, config: ConfiguracaoDaGoogleAgenda, userId: number, versao: string, buscar: Fetch, agora: () => number): Promise<string> {
  let refreshToken: string;
  try {
    refreshToken = decryptData(versao);
  } catch {
    // A chave do cofre mudou: o token guardado não se lê mais, e só reconectar resolve.
    await marcarRevogada(db, userId, versao);
    throw new ConexaoGoogleRevogada();
  }
  try {
    const tokens = await renovarAcesso(config, refreshToken, buscar, agora());
    let versaoAtual = versao;
    if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
      // A Google pode mandar um refresh token novo na renovação: ele toma o lugar do antigo.
      versaoAtual = encryptData(tokens.refreshToken);
      await db.update(googleAgendaConexoes)
        .set({ refreshTokenCifrado: versaoAtual, updatedAt: agora() })
        .where(and(eq(googleAgendaConexoes.userId, userId), eq(googleAgendaConexoes.refreshTokenCifrado, versao)));
    }
    guardarAcesso(userId, versaoAtual, { token: tokens.accessToken, expiraEm: tokens.expiraEm });
    return tokens.accessToken;
  } catch (erro) {
    // invalid_grant: a dona tirou o acesso na conta Google, ou o modo Teste
    // venceu (7 dias). Fica marcado, e a tela pede "Reconectar": nada de silêncio.
    if (erro instanceof ConexaoGoogleRevogada) await marcarRevogada(db, userId, versao);
    throw erro;
  }
}

/**
 * O token de acesso da Google Agenda da dona, para a H16c criar, mudar e
 * excluir eventos. Vem da memória enquanto vale; senão, é renovado pelo refresh
 * token. Lança GoogleAgendaIndisponivel (sem as variáveis),
 * GoogleAgendaNaoConectada, ConexaoGoogleRevogada (a conexão parou de
 * funcionar; a linha fica marcada) ou RecusaDaGoogle (Google fora do ar: tente
 * de novo depois). Banco fora do ar sobe como erro.
 */
export async function tokenDeAcessoDaGoogleAgenda(
  userId: number,
  buscar: Fetch = fetchGlobal,
  agora: () => number = Date.now,
): Promise<string> {
  const config = configuracaoDaGoogleAgenda();
  if (!config) throw new GoogleAgendaIndisponivel();
  const db = await exigirDb();
  const [linha] = await db.select({ versao: googleAgendaConexoes.refreshTokenCifrado, falha: googleAgendaConexoes.falha })
    .from(googleAgendaConexoes)
    .where(eq(googleAgendaConexoes.userId, userId))
    .limit(1);
  if (!linha) {
    esquecerAcesso(userId);
    throw new GoogleAgendaNaoConectada();
  }
  if (linha.falha) {
    esquecerAcesso(userId);
    throw new ConexaoGoogleRevogada();
  }
  const guardado = acessos.get(userId);
  if (guardado && guardado.versao === linha.versao && guardado.expiraEm - MARGEM_DO_ACESSO_MS > agora()) return guardado.token;
  const emCurso = renovacoes.get(linha.versao);
  if (emCurso) return emCurso;
  const renovacao = renovar(db, config, userId, linha.versao, buscar, agora)
    .finally(() => renovacoes.delete(linha.versao));
  renovacoes.set(linha.versao, renovacao);
  return renovacao;
}

// ── conectar, desconectar e excluir ────────────────────────────────────────

export type ConexaoNova = {
  refreshToken: string;
  email: string | null;
  escopos: string[];
  /** O token de acesso que veio na troca do código: fica em memória até vencer. */
  acesso: { token: string; expiraEm: number };
};

/**
 * Grava a conexão que voltou da Google (ou troca a anterior) e a prova do
 * consentimento, numa transação só. Devolve o refresh token ANTERIOR, já
 * decifrado, para a rota revogá-lo depois do commit, por melhor esforço: a
 * conexão nova já vale.
 */
export async function gravarConexaoGoogle(
  userId: number,
  conexao: ConexaoNova,
  prova: ProvaDoPedido,
  agora: number = Date.now(),
): Promise<{ anterior: string | null }> {
  const db = await exigirDb();
  const versao = encryptData(conexao.refreshToken);
  const escopos = Array.from(new Set(conexao.escopos)).sort().join(" ").slice(0, 1000);
  const { versaoAnterior } = await db.transaction(async tx => {
    const [antiga] = await tx.select({ versao: googleAgendaConexoes.refreshTokenCifrado })
      .from(googleAgendaConexoes)
      .where(eq(googleAgendaConexoes.userId, userId))
      .limit(1);
    await tx.insert(googleAgendaConexoes).values({
      id: crypto.randomUUID(),
      userId,
      emailGoogle: conexao.email,
      refreshTokenCifrado: versao,
      escopos,
      falha: null,
      createdAt: agora,
      updatedAt: agora,
    }).onDuplicateKeyUpdate({
      set: { emailGoogle: conexao.email, refreshTokenCifrado: versao, escopos, falha: null, updatedAt: agora },
    });
    // Lançar aqui desfaz a gravação da conexão.
    await tx.insert(auditLogs).values({
      userId,
      action: ACAO_GOOGLE_CONECTADA,
      resource: "google_agenda",
      // Os escopos dados e se trocou uma conexão anterior; nunca token nem e-mail.
      details: { escopos: escopos ? escopos.split(" ") : [], reconexao: Boolean(antiga) },
      // Os mesmos cortes do createAuditLog (server/security.ts).
      ipAddress: prova.ipAddress.substring(0, 45),
      userAgent: prova.userAgent ? prova.userAgent.substring(0, 500) : null,
      status: "success",
      riskLevel: "medium",
    });
    return { versaoAnterior: antiga?.versao ?? null };
  });
  guardarAcesso(userId, versao, conexao.acesso);
  if (!versaoAnterior) return { anterior: null };
  try {
    return { anterior: decryptData(versaoAnterior) };
  } catch {
    // Cifrado com outra chave: ninguém aqui consegue mais usá-lo nem revogá-lo.
    return { anterior: null };
  }
}

/**
 * A dona desconecta. Primeiro a Google, depois o banco: se o banco cair depois
 * da revogação, a linha fica com um token morto, a próxima renovação a marca
 * como revogada, e desconectar de novo termina o serviço. Na ordem inversa, um
 * token vivo ficaria sem ninguém que o revogasse.
 *
 * A linha sai mesmo quando a Google não confirma (fora do ar, ou o token não se
 * decifra mais): a dona pediu para a WRW esquecer a conta, e a WRW esquece.
 * `googleNaoConfirmou` diz isso à tela, que sugere tirar o acesso pela conta
 * Google. Desconectar o que já não está conectado não é erro.
 */
export async function desconectarGoogleAgenda(
  userId: number,
  prova: ProvaDoPedido,
  buscar: Fetch = fetchGlobal,
): Promise<{ googleNaoConfirmou: boolean }> {
  const db = await exigirDb();
  esquecerAcesso(userId);
  const [linha] = await db.select({ versao: googleAgendaConexoes.refreshTokenCifrado })
    .from(googleAgendaConexoes)
    .where(eq(googleAgendaConexoes.userId, userId))
    .limit(1);
  if (!linha) return { googleNaoConfirmou: false };
  let revogadaNaGoogle = false;
  try {
    revogadaNaGoogle = await revogarToken(decryptData(linha.versao), buscar);
  } catch {
    revogadaNaGoogle = false;
  }
  await db.transaction(async tx => {
    await tx.delete(googleAgendaConexoes).where(eq(googleAgendaConexoes.userId, userId));
    await tx.insert(auditLogs).values({
      userId,
      action: ACAO_GOOGLE_DESCONECTADA,
      resource: "google_agenda",
      details: { revogadaNaGoogle },
      ipAddress: prova.ipAddress.substring(0, 45),
      userAgent: prova.userAgent ? prova.userAgent.substring(0, 500) : null,
      status: "success",
      riskLevel: "low",
    });
  });
  esquecerAcesso(userId);
  return { googleNaoConfirmou: !revogadaNaGoogle };
}

/**
 * Para a exclusão da conta (server/exclusao-de-conta.ts): revoga na Google o
 * token da conta, se houver. A linha sai pelo plano da exclusão, com o resto.
 * Não pede as variáveis do cliente OAuth: revogar só precisa do token.
 *
 * Lança quando havia token e a Google não confirmou (ou ele não se decifra): a
 * exclusão anota no relatório e segue, sem parar no meio.
 */
export async function revogarGoogleDaConta(db: Banco, userId: number, buscar: Fetch = fetchGlobal): Promise<"revogada" | "sem-conexao"> {
  esquecerAcesso(userId);
  // Sem .limit(1): a coluna é única, e o banco falso do teste da exclusão só
  // conhece o where.
  const linhas = await db.select({ versao: googleAgendaConexoes.refreshTokenCifrado })
    .from(googleAgendaConexoes)
    .where(eq(googleAgendaConexoes.userId, userId));
  if (!linhas.length) return "sem-conexao";
  for (const linha of linhas) {
    if (!(await revogarToken(decryptData(linha.versao), buscar))) {
      throw new Error("A Google não confirmou a revogação do token da agenda.");
    }
  }
  return "revogada";
}
