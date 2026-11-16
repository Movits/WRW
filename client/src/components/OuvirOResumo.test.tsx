import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { PRAZO_DAS_VOZES } from "@/lib/leitura-em-voz-alta";
import { instalarSinteseFalsa } from "@/test/sintese-falsa";
import { OuvirOResumo } from "./OuvirOResumo";

/**
 * "Ouvir o resumo" (H19): a voz do próprio aparelho lê as falas que o resumo
 * monta (components/ResumoGuardado.tsx), com pausar, continuar e parar. A
 * speechSynthesis é o dublê de test/sintese-falsa.ts; a escolha da voz e o
 * corte das falas estão em lib/leitura-em-voz-alta.test.ts.
 */

const VOZES = [
  { name: "Microsoft David", lang: "en-US", default: true },
  { name: "Joana", lang: "pt-PT" },
  { name: "Luciana", lang: "pt-BR" },
];
const FALAS = ["Ações", "Carla envia a proposta revisada.", "Responsável: Carla"];

const ouvir = () => render(<OuvirOResumo falas={FALAS} idioma="pt-BR"/>);
const botao = (nome: string) => screen.getByRole("button", { name: nome });

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("Ouvir o resumo — ler, pausar, continuar e parar", () => {
  it("lê as falas na ordem com a voz do idioma do resumo e, no fim, volta a 'Ouvir o resumo' sem calar ninguém", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    ouvir();
    fireEvent.click(botao("Ouvir o resumo"));
    expect(voz.fila()).toEqual(FALAS);
    // A voz do Brasil, e não a padrão do aparelho (inglês) nem a de Portugal.
    expect(voz.pedidas.map(fala => [fala.voice?.name, fala.lang])).toEqual(FALAS.map(() => ["Luciana", "pt-BR"]));
    expect(botao("Parar a leitura")).toBeInTheDocument();
    act(() => { voz.terminar(); voz.terminar(); });
    expect(botao("Pausar a leitura")).toBeInTheDocument();
    act(() => voz.terminar());
    expect(botao("Ouvir o resumo")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Parar a leitura" })).not.toBeInTheDocument();
    expect(voz.chamadas.cancel).toBe(0);
  });

  it("o mesmo botão vira Pausar e Continuar: o foco não se perde", () => {
    instalarSinteseFalsa({ vozes: VOZES });
    ouvir();
    const principal = botao("Ouvir o resumo");
    principal.focus();
    fireEvent.click(principal);
    expect(principal).toHaveAccessibleName("Pausar a leitura");
    fireEvent.click(principal);
    expect(principal).toHaveAccessibleName("Continuar a leitura");
    expect(principal).toHaveFocus();
  });

  it.each(["erro", "fim"] as const)("pausar cala; continuar lê de novo desde o começo da fala em que parou (cancel que dispara %s)", cancelarComo => {
    const voz = instalarSinteseFalsa({ vozes: VOZES, cancelarComo });
    ouvir();
    fireEvent.click(botao("Ouvir o resumo"));
    act(() => voz.terminar());
    fireEvent.click(botao("Pausar a leitura"));
    expect(voz.fila()).toEqual([]);
    expect(botao("Parar a leitura")).toBeInTheDocument();
    fireEvent.click(botao("Continuar a leitura"));
    // A segunda fala, interrompida no meio, volta inteira; a primeira não se repete.
    expect(voz.fila()).toEqual(FALAS.slice(1));
    act(() => { voz.terminar(); voz.terminar(); });
    expect(botao("Ouvir o resumo")).toBeInTheDocument();
  });

  it.each(["erro", "fim"] as const)("parar cala e esquece onde parou: o próximo 'Ouvir' começa do início (cancel que dispara %s)", cancelarComo => {
    const voz = instalarSinteseFalsa({ vozes: VOZES, cancelarComo });
    ouvir();
    fireEvent.click(botao("Ouvir o resumo"));
    act(() => voz.terminar());
    fireEvent.click(botao("Parar a leitura"));
    expect(voz.fila()).toEqual([]);
    expect(botao("Ouvir o resumo")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Parar a leitura" })).not.toBeInTheDocument();
    fireEvent.click(botao("Ouvir o resumo"));
    expect(voz.fila()).toEqual(FALAS);
  });

  it("frase longa vira falas curtas antes de ir para a fila", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    const longa = `${"A reunião tratou do frete marítimo e do seguro ".repeat(4).trim()}, e ficou para a semana que vem a decisão sobre a licença de exportação.`;
    render(<OuvirOResumo falas={["Foco do trabalho", longa]} idioma="pt-BR"/>);
    fireEvent.click(botao("Ouvir o resumo"));
    expect(voz.fila().length).toBeGreaterThan(2);
    for (const fala of voz.fila()) expect(fala.length).toBeLessThanOrEqual(160);
    expect(voz.fila().slice(1).join(" ")).toBe(longa);
  });

  it("a leitura que falha avisa e volta a 'Ouvir o resumo'; ouvir de novo tira o aviso", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    ouvir();
    fireEvent.click(botao("Ouvir o resumo"));
    act(() => voz.falhar("synthesis-failed"));
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível ler o resumo em voz alta. Tente de novo.");
    expect(voz.fila()).toEqual([]);
    expect(botao("Ouvir o resumo")).toBeInTheDocument();
    fireEvent.click(botao("Ouvir o resumo"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(voz.fila()).toEqual(FALAS);
  });

  it("outra página (ou o aparelho) interrompe a leitura: fica pausada, e Continuar volta à fala interrompida", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    ouvir();
    fireEvent.click(botao("Ouvir o resumo"));
    act(() => voz.terminar());
    act(() => voz.sintese.cancel());
    fireEvent.click(botao("Continuar a leitura"));
    expect(voz.fila()).toEqual(FALAS.slice(1));
  });

  it("sair da tela cala a leitura; sair sem ter lido não cala a voz de mais ninguém", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    const { unmount } = ouvir();
    fireEvent.click(botao("Ouvir o resumo"));
    unmount();
    expect(voz.fila()).toEqual([]);
    expect(voz.chamadas.cancel).toBe(1);
    ouvir().unmount();
    expect(voz.chamadas.cancel).toBe(1);
  });

  it("recarregar ou fechar a página (pagehide) cala a leitura", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    ouvir();
    fireEvent.click(botao("Ouvir o resumo"));
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(voz.fila()).toEqual([]);
  });

  it("um som por vez: ler pausa a gravação que toca, e a gravação que começa a tocar pausa a leitura", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    const { container } = render(<><audio/><OuvirOResumo falas={FALAS} idioma="pt-BR"/></>);
    const gravacao = container.querySelector("audio")!;
    let tocando = true;
    Object.defineProperty(gravacao, "paused", { configurable: true, get: () => !tocando });
    gravacao.pause = () => { tocando = false; };
    fireEvent.click(botao("Ouvir o resumo"));
    expect(tocando).toBe(false);
    expect(voz.fila()).toEqual(FALAS);
    act(() => voz.terminar());
    // O "play" não sobe pela árvore: a tela o ouve na captura.
    tocando = true;
    fireEvent(gravacao, new Event("play"));
    expect(voz.fila()).toEqual([]);
    fireEvent.click(botao("Continuar a leitura"));
    expect(tocando).toBe(false);
    expect(voz.fila()).toEqual(FALAS.slice(1));
  });
});

describe("Ouvir o resumo — sem voz para o idioma, o botão explica", () => {
  it("sem voz do idioma do resumo: o botão fica desligado, mas focável, e explica com o nome do idioma; clicar não lê", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    render(<OuvirOResumo falas={FALAS} idioma="ja"/>);
    const principal = botao("Ouvir o resumo");
    expect(principal).toHaveAttribute("aria-disabled", "true");
    expect(principal).not.toBeDisabled();
    expect(principal).toHaveAccessibleDescription("Este aparelho não tem voz no idioma do resumo (japonês). Instale uma voz desse idioma nas configurações do aparelho para ouvir.");
    fireEvent.click(principal);
    expect(voz.pedidas).toEqual([]);
    expect(principal).toHaveAccessibleName("Ouvir o resumo");
  });

  it("as vozes que chegam depois (o Chrome avisa pelo voiceschanged) ligam o botão, sem a explicação no meio", () => {
    const voz = instalarSinteseFalsa({ vozes: [] });
    ouvir();
    const principal = botao("Ouvir o resumo");
    expect(principal).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText(/não tem voz/)).not.toBeInTheDocument();
    act(() => voz.trocarVozes(VOZES));
    expect(principal).not.toHaveAttribute("aria-disabled");
    fireEvent.click(principal);
    expect(voz.fila()).toEqual(FALAS);
  });

  it("nenhuma voz depois do prazo: explica", () => {
    vi.useFakeTimers();
    instalarSinteseFalsa({ vozes: [] });
    ouvir();
    expect(screen.queryByText(/não tem voz/)).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(PRAZO_DAS_VOZES); });
    expect(botao("Ouvir o resumo")).toHaveAccessibleDescription(/^Este aparelho não tem voz no idioma do resumo \(português\)\./);
  });

  it("navegador sem leitura em voz alta: o botão explica", () => {
    ouvir();
    const principal = botao("Ouvir o resumo");
    expect(principal).toHaveAttribute("aria-disabled", "true");
    expect(principal).toHaveAccessibleDescription("Este navegador não lê texto em voz alta. Para ouvir o resumo, abra esta página em outro navegador.");
    fireEvent.click(principal);
    expect(principal).toHaveAccessibleName("Ouvir o resumo");
  });

  it("a explicação sai no idioma da tela", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    instalarSinteseFalsa({ vozes: VOZES });
    render(<OuvirOResumo falas={FALAS} idioma="ja"/>);
    expect(botao("Listen to the summary")).toHaveAccessibleDescription("This device has no voice for the summary's language (Japanese). Install a voice for that language in the device settings to listen.");
  });
});
