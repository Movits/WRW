import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { BarChart3, Table2 } from "lucide-react";
import { ehGrafico, type GraficoDaResposta, type TabelaDaResposta, type VisualDaResposta as Visual } from "@shared/resposta-visual";
import { CORES_DAS_SERIES, dominioComZero, marcasDoEixo, numeroComUnidade, posicaoNoDominio } from "@/lib/grafico";

/**
 * A resposta em forma visual do Pergunte (H6d; shared/resposta-visual.ts): a
 * tabela ou o gráfico que o servidor conferiu, desenhado AQUI com os números
 * (nunca HTML, SVG ou código da IA). Todo texto do visual vai como texto, que
 * o React escapa, e as vozes ({F2}, {R2:F1}) viram nome por `comVozes`, como
 * na resposta.
 *
 * O gráfico segue a regra de visualização do projeto (a skill dataviz): barras
 * finas que crescem de uma linha de base só, com a ponta arredondada e o valor
 * na ponta quando há uma série; linhas de 2 px com o ponto de 8 px e o anel da
 * cor do fundo; a grade em linha fina; a legenda com duas séries ou mais; o
 * texto nunca na cor da série; o valor no foco e no passar do mouse; e o "Ver
 * como tabela", com os mesmos números, para quem não lê o gráfico.
 */

type ComVozes = (texto: string) => string;

export function VisualDaResposta({ visual, comVozes }: { visual: Visual; comVozes: ComVozes }) {
  const { t } = useTranslation();
  const [comoTabela, setComoTabela] = useState(false);
  const idDoTitulo = useId();
  const titulo = visual.titulo ? comVozes(visual.titulo) : "";
  const grafico = ehGrafico(visual) ? visual : null;
  return (
    <figure aria-labelledby={titulo ? idDoTitulo : undefined} className="space-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <figcaption className="flex flex-wrap items-start justify-between gap-2">
        {titulo && <span id={idDoTitulo} dir="auto" className="min-w-0 break-words text-sm font-semibold text-white/85">{titulo}</span>}
        {grafico && (
          <button type="button" onClick={() => setComoTabela(atual => !atual)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/15 px-2.5 py-1 text-xs text-white/70 hover:bg-white/5">
            {comoTabela ? <BarChart3 size={13} aria-hidden="true" /> : <Table2 size={13} aria-hidden="true" />}
            {comoTabela ? t("meetings.visual.showChart") : t("meetings.visual.showTable")}
          </button>
        )}
      </figcaption>
      {!grafico
        ? <TabelaDoVisual tabela={visual as TabelaDaResposta} comVozes={comVozes} />
        : comoTabela
          ? <TabelaDoGrafico grafico={grafico} comVozes={comVozes} />
          : <GraficoDoVisual grafico={grafico} comVozes={comVozes} />}
    </figure>
  );
}

/** A tabela, com rolagem própria quando é larga: a página nunca rola de lado. */
function TabelaDoVisual({ tabela, comVozes }: { tabela: Pick<TabelaDaResposta, "colunas" | "linhas">; comVozes: ComVozes }) {
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-start text-xs">
        <thead>
          <tr>{tabela.colunas.map((coluna, i) => <th key={i} scope="col" dir="auto" className="border-b border-white/15 px-2 py-1.5 text-start font-semibold text-white/75">{comVozes(coluna)}</th>)}</tr>
        </thead>
        <tbody>
          {tabela.linhas.map((linha, i) => (
            <tr key={i} className="border-b border-white/5 last:border-0">
              {linha.map((celula, j) => j === 0
                ? <th key={j} scope="row" dir="auto" className="px-2 py-1.5 text-start font-medium text-white/80">{celula ? comVozes(celula) : "—"}</th>
                : <td key={j} dir="auto" className="px-2 py-1.5 text-white/70 [font-variant-numeric:tabular-nums]">{celula ? comVozes(celula) : "—"}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** O gráfico como tabela: o mesmo eixo, as séries e os números no idioma da tela. */
function TabelaDoGrafico({ grafico, comVozes }: { grafico: GraficoDaResposta; comVozes: ComVozes }) {
  const { i18n } = useTranslation();
  const colunas = [grafico.eixo, ...grafico.series.map(serie => serie.nome)];
  const linhas = grafico.rotulos.map((rotulo, i) => [rotulo, ...grafico.series.map(serie => numeroComUnidade(serie.valores[i], i18n.language, grafico.unidade))]);
  return <TabelaDoVisual tabela={{ colunas, linhas }} comVozes={comVozes} />;
}

/** A legenda: com duas séries ou mais; uma série só é dita pelo título. */
function LegendaDasSeries({ grafico, comVozes, marca }: { grafico: GraficoDaResposta; comVozes: ComVozes; marca: "barra" | "linha" }) {
  const { t } = useTranslation();
  if (grafico.series.length < 2) return null;
  return (
    <ul aria-label={t("meetings.visual.legend")} className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/65">
      {grafico.series.map((serie, i) => (
        <li key={i} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={marca === "barra" ? "h-2.5 w-2.5 rounded-[2px]" : "h-0.5 w-3.5 rounded-full"} style={{ backgroundColor: CORES_DAS_SERIES[i] }} />
          <span dir="auto">{comVozes(serie.nome)}</span>
        </li>
      ))}
    </ul>
  );
}

function GraficoDoVisual({ grafico, comVozes }: { grafico: GraficoDaResposta; comVozes: ComVozes }) {
  return grafico.tipo === "barras"
    ? <GraficoDeBarras grafico={grafico} comVozes={comVozes} />
    : <GraficoDeLinhas grafico={grafico} comVozes={comVozes} />;
}

/**
 * As barras, em HTML: deitadas (os nomes compridos cabem no celular), da linha
 * de base para a ponta, que segue a direção da escrita (no árabe, crescem para
 * a esquerda). Cada barra mostra o valor no passar do mouse e no foco.
 */
function GraficoDeBarras({ grafico, comVozes }: { grafico: GraficoDaResposta; comVozes: ComVozes }) {
  const { t, i18n } = useTranslation();
  const [emFoco, setEmFoco] = useState<string | null>(null);
  const uma = grafico.series.length === 1;
  const { dominio } = marcasDoEixo(dominioComZero(grafico.series.flatMap(serie => serie.valores)));
  const base = posicaoNoDominio(0, dominio);
  const valor = (numero: number) => numeroComUnidade(numero, i18n.language, grafico.unidade);
  return (
    <div className="space-y-2">
      <LegendaDasSeries grafico={grafico} comVozes={comVozes} marca="barra" />
      <ul role="list" aria-label={t("meetings.visual.chartLabel", { titulo: grafico.titulo ? comVozes(grafico.titulo) : grafico.eixo })} className="space-y-2.5">
        {grafico.rotulos.map((rotulo, linha) => (
          <li key={linha} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
            <span dir="auto" className="break-words text-xs text-white/70">{comVozes(rotulo)}</span>
            <span className="space-y-0.5">
              {grafico.series.map((serie, s) => {
                const numero = serie.valores[linha];
                const ponta = posicaoNoDominio(numero, dominio);
                const inicio = Math.min(base, ponta) * 100;
                const largura = Math.max(Math.abs(ponta - base) * 100, numero === 0 ? 0 : 0.8);
                const chave = `${linha}-${s}`;
                const rotuloDaBarra = `${comVozes(rotulo)}${uma ? "" : ` · ${comVozes(serie.nome)}`}: ${valor(numero)}`;
                return (
                  <span key={s} className="relative flex items-center gap-2">
                    <span className="relative block flex-1" style={{ height: uma ? 16 : 10 }}>
                      {/* A linha de base, fina e discreta. */}
                      <span aria-hidden="true" className="absolute inset-y-[-3px] w-px bg-white/25" style={{ insetInlineStart: `${base * 100}%` }} />
                      <span role="img" tabIndex={0} aria-label={rotuloDaBarra}
                        onMouseEnter={() => setEmFoco(chave)} onMouseLeave={() => setEmFoco(atual => (atual === chave ? null : atual))}
                        onFocus={() => setEmFoco(chave)} onBlur={() => setEmFoco(atual => (atual === chave ? null : atual))}
                        className={`absolute inset-y-0 outline-none focus-visible:ring-2 focus-visible:ring-white/60 hover:brightness-125 ${numero < 0 ? "rounded-s-[4px]" : "rounded-e-[4px]"}`}
                        style={{ insetInlineStart: `${inicio}%`, width: `${largura}%`, backgroundColor: CORES_DAS_SERIES[s] }} />
                      {emFoco === chave && (
                        <span role="tooltip" className="pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-md border border-white/15 bg-[#211e1b] px-2 py-1 text-[11px] shadow-lg" style={{ insetInlineStart: `${inicio}%` }}>
                          <strong className="font-semibold text-white">{valor(numero)}</strong>
                          {!uma && <span dir="auto" className="ms-1.5 text-white/60">{comVozes(serie.nome)}</span>}
                        </span>
                      )}
                    </span>
                    {/* O valor na ponta só com uma série: com várias, um número em cada barra seria ruído. */}
                    {uma && <span className="w-16 shrink-0 text-xs text-white/75 [font-variant-numeric:tabular-nums]">{valor(numero)}</span>}
                  </span>
                );
              })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// O desenho das linhas, em unidades do viewBox; o SVG ocupa a largura da caixa.
const LARGURA = 600;
const ALTURA = 220;
const MARGEM = { topo: 12, base: 34, inicio: 52, fim: 16 };
const COR_DO_FUNDO = "#1d1a18";

/**
 * As linhas, em SVG, da esquerda para a direita (a ordem do tempo, também no
 * árabe). A cruz acha o ponto: passar o mouse (ou focar) numa faixa mostra a
 * linha vertical e o valor de todas as séries naquele ponto.
 */
function GraficoDeLinhas({ grafico, comVozes }: { grafico: GraficoDaResposta; comVozes: ComVozes }) {
  const { t, i18n } = useTranslation();
  const [emFoco, setEmFoco] = useState<number | null>(null);
  const { marcas, dominio } = marcasDoEixo(dominioComZero(grafico.series.flatMap(serie => serie.valores)));
  const larguraUtil = LARGURA - MARGEM.inicio - MARGEM.fim;
  const alturaUtil = ALTURA - MARGEM.topo - MARGEM.base;
  const pontos = grafico.rotulos.length;
  const x = (indice: number) => MARGEM.inicio + (pontos === 1 ? larguraUtil / 2 : (indice / (pontos - 1)) * larguraUtil);
  const y = (valor: number) => MARGEM.topo + (1 - posicaoNoDominio(valor, dominio)) * alturaUtil;
  const faixa = pontos === 1 ? larguraUtil : larguraUtil / (pontos - 1);
  // Com muitos pontos, um nome sim e outro não, para não se encavalarem.
  const pulo = pontos > 6 ? 2 : 1;
  const curto = (texto: string) => (Array.from(texto).length > 12 ? `${Array.from(texto).slice(0, 11).join("")}…` : texto);
  const valor = (numero: number) => numeroComUnidade(numero, i18n.language, grafico.unidade);
  return (
    <div className="space-y-2">
      <LegendaDasSeries grafico={grafico} comVozes={comVozes} marca="linha" />
      <div dir="ltr" className="relative">
        <svg viewBox={`0 0 ${LARGURA} ${ALTURA}`} className="block h-auto w-full" role="img"
          aria-label={t("meetings.visual.chartLabel", { titulo: grafico.titulo ? comVozes(grafico.titulo) : grafico.eixo })}>
          {marcas.map(marca => (
            <g key={marca}>
              <line x1={MARGEM.inicio} x2={LARGURA - MARGEM.fim} y1={y(marca)} y2={y(marca)} stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
              <text x={MARGEM.inicio - 8} y={y(marca)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="rgba(255,255,255,0.5)" style={{ fontVariantNumeric: "tabular-nums" }}>
                {numeroComUnidade(marca, i18n.language, "", true)}
              </text>
            </g>
          ))}
          {grafico.rotulos.map((rotulo, i) => (i % pulo === 0 || i === pontos - 1) && (
            <text key={i} x={x(i)} y={ALTURA - MARGEM.base + 18} textAnchor="middle" fontSize={11} fill="rgba(255,255,255,0.55)">{curto(comVozes(rotulo))}</text>
          ))}
          {emFoco !== null && <line x1={x(emFoco)} x2={x(emFoco)} y1={MARGEM.topo} y2={ALTURA - MARGEM.base} stroke="rgba(255,255,255,0.35)" strokeWidth={1} />}
          {grafico.series.map((serie, s) => (
            <g key={s}>
              <polyline points={serie.valores.map((numero, i) => `${x(i)},${y(numero)}`).join(" ")} fill="none" stroke={CORES_DAS_SERIES[s]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {serie.valores.map((numero, i) => <circle key={i} cx={x(i)} cy={y(numero)} r={4} fill={CORES_DAS_SERIES[s]} stroke={COR_DO_FUNDO} strokeWidth={2} />)}
            </g>
          ))}
          {/* As faixas que acham o ponto: maiores que a marca, uma por ponto, com o foco do teclado. */}
          {grafico.rotulos.map((rotulo, i) => (
            <rect key={i} x={x(i) - faixa / 2} y={MARGEM.topo} width={faixa} height={alturaUtil} fill="transparent" tabIndex={0}
              aria-label={`${comVozes(rotulo)}: ${grafico.series.map(serie => `${comVozes(serie.nome)} ${valor(serie.valores[i])}`).join(", ")}`}
              onMouseEnter={() => setEmFoco(i)} onMouseLeave={() => setEmFoco(atual => (atual === i ? null : atual))}
              onFocus={() => setEmFoco(i)} onBlur={() => setEmFoco(atual => (atual === i ? null : atual))} className="outline-none" />
          ))}
        </svg>
        {emFoco !== null && (
          <div role="tooltip" className="pointer-events-none absolute top-0 z-10 rounded-md border border-white/15 bg-[#211e1b] px-2 py-1.5 text-[11px] shadow-lg"
            style={{ left: `${(x(emFoco) / LARGURA) * 100}%`, transform: emFoco > pontos / 2 ? "translateX(-100%)" : "translateX(4px)" }}>
            <p dir="auto" className="mb-1 text-white/60">{comVozes(grafico.rotulos[emFoco])}</p>
            {grafico.series.map((serie, s) => (
              <p key={s} className="flex items-center gap-1.5 whitespace-nowrap">
                <span aria-hidden="true" className="h-0.5 w-3 rounded-full" style={{ backgroundColor: CORES_DAS_SERIES[s] }} />
                <strong className="font-semibold text-white">{valor(serie.valores[emFoco])}</strong>
                {grafico.series.length > 1 && <span dir="auto" className="text-white/60">{comVozes(serie.nome)}</span>}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
