// A conta Google para entrar, no Perfil (A8 da auditoria, HN-80 do HiNoter):
// ligar a conta Google a esta conta de e-mail (e entrar com ela da próxima
// vez) ou desligar a que está ligada.
//
// Ligar é navegação de página inteira (um <a href> para
// /api/entrar-com-google/ir?modo=ligar); a volta traz `?conta-google=` ao
// Perfil, que vira um aviso no idioma de quem lê e sai da URL. Ligar pede uma
// entrada dos últimos 10 minutos, como ativar uma chave de acesso: a volta com
// `entre-de-novo` abre aqui o pedido da senha, que entra de novo por
// `auth.login` e recomeça a ida.
//
// A seção aparece com a função ligada no servidor ou com uma conta Google já
// ligada (o Desligar funciona sempre). A falha da consulta é erro na tela
// (ErroDeConsulta), nunca "nenhuma conta ligada". Noutro host, ou dentro de
// WebView (onde a Google recusa a entrada), o Ligar dá lugar ao caminho certo.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useSearch } from "wouter";
import { ExternalLink, Link2, Smartphone, Unplug } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { googleRecusaEntrarAqui } from "@/lib/instalacao-do-app";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { avisoDaContaGoogle, buscaSemOResultado, hostDaOrigem, mensagemDoErroDaContaGoogle } from "@/lib/entrar-com-google";
import { enderecoDoBotaoDoGoogle, lerResultadoDaContaGoogle } from "@shared/entrar-com-google";

const CLASSE_PRINCIPAL = "inline-flex items-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-50";
const CLASSE_SECUNDARIA = "inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm text-white/85 hover:bg-white/5 disabled:opacity-50";

/** A moldura das seções do Perfil (o `Section` de pages/Profile.tsx). */
function Moldura({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="conta-google-titulo" className="bg-[#1b1714] border border-white/8 rounded-2xl overflow-hidden">
      <div className="px-6 pt-6 pb-4 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
            <Link2 size={16} aria-hidden="true" />
          </div>
          <div>
            <h2 id="conta-google-titulo" className="text-white font-bold text-base leading-tight">{t("contaGoogle.profile.title")}</h2>
            <p className="text-white/40 text-xs mt-0.5">{t("contaGoogle.profile.subtitle")}</p>
          </div>
        </div>
      </div>
      <div className="p-6 space-y-4">{children}</div>
    </section>
  );
}

export function ContaGoogleNoPerfil() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const busca = useSearch();
  const [caminho, navegar] = useLocation();
  const utils = trpc.useUtils();
  const [confirmando, setConfirmando] = useState(false);
  const [pedindoSenha, setPedindoSenha] = useState(false);
  const [senha, setSenha] = useState("");
  const [recusaAqui] = useState(() => googleRecusaEntrarAqui(window.navigator.userAgent));
  const estado = trpc.contaGoogle.estado.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });
  const entrarDeNovo = trpc.auth.login.useMutation();

  // A volta da Google: um aviso só, e o parâmetro sai da URL. O "entre de
  // novo" abre o pedido da senha.
  const avisado = useRef(false);
  useEffect(() => {
    const resultado = lerResultadoDaContaGoogle(busca);
    if (!resultado || avisado.current) return;
    avisado.current = true;
    if (resultado === "entre-de-novo") setPedindoSenha(true);
    else {
      const aviso = avisoDaContaGoogle(t, resultado);
      if (aviso.tipo === "error") toast.error(aviso.texto, { duration: 10000 });
      else toast[aviso.tipo](aviso.texto);
    }
    if (resultado === "ligada") void utils.contaGoogle.estado.invalidate();
    navegar(`${caminho}${buscaSemOResultado(busca)}`, { replace: true });
  }, [busca, caminho, navegar, t, utils]);

  const desligar = trpc.contaGoogle.desligar.useMutation({
    onSuccess: () => {
      setConfirmando(false);
      toast.success(t("contaGoogle.profile.unlinked"));
      void utils.contaGoogle.estado.invalidate();
    },
    onError: erro => toast.error(mensagemDoErroDaContaGoogle(t, erro), { duration: 10000 }),
  });

  const formatarData = (quando: number) => {
    try {
      return new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(new Date(quando));
    } catch {
      return new Date(quando).toLocaleDateString();
    }
  };

  if (estado.isLoading) return null;
  if (estado.isError) {
    return <Moldura><ErroDeConsulta erro={estado.error} aoTentarDeNovo={() => void estado.refetch()} /></Moldura>;
  }
  const dados = estado.data;
  if (!dados || (!dados.disponivel && !dados.ligada)) return null;

  const origem = dados.disponivel ? dados.origem : null;
  const hostCerto = origem ? hostDaOrigem(origem) : null;
  const noEnderecoCerto = hostCerto !== null && window.location.host.toLowerCase() === hostCerto;
  const podeLigar = Boolean(origem) && !dados.ligada;
  const enderecoDeLigar = origem ? enderecoDoBotaoDoGoogle(origem, "ligar") : null;

  /** A senha confirmada abre uma sessão nova (com o bloqueio por tentativas do login), e a ida recomeça. */
  const confirmarSenhaELigar = async (evento: React.FormEvent) => {
    evento.preventDefault();
    if (!user?.email || !senha || entrarDeNovo.isPending || !enderecoDeLigar) return;
    try {
      await entrarDeNovo.mutateAsync({ email: user.email, password: senha });
    } catch (erro) {
      // A frase do servidor vem em português e não vai para a tela.
      const senhaErrada = (erro as { data?: { code?: string } } | null)?.data?.code === "UNAUTHORIZED";
      toast.error(senhaErrada ? t("contaGoogle.profile.wrongPassword") : mensagemDeErroParaTela(erro, t));
      return;
    }
    window.location.href = enderecoDeLigar;
  };

  return (
    <Moldura>
      {dados.ligada ? (
        <div className="space-y-1">
          <p className="text-sm text-white/80 break-words">
            {dados.email ? t("contaGoogle.profile.linkedAs", { email: dados.email }) : t("contaGoogle.profile.linked")}
          </p>
          <p className="text-xs text-white/50">{t("contaGoogle.profile.linkedSince", { date: formatarData(dados.desde) })}</p>
        </div>
      ) : (
        <p className="text-sm text-white/60">{t("contaGoogle.profile.notLinked")}</p>
      )}

      <p className="text-xs leading-relaxed text-white/40">{t("contaGoogle.privacyNote")}</p>

      {podeLigar && recusaAqui && hostCerto && (
        <p className="flex gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-3 text-xs text-white/60">
          <Smartphone size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          {t("contaGoogle.profile.inApp", { address: hostCerto })}
        </p>
      )}

      {podeLigar && !recusaAqui && !noEnderecoCerto && hostCerto && origem && (
        <div className="space-y-2 rounded-lg border border-white/10 bg-white/[0.03] p-3">
          <p className="text-xs text-white/60">{t("contaGoogle.profile.wrongAddress", { address: hostCerto })}</p>
          <a href={`${origem}/profile`} className={CLASSE_SECUNDARIA}>
            <ExternalLink size={14} aria-hidden="true" /> {t("contaGoogle.profile.openAddress", { address: hostCerto })}
          </a>
        </div>
      )}

      {podeLigar && pedindoSenha && !recusaAqui && noEnderecoCerto && (
        <form onSubmit={evento => void confirmarSenhaELigar(evento)} className="space-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-sm text-white/80">{t("contaGoogle.result.signInAgain")}</p>
          <label className="block space-y-1">
            <span className="block text-xs text-white/60">{t("contaGoogle.profile.passwordLabel")}</span>
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={senha}
              onChange={evento => setSenha(evento.target.value)}
              className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={!senha || entrarDeNovo.isPending} className={CLASSE_PRINCIPAL}>
              {t("contaGoogle.profile.reauthConfirm")}
            </button>
            <button type="button" onClick={() => { setPedindoSenha(false); setSenha(""); }} className={CLASSE_SECUNDARIA}>
              {t("contaGoogle.profile.cancel")}
            </button>
          </div>
        </form>
      )}

      <div className="flex flex-wrap gap-2">
        {podeLigar && !pedindoSenha && !recusaAqui && noEnderecoCerto && enderecoDeLigar && (
          <a href={enderecoDeLigar} className={CLASSE_PRINCIPAL}>
            <Link2 size={15} aria-hidden="true" /> {t("contaGoogle.profile.link")}
          </a>
        )}
        {dados.ligada && !confirmando && (
          <button type="button" onClick={() => setConfirmando(true)} disabled={desligar.isPending} className={CLASSE_SECUNDARIA}>
            <Unplug size={15} aria-hidden="true" /> {t("contaGoogle.profile.unlink")}
          </button>
        )}
      </div>

      {dados.ligada && confirmando && (
        <div className="space-y-2 rounded-xl border border-red-400/25 bg-red-500/[0.06] p-3">
          <p id="conta-google-desligar" className="text-sm text-red-100/90">{t("contaGoogle.profile.unlinkConfirm")}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={desligar.isPending} onClick={() => desligar.mutate()}
              className="inline-flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-bold text-white hover:bg-red-400 disabled:opacity-50">
              {desligar.isPending ? t("contaGoogle.profile.unlinking") : t("contaGoogle.profile.unlinkYes")}
            </button>
            {/* Manter, a saída segura, recebe o foco, e a pergunta vai junto no anúncio. */}
            <button type="button" autoFocus aria-describedby="conta-google-desligar" onClick={() => setConfirmando(false)}
              className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/65 hover:bg-white/5">
              {t("contaGoogle.profile.unlinkNo")}
            </button>
          </div>
        </div>
      )}
    </Moldura>
  );
}
