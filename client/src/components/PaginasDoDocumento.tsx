import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2 } from "lucide-react";
import { buscarDocumentoGuardado, FalhaAoBuscarODocumento } from "@/lib/envio-do-documento";
import { abrirPdf, type DocumentoAberto } from "@/lib/leitor-de-pdf";

/**
 * As páginas do documento guardado (H12b do desenho do gravador), só na tela
 * da dona: o PDF enviado, ou as fotos do texto que o aparelho juntou num PDF,
 * página a página, com anterior e próxima. O link aberto não tem esta aba nem
 * o arquivo (server/link-aberto-da-reuniao.ts).
 *
 * Os bytes vêm da rota da dona (GET /api/reunioes/{id}/documento) e ficam no
 * cache do React Query enquanto a reunião está aberta: trocar de aba e voltar
 * não baixa o arquivo de novo. O desenho é do pdf.js (lib/leitor-de-pdf.ts),
 * carregado só aqui. O arquivo dura 30 dias, como o áudio: depois, a aba diz
 * que ele saiu, e o texto lido continua na aba do texto.
 */

export type DocumentoNaTela = { url: string; mimeType: string; sizeBytes: number; expiresAt: number };

const doisMinutos = 2 * 60_000;

export function PaginasDoDocumento({ meetingId, documento, documentoExpirado, documentoSaindo }: {
  meetingId: string;
  documento: DocumentoNaTela | null;
  documentoExpirado: boolean;
  documentoSaindo: boolean;
}) {
  const { t, i18n } = useTranslation();
  const bytes = useQuery({
    queryKey: ["documento-da-reuniao", meetingId],
    queryFn: () => buscarDocumentoGuardado(meetingId),
    enabled: documento !== null,
    staleTime: Infinity,
    gcTime: doisMinutos,
    // O arquivo que saiu (404) não volta; a rede e o servidor, sim.
    retry: (tentativas, erro) => !(erro instanceof FalhaAoBuscarODocumento && erro.status === 404) && tentativas < 2,
    refetchOnWindowFocus: false,
  });
  const [aberto, setAberto] = useState<DocumentoAberto | null>(null);
  const [falhou, setFalhou] = useState(false);
  const [pagina, setPagina] = useState(1);
  const [desenhando, setDesenhando] = useState(false);
  const [largura, setLargura] = useState(0);
  const moldura = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);

  // Abre o PDF quando os bytes chegam e o fecha ao sair (o worker do pdf.js guarda o documento).
  useEffect(() => {
    if (!bytes.data) return;
    let cancelado = false;
    let documentoAberto: DocumentoAberto | null = null;
    setFalhou(false);
    abrirPdf(bytes.data).then(
      novo => {
        if (cancelado) return novo.fechar();
        documentoAberto = novo;
        setPagina(atual => Math.min(Math.max(atual, 1), novo.paginas));
        setAberto(novo);
      },
      () => { if (!cancelado) setFalhou(true); },
    );
    return () => {
      cancelado = true;
      documentoAberto?.fechar();
      setAberto(null);
    };
  }, [bytes.data]);

  // A largura da moldura decide a escala do desenho; girar o celular desenha de novo.
  useEffect(() => {
    const elemento = moldura.current;
    if (!elemento) return;
    const medir = () => setLargura(Math.round(elemento.clientWidth) || 600);
    medir();
    if (typeof ResizeObserver === "undefined") return;
    const observador = new ResizeObserver(medir);
    observador.observe(elemento);
    return () => observador.disconnect();
  }, [aberto]);

  useEffect(() => {
    if (!aberto || !canvas.current || !largura) return;
    let valendo = true;
    setDesenhando(true);
    aberto.desenharPagina(pagina, canvas.current, largura).then(
      () => { if (valendo) setDesenhando(false); },
      (erro: unknown) => {
        // Trocar de página no meio cancela o desenho anterior: não é falha.
        if ((erro as { name?: string } | null)?.name === "RenderingCancelledException") return;
        if (valendo) { setDesenhando(false); setFalhou(true); }
      },
    );
    return () => { valendo = false; };
  }, [aberto, pagina, largura]);

  if (!documento) {
    return <p className="text-sm text-white/50">{documentoExpirado ? t("meetings.document.fileExpired") : documentoSaindo ? t("meetings.document.fileDeletionPending") : t("meetings.document.noFileStored")}</p>;
  }

  const abrirNoNavegador = <a href={documento.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm text-white/75 hover:bg-white/5">
    <ExternalLink size={15}/> {t("meetings.document.openPdf")}
  </a>;

  if (bytes.isError) {
    const saiu = bytes.error instanceof FalhaAoBuscarODocumento && bytes.error.status === 404;
    return <div role="alert" className="space-y-3 text-sm text-white/70">
      <p>{saiu ? t("meetings.document.fileDeletionPending") : t("meetings.document.loadError")}</p>
      {!saiu && <button type="button" onClick={() => void bytes.refetch()} className="rounded-lg border border-amber-300/30 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-300/10">{t("errorBoundary.retryButton")}</button>}
    </div>;
  }
  if (falhou) {
    return <div role="alert" className="space-y-3 text-sm text-white/70"><p>{t("meetings.document.renderError")}</p>{abrirNoNavegador}</div>;
  }
  if (!aberto) {
    return <p role="status" className="text-sm text-white/55"><Loader2 className="inline animate-spin me-2" size={16}/>{t("meetings.document.loadingPages")}</p>;
  }

  const total = aberto.paginas;
  const posicao = t("meetings.document.pageOf", { pagina: pagina.toLocaleString(i18n.language), total: total.toLocaleString(i18n.language) });
  return <div className="space-y-3">
    <nav aria-label={t("meetings.document.pagesNav")} className="flex items-center justify-between gap-2">
      <button type="button" onClick={() => setPagina(atual => Math.max(1, atual - 1))} disabled={pagina <= 1}
        aria-label={t("meetings.document.previousPage")}
        className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-2 text-sm text-white/75 hover:bg-white/5 disabled:opacity-30">
        <ChevronLeft size={16} className="rtl:rotate-180"/><span className="hidden sm:inline">{t("meetings.document.previousPage")}</span>
      </button>
      <span aria-live="polite" className="min-w-0 text-center text-sm text-white/70">
        {desenhando && <Loader2 className="inline animate-spin me-2" size={14}/>}
        {posicao}
      </span>
      <button type="button" onClick={() => setPagina(atual => Math.min(total, atual + 1))} disabled={pagina >= total}
        aria-label={t("meetings.document.nextPage")}
        className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-2 text-sm text-white/75 hover:bg-white/5 disabled:opacity-30">
        <span className="hidden sm:inline">{t("meetings.document.nextPage")}</span><ChevronRight size={16} className="rtl:rotate-180"/>
      </button>
    </nav>
    {/* A página ocupa a largura da aba, nunca mais: no celular de 375 px não há rolagem lateral.
        dir="ltr": o canvas herda a direção da página, e com a tela em árabe o
        pdf.js desenhava cada letra fora do lugar (o texto do PDF tem as
        posições dele, que valem da esquerda para a direita). */}
    <div ref={moldura} dir="ltr" className="w-full max-w-full overflow-hidden rounded-xl border border-white/10 bg-white">
      <canvas ref={canvas} aria-label={posicao} role="img" className="block h-auto w-full"/>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-white/45">{t("meetings.document.availableUntil", { date: new Date(documento.expiresAt).toLocaleDateString(i18n.language) })}</p>
      {abrirNoNavegador}
    </div>
  </div>;
}
