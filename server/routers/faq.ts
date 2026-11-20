import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { invokeLLM } from "../_core/llm";
import { chaveDeRede, ipDaCliente } from "../ip-da-cliente";
import { ENVIO_UNICO_BYTES_MAX, ENVIO_UNICO_SEGUNDOS_MAX, GRAVACAO_EM_PARTES_SEGUNDOS_MAX, PRAZO_DO_AVISO_DE_HORA_MS } from "@shared/const";

// O ask é público e cada chamada custa uma requisição de LLM. Sem um teto
// próprio, qualquer visitante anônimo podia disparar até o limite da API
// (hoje 1200 req/min por IP) contra a conta do provedor. Janela deslizante em
// memória: suficiente para a instância única do Render. Por IP real
// (ip-da-cliente.ts): com o primeiro item do X-Forwarded-For, bastava trocá-lo
// a cada pergunta. 60 por minuto porque uma sala inteira no mesmo wi-fi divide
// o mesmo IP (se a apresentação convidar a testar a assistente, 20 acabavam no
// primeiro minuto); o Gemini pago aguenta 1000 por minuto.
export const FAQ_LIMIT = 60;
const FAQ_WINDOW_MS = 60_000;
const faqCalls = new Map<string, number[]>();

function assertFaqRate(ip: string) {
  const now = Date.now();
  const recent = (faqCalls.get(ip) ?? []).filter(t => now - t < FAQ_WINDOW_MS);
  if (recent.length >= FAQ_LIMIT) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Muitas perguntas em sequência. Aguarde um minuto e tente de novo." });
  }
  recent.push(now);
  faqCalls.set(ip, recent);
  if (faqCalls.size > 5000) faqCalls.clear();
}

// O idioma em que a IA deve responder. A chave é o código do seletor da Home
// (client/src/i18n/index.ts) e o valor é o nome do idioma DENTRO do prompt,
// que é escrito em português.
//
// Vem do cliente porque o servidor não tem como saber o idioma da tela: não há
// cabeçalho de idioma tratado em lugar nenhum e `users` não tem coluna de
// idioma. Desconhecido ou ausente cai no português do Brasil, que é o
// fallback do próprio i18n.
const IDIOMA_DA_RESPOSTA: Record<string, string> = {
  "pt-BR": "português do Brasil",
  en: "inglês",
  es: "espanhol",
  fr: "francês",
  ar: "árabe",
  zh: "chinês simplificado",
  hi: "híndi",
  de: "alemão",
  ja: "japonês",
  ru: "russo",
};

// Os números da gravação no prompt saem das constantes que a tela e o servidor
// aplicam (G13b): a gravação em partes vai até 12 h, com o aviso de hora; o
// arquivo em MP3 vai em partes, também até 12 h (H9a), e os outros formatos
// seguem no envio único (10 minutos e 10 MB). Escritos à mão, já ficaram para
// trás uma vez ("reuniões de até 10 minutos").
const HORAS_DE_GRAVACAO = GRAVACAO_EM_PARTES_SEGUNDOS_MAX / 3600;
const MINUTOS_DO_AVISO_DE_HORA = PRAZO_DO_AVISO_DE_HORA_MS / 60_000;
const MINUTOS_DO_ARQUIVO = ENVIO_UNICO_SEGUNDOS_MAX / 60;
const MB_DO_ARQUIVO = ENVIO_UNICO_BYTES_MAX / (1024 * 1024);

// ============================================================
// FAQ COM IA
// ============================================================
export const faqRouter = router({
  ask: publicProcedure
    .input(z.object({
      question: z.string().min(1).max(500),
      idioma: z.string().max(10).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertFaqRate(chaveDeRede(ipDaCliente(ctx.req)));
      const idiomaDaResposta = IDIOMA_DA_RESPOSTA[input.idioma ?? ""] ?? IDIOMA_DA_RESPOSTA["pt-BR"];
      const systemPrompt = `Você é a assistente virtual da plataforma WRW — Women Rocking the World — uma rede de negócios para pessoas empreendedoras e líderes de negócios. Responda perguntas sobre a plataforma de forma clara, amigável e concisa (máximo 3 parágrafos curtos).

Informações sobre a plataforma:
- Nome: WRW, por extenso Women Rocking the World. É marca e não se traduz. A plataforma já se chamou MMM; se perguntarem por esse nome, explique que é a mesma plataforma, hoje WRW, e use sempre WRW
- Níveis de membro: Bronze e Prata medem a qualificação das informações do perfil, não são planos. Todo cadastro começa Bronze (perfil em qualificação) e passa a Prata automaticamente quando Quem Sou, O Que Tenho e O Que Preciso estão completos e com conteúdo. Bronze e Prata têm os mesmos acessos e não pagam mensalidade: a plataforma participa dos negócios efetivamente concretizados por sua intermediação, conforme as condições aplicáveis a cada operação (não informe percentual)
- Ouro é a categoria premium, mediante mensalidade, com acesso em primeira mão a oportunidades selecionadas, conexões estratégicas, Deal Rooms, encontros estratégicos e painel de governança. Não é evolução automática da Prata. Não informe preço nem diga que dá para assinar pela plataforma: o valor e a cobrança ainda não existem nela; hoje o Status Ouro é concedido por membros Ouro
- Deal Room: sala de negociação privada protegida por NDA (Acordo de Confidencialidade). Ambas as partes assinam digitalmente antes de iniciar o chat
- NDA: Termo de Confidencialidade que protege todas as informações trocadas na Deal Room
- Oportunidades: propostas de sociedade, investimento, mentoria, parceria, projetos e vagas publicadas por membros
- A plataforma usa IA para sugerir conexões entre perfis e oportunidades (conexões sugeridas); quando duas pessoas demonstram interesse uma na outra, elas criam uma conexão. Chame isso sempre de "conexão", nunca de "match" (Smart Match e Business Match são nomes próprios e continuam assim). Conexões sugeridas e conexões criadas por interesse mútuo existem em todos os níveis (Bronze, Prata e Ouro); não confunda com as Conexões Estratégicas, rede exclusiva do Status Ouro
- Segurança: acesso com login, bloqueio automático de tentativas de acesso suspeitas, verificação de identidade (SIVC) e sistema de confiança com índice de confiabilidade. Não afirme que existe criptografia de ponta a ponta: ela não existe
- Meu Network Inteligente: a pessoa grava reuniões gratuitamente, cada uma com até ${HORAS_DE_GRAVACAO} horas: a cada hora de gravação, a plataforma pede que ela confirme que a gravação continua e, sem a confirmação em ${MINUTOS_DO_AVISO_DE_HORA} minutos, a gravação para e o que foi gravado segue para a transcrição; um arquivo de áudio pronto também pode ser enviado: em MP3, com até ${HORAS_DE_GRAVACAO} horas; nos outros formatos, com até ${MINUTOS_DO_ARQUIVO} minutos e ${MB_DO_ARQUIVO} MB; a IA transcreve e sugere os contatos citados, que ficam na rede particular dela, privados por padrão; a plataforma cruza o que cada contato tem e procura para mostrar oportunidades entre pessoas que ela já conhece. Se quiser, ela pode disponibilizar cada contato para oportunidades da rede, de forma anonimizada: a opção começa em NÃO e pode voltar a NÃO quando ela quiser; com SIM, e com o termo do Smart Match aceito, a rede enxerga só um ID anônimo e o que o contato tem e o que precisa, nunca nome, telefone, e-mail, áudio, transcrição ou notas, e a plataforma procura conexões com contatos disponibilizados por outras pessoas e com membros da plataforma. Toda conexão identificada fica registrada com a origem, as etapas e o status da comissão; nenhum percentual, valor ou cobrança é aplicado automaticamente (não informe percentual). Não prometa planos pagos nem minutos extras: ainda não existem
- Conexões Estratégicas: rede de contatos exclusiva para membros Ouro
- Líderes Nacionais: membros nomeados por Ouro para representar a plataforma em suas regiões
- Plataforma disponível em 10 idiomas

Responda SEMPRE em ${idiomaDaResposta}, de forma acolhedora e profissional, qualquer que seja o idioma da pergunta. Seja direta e objetiva. Não traduza os nomes próprios da plataforma: WRW, Women Rocking the World, Deal Room, NDA, Smart Match e Business Match.`;
      const response = await invokeLLM({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: input.question },
        ],
      });
      const answer = response.choices?.[0]?.message?.content;
      // Sem texto do modelo não há resposta para mostrar. Lançar deixa a
      // mensagem com a TELA, que a escreve no idioma da visitante
      // (`faq.askError`); a frase fixa que ficava aqui saía em português nos
      // dez idiomas, justamente na caixa que acabou de responder em outro.
      if (!answer) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "A IA não devolveu resposta." });
      }
      return { answer };
    }),
});
