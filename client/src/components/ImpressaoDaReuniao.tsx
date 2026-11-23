import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { LANGUAGES } from "@/i18n";
import { mmss } from "@/components/TranscricaoPorFalante";
import { tituloDaSecao } from "@/components/ResumoGuardado";
import { SECOES_DO_RESUMO } from "@shared/item-do-resumo";
import { vozesNoTexto } from "@shared/vozes-no-texto";

/**
 * O documento do PDF da reunião (H8): a tela de impressão do aparelho o
 * transforma no PDF ("Salvar como PDF"), com as fontes do sistema. Por isso o
 * árabe sai da direita para a esquerda e o hindi, o chinês e o japonês saem
 * com as letras certas no celular e no computador, sem biblioteca nem fonte
 * embutida (shared/exportar-reuniao.ts).
 *
 * O conteúdo é o que meetings.exportar devolveu: o servidor já deixou só os
 * itens do resumo que a dona confirmou. Os rótulos (títulos das seções,
 * "Falante n", responsável, prazo) saem no idioma da REUNIÃO, com o `t` fixo
 * nele, e não no da tela: o PDF é um documento só, no idioma em que a reunião
 * aconteceu, como o resumo e a transcrição. O `lang` do documento escolhe a
 * fonte certa para o chinês e o japonês, e o `dir` vira o árabe.
 *
 * O portal fica no fim do <body>, e o body ganha a classe CLASSE_DA_IMPRESSAO
 * enquanto ele existe: na tela ele não aparece, e na impressão só ele aparece,
 * em fundo branco (client/src/index.css, "Exportar a reunião em PDF").
 */

export type ReuniaoExportada = inferRouterOutputs<AppRouter>["meetings"]["exportar"];
type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

export const CLASSE_DA_IMPRESSAO = "imprimindo-a-reuniao";

const numeroDoFalante = (falante: string) => Number(falante.replace(/^F/, "")) || 0;

/** A data por extenso, no idioma da reunião ("16 de novembro de 2026 às 14:30"; "١٦ نوفمبر ٢٠٢٦"). */
export function dataNoIdioma(ms: number, idioma: string): string {
  try {
    return new Intl.DateTimeFormat(idioma, { dateStyle: "long", timeStyle: "short" }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

export function DocumentoDaReuniao({ reuniao, t }: { reuniao: ReuniaoExportada; t: TranslateFn }) {
  const direcao = LANGUAGES.find(idioma => idioma.code === reuniao.idioma)?.dir === "rtl" ? "rtl" : "ltr";
  const comVozes = (texto: string) => vozesNoTexto(texto, reuniao.nomes, numero => t("meetings.speakerLabel", { n: numero }));
  const rotulo = (falante: string) => reuniao.nomes[falante] ?? t("meetings.speakerLabel", { n: numeroDoFalante(falante) });
  // As seções na ordem do formato da cliente, só as que têm item confirmado.
  const secoes = SECOES_DO_RESUMO
    .map(secao => ({ secao, itens: reuniao.itens.filter(item => item.secao === secao) }))
    .filter(grupo => grupo.itens.length > 0);
  const falas = reuniao.transcricao?.falas ?? [];
  const texto = reuniao.transcricao?.texto?.trim() ? reuniao.transcricao.texto : null;

  return <article lang={reuniao.idioma} dir={direcao} className="documento-da-reuniao">
    <header>
      <h1 dir="auto">{reuniao.emoji && <span className="documento-da-reuniao__emoji">{reuniao.emoji}</span>}{reuniao.titulo}</h1>
      <p className="documento-da-reuniao__data">
        {dataNoIdioma(reuniao.criadaEm, reuniao.idioma)}
        {reuniao.duracaoSegundos ? <> · {t("meetings.durationLabel")} <span dir="ltr">{mmss(reuniao.duracaoSegundos)}</span></> : null}
      </p>
    </header>

    {secoes.length > 0 && <section>
      <h2>{t("meetings.summary.title")}</h2>
      {secoes.map(({ secao, itens }) => <section key={secao}>
        <h3>{tituloDaSecao(t, secao)}</h3>
        <ul>
          {itens.map((item, posicao) => <li key={posicao} className="documento-da-reuniao__item">
            {/* A caixa de marcar das ações, como na tela: marcada quando a ação foi feita. */}
            {secao === "action" && <span aria-hidden="true" className="documento-da-reuniao__caixa">{item.feita ? "✓" : ""}</span>}
            <div>
              <p dir="auto">
                {item.assunto && <strong>{comVozes(item.assunto)}: </strong>}
                {comVozes(item.texto)}
                {secao === "action" && item.feita && <> {t("meetings.export.doneTag")}</>}
              </p>
              {(item.responsavel || item.prazo) && <p className="documento-da-reuniao__detalhe">
                {item.responsavel && <span>{t("meetings.summary.assignee", { nome: comVozes(item.responsavel) })}</span>}
                {item.responsavel && item.prazo && " · "}
                {item.prazo && <span>{t("meetings.summary.due", { prazo: item.prazo })}</span>}
              </p>}
            </div>
          </li>)}
        </ul>
      </section>)}
    </section>}

    <section>
      <h2>{t("meetings.transcriptTab")}</h2>
      {/* H18: a transcrição que a dona corrigiu sai como ela a deixou, e o PDF diz isso. */}
      {reuniao.transcricao?.editada && <p className="documento-da-reuniao__detalhe">{t("meetings.export.editedTranscript")}</p>}
      {falas.length > 0
        ? <ol>
          {falas.map((fala, posicao) => fala.lacuna
            ? <li key={posicao} className="documento-da-reuniao__lacuna">
              <span dir="ltr">{mmss(fala.inicio)}–{mmss(fala.fim)}</span> · {t("meetings.gapLabel")}
            </li>
            : <li key={posicao} className="documento-da-reuniao__fala">
              <p className="documento-da-reuniao__quem">
                {/* O tempo é sempre da esquerda para a direita, também no árabe; o nome segue a direção dele. */}
                <span dir="ltr" className="documento-da-reuniao__tempo">{mmss(fala.inicio)}</span>
                <bdi>{rotulo(fala.falante)}</bdi>
              </p>
              <p dir="auto">{fala.texto}</p>
            </li>)}
        </ol>
        : texto
          ? <p dir="auto" className="documento-da-reuniao__texto-corrido">{texto}</p>
          : <p>{t("meetings.transcriptUnavailable")}</p>}
    </section>

    <footer className="documento-da-reuniao__rodape">
      <p>{t("meetings.export.footer", { data: dataNoIdioma(reuniao.exportadaEm, reuniao.idioma) })}</p>
    </footer>
  </article>;
}

/** O documento no portal da impressão. Montado, o body ganha a classe que mostra só ele na impressão. */
export function ImpressaoDaReuniao({ reuniao, t }: { reuniao: ReuniaoExportada; t: TranslateFn }) {
  useEffect(() => {
    document.body.classList.add(CLASSE_DA_IMPRESSAO);
    return () => document.body.classList.remove(CLASSE_DA_IMPRESSAO);
  }, []);
  return createPortal(<div className="impressao-da-reuniao"><DocumentoDaReuniao reuniao={reuniao} t={t}/></div>, document.body);
}
