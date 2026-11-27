import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardarDescarte } from "@/lib/descartes-pendentes";
import { guardarParte, partesGuardadas, type ParteNoAparelho } from "@/lib/partes-no-aparelho";
import { sessaoOcupada } from "@/lib/sessao-ocupada";
import { indexedDBEmMemoria } from "@/test/indexeddb-em-memoria";
import { useSairDaConta } from "./SairDaConta";

/**
 * T19, passo 3 (teste do Gabriel no iPhone, 26/11/2026): em modo avião, com a
 * gravação em partes já encerrada e uma parte ainda no aparelho (IndexedDB), o
 * Sair do menu deslogou sem perguntar, e o logout apagou a parte
 * (liberarTodas). O Sair só olhava o registro da sessão ocupada, na memória,
 * que depende de uma contagem do aparelho que pode estar atrasada ou ter
 * falhado. Aqui o registro está livre de propósito, e a parte está no
 * aparelho: o Sair tem de perguntar a ele antes de sair.
 */

const parte = (meetingId: string, seq = 0, dona = "dona-1"): ParteNoAparelho => ({
  meetingId, seq, dona, blob: new Blob(["som"], { type: "audio/mp4" }), mimeType: "audio/mp4", duracaoMs: 600_000, guardadaEm: 1,
});

function BotaoDeSair({ sair }: { sair: () => void }) {
  const { pedirSaida, dialogo } = useSairDaConta(sair);
  return <><button onClick={pedirSaida}>Sair da conta</button>{dialogo}</>;
}

const clicarEmSair = () => fireEvent.click(screen.getByRole("button", { name: "Sair da conta" }));

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("indexedDB", indexedDBEmMemoria());
  expect(sessaoOcupada()).toBe(false);
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("useSairDaConta — o áudio que está só no aparelho (T19)", () => {
  it("com a sessão livre na memória e uma parte no aparelho, pergunta antes de sair, e 'Continuar aqui' guarda a parte", async () => {
    await guardarParte(parte("r-1"));
    const sair = vi.fn();
    render(<BotaoDeSair sair={sair} />);
    clicarEmSair();
    const caixa = await screen.findByRole("alertdialog", { name: "Sair agora?" });
    expect(caixa).toHaveAccessibleDescription("Há um áudio gravado nesta aba que ainda não foi enviado. Se sair agora, esse áudio se perde.");
    expect(sair).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continuar aqui" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(sair).not.toHaveBeenCalled();
    expect(await partesGuardadas("dona-1")).toHaveLength(1);
  });

  it("'Sair mesmo assim' sai uma vez só", async () => {
    await guardarParte(parte("r-1"));
    const sair = vi.fn();
    render(<BotaoDeSair sair={sair} />);
    clicarEmSair();
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Sair mesmo assim" }));
    expect(sair).toHaveBeenCalledTimes(1);
  });

  it("a parte de outra conta também conta: o Sair apaga todas as do aparelho", async () => {
    await guardarParte(parte("r-9", 0, "outra-dona"));
    const sair = vi.fn();
    render(<BotaoDeSair sair={sair} />);
    clicarEmSair();
    await screen.findByRole("alertdialog");
    expect(sair).not.toHaveBeenCalled();
  });

  it("sem nada no aparelho, sai sem diálogo; o segundo toque durante a conferência não sai de novo", async () => {
    const sair = vi.fn();
    render(<BotaoDeSair sair={sair} />);
    clicarEmSair();
    clicarEmSair();
    await waitFor(() => expect(sair).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("a cópia da gravação descartada não segura o Sair", async () => {
    await guardarParte(parte("r-1"));
    guardarDescarte("r-1", "dona-1");
    const sair = vi.fn();
    render(<BotaoDeSair sair={sair} />);
    clicarEmSair();
    await waitFor(() => expect(sair).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("o aparelho ilegível (o IndexedDB que não abre): na dúvida, pergunta", async () => {
    vi.stubGlobal("indexedDB", { open: () => { throw new Error("Connection to Indexed Database server lost"); } });
    const sair = vi.fn();
    render(<BotaoDeSair sair={sair} />);
    clicarEmSair();
    await screen.findByRole("alertdialog");
    expect(sair).not.toHaveBeenCalled();
  });
});
