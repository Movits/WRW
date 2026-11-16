import { TRPCError } from "@trpc/server";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import {
  destinoDaAcaoNaAgenda,
  DURACAO_DO_EVENTO_DA_ACAO_MIN,
  inicioDoEventoDaAcao,
  ROTULOS_SEM_TRADUCAO,
  rotulosDaAgendaValidos,
  textosDaAcaoNaAgenda,
  type RotulosDaAcaoNaAgenda,
} from "@shared/acoes-na-agenda";
import { fusoCanonico } from "@shared/agenda";
import { nomesDosFalantes } from "@shared/const";
import { estadoNaGoogle, type EstadoNaGoogle, type ResultadoNaGoogle } from "@shared/google-agenda-eventos";
import { FUSO_PADRAO_DOS_LEMBRETES, rotaDaProximaAcao } from "@shared/lembretes";
import { MENSAGEM_ACAO_NAO_ENCONTRADA } from "@shared/proximas-acoes";
import { meetings, meetingSummaryItems, proximasAcoes } from "../drizzle/schema";
import {
  acessoDaGoogle,
  codigoParaLog,
  DEPENDENCIAS_DA_GOOGLE,
  motivoSemGoogle,
  type AcessoDaGoogle,
  type ContaDaAgenda,
  type DependenciasDaGoogle,
} from "./agenda-na-google";
import { exigirDb } from "./db";
import { excluirEventoPeloId, gravarEventoPeloId, sessaoDaGoogle, type SessaoDaGoogle } from "./google-agenda-eventos";
import { configuracaoDaGoogleAgendaPara } from "./google-oauth";
import {
  apagarProximaAcao,
  criarProximaAcao,
  editarProximaAcao,
  marcarProximaAcaoFeita,
  type DadosDaAcao,
  type PassoNaGoogle,
} from "./proximas-acoes";

/**
 * A próxima ação na Google Agenda conectada da dona (H5c do plano do gravador):
 * o banco e a ordem das coisas, como a reunião da agenda faz na H16c
 * (server/agenda-na-google.ts), de onde vêm o token, os motivos e as
 * dependências. A regra do que vai para a agenda e do texto do evento está em
 * shared/acoes-na-agenda.ts; a conversa com a Google, em
 * server/google-agenda-eventos.ts. Sem a Google Agenda conectada, a tela
 * oferece o .ics e o link de criar evento (client/src/components/AcaoNaAgenda.tsx).
 *
 * - Com a Google Agenda conectada, a ação aberta com prazo vai para lá sozinha:
 *   anotar com prazo, mudar o texto ou o prazo e reabrir criam ou mudam o
 *   evento; marcar feita, tirar o prazo e apagar o tiram, também pelo resumo da
 *   reunião (desconfirmar o item, marcar a ação feita nele). A ação que já tinha
 *   prazo antes de conectar ganha "Pôr na Google Agenda" na lista.
 * - Primeiro o banco, depois a Google: a escrita grava o estado ("pendente", ou
 *   nulo quando a ação sai da agenda) e só então a Google é chamada. A falha da
 *   Google nunca desfaz o que a dona salvou: a resposta diz `naGoogle: "falhou"`
 *   com o motivo, e a tela mostra "Tentar de novo".
 * - O token vem ANTES da escrita (acessoDaGoogle), e só quando a ação pode ter
 *   evento (tem ou tinha prazo): o banco fora do ar ali derruba a mutação sem
 *   nada feito, e a ação sem prazo não paga uma ida à Google.
 * - O resultado grava com FICHA (o updatedAt da versão que foi à Google), como
 *   na H16c: a ação que mudou no meio só fica "ok" se o evento é o mesmo (ligar
 *   um contato muda a linha e não o evento); a que saiu da agenda no meio
 *   (apagada, feita, sem prazo) leva o evento recém-gravado junto.
 * - O evento não convida ninguém (sendUpdates=none) e não ocupa a agenda.
 * - Desconectar a Google Agenda e excluir a conta da WRW não apagam os eventos
 *   que já estão na agenda da dona, como na H16c.
 *
 * Banco fora do ar sobe como erro (server/CLAUDE.md). O log leva só o código
 * do erro, nunca token, texto da ação ou e-mail.
 */

type Banco = Awaited<ReturnType<typeof exigirDb>>;

export const MENSAGEM_ACAO_AINDA_NA_AGENDA = "Esta próxima ação continua aberta e com prazo; o evento dela fica na Google Agenda.";

const acaoNaoEncontrada = () => new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ACAO_NAO_ENCONTRADA });

function linhasAfetadas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  const linhas = (cabecalho as { affectedRows?: unknown } | null | undefined)?.affectedRows;
  return typeof linhas === "number" ? linhas : 0;
}

/**
 * O id do evento da ação na Google: "acao" e o id da ação sem os hífens. Só
 * letras de 0-9 e a-v (base32hex, como a Google pede; o "o" está entre "a" e
 * "v"), e nunca igual ao de uma reunião da agenda, que é só hexadecimal
 * (idDoEventoNaGoogle). Não há coluna: criar o que já existe dá 409, que vira
 * PATCH, e a resposta perdida de uma criação nunca duplica o evento.
 */
export function idDoEventoDaAcao(acaoId: string): string {
  return `acao${acaoId.replace(/-/g, "").toLowerCase()}`;
}

/** A ação como o envio precisa: o texto do evento, o prazo, o estado na Google e a ficha. */
export type AcaoParaGoogle = {
  id: string;
  texto: string;
  detalhe: string | null;
  responsavel: string | null;
  /** Os nomes das vozes, só enquanto a ação está presa ao item da reunião viva (como na lista). */
  vozes: Record<string, string>;
  prazo: string | null;
  feita: boolean;
  google: EstadoNaGoogle | null;
  updatedAt: number;
};

/** O que decide o evento além da ação: o fuso, os rótulos da tela e o endereço da WRW. */
export type ContextoDaAcaoNaGoogle = { fuso: string; rotulos: RotulosDaAcaoNaAgenda; origem: string | null };

/** O que a tela manda com o pedido: o fuso do aparelho e os rótulos no idioma dela. */
export type PedidoDaTela = { fuso?: string | null; rotulos?: { voz?: unknown; responsavel?: unknown } | null };

/**
 * O contexto do evento a partir do pedido. O fuso que o Intl não conhece, ou
 * nenhum, cai no padrão dos lembretes (o mesmo do sino); os rótulos fora da
 * forma, ou nenhum (a aba aberta antes do deploy), caem nos sem tradução. O
 * endereço da ação vai na descrição, pela origem do FRONTEND_URL.
 */
export function contextoDoPedido(conta: ContaDaAgenda, pedido: PedidoDaTela = {}): ContextoDaAcaoNaGoogle {
  const rotulos = pedido.rotulos;
  return {
    fuso: (pedido.fuso ? fusoCanonico(pedido.fuso) : null) ?? FUSO_PADRAO_DOS_LEMBRETES,
    rotulos: rotulosDaAgendaValidos(rotulos) ? { voz: rotulos.voz, responsavel: rotulos.responsavel } : ROTULOS_SEM_TRADUCAO,
    origem: configuracaoDaGoogleAgendaPara(conta.id)?.origem ?? null,
  };
}

/**
 * O corpo do evento (sem o id, que só vai na criação): às 9h do dia do prazo,
 * no fuso do contexto, por 30 minutos, livre na agenda e com um aviso na hora.
 * Sem prazo válido, nenhum. O PATCH manda todos os campos daqui, a descrição
 * vazia inclusive: o detalhe apagado na WRW sai da Google.
 */
export function corpoDoEventoDaAcao(acao: AcaoParaGoogle, contexto: ContextoDaAcaoNaGoogle): Record<string, unknown> | null {
  const inicio = acao.prazo ? inicioDoEventoDaAcao(acao.prazo, contexto.fuso) : null;
  if (inicio === null) return null;
  const endereco = contexto.origem ? `${contexto.origem}${rotaDaProximaAcao(acao.id)}` : null;
  const { titulo, descricao } = textosDaAcaoNaAgenda(acao, contexto.rotulos, endereco);
  return {
    summary: titulo,
    description: descricao,
    start: { dateTime: new Date(inicio).toISOString(), timeZone: contexto.fuso },
    end: { dateTime: new Date(inicio + DURACAO_DO_EVENTO_DA_ACAO_MIN * 60_000).toISOString(), timeZone: contexto.fuso },
    // Não ocupa a agenda: a dona continua livre às 9h para outras reuniões.
    transparency: "transparent",
    // Um aviso na hora do evento, sem os lembretes padrão da agenda dela.
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] },
    // Na criação é o padrão. No PATCH (depois do 409), traz de volta o evento
    // que a dona apagou na Google: a ação continua aberta e com prazo na WRW.
    status: "confirmed",
  };
}

const COLUNAS_PARA_GOOGLE = {
  id: proximasAcoes.id,
  texto: proximasAcoes.texto,
  detalhe: proximasAcoes.detalhe,
  responsavel: proximasAcoes.responsavel,
  prazo: proximasAcoes.prazo,
  feita: proximasAcoes.feita,
  google: proximasAcoes.google,
  updatedAt: proximasAcoes.updatedAt,
  reuniaoViva: meetings.id,
  vozesDaReuniao: meetings.speakerNames,
  itemVivo: meetingSummaryItems.id,
};

const daDona = (ownerId: string, id: string) => and(eq(proximasAcoes.id, id), eq(proximasAcoes.ownerId, ownerId));
/**
 * A ação da dona, só se ela ainda for a versão da ficha e ainda tiver estado na
 * Google: o nulo veio de ela sair da agenda, da desconexão ou da troca da conta
 * Google, e o envio que estava no meio não o desfaz.
 */
const naFicha = (ownerId: string, id: string, ficha: number) =>
  and(eq(proximasAcoes.id, id), eq(proximasAcoes.ownerId, ownerId), eq(proximasAcoes.updatedAt, ficha), isNotNull(proximasAcoes.google));

/** A ação da dona como o envio precisa. A reunião e o item só valem se ainda são dela, como na lista. */
async function lerAcao(db: Banco, ownerId: string, id: string): Promise<AcaoParaGoogle | null> {
  const [linha] = await db.select(COLUNAS_PARA_GOOGLE).from(proximasAcoes)
    .leftJoin(meetings, and(eq(meetings.id, proximasAcoes.meetingId), eq(meetings.ownerId, proximasAcoes.ownerId), ne(meetings.status, "deleted")))
    .leftJoin(meetingSummaryItems, and(eq(meetingSummaryItems.id, proximasAcoes.itemId), eq(meetingSummaryItems.ownerId, proximasAcoes.ownerId)))
    .where(daDona(ownerId, id))
    .limit(1);
  if (!linha) return null;
  const presaAoItem = linha.reuniaoViva !== null && linha.reuniaoViva !== undefined && linha.itemVivo !== null && linha.itemVivo !== undefined;
  return {
    id: String(linha.id),
    texto: String(linha.texto),
    detalhe: typeof linha.detalhe === "string" ? linha.detalhe : null,
    responsavel: typeof linha.responsavel === "string" ? linha.responsavel : null,
    vozes: presaAoItem ? nomesDosFalantes(linha.vozesDaReuniao) : {},
    prazo: typeof linha.prazo === "string" ? linha.prazo : null,
    feita: Boolean(linha.feita),
    google: estadoNaGoogle(linha.google),
    updatedAt: Number(linha.updatedAt),
  };
}

/** A ação da dona para o envio; NOT_FOUND quando não é dela ou saiu. */
export async function acaoParaGoogle(ownerId: string, id: string): Promise<AcaoParaGoogle> {
  const acao = await lerAcao(await exigirDb(), ownerId, id);
  if (!acao) throw acaoNaoEncontrada();
  return acao;
}

type Registro = "gravado" | "mudou" | "fora";

/**
 * Grava o resultado da Google na ação, se ela ainda é a versão que foi para lá
 * (a ficha). Mudou no meio: o "ok" ainda vale quando o evento é o mesmo; o
 * "falhou" e o nulo nunca passam por cima, porque quem mudou manda a versão
 * dele. A ação que saiu da agenda no meio (apagada, feita, sem prazo) é "fora":
 * o evento recém-gravado sai.
 */
async function registrar(
  db: Banco, ownerId: string, acao: AcaoParaGoogle, estado: "ok" | "falhou" | null, contexto: ContextoDaAcaoNaGoogle, agora: number,
): Promise<Registro> {
  const gravado = await db.update(proximasAcoes).set({ google: estado }).where(naFicha(ownerId, acao.id, acao.updatedAt));
  if (linhasAfetadas(gravado)) return "gravado";
  if (estado !== "ok") return "mudou";
  const atual = await lerAcao(db, ownerId, acao.id);
  if (!atual || destinoDaAcaoNaAgenda(atual, contexto.fuso, agora) === "tirar") return "fora";
  if (JSON.stringify(corpoDoEventoDaAcao(atual, contexto)) !== JSON.stringify(corpoDoEventoDaAcao(acao, contexto))) return "mudou";
  const naNovaFicha = await db.update(proximasAcoes).set({ google: estado }).where(naFicha(ownerId, acao.id, atual.updatedAt));
  return linhasAfetadas(naNovaFicha) ? "gravado" : "mudou";
}

/** O que o envio recebe de quem chama: o token já lido antes da escrita e os dublês do teste. */
export type OpcoesDaGoogle = { acesso?: AcessoDaGoogle; deps?: DependenciasDaGoogle };

/**
 * Manda a ação para a Google Agenda da dona: cria o evento, ou o muda (409 vira
 * PATCH). Serve à escrita (logo depois de o banco gravar "pendente"), ao "Pôr
 * na Google Agenda" e ao "Tentar de novo". Lê a ação de novo: a ficha é a versão
 * que está no banco agora.
 *
 * - Feita ou sem prazo: nada a mandar (quem tira o evento é tirarAcaoDaGoogle).
 * - Com o dia do prazo encerrado, a que não está lá fica de fora, sem chamar a
 *   Google, e a que está só muda; a que sumiu de lá volta a nulo.
 * - Sem a Google Agenda conectada, a que estava lá fica "falhou" (a Google ficou
 *   com a versão antiga), e a que nunca foi continua nula.
 * - Com o token, a ação fica "pendente" ANTES da chamada: se o processo cair no
 *   meio, a tela mostra "Tentar de novo".
 */
export async function enviarAcaoParaGoogle(conta: ContaDaAgenda, acaoId: string, contexto: ContextoDaAcaoNaGoogle, opcoes: OpcoesDaGoogle = {}): Promise<ResultadoNaGoogle> {
  const deps = opcoes.deps ?? DEPENDENCIAS_DA_GOOGLE;
  const db = await exigirDb();
  const acao = await lerAcao(db, conta.openId, acaoId);
  if (!acao) throw acaoNaoEncontrada();
  const agora = deps.agora();
  const destino = destinoDaAcaoNaAgenda(acao, contexto.fuso, agora);
  const corpo = corpoDoEventoDaAcao(acao, contexto);
  if (destino === "tirar" || !corpo || (destino === "atualizar" && acao.google === null)) return { naGoogle: null };
  const acesso = opcoes.acesso ?? await acessoDaGoogle(conta, deps);
  if ("motivo" in acesso) {
    if (acao.google !== null) await registrar(db, conta.openId, acao, "falhou", contexto, agora);
    return { naGoogle: "falhou", motivo: acesso.motivo };
  }
  if (acao.google !== "pendente") {
    const marcada = await db.update(proximasAcoes).set({ google: "pendente" }).where(daDona(conta.openId, acao.id));
    // A ação saiu entre a leitura e aqui: nada vai à Google.
    if (!linhasAfetadas(marcada)) throw acaoNaoEncontrada();
  }
  const sessao = sessaoDaGoogle(acesso.token, () => deps.renovar(conta.id), deps.buscar);
  let gravacao: "gravado" | "ausente";
  try {
    gravacao = await gravarEventoPeloId(sessao, idDoEventoDaAcao(acao.id), corpo, false, destino === "gravar");
  } catch (erro) {
    const motivo = motivoSemGoogle(erro);
    console.warn(`[Google Agenda] o evento da próxima ação não foi gravado: ${codigoParaLog(erro)}`);
    await registrar(db, conta.openId, acao, "falhou", contexto, agora);
    return { naGoogle: "falhou", motivo };
  }
  if (gravacao === "ausente") {
    await registrar(db, conta.openId, acao, null, contexto, agora);
    return { naGoogle: null };
  }
  if ((await registrar(db, conta.openId, acao, "ok", contexto, agora)) === "fora") await tirarOrfao(sessao, acao.id);
  return { naGoogle: "ok" };
}

/** A ação saiu da agenda enquanto a Google gravava: o evento sai também. Melhor esforço, com log. */
async function tirarOrfao(sessao: SessaoDaGoogle, acaoId: string) {
  try {
    await excluirEventoPeloId(sessao, idDoEventoDaAcao(acaoId), false);
  } catch (erro) {
    console.warn(`[Google Agenda] a próxima ação saiu da agenda durante o envio, e o evento não foi tirado da Google: ${codigoParaLog(erro)}`);
  }
}

/**
 * Tira o evento da ação da Google Agenda da dona: a ação ficou feita, perdeu o
 * prazo ou foi apagada (o banco já gravou isso). O evento que não existe (404
 * ou 410) conta como tirado, e a tentativa vale mesmo para a ação cujo estado
 * era nulo: a desconexão o zera, e quem reconecta a mesma conta Google ainda
 * tem o evento lá. A falha só vira "falhou" com o motivo quando a ação estava na
 * Google (`estavaNaGoogle`): aí a tela avisa que o evento continua lá, com
 * "Tentar de novo"; senão, só o log.
 */
export async function tirarAcaoDaGoogle(
  conta: ContaDaAgenda, acaoId: string, opcoes: OpcoesDaGoogle & { estavaNaGoogle: boolean },
): Promise<ResultadoNaGoogle> {
  const deps = opcoes.deps ?? DEPENDENCIAS_DA_GOOGLE;
  const acesso = opcoes.acesso ?? await acessoDaGoogle(conta, deps);
  if ("motivo" in acesso) return opcoes.estavaNaGoogle ? { naGoogle: "falhou", motivo: acesso.motivo } : { naGoogle: null };
  try {
    await excluirEventoPeloId(sessaoDaGoogle(acesso.token, () => deps.renovar(conta.id), deps.buscar), idDoEventoDaAcao(acaoId), false);
  } catch (erro) {
    const motivo = motivoSemGoogle(erro);
    console.warn(`[Google Agenda] o evento da próxima ação não saiu da Google: ${codigoParaLog(erro)}`);
    return opcoes.estavaNaGoogle ? { naGoogle: "falhou", motivo } : { naGoogle: null };
  }
  return { naGoogle: opcoes.estavaNaGoogle ? "ok" : null };
}

// ── as mutações da lista e do resumo ───────────────────────────────────────

/**
 * O token, só quando a ação pode ter evento (tem ou tinha prazo), lido antes da
 * escrita. `ligada` é a Google Agenda conectada, mesmo com a conexão quebrada
 * (a ação vai "pendente" e falha com o motivo, para a tela pedir "Reconectar"),
 * como googleAgendaConectada na H16c.
 */
async function acessoSePuderTerEvento(conta: ContaDaAgenda, podeTerEvento: boolean, deps: DependenciasDaGoogle) {
  if (!podeTerEvento) return { acesso: null, ligada: false };
  const acesso = await acessoDaGoogle(conta, deps);
  return { acesso, ligada: !("motivo" in acesso) || acesso.motivo !== "nao-conectada" };
}

/** Depois da escrita, pelo destino que ela gravou: tira o evento, manda a versão nova ou não faz nada. */
async function depoisDaEscrita(
  conta: ContaDaAgenda, acaoId: string, contexto: ContextoDaAcaoNaGoogle, passo: PassoNaGoogle | undefined,
  acesso: AcessoDaGoogle | null, ligada: boolean, deps: DependenciasDaGoogle,
): Promise<ResultadoNaGoogle> {
  if (!passo || !acesso) return { naGoogle: null };
  if (passo.destino === "tirar") return tirarAcaoDaGoogle(conta, acaoId, { estavaNaGoogle: passo.googleAntes !== null, acesso, deps });
  // Sem a Google Agenda, a escrita já deixou "falhou" na que estava lá, e a tela
  // (que só mostra o estado com a Google Agenda conectada) não tem o que dizer.
  if (!ligada || (passo.destino === "atualizar" && passo.googleAntes === null)) return { naGoogle: null };
  return enviarAcaoParaGoogle(conta, acaoId, contexto, { acesso, deps });
}

/** Anotar à mão: a ação com prazo por vir vai para a Google, com a Google Agenda conectada. */
export async function criarAcaoComAGoogle(
  conta: ContaDaAgenda, dados: DadosDaAcao, pedido: PedidoDaTela = {}, deps: DependenciasDaGoogle = DEPENDENCIAS_DA_GOOGLE,
): Promise<{ id: string } & ResultadoNaGoogle> {
  const contexto = contextoDoPedido(conta, pedido);
  const vai = destinoDaAcaoNaAgenda({ prazo: dados.prazo || null, feita: false }, contexto.fuso, deps.agora()) === "gravar";
  const { acesso, ligada } = await acessoSePuderTerEvento(conta, vai, deps);
  const { id } = await criarProximaAcao(conta.openId, dados, { naGoogle: ligada });
  if (!acesso || !ligada) return { id, naGoogle: null };
  return { id, ...(await enviarAcaoParaGoogle(conta, id, contexto, { acesso, deps })) };
}

/** Editar: o texto ou o prazo novos vão para a Google; sem prazo, o evento sai. */
export async function editarAcaoComAGoogle(
  conta: ContaDaAgenda, acaoId: string, campos: Partial<Omit<DadosDaAcao, "contactId">>, pedido: PedidoDaTela = {},
  deps: DependenciasDaGoogle = DEPENDENCIAS_DA_GOOGLE,
): Promise<ResultadoNaGoogle> {
  const contexto = contextoDoPedido(conta, pedido);
  const antes = await acaoParaGoogle(conta.openId, acaoId);
  const prazoDepois = campos.prazo !== undefined ? campos.prazo || null : antes.prazo;
  const { acesso, ligada } = await acessoSePuderTerEvento(conta, antes.prazo !== null || prazoDepois !== null, deps);
  const passo = await editarProximaAcao(conta.openId, acaoId, campos, { naGoogle: ligada, fuso: contexto.fuso, agora: deps.agora() });
  return depoisDaEscrita(conta, acaoId, contexto, passo, acesso, ligada, deps);
}

/** Marcar feita tira o evento; reabrir manda de novo a ação com prazo por vir. */
export async function marcarAcaoFeitaComAGoogle(
  conta: ContaDaAgenda, acaoId: string, feita: boolean, pedido: PedidoDaTela = {}, deps: DependenciasDaGoogle = DEPENDENCIAS_DA_GOOGLE,
): Promise<ResultadoNaGoogle> {
  const contexto = contextoDoPedido(conta, pedido);
  const antes = await acaoParaGoogle(conta.openId, acaoId);
  const { acesso, ligada } = await acessoSePuderTerEvento(conta, antes.prazo !== null, deps);
  const { prazo, googleAntes } = await marcarProximaAcaoFeita(conta.openId, acaoId, feita);
  const destino = destinoDaAcaoNaAgenda({ prazo, feita }, contexto.fuso, deps.agora());
  return depoisDaEscrita(conta, acaoId, contexto, { destino, googleAntes }, acesso, ligada, deps);
}

/** Apagar a ação tira o evento dela. */
export async function apagarAcaoComAGoogle(conta: ContaDaAgenda, acaoId: string, deps: DependenciasDaGoogle = DEPENDENCIAS_DA_GOOGLE): Promise<ResultadoNaGoogle> {
  const antes = await acaoParaGoogle(conta.openId, acaoId);
  const { acesso } = await acessoSePuderTerEvento(conta, antes.prazo !== null, deps);
  const { googleAntes } = await apagarProximaAcao(conta.openId, acaoId);
  if (!acesso) return { naGoogle: null };
  return tirarAcaoDaGoogle(conta, acaoId, { estavaNaGoogle: googleAntes !== null, acesso, deps });
}

/** "Pôr na Google Agenda" e "Tentar de novo": manda a versão que está no banco. */
export async function mandarAcaoParaGoogle(
  conta: ContaDaAgenda, acaoId: string, pedido: PedidoDaTela = {}, deps: DependenciasDaGoogle = DEPENDENCIAS_DA_GOOGLE,
): Promise<ResultadoNaGoogle> {
  return enviarAcaoParaGoogle(conta, acaoId, contextoDoPedido(conta, pedido), { deps });
}

/**
 * O "Tentar de novo" de quando o evento não saiu da Google: a ação foi apagada,
 * feita ou perdeu o prazo. A que continua aberta e com prazo é CONFLICT: o
 * evento dela é para ficar.
 */
export async function tirarDaGoogleAAcaoQueSaiu(conta: ContaDaAgenda, acaoId: string, deps: DependenciasDaGoogle = DEPENDENCIAS_DA_GOOGLE): Promise<ResultadoNaGoogle> {
  const atual = await lerAcao(await exigirDb(), conta.openId, acaoId);
  if (atual && !atual.feita && atual.prazo) throw new TRPCError({ code: "CONFLICT", message: MENSAGEM_ACAO_AINDA_NA_AGENDA });
  return tirarAcaoDaGoogle(conta, acaoId, { estavaNaGoogle: true, deps });
}

/** A ação de um item do resumo antes de mexer nele, com o token, quando ela pode ter evento. */
export type AcaoDoItemNaGoogle = { acaoId: string; estavaNaGoogle: boolean; acesso: AcessoDaGoogle; ligada: boolean };

/**
 * Antes de desconfirmar o item, de marcar a ação dele no resumo ou de editá-lo
 * (H4f): a ação dele, quando tem prazo, e o token, lido antes da escrita. Sem
 * ação, ou sem prazo, nada (ela não pode ter evento).
 */
export async function prepararAcaoDoItem(conta: ContaDaAgenda, itemId: string, deps: DependenciasDaGoogle = DEPENDENCIAS_DA_GOOGLE): Promise<AcaoDoItemNaGoogle | null> {
  const db = await exigirDb();
  const [acao] = await db.select({ id: proximasAcoes.id, prazo: proximasAcoes.prazo, google: proximasAcoes.google })
    .from(proximasAcoes)
    .where(and(eq(proximasAcoes.ownerId, conta.openId), eq(proximasAcoes.itemId, itemId)))
    .limit(1);
  if (!acao || !acao.prazo) return null;
  const { acesso, ligada } = await acessoSePuderTerEvento(conta, true, deps);
  if (!acesso) return null;
  return { acaoId: acao.id, estavaNaGoogle: estadoNaGoogle(acao.google) !== null, acesso, ligada };
}

/**
 * Depois de mexer no item do resumo: a ação desconfirmada (apagada) ou marcada
 * feita sai da Google; a reaberta volta, e a do item editado (H4f) vai com o
 * texto novo. O id da ação vai junto, para o "Tentar de novo" da tela.
 */
export async function depoisDeMexerNoItem(
  conta: ContaDaAgenda, preparo: AcaoDoItemNaGoogle | null, ficouAberta: boolean, pedido: PedidoDaTela = {},
  deps: DependenciasDaGoogle = DEPENDENCIAS_DA_GOOGLE,
): Promise<ResultadoNaGoogle & { acaoId: string | null }> {
  if (!preparo) return { acaoId: null, naGoogle: null };
  if (!ficouAberta) {
    return { acaoId: preparo.acaoId, ...(await tirarAcaoDaGoogle(conta, preparo.acaoId, { estavaNaGoogle: preparo.estavaNaGoogle, acesso: preparo.acesso, deps })) };
  }
  if (!preparo.ligada) return { acaoId: preparo.acaoId, naGoogle: null };
  return { acaoId: preparo.acaoId, ...(await enviarAcaoParaGoogle(conta, preparo.acaoId, contextoDoPedido(conta, pedido), { acesso: preparo.acesso, deps })) };
}
