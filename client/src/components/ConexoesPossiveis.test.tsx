import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConexoesPossiveis, type ConsultaDasConexoesPossiveis } from "./ConexoesPossiveis";

/**
 * U3: o bloco que a Bronze vê no Painel no lugar da lista das conexões
 * sugeridas. A tela inteira (os níveis, os indicadores, o árabe) está em
 * pages/Dashboard.conexoes-possiveis.test.tsx; aqui ficam os estados do bloco.
 */

/** Atende à régua da Prata (shared/qualificacao-do-perfil.ts): Quem sou, O que tenho e O que preciso. */
const PERFIL_QUALIFICADO = {
  displayName: "Ana Souza",
  city: "Lisboa",
  primarySpecialty: "Exportação de vinhos",
  bio: "Exporto vinhos portugueses para distribuidores europeus há quinze anos com equipe própria",
  whatIHave: ["Vinho do Porto"],
  whatINeed: ["Distribuidores na Alemanha"],
};

const consulta = (parcial: Partial<ConsultaDasConexoesPossiveis> = {}): ConsultaDasConexoesPossiveis => ({
  data: { total: 4, listaLiberada: false },
  isError: false,
  refetch: vi.fn(),
  ...parcial,
});

function renderizar(props: Partial<Parameters<typeof ConexoesPossiveis>[0]> = {}) {
  const aoBuscar = vi.fn();
  render(<ConexoesPossiveis consulta={consulta()} role="bronze" perfil={{}} aoBuscar={aoBuscar} buscando={false} {...props} />);
  return { aoBuscar };
}

describe("ConexoesPossiveis (U3)", () => {
  it("carregando: nenhum número, nem zero, e nada para clicar", () => {
    renderizar({ consulta: consulta({ data: undefined }) });
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("o número, de onde ele vem e o botão que roda o motor de novo", () => {
    const { aoBuscar } = renderizar();
    expect(screen.getByRole("heading", { name: "Há 4 conexões possíveis para você" })).toBeInTheDocument();
    expect(screen.getByText(/O número vem da última análise do seu perfil/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Buscar novas conexões sugeridas" }));
    expect(aoBuscar).toHaveBeenCalledTimes(1);
  });

  it("enquanto o motor roda, o botão fica desligado e diz isso", () => {
    renderizar({ buscando: true });
    expect(screen.getByRole("button", { name: "Analisando..." })).toBeDisabled();
  });

  it("perfil que já atende à régua: o cartão manda salvar, sem lista de pendências", () => {
    renderizar({ perfil: PERFIL_QUALIFICADO });
    expect(screen.getByText(/Salve o perfil para concluir a mudança/)).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  // Etapa 13 (revisão do pacote do match, 20/11): a Bronze que aceitou o termo e
  // cujas conexões esperam o outro lado aceitar via o vazio errado.
  it("zero possíveis com conexões esperando o termo do outro lado: a causa é a rede, não o perfil", () => {
    renderizar({ consulta: consulta({ data: { total: 0, listaLiberada: false } }), ocultas: 3 });
    expect(screen.getByRole("heading", { name: "Suas conexões estão a caminho" })).toBeInTheDocument();
    expect(screen.getByText(/esses membros ainda não autorizaram/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Ainda não há conexões possíveis para você" })).not.toBeInTheDocument();
    expect(screen.queryByText(/quanto mais completo ele estiver/)).not.toBeInTheDocument();
  });

  it("zero possíveis e nenhuma esperando: diz que não há, e convida a completar o perfil", () => {
    renderizar({ consulta: consulta({ data: { total: 0, listaLiberada: false } }), ocultas: 0 });
    expect(screen.getByRole("heading", { name: "Ainda não há conexões possíveis para você" })).toBeInTheDocument();
    expect(screen.getByText(/quanto mais completo ele estiver/)).toBeInTheDocument();
  });

  it("com conexões possíveis, o número vale mesmo havendo outras esperando o termo", () => {
    renderizar({ ocultas: 2 });
    expect(screen.getByRole("heading", { name: "Há 4 conexões possíveis para você" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Suas conexões estão a caminho" })).not.toBeInTheDocument();
  });
});
