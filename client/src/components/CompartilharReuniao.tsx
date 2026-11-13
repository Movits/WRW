import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Link2, Loader2, Mail, MessageCircle, Share2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { rotaDaReuniaoAberta } from "@shared/rotas";

/**
 * Compartilhar a reunião por link (pedido do Roberto em 12/11/2026, "por
 * enquanto"): a dona liga o link aberto de uma reunião pronta e o manda por
 * WhatsApp, por e-mail ou copiando. Quem recebe ouve a gravação, lê a
 * transcrição e pergunta à IA sem conta na WRW (pages/ReuniaoAberta.tsx).
 *
 * WhatsApp e e-mail abrem o app da própria dona com a mensagem pronta, e ela
 * escolhe para quem mandar: a WRW não envia nada em nome dela.
 */

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/** O endereço completo do link, no domínio em que a dona está. */
export function enderecoDoLinkAberto(token: string, origem: string = window.location.origin) {
  return `${origem}${rotaDaReuniaoAberta(token)}`;
}

/** A mensagem pronta para o WhatsApp: o app escolhe o contato, a mensagem já vai escrita. */
export function linkDoWhatsApp(mensagem: string) {
  return `https://wa.me/?text=${encodeURIComponent(mensagem)}`;
}

/** O e-mail pronto no app de e-mail da dona, sem destinatário: ela escolhe. */
export function linkDoEmail(assunto: string, corpo: string) {
  return `mailto:?subject=${encodeURIComponent(assunto)}&body=${encodeURIComponent(corpo)}`;
}

// O código tRPC decide a frase: as mensagens do servidor vêm em português.
function mensagemDoErro(t: TranslateFn, erro: unknown) {
  switch ((erro as { data?: { code?: string } } | null)?.data?.code) {
    case "PRECONDITION_FAILED": return t("meetings.share.onlyReady");
    case "NOT_FOUND": return t("meetings.meetingNotFound");
    case "INTERNAL_SERVER_ERROR": return mensagemDeErroParaTela(erro, t);
    default: return t("meetings.share.error");
  }
}

export function CompartilharReuniao({ meetingId, titulo, token }: { meetingId: string; titulo: string; token: string | null }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const campo = useRef<HTMLInputElement>(null);
  // Ligar pede um passo a mais: a confirmação de que as pessoas autorizaram.
  const [pedindo, setPedindo] = useState(false);
  const [autorizou, setAutorizou] = useState(false);
  const [confirmarDesligar, setConfirmarDesligar] = useState(false);

  // O token novo entra na tela na hora, e a releitura confirma com o servidor.
  const trocarToken = (novo: string | null) => {
    utils.meetings.get.setData({ meetingId }, anterior => anterior && { ...anterior, meeting: { ...anterior.meeting, shareToken: novo } });
    void utils.meetings.get.invalidate({ meetingId });
  };
  const ligar = trpc.meetings.ligarLinkAberto.useMutation({
    onSuccess: ({ token: novo }) => { setPedindo(false); setAutorizou(false); trocarToken(novo); },
    onError: erro => toast.error(mensagemDoErro(t, erro)),
  });
  const desligar = trpc.meetings.desligarLinkAberto.useMutation({
    onSuccess: () => { setConfirmarDesligar(false); trocarToken(null); toast.success(t("meetings.share.turnedOff")); },
    onError: erro => toast.error(mensagemDoErro(t, erro)),
  });

  if (!token) {
    return <section aria-labelledby="compartilhar-reuniao" className="mb-6 rounded-2xl border border-white/10 bg-white/[0.035] p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 id="compartilhar-reuniao" className="inline-flex items-center gap-2 text-base font-semibold"><Share2 size={16} className="text-amber-300"/>{t("meetings.share.title")}</h2>
          <p className="mt-1 text-sm text-white/55">{t("meetings.share.intro")}</p>
        </div>
        {!pedindo && <button type="button" onClick={() => setPedindo(true)}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-amber-300/40 px-4 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-300/10">
          <Link2 size={15}/> {t("meetings.share.button")}
        </button>}
      </div>
      {pedindo && <div className="mt-4 space-y-3">
        <label className="flex items-start gap-3 text-sm text-white/75">
          <input type="checkbox" checked={autorizou} onChange={evento => setAutorizou(evento.target.checked)} className="mt-1 h-4 w-4 accent-amber-400"/>
          <span>{t("meetings.share.authorization")}</span>
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!autorizou || ligar.isPending} onClick={() => ligar.mutate({ meetingId, autorizacaoDasPessoas: true })}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-50">
            {ligar.isPending ? <Loader2 size={15} className="animate-spin"/> : <Link2 size={15}/>} {t("meetings.share.createButton")}
          </button>
          <button type="button" onClick={() => { setPedindo(false); setAutorizou(false); }} disabled={ligar.isPending}
            className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/65 hover:bg-white/5 disabled:opacity-50">
            {t("meetings.share.cancel")}
          </button>
        </div>
      </div>}
    </section>;
  }

  const endereco = enderecoDoLinkAberto(token);
  const mensagem = t("meetings.share.message", { title: titulo, url: endereco });
  async function copiar() {
    try {
      await navigator.clipboard.writeText(endereco);
      toast.success(t("meetings.share.copied"));
    } catch {
      // Sem permissão (ou fora de HTTPS) a área de transferência recusa: o
      // endereço fica selecionado no campo para a dona copiar à mão.
      campo.current?.select();
      toast.message(t("meetings.share.copyFallback"));
    }
  }

  return <section aria-labelledby="compartilhar-reuniao" className="mb-6 rounded-2xl border border-amber-300/25 bg-amber-300/[0.06] p-5">
    <h2 id="compartilhar-reuniao" className="inline-flex items-center gap-2 text-base font-semibold text-amber-100"><Share2 size={16}/>{t("meetings.share.activeTitle")}</h2>
    <p className="mt-1 text-sm text-white/60">{t("meetings.share.activeIntro")}</p>
    <input ref={campo} readOnly value={endereco} aria-label={t("meetings.share.linkLabel")} onFocus={evento => evento.currentTarget.select()}
      className="mt-4 w-full rounded-xl border border-white/15 bg-black/20 px-4 py-2.5 text-sm text-white/85 outline-none focus:border-amber-300"/>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" onClick={() => void copiar()}
        className="inline-flex items-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8]">
        <Copy size={15}/> {t("meetings.share.copy")}
      </button>
      <a href={linkDoWhatsApp(mensagem)} target="_blank" rel="noopener noreferrer"
        className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2 text-sm text-white/85 hover:bg-white/5">
        <MessageCircle size={15}/> {t("meetings.share.whatsapp")}
      </a>
      <a href={linkDoEmail(t("meetings.share.emailSubject", { title: titulo }), mensagem)}
        className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2 text-sm text-white/85 hover:bg-white/5">
        <Mail size={15}/> {t("meetings.share.email")}
      </a>
    </div>
    <div className="mt-4 border-t border-white/10 pt-3">
      {confirmarDesligar ? <div className="space-y-2">
        <p className="text-sm text-amber-100/85">{t("meetings.share.turnOffConfirm")}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => desligar.mutate({ meetingId })} disabled={desligar.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-bold text-white hover:bg-red-400 disabled:opacity-50">
            {desligar.isPending && <Loader2 size={15} className="animate-spin"/>} {t("meetings.share.turnOffYes")}
          </button>
          <button type="button" onClick={() => setConfirmarDesligar(false)} disabled={desligar.isPending}
            className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/65 hover:bg-white/5 disabled:opacity-50">
            {t("meetings.share.turnOffCancel")}
          </button>
        </div>
      </div> : <button type="button" onClick={() => setConfirmarDesligar(true)} className="text-sm text-red-200/80 underline-offset-2 hover:underline">
        {t("meetings.share.turnOff")}
      </button>}
    </div>
  </section>;
}
