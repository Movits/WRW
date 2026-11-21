import { TRPCError } from "@trpc/server";
import { hasValidConsent } from "./consent";
import { recalculatePrivateMatches, slugifyMatchTag } from "../match-service";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  getActiveEnrichmentSession, createEnrichmentSession, getEnrichmentMessages,
  saveEnrichmentMessage, saveEnrichmentSuggestions, getEnrichmentSuggestion,
  applyEnrichmentSuggestion, ignoreEnrichmentSuggestion, completeEnrichmentSession,
  getEnrichmentHistory, getEnrichmentSessionById, advanceEnrichmentSession,
  getPendingEnrichmentSuggestions, undoEnrichmentSuggestion, criarContextoOferecido,
} from "../db";
import { contextoParaOferecer } from "../contexto-oferecido";
import {
  dizQueNaoSabe, ENRICHMENT_STEPS, getEnrichmentStep, indiceDaEtapaDoCampo, isExpectedField, isSkipResponse, limiteDoValor,
  type EnrichmentField,
} from "../enrichment-flow";

// A IA tem um teto por chamada e um orçamento total (com as retentativas):
// a tela fica em "pensando" com o campo travado enquanto o servidor espera, e
// a spec da etapa 4 pede resposta ou erro claro em segundos, não em minutos.
const TIMEOUT_DA_IA_MS = 15_000;
const ORCAMENTO_DA_IA_MS = 35_000;

// Etapas que pedem uma LISTA ("o que oferece", "o que procura"): cada item
// vira um cartão. As demais têm um valor só (um telefone, uma empresa).
const ETAPAS_DE_LISTA: ReadonlySet<EnrichmentField> = new Set<EnrichmentField>(["assets", "needs"]);
const TETO_DE_CARTOES_POR_ETAPA = 10;

type Extraida = { field_type: string; value: string; confidence: number; display_label?: string; is_complete?: boolean };

// "Mina de lítio" e "mina de litio" são o mesmo item: a chave é o slug da tag
// (o mesmo que contact_assets usa) e, sem slug (escrita sem letras latinas
// que o slugify não cobre), o rótulo normalizado.
function semRepetidas(entidades: Extraida[]) {
  const vistas = new Set<string>();
  const unicas: Extraida[] = [];
  for (const e of entidades) {
    const chave = slugifyMatchTag(e.value) || e.value.trim().toLowerCase();
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    unicas.push(e);
    if (unicas.length >= TETO_DE_CARTOES_POR_ETAPA) break;
  }
  return unicas;
}

// O cartão como a tela o desenha. confidence é DECIMAL no banco (chega como
// string); a tela multiplica por 100, então precisa ser número.
const paraCartao = (s: { id: string; fieldType: string; suggestedValue: string; confidence: string | number }) => ({
  id: s.id,
  fieldType: s.fieldType,
  suggestedValue: s.suggestedValue,
  confidence: Number(s.confidence),
  status: "pending" as const,
});

// A pendência é POR ETAPA: só a sugestão da pergunta atual bloqueia e vira
// cartão. As de etapa anterior são órfãs (o defeito antigo deixou sessões com
// mais de uma pendente) — a lista chega da mais nova para a mais velha.
type Pendente = { id: string; fieldType: string; messageId: string | null; suggestedValue: string; confidence: string | number };
function separarPendentes<T extends Pendente>(pendentes: T[], fieldTypeDaEtapa: EnrichmentField) {
  const daEtapaAtual = pendentes.filter(p => isExpectedField(p.fieldType, fieldTypeDaEtapa));
  const orfas = pendentes.filter(p => !daEtapaAtual.includes(p));
  return { daEtapaAtual, orfas };
}

// Confirmar/ignorar só avança o roteiro se a sugestão responde à pergunta
// ATUAL da sessão; sessão encerrada ou sugestão de etapa anterior → null.
// Devolve também a etapa lida (questionsAnswered): é ela que o avanço exige
// no WHERE, para duas abas não avançarem a mesma etapa duas vezes.
async function etapaAtualDaSugestao(sessionId: string, ownerId: string, fieldType: string) {
  const session = await getEnrichmentSessionById(sessionId, ownerId);
  if (!session || session.status !== "active") return null;
  const etapa = session.questionsAnswered ?? 0;
  const step = getEnrichmentStep(etapa);
  return step && isExpectedField(fieldType, step.fieldType) ? { step, etapa, contactId: session.contactId } : null;
}

// ─── O dado de outra pergunta, dito antes da vez ──────────────────────────────
// "Não sei o telefone. O que ela tem para oferecer: Exportação de café." chega
// na pergunta do telefone e traz a resposta da pergunta do que ela oferece. A
// pendência continua POR ETAPA (só a pergunta da vez vira cartão agora): o
// dado de pergunta SEGUINTE fica guardado na mensagem da usuária
// (metadata.antecipadas) e vira cartão quando o roteiro chega à pergunta dele —
// a usuária confirma ou ignora ali, como qualquer outro cartão (nada extraído
// por IA entra sozinho). Antes ele sumia, e ela tinha de dizer tudo de novo
// (conferência de tela do pacote do match, 20/11/2026).
type Antecipada = { field_type: EnrichmentField; value: string; confidence: number };

const CONFIANCA_DO_CARTAO = 0.7;

/**
 * O que a IA devolveu para OUTRAS perguntas do roteiro, só as que ainda vêm (a
 * de antes já passou). Vale o que veio em `outros_campos` e o que veio em
 * `extracted_entities` com o campo de outra pergunta; o campo vai pelo nome da
 * pergunta (os apelidos de isExpectedField valem), com o teto e a confiança de
 * qualquer cartão.
 */
function antecipadasDaResposta(parsed: unknown, etapaAtual: number): Antecipada[] {
  const resposta = (parsed && typeof parsed === "object" ? parsed : {}) as { extracted_entities?: unknown; outros_campos?: unknown };
  const candidatas = [resposta.extracted_entities, resposta.outros_campos].flatMap(lista => (Array.isArray(lista) ? lista : []));
  const porCampo = new Map<EnrichmentField, Extraida[]>();
  for (const candidata of candidatas) {
    if (!candidata || typeof candidata !== "object") continue;
    const { field_type, value, confidence } = candidata as { field_type?: unknown; value?: unknown; confidence?: unknown };
    const indice = indiceDaEtapaDoCampo(String(field_type ?? ""));
    const valor = typeof value === "string" ? value.trim() : "";
    const confianca = Number(confidence);
    if (indice <= etapaAtual || !valor || !(confianca >= CONFIANCA_DO_CARTAO)) continue;
    const campo = ENRICHMENT_STEPS[indice].fieldType;
    porCampo.set(campo, [...(porCampo.get(campo) ?? []), { field_type: campo, value: valor, confidence: confianca }]);
  }
  return Array.from(porCampo.entries()).flatMap(([campo, itens]) =>
    (ETAPAS_DE_LISTA.has(campo) ? semRepetidas(itens) : itens.slice(-1)).map(item => ({ field_type: campo, value: item.value, confidence: item.confidence })));
}

/** As antecipadas da sessão para esta pergunta, na ordem em que foram ditas (na etapa de valor único, a última dita). */
async function antecipadasDaEtapa(sessionId: string, ownerId: string, fieldType: EnrichmentField): Promise<Extraida[]> {
  const mensagens = [...(await getEnrichmentMessages(sessionId, ownerId, 50))].reverse(); // cronológica
  const ditas: Extraida[] = mensagens.flatMap(mensagem => {
    const guardadas = (mensagem.metadata as { antecipadas?: unknown } | null)?.antecipadas;
    return (Array.isArray(guardadas) ? guardadas as Antecipada[] : [])
      .filter(antecipada => antecipada && typeof antecipada.value === "string" && antecipada.value.trim() && isExpectedField(String(antecipada.field_type), fieldType))
      .map(antecipada => ({ field_type: fieldType, value: antecipada.value.trim(), confidence: Number(antecipada.confidence) || CONFIANCA_DO_CARTAO }));
  });
  return ETAPAS_DE_LISTA.has(fieldType) ? semRepetidas(ditas) : ditas.slice(-1);
}

/**
 * Faz a pergunta da etapa `indice` (que acabou de chegar). Com antecipadas
 * para ela, a pergunta já vem com os cartões delas, na mesma mensagem — o que
 * getMessages devolve ao reidratar —, e a tela espera a decisão em vez do campo
 * de digitar.
 */
async function perguntarEtapa(sessionId: string, ownerId: string, contactId: number, indice: number, metadataExtra: Record<string, unknown> = {}) {
  const step = getEnrichmentStep(indice)!;
  const antecipadas = await antecipadasDaEtapa(sessionId, ownerId, step.fieldType);
  const pergunta = antecipadas.length
    ? `${step.question} Você já tinha contado isto antes: confirme o que vale ou ignore.`
    : step.question;
  const messageId = await saveEnrichmentMessage({
    sessionId, ownerId, role: "assistant", content: pergunta,
    metadata: {
      questionIndex: indice, fieldType: step.fieldType, ...metadataExtra,
      ...(antecipadas.length ? { awaitingConfirmation: true, deAntecipadas: true } : {}),
    },
  });
  if (!antecipadas.length) return { pergunta, messageId, cartoes: [] as ReturnType<typeof paraCartao>[] };
  const ids = await saveEnrichmentSuggestions(antecipadas.map(antecipada => ({
    sessionId, messageId, ownerId, contactId, fieldType: step.fieldType, suggestedValue: antecipada.value, confidence: antecipada.confidence,
  })));
  const cartoes = antecipadas.map((antecipada, i) => paraCartao({
    id: ids[i] ?? "", fieldType: step.fieldType, suggestedValue: antecipada.value, confidence: antecipada.confidence,
  }));
  return { pergunta, messageId, cartoes };
}

// Depois de decidir um cartão: o roteiro só anda quando não sobra NENHUM
// cartão da pergunta atual (as etapas de lista podem ter vários). Sobrando,
// a tela recebe quantos faltam e continua travada neles.
async function avancarOuEsperarOsOutros(sessionId: string, ownerId: string, fieldType: string, status: "applied" | "ignored", skipped: boolean) {
  const atual = await etapaAtualDaSugestao(sessionId, ownerId, fieldType);
  if (!atual) return { success: true, status, nextQuestion: null, sessionComplete: false, pendentesRestantes: 0 };
  const { step, etapa, contactId } = atual;

  const restantes = separarPendentes(await getPendingEnrichmentSuggestions(sessionId, ownerId), step.fieldType).daEtapaAtual;
  if (restantes.length > 0) {
    return { success: true, status, nextQuestion: null, sessionComplete: false, pendentesRestantes: restantes.length };
  }

  // Avança a etapa LIDA acima, sem reler: entre a checagem de pendentes e o
  // UPDATE, outra aba pode ter confirmado o outro último cartão e avançado —
  // relendo, as duas avançariam (2 → 4, pulando uma pergunta).
  const advanced = await advanceEnrichmentSession(sessionId, ownerId, etapa, skipped);
  // Outra aba avançou primeiro: a pergunta seguinte já está gravada por ela;
  // esta tela a recebe ao reidratar (getMessages), sem duplicar nem concluir.
  if (!advanced) return { success: true, status, nextQuestion: null, sessionComplete: false, pendentesRestantes: 0 };
  const nextStep = getEnrichmentStep(advanced.questionsAnswered);
  if (!nextStep) {
    await completeEnrichmentSession(sessionId, ownerId, "Cadastro enriquecido com sucesso!");
    return { success: true, status, nextQuestion: null, sessionComplete: true, pendentesRestantes: 0 };
  }
  // A pergunta seguinte, com os cartões do que a usuária já tinha dito para ela.
  const proxima = await perguntarEtapa(sessionId, ownerId, contactId, advanced.questionsAnswered);
  return {
    success: true, status, nextQuestion: proxima.pergunta, nextMessageId: proxima.messageId, nextSuggestions: proxima.cartoes,
    sessionComplete: false, pendentesRestantes: 0,
  };
}

// ─── Módulo de Enriquecimento com IA (Etapa 4) ────────────────────────────────
export const enrichmentRouter = router({
  // Verificar sessão ativa de um contato
  getActiveSession: protectedProcedure
    .input(z.object({ contactId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      return getActiveEnrichmentSession(ctx.user.openId, input.contactId);
    }),

  // Iniciar sessão de enriquecimento
  startSession: protectedProcedure
    .input(z.object({ contactId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await getActiveEnrichmentSession(ctx.user.openId, input.contactId);
      if (existing) throw new TRPCError({ code: "CONFLICT", message: "SESSION_ALREADY_ACTIVE" });
      const sessionId = await createEnrichmentSession(ctx.user.openId, input.contactId);
      const firstQuestion = ENRICHMENT_STEPS[0].question;
      const msgId = await saveEnrichmentMessage({
        sessionId, ownerId: ctx.user.openId, role: "assistant", content: firstQuestion,
        metadata: { questionIndex: 0, fieldType: ENRICHMENT_STEPS[0].fieldType },
      });
      return { sessionId, firstQuestion, firstMessageId: msgId };
    }),

  // Enviar mensagem e receber resposta da IA
  sendMessage: protectedProcedure
    .input(z.object({
      sessionId: z.string(),
      contactId: z.number().int(),
      content:   z.string().min(1).max(2000),
    }))
    .mutation(async ({ ctx, input }) => {
      const session = await getEnrichmentSessionById(input.sessionId, ctx.user.openId);
      if (!session || session.contactId !== input.contactId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "SESSION_NOT_FOUND" });
      }
      if (session.status !== "active") {
        return { messageId: null, aiResponse: null, suggestions: [], sessionComplete: true, completionSummary: session.summary, awaitingConfirmation: false };
      }
      const step = getEnrichmentStep(session.questionsAnswered ?? 0);
      if (!step) {
        await completeEnrichmentSession(input.sessionId, ctx.user.openId, "Cadastro enriquecido com sucesso!");
        return { messageId: null, aiResponse: null, suggestions: [], sessionComplete: true, completionSummary: "Cadastro enriquecido com sucesso!", awaitingConfirmation: false };
      }

      // Uma decisão por vez, POR ETAPA. Enquanto há cartão da pergunta atual
      // esperando confirmação, uma nova resposta geraria outra sugestão (órfã:
      // nunca decidida, nunca mostrada) — e "não sei" pularia a etapa por cima
      // dela. A tela recebe o código e reidrata a conversa com o cartão.
      // Pendente de etapa ANTERIOR é órfã do defeito antigo (ou de uma corrida
      // entre abas): sai do caminho como "ignorada" sem avançar o roteiro —
      // senão ressurgiria depois, bloquearia a conversa e avançaria a etapa
      // errada ao ser decidida.
      const { daEtapaAtual, orfas } = separarPendentes(await getPendingEnrichmentSuggestions(input.sessionId, ctx.user.openId), step.fieldType);
      for (const orfa of orfas) await ignoreEnrichmentSuggestion(orfa.id, ctx.user.openId);
      if (daEtapaAtual.length > 0) throw new TRPCError({ code: "CONFLICT", message: "SUGGESTION_PENDING" });

      // O instante da resposta é AGORA, mesmo que ela só vá para o banco depois
      // de a IA responder: gravada com o relógio de depois, empatava (ou
      // passava) a resposta da IA em created_at e a conversa reabria trocada.
      const mensagemDaUsuaria = { sessionId: input.sessionId, ownerId: ctx.user.openId, role: "user", content: input.content, createdAt: Date.now() };

      // Pular a pergunta da vez (a resposta da usuária já está gravada): a
      // seguinte, com os cartões do que ela já tinha dito para ela, ou o fim.
      const pularAPergunta = async () => {
        const advanced = await advanceEnrichmentSession(input.sessionId, ctx.user.openId, session.questionsAnswered ?? 0, true);
        // Outra aba avançou primeiro: nada a gravar; a tela reidrata pelo getMessages.
        if (!advanced) {
          return { messageId: null, aiResponse: null, suggestions: [], sessionComplete: false, completionSummary: null, awaitingConfirmation: false };
        }
        if (!getEnrichmentStep(advanced.questionsAnswered)) {
          await completeEnrichmentSession(input.sessionId, ctx.user.openId, "Cadastro enriquecido com sucesso!");
          return { messageId: null, aiResponse: null, suggestions: [], sessionComplete: true, completionSummary: "Cadastro enriquecido com sucesso!", awaitingConfirmation: false };
        }
        const proxima = await perguntarEtapa(input.sessionId, ctx.user.openId, session.contactId, advanced.questionsAnswered, { skippedPrevious: true });
        return {
          messageId: proxima.messageId, aiResponse: proxima.pergunta, suggestions: proxima.cartoes, sessionComplete: false, completionSummary: null,
          awaitingConfirmation: proxima.cartoes.length > 0,
        };
      };

      // "Não sei" avança diretamente sem abrir confirmação nem repetir a pergunta anterior.
      if (isSkipResponse(input.content)) {
        await saveEnrichmentMessage(mensagemDaUsuaria);
        return pularAPergunta();
      }

      // Buscar histórico das últimas 10 mensagens (em ordem cronológica). A
      // resposta de agora ainda NÃO está gravada: entra no prompt em memória e
      // só vai para o banco depois de a IA responder — se a IA estourar o
      // tempo, a usuária reenvia sem a mensagem aparecer duas vezes.
      const history = await getEnrichmentMessages(input.sessionId, ctx.user.openId, 10);
      const historyAsc = [...history].reverse();

      const { invokeLLM } = await import("../_core/llm");
      const systemPrompt = `Você é o Assistente de Enriquecimento da WRW (Women Rocking the World). Sua única função é extrair dados estruturados de respostas em português e conduzir um roteiro de 6 perguntas.

ROTEIRO OBRIGATÓRIO (nunca fuja disso):
1. phone → "Qual é o telefone dele/dela?"
2. company → "Em qual empresa trabalha?"
3. assets → "O que essa pessoa pode oferecer? (ex: mina, fábrica, patente, acesso)"
4. needs → "O que ela está procurando? (ex: investidores, parceiros, compradores)"
5. how_met → "Como vocês se conheceram?"
6. relationship_type → "O relacionamento é pessoal, profissional ou ambos?"

REGRAS DE OURO:
- Extraia SOMENTE o que a pessoa disse. NUNCA deduza o que a pessoa oferece ou procura a partir do setor, porte, cargo, localização ou atividade da empresa: necessidade presumida não é dado, e nada entra em "assets" ou "needs" sem ter sido dito.
- Se o usuário responder algo relevante a uma pergunta do roteiro, EXTRAIA a entidade imediatamente.
- Se a resposta for vaga (ex: "tem uma empresa"), PERGUNTE O NOME em vez de aceitar.
- Se o usuário disser "não sei", pule para a próxima pergunta do roteiro.
- NUNCA diga "Pode me contar mais sobre esta pessoa?" — isso é proibido. Seja específico.
- SEMPRE responda em JSON válido. NUNCA adicione texto fora do JSON.

NESTE TURNO, extraia em "extracted_entities" SOMENTE o campo "${step.fieldType}". Não avance o roteiro; a interface avançará após uma única confirmação de quem responde.
Se a resposta TAMBÉM disser, com todas as letras, o dado de outra pergunta do roteiro (ex.: "Não sei o telefone. Ela oferece exportação de café."), ponha esse dado em "outros_campos", com o field_type daquela pergunta; ele não entra agora, só vira confirmação quando o roteiro chegar lá. Nada deduzido, como nas regras de ouro; sem dado de outra pergunta, "outros_campos" fica vazio.
FORMATO DE SAÍDA (JSON obrigatório):
{"next_question": null, "extracted_entities": [{"field_type": "${step.fieldType}", "value": "valor extraído da resposta", "confidence": 0.9, "is_complete": true}], "outros_campos": [{"field_type": "campo de outra pergunta do roteiro", "value": "valor dito", "confidence": 0.9}], "pending_fields": ["array dos campos ainda não respondidos"], "session_status": "active", "notes_for_user": "texto curto e direto para confirmar o valor, máximo 15 palavras"}`;

      const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
        { role: "system", content: systemPrompt },
        ...historyAsc.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
        { role: "user", content: input.content },
      ];

      let falhaDaIA: string | null = null;
      const aiResp = await invokeLLM({ messages, timeoutMs: TIMEOUT_DA_IA_MS, orcamentoMs: ORCAMENTO_DA_IA_MS }).catch((erro: unknown) => {
        falhaDaIA = erro instanceof Error ? erro.message : String(erro);
        return null;
      });

      // IA fora do ar NÃO é "não entendi". A versão anterior engolia o erro e
      // caía no ramo que repete a pergunta — a usuária respondia para sempre,
      // recebendo a mesma pergunta, sem nenhum sinal de que o problema era o
      // sistema. Dizer a verdade custa uma frase.
      if (falhaDaIA !== null) {
        console.warn("[Enriquecimento] IA indisponível:", falhaDaIA);
        const aviso =
          "O assistente de IA está indisponível neste momento, então sua resposta ainda não foi processada. Tente de novo em instantes.";
        const messageId = await saveEnrichmentMessage({
          sessionId: input.sessionId, ownerId: ctx.user.openId, role: "assistant", content: aviso,
          metadata: { questionIndex: session.questionsAnswered, fieldType: step.fieldType, aiUnavailable: true },
        });
        // `aiUnavailable` avisa a tela de que a resposta da usuária NÃO foi
        // gravada: ela devolve o texto ao campo para reenviar, em vez de
        // reidratar a conversa sem ele.
        return { messageId, aiResponse: aviso, suggestions: [], sessionComplete: false, completionSummary: null, awaitingConfirmation: false, aiUnavailable: true as const };
      }

      let aiText = `Confirme esta informação para continuar.`;
      let extracted: Extraida[] = [];
      let antecipadas: Antecipada[] = [];
      if (aiResp?.choices?.[0]?.message?.content) {
        try {
          const rawContent = aiResp.choices[0].message.content as string;
          const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
          const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawContent);
          if (parsed.notes_for_user) aiText = parsed.notes_for_user;
          if (parsed.extracted_entities) extracted = parsed.extracted_entities;
          antecipadas = antecipadasDaResposta(parsed, session.questionsAnswered ?? 0);
        } catch { /* usa defaults */ }
      }

      // A IA respondeu: agora a resposta da usuária é parte da conversa — com o
      // dado que ela já deu para uma pergunta seguinte, que vira cartão lá.
      await saveEnrichmentMessage(antecipadas.length ? { ...mensagemDaUsuaria, metadata: { antecipadas } } : mensagemDaUsuaria);

      // Não aceitar sugestões de pergunta anterior/seguinte. Na etapa de
      // lista, cada item da resposta ("uma mina, uma fábrica e a patente")
      // vira um cartão — antes só o 1º sobrevivia e os outros sumiam sem
      // aviso; nas demais etapas, um valor só.
      extracted = extracted.filter(entity => isExpectedField(entity.field_type, step.fieldType) && entity.value?.trim());
      extracted = ETAPAS_DE_LISTA.has(step.fieldType) ? semRepetidas(extracted) : extracted.slice(0, 1);
      if (extracted.length === 0) {
        // "Não sei o telefone." (com ou sem mais coisa na frase) pula como o
        // "não sei" sozinho: nada saiu da pergunta da vez e quem responde disse
        // que não sabe. Repetir a pergunta aqui a repetia para sempre.
        if (dizQueNaoSabe(input.content)) return pularAPergunta();
        const repeatQuestion = step.fieldType === "company"
          ? "Qual é o nome da empresa em que trabalha?"
          : step.question;
        const messageId = await saveEnrichmentMessage({
          sessionId: input.sessionId, ownerId: ctx.user.openId, role: "assistant", content: repeatQuestion,
          metadata: { questionIndex: session.questionsAnswered, fieldType: step.fieldType, needsClarification: true },
        });
        return { messageId, aiResponse: repeatQuestion, suggestions: [], sessionComplete: false, completionSummary: null, awaitingConfirmation: false };
      }

      // Só vira cartão o que tem confiança >= 0.7 — e isso é decidido ANTES de
      // salvar a resposta. A versão anterior decidia depois: devolvia
      // "aguardando confirmação" com zero cartões, a tela escondia o campo de
      // digitar e pedia para confirmar algo que não existia. Só recarregar a
      // página destravava a conversa.
      const suggestions = extracted.filter(e => e.confidence >= 0.7);
      if (suggestions.length === 0) {
        const pedido = "Não tenho certeza se entendi. Pode dizer de outro jeito?";
        const messageId = await saveEnrichmentMessage({
          sessionId: input.sessionId, ownerId: ctx.user.openId, role: "assistant", content: pedido,
          metadata: { questionIndex: session.questionsAnswered, fieldType: step.fieldType, needsClarification: true, lowConfidence: true },
        });
        return { messageId, aiResponse: pedido, suggestions: [], sessionComplete: false, completionSummary: null, awaitingConfirmation: false };
      }

      // Salvar resposta da IA
      const aiMsgId = await saveEnrichmentMessage({
        sessionId: input.sessionId, ownerId: ctx.user.openId, role: "assistant", content: aiText,
        metadata: { extracted_entities: extracted, questionIndex: session.questionsAnswered, fieldType: step.fieldType, awaitingConfirmation: true },
      });

      const suggestionIds = await saveEnrichmentSuggestions(suggestions.map(e => ({
        sessionId: input.sessionId, messageId: aiMsgId, ownerId: ctx.user.openId,
        contactId: input.contactId, fieldType: e.field_type, suggestedValue: e.value,
        confidence: e.confidence,
      })));

      return {
        messageId: aiMsgId,
        aiResponse: aiText,
        suggestions: suggestions.map((e, i) => ({
          id: suggestionIds[i] ?? "",
          fieldType: e.field_type,
          suggestedValue: e.value,
          confidence: e.confidence,
          displayLabel: e.display_label,
          status: "pending",
        })),
        sessionComplete: false,
        completionSummary: null,
        awaitingConfirmation: true,
      };
    }),

  // Confirmar sugestão
  confirmSuggestion: protectedProcedure
    .input(z.object({ suggestionId: z.string(), editedValue: z.string().max(2000).optional() }))
    .mutation(async ({ ctx, input }) => {
      // A sugestão vem ANTES de aplicar: o teto depende do campo de destino
      // (phone varchar(50), company varchar(200)...), e estourar a coluna no
      // UPDATE virava um erro genérico que nem a tela nem a usuária entendiam.
      const sug = await getEnrichmentSuggestion(input.suggestionId, ctx.user.openId);
      if (!sug) throw new TRPCError({ code: "NOT_FOUND", message: "SUGGESTION_NOT_FOUND" });
      const valor = (input.editedValue ?? sug.suggestedValue).trim();
      if (!valor) throw new TRPCError({ code: "BAD_REQUEST", message: "Informe um valor antes de salvar." });
      const limite = limiteDoValor(sug.fieldType);
      if (valor.length > limite) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Valor muito longo para este campo: no máximo ${limite} caracteres.` });
      }

      const ok = await applyEnrichmentSuggestion(input.suggestionId, ctx.user.openId, input.editedValue);
      if (!ok) throw new TRPCError({ code: "NOT_FOUND", message: "SUGGESTION_NOT_FOUND" });

      // A resposta acabou de virar "o que possui" ou "o que procura": recalcular
      // aqui é o que fecha o circuito automático — a pessoa conversa, o item
      // entra, o match nasce, sem passar pela tela de matches.
      //
      // Etapa 11: o recálculo é CRUZAMENTO, e cruzamento exige o termo aceito.
      // Sem consentimento vigente, a resposta fica gravada no contato (isso é
      // dado da agenda, não cruzamento) e o recálculo acontece quando a pessoa
      // autorizar e clicar em atualizar. Falha de recálculo não desfaz o aceite
      // da sugestão: o dado dela já está seguro.
      if (sug.fieldType === "assets" || sug.fieldType === "needs") {
        try {
          if (await hasValidConsent(ctx.user.id, "termo_smart_match")) {
            // Meu Network Inteligente, item 16: a conexão interna que acabou
            // de nascer é registrada pela plataforma no fim do próprio recálculo.
            await recalculatePrivateMatches(ctx.user.openId, ctx.user.email);
          }
        } catch (erro) {
          console.warn("[Enriquecimento] Recálculo adiado:", erro instanceof Error ? erro.message : erro);
        }
      }

      // O roteiro só avança se a sugestão é da pergunta ATUAL (uma órfã de
      // etapa anterior decidida aqui gravou o dado, mas não conta como
      // resposta da pergunta na tela) e se não sobrou outro cartão dela.
      const avanco = await avancarOuEsperarOsOutros(sug.sessionId, ctx.user.openId, sug.fieldType, "applied", false);

      // "Como se conheceram" que não casou com contexto nenhum ficou só na nota.
      // Nada é criado aqui: o nome volta para o chat perguntar "Criar o contexto
      // X?", e só o sim explícito da dona (createSuggestedContext) cria.
      if (sug.fieldType === "how_met") {
        const nome = contextoParaOferecer(await getEnrichmentSuggestion(input.suggestionId, ctx.user.openId));
        if (nome) return { ...avanco, contextoParaCriar: nome };
      }
      return avanco;
    }),

  // O "Criar" da pergunta "Criar o contexto X?". Recebe só o id da sugestão: o
  // nome é relido no servidor, a partir do que a dona confirmou no cartão.
  createSuggestedContext: protectedProcedure
    .input(z.object({ suggestionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const r = await criarContextoOferecido(input.suggestionId, ctx.user.openId);
      if (r.resultado === "indisponivel") {
        throw new TRPCError({ code: "NOT_FOUND", message: "CONTEXT_OFFER_NOT_AVAILABLE" });
      }
      return r;
    }),

  // Ignorar sugestão
  ignoreSuggestion: protectedProcedure
    .input(z.object({ suggestionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const ok = await ignoreEnrichmentSuggestion(input.suggestionId, ctx.user.openId);
      if (!ok) throw new TRPCError({ code: "NOT_FOUND", message: "SUGGESTION_NOT_FOUND" });
      const sug = await getEnrichmentSuggestion(input.suggestionId, ctx.user.openId);
      if (!sug) return { success: true, status: "ignored", nextQuestion: null, sessionComplete: false, pendentesRestantes: 0 };
      // Órfã de etapa anterior sai de cena sem pular a pergunta atual; com
      // outro cartão da mesma pergunta ainda pendente, a etapa espera por ele.
      return avancarOuEsperarOsOutros(sug.sessionId, ctx.user.openId, sug.fieldType, "ignored", true);
    }),

  // Desfazer uma sugestão aplicada: reverte o que ela gravou no contato
  undoSuggestion: protectedProcedure
    .input(z.object({ suggestionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const r = await undoEnrichmentSuggestion(input.suggestionId, ctx.user.openId);
      if (r.resultado === "nao_encontrada") throw new TRPCError({ code: "NOT_FOUND", message: "SUGGESTION_NOT_FOUND" });
      // Já desfeita (antes, ou por outra aba agora): a tela que ainda mostra o
      // botão está desatualizada — recarrega o histórico e diz o porquê.
      if (r.resultado === "ja_desfeita") throw new TRPCError({ code: "NOT_FOUND", message: "SUGGESTION_ALREADY_UNDONE" });
      // Ignorada, ou aplicada antes de o recurso existir (sem retrato do valor
      // anterior): não há o que reverter.
      if (r.resultado === "indisponivel") throw new TRPCError({ code: "BAD_REQUEST", message: "UNDO_UNAVAILABLE" });

      // Uma tag saiu de possui/procura: os matches que nasceram dela precisam
      // morrer junto. Mesma trava do confirmar (cruzamento exige o termo),
      // sem e-mail — remover não é uma oportunidade nova.
      if (r.kind === "tag") {
        try {
          if (await hasValidConsent(ctx.user.id, "termo_smart_match")) {
            await recalculatePrivateMatches(ctx.user.openId);
          }
        } catch (erro) {
          console.warn("[Enriquecimento] Recálculo adiado após desfazer:", erro instanceof Error ? erro.message : erro);
        }
      }
      return { success: true, status: "undone", reverted: r.reverted, motivo: r.motivo };
    }),

  // Concluir sessão manualmente
  completeSession: protectedProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const ok = await completeEnrichmentSession(input.sessionId, ctx.user.openId, "Sessão concluída pelo usuário.");
      if (!ok) throw new TRPCError({ code: "NOT_FOUND", message: "SESSION_NOT_FOUND" });
      return { success: true };
    }),

  // Histórico de enriquecimento de um contato
  getHistory: protectedProcedure
    .input(z.object({ contactId: z.number().int(), page: z.number().int().min(1).default(1), limit: z.number().int().min(1).max(100).default(20) }))
    .query(async ({ ctx, input }) => {
      const offset = (input.page - 1) * input.limit;
      return getEnrichmentHistory(ctx.user.openId, input.contactId, input.limit, offset);
    }),

  // Buscar mensagens de uma sessão
  getMessages: protectedProcedure
    .input(z.object({ sessionId: z.string(), limit: z.number().int().min(1).max(50).default(20) }))
    .query(async ({ ctx, input }) => {
      const msgs = await getEnrichmentMessages(input.sessionId, ctx.user.openId, input.limit);
      // A mensagem da pergunta atual leva os cartões que ainda esperam decisão:
      // é o que faz a confirmação pendente sobreviver a fechar e reabrir o
      // detalhe do contato. Só as pendentes da ETAPA ATUAL viram cartão (todas
      // elas: a etapa de lista pode ter vários) — órfã de etapa anterior fica
      // fora e é resolvida pelo sendMessage.
      const session = await getEnrichmentSessionById(input.sessionId, ctx.user.openId);
      const step = session?.status === "active" ? getEnrichmentStep(session.questionsAnswered ?? 0) : null;
      const pendentes = step ? await getPendingEnrichmentSuggestions(input.sessionId, ctx.user.openId) : [];
      // Da mais velha para a mais nova: a ordem em que a IA as listou.
      const cartoes = step ? [...separarPendentes(pendentes, step.fieldType).daEtapaAtual].reverse() : [];
      return [...msgs].reverse().map(m => ({ // cronológica
        ...m,
        suggestions: cartoes.filter(c => c.messageId === m.id).map(paraCartao),
      }));
    }),
});
