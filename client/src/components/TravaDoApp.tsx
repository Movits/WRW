// A trava do app das lojas, no Perfil: ligar e desligar "pedir o Face ID, a
// digital ou o bloqueio de tela ao abrir o app" (cartão "App: pedir Face ID ao
// abrir como opção", pedido da Glenda em 11/11/2026). Só aparece dentro da
// casca (#180): quem guarda a escolha e pede a biometria é o próprio app
// (mobile/regras/trava.ts), no celular. O site só conversa com ele.
//
// A conversa: o site manda ao app, por window.ReactNativeWebView.postMessage, um
// JSON {tipo: "wrw:trava", acao: "estado" | "ligar" | "desligar"}; o app
// responde disparando na página o evento "wrw:trava" com {disponivel, ligada}.
// App antigo, que não conhece a trava, não responde, e a seção não aparece.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import { abertoNaCascaDasLojas } from "@/lib/instalacao-do-app";

/** O nome do evento e do tipo da mensagem, iguais aos de mobile/regras/trava.ts. */
export const EVENTO_DA_TRAVA = "wrw:trava";

type EstadoDaTrava = { disponivel: boolean; ligada: boolean };
type PonteDoApp = { postMessage: (mensagem: string) => void };

function ponteDoApp(): PonteDoApp | null {
  const ponte = (window as unknown as { ReactNativeWebView?: PonteDoApp }).ReactNativeWebView;
  return ponte && typeof ponte.postMessage === "function" ? ponte : null;
}

function pedirAoApp(acao: "estado" | "ligar" | "desligar") {
  ponteDoApp()?.postMessage(JSON.stringify({ tipo: EVENTO_DA_TRAVA, acao }));
}

export function TravaDoApp() {
  const { t } = useTranslation();
  const [noApp] = useState(() => abertoNaCascaDasLojas(window.navigator.userAgent) && ponteDoApp() !== null);
  const [estado, setEstado] = useState<EstadoDaTrava | null>(null);
  const [esperando, setEsperando] = useState(false);
  const montado = useRef(true);

  useEffect(() => {
    montado.current = true;
    if (!noApp) return;
    const aoResponder = (evento: Event) => {
      const detalhe = (evento as CustomEvent<Partial<EstadoDaTrava>>).detail;
      if (!detalhe || !montado.current) return;
      setEstado({ disponivel: detalhe.disponivel === true, ligada: detalhe.ligada === true });
      setEsperando(false);
    };
    window.addEventListener(EVENTO_DA_TRAVA, aoResponder);
    pedirAoApp("estado");
    return () => {
      montado.current = false;
      window.removeEventListener(EVENTO_DA_TRAVA, aoResponder);
    };
  }, [noApp]);

  // Fora do app, ou com um app que ainda não respondeu (versão antiga), nada aparece.
  if (!noApp || !estado) return null;

  const alternar = () => {
    if (esperando || !estado.disponivel) return;
    setEsperando(true);
    pedirAoApp(estado.ligada ? "desligar" : "ligar");
  };

  return (
    <section aria-labelledby="trava-do-app-titulo" className="bg-[#1b1714] border border-white/8 rounded-2xl overflow-hidden">
      <div className="px-6 pt-6 pb-4 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
            <Lock size={16} aria-hidden="true" />
          </div>
          <div>
            <h2 id="trava-do-app-titulo" className="text-white font-bold text-base leading-tight">{t("travaDoApp.title")}</h2>
            <p className="text-white/40 text-xs mt-0.5">{t("travaDoApp.subtitle")}</p>
          </div>
        </div>
      </div>
      <div className="p-6 space-y-3">
        {estado.disponivel ? (
          <div className="flex items-center justify-between gap-4">
            <span id="trava-do-app-rotulo" className="text-sm text-white/85">{t("travaDoApp.switchLabel")}</span>
            <button
              type="button"
              role="switch"
              aria-checked={estado.ligada}
              aria-labelledby="trava-do-app-rotulo"
              aria-busy={esperando}
              disabled={esperando}
              onClick={alternar}
              className={`relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${estado.ligada ? "bg-[#c98f70]" : "bg-white/15"}`}
            >
              <span className={`inline-block h-5 w-5 rounded-full bg-white transition-transform ${estado.ligada ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </div>
        ) : (
          <p className="text-sm text-white/60">{t("travaDoApp.unavailable")}</p>
        )}
        <p className="text-xs leading-relaxed text-white/40">{t("travaDoApp.explanation")}</p>
      </div>
    </section>
  );
}
