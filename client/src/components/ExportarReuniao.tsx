import { useEffect, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { FileDown, Loader2, Printer } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { abertoNaCascaDasLojas, ambienteAtual } from "@/lib/instalacao-do-app";
import { ImpressaoDaReuniao, type ReuniaoExportada } from "@/components/ImpressaoDaReuniao";

/**
 * "Baixar PDF" no detalhe da reunião (H8; só PDF, decisão do Roberto de
 * 16/11/2026). Só a dona tem o botão: a página do link aberto não o monta, e o
 * servidor não tem rota de exportar pelo link.
 *
 * Antes de exportar, um aviso (a Cris revisa o texto, meetings.export.notice):
 * o arquivo sai da WRW com a transcrição, os nomes das vozes e os itens que a
 * dona confirmou. Ao confirmar, o servidor lê a reunião e grava a auditoria na
 * mesma transação (server/exportar-reuniao.ts), o documento entra no portal da
 * impressão (ImpressaoDaReuniao) e a tela de impressão do aparelho abre: no
 * computador e no Android, "Salvar como PDF"; no iPhone, Compartilhar e
 * "Salvar em Arquivos". O aparelho que não abre a impressão sozinho (o
 * navegador que a segura sem um toque, o app instalado) tem o "Abrir a
 * impressão de novo", que a abre direto do toque.
 *
 * O pedido, o documento e o portal moram no diálogo, que só monta quando a
 * dona toca no botão: fechar descarta tudo, e o PDF seguinte é pedido (e
 * auditado) de novo.
 */

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

// O código tRPC decide a frase: as mensagens do servidor vêm em português.
function mensagemDoErro(t: TranslateFn, erro: unknown) {
  switch ((erro as { data?: { code?: string } } | null)?.data?.code) {
    case "NOT_FOUND": return t("meetings.meetingNotFound");
    case "PRECONDITION_FAILED": return t("meetings.export.onlyReady");
    // O teto da exportação e o limite da API vêm com frase do servidor, que a tabela traduz.
    case "TOO_MANY_REQUESTS":
    case "INTERNAL_SERVER_ERROR": return mensagemDeErroParaTela(erro, t);
    default: return t("meetings.export.error");
  }
}

/** O nome que o "Salvar como PDF" sugere: o título e a data da reunião, sem o que o sistema de arquivos recusa. */
export function nomeDoArquivo(reuniao: Pick<ReuniaoExportada, "titulo" | "criadaEm">): string {
  const data = new Date(reuniao.criadaEm);
  const dia = [data.getFullYear(), String(data.getMonth() + 1).padStart(2, "0"), String(data.getDate()).padStart(2, "0")].join("-");
  const titulo = reuniao.titulo.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  return titulo ? `${titulo} - ${dia}` : dia;
}

export function ExportarReuniao({ meetingId, confirmados }: {
  meetingId: string;
  /** Quantos itens do resumo a dona confirmou: o aviso diz quantos vão no PDF. */
  confirmados: number;
}) {
  const { t } = useTranslation();
  const [aberto, setAberto] = useState(false);
  const botao = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={botao} type="button" onClick={() => setAberto(true)}
      className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/30 px-3 py-1 text-xs text-amber-200 hover:bg-amber-300/10">
      <FileDown size={13} aria-hidden="true"/> {t("meetings.export.button")}
    </button>
    {aberto && <DialogoDaExportacao meetingId={meetingId} confirmados={confirmados}
      aoFechar={() => { setAberto(false); botao.current?.focus(); }}/>}
  </>;
}

function DialogoDaExportacao({ meetingId, confirmados, aoFechar }: { meetingId: string; confirmados: number; aoFechar: () => void }) {
  const { t, i18n } = useTranslation();
  const [exportada, setExportada] = useState<ReuniaoExportada | null>(null);
  const exportar = trpc.meetings.exportar.useMutation();
  const idDoTitulo = useId();
  const idDoAviso = useId();
  // No app instalado (da tela de início ou a casca das lojas), a impressão pode não abrir: a dica manda ao navegador.
  const noAppInstalado = useMemo(() => {
    const ambiente = ambienteAtual();
    return ambiente.abertoComoApp || abertoNaCascaDasLojas(ambiente.userAgent);
  }, []);

  // Enquanto a impressão está aberta, o título da aba vira o nome do arquivo
  // (o "Salvar como PDF" o sugere). Ele volta quando a impressão fecha, ou
  // quando o diálogo sai da tela. Null: o título já voltou.
  const tituloDaAba = useRef<string | null>(null);
  useEffect(() => {
    const devolver = () => {
      if (tituloDaAba.current === null) return;
      document.title = tituloDaAba.current;
      tituloDaAba.current = null;
    };
    window.addEventListener("afterprint", devolver);
    return () => {
      window.removeEventListener("afterprint", devolver);
      devolver();
    };
  }, []);
  function imprimir(dados: ReuniaoExportada) {
    if (tituloDaAba.current === null) tituloDaAba.current = document.title;
    document.title = nomeDoArquivo(dados);
    window.print();
  }

  function baixar() {
    exportar.mutate({ meetingId, formato: "pdf" }, {
      onSuccess: dados => {
        // O documento entra no portal ANTES de a impressão abrir: ela imprime o que está no DOM.
        flushSync(() => setExportada(dados));
        imprimir(dados);
      },
    });
  }

  // Os rótulos do PDF saem no idioma da reunião, que o servidor devolve; o diálogo segue no da tela.
  const tDoPdf = exportada ? i18n.getFixedT(exportada.idioma) : null;

  return <>
    <div role="dialog" aria-modal="true" aria-labelledby={idDoTitulo} aria-describedby={idDoAviso}
      onKeyDown={evento => { if (evento.key === "Escape" && !exportar.isPending) aoFechar(); }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl border border-white/15 bg-[#211e1b] p-6 text-start shadow-2xl">
        <h3 id={idDoTitulo} className="mb-2 inline-flex items-center gap-2 text-base font-bold text-white">
          <FileDown size={18} className="text-amber-300" aria-hidden="true"/>{t("meetings.export.title")}
        </h3>
        <p id={idDoAviso} className="text-sm leading-6 text-white/70">{t("meetings.export.notice")}</p>
        <p className="mt-3 text-sm text-amber-100/85">
          {confirmados > 0 ? t("meetings.export.confirmedItems", { n: confirmados }) : t("meetings.export.noConfirmedItems")}
        </p>
        {exportada ? <>
          <p role="status" className="mt-4 rounded-xl border border-emerald-400/25 bg-emerald-400/10 p-3 text-sm text-emerald-100">{t("meetings.export.ready")}</p>
          {noAppInstalado && <p className="mt-2 text-xs text-white/55">{t("meetings.export.installedAppHint")}</p>}
          <div className="mt-5 flex flex-wrap gap-3">
            <button type="button" autoFocus onClick={() => imprimir(exportada)}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#c98f70] px-4 py-2.5 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8]">
              <Printer size={15} aria-hidden="true"/> {t("meetings.export.printAgain")}
            </button>
            <button type="button" onClick={aoFechar}
              className="rounded-xl border border-white/15 px-4 py-2.5 text-sm text-white/65 hover:bg-white/5">
              {t("meetings.export.close")}
            </button>
          </div>
        </> : <>
          {exportar.isPending && <p role="status" className="mt-4 text-sm text-white/55">
            <Loader2 size={15} className="me-2 inline animate-spin" aria-hidden="true"/>{t("meetings.export.preparing")}
          </p>}
          {exportar.isError && <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">
            {mensagemDoErro(t, exportar.error)}
          </p>}
          <div className="mt-5 flex flex-wrap gap-3">
            <button type="button" autoFocus onClick={baixar} disabled={exportar.isPending}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#c98f70] px-4 py-2.5 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-50">
              {exportar.isPending ? <Loader2 size={15} className="animate-spin" aria-hidden="true"/> : <FileDown size={15} aria-hidden="true"/>} {t("meetings.export.confirm")}
            </button>
            <button type="button" onClick={aoFechar} disabled={exportar.isPending}
              className="rounded-xl border border-white/15 px-4 py-2.5 text-sm text-white/65 hover:bg-white/5 disabled:opacity-50">
              {t("meetings.export.cancel")}
            </button>
          </div>
        </>}
      </div>
    </div>

    {exportada && tDoPdf && <ImpressaoDaReuniao reuniao={exportada} t={tDoPdf}/>}
  </>;
}
