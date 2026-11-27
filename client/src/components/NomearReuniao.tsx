import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { TITULO_DA_REUNIAO_MAX, TITULO_DA_REUNIAO_MIN } from "@shared/const";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * O título padrão da gravação que começou sem nome (gravar com um toque,
 * decisão do Roberto de 26/11/2026): "Reunião de 26/11/2026 14:32", no idioma
 * da tela. Fica entre os limites do servidor (TITULO_DA_REUNIAO_MIN e _MAX).
 */
export function tituloPadraoDaGravacao(t: (chave: string, opcoes?: Record<string, unknown>) => string, idioma: string, agora: Date = new Date()): string {
  let data: string;
  try {
    data = new Intl.DateTimeFormat(idioma, { dateStyle: "short", timeStyle: "short" }).format(agora);
  } catch {
    data = agora.toISOString().slice(0, 16).replace("T", " ");
  }
  return t("meetings.nameAfterRecording.defaultTitle", { data }).slice(0, TITULO_DA_REUNIAO_MAX);
}

/**
 * O nome da reunião no fim da gravação (gravar com um toque): o gravador não
 * pede título antes de gravar; ao encerrar, este diálogo oferece dar nome,
 * já preenchido com o título com que a reunião nasceu (o da reunião da agenda
 * ou o padrão com data e hora). "Pular" mantém esse título. O título que a IA
 * sugere com o resumo chega depois, no detalhe (TituloSugerido), e o nome
 * também se troca em "Editar detalhes".
 */
export function NomearReuniao({ meetingId, tituloInicial, aoFechar }: { meetingId: string; tituloInicial: string; aoFechar: () => void }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const idDoCampo = useId();
  const [titulo, setTitulo] = useState(tituloInicial);
  const salvar = trpc.meetings.atualizarDetalhes.useMutation({
    onSuccess: async () => {
      toast.success(t("meetings.nameAfterRecording.saved"));
      aoFechar();
      await Promise.all([utils.meetings.get.invalidate({ meetingId }), utils.meetings.list.invalidate()]);
    },
    onError: erro => {
      const codigo = (erro as { data?: { code?: string } }).data?.code;
      toast.error(codigo === "NOT_FOUND" ? t("meetings.meetingNotFound") : mensagemDeErroParaTela(erro, t));
    },
  });
  const limpo = titulo.trim();
  const valido = limpo.length >= TITULO_DA_REUNIAO_MIN && limpo.length <= TITULO_DA_REUNIAO_MAX;

  return (
    <Dialog open onOpenChange={aberta => { if (!aberta && !salvar.isPending) aoFechar(); }}>
      <DialogContent className="border-amber-300/25 bg-[#211e1b] text-white sm:max-w-md">
        <form onSubmit={evento => {
          evento.preventDefault();
          if (!valido || salvar.isPending) return;
          // Sem mudança, nada a gravar: a reunião já tem este título.
          if (limpo === tituloInicial.trim()) { aoFechar(); return; }
          salvar.mutate({ meetingId, titulo: limpo });
        }}>
          <DialogHeader>
            <DialogTitle className="text-amber-200">{t("meetings.nameAfterRecording.title")}</DialogTitle>
            <DialogDescription className="text-sm text-white/60">{t("meetings.nameAfterRecording.hint")}</DialogDescription>
          </DialogHeader>
          <label htmlFor={idDoCampo} className="mt-4 block text-sm text-white/70">{t("meetings.titleLabel")}</label>
          <input id={idDoCampo} autoFocus value={titulo} onChange={evento => setTitulo(evento.target.value)} maxLength={TITULO_DA_REUNIAO_MAX}
            onFocus={evento => evento.currentTarget.select()}
            className="mt-2 w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-white outline-none focus:border-amber-300"/>
          {!valido && <p role="alert" className="mt-2 text-xs text-red-300">{t("meetings.titleLength", { min: TITULO_DA_REUNIAO_MIN, max: TITULO_DA_REUNIAO_MAX })}</p>}
          <DialogFooter className="mt-5 flex-row gap-3">
            <button type="button" disabled={salvar.isPending} onClick={aoFechar}
              className="flex-1 rounded-xl border border-white/15 px-3 py-2 text-sm text-white/70 hover:bg-white/5 disabled:opacity-50">
              {t("meetings.nameAfterRecording.skip")}
            </button>
            <button type="submit" disabled={!valido || salvar.isPending}
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-[#c98f70] px-3 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-50">
              {salvar.isPending ? <Loader2 size={15} className="animate-spin" aria-hidden/> : <Check size={15} aria-hidden/>}{t("meetings.nameAfterRecording.save")}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
