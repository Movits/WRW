import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ResumoDasConexoes, type PropsDoResumo } from "./ResumoDasConexoes";

/**
 * O resumo das conexões do Início em frases (pedido do Nicolas, 25/11): bater o
 * olho e entender. Zero não vira linha, o que falhou não vira "nenhum", e cada
 * linha leva aonde agir.
 */

function resumo(extra: Partial<PropsDoResumo> = {}) {
  const props: PropsDoResumo = {
    listaLiberada: true, sugestoes: 0, sugestoesFalharam: false, conexoesFeitas: 0, pedidosParaResponder: 0,
    aoVerSugestoes: vi.fn(), aoVerConexoes: vi.fn(), ...extra,
  };
  render(<ResumoDasConexoes {...props} />);
  return props;
}

const linhas = () => Array.from(screen.getByRole("region", { name: "Resumo das suas conexões" }).querySelectorAll("li")).map(li => li.textContent);

afterEach(async () => {
  await i18n.changeLanguage("pt-BR");
});

describe("ResumoDasConexoes", () => {
  it("tudo em zero: uma linha só, sem botão, e nenhum '0' na tela", () => {
    resumo();
    expect(linhas()).toEqual(["Nenhuma sugestão nova por enquantoQuando alguém combinar com você, aparece aqui"]);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/\b0\b/)).not.toBeInTheDocument();
  });

  it("a ordem: o pedido para responder, as sugestões e as conexões feitas, cada um com o seu toque", () => {
    const props = resumo({ pedidosParaResponder: 1, sugestoes: 5, combinamMuito: 2, afinidadeMedia: 71, conexoesFeitas: 3 });
    expect(linhas()).toEqual([
      "1 pessoa quer se conectar com vocêResponder",
      "5 pessoas combinam com você2 delas combinam muitoVer",
      "3 conexões feitasAbrir",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Ver: 5 pessoas combinam com você" }));
    expect(props.aoVerSugestoes).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Abrir: 3 conexões feitas" }));
    fireEvent.click(screen.getByRole("button", { name: "Responder: 1 pessoa quer se conectar com você" }));
    expect(props.aoVerConexoes).toHaveBeenCalledTimes(2);
  });

  it("carregando: guarda o lugar, sem frase nenhuma; a consulta que falhou diz que não carregou", () => {
    const { unmount } = render(<ResumoDasConexoes listaLiberada sugestoes={undefined} sugestoesFalharam={false} conexoesFeitas={undefined}
      pedidosParaResponder={0} aoVerSugestoes={vi.fn()} aoVerConexoes={vi.fn()} />);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    unmount();

    resumo({ sugestoes: undefined, sugestoesFalharam: true, conexoesFeitas: undefined });
    expect(linhas()).toEqual(["Não deu para carregar suas sugestões agoraVer"]);
  });

  it("em árabe: o plural do árabe nas frases", async () => {
    await i18n.changeLanguage("ar");
    resumo({ sugestoes: 2, conexoesFeitas: 11 });
    expect(screen.getByText("شخصان يناسبانك")).toBeInTheDocument();
    expect(screen.getByText("تم 11 اتصالًا")).toBeInTheDocument();
  });
});
