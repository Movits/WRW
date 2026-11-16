// O raciocínio que cada função de texto pede ao modelo.
//
// O gemini-3.5-flash raciocina sem que ninguém peça. Na bancada de texto de
// 16/11/2026 (uma reunião de 20 min), o raciocínio foi 60% do custo do resumo,
// 59% do da extração e 51% do da pergunta, e é o que deixa a latência dele 5 a
// 6 vezes maior que a do Flash-Lite. Pedir menos é o braço b da bancada, que
// ainda não rodou: por isso nada liga sozinho. Sem a variável da função, o
// pedido sai sem o campo e o modelo raciocina no padrão dele, como até aqui.
//
// A variável é lida a cada chamada, como o LLM_MODEL (modelos-de-ia.ts): a
// bancada liga o braço b no próprio processo, e ligar em produção é definir a
// variável no Render, depois da bancada e com o Roberto.

import { FUNCOES_DE_TEXTO, type FuncaoDeTexto } from "./modelos-de-ia";

/**
 * Os valores de `reasoning_effort` que a documentação do Gemini compatível com
 * a OpenAI aceita no Gemini 3 Flash e no 3.1 Flash-Lite, onde cada um vira o
 * thinking_level de mesmo nome (no 2.5, minimal e low viram um
 * thinking_budget de 1.024 tokens). Ficam de fora o "xhigh", que é de um
 * modelo só, e o "none", que só desliga o raciocínio no 2.5: no Gemini 3 o
 * raciocínio não desliga.
 */
export const NIVEIS_DE_RACIOCINIO = ["minimal", "low", "medium", "high"] as const;
export type NivelDeRaciocinio = (typeof NIVEIS_DE_RACIOCINIO)[number];

export function ehNivelDeRaciocinio(valor: unknown): valor is NivelDeRaciocinio {
  return typeof valor === "string" && (NIVEIS_DE_RACIOCINIO as readonly string[]).includes(valor);
}

/**
 * As funções que a bancada mede, cada uma com a sua variável: ligar uma não
 * liga as outras. São as mesmas do modelo por função (FuncaoDeTexto, em
 * modelos-de-ia.ts), num tipo só: o modelo e o raciocínio de uma função saem
 * da mesma `funcao`, e uma função nova que entre lá sem a sua variável aqui
 * não compila.
 */
export const VARIAVEL_DO_RACIOCINIO = {
  extracao: "LLM_RACIOCINIO_EXTRACAO",
  resumo: "LLM_RACIOCINIO_RESUMO",
  pergunta: "LLM_RACIOCINIO_PERGUNTA",
} as const satisfies Record<FuncaoDeTexto, string>;

// No log só entra valor que não pode ser uma chave: letras, hífen e
// sublinhado, até 20. "baixo" aparece; uma chave colada no campo errado do
// painel, não.
const CABE_NO_LOG = /^[a-z_-]{1,20}$/i;

function comoAparecerNoLog(valor: string): string {
  const limpo = valor.trim();
  if (!limpo) return "vazio";
  return CABE_NO_LOG.test(limpo) ? `"${limpo}"` : "valor fora do log";
}

const recusasAvisadas = new Set<string>();

/**
 * O nível que a função pede, ou undefined para o pedido sair sem o campo.
 * Sem função (quem chama o pedirJsonAIA com funcao null, fora das três que a
 * bancada mede), undefined: nenhuma das variáveis vale para ela. Ausente ou
 * vazia, a variável deixa o padrão do modelo, em silêncio. Caixa e espaços em
 * volta não contam ("LOW" vale "low"). Valor fora da lista avisa no log uma vez
 * por variável e valor, e também não manda nada: um nível que o endpoint
 * recusasse derrubaria a função inteira com 400.
 */
export function raciocinioDaFuncao(funcao?: FuncaoDeTexto): NivelDeRaciocinio | undefined {
  if (!funcao) return undefined;
  const variavel = VARIAVEL_DO_RACIOCINIO[funcao];
  const valor = process.env[variavel];
  if (valor === undefined || valor === "") return undefined;
  const nivel = valor.trim().toLowerCase();
  if (ehNivelDeRaciocinio(nivel)) return nivel;
  const marca = `${variavel}\n${valor}`;
  if (!recusasAvisadas.has(marca)) {
    recusasAvisadas.add(marca);
    console.warn(
      `[IA] ${variavel} recusado (${comoAparecerNoLog(valor)}): use ${NIVEIS_DE_RACIOCINIO.join(", ")}. ` +
        "A chamada sai sem o campo, com o raciocínio padrão do modelo.",
    );
  }
  return undefined;
}

/**
 * A linha do boot com o raciocínio que cada função pede, já depois da guarda:
 * quem lê o log do Render vê se a variável pegou sem abrir o painel. Valor
 * recusado aparece como "padrão do modelo", com o aviso da recusa logo antes.
 * O nome de cada função é o da linha dos modelos (FUNCOES_DE_TEXTO).
 */
export function linhaDoRaciocinioDeIa(): string {
  const funcoes = Object.keys(VARIAVEL_DO_RACIOCINIO) as FuncaoDeTexto[];
  const partes = funcoes.map(funcao => `${FUNCOES_DE_TEXTO[funcao].nomeNoLog} ${raciocinioDaFuncao(funcao) ?? "padrão do modelo"}`);
  return `[IA] raciocínio · ${partes.join(" · ")}`;
}
