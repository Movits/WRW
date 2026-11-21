import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";

/**
 * O título que a IA sugeriu com o resumo, no detalhe da dona, como no app de
 * referência da cliente ("📱 Preparação e validação do aplicativo", com a data
 * da reunião embaixo): o emoji é o do resumo, e a data continua a da reunião.
 * É só sugestão (nada extraído por IA entra sozinho): "Usar este título" troca
 * o título; "Manter o atual" a dispensa. O link aberto não recebe a sugestão,
 * e a lista e o link só mudam quando a dona usa.
 */
export function TituloSugerido({ meetingId, emoji, sugestao }: { meetingId: string; emoji: string | null; sugestao: string | null }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const idDoRotulo = useId();
  const decidir = trpc.meetings.decidirTituloSugerido.useMutation({
    onSuccess: async (_dados, pedido) => {
      if (pedido.usar) toast.success(t("meetings.suggestedTitle.used"));
      await Promise.all([
        utils.meetings.get.invalidate({ meetingId }),
        utils.meetings.resumoGuardado.invalidate({ meetingId }),
        utils.meetings.list.invalidate(),
      ]);
    },
    // A sugestão que já não espera a dona (decidida noutra aba, trocada por um
    // resumo refeito): a frase é da tela, pelo código; a sugestão relê. A
    // reunião excluída noutra aba (NOT_FOUND) também sai pelo código, e não
    // pela frase em português do servidor.
    onError: erro => {
      const codigo = (erro as { data?: { code?: string } }).data?.code;
      if (codigo === "CONFLICT") {
        toast.error(t("meetings.suggestedTitle.gone"));
        void utils.meetings.resumoGuardado.invalidate({ meetingId });
      } else if (codigo === "NOT_FOUND") toast.error(t("meetings.meetingNotFound"));
      else toast.error(mensagemDeErroParaTela(erro, t));
    },
  });
  if (!sugestao) return null;
  return <section aria-labelledby={idDoRotulo} className="mb-6 rounded-2xl border border-amber-300/25 bg-amber-300/[0.06] p-4">
    <p id={idDoRotulo} className="inline-flex items-center gap-2 text-xs font-semibold text-amber-200"><Sparkles size={14} aria-hidden/>{t("meetings.suggestedTitle.label")}</p>
    <p dir="auto" className="mt-1 text-lg font-semibold text-white">{emoji && <span aria-hidden="true" className="mr-2">{emoji}</span>}{sugestao}</p>
    <p className="mt-1 text-xs text-white/50">{t("meetings.suggestedTitle.hint")}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" disabled={decidir.isPending} onClick={() => decidir.mutate({ meetingId, usar: true })}
        className="inline-flex items-center gap-2 rounded-lg bg-[#c98f70] px-3 py-1.5 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-50">
        {decidir.isPending && decidir.variables?.usar ? <Loader2 size={14} className="animate-spin" aria-hidden/> : <Check size={14} aria-hidden/>}{t("meetings.suggestedTitle.use")}
      </button>
      <button type="button" disabled={decidir.isPending} onClick={() => decidir.mutate({ meetingId, usar: false })}
        className="inline-flex items-center gap-2 rounded-lg border border-white/20 px-3 py-1.5 text-sm text-white/75 hover:bg-white/5 disabled:opacity-50">
        {decidir.isPending && decidir.variables?.usar === false ? <Loader2 size={14} className="animate-spin" aria-hidden/> : <X size={14} aria-hidden/>}{t("meetings.suggestedTitle.keep")}
      </button>
    </div>
  </section>;
}
