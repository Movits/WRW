import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Send, Check, Edit2, X, Sparkles, ChevronDown, ChevronUp, Clock } from "lucide-react";

// ─── Tipos ────────────────────────────────────────────────────────────────────
type Suggestion = {
  id: string;
  fieldType: string;
  suggestedValue: string;
  confidence: number;
  displayLabel?: string;
  status: "pending" | "confirmed" | "edited" | "ignored" | "applied";
};

type Message = {
  id: string;
  role: "assistant" | "user";
  content: string;
  suggestions?: Suggestion[];
};

// ─── Labels amigáveis por field_type ─────────────────────────────────────────
// Os rótulos já existiam traduzidos nos dez idiomas (`network.campo*IA`, feitos
// para ESTE cartão) e não eram usados: o mapa repetia tudo em português fixo, e
// era isso que a usuária lia em qualquer idioma. Agora ele guarda a CHAVE.
const FIELD_LABEL_KEYS: Record<string, string> = {
  phone: "network.campoTelefoneIA", whatsapp: "network.campoWhatsappIA", email: "network.campoEmailIA",
  company: "network.campoEmpresaIA", job_title: "network.campoCargoIA", city: "network.campoCidadeIA",
  country: "network.campoPaisIA", linkedin_url: "network.campoLinkedinIA", instagram_handle: "network.campoInstagramIA",
  asset_tag: "network.campoAtivoIA", need_tag: "network.campoNecessidadeIA", context_link: "network.campoContextoIA",
  relationship_type: "network.campoRelacionamentoIA", notes: "network.campoNotasIA",
  // Os campos com o nome da PERGUNTA do roteiro (server/enrichment-flow.ts), que é o que o servidor grava no cartão
  // dessas etapas: sem eles, o cartão do que a pessoa oferece saía rotulado "assets", em inglês e cru.
  assets: "network.campoAtivoIA", needs: "network.campoNecessidadeIA", how_met: "network.campoContextoIA",
};

// ─── Card de sugestão ─────────────────────────────────────────────────────────
// O cartão NÃO se esconde sozinho ao clicar: fica na tela até o servidor
// responder, e é o pai quem muda o status da sugestão (applied/ignored) no
// sucesso. Antes ele sumia antes da resposta; se a confirmação falhava, a
// conversa ficava sem cartão, sem campo de digitar e com o aviso "Confirme ou
// ignore..." apontando para nada.
function SuggestionCard({ suggestion, busy, onConfirm, onIgnore }: {
  suggestion: Suggestion;
  busy: boolean;
  onConfirm: (id: string, editedValue?: string) => void;
  onIgnore: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(suggestion.suggestedValue);

  const chaveDoRotulo = FIELD_LABEL_KEYS[suggestion.fieldType];
  const label = chaveDoRotulo ? t(chaveDoRotulo) : suggestion.fieldType;
  const pct = Math.round(suggestion.confidence * 100);

  return (
    <div className="mt-2 p-3 rounded-xl bg-[#211e1b] border border-amber-500/20 text-sm">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-amber-400 font-medium">{label}</span>
        <span className="text-xs text-white/30">{t("enrichment.confidence", { pct })}</span>
      </div>
      {editing ? (
        <div className="space-y-2">
          <Input value={editValue} onChange={e => setEditValue(e.target.value)} maxLength={2000}
            className="bg-white/5 border-white/10 text-white text-sm h-8" />
          <Button size="sm" disabled={busy} onClick={() => onConfirm(suggestion.id, editValue)}
            className="w-full bg-amber-500 hover:bg-amber-400 text-[#151312] font-bold h-8 text-xs">
            {t("enrichment.saveEdit")}
          </Button>
        </div>
      ) : (
        <>
          <p className="text-white font-medium mb-2 truncate">{suggestion.suggestedValue}</p>
          <div className="flex gap-2">
            <button disabled={busy} onClick={() => onConfirm(suggestion.id)}
              className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg bg-green-500/15 border border-green-500/30 text-green-400 text-xs font-medium hover:bg-green-500/25 transition-colors disabled:opacity-50">
              <Check size={12} /> {t("networkInteligente.suggestions.confirm")}
            </button>
            <button disabled={busy} onClick={() => setEditing(true)}
              className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg bg-blue-500/15 border border-blue-500/30 text-blue-400 text-xs font-medium hover:bg-blue-500/25 transition-colors disabled:opacity-50">
              <Edit2 size={12} /> {t("network.editar")}
            </button>
            <button disabled={busy} onClick={() => onIgnore(suggestion.id)}
              className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg bg-white/5 border border-white/15 text-white/40 text-xs font-medium hover:bg-white/10 transition-colors disabled:opacity-50">
              <X size={12} /> {t("networkInteligente.suggestions.ignore")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Bubble de mensagem ───────────────────────────────────────────────────────
function MessageBubble({ msg, busy, onConfirm, onIgnore }: {
  msg: Message;
  busy: boolean;
  onConfirm: (id: string, editedValue?: string) => void;
  onIgnore: (id: string) => void;
}) {
  const { t } = useTranslation();
  const isAI = msg.role === "assistant";
  // Só o que ainda espera decisão vira cartão; o decidido some da tela.
  const pendentes = msg.suggestions?.filter(s => s.status === "pending") ?? [];
  return (
    <div className={`flex ${isAI ? "justify-start" : "justify-end"} mb-3`}>
      <div className={`max-w-[80%] ${isAI ? "" : "items-end"}`}>
        {isAI && (
          <div className="flex items-center gap-1.5 mb-1">
            <img src="/brand/selo.png" alt="" className="w-5 h-5 rounded-full" />
            <span className="text-xs text-white/30">{t("enrichment.assistantName")}</span>
          </div>
        )}
        <div className={`px-3 py-2 rounded-2xl text-sm leading-relaxed ${
          isAI
            ? "bg-white/8 text-white rounded-tl-sm"
            : "bg-amber-500/20 text-white rounded-tr-sm border border-amber-500/20"
        }`}>
          {msg.content}
        </div>
        {isAI && pendentes.length > 0 && (
          <div className="mt-1 space-y-1">
            {pendentes.map(s => (
              <SuggestionCard key={s.id} suggestion={s} busy={busy} onConfirm={onConfirm} onIgnore={onIgnore} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Indicador "pensando" ─────────────────────────────────────────────────────
function ThinkingIndicator() {
  const { t } = useTranslation();
  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[80%]">
        <div className="flex items-center gap-1.5 mb-1">
          <img src="/brand/selo.png" alt="" className="w-5 h-5 rounded-full" />
          <span className="text-xs text-white/30">{t("enrichment.assistantName")}</span>
        </div>
        <div className="px-4 py-3 rounded-2xl rounded-tl-sm bg-white/8 flex items-center gap-1">
          {[0, 1, 2].map(i => (
            <div key={i} className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce"
              style={{ animationDelay: `${i * 150}ms` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Hidratação a partir do servidor ─────────────────────────────────────────
// enrichment.getMessages devolve, em cada mensagem, os cartões que ainda
// esperam decisão (status pending). Antes o map descartava isso e uma
// confirmação pendente era irrecuperável ao reabrir o detalhe do contato.
type MensagemDoServidor = { id: string; role: string; content: string; suggestions?: Suggestion[] };

function hidratarMensagens(rows: MensagemDoServidor[]): Message[] {
  return rows.map(m => ({
    id: m.id,
    role: m.role as "assistant" | "user",
    content: m.content,
    suggestions: m.suggestions?.filter(s => s.status === "pending"),
  }));
}

function temCartaoPendente(rows: MensagemDoServidor[]) {
  return rows.some(m => m.suggestions?.some(s => s.status === "pending"));
}

// ─── Oferta de criar o contexto ───────────────────────────────────────────────
// A resposta de "como se conheceram" não casou com contexto nenhum e ficou só
// na nota. Criar o contexto é decisão da dona: só "Criar" chama o servidor, e
// "Agora não" some com a pergunta sem gravar nada. Componente próprio para a
// mutação só existir enquanto a pergunta está na tela.
function OfertaDeContexto({ oferta, onCriado, onFechar }: {
  oferta: { suggestionId: string; nome: string };
  onCriado: () => void;
  onFechar: () => void;
}) {
  const { t } = useTranslation();
  const criarMut = trpc.enrichment.createSuggestedContext.useMutation({
    onSuccess: r => {
      toast.success(t(r.resultado === "criado" ? "enrichment.contextCreated" : "enrichment.contextExisted", { nome: r.nome }));
      onCriado();
    },
    onError: e => {
      // Já aceita em outra aba, desfeita, ou o contato saiu: não há o que insistir.
      if (e.data?.code === "NOT_FOUND") {
        toast.info(t("enrichment.contextGone"));
        onFechar();
        return;
      }
      toast.error(t("enrichment.contextCreateError"));
    },
  });

  return (
    <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 mb-3">
      <p className="text-sm text-white/85 mb-2">{t("enrichment.contextOfferQuestion", { nome: oferta.nome })}</p>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => criarMut.mutate({ suggestionId: oferta.suggestionId })} disabled={criarMut.isPending}
          className="h-7 px-3 text-xs bg-amber-500 hover:bg-amber-400 text-[#151312]">
          {criarMut.isPending ? t("enrichment.creating") : t("enrichment.create")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onFechar} disabled={criarMut.isPending}
          className="h-7 px-3 text-xs text-white/50 hover:text-white/80">
          {t("enrichment.notNow")}
        </Button>
      </div>
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────
export function EnrichmentChat({ contactId, contactName }: { contactId: number; contactName: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [completionSummary, setCompletionSummary] = useState<string | null>(null);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  // "Criar o contexto X?": só na tela. Fechar o chat sem responder vale como
  // "Agora não" — a resposta já está na nota do contato.
  const [ofertaDeContexto, setOfertaDeContexto] = useState<{ suggestionId: string; nome: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const handledSuggestionIds = useRef(new Set<string>());
  const utils = trpc.useUtils();

  const { data: activeSession, isLoading: loadingSession } = trpc.enrichment.getActiveSession.useQuery(
    { contactId },
    { refetchOnWindowFocus: false }
  );

  // Carregar mensagens da sessão existente
  const { data: existingMessages, isFetchedAfterMount: mensagensFrescas } = trpc.enrichment.getMessages.useQuery(
    // 50 é o teto do servidor: o cartão pendente viaja junto da mensagem dele, e
    // uma janela curta demais o deixaria fora da tela numa sessão longa.
    { sessionId: sessionId ?? "", limit: 50 },
    { enabled: !!sessionId, refetchOnWindowFocus: false }
  );

  useEffect(() => {
    if (activeSession?.id && !sessionId) {
      setSessionId(activeSession.id);
    }
    if (activeSession?.status === "completed") {
      setIsComplete(true);
    }
  }, [activeSession, sessionId]);

  // Hidrata a conversa só com dado buscado DEPOIS de montar. O React Query
  // entrega primeiro o cache da abertura anterior (staleTime 0, gcTime 5 min):
  // hidratar dele trazia de volta um cartão já decidido — que trancava a tela
  // com "Erro ao salvar" — ou escondia o pendente até recarregar a página.
  // Cada resposta nova do servidor substitui a conversa inteira: ele é a fonte.
  const ultimaHidratada = useRef<MensagemDoServidor[] | null>(null);
  useEffect(() => {
    if (!existingMessages || !mensagensFrescas) return;
    if (ultimaHidratada.current === existingMessages) return;
    ultimaHidratada.current = existingMessages;
    setMessages(hidratarMensagens(existingMessages));
    setAwaitingConfirmation(temCartaoPendente(existingMessages));
  }, [existingMessages, mensagensFrescas]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Reidrata a conversa a partir do servidor, cartões pendentes inclusos.
  const recarregarConversa = async () => {
    if (!sessionId) return;
    try {
      const rows = await utils.enrichment.getMessages.fetch({ sessionId, limit: 50 });
      setMessages(hidratarMensagens(rows));
      setAwaitingConfirmation(temCartaoPendente(rows));
    } catch {
      toast.error(t("enrichment.reloadError"));
    }
  };

  // A pergunta seguinte, que chega na resposta de confirmar ou ignorar; com os
  // cartões do que a usuária já tinha dito para ela, quando há.
  const acrescentarPergunta = (id: string, content: string, suggestions?: Suggestion[]) => {
    setMessages(prev => prev.some(msg => msg.id === id)
      ? prev
      : [...prev, { id, role: "assistant", content, ...(suggestions?.length ? { suggestions } : {}) }]);
  };

  // Decisão registrada no servidor: o cartão sai da tela por aqui, nunca antes.
  const marcarSugestao = (suggestionId: string, status: Suggestion["status"]) => {
    setMessages(prev => prev.map(m => m.suggestions
      ? { ...m, suggestions: m.suggestions.map(s => s.id === suggestionId ? { ...s, status } : s) }
      : m));
  };

  // O que o servidor gravou fora desta conversa precisa aparecer fora dela: o
  // perfil aberto (network.get), a lista (network.list), possui/procura e o
  // Histórico IA leem do cache do React Query, que só é refeito ao focar a
  // janela — sem isto, a usuária confirmava o telefone, não o via no perfil e
  // digitava de novo. getMessages entra junto: reabrir o contato hidrata dele.
  const sincronizarDepoisDoServidor = () => {
    void utils.enrichment.getMessages.invalidate();
    void utils.enrichment.getHistory.invalidate({ contactId });
    void utils.network.get.invalidate({ id: contactId });
    void utils.network.list.invalidate();
    void utils.network.assetsNeeds.invalidate({ contactId });
  };

  const startMut = trpc.enrichment.startSession.useMutation({
    onSuccess: (data) => {
      setSessionId(data.sessionId);
      setMessages([{ id: data.firstMessageId, role: "assistant", content: data.firstQuestion }]);
    },
    onError: (e) => {
      if (e.message === "SESSION_ALREADY_ACTIVE") {
        toast.info(t("enrichment.sessionAlreadyActive"));
      } else {
        toast.error(t("enrichment.startError", { motivo: e.message }));
      }
    },
  });

  const sendMut = trpc.enrichment.sendMessage.useMutation({
    onSuccess: (data, enviado) => {
      if (data.messageId && data.aiResponse) {
        const aiMsg: Message = {
          id: data.messageId,
          role: "assistant",
          content: data.aiResponse,
          suggestions: data.suggestions as Suggestion[],
        };
        setMessages(prev => prev.some(msg => msg.id === aiMsg.id) ? prev : [...prev, aiMsg]);
      }
      setAwaitingConfirmation(Boolean(data.awaitingConfirmation));
      if (data.sessionComplete) {
        setIsComplete(true);
        setCompletionSummary(data.completionSummary ?? null);
        setAwaitingConfirmation(false);
        void utils.enrichment.getActiveSession.invalidate({ contactId });
      }
      // A IA não respondeu: o servidor gravou só o aviso, NÃO a resposta da
      // usuária (é o que evita a duplicata ao reenviar). Reidratar agora
      // apagaria o balão dela, e o campo já foi esvaziado ao enviar: o texto
      // volta ao campo para ela tentar de novo, e a conversa local fica como
      // está — nada foi gravado no contato, não há o que refazer.
      if ("aiUnavailable" in data && data.aiUnavailable) {
        setInput(enviado.content);
        return;
      }
      sincronizarDepoisDoServidor();
    },
    onError: (e) => {
      // O servidor recusou porque há cartão esperando decisão (esta tela ou
      // outra aba perdeu o cartão): traz a conversa de volta com ele.
      if (e.message === "SUGGESTION_PENDING") {
        toast.info(t("enrichment.suggestionPending"));
        void recarregarConversa();
        return;
      }
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        role: "assistant",
        content: t("enrichment.processError"),
      }]);
    },
  });

  const confirmMut = trpc.enrichment.confirmSuggestion.useMutation({
    onSuccess: (data, { suggestionId }) => {
      marcarSugestao(suggestionId, "applied");
      toast.success(t("enrichment.savedToProfile"));
      // "Como se conheceram" que não casou com contexto nenhum: o servidor não
      // criou nada, só devolveu o nome para perguntar.
      if ("contextoParaCriar" in data && data.contextoParaCriar) {
        setOfertaDeContexto({ suggestionId, nome: data.contextoParaCriar });
      }
      // A etapa de lista pode ter vários cartões: a digitação só volta quando
      // o servidor diz que não sobrou nenhum — é ele quem conta. A pergunta
      // seguinte pode chegar com cartões (o que a usuária já tinha dito para
      // ela): aí a tela espera a decisão deles.
      const cartoesNovos = "nextSuggestions" in data && data.nextSuggestions ? data.nextSuggestions : [];
      setAwaitingConfirmation(data.pendentesRestantes > 0 || cartoesNovos.length > 0);
      if (data.sessionComplete) {
        setIsComplete(true);
        setCompletionSummary(t("enrichment.enrichedSuccess"));
        void utils.enrichment.getActiveSession.invalidate({ contactId });
      } else if (data.nextQuestion && data.nextMessageId) {
        acrescentarPergunta(data.nextMessageId, data.nextQuestion, cartoesNovos);
      }
      sincronizarDepoisDoServidor();
    },
    onError: (e, { suggestionId }) => {
      // A sugestão já foi decidida (outra aba, ou tela desatualizada): não há
      // o que insistir — a conversa do servidor é a que vale.
      if (e.data?.code === "NOT_FOUND") {
        toast.info(t("enrichment.alreadyDecided"));
        void recarregarConversa();
        return;
      }
      // Falhou: o cartão continua na tela e a decisão continua pendente.
      handledSuggestionIds.current.delete(suggestionId);
      setAwaitingConfirmation(true);
      // A frase do servidor só serve se for uma frase: a validação do zod também
      // é BAD_REQUEST, mas vem como JSON em inglês.
      const explicacao = e.data?.code === "BAD_REQUEST" && !e.message.trim().startsWith("[") ? e.message : null;
      toast.error(explicacao ?? t("enrichment.saveError"));
    },
  });

  const ignoreMut = trpc.enrichment.ignoreSuggestion.useMutation({
    onSuccess: (data, { suggestionId }) => {
      marcarSugestao(suggestionId, "ignored");
      const cartoesNovos = "nextSuggestions" in data && data.nextSuggestions ? data.nextSuggestions : [];
      setAwaitingConfirmation(data.pendentesRestantes > 0 || cartoesNovos.length > 0);
      if (data.sessionComplete) {
        setIsComplete(true);
        setCompletionSummary(t("enrichment.enrichedSuccess"));
        void utils.enrichment.getActiveSession.invalidate({ contactId });
      } else if (data.nextQuestion && data.nextMessageId) {
        acrescentarPergunta(data.nextMessageId, data.nextQuestion, cartoesNovos);
      }
      sincronizarDepoisDoServidor();
    },
    onError: (e, { suggestionId }) => {
      if (e.data?.code === "NOT_FOUND") {
        toast.info(t("enrichment.alreadyDecided"));
        void recarregarConversa();
        return;
      }
      handledSuggestionIds.current.delete(suggestionId);
      setAwaitingConfirmation(true);
      toast.error(t("enrichment.ignoreError"));
    },
  });

  const completeMut = trpc.enrichment.completeSession.useMutation({
    onSuccess: () => { setIsComplete(true); toast.success(t("enrichment.completed")); },
  });

  const handleSend = () => {
    if (!input.trim() || !sessionId || sendMut.isPending || awaitingConfirmation || isComplete) return;
    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: input.trim() };
    setMessages(prev => [...prev, userMsg]);
    sendMut.mutate({ sessionId, contactId, content: input.trim() });
    setInput("");
  };

  const handleStart = () => {
    startMut.mutate({ contactId });
  };

  const handleConfirm = (suggestionId: string, editedValue?: string) => {
    if (handledSuggestionIds.current.has(suggestionId) || confirmMut.isPending || ignoreMut.isPending) return;
    handledSuggestionIds.current.add(suggestionId);
    confirmMut.mutate({ suggestionId, editedValue });
  };

  const handleIgnore = (suggestionId: string) => {
    if (handledSuggestionIds.current.has(suggestionId) || confirmMut.isPending || ignoreMut.isPending) return;
    handledSuggestionIds.current.add(suggestionId);
    ignoreMut.mutate({ suggestionId });
  };

  // Não mostrar se não há sessão ativa e não está carregando
  if (loadingSession) return null;
  if (!activeSession && !sessionId) {
    return (
      <div className="border-t border-white/8 px-4 py-3">
        <button onClick={handleStart} disabled={startMut.isPending}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 text-sm font-medium hover:bg-amber-500/15 transition-colors">
          <Sparkles size={14} />
          {startMut.isPending ? t("enrichment.starting") : t("enrichment.startButton")}
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-amber-500/20 bg-[#151312]/50">
      {/* Header do chat */}
      <button onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-white/3 transition-colors">
        <div className="flex items-center gap-2">
          <Sparkles size={13} className="text-amber-400" />
          <span className="text-xs font-medium text-amber-400">
            {isComplete ? t("enrichment.headerDone") : t("enrichment.headerActive")}
          </span>
          {!isComplete && (
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          )}
        </div>
        {expanded ? <ChevronDown size={14} className="text-white/30" /> : <ChevronUp size={14} className="text-white/30" />}
      </button>

      {expanded && (
        <>
          {/* Área de mensagens */}
          <div ref={scrollRef} className="px-4 py-2 max-h-64 overflow-y-auto">
            {messages.length === 0 && (
              <p className="text-xs text-white/30 text-center py-4">{t("enrichment.startingConversation")}</p>
            )}
            {messages.map(msg => (
              <MessageBubble key={msg.id} msg={msg}
                // Só enquanto UMA decisão viaja: com vários cartões, os outros
                // continuam clicáveis assim que o servidor responde.
                busy={confirmMut.isPending || ignoreMut.isPending}
                onConfirm={handleConfirm}
                onIgnore={handleIgnore} />
            ))}
            {sendMut.isPending && <ThinkingIndicator />}

            {ofertaDeContexto && (
              <OfertaDeContexto oferta={ofertaDeContexto}
                onCriado={() => {
                  setOfertaDeContexto(null);
                  void utils.contexts.listByContact.invalidate({ contactId });
                  sincronizarDepoisDoServidor();
                }}
                onFechar={() => setOfertaDeContexto(null)} />
            )}

            {/* Resumo de conclusão */}
            {isComplete && completionSummary && (
              <div className="p-3 rounded-xl bg-green-500/10 border border-green-500/20 text-sm text-green-300 mb-3">
                <p className="font-medium mb-1">{t("enrichment.enrichedTitle")}</p>
                <p className="text-xs text-green-300/70">{completionSummary}</p>
              </div>
            )}
            {isComplete && !completionSummary && (
              <div className="p-3 rounded-xl bg-white/5 border border-white/10 text-sm text-white/50 mb-3 flex items-center gap-2">
                <Clock size={13} /> {t("enrichment.sessionDone")}
              </div>
            )}
          </div>

          {/* Input */}
          {!isComplete && !awaitingConfirmation && (
            <div className="px-4 pb-3 flex items-center gap-2">
              <Input
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                placeholder={t("enrichment.inputPlaceholder")}
                disabled={sendMut.isPending}
                className="flex-1 bg-white/5 border-white/10 text-white placeholder:text-white/25 text-sm h-9 focus:border-amber-500/50"
              />
              <Button size="sm" onClick={handleSend} disabled={!input.trim() || sendMut.isPending}
                className="bg-amber-500 hover:bg-amber-400 text-[#151312] h-9 w-9 p-0 flex-shrink-0">
                <Send size={14} />
              </Button>
            </div>
          )}

          {!isComplete && awaitingConfirmation && (
            <p className="px-4 pb-3 text-xs text-amber-300/75">{t("enrichment.confirmOrIgnore")}</p>
          )}

          {/* Botão concluir */}
          {!isComplete && sessionId && messages.length >= 3 && (
            <div className="px-4 pb-3">
              <button onClick={() => completeMut.mutate({ sessionId })}
                className="text-xs text-white/30 hover:text-white/50 transition-colors">
                {t("enrichment.finish")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
