import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ArrowLeft, Inbox, Mail, Loader2 } from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { LOGIN_COM_FORMULARIO } from "@/lib/caminho-de-volta";

export default function ForgotPassword() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  // O e-mail que foi no pedido, e não o que está no campo: é ele que a tela
  // repete para a pessoa conferir.
  const [emailPedido, setEmailPedido] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const campoDoEmail = useRef<HTMLInputElement>(null);
  const tituloDoPedido = useRef<HTMLHeadingElement>(null);
  const voltouParaCorrigir = useRef(false);

  const forgotMutation = trpc.auth.forgotPassword.useMutation({
    onSuccess: (_dados, variaveis) => {
      setEmailPedido(variaveis.email.trim());
      setSent(true);
      setError("");
    },
    onError: (err) => {
      // Pelo código, porque o servidor escreve em português: BAD_REQUEST nesta
      // rota é só o formato do e-mail (o zod), que o navegador às vezes deixa
      // passar, como "nome@gmailcom", e cuja mensagem crua era JSON em inglês.
      // TOO_MANY_REQUESTS vem de dois lugares, e o path separa os dois, porque o
      // tRPC só o põe no erro lançado dentro da rota: com path, é o limite de
      // pedidos de recuperação por rede (até 15 minutos), e o aviso diz isso,
      // com a saída de trocar de conexão; sem path, é o limite geral da API,
      // montado antes do tRPC (segundos), cuja frase segue pelo tradutor comum,
      // como o resto (banco fora do ar, rede).
      const codigo = err.data?.code;
      setError(
        codigo === "BAD_REQUEST" ? t("auth.forgotPasswordInvalidEmail")
          : codigo === "TOO_MANY_REQUESTS" && err.data?.path ? t("auth.forgotPasswordTooManyRequests")
            : mensagemDeErroParaTela(err, t),
      );
    },
  });

  // Na ida, o formulário sai da tela junto com o que tinha o foco: o foco vai ao
  // título "Pedido recebido", e o leitor de tela o lê. Na volta, "Corrigir o
  // e-mail" devolve o texto digitado selecionado, pronto para ser trocado
  // (antes ele era apagado e a pessoa redigitava tudo).
  useEffect(() => {
    if (sent) {
      tituloDoPedido.current?.focus();
      return;
    }
    if (!voltouParaCorrigir.current) return;
    voltouParaCorrigir.current = false;
    campoDoEmail.current?.focus();
    campoDoEmail.current?.select();
  }, [sent]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    // O navegador já tira os espaços das pontas de um campo type="email"; o trim
    // garante o mesmo onde ele não tira.
    forgotMutation.mutate({ email: email.trim() });
  };

  const corrigirEmail = () => {
    voltouParaCorrigir.current = true;
    setSent(false);
  };

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
              <Mail className="w-6 h-6 text-amber-500" />
            </div>
            <CardTitle className="text-2xl font-bold">
              {t("auth.forgotPasswordTitle", "Esqueci minha senha")}
            </CardTitle>
            {!sent && (
              <CardDescription className="text-muted-foreground">
                {t("auth.forgotPasswordSubtitle", "Informe seu e-mail cadastrado para receber o link de redefinição.")}
              </CardDescription>
            )}
          </CardHeader>

          <CardContent>
            {sent ? (
              /* ---- ESTADO: pedido recebido ----
                 A tela é a mesma com conta e sem conta, porque a resposta de
                 auth.forgotPassword é a mesma nos dois casos (PR #90; o teste
                 server/auth.esqueci-senha-nao-enumera.test.ts prende o corpo da
                 resposta). Por isso a tela não afirma que um link saiu: diz que
                 o pedido chegou, repete o e-mail pedido para a pessoa conferir
                 e explica o que fazer se nada chegar. O "Link enviado!" em verde
                 fazia quem errou o e-mail esperar por algo que nunca viria
                 (relato da cliente, 20/10/2026).
                 Ressalva do servidor, anotada à parte junto com o login e o
                 cadastro: a resposta só é a mesma com FRONTEND_URL definida;
                 sem ela, o servidor falha só para conta existente. */
              <div className="space-y-5 text-center" role="status" aria-live="polite">
                <div className="mx-auto w-16 h-16 rounded-full bg-amber-500/10 flex items-center justify-center">
                  <Inbox className="w-8 h-8 text-amber-500" />
                </div>

                <div className="space-y-2">
                  {/* Sem moldura de foco no título, que não é um controle: a regra
                      global de :focus-visible (index.css) fica fora de camada e
                      vence a classe outline-none do Tailwind, então o estilo vai
                      inline. Com a moldura, quem enviava com Enter via o título
                      dentro de uma caixa, como um campo. */}
                  <h3 ref={tituloDoPedido} tabIndex={-1} style={{ outline: "none" }} className="text-lg font-semibold text-foreground">{t("auth.forgotPasswordCheckTitle")}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {t("auth.forgotPasswordCheckDesc")}
                  </p>
                  {/* Linha própria, e não dentro da frase: fica em destaque e
                      não embaralha a ordem das palavras em árabe e japonês. */}
                  <p dir="ltr" className="font-semibold text-foreground break-all" data-testid="email-digitado">
                    {emailPedido}
                  </p>
                </div>

                <div className="bg-muted/30 rounded-lg p-4 text-start space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t("auth.forgotPasswordInfoTitle")}</p>
                  <ul className="text-xs text-muted-foreground space-y-1">
                    <li>• {t("auth.forgotPasswordInfoExpiryBefore")}<strong className="text-foreground">{t("auth.forgotPasswordInfoExpiryStrong")}</strong></li>
                    <li>• {t("auth.forgotPasswordInfoOnceBefore")}<strong className="text-foreground">{t("auth.forgotPasswordInfoOnceStrong")}</strong></li>
                  </ul>
                </div>

                <div className="bg-muted/30 rounded-lg p-4 text-start space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t("auth.forgotPasswordNotArrivedTitle")}</p>
                  <ul className="text-xs text-muted-foreground space-y-1">
                    <li>• {t("auth.forgotPasswordNotArrivedTypo")}</li>
                    <li>• {t("auth.forgotPasswordNotArrivedSpam")}</li>
                    {/* Cada pedido novo invalida o link anterior (server/routers/auth.ts;
                        preso em server/auth.esqueci-senha-limite-por-conta.test.ts). */}
                    <li>• {t("auth.forgotPasswordNotArrivedWait")}</li>
                    <li>• {t("auth.forgotPasswordNotArrivedNoAccount")}</li>
                  </ul>
                </div>

                {/* Corrigir é o passo principal: o caso relatado é o de quem
                    digitou outro e-mail, e "Criar conta" em destaque a levaria
                    a abrir uma segunda conta (as participantes importadas da
                    planilha só ganham senha por esta tela). */}
                <div className="flex flex-col sm:flex-row gap-2 justify-center">
                  <Button size="sm" className="bg-amber-500 hover:bg-amber-600 text-black font-semibold" onClick={corrigirEmail}>
                    {t("auth.forgotPasswordFixEmail")}
                  </Button>
                  <Link href="/register">
                    <Button variant="outline" size="sm" className="w-full">
                      {t("auth.createFree")}
                    </Button>
                  </Link>
                </div>
              </div>
            ) : (
              /* ---- ESTADO: formulário ---- */
              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <div className="space-y-2">
                  <Label htmlFor="email">
                    {t("auth.email", "E-mail cadastrado")}
                  </Label>
                  {/* username: o gerenciador de senhas oferece o e-mail salvo do
                      login, e o celular não capitaliza nem corrige o endereço.
                      Só leitura durante o envio (o Login trava com disabled): o
                      e-mail que a tela repete é o que foi pedido. */}
                  <Input
                    ref={campoDoEmail}
                    readOnly={forgotMutation.isPending}
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="username"
                    inputMode="email"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder={t("auth.emailPlaceholder")}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoFocus
                    className="bg-background/50"
                  />
                </div>

                <Button
                  type="submit"
                  className="w-full bg-amber-500 hover:bg-amber-600 text-black font-semibold"
                  disabled={forgotMutation.isPending}
                >
                  {forgotMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      {t("auth.sending", "Enviando...")}
                    </>
                  ) : (
                    t("auth.forgotPasswordButton", "Enviar link de recuperação")
                  )}
                </Button>

                <p className="text-xs text-muted-foreground text-center">
                  {t("auth.forgotPasswordNote", "Se o e-mail estiver cadastrado, você receberá o link em instantes.")}
                </p>
              </form>
            )}

            <div className="mt-6 text-center">
              <Link href={LOGIN_COM_FORMULARIO}>
                <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground gap-2">
                  <ArrowLeft className="w-4 h-4" />
                  {t("auth.backToLogin", "Voltar para o login")}
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
