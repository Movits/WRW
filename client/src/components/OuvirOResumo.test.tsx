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
  it("lê as falas na ordem, uma por vez, com a voz do idioma do resumo e, no fim, volta a 'Ouvir o resumo' sem calar ninguém", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    ouvir();
    fireEvent.click(botao("Ouvir resumo · áudio gerado pela IA da Google"));
    // Uma fala por vez com o navegador: a seguinte vai quando a anterior termina.
    expect(voz.fila()).toEqual([FALAS[0]]);
    expect(botao("Parar a leitura")).toBeInTheDocument();
    act(() => { voz.terminar(); voz.terminar(); });
    expect(voz.fila()).toEqual([FALAS[2]]);
    expect(botao("Pausar a leitura")).toBeInTheDocument();
    act(() => voz.terminar());
    expect(botao("Ouvir resumo · áudio gerado pela IA da Google")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Parar a leitura" })).not.toBeInTheDocument();
    expect(voz.pedidas.map(fala => fala.text)).toEqual(FALAS);
    // A voz do Brasil, e não a padrão do aparelho (inglês) nem a de Portugal.
    expect(voz.pedidas.map(fala => [fala.voice?.name, fala.lang])).toEqual(FALAS.map(() => ["Luciana", "pt-BR"]));
    expect(voz.chamadas.cancel).toBe(0);
  });

  it("o mesmo botão vira Pausar e Continuar: o foco não se perde", () => {
    instalarSinteseFalsa({ vozes: VOZES });
    ouvir();
    const principal = botao("Ouvir resumo · áudio gerado pela IA da Google");
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
    fireEvent.click(botao("Ouvir resumo · áudio gerado pela IA da Google"));
    act(() => voz.terminar());
    fireEvent.click(botao("Pausar a leitura"));
    expect(voz.fila()).toEqual([]);
    expect(botao("Parar a leitura")).toBeInTheDocument();
    fireEvent.click(botao("Continuar a leitura"));
    // A segunda fala, interrompida no meio, volta inteira; a primeira não se repete.
    expect(voz.lerAteOFim()).toEqual(FALAS.slice(1));
    expect(botao("Ouvir resumo · áudio gerado pela IA da Google")).toBeInTheDocument();
  });

  it.each(["erro", "fim"] as const)("parar cala e esquece onde parou: o próximo 'Ouvir' começa do início (cancel que dispara %s)", cancelarComo => {
    const voz = instalarSinteseFalsa({ vozes: VOZES, cancelarComo });
    ouvir();
    fireEvent.click(botao("Ouvir resumo · áudio gerado pela IA da Google"));
    act(() => voz.terminar());
    fireEvent.click(botao("Parar a leitura"));
    expect(voz.fila()).toEqual([]);
    expect(botao("Ouvir resumo · áudio gerado pela IA da Google")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Parar a leitura" })).not.toBeInTheDocument();
    fireEvent.click(botao("Ouvir resumo · áudio gerado pela IA da Google"));
    expect(voz.lerAteOFim()).toEqual(FALAS);
  });

  it("frase longa vira falas curtas antes de ir para a fila", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    const longa = `${"A reunião tratou do frete marítimo e do seguro ".repeat(4).trim()}, e ficou para a semana que vem a decisão sobre a licença de exportação.`;
    render(<OuvirOResumo falas={["Foco do trabalho", longa]} idioma="pt-BR"/>);
    fireEvent.click(botao("Ouvir resumo · áudio gerado pela IA da Google"));
    const lidas = voz.lerAteOFim();
    expect(lidas.length).toBeGreaterThan(2);
    for (const fala of lidas) expect(fala.length).toBeLessThanOrEqual(160);
    expect(lidas.slice(1).join(" ")).toBe(longa);
  });

  it("a fala que falha no meio avisa, não deixa o resto tocar e volta a 'Ouvir o resumo'; ouvir de novo tira o aviso", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    ouvir();
    fireEvent.click(botao("Ouvir resumo · áudio gerado pela IA da Google"));
    act(() => voz.terminar());
    act(() => voz.falhar("synthesis-failed"));
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível ler o resumo em voz alta. Tente de novo.");
    // O navegador segue a fila depois de um erro: não pode haver nela outra fala desta tela.
    expect(voz.fila()).toEqual([]);
    expect(voz.pedidas.map(fala => fala.text)).toEqual(FALAS.slice(0, 2));
    // E, sem nada desta tela para calar, a voz de mais ninguém se cala.
    expect(voz.chamadas.cancel).toBe(0);
    expect(botao("Ouvir resumo · áudio gerado pela IA da Google")).toBeInTheDocument();
    fireEvent.click(botao("Ouvir resumo · áudio gerado pela IA da Google"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(voz.lerAteOFim()).toEqual(FALAS);
  });

  it.each(["interrupted", "canceled"])("outra página (ou o aparelho) interrompe a fala (%s): a leitura fica pausada de verdade, sem calar ninguém, e Continuar volta à fala interrompida", erro => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    ouvir();
    fireEvent.click(botao("Ouvir resumo · áudio gerado pela IA da Google"));
    act(() => voz.terminar());
    // No Chrome, o cancel() de outra aba interrompe a fala da vez, e o
    // navegador seguiria com a próxima da fila: não pode haver próxima desta tela.
    act(() => voz.falhar(erro));
    expect(botao("Continuar a leitura")).toBeInTheDocument();
    expect(voz.fila()).toEqual([]);
    // O cancel() do Chrome cala todas as abas: quem interrompeu segue falando.
    expect(voz.chamadas.cancel).toBe(0);
    fireEvent.click(botao("Continuar a leitura"));
    // Da fala interrompida em diante, sem repetir nada.
    expect(voz.lerAteOFim()).toEqual(FALAS.slice(1));
    expect(voz.pedidas.map(fala => fala.text)).toEqual([...FALAS.slice(0, 2), ...FALAS.slice(1)]);
    expect(botao("Ouvir resumo · áudio gerado pela IA da Google")).toBeInTheDocument();
  });

  it("sair da tela cala a leitura; sair sem ter lido não cala a voz de mais ninguém", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    const { unmount } = ouvir();
    fireEvent.click(botao("Ouvir resumo · áudio gerado pela IA da Google"));
    unmount();
    expect(voz.fila()).toEqual([]);
    expect(voz.chamadas.cancel).toBe(1);
    ouvir().unmount();
    expect(voz.chamadas.cancel).toBe(1);
  });

  it("recarregar ou fechar a página (pagehide) cala a leitura", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    ouvir();
    fireEvent.click(botao("Ouvir resumo · áudio gerado pela IA da Google"));
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
    fireEvent.click(botao("Ouvir resumo · áudio gerado pela IA da Google"));
    expect(tocando).toBe(false);
    expect(voz.fila()).toEqual([FALAS[0]]);
    act(() => voz.terminar());
    // O "play" não sobe pela árvore: a tela o ouve na captura.
    tocando = true;
    fireEvent(gravacao, new Event("play"));
    expect(voz.fila()).toEqual([]);
    fireEvent.click(botao("Continuar a leitura"));
    expect(tocando).toBe(false);
    expect(voz.lerAteOFim()).toEqual(FALAS.slice(1));
  });

  it("o foco que estava no Parar volta ao botão principal quando a leitura para: pelo Parar, no fim e na falha", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    ouvir();
    fireEvent.click(botao("Ouvir resumo · áudio gerado pela IA da Google"));
    botao("Parar a leitura").focus();
    fireEvent.click(botao("Parar a leitura"));
    expect(botao("Ouvir resumo · áudio gerado pela IA da Google")).toHaveFocus();

    fireEvent.click(botao("Ouvir resumo · áudio gerado pela IA da Google"));
    botao("Parar a leitura").focus();
    voz.lerAteOFim();
    expect(botao("Ouvir resumo · áudio gerado pela IA da Google")).toHaveFocus();

    fireEvent.click(botao("Ouvir resumo · áudio gerado pela IA da Google"));
    botao("Parar a leitura").focus();
    act(() => voz.falhar("synthesis-failed"));
    expect(botao("Ouvir resumo · áudio gerado pela IA da Google")).toHaveFocus();
  });

  it("o foco que está em outro lugar fica onde está quando a leitura termina", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    render(<><input aria-label="Anotação"/><OuvirOResumo falas={FALAS} idioma="pt-BR"/></>);
    fireEvent.click(botao("Ouvir resumo · áudio gerado pela IA da Google"));
    const anotacao = screen.getByRole("textbox", { name: "Anotação" });
    anotacao.focus();
    voz.lerAteOFim();
    expect(anotacao).toHaveFocus();
  });
});

describe("Ouvir o resumo — de onde vem o áudio", () => {
  it("o próprio botão diz de onde vem o áudio, com o texto da Cris (decisão do Roberto de 24/11), e a frase da voz do aparelho saiu", () => {
    instalarSinteseFalsa({ vozes: VOZES });
    ouvir();
    expect(botao("Ouvir resumo · áudio gerado pela IA da Google")).toBeInTheDocument();
    expect(screen.queryByText(/voz do próprio aparelho/)).not.toBeInTheDocument();
  });

  it("sem voz para o idioma, o botão mantém o texto da Cris e a explicação aparece", () => {
    instalarSinteseFalsa({ vozes: VOZES });
    render(<OuvirOResumo falas={FALAS} idioma="ja"/>);
    expect(botao("Ouvir resumo · áudio gerado pela IA da Google")).toHaveAccessibleDescription(/^Este aparelho não tem voz no idioma do resumo/);
    expect(screen.queryByText(/voz do próprio aparelho/)).not.toBeInTheDocument();
  });
});

describe("Ouvir o resumo — sem voz para o idioma, o botão explica", () => {
  it("sem voz do idioma do resumo: o botão fica desligado, mas focável, e explica com o nome do idioma; clicar não lê", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    render(<OuvirOResumo falas={FALAS} idioma="ja"/>);
    const principal = botao("Ouvir resumo · áudio gerado pela IA da Google");
    expect(principal).toHaveAttribute("aria-disabled", "true");
    expect(principal).not.toBeDisabled();
    expect(principal).toHaveAccessibleDescription("Este aparelho não tem voz no idioma do resumo (japonês). Instale uma voz desse idioma nas configurações do aparelho para ouvir.");
    fireEvent.click(principal);
    expect(voz.pedidas).toEqual([]);
    expect(principal).toHaveAccessibleName("Ouvir resumo · áudio gerado pela IA da Google");
  });

  it("só a voz de rede do navegador no idioma (a do Google, no Chrome): o botão fica desligado e explica, e nada vai a ela", () => {
    const voz = instalarSinteseFalsa({ vozes: [...VOZES, { name: "Google 日本語", lang: "ja-JP", localService: false }] });
    render(<OuvirOResumo falas={FALAS} idioma="ja"/>);
    const principal = botao("Ouvir resumo · áudio gerado pela IA da Google");
    expect(principal).toHaveAttribute("aria-disabled", "true");
    expect(principal).toHaveAccessibleDescription("Este aparelho não tem voz no idioma do resumo (japonês). Instale uma voz desse idioma nas configurações do aparelho para ouvir.");
    fireEvent.click(principal);
    expect(voz.pedidas).toEqual([]);
  });

  it("as vozes que chegam depois (o Chrome avisa pelo voiceschanged) ligam o botão, sem a explicação no meio", () => {
    const voz = instalarSinteseFalsa({ vozes: [] });
    ouvir();
    const principal = botao("Ouvir resumo · áudio gerado pela IA da Google");
    expect(principal).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText(/não tem voz/)).not.toBeInTheDocument();
    act(() => voz.trocarVozes(VOZES));
    expect(principal).not.toHaveAttribute("aria-disabled");
    fireEvent.click(principal);
    expect(voz.lerAteOFim()).toEqual(FALAS);
  });

  it("nenhuma voz depois do prazo: explica", () => {
    vi.useFakeTimers();
    instalarSinteseFalsa({ vozes: [] });
    ouvir();
    expect(screen.queryByText(/não tem voz/)).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(PRAZO_DAS_VOZES); });
    expect(botao("Ouvir resumo · áudio gerado pela IA da Google")).toHaveAccessibleDescription(/^Este aparelho não tem voz no idioma do resumo \(português\)\./);
  });

  it("navegador sem leitura em voz alta: o botão explica", () => {
    ouvir();
    const principal = botao("Ouvir resumo · áudio gerado pela IA da Google");
    expect(principal).toHaveAttribute("aria-disabled", "true");
    expect(principal).toHaveAccessibleDescription("Este navegador não lê texto em voz alta. Para ouvir o resumo, abra esta página em outro navegador.");
    fireEvent.click(principal);
    expect(principal).toHaveAccessibleName("Ouvir resumo · áudio gerado pela IA da Google");
  });

  it("a explicação sai no idioma da tela", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    instalarSinteseFalsa({ vozes: VOZES });
    render(<OuvirOResumo falas={FALAS} idioma="ja"/>);
    expect(botao("Listen to summary · audio generated by Google AI")).toHaveAccessibleDescription("This device has no voice for the summary's language (Japanese). Install a voice for that language in the device settings to listen.");
  });
});

describe("Ouvir o resumo — a barra da leitura por trecho", () => {
  const barra = () => screen.getByRole("slider", { name: "Posição na leitura do resumo" });

  it("mostra o trecho da vez, e voltar e avançar um trecho leem dali, sem calar mais ninguém além da fala desta tela", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    ouvir();
    // Parada, não há barra.
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    fireEvent.click(botao("Ouvir resumo · áudio gerado pela IA da Google"));
    expect(barra()).toHaveAttribute("aria-valuetext", "Trecho 1 de 3");
    expect(botao("Voltar um trecho")).toBeDisabled();
    act(() => voz.terminar());
    expect(barra()).toHaveAttribute("aria-valuetext", "Trecho 2 de 3");
    fireEvent.click(botao("Avançar um trecho"));
    expect(voz.fila()).toEqual([FALAS[2]]);
    expect(barra()).toHaveAttribute("aria-valuetext", "Trecho 3 de 3");
    expect(botao("Avançar um trecho")).toBeDisabled();
    expect(voz.chamadas.cancel).toBe(1);
    fireEvent.click(botao("Voltar um trecho"));
    expect(voz.fila()).toEqual([FALAS[1]]);
    expect(botao("Pausar a leitura")).toBeInTheDocument();
    // O fim do pulo segue a leitura a partir do trecho escolhido.
    act(() => voz.terminar());
    expect(voz.fila()).toEqual([FALAS[2]]);
    expect(voz.pedidas.map(fala => fala.text)).toEqual([FALAS[0], FALAS[1], FALAS[2], FALAS[1], FALAS[2]]);
  });

  it.each(["erro", "fim"] as const)("arrastar a barra lendo pula para o trecho escolhido (cancel como %s): a fala calada não avança a leitura", cancelarComo => {
    const voz = instalarSinteseFalsa({ vozes: VOZES, cancelarComo });
    ouvir();
    fireEvent.click(botao("Ouvir resumo · áudio gerado pela IA da Google"));
    fireEvent.change(barra(), { target: { value: "3" } });
    expect(voz.fila()).toEqual([FALAS[2]]);
    expect(barra()).toHaveAttribute("aria-valuetext", "Trecho 3 de 3");
    act(() => voz.terminar());
    expect(botao("Ouvir resumo · áudio gerado pela IA da Google")).toBeInTheDocument();
    expect(voz.pedidas.map(fala => fala.text)).toEqual([FALAS[0], FALAS[2]]);
  });

  it("pausada, a barra só muda de onde o Continuar começa", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    ouvir();
    fireEvent.click(botao("Ouvir resumo · áudio gerado pela IA da Google"));
    fireEvent.click(botao("Pausar a leitura"));
    const pedidasAntes = voz.pedidas.length;
    const cancelAntes = voz.chamadas.cancel;
    fireEvent.change(barra(), { target: { value: "2" } });
    expect(barra()).toHaveAttribute("aria-valuetext", "Trecho 2 de 3");
    expect(voz.pedidas).toHaveLength(pedidasAntes);
    expect(voz.chamadas.cancel).toBe(cancelAntes);
    fireEvent.click(botao("Continuar a leitura"));
    expect(voz.fila()).toEqual([FALAS[1]]);
  });

  it("a posição sai no idioma da tela", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    instalarSinteseFalsa({ vozes: VOZES });
    ouvir();
    fireEvent.click(botao("Listen to summary · audio generated by Google AI"));
    expect(screen.getByRole("slider", { name: "Position in the summary reading" })).toHaveAttribute("aria-valuetext", "Passage 1 of 3");
    expect(botao("Forward one passage")).toBeEnabled();
  });
});
