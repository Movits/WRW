/**
 * O mapa mental da reunião (H10 do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md), no formato do app de referência
 * da cliente: uma árvore horizontal com a raiz no título da reunião e três
 * níveis abaixo dela. Os ramos são os assuntos; as folhas, os pontos de cada
 * assunto; os filhos, os detalhes de uma folha. A raiz não é guardada nem vem
 * da IA: a tela usa o título.
 *
 * A conferência mora aqui porque é a mesma regra nos dois lados: o servidor a
 * aplica na resposta da IA antes de gravar, e de novo ao ler o que está
 * guardado, para um JSON velho ou mexido à mão nunca chegar pela metade à
 * tela. Puro: sem banco, rede nem ambiente (shared/CLAUDE.md).
 *
 * As regras (plano de 15/11):
 * - de 2 a 12 ramos, até 8 folhas por ramo e até 4 filhos por folha;
 * - rótulos de até 60 caracteres, sem rótulo de voz ({F2}): o mapa não diz
 *   quem falou, e o nome que a dona deu às vozes nunca chega à IA;
 * - até 150 nós na árvore toda (ramos, folhas e filhos; a raiz não conta).
 */

export type FolhaDoMapa = { rotulo: string; filhos: string[] };
export type RamoDoMapa = { rotulo: string; folhas: FolhaDoMapa[] };
export type MapaMental = { ramos: RamoDoMapa[] };

export const RAMOS_DO_MAPA_MIN = 2;
export const RAMOS_DO_MAPA_MAX = 12;
export const FOLHAS_POR_RAMO_MAX = 8;
export const FILHOS_POR_FOLHA_MAX = 4;
export const ROTULO_DO_MAPA_MAX = 60;
export const NOS_DO_MAPA_MAX = 150;

// Um rótulo de voz inteiro ({F2}) ou pela metade ("{F2", "{ f 2"): qualquer um
// derruba o nó. O rótulo não é trocado nem apagado do texto: "{F2} envia a
// proposta" sem o rótulo viraria outra frase.
const ROTULO_DE_VOZ = /\{\s*F\s*\d/i;
// Pelo construtor: o alvo do tsconfig não aceita a flag u num literal.
// Só a letra latina perde o sinal combinante ("Prázo" = "Prazo"). Nas outras
// escritas ele muda a palavra e fica na chave: a matra do hindi (माल × मेल),
// o dakuten do japonês (バス × パス), o breve do russo (й não é и), as vogais
// escritas do árabe.
const SINAIS_DA_LETRA_LATINA = new RegExp("(\\p{Script=Latin})\\p{M}+", "gu");
// As palavras da chave: letras, cada uma com os seus sinais, e números. O
// sinal solto, sem letra antes (o seletor de variação do emoji em "⚠️"), fica
// de fora, como a pontuação.
const PALAVRA_DA_CHAVE = new RegExp("(?:\\p{L}\\p{M}*|\\p{N})+", "gu");

/**
 * O rótulo aparado, com os espaços juntados, ou null: vazio, não texto ou com
 * rótulo de voz. Acima de 60 caracteres, corta na última palavra inteira (se
 * ela não estiver cedo demais) e fecha com reticências, dentro dos 60.
 */
export function rotuloDoMapa(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const aparado = valor.replace(/\s+/g, " ").trim();
  if (!aparado || ROTULO_DE_VOZ.test(aparado)) return null;
  const letras = Array.from(aparado);
  if (letras.length <= ROTULO_DO_MAPA_MAX) return aparado;
  const cabe = letras.slice(0, ROTULO_DO_MAPA_MAX - 1).join("");
  const espaco = cabe.lastIndexOf(" ");
  const cortado = espaco >= ROTULO_DO_MAPA_MAX / 2 ? cabe.slice(0, espaco) : cabe;
  return `${cortado.trimEnd()}…`;
}

/** Para achar irmãos repetidos: sem acento na letra latina, sem caixa e sem pontuação. */
export function chaveDoRotulo(rotulo: string): string {
  return (rotulo.normalize("NFD").replace(SINAIS_DA_LETRA_LATINA, "$1").toLowerCase().match(PALAVRA_DA_CHAVE) ?? []).join(" ");
}

function objeto(valor: unknown): Record<string, unknown> | null {
  return valor && typeof valor === "object" && !Array.isArray(valor) ? valor as Record<string, unknown> : null;
}

function lista(valor: unknown): unknown[] {
  return Array.isArray(valor) ? valor : [];
}

// O nó vem como {rotulo, ...}; a folha e o filho também valem como texto solto.
function rotuloDoNo(bruto: unknown): unknown {
  return typeof bruto === "string" ? bruto : objeto(bruto)?.rotulo;
}

/** Os irmãos com rótulo válido, na ordem, sem repetidos e até o teto do nível. */
function irmaos<T>(brutos: unknown[], teto: number, montar: (rotulo: string, bruto: unknown) => T): T[] {
  const vistos: string[] = [];
  const saida: T[] = [];
  for (const bruto of brutos) {
    if (saida.length >= teto) break;
    const rotulo = rotuloDoMapa(rotuloDoNo(bruto));
    if (!rotulo) continue;
    const chave = chaveDoRotulo(rotulo);
    if (!chave || vistos.includes(chave)) continue;
    vistos.push(chave);
    saida.push(montar(rotulo, bruto));
  }
  return saida;
}

/**
 * O teto de nós da árvore toda, por nível e em rodízio: primeiro os ramos,
 * depois a 1ª folha de cada ramo, a 2ª de cada ramo..., e por fim os filhos,
 * do mesmo jeito. Assim o corte cai nos detalhes, e nenhum assunto do fim da
 * reunião some porque o primeiro tinha detalhe demais.
 */
function dentroDoTeto(ramos: RamoDoMapa[]): RamoDoMapa[] {
  let restam = NOS_DO_MAPA_MAX - ramos.length;
  const folhas: FolhaDoMapa[][] = ramos.map(() => []);
  for (let i = 0; i < FOLHAS_POR_RAMO_MAX; i++) {
    ramos.forEach((ramo, r) => {
      const folha = ramo.folhas[i];
      if (folha && restam > 0) {
        folhas[r].push({ rotulo: folha.rotulo, filhos: [] });
        restam--;
      }
    });
  }
  for (let j = 0; j < FILHOS_POR_FOLHA_MAX; j++) {
    ramos.forEach((ramo, r) => {
      folhas[r].forEach((folha, f) => {
        const filho = ramo.folhas[f].filhos[j];
        if (filho && restam > 0) {
          folha.filhos.push(filho);
          restam--;
        }
      });
    });
  }
  return ramos.map((ramo, r) => ({ rotulo: ramo.rotulo, folhas: folhas[r] }));
}

/**
 * A árvore só com o que passa nas regras: nó sem rótulo válido sai com tudo o
 * que vem embaixo dele, repetidos entre irmãos saem, e os tetos de cada nível
 * e o da árvore toda cortam o excesso. Pode sobrar menos de 2 ramos: é a
 * forma de conferir um mapa parcial (uma janela da reunião longa).
 */
export function podarMapaMental(bruto: unknown): MapaMental {
  const ramos = irmaos(lista(objeto(bruto)?.ramos), RAMOS_DO_MAPA_MAX, (rotulo, ramo) => ({
    rotulo,
    folhas: irmaos(lista(objeto(ramo)?.folhas), FOLHAS_POR_RAMO_MAX, (rotuloDaFolha, folha) => ({
      rotulo: rotuloDaFolha,
      filhos: irmaos(lista(objeto(folha)?.filhos), FILHOS_POR_FOLHA_MAX, rotuloDoFilho => rotuloDoFilho),
    })),
  }));
  return { ramos: dentroDoTeto(ramos) };
}

/** O mapa que vale: podado e com pelo menos 2 ramos; senão, null. */
export function conferirMapaMental(bruto: unknown): MapaMental | null {
  const mapa = podarMapaMental(bruto);
  return mapa.ramos.length >= RAMOS_DO_MAPA_MIN ? mapa : null;
}

/** Quantos nós o mapa tem (ramos, folhas e filhos; a raiz não conta). */
export function nosDoMapa(mapa: MapaMental): number {
  return mapa.ramos.reduce((soma, ramo) => soma + 1 + ramo.folhas.reduce((daFolha, folha) => daFolha + 1 + folha.filhos.length, 0), 0);
}

/**
 * Os rótulos do mapa (ramos, folhas e filhos; a raiz é o título da reunião e
 * não entra), uma vez cada, na ordem da árvore: o que a tradução do resumo
 * (H11) traduz junto com os itens, no servidor e na tela.
 */
export function rotulosDoMapaMental(mapa: MapaMental): string[] {
  const rotulos = new Set<string>();
  for (const ramo of mapa.ramos) {
    rotulos.add(ramo.rotulo);
    for (const folha of ramo.folhas) {
      rotulos.add(folha.rotulo);
      for (const filho of folha.filhos) rotulos.add(filho);
    }
  }
  return Array.from(rotulos);
}
