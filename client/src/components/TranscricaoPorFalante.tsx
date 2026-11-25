import { NOME_DO_FALANTE_MAX } from "@shared/const";
import { textoTemFala } from "@shared/fala-na-transcricao";
import { primeiraFalaComOTermo, temOTermo, trechosDoTermo } from "@shared/busca-de-reunioes";
import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Check, Headphones, Pencil, Play, RotateCcw, Search } from "lucide-react";
import { FormularioDoTrecho } from "@/components/FormularioDoTrecho";

/** Onde o navegador de quem lê guarda se a transcrição mostra as vozes e os horários (D2). */
export const CHAVE_DAS_VOZES_NA_TRANSCRICAO = "wrw:transcricao-com-vozes";
export const CHAVE_DOS_HORARIOS_NA_TRANSCRICAO = "wrw:transcricao-com-horarios";

/** A escolha guardada neste navegador; sem ela (ou sem armazenamento), mostra. */
function mostraGuardado(chave: string): boolean {
  try {
    return localStorage.getItem(chave) !== "0";
  } catch {
    return true;
  }
}

function guardarMostra(chave: string, mostra: boolean) {
  try {
    localStorage.setItem(chave, mostra ? "1" : "0");
  } catch {
    // Sem armazenamento: a escolha vale só nesta visita.
  }
}

/** O segmento do contrato do desenho: tempo absoluto em segundos, falante F1, F2... */
export type SegmentoDaTela = { inicio: number; fim: number; falante: string; texto: string; lacuna?: boolean };

export function mmss(segundos: number) {
  const s = Math.max(0, Math.floor(segundos));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const resto = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${resto}` : `${String(m).padStart(2, "0")}:${resto}`;
}

/** Os segmentos que vieram no formato do contrato; o resto (transcrição antiga, sem falantes) fica de fora. */
export function segmentosValidos(bruto: unknown): SegmentoDaTela[] {
  if (!Array.isArray(bruto)) return [];
  return bruto.filter((s): s is SegmentoDaTela =>
    !!s && typeof s === "object" && typeof (s as SegmentoDaTela).inicio === "number" && typeof (s as SegmentoDaTela).fim === "number"
    && typeof (s as SegmentoDaTela).texto === "string" && typeof (s as SegmentoDaTela).falante === "string");
}

/**
 * Quanto tempo cada voz falou, da que mais falou para a que menos falou. O
 * trecho que é só marca entre colchetes ([música], [ruído], [inaudível]) não é
 * fala (textoTemFala): a vinheta de um vídeo do YouTube não vira uma voz que
 * não existe, nem entra na conta das outras.
 */
export function tempoDeFala(segmentos: SegmentoDaTela[]) {
  const porFalante = new Map<string, number>();
  for (const s of segmentos) {
    if (s.lacuna || !s.falante || !textoTemFala(s.texto)) continue;
    porFalante.set(s.falante, (porFalante.get(s.falante) ?? 0) + Math.max(0, s.fim - s.inicio));
  }
  const total = Array.from(porFalante.values()).reduce((a, b) => a + b, 0);
  return Array.from(porFalante.entries())
    .map(([falante, segundos]) => ({ falante, segundos, fracao: total ? segundos / total : 0 }))
    .sort((a, b) => b.segundos - a.segundos);
}

const numeroDoFalante = (falante: string) => Number(falante.replace(/^F/, "")) || 0;

// O termo destacado sem acento e sem caixa, a régua da busca do servidor
// (trechosDoTermo): "reuniao" destaca "Reunião".
function comDestaque(texto: string, termo: string) {
  if (!termo) return texto;
  const trechos = trechosDoTermo(texto, termo);
  if (!trechos.length) return texto;
  const partes: Array<string | ReactElement> = [];
  let de = 0;
  for (const [inicio, fim] of trechos) {
    partes.push(texto.slice(de, inicio));
    partes.push(<mark key={inicio} className="rounded bg-amber-300/40 px-0.5 text-white">{texto.slice(inicio, fim)}</mark>);
    de = fim;
  }
  partes.push(texto.slice(de));
  return partes;
}

/**
 * A transcrição por falante (D1 do desenho do gravador): cada fala com o
 * rótulo "Falante n" (só na tela; no banco é F1, F2...), o tempo em que
 * começou (clicar pula o player para ali), a busca com destaque e o tempo de
 * fala de cada voz. O trecho que não chegou aparece como tal.
 *
 * D2 (HN-26 do HiNoter): quem lê mostra ou esconde as vozes e os horários
 * (guardado no navegador), e, com o player, escolhe ouvir só uma voz: o player
 * toca só as falas dela, e a lista mostra só essas falas, até voltar a todas.
 *
 * H18 (HN-23 e HN-27 do HiNoter): na tela da dona, o trecho que ela mudou leva
 * a marca "editado"; com a edição ligada, cada trecho ganha "Editar" (o texto
 * e a voz), o original da IA e "Voltar ao original". A posição de um trecho é
 * a dele em `segmentos`, a mesma que o servidor conta.
 */
export function TranscricaoPorFalante({ segmentos, aoIrPara, linkDoTempo, termoInicial = "", nomes = {}, aoNomear, nomeNoLink, soAVoz = null, aoOuvirSoAVoz, edicao }: {
  segmentos: SegmentoDaTela[];
  aoIrPara?: (segundo: number) => void;
  /**
   * A reunião que veio de um vídeo do YouTube (H13) não tem player: o tempo de
   * cada fala vira um link para o vídeo naquele segundo, numa aba nova.
   */
  linkDoTempo?: (segundo: number) => string;
  termoInicial?: string;
  /** H3: os nomes que a dona deu às vozes ({ F1: "Ana" }). */
  nomes?: Readonly<Record<string, string>>;
  /** Só na tela da dona: dar ou tirar (nome vazio) o nome de uma voz. */
  aoNomear?: (falante: string, nome: string) => Promise<unknown>;
  /**
   * Só na tela da dona, com o link aberto ligado (H3b): o campo do nome diz se
   * o nome sai também pelo link. "aparece": o link foi ligado com a
   * confirmação que fala dos nomes. "naoAparece": o link é da confirmação
   * antiga, e a dica diz como mostrar o nome (desligar e compartilhar de novo).
   * Sem link, nenhuma dica.
   */
  nomeNoLink?: "aparece" | "naoAparece";
  /** D2: a voz que o player toca sozinha (nula: todas); a lista mostra só as falas dela. */
  soAVoz?: string | null;
  /** D2: ouvir só uma voz (nulo volta a todas). Sem player, o botão não aparece. */
  aoOuvirSoAVoz?: (falante: string | null) => void;
  /**
   * H18, só na tela da dona: o que a IA escreveu em cada trecho que ela mudou,
   * pela posição em `segmentos`; com `editando`, os botões de editar e de
   * voltar ao original. O link aberto não recebe nada disto.
   */
  edicao?: {
    originais: ReadonlyMap<number, { texto: string; falante: string }>;
    editando: boolean;
    aoSalvarTrecho: (indice: number, mudancas: { texto?: string; falante?: string }) => Promise<boolean>;
    aoRestaurar: (indice: number) => Promise<unknown>;
  };
}) {
  const { t } = useTranslation();
  const idDaDicaDoLink = useId();
  const dicaDoLink = nomeNoLink === "aparece" ? t("meetings.speakerNameLinkHint")
    : nomeNoLink === "naoAparece" ? t("meetings.speakerNameRelinkHint")
    : null;
  const [termo, setTermo] = useState(termoInicial);
  const busca = termo.trim();
  // O termo do link (?q, o resultado da busca entre as reuniões) abre a
  // transcrição INTEIRA no ponto: a primeira fala com o termo, rolada até a
  // vista e marcada, com o termo destacado em todas. A lista só filtra quando
  // quem lê mexe na busca. Antes (defeito 1 do teste manual T50, 23/11), o
  // link só filtrava, e a reunião abria sem ir ao trecho encontrado.
  const [filtrar, setFiltrar] = useState(!termoInicial.trim());
  const falaDoLink = useMemo(() => primeiraFalaComOTermo(segmentos, termoInicial), [segmentos, termoInicial]);
  const jaRolouAteOLink = useRef(false);
  // D2: mostrar ou esconder as vozes e os horários, como quem lê deixou da última vez.
  const [comVozes, setComVozes] = useState(() => mostraGuardado(CHAVE_DAS_VOZES_NA_TRANSCRICAO));
  const [comHorarios, setComHorarios] = useState(() => mostraGuardado(CHAVE_DOS_HORARIOS_NA_TRANSCRICAO));
  // Cada trecho com a posição dele em `segmentos` (a que a edição manda ao servidor).
  const visiveis = useMemo(() => segmentos.map((s, indice) => ({ s, indice })).filter(({ s }) => {
    if (soAVoz && (s.lacuna || s.falante !== soAVoz)) return false;
    return !busca || !filtrar || (!s.lacuna && temOTermo(s.texto, busca));
  }), [segmentos, busca, soAVoz, filtrar]);
  // H18: as vozes que a lista do trecho oferece (todas as da transcrição), o
  // trecho aberto para editar e o foco que volta ao "Editar" dele ao fechar.
  const vozesDaTranscricao = useMemo(() => Array.from(new Set(segmentos.filter(s => !s.lacuna && s.falante).map(s => s.falante))), [segmentos]);
  const [trechoAberto, setTrechoAberto] = useState<number | null>(null);
  const focarNoTrecho = useRef<number | null>(null);
  const idDosTrechos = useId();
  useEffect(() => { if (!edicao?.editando) setTrechoAberto(null); }, [edicao?.editando]);
  useEffect(() => {
    if (trechoAberto !== null || focarNoTrecho.current === null) return;
    document.getElementById(`${idDosTrechos}-${focarNoTrecho.current}`)?.focus();
    focarNoTrecho.current = null;
  }, [trechoAberto, idDosTrechos]);
  useEffect(() => {
    if (filtrar || falaDoLink < 0 || jaRolouAteOLink.current) return;
    const fala = document.getElementById(`${idDosTrechos}-fala-${falaDoLink}`);
    if (!fala) return;
    jaRolouAteOLink.current = true;
    // jsdom não tem scrollIntoView; o navegador tem.
    fala.scrollIntoView?.({ block: "center" });
  }, [filtrar, falaDoLink, idDosTrechos, visiveis]);
  const vozes = useMemo(() => tempoDeFala(segmentos), [segmentos]);
  const rotulo = (falante: string) => nomes[falante] ?? t("meetings.speakerLabel", { n: numeroDoFalante(falante) });
  // A voz cujo nome está sendo editado, e o texto do campo.
  const [editando, setEditando] = useState<string | null>(null);
  const [rascunho, setRascunho] = useState("");
  const [salvando, setSalvando] = useState(false);
  async function salvarNome(falante: string) {
    if (!aoNomear) return;
    setSalvando(true);
    try {
      await aoNomear(falante, rascunho);
      setEditando(null);
    } catch {
      // Quem chama avisa a falha (toast); o campo fica aberto para tentar de novo.
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div>
      {vozes.length > 0 && (
        <div className="mb-4 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <p className="text-xs font-semibold text-white/60">{t("meetings.speakingTime")}</p>
          <ul className="mt-2 space-y-1.5">
            {vozes.map(v => (
              // No celular (abaixo de sm), a barra vai para uma linha só dela, embaixo do nome: na
              // linha do nome, do tempo e do botão de ouvir só esta voz, ela ficava com 16 px a 375 px.
              // O campo do nome, aberto, também fica com a primeira linha inteira (não cabe ao lado do
              // tempo). A partir de sm, tudo numa linha, com a barra no meio.
              <li key={v.falante} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-white/75 sm:flex-nowrap">
                {editando === v.falante
                  ? <div className="flex basis-full flex-col gap-1 sm:flex-initial">
                      <form className="flex items-center gap-2" onSubmit={e => { e.preventDefault(); void salvarNome(v.falante); }} onKeyDown={e => { if (e.key === "Escape") setEditando(null); }}>
                        <input autoFocus value={rascunho} onChange={e => setRascunho(e.target.value)} maxLength={NOME_DO_FALANTE_MAX} aria-label={t("meetings.speakerNameLabel", { n: numeroDoFalante(v.falante) })} aria-describedby={dicaDoLink ? idDaDicaDoLink : undefined} placeholder={t("meetings.speakerNamePlaceholder")} className="w-36 rounded-lg bg-white/5 border border-white/15 px-2 py-1 text-sm outline-none focus:border-amber-300"/>
                        <button type="submit" disabled={salvando} className="text-xs font-semibold text-amber-200 disabled:opacity-50">{t("meetings.saveSpeakerName")}</button>
                      </form>
                      {/* A confirmação nova cobre o nome dado depois de ligar o link: a dica diz à dona onde ele
                          aparece. Com o link da confirmação antiga, diz que quem tem o link não o vê, e como mostrá-lo. */}
                      {dicaDoLink && <p id={idDaDicaDoLink} className="text-xs text-amber-100/70">{dicaDoLink}</p>}
                    </div>
                  : aoNomear
                    ? <button type="button" onClick={() => { setEditando(v.falante); setRascunho(nomes[v.falante] ?? ""); }} title={t("meetings.renameSpeaker")} aria-label={`${t("meetings.renameSpeaker")}: ${rotulo(v.falante)}`} className="min-w-0 flex-1 truncate text-start underline decoration-dotted underline-offset-4 hover:text-white sm:w-24 sm:flex-none">{rotulo(v.falante)}</button>
                    : <span className="min-w-0 flex-1 truncate sm:w-24 sm:flex-none">{rotulo(v.falante)}</span>}
                <span data-barra-do-tempo-de-fala className="order-last h-2 basis-full overflow-hidden rounded-full bg-white/10 sm:order-none sm:min-w-4 sm:flex-1">
                  <span className="block h-full rounded-full bg-amber-300/70" style={{ width: `${Math.round(v.fracao * 100)}%` }} />
                </span>
                <span className="w-24 shrink-0 text-end tabular-nums text-white/55">{mmss(v.segundos)} · {Math.round(v.fracao * 100)}%</span>
                {/* D2: ouvir só esta voz; tocar de novo na voz escolhida volta a todas. */}
                {aoOuvirSoAVoz && <button type="button" onClick={() => aoOuvirSoAVoz(soAVoz === v.falante ? null : v.falante)}
                  aria-pressed={soAVoz === v.falante} aria-label={t("meetings.playback.onlyVoice", { nome: rotulo(v.falante) })} title={t("meetings.playback.onlyVoice", { nome: rotulo(v.falante) })}
                  className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-300 ${soAVoz === v.falante ? "bg-amber-300/25 text-amber-200" : "text-white/60 hover:bg-white/10 hover:text-white"}`}>
                  <Headphones size={15} aria-hidden/>
                </button>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {soAVoz && <div role="status" className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-sm text-amber-100">
        <Headphones size={15} aria-hidden className="shrink-0"/>
        <span dir="auto" className="min-w-0">{t("meetings.playback.onlyVoiceShowing", { nome: rotulo(soAVoz) })}</span>
        {aoOuvirSoAVoz && <button type="button" onClick={() => aoOuvirSoAVoz(null)} className="ms-auto rounded-md px-1.5 py-0.5 text-xs font-semibold text-amber-200 underline decoration-dotted underline-offset-4 hover:text-amber-100">{t("meetings.playback.allVoices")}</button>}
      </div>}
      <label className="mb-4 flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2">
        <Search size={16} className="text-white/45" aria-hidden />
        <input
          type="search"
          value={termo}
          onChange={e => { setTermo(e.target.value); setFiltrar(true); }}
          placeholder={t("meetings.searchTranscriptPlaceholder")}
          aria-label={t("meetings.searchTranscriptPlaceholder")}
          className="w-full bg-transparent text-sm text-white outline-none placeholder:text-white/35"
        />
      </label>
      {/* D2: mostrar ou esconder as vozes e os horários de cada fala. */}
      <div role="group" aria-label={t("meetings.transcriptView.label")} className="mb-4 flex flex-wrap gap-2">
        {([
          ["vozes", comVozes, setComVozes, CHAVE_DAS_VOZES_NA_TRANSCRICAO, t("meetings.transcriptView.voices")],
          ["horarios", comHorarios, setComHorarios, CHAVE_DOS_HORARIOS_NA_TRANSCRICAO, t("meetings.transcriptView.times")],
        ] as const).map(([id, ligado, mudar, chave, rotuloDoBotao]) => (
          <button key={id} type="button" aria-pressed={ligado} onClick={() => { mudar(!ligado); guardarMostra(chave, !ligado); }}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-300 ${ligado ? "border-amber-300/40 bg-amber-300/10 text-amber-100" : "border-white/15 text-white/50 hover:text-white/80"}`}>
            {ligado && <Check size={12} aria-hidden/>}{rotuloDoBotao}
          </button>
        ))}
      </div>
      {busca && (filtrar ? !visiveis.length : falaDoLink < 0) && <p className="text-sm text-white/45">{t("meetings.searchNoResults")}</p>}
      <ol className="space-y-3">
        {visiveis.map(({ s, indice }) => s.lacuna ? (
          <li key={`l${indice}`} className="rounded-lg border border-dashed border-white/15 px-3 py-2 text-sm italic text-white/45">
            {comHorarios && <>{mmss(s.inicio)}–{mmss(s.fim)} · </>}{t("meetings.gapLabel")}
          </li>
        ) : (
          <li key={`${s.inicio}-${indice}`} id={`${idDosTrechos}-fala-${indice}`}
            data-fala-do-link={!filtrar && indice === falaDoLink ? "" : undefined}
            aria-current={!filtrar && indice === falaDoLink ? "location" : undefined}
            className={`flex gap-3${!filtrar && indice === falaDoLink ? " -mx-2 rounded-lg bg-amber-300/10 px-2 py-1 ring-1 ring-amber-300/40" : ""}`}>
            {/* D2: com os horários escondidos, o ▶ de cada fala continua, só com o ícone (o tempo vai no
                nome e na dica): é ele que leva o player, ou o vídeo do YouTube, até o trecho. Sem player
                nem vídeo, não há para onde ir, e nada aparece. */}
            {linkDoTempo ? (
              <a
                href={linkDoTempo(s.inicio)}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t("meetings.youtube.watchFrom", { tempo: mmss(s.inicio) })}
                title={comHorarios ? undefined : t("meetings.youtube.watchFrom", { tempo: mmss(s.inicio) })}
                className={comHorarios
                  ? "inline-flex h-fit shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-xs text-amber-300 hover:bg-amber-300/10"
                  : "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-amber-300 hover:bg-amber-300/10"}
              >
                <Play size={comHorarios ? 11 : 13} aria-hidden />{comHorarios && mmss(s.inicio)}
              </a>
            ) : !comHorarios ? (aoIrPara ? (
              <button
                type="button"
                onClick={() => aoIrPara(s.inicio)}
                aria-label={t("meetings.playFrom", { tempo: mmss(s.inicio) })}
                title={t("meetings.playFrom", { tempo: mmss(s.inicio) })}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-amber-300 hover:bg-amber-300/10"
              >
                <Play size={13} aria-hidden />
              </button>
            ) : null) : (
              <button
                type="button"
                onClick={() => aoIrPara?.(s.inicio)}
                disabled={!aoIrPara}
                aria-label={t("meetings.playFrom", { tempo: mmss(s.inicio) })}
                className="h-fit shrink-0 rounded-md px-1.5 py-0.5 font-mono text-xs text-amber-300 hover:bg-amber-300/10 disabled:text-white/40"
              >
                {mmss(s.inicio)}
              </button>
            )}
            <div className="min-w-0 flex-1">
              {/* A marca sem fala ([música]) não tem voz: sem o rótulo, como no tempo de fala. */}
              {comVozes && textoTemFala(s.texto) && <p className="text-xs font-semibold text-white/55">{rotulo(s.falante)}</p>}
              <p dir="auto" className="leading-7 text-white/80">{comDestaque(s.texto, busca)}</p>
              {edicao && <TrechoEditavel indice={indice} segmento={s} original={edicao.originais.get(indice)} editando={edicao.editando}
                aberto={trechoAberto === indice} idDoEditar={`${idDosTrechos}-${indice}`} vozes={vozesDaTranscricao} rotulo={rotulo}
                aoAbrir={() => setTrechoAberto(indice)} aoFechar={() => { focarNoTrecho.current = indice; setTrechoAberto(null); }}
                aoSalvar={mudancas => edicao.aoSalvarTrecho(indice, mudancas)} aoRestaurar={() => edicao.aoRestaurar(indice)}/>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * O que um trecho mostra na edição da dona (H18): a marca "editado" quando ela
 * o mudou e, com a edição ligada, "Editar", o original da IA (o texto e a
 * voz) e "Voltar ao original", ou o formulário aberto.
 */
function TrechoEditavel({ indice, segmento, original, editando, aberto, idDoEditar, vozes, rotulo, aoAbrir, aoFechar, aoSalvar, aoRestaurar }: {
  indice: number;
  segmento: SegmentoDaTela;
  original: { texto: string; falante: string } | undefined;
  editando: boolean;
  aberto: boolean;
  idDoEditar: string;
  vozes: readonly string[];
  rotulo: (falante: string) => string;
  aoAbrir: () => void;
  aoFechar: () => void;
  aoSalvar: (mudancas: { texto?: string; falante?: string }) => Promise<boolean>;
  aoRestaurar: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [voltando, setVoltando] = useState(false);
  if (!editando) {
    return original ? <p className="mt-1 text-[11px] text-white/45">{t("meetings.editTranscript.editedBadge")}</p> : null;
  }
  if (aberto) {
    return <FormularioDoTrecho key={indice} texto={segmento.texto} falante={segmento.falante} vozes={vozes} rotulo={rotulo} aoSalvar={aoSalvar} aoFechar={aoFechar}/>;
  }
  return <div className="mt-1 space-y-1">
    <div className="flex flex-wrap items-center gap-2">
      <button id={idDoEditar} type="button" onClick={aoAbrir} aria-label={t("meetings.editTranscript.editSegmentAt", { tempo: mmss(segmento.inicio) })}
        className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-white/55 hover:bg-white/5 hover:text-white">
        <Pencil size={13} aria-hidden/> {t("meetings.editTranscript.editSegment")}
      </button>
      {original && <span className="rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 text-[11px] font-semibold text-amber-200">{t("meetings.editTranscript.editedBadge")}</span>}
      {original && <button type="button" disabled={voltando} onClick={() => { setVoltando(true); void aoRestaurar().finally(() => setVoltando(false)); }}
        aria-label={t("meetings.editTranscript.restoreSegmentAt", { tempo: mmss(segmento.inicio) })}
        className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-white/55 hover:bg-white/5 hover:text-white disabled:opacity-50">
        <RotateCcw size={13} aria-hidden/> {t("meetings.editTranscript.restoreSegment")}
      </button>}
    </div>
    {original && <details>
      <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-white/35">{t("meetings.editTranscript.originalLabel")}</summary>
      <p dir="auto" className="mt-1 border-s-2 border-amber-300/40 ps-3 text-xs italic text-white/55">
        {original.falante !== segmento.falante && <span className="font-semibold not-italic">{rotulo(original.falante)}: </span>}{original.texto}
      </p>
    </details>}
  </div>;
}
