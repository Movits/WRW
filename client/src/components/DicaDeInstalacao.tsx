import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Smartphone, X } from "lucide-react";
import {
  ambienteAtual,
  dicaDispensadaNoAparelho,
  marcarDicaNoAparelho,
  pedirInstalacao,
  plataformaDeInstalacao,
  useInstalacaoDoApp,
  type AmbienteDoNavegador,
  type Plataforma,
} from "@/lib/instalacao-do-app";

/**
 * A dica de instalação do app, no gravador do /gravar (decisão 8 do plano do
 * gravador): instalado, o WRW abre direto no gravador, em janela própria.
 *
 * No Chrome, no Edge e no Samsung Internet, com o pedido do navegador guardado,
 * ela oferece o botão "Instalar o app"; nos outros casos, os passos do aparelho,
 * com os rótulos que o sistema mostra em cada idioma. No iPhone e no iPad ela
 * avisa que o app instalado pede um login próprio, separado do do Safari.
 *
 * Fechada, ou com o app instalado, não volta neste aparelho (a marca de
 * lib/instalacao-do-app.ts). Ela também não aparece dentro do app instalado
 * nem na casca das lojas.
 *
 * `oculta` (durante a gravação e o envio) esconde a dica sem tirar o lugar
 * dela: no computador o cartão do gravador é centralizado na altura, e a dica
 * sumindo puxaria o "Encerrar gravação" para longe do "Iniciar gravação".
 */
export function DicaDeInstalacao({ ambiente, oculta = false }: { ambiente?: AmbienteDoNavegador; oculta?: boolean }) {
  const { t } = useTranslation();
  const { podePedir, instaladoNestaVisita } = useInstalacaoDoApp();
  const [plataforma] = useState<Plataforma>(() => plataformaDeInstalacao(ambiente ?? ambienteAtual()));
  const [fechada, setFechada] = useState(dicaDispensadaNoAparelho);
  const [pedindo, setPedindo] = useState(false);
  const [instalou, setInstalou] = useState(false);
  const secao = useRef<HTMLElement>(null);
  const titulo = useRef<HTMLHeadingElement>(null);
  const idDoTitulo = useId();

  // Aberta como app: o aparelho guarda que o app está instalado. No Chromium,
  // a aba do navegador lê a mesma marca e para de oferecer a instalação.
  useEffect(() => {
    if (plataforma === "app-instalado") marcarDicaNoAparelho("instalado");
  }, [plataforma]);

  if (fechada || instalou || instaladoNestaVisita || plataforma === "app-instalado") return null;

  // O botão clicado some com a dica: o foco vai ao último botão antes dela (no
  // gravador, o "Enviar arquivo de áudio") em vez de se perder no topo da página.
  function focarAntesDaDica() {
    const anterior = secao.current?.previousElementSibling;
    if (!anterior) return;
    const botoes = [anterior, ...Array.from(anterior.querySelectorAll("button"))].filter(
      (elemento): elemento is HTMLButtonElement => elemento instanceof HTMLButtonElement && !elemento.disabled
    );
    botoes[botoes.length - 1]?.focus();
  }

  function fechar() {
    focarAntesDaDica();
    // Sem armazenamento, a marca não fica, e a dica volta só numa visita nova.
    marcarDicaNoAparelho("fechada");
    setFechada(true);
  }

  async function instalar() {
    setPedindo(true);
    try {
      if ((await pedirInstalacao()) === "aceitou") {
        // O appinstalled do navegador grava a marca; a dica some já.
        focarAntesDaDica();
        setInstalou(true);
        return;
      }
    } catch (erro) {
      // O navegador não abriu o pedido: a dica passa a mostrar os passos do menu.
      console.error("[Instalação] o navegador não abriu o pedido de instalação", erro);
    } finally {
      setPedindo(false);
    }
    // Recusou ou falhou: os passos tomam o lugar do botão, e o foco vai ao título da dica.
    titulo.current?.focus();
  }

  const comBotao = (podePedir || pedindo) && plataforma !== "ios";

  return (
    <section
      ref={secao}
      aria-labelledby={idDoTitulo}
      style={oculta ? { visibility: "hidden" } : undefined}
      className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/65"
    >
      <div className="flex items-start justify-between gap-3">
        {/* text-base: o h2 global de index.css é text-4xl, para título de página. */}
        <h2 id={idDoTitulo} ref={titulo} tabIndex={-1} className="flex items-center gap-2 text-base font-semibold text-white/85 outline-none">
          <Smartphone aria-hidden="true" size={17} className="shrink-0 text-amber-300" />
          {t("meetings.install.title")}
        </h2>
        <button
          type="button"
          onClick={fechar}
          aria-label={t("meetings.install.closeLabel")}
          className="-m-2 shrink-0 rounded-lg p-2 text-white/45 hover:bg-white/5 hover:text-white"
        >
          <X aria-hidden="true" size={16} />
        </button>
      </div>
      <p className="mt-2">{t("meetings.install.intro")}</p>
      {comBotao ? (
        <button
          type="button"
          onClick={instalar}
          disabled={pedindo}
          className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-amber-300/40 py-3 font-semibold text-amber-100 hover:bg-amber-300/10 disabled:opacity-60"
        >
          <Download aria-hidden="true" size={17} />
          {t("meetings.install.installButton")}
        </button>
      ) : (
        <PassosDaInstalacao plataforma={plataforma} />
      )}
      {plataforma === "ios" && <p className="mt-3 text-xs text-white/50">{t("meetings.install.iosLoginNote")}</p>}
    </section>
  );
}

// Cada ramo pede a chave literal: a guarda server/i18n-chaves-usadas.test.ts só confere chave literal.
function PassosDaInstalacao({ plataforma }: { plataforma: Plataforma }) {
  const { t } = useTranslation();
  const lista = "mt-3 list-decimal space-y-1.5 ps-5";
  switch (plataforma) {
    case "ios":
      return (
        <ol className={lista}>
          <li>{t("meetings.install.iosStep1")}</li>
          <li>{t("meetings.install.iosStep2")}</li>
          <li>{t("meetings.install.iosStep3")}</li>
        </ol>
      );
    case "android":
      return (
        <ol className={lista}>
          <li>{t("meetings.install.androidStep1")}</li>
          <li>{t("meetings.install.androidStep2")}</li>
        </ol>
      );
    case "computador":
      return (
        <ol className={lista}>
          <li>{t("meetings.install.desktopStep1")}</li>
          <li>{t("meetings.install.desktopStep2")}</li>
        </ol>
      );
    case "mac-safari":
      return <p className="mt-3">{t("meetings.install.macSafari")}</p>;
    case "navegador-embutido":
      return <p className="mt-3">{t("meetings.install.inAppBrowser")}</p>;
    default:
      return <p className="mt-3">{t("meetings.install.unsupportedBrowser")}</p>;
  }
}
