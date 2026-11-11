import { useState } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, EyeOff, Lock, Mail, User, ArrowRight, Shield, CheckCircle2, Sparkles } from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { LOGIN_COM_FORMULARIO } from "@/lib/caminho-de-volta";

function PasswordStrength({ password, t }: { password: string; t: (key: string) => string }) {
  const checks = [
    { label: t("auth.pwd8chars"), ok: password.length >= 8 },
    { label: t("auth.pwdUppercase"), ok: /[A-Z]/.test(password) },
    { label: t("auth.pwdNumber"), ok: /[0-9]/.test(password) },
    { label: t("auth.pwdSpecial"), ok: /[^A-Za-z0-9]/.test(password) },
  ];
  const score = checks.filter((c) => c.ok).length;
  const colors = ["bg-red-500", "bg-orange-500", "bg-yellow-500", "bg-green-500"];
  const strengthLabels = [t("auth.pwdWeak"), t("auth.pwdFair"), t("auth.pwdGood"), t("auth.pwdStrong")];

  if (!password) return null;

  return (
    <div className="mt-2 space-y-2">
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full transition-all duration-300 ${
              i < score ? colors[score - 1] : "bg-white/10"
            }`}
          />
        ))}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/60">
          {t("auth.strength")}:{" "}
          <span className={score >= 3 ? "text-green-400" : "text-amber-400"}>
            {strengthLabels[score - 1] || t("auth.pwdVeryWeak")}
          </span>
        </span>
        <div className="flex gap-2">
          {checks.map((c) => (
            <span
              key={c.label}
              className={`text-xs transition-colors ${c.ok ? "text-green-400" : "text-white/50"}`}
              title={c.label}
            >
              <CheckCircle2 className="w-3 h-3 inline" />
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Register() {
  const { t } = useTranslation();
  const [, navigate] = useLocation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const registerMutation = trpc.auth.register.useMutation({
    onSuccess: () => {
      toast.success(t("auth.accountCreated"), {
        description: t("auth.nowLogin"),
      });
      navigate(LOGIN_COM_FORMULARIO);
    },
    onError: (err) => {
      toast.error(t("auth.registerError"), {
        description: err.message,
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !email || !password || !confirmPassword) {
      toast.error(t("auth.fillAllFields"));
      return;
    }
    if (password.length < 8) {
      toast.error(t("auth.passwordTooShort"));
      return;
    }
    if (password !== confirmPassword) {
      toast.error(t("auth.passwordMismatch"));
      return;
    }
    registerMutation.mutate({ name, email, password });
  };

  const passwordsMatch = confirmPassword.length > 0 && password === confirmPassword;
  const passwordsMismatch = confirmPassword.length > 0 && password !== confirmPassword;

  return (
    <div className="min-h-screen bg-transparent flex items-center justify-center px-4 py-8 relative overflow-hidden">
      {/* Background decorativo */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/3 right-1/4 w-96 h-96 bg-amber-500/5 rounded-full blur-3xl" />
        <div className="absolute bottom-1/3 left-1/4 w-96 h-96 bg-rose-500/5 rounded-full blur-3xl" />
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
            <p className="text-slate-400 text-sm">{t("auth.registerTagline")}</p>
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
            <h1 className="text-2xl font-bold text-white">{t("auth.registerTitle")}</h1>
            <p className="text-slate-400 mt-1 text-sm">
              {t("auth.hasAccount")}{" "}
              <Link href={LOGIN_COM_FORMULARIO}>
                <span className="text-amber-400 hover:text-amber-300 cursor-pointer transition-colors font-medium">
                  {t("auth.loginLink")} →
                </span>
              </Link>
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Nome */}
            <div className="space-y-2">
              <Label htmlFor="name" className="text-slate-300 text-sm font-medium">
                {t("auth.name")}
              </Label>
              <div className="relative group">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/60 group-focus-within:text-amber-400 transition-colors" />
                <Input
                  id="name"
                  type="text"
                  placeholder={t("auth.namePlaceholder")}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="pl-10 bg-white/5 border-white/10 text-white placeholder:text-white/50 focus:border-amber-400/60 focus:ring-amber-400/20 h-11 transition-all"
                  autoComplete="name"
                  disabled={registerMutation.isPending}
                />
              </div>
            </div>

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
                  disabled={registerMutation.isPending}
                />
              </div>
            </div>

            {/* Senha */}
            <div className="space-y-2">
              <Label htmlFor="password" className="text-slate-300 text-sm font-medium">
                {t("auth.password")}
              </Label>
              <div className="relative group">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/60 group-focus-within:text-amber-400 transition-colors" />
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder={t("auth.passwordPlaceholder")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-10 pr-10 bg-white/5 border-white/10 text-white placeholder:text-white/50 focus:border-amber-400/60 focus:ring-amber-400/20 h-11 transition-all"
                  autoComplete="new-password"
                  disabled={registerMutation.isPending}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/60 hover:text-slate-300 transition-colors"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <PasswordStrength password={password} t={t} />
            </div>

            {/* Confirmar Senha */}
            <div className="space-y-2">
              <Label htmlFor="confirmPassword" className="text-slate-300 text-sm font-medium">
                {t("auth.confirmPassword")}
              </Label>
              <div className="relative group">
                <Lock className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 transition-colors ${
                  passwordsMatch ? "text-green-400" : passwordsMismatch ? "text-red-400" : "text-white/60 group-focus-within:text-amber-400"
                }`} />
                <Input
                  id="confirmPassword"
                  type={showConfirm ? "text" : "password"}
                  placeholder={t("auth.confirmPasswordPlaceholder")}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className={`pl-10 pr-10 bg-white/5 text-white placeholder:text-white/50 h-11 transition-all ${
                    passwordsMatch
                      ? "border-green-500/50 focus:border-green-400/60"
                      : passwordsMismatch
                      ? "border-red-500/50 focus:border-red-400/60"
                      : "border-white/10 focus:border-amber-400/60 focus:ring-amber-400/20"
                  }`}
                  autoComplete="new-password"
                  disabled={registerMutation.isPending}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm(!showConfirm)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/60 hover:text-slate-300 transition-colors"
                >
                  {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {passwordsMatch && (
                <p className="text-xs text-green-400 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> {t("auth.passwordsMatch")}
                </p>
              )}
              {passwordsMismatch && (
                <p className="text-xs text-red-400">{t("auth.passwordMismatch")}</p>
              )}
            </div>

            {/* Termos.

                Os dois nomes eram <span> com cor de link e cursor-pointer: pareciam
                clicáveis e não levavam a lugar nenhum. Numa frase que diz "ao criar
                sua conta, você concorda com", isso é pior do que texto simples — a
                pessoa tenta ler o que está aceitando e o clique morre. Agora são
                links de verdade para as duas páginas públicas, que existem e estão
                no ar (/termos mostra o Termo Geral vigente desde 16/09).

                Abrem em aba nova de propósito: ler o termo no meio do cadastro não
                pode custar o formulário já preenchido. */}
            <p className="text-xs text-white/50 leading-relaxed">
              {t("auth.termsPrefix")}{" "}
              <a href="/termos" target="_blank" rel="noopener noreferrer"
                className="text-amber-500/70 hover:text-amber-400 underline underline-offset-2 transition-colors">
                {t("auth.terms")}
              </a>{" "}
              {t("auth.termsAnd")}{" "}
              <a href="/privacidade" target="_blank" rel="noopener noreferrer"
                className="text-amber-500/70 hover:text-amber-400 underline underline-offset-2 transition-colors">
                {t("auth.privacy")}
              </a>
              . {t("auth.dataProtected")}
            </p>

            {/* Botão */}
            <Button
              type="submit"
              disabled={registerMutation.isPending || passwordsMismatch}
              className="w-full h-11 bg-amber-500 hover:bg-amber-400 text-black font-semibold text-sm transition-all duration-150 active:scale-[0.97] shadow-lg shadow-amber-500/20 disabled:opacity-50"
            >
              {registerMutation.isPending ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                  {t("auth.creating")}
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  {t("auth.registerButton")}
                  <ArrowRight className="w-4 h-4" />
                </span>
              )}
            </Button>
          </form>

          {/* Segurança */}
          <div className="mt-6 pt-5 border-t border-white/5 flex items-center justify-center gap-2 text-xs text-white/50">
            <Shield className="w-3.5 h-3.5 text-amber-500/50" />
            <span>{t("auth.registerSecurityNote")}</span>
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
