// O perfil de voz da dona, no Perfil (H3d; HN-24 da auditoria, aprovado pelo
// Roberto em 24/11/2026; servidor em server/perfil-de-voz.ts).
//
// A dona lê em voz alta o texto da tela (cerca de 30 s), e as próximas
// reuniões que ela gravar já a reconhecem: a fala dela sai com o nome dela. É
// dado biométrico (LGPD art. 11): a caixa do consentimento (texto da Cris) nasce
// DESMARCADA, é separada do aceite dos Termos, e sem ela o botão de gravar não
// liga. O texto que a dona viu vai junto, com a versão e o idioma, para o
// registro. Com o perfil gravado: ouvir, regravar e desligar (desligar exclui o
// perfil de vez, com confirmação). A falha da consulta é erro na tela
// (ErroDeConsulta), nunca "sem perfil".

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Mic, Play, RotateCcw, Square, Trash2, AudioLines } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { gravacaoDeAudioSuportada, useGravadorDeAudio, type AudioGravado } from "@/hooks/useGravadorDeAudio";
import {
  DURACAO_MAXIMA_DA_AMOSTRA_MS, DURACAO_MINIMA_DA_AMOSTRA_MS, DURACAO_SUGERIDA_DA_AMOSTRA_S, VERSAO_VIGENTE_DO_TEXTO_DO_PERFIL_DE_VOZ,
} from "@shared/perfil-de-voz";

const CLASSE_PRINCIPAL = "inline-flex items-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-50 disabled:cursor-not-allowed";
const CLASSE_SECUNDARIA = "inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm text-white/85 hover:bg-white/5 disabled:opacity-50";

function lerComoDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onerror = () => reject(leitor.error);
    leitor.onload = () => resolve(String(leitor.result));
    leitor.readAsDataURL(blob);
  });
}

/** A moldura das seções do Perfil (o `Section` de pages/Profile.tsx). */
function Moldura({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="perfil-de-voz-titulo" className="bg-[#1b1714] border border-white/8 rounded-2xl overflow-hidden">
      <div className="px-6 pt-6 pb-4 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
            <AudioLines size={16} aria-hidden="true" />
          </div>
          <div>
            <h2 id="perfil-de-voz-titulo" className="text-white font-bold text-base leading-tight">{t("perfilDeVoz.title")}</h2>
            <p className="text-white/40 text-xs mt-0.5">{t("perfilDeVoz.subtitle")}</p>
          </div>
        </div>
      </div>
      <div className="p-6 space-y-4">{children}</div>
    </section>
  );
}

export function PerfilDeVoz() {
  const { t, i18n } = useTranslation();
  const utils = trpc.useUtils();
  const estado = trpc.perfilDeVoz.estado.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });
  const [consentiu, setConsentiu] = useState(false);
  const [regravando, setRegravando] = useState(false);
  const [confirmandoDesligar, setConfirmandoDesligar] = useState(false);
  const [urlDaAmostra, setUrlDaAmostra] = useState<string | null>(null);

  // A URL do áudio ouvido sai da memória quando muda ou a tela fecha.
  useEffect(() => () => { if (urlDaAmostra) URL.revokeObjectURL(urlDaAmostra); }, [urlDaAmostra]);

  const erro = (e: unknown) => toast.error(mensagemDeErroParaTela(e, t));
  const gravar = trpc.perfilDeVoz.gravar.useMutation({
    onSuccess: () => {
      setRegravando(false);
      setConsentiu(false);
      setUrlDaAmostra(null);
      void utils.perfilDeVoz.estado.invalidate();
      toast.success(t("perfilDeVoz.toast.saved"));
    },
    onError: erro,
  });
  const ouvir = trpc.perfilDeVoz.ouvir.useMutation({
    onSuccess: ({ audioBase64, mimeType }) => {
      const bytes = Uint8Array.from(atob(audioBase64), letra => letra.charCodeAt(0));
      setUrlDaAmostra(URL.createObjectURL(new Blob([bytes], { type: mimeType })));
    },
    onError: erro,
  });
  const desligar = trpc.perfilDeVoz.desligar.useMutation({
    onSuccess: () => {
      setConfirmandoDesligar(false);
      setUrlDaAmostra(null);
      void utils.perfilDeVoz.estado.invalidate();
      toast.success(t("perfilDeVoz.toast.deleted"));
    },
    onError: erro,
  });

  // O texto do consentimento como a dona o vê, no idioma da tela: vai para o registro.
  const textoDoConsentimento = `${t("perfilDeVoz.consent")}\n${t("perfilDeVoz.consentSupport")}`;

  async function enviar({ blob, mimeType, duracaoMs }: AudioGravado) {
    if (!blob.size) return;
    if (duracaoMs < DURACAO_MINIMA_DA_AMOSTRA_MS) {
      toast.error(t("perfilDeVoz.tooShort", { segundos: Math.round(DURACAO_MINIMA_DA_AMOSTRA_MS / 1000) }));
      return;
    }
    try {
      const audioBase64 = await lerComoDataUrl(blob);
      const primeira = !estado.data?.ativo;
      gravar.mutate({
        audioBase64, mimeType, duracaoMs: Math.min(Math.round(duracaoMs), DURACAO_MAXIMA_DA_AMOSTRA_MS),
        ...(primeira ? { consentimento: { versaoDoTexto: VERSAO_VIGENTE_DO_TEXTO_DO_PERFIL_DE_VOZ, idioma: i18n.resolvedLanguage ?? i18n.language, textoExibido: textoDoConsentimento } } : {}),
      });
    } catch {
      toast.error(t("perfilDeVoz.erros.amostraInvalida"));
    }
  }

  const gravador = useGravadorDeAudio({
    limiteSegundos: DURACAO_MAXIMA_DA_AMOSTRA_MS / 1000,
    bitsPorSegundo: 64_000,
    aoTerminar: amostra => void enviar(amostra),
    aoFalhar: () => toast.error(t("perfilDeVoz.micError")),
  });
  const gravando = gravador.estado === "gravando" || gravador.estado === "pedindoMicrofone";

  async function comecar() {
    if (!gravacaoDeAudioSuportada()) {
      toast.error(t("perfilDeVoz.unsupported"));
      return;
    }
    await gravador.comecar();
  }

  if (estado.isLoading) return null;
  if (estado.error) {
    return <Moldura><ErroDeConsulta erro={estado.error} aoTentarDeNovo={() => void estado.refetch()} /></Moldura>;
  }
  const ativo = estado.data?.ativo === true;
  const mostrarGravador = !ativo || regravando;
  const relogio = `${String(Math.floor(gravador.segundos / 60)).padStart(2, "0")}:${String(gravador.segundos % 60).padStart(2, "0")}`;

  return (
    <Moldura>
      {ativo && !regravando && (
        <div className="space-y-3">
          <p className="text-sm text-white/80">
            {t("perfilDeVoz.active", { data: new Date(estado.data && estado.data.ativo ? estado.data.atualizadoEm : 0).toLocaleDateString(i18n.resolvedLanguage ?? i18n.language) })}
          </p>
          <p className="text-xs text-white/50">{t("perfilDeVoz.howItWorks")}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={CLASSE_SECUNDARIA} onClick={() => ouvir.mutate()} disabled={ouvir.isPending}>
              <Play size={14} aria-hidden="true" /> {t("perfilDeVoz.listen")}
            </button>
            {/* Regravar fecha a amostra que tocava e a confirmação de desligar:
                sem isso, o Cancelar remontava o player com autoPlay (a amostra
                voltava a tocar sozinha) e reabria a confirmação. */}
            <button type="button" className={CLASSE_SECUNDARIA} onClick={() => { setUrlDaAmostra(null); setConfirmandoDesligar(false); setRegravando(true); }}>
              <RotateCcw size={14} aria-hidden="true" /> {t("perfilDeVoz.rerecord")}
            </button>
            <button type="button" className={CLASSE_SECUNDARIA} onClick={() => setConfirmandoDesligar(true)}>
              <Trash2 size={14} aria-hidden="true" /> {t("perfilDeVoz.turnOff")}
            </button>
          </div>
          {urlDaAmostra && (
            <audio src={urlDaAmostra} controls autoPlay className="w-full" aria-label={t("perfilDeVoz.listen")} />
          )}
          {confirmandoDesligar && (
            <div role="alertdialog" aria-labelledby="perfil-de-voz-desligar" className="rounded-xl border border-red-400/30 bg-red-500/5 p-4 space-y-3">
              <p id="perfil-de-voz-desligar" className="text-sm text-white/85">{t("perfilDeVoz.turnOffConfirm")}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={CLASSE_PRINCIPAL} onClick={() => desligar.mutate()} disabled={desligar.isPending}>
                  {desligar.isPending ? t("perfilDeVoz.turningOff") : t("perfilDeVoz.turnOffYes")}
                </button>
                <button type="button" className={CLASSE_SECUNDARIA} onClick={() => setConfirmandoDesligar(false)} disabled={desligar.isPending}>
                  {t("perfilDeVoz.cancel")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {mostrarGravador && (
        <div className="space-y-4">
          {!ativo && <p className="text-sm text-white/75">{t("perfilDeVoz.intro", { segundos: DURACAO_SUGERIDA_DA_AMOSTRA_S })}</p>}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-xs uppercase tracking-wide text-white/40 mb-2">{t("perfilDeVoz.readAloud")}</p>
            <p className="text-sm leading-relaxed text-white/90">{t("perfilDeVoz.textToRead")}</p>
          </div>

          {!ativo && (
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-amber-500"
                checked={consentiu}
                onChange={evento => setConsentiu(evento.target.checked)}
                disabled={gravando || gravar.isPending}
              />
              <span className="space-y-1">
                <span className="block text-sm text-white/90">{t("perfilDeVoz.consent")}</span>
                <span className="block text-xs text-white/50">{t("perfilDeVoz.consentSupport")}</span>
              </span>
            </label>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {!gravando ? (
              <button type="button" className={CLASSE_PRINCIPAL} onClick={() => void comecar()} disabled={(!ativo && !consentiu) || gravar.isPending}>
                <Mic size={14} aria-hidden="true" /> {gravar.isPending ? t("perfilDeVoz.saving") : t("perfilDeVoz.record")}
              </button>
            ) : (
              <button type="button" className={CLASSE_PRINCIPAL} onClick={() => gravador.parar()} disabled={gravador.estado !== "gravando"}>
                <Square size={14} aria-hidden="true" /> {t("perfilDeVoz.stop")}
              </button>
            )}
            {gravando && <span className="text-sm tabular-nums text-white/70" aria-live="polite">{relogio}</span>}
            {ativo && regravando && !gravando && (
              <button type="button" className={CLASSE_SECUNDARIA} onClick={() => setRegravando(false)} disabled={gravar.isPending}>
                {t("perfilDeVoz.cancel")}
              </button>
            )}
          </div>
          {!ativo && !consentiu && <p className="text-xs text-white/40">{t("perfilDeVoz.needsConsent")}</p>}
        </div>
      )}
    </Moldura>
  );
}
