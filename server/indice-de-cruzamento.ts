import crypto from "node:crypto";
import { and, asc, eq, gt, inArray, max, notExists, sql } from "drizzle-orm";
import { chavesDeCruzamento, contactAssets, contactNeeds } from "../drizzle/schema";
import { chavesDoItem, VERSAO_DAS_CHAVES, type LadoDoItem } from "../shared/chaves-de-cruzamento";
import { exigirDb } from "./db";

/**
 * O índice invertido do cruzamento (N4b, docs/arquitetura/entidades.md,
 * seção 8): a tabela `chaves_de_cruzamento` diz, para cada chave
 * (shared/chaves-de-cruzamento.ts), quais itens de "tem" e de "precisa" a têm.
 * O cruzamento global pergunta ao índice quem pode casar com os contatos de
 * quem procura e só compara esses, em vez de ler a rede inteira.
 *
 * A chave não decide nada: `scoreMatch` continua decidindo cada par, com os
 * concorrentes zerados e a regra da demanda expressa. O índice guarda o HASH da
 * chave, não o texto do item. O hash é SHA-256 sem sal, cortado, de termos
 * curtos: quem tem a tabela o reverte por dicionário ("s:cafe-torrado"). Trate
 * a tabela como dado pessoal da dona (ela sai na exclusão da conta e na faxina
 * do exame), nunca como anonimizada.
 *
 * Como ele se mantém. As chaves de um item mudam em dois casos: o rótulo muda
 * (a edição da ficha, T45: `editarItemDaFicha` reindexa o contato na mesma
 * transação do UPDATE, com `indexarContatos`) e o cálculo muda (cada linha
 * guarda a `VERSAO_DAS_CHAVES` de quem a gravou, e a varredura trata versão
 * diferente como item sem chave). A carga das entidades indexa o bloco na hora
 * (`indexarContatos`); o resto (a tela, o enriquecimento, a reunião) é
 * alcançado por `indexarPendentes`, que acha os itens sem chave da versão de
 * agora, e a chave de item apagado sai em `limparOrfas`. Os dois rodam no laço
 * da fila (server/fila-de-cruzamento.ts): a cada volta, os itens novos (id acima
 * da última marca, com folga); de 10 em 10 minutos, uma passada pela tabela
 * inteira, em ordem de id e em lotes (o cursor anda de volta em volta até o
 * fim), e as órfãs. A chave órfã só traz candidato a mais (o item é lido de novo
 * das tabelas de verdade); o item ainda sem chave só fica de fora até a
 * varredura chegar nele.
 */

type Banco = Awaited<ReturnType<typeof exigirDb>>;
type Executor = Pick<Banco, "select" | "insert" | "delete">;

/** O hash guardado: 16 hex do SHA-256 da chave. */
export function hashDaChave(chave: string): string {
  return crypto.createHash("sha256").update(chave).digest("hex").slice(0, 16);
}

/** Itens lidos de uma vez pela varredura e pela indexação. */
export const ITENS_POR_VARREDURA = 5000;
/** Linhas por INSERT no índice. */
const LINHAS_POR_INSERT = 2000;
/** Chaves por consulta ao índice (o IN do MySQL tem teto de parâmetros). */
const CHAVES_POR_CONSULTA = 1000;

type ItemLido = { id: number; ownerId: string; contactId: number; tagSlug: string; tagLabel: string; category: string | null };

function linhasDoIndice(lado: LadoDoItem, itens: ItemLido[]) {
  return itens.flatMap(item => {
    const chaves = new Set(chavesDoItem({ label: item.tagLabel, category: item.category, slug: item.tagSlug }, lado).map(hashDaChave));
    // O item sem chave nenhuma (rótulo sem letra) ganha a marca, para a varredura não o ler de novo a cada volta.
    if (!chaves.size) chaves.add(hashDaChave("-"));
    return Array.from(chaves).map(chave => ({ lado, itemId: Number(item.id), contactId: Number(item.contactId), ownerId: item.ownerId, chave, versao: VERSAO_DAS_CHAVES }));
  });
}

async function gravarLinhas(ex: Executor, linhas: ReturnType<typeof linhasDoIndice>) {
  for (let i = 0; i < linhas.length; i += LINHAS_POR_INSERT) {
    // A mesma chave do mesmo item duas vezes (duas varreduras ao mesmo tempo) não é erro: o índice único a recusa.
    await ex.insert(chavesDeCruzamento).values(linhas.slice(i, i + LINHAS_POR_INSERT))
      .onDuplicateKeyUpdate({ set: { versao: sql`values(${chavesDeCruzamento.versao})` } });
  }
}

const colunasDoItem = (tabela: typeof contactAssets | typeof contactNeeds) => ({
  id: tabela.id, ownerId: tabela.ownerId, contactId: tabela.contactId, tagSlug: tabela.tagSlug, tagLabel: tabela.tagLabel, category: tabela.category,
});

export type MarcaDosItens = { tem: number; precisa: number };

/**
 * Indexa os itens sem chave DA VERSÃO DE AGORA (os dois lados), em ordem de id,
 * até `limite` por lado e depois de `desde`. O item com chaves de outra versão
 * perde as antigas e ganha as novas. Devolve quantos indexou e, por lado, o
 * último id lido quando o lote veio cheio (`null` quando o lado chegou ao fim):
 * é o cursor da passada pela tabela inteira.
 */
export async function indexarPendentesDesde(banco: Banco, limite: number, desde: MarcaDosItens): Promise<{ total: number; proximo: { tem: number | null; precisa: number | null } }> {
  let total = 0;
  const proximo: { tem: number | null; precisa: number | null } = { tem: null, precisa: null };
  for (const [lado, tabela] of [["tem", contactAssets], ["precisa", contactNeeds]] as const) {
    const semChave = notExists(banco.select({ um: chavesDeCruzamento.id }).from(chavesDeCruzamento)
      .where(and(eq(chavesDeCruzamento.lado, lado), eq(chavesDeCruzamento.itemId, tabela.id), eq(chavesDeCruzamento.versao, VERSAO_DAS_CHAVES))));
    const itens = await banco.select(colunasDoItem(tabela)).from(tabela)
      .where(and(gt(tabela.id, desde[lado]), semChave))
      .orderBy(asc(tabela.id))
      .limit(limite);
    if (itens.length >= limite) proximo[lado] = Number(itens[itens.length - 1].id);
    if (!itens.length) continue;
    // As chaves de outra versão saem antes: o índice único (lado, item, chave) vale para as duas.
    const idsDosItens = itens.map(item => Number(item.id));
    for (let i = 0; i < idsDosItens.length; i += CHAVES_POR_CONSULTA) {
      await banco.delete(chavesDeCruzamento).where(and(eq(chavesDeCruzamento.lado, lado), inArray(chavesDeCruzamento.itemId, idsDosItens.slice(i, i + CHAVES_POR_CONSULTA))));
    }
    await gravarLinhas(banco, linhasDoIndice(lado, itens as ItemLido[]));
    total += itens.length;
  }
  return { total, proximo };
}

/**
 * Indexa os itens ainda sem chave da versão de agora (os dois lados), até
 * `limite` por lado. Com `desde`, só os de id maior (a varredura curta do laço).
 * Devolve quantos itens indexou; zero quer dizer que o índice está em dia.
 */
export async function indexarPendentes(db?: Banco, limite = ITENS_POR_VARREDURA, desde?: MarcaDosItens): Promise<number> {
  const banco = db ?? await exigirDb();
  return (await indexarPendentesDesde(banco, limite, desde ?? { tem: 0, precisa: 0 })).total;
}

/** O maior id de item de cada lado: a marca de onde a varredura curta recomeça. */
export async function maioresIdsDosItens(db?: Banco): Promise<MarcaDosItens> {
  const banco = db ?? await exigirDb();
  const [[tem], [precisa]] = await Promise.all([
    banco.select({ maior: max(contactAssets.id) }).from(contactAssets),
    banco.select({ maior: max(contactNeeds.id) }).from(contactNeeds),
  ]);
  return { tem: Number(tem?.maior) || 0, precisa: Number(precisa?.maior) || 0 };
}

/** Tira as chaves de itens que não existem mais, até `limite` linhas por lado. */
export async function limparOrfas(db?: Banco, limite = ITENS_POR_VARREDURA): Promise<number> {
  const banco = db ?? await exigirDb();
  let total = 0;
  for (const [lado, tabela] of [["tem", contactAssets], ["precisa", contactNeeds]] as const) {
    const orfas = await banco.select({ id: chavesDeCruzamento.id }).from(chavesDeCruzamento)
      .where(and(eq(chavesDeCruzamento.lado, lado), notExists(banco.select({ um: tabela.id }).from(tabela).where(eq(tabela.id, chavesDeCruzamento.itemId)))))
      .limit(limite);
    if (!orfas.length) continue;
    await banco.delete(chavesDeCruzamento).where(inArray(chavesDeCruzamento.id, orfas.map(o => Number(o.id))));
    total += orfas.length;
  }
  return total;
}

/**
 * Refaz o índice dos contatos dados, da dona: apaga as chaves deles e grava as dos
 * itens de agora. A carga das entidades chama dentro da transação do bloco (o
 * associado cruza na hora), e a edição de item da ficha, na transação do UPDATE
 * (as chaves do rótulo antigo não ficam no índice).
 */
export async function indexarContatos(ex: Executor, ownerId: string, contactIds: number[]): Promise<void> {
  if (!contactIds.length) return;
  for (let i = 0; i < contactIds.length; i += CHAVES_POR_CONSULTA) {
    const ids = contactIds.slice(i, i + CHAVES_POR_CONSULTA);
    await ex.delete(chavesDeCruzamento).where(and(eq(chavesDeCruzamento.ownerId, ownerId), inArray(chavesDeCruzamento.contactId, ids)));
    const [tem, precisa] = await Promise.all([
      // A dona no WHERE: o índice das duas tabelas é (dona, contato).
      ex.select(colunasDoItem(contactAssets)).from(contactAssets).where(and(eq(contactAssets.ownerId, ownerId), inArray(contactAssets.contactId, ids))),
      ex.select(colunasDoItem(contactNeeds)).from(contactNeeds).where(and(eq(contactNeeds.ownerId, ownerId), inArray(contactNeeds.contactId, ids))),
    ]);
    await gravarLinhas(ex, [...linhasDoIndice("tem", tem as ItemLido[]), ...linhasDoIndice("precisa", precisa as ItemLido[])]);
  }
}

/**
 * Os contatos que PODEM casar com quem procura: os que têm, no lado oposto,
 * alguma das chaves dela ("tem" dela × "precisa" deles e vice-versa). Só ids,
 * em ordem; quem chama lê cada um pela leitura autorizada da rede global (SIM,
 * termo, convênio), que é onde a regra de consulta mora.
 */
export async function candidatosPelasChaves(
  db: Banco,
  chaves: { tem: Iterable<string>; precisa: Iterable<string> },
): Promise<number[]> {
  const ids = new Set<number>();
  const procurar = async (lado: LadoDoItem, deQuemProcura: Iterable<string>) => {
    const hashes = Array.from(new Set(Array.from(deQuemProcura).map(hashDaChave)));
    for (let i = 0; i < hashes.length; i += CHAVES_POR_CONSULTA) {
      const linhas = await db.selectDistinct({ contactId: chavesDeCruzamento.contactId }).from(chavesDeCruzamento)
        .where(and(eq(chavesDeCruzamento.lado, lado), inArray(chavesDeCruzamento.chave, hashes.slice(i, i + CHAVES_POR_CONSULTA))));
      for (const linha of linhas) ids.add(Number(linha.contactId));
    }
  };
  await procurar("precisa", chaves.tem);
  await procurar("tem", chaves.precisa);
  return Array.from(ids).sort((a, b) => a - b);
}
