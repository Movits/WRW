import {
  CABECALHO_DO_VISUAL_MAX, CELULA_DO_VISUAL_MAX, COLUNAS_DO_VISUAL_MAX, LINHAS_DO_VISUAL_MAX, numeroDaCelula, TIPOS_DE_VISUAL,
  TITULO_DO_VISUAL_MAX, UNIDADE_DO_VISUAL_MAX,
  type TabelaDaResposta, type TipoDeVisual, type VisualDaResposta,
} from "@shared/resposta-visual";

/**
 * A resposta em forma visual do Pergunte (H6d; shared/resposta-visual.ts): o
 * pedaço do esquema que a IA preenche, as instruções e a conferência do que
 * ela devolve. Vale para a pergunta a uma reunião (server/reuniao-com-ia.ts:
 * a dona, a gravação em andamento e o link aberto) e para a pergunta a várias
 * (server/perguntar-a-varias-reunioes.ts).
 *
 * A IA não manda desenho nem marcação: manda colunas e linhas de texto, num
 * formato fixo. O servidor confere a forma (colunas, linhas, células do mesmo
 * tamanho, os limites), os números do gráfico (só o número, sem adivinhar
 * outro formato) e as vozes (só as que a entrada tem). O que não passa não vai
 * à tela: o gráfico com número fora do formato vira tabela, com o texto como a
 * IA o escreveu; a forma errada ou a voz inventada derrubam o visual, e a
 * resposta em texto continua (o motivo vai ao log, sem o conteúdo).
 */

// Só palavras de esquema que o pedido à IA já usa em produção (type, properties,
// items, required, additionalProperties, enum e maxLength): uma palavra que o
// endpoint recusasse derrubaria todo Pergunte, e não só o visual. Os limites de
// colunas e linhas vão nas instruções, e o servidor os confere (visualConferido).
export const SCHEMA_DO_VISUAL = {
  type: "object",
  properties: {
    tipo: { type: "string", enum: ["nenhum", ...TIPOS_DE_VISUAL] },
    titulo: { type: "string", maxLength: TITULO_DO_VISUAL_MAX },
    unidade: { type: "string", maxLength: UNIDADE_DO_VISUAL_MAX },
    colunas: { type: "array", items: { type: "string", maxLength: CABECALHO_DO_VISUAL_MAX } },
    linhas: {
      type: "array",
      items: {
        type: "object",
        properties: { celulas: { type: "array", items: { type: "string", maxLength: CELULA_DO_VISUAL_MAX } } },
        required: ["celulas"],
        additionalProperties: false,
      },
    },
  },
  required: ["tipo", "titulo", "unidade", "colunas", "linhas"],
  additionalProperties: false,
} as const;

/** Como a entrada nomeia as vozes: o rótulo da reunião, o rótulo com a reunião (várias) ou nenhum. */
export type VozesDoVisual = "rotulo" | "rotulo_com_reuniao" | "sem_vozes";

/** As linhas do visual nas instruções da IA. */
export function instrucoesDoVisual(vozes: VozesDoVisual): string[] {
  return [
    "Visual: só quando a pergunta pede uma tabela, um gráfico, uma comparação, uma contagem ou uma lista de valores que fica melhor em colunas, monte também o \"visual\". Em qualquer outra pergunta, ou sem resposta, o tipo é \"nenhum\", com o título, a unidade, as colunas e as linhas vazios.",
    "O visual usa só o que foi dito, como a resposta: nenhum nome, número ou valor que a transcrição não sustente. O que não foi dito fica de fora, nunca vira zero.",
    `"tabela": "colunas" traz os cabeçalhos (de 2 a ${COLUNAS_DO_VISUAL_MAX}), e cada linha traz uma célula por coluna, na mesma ordem (até ${LINHAS_DO_VISUAL_MAX} linhas).`,
    `"barras" (comparar quantidades entre itens) ou "linhas" (a mesma quantidade ao longo do tempo, na ordem do tempo): a primeira coluna é o nome de cada item, ou o momento, e as outras (de 1 a ${COLUNAS_DO_VISUAL_MAX - 1}) são as séries de números. Cada célula de série traz só o número, com ponto decimal e sem separador de milhar nem unidade; a unidade vai em "unidade" ("R$", "%", "contêineres"). Até ${LINHAS_DO_VISUAL_MAX} linhas; "linhas" pede ao menos 2.`,
    "O texto do visual não leva HTML, Markdown nem código: só o texto de cada célula.",
    vozes === "rotulo"
      ? "Para pôr uma voz numa célula, use o rótulo dela, como na resposta ({F2})."
      : vozes === "rotulo_com_reuniao"
        ? "Para pôr uma voz numa célula, use a reunião e o rótulo, como na resposta ({R2:F1})."
        : "Não use rótulos de voz no visual.",
  ];
}

// Os caracteres de controle (quebra de linha e tab incluídas) viram espaço.
const CONTROLE = new RegExp("[\\u0000-\\u001f\\u007f]", "g");
// Uma etiqueta de HTML que a IA escreveu (<b>, </td>, <br/>): sai, e o texto de dentro fica.
const ETIQUETA_DE_HTML = /<\/?[a-z][^<>]{0,200}>/gi;
// A ênfase e o código do Markdown (**, __, `): saem; o texto fica.
const MARCAS_DO_MARKDOWN = /\*\*|__|`+/g;
// Um rótulo de voz cortado no fim ("{F", "{R2:F"): sai inteiro, para a tela não mostrar meio rótulo.
const ROTULO_PELA_METADE = /\{[^{}]{0,8}$/;

/** O texto de um campo do visual: sem controle, sem HTML nem Markdown, sem espaço sobrando e cortado por caractere. */
export function textoDoVisual(valor: unknown, limite: number): string {
  if (typeof valor !== "string") return "";
  const limpo = valor.replace(CONTROLE, " ").replace(ETIQUETA_DE_HTML, "").replace(MARCAS_DO_MARKDOWN, "").replace(/\s+/g, " ").trim();
  const letras = Array.from(limpo);
  if (letras.length <= limite) return limpo;
  return letras.slice(0, limite).join("").replace(ROTULO_PELA_METADE, "").trimEnd();
}

/**
 * Por que o visual não foi à tela como a IA mandou: "forma" (colunas, linhas
 * ou células fora do formato), "voz" (um rótulo que a entrada não tem) e, no
 * gráfico que virou tabela, "numero" (célula de série que não é só o número) e
 * "pontos" (linha do tempo com um ponto só).
 */
export type MotivoDoVisual = "forma" | "voz" | "numero" | "pontos";

export type VisualConferido = { visual: VisualDaResposta | null; motivo: MotivoDoVisual | null; tipoPedido: TipoDeVisual | null };

/**
 * O visual que a IA devolveu, conferido. `conferirVozes` recebe cada texto e
 * devolve o texto com as vozes no formato da tela, ou null se ele cita uma voz
 * que a entrada não tem (quem chama sabe quais existem).
 */
export function visualConferido(bruto: unknown, conferirVozes: (texto: string) => string | null): VisualConferido {
  const dados = bruto && typeof bruto === "object" ? (bruto as Record<string, unknown>) : null;
  const tipo = typeof dados?.tipo === "string" && (TIPOS_DE_VISUAL as readonly string[]).includes(dados.tipo) ? (dados.tipo as TipoDeVisual) : null;
  if (!dados || !tipo) return { visual: null, motivo: null, tipoPedido: null };
  const recusa = (motivo: MotivoDoVisual): VisualConferido => ({ visual: null, motivo, tipoPedido: tipo });

  const colunas = Array.isArray(dados.colunas) ? dados.colunas.map(coluna => textoDoVisual(coluna, CABECALHO_DO_VISUAL_MAX)) : [];
  if (colunas.length < 2 || colunas.length > COLUNAS_DO_VISUAL_MAX || colunas.some(coluna => !coluna)) return recusa("forma");
  const brutas = Array.isArray(dados.linhas) ? dados.linhas : [];
  if (brutas.length > LINHAS_DO_VISUAL_MAX) return recusa("forma");
  const linhas: string[][] = [];
  for (const bruta of brutas) {
    const celulas = bruta && typeof bruta === "object" ? (bruta as Record<string, unknown>).celulas : null;
    if (!Array.isArray(celulas) || celulas.length !== colunas.length) return recusa("forma");
    const linha = celulas.map(celula => textoDoVisual(celula, CELULA_DO_VISUAL_MAX));
    if (linha.some(Boolean)) linhas.push(linha);
  }
  if (!linhas.length) return recusa("forma");

  // As vozes em todo texto que vai à tela: o título, os cabeçalhos e as células.
  const comVozes = (texto: string): string | null => (texto ? conferirVozes(texto) : texto);
  const titulo = comVozes(textoDoVisual(dados.titulo, TITULO_DO_VISUAL_MAX));
  const cabecalhos = colunas.map(comVozes);
  const celulas = linhas.map(linha => linha.map(comVozes));
  if (titulo === null || cabecalhos.some(c => c === null) || celulas.some(linha => linha.some(c => c === null))) return recusa("voz");
  const tabela: TabelaDaResposta = { tipo: "tabela", titulo, colunas: cabecalhos as string[], linhas: celulas as string[][] };
  if (tipo === "tabela") return { visual: tabela, motivo: null, tipoPedido: tipo };

  // O gráfico: a primeira coluna é o nome de cada item; as outras, números.
  const unidade = textoDoVisual(dados.unidade, UNIDADE_DO_VISUAL_MAX);
  const rotulos = tabela.linhas.map(linha => linha[0]);
  const valores = tabela.linhas.map(linha => linha.slice(1).map(numeroDaCelula));
  const viraTabela = (motivo: MotivoDoVisual): VisualConferido => ({ visual: tabela, motivo, tipoPedido: tipo });
  if (rotulos.some(rotulo => !rotulo) || valores.some(linha => linha.some(valor => valor === null))) return viraTabela("numero");
  if (tipo === "linhas" && rotulos.length < 2) return viraTabela("pontos");
  const series = tabela.colunas.slice(1).map((nome, indice) => ({ nome, valores: valores.map(linha => linha[indice] as number) }));
  return { visual: { tipo, titulo: tabela.titulo, eixo: tabela.colunas[0], unidade, rotulos, series }, motivo: null, tipoPedido: tipo };
}

/** A linha de log do visual que não foi como veio: o motivo e o tipo pedido, nunca o conteúdo. */
export function avisarDoVisual(origem: string, conferido: VisualConferido) {
  if (!conferido.motivo) return;
  console.warn(`[${origem}] visual ${conferido.visual ? "virou tabela" : "fora da tela"} (${conferido.motivo}): a IA pediu ${conferido.tipoPedido}`);
}
