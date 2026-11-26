import { useTranslation } from "react-i18next";
import { segmentarTranscricao, TIPOS_DE_ENTIDADE } from "@/lib/transcricao-destacada";
import type { PaginaDoDocumento } from "@shared/documento-da-reuniao";

/**
 * O texto que a IA leu do documento (H12 e H12b), página a página, no lugar
 * da transcrição por falante: cada página com o número dela, os destaques do
 * que a extração achou (como na transcrição) e, no topo, os atalhos para cada
 * página. A página sem texto legível fica, com o aviso, para a numeração bater
 * com a do PDF. A tradução, quando pedida, sai inteira, sem as páginas: a IA
 * traduz o texto corrido (o detalhe da reunião mostra o texto traduzido como
 * mostra o da transcrição).
 */
export function TextoDoDocumento({ paginas, entidades, idPrefixo }: {
  paginas: PaginaDoDocumento[];
  entidades: Parameters<typeof segmentarTranscricao>[1] | null;
  /** O começo dos ids das páginas, para os atalhos acharem cada uma. */
  idPrefixo: string;
}) {
  const { t, i18n } = useTranslation();
  const idDaPagina = (numero: number) => `${idPrefixo}-pagina-${numero}`;
  return <div className="space-y-5">
    {paginas.length > 1 && <nav aria-label={t("meetings.document.goToPage")} className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-white/45">{t("meetings.document.goToPage")}</span>
      {paginas.map(({ pagina }) => <button key={pagina} type="button"
        onClick={() => document.getElementById(idDaPagina(pagina))?.scrollIntoView({ behavior: "smooth", block: "start" })}
        className="min-w-9 rounded-lg border border-white/15 px-2 py-1 text-xs text-white/70 hover:bg-white/5">
        {pagina.toLocaleString(i18n.language)}
      </button>)}
    </nav>}
    {paginas.map(({ pagina, texto }) => {
      const trechos = texto && entidades ? segmentarTranscricao(texto, entidades) : null;
      return <section key={pagina} id={idDaPagina(pagina)} aria-labelledby={`${idDaPagina(pagina)}-titulo`} className="scroll-mt-4">
        <h3 id={`${idDaPagina(pagina)}-titulo`} className="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-200/80">{t("meetings.document.pageHeading", { pagina: pagina.toLocaleString(i18n.language) })}</h3>
        {!texto
          ? <p className="text-sm text-white/40">{t("meetings.document.emptyPage")}</p>
          : <p dir="auto" className="whitespace-pre-wrap break-words leading-7 text-white/75">{trechos
            ? trechos.map((trecho, i) => trecho.tipo
              ? <mark key={i} title={t(TIPOS_DE_ENTIDADE[trecho.tipo].chave)} className={`rounded-md px-1 py-0.5 font-medium ${TIPOS_DE_ENTIDADE[trecho.tipo].classes}`}>{trecho.texto}</mark>
              : <span key={i}>{trecho.texto}</span>)
            : texto}</p>}
      </section>;
    })}
  </div>;
}
