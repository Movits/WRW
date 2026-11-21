import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { CircleAlert, Loader2, MonitorPlay, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { LANGUAGES } from "@/i18n";
import { fraseDoPedidoDoYoutube } from "@/lib/erro-do-youtube";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TITULO_DA_REUNIAO_MAX, TITULO_DA_REUNIAO_MIN } from "@shared/const";
import { IDIOMA_DA_REUNIAO_PADRAO, idiomaDaReuniao, type IdiomaDaReuniao } from "@shared/idioma-da-reuniao";
import { rotaDaReuniao } from "@shared/rotas";
import {
  idDoVideoDoYoutube, SEGUNDOS_DO_VIDEO_DO_YOUTUBE_MAX, TAMANHO_MAXIMO_DO_LINK_DO_YOUTUBE, VERSAO_VIGENTE_DO_AVISO_DO_YOUTUBE,
  VIDEOS_DO_YOUTUBE_POR_DIA,
} from "@shared/youtube";

/**
 * "Resumir um vídeo do YouTube" (H13), na lista de Reuniões: a dona cola o
 * link de um vídeo público, dá o título e o idioma falado e aceita o aviso do
 * YouTube; o servidor cria a reunião e a IA lê o vídeo (só a primeira hora).
 * Daí a tela vai ao detalhe da reunião, que acompanha o processamento.
 *
 * O link é conferido aqui com a mesma regra do servidor (shared/youtube.ts),
 * para a dona ver o aviso no idioma dela antes de enviar; o servidor confere
 * de novo. Nada aqui abre o link: nem a tela nem o servidor buscam o vídeo.
 */
export function ResumoDoYoutube() {
  const { t, i18n } = useTranslation();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [aberto, setAberto] = useState(false);
  const [titulo, setTitulo] = useState("");
  const [link, setLink] = useState("");
  const [idioma, setIdioma] = useState<IdiomaDaReuniao>(() => idiomaDaReuniao(i18n.resolvedLanguage ?? i18n.language) ?? IDIOMA_DA_REUNIAO_PADRAO);
  const [consentimento, setConsentimento] = useState(false);
  // Os avisos dos campos só aparecem depois da primeira tentativa de enviar.
  const [tentou, setTentou] = useState(false);
  const pedir = trpc.meetings.resumirVideoDoYoutube.useMutation();
  const ids = { titulo: useId(), link: useId(), idioma: useId(), erroTitulo: useId(), erroLink: useId(), erroConsentimento: useId(), aviso: useId() };

  const tituloLimpo = titulo.trim();
  const avisoDoTitulo = !tituloLimpo
    ? t("meetings.titleRequired")
    : tituloLimpo.length < TITULO_DA_REUNIAO_MIN || tituloLimpo.length > TITULO_DA_REUNIAO_MAX
      ? t("meetings.titleLength", { min: TITULO_DA_REUNIAO_MIN, max: TITULO_DA_REUNIAO_MAX })
      : null;
  const avisoDoLink = !link.trim()
    ? t("meetings.youtube.linkRequired")
    : idDoVideoDoYoutube(link) ? null : t("meetings.youtube.errors.linkInvalid");
  const avisoDoConsentimento = consentimento ? null : t("meetings.youtube.consentRequired");
  const mostrar = (aviso: string | null) => (tentou ? aviso : null);

  function abrirOuFechar(estado: boolean) {
    // Enviando, a janela não fecha: o pedido segue, e a resposta leva ao detalhe.
    if (!estado && pedir.isPending) return;
    setAberto(estado);
    if (!estado) {
      setTentou(false);
      pedir.reset();
    }
  }

  function enviar(evento: FormEvent) {
    evento.preventDefault();
    setTentou(true);
    if (avisoDoTitulo || avisoDoLink || avisoDoConsentimento || pedir.isPending) return;
    pedir.mutate(
      { title: tituloLimpo, url: link.trim(), language: idioma, consentGranted: true, consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DO_YOUTUBE },
      {
        onSuccess: ({ id }) => {
          toast.success(t("meetings.youtube.started"));
          void utils.meetings.list.invalidate();
          setAberto(false);
          setTitulo("");
          setLink("");
          setConsentimento(false);
          setTentou(false);
          navigate(rotaDaReuniao(id));
        },
      },
    );
  }

  const campo = "mt-2 w-full rounded-xl bg-white/5 border border-white/15 px-4 py-3 text-white outline-none focus:border-amber-300 disabled:opacity-60";
  return <>
    <button type="button" onClick={() => setAberto(true)}
      className="inline-flex justify-center items-center gap-2 rounded-xl border border-[#c98f70]/50 px-5 py-3 font-semibold text-[#efcba8] hover:bg-[#c98f70]/10">
      <MonitorPlay size={18} aria-hidden/> {t("meetings.youtube.openButton")}
    </button>
    <Dialog open={aberto} onOpenChange={abrirOuFechar}>
      <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-2rem)] overflow-y-auto border-white/15 bg-[#211e1b] text-white sm:max-w-lg">
        {/* O cabeçalho do shadcn alinha à esquerda do sm para cima (sm:text-left): aqui, ao início da linha, que em árabe é a direita. */}
        <DialogHeader className="sm:text-start">
          <DialogTitle className="flex items-center gap-2 text-white"><MonitorPlay size={18} className="text-amber-300" aria-hidden/>{t("meetings.youtube.dialogTitle")}</DialogTitle>
          <DialogDescription className="text-sm text-white/60">
            {t("meetings.youtube.dialogIntro", { minutos: SEGUNDOS_DO_VIDEO_DO_YOUTUBE_MAX / 60 })}
          </DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={enviar} className="space-y-4">
          <div>
            <label htmlFor={ids.link} className="text-sm text-white/70">{t("meetings.youtube.linkLabel")}</label>
            <input id={ids.link} type="url" inputMode="url" autoComplete="off" dir="ltr" value={link} disabled={pedir.isPending}
              onChange={evento => setLink(evento.target.value)} maxLength={TAMANHO_MAXIMO_DO_LINK_DO_YOUTUBE}
              placeholder="https://www.youtube.com/watch?v=…" aria-invalid={!!mostrar(avisoDoLink)}
              aria-describedby={mostrar(avisoDoLink) ? ids.erroLink : undefined} className={campo}/>
            {mostrar(avisoDoLink) && <p id={ids.erroLink} className="mt-1.5 text-xs text-red-300">{avisoDoLink}</p>}
          </div>
          <div>
            <label htmlFor={ids.titulo} className="text-sm text-white/70">{t("meetings.titleLabel")}</label>
            <input id={ids.titulo} value={titulo} disabled={pedir.isPending} onChange={evento => setTitulo(evento.target.value)}
              maxLength={TITULO_DA_REUNIAO_MAX} placeholder={t("meetings.youtube.titlePlaceholder")} aria-invalid={!!mostrar(avisoDoTitulo)}
              aria-describedby={mostrar(avisoDoTitulo) ? ids.erroTitulo : undefined} className={campo}/>
            {mostrar(avisoDoTitulo) && <p id={ids.erroTitulo} className="mt-1.5 text-xs text-red-300">{avisoDoTitulo}</p>}
          </div>
          <div>
            <label htmlFor={ids.idioma} className="text-sm text-white/70">{t("meetings.youtube.languageLabel")}</label>
            <select id={ids.idioma} value={idioma} disabled={pedir.isPending}
              onChange={evento => setIdioma(idiomaDaReuniao(evento.target.value) ?? IDIOMA_DA_REUNIAO_PADRAO)} className={campo}>
              {LANGUAGES.map(language => <option className="bg-white text-[#322C26]" key={language.code} value={language.code}>{language.flag} {language.label}</option>)}
            </select>
          </div>
          <p id={ids.aviso} className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm text-amber-100/80">
            <CircleAlert size={16} className="me-2 inline" aria-hidden/>{t("meetings.youtube.notice", { minutos: SEGUNDOS_DO_VIDEO_DO_YOUTUBE_MAX / 60, n: VIDEOS_DO_YOUTUBE_POR_DIA })}
          </p>
          <div>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 p-4">
              <input type="checkbox" checked={consentimento} disabled={pedir.isPending} onChange={evento => setConsentimento(evento.target.checked)}
                aria-describedby={[ids.aviso, mostrar(avisoDoConsentimento) ? ids.erroConsentimento : ""].filter(Boolean).join(" ")}
                aria-invalid={!!mostrar(avisoDoConsentimento)} className="mt-1 accent-amber-400"/>
              <span className="text-sm text-white/70">{t("meetings.youtube.consentLabel")}</span>
            </label>
            {mostrar(avisoDoConsentimento) && <p id={ids.erroConsentimento} className="mt-1.5 text-xs text-red-300">{avisoDoConsentimento}</p>}
          </div>
          {pedir.isError && <p role="alert" className="rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">{fraseDoPedidoDoYoutube(pedir.error, t)}</p>}
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row">
            <button type="button" onClick={() => abrirOuFechar(false)} disabled={pedir.isPending}
              className="rounded-xl border border-white/15 px-4 py-2.5 text-sm text-white/70 hover:bg-white/5 disabled:opacity-50">
              {t("meetings.youtube.cancel")}
            </button>
            <button type="submit" disabled={pedir.isPending} aria-busy={pedir.isPending}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#c98f70] px-4 py-2.5 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-60">
              {pedir.isPending ? <Loader2 size={16} className="animate-spin" aria-hidden/> : <Sparkles size={16} aria-hidden/>} {t("meetings.youtube.submit")}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
