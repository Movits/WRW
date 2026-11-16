import { ORDEM_DAS_SECOES, SECOES_DE_UM_ITEM, type ItemDoResumo, type SecaoDoResumo } from "./resumo-da-reuniao";
import { normalizarParaComparar } from "./trecho-da-transcricao";

/**
 * O resumo refeito com outro modelo (H4d, "Refazer como…"): os itens que a
 * dona confirmou e as ações que marcou como feitas ficam; os pendentes e os
 * ignorados saem, e entram os itens novos da IA. Esta função só decide a
 * ordem e o que entra; quem lê e grava é a fila do resumo
 * (server/fila-do-resumo.ts), numa transação.
 */

export type ItemQueFica = { id: string; section: SecaoDoResumo; position: number; text: string };

const chave = (secao: SecaoDoResumo, texto: string) => `${secao}\u0000${normalizarParaComparar(texto)}`;

/**
 * A numeração nova do resumo, na ordem das seções do formato: em cada seção,
 * primeiro os itens que ficam (na ordem em que já estavam), depois os novos
 * (na ordem da IA). Um item novo que repete um que fica (mesma seção e o mesmo
 * texto, sem contar maiúsculas, pontuação e espaços) não entra: a dona já o
 * confirmou. Na seção de um item só (o foco), o que fica ocupa o lugar: o foco
 * novo, escrito com outras palavras, também não entra.
 */
export function numeracaoDoResumoRefeito(
  queFicam: readonly ItemQueFica[],
  novos: readonly ItemDoResumo[],
): { queFicam: Array<{ id: string; position: number }>; novos: Array<ItemDoResumo & { position: number }> } {
  const jaNoResumo = new Set(queFicam.map(item => chave(item.section, item.text)));
  const secoesOcupadas = new Set(queFicam.map(item => item.section).filter(secao => SECOES_DE_UM_ITEM.has(secao)));
  const entram = novos.filter(item => !jaNoResumo.has(chave(item.section, item.text)) && !secoesOcupadas.has(item.section));
  const numerados = { queFicam: [] as Array<{ id: string; position: number }>, novos: [] as Array<ItemDoResumo & { position: number }> };
  let position = 0;
  for (const secao of ORDEM_DAS_SECOES) {
    const ficamNaSecao = queFicam.filter(item => item.section === secao).sort((a, b) => a.position - b.position);
    for (const item of ficamNaSecao) numerados.queFicam.push({ id: item.id, position: position++ });
    for (const item of entram.filter(novo => novo.section === secao)) numerados.novos.push({ ...item, position: position++ });
  }
  return numerados;
}
