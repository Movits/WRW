import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RefreshCw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { mensagemDoErroDaIA } from "@/components/ReuniaoComIA";
import { MODELOS_DE_RESUMO, type ModeloDeResumo } from "@shared/modelos-de-resumo";

/**
 * Os modelos do resumo guardado (H4d do plano do gravador): Geral, Networking,
 * Mentoria, Vendas e 1:1, com as mesmas seções e outra instrução à IA
 * (server/modelos-de-resumo.ts). Só a dona escolhe: ao pedir o resumo que a
 * reunião ainda não tem (EscolhaDoModelo) e no "Refazer como…"
 * (PainelDeRefazer), que guarda os itens confirmados e as ações feitas e troca
 * os pendentes e os ignorados. O link aberto não mostra nada disto.
 */

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

// Cada ramo chama t() com a chave literal, para o teste das chaves usadas
// (server/i18n-chaves-usadas.test.ts) conferir que todas existem.
export function nomeDoModelo(t: TranslateFn, modelo: ModeloDeResumo): string {
  switch (modelo) {
    case "general": return t("meetings.summary.templateGeneral");
    case "networking": return t("meetings.summary.templateNetworking");
    case "mentoring": return t("meetings.summary.templateMentoring");
    case "sales": return t("meetings.summary.templateSales");
    case "one_on_one": return t("meetings.summary.templateOneOnOne");
  }
}

function dicaDoModelo(t: TranslateFn, modelo: ModeloDeResumo): string {
  switch (modelo) {
    case "general": return t("meetings.summary.templateGeneralHint");
    case "networking": return t("meetings.summary.templateNetworkingHint");
    case "mentoring": return t("meetings.summary.templateMentoringHint");
    case "sales": return t("meetings.summary.templateSalesHint");
    case "one_on_one": return t("meetings.summary.templateOneOnOneHint");
  }
}

/**
 * O modelo do resumo que a reunião ainda não tem, escolhido antes de pedir: o
 * rótulo, o seletor com o botão de pedir ao lado (children) e a descrição do
 * modelo escolhido embaixo.
 */
export function EscolhaDoModelo({ valor, aoMudar, desligado = false, children }: { valor: ModeloDeResumo; aoMudar: (modelo: ModeloDeResumo) => void; desligado?: boolean; children?: ReactNode }) {
  const { t } = useTranslation();
  const id = useId();
  return <div className="flex min-w-0 flex-col gap-1.5">
    <label htmlFor={`${id}-modelo`} className="text-xs font-semibold text-white/60">{t("meetings.summary.templateLabel")}</label>
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <select id={`${id}-modelo`} value={valor} disabled={desligado} aria-describedby={`${id}-dica`}
        onChange={evento => aoMudar(evento.target.value as ModeloDeResumo)}
        className="w-full rounded-lg border border-white/15 bg-[#211e1b] px-3 py-2 text-sm text-white outline-none focus:border-amber-300 disabled:opacity-60 sm:w-56">
        {MODELOS_DE_RESUMO.map(modelo => <option key={modelo} value={modelo}>{nomeDoModelo(t, modelo)}</option>)}
      </select>
      {children}
    </div>
    <p id={`${id}-dica`} className="text-xs text-white/45">{dicaDoModelo(t, valor)}</p>
  </div>;
}

// A recusa de refazer o resumo que ainda está na fila em outro modelo
// (CONFLICT) diz o que está acontecendo: a IA já está escrevendo. As outras
// (o teto de pedidos, o banco fora do ar) seguem a regra das chamadas à IA.
export function mensagemDoRefazer(t: TranslateFn, erro: unknown) {
  if ((erro as { data?: { code?: string } } | null)?.data?.code === "CONFLICT") return t("meetings.summary.generating");
  return mensagemDoErroDaIA(t, erro, t("meetings.summary.requestError"), false);
}

/**
 * "Refazer como…": a dona escolhe o modelo (o atual vem marcado: refazer nele
 * dá uma versão nova) e manda refazer. A fila guarda os itens confirmados e as
 * ações feitas e troca o resto; até lá, a tela mostra a versão anterior só
 * para ler. Aceito o pedido, o painel fecha e o resumo é relido.
 */
export function PainelDeRefazer({ id, meetingId, atual, aoFechar }: { id: string; meetingId: string; atual: ModeloDeResumo; aoFechar: () => void }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const prefixo = useId();
  const [escolhido, setEscolhido] = useState<ModeloDeResumo>(atual);
  const refazer = trpc.meetings.refazerResumo.useMutation({
    onSuccess: aoFechar,
    onSettled: () => utils.meetings.resumoGuardado.invalidate({ meetingId }),
  });
  return <div id={id} className="mt-4 rounded-xl border border-amber-300/25 bg-black/20 p-4">
    <fieldset>
      <legend className="text-sm font-semibold text-amber-100">{t("meetings.summary.templateLabel")}</legend>
      <div className="mt-3 space-y-3">
        {MODELOS_DE_RESUMO.map(modelo => <div key={modelo} className="flex items-start gap-3">
          <input type="radio" id={`${prefixo}-${modelo}`} name={`${prefixo}-modelo`} value={modelo} checked={escolhido === modelo}
            onChange={() => setEscolhido(modelo)} disabled={refazer.isPending} aria-describedby={`${prefixo}-${modelo}-dica`}
            className="mt-1 h-4 w-4 shrink-0 accent-amber-400"/>
          <div className="min-w-0">
            <label htmlFor={`${prefixo}-${modelo}`} className="cursor-pointer text-sm font-semibold text-white/90">{nomeDoModelo(t, modelo)}</label>
            <p id={`${prefixo}-${modelo}-dica`} className="text-xs text-white/50">{dicaDoModelo(t, modelo)}</p>
          </div>
        </div>)}
      </div>
    </fieldset>
    <p className="mt-4 text-xs text-amber-100/75">{t("meetings.summary.redoNotice")}</p>
    {refazer.isError && <p role="alert" className="mt-3 rounded-lg border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">{mensagemDoRefazer(t, refazer.error)}</p>}
    <div className="mt-4 flex flex-wrap gap-2">
      <button type="button" disabled={refazer.isPending} onClick={() => refazer.mutate({ meetingId, modelo: escolhido })}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-60">
        {refazer.isPending ? <Loader2 size={15} className="animate-spin"/> : <RefreshCw size={15}/>} {t("meetings.summary.redoConfirm")}
      </button>
      <button type="button" onClick={aoFechar} className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/70 hover:text-white">
        {t("meetings.summary.redoCancel")}
      </button>
    </div>
  </div>;
}
