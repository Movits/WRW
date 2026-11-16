import { invokeLLM } from "./_core/llm";
import type { FuncaoDeTexto } from "./_core/modelos-de-ia";

/**
 * O pedido à IA de texto que responde em JSON (schema strict), usado no que a
 * IA escreve sobre uma reunião: o "Pergunte à reunião" e o resumo guardado.
 * Toda falha vira um código nosso; só o tipo do erro vai ao log, porque a
 * mensagem do JSON.parse cita o conteúdo, que vem da transcrição.
 */
export type CodigoDaFalhaDaIA = "IA_INDISPONIVEL" | "RESPOSTA_INVALIDA" | "RESPOSTA_CORTADA";

export class FalhaDaIA extends Error {
  readonly codigo: CodigoDaFalhaDaIA;
  constructor(codigo: CodigoDaFalhaDaIA) {
    super(codigo);
    this.name = "FalhaDaIA";
    this.codigo = codigo;
  }
}

export async function pedirJsonAIA(pedido: {
  sistema: string;
  usuario: string;
  nome: string;
  schema: Record<string, unknown>;
  timeoutMs: number;
  orcamentoMs: number;
  /** A função escolhe o modelo (LLM_MODEL_RESUMO, LLM_MODEL_PERGUNTA...); sem ela, vale o LLM_MODEL. */
  funcao?: FuncaoDeTexto;
}): Promise<{ dados: Record<string, unknown>; modelo: string | null }> {
  let resposta: Awaited<ReturnType<typeof invokeLLM>>;
  try {
    resposta = await invokeLLM({
      funcao: pedido.funcao,
      timeoutMs: pedido.timeoutMs,
      orcamentoMs: pedido.orcamentoMs,
      messages: [{ role: "system", content: pedido.sistema }, { role: "user", content: pedido.usuario }],
      response_format: { type: "json_schema", json_schema: { name: pedido.nome, strict: true, schema: pedido.schema } },
    });
  } catch (erro) {
    console.error(`[Reuniões] a IA não respondeu (${pedido.nome}):`, erro instanceof Error ? erro.message : erro);
    throw new FalhaDaIA("IA_INDISPONIVEL");
  }
  const escolha = resposta?.choices?.[0];
  // Cortada no teto de saída, a resposta é um JSON pela metade: tentar de novo
  // com a mesma entrada daria o mesmo corte.
  if (escolha?.finish_reason === "length") {
    console.error(`[Reuniões] a resposta da IA veio cortada no teto de saída (${pedido.nome})`);
    throw new FalhaDaIA("RESPOSTA_CORTADA");
  }
  try {
    const conteudo = escolha?.message?.content;
    if (typeof conteudo !== "string") throw new Error("sem texto");
    const dados = JSON.parse(conteudo) as unknown;
    if (!dados || typeof dados !== "object" || Array.isArray(dados)) throw new Error("não é objeto");
    return { dados: dados as Record<string, unknown>, modelo: typeof resposta.model === "string" && resposta.model ? resposta.model.slice(0, 80) : null };
  } catch (erro) {
    console.error(`[Reuniões] a IA devolveu um JSON inválido (${pedido.nome}):`, erro instanceof Error ? erro.name : typeof erro);
    throw new FalhaDaIA("RESPOSTA_INVALIDA");
  }
}
