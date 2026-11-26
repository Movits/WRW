import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  auditLogs, consumoDasSalas, meetingParticipants, meetingRoomPresences, meetingRooms, meetings, platformNotifications, userProfiles, users,
} from "../drizzle/schema";
import {
  FICHA_DA_SALA_VALE_MS, FORMATO_DO_LINK_DE_VISITANTE, FRACAO_DO_AVISO_DO_ORCAMENTO, MINUTOS_PESSOA_POR_MES, NOME_DO_VISITANTE_MAX,
  PESSOAS_POR_SALA_MAX, RECUSAS_DA_SALA, SALA_DURA_MS, TETO_DA_SALA_EM_MINUTOS, papelAbreSala, type PapelNaSala,
} from "@shared/sala-de-video";
import { VERSOES_DO_AVISO_DE_GRAVACAO, VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO } from "@shared/aviso-de-gravacao";
import { encontrarContatosEmTexto } from "@shared/contato-em-texto";
import { criarTeto } from "./assistente-de-texto";
import { exigirDb } from "./db";
import { reuniaoVisivel } from "./reuniao-visivel";
import { nomeDaConta, type ProvaDaPessoa } from "./participantes-da-reuniao";
import {
  configuracaoDoDaily, criarClienteDoDaily, FalhaDoDaily, nomeNovoDeSala, type AvisoDaSala, type ClienteDoDaily, type ConfiguracaoDoDaily,
} from "./daily";

/**
 * A sala de vídeo da reunião, o servidor (V1 do estudo
 * docs/arquitetura/sala-de-video.md; decisão do Roberto de 24/11/2026). A tela
 * é a V2; o convite e a entrada pela tela, a V3; a gravação, a V4.
 *
 * Quem faz o quê:
 * - **abre** a sala só a dona da reunião, e só se for Prata ou acima (silver,
 *   gold, president ou admin), conferido aqui pelo papel da conta. Uma sala
 *   aberta por reunião: abrir de novo devolve a mesma;
 * - **recebe a ficha** (o token do Daily) a dona, as participantes ATIVAS da
 *   reunião pela R1b (meeting_participants) e os visitantes sem conta pelo link
 *   da sala, só com o nome. Quem sai da reunião, é removida ou tem a conta
 *   desativada não recebe mais ficha; a reunião na lixeira e a dona desativada
 *   fecham a sala para todo mundo;
 * - **o teto de 8 pessoas** é conferido aqui, ao emitir a ficha, com a linha da
 *   sala travada (e o Daily tem o mesmo teto na sala, como segunda trava);
 * - **o teto do orçamento** soma os minutos-pessoa do mês (consumo_das_salas,
 *   que não sai com a reunião nem com a conta): a sala aberta conta pelo teto
 *   dela (8 pessoas por 120 minutos), a fechada pelo que o Daily avisou que foi
 *   usado (webhook), e a sala sem o segredo do webhook, pelo teto também. Sala
 *   nova que passaria do teto do mês é recusada (decisão vetável, "O que ainda
 *   falta decidir" no estudo); aos 80%, a presidência recebe um aviso no sino.
 *
 * O que vai ao Daily: o nome da sala (aleatório), o nome da pessoa (o da conta
 * ou o que o visitante digitou) e o id da presença como identificador. Nunca o
 * users.id, o e-mail, o telefone ou o título da reunião. Sem compartilhar a
 * tela na V1 (decisão vetável, ver o estudo).
 *
 * Banco fora do ar é erro: nada aqui devolve vazio no lugar do banco. A única
 * falha engolida é a do aviso de 80% no sino, depois de a sala já estar criada
 * (o aviso é acessório, como o do distribuidor em routers/connections.ts).
 */

const recusa = (code: TRPCError["code"], message: string) => new TRPCError({ code, message });
const salaNaoEncontrada = () => recusa("NOT_FOUND", RECUSAS_DA_SALA.salaNaoEncontrada);
const reuniaoNaoEncontrada = () => recusa("NOT_FOUND", RECUSAS_DA_SALA.reuniaoNaoEncontrada);
const linkInvalido = () => recusa("NOT_FOUND", RECUSAS_DA_SALA.linkInvalido);

type Banco = Awaited<ReturnType<typeof exigirDb>>;
type Transacao = Parameters<Parameters<Banco["transaction"]>[0]>[0];
type BancoOuTransacao = Banco | Transacao;

/** A conta que pede: o papel decide quem abre sala. */
export type ContaDaSala = { id: number; openId: string; role: string };
/** O aceite do aviso de gravação, antes de entrar: a versão que a pessoa viu. */
export type AceiteDoAviso = { aceito: boolean; versao: string };
/** O que a tela precisa para entrar: o endereço da sala no Daily, a ficha e quando ela vence. */
export type EntradaNaSala = { salaId: string; url: string; ficha: string; expiraEm: number; papel: PapelNaSala };

export const ACAO_SALA_ABERTA = "MEETING_ROOM_OPENED";
export const ACAO_SALA_ENCERRADA = "MEETING_ROOM_ENDED";
export const ACAO_LINK_DE_VISITANTE_CRIADO = "MEETING_ROOM_GUEST_LINK_CREATED";
export const ACAO_LINK_DE_VISITANTE_DESLIGADO = "MEETING_ROOM_GUEST_LINK_DISABLED";
/** A marca de que a presidência já foi avisada dos 80% do orçamento neste mês (sem conta: é da plataforma). */
export const ACAO_AVISO_DO_ORCAMENTO = "MEETING_ROOMS_BUDGET_WARNED";

// ── o cliente do Daily (trocado nos testes) ────────────────────────────────

let fabricaDoCliente: (configuracao: ConfiguracaoDoDaily) => ClienteDoDaily = configuracao => criarClienteDoDaily(configuracao);

/**
 * Só para os testes: troca o cliente do Daily por um dublê (null volta ao de
 * verdade). A suíte nunca chama o Daily de verdade; o cliente de verdade, no
 * Vitest, recusa antes de sair do processo (server/daily.ts).
 */
export function usarClienteDaSalaNosTestes(fabrica: ((configuracao: ConfiguracaoDoDaily) => ClienteDoDaily) | null): void {
  fabricaDoCliente = fabrica ?? (configuracao => criarClienteDoDaily(configuracao));
}

/** A configuração do Daily, ou a recusa SALA_INDISPONIVEL: sem as variáveis, a função some. */
function exigirConfiguracao(): ConfiguracaoDoDaily {
  const configuracao = configuracaoDoDaily();
  if (!configuracao) throw recusa("PRECONDITION_FAILED", RECUSAS_DA_SALA.indisponivel);
  return configuracao;
}

/** A sala existe no Daily? (a tela some com o botão sem ela) */
export function salaDeVideoDisponivel(): boolean {
  return configuracaoDoDaily() !== null;
}

function falhaDoFornecedor(erro: unknown): TRPCError {
  console.error("[Sala de vídeo]", erro instanceof FalhaDoDaily ? erro.message : erro instanceof Error ? erro.name : "erro");
  return recusa("SERVICE_UNAVAILABLE", RECUSAS_DA_SALA.fornecedorFalhou);
}

// ── tetos de pedidos (em memória, como os outros; zeram a cada deploy) ──────
// Criados no primeiro uso: este módulo entra no ciclo de importação do
// meeting-service (que apaga as salas da reunião excluída), e o criarTeto
// ainda não existe quando ele é carregado.

let tetos: {
  abertura: ReturnType<typeof criarTeto>;
  entrada: ReturnType<typeof criarTeto>;
  visitantePorRede: ReturnType<typeof criarTeto>;
  visitantePorLink: ReturnType<typeof criarTeto>;
  gestao: ReturnType<typeof criarTeto>;
} | null = null;

/** Os tetos: 10 salas por hora por dona; 30 fichas a cada 10 min por conta; o link de visitante, 30 a cada 10 min por rede e 40 por link. */
export function tetosDaSala() {
  tetos ??= {
    abertura: criarTeto(10, 60 * 60_000, RECUSAS_DA_SALA.muitosPedidos),
    entrada: criarTeto(30, 10 * 60_000, RECUSAS_DA_SALA.muitosPedidos),
    visitantePorRede: criarTeto(30, 10 * 60_000, RECUSAS_DA_SALA.muitosPedidos),
    visitantePorLink: criarTeto(40, 10 * 60_000, RECUSAS_DA_SALA.muitosPedidos),
    gestao: criarTeto(30, 10 * 60_000, RECUSAS_DA_SALA.muitosPedidos),
  };
  return tetos;
}

// ── a abertura, uma de cada vez ────────────────────────────────────────────
// A conta do orçamento e a criação da sala andam juntas: duas aberturas ao
// mesmo tempo passariam as duas pela conta e estourariam o teto por uma sala. A
// instância do Render é única, então a fila em memória basta (e serializa
// também duas aberturas da mesma reunião).

let filaDaAbertura: Promise<unknown> = Promise.resolve();
function naFilaDaAbertura<T>(trabalho: () => Promise<T>): Promise<T> {
  const vez = filaDaAbertura.then(trabalho, trabalho);
  filaDaAbertura = vez.catch(() => undefined);
  return vez;
}

// ── o orçamento ────────────────────────────────────────────────────────────

/** O mês do orçamento (em UTC, "AAAA-MM"). */
export function mesDoOrcamento(momento: number): string {
  return new Date(momento).toISOString().slice(0, 7);
}

type ConsumoDaSala = { expiraEm: number; encerradaEm: number | null; segundosPessoa: number; medida: boolean };

/**
 * Os minutos-pessoa do mês: a sala aberta conta pelo teto dela; a fechada, pelo
 * que o Daily avisou (arredondado para cima), se a sala nasceu com o segredo do
 * webhook; sem ele, pelo teto também (sem aviso de quem entrou, a conta não tem
 * como saber).
 */
export function minutosPessoaDoMes(salas: ConsumoDaSala[], agora: number): number {
  let total = 0;
  for (const sala of salas) {
    const aberta = sala.encerradaEm === null && sala.expiraEm > agora;
    total += aberta || !sala.medida ? TETO_DA_SALA_EM_MINUTOS : Math.ceil(sala.segundosPessoa / 60);
  }
  return total;
}

/** O orçamento do mês comporta mais uma sala (pelo teto dela)? */
export function orcamentoComportaOutraSala(usados: number): boolean {
  return usados + TETO_DA_SALA_EM_MINUTOS <= MINUTOS_PESSOA_POR_MES;
}

async function minutosUsadosNoMes(ex: BancoOuTransacao, agora: number): Promise<number> {
  const linhas = await ex.select({
    expiraEm: consumoDasSalas.expiraEm, encerradaEm: consumoDasSalas.encerradaEm,
    segundosPessoa: consumoDasSalas.segundosPessoa, medida: consumoDasSalas.medida,
  }).from(consumoDasSalas).where(eq(consumoDasSalas.mes, mesDoOrcamento(agora)));
  return minutosPessoaDoMes(linhas.map(linha => ({ ...linha, medida: Boolean(linha.medida) })), agora);
}

/** O tempo de uma sessão em segundos, arredondado para cima ao minuto (o conservador para o orçamento). */
export function segundosCobrados(segundos: number): number {
  return Math.ceil(Math.max(0, segundos) / 60) * 60;
}

/**
 * Aos 80% do teto do mês (contando a sala que acabou de abrir), a presidência
 * (president e admin ativos) recebe um aviso no sino, uma vez por mês. A marca é
 * uma linha da auditoria sem conta, com o mês. Falha aqui não desfaz a sala.
 */
async function avisarSeOrcamentoPassouDoAviso(usadosDepois: number, agora: number): Promise<void> {
  if (usadosDepois < MINUTOS_PESSOA_POR_MES * FRACAO_DO_AVISO_DO_ORCAMENTO) return;
  const mes = mesDoOrcamento(agora);
  try {
    const db = await exigirDb();
    const [marca] = await db.select({ id: auditLogs.id }).from(auditLogs)
      .where(and(eq(auditLogs.action, ACAO_AVISO_DO_ORCAMENTO), eq(auditLogs.resourceId, mes))).limit(1);
    if (marca) return;
    const destinatarias = await db.select({ id: users.id }).from(users)
      .where(and(inArray(users.role, ["president", "admin"]), eq(users.isActive, true)));
    const porcento = Math.min(100, Math.round((usadosDepois / MINUTOS_PESSOA_POR_MES) * 100));
    await db.transaction(async tx => {
      await tx.insert(auditLogs).values({
        userId: null, action: ACAO_AVISO_DO_ORCAMENTO, resource: "consumo_das_salas", resourceId: mes,
        details: { mes, minutosPessoa: usadosDepois, teto: MINUTOS_PESSOA_POR_MES }, status: "success", riskLevel: "medium",
      });
      for (const { id } of destinatarias) {
        await tx.insert(platformNotifications).values({
          userId: id, type: "system",
          title: "Salas de vídeo: orçamento do mês em 80%",
          body: `As salas de vídeo deste mês já usaram ou reservaram ${usadosDepois} de ${MINUTOS_PESSOA_POR_MES} minutos-pessoa (${porcento}% do teto de US$ 50). No teto, sala nova é recusada até o mês virar.`,
        });
      }
    });
  } catch (erro) {
    console.error("[Sala de vídeo] o aviso de 80% do orçamento não foi gravado:", erro instanceof Error ? erro.message : erro);
  }
}

// ── apoio ──────────────────────────────────────────────────────────────────

// Os mesmos cortes do createAuditLog (server/security.ts).
function linhaDeAuditoria(prova: ProvaDaPessoa, action: string, meetingId: string, details: Record<string, unknown>) {
  return {
    userId: prova.userId,
    ipAddress: prova.ipAddress.substring(0, 45),
    userAgent: prova.userAgent ? prova.userAgent.substring(0, 500) : null,
    action,
    resource: "meetings",
    resourceId: meetingId,
    details,
    status: "success" as const,
    riskLevel: "low" as const,
  };
}

/** O hash do segredo do link de visitante: só ele fica no banco. */
export function hashDoLinkDeVisitante(segredo: string): string {
  return crypto.createHash("sha256").update(segredo).digest("hex");
}

/** Um segredo novo de link de visitante: 24 bytes aleatórios (192 bits), 32 caracteres em base64url. */
export function gerarSegredoDoLink(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** O aceite vale se foi marcado e se a versão é uma das do aviso de gravação. */
export function aceiteValido(aviso: AceiteDoAviso | null | undefined): aviso is AceiteDoAviso {
  return !!aviso && aviso.aceito === true && (VERSOES_DO_AVISO_DE_GRAVACAO as readonly string[]).includes(aviso.versao);
}

/**
 * O nome do visitante como vai à sala: sem espaços sobrando, sem caractere de
 * controle, de 1 a 60 caracteres e sem e-mail nem telefone (D3: os contatos
 * não vão à tela das outras pessoas nem ao fornecedor). Null quando não serve.
 */
export function nomeDoVisitante(nome: string): string | null {
  // Controle (C0, DEL, C1) e os invisíveis de formatação (largura zero, direção, BOM).
  if (/[\u0000-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁤﻿]/.test(nome)) return null;
  const limpo = nome.replace(/\s+/g, " ").trim();
  if (!limpo || limpo.length > NOME_DO_VISITANTE_MAX) return null;
  if (encontrarContatosEmTexto(limpo).length) return null;
  return limpo;
}

type LinhaDaSala = { id: string; meetingId: string; ownerId: string; providerRoomName: string; expiresAt: number; endedAt: number | null; guestLinkHash: string | null };

const colunasDaSala = {
  id: meetingRooms.id, meetingId: meetingRooms.meetingId, ownerId: meetingRooms.ownerId, providerRoomName: meetingRooms.providerRoomName,
  expiresAt: meetingRooms.expiresAt, endedAt: meetingRooms.endedAt, guestLinkHash: meetingRooms.guestLinkHash,
};

export function salaAberta(sala: { expiresAt: number; endedAt: number | null }, agora: number): boolean {
  return sala.endedAt === null && sala.expiresAt > agora;
}

type LinhaDaPresenca = {
  id: string; userId: number | null; tokenIssuedAt: number; tokenExpiresAt: number; leftAt: number | null; openSessionId: string | null;
};

/**
 * A presença ocupa um lugar da sala? Está na sala (o Daily avisou a entrada e
 * ainda não a saída), ou recebeu a ficha há pouco, ainda não venceu e não saiu
 * depois dela. Sem os avisos do webhook, só a segunda regra vale (a ficha conta
 * por 10 minutos), e o teto de 8 da própria sala no Daily é a trava de quem já
 * entrou.
 */
export function ocupaLugar(presenca: Omit<LinhaDaPresenca, "id" | "userId">, agora: number): boolean {
  if (presenca.openSessionId !== null) return true;
  return presenca.tokenExpiresAt > agora && (presenca.leftAt === null || presenca.leftAt < presenca.tokenIssuedAt);
}

/** As presenças da sala, para o teto de pessoas (a linha da sala já travada por quem chama). */
async function presencasDaSala(tx: Transacao, salaId: string): Promise<LinhaDaPresenca[]> {
  return tx.select({
    id: meetingRoomPresences.id, userId: meetingRoomPresences.userId, tokenIssuedAt: meetingRoomPresences.tokenIssuedAt,
    tokenExpiresAt: meetingRoomPresences.tokenExpiresAt, leftAt: meetingRoomPresences.leftAt, openSessionId: meetingRoomPresences.openSessionId,
  }).from(meetingRoomPresences).where(eq(meetingRoomPresences.roomId, salaId)).limit(500);
}

/** A reunião da sala segue visível e a conta da dona segue ativa? Sem isso, a sala está fechada para todo mundo. */
async function reuniaoDaSalaValida(ex: BancoOuTransacao, sala: { meetingId: string; ownerId: string }): Promise<boolean> {
  const [linha] = await ex.select({ id: meetings.id }).from(meetings)
    .innerJoin(users, eq(users.openId, meetings.ownerId))
    .where(and(eq(meetings.id, sala.meetingId), eq(meetings.ownerId, sala.ownerId), reuniaoVisivel(), eq(users.isActive, true)))
    .limit(1);
  return !!linha;
}

async function nomeDaContaNaSala(ex: BancoOuTransacao, userId: number): Promise<string> {
  const [linha] = await ex.select({ nome: users.name, displayName: userProfiles.displayName }).from(users)
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(eq(users.id, userId)).limit(1);
  return linha ? nomeDaConta(linha.displayName, linha.nome) : "";
}

/** A sala da dona, com a linha travada (para a gestão: o link e o encerrar). */
async function salaDaDonaTravada(tx: Transacao, ownerId: string, salaId: string): Promise<LinhaDaSala> {
  const [sala] = await tx.select(colunasDaSala).from(meetingRooms)
    .where(and(eq(meetingRooms.id, salaId), eq(meetingRooms.ownerId, ownerId))).limit(1).for("update");
  if (!sala) throw salaNaoEncontrada();
  return sala;
}

/** A ficha que o Daily não emitiu devolve o lugar: a presença daquela ficha vence agora. */
async function devolverLugar(presencaId: string, emitidaEm: number): Promise<void> {
  const db = await exigirDb();
  await db.update(meetingRoomPresences).set({ tokenExpiresAt: emitidaEm })
    .where(and(eq(meetingRoomPresences.id, presencaId), eq(meetingRoomPresences.tokenIssuedAt, emitidaEm)));
}

async function emitirFicha(
  configuracao: ConfiguracaoDoDaily,
  pessoa: { salaId: string; sala: string; presencaId: string; nome: string; papel: PapelNaSala; venceEm: number; emitidaEm: number },
): Promise<EntradaNaSala> {
  const cliente = fabricaDoCliente(configuracao);
  try {
    const ficha = await cliente.emitirFicha({ sala: pessoa.sala, nome: pessoa.nome, idDaPessoa: pessoa.presencaId, dona: pessoa.papel === "owner", expiraEm: pessoa.venceEm });
    return { salaId: pessoa.salaId, url: cliente.enderecoDaSala(pessoa.sala), ficha, expiraEm: pessoa.venceEm, papel: pessoa.papel };
  } catch (erro) {
    // A falha que a tela precisa ver é a do Daily; a do banco aqui só vai ao log (a ficha vence sozinha em 10 minutos).
    await devolverLugar(pessoa.presencaId, pessoa.emitidaEm)
      .catch(falha => console.error("[Sala de vídeo] o lugar da ficha que falhou não voltou:", falha instanceof Error ? falha.message : falha));
    throw falhaDoFornecedor(erro);
  }
}

// ── abrir a sala ───────────────────────────────────────────────────────────

/**
 * A dona abre a sala da reunião dela: Prata ou acima, a reunião visível (nem
 * excluída nem na lixeira), uma sala aberta por reunião (abrir de novo devolve a
 * mesma, sem sala nova no Daily) e o orçamento do mês. A sala nasce no Daily
 * antes da linha no banco; se a linha não grava, a sala do Daily sai.
 */
export async function abrirSala(conta: ContaDaSala, meetingId: string, prova: ProvaDaPessoa): Promise<{ salaId: string; nova: boolean; expiraEm: number }> {
  const configuracao = exigirConfiguracao();
  if (!papelAbreSala(conta.role)) throw recusa("FORBIDDEN", RECUSAS_DA_SALA.soPrataOuAcima);
  const soltarVaga = tetosDaSala().abertura.reservar(conta.openId);
  try {
    return await naFilaDaAbertura(async () => {
      const db = await exigirDb();
      const agora = Date.now();
      const [reuniao] = await db.select({ id: meetings.id }).from(meetings)
        .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, conta.openId), reuniaoVisivel())).limit(1);
      if (!reuniao) throw reuniaoNaoEncontrada();
      const [aberta] = await db.select({ id: meetingRooms.id, expiresAt: meetingRooms.expiresAt }).from(meetingRooms)
        .where(and(eq(meetingRooms.ownerId, conta.openId), eq(meetingRooms.meetingId, meetingId), isNull(meetingRooms.endedAt), gt(meetingRooms.expiresAt, agora)))
        .orderBy(asc(meetingRooms.createdAt)).limit(1);
      if (aberta) return { salaId: aberta.id, nova: false, expiraEm: aberta.expiresAt };

      const usados = await minutosUsadosNoMes(db, agora);
      if (!orcamentoComportaOutraSala(usados)) throw recusa("PRECONDITION_FAILED", RECUSAS_DA_SALA.orcamentoEsgotado);

      const cliente = fabricaDoCliente(configuracao);
      const nome = nomeNovoDeSala();
      const expiraEm = agora + SALA_DURA_MS;
      try {
        await cliente.criarSala({ nome, expiraEm, pessoasMax: PESSOAS_POR_SALA_MAX });
      } catch (erro) {
        throw falhaDoFornecedor(erro);
      }
      const salaId = crypto.randomUUID();
      try {
        await db.transaction(async tx => {
          // A reunião pode ter ido para a lixeira enquanto o Daily criava a sala.
          const [ainda] = await tx.select({ id: meetings.id }).from(meetings)
            .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, conta.openId), reuniaoVisivel())).limit(1).for("update");
          if (!ainda) throw reuniaoNaoEncontrada();
          await tx.insert(meetingRooms).values({
            id: salaId, meetingId, ownerId: conta.openId, providerRoomName: nome, guestLinkHash: null, createdAt: agora, expiresAt: expiraEm, endedAt: null,
          });
          await tx.insert(consumoDasSalas).values({
            salaId, nomeNoFornecedor: nome, mes: mesDoOrcamento(agora), criadaEm: agora, expiraEm, encerradaEm: null, segundosPessoa: 0,
            medida: configuracao.segredoDoWebhook !== null,
          });
          await tx.insert(auditLogs).values(linhaDeAuditoria(prova, ACAO_SALA_ABERTA, meetingId, { salaId }));
        });
      } catch (erro) {
        await cliente.apagarSala(nome).catch(falha => console.error("[Sala de vídeo] a sala do Daily sem linha no banco não saiu:", falha instanceof Error ? falha.message : falha));
        throw erro;
      }
      await avisarSeOrcamentoPassouDoAviso(usados + TETO_DA_SALA_EM_MINUTOS, agora);
      return { salaId, nova: true, expiraEm };
    });
  } catch (erro) {
    soltarVaga();
    throw erro;
  }
}

// ── entrar com a conta: a dona e as participantes (R1b) ────────────────────

/**
 * A ficha de quem entra com a conta: a dona da sala ou uma participante ATIVA
 * da reunião (R1b), com a reunião visível e a dona ativa. Quem não é nenhuma das
 * duas leva NOT_FOUND, igual à sala que não existe. A participante aceita o
 * aviso de gravação antes; a dona confirma o aviso ao gravar (V4). A conta tem
 * uma presença por sala, reaproveitada a cada ficha.
 */
export async function entrarNaSala(conta: { id: number; openId: string }, salaId: string, aviso: AceiteDoAviso | null): Promise<EntradaNaSala> {
  const configuracao = exigirConfiguracao();
  const soltarVaga = tetosDaSala().entrada.reservar(`conta:${conta.id}`);
  try {
    const db = await exigirDb();
    const agora = Date.now();
    const pessoa = await db.transaction(async tx => {
      const [sala] = await tx.select(colunasDaSala).from(meetingRooms).where(eq(meetingRooms.id, salaId)).limit(1).for("update");
      if (!sala || !(await reuniaoDaSalaValida(tx, sala))) throw salaNaoEncontrada();
      const papel: PapelNaSala = sala.ownerId === conta.openId ? "owner" : "participant";
      if (papel === "participant") {
        const [participacao] = await tx.select({ id: meetingParticipants.id }).from(meetingParticipants)
          .where(and(
            eq(meetingParticipants.meetingId, sala.meetingId), eq(meetingParticipants.ownerId, sala.ownerId),
            eq(meetingParticipants.userId, conta.id), eq(meetingParticipants.status, "active"),
          )).limit(1);
        if (!participacao) throw salaNaoEncontrada();
      }
      if (!salaAberta(sala, agora)) throw recusa("PRECONDITION_FAILED", RECUSAS_DA_SALA.salaEncerrada);
      const aceito = aceiteValido(aviso);
      if (papel === "participant" && !aceito) throw recusa("PRECONDITION_FAILED", RECUSAS_DA_SALA.avisoPedido);
      const presencas = await presencasDaSala(tx, sala.id);
      const minha = presencas.find(presenca => presenca.userId === conta.id);
      if (presencas.filter(presenca => presenca !== minha && ocupaLugar(presenca, agora)).length >= PESSOAS_POR_SALA_MAX) {
        throw recusa("PRECONDITION_FAILED", RECUSAS_DA_SALA.salaCheia);
      }
      const venceEm = Math.min(agora + FICHA_DA_SALA_VALE_MS, sala.expiresAt);
      const doAviso = aceito ? { noticeVersion: aviso.versao, noticeAcceptedAt: agora } : {};
      const presencaId = minha?.id ?? crypto.randomUUID();
      if (minha) {
        await tx.update(meetingRoomPresences).set({ tokenIssuedAt: agora, tokenExpiresAt: venceEm, updatedAt: agora, ...doAviso })
          .where(and(eq(meetingRoomPresences.id, minha.id), eq(meetingRoomPresences.roomId, sala.id)));
      } else {
        await tx.insert(meetingRoomPresences).values({
          id: presencaId, roomId: sala.id, ownerId: sala.ownerId, userId: conta.id, role: papel, guestName: null,
          noticeVersion: null, noticeAcceptedAt: null, ...doAviso,
          tokenIssuedAt: agora, tokenExpiresAt: venceEm, createdAt: agora, updatedAt: agora,
        });
      }
      return { salaId: sala.id, sala: sala.providerRoomName, presencaId, nome: await nomeDaContaNaSala(tx, conta.id), papel, venceEm, emitidaEm: agora };
    });
    return await emitirFicha(configuracao, pessoa);
  } catch (erro) {
    soltarVaga();
    throw erro;
  }
}

// ── o link de visitante ────────────────────────────────────────────────────

/** A sala aberta do link, com a reunião visível e a dona ativa; null para todo o resto, igual. */
async function salaDoLink(ex: BancoOuTransacao, segredo: string, agora: number, travar: boolean): Promise<LinhaDaSala | null> {
  if (!FORMATO_DO_LINK_DE_VISITANTE.test(segredo)) return null;
  const consulta = ex.select(colunasDaSala).from(meetingRooms).where(eq(meetingRooms.guestLinkHash, hashDoLinkDeVisitante(segredo))).limit(1);
  const [sala] = travar ? await consulta.for("update") : await consulta;
  if (!sala || !salaAberta(sala, agora) || !(await reuniaoDaSalaValida(ex, sala))) return null;
  return sala;
}

/**
 * O que a página do visitante mostra antes de ele digitar o nome: o nome da
 * dona, quando a sala fecha e a versão do aviso a aceitar. Nada da reunião (o
 * título, o resumo, a transcrição): o link é da sala, não da reunião. O link
 * que não existe, foi desligado ou cuja sala fechou responde igual.
 */
export async function verLinkDeVisitante(segredo: string, rede: string): Promise<
  { valido: false } | { valido: true; nomeDaDona: string; expiraEm: number; versaoDoAviso: string }
> {
  exigirConfiguracao();
  tetosDaSala().visitantePorRede.reservar(rede);
  const db = await exigirDb();
  const sala = await salaDoLink(db, segredo, Date.now(), false);
  if (!sala) return { valido: false };
  const [dona] = await db.select({ nome: users.name, displayName: userProfiles.displayName }).from(users)
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(eq(users.openId, sala.ownerId)).limit(1);
  return { valido: true, nomeDaDona: dona ? nomeDaConta(dona.displayName, dona.nome) : "", expiraEm: sala.expiresAt, versaoDoAviso: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO };
}

/**
 * O visitante sem conta entra pelo link da sala, só com o nome e o aceite do
 * aviso: uma presença nova por entrada (sem conta, não há como reconhecê-lo), e
 * a ficha sem o papel de dona. Os tetos de tentativas valem por rede e por link,
 * também para o link errado (é o que segura quem adivinha).
 */
export async function entrarComoVisitante(segredo: string, nome: string, aviso: AceiteDoAviso | null, rede: string): Promise<EntradaNaSala> {
  const configuracao = exigirConfiguracao();
  const tetosAgora = tetosDaSala();
  tetosAgora.visitantePorRede.reservar(rede);
  if (!FORMATO_DO_LINK_DE_VISITANTE.test(segredo)) throw linkInvalido();
  tetosAgora.visitantePorLink.reservar(hashDoLinkDeVisitante(segredo));
  const nomeLimpo = nomeDoVisitante(nome);
  if (!nomeLimpo) throw recusa("BAD_REQUEST", RECUSAS_DA_SALA.nomeInvalido);
  if (!aceiteValido(aviso)) throw recusa("PRECONDITION_FAILED", RECUSAS_DA_SALA.avisoPedido);
  const db = await exigirDb();
  const agora = Date.now();
  const pessoa = await db.transaction(async tx => {
    const sala = await salaDoLink(tx, segredo, agora, true);
    if (!sala) throw linkInvalido();
    const presencas = await presencasDaSala(tx, sala.id);
    if (presencas.filter(presenca => ocupaLugar(presenca, agora)).length >= PESSOAS_POR_SALA_MAX) {
      throw recusa("PRECONDITION_FAILED", RECUSAS_DA_SALA.salaCheia);
    }
    const venceEm = Math.min(agora + FICHA_DA_SALA_VALE_MS, sala.expiresAt);
    const presencaId = crypto.randomUUID();
    await tx.insert(meetingRoomPresences).values({
      id: presencaId, roomId: sala.id, ownerId: sala.ownerId, userId: null, role: "guest", guestName: nomeLimpo,
      noticeVersion: aviso.versao, noticeAcceptedAt: agora, tokenIssuedAt: agora, tokenExpiresAt: venceEm, createdAt: agora, updatedAt: agora,
    });
    return { salaId: sala.id, sala: sala.providerRoomName, presencaId, nome: nomeLimpo, papel: "guest" as const, venceEm, emitidaEm: agora };
  });
  return emitirFicha(configuracao, pessoa);
}

/**
 * A dona liga o link de visitante (ou troca o segredo: o link antigo para de
 * abrir na hora). O segredo sai só nesta resposta; o banco guarda o hash. Só
 * na sala aberta.
 */
export async function novoLinkDeVisitante(conta: { id: number; openId: string }, salaId: string, prova: ProvaDaPessoa): Promise<{ segredo: string; expiraEm: number }> {
  exigirConfiguracao();
  tetosDaSala().gestao.reservar(conta.openId);
  const db = await exigirDb();
  const segredo = gerarSegredoDoLink();
  const agora = Date.now();
  const sala = await db.transaction(async tx => {
    const linha = await salaDaDonaTravada(tx, conta.openId, salaId);
    if (!salaAberta(linha, agora)) throw recusa("PRECONDITION_FAILED", RECUSAS_DA_SALA.salaEncerrada);
    await tx.update(meetingRooms).set({ guestLinkHash: hashDoLinkDeVisitante(segredo) })
      .where(and(eq(meetingRooms.id, linha.id), eq(meetingRooms.ownerId, conta.openId)));
    await tx.insert(auditLogs).values(linhaDeAuditoria(prova, ACAO_LINK_DE_VISITANTE_CRIADO, linha.meetingId, { salaId: linha.id, trocou: linha.guestLinkHash !== null }));
    return linha;
  });
  return { segredo, expiraEm: sala.expiresAt };
}

/** A dona desliga o link de visitante: ele para de abrir na hora. Quem já está na sala segue nela. */
export async function desligarLinkDeVisitante(conta: { id: number; openId: string }, salaId: string, prova: ProvaDaPessoa): Promise<void> {
  tetosDaSala().gestao.reservar(conta.openId);
  const db = await exigirDb();
  await db.transaction(async tx => {
    const sala = await salaDaDonaTravada(tx, conta.openId, salaId);
    if (sala.guestLinkHash === null) return;
    await tx.update(meetingRooms).set({ guestLinkHash: null }).where(and(eq(meetingRooms.id, sala.id), eq(meetingRooms.ownerId, conta.openId)));
    await tx.insert(auditLogs).values(linhaDeAuditoria(prova, ACAO_LINK_DE_VISITANTE_DESLIGADO, sala.meetingId, { salaId: sala.id }));
  });
}

// ── encerrar ───────────────────────────────────────────────────────────────

/**
 * A dona encerra a sala: a linha fecha (nenhuma ficha nova, o link desligado),
 * o consumo do mês fecha, e a sala sai do Daily, o que tira quem está dentro. Se
 * o Daily não responder, a sala já está fechada aqui e vence sozinha no fim das
 * 2 horas (quem já estava dentro fica até lá). Encerrar a sala já fechada não
 * faz nada.
 */
export async function encerrarSala(conta: { id: number; openId: string }, salaId: string, prova: ProvaDaPessoa): Promise<{ encerrada: boolean }> {
  tetosDaSala().gestao.reservar(conta.openId);
  const db = await exigirDb();
  const agora = Date.now();
  const sala = await db.transaction(async tx => {
    const linha = await salaDaDonaTravada(tx, conta.openId, salaId);
    if (!salaAberta(linha, agora)) return null;
    await tx.update(meetingRooms).set({ endedAt: agora, guestLinkHash: null })
      .where(and(eq(meetingRooms.id, linha.id), eq(meetingRooms.ownerId, conta.openId)));
    await tx.update(consumoDasSalas).set({ encerradaEm: agora })
      .where(and(eq(consumoDasSalas.salaId, linha.id), isNull(consumoDasSalas.encerradaEm)));
    await tx.insert(auditLogs).values(linhaDeAuditoria(prova, ACAO_SALA_ENCERRADA, linha.meetingId, { salaId: linha.id }));
    return linha;
  });
  if (!sala) return { encerrada: false };
  const configuracao = configuracaoDoDaily();
  if (configuracao) {
    await fabricaDoCliente(configuracao).apagarSala(sala.providerRoomName)
      .catch(erro => console.error("[Sala de vídeo] a sala encerrada não saiu do Daily (vence no fim das 2 horas):", erro instanceof Error ? erro.message : erro));
  }
  return { encerrada: true };
}

// ── o estado, para a tela ──────────────────────────────────────────────────

export type EstadoDaSala =
  | { disponivel: false }
  | {
    disponivel: true;
    papel: "dona";
    podeAbrir: boolean;
    sala: null | {
      id: string; expiraEm: number; linkLigado: boolean;
      pessoas: { id: string; papel: PapelNaSala; nome: string; naSala: boolean; entrouEm: number | null; saiuEm: number | null }[];
    };
  }
  | { disponivel: true; papel: "participante"; podeAbrir: false; sala: null | { id: string; expiraEm: number } };

/**
 * O estado da sala de uma reunião, como a conta a vê: sem as variáveis, só
 * `disponivel: false` (a tela some com o botão). A dona vê se pode abrir (Prata
 * ou acima), a sala aberta, se o link de visitante está ligado e quem recebeu
 * ficha, só pelo nome; a participante ativa (R1b) vê só se há sala aberta.
 * Quem não é nenhuma das duas leva NOT_FOUND, como a reunião de outra conta.
 */
export async function estadoDaSala(conta: ContaDaSala, meetingId: string): Promise<EstadoDaSala> {
  if (!salaDeVideoDisponivel()) return { disponivel: false };
  const db = await exigirDb();
  const agora = Date.now();
  const [reuniao] = await db.select({ ownerId: meetings.ownerId }).from(meetings)
    .innerJoin(users, eq(users.openId, meetings.ownerId))
    .where(and(eq(meetings.id, meetingId), reuniaoVisivel(), eq(users.isActive, true))).limit(1);
  if (!reuniao) throw reuniaoNaoEncontrada();
  const ehDona = reuniao.ownerId === conta.openId;
  if (!ehDona) {
    const [participacao] = await db.select({ id: meetingParticipants.id }).from(meetingParticipants)
      .where(and(
        eq(meetingParticipants.meetingId, meetingId), eq(meetingParticipants.ownerId, reuniao.ownerId),
        eq(meetingParticipants.userId, conta.id), eq(meetingParticipants.status, "active"),
      )).limit(1);
    if (!participacao) throw reuniaoNaoEncontrada();
  }
  const [sala] = await db.select(colunasDaSala).from(meetingRooms)
    .where(and(eq(meetingRooms.ownerId, reuniao.ownerId), eq(meetingRooms.meetingId, meetingId), isNull(meetingRooms.endedAt), gt(meetingRooms.expiresAt, agora)))
    .orderBy(asc(meetingRooms.createdAt)).limit(1);
  if (!ehDona) return { disponivel: true, papel: "participante", podeAbrir: false, sala: sala ? { id: sala.id, expiraEm: sala.expiresAt } : null };
  if (!sala) return { disponivel: true, papel: "dona", podeAbrir: papelAbreSala(conta.role), sala: null };
  const linhas = await db.select({
    id: meetingRoomPresences.id, role: meetingRoomPresences.role, guestName: meetingRoomPresences.guestName,
    openSessionId: meetingRoomPresences.openSessionId, joinedAt: meetingRoomPresences.joinedAt, leftAt: meetingRoomPresences.leftAt,
    nome: users.name, displayName: userProfiles.displayName, ativa: users.isActive,
  }).from(meetingRoomPresences)
    .leftJoin(users, eq(users.id, meetingRoomPresences.userId))
    .leftJoin(userProfiles, eq(userProfiles.userId, meetingRoomPresences.userId))
    .where(and(eq(meetingRoomPresences.roomId, sala.id), eq(meetingRoomPresences.ownerId, reuniao.ownerId)))
    .orderBy(asc(meetingRoomPresences.createdAt))
    .limit(200);
  return {
    disponivel: true, papel: "dona", podeAbrir: papelAbreSala(conta.role),
    sala: {
      id: sala.id, expiraEm: sala.expiresAt, linkLigado: sala.guestLinkHash !== null,
      pessoas: linhas.map(linha => ({
        id: linha.id, papel: linha.role,
        // A conta desativada não mostra nome; o visitante, o que digitou.
        nome: linha.role === "guest" ? linha.guestName ?? "" : linha.ativa ? nomeDaConta(linha.displayName, linha.nome) : "",
        naSala: linha.openSessionId !== null,
        entrouEm: linha.joinedAt === null ? null : Number(linha.joinedAt),
        saiuEm: linha.leftAt === null ? null : Number(linha.leftAt),
      })),
    },
  };
}

// ── os avisos do Daily (webhook) ───────────────────────────────────────────

/**
 * Um aviso do Daily, já com a assinatura conferida (server/_core/rota-do-webhook-da-sala.ts):
 * - **entrou**: abre a sessão na presença (a primeira entrada fica em joined_at);
 * - **saiu**: soma a duração que o Daily mediu à presença e ao consumo do mês,
 *   arredondada para cima ao minuto, e marca a saída;
 * - **fim** (o Daily o manda quando a ÚLTIMA pessoa sai, não quando a sala
 *   vence): fecha as sessões que ficaram abertas na hora do fim e soma o tempo
 *   delas. A sala NÃO fecha aqui: a dona que cai da rede sozinha volta para a
 *   mesma sala. Ela fecha pelo prazo de 2 horas ou pelo encerrar da dona, e só
 *   então o orçamento passa do teto da sala ao que foi medido.
 * O mesmo aviso repetido (o Daily tenta de novo) não soma duas vezes: a sessão
 * aberta e a última fechada ficam na presença. O aviso de sala ou presença que
 * não existe mais (a reunião foi excluída) é ignorado; a sala aberta da reunião
 * excluída já conta pelo teto (apagarSalasDaReuniao).
 */
export async function receberAvisoDaSala(aviso: AvisoDaSala): Promise<"aplicado" | "ignorado"> {
  const db = await exigirDb();
  return db.transaction(async tx => {
    if (aviso.tipo === "fim") {
      const [consumo] = await tx.select({ salaId: consumoDasSalas.salaId }).from(consumoDasSalas)
        .where(eq(consumoDasSalas.nomeNoFornecedor, aviso.sala)).limit(1).for("update");
      const [sala] = await tx.select(colunasDaSala).from(meetingRooms).where(eq(meetingRooms.providerRoomName, aviso.sala)).limit(1).for("update");
      if (!consumo && !sala) return "ignorado";
      let somados = 0;
      if (sala) {
        const abertas = await tx.select({ id: meetingRoomPresences.id, openSessionId: meetingRoomPresences.openSessionId, openSessionSince: meetingRoomPresences.openSessionSince })
          .from(meetingRoomPresences)
          .where(and(eq(meetingRoomPresences.roomId, sala.id), isNotNull(meetingRoomPresences.openSessionId)))
          .for("update");
        for (const presenca of abertas) {
          const segundos = segundosCobrados((aviso.em - Number(presenca.openSessionSince ?? aviso.em)) / 1000);
          somados += segundos;
          await tx.update(meetingRoomPresences).set({
            secondsInRoom: sql`${meetingRoomPresences.secondsInRoom} + ${segundos}`, leftAt: aviso.em,
            lastSessionId: presenca.openSessionId, openSessionId: null, openSessionSince: null, updatedAt: Date.now(),
          }).where(eq(meetingRoomPresences.id, presenca.id));
        }
      }
      if (consumo && somados) {
        await tx.update(consumoDasSalas).set({ segundosPessoa: sql`${consumoDasSalas.segundosPessoa} + ${somados}` })
          .where(eq(consumoDasSalas.salaId, consumo.salaId));
      }
      return "aplicado";
    }

    if (!aviso.pessoa) return "ignorado";
    const [sala] = await tx.select({ id: meetingRooms.id }).from(meetingRooms).where(eq(meetingRooms.providerRoomName, aviso.sala)).limit(1);
    if (!sala) return "ignorado";
    const [presenca] = await tx.select({
      id: meetingRoomPresences.id, joinedAt: meetingRoomPresences.joinedAt, leftAt: meetingRoomPresences.leftAt,
      openSessionId: meetingRoomPresences.openSessionId, openSessionSince: meetingRoomPresences.openSessionSince, lastSessionId: meetingRoomPresences.lastSessionId,
    }).from(meetingRoomPresences)
      .where(and(eq(meetingRoomPresences.id, aviso.pessoa), eq(meetingRoomPresences.roomId, sala.id))).limit(1).for("update");
    if (!presenca) return "ignorado";
    if (aviso.sessao === presenca.openSessionId || aviso.sessao === presenca.lastSessionId) {
      if (aviso.tipo === "entrou") return "ignorado";
    }

    let somar = 0;
    let mudanca: Partial<typeof meetingRoomPresences.$inferInsert>;
    if (aviso.tipo === "entrou") {
      // Uma sessão nova com outra ainda aberta (o aviso de saída se perdeu): a antiga fecha agora.
      if (presenca.openSessionId) somar = segundosCobrados((aviso.em - Number(presenca.openSessionSince ?? aviso.em)) / 1000);
      mudanca = {
        openSessionId: aviso.sessao, openSessionSince: aviso.em, joinedAt: presenca.joinedAt ?? aviso.em,
        ...(presenca.openSessionId ? { lastSessionId: presenca.openSessionId, leftAt: aviso.em } : {}),
      };
    } else {
      const eraAberta = aviso.sessao === presenca.openSessionId;
      // A saída da sessão aberta; ou de uma sessão cuja entrada não chegou (com a duração do Daily). A já contada é ignorada.
      if (!eraAberta && (aviso.sessao === presenca.lastSessionId || aviso.segundos === null)) return "ignorado";
      const segundos = aviso.segundos ?? (aviso.em - Number(presenca.openSessionSince ?? aviso.em)) / 1000;
      somar = segundosCobrados(segundos);
      mudanca = {
        leftAt: Math.max(Number(presenca.leftAt ?? 0), aviso.em), lastSessionId: aviso.sessao,
        joinedAt: presenca.joinedAt ?? Math.round(aviso.em - segundos * 1000),
        ...(eraAberta ? { openSessionId: null, openSessionSince: null } : {}),
      };
    }
    await tx.update(meetingRoomPresences).set({
      ...mudanca, secondsInRoom: sql`${meetingRoomPresences.secondsInRoom} + ${somar}`, updatedAt: Date.now(),
    }).where(eq(meetingRoomPresences.id, presenca.id));
    if (somar) {
      await tx.update(consumoDasSalas).set({ segundosPessoa: sql`${consumoDasSalas.segundosPessoa} + ${somar}` })
        .where(eq(consumoDasSalas.salaId, sala.id));
    }
    return "aplicado";
  });
}

// ── a reunião que sai leva a sala ──────────────────────────────────────────

/**
 * As salas da reunião que sai (exclusão, ou junção a outra na H17) e as
 * presenças delas, com o nome do visitante e o aceite do aviso. O consumo do
 * mês fica (não tem pessoa): a sala ainda aberta passa a contar pelo teto dela
 * (sem as presenças, os avisos do Daily não têm onde somar), e excluir a reunião
 * não devolve minutos ao orçamento. A sala do Daily não é apagada daqui: as
 * fichas param na hora (a linha saiu), e ela vence no fim das 2 horas.
 */
export async function apagarSalasDaReuniao(ex: BancoOuTransacao, ownerId: string, meetingId: string): Promise<void> {
  const salas = await ex.select({ id: meetingRooms.id }).from(meetingRooms)
    .where(and(eq(meetingRooms.ownerId, ownerId), eq(meetingRooms.meetingId, meetingId)));
  if (!salas.length) return;
  const ids = salas.map(sala => sala.id);
  await ex.update(consumoDasSalas).set({ medida: false })
    .where(and(inArray(consumoDasSalas.salaId, ids), isNull(consumoDasSalas.encerradaEm), gt(consumoDasSalas.expiraEm, Date.now())));
  await ex.delete(meetingRoomPresences).where(and(eq(meetingRoomPresences.ownerId, ownerId), inArray(meetingRoomPresences.roomId, ids)));
  await ex.delete(meetingRooms).where(and(eq(meetingRooms.ownerId, ownerId), inArray(meetingRooms.id, ids)));
}
