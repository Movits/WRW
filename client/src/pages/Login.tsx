import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, EyeOff, Lock, Mail, ArrowRight, Shield, Sparkles, Fingerprint } from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { destinoDepoisDoLogin, PARAMETRO_ENTRAR } from "@/lib/caminho-de-volta";
import {
  apelidoSugerido,
  avisarChaveDesconhecida,
  cadastrarAChave,
  cancelarPedidoDaChave,
  codigoDoErroDaChave,
  conviteRespondidoNoAparelho,
  ehCancelamento,
  ehChaveJaCadastrada,
  entrarComAChave,
  marcarConviteNoAparelho,
  mensagemDoErroDaChave,
  podeAtivarNesteAparelho,
  podeUsarChavesAqui,
  sugestaoNoCampoDisponivel,
} from "@/lib/chaves-de-acesso";
import { ERRO_DA_CHAVE_DE_ACESSO } from "@shared/chaves-de-acesso";

/** O que o login (por senha ou por chave) devolve e a tela usa. */
type QuemEntrou = { name?: string | null; onboardingCompleted?: boolean | null };

/** Quantas vezes a espera no campo se refaz depois de uma entrada recusada, antes de parar. */
const ESPERAS_NO_CAMPO_MAX = 3;

export default function Login() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const { user, loading } = useAuth();
  const [, navigate] = useLocation();

  // Quem já está logada não digita e-mail e senha de novo (pedido do Roberto,
  // 10/11/2026): com a sessão viva, o /login segue direto para o destino que
  // o login daria. Sem sessão, ou sem dar para saber (banco fora do ar), o
  // formulário aparece como sempre.
  //
  // `?entrar` pede o formulário mesmo assim: é como o cadastro e a redefinição
  // de senha mandam para cá ("agora faça login"). Num aparelho com OUTRA conta
  // logada, seguir sozinho levaria quem acabou de criar a conta para dentro da
  // conta alheia.
  const pedeFormulario = new URLSearchParams(window.location.search).has(PARAMETRO_ENTRAR);
  useEffect(() => {
    if (!user || pedeFormulario) return;
    navigate(destinoDepoisDoLogin(Boolean(user.onboardingCompleted), window.location.search), { replace: true });
  }, [user, navigate, pedeFormulario]);

  // ---- Chaves de acesso (A7): Face ID, digital ou o bloqueio de tela ----
  // O jeito principal é a sugestão no próprio campo: ao tocar no e-mail ou na
  // senha, o navegador oferece a chave deste aparelho, o que só acontece depois
  // do primeiro login com o convite aceito. O link "Entrar com Face ID ou
  // digital" é a reserva do navegador que não sugere no campo. Nada disso
  // aparece sem a configuração no servidor (o `estado`), no endereço errado (o
  // .onrender.com) ou na casca das lojas, até a M1.
  const [podeUsarChaves] = useState(() => podeUsarChavesAqui(window.navigator.userAgent));
  const estadoDasChaves = trpc.chavesDeAcesso.estado.useQuery(undefined, {
    enabled: podeUsarChaves,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const chaves = podeUsarChaves && estadoDasChaves.data?.disponivel ? estadoDasChaves.data : null;
  const [sugestaoNoCampo, setSugestaoNoCampo] = useState<boolean | null>(null);
  const [autenticadorProprio, setAutenticadorProprio] = useState(false);
  useEffect(() => {
    if (!podeUsarChaves) return;
    let ativo = true;
    void sugestaoNoCampoDisponivel().then(sim => ativo && setSugestaoNoCampo(sim));
    void podeAtivarNesteAparelho().then(sim => ativo && setAutenticadorProprio(sim));
    return () => { ativo = false; };
  }, [podeUsarChaves]);

  const opcoesDeEntrada = trpc.chavesDeAcesso.opcoesDeEntrada.useMutation();
  const entrarComChave = trpc.chavesDeAcesso.entrar.useMutation();
  const opcoesDeCadastro = trpc.chavesDeAcesso.opcoesDeCadastro.useMutation();
  const cadastrar = trpc.chavesDeAcesso.cadastrar.useMutation();
  const [entrandoComChave, setEntrandoComChave] = useState(false);
  // Depois da senha certa, o convite para ativar a chave neste aparelho, antes de seguir.
  const [convite, setConvite] = useState<QuemEntrou | null>(null);
  const [ativando, setAtivando] = useState(false);
  const saindo = useRef(false);

  /** Boas-vindas e a ida ao destino, como sempre foi depois do login. */
  const seguir = (quem: QuemEntrou) => {
    saindo.current = true;
    cancelarPedidoDaChave();
    const firstName = (quem.name?.split(" ")[0] || "").toUpperCase();
    // Quem acabou de se cadastrar e entra pela primeira vez não "volta":
    // o cadastro por concluir é o primeiro acesso, e é o mesmo sinal que
    // decide o destino logo abaixo (reteste v4, item 8).
    const saudacao = quem.onboardingCompleted ? "auth.welcomeBack" : "auth.welcomeFirst";
    toast.success(t(saudacao, { name: firstName }), {
      description: t("auth.redirecting"),
    });
    // Usar window.location.href para garantir que o cookie de sessão
    // já está definido antes de carregar a página protegida.
    // navigate() (client-side) pode carregar a página antes do cookie
    // ser processado, causando loop de login duplo.
    // Cadastro por concluir vai ao /onboarding; quem já tem cadastro volta
    // à tela que pediu (?voltar= seguro) ou cai no gravador, a primeira tela
    // do app a pedido da cliente (20/10/2026).
    setTimeout(() => {
      window.location.href = destinoDepoisDoLogin(Boolean(quem.onboardingCompleted), window.location.search);
    }, 600);
  };

  /** Erro de uma entrada com chave: cancelar não é erro; a chave que não vale mais sai das sugestões do aparelho. */
  const avisarErroDaEntrada = (erro: unknown, credencialId?: string) => {
    if (ehCancelamento(erro)) return;
    if (codigoDoErroDaChave(erro) === ERRO_DA_CHAVE_DE_ACESSO.desconhecida && chaves && credencialId) {
      void avisarChaveDesconhecida(chaves.rpId, credencialId);
    }
    toast.error(mensagemDoErroDaChave(erro, t));
  };

  // A espera no campo: as opções ao abrir e o pedido ao navegador, que só
  // responde quando a pessoa escolhe a chave na sugestão. Sair da tela (ou
  // seguir por outro caminho) cancela a espera. Uma entrada recusada (chave
  // removida, por exemplo) refaz a espera, até ESPERAS_NO_CAMPO_MAX vezes.
  const [esperaNoCampo, setEsperaNoCampo] = useState(0);
  const mostrandoFormulario = pedeFormulario || (!loading && !user);
  useEffect(() => {
    if (!chaves || sugestaoNoCampo !== true || !mostrandoFormulario || convite) return;
    if (esperaNoCampo >= ESPERAS_NO_CAMPO_MAX) return;
    let ativo = true;
    (async () => {
      let opcoes;
      try {
        opcoes = await opcoesDeEntrada.mutateAsync();
      } catch {
        // Sem as opções (muitas tentativas, servidor fora do ar), o login por
        // senha segue igual, e não há sugestão no campo nesta visita.
        return;
      }
      if (!ativo) return;
      let resposta;
      try {
        resposta = await entrarComAChave(opcoes, { autofill: true });
      } catch (erro) {
        // Cancelada (a tela saiu, outro pedido tomou o lugar) ou o navegador recusou: em silêncio.
        if (ativo && !ehCancelamento(erro)) avisarErroDaEntrada(erro);
        return;
      }
      if (!ativo) return;
      setEntrandoComChave(true);
      try {
        const dados = await entrarComChave.mutateAsync({ resposta });
        seguir(dados.user);
      } catch (erro) {
        setEntrandoComChave(false);
        avisarErroDaEntrada(erro, resposta.id);
        if (ativo && !saindo.current) setEsperaNoCampo(n => n + 1);
      }
    })();
    return () => {
      ativo = false;
      if (!saindo.current) cancelarPedidoDaChave();
    };
    // As mutações do tRPC mudam de identidade a cada render; a espera só se
    // refaz quando muda o que decide se ela existe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chaves?.rpId, sugestaoNoCampo, mostrandoFormulario, convite, esperaNoCampo]);

  /** O link de reserva: o pedido direto ao aparelho, no navegador que não sugere no campo. */
  const entrarPeloLink = async () => {
    if (!chaves || entrandoComChave) return;
    setEntrandoComChave(true);
    let credencialId: string | undefined;
    try {
      const opcoes = await opcoesDeEntrada.mutateAsync();
      const resposta = await entrarComAChave(opcoes);
      credencialId = resposta.id;
      const dados = await entrarComChave.mutateAsync({ resposta });
      seguir(dados.user);
    } catch (erro) {
      setEntrandoComChave(false);
      avisarErroDaEntrada(erro, credencialId);
    }
  };

  /** O convite cabe: a função existe aqui, o aparelho tem autenticador próprio e ainda não respondeu. */
  const conviteCabe = () => Boolean(chaves) && autenticadorProprio && !conviteRespondidoNoAparelho();

  const ativarNesteAparelho = async () => {
    if (!convite || ativando) return;
    setAtivando(true);
    try {
      const opcoes = await opcoesDeCadastro.mutateAsync();
      const resposta = await cadastrarAChave(opcoes);
      await cadastrar.mutateAsync({ resposta, apelido: apelidoSugerido(window.navigator.userAgent) });
      marcarConviteNoAparelho("ativada");
      toast.success(t("chavesDeAcesso.toast.activated"));
      seguir(convite);
    } catch (erro) {
      setAtivando(false);
      // Fechou o pedido do aparelho: o convite fica, para tentar de novo ou dizer "Agora não".
      if (ehCancelamento(erro)) return;
      toast.error(mensagemDoErroDaChave(erro, t));
      // O aparelho já tem a chave desta conta: está ativada, e o convite não volta.
      if (ehChaveJaCadastrada(erro)) marcarConviteNoAparelho("ativada");
      // Erro no convite nunca prende a pessoa: segue para o destino.
      seguir(convite);
    }
  };

  const agoraNao = () => {
    if (!convite || ativando) return;
    marcarConviteNoAparelho("recusado");
    seguir(convite);
  };

  const loginMutation = trpc.auth.login.useMutation({
    onSuccess: (data) => {
      // A senha certa: antes de seguir, o convite para entrar com a chave
      // deste aparelho da próxima vez, quando ele cabe. Ele vem aqui, e não
      // depois, porque cadastrar pede entrada recente (10 minutos).
      if (conviteCabe()) {
        cancelarPedidoDaChave();
        setConvite(data.user);
        return;
      }
      seguir(data.user);
    },
    onError: (err) => {
      toast.error(t("auth.loginError"), {
        description: err.message,
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      toast.error(t("auth.fillAllFields"));
      return;
    }
    loginMutation.mutate({ email, password });
  };

  // Enquanto confere a sessão, e no instante antes de seguir adiante, não pisca
  // o formulário para quem não vai precisar dele.
  if (!pedeFormulario && (loading || user)) return null;

  const ocupado = loginMutation.isPending || entrandoComChave;

  return (
    <div className="min-h-screen bg-transparent flex items-center justify-center px-4 relative overflow-hidden">
      {/* Background decorativo */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-amber-500/5 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-rose-500/5 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-amber-500/3 rounded-full blur-3xl" />
        <div
          className="absolute inset-0 opacity-[0.025]"
          style={{
            backgroundImage: `radial-gradient(circle at 1px 1px, rgba(255,255,255,0.4) 1px, transparent 0)`,
            backgroundSize: "40px 40px",
          }}
        />
      </div>

      <div className="w-full max-w-md relative z-10">
        {/* Logo */}
        <div className="text-center mb-8" style={{ animation: "fadeInUp 0.4s ease-out both" }}>
          <Link href="/">
            <BrandLogo variante="destaque" className="w-56 max-w-[70%] mx-auto cursor-pointer" />
          </Link>
          <div className="flex items-center justify-center gap-1.5 mt-2">
            <Sparkles className="w-3.5 h-3.5 text-amber-400/60" />
            <p className="text-slate-400 text-sm">{t("auth.platformTagline")}</p>
            <Sparkles className="w-3.5 h-3.5 text-amber-400/60" />
          </div>
        </div>

        {/* Card */}
        <div
          className="rounded-2xl border border-white/10 p-8 backdrop-blur-sm"
          style={{
            background: "linear-gradient(135deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%)",
            animation: "fadeInUp 0.4s ease-out 0.1s both",
            boxShadow: "0 25px 50px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)",
          }}
        >
          {convite ? (
            <section aria-labelledby="convite-da-chave-titulo" className="space-y-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
                  <Fingerprint className="w-5 h-5" aria-hidden="true" />
                </div>
                <h1 id="convite-da-chave-titulo" className="text-xl font-bold text-white leading-tight">
                  {t("chavesDeAcesso.invite.title")}
                </h1>
              </div>
              <p className="text-slate-300 text-sm leading-relaxed">{t("chavesDeAcesso.invite.text")}</p>
              <p className="text-white/50 text-xs leading-relaxed">{t("chavesDeAcesso.privacyNote")}</p>
              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  autoFocus
                  onClick={() => void ativarNesteAparelho()}
                  disabled={ativando}
                  className="w-full h-11 bg-amber-500 hover:bg-amber-400 text-black font-semibold text-sm"
                >
                  {ativando ? t("chavesDeAcesso.invite.activating") : t("chavesDeAcesso.invite.activate")}
                </Button>
                <button
                  type="button"
                  onClick={agoraNao}
                  disabled={ativando}
                  className="w-full h-11 rounded-md border border-white/15 text-sm text-white/75 hover:bg-white/5 disabled:opacity-50"
                >
                  {t("chavesDeAcesso.invite.notNow")}
                </button>
              </div>
            </section>
          ) : (
            <>
              <div className="mb-6">
                <h1 className="text-2xl font-bold text-white">{t("auth.loginTitle")}</h1>
                <p className="text-slate-400 mt-1 text-sm">
                  {t("auth.noAccount")}{" "}
                  <Link href="/register">
                    <span className="text-amber-400 hover:text-amber-300 cursor-pointer transition-colors font-medium">
                      {t("auth.createFree")} →
                    </span>
                  </Link>
                </p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-5">
                {/* Email */}
                <div className="space-y-2">
                  <Label htmlFor="email" className="text-slate-300 text-sm font-medium">
                    {t("auth.email")}
                  </Label>
                  <div className="relative group">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/60 group-focus-within:text-amber-400 transition-colors" />
                    <Input
                      id="email"
                      type="email"
                      placeholder={t("auth.emailPlaceholder")}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="pl-10 bg-white/5 border-white/10 text-white placeholder:text-white/50 focus:border-amber-400/60 focus:ring-amber-400/20 h-11 transition-all"
                      // "webauthn": o navegador sugere a chave deste aparelho ao tocar no campo.
                      autoComplete="email webauthn"
                      disabled={ocupado}
                    />
                  </div>
                </div>

                {/* Senha */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="password" className="text-slate-300 text-sm font-medium">
                      {t("auth.password")}
                    </Label>
                    <Link href="/forgot-password">
                      <span className="text-xs text-white/60 hover:text-amber-400 cursor-pointer transition-colors">
                        {t("auth.forgotPassword")}
                      </span>
                    </Link>
                  </div>
                  <div className="relative group">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/60 group-focus-within:text-amber-400 transition-colors" />
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="pl-10 pr-10 bg-white/5 border-white/10 text-white placeholder:text-white/50 focus:border-amber-400/60 focus:ring-amber-400/20 h-11 transition-all"
                      autoComplete="current-password webauthn"
                      disabled={ocupado}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-white/60 hover:text-slate-300 transition-colors"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Botão */}
                <Button
                  type="submit"
                  disabled={ocupado}
                  className="w-full h-11 bg-amber-500 hover:bg-amber-400 text-black font-semibold text-sm transition-all duration-150 active:scale-[0.97] shadow-lg shadow-amber-500/20"
                >
                  {ocupado ? (
                    <span className="flex items-center gap-2">
                      <span className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                      {t("auth.loggingIn")}
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      {t("auth.loginButton")}
                      <ArrowRight className="w-4 h-4" />
                    </span>
                  )}
                </Button>
              </form>

              {/* Reserva: o navegador que não sugere a chave no campo. */}
              {chaves && sugestaoNoCampo === false && (
                <button
                  type="button"
                  onClick={() => void entrarPeloLink()}
                  disabled={ocupado}
                  className="mt-4 w-full flex items-center justify-center gap-2 text-sm text-white/70 hover:text-amber-400 transition-colors disabled:opacity-50"
                >
                  <Fingerprint className="w-4 h-4" aria-hidden="true" />
                  {t("chavesDeAcesso.login.fallbackButton")}
                </button>
              )}
            </>
          )}

          {/* Segurança */}
          <div className="mt-6 pt-5 border-t border-white/5 flex items-center justify-center gap-2 text-xs text-white/50">
            <Shield className="w-3.5 h-3.5 text-amber-500/50" />
            <span>{t("auth.securityNote")}</span>
          </div>
        </div>

        {/* Link de volta */}
        <p className="text-center mt-6 text-xs text-white/50">
          <Link href="/">
            <span className="hover:text-slate-400 cursor-pointer transition-colors">← {t("auth.backToHome")}</span>
          </Link>
        </p>
      </div>
    </div>
  );
}
