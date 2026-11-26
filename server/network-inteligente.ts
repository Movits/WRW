import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  aiMatchSuggestions, contactAssets, contactNeeds, meetings, meetingTranscripts, privateContacts,
} from "../drizzle/schema";
import { camposFaltantes, type CampoDaCompletude } from "../shared/completude-do-contato";
import { exigirDb } from "./db";
import { reuniaoVisivel } from "./reuniao-visivel";
import { LIMITE_GRATUITO_POR_REUNIAO_SEGUNDOS } from "./minutos-de-reuniao";

/**
 * Meu Network Inteligente — o resumo do painel (pedido do Nicolas, 13/09/2026,
 * item 19), só com o que já existe no banco. Nenhuma coluna ou tabela nova.
 *
 * Toda consulta leva o openId da dona no WHERE: é a rede particular DELA, e
 * nada aqui atravessa donas. As sugestões entre contatos só são contadas com o
 * termo do Smart Match vigente — quem chama decide e passa `termoSmartMatch`;
 * sem ele a tabela nem é lida, igual à tela de Conexões Inteligentes.
 *
 * Conexões registradas (internas e com a rede global), intermediações,
 * negócios, comissões e minutos do mês têm consultas próprias no router
 * (networkInteligente.conexoes e .minutos), com as regras delas.
 */

/** Quantos contatos incompletos o painel lista pelo nome. A contagem vem inteira. */
export const AMOSTRA_DE_INCOMPLETOS = 5;
/** Contatos por página na leitura da completude (N4b). */
export const CONTATOS_POR_PAGINA_DO_RESUMO = 1000;

export type ContatoIncompleto = { id: number; fullName: string; faltando: CampoDaCompletude[] };

export type ResumoDoNetworkInteligente = {
  reunioes: { total: number; transcritas: number; emAndamento: number; comFalha: number };
  minutos: {
    /** Soma da duração das reuniões transcritas que continuam na conta (não é consumo mensal). */
    segundosEmReunioesGuardadas: number;
    /**
     * O teto da reunião gravada (12 h desde a G13b, o da gravação em partes), o
     * mesmo do plano gratuito em networkInteligente.minutos. Vale também para o
     * arquivo enviado, que vai em partes (H9a, H9b e H9c), e a tela diz os dois.
     */
    limitePorReuniaoSegundos: number;
  };
  /** `disponibilizados`: contatos com SIM em "Disponibilizar este contato para oportunidades da rede" (spec de 14/09, item 14). */
  contatos: { total: number; incompletos: number; disponibilizados: number; amostraIncompletos: ContatoIncompleto[] };
  matchesInternos: { termoAceito: true; novos: number; total: number } | { termoAceito: false };
};

// COUNT e SUM chegam como número ou como texto, conforme o driver e o banco.
const numero = (valor: unknown) => Number(valor ?? 0) || 0;

export async function resumoDoNetworkInteligente(
  ownerId: string,
  opcoes: { termoSmartMatch: boolean },
): Promise<ResumoDoNetworkInteligente> {
  const db = await exigirDb();

  // Reuniões por status. 'deleted' é a exclusão em curso: para a dona, a
  // reunião já não existe; a da lixeira (H7d) também não conta.
  const reunioesPorStatus = await db
    .select({ status: meetings.status, total: sql<number>`COUNT(*)` })
    .from(meetings)
    .where(and(eq(meetings.ownerId, ownerId), reuniaoVisivel()))
    .groupBy(meetings.status);
  const porStatus = new Map(reunioesPorStatus.map(linha => [linha.status, numero(linha.total)]));
  const doStatus = (status: string) => porStatus.get(status as never) ?? 0;
  const reunioes = {
    total: Array.from(porStatus.values()).reduce((soma, n) => soma + n, 0),
    transcritas: doStatus("ready"),
    emAndamento: doStatus("draft") + doStatus("recording") + doStatus("processing"),
    comFalha: doStatus("failed"),
  };

  // Duração das reuniões transcritas guardadas. O join com meetings deixa de
  // fora a reunião em exclusão, como na contagem acima.
  const [duracao] = await db
    .select({ segundos: sql<number>`COALESCE(SUM(${meetingTranscripts.durationSeconds}), 0)` })
    .from(meetingTranscripts)
    .innerJoin(meetings, eq(meetings.id, meetingTranscripts.meetingId))
    .where(and(
      eq(meetingTranscripts.ownerId, ownerId),
      eq(meetings.ownerId, ownerId),
      reuniaoVisivel(),
    ));

  // Completude. A régua é a função pura de shared/, a mesma do alerta no
  // detalhe do contato; por isso a leitura traz as 5 colunas curtas de cada
  // contato (nunca notas, foto ou cartão) em vez de repetir a regra em SQL,
  // onde as duas poderiam divergir.
  //
  // Paginada pelo id (N4b): a conta da entidade tem dezenas de milhares de
  // contatos, e a leitura de uma vez segurava todos na memória. Cada página
  // traz os seus "tem" e "preciso"; a amostra guarda só os incompletos mais
  // recentes (a ordem de antes, pelo updatedAt; no empate, o id menor).
  let total = 0;
  let disponibilizados = 0;
  let totalIncompletos = 0;
  const amostra: Array<ContatoIncompleto & { updatedAt: number }> = [];
  let depoisDe = 0;
  for (;;) {
    const pagina = await db
      .select({
        id: privateContacts.id,
        fullName: privateContacts.fullName,
        phone: privateContacts.phone,
        whatsapp: privateContacts.whatsapp,
        email: privateContacts.email,
        disponivelRedeGlobal: privateContacts.disponivelRedeGlobal,
        updatedAt: privateContacts.updatedAt,
      })
      .from(privateContacts)
      .where(and(eq(privateContacts.ownerId, ownerId), gt(privateContacts.id, depoisDe)))
      .orderBy(asc(privateContacts.id))
      .limit(CONTATOS_POR_PAGINA_DO_RESUMO);
    if (!pagina.length) break;
    const ids = pagina.map(contato => numero(contato.id));
    const [comTenho, comPreciso] = await Promise.all([
      db.selectDistinct({ contactId: contactAssets.contactId }).from(contactAssets)
        .where(and(eq(contactAssets.ownerId, ownerId), inArray(contactAssets.contactId, ids))),
      db.selectDistinct({ contactId: contactNeeds.contactId }).from(contactNeeds)
        .where(and(eq(contactNeeds.ownerId, ownerId), inArray(contactNeeds.contactId, ids))),
    ]);
    const idsComTenho = new Set(comTenho.map(linha => numero(linha.contactId)));
    const idsComPreciso = new Set(comPreciso.map(linha => numero(linha.contactId)));
    for (const contato of pagina) {
      total += 1;
      if (contato.disponivelRedeGlobal) disponibilizados += 1;
      const faltando = camposFaltantes({
        ...contato,
        totalTenho: idsComTenho.has(numero(contato.id)) ? 1 : 0,
        totalPreciso: idsComPreciso.has(numero(contato.id)) ? 1 : 0,
      });
      if (!faltando.length) continue;
      totalIncompletos += 1;
      amostra.push({ id: numero(contato.id), fullName: contato.fullName, faltando, updatedAt: numero(contato.updatedAt) });
      amostra.sort((a, b) => b.updatedAt - a.updatedAt || a.id - b.id);
      if (amostra.length > AMOSTRA_DE_INCOMPLETOS) amostra.pop();
    }
    if (pagina.length < CONTATOS_POR_PAGINA_DO_RESUMO) break;
    depoisDe = ids[ids.length - 1];
  }

  let matchesInternos: ResumoDoNetworkInteligente["matchesInternos"] = { termoAceito: false };
  if (opcoes.termoSmartMatch) {
    const sugestoesPorStatus = await db
      .select({ status: aiMatchSuggestions.status, total: sql<number>`COUNT(*)` })
      .from(aiMatchSuggestions)
      .where(eq(aiMatchSuggestions.ownerId, ownerId))
      .groupBy(aiMatchSuggestions.status);
    const sugestoes = new Map(sugestoesPorStatus.map(linha => [linha.status, numero(linha.total)]));
    const daSugestao = (status: string) => sugestoes.get(status as never) ?? 0;
    // Dispensada não conta: a dona já disse que não serve.
    matchesInternos = {
      termoAceito: true,
      novos: daSugestao("pending"),
      total: daSugestao("pending") + daSugestao("viewed") + daSugestao("accepted"),
    };
  }

  return {
    reunioes,
    minutos: {
      segundosEmReunioesGuardadas: numero(duracao?.segundos),
      limitePorReuniaoSegundos: LIMITE_GRATUITO_POR_REUNIAO_SEGUNDOS,
    },
    contatos: {
      total,
      incompletos: totalIncompletos,
      disponibilizados,
      amostraIncompletos: amostra.map(({ id, fullName, faltando }) => ({ id, fullName, faltando })),
    },
    matchesInternos,
  };
}
