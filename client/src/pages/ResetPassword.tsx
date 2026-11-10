import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CheckCircle2, KeyRound, Loader2, Eye, EyeOff, AlertTriangle } from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";

export default function ResetPassword() {
  const { t } = useTranslation();
  const [, setLocation] = useLocation();
  // Lido da URL já no primeiro render. Lido num efeito, o primeiro quadro pintava
  // o aviso de link inválido para quem abriu um link válido.
  const [token] = useState(() => new URLSearchParams(window.location.search).get("token") ?? "");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  // Depois da troca da senha, vai ao login em 3 segundos. Sair da tela antes
  // cancela a ida: sem isso, o timer puxava a pessoa de volta de outra tela.
  useEffect(() => {
    if (!success) return;
    const timer = window.setTimeout(() => setLocation("/login"), 3000);
    return () => window.clearTimeout(timer);
  }, [success]);

  const resetMutation = trpc.auth.resetPassword.useMutation({
    onSuccess: () => {
      setSuccess(true);
      setError("");
    },
    onError: (err) => {
      // Pelo código, porque o servidor escreve em português. BAD_REQUEST nesta
      // rota é o link: o token fora do formato (zod) ou o "Token inválido ou
      // expirado" do servidor (a senha curta é barrada antes de enviar, logo
      // abaixo). TOO_MANY_REQUESTS com path (o tRPC só o põe no erro lançado
      // dentro da rota) é a fila do bcrypt cheia; sem path, é o limite geral da
      // API, montado antes do tRPC, e a frase dele segue pelo tradutor comum,
      // como o resto (banco fora do ar, rede).
      const codigo = err.data?.code;
      setError(
        codigo === "BAD_REQUEST" ? t("auth.invalidTokenDesc")
          : codigo === "TOO_MANY_REQUESTS" && err.data?.path ? t("auth.tooManyRequests")
            : mensagemDeErroParaTela(err, t),
      );
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    // O minLength do campo não vale para valor posto por script ou por
    // gerenciador de senhas; sem esta conferência, a senha curta voltava como
    // BAD_REQUEST e a tela dizia que o link estava vencido.
    if (newPassword.length < 8) {
      setError(t("auth.passwordTooShort", "Mínimo 8 caracteres"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t("auth.passwordMismatch", "As senhas não coincidem."));
      return;
    }
    if (!token) {
      setError(t("auth.invalidToken", "Token inválido. Use o link enviado por e-mail."));
      return;
    }
    resetMutation.mutate({ token, newPassword });
  };

  if (!token) {
    return (
      <div className="min-h-screen bg-transparent flex items-center justify-center p-4">
        <Card className="w-full max-w-md border-border/50 shadow-2xl">
          <CardContent className="pt-8 text-center space-y-4">
            <div className="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
              <AlertTriangle className="w-6 h-6 text-destructive" />
            </div>
            <p className="font-semibold">{t("auth.invalidTokenTitle", "Link inválido")}</p>
            <p className="text-sm text-muted-foreground">
              {t("auth.invalidTokenDesc", "Este link de recuperação é inválido ou expirou. Solicite um novo.")}
            </p>
            <Link href="/forgot-password">
              <Button className="w-full bg-amber-500 hover:bg-amber-600 text-black font-semibold">
                {t("auth.requestNewLink", "Solicitar novo link")}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-transparent flex items-center justify-center p-4">
      {/* Background decorativo */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-amber-500/5 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-amber-600/5 rounded-full blur-3xl" />
      </div>

      <div className="w-full max-w-md relative z-10">
        {/* Logo */}
        <div className="text-center mb-8">
          <Link href="/">
            <BrandLogo variante="lockup" className="w-44 mx-auto cursor-pointer" />
          </Link>
        </div>

        <Card className="border-border/50 shadow-2xl bg-card/80 backdrop-blur-sm">
          <CardHeader className="text-center pb-4">
            <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center">
              <KeyRound className="w-6 h-6 text-amber-500" />
            </div>
            <CardTitle className="text-2xl font-bold">
              {t("auth.resetPasswordTitle", "Redefinir senha")}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t("auth.resetPasswordSubtitle", "Escolha uma nova senha segura para sua conta.")}
            </CardDescription>
          </CardHeader>

          <CardContent>
            {success ? (
              <div className="text-center space-y-4">
                <div className="mx-auto w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center">
                  <CheckCircle2 className="w-8 h-8 text-green-500" />
                </div>
                <div>
                  <p className="font-semibold text-foreground mb-1">
                    {t("auth.resetPasswordSuccessTitle", "Senha redefinida!")}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t("auth.resetPasswordSuccessDesc", "Sua senha foi atualizada com sucesso. Você será redirecionada para o login em instantes.")}
                  </p>
                </div>
                <Link href="/login">
                  <Button className="w-full bg-amber-500 hover:bg-amber-600 text-black font-semibold">
                    {t("auth.goToLogin", "Ir para o login")}
                  </Button>
                </Link>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <div className="space-y-2">
                  <Label htmlFor="newPassword">
                    {t("auth.newPassword", "Nova senha")}
                  </Label>
                  <div className="relative">
                    {/* new-password: o gerenciador de senhas sugere uma senha forte
                        nos dois campos. A tela não tem o e-mail (o link só traz o
                        token), então, ao guardar a senha, ele pode perguntar de
                        qual conta ela é. */}
                    {/* Só leitura durante o envio: a senha que o servidor grava é a
                        que está nos campos quando a tela diz "Senha redefinida!". */}
                    <Input
                      id="newPassword"
                      name="new-password"
                      autoComplete="new-password"
                      readOnly={resetMutation.isPending}
                      type={showPassword ? "text" : "password"}
                      placeholder={t("auth.passwordPlaceholder", "Mínimo 8 caracteres")}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                      minLength={8}
                      autoFocus
                      className="bg-background/50 pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">
                    {t("auth.confirmNewPassword", "Confirmar nova senha")}
                  </Label>
                  <div className="relative">
                    <Input
                      id="confirmPassword"
                      name="confirm-password"
                      autoComplete="new-password"
                      readOnly={resetMutation.isPending}
                      type={showConfirm ? "text" : "password"}
                      placeholder={t("auth.confirmNewPasswordPlaceholder", "Repita a nova senha")}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                      minLength={8}
                      className="bg-background/50 pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirm(!showConfirm)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Indicador de força da senha */}
                {newPassword.length > 0 && (
                  <div className="space-y-1">
                    <div className="flex gap-1">
                      {[1, 2, 3, 4].map((level) => {
                        const strength = Math.min(
                          Math.floor(newPassword.length / 4) +
                          (newPassword.match(/[A-Z]/) ? 1 : 0) +
                          (newPassword.match(/[0-9]/) ? 1 : 0) +
                          (newPassword.match(/[^A-Za-z0-9]/) ? 1 : 0),
                          4
                        );
                        return (
                          <div
                            key={level}
                            className={`h-1 flex-1 rounded-full transition-colors ${
                              level <= strength
                                ? strength <= 1 ? "bg-red-500"
                                  : strength <= 2 ? "bg-orange-500"
                                  : strength <= 3 ? "bg-yellow-500"
                                  : "bg-green-500"
                                : "bg-muted"
                            }`}
                          />
                        );
                      })}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {newPassword.length < 8
                        ? t("auth.passwordTooShort", "Mínimo 8 caracteres")
                        : t("auth.passwordStrengthHint", "Use letras maiúsculas, números e símbolos para uma senha mais forte")}
                    </p>
                  </div>
                )}

                <Button
                  type="submit"
                  className="w-full bg-amber-500 hover:bg-amber-600 text-black font-semibold"
                  disabled={resetMutation.isPending}
                >
                  {resetMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      {t("auth.saving", "Salvando...")}
                    </>
                  ) : (
                    t("auth.resetPasswordButton", "Redefinir senha")
                  )}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
