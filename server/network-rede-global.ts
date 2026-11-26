import { and, asc, count, eq, exists, gt, inArray, isNotNull, isNull, lte, ne, notExists, or } from "drizzle-orm";
import {
  consents, contactAssets, contactNeeds, documentVersions, entidadeMembros, entidades, privateContacts, userProfiles, users,
} from "../drizzle/schema";
import { ERROS_DA_ENTIDADE } from "../shared/entidades";
import { criarTeto } from "./assistente-de-texto";
import { exigirDb } from "./db";
import { scoreMatch, slugifyMatchTag, type MatchReason } from "./match-service";
import { garantirCodigosAnonimos } from "./network-codigo-anonimo";
import { registrarConexao, type ItemDaConexao } from "./network-registro";
import { necessidadesEscritasDoPerfil } from "./portao-da-demanda-expressa";
import { mascararContatosEmTexto } from "../shared/contato-em-texto";
import { chavesDoContato, podemCasar } from "../shared/chaves-de-cruzamento";
import { candidatosPelasChaves } from "./indice-de-cruzamento";

/**
 * O network particular diante da rede global — Meu Network Inteligente, spec
 * da Glenda de 14/09, itens 13, 14, 15B e 26.
 *
 * "O network pessoal deve ser privado por padrão." Cada contato tem o SIM/NÃO
 * "Disponibilizar este contato para oportunidades da rede", padrão NÃO. Com
 * SIM, o mecanismo global pode usar SOMENTE:
 *
 *   ID ANÔNIMO + O QUE TENHO + O QUE PRECISO
 *
 * e nunca nome, telefone, e-mail, áudio, transcrição ou notas. Isso é regra
 * de CONSULTA (CLAUDE.md, "Privacidade é regra de consulta, não de tela"): a
 * leitura que atravessa donas, `lerRedeGlobalAnonima`, não seleciona nenhuma
 * coluna pessoal — elas nem chegam à memória do servidor nesta rota.
 *
 * O cruzamento reaproveita `scoreMatch` do motor privado (sem editá-lo), com
 * as mesmas regras: concorrentes não casam, serviço só casa com necessidade
 * declarada, nada de palavra solta.
 *
 * Duas origens nascem aqui (item 17):
 * - NETWORK_NETWORK_MATCH: contato autorizado desta dona × contato autorizado
 *   de OUTRA dona; as duas são originadoras (item 18).
 * - NETWORK_PLATFORM_MATCH: contato autorizado × membra da plataforma (o que
 *   ela declarou em "O que tenho" e "O que preciso" no perfil).
 *
 * Quem participa do cruzamento autorizou: a dona do contato pelo SIM e pelo
 * termo do Smart Match; a membra pelo termo do Smart Match. Revogar qualquer
 * um tira da leitura seguinte, porque o filtro roda a cada chamada. Conta
 * desativada (admin ou bloqueio de segurança) sai do mesmo jeito, como no
 * motor de perfis e na distribuição: nem os contatos dela nem o perfil cruzam.
 *
 * Fica de fora, por ora: oportunidades publicadas (título e descrição são texto
 * corrido, não "tem/precisa" estruturado — cruzar exigiria IA e o portão da
 * demanda expressa; ver relatório).
 */

/** O mesmo corte do motor privado (SAVE_THRESHOLD): scoreMatch devolve 0, 45, 60 ou 100. */
export const LIMIAR_DA_CONEXAO = 50;
/**
 * O cruzamento é uma consulta, não uma exportação da rede: desde a N4b ele não
 * lê a rede inteira, pergunta ao índice (`chaves_de_cruzamento`) quem pode
 * casar com os contatos de quem procura e lê só esses, pela leitura autorizada
 * (docs/arquitetura/entidades.md, seção 8). As duas janelas de 1000 (contatos
 * comuns e de entidades, sem ordem) saíram.
 *
 * Os perfis de membras ainda são lidos por página, em ordem de id, até
 * TETO_DE_MEMBROS: o índice dos perfis fica para a próxima PR (seção 8).
 */
export const TETO_DE_MEMBROS = 1000;
/**
 * Acima destes contatos disponíveis, a busca vai para a fila (server/fila-de-cruzamento.ts)
 * e roda em lotes no servidor, fora do pedido: é a conta da entidade, com milhares de associados.
 */
export const CONTATOS_DA_BUSCA_NA_HORA = 300;
/** Contatos de quem procura cruzados por lote da fila. */
export const CONTATOS_POR_LOTE = 200;
export const TETO_DE_REGISTROS_POR_RODADA = 100;
/**
 * Tetos de TRABALHO. O cruzamento é CPU síncrona (scoreMatch par a par) na
 * instância única do Render, e cada rodada grava conexões em que OUTRAS contas
 * participam. Sem teto, uma conta com centenas de contatos (e o httpBatchLink
 * mandando dezenas de chamadas num POST só) travava o servidor de todas e
 * inundava o registro de uma vítima com contatos feitos sob medida para ela.
 * - itens por lado: um contato ou perfil com lista enorme não multiplica o custo;
 * - orçamento de comparações (scoreMatch) por rodada: esgotado, a rodada para e
 *   diz que ficou incompleta; a cada fatia o laço devolve a vez ao event loop;
 * - por contraparte: uma rodada registra no máximo N conexões com a mesma outra
 *   dona ou a mesma membra (as de nota maior primeiro);
 * - por conta: poucas buscas a cada 10 minutos (`tetoDeBuscaNaRedeGlobal`).
 */
export const TETO_DE_ITENS_POR_LADO = 20;
export const ORCAMENTO_DE_COMPARACOES = 100_000;
const COMPARACOES_POR_FATIA = 2_000;
export const TETO_POR_CONTRAPARTE_POR_RODADA = 10;
export const BUSCAS_NA_REDE_GLOBAL_POR_JANELA = 10;

export const tetoDeBuscaNaRedeGlobal = criarTeto(
  BUSCAS_NA_REDE_GLOBAL_POR_JANELA,
  10 * 60_000,
  "Muitas buscas na rede global em sequência. Aguarde alguns minutos e tente de novo.",
);

export type ItemDeNegocio = { label: string; category: string | null };

/** O que o mecanismo global enxerga de um contato autorizado. */
export type ContatoAnonimo = { codigoAnonimo: string; tenho: ItemDeNegocio[]; preciso: ItemDeNegocio[] };

/** Uso interno do servidor: o id e a dona servem para registrar a conexão; nunca saem numa resposta. */
type ContatoDaRede = ContatoAnonimo & { contactId: number; ownerId: string };

export class ContatoNaoEncontrado extends Error {
  constructor() { super("Contato não encontrado na sua rede."); this.name = "ContatoNaoEncontrado"; }
}

/**
 * O associado que ativou o próprio cadastro (N3) decide por si na conta dele:
 * a cópia na rede da entidade saiu da rede global na ativação e não volta,
 * nem com os itens que a empresa desmarcou, nem sem o Termo do Smart Match dela.
 */
export class AssociadoAtivado extends Error {
  constructor() { super(ERROS_DA_ENTIDADE.associadoAtivado); this.name = "AssociadoAtivado"; }
}

/** SIM/NÃO por contato. Só a dona muda, e o efeito vale na leitura seguinte. */
export async function definirDisponibilidade(ownerId: string, contactId: number, disponivel: boolean) {
  const db = await exigirDb();
  if (disponivel) {
    const [ativado] = await db.select({ id: entidadeMembros.id }).from(entidadeMembros)
      .where(and(eq(entidadeMembros.ownerId, ownerId), eq(entidadeMembros.contactId, contactId), eq(entidadeMembros.estado, "ativado")))
      .limit(1);
    if (ativado) throw new AssociadoAtivado();
  }
  const [resultado] = await db.update(privateContacts)
    .set({ disponivelRedeGlobal: disponivel, disponibilidadeAlteradaEm: Date.now() })
    .where(and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, ownerId)));
  if (!((resultado as { affectedRows?: number } | undefined)?.affectedRows)) throw new ContatoNaoEncontrado();
  // Um contato disponibilizado precisa do ID que o representa lá fora.
  if (disponivel) await garantirCodigosAnonimos(ownerId);
  return { disponivel };
}

/**
 * A projeção que pode sair do servidor: só o ID anônimo e os itens, e os itens
 * passam pela máscara. O ID anônimo não protege nada se o telefone da pessoa
 * estiver escrito DENTRO de "O que tenho" ou "O que preciso" — é a mesma
 * máscara que `encontrosEntre` aplica antes de gravar motivo e itens.
 */
export function projecaoAnonima(contato: ContatoAnonimo): ContatoAnonimo {
  // A categoria também é digitada pela dona (o campo é um input aberto): sem
  // a mesma máscara, um telefone escrito ali sairia inteiro.
  const semContato = ({ label, category }: ItemDeNegocio) => ({
    label: mascararContatosEmTexto(label),
    category: typeof category === "string" ? mascararContatosEmTexto(category) : category,
  });
  return {
    codigoAnonimo: contato.codigoAnonimo,
    tenho: contato.tenho.map(semContato),
    preciso: contato.preciso.map(semContato),
  };
}

/**
 * Os itens dos contatos lidos. A dona entra no WHERE junto com os ids: as duas
 * tabelas só têm índice por (dona, contato), e o IN só por contato varria a
 * tabela inteira a cada página (medido na carga de 50 mil associados, N4b).
 */
async function itensDosContatos(db: Awaited<ReturnType<typeof exigirDb>>, contatos: Array<{ id: number; ownerId: string }>) {
  if (!contatos.length) return { tenho: new Map<number, ItemDeNegocio[]>(), preciso: new Map<number, ItemDeNegocio[]>() };
  const ids = contatos.map(c => c.id);
  const donas = Array.from(new Set(contatos.map(c => c.ownerId)));
  const [possui, procura] = await Promise.all([
    db.select({ contactId: contactAssets.contactId, label: contactAssets.tagLabel, category: contactAssets.category })
      .from(contactAssets).where(and(inArray(contactAssets.ownerId, donas), inArray(contactAssets.contactId, ids))),
    db.select({ contactId: contactNeeds.contactId, label: contactNeeds.tagLabel, category: contactNeeds.category })
      .from(contactNeeds).where(and(inArray(contactNeeds.ownerId, donas), inArray(contactNeeds.contactId, ids))),
  ]);
  const agrupar = (linhas: Array<{ contactId: number; label: string; category: string | null }>) => {
    const mapa = new Map<number, ItemDeNegocio[]>();
    for (const linha of linhas) {
      const lista = mapa.get(Number(linha.contactId)) ?? [];
      if (lista.length >= TETO_DE_ITENS_POR_LADO) continue;
      lista.push({ label: linha.label, category: linha.category ?? null });
      mapa.set(Number(linha.contactId), lista);
    }
    return mapa;
  };
  return { tenho: agrupar(possui), preciso: agrupar(procura) };
}

/**
 * A leitura que atravessa donas. Colunas lidas de private_contacts: id,
 * owner e ID anônimo — mais nada. Só entra contato com SIM, com ID anônimo e
 * cuja dona tem o termo do Smart Match vigente. `excetoDona` tira a própria
 * rede de quem pergunta; `somenteDona` lê só a dela (os contatos que ELA
 * disponibilizou, lado de cá do cruzamento); `ids` lê só os candidatos que o
 * índice achou (server/indice-de-cruzamento.ts).
 *
 * Paginada e ORDENADA pelo id (N4b): `aPartirDoId` e `limite` dão uma página;
 * sem `limite`, a função percorre todas as páginas e devolve tudo. Não há mais
 * janela: os associados de uma entidade com convênio vigente entram todos, como
 * os contatos das outras donas (antes eram duas janelas de 1000, sem ordem).
 */
export async function lerRedeGlobalAnonima(opcoes: OpcoesDaLeitura = {}): Promise<ContatoDaRede[]> {
  if (opcoes.limite !== undefined) return lerUmaPagina(opcoes, opcoes.limite);
  let todos: ContatoDaRede[] = [];
  for await (const pagina of lerRedeGlobalPaginada(opcoes)) todos = todos.concat(pagina);
  return todos;
}

type OpcoesDaLeitura = {
  excetoDona?: string; somenteDona?: string; contactId?: number; ids?: number[];
  aPartirDoId?: number; limite?: number;
};

/** Contatos por página da leitura global (o IN dos itens e o da autorização seguem abaixo do teto do MySQL). */
export const CONTATOS_POR_PAGINA = 1000;

/** Todas as páginas, em ordem de id: a busca grande (a fila) e a medida de carga leem assim. */
export async function* lerRedeGlobalPaginada(opcoes: Omit<OpcoesDaLeitura, "aPartirDoId" | "limite"> = {}, tamanho = CONTATOS_POR_PAGINA): AsyncGenerator<ContatoDaRede[]> {
  if (opcoes.ids) {
    const ids = Array.from(new Set(opcoes.ids)).sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i += tamanho) {
      const pagina = await lerUmaPagina({ ...opcoes, ids: ids.slice(i, i + tamanho) }, tamanho);
      if (pagina.length) yield pagina;
    }
    return;
  }
  let depoisDe = 0;
  for (;;) {
    const { contatos, ultimoId } = await lerPaginaCrua({ ...opcoes, aPartirDoId: depoisDe }, tamanho);
    if (contatos.length) yield contatos;
    // A página veio incompleta (a última) ou o id não andou: fim.
    if (ultimoId === null || !(ultimoId > depoisDe)) return;
    depoisDe = ultimoId;
  }
}

async function lerUmaPagina(opcoes: OpcoesDaLeitura, limite: number): Promise<ContatoDaRede[]> {
  return (await lerPaginaCrua(opcoes, limite)).contatos;
}

/**
 * Uma página: as linhas autorizadas com id depois de `aPartirDoId`, em ordem, e
 * o último id lido (null quando a página veio incompleta, isto é, acabou).
 */
async function lerPaginaCrua(opcoes: OpcoesDaLeitura, limite: number): Promise<{ contatos: ContatoDaRede[]; ultimoId: number | null }> {
  const db = await exigirDb();
  const agora = Date.now();
  // A autorização da dona (conta ativa e termo do Smart Match) e o convênio da entidade
  // filtram NO SQL, antes do LIMIT: filtrados depois, a página podia vir inteira de uma
  // dona sem autorização. O filtro em memória abaixo continua como segunda trava.
  const condicoes = [eq(privateContacts.disponivelRedeGlobal, true), isNotNull(privateContacts.codigoAnonimo), eq(users.isActive, true)];
  if (opcoes.excetoDona) condicoes.push(ne(privateContacts.ownerId, opcoes.excetoDona));
  if (opcoes.somenteDona) condicoes.push(eq(privateContacts.ownerId, opcoes.somenteDona));
  if (opcoes.contactId !== undefined) condicoes.push(eq(privateContacts.id, opcoes.contactId));
  if (opcoes.ids) {
    if (!opcoes.ids.length) return { contatos: [], ultimoId: null };
    condicoes.push(inArray(privateContacts.id, opcoes.ids));
  }
  if (opcoes.aPartirDoId) condicoes.push(gt(privateContacts.id, opcoes.aPartirDoId));
  const [termo] = await db.select({ id: documentVersions.id }).from(documentVersions)
    .where(and(eq(documentVersions.type, "termo_smart_match"), eq(documentVersions.isCurrent, true))).limit(1);
  if (termo) {
    condicoes.push(exists(db.select({ um: consents.userId }).from(consents).where(and(
      eq(consents.userId, users.id), eq(consents.documentVersionId, termo.id), isNull(consents.revokedAt),
    ))));
  }
  // O contato de conta de ENTIDADE só entra com o convênio vigente e se o associado não ativou a conta.
  condicoes.push(or(
    eq(users.isEntidade, false),
    and(
      // Convênio que não vale hoje (o mesmo corte de convenioVigente: o dia do fim ainda vale).
      notExists(db.select({ um: entidades.id }).from(entidades).where(and(
        eq(entidades.ownerId, privateContacts.ownerId),
        or(ne(entidades.convenioEstado, "ativo"), lte(entidades.convenioFim, agora - 86_400_000)),
      ))),
      // O associado ativado cruza pela conta dele, não pela cópia da entidade.
      notExists(db.select({ um: entidadeMembros.id }).from(entidadeMembros).where(and(
        eq(entidadeMembros.contactId, privateContacts.id), eq(entidadeMembros.estado, "ativado"),
      ))),
    ),
  )!);
  const linhas = await db
    .select({ id: privateContacts.id, ownerId: privateContacts.ownerId, codigoAnonimo: privateContacts.codigoAnonimo })
    .from(privateContacts)
    .innerJoin(users, eq(users.openId, privateContacts.ownerId))
    .where(and(...condicoes))
    .orderBy(asc(privateContacts.id))
    .limit(limite);
  const ultimoId = linhas.length >= limite ? Number(linhas[linhas.length - 1].id) : null;
  if (!linhas.length) return { contatos: [], ultimoId };

  // A dona autoriza o cruzamento pelo termo do Smart Match, conferido agora; conta desativada não entra.
  const donas = await db.select({ id: users.id, openId: users.openId }).from(users)
    .where(and(inArray(users.openId, Array.from(new Set(linhas.map(l => l.ownerId)))), eq(users.isActive, true)));
  const { usersComConsentimento } = await import("./routers/consent");
  const autorizadas = await usersComConsentimento(donas.map(d => d.id), "termo_smart_match");
  // A conta de entidade (a base das associações, N1) só cruza com o convênio vigente: encerrado, os associados
  // saem do cruzamento na leitura seguinte, sem apagar nada (docs/arquitetura/entidades.md, seção 3).
  const { entidadesSemConvenio } = await import("./entidades");
  const semConvenio = await entidadesSemConvenio(db, donas.map(d => d.openId), agora);
  const donaAutorizada = new Set(donas.filter(d => autorizadas.has(d.id) && !semConvenio.has(d.openId)).map(d => d.openId));
  const validas = linhas.filter(l => donaAutorizada.has(l.ownerId));

  const { tenho, preciso } = await itensDosContatos(db, validas.map(l => ({ id: Number(l.id), ownerId: l.ownerId })));
  return {
    ultimoId,
    contatos: validas.map(linha => ({
      contactId: Number(linha.id),
      ownerId: linha.ownerId,
      codigoAnonimo: linha.codigoAnonimo as string,
      tenho: tenho.get(Number(linha.id)) ?? [],
      preciso: preciso.get(Number(linha.id)) ?? [],
    })),
  };
}

type MembroDaRede = { userId: number; tenho: ItemDeNegocio[]; preciso: ItemDeNegocio[] };

const textos = (valor: unknown): string[] =>
  (Array.isArray(valor) ? valor : []).filter((item): item is string => typeof item === "string" && item.trim().length > 1).map(item => item.trim().slice(0, 200));

/**
 * Membras ATIVAS com o termo do Smart Match e algo declarado em "O que tenho" ou
 * "O que preciso". O texto de "Outra necessidade" vale como "O que preciso",
 * como nos outros motores (`necessidadesEscritasDoPerfil`). A área de atuação e
 * a especialidade só alimentam a guarda de concorrência dessa leitura; o que a
 * membra OFERECE ao cruzamento continua sendo "O que tenho".
 */
export async function lerMembrosParaCruzamento(excetoUserId: number): Promise<MembroDaRede[]> {
  const db = await exigirDb();
  const perfis = await db
    .select({
      userId: userProfiles.userId, whatIHave: userProfiles.whatIHave, whatINeed: userProfiles.whatINeed,
      // A descrição das demandas detalhadas de "O que preciso" (14/09) também é necessidade declarada.
      whatINeedDetails: userProfiles.whatINeedDetails,
      seekingTypes: userProfiles.seekingTypes, seekingOtherNeed: userProfiles.seekingOtherNeed,
      // O que a membra OFERECE quando "O que tenho" está vazio (o caso comum: a tela só grava ids fixos ali,
      // nenhum de serviço). A guarda de concorrência de `necessidadesEscritasDoPerfil` lê as duas colunas como
      // `ofertasDoPerfil`; sem elas era inerte aqui, e a consultora tributária que descreveu o próprio serviço
      // numa demanda casava com todo contato que o presta.
      activityArea: userProfiles.activityArea, primarySpecialty: userProfiles.primarySpecialty,
    })
    .from(userProfiles)
    .innerJoin(users, eq(users.id, userProfiles.userId))
    .where(and(ne(userProfiles.userId, excetoUserId), eq(users.isActive, true)))
    .orderBy(asc(userProfiles.userId))
    .limit(TETO_DE_MEMBROS);
  const comDeclaracao = perfis
    .map(perfil => ({
      userId: Number(perfil.userId),
      // Acima do teto, ficam os itens mais NOVOS: a reunião (N5) acrescenta no fim de "O que tenho" e das
      // demandas, e o corte pelos primeiros tirava justamente o que a dona acabou de confirmar (revisão da N5).
      tenho: textos(perfil.whatIHave).slice(-TETO_DE_ITENS_POR_LADO).map(label => ({ label, category: null })),
      preciso: textos(necessidadesEscritasDoPerfil(perfil)).slice(-TETO_DE_ITENS_POR_LADO).map(label => ({ label, category: null })),
    }))
    .filter(membro => membro.tenho.length || membro.preciso.length);
  if (!comDeclaracao.length) return [];
  const { usersComConsentimento } = await import("./routers/consent");
  const autorizadas = await usersComConsentimento(comDeclaracao.map(m => m.userId), "termo_smart_match");
  return comDeclaracao.filter(membro => autorizadas.has(membro.userId));
}

const razao = (item: ItemDeNegocio): MatchReason => ({ slug: slugifyMatchTag(item.label), label: item.label, category: item.category });

/**
 * Tudo o que liga dois lados, nos dois sentidos, pelas regras de scoreMatch.
 * Função pura: é o coração do cruzamento e o que os testes exercitam.
 *
 * A nota sai do texto inteiro, mas o rótulo que vai para a resposta, para os
 * itens e para o motivo registrados sai com os contatos mascarados: a descrição
 * das demandas e "Outra necessidade" são texto livre (até 1000 e 500
 * caracteres), e telefone ou e-mail escrito ali chegaria à outra dona ou à dona
 * do contato sem interesse mútuo nem distribuidora (A13; a mesma máscara que
 * `distribuicao.ts` aplica ao `seekingOtherNeed`).
 */
export function encontrosEntre(
  a: { tenho: ItemDeNegocio[]; preciso: ItemDeNegocio[] },
  b: { tenho: ItemDeNegocio[]; preciso: ItemDeNegocio[] },
): { pontuacao: number; mutuo: boolean; encontros: Array<{ de: "a" | "b"; tem: string; precisa: string; nota: number }> } {
  const encontros: Array<{ de: "a" | "b"; tem: string; precisa: string; nota: number }> = [];
  const cruzar = (de: "a" | "b", quemTem: ItemDeNegocio[], quemPrecisa: ItemDeNegocio[]) => {
    for (const tem of quemTem) {
      for (const precisa of quemPrecisa) {
        const { score } = scoreMatch(razao(tem), razao(precisa));
        if (score >= LIMIAR_DA_CONEXAO) {
          encontros.push({ de, tem: mascararContatosEmTexto(tem.label), precisa: mascararContatosEmTexto(precisa.label), nota: score });
        }
      }
    }
  };
  cruzar("a", a.tenho, b.preciso);
  cruzar("b", b.tenho, a.preciso);
  const pontuacao = encontros.reduce((maior, e) => Math.max(maior, e.nota), 0);
  const mutuo = encontros.some(e => e.de === "a") && encontros.some(e => e.de === "b");
  return { pontuacao, mutuo, encontros };
}

function motivoEItens(
  codigoA: string, rotuloB: string, codigoB: string | null,
  resultado: ReturnType<typeof encontrosEntre>,
): { motivo: string; itens: ItemDaConexao[] } {
  const itens = resultado.encontros.slice(0, 20).map(e => ({
    tem: e.tem, precisa: e.precisa,
    deCodigo: e.de === "a" ? codigoA : codigoB,
    paraCodigo: e.de === "a" ? codigoB : codigoA,
  }));
  const primeiro = resultado.encontros[0];
  const motivo = resultado.mutuo
    ? `${codigoA} e ${rotuloB} se completam: cada um tem o que o outro procura.`
    : primeiro.de === "a"
      ? `${codigoA} tem ${primeiro.tem}, que ${rotuloB} procura.`
      : `${rotuloB} tem ${primeiro.tem}, que ${codigoA} procura.`;
  return { motivo, itens };
}

export type ConexaoGlobalEncontrada = {
  conexaoId: string;
  origem: "NETWORK_NETWORK_MATCH" | "NETWORK_PLATFORM_MATCH";
  meuCodigo: string;
  outroLado: { tipo: "contato" | "membro"; codigoAnonimo: string | null };
  pontuacao: number;
  encontros: Array<{ de: "meu" | "outro"; tem: string; precisa: string }>;
};

/**
 * Cruza os contatos que ESTA dona disponibilizou (todos, ou um só) com a rede
 * global e registra cada conexão relevante. Devolve só o que a dona pode ver:
 * o ID anônimo do contato dela, o tipo e o ID anônimo do outro lado (membra
 * não tem ID anônimo e não é identificada) e os itens que se encontraram.
 *
 * Com mais de CONTATOS_DA_BUSCA_NA_HORA contatos disponíveis (a conta da
 * entidade), a busca vai para a fila e responde `emFila`: os lotes rodam no
 * servidor (server/fila-de-cruzamento.ts), sem segurar o pedido.
 */
export async function procurarConexoesNaRedeGlobal(
  quem: { id: number; openId: string },
  opcoes: { contactId?: number } = {},
): Promise<{ contatosDisponiveis: number; conexoes: ConexaoGlobalEncontrada[]; completa: boolean; emFila?: boolean }> {
  // A vaga é reservada antes de qualquer await: uma rajada (ou um lote do httpBatchLink) não passa inteira.
  tetoDeBuscaNaRedeGlobal.reservar(quem.openId);
  const db = await exigirDb();
  await garantirCodigosAnonimos(quem.openId);
  if (opcoes.contactId === undefined) {
    const [contagem] = await db.select({ total: count() }).from(privateContacts).where(and(
      eq(privateContacts.ownerId, quem.openId), eq(privateContacts.disponivelRedeGlobal, true), isNotNull(privateContacts.codigoAnonimo),
    ));
    const disponiveis = Number(contagem?.total) || 0;
    if (disponiveis > CONTATOS_DA_BUSCA_NA_HORA) {
      const { enfileirarCruzamento } = await import("./fila-de-cruzamento");
      await enfileirarCruzamento({ ownerId: quem.openId, userId: quem.id, tipo: "global" });
      return { contatosDisponiveis: disponiveis, conexoes: [], completa: false, emFila: true };
    }
  }
  const meus = await lerRedeGlobalAnonima({ somenteDona: quem.openId, contactId: opcoes.contactId });
  if (!meus.length) return { contatosDisponiveis: 0, conexoes: [], completa: true };
  const membros = await lerMembrosParaCruzamento(quem.id);
  const { conexoes, completa } = await cruzarERegistrar(db, quem.openId, meus, membros);
  return { contatosDisponiveis: meus.length, conexoes, completa };
}

/**
 * Um lote da busca grande (a fila): os próximos CONTATOS_POR_LOTE contatos
 * disponíveis da dona depois de `aPartirDoId`, em ordem de id, cruzados com a
 * rede pelo índice. `proximoId` null quer dizer que a base acabou.
 */
export async function cruzarUmLoteNaRedeGlobal(
  quem: { id: number; openId: string },
  aPartirDoId: number,
  membros?: MembroDaRede[],
): Promise<{ proximoId: number | null; processados: number; conexoes: number; completa: boolean }> {
  const db = await exigirDb();
  const { contatos, ultimoId } = await lerPaginaCrua({ somenteDona: quem.openId, aPartirDoId }, CONTATOS_POR_LOTE);
  if (!contatos.length) return { proximoId: ultimoId, processados: 0, conexoes: 0, completa: true };
  const r = await cruzarERegistrar(db, quem.openId, contatos, membros ?? await lerMembrosParaCruzamento(quem.id));
  return { proximoId: ultimoId, processados: contatos.length, conexoes: r.conexoes.length, completa: r.completa };
}

/**
 * O coração da busca: pergunta ao índice quem pode casar com `meus`, lê esses
 * candidatos pela leitura autorizada e compara só os pares com chave em comum
 * (`podemCasar`); quem decide cada par é `encontrosEntre` (scoreMatch). Depois
 * registra, com os tetos por rodada e por contraparte.
 */
async function cruzarERegistrar(
  db: Awaited<ReturnType<typeof exigirDb>>,
  donaQueProcura: string,
  meus: ContatoDaRede[],
  membros: MembroDaRede[],
): Promise<{ conexoes: ConexaoGlobalEncontrada[]; completa: boolean }> {
  const chavesDosMeus = meus.map(chavesDoContato);
  const todas = { tem: new Set<string>(), precisa: new Set<string>() };
  for (const chaves of chavesDosMeus) {
    for (const chave of Array.from(chaves.tem)) todas.tem.add(chave);
    for (const chave of Array.from(chaves.precisa)) todas.precisa.add(chave);
  }
  const candidatos = await candidatosPelasChaves(db, todas);
  const outros: ContatoDaRede[] = [];
  for await (const pagina of lerRedeGlobalPaginada({ excetoDona: donaQueProcura, ids: candidatos })) outros.push(...pagina);
  const chavesDosOutros = outros.map(chavesDoContato);
  const chavesDosMembros = membros.map(chavesDoContato);

  // 1) Cruzar, dentro do orçamento, devolvendo a vez ao event loop a cada fatia.
  type Candidata =
    | { origem: "NETWORK_NETWORK_MATCH"; meu: ContatoDaRede; outro: ContatoDaRede; contraparte: string; resultado: ReturnType<typeof encontrosEntre> }
    | { origem: "NETWORK_PLATFORM_MATCH"; meu: ContatoDaRede; membro: MembroDaRede; contraparte: string; resultado: ReturnType<typeof encontrosEntre> };
  const candidatas: Candidata[] = [];
  const custoDoPar = (a: { tenho: unknown[]; preciso: unknown[] }, b: { tenho: unknown[]; preciso: unknown[] }) =>
    a.tenho.length * b.preciso.length + b.tenho.length * a.preciso.length;
  let gasto = 0;
  let desdeAPausa = 0;
  let completa = true;
  const cabeNoOrcamento = async (custo: number) => {
    if (gasto + custo > ORCAMENTO_DE_COMPARACOES) { completa = false; return false; }
    gasto += custo;
    desdeAPausa += custo;
    if (desdeAPausa >= COMPARACOES_POR_FATIA) {
      desdeAPausa = 0;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    return true;
  };

  cruzamento: for (let i = 0; i < meus.length; i += 1) {
    const meu = meus[i];
    for (let j = 0; j < outros.length; j += 1) {
      const outro = outros[j];
      if (!podemCasar(chavesDosMeus[i], chavesDosOutros[j])) continue;
      const custo = custoDoPar(meu, outro);
      if (!custo) continue;
      if (!(await cabeNoOrcamento(custo))) break cruzamento;
      const resultado = encontrosEntre(meu, outro);
      if (resultado.pontuacao >= LIMIAR_DA_CONEXAO) candidatas.push({ origem: "NETWORK_NETWORK_MATCH", meu, outro, contraparte: `dona:${outro.ownerId}`, resultado });
    }
    for (let k = 0; k < membros.length; k += 1) {
      const membro = membros[k];
      if (!podemCasar(chavesDosMeus[i], chavesDosMembros[k])) continue;
      const custo = custoDoPar(meu, membro);
      if (!custo) continue;
      if (!(await cabeNoOrcamento(custo))) break cruzamento;
      const resultado = encontrosEntre(meu, membro);
      if (resultado.pontuacao >= LIMIAR_DA_CONEXAO) candidatas.push({ origem: "NETWORK_PLATFORM_MATCH", meu, membro, contraparte: `membra:${membro.userId}`, resultado });
    }
  }

  // 2) Registrar as de nota maior primeiro, com teto por rodada e por contraparte.
  candidatas.sort((x, y) => y.resultado.pontuacao - x.resultado.pontuacao);
  const conexoes: ConexaoGlobalEncontrada[] = [];
  const porContraparte = new Map<string, number>();
  const paraMim = (e: ReturnType<typeof encontrosEntre>["encontros"][number]) => ({ de: e.de === "a" ? "meu" as const : "outro" as const, tem: e.tem, precisa: e.precisa });

  for (const candidata of candidatas) {
    if (conexoes.length >= TETO_DE_REGISTROS_POR_RODADA) { completa = false; break; }
    const jaRegistradas = porContraparte.get(candidata.contraparte) ?? 0;
    if (jaRegistradas >= TETO_POR_CONTRAPARTE_POR_RODADA) { completa = false; continue; }
    porContraparte.set(candidata.contraparte, jaRegistradas + 1);
    const { meu, resultado } = candidata;
    const ladoA = { tipo: "contato" as const, ownerId: meu.ownerId, contactId: meu.contactId, codigoAnonimo: meu.codigoAnonimo, originador: true };
    if (candidata.origem === "NETWORK_NETWORK_MATCH") {
      const { outro } = candidata;
      const { motivo, itens } = motivoEItens(meu.codigoAnonimo, outro.codigoAnonimo, outro.codigoAnonimo, resultado);
      const conexaoId = await registrarConexao(db, {
        origem: "NETWORK_NETWORK_MATCH",
        a: ladoA,
        b: { tipo: "contato", ownerId: outro.ownerId, contactId: outro.contactId, codigoAnonimo: outro.codigoAnonimo, originador: true },
        motivo, itens, pontuacao: resultado.pontuacao,
      });
      conexoes.push({
        conexaoId, origem: "NETWORK_NETWORK_MATCH", meuCodigo: meu.codigoAnonimo,
        outroLado: { tipo: "contato", codigoAnonimo: outro.codigoAnonimo },
        pontuacao: resultado.pontuacao, encontros: resultado.encontros.map(paraMim),
      });
    } else {
      const { motivo, itens } = motivoEItens(meu.codigoAnonimo, "uma membra da plataforma", null, resultado);
      const conexaoId = await registrarConexao(db, {
        origem: "NETWORK_PLATFORM_MATCH",
        a: ladoA,
        b: { tipo: "membro", userId: candidata.membro.userId },
        motivo, itens, pontuacao: resultado.pontuacao,
      });
      conexoes.push({
        conexaoId, origem: "NETWORK_PLATFORM_MATCH", meuCodigo: meu.codigoAnonimo,
        outroLado: { tipo: "membro", codigoAnonimo: null },
        pontuacao: resultado.pontuacao, encontros: resultado.encontros.map(paraMim),
      });
    }
  }
  return { conexoes, completa };
}
