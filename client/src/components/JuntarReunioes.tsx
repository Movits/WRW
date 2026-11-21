import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Loader2, Merge } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { traduzirMensagemDoServidor } from "@/lib/mensagem-de-erro";
import { ordemCronologica, RECUSAS_DA_JUNCAO, type CodigoDaRecusaDaJuncao } from "@shared/juntar-reunioes";

/**
 * A confirmação de juntar reuniões (H17): a ordem em que o áudio entra (da
 * mais antiga para a mais nova, por padrão, e a dona pode mudar), o que
 * acontece com o resumo, o link aberto e o áudio, e o botão. O servidor confere
 * tudo de novo (server/juntar-reunioes.ts); a recusa sai pelo código, no
 * idioma da tela.
 */
type ReuniaoParaJuntar = { id: string; title: string; createdAt: number; audioPipeline?: string | null };

/**
 * A junção transcreve de novo quando alguma escolhida foi gravada num arquivo
 * só (audio_pipeline 'single'): é a regra do servidor (planejarJuncao). Só
 * então o aviso disso aparece; sem saber como o áudio chegou, avisa.
 */
export function juncaoTranscreveDeNovo(reunioes: readonly { audioPipeline?: string | null }[]): boolean {
  return reunioes.some(reuniao => reuniao.audioPipeline !== "slices");
}

/**
 * O aviso de cada recusa do servidor. O Record é pelo tipo compartilhado:
 * código novo lá não compila aqui sem o aviso dele, e cada valor chama t() com
 * a chave literal (server/i18n-chaves-usadas.test.ts confere que existem).
 */
const AVISO_POR_RECUSA: Record<CodigoDaRecusaDaJuncao, (t: (chave: string) => string) => string> = {
  [RECUSAS_DA_JUNCAO.foraDoEstado]: t => t("meetings.join.errorState"),
  [RECUSAS_DA_JUNCAO.soAudio]: t => t("meetings.join.errorOnlyAudio"),
  [RECUSAS_DA_JUNCAO.semAudio]: t => t("meetings.join.errorNoAudio"),
  [RECUSAS_DA_JUNCAO.longaDemais]: t => t("meetings.join.errorTooLong"),
  [RECUSAS_DA_JUNCAO.demais]: t => t("meetings.join.errorTooMany"),
};

export function avisoDaRecusaDaJuncao(erro: unknown, t: (chave: string) => string): string {
  const { message, data } = (erro ?? {}) as { message?: unknown; data?: { code?: unknown } };
  if (data?.code === "NOT_FOUND") return t("meetings.meetingNotFound");
  if (typeof message === "string" && Object.prototype.hasOwnProperty.call(AVISO_POR_RECUSA, message)) {
    return AVISO_POR_RECUSA[message as CodigoDaRecusaDaJuncao](t);
  }
  if (typeof message === "string" && data?.code) {
    const traduzida = traduzirMensagemDoServidor(message, t);
    if (traduzida !== message) return traduzida;
  }
  return t("meetings.join.error");
}

export function JuntarReunioes({ reunioes, aoFechar, aoJuntar }: {
  reunioes: ReuniaoParaJuntar[];
  aoFechar: () => void;
  aoJuntar: (meetingId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const utils = trpc.useUtils();
  const [ordem, setOrdem] = useState(() => ordemCronologica(reunioes));
  const juntar = trpc.meetings.juntar.useMutation({
    onSuccess: async resposta => {
      toast.success(t("meetings.join.started"));
      await utils.meetings.list.invalidate();
      aoJuntar(resposta.meetingId);
    },
    onError: erro => toast.error(avisoDaRecusaDaJuncao(erro, t)),
  });
  const mover = (indice: number, passo: -1 | 1) => setOrdem(atual => {
    const destino = indice + passo;
    if (destino < 0 || destino >= atual.length) return atual;
    const nova = [...atual];
    [nova[indice], nova[destino]] = [nova[destino], nova[indice]];
    return nova;
  });

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="juntar-reunioes-titulo" className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-white/15 bg-[#211e1b] p-5 shadow-2xl sm:rounded-2xl sm:p-6">
        <h3 id="juntar-reunioes-titulo" className="flex items-center gap-2 font-bold text-white"><Merge size={18} aria-hidden="true" />{t("meetings.join.title", { n: ordem.length })}</h3>
        <p className="mt-2 text-sm text-white/60">{t("meetings.join.orderHint")}</p>
        <ol className="mt-4 space-y-2">
          {ordem.map((reuniao, indice) => (
            <li key={reuniao.id} className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <span className="w-6 shrink-0 text-center text-sm font-semibold text-white/50">{indice + 1}</span>
              <span className="min-w-0 flex-1">
                <span dir="auto" className="block break-words text-sm font-semibold text-white">{reuniao.title}</span>
                <span className="text-xs text-white/45">{new Date(reuniao.createdAt).toLocaleString(i18n.language)}</span>
                {indice === 0 && <span className="ms-2 rounded-full bg-amber-300/15 px-2 py-0.5 text-[11px] font-semibold text-amber-200">{t("meetings.join.staysBadge")}</span>}
              </span>
              <span className="flex shrink-0 flex-col gap-1">
                <button type="button" disabled={indice === 0 || juntar.isPending} onClick={() => mover(indice, -1)} aria-label={t("meetings.join.moveUp", { titulo: reuniao.title })}
                  className="rounded-md border border-white/15 p-1 text-white/70 hover:bg-white/5 disabled:opacity-30"><ArrowUp size={14} /></button>
                <button type="button" disabled={indice === ordem.length - 1 || juntar.isPending} onClick={() => mover(indice, 1)} aria-label={t("meetings.join.moveDown", { titulo: reuniao.title })}
                  className="rounded-md border border-white/15 p-1 text-white/70 hover:bg-white/5 disabled:opacity-30"><ArrowDown size={14} /></button>
              </span>
            </li>
          ))}
        </ol>
        <ul className="mt-4 list-disc space-y-1.5 ps-5 text-sm text-white/60">
          <li>{t("meetings.join.warningSummary")}</li>
          <li>{t("meetings.join.warningLink")}</li>
          <li>{t("meetings.join.warningAudio")}</li>
          {juncaoTranscreveDeNovo(ordem) && <li>{t("meetings.join.warningOld")}</li>}
        </ul>
        <div className="mt-6 flex gap-3">
          <button type="button" onClick={aoFechar} disabled={juntar.isPending} className="flex-1 rounded-xl border border-white/15 py-2.5 text-sm text-white/60 hover:bg-white/5 disabled:opacity-50">{t("meetings.join.cancel")}</button>
          <button type="button" onClick={() => juntar.mutate({ meetingIds: ordem.map(reuniao => reuniao.id) })} disabled={juntar.isPending}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#c98f70] py-2.5 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-60">
            {juntar.isPending && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}{juntar.isPending ? t("meetings.join.joining") : t("meetings.join.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
