import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AArrowDown, AArrowUp, Captions, CaptionsOff, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import {
  guardarTamanhoDaLetra, idiomaDaLegenda, legendaDisponivel, lerTamanhoDaLetra, separadorDoIdioma,
  TAMANHOS_DA_LETRA, type FalhaDaLegenda,
} from "@/lib/legenda-ao-vivo";
import { useLegendaAoVivo } from "@/hooks/useLegendaAoVivo";
import { VERSAO_VIGENTE_DO_AVISO_DA_LEGENDA } from "@shared/legenda-ao-vivo";
import { RECUSAS_DA_LIXEIRA } from "@shared/lixeira-de-reunioes";
import { IDIOMA_DA_REUNIAO_PADRAO, idiomaDaReuniao, nomeDoIdiomaEm, type EscolhaDoIdioma } from "@shared/idioma-da-reuniao";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * A legenda ao vivo do gravador (G15b; HN-19 do HiNoter; a regra está em
 * shared/legenda-ao-vivo.ts): o texto do que está sendo dito, com segundos de
 * atraso, pelo reconhecimento de voz do próprio navegador, de graça. Liga e
 * desliga, com a letra ajustável (A− e A+; o aparelho lembra o tamanho).
 *
 * Convive com a transcrição durante a gravação (G15a, logo abaixo no
 * gravador): a legenda é o rascunho imediato, que não separa quem fala e não
 * fica guardado; a transcrição da reunião continua sendo a da IA, por partes.
 *
 * Antes de ligar pela primeira vez na gravação, o aviso (decisão do Roberto de
 * 16/11/2026, texto para a Cris revisar): no Chrome, o reconhecimento costuma
 * mandar o áudio a um servidor do Google; a legenda não separa quem fala e não
 * fica guardada. A dona confirma que as pessoas da reunião concordam, e a
 * confirmação, com o texto que ela viu, vai à auditoria antes de a legenda
 * ligar (meetings.ligarLegendaAoVivo). Desligar e ligar de novo na mesma
 * gravação não pergunta outra vez.
 *
 * Onde o navegador não tem o reconhecimento (o Firefox), o botão não aparece;
 * no celular e no tablet também não, até o teste num aparelho de verdade
 * (LEGENDA_NO_CELULAR, em lib/legenda-ao-vivo.ts).
 */

type Props = {
  meetingId: string;
  /** O idioma da reunião: a legenda ouve nele (no "Detectar sozinho", no idioma da tela). */
  idioma: EscolhaDoIdioma;
  /** A gravação está gravando (nem pausada, nem sem microfone). */
  ativa: boolean;
  /** O microfone da gravação caiu (G17): a legenda desliga. */
  microfoneCaiu: boolean;
};

/**
 * Memorizada: no gravador, a tela redesenha a cada meio segundo (o relógio).
 * Com as mesmas props, a legenda só redesenha quando chega texto novo.
 */
export const LegendaAoVivo = memo(function LegendaAoVivo(props: Props) {
  // Decidido uma vez: o navegador não ganha nem perde o reconhecimento no meio.
  const [disponivel] = useState(() => legendaDisponivel());
  if (!disponivel) return null;
  return <PainelDaLegenda {...props}/>;
});

/** A frase de cada falha que desliga a legenda sozinha (o Record é pelo tipo: falha nova não compila sem a frase). */
const FRASE_DA_FALHA: Record<FalhaDaLegenda, (t: (chave: string, opcoes?: Record<string, unknown>) => string, idioma: string) => string> = {
  semPermissao: t => t("meetings.caption.errors.permission"),
  servicoRecusado: t => t("meetings.caption.errors.service"),
  semMicrofone: t => t("meetings.caption.errors.microphone"),
  idiomaSemSuporte: (t, idioma) => t("meetings.caption.errors.language", { idioma }),
  naoResponde: t => t("meetings.caption.errors.notResponding"),
  microfoneDaGravacao: t => t("meetings.caption.errors.recordingMicLost"),
};

/**
 * A recusa do ligar no idioma da tela: a reunião que não existe mais tem a
 * frase dela; a que foi para a lixeira (por outro aparelho; a guarda da
 * lixeira manda o código REUNIAO_NA_LIXEIRA) e o resto, a tabela das
 * mensagens do servidor.
 */
function fraseDaRecusa(erro: unknown, t: (chave: string) => string): string {
  const codigo = (erro as { data?: { code?: unknown } } | null)?.data?.code;
  const mensagem = (erro as { message?: unknown } | null)?.message;
  if (codigo === "NOT_FOUND" && mensagem !== RECUSAS_DA_LIXEIRA.naLixeira) return t("meetings.caption.errors.meetingGone");
  return mensagemDeErroParaTela(erro, t);
}

function PainelDaLegenda({ meetingId, idioma, ativa, microfoneCaiu }: Props) {
  const { t, i18n } = useTranslation();
  const utils = trpc.useUtils();
  const idDoTitulo = useId();
  const idDaCaixa = useId();
  const idiomaDaTela = i18n.resolvedLanguage ?? i18n.language;
  const daLegenda = useMemo(
    () => idiomaDaLegenda(idioma, idiomaDaTela, typeof navigator === "undefined" ? [] : navigator.languages ?? []),
    [idioma, idiomaDaTela],
  );
  const nomeDoIdioma = nomeDoIdiomaEm(daLegenda.idioma, idiomaDaTela);
  const legenda = useLegendaAoVivo({ ativa, microfoneCaiu, etiqueta: daLegenda.etiqueta, separador: separadorDoIdioma(daLegenda.idioma) });

  // O aviso e a confirmação (uma vez por gravação: a legenda nasce com a gravação, key no Meetings).
  const [avisoAberto, setAvisoAberto] = useState(false);
  const [concorda, setConcorda] = useState(false);
  const [confirmada, setConfirmada] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [recusa, setRecusa] = useState<string | null>(null);

  const [tamanho, setTamanho] = useState(() => lerTamanhoDaLetra());
  const mudarTamanho = (passo: number) => {
    const novo = Math.min(TAMANHOS_DA_LETRA.length - 1, Math.max(0, tamanho + passo));
    setTamanho(novo);
    guardarTamanhoDaLetra(novo);
  };

  // O texto do aviso como aparece na caixa: vai para a prova, porque a frase
  // muda com a revisão da Cris.
  const titulo = t("meetings.caption.noticeTitle");
  const paragrafos = [t("meetings.caption.noticeBrowser"), t("meetings.caption.noticeSpeakers"), t("meetings.caption.noticeNotSaved")];
  const caixa = t("meetings.caption.consentLabel");

  const aoTocarLigar = () => {
    setRecusa(null);
    if (confirmada) return legenda.ligar();
    setConcorda(false);
    setAvisoAberto(true);
  };

  async function confirmar() {
    if (!concorda || enviando) return;
    setEnviando(true);
    setRecusa(null);
    try {
      await utils.client.meetings.ligarLegendaAoVivo.mutate({
        meetingId,
        concordanciaDasPessoas: true,
        versaoDoAviso: VERSAO_VIGENTE_DO_AVISO_DA_LEGENDA,
        idioma: idiomaDaReuniao(idiomaDaTela) ?? IDIOMA_DA_REUNIAO_PADRAO,
        textoExibido: [titulo, ...paragrafos, caixa].join("\n"),
      });
      setConfirmada(true);
      setAvisoAberto(false);
      legenda.ligar();
    } catch (erro) {
      // Sem a prova, a legenda não liga: o aviso fica aberto com a recusa.
      setRecusa(fraseDaRecusa(erro, t));
    } finally {
      setEnviando(false);
    }
  }

  // A caixa acompanha o texto novo, salvo quando a dona subiu para reler.
  const caixaDoTexto = useRef<HTMLDivElement | null>(null);
  const seguirOFim = useRef(true);
  useLayoutEffect(() => {
    const elemento = caixaDoTexto.current;
    if (elemento && seguirOFim.current) elemento.scrollTop = elemento.scrollHeight;
  }, [legenda.linhas, legenda.provisorio]);

  const ligada = legenda.estado !== "desligada";
  const temTexto = legenda.linhas.length > 0 || legenda.provisorio !== "";
  const botaoDiscreto = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/15 px-2.5 py-1.5 text-xs text-white/75 hover:bg-white/5 disabled:opacity-40";

  return <section aria-labelledby={idDoTitulo} className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-start">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 id={idDoTitulo} className="inline-flex items-center gap-2 text-base font-semibold"><Captions size={16} aria-hidden className="text-amber-300"/>{t("meetings.caption.title")}</h2>
      {ligada && <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => mudarTamanho(-1)} disabled={tamanho === 0} aria-label={t("meetings.caption.smaller")} aria-controls={idDaCaixa} className={botaoDiscreto}><AArrowDown size={16} aria-hidden/></button>
        <button type="button" onClick={() => mudarTamanho(1)} disabled={tamanho === TAMANHOS_DA_LETRA.length - 1} aria-label={t("meetings.caption.larger")} aria-controls={idDaCaixa} className={botaoDiscreto}><AArrowUp size={16} aria-hidden/></button>
        <button type="button" onClick={legenda.desligar} className={botaoDiscreto}><CaptionsOff size={14} aria-hidden/> {t("meetings.caption.turnOff")}</button>
      </div>}
    </div>
    {!ligada ? <>
      <p className="mt-1 text-xs text-white/50">{t("meetings.caption.intro")}</p>
      <button type="button" onClick={aoTocarLigar} className="mt-3 w-full rounded-xl border border-white/20 py-3 text-sm text-white/80 hover:bg-white/5 inline-flex justify-center items-center gap-2">
        <Captions size={17} aria-hidden/> {t("meetings.caption.turnOn")}
      </button>
      {legenda.falha && <p role="alert" className="mt-2 text-xs text-amber-200/90">{FRASE_DA_FALHA[legenda.falha](t, nomeDoIdioma)}</p>}
    </> : <>
      <p className="mt-1 text-xs text-white/50">
        {t("meetings.caption.reminder", { idioma: nomeDoIdioma })}
        {daLegenda.automatico && <> {t("meetings.caption.autoLanguage")}</>}
      </p>
      {/* Sem anúncio ao leitor de tela (aria-live off): quem ouve a reunião não precisa da legenda lida em voz alta por cima. Focável, para rolar pelo teclado. */}
      <div ref={caixaDoTexto} id={idDaCaixa} role="region" aria-live="off" aria-label={t("meetings.caption.boxLabel")} tabIndex={0}
        onScroll={evento => {
          const elemento = evento.currentTarget;
          seguirOFim.current = elemento.scrollHeight - elemento.scrollTop - elemento.clientHeight < 48;
        }}
        style={{ fontSize: `${TAMANHOS_DA_LETRA[tamanho]}px`, lineHeight: 1.4 }}
        className="mt-3 max-h-72 overflow-y-auto rounded-xl border border-white/10 bg-black/30 p-3 text-white/90">
        {temTexto ? <>
          {legenda.linhas.map((linha, i) => <p key={i} dir="auto">{linha}</p>)}
          {legenda.provisorio && <p dir="auto" className="text-white/55">{legenda.provisorio}</p>}
        </> : legenda.estado === "pausada"
          ? <p role="status" className="text-sm text-amber-200/80">{t("meetings.caption.pausedEmpty")}</p>
          : <p className="text-sm text-white/45">{t("meetings.caption.listening")}</p>}
      </div>
      {/* Com texto na caixa, a pausa é dita embaixo; sem texto, dentro dela. */}
      {legenda.estado === "pausada" && temTexto && <p role="status" className="mt-2 text-xs text-amber-200/80">{t("meetings.caption.paused")}</p>}
    </>}

    <AlertDialog open={avisoAberto} onOpenChange={aberto => { if (!enviando) setAvisoAberto(aberto); }}>
      <AlertDialogContent className="border-white/15 bg-[#211e1b] text-white rounded-2xl sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-base font-bold text-white">{titulo}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm leading-6 text-white/70">
              {paragrafos.map(paragrafo => <p key={paragrafo}>{paragrafo}</p>)}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex items-start gap-3 rounded-xl border border-white/10 p-3 cursor-pointer">
          <input type="checkbox" checked={concorda} disabled={enviando} onChange={evento => setConcorda(evento.target.checked)} className="mt-1 accent-amber-400"/>
          <span className="text-sm text-white/75">{caixa}</span>
        </label>
        {recusa && <p role="alert" className="rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">{recusa}</p>}
        <AlertDialogFooter className="flex-row gap-3">
          <AlertDialogCancel disabled={enviando} className="flex-1 rounded-xl border-white/15 bg-transparent text-white/60 hover:bg-white/8 hover:text-white">
            {t("meetings.caption.notNow")}
          </AlertDialogCancel>
          {/* Botão comum, e não o Action do diálogo: o aviso só fecha depois de a prova entrar. */}
          <button type="button" onClick={() => void confirmar()} disabled={!concorda || enviando} aria-busy={enviando}
            className="flex-1 rounded-xl bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-50 inline-flex justify-center items-center gap-2">
            {enviando && <Loader2 size={15} className="animate-spin" aria-hidden/>} {t("meetings.caption.confirm")}
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>;
}
