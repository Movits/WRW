import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { TRPCError, type TRPC_ERROR_CODE_KEY } from "@trpc/server";
import { and, asc, count, eq, gt, isNull, lt, sql } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import {
  APELIDO_DA_CHAVE_MAX,
  CHAVES_POR_CONTA_MAX,
  ERRO_DA_CHAVE_DE_ACESSO,
  MINUTOS_PARA_CADASTRAR_CHAVE,
  type CodigoDeErroDaChaveDeAcesso,
} from "@shared/chaves-de-acesso";
import { UNAUTHED_ERR_MSG } from "@shared/const";
import { auditLogs, chavesDeAcesso, desafiosDeChaveDeAcesso, sessions, users, type User } from "../drizzle/schema";
import { escapeHtml, sendEmail } from "./_core/email";
import { requireSecret } from "./_core/env";
import { descreverErroDeBanco, ehErroDeBancoIndisponivel } from "./banco-indisponivel";
import { exigirDb } from "./db";
import { ehColisaoDeChave } from "./network-codigo-anonimo";
import { checkLoginRateLimit, invalidateSession, linhasAlcancadas, recordLoginAttempt } from "./security";
import { abrirSessao, type SessaoAberta } from "./sessao";

// ─── As chaves de acesso (passkeys, WebAuthn) ─────────────────
// A6 do desenho do gravador (docs/arquitetura/gravador-de-reunioes.md, "Passkeys"):
// entrar com Face ID, digital ou o bloqueio de tela do aparelho. O aparelho
// confere a pessoa e manda só uma ASSINATURA; aqui ficam a chave pública e
// dados técnicos da chave, nunca biometria. A biblioteca é a
// @simplewebauthn/server (MIT); a tela (A7) usa a @simplewebauthn/browser.
//
// Regras deste módulo:
// - Sem WEBAUTHN_RP_ID e WEBAUTHN_ORIGENS, ou com o pedido vindo de uma origem
//   fora da lista, a função some: `chavesDeAcesso.estado` responde
//   `disponivel: false` e todo o resto recusa com CHAVE_INDISPONIVEL.
// - Cada desafio é de uso único, vale 5 minutos e é gasto por UPDATE
//   condicional ANTES da conferência: quem não alcançou a linha não segue.
// - A entrada abre a sessão por `abrirSessao` (server/sessao.ts), com as mesmas
//   checagens do login por senha: o bloqueio por tentativas (e-mail da conta +
//   rede), conta desativada e conta excluída. O token só sai daqui depois de a
//   transação que grava o contador e a auditoria confirmar.
// - Cadastrar, remover e entrar gravam a auditoria por `tx.insert(auditLogs)`,
//   na mesma transação da escrita: se a auditoria falha, nada é gravado.
// - Cadastrar pede entrada recente: só a sessão aberta há até
//   MINUTOS_PARA_CADASTRAR_CHAVE minutos cadastra (as opções recusam antes do
//   Face ID; o cadastro confere de novo, na transação que trava a sessão).
//   Depois disso, CHAVE_REAUTENTICAR: a tela pede a senha e entra de novo
//   (`auth.login`), que abre uma sessão nova. E a dona recebe um e-mail a cada
//   chave cadastrada. Sem as duas coisas, uma sessão roubada virava uma
//   credencial que sobrevive a "Sair" e à revogação das sessões.
// - Os erros saem como CÓDIGO (shared/chaves-de-acesso.ts), e a tela traduz.

type Banco = Awaited<ReturnType<typeof exigirDb>>;
export type Transacao = Parameters<Parameters<Banco["transaction"]>[0]>[0];

/** Quanto tempo o desafio vale: o bastante para o Face ID, curto para quem o copiar. */
export const VALIDADE_DO_DESAFIO_MS = 5 * 60_000;

/**
 * Os algoritmos aceitos, na ordem de preferência: ES256 (o de Apple, Google e
 * Windows Hello), EdDSA e RS256. Fixos, nos dois passos: o padrão da biblioteca
 * oferece o pós-quântico ML-DSA quando o Node o tem, e uma chave cadastrada no
 * Node 24 da máquina de alguém não seria conferida no Node 20 do servidor.
 */
export const ALGORITMOS_ACEITOS = [-7, -8, -257];

/** O nome que o aparelho mostra ao guardar a chave. */
const NOME_DO_SITE = "MarquesaMatch";

export const ACAO_CHAVE_CADASTRADA = "PASSKEY_REGISTERED";
export const ACAO_CHAVE_REMOVIDA = "PASSKEY_REMOVED";
/** A entrada com chave grava LOGIN, como a senha, com o método nos detalhes. */
export const ACAO_ENTRADA = "LOGIN";
export const METODO_DA_ENTRADA = "chave_de_acesso";

function erroDaChave(code: TRPC_ERROR_CODE_KEY, codigo: CodigoDeErroDaChaveDeAcesso): TRPCError {
  return new TRPCError({ code, message: codigo });
}

// ─── Configuração ─────────────────────────────────────────────

/** O domínio a que as chaves ficam presas (RP ID) e as origens que podem usá-las. */
export type ConfiguracaoDasChaves = { rpId: string; origens: string[] };

/** Um domínio: letras, números, hífen e pontos, sem esquema, porta nem caminho. */
const DOMINIO = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const avisosDados = new Set<string>();
function avisarUmaVez(mensagem: string) {
  if (avisosDados.has(mensagem)) return;
  avisosDados.add(mensagem);
  console.warn(`[Chaves de acesso] ${mensagem}`);
}

/**
 * Só para os testes: esquece os avisos já dados, para cada teste ver o próprio
 * aviso em qualquer ordem (como o `esquecer()` dos tetos da rota).
 */
export function esquecerAvisosDasChaves(): void {
  avisosDados.clear();
}

/** A origem de um endereço (esquema, host e porta), ou null se ele trouxer mais que isso. */
function origemDe(valor: string): string | null {
  let url: URL;
  try {
    url = new URL(valor);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

/**
 * WEBAUTHN_RP_ID e WEBAUTHN_ORIGENS, lidas do ambiente a cada chamada. Em
 * produção: `wrwglobal.org` e `https://wrwglobal.org,https://www.wrwglobal.org`
 * (decisão do Roberto de 15/11/2026). Sem as duas, a função fica desligada, em
 * silêncio. Com uma só, ou com um valor que não serve, também fica desligada, e
 * o log avisa uma vez: o RP ID é um domínio; cada origem é https (http só em
 * localhost), sem caminho, e tem de ser o próprio RP ID ou um subdomínio dele —
 * o navegador recusaria a chave de qualquer outra.
 */
export function lerConfiguracaoDasChaves(ambiente: NodeJS.ProcessEnv = process.env): ConfiguracaoDasChaves | null {
  const rpId = (ambiente.WEBAUTHN_RP_ID ?? "").trim().toLowerCase();
  const lista = (ambiente.WEBAUTHN_ORIGENS ?? "").split(",").map(item => item.trim()).filter(Boolean);
  if (!rpId && !lista.length) return null;
  if (!rpId || !lista.length) {
    avisarUmaVez(rpId
      ? "WEBAUTHN_RP_ID está definida sem WEBAUTHN_ORIGENS; as duas vão juntas. A função fica desligada."
      : "WEBAUTHN_ORIGENS está definida sem WEBAUTHN_RP_ID; as duas vão juntas. A função fica desligada.");
    return null;
  }
  if (!DOMINIO.test(rpId) || IPV4.test(rpId)) {
    avisarUmaVez(`WEBAUTHN_RP_ID inválido ("${rpId}"): é um domínio, sem https://, porta nem caminho. A função fica desligada.`);
    return null;
  }
  const origens: string[] = [];
  for (const item of lista) {
    const origem = origemDe(item);
    const host = origem ? new URL(origem).hostname : "";
    const segura = origem?.startsWith("https://") || (origem?.startsWith("http://") && host === "localhost");
    const doDominio = host === rpId || host.endsWith(`.${rpId}`);
    if (!origem || !segura || !doDominio) {
      avisarUmaVez(
        `origem inválida em WEBAUTHN_ORIGENS ("${item}"): cada uma é https://domínio (http só em localhost), ` +
          `sem caminho, e o domínio é "${rpId}" ou um subdomínio dele. A função fica desligada.`,
      );
      return null;
    }
    if (!origens.includes(origem)) origens.push(origem);
  }
  return { rpId, origens };
}

/** O que o módulo lê do pedido HTTP. */
export type PedidoHttp = { headers: IncomingHttpHeaders; protocol?: string };

/**
 * A origem de onde o pedido veio: o cabeçalho Origin, que o navegador manda nas
 * mutações; sem ele (as consultas GET da mesma origem não o levam), o Host com o
 * protocolo que o Express leu do proxy (`trust proxy`). O Origin "null" (iframe
 * isolado, arquivo local) não é origem nenhuma. Serve para a função sumir onde a
 * chave não vale (o .onrender.com); quem protege de verdade é a conferência da
 * origem assinada pelo aparelho, em toda resposta.
 */
export function origemDoPedido(req: PedidoHttp): string | null {
  const origem = req.headers.origin;
  if (typeof origem === "string" && origem) return origemDe(origem);
  const host = req.headers.host;
  if (typeof host !== "string" || !host) return null;
  return origemDe(`${req.protocol === "https" ? "https" : "http"}://${host}`);
}

/** A configuração, se a função vale para este pedido; null se ela está desligada aqui. */
export function configuracaoParaOPedido(req: PedidoHttp, ambiente: NodeJS.ProcessEnv = process.env): ConfiguracaoDasChaves | null {
  const configuracao = lerConfiguracaoDasChaves(ambiente);
  if (!configuracao) return null;
  const origem = origemDoPedido(req);
  return origem && configuracao.origens.includes(origem) ? configuracao : null;
}

/** A configuração para este pedido, ou CHAVE_INDISPONIVEL. */
export function exigirConfiguracao(req: PedidoHttp): ConfiguracaoDasChaves {
  const configuracao = configuracaoParaOPedido(req);
  if (!configuracao) throw erroDaChave("PRECONDITION_FAILED", ERRO_DA_CHAVE_DE_ACESSO.indisponivel);
  return configuracao;
}

// ─── Desafio de uso único ─────────────────────────────────────

/** O desafio que a biblioteca gera: 32 bytes aleatórios em base64url (43 caracteres). */
const FORMATO_DO_DESAFIO = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * O desafio que o aparelho assinou, lido do clientDataJSON da resposta. É por
 * ele que o desafio guardado é achado e gasto: a entrada começa sem saber quem
 * é a pessoa, e o desafio é a única coisa que liga a resposta ao pedido de
 * opções. Null se a resposta não tem um desafio no formato que geramos.
 */
export function desafioDaResposta(clientDataJSON: unknown): string | null {
  if (typeof clientDataJSON !== "string" || !clientDataJSON || clientDataJSON.length > 8192) return null;
  try {
    const dados = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")) as unknown;
    const desafio = dados && typeof dados === "object" ? (dados as { challenge?: unknown }).challenge : undefined;
    return typeof desafio === "string" && FORMATO_DO_DESAFIO.test(desafio) ? desafio : null;
  } catch {
    return null;
  }
}

type Finalidade = "cadastro" | "entrada";

async function guardarDesafio(
  db: Banco,
  dados: { desafio: string; finalidade: Finalidade; userId: number | null; identificadorDaUsuaria: string | null },
): Promise<void> {
  const agora = Date.now();
  await db.insert(desafiosDeChaveDeAcesso).values({
    id: crypto.randomUUID(),
    desafio: dados.desafio,
    finalidade: dados.finalidade,
    userId: dados.userId,
    identificadorDaUsuaria: dados.identificadorDaUsuaria,
    expiraEm: agora + VALIDADE_DO_DESAFIO_MS,
    createdAt: agora,
  });
}

/**
 * Gasta o desafio, se ele ainda vale: o mesmo valor, a mesma finalidade, a
 * mesma conta (no cadastro) ou nenhuma (na entrada), ainda não gasto e dentro
 * do prazo. É um UPDATE condicional, e só segue quem alcançou a linha: dois
 * envios da mesma resposta não passam juntos.
 */
async function gastarDesafio(db: Banco, dados: { desafio: string; finalidade: Finalidade; userId: number | null }): Promise<boolean> {
  const agora = Date.now();
  const resultado = await db
    .update(desafiosDeChaveDeAcesso)
    .set({ consumidoEm: agora })
    .where(and(
      eq(desafiosDeChaveDeAcesso.desafio, dados.desafio),
      eq(desafiosDeChaveDeAcesso.finalidade, dados.finalidade),
      dados.userId === null ? isNull(desafiosDeChaveDeAcesso.userId) : eq(desafiosDeChaveDeAcesso.userId, dados.userId),
      isNull(desafiosDeChaveDeAcesso.consumidoEm),
      gt(desafiosDeChaveDeAcesso.expiraEm, agora),
    ));
  return linhasAlcancadas(resultado) === 1;
}

/** Os desafios vencidos saem a cada pedido de opções, 200 por vez: a tabela fica pequena sem tarefa agendada. */
async function apagarDesafiosVencidos(db: Banco): Promise<void> {
  await db.delete(desafiosDeChaveDeAcesso).where(lt(desafiosDeChaveDeAcesso.expiraEm, Date.now())).limit(200);
}

// ─── Utilitários ──────────────────────────────────────────────

const TRANSPORTES_CONHECIDOS = new Set(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);

function transportesConhecidos(lista: unknown): string[] {
  if (!Array.isArray(lista)) return [];
  return Array.from(new Set(lista.filter((item): item is string => typeof item === "string" && TRANSPORTES_CONHECIDOS.has(item))));
}

/** O apelido sem caracteres de controle nem espaços repetidos; vazio vira null. */
export function limparApelido(apelido: string | null | undefined): string | null {
  const limpo = (apelido ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, APELIDO_DA_CHAVE_MAX).trim();
  return limpo || null;
}

/** O motivo de uma recusa, para o log: uma linha curta, sem quebra. */
function registrarRecusa(etapa: "cadastro" | "entrada", userId: number, motivo: unknown) {
  const texto = (motivo instanceof Error ? motivo.message : String(motivo)).replace(/\s+/g, " ").slice(0, 200);
  console.warn(`[Chaves de acesso] ${etapa} recusada (userId ${userId}): ${texto}`);
}

/** O pedido como a auditoria o guarda. */
export type PedidoAuditado = { ip?: string; userAgent?: string };

/** A linha de auditoria, com o mesmo corte de IP e navegador de `createAuditLog`. */
function linhaDeAuditoria(dados: {
  userId: number;
  action: string;
  resourceId?: string | null;
  details: Record<string, unknown>;
  pedido: PedidoAuditado;
  riskLevel: "low" | "medium";
}): typeof auditLogs.$inferInsert {
  const ip = dados.pedido.ip ? dados.pedido.ip.split(",")[0].trim().substring(0, 45) : null;
  return {
    userId: dados.userId,
    action: dados.action,
    resource: "auth",
    resourceId: dados.resourceId ?? null,
    details: dados.details,
    ipAddress: ip || null,
    userAgent: dados.pedido.userAgent ? dados.pedido.userAgent.substring(0, 500) : null,
    status: "success",
    riskLevel: dados.riskLevel,
  };
}

/**
 * A chave como a dona a vê: nada do que serve para conferir assinatura sai daqui
 * (a chave pública fica no servidor). O id da credencial e o identificador da
 * conta no aparelho não são segredo (as opções de cadastro já os mandam à dona,
 * em `excludeCredentials` e `user.id`): vão na lista para a tela da A7 avisar o
 * aparelho (a Signal API do WebAuthn, `signalUnknownCredential` e
 * `signalAllAcceptedCredentials`) da chave que a dona removeu, e ele parar de
 * oferecê-la.
 */
export type ChaveDaLista = {
  id: string;
  /** O id da credencial no aparelho, em base64url. */
  credencialId: string;
  /** O identificador da conta no aparelho (o user handle), em base64url. */
  identificadorDaConta: string;
  apelido: string | null;
  tipoDoAparelho: "singleDevice" | "multiDevice";
  sincronizada: boolean;
  transportes: string[];
  aaguid: string | null;
  criadaEm: number;
  ultimoUsoEm: number | null;
};

const COLUNAS_DA_LISTA = {
  id: chavesDeAcesso.id,
  credencialId: chavesDeAcesso.credencialId,
  identificadorDaUsuaria: chavesDeAcesso.identificadorDaUsuaria,
  apelido: chavesDeAcesso.apelido,
  tipoDoAparelho: chavesDeAcesso.tipoDoAparelho,
  sincronizada: chavesDeAcesso.sincronizada,
  transportes: chavesDeAcesso.transportes,
  aaguid: chavesDeAcesso.aaguid,
  createdAt: chavesDeAcesso.createdAt,
  ultimoUsoEm: chavesDeAcesso.ultimoUsoEm,
};

function chaveDaLista(linha: {
  id: string;
  credencialId: string;
  identificadorDaUsuaria: string;
  apelido: string | null;
  tipoDoAparelho: "singleDevice" | "multiDevice";
  sincronizada: boolean;
  transportes: string[] | null;
  aaguid: string | null;
  createdAt: number;
  ultimoUsoEm: number | null;
}): ChaveDaLista {
  return {
    id: linha.id,
    credencialId: linha.credencialId,
    identificadorDaConta: linha.identificadorDaUsuaria,
    apelido: linha.apelido,
    tipoDoAparelho: linha.tipoDoAparelho,
    sincronizada: Boolean(linha.sincronizada),
    transportes: transportesConhecidos(linha.transportes),
    aaguid: linha.aaguid,
    criadaEm: Number(linha.createdAt),
    ultimoUsoEm: linha.ultimoUsoEm === null ? null : Number(linha.ultimoUsoEm),
  };
}

// ─── Cadastro (logada) ────────────────────────────────────────

/**
 * O identificador da conta que vai para o aparelho (o user handle do WebAuthn):
 * fixo por conta, um HMAC do id com uma chave derivada do JWT_SECRET. Não
 * revela o id nem o e-mail, e volta igual depois de a conta ficar sem chaves
 * (todas removidas, ou apagadas pela redefinição da senha). É isso que faz o
 * aparelho SUBSTITUIR a chave antiga ao cadastrar de novo: ele troca a que tem
 * o mesmo domínio e o mesmo identificador. Com um identificador sorteado a cada
 * vez, a antiga ficava no aparelho, e a pessoa via duas contas no Face ID, uma
 * delas morta (CHAVE_DESCONHECIDA). Trocar o JWT_SECRET muda o identificador
 * das contas que ficarem sem chaves; a conta que ainda tem chave continua com o
 * da primeira (`gerarOpcoesDeCadastro`).
 */
export function identificadorFixoDaConta(userId: number): string {
  const chave = crypto.createHmac("sha256", requireSecret("JWT_SECRET")).update("wrw/chaves-de-acesso/identificador-da-conta").digest();
  return isoBase64URL.fromBuffer(new Uint8Array(crypto.createHmac("sha256", chave).update(String(userId)).digest()));
}

/**
 * O que o cadastro lê da sessão do pedido. `recente` é calculado pelo relógio do
 * BANCO: `createdAt` é gravado por ele (DEFAULT, no fuso dele) e a renovação da
 * sessão não o muda; a comparação com uma data do Node erraria com o banco fora
 * de UTC, como no bloqueio por tentativas (server/security.ts). Exportado para o
 * teste prender o SQL: o MariaDB do CI roda em UTC, e lá a comparação errada
 * também passaria.
 */
export const COLUNAS_DA_SESSAO_QUE_CADASTRA = {
  userId: sessions.userId,
  isActive: sessions.isActive,
  expiresAt: sessions.expiresAt,
  recente: sql<number>`(${sessions.createdAt} >= NOW() - INTERVAL ${MINUTOS_PARA_CADASTRAR_CHAVE} MINUTE)`,
};

type SessaoQueCadastra = { userId: number; isActive: boolean; expiresAt: Date; recente: number | string | boolean | null };

/**
 * A sessão do pedido pode cadastrar uma chave para esta conta? Sem sessão,
 * derrubada, vencida ou de outra conta: UNAUTHED (a tela manda ao login). Aberta
 * há mais de MINUTOS_PARA_CADASTRAR_CHAVE minutos: CHAVE_REAUTENTICAR.
 */
function exigirSessaoQueCadastra(sessao: SessaoQueCadastra | undefined, userId: number): void {
  if (!sessao || !sessao.isActive || sessao.userId !== userId || sessao.expiresAt.getTime() <= Date.now()) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  if (Number(sessao.recente) !== 1) throw erroDaChave("UNAUTHORIZED", ERRO_DA_CHAVE_DE_ACESSO.reautenticar);
}

/**
 * As opções para o aparelho criar a chave: chave residente (a entrada não pede
 * e-mail), a pessoa verificada pelo aparelho (Face ID, digital, PIN), sem
 * atestado e sem as chaves que a conta já tem. Antes de tudo, a sessão do
 * pedido tem de ser recente (`exigirSessaoQueCadastra`), para a recusa chegar
 * antes do Face ID. O identificador que vai para o aparelho é o mesmo em todas
 * as chaves da conta (o da primeira chave; sem chave, o fixo da conta), nunca o
 * id nem o e-mail; ele fica guardado com o desafio até o cadastro.
 */
export async function gerarOpcoesDeCadastro(
  configuracao: ConfiguracaoDasChaves,
  usuaria: Pick<User, "id" | "email" | "name">,
  pedido: { sessionToken: string | null },
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const db = await exigirDb();
  const [sessao] = pedido.sessionToken
    ? await db.select(COLUNAS_DA_SESSAO_QUE_CADASTRA).from(sessions).where(eq(sessions.sessionToken, pedido.sessionToken)).limit(1)
    : [];
  exigirSessaoQueCadastra(sessao, usuaria.id);
  const existentes = await db
    .select({
      credencialId: chavesDeAcesso.credencialId,
      transportes: chavesDeAcesso.transportes,
      identificadorDaUsuaria: chavesDeAcesso.identificadorDaUsuaria,
    })
    .from(chavesDeAcesso)
    .where(eq(chavesDeAcesso.userId, usuaria.id))
    .orderBy(asc(chavesDeAcesso.createdAt));
  if (existentes.length >= CHAVES_POR_CONTA_MAX) {
    throw erroDaChave("PRECONDITION_FAILED", ERRO_DA_CHAVE_DE_ACESSO.limiteDaConta);
  }
  const identificador = existentes[0]?.identificadorDaUsuaria ?? identificadorFixoDaConta(usuaria.id);
  const email = usuaria.email?.trim().toLowerCase() || null;
  const nome = usuaria.name?.trim() || null;
  const opcoes = await generateRegistrationOptions({
    rpName: NOME_DO_SITE,
    rpID: configuracao.rpId,
    // O que o gerenciador de senhas mostra para a pessoa escolher a conta.
    userName: email ?? nome ?? NOME_DO_SITE,
    userDisplayName: nome ?? email ?? "",
    userID: isoBase64URL.toBuffer(identificador),
    timeout: VALIDADE_DO_DESAFIO_MS,
    attestationType: "none",
    excludeCredentials: existentes.map(chave => ({
      id: chave.credencialId,
      transports: transportesConhecidos(chave.transportes),
    })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    supportedAlgorithmIDs: ALGORITMOS_ACEITOS,
  });
  await apagarDesafiosVencidos(db);
  await guardarDesafio(db, { desafio: opcoes.challenge, finalidade: "cadastro", userId: usuaria.id, identificadorDaUsuaria: identificador });
  return opcoes;
}

/**
 * Confere a resposta do aparelho e grava a chave na conta logada, com a
 * auditoria na mesma transação. O desafio é gasto antes da conferência. A
 * transação trava a linha da SESSÃO deste pedido e só grava enquanto ela vale e
 * é recente (a conferência que vale; a das opções só adianta a recusa): a
 * redefinição da senha derruba as sessões e apaga as chaves na mesma transação
 * dela (routers/auth.ts), então um cadastro em andamento ou termina antes e a
 * chave dele é apagada, ou encontra a sessão derrubada e é recusado. Depois da
 * transação, a dona recebe o aviso por e-mail.
 */
export async function cadastrarChave(
  configuracao: ConfiguracaoDasChaves,
  usuaria: Pick<User, "id" | "email" | "name">,
  entrada: { resposta: RegistrationResponseJSON; apelido?: string | null },
  pedido: PedidoAuditado & { sessionToken: string | null },
): Promise<ChaveDaLista> {
  const { resposta } = entrada;
  const desafio = desafioDaResposta(resposta.response?.clientDataJSON);
  if (!desafio) throw erroDaChave("BAD_REQUEST", ERRO_DA_CHAVE_DE_ACESSO.respostaInvalida);
  const db = await exigirDb();
  if (!(await gastarDesafio(db, { desafio, finalidade: "cadastro", userId: usuaria.id }))) {
    throw erroDaChave("BAD_REQUEST", ERRO_DA_CHAVE_DE_ACESSO.desafioInvalido);
  }
  const [doDesafio] = await db
    .select({ identificadorDaUsuaria: desafiosDeChaveDeAcesso.identificadorDaUsuaria })
    .from(desafiosDeChaveDeAcesso)
    .where(eq(desafiosDeChaveDeAcesso.desafio, desafio))
    .limit(1);
  const identificador = doDesafio?.identificadorDaUsuaria;
  if (!identificador) throw erroDaChave("BAD_REQUEST", ERRO_DA_CHAVE_DE_ACESSO.desafioInvalido);

  let verificacao: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verificacao = await verifyRegistrationResponse({
      response: resposta,
      expectedChallenge: desafio,
      expectedOrigin: configuracao.origens,
      expectedRPID: configuracao.rpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: ALGORITMOS_ACEITOS,
    });
  } catch (motivo) {
    registrarRecusa("cadastro", usuaria.id, motivo);
    throw erroDaChave("UNAUTHORIZED", ERRO_DA_CHAVE_DE_ACESSO.recusada);
  }
  if (!verificacao.verified) {
    registrarRecusa("cadastro", usuaria.id, "o atestado não confere");
    throw erroDaChave("UNAUTHORIZED", ERRO_DA_CHAVE_DE_ACESSO.recusada);
  }
  const info = verificacao.registrationInfo;
  // O id que a entrada vai procurar é o que o navegador manda (`resposta.id`): tem de ser o do aparelho.
  if (info.credential.id !== resposta.id) {
    registrarRecusa("cadastro", usuaria.id, "o id da credencial não é o dos dados do aparelho");
    throw erroDaChave("UNAUTHORIZED", ERRO_DA_CHAVE_DE_ACESSO.recusada);
  }
  if (info.credential.id.length > 512) throw erroDaChave("BAD_REQUEST", ERRO_DA_CHAVE_DE_ACESSO.respostaInvalida);

  const chave = {
    id: crypto.randomUUID(),
    userId: usuaria.id,
    credencialId: info.credential.id,
    chavePublica: isoBase64URL.fromBuffer(info.credential.publicKey),
    contador: info.credential.counter,
    transportes: transportesConhecidos(info.credential.transports),
    tipoDoAparelho: info.credentialDeviceType,
    sincronizada: info.credentialBackedUp,
    identificadorDaUsuaria: identificador,
    aaguid: info.aaguid,
    apelido: limparApelido(entrada.apelido),
    createdAt: Date.now(),
    ultimoUsoEm: null,
  };
  try {
    await db.transaction(async tx => {
      const [sessao] = pedido.sessionToken
        ? await tx
          .select(COLUNAS_DA_SESSAO_QUE_CADASTRA)
          .from(sessions)
          .where(eq(sessions.sessionToken, pedido.sessionToken))
          .limit(1)
          .for("update")
        : [];
      exigirSessaoQueCadastra(sessao, usuaria.id);
      const [{ total }] = await tx.select({ total: count() }).from(chavesDeAcesso).where(eq(chavesDeAcesso.userId, usuaria.id));
      if (Number(total) >= CHAVES_POR_CONTA_MAX) {
        throw erroDaChave("PRECONDITION_FAILED", ERRO_DA_CHAVE_DE_ACESSO.limiteDaConta);
      }
      await tx.insert(chavesDeAcesso).values(chave);
      await tx.insert(auditLogs).values(linhaDeAuditoria({
        userId: usuaria.id,
        action: ACAO_CHAVE_CADASTRADA,
        resourceId: chave.id,
        details: { tipoDoAparelho: chave.tipoDoAparelho, sincronizada: chave.sincronizada, aaguid: chave.aaguid },
        pedido,
        riskLevel: "medium",
      }));
    });
  } catch (erro) {
    // A mesma credencial já cadastrada (nesta conta ou em outra): o índice único recusou.
    if (ehColisaoDeChave(erro)) throw erroDaChave("CONFLICT", ERRO_DA_CHAVE_DE_ACESSO.jaCadastrada);
    throw erro;
  }
  avisarChaveCadastrada(usuaria, chave);
  return chaveDaLista(chave);
}

/**
 * O e-mail à dona a cada chave cadastrada: quando, o apelido e o que fazer se
 * não foi ela (redefinir a senha derruba as sessões e apaga as chaves). Em
 * português, como os outros e-mails do app. `site` é o FRONTEND_URL, a origem
 * dos links; sem ele, o texto aponta o "Esqueci minha senha" sem link.
 */
export function montarAvisoDeChaveCadastrada(dados: {
  nome: string | null;
  apelido: string | null;
  quando: Date;
  site: string | null;
}): { assunto: string; text: string; html: string } {
  const nome = dados.nome?.trim() || "Membro";
  const quando = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(dados.quando);
  const linkDaSenha = dados.site ? `${dados.site.replace(/\/+$/, "")}/forgot-password` : null;
  const assunto = "Nova chave de acesso na sua conta MarquesaMatch";
  const cadastrada = (apelido: string | null) =>
    `Uma chave de acesso (Face ID, digital ou bloqueio de tela) foi cadastrada na sua conta MarquesaMatch em ${quando}, no horário de Brasília${apelido ? `, com o nome "${apelido}"` : ""}.`;
  const seNaoFoi = "Se não foi você, redefina a sua senha agora: isso encerra todas as sessões e apaga todas as chaves de acesso da conta.";
  const text = [
    `Olá, ${nome}.`,
    cadastrada(dados.apelido),
    "Se foi você, não precisa fazer nada.",
    linkDaSenha ? `${seNaoFoi} ${linkDaSenha}` : `${seNaoFoi} Use o "Esqueci minha senha" na tela de entrada.`,
  ].join("\n\n");
  const html = [
    `<p>Olá, <strong>${escapeHtml(nome)}</strong>.</p>`,
    `<p>${escapeHtml(cadastrada(dados.apelido))}</p>`,
    "<p>Se foi você, não precisa fazer nada.</p>",
    linkDaSenha
      ? `<p>${escapeHtml(seNaoFoi)} <a href="${escapeHtml(linkDaSenha)}">Redefinir a senha</a></p>`
      : `<p>${escapeHtml(seNaoFoi)} Use o "Esqueci minha senha" na tela de entrada.</p>`,
  ].join("\n");
  return { assunto, text, html };
}

/**
 * Manda o aviso da chave cadastrada sem segurar o cadastro: a chave já está
 * gravada, e a Resend fora do ar (ou sem configuração) só vai para o log, com o
 * userId e sem o e-mail. Nunca lança nem deixa promessa rejeitada solta.
 */
function avisarChaveCadastrada(usuaria: Pick<User, "id" | "email" | "name">, chave: { apelido: string | null; createdAt: number }): void {
  const registrarFalha = (motivo: unknown) =>
    console.error(`[Chaves de acesso] o aviso da chave cadastrada não saiu (userId ${usuaria.id}):`, motivo instanceof Error ? motivo.message : motivo);
  try {
    const email = usuaria.email?.trim();
    if (!email) return;
    const { assunto, text, html } = montarAvisoDeChaveCadastrada({
      nome: usuaria.name ?? null,
      apelido: chave.apelido,
      quando: new Date(chave.createdAt),
      site: process.env.FRONTEND_URL?.trim() || null,
    });
    void sendEmail({ to: email, subject: assunto, text, html })
      .then(enviado => {
        if (!enviado) registrarFalha("a Resend não aceitou o envio");
      })
      .catch(registrarFalha);
  } catch (erro) {
    registrarFalha(erro);
  }
}

// ─── Entrada (pública) ────────────────────────────────────────

/**
 * As opções da entrada: sem lista de chaves (o aparelho oferece as que tem para
 * este domínio) e com a pessoa verificada pelo aparelho. O desafio fica
 * guardado sem conta: quem é a pessoa só se sabe pela chave que voltar.
 */
export async function gerarOpcoesDeEntrada(configuracao: ConfiguracaoDasChaves): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const db = await exigirDb();
  const opcoes = await generateAuthenticationOptions({
    rpID: configuracao.rpId,
    userVerification: "required",
    timeout: VALIDADE_DO_DESAFIO_MS,
  });
  await apagarDesafiosVencidos(db);
  await guardarDesafio(db, { desafio: opcoes.challenge, finalidade: "entrada", userId: null, identificadorDaUsuaria: null });
  return opcoes;
}

/** Quem entrou, no formato que `auth.login` devolve. */
export type UsuariaQueEntrou = Pick<User, "id" | "name" | "email" | "role" | "onboardingCompleted">;

export type EntradaComChave = { token: string; expiresAt: Date; usuaria: UsuariaQueEntrou };

/**
 * A entrada com a chave. Nesta ordem:
 * 1. o desafio é gasto (uso único, de entrada, no prazo);
 * 2. a chave e a conta dela: sem uma das duas (removida, conta excluída), CHAVE_DESCONHECIDA;
 * 3. o bloqueio por tentativas do login por senha (`checkLoginRateLimit`), pelo
 *    e-mail da conta e pela rede: as falhas das duas formas de entrar somam;
 * 4. conta desativada: recusada, como no login por senha;
 * 5. a conferência: assinatura, origem, domínio, a pessoa verificada, o
 *    contador e o identificador da conta. Falha conta como tentativa errada;
 * 6. a sessão, por `abrirSessao` (banco fora do ar sobe como é; outra falha
 *    dela é CHAVE_ERRO_INTERNO);
 * 7. numa transação: a conta ainda ativa, o contador gravado só se ele andou
 *    (UPDATE condicional: a chave removida ou usada ao mesmo tempo não alcança
 *    a linha), o último acesso e a auditoria. Se ela falha, a sessão do passo 6
 *    cai e o token não sai daqui.
 */
export async function entrarComChave(
  configuracao: ConfiguracaoDasChaves,
  resposta: AuthenticationResponseJSON,
  pedido: PedidoAuditado & { ip: string; rede: string },
): Promise<EntradaComChave> {
  const desafio = desafioDaResposta(resposta.response?.clientDataJSON);
  if (!desafio) throw erroDaChave("BAD_REQUEST", ERRO_DA_CHAVE_DE_ACESSO.respostaInvalida);
  const db = await exigirDb();
  if (!(await gastarDesafio(db, { desafio, finalidade: "entrada", userId: null }))) {
    throw erroDaChave("BAD_REQUEST", ERRO_DA_CHAVE_DE_ACESSO.desafioInvalido);
  }

  const [chave] = await db.select().from(chavesDeAcesso).where(eq(chavesDeAcesso.credencialId, resposta.id)).limit(1);
  if (!chave) throw erroDaChave("UNAUTHORIZED", ERRO_DA_CHAVE_DE_ACESSO.desconhecida);
  const [conta] = await db
    .select({
      id: users.id,
      openId: users.openId,
      name: users.name,
      email: users.email,
      role: users.role,
      isActive: users.isActive,
      onboardingCompleted: users.onboardingCompleted,
    })
    .from(users)
    .where(eq(users.id, chave.userId))
    .limit(1);
  if (!conta) throw erroDaChave("UNAUTHORIZED", ERRO_DA_CHAVE_DE_ACESSO.desconhecida);

  // O mesmo balde do login por senha (login_attempts): e-mail em minúsculas e a
  // rede. Conta sem e-mail não entra por senha nem cadastra chave; se existir
  // uma, fica só com os tetos em memória da rota.
  const identificador = conta.email?.trim().toLowerCase() || null;
  if (identificador) {
    const limite = await checkLoginRateLimit(identificador, pedido.rede);
    if (!limite.allowed) throw erroDaChave("TOO_MANY_REQUESTS", ERRO_DA_CHAVE_DE_ACESSO.muitasTentativas);
  }
  if (!conta.isActive) throw erroDaChave("FORBIDDEN", ERRO_DA_CHAVE_DE_ACESSO.contaDesativada);

  const recusar = async (motivo: unknown): Promise<TRPCError> => {
    registrarRecusa("entrada", conta.id, motivo);
    if (identificador) {
      await recordLoginAttempt(identificador, pedido.rede, false).catch(erro => {
        // Banco fora do ar é erro, e não "recusada": a tentativa não foi
        // contada, e a tela diz "banco indisponível" (o middleware traduz).
        if (ehErroDeBancoIndisponivel(erro)) throw erro;
        console.warn(`[Chaves de acesso] a tentativa errada não foi registrada (userId ${conta.id}): ${descreverErroDeBanco(erro)}`);
      });
    }
    return erroDaChave("UNAUTHORIZED", ERRO_DA_CHAVE_DE_ACESSO.recusada);
  };
  // O identificador da conta que o aparelho devolve tem de ser o desta chave.
  const identificadorDevolvido = resposta.response.userHandle;
  if (identificadorDevolvido && identificadorDevolvido !== chave.identificadorDaUsuaria) {
    throw await recusar("o identificador da conta devolvido pelo aparelho não é o desta chave");
  }

  let verificacao: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verificacao = await verifyAuthenticationResponse({
      response: resposta,
      expectedChallenge: desafio,
      expectedOrigin: configuracao.origens,
      expectedRPID: configuracao.rpId,
      credential: {
        id: chave.credencialId,
        publicKey: isoBase64URL.toBuffer(chave.chavePublica),
        counter: Number(chave.contador),
        transports: transportesConhecidos(chave.transportes),
      },
      requireUserVerification: true,
    });
  } catch (motivo) {
    throw await recusar(motivo);
  }
  if (!verificacao.verified) throw await recusar("a assinatura não confere");

  const { newCounter, credentialBackedUp } = verificacao.authenticationInfo;
  let sessao: SessaoAberta;
  try {
    sessao = await abrirSessao({ usuaria: conta, ip: pedido.ip, userAgent: pedido.userAgent });
  } catch (erro) {
    // O banco fora do ar sobe como é (o middleware diz "banco indisponível");
    // o resto vira código, e não a frase em português de `abrirSessao`.
    if (ehErroDeBancoIndisponivel(erro)) throw erro;
    throw erroDaChave("INTERNAL_SERVER_ERROR", ERRO_DA_CHAVE_DE_ACESSO.erroInterno);
  }
  try {
    await db.transaction(async tx => {
      const [agora] = await tx.select({ isActive: users.isActive }).from(users).where(eq(users.id, conta.id)).limit(1);
      if (!agora) throw erroDaChave("UNAUTHORIZED", ERRO_DA_CHAVE_DE_ACESSO.desconhecida);
      if (!agora.isActive) throw erroDaChave("FORBIDDEN", ERRO_DA_CHAVE_DE_ACESSO.contaDesativada);
      // O contador só anda: zero fica zero (as chaves sincronizadas não contam),
      // e o que não for maior que o gravado não alcança a linha.
      const uso = await tx
        .update(chavesDeAcesso)
        .set({ contador: newCounter, ultimoUsoEm: Date.now(), sincronizada: credentialBackedUp })
        .where(and(
          eq(chavesDeAcesso.id, chave.id),
          eq(chavesDeAcesso.userId, conta.id),
          newCounter === 0 ? eq(chavesDeAcesso.contador, 0) : lt(chavesDeAcesso.contador, newCounter),
        ));
      if (linhasAlcancadas(uso) !== 1) {
        registrarRecusa("entrada", conta.id, "a chave foi removida ou usada ao mesmo tempo");
        throw erroDaChave("UNAUTHORIZED", ERRO_DA_CHAVE_DE_ACESSO.recusada);
      }
      await tx.update(users).set({ lastSignedIn: new Date() }).where(eq(users.id, conta.id));
      await tx.insert(auditLogs).values(linhaDeAuditoria({
        userId: conta.id,
        action: ACAO_ENTRADA,
        resourceId: chave.id,
        details: { metodo: METODO_DA_ENTRADA },
        pedido,
        riskLevel: "low",
      }));
    });
  } catch (erro) {
    await invalidateSession(sessao.sessionToken).catch(falha => {
      console.error("[Chaves de acesso] a sessão da entrada recusada não caiu:", falha instanceof Error ? falha.message : falha);
    });
    throw erro;
  }
  if (identificador) {
    await recordLoginAttempt(identificador, pedido.rede, true).catch(erro => {
      // A sessão já foi confirmada: a entrada vale. Fica no log que as
      // tentativas erradas desta rede não foram zeradas.
      console.error(`[Chaves de acesso] as tentativas erradas não foram zeradas (userId ${conta.id}): ${descreverErroDeBanco(erro)}`);
    });
  }
  return {
    token: sessao.token,
    expiresAt: sessao.expiresAt,
    usuaria: { id: conta.id, name: conta.name, email: conta.email, role: conta.role, onboardingCompleted: conta.onboardingCompleted },
  };
}

// ─── Gestão pela dona (logada; a dona sempre no WHERE) ────────

export async function listarChaves(userId: number): Promise<ChaveDaLista[]> {
  const db = await exigirDb();
  const linhas = await db
    .select(COLUNAS_DA_LISTA)
    .from(chavesDeAcesso)
    .where(eq(chavesDeAcesso.userId, userId))
    .orderBy(asc(chavesDeAcesso.createdAt), asc(chavesDeAcesso.id));
  return linhas.map(chaveDaLista);
}

/** Troca o apelido; chave de outra conta, ou que não existe, é CHAVE_NAO_ENCONTRADA. */
export async function renomearChave(userId: number, id: string, apelido: string | null): Promise<void> {
  const db = await exigirDb();
  const resultado = await db
    .update(chavesDeAcesso)
    .set({ apelido: limparApelido(apelido) })
    .where(and(eq(chavesDeAcesso.id, id), eq(chavesDeAcesso.userId, userId)));
  if (linhasAlcancadas(resultado) !== 1) throw erroDaChave("NOT_FOUND", ERRO_DA_CHAVE_DE_ACESSO.naoEncontrada);
}

/** Remove a chave da conta, com a auditoria na mesma transação. */
export async function removerChave(userId: number, id: string, pedido: PedidoAuditado): Promise<void> {
  const db = await exigirDb();
  await db.transaction(async tx => {
    const resultado = await tx.delete(chavesDeAcesso).where(and(eq(chavesDeAcesso.id, id), eq(chavesDeAcesso.userId, userId)));
    if (linhasAlcancadas(resultado) !== 1) throw erroDaChave("NOT_FOUND", ERRO_DA_CHAVE_DE_ACESSO.naoEncontrada);
    await tx.insert(auditLogs).values(linhaDeAuditoria({
      userId,
      action: ACAO_CHAVE_REMOVIDA,
      resourceId: id,
      details: { motivo: "dona" },
      pedido,
      riskLevel: "medium",
    }));
  });
}

/**
 * Dentro da transação da redefinição de senha (routers/auth.ts), depois de as
 * sessões caírem: apaga todas as chaves da conta e os desafios dela, e grava na
 * auditoria quantas chaves saíram. Sem isto, uma chave cadastrada por quem
 * tomou a conta sobreviveria ao reset. Devolve quantas chaves saíram.
 */
export async function apagarChavesNaRedefinicaoDeSenha(tx: Transacao, userId: number, pedido: PedidoAuditado): Promise<number> {
  const resultado = await tx.delete(chavesDeAcesso).where(eq(chavesDeAcesso.userId, userId));
  await tx.delete(desafiosDeChaveDeAcesso).where(eq(desafiosDeChaveDeAcesso.userId, userId));
  const apagadas = linhasAlcancadas(resultado);
  if (apagadas > 0) {
    await tx.insert(auditLogs).values(linhaDeAuditoria({
      userId,
      action: ACAO_CHAVE_REMOVIDA,
      details: { motivo: "redefinicao_de_senha", quantidade: apagadas },
      pedido,
      riskLevel: "medium",
    }));
  }
  return apagadas;
}
