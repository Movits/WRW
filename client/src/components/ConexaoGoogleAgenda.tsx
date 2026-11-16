// A conexão da dona com a Google Agenda, no Perfil (H16b do plano do gravador).
//
// Conectar é navegação de página inteira: o botão é um <a href> para
// /api/google-agenda/conectar (nunca o Link do wouter, que não sai do app),
// o servidor manda à tela de consentimento da Google, e a Google volta ao
// Perfil com `?google=<resultado>`, que vira um aviso no idioma de quem lê. O
// parâmetro sai da URL logo depois, para o F5 não repetir o aviso.
//
// A seção só existe quando a função está disponível (as variáveis do cliente
// OAuth no servidor). A falha da consulta é erro na tela (ErroDeConsulta),
// nunca "nenhuma conta conectada". O cookie da ida é do host: quem está noutro
// endereço (o do Render, por exemplo) recebe o caminho para o endereço certo
// em vez do botão.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useSearch } from "wouter";
import { AlertTriangle, CalendarCheck, ExternalLink, Unplug } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import {
  lerResultadoDaGoogleAgenda,
  PARAMETRO_DO_RESULTADO_GOOGLE,
  ROTA_CONECTAR_GOOGLE_AGENDA,
  ROTA_DO_PERFIL,
  type ResultadoDaGoogleAgenda,
} from "@shared/google-agenda";

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/** O aviso de cada resultado que a volta da Google traz em `?google=`. */
export function avisoDaVolta(t: TranslateFn, resultado: ResultadoDaGoogleAgenda): { tipo: "success" | "info" | "error"; texto: string } {
  switch (resultado) {
    case "conectada": return { tipo: "success", texto: t("googleAgenda.result.connected") };
    case "negada": return { tipo: "info", texto: t("googleAgenda.result.denied") };
    case "sem-permissao": return { tipo: "error", texto: t("googleAgenda.result.missingPermission") };
    case "expirou": return { tipo: "error", texto: t("googleAgenda.result.expired") };
    case "endereco": return { tipo: "error", texto: t("googleAgenda.result.wrongAddress") };
    case "erro": return { tipo: "error", texto: t("googleAgenda.result.error") };
  }
}

/** O código do tRPC decide a frase: as mensagens do servidor vêm em português. */
export function mensagemDoErroDaGoogleAgenda(t: TranslateFn, erro: unknown): string {
  if ((erro as { data?: { code?: string } } | null)?.data?.code === "NOT_FOUND") return t("googleAgenda.errors.unavailable");
  return mensagemDeErroParaTela(erro, t);
}

/** O host da origem (o FRONTEND_URL do servidor), em minúsculas, ou null. */
function hostDe(origem: string): string | null {
  try {
    return new URL(origem).host.toLowerCase();
  } catch {
    return null;
  }
}

const CLASSE_PRINCIPAL = "inline-flex items-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8]";
const CLASSE_SECUNDARIA = "inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm text-white/85 hover:bg-white/5 disabled:opacity-50";

/** A moldura das seções do Perfil (o `Section` de pages/Profile.tsx). */
function Moldura({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="google-agenda-titulo" className="bg-[#1b1714] border border-white/8 rounded-2xl overflow-hidden">
      <div className="px-6 pt-6 pb-4 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
            <CalendarCheck size={16} aria-hidden="true" />
          </div>
          <div>
            <h2 id="google-agenda-titulo" className="text-white font-bold text-base leading-tight">{t("googleAgenda.title")}</h2>
            <p className="text-white/40 text-xs mt-0.5">{t("googleAgenda.subtitle")}</p>
          </div>
        </div>
      </div>
      <div className="p-6 space-y-4">{children}</div>
    </section>
  );
}

export function ConexaoGoogleAgenda() {
  const { t } = useTranslation();
  const busca = useSearch();
  const [, navegar] = useLocation();
  const utils = trpc.useUtils();
  const [confirmando, setConfirmando] = useState(false);
  const estado = trpc.googleAgenda.estado.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });

  // A volta da Google: um aviso só, e o parâmetro sai da URL.
  const avisado = useRef(false);
  useEffect(() => {
    const resultado = lerResultadoDaGoogleAgenda(busca);
    if (!resultado || avisado.current) return;
    avisado.current = true;
    const aviso = avisoDaVolta(t, resultado);
    toast[aviso.tipo](aviso.texto);
    const resto = new URLSearchParams(busca);
    resto.delete(PARAMETRO_DO_RESULTADO_GOOGLE);
    const consulta = resto.toString();
    navegar(consulta ? `${ROTA_DO_PERFIL}?${consulta}` : ROTA_DO_PERFIL, { replace: true });
  }, [busca, navegar, t]);

  const desconectar = trpc.googleAgenda.desconectar.useMutation({
    onSuccess: (resultado) => {
      setConfirmando(false);
      // A conexão saiu da WRW nos dois casos; sem a confirmação da Google, a
      // dona fica sabendo que pode tirar o acesso pela conta Google dela.
      if (resultado.googleNaoConfirmou) toast.warning(t("googleAgenda.toast.disconnectedPending"), { duration: 15000 });
      else toast.success(t("googleAgenda.toast.disconnected"));
      void utils.googleAgenda.estado.invalidate();
    },
    onError: (erro) => toast.error(mensagemDoErroDaGoogleAgenda(t, erro)),
  });

  // Enquanto carrega, nada: a seção só aparece quando a função existe.
  if (estado.isLoading) return null;
  if (estado.isError) {
    return <Moldura><ErroDeConsulta erro={estado.error} aoTentarDeNovo={() => void estado.refetch()} /></Moldura>;
  }
  const dados = estado.data;
  if (!dados || !dados.disponivel) return null;

  const hostCerto = hostDe(dados.origem);
  const noEnderecoCerto = hostCerto !== null && window.location.host.toLowerCase() === hostCerto;
  const botaoDeConectar = (rotulo: string) => (
    <a href={ROTA_CONECTAR_GOOGLE_AGENDA} className={CLASSE_PRINCIPAL}>
      <CalendarCheck size={15} aria-hidden="true" /> {rotulo}
    </a>
  );

  return (
    <Moldura>
      {dados.conectada ? (
        <p className="text-sm text-white/80 break-words">
          {dados.email ? t("googleAgenda.connectedAs", { email: dados.email }) : t("googleAgenda.connected")}
        </p>
      ) : (
        <p className="text-sm text-white/60">{t("googleAgenda.notConnected")}</p>
      )}

      {dados.conectada && dados.falha && (
        <p role="status" className="flex gap-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] p-3 text-xs text-amber-300">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          {t("googleAgenda.broken")}
        </p>
      )}

      <p className="text-xs leading-relaxed text-white/40">{t("googleAgenda.privacyNote")}</p>

      {!noEnderecoCerto && hostCerto && (!dados.conectada || dados.falha) && (
        <div className="space-y-2 rounded-lg border border-white/10 bg-white/[0.03] p-3">
          <p className="text-xs text-white/60">{t("googleAgenda.wrongAddress", { address: hostCerto })}</p>
          <a href={`${dados.origem}${ROTA_DO_PERFIL}`} className={CLASSE_SECUNDARIA}>
            <ExternalLink size={14} aria-hidden="true" /> {t("googleAgenda.openAddress", { address: hostCerto })}
          </a>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {noEnderecoCerto && !dados.conectada && botaoDeConectar(t("googleAgenda.connect"))}
        {noEnderecoCerto && dados.conectada && dados.falha && botaoDeConectar(t("googleAgenda.reconnect"))}
        {dados.conectada && !confirmando && (
          <button type="button" onClick={() => setConfirmando(true)} disabled={desconectar.isPending} className={CLASSE_SECUNDARIA}>
            <Unplug size={15} aria-hidden="true" /> {t("googleAgenda.disconnect")}
          </button>
        )}
      </div>

      {dados.conectada && confirmando && (
        <div className="space-y-2 rounded-xl border border-red-400/25 bg-red-500/[0.06] p-3">
          <p id="google-agenda-desconectar" className="text-sm text-red-100/90">{t("googleAgenda.disconnectConfirm")}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={desconectar.isPending} onClick={() => desconectar.mutate()}
              className="inline-flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-bold text-white hover:bg-red-400 disabled:opacity-50">
              {desconectar.isPending ? t("googleAgenda.disconnecting") : t("googleAgenda.disconnectYes")}
            </button>
            {/* Manter, a saída segura, recebe o foco, e a pergunta vai junto no anúncio. */}
            <button type="button" autoFocus aria-describedby="google-agenda-desconectar" onClick={() => setConfirmando(false)}
              className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/65 hover:bg-white/5">
              {t("googleAgenda.disconnectNo")}
            </button>
          </div>
        </div>
      )}
    </Moldura>
  );
}
