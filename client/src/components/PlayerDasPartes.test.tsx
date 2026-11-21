import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import {
  CHAVE_DA_VELOCIDADE, CHAVE_DOS_SILENCIOS, CONFERENCIA_DOS_TRECHOS_MS, PlayerDasPartes, destinoDoPulo, fimDaReuniao, localizar,
  type ControleDoPlayer, type ParteDoPlayer,
} from "./PlayerDasPartes";

const PARTES: ParteDoPlayer[] = [
  { seq: 0, url: "/a/0.m4a", mimeType: "audio/mp4", inicioSegundos: 0, duracaoSegundos: 600 },
  { seq: 1, url: "/a/1.m4a", mimeType: "audio/mp4", inicioSegundos: 600, duracaoSegundos: 600 },
  { seq: 2, url: "/a/2.m4a", mimeType: "audio/mp4", inicioSegundos: 1200, duracaoSegundos: 300 },
];
// A parte 1 (600 a 1200 s) não chegou ou venceu: um buraco na linha do tempo.
const COM_BURACO: ParteDoPlayer[] = [PARTES[0], PARTES[2]];

const audio = () => document.querySelector("audio")!;
const deslizante = () => screen.getByRole("slider") as HTMLInputElement;
const botao = (nome: string | RegExp) => screen.getByRole("button", { name: nome });
// O jsdom não tem play nem pause: o espião no prototype faz o papel do navegador.
const tocou = () => vi.mocked(HTMLMediaElement.prototype.play);
const pausou = () => vi.mocked(HTMLMediaElement.prototype.pause);

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  localStorage.removeItem(CHAVE_DA_VELOCIDADE);
  if (i18n.language !== "pt-BR") await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("PlayerDasPartes (D1)", () => {
  it("começa na primeira parte e, ao terminar, passa à seguinte tocando", () => {
    render(<PlayerDasPartes partes={PARTES} />);
    expect(audio().getAttribute("src")).toBe("/a/0.m4a");
    fireEvent.ended(audio());
    expect(audio().getAttribute("src")).toBe("/a/1.m4a");
    fireEvent.loadedMetadata(audio());
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it("na última parte, terminar não dá volta", () => {
    render(<PlayerDasPartes partes={[PARTES[0]]} />);
    fireEvent.ended(audio());
    expect(audio().getAttribute("src")).toBe("/a/0.m4a");
  });

  it("irPara acha a parte do segundo (absoluto) e começa dali", () => {
    const controle = createRef<ControleDoPlayer>();
    render(<PlayerDasPartes ref={controle} partes={PARTES} />);
    act(() => controle.current!.irPara(1250));
    expect(audio().getAttribute("src")).toBe("/a/2.m4a");
    fireEvent.loadedMetadata(audio());
    expect(audio().currentTime).toBe(50);
  });

  it("irPara na parte atual só muda o ponto", () => {
    const controle = createRef<ControleDoPlayer>();
    render(<PlayerDasPartes ref={controle} partes={PARTES} />);
    act(() => controle.current!.irPara(30));
    expect(audio().getAttribute("src")).toBe("/a/0.m4a");
    expect(audio().currentTime).toBe(30);
  });

  it("falha do áudio avisa a tela (sem isso, o player falha mudo)", () => {
    const aoFalhar = vi.fn();
    render(<PlayerDasPartes partes={PARTES} aoFalhar={aoFalhar} />);
    fireEvent.error(audio());
    expect(aoFalhar).toHaveBeenCalled();
  });

  it("sem partes, não desenha nada", () => {
    const { container } = render(<PlayerDasPartes partes={[]} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("As contas da linha do tempo (D1b)", () => {
  it("o fim da reunião é o fim da última parte, com ou sem buraco", () => {
    expect(fimDaReuniao(PARTES)).toBe(1500);
    expect(fimDaReuniao(COM_BURACO)).toBe(1500);
    expect(fimDaReuniao([])).toBe(0);
  });

  it("localizar: a parte do segundo; no buraco, a seguinte; depois do fim, a última", () => {
    expect(localizar(PARTES, 650)).toEqual({ indice: 1, dentro: 50 });
    expect(localizar(COM_BURACO, 900)).toEqual({ indice: 1, dentro: 0 });
    expect(localizar(PARTES, 1600)).toEqual({ indice: 2, dentro: 400 });
  });

  it("o pulo dos botões conta só o áudio que existe: atravessa partes e salta o buraco", () => {
    expect(destinoDoPulo(PARTES, 590, 15)).toBe(605);
    expect(destinoDoPulo(PARTES, 605, -15)).toBe(590);
    expect(destinoDoPulo(PARTES, 5, -15)).toBe(0);
    expect(destinoDoPulo(PARTES, 1495, 15)).toBe(1500);
    // Logo depois do buraco, voltar 15 s cai no fim da parte de antes, não no buraco.
    expect(destinoDoPulo(COM_BURACO, 1205, -15)).toBe(590);
    expect(destinoDoPulo(COM_BURACO, 590, 15)).toBe(1205);
  });
});

describe("PlayerDasPartes — uma gravação só para quem ouve (D1b)", () => {
  it("a linha do tempo é a reunião inteira: o total soma as partes e o tempo na tela é absoluto", () => {
    const controle = createRef<ControleDoPlayer>();
    render(<PlayerDasPartes ref={controle} partes={PARTES} />);
    expect(screen.getByText("25:00")).toBeInTheDocument();
    expect(deslizante()).toHaveAttribute("max", "1500");
    expect(deslizante()).toHaveAttribute("aria-valuetext", "00:00 de 25:00");
    act(() => controle.current!.irPara(1250));
    fireEvent.loadedMetadata(audio());
    expect(deslizante().value).toBe("1250");
    expect(deslizante()).toHaveAttribute("aria-valuetext", "20:50 de 25:00");
    // O tempo absoluto é o início da parte mais o currentTime dela.
    audio().currentTime = 60;
    fireEvent.timeUpdate(audio());
    expect(deslizante()).toHaveAttribute("aria-valuetext", "21:00 de 25:00");
    expect(screen.getByText("21:00")).toBeInTheDocument();
  });

  it("o deslizante leva a um segundo da parte 2: o src é o da parte 2 e o currentTime vem certo no loadedmetadata", () => {
    render(<PlayerDasPartes partes={PARTES} />);
    fireEvent.change(deslizante(), { target: { value: "650" } });
    expect(audio().getAttribute("src")).toBe("/a/1.m4a");
    expect(audio()).toHaveAttribute("data-parte", "1");
    fireEvent.loadedMetadata(audio());
    expect(audio().currentTime).toBe(50);
    // Parado, o pulo não toca sozinho.
    expect(tocou()).not.toHaveBeenCalled();
  });

  it("tocando, o pulo pelo deslizante segue tocando na parte nova", () => {
    render(<PlayerDasPartes partes={PARTES} />);
    fireEvent.click(botao("Tocar"));
    expect(tocou()).toHaveBeenCalledTimes(1);
    tocou().mockClear();
    fireEvent.change(deslizante(), { target: { value: "1300" } });
    expect(audio().getAttribute("src")).toBe("/a/2.m4a");
    // O play() sai já com o src novo (o iPhone não carrega sem ele)...
    expect(tocou()).toHaveBeenCalled();
    tocou().mockClear();
    fireEvent.loadedMetadata(audio());
    // ...e de novo no ponto pedido, quando a parte carrega.
    expect(audio().currentTime).toBe(100);
    expect(tocou()).toHaveBeenCalled();
    expect(botao("Pausar")).toBeInTheDocument();
  });

  it("o ▶ que cai na parte que ainda carrega toca já no toque, sem esperar o loadedmetadata", () => {
    const controle = createRef<ControleDoPlayer>();
    render(<PlayerDasPartes ref={controle} partes={PARTES} />);
    // Parado, o deslizante leva à última parte, que começa a carregar.
    fireEvent.change(deslizante(), { target: { value: "1300" } });
    expect(audio().getAttribute("src")).toBe("/a/2.m4a");
    expect(tocou()).not.toHaveBeenCalled();
    // O ▶ da transcrição cai na mesma parte antes de ela carregar: o play()
    // sai no toque (o iPhone não carrega a parte sem ele).
    act(() => controle.current!.irPara(1250));
    expect(tocou()).toHaveBeenCalled();
    expect(botao("Pausar")).toBeInTheDocument();
    fireEvent.loadedMetadata(audio());
    expect(audio().currentTime).toBe(50);
  });

  it("parado, trocar de parte não toca sozinho, nem no src novo nem no loadedmetadata", () => {
    render(<PlayerDasPartes partes={PARTES} />);
    fireEvent.click(botao("Avançar 15 segundos"));
    fireEvent.change(deslizante(), { target: { value: "1300" } });
    expect(audio().getAttribute("src")).toBe("/a/2.m4a");
    fireEvent.loadedMetadata(audio());
    expect(tocou()).not.toHaveBeenCalled();
    expect(botao("Tocar")).toBeInTheDocument();
  });

  it("arrastar não pula a cada passo: nenhuma parte carrega no caminho, e o pulo vem ao soltar", () => {
    render(<PlayerDasPartes partes={PARTES} />);
    fireEvent.pointerDown(deslizante());
    fireEvent.input(deslizante(), { target: { value: "700" } });
    fireEvent.input(deslizante(), { target: { value: "1300" } });
    expect(audio().getAttribute("src")).toBe("/a/0.m4a");
    // A tela acompanha o arraste.
    expect(deslizante()).toHaveAttribute("aria-valuetext", "21:40 de 25:00");
    fireEvent.pointerUp(deslizante());
    expect(audio().getAttribute("src")).toBe("/a/2.m4a");
    fireEvent.loadedMetadata(audio());
    expect(audio().currentTime).toBe(100);
  });

  it("soltar fora do controle também confirma: o change nativo do navegador fecha o arraste", () => {
    render(<PlayerDasPartes partes={PARTES} />);
    fireEvent.pointerDown(deslizante());
    fireEvent.input(deslizante(), { target: { value: "700" } });
    expect(audio().getAttribute("src")).toBe("/a/0.m4a");
    fireEvent.change(deslizante());
    expect(audio().getAttribute("src")).toBe("/a/1.m4a");
    fireEvent.loadedMetadata(audio());
    expect(audio().currentTime).toBe(100);
  });

  it("a velocidade vale em todas as partes: segue depois do ended para a parte seguinte e fica guardada", () => {
    render(<PlayerDasPartes partes={PARTES} />);
    const velocidade = () => botao(/^Velocidade de reprodução/);
    expect(velocidade()).toHaveTextContent("1x");
    fireEvent.click(velocidade());
    fireEvent.click(velocidade());
    expect(velocidade()).toHaveAccessibleName("Velocidade de reprodução: 1,5x");
    expect(velocidade()).toHaveTextContent("1,5x");
    expect(audio().playbackRate).toBe(1.5);
    expect(audio().defaultPlaybackRate).toBe(1.5);
    expect(localStorage.getItem(CHAVE_DA_VELOCIDADE)).toBe("1.5");
    fireEvent.ended(audio());
    expect(audio().getAttribute("src")).toBe("/a/1.m4a");
    // O algoritmo de carga do navegador volta a velocidade ao trocar o src.
    audio().playbackRate = 1;
    fireEvent.loadedMetadata(audio());
    expect(audio().playbackRate).toBe(1.5);
    expect(audio().defaultPlaybackRate).toBe(1.5);
    // 1,75x, 2x e de volta a 1x.
    fireEvent.click(velocidade());
    fireEvent.click(velocidade());
    expect(velocidade()).toHaveTextContent("2x");
    fireEvent.click(velocidade());
    expect(velocidade()).toHaveTextContent("1x");
    expect(audio().playbackRate).toBe(1);
  });

  it("a velocidade guardada volta na visita seguinte; valor estranho no armazenamento vira 1x", () => {
    localStorage.setItem(CHAVE_DA_VELOCIDADE, "1.75");
    const { unmount } = render(<PlayerDasPartes partes={PARTES} />);
    expect(botao(/^Velocidade de reprodução/)).toHaveTextContent("1,75x");
    expect(audio().playbackRate).toBe(1.75);
    unmount();
    localStorage.setItem(CHAVE_DA_VELOCIDADE, "3");
    render(<PlayerDasPartes partes={PARTES} />);
    expect(botao(/^Velocidade de reprodução/)).toHaveTextContent("1x");
  });

  it("localStorage que lança não quebra o player: começa em 1x e a troca vale na visita", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("armazenamento bloqueado"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("armazenamento bloqueado"); });
    // O erro solto num clique não derruba a tela no jsdom: ele chega aqui.
    const erros: unknown[] = [];
    const ouvir = (evento: ErrorEvent) => { erros.push(evento.error); evento.preventDefault(); };
    window.addEventListener("error", ouvir);
    try {
      render(<PlayerDasPartes partes={PARTES} />);
      expect(botao(/^Velocidade de reprodução/)).toHaveTextContent("1x");
      fireEvent.click(botao(/^Velocidade de reprodução/));
      expect(botao(/^Velocidade de reprodução/)).toHaveTextContent("1,25x");
      expect(audio().playbackRate).toBe(1.25);
      expect(erros).toEqual([]);
    } finally {
      window.removeEventListener("error", ouvir);
    }
  });

  it("+15 s e -15 s atravessam a fronteira entre as partes", () => {
    const controle = createRef<ControleDoPlayer>();
    render(<PlayerDasPartes ref={controle} partes={PARTES} />);
    act(() => controle.current!.irPara(590));
    expect(audio().currentTime).toBe(590);
    fireEvent.click(botao("Avançar 15 segundos"));
    expect(audio().getAttribute("src")).toBe("/a/1.m4a");
    fireEvent.loadedMetadata(audio());
    expect(audio().currentTime).toBe(5);
    fireEvent.click(botao("Retroceder 15 segundos"));
    expect(audio().getAttribute("src")).toBe("/a/0.m4a");
    fireEvent.loadedMetadata(audio());
    expect(audio().currentTime).toBe(590);
  });

  it("tocar e pausar: o botão troca o rótulo e acompanha o que o navegador faz", () => {
    render(<PlayerDasPartes partes={PARTES} />);
    fireEvent.click(botao("Tocar"));
    expect(tocou()).toHaveBeenCalledTimes(1);
    fireEvent.click(botao("Pausar"));
    expect(pausou()).toHaveBeenCalledTimes(1);
    expect(botao("Tocar")).toBeInTheDocument();
    // Tocado e pausado de fora (tecla de mídia, outro app que toma o som).
    fireEvent.play(audio());
    expect(botao("Pausar")).toBeInTheDocument();
    fireEvent.pause(audio());
    expect(botao("Tocar")).toBeInTheDocument();
  });

  it("o navegador que recusa tocar (sem gesto) devolve o botão a Tocar", async () => {
    tocou().mockRejectedValue(new DOMException("sem gesto", "NotAllowedError"));
    render(<PlayerDasPartes partes={PARTES} />);
    await act(async () => { fireEvent.click(botao("Tocar")); });
    expect(botao("Tocar")).toBeInTheDocument();
  });

  it("na troca de uma parte para a seguinte, o pause do fim da parte não vira pausa na tela", () => {
    render(<PlayerDasPartes partes={PARTES} />);
    fireEvent.click(botao("Tocar"));
    // No fim da parte o navegador dispara pause e depois ended.
    Object.defineProperty(audio(), "ended", { value: true, configurable: true });
    fireEvent.pause(audio());
    expect(botao("Pausar")).toBeInTheDocument();
    fireEvent.ended(audio());
    delete (audio() as unknown as { ended?: boolean }).ended;
    expect(audio().getAttribute("src")).toBe("/a/1.m4a");
    expect(botao("Pausar")).toBeInTheDocument();
  });

  it("buraco entre partes: a linha do tempo é absoluta, o pulo no buraco começa na parte seguinte e a reprodução salta o buraco", () => {
    render(<PlayerDasPartes partes={COM_BURACO} />);
    expect(screen.getByText("25:00")).toBeInTheDocument();
    fireEvent.change(deslizante(), { target: { value: "900" } });
    expect(audio().getAttribute("src")).toBe("/a/2.m4a");
    fireEvent.loadedMetadata(audio());
    expect(audio().currentTime).toBe(0);
    expect(deslizante()).toHaveAttribute("aria-valuetext", "20:00 de 25:00");
    // -15 s logo depois do buraco volta ao fim da parte de antes, sem ficar preso no buraco.
    audio().currentTime = 5;
    fireEvent.timeUpdate(audio());
    fireEvent.click(botao("Retroceder 15 segundos"));
    expect(audio().getAttribute("src")).toBe("/a/0.m4a");
    fireEvent.loadedMetadata(audio());
    expect(audio().currentTime).toBe(590);
    // O fim da parte de antes leva ao começo da de depois: o buraco é saltado.
    fireEvent.ended(audio());
    expect(audio().getAttribute("src")).toBe("/a/2.m4a");
    expect(deslizante()).toHaveAttribute("aria-valuetext", "20:00 de 25:00");
  });

  it("gravação ainda chegando: o total cresce com a parte nova, sem cortar o que está tocando", () => {
    const { rerender } = render(<PlayerDasPartes partes={[PARTES[0]]} />);
    fireEvent.click(botao("Tocar"));
    audio().currentTime = 300;
    fireEvent.timeUpdate(audio());
    const elemento = audio();
    expect(screen.getByText("10:00")).toBeInTheDocument();
    rerender(<PlayerDasPartes partes={PARTES.slice(0, 2)} />);
    expect(audio()).toBe(elemento);
    expect(audio().getAttribute("src")).toBe("/a/0.m4a");
    expect(audio().currentTime).toBe(300);
    expect(deslizante()).toHaveAttribute("aria-valuetext", "05:00 de 20:00");
    expect(botao("Pausar")).toBeInTheDocument();
  });

  it("a parte mais antiga que vence sai da lista sem trocar a que está tocando", () => {
    const { rerender } = render(<PlayerDasPartes partes={PARTES} />);
    fireEvent.ended(audio());
    expect(audio().getAttribute("src")).toBe("/a/1.m4a");
    rerender(<PlayerDasPartes partes={PARTES.slice(1)} />);
    expect(audio().getAttribute("src")).toBe("/a/1.m4a");
  });

  it("acabou a última parte: tocar segue na parte que chegou depois ou recomeça do início", () => {
    const { rerender } = render(<PlayerDasPartes partes={[PARTES[0]]} />);
    fireEvent.click(botao("Tocar"));
    fireEvent.ended(audio());
    expect(botao("Tocar")).toBeInTheDocument();
    rerender(<PlayerDasPartes partes={PARTES.slice(0, 2)} />);
    fireEvent.click(botao("Tocar"));
    expect(audio().getAttribute("src")).toBe("/a/1.m4a");
    fireEvent.loadedMetadata(audio());
    expect(audio().currentTime).toBe(0);
    fireEvent.ended(audio());
    fireEvent.click(botao("Tocar"));
    expect(audio().getAttribute("src")).toBe("/a/0.m4a");
  });

  it("a parte que não carrega na reprodução contínua pula para a seguinte, e a seguinte toca", () => {
    const aoFalhar = vi.fn();
    render(<PlayerDasPartes partes={PARTES} aoFalhar={aoFalhar} />);
    fireEvent.ended(audio());
    expect(audio().getAttribute("src")).toBe("/a/1.m4a");
    // O play() que conta é o da parte seguinte, depois do erro, e não o da
    // troca anterior (o do ended).
    tocou().mockClear();
    fireEvent.error(audio());
    expect(aoFalhar).toHaveBeenCalled();
    expect(audio().getAttribute("src")).toBe("/a/2.m4a");
    fireEvent.loadedMetadata(audio());
    expect(tocou()).toHaveBeenCalled();
    expect(botao("Pausar")).toBeInTheDocument();
  });

  it("o pulo pedido (o ▶, o ?t) para uma parte que não carrega fica no ponto pedido, com o aviso, sem tocar outro trecho", () => {
    const controle = createRef<ControleDoPlayer>();
    const aoFalhar = vi.fn();
    render(<PlayerDasPartes ref={controle} partes={PARTES} aoFalhar={aoFalhar} />);
    act(() => controle.current!.irPara(650));
    expect(audio().getAttribute("src")).toBe("/a/1.m4a");
    fireEvent.error(audio());
    expect(aoFalhar).toHaveBeenCalledTimes(1);
    expect(audio().getAttribute("src")).toBe("/a/1.m4a");
    expect(botao("Tocar")).toBeInTheDocument();
    expect(deslizante()).toHaveAttribute("aria-valuetext", "10:50 de 25:00");
  });

  it("tocando, os 15 s que entram numa parte que não carrega também ficam nela", () => {
    const aoFalhar = vi.fn();
    render(<PlayerDasPartes partes={PARTES} aoFalhar={aoFalhar} />);
    fireEvent.change(deslizante(), { target: { value: "590" } });
    fireEvent.click(botao("Tocar"));
    fireEvent.click(botao("Avançar 15 segundos"));
    expect(audio().getAttribute("src")).toBe("/a/1.m4a");
    fireEvent.error(audio());
    expect(aoFalhar).toHaveBeenCalledTimes(1);
    expect(audio().getAttribute("src")).toBe("/a/1.m4a");
    expect(botao("Tocar")).toBeInTheDocument();
    expect(deslizante()).toHaveAttribute("aria-valuetext", "10:05 de 25:00");
  });

  it("o aviso da parte que não carregou fica quando a seguinte carrega pelo pulo automático; o pedido de outra parte o apaga", () => {
    const controle = createRef<ControleDoPlayer>();
    const aoCarregar = vi.fn();
    render(<PlayerDasPartes ref={controle} partes={PARTES} aoFalhar={() => {}} aoCarregar={aoCarregar} />);
    fireEvent.loadedData(audio());
    expect(aoCarregar).toHaveBeenCalledTimes(1);
    fireEvent.click(botao("Tocar"));
    fireEvent.ended(audio());
    fireEvent.error(audio());
    expect(audio().getAttribute("src")).toBe("/a/2.m4a");
    fireEvent.loadedMetadata(audio());
    fireEvent.loadedData(audio());
    expect(aoCarregar).toHaveBeenCalledTimes(1);
    // Quem ouve pede um ponto de outra parte: o loadeddata dela apaga o aviso.
    act(() => controle.current!.irPara(30));
    expect(audio().getAttribute("src")).toBe("/a/0.m4a");
    fireEvent.loadedMetadata(audio());
    fireEvent.loadedData(audio());
    expect(aoCarregar).toHaveBeenCalledTimes(2);
  });

  it("o play() recusado com AbortError (o src trocado pelo ▶ no meio) não devolve o botão a Tocar", async () => {
    let recusar!: (erro: unknown) => void;
    tocou().mockImplementationOnce(() => new Promise<void>((_tocou, falhou) => { recusar = falhou; }));
    const controle = createRef<ControleDoPlayer>();
    render(<PlayerDasPartes ref={controle} partes={PARTES} />);
    fireEvent.click(botao("Tocar"));
    act(() => controle.current!.irPara(650));
    expect(audio().getAttribute("src")).toBe("/a/1.m4a");
    await act(async () => { recusar(new DOMException("o src mudou", "AbortError")); });
    expect(botao("Pausar")).toBeInTheDocument();
  });

  it("Pausar enquanto a parte do pulo ainda carrega: ela não toca sozinha quando carregar", () => {
    const controle = createRef<ControleDoPlayer>();
    render(<PlayerDasPartes ref={controle} partes={PARTES} />);
    act(() => controle.current!.irPara(650));
    fireEvent.click(botao("Pausar"));
    tocou().mockClear();
    fireEvent.loadedMetadata(audio());
    expect(audio().currentTime).toBe(50);
    expect(tocou()).not.toHaveBeenCalled();
    expect(botao("Tocar")).toBeInTheDocument();
  });

  it("a parte de seq menor que chega atrasada não troca a que já toca, mesmo antes de qualquer troca de parte", () => {
    // O envio da seq 0 falhou de forma passageira e a retomada a mandou depois
    // da 1 e da 2: quem abriu o detalhe nesse meio-tempo ouve a seq 1.
    const { rerender } = render(<PlayerDasPartes partes={[PARTES[1], PARTES[2]]} />);
    fireEvent.click(botao("Tocar"));
    audio().currentTime = 120;
    fireEvent.timeUpdate(audio());
    expect(deslizante()).toHaveAttribute("aria-valuetext", "12:00 de 25:00");
    tocou().mockClear();
    rerender(<PlayerDasPartes partes={PARTES} />);
    expect(audio().getAttribute("src")).toBe("/a/1.m4a");
    expect(audio().currentTime).toBe(120);
    expect(deslizante()).toHaveAttribute("aria-valuetext", "12:00 de 25:00");
    expect(botao("Pausar")).toBeInTheDocument();
    expect(tocou()).not.toHaveBeenCalled();
  });

  it("a parte que está tocando sai da lista: segue tocando na seguinte, com o botão coerente", () => {
    const aoFalhar = vi.fn();
    const { rerender } = render(<PlayerDasPartes partes={PARTES} aoFalhar={aoFalhar} />);
    fireEvent.click(botao("Tocar"));
    fireEvent.ended(audio());
    fireEvent.loadedMetadata(audio());
    audio().currentTime = 120;
    fireEvent.timeUpdate(audio());
    tocou().mockClear();
    // A parte 1 venceu, ou a transcrição dela desistiu: o servidor deixa de listá-la.
    rerender(<PlayerDasPartes partes={COM_BURACO} aoFalhar={aoFalhar} />);
    expect(audio().getAttribute("src")).toBe("/a/2.m4a");
    expect(tocou()).toHaveBeenCalled();
    expect(botao("Pausar")).toBeInTheDocument();
    expect(deslizante()).toHaveAttribute("aria-valuetext", "20:00 de 25:00");
    fireEvent.loadedMetadata(audio());
    expect(audio().currentTime).toBe(0);
    expect(aoFalhar).not.toHaveBeenCalled();
  });

  it("parado, a parte que sai da lista leva ao começo da seguinte sem tocar; sem parte depois, o player para", () => {
    const { rerender } = render(<PlayerDasPartes partes={PARTES} />);
    fireEvent.change(deslizante(), { target: { value: "900" } });
    fireEvent.loadedMetadata(audio());
    expect(deslizante()).toHaveAttribute("aria-valuetext", "15:00 de 25:00");
    rerender(<PlayerDasPartes partes={COM_BURACO} />);
    expect(audio().getAttribute("src")).toBe("/a/2.m4a");
    expect(deslizante()).toHaveAttribute("aria-valuetext", "20:00 de 25:00");
    fireEvent.loadedMetadata(audio());
    expect(tocou()).not.toHaveBeenCalled();
    expect(botao("Tocar")).toBeInTheDocument();
    // Tocando a última parte, ela sai e não sobra parte depois: o player para.
    fireEvent.click(botao("Tocar"));
    tocou().mockClear();
    rerender(<PlayerDasPartes partes={[PARTES[0]]} />);
    expect(audio().getAttribute("src")).toBe("/a/0.m4a");
    expect(tocou()).not.toHaveBeenCalled();
    expect(botao("Tocar")).toBeInTheDocument();
  });

  it("teclado: a seta para a esquerda e o PageDown logo depois de um buraco voltam para a parte de antes", () => {
    render(<PlayerDasPartes partes={COM_BURACO} />);
    fireEvent.change(deslizante(), { target: { value: "1200" } });
    fireEvent.loadedMetadata(audio());
    expect(deslizante().value).toBe("1200");
    // Seta para a esquerda: um passo de 1 s, sem ponteiro.
    fireEvent.change(deslizante(), { target: { value: "1199" } });
    expect(audio().getAttribute("src")).toBe("/a/0.m4a");
    fireEvent.loadedMetadata(audio());
    expect(audio().currentTime).toBe(599);
    expect(deslizante().value).toBe("599");
    // PageDown (10% de 25 min) a partir do começo da parte de depois do buraco.
    fireEvent.change(deslizante(), { target: { value: "1200" } });
    fireEvent.loadedMetadata(audio());
    fireEvent.change(deslizante(), { target: { value: "1050" } });
    expect(audio().getAttribute("src")).toBe("/a/0.m4a");
    fireEvent.loadedMetadata(audio());
    expect(audio().currentTime).toBe(450);
    // O passo para trás que cai no áudio que existe vai exatamente ao valor escolhido.
    fireEvent.change(deslizante(), { target: { value: "300" } });
    expect(audio().currentTime).toBe(300);
  });

  it("depois do fim, o áudio que volta a tocar por fora da barra (tecla de mídia, fone) não faz o Tocar seguinte pular", () => {
    render(<PlayerDasPartes partes={PARTES} />);
    fireEvent.change(deslizante(), { target: { value: "1490" } });
    fireEvent.loadedMetadata(audio());
    fireEvent.click(botao("Tocar"));
    fireEvent.ended(audio());
    expect(botao("Tocar")).toBeInTheDocument();
    // A tecla de mídia toca de novo: o navegador recomeça a última parte.
    audio().currentTime = 0;
    fireEvent.play(audio());
    audio().currentTime = 100;
    fireEvent.timeUpdate(audio());
    fireEvent.click(botao("Pausar"));
    fireEvent.click(botao("Tocar"));
    expect(audio().getAttribute("src")).toBe("/a/2.m4a");
    expect(audio().currentTime).toBe(100);
    expect(deslizante()).toHaveAttribute("aria-valuetext", "21:40 de 25:00");
  });

  it("com o foco no deslizante e o áudio tocando, o texto anunciado não muda a cada segundo: só no foco, na ação de quem ouve e na pausa", () => {
    render(<PlayerDasPartes partes={PARTES} />);
    fireEvent.click(botao("Tocar"));
    audio().currentTime = 60;
    fireEvent.timeUpdate(audio());
    fireEvent.focus(deslizante());
    expect(deslizante()).toHaveAttribute("aria-valuetext", "01:00 de 25:00");
    audio().currentTime = 61;
    fireEvent.timeUpdate(audio());
    // O valor visual anda; o texto para o leitor de tela fica.
    expect(deslizante().value).toBe("61");
    expect(deslizante()).toHaveAttribute("aria-valuetext", "01:00 de 25:00");
    // A seta (ação de quem ouve) atualiza o texto.
    fireEvent.change(deslizante(), { target: { value: "75" } });
    expect(deslizante()).toHaveAttribute("aria-valuetext", "01:15 de 25:00");
    audio().currentTime = 76;
    fireEvent.timeUpdate(audio());
    expect(deslizante()).toHaveAttribute("aria-valuetext", "01:15 de 25:00");
    // A pausa também.
    fireEvent.pause(audio());
    expect(deslizante()).toHaveAttribute("aria-valuetext", "01:16 de 25:00");
    // Sem o foco, o texto acompanha o tempo.
    fireEvent.blur(deslizante());
    fireEvent.play(audio());
    audio().currentTime = 80;
    fireEvent.timeUpdate(audio());
    expect(deslizante()).toHaveAttribute("aria-valuetext", "01:20 de 25:00");
  });

  it("acessibilidade: rótulos e valor do deslizante no idioma da tela, alvos de 44 px e controles da esquerda para a direita em árabe", async () => {
    const controle = createRef<ControleDoPlayer>();
    render(<PlayerDasPartes ref={controle} partes={[{ seq: 0, url: "/a/0.m4a", mimeType: "audio/mp4", inicioSegundos: 0, duracaoSegundos: 3720 }]} />);
    expect(deslizante()).toHaveAccessibleName("Posição na gravação");
    const controles = [...["Retroceder 15 segundos", "Tocar", "Avançar 15 segundos", "Velocidade de reprodução: 1x"].map(nome => botao(nome)), deslizante()];
    for (const controle of controles) {
      expect(controle.className).toMatch(/(^|\s)h-11(\s|$)/);
      // O foco aparece também no alto contraste do Windows, que apaga o ring:
      // o outline fica transparente (e o sistema o pinta), em vez de sumir.
      expect(controle.className).toMatch(/(^|\s)focus-visible:outline-hidden(\s|$)/);
      expect(controle.className).not.toMatch(/outline-none/);
    }
    // Sem o atributo step: com ele, o VoiceOver anda 1 s por gesto.
    expect(deslizante()).not.toHaveAttribute("step");
    act(() => controle.current!.irPara(620));
    expect(deslizante()).toHaveAttribute("aria-valuetext", "10:20 de 1:02:00");

    await act(async () => { await i18n.changeLanguage("en"); });
    expect(botao("Back 15 seconds")).toBeInTheDocument();
    expect(botao("Pause")).toBeInTheDocument();
    expect(botao("Forward 15 seconds")).toBeInTheDocument();
    expect(botao("Playback speed: 1x")).toBeInTheDocument();
    expect(deslizante()).toHaveAccessibleName("Position in the recording");
    expect(deslizante()).toHaveAttribute("aria-valuetext", "10:20 of 1:02:00");

    await act(async () => { await i18n.changeLanguage("ar"); });
    expect(document.documentElement.dir).toBe("rtl");
    expect(deslizante()).toHaveAttribute("aria-valuetext", "10:20 من 1:02:00");
    expect(deslizante().closest("[dir]")).toHaveAttribute("dir", "ltr");
    // Nenhuma chave crua na tela nem nos rótulos.
    const rotulos = Array.from(document.querySelectorAll("[aria-label], [aria-valuetext]"))
      .map(e => `${e.getAttribute("aria-label") ?? ""} ${e.getAttribute("aria-valuetext") ?? ""}`).join(" ");
    expect(`${document.body.textContent} ${rotulos}`).not.toMatch(/meetings\./);
  });
});

/**
 * D2 (HN-26 e HN-79 do HiNoter): ouvir só uma voz e pular os silêncios. As
 * falas vêm com os tempos em segundos; o player toca só os trechos de
 * lib/trechos-para-tocar.ts (com as margens de 0,25 s antes e 0,75 s depois).
 */
const FALAS_D2 = [
  { inicio: 10, fim: 20, falante: "F1", texto: "Bom dia." },
  { inicio: 30, fim: 40, falante: "F2", texto: "Oi, tudo bem?" },
  { inicio: 700, fim: 710, falante: "F1", texto: "Voltando ao contrato." },
];

/** O player com a voz escolhida guardada como a página guarda (o estado é dela). */
function PlayerComVoz({ controle, aoMudar }: { controle: React.RefObject<ControleDoPlayer | null>; aoMudar?: (voz: string | null) => void }) {
  const [voz, setVoz] = useState<string | null>(null);
  return <PlayerDasPartes ref={controle} partes={PARTES} falas={FALAS_D2} soAVoz={voz} aoMudarSoAVoz={nova => { aoMudar?.(nova); setVoz(nova); }}/>;
}

describe("PlayerDasPartes — ouvir só uma voz e pular os silêncios (D2)", () => {
  afterEach(() => { localStorage.removeItem(CHAVE_DOS_SILENCIOS); });

  it("pular os silêncios: o botão liga e desliga e fica guardado; tocando, o player salta o intervalo sem fala", () => {
    render(<PlayerDasPartes partes={PARTES} falas={FALAS_D2}/>);
    const pular = botao("Pular os silêncios");
    expect(pular).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(pular);
    expect(pular).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem(CHAVE_DOS_SILENCIOS)).toBe("1");
    // Do começo (silêncio até 9,75 s), o Tocar já vai à primeira fala.
    fireEvent.click(botao("Tocar"));
    expect(audio().currentTime).toBe(9.75);
    expect(tocou()).toHaveBeenCalled();
    // Entre as falas (20,75 a 29,75 s), o timeupdate salta à seguinte.
    audio().currentTime = 25;
    fireEvent.timeUpdate(audio());
    expect(audio().currentTime).toBe(29.75);
    // Desligado, o silêncio toca.
    fireEvent.click(pular);
    expect(localStorage.getItem(CHAVE_DOS_SILENCIOS)).toBe("0");
    audio().currentTime = 45;
    fireEvent.timeUpdate(audio());
    expect(audio().currentTime).toBe(45);
  });

  it("a conferência não espera o timeupdate (a cada 250 ms no navegador): a cada 100 ms o player confere e salta", () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval"] });
    try {
      localStorage.setItem(CHAVE_DOS_SILENCIOS, "1");
      render(<PlayerDasPartes partes={PARTES} falas={FALAS_D2}/>);
      expect(botao("Pular os silêncios")).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(botao("Tocar"));
      audio().currentTime = 22;
      act(() => { vi.advanceTimersByTime(CONFERENCIA_DOS_TRECHOS_MS); });
      expect(audio().currentTime).toBe(29.75);
    } finally {
      vi.useRealTimers();
    }
  });

  it("depois da última fala, o player para ali; o Tocar seguinte recomeça da primeira", () => {
    localStorage.setItem(CHAVE_DOS_SILENCIOS, "1");
    const controle = createRef<ControleDoPlayer>();
    render(<PlayerDasPartes ref={controle} partes={PARTES} falas={FALAS_D2}/>);
    act(() => controle.current!.irPara(705));
    fireEvent.loadedMetadata(audio());
    expect(audio().currentTime).toBe(105);
    pausou().mockClear();
    audio().currentTime = 115;
    fireEvent.timeUpdate(audio());
    expect(pausou()).toHaveBeenCalled();
    expect(botao("Tocar")).toBeInTheDocument();
    fireEvent.click(botao("Tocar"));
    expect(audio().getAttribute("src")).toBe("/a/0.m4a");
    fireEvent.loadedMetadata(audio());
    expect(audio().currentTime).toBe(9.75);
  });

  it("ouvir só uma voz: o controle avisa a página e toca a próxima fala dessa voz a partir de onde o player está", () => {
    const controle = createRef<ControleDoPlayer>();
    const aoMudar = vi.fn();
    render(<PlayerComVoz controle={controle} aoMudar={aoMudar}/>);
    act(() => controle.current!.ouvirSoAVoz("F2"));
    expect(aoMudar).toHaveBeenCalledWith("F2");
    expect(audio().currentTime).toBe(29.75);
    expect(tocou()).toHaveBeenCalled();
    // Depois da única fala da voz, para.
    pausou().mockClear();
    audio().currentTime = 41;
    fireEvent.timeUpdate(audio());
    expect(pausou()).toHaveBeenCalled();
    // A partir de 25 s, a próxima fala da F1 está na parte 2 (700 s).
    act(() => controle.current!.irPara(25));
    act(() => controle.current!.ouvirSoAVoz("F1"));
    expect(audio().getAttribute("src")).toBe("/a/1.m4a");
    fireEvent.loadedMetadata(audio());
    expect(audio().currentTime).toBe(99.75);
  });

  it("os 15 s, ouvindo só uma voz, contam só as falas dela: voltar da segunda fala cai na primeira, e não na fala de outra pessoa", () => {
    const controle = createRef<ControleDoPlayer>();
    render(<PlayerComVoz controle={controle}/>);
    act(() => controle.current!.irPara(705));
    fireEvent.loadedMetadata(audio());
    act(() => controle.current!.ouvirSoAVoz("F1"));
    fireEvent.click(botao("Retroceder 15 segundos"));
    expect(audio().getAttribute("src")).toBe("/a/0.m4a");
    fireEvent.loadedMetadata(audio());
    // 5,25 s dentro da segunda fala (de 699,75): voltar 15 anda 5,25 nela e 9,75 na primeira (de 9,75 a 20,75).
    expect(audio().currentTime).toBeCloseTo(11, 5);
  });

  it("o ▶ de um trecho de outra voz, com só uma voz ligada, volta a tocar todas, no ponto pedido", () => {
    const controle = createRef<ControleDoPlayer>();
    const aoMudar = vi.fn();
    render(<PlayerComVoz controle={controle} aoMudar={aoMudar}/>);
    act(() => controle.current!.ouvirSoAVoz("F2"));
    aoMudar.mockClear();
    act(() => controle.current!.irPara(15));
    expect(aoMudar).toHaveBeenCalledWith(null);
    expect(audio().currentTime).toBe(15);
    audio().currentTime = 16;
    fireEvent.timeUpdate(audio());
    expect(audio().currentTime).toBe(16);
  });

  it("sem as falas (a transcrição antiga, sem vozes), não há o botão de pular os silêncios", () => {
    render(<PlayerDasPartes partes={PARTES}/>);
    expect(screen.queryByRole("button", { name: "Pular os silêncios" })).not.toBeInTheDocument();
  });
});
