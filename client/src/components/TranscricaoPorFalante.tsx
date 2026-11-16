import { NOME_DO_FALANTE_MAX } from "@shared/const";
import { useId, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";

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

/** Quanto tempo cada voz falou, da que mais falou para a que menos falou. */
export function tempoDeFala(segmentos: SegmentoDaTela[]) {
  const porFalante = new Map<string, number>();
  for (const s of segmentos) {
    if (s.lacuna || !s.falante) continue;
    porFalante.set(s.falante, (porFalante.get(s.falante) ?? 0) + Math.max(0, s.fim - s.inicio));
  }
  const total = Array.from(porFalante.values()).reduce((a, b) => a + b, 0);
  return Array.from(porFalante.entries())
    .map(([falante, segundos]) => ({ falante, segundos, fracao: total ? segundos / total : 0 }))
    .sort((a, b) => b.segundos - a.segundos);
}

const numeroDoFalante = (falante: string) => Number(falante.replace(/^F/, "")) || 0;

function comDestaque(texto: string, termo: string) {
  if (!termo) return texto;
  const partes: Array<string | ReactElement> = [];
  const baixo = texto.toLocaleLowerCase();
  const alvo = termo.toLocaleLowerCase();
  let de = 0;
  for (let i = baixo.indexOf(alvo); i >= 0; i = baixo.indexOf(alvo, de)) {
    partes.push(texto.slice(de, i));
    partes.push(<mark key={i} className="rounded bg-amber-300/40 px-0.5 text-white">{texto.slice(i, i + termo.length)}</mark>);
    de = i + termo.length;
  }
  partes.push(texto.slice(de));
  return partes;
}

/**
 * A transcrição por falante (D1 do desenho do gravador): cada fala com o
 * rótulo "Falante n" (só na tela; no banco é F1, F2...), o tempo em que
 * começou (clicar pula o player para ali), a busca com destaque e o tempo de
 * fala de cada voz. O trecho que não chegou aparece como tal.
 */
export function TranscricaoPorFalante({ segmentos, aoIrPara, termoInicial = "", nomes = {}, aoNomear, nomeNoLink }: {
  segmentos: SegmentoDaTela[];
  aoIrPara?: (segundo: number) => void;
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
}) {
  const { t } = useTranslation();
  const idDaDicaDoLink = useId();
  const dicaDoLink = nomeNoLink === "aparece" ? t("meetings.speakerNameLinkHint")
    : nomeNoLink === "naoAparece" ? t("meetings.speakerNameRelinkHint")
    : null;
  const [termo, setTermo] = useState(termoInicial);
  const busca = termo.trim();
  const visiveis = useMemo(
    () => (busca ? segmentos.filter(s => !s.lacuna && s.texto.toLocaleLowerCase().includes(busca.toLocaleLowerCase())) : segmentos),
    [segmentos, busca],
  );
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
              <li key={v.falante} className="flex items-center gap-3 text-sm text-white/75">
                {editando === v.falante
                  ? <div className="flex flex-col gap-1">
                      <form className="flex items-center gap-2" onSubmit={e => { e.preventDefault(); void salvarNome(v.falante); }} onKeyDown={e => { if (e.key === "Escape") setEditando(null); }}>
                        <input autoFocus value={rascunho} onChange={e => setRascunho(e.target.value)} maxLength={NOME_DO_FALANTE_MAX} aria-label={t("meetings.speakerNameLabel", { n: numeroDoFalante(v.falante) })} aria-describedby={dicaDoLink ? idDaDicaDoLink : undefined} placeholder={t("meetings.speakerNamePlaceholder")} className="w-36 rounded-lg bg-white/5 border border-white/15 px-2 py-1 text-sm outline-none focus:border-amber-300"/>
                        <button type="submit" disabled={salvando} className="text-xs font-semibold text-amber-200 disabled:opacity-50">{t("meetings.saveSpeakerName")}</button>
                      </form>
                      {/* A confirmação nova cobre o nome dado depois de ligar o link: a dica diz à dona onde ele
                          aparece. Com o link da confirmação antiga, diz que quem tem o link não o vê, e como mostrá-lo. */}
                      {dicaDoLink && <p id={idDaDicaDoLink} className="text-xs text-amber-100/70">{dicaDoLink}</p>}
                    </div>
                  : aoNomear
                    ? <button type="button" onClick={() => { setEditando(v.falante); setRascunho(nomes[v.falante] ?? ""); }} title={t("meetings.renameSpeaker")} aria-label={`${t("meetings.renameSpeaker")}: ${rotulo(v.falante)}`} className="w-24 shrink-0 truncate text-left underline decoration-dotted underline-offset-4 hover:text-white">{rotulo(v.falante)}</button>
                    : <span className="w-24 shrink-0 truncate">{rotulo(v.falante)}</span>}
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
                  <span className="block h-full rounded-full bg-amber-300/70" style={{ width: `${Math.round(v.fracao * 100)}%` }} />
                </span>
                <span className="w-24 shrink-0 text-right tabular-nums text-white/55">{mmss(v.segundos)} · {Math.round(v.fracao * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <label className="mb-4 flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2">
        <Search size={16} className="text-white/45" aria-hidden />
        <input
          type="search"
          value={termo}
          onChange={e => setTermo(e.target.value)}
          placeholder={t("meetings.searchTranscriptPlaceholder")}
          aria-label={t("meetings.searchTranscriptPlaceholder")}
          className="w-full bg-transparent text-sm text-white outline-none placeholder:text-white/35"
        />
      </label>
      {busca && !visiveis.length && <p className="text-sm text-white/45">{t("meetings.searchNoResults")}</p>}
      <ol className="space-y-3">
        {visiveis.map((s, i) => s.lacuna ? (
          <li key={`l${i}`} className="rounded-lg border border-dashed border-white/15 px-3 py-2 text-sm italic text-white/45">
            {mmss(s.inicio)}–{mmss(s.fim)} · {t("meetings.gapLabel")}
          </li>
        ) : (
          <li key={`${s.inicio}-${i}`} className="flex gap-3">
            <button
              type="button"
              onClick={() => aoIrPara?.(s.inicio)}
              disabled={!aoIrPara}
              aria-label={t("meetings.playFrom", { tempo: mmss(s.inicio) })}
              className="h-fit shrink-0 rounded-md px-1.5 py-0.5 font-mono text-xs text-amber-300 hover:bg-amber-300/10 disabled:text-white/40"
            >
              {mmss(s.inicio)}
            </button>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-white/55">{rotulo(s.falante)}</p>
              <p dir="auto" className="leading-7 text-white/80">{comDestaque(s.texto, busca)}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
