import { memo, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, ScrollText } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { textoTemFala } from "@shared/fala-na-transcricao";
import { mmss, type SegmentoDaTela } from "./TranscricaoPorFalante";
import { PergunteAReuniao } from "./ReuniaoComIA";

/**
 * A transcrição durante a gravação (G15a; HN-19 e HN-20 do HiNoter). A fila do
 * servidor transcreve cada parte de ~10 min enquanto a reunião ainda grava:
 * aqui a dona lê o texto das partes prontas, com o andamento de cada uma (na
 * fila, sendo transcrita, pronta e quanto tempo depois de chegar) e, com
 * `comPergunta`, pergunta à IA sobre o que já foi dito. O texto é o da fila: não
 * custa IA a mais. A pergunta custa a de sempre.
 *
 * A tela pergunta ao servidor a cada INTERVALO_DA_TRANSCRICAO_AO_VIVO_MS e só
 * recebe o texto das partes que ainda não tem (`desde`); para quando a reunião
 * deixa de estar em andamento ou não existe mais. A falha de uma consulta não
 * apaga o que já está na tela: um aviso curto diz que a atualização falhou, e
 * a próxima volta tenta de novo.
 */

/** De quanto em quanto tempo a tela pergunta pelas partes prontas. */
export const INTERVALO_DA_TRANSCRICAO_AO_VIVO_MS = 15_000;

type EstadoDaParte = "enviando" | "na_fila" | "transcrevendo" | "transcrita" | "falhou";
type ParteNaTela = { seq: number; estado: EstadoDaParte; inicioSegundos: number; duracaoSegundos: number; chegouEm: number; atrasoSegundos: number | null };
type Leitura = { status: string; agora: number; partes: ParteNaTela[]; nomes: Record<string, string>; recebidaEm: number };

const EM_ANDAMENTO = new Set(["recording", "uploading", "processing"]);
const codigoDoErro = (erro: unknown) => (erro as { data?: { code?: string } } | null)?.data?.code;

/**
 * Quantas partes, desde a primeira, a tela já tem resolvidas (com o texto, ou
 * sem texto de vez): é o `desde` do pedido seguinte. A fila transcreve em
 * ordem, então o que está resolvido é um começo contínuo.
 */
export function partesResolvidas(partes: readonly { seq: number; estado: EstadoDaParte }[], comTexto: ReadonlySet<number>): number {
  const porSeq = new Map(partes.map(parte => [parte.seq, parte]));
  let resolvidas = 0;
  for (let parte = porSeq.get(0); parte; parte = porSeq.get(resolvidas)) {
    if (parte.estado === "falhou" || (parte.estado === "transcrita" && comTexto.has(parte.seq))) resolvidas++;
    else break;
  }
  return resolvidas;
}

/**
 * Memorizado: no gravador, a tela redesenha a cada meio segundo (o relógio), e
 * uma reunião de horas tem milhares de falas. Com as mesmas props, o painel só
 * redesenha quando chega texto novo.
 */
export const TranscricaoDuranteAGravacao = memo(function TranscricaoDuranteAGravacao({ meetingId, gravando = false, comPergunta = false }: {
  meetingId: string;
  /** Na tela do gravador: a parte em curso ainda grava, e o texto dela vem depois. */
  gravando?: boolean;
  /** Mostra o "Pergunte sobre o que já foi dito" quando há texto. */
  comPergunta?: boolean;
}) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const idDoTitulo = useId();
  const [leitura, setLeitura] = useState<Leitura | null>(null);
  const [falas, setFalas] = useState<ReadonlyMap<number, SegmentoDaTela[]>>(() => new Map());
  const [falhou, setFalhou] = useState(false);
  const [naoExiste, setNaoExiste] = useState(false);
  // O que já chegou, fora do render: o laço de consultas lê daqui o `desde`.
  const recebidas = useRef(new Map<number, SegmentoDaTela[]>());
  const ultimasPartes = useRef<ParteNaTela[]>([]);

  useEffect(() => {
    let ativo = true;
    let relogio = 0;
    recebidas.current = new Map();
    ultimasPartes.current = [];
    const consultar = async () => {
      let seguir = true;
      try {
        const desde = partesResolvidas(ultimasPartes.current, new Set(recebidas.current.keys()));
        const dados = await utils.client.meetings.transcricaoDaGravacao.query({ meetingId, desde });
        if (!ativo) return;
        for (const parte of dados.falas) recebidas.current.set(parte.seq, parte.segmentos);
        ultimasPartes.current = dados.partes;
        setFalas(new Map(recebidas.current));
        setLeitura({ status: dados.status, agora: dados.agora, partes: dados.partes, nomes: dados.nomes, recebidaEm: Date.now() });
        setFalhou(false);
        seguir = EM_ANDAMENTO.has(dados.status);
      } catch (erro) {
        if (!ativo) return;
        // A reunião que não existe mais (excluída, ou de outra conta) não volta: para de perguntar.
        if (codigoDoErro(erro) === "NOT_FOUND") {
          setNaoExiste(true);
          seguir = false;
        } else setFalhou(true);
      }
      if (ativo && seguir) relogio = window.setTimeout(() => void consultar(), INTERVALO_DA_TRANSCRICAO_AO_VIVO_MS);
    };
    void consultar();
    return () => {
      ativo = false;
      window.clearTimeout(relogio);
    };
  }, [meetingId, utils]);

  if (naoExiste) return null;
  // A hora do servidor agora: a da última leitura mais o que passou desde ela.
  const agoraNoServidor = leitura ? leitura.agora + (Date.now() - leitura.recebidaEm) : 0;
  const duracao = (segundos: number) => {
    const s = Math.max(0, Math.round(segundos));
    return s < 60 ? t("meetings.live.seconds", { segundos: s }) : t("meetings.live.minutes", { minutos: Math.floor(s / 60), segundos: s % 60 });
  };
  const situacao = (parte: ParteNaTela) => {
    switch (parte.estado) {
      case "transcrita": return t("meetings.live.partReady", { atraso: duracao(parte.atrasoSegundos ?? 0) });
      case "falhou": return t("meetings.live.partFailed");
      case "transcrevendo": return t("meetings.live.partTranscribing");
      case "enviando": return t("meetings.live.partUploading");
      default: return t("meetings.live.partQueued", { tempo: duracao((agoraNoServidor - parte.chegouEm) / 1000) });
    }
  };
  const rotulo = (falante: string) => leitura?.nomes[falante] ?? t("meetings.speakerLabel", { n: Number(falante.replace(/^F/, "")) || 0 });
  const temTexto = !!leitura?.partes.some(parte => parte.estado === "transcrita" && (falas.get(parte.seq)?.some(fala => !fala.lacuna && fala.texto.trim()) ?? false));

  return (
    <div className="mt-6 space-y-4 text-start">
      <section aria-labelledby={idDoTitulo} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <h2 id={idDoTitulo} className="inline-flex items-center gap-2 text-base font-semibold"><ScrollText size={16} aria-hidden className="text-amber-300"/>{t("meetings.live.title")}</h2>
        <p className="mt-1 text-xs text-white/50">{t("meetings.live.intro")}</p>
        {falhou && <p role="status" className="mt-2 text-xs text-amber-200/80">{t("meetings.live.updateError")}</p>}
        {!leitura
          ? (!falhou && <p className="mt-3 text-sm text-white/55"><Loader2 size={14} className="me-2 inline animate-spin" aria-hidden/>{t("meetings.live.loading")}</p>)
          : !leitura.partes.length
          ? <p className="mt-3 text-sm text-white/55">{gravando ? t("meetings.live.emptyRecording") : t("meetings.live.empty")}</p>
          : <ol className="mt-3 max-h-96 space-y-4 overflow-y-auto pe-1">
            {leitura.partes.map(parte => {
              const segmentos = (falas.get(parte.seq) ?? []).filter(fala => !fala.lacuna && fala.texto.trim());
              return <li key={parte.seq} data-parte={parte.seq}>
                <p className="text-xs font-semibold text-amber-200/80">
                  {t("meetings.live.partLabel", { n: parte.seq + 1, inicio: mmss(parte.inicioSegundos), fim: mmss(parte.inicioSegundos + parte.duracaoSegundos) })}
                  <span className="font-normal text-white/50"> · {situacao(parte)}</span>
                </p>
                {parte.estado === "transcrita" && (segmentos.length
                  ? <ul className="mt-1.5 space-y-2">
                    {segmentos.map((fala, i) => <li key={`${fala.inicio}-${i}`}>
                      <p className="text-[11px] text-white/45">{textoTemFala(fala.texto) ? `${rotulo(fala.falante)} · ` : ""}{mmss(fala.inicio)}</p>
                      <p dir="auto" className="text-sm leading-6 text-white/80">{fala.texto}</p>
                    </li>)}
                  </ul>
                  : falas.has(parte.seq) && <p className="mt-1 text-sm italic text-white/45">{t("meetings.live.partNoSpeech")}</p>)}
              </li>;
            })}
          </ol>}
        {gravando && <p className="mt-3 border-t border-white/10 pt-3 text-xs text-white/45">{t("meetings.live.recordingNow")}</p>}
      </section>
      {comPergunta && temTexto && <PergunteAReuniao meetingId={meetingId} duranteAGravacao nomes={leitura?.nomes}/>}
    </div>
  );
});
