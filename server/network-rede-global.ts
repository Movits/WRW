import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { contactAssets, contactNeeds, privateContacts, userProfiles, users } from "../drizzle/schema";
import { criarTeto } from "./assistente-de-texto";
import { exigirDb } from "./db";
import { scoreMatch, slugifyMatchTag, type MatchReason } from "./match-service";
import { garantirCodigosAnonimos } from "./network-codigo-anonimo";
import { registrarConexao, type ItemDaConexao } from "./network-registro";
import { necessidadesEscritasDoPerfil } from "./portao-da-demanda-expressa";
import { mascararContatosEmTexto } from "../shared/contato-em-texto";

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
/** Teto de leitura: o cruzamento é uma consulta, não uma exportação da rede. */
const TETO_DE_CONTATOS = 1000;
const TETO_DE_MEMBROS = 1000;
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

/** SIM/NÃO por contato. Só a dona muda, e o efeito vale na leitura seguinte. */
export async function definirDisponibilidade(ownerId: string, contactId: number, disponivel: boolean) {
  const db = await exigirDb();
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

async function itensDosContatos(db: Awaited<ReturnType<typeof exigirDb>>, ids: number[]) {
  if (!ids.length) return { tenho: new Map<number, ItemDeNegocio[]>(), preciso: new Map<number, ItemDeNegocio[]>() };
  const [possui, procura] = await Promise.all([
    db.select({ contactId: contactAssets.contactId, label: contactAssets.tagLabel, category: contactAssets.category })
      .from(contactAssets).where(inArray(contactAssets.contactId, ids)),
    db.select({ contactId: contactNeeds.contactId, label: contactNeeds.tagLabel, category: contactNeeds.category })
      .from(contactNeeds).where(inArray(contactNeeds.contactId, ids)),
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
 * disponibilizou, lado de cá do cruzamento).
 */
export async function lerRedeGlobalAnonima(opcoes: { excetoDona?: string; somenteDona?: string; contactId?: number } = {}): Promise<ContatoDaRede[]> {
  const db = await exigirDb();
  const condicoes = [eq(privateContacts.disponivelRedeGlobal, true), isNotNull(privateContacts.codigoAnonimo)];
  if (opcoes.excetoDona) condicoes.push(ne(privateContacts.ownerId, opcoes.excetoDona));
  if (opcoes.somenteDona) condicoes.push(eq(privateContacts.ownerId, opcoes.somenteDona));
  if (opcoes.contactId !== undefined) condicoes.push(eq(privateContacts.id, opcoes.contactId));
  const linhas = await db
    .select({ id: privateContacts.id, ownerId: privateContacts.ownerId, codigoAnonimo: privateContacts.codigoAnonimo })
    .from(privateContacts)
    .where(and(...condicoes))
    .limit(TETO_DE_CONTATOS);
  if (!linhas.length) return [];

  // A dona autoriza o cruzamento pelo termo do Smart Match, conferido agora; conta desativada não entra.
  const donas = await db.select({ id: users.id, openId: users.openId }).from(users)
    .where(and(inArray(users.openId, Array.from(new Set(linhas.map(l => l.ownerId)))), eq(users.isActive, true)));
  const { usersComConsentimento } = await import("./routers/consent");
  const autorizadas = await usersComConsentimento(donas.map(d => d.id), "termo_smart_match");
  const donaAutorizada = new Set(donas.filter(d => autorizadas.has(d.id)).map(d => d.openId));
  const validas = linhas.filter(l => donaAutorizada.has(l.ownerId));

  const { tenho, preciso } = await itensDosContatos(db, validas.map(l => Number(l.id)));
  return validas.map(linha => ({
    contactId: Number(linha.id),
    ownerId: linha.ownerId,
    codigoAnonimo: linha.codigoAnonimo as string,
    tenho: tenho.get(Number(linha.id)) ?? [],
    preciso: preciso.get(Number(linha.id)) ?? [],
  }));
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
    .limit(TETO_DE_MEMBROS);
  const comDeclaracao = perfis
    .map(perfil => ({
      userId: Number(perfil.userId),
      tenho: textos(perfil.whatIHave).slice(0, TETO_DE_ITENS_POR_LADO).map(label => ({ label, category: null })),
      preciso: textos(necessidadesEscritasDoPerfil(perfil)).slice(0, TETO_DE_ITENS_POR_LADO).map(label => ({ label, category: null })),
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
 */
export async function procurarConexoesNaRedeGlobal(
  quem: { id: number; openId: string },
  opcoes: { contactId?: number } = {},
): Promise<{ contatosDisponiveis: number; conexoes: ConexaoGlobalEncontrada[]; completa: boolean }> {
  // A vaga é reservada antes de qualquer await: uma rajada (ou um lote do httpBatchLink) não passa inteira.
  tetoDeBuscaNaRedeGlobal.reservar(quem.openId);
  const db = await exigirDb();
  await garantirCodigosAnonimos(quem.openId);
  const meus = await lerRedeGlobalAnonima({ somenteDona: quem.openId, contactId: opcoes.contactId });
  if (!meus.length) return { contatosDisponiveis: 0, conexoes: [], completa: true };
  const [outros, membros] = await Promise.all([
    lerRedeGlobalAnonima({ excetoDona: quem.openId }),
    lerMembrosParaCruzamento(quem.id),
  ]);

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

  cruzamento: for (const meu of meus) {
    for (const outro of outros) {
      const custo = custoDoPar(meu, outro);
      if (!custo) continue;
      if (!(await cabeNoOrcamento(custo))) break cruzamento;
      const resultado = encontrosEntre(meu, outro);
      if (resultado.pontuacao >= LIMIAR_DA_CONEXAO) candidatas.push({ origem: "NETWORK_NETWORK_MATCH", meu, outro, contraparte: `dona:${outro.ownerId}`, resultado });
    }
    for (const membro of membros) {
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
  return { contatosDisponiveis: meus.length, conexoes, completa };
}
