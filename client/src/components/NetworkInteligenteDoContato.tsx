import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Mic, Send, ShieldCheck, Square, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { gravacaoDeAudioSuportada, useGravadorDeAudio, type AudioGravado } from "@/hooks/useGravadorDeAudio";

/**
 * Meu Network Inteligente — as três peças do contato que MUDAM dado (spec da
 * Glenda de 14/09, itens 9, 10, 13, 14 e 26). A tela só pede; quem decide é o
 * servidor (networkInteligente.*):
 *
 * - DisponibilidadeDoContato: o ID anônimo e o SIM/NÃO "Disponibilizar este
 *   contato para oportunidades da rede", padrão NÃO, com o que sai e o que
 *   nunca sai escrito ao lado da escolha.
 * - SugestoesDaIA: o que a IA propôs (da reunião, da voz ou do texto), com
 *   origem, confiança e o trecho que sustenta; a dona corrige, confirma ou
 *   ignora. Nada entra no contato sem esse clique.
 * - CompletarInformacoes: por TEXTO ou por VOZ (grava até 2 minutos; o áudio é
 *   transcrito e descartado no servidor). O resultado vira sugestão, não dado.
 */

type Traduzir = (chave: string, opcoes?: Record<string, unknown>) => string;

const CARTAO = "rounded-2xl border border-white/[0.08] bg-[#211e1b]/90 p-5";

function rotuloDoCampo(t: Traduzir, campo: string) {
  switch (campo) {
    case "nome": return t("networkPanel.fields.nome");
    case "telefone": return t("networkPanel.fields.telefone");
    case "email": return t("networkPanel.fields.email");
    case "tipo_pessoa": return t("networkInteligente.contact.personType");
    case "tenho": return t("networkPanel.fields.tenho");
    case "preciso": return t("networkPanel.fields.preciso");
    default: return campo;
  }
}

function rotuloDaOrigem(t: Traduzir, origem: string) {
  switch (origem) {
    case "reuniao": return t("networkInteligente.suggestions.originMeeting");
    case "voz": return t("networkInteligente.suggestions.originVoice");
    default: return t("networkInteligente.suggestions.originText");
  }
}

export function rotuloDoTipoDePessoa(t: Traduzir, tipo: string | null | undefined) {
  if (tipo === "fisica") return t("networkInteligente.contact.personFisica");
  if (tipo === "juridica") return t("networkInteligente.contact.personJuridica");
  return t("networkInteligente.contact.personUnknown");
}

export function DisponibilidadeDoContato({ contactId, codigoAnonimo, disponivel, alteradaEm }: {
  contactId: number;
  codigoAnonimo: string | null;
  disponivel: boolean;
  alteradaEm: number | null;
}) {
  const { t, i18n } = useTranslation();
  const utils = trpc.useUtils();
  const definir = trpc.networkInteligente.definirDisponibilidade.useMutation({
    onSuccess: () => {
      toast.success(t("networkInteligente.availability.saved"));
      void utils.networkInteligente.contato.invalidate({ contactId });
      void utils.networkInteligente.resumo.invalidate();
    },
    onError: () => toast.error(t("networkInteligente.availability.error")),
  });
  const escolher = (valor: boolean) => {
    if (valor !== disponivel && !definir.isPending) definir.mutate({ contactId, disponivel: valor });
  };
  return (
    <section aria-labelledby={`nwi-disponibilidade-${contactId}`} className={CARTAO}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-white/50">{t("networkInteligente.contact.anonymousId")}</p>
        <code className="rounded-lg border border-[#c98f70]/30 bg-[#c98f70]/10 px-2.5 py-1 font-mono text-sm font-bold text-[#efcba8]">{codigoAnonimo ?? "—"}</code>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-white/45">{t("networkInteligente.contact.anonymousIdHelp")}</p>

      <h3 id={`nwi-disponibilidade-${contactId}`} className="mt-5 font-semibold text-white">{t("networkInteligente.availability.title")}</h3>
      <div role="radiogroup" aria-labelledby={`nwi-disponibilidade-${contactId}`} className="mt-3 inline-flex rounded-xl border border-white/10 bg-white/[0.03] p-1">
        {([[true, t("networkInteligente.availability.yes")], [false, t("networkInteligente.availability.no")]] as const).map(([valor, rotulo]) => (
          <button key={String(valor)} type="button" role="radio" aria-checked={disponivel === valor} disabled={definir.isPending}
            onClick={() => escolher(valor)}
            className={`min-w-[4.5rem] rounded-lg px-4 py-2 text-sm font-bold transition-colors disabled:opacity-60 ${disponivel === valor ? "bg-[#c98f70] text-[#151312]" : "text-white/60 hover:text-white"}`}>
            {rotulo}
          </button>
        ))}
      </div>
      <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-white/55">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-hidden="true" />
        {t("networkInteligente.availability.help")}
      </p>
      {alteradaEm !== null && (
        <p className="mt-2 text-xs text-white/35">{t("networkInteligente.availability.changedAt", { data: new Date(alteradaEm).toLocaleDateString(i18n.language) })}</p>
      )}
    </section>
  );
}

type Pendencia = {
  id: string; campo: string; valor: string; origem: string; confianca: number; trecho: string | null;
};

function LinhaDeSugestao({ pendencia, aoDecidir }: { pendencia: Pendencia; aoDecidir: () => void }) {
  const { t } = useTranslation();
  const [valor, setValor] = useState(pendencia.valor);
  const confirmar = trpc.networkInteligente.confirmarPendencia.useMutation({
    onSuccess: () => { toast.success(t("networkInteligente.suggestions.confirmed")); aoDecidir(); },
    onError: erro => toast.error(erro.data?.code === "BAD_REQUEST" ? erro.message : t("networkInteligente.suggestions.error")),
  });
  const ignorar = trpc.networkInteligente.ignorarPendencia.useMutation({
    onSuccess: () => { toast.success(t("networkInteligente.suggestions.ignored")); aoDecidir(); },
    onError: () => toast.error(t("networkInteligente.suggestions.error")),
  });
  const ocupado = confirmar.isPending || ignorar.isPending;
  const editavel = pendencia.campo !== "tipo_pessoa";
  return (
    <li className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-bold uppercase tracking-wider text-[#efcba8]">{rotuloDoCampo(t, pendencia.campo)}</span>
        <span className="rounded-full border border-white/10 px-2 py-0.5 text-white/50">{rotuloDaOrigem(t, pendencia.origem)}</span>
        <span className="text-white/40">{t("networkInteligente.suggestions.confidence", { pct: Math.round(pendencia.confianca * 100) })}</span>
      </div>
      {editavel ? (
        <label className="mt-2 block">
          <span className="sr-only">{t("networkInteligente.suggestions.valueLabel")}</span>
          <input value={valor} onChange={evento => setValor(evento.target.value)} disabled={ocupado} maxLength={320}
            className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-[#c98f70]" />
        </label>
      ) : (
        <p className="mt-2 text-sm font-semibold text-white">{rotuloDoTipoDePessoa(t, pendencia.valor)}</p>
      )}
      {pendencia.trecho && (
        <p className="mt-2 text-xs italic leading-relaxed text-white/45">{t("networkInteligente.suggestions.evidence", { trecho: pendencia.trecho })}</p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={ocupado || !valor.trim()}
          onClick={() => confirmar.mutate({ id: pendencia.id, ...(editavel && valor.trim() !== pendencia.valor ? { valor: valor.trim() } : {}) })}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#c98f70] px-3 py-1.5 text-xs font-bold text-[#151312] hover:bg-[#efcba8] disabled:opacity-50">
          <Check className="h-3.5 w-3.5" aria-hidden="true" /> {t("networkInteligente.suggestions.confirm")}
        </button>
        <button type="button" disabled={ocupado} onClick={() => ignorar.mutate({ id: pendencia.id })}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/65 hover:bg-white/5 disabled:opacity-50">
          <X className="h-3.5 w-3.5" aria-hidden="true" /> {t("networkInteligente.suggestions.ignore")}
        </button>
      </div>
    </li>
  );
}

export function SugestoesDaIA({ contactId, pendencias, erro, aoTentarDeNovo }: {
  contactId: number;
  pendencias: Pendencia[] | undefined;
  erro?: unknown;
  aoTentarDeNovo?: () => void;
}) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const aoDecidir = () => {
    void utils.networkInteligente.contato.invalidate({ contactId });
    void utils.networkInteligente.resumo.invalidate();
  };
  return (
    <section aria-labelledby={`nwi-sugestoes-${contactId}`} className={CARTAO}>
      <h3 id={`nwi-sugestoes-${contactId}`} className="font-semibold text-white">{t("networkInteligente.suggestions.title")}</h3>
      <p className="mt-1 text-xs leading-relaxed text-white/45">{t("networkInteligente.suggestions.subtitle")}</p>
      {erro ? (
        <div className="mt-3"><ErroDeConsulta erro={erro} aoTentarDeNovo={aoTentarDeNovo} /></div>
      ) : !pendencias ? (
        <p role="status" className="mt-3 text-sm text-white/45">{t("networkPanel.loading")}</p>
      ) : pendencias.length === 0 ? (
        <p className="mt-3 text-sm text-white/45">{t("networkInteligente.suggestions.empty")}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {pendencias.map(pendencia => <LinhaDeSugestao key={pendencia.id} pendencia={pendencia} aoDecidir={aoDecidir} />)}
        </ul>
      )}
    </section>
  );
}

const LIMITE_DA_VOZ_SEGUNDOS = 120;

function lerComoDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onerror = () => reject(new Error("leitura"));
    leitor.onload = () => resolve(String(leitor.result));
    leitor.readAsDataURL(blob);
  });
}

export function CompletarInformacoes({ contactId }: { contactId: number }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [modo, setModo] = useState<"texto" | "voz">("texto");
  const [texto, setTexto] = useState("");
  const [entendido, setEntendido] = useState<string | null>(null);

  const depoisDeInterpretar = (criadas: number) => {
    if (criadas > 0) toast.success(t("networkInteligente.complete.created", { quantidade: criadas }));
    else toast.info(t("networkInteligente.complete.noneCreated"));
    void utils.networkInteligente.contato.invalidate({ contactId });
  };
  const porTexto = trpc.networkInteligente.complementarPorTexto.useMutation({
    onSuccess: r => { setTexto(""); depoisDeInterpretar(r.pendenciasCriadas); },
    onError: erro => toast.error(erro.data?.code === "TOO_MANY_REQUESTS" ? erro.message : t("networkInteligente.complete.error")),
  });
  const porVoz = trpc.networkInteligente.complementarPorVoz.useMutation({
    onSuccess: r => { setEntendido(r.transcricao); depoisDeInterpretar(r.pendenciasCriadas); },
    onError: erro => toast.error(["TOO_MANY_REQUESTS", "SERVICE_UNAVAILABLE", "BAD_REQUEST"].includes(erro.data?.code ?? "") ? erro.message : t("networkInteligente.complete.error")),
  });

  // Saiu da tela gravando: o hook para o gravador e o microfone e não entrega
  // nada (o áudio abandonado não vai à IA, não conta minutos nem cria sugestão).
  const gravador = useGravadorDeAudio({
    limiteSegundos: LIMITE_DA_VOZ_SEGUNDOS,
    bitsPorSegundo: 48_000,
    aoTerminar: audio => void enviarVoz(audio),
    aoFalhar: () => toast.error(t("networkInteligente.complete.micError")),
  });
  const gravando = gravador.estado === "gravando";
  const segundos = gravador.segundos;
  // Um pedido de microfone por vez: o duplo clique abria dois MediaRecorder e o
  // primeiro ficava com o microfone aceso, empurrando pedaços para a gravação seguinte.
  // O hook barra já o segundo clique; o estado desabilita o botão enquanto o navegador responde.
  const aguardandoMicrofone = gravador.estado === "pedindoMicrofone";

  async function enviarVoz({ blob, mimeType, duracaoMs }: AudioGravado) {
    const duracao = Math.max(1, Math.min(LIMITE_DA_VOZ_SEGUNDOS, Math.round(duracaoMs / 1000)));
    if (!blob.size) return;
    try {
      const audioBase64 = await lerComoDataUrl(blob);
      porVoz.mutate({ contactId, audioBase64, mimeType, durationSeconds: duracao });
    } catch {
      toast.error(t("networkInteligente.complete.error"));
    }
  }

  async function gravar() {
    if (!gravacaoDeAudioSuportada()) {
      toast.error(t("networkInteligente.complete.unsupported"));
      return;
    }
    if (await gravador.comecar()) setEntendido(null);
  }

  function parar() {
    gravador.parar();
  }

  const relogio = `${String(Math.floor(segundos / 60)).padStart(2, "0")}:${String(segundos % 60).padStart(2, "0")}`;

  return (
    <section aria-labelledby={`nwi-completar-${contactId}`} className={CARTAO}>
      <h3 id={`nwi-completar-${contactId}`} className="font-semibold text-white">{t("networkInteligente.complete.title")}</h3>
      <div role="tablist" className="mt-3 inline-flex rounded-xl border border-white/10 bg-white/[0.03] p-1">
        {([["texto", t("networkInteligente.complete.byText")], ["voz", t("networkInteligente.complete.byVoice")]] as const).map(([id, rotulo]) => (
          <button key={id} type="button" role="tab" aria-selected={modo === id} onClick={() => { if (!gravando && !aguardandoMicrofone) setModo(id); }}
            className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors ${modo === id ? "bg-[#c98f70] text-[#151312]" : "text-white/60 hover:text-white"}`}>
            {rotulo}
          </button>
        ))}
      </div>

      {modo === "texto" ? (
        <form className="mt-3" onSubmit={evento => { evento.preventDefault(); if (texto.trim().length >= 5) porTexto.mutate({ contactId, texto: texto.trim() }); }}>
          <label className="block">
            <span className="sr-only">{t("networkInteligente.complete.byText")}</span>
            <textarea value={texto} onChange={evento => setTexto(evento.target.value)} maxLength={4000} rows={4} disabled={porTexto.isPending}
              placeholder={t("networkInteligente.complete.textPlaceholder")}
              className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-[#c98f70]" />
          </label>
          <button type="submit" disabled={porTexto.isPending || texto.trim().length < 5}
            className="mt-2 inline-flex items-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#151312] hover:bg-[#efcba8] disabled:opacity-50">
            {porTexto.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
            {porTexto.isPending ? t("networkInteligente.complete.interpreting") : t("networkInteligente.complete.interpret")}
          </button>
        </form>
      ) : (
        <div className="mt-3">
          {porVoz.isPending ? (
            <p role="status" className="flex items-center gap-2 text-sm text-white/60"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t("networkInteligente.complete.sending")}</p>
          ) : gravando ? (
            <button type="button" onClick={parar}
              className="inline-flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-bold text-white">
              <Square className="h-4 w-4" aria-hidden="true" /> {t("networkInteligente.complete.stop")} <span className="font-mono">{relogio}</span>
            </button>
          ) : (
            <button type="button" onClick={() => void gravar()} disabled={aguardandoMicrofone} aria-busy={aguardandoMicrofone || undefined}
              className="inline-flex items-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#151312] hover:bg-[#efcba8] disabled:cursor-not-allowed disabled:opacity-50">
              <Mic className="h-4 w-4" aria-hidden="true" /> {t("networkInteligente.complete.record")}
            </button>
          )}
          <p className="mt-2 text-xs leading-relaxed text-white/45">{t("networkInteligente.complete.voiceNotStored")}</p>
          {entendido && <p className="mt-2 rounded-lg border border-white/10 bg-white/[0.03] p-3 text-xs italic leading-relaxed text-white/60">{t("networkInteligente.complete.heard", { texto: entendido })}</p>}
        </div>
      )}
    </section>
  );
}
