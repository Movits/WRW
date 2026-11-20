import type { meetingSummaries } from "../drizzle/schema";
import type { ModeloDeResumo } from "@shared/modelos-de-resumo";

/**
 * O que muda no prompt do resumo guardado com o modelo (H4d do plano do
 * gravador): uma frase de contexto e o que vai em cada seção. As seções, o
 * formato JSON, as quantidades, o idioma, a regra das vozes, a do responsável
 * composto e a do trecho literal são os mesmos em todos
 * (server/resumo-da-reuniao.ts): a conferência de cada item não muda com o
 * modelo, e a tela mostra todos do mesmo jeito.
 *
 * O "Geral" é o resumo de antes dos modelos, letra por letra, já com as
 * regras da IA2 (até 7 ações, o rótulo da voz que fala, o responsável
 * composto e o trecho sem "[...]" entre partes distantes), que valem também
 * para os outros quatro.
 */

// A lista da tela (shared/modelos-de-resumo.ts) é a mesma do enum da coluna
// meeting_summaries.template: um modelo novo que entre só num dos dois lados
// quebra o `pnpm check` aqui.
type ModeloDoBanco = (typeof meetingSummaries.$inferSelect)["template"];
type MesmoConjunto<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const LISTAS_IGUAIS: MesmoConjunto<ModeloDoBanco, ModeloDeResumo> = true;
void LISTAS_IGUAIS;

export type InstrucaoDoModelo = {
  /** A frase que diz à IA que tipo de reunião é, e o que destacar; o Geral não tem. */
  contexto: string | null;
  acoes: string;
  foco: string;
  tarefas: string;
  decisoes: string;
  bloqueios: string;
  questoes: string;
};

// O que só foi dito pode virar item; o que se deduz do setor, do cargo ou do
// porte de alguém, não (a regra da demanda expressa, CLAUDE.md da raiz). Vale
// para os modelos que falam do que as pessoas oferecem e procuram.
const SO_O_QUE_FOI_DECLARADO = "Registre só a necessidade que a pessoa declarou na conversa; nunca a deduza do setor, do cargo, do porte ou da empresa de alguém.";
const RESPONSAVEL_E_PRAZO = "\"responsavel\" e \"prazo\" só se foram ditos; se não, null.";
const SEM_FOCO = "Sem foco claro, texto e trecho vazios.";
// Quantas ações (IA2, achado 4 da bancada de texto de 16/11): todas as
// combinadas, até 7, o teto da seção (SECOES, em resumo-da-reuniao.ts), e não
// de 3 a 5. Vale para todo modelo, não só para o Geral.
const ATE_7_ACOES = "até 7 (com mais, os 7 mais importantes)";

export const INSTRUCOES_DOS_MODELOS: Record<ModeloDeResumo, InstrucaoDoModelo> = {
  general: {
    contexto: null,
    acoes: `todos os próximos passos concretos combinados, ${ATE_7_ACOES}, cada um uma frase curta no imperativo ("Enviar a proposta revisada"). ${RESPONSAVEL_E_PRAZO}`,
    foco: `um parágrafo de 2 a 4 frases sobre o foco do trabalho na reunião. ${SEM_FOCO}`,
    tarefas: "um item por assunto tratado, na ordem da reunião: \"assunto\" curto (até 6 palavras) e \"texto\" com 2 a 4 frases sobre o que foi combinado, quem ficou responsável e os prazos ditos.",
    decisoes: "o que foi decidido ou mudou de escopo.",
    bloqueios: "bloqueios, dependências e restrições citados.",
    questoes: "o que ficou em aberto.",
  },
  networking: {
    contexto: `Modelo Networking: é uma conversa para as pessoas se conhecerem e abrirem oportunidades. Destaque quem é cada pessoa, o que cada uma disse que oferece e o que disse que procura, e as apresentações e os contatos combinados. ${SO_O_QUE_FOI_DECLARADO}`,
    acoes: `todos os próximos passos da conexão combinados, ${ATE_7_ACOES}, cada um uma frase curta no imperativo ("Apresentar a importadora de Hamburgo", "Enviar o portfólio"): apresentações a fazer, contatos a enviar e encontros a marcar. ${RESPONSAVEL_E_PRAZO}`,
    foco: `um parágrafo de 2 a 4 frases sobre quem conversou, como cada pessoa se apresentou e o objetivo da conversa. ${SEM_FOCO}`,
    tarefas: "um item por pessoa ou oportunidade tratada, na ordem da reunião: \"assunto\" curto (até 6 palavras: a pessoa, a empresa ou a oportunidade) e \"texto\" com 2 a 4 frases sobre o que ela disse que oferece, o que disse que procura e o que ficou combinado entre as partes.",
    decisoes: "o que as pessoas combinaram entre si: parcerias, indicações e próximos encontros.",
    bloqueios: "o que impede ou adia a conexão: condições, informações que faltam e restrições citadas.",
    questoes: "o que ficou de ser respondido ou confirmado por alguém.",
  },
  mentoring: {
    contexto: "Modelo Mentoria: é uma sessão de mentoria. Destaque os desafios que a pessoa mentorada trouxe, os conselhos e as recomendações que recebeu e os compromissos que ela assumiu.",
    acoes: `todos os compromissos de desenvolvimento combinados para antes do próximo encontro, ${ATE_7_ACOES}, cada um uma frase curta no imperativo ("Rever o plano de negócios", "Ler o livro indicado"). ${RESPONSAVEL_E_PRAZO}`,
    foco: `um parágrafo de 2 a 4 frases sobre o desafio ou o objetivo central trazido para a sessão. ${SEM_FOCO}`,
    tarefas: "um item por tema discutido, na ordem da reunião: \"assunto\" curto (até 6 palavras) e \"texto\" com 2 a 4 frases sobre a situação contada, o conselho ou a recomendação dada e os recursos indicados (livros, cursos, ferramentas ou pessoas).",
    decisoes: "o que a pessoa mentorada decidiu fazer ou mudar.",
    bloqueios: "as dificuldades, os receios e os obstáculos citados.",
    questoes: "as perguntas que ficaram para pensar ou para o próximo encontro.",
  },
  sales: {
    contexto: `Modelo Vendas: é uma conversa comercial. Destaque o que o cliente disse que precisa, a solução apresentada, o preço e as condições, as objeções e o próximo passo da venda. ${SO_O_QUE_FOI_DECLARADO}`,
    acoes: `todos os próximos passos comerciais combinados, ${ATE_7_ACOES}, cada um uma frase curta no imperativo ("Enviar a proposta com o desconto combinado", "Marcar a demonstração"). ${RESPONSAVEL_E_PRAZO}`,
    foco: `um parágrafo de 2 a 4 frases sobre o que o cliente procura e em que ponto está a negociação. ${SEM_FOCO}`,
    tarefas: "um item por tema da negociação, na ordem da reunião: \"assunto\" curto (até 6 palavras: a necessidade, a solução, o preço, as condições, o prazo de entrega...) e \"texto\" com 2 a 4 frases sobre o que foi dito e combinado.",
    decisoes: "o que foi acordado: preço, escopo, condições e prazos.",
    bloqueios: "objeções, limites de orçamento, aprovações que faltam e concorrentes citados.",
    questoes: "as dúvidas do cliente que ficaram sem resposta e o que ele ainda precisa confirmar.",
  },
  one_on_one: {
    contexto: "Modelo 1:1: é uma conversa individual, em geral entre uma líder e uma pessoa da equipe. Destaque o andamento do trabalho, as prioridades, o feedback dado e recebido e o apoio pedido.",
    acoes: `todos os combinados para antes da próxima conversa, ${ATE_7_ACOES}, cada um uma frase curta no imperativo ("Entregar o relatório revisado", "Marcar a conversa com o financeiro"). ${RESPONSAVEL_E_PRAZO}`,
    foco: `um parágrafo de 2 a 4 frases sobre as prioridades da pessoa no período. ${SEM_FOCO}`,
    tarefas: "um item por assunto tratado, na ordem da reunião: \"assunto\" curto (até 6 palavras) e \"texto\" com 2 a 4 frases sobre o andamento, o feedback e o que ficou combinado.",
    decisoes: "o que ficou decidido: prioridades e mudanças de responsabilidade ou de prazo.",
    bloqueios: "os impedimentos citados e o apoio que a pessoa pediu.",
    questoes: "o que ficou para a próxima conversa.",
  },
};
