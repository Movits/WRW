// "Continuar com Google" no login e no cadastro (A8 da auditoria, HN-80 do
// HiNoter). O botão é navegação de página inteira (um <a href>, nunca o Link
// do wouter) para /api/entrar-com-google/ir, que guarda a ida num cookie e
// manda à Google; a volta (server/rotas-de-entrar-com-google.ts) entra e cai
// no /login com a sessão, ou volta à tela com `?conta-google=<resultado>`, que
// vira um aviso aqui, no idioma de quem lê. O parâmetro sai da URL na hora,
// para o F5 não repetir o aviso.
//
// O botão some quando a função está desligada no servidor (sem o cliente
// OAuth ou sem ENTRAR_COM_GOOGLE=ligado) e dentro de WebView (a casca das
// lojas e os navegadores de dentro de outros apps), onde a Google recusa a
// entrada. O endereço é o absoluto do FRONTEND_URL: começado noutro host (o
// .onrender.com), o servidor recomeça lá.
//
// O aviso da volta aparece mesmo sem o botão (a função desligada no meio).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Info } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { avisoDaContaGoogle, buscaSemOResultado, type AvisoDaContaGoogle } from "@/lib/entrar-com-google";
import { googleRecusaEntrarAqui } from "@/lib/instalacao-do-app";
import { enderecoDoBotaoDoGoogle, lerResultadoDaContaGoogle, type ModoDeEntrarComGoogle } from "@shared/entrar-com-google";

/** O "G" do Google nas cores da marca, como pedem as regras do botão de entrada do Google. */
function LogoDoGoogle() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

/** O aviso da volta, lido uma vez da URL ao abrir a tela (e tirado dela). */
function useAvisoDaVolta(): AvisoDaContaGoogle | null {
  const { t } = useTranslation();
  const [resultado] = useState(() => lerResultadoDaContaGoogle(window.location.search));
  useEffect(() => {
    if (!resultado) return;
    const { pathname, search, hash } = window.location;
    window.history.replaceState(window.history.state, "", `${pathname}${buscaSemOResultado(search)}${hash}`);
  }, [resultado]);
  return resultado ? avisoDaContaGoogle(t, resultado) : null;
}

export function ContinuarComGoogle({ modo, voltar, desligado }: {
  modo: Extract<ModoDeEntrarComGoogle, "entrar" | "cadastrar">;
  /** No login, o `?voltar=` já conferido pela tela. */
  voltar?: string | null;
  /** Enquanto o formulário envia, o botão não leva a outra página. */
  desligado?: boolean;
}) {
  const { t } = useTranslation();
  const aviso = useAvisoDaVolta();
  const [recusaAqui] = useState(() => googleRecusaEntrarAqui(window.navigator.userAgent));
  const disponivel = trpc.contaGoogle.disponivel.useQuery(undefined, {
    enabled: !recusaAqui,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const origem = !recusaAqui && disponivel.data?.disponivel ? disponivel.data.origem : null;

  return (
    <>
      {aviso && (
        <p
          role={aviso.tipo === "error" ? "alert" : "status"}
          className={aviso.tipo === "error"
            ? "mb-5 flex gap-2 rounded-lg border border-red-400/25 bg-red-500/[0.06] p-3 text-sm text-red-100/90"
            : "mb-5 flex gap-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] p-3 text-sm text-amber-100/90"}
        >
          {aviso.tipo === "error"
            ? <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
            : <Info size={16} className="mt-0.5 flex-shrink-0" aria-hidden="true" />}
          <span>{aviso.texto}</span>
        </p>
      )}
      {origem && (
        <div className="mb-5 space-y-4">
          <a
            href={enderecoDoBotaoDoGoogle(origem, modo, voltar)}
            aria-disabled={desligado || undefined}
            onClick={evento => { if (desligado) evento.preventDefault(); }}
            className="flex h-11 w-full items-center justify-center gap-3 rounded-md border border-[#dadce0] bg-white px-4 text-sm font-medium text-[#1f1f1f] transition-colors hover:bg-[#f7f8f8] aria-disabled:opacity-50"
          >
            <LogoDoGoogle />
            {t("contaGoogle.continue")}
          </a>
          <div className="flex items-center gap-3 text-xs text-white/40" aria-hidden="true">
            <span className="h-px flex-1 bg-white/10" />
            {t("contaGoogle.or")}
            <span className="h-px flex-1 bg-white/10" />
          </div>
        </div>
      )}
    </>
  );
}
