import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, EyeOff, Lock, Mail, ArrowRight, Shield, Sparkles } from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { destinoDepoisDoLogin, PARAMETRO_ENTRAR } from "@/lib/caminho-de-volta";

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

  const loginMutation = trpc.auth.login.useMutation({
    onSuccess: (data) => {
      const firstName = (data.user.name?.split(" ")[0] || "").toUpperCase();
      // Quem acabou de se cadastrar e entra pela primeira vez não "volta":
      // o cadastro por concluir é o primeiro acesso, e é o mesmo sinal que
      // decide o destino logo abaixo (reteste v4, item 8).
      const saudacao = data.user.onboardingCompleted ? "auth.welcomeBack" : "auth.welcomeFirst";
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
        window.location.href = destinoDepoisDoLogin(Boolean(data.user.onboardingCompleted), window.location.search);
      }, 600);
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
                  autoComplete="email"
                  disabled={loginMutation.isPending}
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
                  autoComplete="current-password"
                  disabled={loginMutation.isPending}
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
              disabled={loginMutation.isPending}
              className="w-full h-11 bg-amber-500 hover:bg-amber-400 text-black font-semibold text-sm transition-all duration-150 active:scale-[0.97] shadow-lg shadow-amber-500/20"
            >
              {loginMutation.isPending ? (
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
