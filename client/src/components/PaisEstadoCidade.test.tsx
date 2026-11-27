import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import PaisEstadoCidade, { type LocalEscolhido } from "./PaisEstadoCidade";
import { carregarCidadesDoPais } from "@/lib/busca-de-cidades";

// A cascata país → estado → cidade montada de verdade, com os arquivos de
// cidade reais (client/src/data/cidades/*.json) carregados pelo mesmo
// import.meta.glob da tela. O i18n está fixo em pt-BR (client/src/test/setup.ts),
// então os nomes de país saem do Intl.DisplayNames em português.

function Montagem({
  inicial,
  aoMudar,
}: {
  inicial: LocalEscolhido;
  aoMudar?: (local: LocalEscolhido) => void;
}) {
  const [local, setLocal] = useState(inicial);
  return (
    <PaisEstadoCidade
      pais={local.pais}
      cidade={local.cidade}
      onChange={novo => {
        setLocal(novo);
        aoMudar?.(novo);
      }}
      rotuloDoPais="País"
      rotuloDaCidade="Cidade"
    />
  );
}

const campo = (nome: string) => screen.getByRole("combobox", { name: nome });
const campoDeEstado = () =>
  screen.queryByRole("combobox", { name: "Estado / província" });

/** Digita no campo e escolhe a opção com o rótulo exato. */
async function escolher(nome: string, digitado: string, opcao: string) {
  const alvo = campo(nome);
  fireEvent.focus(alvo);
  fireEvent.change(alvo, { target: { value: digitado } });
  const lista = await screen.findByRole("listbox", { name: nome });
  fireEvent.click(within(lista).getByRole("option", { name: opcao }));
}

describe("PaisEstadoCidade — a cascata", () => {
  // Os arquivos de país chegam por import dinâmico; o primeiro, frio, pode
  // passar do prazo do waitFor numa suíte cheia. Aquecidos aqui, o teste mede
  // a cascata, não o disco.
  beforeAll(async () => {
    await Promise.all(["BR", "PT", "MC"].map(carregarCidadesDoPais));
  }, 30000);

  it("país com estados pede o estado antes e só então libera a cidade daquele estado", async () => {
    const aoMudar = vi.fn();
    render(<Montagem inicial={{ pais: "BR", cidade: "" }} aoMudar={aoMudar} />);

    await waitFor(() => expect(campoDeEstado()).toBeInTheDocument());
    expect(campo("Cidade")).toBeDisabled();
    expect(screen.getByText("Escolha o estado primeiro.")).toBeInTheDocument();

    await escolher("Estado / província", "bahia", "Bahia");
    expect(campo("Cidade")).toBeEnabled();

    fireEvent.focus(campo("Cidade"));
    fireEvent.change(campo("Cidade"), { target: { value: "xique" } });
    const lista = await screen.findByRole("listbox", { name: "Cidade" });
    const opcoes = within(lista)
      .getAllByRole("option")
      .map(o => o.textContent);
    expect(opcoes).toContain("Xique-Xique");
    fireEvent.click(within(lista).getByRole("option", { name: "Xique-Xique" }));

    expect(aoMudar).toHaveBeenLastCalledWith({
      pais: "BR",
      cidade: "Xique-Xique",
    });
    expect(campo("Cidade")).toHaveValue("Xique-Xique");
  });

  it("a busca do estado ignora acento e caixa", async () => {
    render(<Montagem inicial={{ pais: "BR", cidade: "" }} />);
    await waitFor(() => expect(campoDeEstado()).toBeInTheDocument());
    await escolher("Estado / província", "sao pa", "São Paulo");
    expect(campo("Estado / província")).toHaveValue("São Paulo");
  });

  it("país sem estados vai direto à cidade", async () => {
    const aoMudar = vi.fn();
    render(<Montagem inicial={{ pais: "BR", cidade: "" }} aoMudar={aoMudar} />);
    await waitFor(() => expect(campoDeEstado()).toBeInTheDocument());

    // Mônaco tem poucas cidades na lista: o nível do estado não aparece.
    await escolher("País", "monac", "Mônaco");
    await waitFor(() =>
      expect(screen.getByText(/Dados de cidades:/)).toBeInTheDocument()
    );
    expect(campoDeEstado()).not.toBeInTheDocument();
    expect(campo("Cidade")).toBeEnabled();

    await escolher("Cidade", "mona", "Monaco");
    expect(aoMudar).toHaveBeenLastCalledWith({ pais: "MC", cidade: "Monaco" });
  });

  it("país sem lista de cidades aceita a cidade digitada", async () => {
    const aoMudar = vi.fn();
    render(<Montagem inicial={{ pais: "AQ", cidade: "" }} aoMudar={aoMudar} />);
    expect(campoDeEstado()).not.toBeInTheDocument();
    expect(
      screen.getByText("Sem lista para este país: digite o nome da cidade.")
    ).toBeInTheDocument();
    fireEvent.change(campo("Cidade"), { target: { value: "Base McMurdo" } });
    expect(aoMudar).toHaveBeenLastCalledWith({
      pais: "AQ",
      cidade: "Base McMurdo",
    });
  });

  it("trocar o país limpa o estado e a cidade", async () => {
    const aoMudar = vi.fn();
    render(<Montagem inicial={{ pais: "BR", cidade: "" }} aoMudar={aoMudar} />);
    await waitFor(() => expect(campoDeEstado()).toBeInTheDocument());
    await escolher("Estado / província", "bahia", "Bahia");
    await escolher("Cidade", "salvad", "Salvador");
    expect(aoMudar).toHaveBeenLastCalledWith({
      pais: "BR",
      cidade: "Salvador",
    });

    await escolher("País", "portu", "Portugal");
    expect(aoMudar).toHaveBeenLastCalledWith({ pais: "PT", cidade: "" });
    expect(campo("Cidade")).toHaveValue("");
    // O estado do Brasil não sobrevive: em Portugal o campo volta vazio, à espera do distrito.
    await waitFor(() => expect(campoDeEstado()).toBeInTheDocument());
    expect(campoDeEstado()).toHaveValue("");
    expect(campo("Cidade")).toBeDisabled();
  });

  it("trocar o estado limpa a cidade", async () => {
    const aoMudar = vi.fn();
    render(<Montagem inicial={{ pais: "BR", cidade: "" }} aoMudar={aoMudar} />);
    await waitFor(() => expect(campoDeEstado()).toBeInTheDocument());
    await escolher("Estado / província", "bahia", "Bahia");
    await escolher("Cidade", "salvad", "Salvador");
    await escolher("Estado / província", "pern", "Pernambuco");
    expect(aoMudar).toHaveBeenLastCalledWith({ pais: "BR", cidade: "" });
  });

  it("cidade já gravada reabre com o estado deduzido", async () => {
    render(<Montagem inicial={{ pais: "BR", cidade: "Xique-Xique" }} />);
    await waitFor(() => expect(campoDeEstado()).toHaveValue("Bahia"));
    expect(campo("Cidade")).toHaveValue("Xique-Xique");
  });

  it("texto livre antigo, fora da lista, continua aparecendo e editável", async () => {
    render(<Montagem inicial={{ pais: "BR", cidade: "Distrito Inventado" }} />);
    await waitFor(() => expect(campoDeEstado()).toBeInTheDocument());
    expect(campoDeEstado()).toHaveValue("");
    expect(campo("Cidade")).toHaveValue("Distrito Inventado");
    expect(campo("Cidade")).toBeEnabled();
  });

  it("o teclado escolhe: seta para baixo e Enter", async () => {
    const aoMudar = vi.fn();
    render(<Montagem inicial={{ pais: "BR", cidade: "" }} aoMudar={aoMudar} />);
    const pais = campo("País");
    fireEvent.focus(pais);
    fireEvent.change(pais, { target: { value: "argent" } });
    await screen.findByRole("listbox", { name: "País" });
    fireEvent.keyDown(pais, { key: "ArrowDown" });
    expect(pais).toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(pais, { key: "Enter" });
    expect(aoMudar).toHaveBeenLastCalledWith({ pais: "AR", cidade: "" });
  });

  it("o país se acha também pelo nome em inglês", async () => {
    render(<Montagem inicial={{ pais: "BR", cidade: "" }} />);
    await escolher("País", "germany", "Alemanha");
    expect(campo("País")).toHaveValue("Alemanha");
  });
});
