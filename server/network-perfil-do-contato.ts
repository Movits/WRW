import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import {
  contactAssets, contactContexts, contactNeeds, contexts, meetingContactSuggestions, meetingEntities, meetings,
  networkSugestoes, privateContacts,
} from "../drizzle/schema";
import { camposFaltantes } from "../shared/completude-do-contato";
import { exigirDb } from "./db";
import { garantirCodigosAnonimos } from "./network-codigo-anonimo";
import { listarPendencias } from "./network-extracao";
import { listarConexoesDaSolicitante, type ConexaoVisivel, type Solicitante } from "./network-registro";
import { ACOES_NO_PERFIL_DO_CONTATO, proximasAcoesDoContato } from "./proximas-acoes";
import { origemDosItensDoContato } from "./reuniao-no-match";
import { slugDoItem } from "../shared/reuniao-no-match";

/**
 * O perfil de um contato no Meu Network Inteligente — spec da Glenda de 14/09,
 * itens 20 e 22: QUEM SOU, O QUE TENHO, O QUE PRECISO, ID anônimo, reuniões
 * vinculadas, informações faltantes, conexões e intermediações, status de
 * disponibilização e a MEMÓRIA DE RELACIONAMENTO (linha do tempo privada). E,
 * desde a H5b do desenho do gravador, as próximas ações que a dona ligou ao
 * contato (server/proximas-acoes.ts).
 *
 * É a agenda da própria dona: toda consulta leva o openId dela no WHERE, e
 * contato de outra dona sai como "não encontrado" antes de qualquer outra
 * leitura. Nada aqui é visto por outra conta.
 *
 * A linha do tempo é MONTADA a partir do que já existe — reuniões, contextos
 * (onde se conheceram), itens de tenho/preciso com a data em que entraram,
 * confirmações de Quem Sou vindas da IA (e, à parte, as de cargo e empresa,
 * que não são Quem Sou), a disponibilização, as conexões registradas com suas
 * etapas e as próximas ações (a anotada e a feita). Sem tabela nova de
 * eventos: o que não deixou rastro (remoção de um item, a ação desmarcada ou
 * desligada do contato, por exemplo) não aparece, e o relatório diz isso.
 */

export type EventoDaLinhaDoTempo =
  | { tipo: "contato_criado"; em: number }
  | { tipo: "reuniao"; em: number; meetingId: string; titulo: string; assuntos: string[] }
  | { tipo: "contexto"; em: number; nome: string; data: string | null }
  | { tipo: "tenho_adicionado" | "preciso_adicionado"; em: number; valor: string }
  | { tipo: "quem_sou_confirmado"; em: number; campo: string; valor: string; origem: string }
  | { tipo: "apoio_confirmado"; em: number; campo: "cargo" | "empresa"; valor: string; origem: string }
  | { tipo: "disponibilidade"; em: number; disponivel: boolean }
  | { tipo: "conexao_registrada"; em: number; conexaoId: string; origem: string }
  | { tipo: "conexao_etapa"; em: number; conexaoId: string; etapa: "apresentacao" | "negociacao" | "fechada" | "descartada" }
  // O texto da ação vai com os rótulos de voz ({F2}) e o mapa dos nomes, como
  // na lista das próximas ações: quem troca o rótulo pelo nome é a tela
  // (shared/vozes-no-texto.ts).
  | { tipo: "proxima_acao" | "proxima_acao_feita"; em: number; acaoId: string; texto: string; vozes: Record<string, string> };

/** Função pura: junta, ordena (mais recente primeiro) e limita. É o que os testes exercitam. */
export function montarLinhaDoTempo(dados: {
  contato: { createdAt: number; disponivelRedeGlobal: boolean; disponibilidadeAlteradaEm: number | null };
  reunioes: Array<{ id: string; title: string; createdAt: number; assuntos: string[] }>;
  contextos: Array<{ nome: string; data: string | null; createdAt: number }>;
  tenho: Array<{ label: string; createdAt: number }>;
  preciso: Array<{ label: string; createdAt: number }>;
  confirmacoes: Array<{ campo: string; valor: string; origem: string; decididaEm: number | null }>;
  conexoes: ConexaoVisivel[];
  acoes: Array<{ id: string; texto: string; vozes: Record<string, string>; createdAt: number; feita: boolean; feitaEm: number | null }>;
}, limite = 100): EventoDaLinhaDoTempo[] {
  const eventos: EventoDaLinhaDoTempo[] = [{ tipo: "contato_criado", em: Number(dados.contato.createdAt) }];
  for (const r of dados.reunioes) eventos.push({ tipo: "reuniao", em: Number(r.createdAt), meetingId: r.id, titulo: r.title, assuntos: r.assuntos });
  for (const c of dados.contextos) eventos.push({ tipo: "contexto", em: Number(c.createdAt), nome: c.nome, data: c.data });
  for (const t of dados.tenho) eventos.push({ tipo: "tenho_adicionado", em: Number(t.createdAt), valor: t.label });
  for (const p of dados.preciso) eventos.push({ tipo: "preciso_adicionado", em: Number(p.createdAt), valor: p.label });
  for (const c of dados.confirmacoes) {
    // Tenho/preciso confirmados já aparecem pelo item gravado; aqui o Quem Sou, e cargo e empresa à parte.
    if (c.decididaEm === null || c.campo === "tenho" || c.campo === "preciso") continue;
    // Cargo e empresa nunca são QUEM SOU (item 6 da spec): têm evento próprio (revisão da IA3).
    if (c.campo === "cargo" || c.campo === "empresa") {
      eventos.push({ tipo: "apoio_confirmado", em: Number(c.decididaEm), campo: c.campo, valor: c.valor, origem: c.origem });
      continue;
    }
    eventos.push({ tipo: "quem_sou_confirmado", em: Number(c.decididaEm), campo: c.campo, valor: c.valor, origem: c.origem });
  }
  if (dados.contato.disponibilidadeAlteradaEm !== null) {
    eventos.push({ tipo: "disponibilidade", em: Number(dados.contato.disponibilidadeAlteradaEm), disponivel: dados.contato.disponivelRedeGlobal });
  }
  for (const conexao of dados.conexoes) {
    eventos.push({ tipo: "conexao_registrada", em: conexao.criadaEm, conexaoId: conexao.id, origem: conexao.origem });
    const etapas = [
      ["apresentacao", conexao.apresentacaoEm], ["negociacao", conexao.negociacaoEm],
      ["fechada", conexao.fechamentoEm], ["descartada", conexao.descartadaEm],
    ] as const;
    for (const [etapa, em] of etapas) if (em !== null) eventos.push({ tipo: "conexao_etapa", em, conexaoId: conexao.id, etapa });
  }
  for (const acao of dados.acoes) {
    const base = { acaoId: acao.id, texto: acao.texto, vozes: acao.vozes };
    const feitaEm = acao.feita && acao.feitaEm !== null ? Number(acao.feitaEm) : null;
    // A feita entra antes: no empate, a ordem (estável) a deixa acima da anotada.
    if (feitaEm !== null) eventos.push({ tipo: "proxima_acao_feita", em: feitaEm, ...base });
    // A ação que nasceu já feita (o item marcado no resumo antes de virar ação)
    // guarda a hora real da caixa, anterior à criação: a anotada não fica
    // depois da feita.
    const anotadaEm = Number(acao.createdAt);
    eventos.push({ tipo: "proxima_acao", em: feitaEm !== null ? Math.min(anotadaEm, feitaEm) : anotadaEm, ...base });
  }
  return eventos.sort((x, y) => y.em - x.em).slice(0, limite);
}

export async function perfilDoContato(quem: Solicitante, contactId: number, opcoes: { termoSmartMatch: boolean }) {
  const db = await exigirDb();
  const [existe] = await db.select({ id: privateContacts.id, codigoAnonimo: privateContacts.codigoAnonimo }).from(privateContacts)
    .where(and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, quem.openId))).limit(1);
  if (!existe) return null;
  if (!existe.codigoAnonimo) await garantirCodigosAnonimos(quem.openId);

  const [contato] = await db.select({
    id: privateContacts.id,
    fullName: privateContacts.fullName,
    phone: privateContacts.phone,
    whatsapp: privateContacts.whatsapp,
    email: privateContacts.email,
    tipoPessoa: privateContacts.tipoPessoa,
    company: privateContacts.company,
    codigoAnonimo: privateContacts.codigoAnonimo,
    disponivelRedeGlobal: privateContacts.disponivelRedeGlobal,
    disponibilidadeAlteradaEm: privateContacts.disponibilidadeAlteradaEm,
    createdAt: privateContacts.createdAt,
  }).from(privateContacts).where(and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, quem.openId))).limit(1);
  if (!contato) return null;

  const [tenho, preciso, sugestoesDaReuniao, vinculos, confirmacoes, pendencias, acoes] = await Promise.all([
    db.select({ id: contactAssets.id, slug: contactAssets.tagSlug, label: contactAssets.tagLabel, category: contactAssets.category, createdAt: contactAssets.createdAt })
      .from(contactAssets).where(and(eq(contactAssets.ownerId, quem.openId), eq(contactAssets.contactId, contactId))),
    db.select({ id: contactNeeds.id, slug: contactNeeds.tagSlug, label: contactNeeds.tagLabel, category: contactNeeds.category, createdAt: contactNeeds.createdAt })
      .from(contactNeeds).where(and(eq(contactNeeds.ownerId, quem.openId), eq(contactNeeds.contactId, contactId))),
    db.select({ meetingId: meetingContactSuggestions.meetingId }).from(meetingContactSuggestions)
      .where(and(eq(meetingContactSuggestions.ownerId, quem.openId), eq(meetingContactSuggestions.existingContactId, contactId))),
    db.select({ contextId: contactContexts.contextId, eventDate: contactContexts.eventDate, createdAt: contactContexts.createdAt })
      .from(contactContexts).where(and(eq(contactContexts.ownerId, quem.openId), eq(contactContexts.contactId, contactId))),
    db.select({ campo: networkSugestoes.campo, valor: networkSugestoes.valor, origem: networkSugestoes.origem, decididaEm: networkSugestoes.decididaEm })
      .from(networkSugestoes)
      .where(and(eq(networkSugestoes.ownerId, quem.openId), eq(networkSugestoes.contactId, contactId), eq(networkSugestoes.status, "confirmada"))),
    listarPendencias(quem.openId, { contactId }),
    proximasAcoesDoContato(quem.openId, contactId),
  ]);

  // Reuniões vinculadas: a que foi gravada já apontando o contato, e as que
  // sugeriram esta pessoa e a dona criou ou vinculou.
  const idsDeReuniao = Array.from(new Set(sugestoesDaReuniao.map(s => s.meetingId)));
  const reunioes = await db.select({ id: meetings.id, title: meetings.title, status: meetings.status, createdAt: meetings.createdAt })
    .from(meetings)
    .where(and(
      eq(meetings.ownerId, quem.openId),
      ne(meetings.status, "deleted"),
      idsDeReuniao.length ? or(eq(meetings.contactId, contactId), inArray(meetings.id, idsDeReuniao)) : eq(meetings.contactId, contactId),
    ))
    .orderBy(desc(meetings.createdAt)).limit(50);
  const assuntos = reunioes.length
    ? await db.select({ meetingId: meetingEntities.meetingId, value: meetingEntities.value, entityType: meetingEntities.entityType })
        .from(meetingEntities)
        .where(and(
          eq(meetingEntities.ownerId, quem.openId),
          inArray(meetingEntities.meetingId, reunioes.map(r => r.id)),
          inArray(meetingEntities.entityType, ["asset", "need", "opportunity"]),
          ne(meetingEntities.status, "ignored"),
        ))
    : [];
  const assuntosDa = (meetingId: string) => assuntos.filter(a => a.meetingId === meetingId).map(a => a.value).slice(0, 6);

  const nomesDeContexto = vinculos.length
    ? await db.select({ id: contexts.id, name: contexts.name }).from(contexts)
        // Contexto da dona ou do catálogo (owner nulo); o privado de outra dona fica de fora.
        .where(and(
          inArray(contexts.id, Array.from(new Set(vinculos.map(v => v.contextId)))),
          or(eq(contexts.ownerId, quem.openId), isNull(contexts.ownerId)),
        ))
    : [];
  const nomeDoContexto = new Map(nomesDeContexto.map(c => [c.id, c.name]));

  const conexoes = opcoes.termoSmartMatch ? await listarConexoesDaSolicitante(quem, { contactId }) : [];

  // N5: de qual reunião veio cada item, pela linha confirmada com o mesmo slug.
  const comSlug = (itens: Array<{ id: number; slug: string; label: string }>) =>
    itens.map(item => ({ id: Number(item.id), slug: item.slug || slugDoItem(item.label) }));
  const origens = await origemDosItensDoContato(quem.openId, contactId, { tenho: comSlug(tenho), preciso: comSlug(preciso) });

  return {
    contato: {
      id: Number(contato.id),
      quemSou: { nome: contato.fullName, telefone: contato.phone ?? contato.whatsapp ?? null, email: contato.email, tipoPessoa: contato.tipoPessoa ?? null },
      codigoAnonimo: contato.codigoAnonimo,
      disponivelRedeGlobal: Boolean(contato.disponivelRedeGlobal),
      disponibilidadeAlteradaEm: contato.disponibilidadeAlteradaEm ?? null,
      criadoEm: contato.createdAt,
    },
    tenho: tenho.map(t => ({ id: Number(t.id), label: t.label, category: t.category, origem: origens.tenho.get(Number(t.id)) ?? null })),
    preciso: preciso.map(p => ({ id: Number(p.id), label: p.label, category: p.category, origem: origens.preciso.get(Number(p.id)) ?? null })),
    faltando: camposFaltantes({
      fullName: contato.fullName, phone: contato.phone, whatsapp: contato.whatsapp, email: contato.email,
      totalTenho: tenho.length, totalPreciso: preciso.length,
    }),
    pendencias,
    reunioes: reunioes.map(r => ({ id: r.id, titulo: r.title, status: r.status, em: r.createdAt, assuntos: assuntosDa(r.id) })),
    proximasAcoes: { lista: acoes, limite: ACOES_NO_PERFIL_DO_CONTATO },
    conexoes: opcoes.termoSmartMatch ? { termoAceito: true as const, lista: conexoes } : { termoAceito: false as const },
    linhaDoTempo: montarLinhaDoTempo({
      contato: {
        createdAt: contato.createdAt,
        disponivelRedeGlobal: Boolean(contato.disponivelRedeGlobal),
        disponibilidadeAlteradaEm: contato.disponibilidadeAlteradaEm ?? null,
      },
      reunioes: reunioes.map(r => ({ id: r.id, title: r.title, createdAt: r.createdAt, assuntos: assuntosDa(r.id) })),
      contextos: vinculos.map(v => ({ nome: nomeDoContexto.get(v.contextId) ?? "", data: v.eventDate ?? null, createdAt: v.createdAt })).filter(c => c.nome),
      tenho: tenho.map(t => ({ label: t.label, createdAt: t.createdAt })),
      preciso: preciso.map(p => ({ label: p.label, createdAt: p.createdAt })),
      confirmacoes: confirmacoes.map(c => ({ ...c, decididaEm: c.decididaEm ?? null })),
      conexoes,
      acoes: acoes.map(a => ({ id: a.id, texto: a.texto, vozes: a.vozes, createdAt: a.createdAt, feita: a.feita, feitaEm: a.feitaEm })),
    }),
  };
}
