import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, FileAudio, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { mensagemDaRecusaDoAudio } from "@/lib/mensagem-de-erro";
import { abertoNaCascaDasLojas, ambienteAtual } from "@/lib/instalacao-do-app";
import { FORMATOS_DO_AUDIO, tamanhoEstimadoDoAudio, type FormatoDoAudio } from "@shared/baixar-audio";

/**
 * "Baixar o áudio" na seção Gravação do detalhe da reunião (H8c; HN-60 no
 * HiNoter): a dona baixa a gravação inteira num arquivo só, em MP3 ou M4A
 * (shared/baixar-audio.ts). Só a dona tem o botão: a página do link aberto não
 * o monta, e o servidor não tem procedimento nem rota de baixar áudio pelo
 * link. O detalhe só o mostra com a gravação encerrada e no prazo dos 30 dias;
 * nos outros casos, o servidor recusa com um código que a tela traduz.
 *
 * Em dois toques, de propósito:
 * 1. "Preparar o arquivo", depois do aviso (a Cris revisa o texto,
 *    meetings.audioDownload.notice): o servidor confere a dona, o prazo e o
 *    teto, grava a auditoria e devolve um endereço de uso único, que vale
 *    poucos minutos e só para a sessão dela (meetings.baixarAudio);
 * 2. "Salvar o arquivo": um link de verdade para esse endereço, com o nome do
 *    arquivo. O toque da dona no link é o que todo navegador aceita para
 *    baixar, inclusive o Safari do iPhone; um download disparado pelo código
 *    depois da espera do servidor pode ser barrado. O arquivo é convertido
 *    enquanto baixa (server/_core/rota-do-audio-baixado.ts).
 *
 * O endereço serve uma vez: depois do toque, o link fica parado. Passado o
 * prazo sem o toque, o link sai, e a dona prepara de novo (a auditoria
 * registra de novo).
 */

/** O tamanho na tela, em megabytes inteiros e no idioma da tela (nunca menos de 1). */
export function tamanhoNaTela(bytes: number, idioma: string): string {
  const megas = Math.max(1, Math.round(bytes / 1_000_000));
  try {
    return new Intl.NumberFormat(idioma, { style: "unit", unit: "megabyte", unitDisplay: "short", maximumFractionDigits: 0 }).format(megas);
  } catch {
    return `${megas} MB`;
  }
}

/** O link sai da tela esta folga antes do prazo do endereço: o toque ainda precisa chegar ao servidor. */
export const FOLGA_DO_ENDERECO_MS = 5_000;

export function BaixarAudioDaReuniao({ meetingId, duracaoSegundos, nomeSugerido }: {
  meetingId: string;
  /** A duração da gravação no player, para o tamanho aproximado. */
  duracaoSegundos: number;
  /** O nome do arquivo sem a extensão (o título e a data, como no PDF); o servidor o limpa e põe a extensão. */
  nomeSugerido: string;
}) {
  const { t } = useTranslation();
  const [aberto, setAberto] = useState(false);
  const botao = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={botao} type="button" onClick={() => setAberto(true)}
      className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-amber-300/30 px-3 py-1 text-xs text-amber-200 hover:bg-amber-300/10">
      <Download size={13} aria-hidden="true"/> {t("meetings.audioDownload.button")}
    </button>
    {aberto && <DialogoDoAudio meetingId={meetingId} duracaoSegundos={duracaoSegundos} nomeSugerido={nomeSugerido}
      aoFechar={() => { setAberto(false); botao.current?.focus(); }}/>}
  </>;
}

type Preparado = { endereco: string; nomeDoArquivo: string; validadeMs: number; tamanhoEstimadoBytes: number };

function DialogoDoAudio({ meetingId, duracaoSegundos, nomeSugerido, aoFechar }: {
  meetingId: string; duracaoSegundos: number; nomeSugerido: string; aoFechar: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [formato, setFormato] = useState<FormatoDoAudio>("mp3");
  const [preparado, setPreparado] = useState<Preparado | null>(null);
  // O toque no link já aconteceu: o endereço foi usado.
  const [iniciado, setIniciado] = useState(false);
  // O prazo do endereço passou sem o toque.
  const [venceu, setVenceu] = useState(false);
  const preparar = trpc.meetings.baixarAudio.useMutation();
  const link = useRef<HTMLAnchorElement>(null);
  const idDoTitulo = useId();
  const idDoAviso = useId();
  const nomeDoGrupo = useId();
  // No app instalado (da tela de início ou a casca das lojas), o download pode não começar: a dica manda ao navegador.
  const noAppInstalado = useMemo(() => {
    const ambiente = ambienteAtual();
    return ambiente.abertoComoApp || abertoNaCascaDasLojas(ambiente.userAgent);
  }, []);

  useEffect(() => {
    if (!preparado || iniciado) return;
    const relogio = window.setTimeout(() => setVenceu(true), Math.max(0, preparado.validadeMs - FOLGA_DO_ENDERECO_MS));
    return () => window.clearTimeout(relogio);
  }, [preparado, iniciado]);

  // O foco vai ao link quando ele aparece (o autoFocus do React não vale para <a>).
  const comLink = preparado !== null && !venceu;
  useEffect(() => { if (comLink) link.current?.focus(); }, [comLink]);

  function pedir() {
    setPreparado(null);
    setIniciado(false);
    setVenceu(false);
    preparar.mutate({ meetingId, formato, nome: nomeSugerido }, { onSuccess: dados => setPreparado(dados) });
  }

  const ocupado = preparar.isPending;
  const tamanho = tamanhoNaTela(preparado?.tamanhoEstimadoBytes ?? tamanhoEstimadoDoAudio(duracaoSegundos), i18n.language);
  const rotulo: Record<FormatoDoAudio, string> = {
    mp3: t("meetings.audioDownload.formatMp3"),
    m4a: t("meetings.audioDownload.formatM4a"),
  };

  return <div role="dialog" aria-modal="true" aria-labelledby={idDoTitulo} aria-describedby={idDoAviso}
    onKeyDown={evento => { if (evento.key === "Escape" && !ocupado) aoFechar(); }}
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
    <div className="w-full max-w-md rounded-2xl border border-white/15 bg-[#211e1b] p-6 text-start shadow-2xl">
      <h3 id={idDoTitulo} className="mb-2 inline-flex items-center gap-2 text-base font-bold text-white">
        <FileAudio size={18} className="text-amber-300" aria-hidden="true"/>{t("meetings.audioDownload.title")}
      </h3>
      <p id={idDoAviso} className="text-sm leading-6 text-white/70">{t("meetings.audioDownload.notice")}</p>

      <fieldset disabled={ocupado || comLink} className="mt-4">
        <legend className="mb-2 text-sm font-semibold text-white/85">{t("meetings.audioDownload.formatLabel")}</legend>
        <div className="space-y-2">
          {FORMATOS_DO_AUDIO.map(opcao => <label key={opcao} className="flex cursor-pointer items-start gap-2 text-sm text-white/75">
            <input type="radio" name={nomeDoGrupo} value={opcao} checked={formato === opcao} onChange={() => setFormato(opcao)} className="mt-1 accent-amber-300"/>
            <span>{rotulo[opcao]}</span>
          </label>)}
        </div>
      </fieldset>
      <p className="mt-3 text-sm text-amber-100/85">{t("meetings.audioDownload.size", { tamanho })}</p>

      {comLink ? <>
        <p role="status" className="mt-4 rounded-xl border border-emerald-400/25 bg-emerald-400/10 p-3 text-sm text-emerald-100">
          {iniciado ? t("meetings.audioDownload.started") : t("meetings.audioDownload.ready", { minutos: Math.max(1, Math.round(preparado.validadeMs / 60_000)) })}
        </p>
        {noAppInstalado && <p className="mt-2 text-xs text-white/55">{t("meetings.audioDownload.installedAppHint")}</p>}
        <div className="mt-5 flex flex-wrap gap-3">
          {/* Um link de verdade: o toque da dona baixa o arquivo. O mesmo elemento fica na tela depois do toque, parado. */}
          <a ref={link} href={preparado.endereco} download={preparado.nomeDoArquivo} aria-disabled={iniciado || undefined}
            onClick={evento => {
              if (iniciado) { evento.preventDefault(); return; }
              setIniciado(true);
            }}
            className={`inline-flex items-center justify-center gap-2 rounded-xl bg-[#c98f70] px-4 py-2.5 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] ${iniciado ? "pointer-events-none opacity-50" : ""}`}>
            <Download size={15} aria-hidden="true"/> {t("meetings.audioDownload.save")}
          </a>
          <button type="button" onClick={aoFechar}
            className="rounded-xl border border-white/15 px-4 py-2.5 text-sm text-white/65 hover:bg-white/5">
            {t("meetings.audioDownload.close")}
          </button>
        </div>
      </> : <>
        {ocupado && <p role="status" className="mt-4 text-sm text-white/55">
          <Loader2 size={15} className="me-2 inline animate-spin" aria-hidden="true"/>{t("meetings.audioDownload.preparing")}
        </p>}
        {!ocupado && preparar.isError && <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">
          {mensagemDaRecusaDoAudio(preparar.error, t)}
        </p>}
        {!ocupado && venceu && <p role="status" className="mt-4 text-sm text-amber-100/85">{t("meetings.audioDownload.linkExpired")}</p>}
        <div className="mt-5 flex flex-wrap gap-3">
          <button type="button" autoFocus onClick={pedir} disabled={ocupado}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#c98f70] px-4 py-2.5 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-50">
            {ocupado ? <Loader2 size={15} className="animate-spin" aria-hidden="true"/> : <FileAudio size={15} aria-hidden="true"/>} {venceu ? t("meetings.audioDownload.prepareAgain") : t("meetings.audioDownload.prepare")}
          </button>
          <button type="button" onClick={aoFechar} disabled={ocupado}
            className="rounded-xl border border-white/15 px-4 py-2.5 text-sm text-white/65 hover:bg-white/5 disabled:opacity-50">
            {t("meetings.audioDownload.cancel")}
          </button>
        </div>
      </>}
    </div>
  </div>;
}
