import crypto from "node:crypto";
import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import {
  aiMatchSuggestions, conexoesParticipantes, conexoesRegistradas, privateContacts, users,
} from "../drizzle/schema";
import { ehErroDeBancoIndisponivel } from "./banco-indisponivel";
import { exigirDb } from "./db";
import { garantirCodigosAnonimos } from "./network-codigo-anonimo";
import { mascararContatosEmTexto } from "../shared/contato-em-texto";

/**
 * Registro das conexões que podem originar negócio — Meu Network Inteligente,
 * spec da Glenda de 14/09, itens 16, 17 e 18.
 *
 * "MATCH ENTRE CONTATOS DO PRÓPRIO NETWORK = MATCH REGISTRADO PELA PLATAFORMA."
 * A plataforma participou da identificação e pode fazer jus à comissão se o
 * negócio fechar; por isso a conexão ganha uma linha própria, com ORIGEM, que
 * sobrevive à sugestão que a originou (a limpeza de órfãos do motor privado
 * apaga a sugestão; o registro fica).
 *
 * O que NÃO há aqui, de propósito (item 17 e decisão do Roberto de 14/09):
 * percentual, valor, cobrança ou pagamento. Só o STATUS da comissão, que a
 * plataforma apura depois do fechamento conforme regra contratual.
 *
 * Privacidade (itens 12 e 16): o registro não guarda nem devolve nome,
 * telefone ou e-mail. O motivo fala pelos IDs anônimos; o outro lado de uma
 * conexão entre networks diferentes aparece só pelo ID anônimo.
 */

export const ORIGENS_DA_CONEXAO = ["PLATFORM_MATCH", "NETWORK_PLATFORM_MATCH", "PRIVATE_NETWORK_MATCH", "NETWORK_NETWORK_MATCH"] as const;
export type OrigemDaConexao = (typeof ORIGENS_DA_CONEXAO)[number];

export const ETAPAS_DA_CONEXAO = ["identificada", "apresentacao", "negociacao", "fechada", "descartada"] as const;
export type EtapaDaConexao = (typeof ETAPAS_DA_CONEXAO)[number];

export const STATUS_DE_COMISSAO = ["sem_negocio", "a_apurar", "devida", "nao_devida"] as const;
export type StatusDeComissao = (typeof STATUS_DE_COMISSAO)[number];

export type ItemDaConexao = { tem: string; precisa: string; deCodigo: string | null; paraCodigo: string | null };

export type ParticipanteParaRegistro =
  | { tipo: "contato"; ownerId: string; contactId: number; codigoAnonimo: string | null; originador: boolean }
  | { tipo: "membro"; userId: number };

/** A conexão sem direção: A×B e B×A são o mesmo par, e a chave é a mesma. */
export function chaveDoPar(origem: OrigemDaConexao, a: ParticipanteParaRegistro, b: ParticipanteParaRegistro): string {
  const ref = (p: ParticipanteParaRegistro) => (p.tipo === "contato" ? `contato:${p.contactId}` : `membro:${p.userId}`);
  const [primeiro, segundo] = [ref(a), ref(b)].sort();
  return `${origem}|${primeiro}|${segundo}`;
}

type Banco = Awaited<ReturnType<typeof exigirDb>>;

/**
 * Grava (ou reencontra) a conexão. Uma linha por par por origem: recalcular
 * não duplica, e a atualização toca só motivo, itens e pontuação — o status
 * (apresentação, negociação, fechamento) e o da comissão nunca voltam atrás
 * por causa de um recálculo.
 *
 * Cabeçalho e participantes na MESMA transação. Separados, uma falha entre as
 * duas escritas (queda de conexão, deploy no meio) deixava o cabeçalho sem
 * participantes; como a sincronização pula a chave que já está no registro e a
 * lista parte das participações, a conexão sumia para sempre da vista das donas.
 */
export async function registrarConexao(db: Banco, entrada: {
  origem: OrigemDaConexao;
  a: ParticipanteParaRegistro;
  b: ParticipanteParaRegistro;
  motivo: string;
  itens: ItemDaConexao[];
  pontuacao: number;
}): Promise<string> {
  return db.transaction(tx => gravarConexao(tx, entrada));
}

type Transacao = Parameters<Parameters<Banco["transaction"]>[0]>[0];

async function gravarConexao(db: Transacao, entrada: Parameters<typeof registrarConexao>[1]): Promise<string> {
  const agora = Date.now();
  const chave = chaveDoPar(entrada.origem, entrada.a, entrada.b);
  await db.insert(conexoesRegistradas).values({
    id: crypto.randomUUID(),
    origem: entrada.origem,
    chaveDoPar: chave,
    motivo: entrada.motivo.slice(0, 2000),
    itens: entrada.itens.slice(0, 20),
    pontuacao: Math.round(entrada.pontuacao),
    status: "identificada",
    statusComissao: "sem_negocio",
    createdAt: agora,
    updatedAt: agora,
  }).onDuplicateKeyUpdate({
    set: { motivo: entrada.motivo.slice(0, 2000), itens: entrada.itens.slice(0, 20), pontuacao: Math.round(entrada.pontuacao), updatedAt: agora },
  });
  const [linha] = await db.select({ id: conexoesRegistradas.id }).from(conexoesRegistradas)
    .where(eq(conexoesRegistradas.chaveDoPar, chave)).limit(1);
  if (!linha) throw new Error("A conexão não foi registrada.");

  const participante = (p: ParticipanteParaRegistro, lado: "a" | "b") => p.tipo === "contato"
    ? {
        conexaoId: linha.id, lado, tipo: "contato" as const, ownerId: p.ownerId, userId: null, contactId: p.contactId,
        codigoAnonimo: p.codigoAnonimo, originador: p.originador,
        statusComissaoOriginador: p.originador ? ("sem_negocio" as const) : null,
        createdAt: agora, updatedAt: agora,
      }
    : {
        conexaoId: linha.id, lado, tipo: "membro" as const, ownerId: null, userId: p.userId, contactId: null,
        codigoAnonimo: null, originador: false, statusComissaoOriginador: null,
        createdAt: agora, updatedAt: agora,
      };
  await db.insert(conexoesParticipantes)
    .values([participante(entrada.a, "a"), participante(entrada.b, "b")])
    .onDuplicateKeyUpdate({ set: { updatedAt: agora } });
  return linha.id;
}

const listar = (rotulos: string[]) =>
  rotulos.length <= 1 ? (rotulos[0] ?? "") : `${rotulos.slice(0, -1).join(", ")} e ${rotulos[rotulos.length - 1]}`;

const rotulosDe = (guardado: unknown) =>
  (Array.isArray(guardado) ? guardado : [])
    .map(item => (item && typeof item === "object" ? String((item as { label?: unknown }).label ?? "") : ""))
    .filter(Boolean);

/**
 * O motivo de uma conexão interna SEM nome de ninguém. A sugestão do motor
 * privado diz "Ana possui X, que Bia procura" — texto que só a dona vê. O
 * registro é da plataforma e fala pelos IDs anônimos.
 *
 * O rótulo é texto livre da dona e fica gravado como ela escreveu: a máscara
 * de contato entra na LEITURA da staff (`listarTodasAsConexoes`), não aqui.
 * Mascarar na escrita destruiria o dado da dona no banco — e ela é quem lê
 * esta linha do outro lado, num par entre dois contatos dela.
 */
export function motivoAnonimo(sugestao: {
  matchType: string; matchedAssets: unknown; matchedNeeds: unknown;
}, codigoDe: string, codigoPara: string): { motivo: string; itens: ItemDaConexao[] } {
  const tem = listar(rotulosDe(sugestao.matchedAssets));
  const precisa = listar(rotulosDe(sugestao.matchedNeeds));
  if (sugestao.matchType === "mutual") {
    return {
      motivo: `${codigoDe} e ${codigoPara} se completam: cada um tem o que o outro procura (${tem}).`,
      itens: [{ tem, precisa, deCodigo: null, paraCodigo: null }],
    };
  }
  return {
    motivo: `${codigoDe} tem ${tem}, que ${codigoPara} procura.`,
    itens: [{ tem, precisa, deCodigo: codigoDe, paraCodigo: codigoPara }],
  };
}

/**
 * Registra toda sugestão do motor privado (ai_match_suggestions) desta dona
 * que ainda não está no registro — origem PRIVATE_NETWORK_MATCH. Todas contam
 * como "identificadas pela plataforma", inclusive a que a dona dispensou: a
 * dispensa é decisão dela sobre a sugestão, não apaga que a plataforma a
 * encontrou. Só lê a tabela de sugestões, que existe apenas com o termo do
 * Smart Match aceito: quem chama já decidiu isso.
 */
export async function sincronizarConexoesInternas(ownerId: string): Promise<number> {
  const db = await exigirDb();
  const sugestoes = await db.select({
    contactAId: aiMatchSuggestions.contactAId,
    contactBId: aiMatchSuggestions.contactBId,
    matchScore: aiMatchSuggestions.matchScore,
    matchType: aiMatchSuggestions.matchType,
    matchedAssets: aiMatchSuggestions.matchedAssets,
    matchedNeeds: aiMatchSuggestions.matchedNeeds,
  }).from(aiMatchSuggestions).where(eq(aiMatchSuggestions.ownerId, ownerId));
  if (!sugestoes.length) return 0;

  const participanteDe = (contactId: number, codigo: string | null): ParticipanteParaRegistro =>
    ({ tipo: "contato", ownerId, contactId: Number(contactId), codigoAnonimo: codigo, originador: false });
  const chaves = sugestoes.map(s => chaveDoPar("PRIVATE_NETWORK_MATCH", participanteDe(s.contactAId, null), participanteDe(s.contactBId, null)));
  const jaRegistradas = new Set((await db.select({ chave: conexoesRegistradas.chaveDoPar }).from(conexoesRegistradas)
    .where(inArray(conexoesRegistradas.chaveDoPar, chaves))).map(linha => linha.chave));
  const faltando = sugestoes.filter((_, indice) => !jaRegistradas.has(chaves[indice]));
  if (!faltando.length) return 0;

  await garantirCodigosAnonimos(ownerId);
  const ids = Array.from(new Set(faltando.flatMap(s => [Number(s.contactAId), Number(s.contactBId)])));
  const codigos = new Map((await db.select({ id: privateContacts.id, codigo: privateContacts.codigoAnonimo })
    .from(privateContacts)
    .where(and(eq(privateContacts.ownerId, ownerId), inArray(privateContacts.id, ids))))
    .map(linha => [Number(linha.id), linha.codigo]));

  let registradas = 0;
  for (const sugestao of faltando) {
    const codigoA = codigos.get(Number(sugestao.contactAId));
    const codigoB = codigos.get(Number(sugestao.contactBId));
    // Contato que já não é desta dona (ou foi excluído no meio): nada a registrar.
    if (!codigoA || !codigoB) continue;
    const { motivo, itens } = motivoAnonimo(sugestao, codigoA, codigoB);
    await registrarConexao(db, {
      origem: "PRIVATE_NETWORK_MATCH",
      a: participanteDe(sugestao.contactAId, codigoA),
      b: participanteDe(sugestao.contactBId, codigoB),
      motivo, itens, pontuacao: sugestao.matchScore,
    });
    registradas += 1;
  }
  return registradas;
}

/**
 * Melhor esforço COM a regra do projeto: a falha do registro não desfaz o
 * cálculo que já gravou as sugestões (log e segue — o que não entrar agora
 * entra na próxima rodada, porque o registro é idempotente pela chave do par),
 * mas banco fora do ar continua ERRO e sobe para quem chamou, como em todo
 * helper de db.ts. Engolir a queda aqui faria a tela dizer "deu certo" com o
 * banco caído.
 */
async function registroSemDerrubarOCalculo(rotulo: string, trabalho: () => Promise<unknown>) {
  try {
    await trabalho();
  } catch (erro) {
    if (ehErroDeBancoIndisponivel(erro)) throw erro;
    console.warn(`[Network Inteligente] registro de ${rotulo} adiado:`, erro instanceof Error ? erro.message : erro);
  }
}

/**
 * O registro logo depois de um recálculo do motor privado — o momento em que
 * a sugestão NASCE. Chamado no fim de `recalculatePrivateMatches`
 * (match-service.ts), o que alcança TODO recálculo: antes a chamada ficava nos
 * routers que lembravam dela, e o recálculo da remoção de contato e o do
 * "desfazer" do enriquecimento não registravam. Quem recalcula já conferiu o
 * termo do Smart Match. A próxima leitura do painel
 * (networkInteligente.conexoes) sincroniza de forma estrita.
 */
export async function registrarConexoesInternasDepoisDoRecalculo(ownerId: string) {
  await registroSemDerrubarOCalculo("conexões internas", () => sincronizarConexoesInternas(ownerId));
}

/**
 * O motivo de uma conexão entre membras (PLATFORM_MATCH) sem dado pessoal:
 * nem nome, nem o que cada uma escreveu no perfil. Quem é cada lado a
 * plataforma sabe pela conta do participante; o motivo diz só de onde a
 * conexão veio e a nota que a sustentou.
 */
export function motivoEntreMembras(pontuacao: number): string {
  return `Conexão sugerida pelo motor de perfis entre dois membros da plataforma, com o termo do Smart Match aceito pelos dois: compatibilidade de ${Math.round(pontuacao)}%.`;
}

export type ParDeMembras = { outraUserId: number; pontuacao: number };

/**
 * PLATFORM_MATCH — spec da Glenda de 14/09, itens 15 e 17: a conexão entre
 * duas membras que o motor de perfis (matching.ts) acabou de gravar como
 * sugerida. Quem chama já aplicou as travas do motor: termo do Smart Match
 * dos DOIS lados, portão da demanda expressa e nota mínima.
 *
 * Idempotente pela chave do par, que não tem direção: a rodada de A (A×B) e a
 * de B (B×A) dão a mesma linha. Uma leitura das chaves antes poupa a escrita
 * do que já está registrado com a mesma nota; nota nova só atualiza motivo e
 * pontuação (registrarConexao nunca rebaixa etapa nem comissão). Os itens
 * ficam vazios de propósito: "o que tenho" e "o que preciso" de uma membra não
 * aparecem para a outra no Dashboard, e o registro é visível às duas.
 */
export async function registrarConexoesEntreMembras(userId: number, pares: ParDeMembras[]): Promise<number> {
  if (!pares.length) return 0;
  const db = await exigirDb();
  const membro = (id: number): ParticipanteParaRegistro => ({ tipo: "membro", userId: id });
  const chaves = pares.map(par => chaveDoPar("PLATFORM_MATCH", membro(userId), membro(par.outraUserId)));
  const notaRegistrada = new Map((await db.select({ chave: conexoesRegistradas.chaveDoPar, pontuacao: conexoesRegistradas.pontuacao })
    .from(conexoesRegistradas)
    .where(inArray(conexoesRegistradas.chaveDoPar, chaves))).map(linha => [linha.chave, linha.pontuacao]));

  let registradas = 0;
  for (let indice = 0; indice < pares.length; indice += 1) {
    const par = pares[indice];
    const pontuacao = Math.round(par.pontuacao);
    if (par.outraUserId === userId || notaRegistrada.get(chaves[indice]) === pontuacao) continue;
    await registrarConexao(db, {
      origem: "PLATFORM_MATCH",
      a: membro(userId),
      b: membro(par.outraUserId),
      motivo: motivoEntreMembras(pontuacao),
      itens: [],
      pontuacao,
    });
    registradas += 1;
  }
  return registradas;
}

/** O registro das conexões entre membras no fim de uma rodada do motor de perfis — mesma regra de falha das internas. */
export async function registrarConexoesEntreMembrasDepoisDoCalculo(userId: number, pares: ParDeMembras[]) {
  if (!pares.length) return;
  await registroSemDerrubarOCalculo("conexões entre membras", () => registrarConexoesEntreMembras(userId, pares));
}

/** Quem pergunta: a dona pelo openId (rede particular) e a membra pelo id (conta). */
export type Solicitante = { id: number; openId: string };

const participacaoDe = (quem: Solicitante) =>
  or(eq(conexoesParticipantes.ownerId, quem.openId), eq(conexoesParticipantes.userId, quem.id));

export type LadoVisivel = {
  lado: "a" | "b";
  tipo: "contato" | "membro";
  /** Só no lado que é da própria solicitante; do outro lado nunca sai. */
  contactId: number | null;
  codigoAnonimo: string | null;
  meu: boolean;
  originador: boolean;
  statusComissaoOriginador: StatusDeComissao | null;
};

export type ConexaoVisivel = {
  id: string;
  origem: OrigemDaConexao;
  motivo: string;
  /**
   * `false` quando o outro lado retirou a autorização: aí `motivo` é a frase
   * padrão e `itens` vem vazio. A tela lê esta bandeira para escrever a
   * explicação no idioma de quem está lendo, em vez de mostrar a frase em
   * português a uma conta em outro idioma.
   */
  detalhesVisiveis: boolean;
  itens: ItemDaConexao[];
  pontuacao: number;
  /** A etapa PARA quem pergunta: quem descartou vê 'descartada', ainda que o outro lado siga (avancarConexao). */
  status: EtapaDaConexao;
  apresentacaoEm: number | null;
  negociacaoEm: number | null;
  fechamentoEm: number | null;
  descartadaEm: number | null;
  /** Quem pergunta já confirmou o fechamento e a conexão espera a confirmação do outro lado. */
  fechamentoConfirmadoPorMim: boolean;
  statusComissao: StatusDeComissao;
  criadaEm: number;
  lados: LadoVisivel[];
};

/** O participante é de quem pergunta: a dona pelo openId (contato) ou a membra pelo id (conta). */
const ehDaSolicitante = (participante: { tipo: "contato" | "membro"; ownerId: string | null; userId: number | null }, quem: Solicitante) =>
  participante.tipo === "contato" ? participante.ownerId === quem.openId : participante.userId === quem.id;

/**
 * Projeção de um participante para quem pergunta. O lado alheio perde tudo
 * que aponta para a pessoa ou para a dona dela: sai o tipo e o ID anônimo,
 * nunca contact_id, owner_id ou userId de outra conta.
 */
export function ladoParaSolicitante(
  participante: typeof conexoesParticipantes.$inferSelect,
  quem: Solicitante,
): LadoVisivel {
  const meu = ehDaSolicitante(participante, quem);
  return {
    lado: participante.lado,
    tipo: participante.tipo,
    contactId: meu && participante.tipo === "contato" && participante.contactId != null ? Number(participante.contactId) : null,
    codigoAnonimo: participante.tipo === "contato" ? participante.codigoAnonimo : null,
    meu,
    originador: meu ? participante.originador : false,
    statusComissaoOriginador: meu ? (participante.statusComissaoOriginador ?? null) : null,
  };
}

/** Origens em que o outro lado é de OUTRA conta e só entrou porque autorizou (item 26). */
const ORIGENS_COM_AUTORIZACAO_DO_OUTRO_LADO: readonly OrigemDaConexao[] = ["NETWORK_NETWORK_MATCH", "NETWORK_PLATFORM_MATCH"];

export const MOTIVO_SEM_AUTORIZACAO_DO_OUTRO_LADO =
  "O outro lado desta conexão retirou a autorização para a rede: o que ele tem e procura não aparece mais aqui. O registro da conexão segue com a plataforma.";

/**
 * Item 26, "retirar autorização". Uma conexão com a rede global nasceu porque
 * o outro lado autorizou: a dona pelo SIM no contato e pelo termo do Smart
 * Match, a membra pelo termo. Como em `lerRedeGlobalAnonima`, a autorização é
 * conferida AGORA, a cada leitura, e não na hora do cruzamento: contato que
 * voltou a NÃO (ou foi excluído), termo revogado ou conta desativada tiram o
 * lado da lista. Devolve os ids das linhas de participante ainda autorizadas.
 * Só colunas não pessoais de private_contacts e users.
 */
async function participantesAindaAutorizados(db: Banco, alheios: Array<typeof conexoesParticipantes.$inferSelect>): Promise<Set<number>> {
  if (!alheios.length) return new Set();
  const unicos = <T>(valores: T[]) => Array.from(new Set(valores));
  const contatoIds = unicos(alheios.filter(p => p.tipo === "contato" && p.contactId != null).map(p => Number(p.contactId)));
  const contatos = contatoIds.length
    ? await db.select({ id: privateContacts.id, ownerId: privateContacts.ownerId }).from(privateContacts)
        .where(and(inArray(privateContacts.id, contatoIds), eq(privateContacts.disponivelRedeGlobal, true), isNotNull(privateContacts.codigoAnonimo)))
    : [];
  const donaDoContatoDisponivel = new Map(contatos.map(c => [Number(c.id), c.ownerId]));
  const openIds = unicos(contatos.map(c => c.ownerId));
  const membroIds = unicos(alheios.filter(p => p.tipo === "membro" && p.userId != null).map(p => Number(p.userId)));
  const contasAtivas = openIds.length || membroIds.length
    ? await db.select({ id: users.id, openId: users.openId }).from(users)
        .where(and(eq(users.isActive, true), or(
          openIds.length ? inArray(users.openId, openIds) : undefined,
          membroIds.length ? inArray(users.id, membroIds) : undefined,
        )))
    : [];
  if (!contasAtivas.length) return new Set();
  const { usersComConsentimento } = await import("./routers/consent");
  const comTermo = await usersComConsentimento(contasAtivas.map(c => Number(c.id)), "termo_smart_match");
  const autorizadas = contasAtivas.filter(c => comTermo.has(Number(c.id)));
  const openIdAutorizado = new Set(autorizadas.map(c => c.openId));
  const userIdAutorizado = new Set(autorizadas.map(c => Number(c.id)));
  return new Set(alheios.filter(p => (p.tipo === "contato"
    ? p.contactId != null && p.ownerId != null && donaDoContatoDisponivel.get(Number(p.contactId)) === p.ownerId && openIdAutorizado.has(p.ownerId)
    : p.userId != null && userIdAutorizado.has(Number(p.userId)))).map(p => p.id));
}

/**
 * As conexões registradas em que a solicitante participa, mais recentes primeiro.
 * A etapa e o descarte saem do ponto de vista dela (ver avancarConexao); numa
 * conexão com a rede global cujo outro lado retirou a autorização, o motivo e
 * os itens não saem (participantesAindaAutorizados).
 */
export async function listarConexoesDaSolicitante(quem: Solicitante, opcoes: { contactId?: number; limite?: number } = {}): Promise<ConexaoVisivel[]> {
  const db = await exigirDb();
  const condicoes = [participacaoDe(quem)!];
  if (opcoes.contactId !== undefined) {
    condicoes.push(eq(conexoesParticipantes.ownerId, quem.openId), eq(conexoesParticipantes.contactId, opcoes.contactId));
  }
  const minhas = await db.select({ conexaoId: conexoesParticipantes.conexaoId }).from(conexoesParticipantes)
    .where(and(...condicoes));
  const ids = Array.from(new Set(minhas.map(linha => linha.conexaoId)));
  if (!ids.length) return [];
  const [cabecalhos, participantes] = await Promise.all([
    db.select().from(conexoesRegistradas).where(inArray(conexoesRegistradas.id, ids))
      .orderBy(desc(conexoesRegistradas.createdAt)).limit(opcoes.limite ?? 200),
    db.select().from(conexoesParticipantes).where(inArray(conexoesParticipantes.conexaoId, ids)),
  ]);
  const comAutorizacaoAlheia = new Set(cabecalhos.filter(c => ORIGENS_COM_AUTORIZACAO_DO_OUTRO_LADO.includes(c.origem)).map(c => c.id));
  const autorizados = await participantesAindaAutorizados(db,
    participantes.filter(p => comAutorizacaoAlheia.has(p.conexaoId) && !ehDaSolicitante(p, quem)));

  return cabecalhos.map(cabecalho => {
    const lados = participantes.filter(p => p.conexaoId === cabecalho.id).sort((x, y) => x.lado.localeCompare(y.lado));
    const meus = lados.filter(p => ehDaSolicitante(p, quem));
    const alheios = lados.filter(p => !ehDaSolicitante(p, quem));
    // O lado alheio que sumiu (conta excluída) também não autoriza mais nada.
    const detalhesVisiveis = !comAutorizacaoAlheia.has(cabecalho.id)
      || (alheios.length > 0 && alheios.every(p => autorizados.has(p.id)));
    const descartadaPorMim = cabecalho.status !== "fechada" && meus.length > 0 && meus.every(p => p.descartadaEm != null);
    return {
      id: cabecalho.id,
      origem: cabecalho.origem,
      motivo: detalhesVisiveis ? cabecalho.motivo : MOTIVO_SEM_AUTORIZACAO_DO_OUTRO_LADO,
      // A TELA precisa saber POR QUE o cartão está sem detalhe, e não só ler a
      // frase: o motivo é escrito aqui em português, e o cartão é traduzido nos
      // dez idiomas. Com esta bandeira ela escreve a explicação no idioma de
      // quem está lendo, em vez de mostrar português a uma conta em árabe.
      detalhesVisiveis,
      itens: detalhesVisiveis && Array.isArray(cabecalho.itens) ? cabecalho.itens : [],
      pontuacao: cabecalho.pontuacao,
      status: descartadaPorMim ? "descartada" as const : cabecalho.status,
      apresentacaoEm: cabecalho.apresentacaoEm ?? null,
      negociacaoEm: cabecalho.negociacaoEm ?? null,
      fechamentoEm: cabecalho.fechamentoEm ?? null,
      descartadaEm: descartadaPorMim ? Math.max(...meus.map(p => Number(p.descartadaEm))) : (cabecalho.descartadaEm ?? null),
      fechamentoConfirmadoPorMim: cabecalho.status === "negociacao" && meus.length > 0 && meus.every(p => p.fechamentoConfirmadoEm != null),
      statusComissao: cabecalho.statusComissao,
      criadaEm: cabecalho.createdAt,
      lados: lados.map(p => ladoParaSolicitante(p, quem)),
    };
  });
}

/** A etapa seguinte que a participante pode registrar; descartar vale antes do fechamento. */
const PROXIMA_ETAPA: Partial<Record<EtapaDaConexao, EtapaDaConexao>> = {
  identificada: "apresentacao",
  apresentacao: "negociacao",
  negociacao: "fechada",
};

export class ConexaoNaoEncontrada extends Error {
  constructor() { super("Conexão não encontrada."); this.name = "ConexaoNaoEncontrada"; }
}
export class EtapaForaDeOrdem extends Error {
  constructor() { super("Esta etapa não pode ser registrada agora."); this.name = "EtapaForaDeOrdem"; }
}

/** Etapa que a tela pede → a que ela exige estar antes (descartar: qualquer uma antes do fim). */
export function etapaAnteriorExigida(destino: Exclude<EtapaDaConexao, "identificada">): EtapaDaConexao[] {
  if (destino === "descartada") return ["identificada", "apresentacao", "negociacao"];
  return (Object.entries(PROXIMA_ETAPA) as [EtapaDaConexao, EtapaDaConexao][])
    .filter(([, proxima]) => proxima === destino).map(([anterior]) => anterior);
}

/**
 * Registra que houve apresentação, negociação, fechamento — ou que a conexão
 * foi descartada. Só quem participa (dona do contato ou membra) registra, e
 * só a etapa seguinte.
 *
 * Nenhum lado encerra sozinho a trilha do outro, inclusive a de comissão da
 * originadora (item 18). Cada lado declara por si, em conexoes_participantes:
 * - DESCARTAR vale para quem descartou (a lista mostra 'descartada' só a ela);
 *   o outro lado segue registrando apresentação e negociação, e a conexão só
 *   vira 'descartada' quando todos os lados descartaram. Descartar apaga a
 *   confirmação de fechamento que esse lado tivesse dado.
 * - FECHAR exige a confirmação de todos os lados: cada confirmação fica no lado
 *   de quem confirmou, e só a última põe a conexão em 'fechada' e a comissão da
 *   plataforma e das originadoras em 'a_apurar' — apurar, não cobrar. Lado que
 *   descartou não conta como confirmado (item 6 da revisão da #135: A confirma,
 *   A descarta, B confirma NÃO fecha — B fica aguardando, como na primeira
 *   confirmação).
 * Na conexão interna os dois lados são da mesma dona, e um clique basta.
 *
 * Tudo numa transação que começa travando o cabeçalho (FOR UPDATE), e cada
 * UPDATE do cabeçalho leva a etapa anterior no WHERE: dois cliques, duas abas ou
 * os dois lados ao mesmo tempo passam um de cada vez sem pular etapa, e o
 * fechamento nunca fica pela metade (conexão fechada com a originadora ainda em
 * 'sem_negocio', sem como repetir).
 */
export async function avancarConexao(
  quem: Solicitante,
  conexaoId: string,
  destino: Exclude<EtapaDaConexao, "identificada">,
): Promise<{ status: EtapaDaConexao; aguardandoOutroLado: boolean }> {
  const db = await exigirDb();
  const [participa] = await db.select({ id: conexoesParticipantes.id }).from(conexoesParticipantes)
    .where(and(eq(conexoesParticipantes.conexaoId, conexaoId), participacaoDe(quem)!)).limit(1);
  if (!participa) throw new ConexaoNaoEncontrada();

  return db.transaction(async tx => {
    const [cabecalho] = await tx.select({ status: conexoesRegistradas.status }).from(conexoesRegistradas)
      .where(eq(conexoesRegistradas.id, conexaoId)).limit(1).for("update");
    if (!cabecalho) throw new ConexaoNaoEncontrada();
    const lados = await tx.select({
      tipo: conexoesParticipantes.tipo,
      ownerId: conexoesParticipantes.ownerId,
      userId: conexoesParticipantes.userId,
      descartadaEm: conexoesParticipantes.descartadaEm,
      fechamentoConfirmadoEm: conexoesParticipantes.fechamentoConfirmadoEm,
    }).from(conexoesParticipantes).where(eq(conexoesParticipantes.conexaoId, conexaoId));
    const meus = lados.filter(lado => ehDaSolicitante(lado, quem));
    const outros = lados.filter(lado => !ehDaSolicitante(lado, quem));
    if (!meus.length) throw new ConexaoNaoEncontrada();
    if (!etapaAnteriorExigida(destino).includes(cabecalho.status) || meus.some(lado => lado.descartadaEm != null)) {
      throw new EtapaForaDeOrdem();
    }

    const agora = Date.now();
    const meusLados = and(eq(conexoesParticipantes.conexaoId, conexaoId), participacaoDe(quem)!);
    const moverCabecalho = async (marcas: Partial<typeof conexoesRegistradas.$inferInsert>) => {
      const [resultado] = await tx.update(conexoesRegistradas)
        .set({ ...marcas, status: destino, updatedAt: agora })
        .where(and(eq(conexoesRegistradas.id, conexaoId), inArray(conexoesRegistradas.status, etapaAnteriorExigida(destino))));
      if (!((resultado as { affectedRows?: number } | undefined)?.affectedRows)) throw new EtapaForaDeOrdem();
    };

    if (destino === "apresentacao" || destino === "negociacao") {
      await moverCabecalho(destino === "apresentacao" ? { apresentacaoEm: agora } : { negociacaoEm: agora });
      return { status: destino, aguardandoOutroLado: false };
    }

    if (destino === "descartada") {
      await tx.update(conexoesParticipantes).set({ descartadaEm: agora, fechamentoConfirmadoEm: null, updatedAt: agora }).where(meusLados);
      if (outros.every(lado => lado.descartadaEm != null)) await moverCabecalho({ descartadaEm: agora });
      return { status: "descartada" as const, aguardandoOutroLado: false };
    }

    if (meus.every(lado => lado.fechamentoConfirmadoEm != null)) throw new EtapaForaDeOrdem();
    await tx.update(conexoesParticipantes).set({ fechamentoConfirmadoEm: agora, updatedAt: agora }).where(meusLados);
    // Lado descartado não conta como confirmado, ainda que uma confirmação antiga tenha ficado gravada nele.
    const confirmou = (lado: { descartadaEm: number | null; fechamentoConfirmadoEm: number | null }) =>
      lado.descartadaEm == null && lado.fechamentoConfirmadoEm != null;
    if (!outros.every(confirmou)) return { status: "negociacao" as const, aguardandoOutroLado: true };
    await moverCabecalho({ fechamentoEm: agora, statusComissao: "a_apurar" });
    await tx.update(conexoesParticipantes)
      .set({ statusComissaoOriginador: "a_apurar", updatedAt: agora })
      .where(and(eq(conexoesParticipantes.conexaoId, conexaoId), eq(conexoesParticipantes.originador, true)));
    return { status: "fechada" as const, aguardandoOutroLado: false };
  });
}

/** O que o painel conta a partir das conexões da solicitante. */
export function contarConexoes(conexoes: ConexaoVisivel[]) {
  const doTipo = (...origens: OrigemDaConexao[]) => conexoes.filter(c => origens.includes(c.origem));
  return {
    internas: doTipo("PRIVATE_NETWORK_MATCH").length,
    comRedeGlobal: doTipo("NETWORK_PLATFORM_MATCH", "NETWORK_NETWORK_MATCH").length,
    oportunidades: conexoes.filter(c => c.status !== "descartada").length,
    intermediacoes: conexoes.filter(c => c.apresentacaoEm !== null).length,
    negociosEmAndamento: conexoes.filter(c => c.status === "apresentacao" || c.status === "negociacao").length,
    negociosConcluidos: conexoes.filter(c => c.status === "fechada").length,
    comissionamentos: conexoes.filter(c => c.statusComissao !== "sem_negocio"
      || c.lados.some(l => l.meu && l.statusComissaoOriginador && l.statusComissaoOriginador !== "sem_negocio")).length,
  };
}

// ─── Administração da plataforma ──────────────────────────────────────────────

/**
 * A lista da plataforma: todas as origens, com a CONTA de quem responde por
 * cada lado (a dona do network ou a membra) — a plataforma conhece as próprias
 * usuárias — e nada do contato além do ID anônimo.
 *
 * As colunas são uma lista-branca, na consulta: `chave_do_par` fica de fora
 * porque carrega os ids crus ("PRIVATE_NETWORK_MATCH|contato:123|contato:456"),
 * e um id de contato ao lado do ID anônimo desfaz o anonimato num salto. Quem
 * lê é só a staff (admin e presidente), com auditoria: ver o router.
 */
export async function listarTodasAsConexoes(opcoes: { origem?: OrigemDaConexao; status?: EtapaDaConexao; limite?: number } = {}) {
  const db = await exigirDb();
  // O filtro vai na consulta, não na tela: a lista tem teto, e filtrar as 200
  // mais recentes esconderia a conexão fechada mais antiga que espera apuração.
  const cabecalhos = await db.select({
    id: conexoesRegistradas.id,
    origem: conexoesRegistradas.origem,
    motivo: conexoesRegistradas.motivo,
    itens: conexoesRegistradas.itens,
    pontuacao: conexoesRegistradas.pontuacao,
    status: conexoesRegistradas.status,
    apresentacaoEm: conexoesRegistradas.apresentacaoEm,
    negociacaoEm: conexoesRegistradas.negociacaoEm,
    fechamentoEm: conexoesRegistradas.fechamentoEm,
    descartadaEm: conexoesRegistradas.descartadaEm,
    statusComissao: conexoesRegistradas.statusComissao,
    createdAt: conexoesRegistradas.createdAt,
  }).from(conexoesRegistradas)
    .where(and(
      opcoes.origem ? eq(conexoesRegistradas.origem, opcoes.origem) : undefined,
      opcoes.status ? eq(conexoesRegistradas.status, opcoes.status) : undefined,
    ))
    .orderBy(desc(conexoesRegistradas.createdAt)).limit(opcoes.limite ?? 200);
  if (!cabecalhos.length) return [];
  const participantes = await db.select().from(conexoesParticipantes)
    .where(inArray(conexoesParticipantes.conexaoId, cabecalhos.map(c => c.id)));
  const openIds = Array.from(new Set(participantes.map(p => p.ownerId).filter((v): v is string => Boolean(v))));
  const userIds = Array.from(new Set(participantes.map(p => p.userId).filter((v): v is number => typeof v === "number")));
  const contas = openIds.length || userIds.length
    ? await db.select({ id: users.id, openId: users.openId, name: users.name }).from(users)
        .where(or(
          openIds.length ? inArray(users.openId, openIds) : undefined,
          userIds.length ? inArray(users.id, userIds) : undefined,
        ))
    : [];
  const porOpenId = new Map(contas.map(c => [c.openId, c]));
  const porId = new Map(contas.map(c => [c.id, c]));
  // A máscara entra AQUI, na leitura que atravessa as redes de todas as donas:
  // o rótulo de "O que tenho"/"O que preciso" é texto livre, e o ID anônimo não
  // protege nada com o telefone escrito dentro dele. Na escrita não pode entrar:
  // ali o valor mascarado substituiria o dado da própria dona no banco.
  const semContato = (valor: unknown) => (typeof valor === "string" ? mascararContatosEmTexto(valor) : valor);
  const itensSemContato = (valor: unknown): ItemDaConexao[] =>
    (Array.isArray(valor) ? valor : []).map(item => (item && typeof item === "object"
      ? { ...(item as ItemDaConexao), tem: semContato((item as ItemDaConexao).tem) as string, precisa: semContato((item as ItemDaConexao).precisa) as string }
      : item)) as ItemDaConexao[];
  return cabecalhos.map(cabecalho => ({
    id: cabecalho.id,
    origem: cabecalho.origem,
    motivo: semContato(cabecalho.motivo) as string,
    itens: itensSemContato(cabecalho.itens),
    pontuacao: cabecalho.pontuacao,
    status: cabecalho.status,
    apresentacaoEm: cabecalho.apresentacaoEm ?? null,
    negociacaoEm: cabecalho.negociacaoEm ?? null,
    fechamentoEm: cabecalho.fechamentoEm ?? null,
    descartadaEm: cabecalho.descartadaEm ?? null,
    statusComissao: cabecalho.statusComissao,
    createdAt: cabecalho.createdAt,
    lados: participantes.filter(p => p.conexaoId === cabecalho.id).sort((x, y) => x.lado.localeCompare(y.lado)).map(p => {
      const conta = p.tipo === "contato" ? porOpenId.get(p.ownerId ?? "") : porId.get(p.userId ?? -1);
      return {
        id: p.id,
        lado: p.lado,
        tipo: p.tipo,
        codigoAnonimo: p.codigoAnonimo,
        originador: p.originador,
        statusComissaoOriginador: p.statusComissaoOriginador,
        // O que este lado declarou: quem descartou e quem já confirmou o fechamento.
        descartadaEm: p.descartadaEm ?? null,
        fechamentoConfirmadoEm: p.fechamentoConfirmadoEm ?? null,
        conta: conta ? { id: conta.id, nome: conta.name } : null,
      };
    }),
  }));
}

export class ComissaoAntesDoFechamento extends Error {
  constructor() { super("A comissão só é apurada depois do fechamento do negócio."); this.name = "ComissaoAntesDoFechamento"; }
}

/**
 * A plataforma registra o resultado da apuração: devida ou não devida. Só
 * depois do fechamento, e só o STATUS — nenhum valor entra aqui. Sem
 * `participanteId`, é a comissão da plataforma; com ele, a da originadora.
 */
export async function definirStatusDeComissao(entrada: {
  conexaoId: string;
  status: Exclude<StatusDeComissao, "sem_negocio">;
  participanteId?: number;
}) {
  const db = await exigirDb();
  const [conexao] = await db.select({ status: conexoesRegistradas.status }).from(conexoesRegistradas)
    .where(eq(conexoesRegistradas.id, entrada.conexaoId)).limit(1);
  if (!conexao) throw new ConexaoNaoEncontrada();
  if (conexao.status !== "fechada") throw new ComissaoAntesDoFechamento();
  const agora = Date.now();
  if (entrada.participanteId === undefined) {
    await db.update(conexoesRegistradas).set({ statusComissao: entrada.status, updatedAt: agora })
      .where(and(eq(conexoesRegistradas.id, entrada.conexaoId), eq(conexoesRegistradas.status, "fechada")));
  } else {
    const [resultado] = await db.update(conexoesParticipantes).set({ statusComissaoOriginador: entrada.status, updatedAt: agora })
      .where(and(
        eq(conexoesParticipantes.id, entrada.participanteId),
        eq(conexoesParticipantes.conexaoId, entrada.conexaoId),
        eq(conexoesParticipantes.originador, true),
      ));
    if (!((resultado as { affectedRows?: number } | undefined)?.affectedRows)) throw new ConexaoNaoEncontrada();
  }
  return { ok: true as const };
}
