import { and, desc, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import {
  aiMatchSuggestions, meetingContactSuggestions, meetings, networkSugestoes, privateContacts, userProfiles,
} from "../drizzle/schema";
import {
  CATEGORIA_DE_SERVICO, LIMITE_DE_DEMANDAS, LIMITE_DE_DEMANDAS_POR_CATEGORIA, lerDemandas, novoIdDeDemanda, problemaDaDemanda,
  type ChaveOQuePreciso, type DemandaDetalhada,
} from "@shared/o-que-preciso";
import {
  CATEGORIA_PADRAO_DO_PRECISO, CATEGORIAS_DO_PRECISO_DA_REUNIAO, LIMITE_DO_QUE_TENHO, mesmoNome, slugDoItem,
} from "@shared/reuniao-no-match";
import { exigirDb } from "./db";
import {
  confirmarPendencia, ignorarPendencia, itemIdentificaOContato, PendenciaNaoEncontrada, ValorInvalido, valorParaGravar,
  type BancoOuTransacao, type CampoDaSugestao, type Identificacao,
} from "./network-extracao";
import { mensagemDoProblemaDaDemanda } from "./o-que-preciso";

/**
 * N5 — a reunião e o mapa mental viram conexões e refinam o perfil (reunião
 * de 11/11 com a Glenda e o Rosber; desenho de 16/11). A FONTE é a extração
 * que já roda em toda reunião (server/meeting-service.ts): por pessoa, o que
 * ela disse que TEM e PRECISA, com o trecho literal conferido pelo portão.
 * Resumo e mapa mental não são fonte, e nada aqui chama a IA.
 *
 * O que este módulo acrescenta ao caminho que já levava os itens ao contato
 * (commit 4fe2699, 15/09):
 *
 * - o PERFIL da dona como destino ("Sou eu" na reunião): o "tenho" vira texto
 *   em "O que tenho" (até 50, sem repetir o slug) e o "preciso" vira demanda
 *   de "O que preciso", com a categoria que ela escolher ("Outra necessidade"
 *   por padrão) e a descrição de 10 caracteres ou mais. Os dois contam para a
 *   régua da Prata e chegam ao motor de perfis pelo portão da demanda
 *   expressa (`necessidadesEscritasDoPerfil`);
 * - a guarda do perfil: o perfil circula nas conexões, e item com o nome, a
 *   empresa ou o telefone de alguém da reunião (ou os da própria dona) é
 *   recusado;
 * - a ORIGEM: a linha confirmada de network_sugestoes guarda a reunião, o
 *   trecho e o valor. É lida pelo par (contato, slug) para o perfil do contato
 *   e para o cartão da conexão privada. Excluir a reunião apaga essa linha
 *   (apagarPendenciasDaReuniao): o item confirmado fica, sem origem;
 * - as conexões que nasceram de uma reunião, só para a dona: o ramo do mapa
 *   mental e a linha do resumo.
 *
 * Tudo aqui é da dona: o openId dela vai em toda consulta.
 */

// ─── Mensagens (servidor em português; a tela mostra a do BAD_REQUEST) ─────────

export const MENSAGEM_ITEM_DO_PERFIL_COM_IDENTIFICACAO =
  "O seu perfil circula nas conexões sem identificação: o item não pode levar o nome, a empresa ou o telefone de ninguém da reunião, nem os seus. Corrija o texto antes de confirmar.";
export const MENSAGEM_O_QUE_TENHO_CHEIO = `"O que tenho" já tem ${LIMITE_DO_QUE_TENHO} itens. Tire um no seu perfil antes de confirmar outro.`;
export const MENSAGEM_DEMANDAS_CHEIAS = `"O que preciso" já tem ${LIMITE_DE_DEMANDAS} demandas. Tire uma no seu perfil antes de confirmar outra.`;
export const MENSAGEM_CATEGORIA_CHEIA = `Esta categoria já tem ${LIMITE_DE_DEMANDAS_POR_CATEGORIA} demandas. Escolha outra ou tire uma no seu perfil.`;
export const MENSAGEM_CATEGORIA_DA_OFERTA = "Escolha outra categoria: em \"Compradores / Clientes\" a descrição conta o que você vende, não o que você precisa.";
export const MENSAGEM_SEM_PERFIL = "Conclua o seu perfil antes de confirmar itens nele.";

// ─── O perfil como destino ─────────────────────────────────────────────────────

/** Uma coluna JSON lida com desconfiança: lista, texto com uma lista, ou nada. */
function listaGravada(valor: unknown): unknown[] {
  let bruto = valor;
  if (typeof bruto === "string") {
    try { bruto = JSON.parse(bruto); } catch { return []; }
  }
  return Array.isArray(bruto) ? bruto : [];
}

const soTexto = (lista: unknown[]) => lista.filter((item): item is string => typeof item === "string");

export type PerfilGravado = { whatIHave: unknown; whatINeed: unknown; whatINeedDetails: unknown };
export type MudancaNoPerfil = { whatIHave?: unknown[]; whatINeed?: unknown[]; whatINeedDetails?: unknown[] };

/**
 * O que confirmar o item muda no perfil, ou null quando o perfil já o tem (o
 * mesmo slug em "O que tenho", ou uma demanda com a mesma descrição). Os
 * tetos recusam com ValorInvalido. O item ENTRA no fim da lista gravada, sem
 * reescrever o resto: valor antigo que a leitura não entende fica como está.
 */
export function mudancaNoPerfil(perfil: PerfilGravado, campo: "tenho" | "preciso", valor: string, demanda: DemandaDetalhada | null): MudancaNoPerfil | null {
  const slug = slugDoItem(valor);
  if (campo === "tenho") {
    const atual = listaGravada(perfil.whatIHave);
    if (soTexto(atual).some(item => slugDoItem(item) === slug)) return null;
    if (atual.length >= LIMITE_DO_QUE_TENHO) throw new ValorInvalido(MENSAGEM_O_QUE_TENHO_CHEIO);
    return { whatIHave: [...atual, valor] };
  }
  if (!demanda) throw new ValorInvalido("Escolha a categoria da demanda.");
  const demandas = lerDemandas(perfil.whatINeedDetails);
  if (demandas.some(existente => slugDoItem(existente.description ?? "") === slug)) return null;
  const brutas = listaGravada(perfil.whatINeedDetails);
  if (brutas.length >= LIMITE_DE_DEMANDAS) throw new ValorInvalido(MENSAGEM_DEMANDAS_CHEIAS);
  if (demandas.filter(existente => existente.category === demanda.category).length >= LIMITE_DE_DEMANDAS_POR_CATEGORIA) {
    throw new ValorInvalido(MENSAGEM_CATEGORIA_CHEIA);
  }
  // A categoria marcada é o que faz a descrição valer nos motores (necessidadesDasDemandas).
  const categorias = listaGravada(perfil.whatINeed);
  const marcadas = soTexto(categorias).includes(demanda.category) ? categorias : [...categorias, demanda.category];
  if (marcadas.length > LIMITE_DE_DEMANDAS) throw new ValorInvalido(MENSAGEM_DEMANDAS_CHEIAS);
  return { whatINeed: marcadas, whatINeedDetails: [...brutas, demanda] };
}

/**
 * Quem a reunião nomeia, para o item do perfil não levar ninguém: as pessoas
 * sugeridas (nome, empresa e telefone, em qualquer status), as pendências de
 * nome, empresa e telefone tiradas dela e o nome e a empresa do perfil da
 * própria dona. Posse no WHERE.
 */
export async function identificacaoDaReuniao(db: BancoOuTransacao, dona: { id: number; openId: string }, meetingId: string | null): Promise<Identificacao> {
  const [perfil] = await db.select({ displayName: userProfiles.displayName, company: userProfiles.company })
    .from(userProfiles).where(eq(userProfiles.userId, dona.id)).limit(1);
  const nomes: unknown[] = [perfil?.displayName, perfil?.company];
  const telefones: unknown[] = [];
  if (meetingId) {
    const [pessoas, pendencias] = await Promise.all([
      db.select({ fullName: meetingContactSuggestions.fullName, company: meetingContactSuggestions.company, phone: meetingContactSuggestions.phone })
        .from(meetingContactSuggestions)
        .where(and(eq(meetingContactSuggestions.ownerId, dona.openId), eq(meetingContactSuggestions.meetingId, meetingId))),
      db.select({ campo: networkSugestoes.campo, valor: networkSugestoes.valor }).from(networkSugestoes)
        .where(and(
          eq(networkSugestoes.ownerId, dona.openId), eq(networkSugestoes.meetingId, meetingId),
          inArray(networkSugestoes.campo, ["nome", "empresa", "telefone"]),
        )),
    ]);
    for (const pessoa of pessoas) {
      nomes.push(pessoa.fullName, pessoa.company);
      telefones.push(pessoa.phone);
    }
    for (const pendencia of pendencias) (pendencia.campo === "telefone" ? telefones : nomes).push(pendencia.valor);
  }
  return { nomes, telefones };
}

/**
 * A reunião terminou de decidir o que vai ao perfil: nenhum item do perfil
 * dela ainda pendente, e pelo menos um confirmado. É quando o motor de perfis
 * recalcula — uma vez por reunião, e não a cada item: os insights de IA custam
 * até 3 chamadas por rodada (server/matching.ts).
 */
export async function perfilDaReuniaoDecidido(db: BancoOuTransacao, ownerId: string, meetingId: string): Promise<boolean> {
  const linhas = await db.select({ status: networkSugestoes.status }).from(networkSugestoes)
    .where(and(
      eq(networkSugestoes.ownerId, ownerId), eq(networkSugestoes.meetingId, meetingId), eq(networkSugestoes.alvo, "perfil"),
    ));
  return linhas.some(linha => linha.status === "confirmada") && !linhas.some(linha => linha.status === "pendente");
}

export type EntradaDaConfirmacao = {
  /** O valor corrigido pela dona; sem ele, o da IA. */
  valor?: string;
  /** Só no "preciso" que vai ao perfil: a categoria da demanda. */
  categoria?: ChaveOQuePreciso;
  /** Só em "Especialistas / Serviços": o serviço, obrigatório lá. */
  servico?: string;
};

export type ResultadoDaConfirmacao =
  | { alvo: "contato"; campo: CampoDaSugestao; contactId: number; mudouTenhoOuPreciso: boolean }
  | { alvo: "perfil"; campo: "tenho" | "preciso"; meetingId: string | null; mudouPerfil: boolean; reuniaoDecidida: boolean };

/**
 * A dona confirma um item. O do contato segue o caminho de sempre
 * (confirmarPendencia); o do perfil:
 *
 * 1. o valor passa pela validação do campo e, no "preciso", pela da demanda
 *    (categoria, descrição de 10+ caracteres, o serviço em Especialistas);
 * 2. a guarda do perfil recusa o item que nomeia alguém da reunião;
 * 3. tomada e escrita na MESMA transação, com o perfil travado (FOR UPDATE):
 *    duas confirmações ao mesmo tempo não perdem item, e a falha no meio
 *    devolve a pendência a 'pendente'.
 */
export async function confirmarItemDaDona(dona: { id: number; openId: string }, id: string, entrada: EntradaDaConfirmacao = {}): Promise<ResultadoDaConfirmacao> {
  const db = await exigirDb();
  const daDona = and(eq(networkSugestoes.id, id), eq(networkSugestoes.ownerId, dona.openId), eq(networkSugestoes.status, "pendente"));
  const [pendencia] = await db.select().from(networkSugestoes).where(daDona).limit(1);
  if (!pendencia) throw new PendenciaNaoEncontrada();
  if (pendencia.alvo !== "perfil") {
    const resultado = await confirmarPendencia(dona.openId, id, entrada.valor);
    return { alvo: "contato", ...resultado };
  }
  const campo = pendencia.campo;
  if (campo !== "tenho" && campo !== "preciso") throw new PendenciaNaoEncontrada();
  const valor = valorParaGravar(campo, entrada.valor ?? pendencia.valor);

  let demanda: DemandaDetalhada | null = null;
  if (campo === "preciso") {
    const categoria = entrada.categoria ?? CATEGORIA_PADRAO_DO_PRECISO;
    if (!CATEGORIAS_DO_PRECISO_DA_REUNIAO.includes(categoria)) throw new ValorInvalido(MENSAGEM_CATEGORIA_DA_OFERTA);
    demanda = { id: novoIdDeDemanda(), category: categoria, description: valor };
    if (categoria === CATEGORIA_DE_SERVICO && entrada.servico?.trim()) demanda.service = entrada.servico.trim();
    const problema = problemaDaDemanda(demanda);
    if (problema) throw new ValorInvalido(mensagemDoProblemaDaDemanda(problema, categoria));
  }
  if (itemIdentificaOContato(valor, await identificacaoDaReuniao(db, dona, pendencia.meetingId))) {
    throw new ValorInvalido(MENSAGEM_ITEM_DO_PERFIL_COM_IDENTIFICACAO);
  }

  const agora = Date.now();
  const mudouPerfil = await db.transaction(async tx => {
    const [tomada] = await tx.update(networkSugestoes)
      .set({ status: "confirmada", valor, decididaEm: agora, updatedAt: agora })
      .where(and(daDona, eq(networkSugestoes.alvo, "perfil")));
    if (!((tomada as { affectedRows?: number } | undefined)?.affectedRows)) throw new PendenciaNaoEncontrada();
    const [perfil] = await tx.select({ whatIHave: userProfiles.whatIHave, whatINeed: userProfiles.whatINeed, whatINeedDetails: userProfiles.whatINeedDetails })
      .from(userProfiles).where(eq(userProfiles.userId, dona.id)).limit(1).for("update");
    if (!perfil) throw new ValorInvalido(MENSAGEM_SEM_PERFIL);
    const mudanca = mudancaNoPerfil(perfil, campo, valor, demanda);
    if (!mudanca) return false;
    await tx.update(userProfiles).set(mudanca).where(eq(userProfiles.userId, dona.id));
    return true;
  });
  const reuniaoDecidida = pendencia.meetingId ? await perfilDaReuniaoDecidido(db, dona.openId, pendencia.meetingId) : false;
  return { alvo: "perfil", campo, meetingId: pendencia.meetingId, mudouPerfil, reuniaoDecidida };
}

/** A dona ignora um item; o do perfil diz se a reunião acabou de decidir o que vai ao perfil. */
export async function ignorarItemDaDona(dona: { openId: string }, id: string): Promise<{ ok: true; alvo: "contato" | "perfil"; reuniaoDecidida: boolean }> {
  const db = await exigirDb();
  const [pendencia] = await db.select({ alvo: networkSugestoes.alvo, meetingId: networkSugestoes.meetingId }).from(networkSugestoes)
    .where(and(eq(networkSugestoes.id, id), eq(networkSugestoes.ownerId, dona.openId), eq(networkSugestoes.status, "pendente"))).limit(1);
  if (!pendencia) throw new PendenciaNaoEncontrada();
  await ignorarPendencia(dona.openId, id);
  const reuniaoDecidida = pendencia.alvo === "perfil" && pendencia.meetingId ? await perfilDaReuniaoDecidido(db, dona.openId, pendencia.meetingId) : false;
  return { ok: true, alvo: pendencia.alvo, reuniaoDecidida };
}

/**
 * O motor de perfis recalcula em segundo plano, uma vez por reunião (quando
 * ela termina de decidir o que vai ao perfil). Melhor esforço: o item já está
 * gravado, e a falha fica no log; a próxima rodada (o "Reanalisar" do
 * Dashboard) alcança. Devolve a promessa para os testes; quem chama não espera.
 */
export function recalcularOMotorDePerfis(userId: number): Promise<void> {
  return (async () => {
    try {
      const { generateMatchesForUser } = await import("./matching");
      await generateMatchesForUser(userId);
    } catch (erro) {
      console.warn("[Reunião no match] o recálculo do motor de perfis ficou para depois:", erro instanceof Error ? erro.message : erro);
    }
  })();
}

/** Os itens que esperam a dona com destino no perfil dela, com a reunião de onde vieram. */
export async function pendenciasDoPerfil(ownerId: string) {
  const db = await exigirDb();
  const linhas = await db.select({
    id: networkSugestoes.id, campo: networkSugestoes.campo, valor: networkSugestoes.valor, trecho: networkSugestoes.trecho,
    confianca: networkSugestoes.confianca, meetingId: networkSugestoes.meetingId, criadaEm: networkSugestoes.createdAt,
  }).from(networkSugestoes)
    .where(and(
      eq(networkSugestoes.ownerId, ownerId), eq(networkSugestoes.status, "pendente"), eq(networkSugestoes.alvo, "perfil"),
      inArray(networkSugestoes.campo, ["tenho", "preciso"]),
    ))
    .orderBy(desc(networkSugestoes.createdAt)).limit(100);
  const reunioes = await titulosDasReunioes(db, ownerId, linhas.map(linha => linha.meetingId));
  return linhas.map(linha => ({
    id: linha.id,
    campo: linha.campo as "tenho" | "preciso",
    valor: linha.valor,
    trecho: linha.trecho,
    confianca: Number(linha.confianca),
    criadaEm: linha.criadaEm,
    reuniao: linha.meetingId ? reunioes.get(linha.meetingId) ?? null : null,
  }));
}

type ReuniaoDeOrigem = { id: string; titulo: string; em: number };

/** O título e a data das reuniões, da dona e não excluídas. */
async function titulosDasReunioes(db: BancoOuTransacao, ownerId: string, ids: Array<string | null>): Promise<Map<string, ReuniaoDeOrigem>> {
  const unicos = Array.from(new Set(ids.filter((id): id is string => Boolean(id))));
  if (!unicos.length) return new Map();
  const linhas = await db.select({ id: meetings.id, title: meetings.title, createdAt: meetings.createdAt }).from(meetings)
    .where(and(eq(meetings.ownerId, ownerId), inArray(meetings.id, unicos), ne(meetings.status, "deleted")));
  return new Map(linhas.map(linha => [linha.id, { id: linha.id, titulo: linha.title, em: Number(linha.createdAt) }]));
}

// ─── A origem do item e da conexão ─────────────────────────────────────────────

export type OrigemDoItem = { meetingId: string; titulo: string; em: number; trecho: string | null };

type LinhaConfirmada = { contactId: number; campo: "tenho" | "preciso"; slug: string; meetingId: string; trecho: string | null; decididaEm: number };

/** As linhas confirmadas de Tenho/Preciso que vieram de reunião, dos contatos dados. */
async function confirmadasDeReuniao(db: BancoOuTransacao, ownerId: string, contatos: number[]): Promise<LinhaConfirmada[]> {
  if (!contatos.length) return [];
  const linhas = await db.select({
    contactId: networkSugestoes.contactId, campo: networkSugestoes.campo, valor: networkSugestoes.valor,
    meetingId: networkSugestoes.meetingId, trecho: networkSugestoes.trecho, decididaEm: networkSugestoes.decididaEm,
  }).from(networkSugestoes)
    .where(and(
      eq(networkSugestoes.ownerId, ownerId), inArray(networkSugestoes.contactId, contatos), eq(networkSugestoes.status, "confirmada"),
      eq(networkSugestoes.alvo, "contato"), inArray(networkSugestoes.campo, ["tenho", "preciso"]), isNotNull(networkSugestoes.meetingId),
    ));
  return linhas.map(linha => ({
    contactId: Number(linha.contactId), campo: linha.campo as "tenho" | "preciso", slug: slugDoItem(linha.valor),
    meetingId: linha.meetingId as string, trecho: linha.trecho, decididaEm: Number(linha.decididaEm ?? 0),
  }));
}

/** A mais recente das linhas, com o título da reunião; null quando a reunião não está mais lá. */
function origemDe(linhas: LinhaConfirmada[], reunioes: Map<string, ReuniaoDeOrigem>): OrigemDoItem | null {
  const ordenadas = linhas.filter(linha => reunioes.has(linha.meetingId)).sort((a, b) => b.decididaEm - a.decididaEm);
  const linha = ordenadas[0];
  if (!linha) return null;
  const reuniao = reunioes.get(linha.meetingId) as ReuniaoDeOrigem;
  return { meetingId: reuniao.id, titulo: reuniao.titulo, em: reuniao.em, trecho: linha.trecho };
}

/**
 * A origem de cada Tenho/Preciso de um contato: a reunião (título e data) e o
 * trecho da linha confirmada com o mesmo slug. Item sem linha (digitado, do
 * enriquecimento, ou de reunião excluída) fica sem origem.
 */
export async function origemDosItensDoContato(ownerId: string, contactId: number, itens: { tenho: Array<{ id: number; slug: string }>; preciso: Array<{ id: number; slug: string }> }) {
  const db = await exigirDb();
  const linhas = await confirmadasDeReuniao(db, ownerId, [contactId]);
  const reunioes = await titulosDasReunioes(db, ownerId, linhas.map(linha => linha.meetingId));
  const doCampo = (campo: "tenho" | "preciso", slug: string) => origemDe(linhas.filter(linha => linha.campo === campo && linha.slug === slug), reunioes);
  return {
    tenho: new Map(itens.tenho.map(item => [item.id, doCampo("tenho", item.slug)])),
    preciso: new Map(itens.preciso.map(item => [item.id, doCampo("preciso", item.slug)])),
  };
}

type ConexaoPrivada = { id: string; contactAId: number; contactBId: number; matchedAssets: unknown; matchedNeeds: unknown };

const slugsDaRazao = (guardado: unknown): Set<string> => new Set((Array.isArray(guardado) ? guardado : [])
  .map(razao => (razao && typeof razao === "object" ? (razao as { slug?: unknown; label?: unknown }) : {}))
  .map(razao => (typeof razao.slug === "string" && razao.slug ? razao.slug : typeof razao.label === "string" ? slugDoItem(razao.label) : ""))
  .filter(Boolean));

/** As linhas confirmadas que sustentam a conexão: o "tenho" de um dos dois que ela cita, ou o "preciso" que ela cita. */
function linhasDaConexao(conexao: ConexaoPrivada, linhas: LinhaConfirmada[]): LinhaConfirmada[] {
  const ativos = slugsDaRazao(conexao.matchedAssets);
  const necessidades = slugsDaRazao(conexao.matchedNeeds);
  const doPar = new Set([Number(conexao.contactAId), Number(conexao.contactBId)]);
  return linhas.filter(linha => doPar.has(linha.contactId)
    && (linha.campo === "tenho" ? ativos.has(linha.slug) : necessidades.has(linha.slug)));
}

/**
 * De qual reunião nasceu cada conexão privada: a mais recente das reuniões em
 * que a dona confirmou um item que a conexão cita. Conexão sem item de reunião
 * fica de fora do mapa devolvido.
 */
export async function origemDasConexoes(ownerId: string, conexoes: ConexaoPrivada[]): Promise<Map<string, OrigemDoItem>> {
  if (!conexoes.length) return new Map();
  const db = await exigirDb();
  const contatos = Array.from(new Set(conexoes.flatMap(conexao => [Number(conexao.contactAId), Number(conexao.contactBId)])));
  const linhas = await confirmadasDeReuniao(db, ownerId, contatos);
  if (!linhas.length) return new Map();
  const reunioes = await titulosDasReunioes(db, ownerId, linhas.map(linha => linha.meetingId));
  const origens = new Map<string, OrigemDoItem>();
  for (const conexao of conexoes) {
    const origem = origemDe(linhasDaConexao(conexao, linhas), reunioes);
    if (origem) origens.set(conexao.id, origem);
  }
  return origens;
}

// ─── As conexões desta reunião (o ramo do mapa e a linha do resumo) ────────────

export type PessoaDaReuniao = {
  id: string;
  nome: string;
  status: "pending" | "created" | "linked" | "ignored" | "self";
  citada: boolean;
  tenho: Array<{ valor: string; confirmado: boolean }>;
  preciso: Array<{ valor: string; confirmado: boolean }>;
  /** As conexões privadas que os itens confirmados desta pessoa, nesta reunião, sustentam. */
  conexoes: Array<{ id: string; com: string | null }>;
};

/**
 * Cada pessoa da reunião com o que tem e precisa (pendente ou confirmado; o
 * ignorado sai) e as conexões privadas que nasceram dos itens confirmados
 * nela. Só para a dona: o link aberto não chama isto, e nada vai à IA ou à
 * tradução. As conexões só com o termo do Smart Match, como a lista delas
 * (intelligentMatches.list); a dispensada não conta. null: a reunião não é da dona.
 */
export async function conexoesDaReuniao(ownerId: string, meetingId: string, opcoes: { termoSmartMatch: boolean }) {
  const db = await exigirDb();
  const [reuniao] = await db.select({ id: meetings.id }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), ne(meetings.status, "deleted"))).limit(1);
  if (!reuniao) return null;
  const [pessoas, itens] = await Promise.all([
    db.select({
      id: meetingContactSuggestions.id, fullName: meetingContactSuggestions.fullName, status: meetingContactSuggestions.status,
      presence: meetingContactSuggestions.presence,
    }).from(meetingContactSuggestions)
      .where(and(eq(meetingContactSuggestions.ownerId, ownerId), eq(meetingContactSuggestions.meetingId, meetingId)))
      .orderBy(meetingContactSuggestions.createdAt),
    db.select({
      meetingSuggestionId: networkSugestoes.meetingSuggestionId, contactId: networkSugestoes.contactId, campo: networkSugestoes.campo,
      valor: networkSugestoes.valor, status: networkSugestoes.status, alvo: networkSugestoes.alvo, decididaEm: networkSugestoes.decididaEm,
    }).from(networkSugestoes)
      .where(and(
        eq(networkSugestoes.ownerId, ownerId), eq(networkSugestoes.meetingId, meetingId),
        inArray(networkSugestoes.campo, ["tenho", "preciso"]), ne(networkSugestoes.status, "ignorada"),
      )),
  ]);

  // As conexões que os itens confirmados (do contato) desta reunião sustentam.
  const confirmados: LinhaConfirmada[] = itens
    .filter(item => item.status === "confirmada" && item.alvo === "contato" && item.contactId !== null)
    .map(item => ({
      contactId: Number(item.contactId), campo: item.campo as "tenho" | "preciso", slug: slugDoItem(item.valor),
      meetingId, trecho: null, decididaEm: Number(item.decididaEm ?? 0),
    }));
  const conexoesDaPessoa = new Map<number, Array<{ id: string; com: string | null }>>();
  const todas = new Set<string>();
  if (opcoes.termoSmartMatch && confirmados.length) {
    const contatos = Array.from(new Set(confirmados.map(linha => linha.contactId)));
    const conexoes = await db.select({
      id: aiMatchSuggestions.id, contactAId: aiMatchSuggestions.contactAId, contactBId: aiMatchSuggestions.contactBId,
      matchedAssets: aiMatchSuggestions.matchedAssets, matchedNeeds: aiMatchSuggestions.matchedNeeds,
    }).from(aiMatchSuggestions)
      .where(and(
        eq(aiMatchSuggestions.ownerId, ownerId), ne(aiMatchSuggestions.status, "dismissed"),
        or(inArray(aiMatchSuggestions.contactAId, contatos), inArray(aiMatchSuggestions.contactBId, contatos)),
      ));
    const nascidas = conexoes.filter(conexao => linhasDaConexao(conexao, confirmados).length > 0);
    const outros = Array.from(new Set(nascidas.flatMap(conexao => [Number(conexao.contactAId), Number(conexao.contactBId)])));
    const nomes = outros.length
      ? new Map((await db.select({ id: privateContacts.id, fullName: privateContacts.fullName }).from(privateContacts)
          .where(and(eq(privateContacts.ownerId, ownerId), inArray(privateContacts.id, outros)))).map(contato => [Number(contato.id), contato.fullName]))
      : new Map<number, string>();
    for (const conexao of nascidas) {
      todas.add(conexao.id);
      for (const linha of linhasDaConexao(conexao, confirmados)) {
        const outro = linha.contactId === Number(conexao.contactAId) ? Number(conexao.contactBId) : Number(conexao.contactAId);
        const lista = conexoesDaPessoa.get(linha.contactId) ?? [];
        if (!lista.some(item => item.id === conexao.id)) lista.push({ id: conexao.id, com: nomes.get(outro) ?? null });
        conexoesDaPessoa.set(linha.contactId, lista);
      }
    }
  }

  const resultado: PessoaDaReuniao[] = pessoas.map(pessoa => {
    const daPessoa = itens.filter(item => item.meetingSuggestionId === pessoa.id);
    const lista = (campo: "tenho" | "preciso") => daPessoa.filter(item => item.campo === campo)
      .map(item => ({ valor: item.valor, confirmado: item.status === "confirmada" }));
    const contatos = Array.from(new Set(daPessoa.filter(item => item.contactId !== null).map(item => Number(item.contactId))));
    return {
      id: pessoa.id, nome: pessoa.fullName, status: pessoa.status, citada: pessoa.presence === "mentioned",
      tenho: lista("tenho"), preciso: lista("preciso"),
      conexoes: contatos.flatMap(contato => conexoesDaPessoa.get(contato) ?? []),
    };
  });
  return { pessoas: resultado, totalDeConexoes: todas.size };
}

// ─── Vincular: o contato que a tela sugere ─────────────────────────────────────

export type MotivoDoCandidato = "email" | "telefone" | "nome";

const ultimosOito = (telefone: string | null | undefined) => (telefone ?? "").replace(/\D/g, "").slice(-8);

/**
 * Os contatos da dona que podem ser a pessoa da reunião: o mesmo e-mail, o
 * mesmo telefone (os 8 últimos dígitos) ou o mesmo nome (`mesmoNome`), nessa
 * ordem, no máximo 5. null: a sugestão não é da dona.
 */
export async function candidatosParaVincular(ownerId: string, suggestionId: string) {
  const db = await exigirDb();
  const [pessoa] = await db.select({
    fullName: meetingContactSuggestions.fullName, email: meetingContactSuggestions.email, phone: meetingContactSuggestions.phone,
  }).from(meetingContactSuggestions)
    .where(and(eq(meetingContactSuggestions.id, suggestionId), eq(meetingContactSuggestions.ownerId, ownerId))).limit(1);
  if (!pessoa) return null;
  const contatos = await db.select({
    id: privateContacts.id, fullName: privateContacts.fullName, company: privateContacts.company,
    email: privateContacts.email, phone: privateContacts.phone, whatsapp: privateContacts.whatsapp,
  }).from(privateContacts).where(eq(privateContacts.ownerId, ownerId)).limit(5000);
  const email = (pessoa.email ?? "").trim().toLowerCase();
  const telefone = ultimosOito(pessoa.phone);
  const ORDEM: Record<MotivoDoCandidato, number> = { email: 0, telefone: 1, nome: 2 };
  return contatos
    .map(contato => {
      const motivo: MotivoDoCandidato | null =
        email && (contato.email ?? "").trim().toLowerCase() === email ? "email"
          : telefone.length === 8 && [contato.phone, contato.whatsapp].some(numero => ultimosOito(numero) === telefone) ? "telefone"
            : mesmoNome(pessoa.fullName, contato.fullName) ? "nome" : null;
      return motivo ? { id: Number(contato.id), nome: contato.fullName, empresa: contato.company, motivo } : null;
    })
    .filter((candidato): candidato is { id: number; nome: string; empresa: string | null; motivo: MotivoDoCandidato } => candidato !== null)
    .sort((a, b) => ORDEM[a.motivo] - ORDEM[b.motivo] || a.nome.localeCompare(b.nome))
    .slice(0, 5);
}
