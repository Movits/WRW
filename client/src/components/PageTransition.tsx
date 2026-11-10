/**
 * PageTransition — Fade Out (escurecer para preto) + Fade In (clarear do preto)
 * Envolve toda a aplicação e dispara a transição a cada mudança de rota.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";

export function PageTransition({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [phase, setPhase] = useState<"idle" | "out" | "in">("idle");
  const [displayLocation, setDisplayLocation] = useState(location);
  const overlayRef = useRef<HTMLDivElement>(null);
  const prevLocation = useRef(location);

  useEffect(() => {
    // A URL voltou à tela anterior antes de o escurecer terminar (A → B → A no
    // mesmo instante, como o gravador faz ao devolver a URL para /gravar): a
    // limpeza já cancelou o timer da troca, então a fase volta a ocioso aqui.
    // Sem isto, o véu preto ficava por cima de tudo, bloqueando todo toque.
    if (location === prevLocation.current) {
      setPhase("idle");
      return;
    }

    // Start fade-out
    setPhase("out");

    // O clarear também é cancelado na troca seguinte. O retorno do callback do
    // setTimeout era descartado, e o timer do clarear da troca anterior cortava
    // no meio o escurecer da nova.
    let inTimer: ReturnType<typeof setTimeout> | undefined;
    const outTimer = setTimeout(() => {
      // At peak black, swap content
      setDisplayLocation(location);
      prevLocation.current = location;
      setPhase("in");

      inTimer = setTimeout(() => {
        setPhase("idle");
      }, 350); // fade-in duration
    }, 280); // fade-out duration

    return () => {
      clearTimeout(outTimer);
      clearTimeout(inTimer);
    };
  }, [location]);

  const overlayOpacity =
    phase === "out" ? 1 :
    phase === "in" ? 0 :
    0;

  const overlayTransition =
    phase === "out"
      ? "opacity 280ms cubic-bezier(0.77,0,0.175,1)"
      : phase === "in"
      ? "opacity 350ms cubic-bezier(0.23,1,0.32,1)"
      : "none";

  return (
    <>
      {/* Black overlay */}
      <div
        ref={overlayRef}
        aria-hidden="true"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 9999,
          background: "#000",
          opacity: overlayOpacity,
          transition: overlayTransition,
          pointerEvents: phase !== "idle" ? "all" : "none",
        }}
      />
      {children}
    </>
  );
}
