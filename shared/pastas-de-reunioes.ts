/**
 * As pastas das reuniões e os filtros da lista por origem (H7d do plano do
 * gravador; HN-67 no app de referência da cliente: pastas com ícone e cor,
 * mover, lixeira, filtros "Todas", "Pastas", "YouTube" e "Importadas" e a
 * seleção de várias notas). A lixeira mora em shared/lixeira-de-reunioes.ts.
 *
 * Cada dona tem as próprias pastas (meeting_folders), e uma reunião fica em no
 * máximo uma (meetings.folder_id). O ícone e a cor são chaves de listas
 * fechadas: a tela as troca pelo desenho e pela classe dela, e o servidor só
 * grava o que está na lista.
 */

/** O nome da pasta, em letras (não em bytes: a coluna aceita 60). */
export const NOME_DA_PASTA_MAX = 40;
/** Quantas pastas uma dona tem, no máximo. */
export const PASTAS_POR_DONA_MAX = 50;
/**
 * Quantas reuniões uma ação de várias (mover, mandar para a lixeira,
 * restaurar, apagar de vez) leva por pedido. A seleção da tela passa disso só
 * quando a dona marca mais de 50 de uma vez: ela manda em lotes.
 */
export const REUNIOES_POR_ACAO_MAX = 50;

/** Os ícones da pasta (a tela desenha cada um com um ícone do lucide). */
export const ICONES_DA_PASTA = [
  "pasta", "estrela", "maleta", "pessoas", "coracao", "livro", "lampada", "globo", "microfone", "calendario", "bandeira", "casa",
] as const;
export type IconeDaPasta = (typeof ICONES_DA_PASTA)[number];
export const ICONE_DA_PASTA_PADRAO: IconeDaPasta = "pasta";

/** As cores da pasta (a tela troca cada chave pela classe dela, legível no fundo escuro). */
export const CORES_DA_PASTA = ["ambar", "vermelho", "laranja", "verde", "azul", "roxo", "rosa", "cinza"] as const;
export type CorDaPasta = (typeof CORES_DA_PASTA)[number];
export const COR_DA_PASTA_PADRAO: CorDaPasta = "ambar";

/**
 * As recusas das pastas, como CÓDIGO (a tela traduz):
 * - NAO_ENCONTRADA: a pasta não existe ou é de outra conta (as duas parecem iguais);
 * - DEMAIS: a dona já tem PASTAS_POR_DONA_MAX pastas;
 * - NOME_INVALIDO: o nome ficou vazio depois de aparado;
 * - NOME_REPETIDO: a dona já tem uma pasta com esse nome (sem caixa nem acento).
 */
export const RECUSAS_DAS_PASTAS = {
  naoEncontrada: "PASTA_NAO_ENCONTRADA",
  demais: "PASTAS_DEMAIS",
  nomeInvalido: "NOME_DA_PASTA_INVALIDO",
  nomeRepetido: "NOME_DA_PASTA_REPETIDO",
} as const;
export type CodigoDaRecusaDaPasta = (typeof RECUSAS_DAS_PASTAS)[keyof typeof RECUSAS_DAS_PASTAS];

/**
 * O nome como fica gravado: sem espaço nas pontas, os espaços de dentro
 * juntados num só e cortado em NOME_DA_PASTA_MAX letras (pela letra, não pela
 * unidade do UTF-16: o emoji não sai pela metade). Vazio vira null.
 */
export function normalizarNomeDaPasta(nome: string): string | null {
  const limpo = nome.replace(/\s+/g, " ").trim();
  if (!limpo) return null;
  return Array.from(limpo).slice(0, NOME_DA_PASTA_MAX).join("").trim() || null;
}

// Em RegExp, e não em literal com a bandeira u: o alvo do tsconfig não aceita a bandeira no literal.
const DIACRITICOS = new RegExp("\\p{Diacritic}", "gu");

/** A chave do nome para conferir a repetida: sem caixa e sem acento ("Clientes" e "clientes" são a mesma pasta). */
export function chaveDoNomeDaPasta(nome: string): string {
  return (normalizarNomeDaPasta(nome) ?? "").normalize("NFD").replace(DIACRITICOS, "").toLocaleLowerCase("pt-BR");
}

/** O ícone lido do banco: o que não está na lista (gravado por uma versão futura) cai no padrão. */
export function iconeDaPasta(valor: unknown): IconeDaPasta {
  return (ICONES_DA_PASTA as readonly unknown[]).includes(valor) ? valor as IconeDaPasta : ICONE_DA_PASTA_PADRAO;
}

/** A cor lida do banco, pela mesma regra do ícone. */
export function corDaPasta(valor: unknown): CorDaPasta {
  return (CORES_DA_PASTA as readonly unknown[]).includes(valor) ? valor as CorDaPasta : COR_DA_PASTA_PADRAO;
}

/**
 * Os filtros da lista por origem, como no app de referência: "Todas",
 * "Gravadas", "Importadas", "YouTube" e "Pastas" (que mostra as pastas, e a
 * pasta escolhida mostra as reuniões dela).
 */
export const VISTAS_DA_LISTA = ["todas", "gravadas", "importadas", "youtube", "pastas"] as const;
export type VistaDaLista = (typeof VISTAS_DA_LISTA)[number];

/**
 * A origem gravada da reunião no filtro da lista:
 * - "gravadas": o microfone (gravacao) e a aba do navegador (aba);
 * - "importadas": o arquivo de áudio ou vídeo, o PDF e as fotos de um texto;
 * - "youtube": o vídeo do YouTube.
 * A origem nula (o envio único de antes da gravação em partes, que recebia
 * tanto o microfone quanto um arquivo sem dizer qual) não entra em nenhum dos
 * três: aparece só em "Todas", em vez de chutar de onde veio.
 */
export function vistaDaOrigem(origem: string | null | undefined): "gravadas" | "importadas" | "youtube" | null {
  if (origem === "gravacao" || origem === "aba") return "gravadas";
  if (origem === "arquivo" || origem === "pdf" || origem === "foto") return "importadas";
  if (origem === "youtube") return "youtube";
  return null;
}

/**
 * A reunião aparece na vista? "Todas" mostra todas; "Pastas", com uma pasta
 * escolhida, as reuniões dela, e sem pasta escolhida, as que estão em alguma
 * pasta (a tela mostra as pastas, e só lista reuniões quando a dona busca ou
 * filtra ali); as outras três, pela origem.
 */
export function reuniaoNaVista(reuniao: { origem?: string | null; folderId?: string | null }, vista: VistaDaLista, pastaId?: string | null): boolean {
  if (vista === "todas") return true;
  if (vista === "pastas") return pastaId ? reuniao.folderId === pastaId : Boolean(reuniao.folderId);
  return vistaDaOrigem(reuniao.origem) === vista;
}
