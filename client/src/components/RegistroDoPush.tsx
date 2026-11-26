import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import { EVENTO_DO_TOKEN_DO_PUSH, tokenDoPushNaPagina } from "@/lib/push-do-app";

/**
 * Manda ao servidor o token do push que o app das lojas deixou na página
 * (lib/push-do-app.ts), com o idioma da tela, para o push sair na língua de
 * quem usa. Montado em toda tela logada (TelaAutenticada, em App.tsx): o
 * servidor prende o token à sessão desta página.
 *
 * Uma vez por token e idioma em cada carga da página. A falha só vai ao log:
 * o push é um extra, e a próxima tela logada tenta de novo.
 */
export function RegistroDoPush() {
  const { i18n } = useTranslation();
  const registrar = trpc.pushNoCelular.registrar.useMutation();
  const enviado = useRef<string | null>(null);
  const { mutate } = registrar;
  const idioma = i18n.language;

  useEffect(() => {
    const tentar = () => {
      const dados = tokenDoPushNaPagina();
      if (!dados) return;
      const chave = `${dados.token}|${idioma}`;
      if (enviado.current === chave) return;
      enviado.current = chave;
      mutate({ ...dados, idioma }, {
        onError: erro => {
          enviado.current = null;
          console.warn("[Push] o token do aparelho não foi guardado:", erro.message);
        },
      });
    };
    tentar();
    window.addEventListener(EVENTO_DO_TOKEN_DO_PUSH, tentar);
    return () => window.removeEventListener(EVENTO_DO_TOKEN_DO_PUSH, tentar);
  }, [idioma, mutate]);

  return null;
}
