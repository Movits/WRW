/**
 * Os modelos do resumo guardado da reunião (H4d do plano do gravador): o mesmo
 * formato e as mesmas seções (ações, foco, tarefas por assunto, decisões,
 * bloqueios e questões), com outra instrução à IA. A dona escolhe o modelo ao
 * pedir o resumo e pode "Refazer como…" outro: os itens que ela confirmou e as
 * ações feitas ficam; os pendentes e os ignorados são trocados.
 *
 * O código fica gravado em meeting_summaries.template (varchar com o enum só
 * no TypeScript, em drizzle/schema.ts); server/modelos-de-resumo.ts confere,
 * em tempo de compilação, que esta lista e a do schema são a mesma. O nome de
 * cada modelo na tela mora nos 10 idiomas de client/src/i18n/locales/.
 */
export const MODELOS_DE_RESUMO = ["general", "networking", "mentoring", "sales", "one_on_one"] as const;

export type ModeloDeResumo = (typeof MODELOS_DE_RESUMO)[number];

/** O modelo do resumo que nasce sozinho quando a reunião fica pronta. */
export const MODELO_DE_RESUMO_PADRAO: ModeloDeResumo = "general";

/** O valor gravado, se é um modelo conhecido; null se não é. */
export function modeloDeResumo(valor: unknown): ModeloDeResumo | null {
  return typeof valor === "string" && (MODELOS_DE_RESUMO as readonly string[]).includes(valor) ? valor as ModeloDeResumo : null;
}

/**
 * Os modelos da própria dona, o estilo, "a IA escolhe o modelo", as instruções
 * do pedido e a pergunta do tamanho (H4e do plano do gravador; HN-35 na
 * auditoria do HiNoter). Construídos sobre os modelos prontos acima: o modelo
 * próprio usa as seções e as quantidades do Geral, com a instrução da dona no
 * lugar da frase de contexto (server/resumo-da-reuniao.ts). As regras que
 * conferem cada item (o trecho literal, só o que foi dito, as vozes) não mudam
 * com nada disto.
 */

/** O estilo do resumo: o equilibrado é o resumo de antes da H4e, letra por letra. */
export const ESTILOS_DO_RESUMO = ["concise", "balanced", "detailed"] as const;
export type EstiloDoResumo = (typeof ESTILOS_DO_RESUMO)[number];
export const ESTILO_DO_RESUMO_PADRAO: EstiloDoResumo = "balanced";

export function estiloDoResumo(valor: unknown): EstiloDoResumo | null {
  return typeof valor === "string" && (ESTILOS_DO_RESUMO as readonly string[]).includes(valor) ? valor as EstiloDoResumo : null;
}

/**
 * Os ícones que a dona escolhe para um modelo dela: uma lista fechada de
 * emojis (sem texto livre, que viraria outro campo a conferir). O primeiro é o
 * do modelo novo.
 */
export const ICONES_DOS_MODELOS = ["📝", "🤝", "💼", "🎯", "💡", "📈", "🎤", "📚", "🧭", "🌍", "❤️", "⭐"] as const;
export type IconeDoModelo = (typeof ICONES_DOS_MODELOS)[number];

export function iconeDoModelo(valor: unknown): IconeDoModelo | null {
  return typeof valor === "string" && (ICONES_DOS_MODELOS as readonly string[]).includes(valor) ? valor as IconeDoModelo : null;
}

/** Quantos modelos próprios cada dona guarda, e o tamanho do nome e das instruções. */
export const MODELOS_PROPRIOS_MAX = 20;
export const NOME_DO_MODELO_MAX = 60;
export const INSTRUCOES_DO_MODELO_MAX = 1500;
/** As instruções de um pedido só (antes de gravar, ao pedir ou ao refazer). */
export const INSTRUCOES_DO_PEDIDO_MAX = 500;

/**
 * Quantas vezes a dona refaz resumos em 24 h, somadas todas as reuniões: o teto
 * de custo do "Refazer o resumo" (cada um é uma geração paga, de US$ 0,05 a
 * 0,10 por hora de reunião). Contado no banco (resumos_refeitos), e não em
 * memória: o deploy não o zera. Soma-se ao teto brando de pedidos à IA (20 a
 * cada 10 minutos), que segura a rajada.
 */
export const REFAZERES_POR_DIA = 20;

/**
 * O modelo de um pedido: um pronto (o código), um da dona (o id) ou "a IA
 * escolhe" (com o modelo Lite, entre os prontos e os da dona). Na tela e na
 * entrada dos procedimentos, um texto só: o código do pronto, "ia" ou
 * "proprio:<id>".
 */
export type EscolhaDoModelo =
  | { tipo: "pronto"; modelo: ModeloDeResumo }
  | { tipo: "proprio"; id: string }
  | { tipo: "ia" };

export const ESCOLHA_DA_IA = "ia";
const PREFIXO_DO_PROPRIO = "proprio:";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function escolhaComoTexto(escolha: EscolhaDoModelo): string {
  if (escolha.tipo === "pronto") return escolha.modelo;
  if (escolha.tipo === "proprio") return `${PREFIXO_DO_PROPRIO}${escolha.id}`;
  return ESCOLHA_DA_IA;
}

/** O texto da tela ou da entrada como escolha; null se não é nenhuma. */
export function escolhaDoTexto(valor: unknown): EscolhaDoModelo | null {
  if (typeof valor !== "string") return null;
  if (valor === ESCOLHA_DA_IA) return { tipo: "ia" };
  const pronto = modeloDeResumo(valor);
  if (pronto) return { tipo: "pronto", modelo: pronto };
  if (valor.startsWith(PREFIXO_DO_PROPRIO)) {
    const id = valor.slice(PREFIXO_DO_PROPRIO.length);
    if (ID.test(id)) return { tipo: "proprio", id: id.toLowerCase() };
  }
  return null;
}

/**
 * "O resumo teve o tamanho certo?" (como no app web do HiNoter): a resposta da
 * dona a um resumo ajusta os próximos dela. Curto demais pede um pouco mais;
 * longo demais, um pouco menos. O ajuste guardado vai de -2 a +2.
 */
export const RESPOSTAS_DO_TAMANHO = ["short", "right", "long"] as const;
export type RespostaDoTamanho = (typeof RESPOSTAS_DO_TAMANHO)[number];
export const AJUSTE_DO_TAMANHO_MAX = 2;

/** O quanto cada resposta move o ajuste: curto pede mais (+1), longo pede menos (-1). */
export function passoDoTamanho(resposta: RespostaDoTamanho | null): number {
  return resposta === "short" ? 1 : resposta === "long" ? -1 : 0;
}

/**
 * O ajuste novo quando a dona responde (ou troca a resposta de) um resumo: o
 * passo da resposta anterior sai e o da nova entra, para trocar de ideia no
 * mesmo resumo não somar duas vezes. Fica entre -2 e +2.
 */
export function ajusteDepoisDaResposta(ajuste: number, anterior: RespostaDoTamanho | null, nova: RespostaDoTamanho | null): number {
  const bruto = Math.round(Number(ajuste) || 0) - passoDoTamanho(anterior) + passoDoTamanho(nova);
  return Math.max(-AJUSTE_DO_TAMANHO_MAX, Math.min(AJUSTE_DO_TAMANHO_MAX, bruto));
}

/** As recusas dos modelos próprios e do teto do refazer, como código traduzido na tela. */
export const RECUSAS_DOS_MODELOS = {
  naoEncontrado: "MODELO_DE_RESUMO_NAO_ENCONTRADO",
  demais: "MODELOS_DE_RESUMO_DEMAIS",
  nomeRepetido: "MODELO_DE_RESUMO_NOME_REPETIDO",
  refazeresDemais: "REFAZERES_DO_RESUMO_DEMAIS",
  pedidoForaDeHora: "PEDIDO_DO_RESUMO_FORA_DE_HORA",
} as const;
export type CodigoDaRecusaDosModelos = (typeof RECUSAS_DOS_MODELOS)[keyof typeof RECUSAS_DOS_MODELOS];
