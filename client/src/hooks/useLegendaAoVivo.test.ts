import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LINHAS_DA_LEGENDA_MAX, REINICIOS_RAPIDOS_MAX } from "@/lib/legenda-ao-vivo";
import { instalarReconhecimentoFalso } from "@/test/reconhecimento-falso";
import { useLegendaAoVivo } from "./useLegendaAoVivo";

/**
 * O reconhecimento de voz por trás da legenda ao vivo (G15b), com o
 * reconhecimento de mentira (test/reconhecimento-falso.ts) e o relógio falso:
 * ligar, religar quando o navegador encerra a sessão, pausar com a gravação,
 * desligar com cada falha e sair da tela.
 */

let falso: ReturnType<typeof instalarReconhecimentoFalso>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  falso = instalarReconhecimentoFalso();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

type Props = { ativa: boolean; microfoneCaiu: boolean; etiqueta: string; separador: string };
const montar = (inicial: Partial<Props> = {}) =>
  renderHook((props: Props) => useLegendaAoVivo(props), { initialProps: { ativa: true, microfoneCaiu: false, etiqueta: "pt-BR", separador: " ", ...inicial } });

const andar = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
// Só até o religar agendado: a sessão nova começa e falha logo (a sessão curta, sem resultado).
const ateOReligar = () => act(() => { vi.advanceTimersToNextTimer(); });

describe("useLegendaAoVivo (G15b)", () => {
  it("desligada não abre nada; ligar abre o reconhecimento no idioma, contínuo e com o provisório", () => {
    const { result } = montar({ etiqueta: "es-MX" });
    expect(result.current.estado).toBe("desligada");
    expect(falso.criados).toHaveLength(0);
    act(() => result.current.ligar());
    expect(result.current.estado).toBe("ouvindo");
    const atual = falso.atual();
    expect(atual).toMatchObject({ lang: "es-MX", continuous: true, interimResults: true, maxAlternatives: 1, emCurso: true });
  });

  it("os resultados viram linhas e o provisório; a sessão que o navegador encerra religa sozinha, com o texto", () => {
    const { result } = montar();
    act(() => result.current.ligar());
    falso.resultados(["Bom dia a todas.", { texto: "vamos", final: false }]);
    expect(result.current.linhas).toEqual(["Bom dia a todas."]);
    expect(result.current.provisorio).toBe("vamos");
    falso.resultados(["Bom dia a todas.", "Vamos começar pela pauta."]);
    expect(result.current.linhas).toEqual(["Bom dia a todas.", "Vamos começar pela pauta."]);
    expect(result.current.provisorio).toBe("");

    // O navegador encerra a sessão (o silêncio, o tempo): passado o tempo de uma sessão normal, religa em 250 ms.
    andar(5_000);
    falso.encerrar();
    expect(falso.criados).toHaveLength(1);
    andar(250);
    expect(falso.criados).toHaveLength(2);
    expect(falso.atual().emCurso).toBe(true);
    // A sessão nova começa a lista do zero: as linhas de antes ficam.
    falso.resultados(["Primeiro item."]);
    expect(result.current.linhas).toEqual(["Bom dia a todas.", "Vamos começar pela pauta.", "Primeiro item."]);
  });

  it(`o navegador que não atende (sessões curtas sem resultado, ${REINICIOS_RAPIDOS_MAX} seguidas) desliga com o aviso, sem religar em laço`, () => {
    const { result } = montar();
    act(() => result.current.ligar());
    for (let i = 0; i < REINICIOS_RAPIDOS_MAX; i++) {
      falso.errar("network");
      ateOReligar();
    }
    expect(result.current.estado).toBe("desligada");
    expect(result.current.falha).toBe("naoResponde");
    const criados = falso.criados.length;
    andar(60_000);
    expect(falso.criados).toHaveLength(criados);
  });

  it("uma sessão com resultado no meio zera a conta das falhas", () => {
    const { result } = montar();
    act(() => result.current.ligar());
    for (let i = 0; i < REINICIOS_RAPIDOS_MAX - 1; i++) {
      falso.errar("network");
      ateOReligar();
    }
    falso.resultados(["Voltou."]);
    falso.encerrar();
    andar(250);
    for (let i = 0; i < REINICIOS_RAPIDOS_MAX - 1; i++) {
      falso.errar("network");
      ateOReligar();
    }
    expect(result.current.estado).toBe("ouvindo");
    expect(result.current.falha).toBeNull();
  });

  it.each([
    ["not-allowed", "semPermissao"],
    ["service-not-allowed", "servicoRecusado"],
    ["audio-capture", "semMicrofone"],
    ["language-not-supported", "idiomaSemSuporte"],
  ])("o erro %s desliga de vez com a falha %s, e o texto some", (erro, falha) => {
    const { result } = montar();
    act(() => result.current.ligar());
    falso.resultados(["Antes do erro."]);
    falso.errar(erro);
    expect(result.current.estado).toBe("desligada");
    expect(result.current.falha).toBe(falha);
    expect(result.current.linhas).toEqual([]);
    andar(60_000);
    expect(falso.criados).toHaveLength(1);
  });

  it("o silêncio (no-speech) não desliga: o fim da sessão religa", () => {
    const { result } = montar();
    act(() => result.current.ligar());
    andar(8_000);
    falso.errar("no-speech");
    andar(250);
    expect(result.current.estado).toBe("ouvindo");
    expect(falso.criados).toHaveLength(2);
  });

  it("a gravação pausada para de ouvir já (o áudio deixa de ir ao serviço) e guarda o texto; na volta, ouve de novo", () => {
    const { result, rerender } = montar();
    act(() => result.current.ligar());
    falso.resultados(["Antes da pausa.", { texto: "e mais", final: false }]);
    const primeira = falso.atual();
    rerender({ ativa: false, microfoneCaiu: false, etiqueta: "pt-BR", separador: " " });
    expect(primeira.chamadas.abort).toBe(1);
    expect(primeira.emCurso).toBe(false);
    expect(result.current.estado).toBe("pausada");
    expect(result.current.linhas).toEqual(["Antes da pausa."]);
    expect(result.current.provisorio).toBe("");
    andar(60_000);
    expect(falso.criados).toHaveLength(1);
    rerender({ ativa: true, microfoneCaiu: false, etiqueta: "pt-BR", separador: " " });
    expect(result.current.estado).toBe("ouvindo");
    expect(falso.criados).toHaveLength(2);
    expect(falso.atual().emCurso).toBe(true);
  });

  it("ligada com a gravação pausada fica pausada, sem ouvir, até a gravação voltar", () => {
    const { result, rerender } = montar({ ativa: false });
    act(() => result.current.ligar());
    expect(result.current.estado).toBe("pausada");
    expect(falso.criados).toHaveLength(0);
    rerender({ ativa: true, microfoneCaiu: false, etiqueta: "pt-BR", separador: " " });
    expect(falso.criados).toHaveLength(1);
  });

  it("o microfone da gravação que cai desliga a legenda de vez, com o aviso (não religa sozinha na volta)", () => {
    const { result, rerender } = montar();
    act(() => result.current.ligar());
    rerender({ ativa: false, microfoneCaiu: true, etiqueta: "pt-BR", separador: " " });
    expect(result.current.estado).toBe("desligada");
    expect(result.current.falha).toBe("microfoneDaGravacao");
    rerender({ ativa: true, microfoneCaiu: false, etiqueta: "pt-BR", separador: " " });
    expect(result.current.estado).toBe("desligada");
    expect(falso.criados).toHaveLength(1);
  });

  it("desligar solta o reconhecimento e esquece o texto; ligar de novo começa do zero", () => {
    const { result } = montar();
    act(() => result.current.ligar());
    falso.resultados(["Um."]);
    const primeira = falso.atual();
    act(() => result.current.desligar());
    expect(primeira.chamadas.abort).toBe(1);
    expect(result.current).toMatchObject({ estado: "desligada", linhas: [], provisorio: "", falha: null });
    andar(60_000);
    expect(falso.criados).toHaveLength(1);
    act(() => result.current.ligar());
    expect(falso.criados).toHaveLength(2);
    expect(result.current.linhas).toEqual([]);
  });

  it("sair da tela solta o reconhecimento, e nenhum religar chega depois", () => {
    const { result, unmount } = montar();
    act(() => result.current.ligar());
    const atual = falso.atual();
    unmount();
    expect(atual.chamadas.abort).toBe(1);
    andar(60_000);
    expect(falso.criados).toHaveLength(1);
  });

  it("ligar depois de sair da tela (a confirmação que voltou tarde) não abre nada", () => {
    const { result, unmount } = montar();
    const ligar = result.current.ligar;
    unmount();
    act(() => ligar());
    andar(60_000);
    expect(falso.criados).toHaveLength(0);
  });

  it("com a página escondida, a sessão que acaba espera a página voltar, sem contar falha", () => {
    const { result } = montar();
    act(() => result.current.ligar());
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    for (let i = 0; i < REINICIOS_RAPIDOS_MAX + 2; i++) falso.encerrar(falso.atual());
    andar(60_000);
    expect(falso.criados).toHaveLength(1);
    expect(result.current.estado).toBe("ouvindo");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(falso.criados).toHaveLength(2);
    expect(falso.atual().emCurso).toBe(true);
  });

  it("o navegador que recusa o start tenta de novo com espera e, recusando sempre, desliga com o aviso", () => {
    falso.falharNoStart.vezes = 1;
    const { result } = montar();
    act(() => result.current.ligar());
    expect(falso.atual().emCurso).toBe(false);
    andar(500);
    expect(falso.atual().emCurso).toBe(true);
    expect(result.current.estado).toBe("ouvindo");

    act(() => result.current.desligar());
    falso.falharNoStart.vezes = 100;
    act(() => result.current.ligar());
    andar(60_000);
    expect(result.current.estado).toBe("desligada");
    expect(result.current.falha).toBe("naoResponde");
  });

  it(`numa gravação de horas, a memória guarda só as ${LINHAS_DA_LEGENDA_MAX} linhas mais novas`, () => {
    const { result } = montar();
    act(() => result.current.ligar());
    for (let sessao = 0; sessao < 3; sessao++) {
      falso.resultados(Array.from({ length: 100 }, (_, i) => `sessão ${sessao} linha ${i}`));
      andar(5_000);
      falso.encerrar();
      andar(250);
    }
    expect(result.current.linhas).toHaveLength(LINHAS_DA_LEGENDA_MAX);
    expect(result.current.linhas[result.current.linhas.length - 1]).toBe("sessão 2 linha 99");
    expect(result.current.linhas[0]).toBe("sessão 1 linha 0");
  });
});
