import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTERVALO_DA_TRANSCRICAO_AO_VIVO_MS, partesResolvidas, TranscricaoDuranteAGravacao } from "./TranscricaoDuranteAGravacao";

/**
 * A transcrição durante a gravação (G15a) na tela. A consulta ao servidor é um
 * dublê (o que ele lê e de quem está em
 * server/transcricao-durante-a-gravacao.integracao.test.ts); o Pergunte vira
 * um marcador com as props que recebeu (o dele está em ReuniaoComIA.test.tsx).
 * O setTimeout é falso: as voltas de 15 s passam sem esperar.
 */
const duble = vi.hoisted(() => ({ consultar: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  trpc: { useUtils: () => duble.utils },
}));
vi.mock("./ReuniaoComIA", () => ({
  PergunteAReuniao: (props: { meetingId: string; duranteAGravacao?: boolean; nomes?: Record<string, string> }) =>
    <div data-testid="pergunte">{props.meetingId} {String(props.duranteAGravacao)} {JSON.stringify(props.nomes)}</div>,
}));
// O mesmo objeto a cada render, como o useUtils do tRPC.
(duble as unknown as { utils: unknown }).utils = { client: { meetings: { transcricaoDaGravacao: { query: (...args: unknown[]) => duble.consultar(...args) } } } };

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const AGORA = 1_800_000_000_000;
const parte = (seq: number, estado: string, extra: Record<string, unknown> = {}) => ({
  seq, estado, inicioSegundos: seq * 600, duracaoSegundos: 600, chegouEm: AGORA - 40_000, prontaEm: null, atrasoSegundos: null, ...extra,
});
const leitura = (extra: Record<string, unknown> = {}) => ({ status: "recording", emPartes: true, agora: AGORA, partes: [], falas: [], nomes: {}, ...extra });
const erroDoServidor = (code: string) => Object.assign(new Error(code), { data: { code } });

/** As promessas da consulta e do estado andam. */
async function andar(ms = 0) {
  await act(async () => {
    if (ms) vi.advanceTimersByTime(ms);
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("TranscricaoDuranteAGravacao (G15a)", () => {
  it("cada parte com o andamento e, a pronta, com o atraso e o texto, com o nome que a dona deu à voz", async () => {
    duble.consultar.mockResolvedValue(leitura({
      partes: [
        parte(0, "transcrita", { atrasoSegundos: 75 }),
        parte(1, "na_fila"),
        parte(2, "transcrevendo"),
        parte(3, "enviando"),
        parte(4, "falhou"),
      ],
      falas: [{ seq: 0, segmentos: [
        { inicio: 3, fim: 9, falante: "F1", texto: "Bom dia, vamos começar." },
        { inicio: 12, fim: 14, falante: "F2", texto: "[música]" },
        { inicio: 15, fim: 20, falante: "", texto: "", lacuna: true },
      ] }],
      nomes: { F1: "Ana" },
    }));
    render(<TranscricaoDuranteAGravacao meetingId={ID} gravando/>);
    await andar();
    expect(duble.consultar).toHaveBeenCalledWith({ meetingId: ID, desde: 0 });
    expect(screen.getByRole("heading", { name: "Transcrição até agora" })).toBeInTheDocument();
    expect(screen.getByText("Parte 1 · 00:00–10:00")).toBeInTheDocument();
    expect(screen.getByText(/texto pronto 1 min 15 s depois de a parte chegar/)).toBeInTheDocument();
    expect(screen.getByText("Ana · 00:03")).toBeInTheDocument();
    expect(screen.getByText("Bom dia, vamos começar.")).toBeInTheDocument();
    // A marca sem fala não leva voz; a lacuna nem aparece.
    expect(screen.getByText("00:12")).toBeInTheDocument();
    expect(screen.getByText(/na fila da transcrição há 40 s/)).toBeInTheDocument();
    expect(screen.getByText(/sendo transcrita/)).toBeInTheDocument();
    expect(screen.getByText(/subindo/)).toBeInTheDocument();
    expect(screen.getByText(/não foi possível transcrever esta parte/)).toBeInTheDocument();
    expect(screen.getByText("A parte que está sendo gravada agora aparece aqui alguns minutos depois de fechar.")).toBeInTheDocument();
  });

  it("pergunta de novo a cada 15 s só pelo texto que falta (desde) e para quando a reunião deixa de estar em andamento", async () => {
    duble.consultar.mockResolvedValueOnce(leitura({
      partes: [parte(0, "transcrita", { atrasoSegundos: 30 }), parte(1, "na_fila")],
      falas: [{ seq: 0, segmentos: [{ inicio: 1, fim: 4, falante: "F1", texto: "Primeira parte." }] }],
    }));
    render(<TranscricaoDuranteAGravacao meetingId={ID}/>);
    await andar();
    expect(duble.consultar).toHaveBeenCalledTimes(1);
    duble.consultar.mockResolvedValueOnce(leitura({
      partes: [parte(0, "transcrita", { atrasoSegundos: 30 }), parte(1, "transcrita", { atrasoSegundos: 50 })],
      falas: [{ seq: 1, segmentos: [{ inicio: 601, fim: 604, falante: "F2", texto: "Segunda parte." }] }],
    }));
    await andar(INTERVALO_DA_TRANSCRICAO_AO_VIVO_MS);
    expect(duble.consultar).toHaveBeenLastCalledWith({ meetingId: ID, desde: 1 });
    // O texto da primeira continua: a resposta só trouxe o da segunda.
    expect(screen.getByText("Primeira parte.")).toBeInTheDocument();
    expect(screen.getByText("Segunda parte.")).toBeInTheDocument();
    duble.consultar.mockResolvedValueOnce(leitura({ status: "ready", partes: [], falas: [] }));
    await andar(INTERVALO_DA_TRANSCRICAO_AO_VIVO_MS);
    expect(duble.consultar).toHaveBeenLastCalledWith({ meetingId: ID, desde: 2 });
    await andar(3 * INTERVALO_DA_TRANSCRICAO_AO_VIVO_MS);
    expect(duble.consultar).toHaveBeenCalledTimes(3);
  });

  it("a consulta que falha não apaga o que está na tela: avisa e tenta de novo na volta seguinte", async () => {
    duble.consultar.mockResolvedValueOnce(leitura({
      partes: [parte(0, "transcrita", { atrasoSegundos: 30 })],
      falas: [{ seq: 0, segmentos: [{ inicio: 1, fim: 4, falante: "F1", texto: "Já transcrito." }] }],
    }));
    render(<TranscricaoDuranteAGravacao meetingId={ID}/>);
    await andar();
    duble.consultar.mockRejectedValueOnce(erroDoServidor("INTERNAL_SERVER_ERROR"));
    await andar(INTERVALO_DA_TRANSCRICAO_AO_VIVO_MS);
    expect(screen.getByRole("status")).toHaveTextContent("Não foi possível atualizar a transcrição agora.");
    expect(screen.getByText("Já transcrito.")).toBeInTheDocument();
    duble.consultar.mockResolvedValueOnce(leitura({ partes: [parte(0, "transcrita", { atrasoSegundos: 30 })] }));
    await andar(INTERVALO_DA_TRANSCRICAO_AO_VIVO_MS);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("Já transcrito.")).toBeInTheDocument();
  });

  it("a reunião que não existe mais (NOT_FOUND): o painel sai e não pergunta de novo", async () => {
    duble.consultar.mockRejectedValue(erroDoServidor("NOT_FOUND"));
    const { container } = render(<TranscricaoDuranteAGravacao meetingId={ID}/>);
    await andar();
    expect(container).toBeEmptyDOMElement();
    await andar(3 * INTERVALO_DA_TRANSCRICAO_AO_VIVO_MS);
    expect(duble.consultar).toHaveBeenCalledTimes(1);
  });

  it("o Pergunte sobre o que já foi dito só aparece com texto e quando pedido, no modo da gravação e com os nomes das vozes", async () => {
    duble.consultar.mockResolvedValue(leitura({ partes: [parte(0, "na_fila")] }));
    const { unmount } = render(<TranscricaoDuranteAGravacao meetingId={ID} comPergunta/>);
    await andar();
    expect(screen.queryByTestId("pergunte")).not.toBeInTheDocument();
    unmount();
    duble.consultar.mockResolvedValue(leitura({
      partes: [parte(0, "transcrita", { atrasoSegundos: 10 })],
      falas: [{ seq: 0, segmentos: [{ inicio: 1, fim: 4, falante: "F1", texto: "Algo dito." }] }],
      nomes: { F1: "Ana" },
    }));
    const segundo = render(<TranscricaoDuranteAGravacao meetingId={ID}/>);
    await andar();
    expect(screen.queryByTestId("pergunte")).not.toBeInTheDocument();
    segundo.unmount();
    render(<TranscricaoDuranteAGravacao meetingId={ID} comPergunta/>);
    await andar();
    expect(screen.getByTestId("pergunte")).toHaveTextContent(`${ID} true {"F1":"Ana"}`);
  });

  it("sem nenhuma parte ainda: gravando, diz quando a primeira fecha; fora do gravador, que nada chegou", async () => {
    duble.consultar.mockResolvedValue(leitura());
    const { unmount } = render(<TranscricaoDuranteAGravacao meetingId={ID} gravando/>);
    await andar();
    expect(screen.getByText("Ainda não há texto: a primeira parte fecha aos 10 minutos de gravação.")).toBeInTheDocument();
    unmount();
    render(<TranscricaoDuranteAGravacao meetingId={ID}/>);
    await andar();
    expect(screen.getByText("Ainda não chegou nenhuma parte da gravação.")).toBeInTheDocument();
  });
});

describe("partesResolvidas", () => {
  it("conta o começo contínuo de partes com o texto na tela ou sem texto de vez; a que falta ou espera interrompe", () => {
    const partes = [
      { seq: 0, estado: "transcrita" as const },
      { seq: 1, estado: "falhou" as const },
      { seq: 2, estado: "transcrita" as const },
      { seq: 3, estado: "na_fila" as const },
    ];
    expect(partesResolvidas(partes, new Set([0, 2]))).toBe(3);
    // A transcrita cujo texto ainda não chegou à tela não conta.
    expect(partesResolvidas(partes, new Set([0]))).toBe(2);
    expect(partesResolvidas([{ seq: 1, estado: "transcrita" }], new Set([1]))).toBe(0);
    expect(partesResolvidas([], new Set())).toBe(0);
  });
});
