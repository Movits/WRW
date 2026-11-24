import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, ExternalLink, Globe, Loader2, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { mensagemDaRecusaDoComplemento } from "@/lib/mensagem-de-erro";
import { enderecoDaConsulta } from "@shared/complemento-pela-busca";

export type ComplementoNaTela = { texto: string; fonte: string | null; titulo: string | null; consultas: string[]; situacao: "pending" | "confirmed" };

/** O nome do site da fonte: o título que a busca deu, ou o domínio do endereço. */
function nomeDaFonte(complemento: ComplementoNaTela): string | null {
  if (complemento.titulo) return complemento.titulo;
  try {
    return complemento.fonte ? new URL(complemento.fonte).hostname : null;
  } catch {
    return null;
  }
}

/**
 * O complemento pela busca na web de um item do resumo (H4i,
 * server/complemento-pela-busca.ts). Sempre marcado "fora da reunião, a
 * conferir", com a fonte e, para a dona, as consultas que a busca fez (os
 * termos da busca da Google pedem mostrá-las). Pelo link aberto, só o
 * confirmado chega, e só para ler.
 *
 * Para a dona: "Completar pela web" abre o aviso do que vai à Google (texto
 * para a Cris revisar) e o "Buscar"; o achado espera "Usar o complemento" ou
 * "Descartar". O confirmado pode ser descartado.
 */
type Props = {
  itemId?: string;
  complemento?: ComplementoNaTela | null;
  peloLink: boolean;
  /** A dona, fora do refazer (H4d), no item que não está ignorado. */
  podeMexer: boolean;
  reler: () => unknown;
  idiomaDoTexto?: string;
};

export function ComplementoDoItem(props: Props) {
  // Pelo link (ou com o resumo só para ler), nada se pede nem se decide: sem as
  // mutações, só o cartão do confirmado.
  if (props.peloLink || !props.podeMexer || !props.itemId) {
    return props.complemento ? <CartaoDoComplemento complemento={props.complemento} peloLink={props.peloLink} idiomaDoTexto={props.idiomaDoTexto}/> : null;
  }
  return <ComplementoDaDona {...props} itemId={props.itemId}/>;
}

function ComplementoDaDona({ itemId, complemento, reler, idiomaDoTexto }: Props & { itemId: string }) {
  const { t } = useTranslation();
  const [perguntando, setPerguntando] = useState(false);
  const idDoAviso = useId();
  const pedir = trpc.meetings.pedirComplemento.useMutation({ onSuccess: () => setPerguntando(false), onSettled: reler });
  const decidir = trpc.meetings.decidirComplemento.useMutation({ onSettled: reler });
  const ocupado = pedir.isPending || decidir.isPending;

  const erro = pedir.isError ? mensagemDaRecusaDoComplemento(pedir.error, t)
    : decidir.isError ? mensagemDaRecusaDoComplemento(decidir.error, t) : null;

  if (!complemento) {
    return <div className="mt-2 text-xs">
      {!perguntando
        ? <button type="button" onClick={() => { pedir.reset(); setPerguntando(true); }}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-white/55 hover:bg-white/5 hover:text-white">
            <Globe size={13} aria-hidden/> {t("meetings.summary.complement.ask")}
          </button>
        : <div role="group" aria-describedby={idDoAviso} className="rounded-lg border border-sky-300/25 bg-sky-300/[0.06] p-3 text-sky-100/85">
            <p id={idDoAviso}>{t("meetings.summary.complement.notice")}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" disabled={ocupado} onClick={() => pedir.mutate({ itemId })}
                className="inline-flex items-center gap-1 rounded-lg bg-sky-300 px-3 py-1.5 font-bold text-[#0d1a22] disabled:opacity-60">
                {pedir.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden/> : <Globe size={13} aria-hidden/>}
                {pedir.isPending ? t("meetings.summary.complement.searching") : t("meetings.summary.complement.search")}
              </button>
              <button type="button" disabled={ocupado} onClick={() => setPerguntando(false)}
                className="rounded-lg border border-white/15 px-3 py-1.5 text-white/70 disabled:opacity-60">{t("meetings.summary.complement.cancel")}</button>
            </div>
          </div>}
      {erro && <p role="alert" className="mt-2 text-red-200">{erro}</p>}
    </div>;
  }

  const pendente = complemento.situacao === "pending";
  return <CartaoDoComplemento complemento={complemento} peloLink={false} idiomaDoTexto={idiomaDoTexto}>
    <div className="mt-2 flex flex-wrap gap-2">
      {pendente && <button type="button" disabled={ocupado} onClick={() => decidir.mutate({ itemId, decisao: "confirmar" })}
        className="inline-flex items-center gap-1 rounded-lg bg-sky-300 px-3 py-1.5 font-bold text-[#0d1a22] disabled:opacity-60"><Check size={13} aria-hidden/> {t("meetings.summary.complement.confirm")}</button>}
      <button type="button" disabled={ocupado} onClick={() => decidir.mutate({ itemId, decisao: "descartar" })}
        className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-white/70 disabled:opacity-60"><X size={13} aria-hidden/> {t("meetings.summary.complement.discard")}</button>
    </div>
    {erro && <p role="alert" className="mt-2 text-red-200">{erro}</p>}
  </CartaoDoComplemento>;
}

/** O complemento, marcado "fora da reunião, a conferir" (ou confirmado), com a fonte; as consultas só para a dona. */
function CartaoDoComplemento({ complemento, peloLink, idiomaDoTexto, children }: { complemento: ComplementoNaTela; peloLink: boolean; idiomaDoTexto?: string; children?: ReactNode }) {
  const { t } = useTranslation();
  const fonte = nomeDaFonte(complemento);
  const pendente = complemento.situacao === "pending";
  // O confirmado deixa de dizer "a conferir" (conferência de tela); pelo link,
  // quem lê não é a dona. Textos para a Cris revisar.
  const marca = pendente ? t("meetings.summary.complement.mark")
    : peloLink ? t("meetings.summary.complement.markConfirmedLink") : t("meetings.summary.complement.markConfirmed");
  return <div className={`mt-2 rounded-lg border p-3 text-xs ${pendente ? "border-sky-300/40 bg-sky-300/[0.08]" : "border-sky-300/20 bg-sky-300/[0.04]"}`}>
    <p className="inline-flex items-center gap-1 font-semibold uppercase tracking-wider text-sky-200/90"><Globe size={12} aria-hidden/> {marca}</p>
    <p dir="auto" lang={idiomaDoTexto} className="mt-1 text-sm text-white/85">{complemento.texto}</p>
    {complemento.fonte && <a href={complemento.fonte} target="_blank" rel="noopener noreferrer nofollow"
      className="mt-1 inline-flex items-center gap-1 break-all text-sky-200 hover:text-sky-100">
      {t("meetings.summary.complement.source", { fonte: fonte ?? complemento.fonte })} <ExternalLink size={11} aria-hidden/>
    </a>}
    {!peloLink && complemento.consultas.length > 0 && <p className="mt-1 text-white/50">
      {t("meetings.summary.complement.searched")}{" "}
      {complemento.consultas.map((consulta, i) => <span key={i}>{i > 0 && " · "}<a href={enderecoDaConsulta(consulta)} target="_blank" rel="noopener noreferrer nofollow" className="underline hover:text-white/80" dir="auto">{consulta}</a></span>)}
    </p>}
    {children}
  </div>;
}
