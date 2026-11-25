import {
  chaveDoRotulo,
  conferirMapaMental,
  FILHOS_POR_FOLHA_MAX,
  FOLHAS_POR_RAMO_MAX,
  NOS_DO_MAPA_MAX,
  RAMOS_DO_MAPA_MAX,
  RAMOS_DO_MAPA_MIN,
  ROTULO_DO_MAPA_MAX,
  rotuloDoMapa,
  type FolhaDoMapa,
  type MapaMental,
  type RamoDoMapa,
} from "./mapa-mental";

/**
 * O mapa mental editável (H10b da auditoria de 16/11; HN-40 do app de
 * referência da cliente): a dona renomeia, arrasta, acrescenta e apaga ramos,
 * folhas e filhos, volta ao mapa da IA, pede à IA que o refaça em outro estilo
 * e o baixa em PDF, JPEG ou Markdown.
 *
 * Aqui ficam as regras que a tela e o servidor aplicam do mesmo jeito (puro:
 * sem banco, rede nem ambiente, shared/CLAUDE.md):
 * - a conferência do mapa editado: as MESMAS regras do mapa da IA
 *   (shared/mapa-mental.ts), mas sem podar em silêncio. O que a IA manda
 *   torto é aparado; o que a dona escreve torto é recusado com o código, para
 *   a tela dizer o que mudar em vez de gravar outra coisa;
 * - as operações da edição (renomear, apagar, acrescentar, mover), sobre uma
 *   cópia, para a tela desfazer com "Cancelar";
 * - os estilos que o "Refazer em outro estilo" aceita;
 * - o Markdown do mapa;
 * - os tetos, os códigos das recusas e as ações da auditoria.
 */

/**
 * Os estilos do app de referência: visão geral (a árvore da H10), hierárquico
 * (do geral ao específico, de cima para baixo), linha do tempo (os momentos da
 * reunião em ordem) e conceito (as ideias centrais e como se ligam).
 */
export const ESTILOS_DO_MAPA = ["overview", "hierarchical", "timeline", "concept"] as const;
export type EstiloDoMapa = (typeof ESTILOS_DO_MAPA)[number];
export const ESTILO_DO_MAPA_PADRAO: EstiloDoMapa = "overview";

/** O estilo guardado, ou a visão geral para o nulo e o desconhecido. */
export function estiloDoMapa(valor: unknown): EstiloDoMapa {
  return (ESTILOS_DO_MAPA as readonly unknown[]).includes(valor) ? valor as EstiloDoMapa : ESTILO_DO_MAPA_PADRAO;
}

/**
 * O teto de edições por dona: cada uma regrava o mapa inteiro e uma linha de
 * auditoria. Como o da transcrição (H18): 200 a cada 10 minutos cabem com
 * folga numa revisão feita à mão.
 */
export const EDICOES_DO_MAPA_POR_JANELA = 200;
export const JANELA_DA_EDICAO_DO_MAPA_MS = 10 * 60_000;

/**
 * O teto de custo do "Refazer em outro estilo": cada um manda a transcrição
 * inteira à IA (cerca de US$ 0,03 por hora de reunião no modelo de texto de
 * hoje). 6 por dona a cada hora, além do teto comum de pedidos à IA da
 * reunião (server/routers/meetings.ts), que ele também gasta.
 */
export const REFAZERES_DO_MAPA_POR_JANELA = 6;
export const JANELA_DO_REFAZER_DO_MAPA_MS = 60 * 60_000;

/** As ações gravadas em audit_logs, na mesma transação da mudança. */
export const ACAO_MAPA_EDITADO = "MEETING_MIND_MAP_EDITED";
export const ACAO_MAPA_REFEITO = "MEETING_MIND_MAP_REDO_REQUESTED";

/**
 * As recusas, como CÓDIGO (a tela traduz, client/src/lib/mensagem-de-erro.ts):
 * - MUDOU: o mapa mudou desde que a tela o leu (outra aba, a fila gravou um
 *   mapa novo);
 * - SEM_MAPA: a reunião não tem mapa pronto para editar ou refazer;
 * - REFAZENDO: a IA está refazendo o mapa; a edição espera;
 * - POUCOS_RAMOS, GRANDE: fora das quantidades da H10 (de 2 a 12 ramos, até 8
 *   folhas por ramo, até 4 filhos por folha, até 150 nós);
 * - ROTULO: rótulo vazio, acima de 60 caracteres ou com rótulo de voz ({F2});
 * - REPETIDO: dois irmãos com o mesmo rótulo;
 * - FORMA: o pedido não tem a forma de um mapa;
 * - EDICOES_DEMAIS, REFAZERES_DEMAIS: os tetos acima.
 */
export const RECUSAS_DO_MAPA = {
  mudou: "MAPA_MUDOU",
  semMapa: "MAPA_SEM_MAPA_PRONTO",
  refazendo: "MAPA_SENDO_REFEITO",
  poucosRamos: "MAPA_POUCOS_RAMOS",
  grande: "MAPA_GRANDE_DEMAIS",
  rotulo: "MAPA_ROTULO_INVALIDO",
  repetido: "MAPA_ROTULO_REPETIDO",
  forma: "MAPA_FORMA_INVALIDA",
  edicoesDemais: "MAPA_EDICOES_DEMAIS",
  refazeresDemais: "MAPA_REFAZERES_DEMAIS",
} as const;
export type CodigoDaRecusaDoMapa = (typeof RECUSAS_DO_MAPA)[keyof typeof RECUSAS_DO_MAPA];

export type ConferenciaDoMapaEditado = { ok: true; mapa: MapaMental } | { ok: false; codigo: CodigoDaRecusaDoMapa };

/** O rótulo como a dona o escreveu, aparado e com os espaços juntados; null se não passa. */
function rotuloEditado(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const aparado = valor.replace(/\s+/g, " ").trim();
  if (Array.from(aparado).length > ROTULO_DO_MAPA_MAX) return null;
  // rotuloDoMapa recusa o vazio e o rótulo de voz; dentro dos 60, devolve o mesmo texto.
  return rotuloDoMapa(aparado) === aparado ? aparado : null;
}

class Recusa extends Error {
  constructor(readonly codigo: CodigoDaRecusaDoMapa) { super(codigo); }
}

function semRepetidos(rotulos: string[]) {
  const chaves = new Set<string>();
  for (const rotulo of rotulos) {
    const chave = chaveDoRotulo(rotulo) || rotulo;
    if (chaves.has(chave)) throw new Recusa(RECUSAS_DO_MAPA.repetido);
    chaves.add(chave);
  }
}

function listaOuRecusa(valor: unknown): unknown[] {
  if (!Array.isArray(valor)) throw new Recusa(RECUSAS_DO_MAPA.forma);
  return valor;
}

function rotuloOuRecusa(valor: unknown): string {
  const rotulo = rotuloEditado(valor);
  if (rotulo === null) throw new Recusa(RECUSAS_DO_MAPA.rotulo);
  return rotulo;
}

function objetoOuRecusa(valor: unknown): Record<string, unknown> {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) throw new Recusa(RECUSAS_DO_MAPA.forma);
  return valor as Record<string, unknown>;
}

/**
 * O mapa que a dona editou, conferido sem podar: passa inteiro, com os
 * rótulos aparados, ou é recusado com o código do primeiro problema. As
 * quantidades e a conferência dos rótulos são as da H10, e o mapa que passa
 * aqui também passa em conferirMapaMental, sem perder nada.
 */
export function conferirMapaEditado(bruto: unknown): ConferenciaDoMapaEditado {
  try {
    const ramosBrutos = listaOuRecusa(objetoOuRecusa(bruto).ramos);
    if (ramosBrutos.length < RAMOS_DO_MAPA_MIN) throw new Recusa(RECUSAS_DO_MAPA.poucosRamos);
    if (ramosBrutos.length > RAMOS_DO_MAPA_MAX) throw new Recusa(RECUSAS_DO_MAPA.grande);
    let nos = 0;
    const ramos: RamoDoMapa[] = ramosBrutos.map(ramoBruto => {
      const ramo = objetoOuRecusa(ramoBruto);
      const folhasBrutas = listaOuRecusa(ramo.folhas);
      if (folhasBrutas.length > FOLHAS_POR_RAMO_MAX) throw new Recusa(RECUSAS_DO_MAPA.grande);
      const folhas: FolhaDoMapa[] = folhasBrutas.map(folhaBruta => {
        const folha = objetoOuRecusa(folhaBruta);
        const filhos = listaOuRecusa(folha.filhos);
        if (filhos.length > FILHOS_POR_FOLHA_MAX) throw new Recusa(RECUSAS_DO_MAPA.grande);
        const rotulosDosFilhos = filhos.map(rotuloOuRecusa);
        semRepetidos(rotulosDosFilhos);
        nos += 1 + rotulosDosFilhos.length;
        return { rotulo: rotuloOuRecusa(folha.rotulo), filhos: rotulosDosFilhos };
      });
      semRepetidos(folhas.map(folha => folha.rotulo));
      nos += 1;
      return { rotulo: rotuloOuRecusa(ramo.rotulo), folhas };
    });
    semRepetidos(ramos.map(ramo => ramo.rotulo));
    if (nos > NOS_DO_MAPA_MAX) throw new Recusa(RECUSAS_DO_MAPA.grande);
    return { ok: true, mapa: { ramos } };
  } catch (erro) {
    if (erro instanceof Recusa) return { ok: false, codigo: erro.codigo };
    throw erro;
  }
}

/**
 * O mapa que vale para quem lê (H10b): o que a dona editou, se existe e ainda
 * passa na conferência; senão, o da IA. O da IA guardado com o estado fora de
 * "pronto" é o de antes de um "Refazer em outro estilo": ele segue à vista
 * enquanto a IA refaz, e se ela falhar. Quem chama decide pelo estado.
 */
export function mapaQueVale(linha: { mindMapEdited: unknown; mindMap: unknown } | undefined): MapaMental | null {
  if (!linha) return null;
  return conferirMapaMental(linha.mindMapEdited) ?? (linha.mindMap == null ? null : conferirMapaMental(linha.mindMap));
}

/** Dois mapas iguais, rótulo a rótulo e na mesma ordem. */
export function mesmoMapa(a: MapaMental, b: MapaMental): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Onde fica um nó: [ramo], [ramo, folha] ou [ramo, folha, filho]. A raiz (o
 * título da reunião) não tem caminho: ela não é do mapa.
 */
export type CaminhoDoNo = readonly [number] | readonly [number, number] | readonly [number, number, number];

function copia(mapa: MapaMental): MapaMental {
  return { ramos: mapa.ramos.map(ramo => ({ rotulo: ramo.rotulo, folhas: ramo.folhas.map(folha => ({ rotulo: folha.rotulo, filhos: [...folha.filhos] })) })) };
}

/** Os irmãos do nó (a lista em que ele está), na cópia. */
function irmaosNaCopia(mapa: MapaMental, caminho: readonly number[]): { lista: unknown[]; indice: number } | null {
  const [r, f, k] = caminho;
  if (caminho.length === 1) return mapa.ramos[r] ? { lista: mapa.ramos, indice: r } : null;
  const ramo = mapa.ramos[r];
  if (!ramo) return null;
  if (caminho.length === 2) return ramo.folhas[f] ? { lista: ramo.folhas, indice: f } : null;
  const folha = ramo.folhas[f];
  if (!folha || folha.filhos[k] === undefined) return null;
  return { lista: folha.filhos, indice: k };
}

/** O rótulo do nó, ou null se o caminho não existe. */
export function rotuloNoCaminho(mapa: MapaMental, caminho: CaminhoDoNo): string | null {
  const [r, f, k] = caminho;
  const ramo = mapa.ramos[r];
  if (!ramo) return null;
  if (caminho.length === 1) return ramo.rotulo;
  const folha = ramo.folhas[f!];
  if (!folha) return null;
  return caminho.length === 2 ? folha.rotulo : folha.filhos[k!] ?? null;
}

/** Troca o rótulo do nó (sem conferir: a conferência é na hora de salvar). */
export function renomearNo(mapa: MapaMental, caminho: CaminhoDoNo, rotulo: string): MapaMental {
  const novo = copia(mapa);
  const [r, f, k] = caminho;
  if (caminho.length === 1 && novo.ramos[r]) novo.ramos[r].rotulo = rotulo;
  else if (caminho.length === 2 && novo.ramos[r]?.folhas[f!]) novo.ramos[r].folhas[f!].rotulo = rotulo;
  else if (caminho.length === 3 && novo.ramos[r]?.folhas[f!]?.filhos[k!] !== undefined) novo.ramos[r].folhas[f!].filhos[k!] = rotulo;
  return novo;
}

/** Apaga o nó e tudo o que sai dele. */
export function apagarNo(mapa: MapaMental, caminho: CaminhoDoNo): MapaMental {
  const novo = copia(mapa);
  const alvo = irmaosNaCopia(novo, caminho);
  if (alvo) alvo.lista.splice(alvo.indice, 1);
  return novo;
}

/**
 * Acrescenta um nó vazio no fim: sem pai, um ramo; com o caminho de um ramo,
 * uma folha dele; com o de uma folha, um filho dela. Devolve o caminho do nó
 * novo, para a tela pôr o cursor nele. Acima do teto do nível, nada muda.
 */
export function acrescentarNo(mapa: MapaMental, pai: readonly [] | readonly [number] | readonly [number, number]): { mapa: MapaMental; caminho: CaminhoDoNo | null } {
  const novo = copia(mapa);
  if (pai.length === 0) {
    if (novo.ramos.length >= RAMOS_DO_MAPA_MAX) return { mapa, caminho: null };
    novo.ramos.push({ rotulo: "", folhas: [] });
    return { mapa: novo, caminho: [novo.ramos.length - 1] };
  }
  const ramo = novo.ramos[pai[0]];
  if (!ramo) return { mapa, caminho: null };
  if (pai.length === 1) {
    if (ramo.folhas.length >= FOLHAS_POR_RAMO_MAX) return { mapa, caminho: null };
    ramo.folhas.push({ rotulo: "", filhos: [] });
    return { mapa: novo, caminho: [pai[0], ramo.folhas.length - 1] };
  }
  const folha = ramo.folhas[pai[1]];
  if (!folha || folha.filhos.length >= FILHOS_POR_FOLHA_MAX) return { mapa, caminho: null };
  folha.filhos.push("");
  return { mapa: novo, caminho: [pai[0], pai[1], folha.filhos.length - 1] };
}

/**
 * Move um nó (arrastar e soltar, ou as setas da tela): para outra posição
 * entre os irmãos ou, no mesmo nível, para outro pai (a folha que vai para
 * outro ramo, o filho que vai para outra folha). `para` é o caminho que o nó
 * passa a ter depois de sair do lugar dele. Nível diferente, caminho que não
 * existe ou o pai novo já no teto: nada muda.
 */
export function moverNo(mapa: MapaMental, de: CaminhoDoNo, para: CaminhoDoNo): MapaMental {
  if (de.length !== para.length) return mapa;
  if (de.every((v, i) => v === para[i])) return mapa;
  const novo = copia(mapa);
  const origem = irmaosNaCopia(novo, de);
  if (!origem) return mapa;
  let destino: unknown[] | undefined;
  let teto: number;
  if (para.length === 1) { destino = novo.ramos; teto = RAMOS_DO_MAPA_MAX; }
  else if (para.length === 2) { destino = novo.ramos[para[0]]?.folhas; teto = FOLHAS_POR_RAMO_MAX; }
  else { destino = novo.ramos[para[0]]?.folhas[para[1]!]?.filhos; teto = FILHOS_POR_FOLHA_MAX; }
  if (!destino) return mapa;
  const mesmaLista = destino === origem.lista;
  if (!mesmaLista && destino.length >= teto) return mapa;
  const [no] = origem.lista.splice(origem.indice, 1);
  const posicao = Math.max(0, Math.min(para[para.length - 1]!, destino.length));
  destino.splice(posicao, 0, no);
  return novo;
}

/** Quantos nós cabem ainda no mapa todo (o teto de 150). */
export function nosQueCabem(mapa: MapaMental): number {
  const nos = mapa.ramos.reduce((soma, ramo) => soma + 1 + ramo.folhas.reduce((s, folha) => s + 1 + folha.filhos.length, 0), 0);
  return Math.max(0, NOS_DO_MAPA_MAX - nos);
}

/** O texto de um rótulo no Markdown: sem quebrar a lista nem virar formatação. */
function textoNoMarkdown(texto: string): string {
  return texto.replace(/\s+/g, " ").replace(/([\\`*_[\]#<>|])/g, "\\$1").trim();
}

/**
 * O mapa em Markdown, como o app de referência o exporta: o título como
 * cabeçalho e a árvore como lista aninhada (os ramos em negrito). `traduzir`
 * é a tradução do resumo (H11), quando a dona baixa o mapa traduzido.
 */
export function mapaEmMarkdown(titulo: string, mapa: MapaMental, traduzir: (rotulo: string) => string = r => r): string {
  const linhas = [`# ${textoNoMarkdown(titulo) || "-"}`, ""];
  for (const ramo of mapa.ramos) {
    linhas.push(`- **${textoNoMarkdown(traduzir(ramo.rotulo))}**`);
    for (const folha of ramo.folhas) {
      linhas.push(`  - ${textoNoMarkdown(traduzir(folha.rotulo))}`);
      for (const filho of folha.filhos) linhas.push(`    - ${textoNoMarkdown(traduzir(filho))}`);
    }
  }
  return `${linhas.join("\n")}\n`;
}

/** O nome do arquivo baixado: o título sem o que os sistemas recusam, e a extensão. */
export function nomeDoArquivoDoMapa(titulo: string, extensao: "pdf" | "jpg" | "md"): string {
  const base = titulo.normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80).trim();
  return `${base || "mapa-mental"}.${extensao}`;
}
