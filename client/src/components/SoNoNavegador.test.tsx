import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SoNoNavegador } from "./SoNoNavegador";
import { noAppDasLojas } from "@/lib/instalacao-do-app";

// O userAgent de verdade do Chrome no Android e o da casca das lojas, que é a
// WebView com "WRWApp/x" no fim (mobile/App.tsx, PR #180).
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; moto g82 5G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const CASCA_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; moto g82 5G; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 WRWApp/1.0.0";

const userAgentOriginal = window.navigator.userAgent;

function usarUserAgent(valor: string) {
  Object.defineProperty(window.navigator, "userAgent", { value: valor, configurable: true });
}

afterEach(() => usarUserAgent(userAgentOriginal));

describe("SoNoNavegador", () => {
  it("mostra o texto no navegador", () => {
    usarUserAgent(CHROME_ANDROID);
    render(<SoNoNavegador><p>Grave reuniões com consentimento.</p></SoNoNavegador>);
    expect(screen.getByText("Grave reuniões com consentimento.")).toBeInTheDocument();
    expect(noAppDasLojas()).toBe(false);
  });

  it("esconde o texto dentro do app das lojas", () => {
    usarUserAgent(CASCA_ANDROID);
    render(<SoNoNavegador><p>Grave reuniões com consentimento.</p></SoNoNavegador>);
    expect(screen.queryByText("Grave reuniões com consentimento.")).not.toBeInTheDocument();
    expect(noAppDasLojas()).toBe(true);
  });
});
