import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, LockKeyhole } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { MENSAGEM_BANCO_INDISPONIVEL, MENSAGEM_ERRO_DE_CONSULTA } from "@shared/const";
import { DIGITOS_DA_SENHA_DO_LINK, FORMATO_DA_SENHA_DO_LINK, normalizarSenhaDoLink } from "@shared/senha-do-link";

/**
 * A tela da senha do link aberto (H23, HN-57 do HiNoter): o link que a dona
 * protegeu pede os 6 dígitos antes de mostrar qualquer coisa da reunião (nem o
 * título vem do servidor). A senha certa grava o cookie da entrada, e a página
 * relê a reunião (`aoEntrar`).
 *
 * A senha errada e o link que não existe ou foi desligado dão a mesma
 * resposta: a tela não diz se o link existe. Muitas tentativas erradas pedem
 * espera, e a tela diz quanto falta. Os algarismos do teclado árabe, do hindi
 * e o de largura cheia do chinês e do japonês valem como 0-9, e espaço e hífen
 * ("123 456") saem antes de mandar.
 *
 * Os textos desta tela (meetings.openLink.password.*) esperam a revisão da
 * Cris, nos 10 idiomas.
 */

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/** "em 3 minutos", "dans 45 secondes": o plural e a ordem de cada idioma vêm do próprio navegador. */
export function quandoTentarDeNovo(segundos: number, idioma: string): string {
  const formato = new Intl.RelativeTimeFormat(idioma, { numeric: "always" });
  return segundos < 60 ? formato.format(Math.max(1, Math.ceil(segundos)), "second") : formato.format(Math.ceil(segundos / 60), "minute");
}

// A frase pelo código, como na tradução da página do link: mensagem de
// servidor que a tela não conhece não aparece crua a quem não tem conta.
function mensagemDoErro(t: TranslateFn, erro: unknown) {
  switch ((erro as { data?: { code?: string } } | null)?.data?.code) {
    case "BAD_REQUEST": return t("meetings.openLink.password.incomplete");
    case "TOO_MANY_REQUESTS": return t("assistenteTexto.muitosPedidos");
    case "INTERNAL_SERVER_ERROR": {
      // Só as duas frases do banco que a tela conhece (em pt-BR a tradução é
      // o próprio texto, por isso a comparação é com a constante).
      const mensagem = (erro as { message?: unknown } | null)?.message;
      return mensagem === MENSAGEM_BANCO_INDISPONIVEL || mensagem === MENSAGEM_ERRO_DE_CONSULTA
        ? mensagemDeErroParaTela(erro, t)
        : t("meetings.openLink.password.error");
    }
    default: return t("meetings.openLink.password.error");
  }
}

export function SenhaDoLinkAberto({ token, aoEntrar }: { token: string; aoEntrar: () => void }) {
  const { t, i18n } = useTranslation();
  const idDoTitulo = useId();
  const idDoCampo = useId();
  const idDoAviso = useId();
  const campo = useRef<HTMLInputElement>(null);
  const [senha, setSenha] = useState("");
  const [aviso, setAviso] = useState<string | null>(null);
  const entrar = trpc.reuniaoAberta.entrar.useMutation();

  function enviar(evento: React.FormEvent) {
    evento.preventDefault();
    if (entrar.isPending) return;
    const normalizada = normalizarSenhaDoLink(senha);
    if (!FORMATO_DA_SENHA_DO_LINK.test(normalizada)) {
      setAviso(t("meetings.openLink.password.incomplete"));
      campo.current?.focus();
      return;
    }
    setAviso(null);
    entrar.mutate({ token, senha: normalizada }, {
      onSuccess: resultado => {
        if (resultado.entrou) return aoEntrar();
        setSenha("");
        setAviso(resultado.motivo === "espera"
          ? t("meetings.openLink.password.wait", { quando: quandoTentarDeNovo(resultado.segundos, i18n.resolvedLanguage ?? i18n.language) })
          : t("meetings.openLink.password.wrong"));
        campo.current?.focus();
      },
      onError: erro => {
        setAviso(mensagemDoErro(t, erro));
        campo.current?.focus();
      },
    });
  }

  return <section aria-labelledby={idDoTitulo} className="w-full max-w-md rounded-2xl border border-white/10 bg-white/[0.035] p-5 sm:p-6">
    <h1 id={idDoTitulo} className="flex items-center gap-2 text-xl font-semibold">
      <LockKeyhole size={18} aria-hidden="true" className="shrink-0 text-amber-300"/>{t("meetings.openLink.password.title")}
    </h1>
    <p className="mt-2 text-sm text-white/65">{t("meetings.openLink.password.intro")}</p>
    <form onSubmit={enviar} noValidate className="mt-5 flex flex-col gap-3">
      <label htmlFor={idDoCampo} className="text-sm font-medium text-white/80">{t("meetings.openLink.password.label")}</label>
      {/* A senha é sempre da esquerda para a direita, também numa tela em árabe. */}
      <input id={idDoCampo} ref={campo} autoFocus value={senha} onChange={evento => setSenha(evento.target.value)}
        inputMode="numeric" autoComplete="off" spellCheck={false} dir="ltr" maxLength={DIGITOS_DA_SENHA_DO_LINK * 3}
        aria-invalid={aviso ? true : undefined} aria-describedby={aviso ? idDoAviso : undefined}
        className="w-full max-w-[16rem] rounded-xl border border-white/15 bg-black/20 px-4 py-3 text-center font-mono text-2xl tracking-[0.3em] text-white outline-none focus:border-amber-300"/>
      {aviso && <p id={idDoAviso} role="alert" className="text-sm text-amber-200/90">{aviso}</p>}
      <button type="submit" disabled={entrar.isPending}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#c98f70] px-5 py-2.5 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-50 sm:w-auto sm:self-start">
        {entrar.isPending && <Loader2 size={15} className="animate-spin"/>}{t("meetings.openLink.password.submit")}
      </button>
    </form>
  </section>;
}
