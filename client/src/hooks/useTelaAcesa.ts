import { useEffect, useState } from "react";

type Sentinela = { released?: boolean; release: () => Promise<void> };
type WakeLock = { request: (tipo: "screen") => Promise<Sentinela> };

/**
 * Mantém a tela acesa enquanto `ativo` (G10 do desenho do gravador): no
 * celular, a tela que apaga sozinha bloqueia o aparelho, e no iPhone o
 * bloqueio corta o microfone no meio da gravação. Usa a Screen Wake Lock API.
 *
 * O navegador solta a trava quando a aba fica oculta; ao voltar, ela é pedida
 * de novo (uma só: enquanto a anterior vale, ou um pedido está no ar, não pede
 * outra). Sair da gravação a solta.
 *
 * Devolve `recusada`: o navegador não tem a API ou negou o pedido (bateria
 * fraca, política). A tela usa isso para avisar a dona de manter a tela aberta.
 */
export function useTelaAcesa(ativo: boolean): { recusada: boolean } {
  const [recusada, setRecusada] = useState(false);
  useEffect(() => {
    if (!ativo) return;
    const wakeLock = typeof navigator !== "undefined" ? (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock : undefined;
    if (!wakeLock) {
      setRecusada(true);
      return;
    }
    let sentinela: Sentinela | null = null;
    let pedindo = false;
    let vigente = true;
    const pedir = () => {
      if (!vigente || pedindo || document.visibilityState !== "visible") return;
      if (sentinela && !sentinela.released) return;
      pedindo = true;
      wakeLock.request("screen").then(s => {
        pedindo = false;
        if (!vigente) return void s.release().catch(() => {});
        sentinela = s;
        setRecusada(false);
      }, () => {
        pedindo = false;
        // Recusado: a gravação segue; a tela avisa que pode apagar.
        if (vigente) setRecusada(true);
      });
    };
    pedir();
    document.addEventListener("visibilitychange", pedir);
    return () => {
      vigente = false;
      document.removeEventListener("visibilitychange", pedir);
      void sentinela?.release().catch(() => {});
      setRecusada(false);
    };
  }, [ativo]);
  return { recusada };
}
