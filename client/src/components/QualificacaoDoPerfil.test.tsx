import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { QualificacaoDoPerfil } from "./QualificacaoDoPerfil";

/**
 * Governança (14/09/2026): a membra Bronze vê, item a item, o que falta para
 * a Prata — pela MESMA régua que o servidor aplica ao salvar
 * (shared/qualificacao-do-perfil.ts). Prata, Ouro e staff não veem o cartão.
 */

const QUALIFICADO = {
  displayName: "Ana Souza",
  city: "Lisboa",
  activityArea: "Comércio exterior",
  bio: "Advogada tributarista, atendo empresas familiares que exportam café para a Europa.",
  whatIHave: ["canais_comerciais"],
  whatINeed: ["fornecedores"],
};

afterEach(async () => {
  await i18n.changeLanguage("pt-BR");
});

describe("QualificacaoDoPerfil", () => {
  it.each(["silver", "gold", "president", "admin", undefined])("%s não vê o cartão", (role) => {
    const { container } = render(<QualificacaoDoPerfil role={role} perfil={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("Bronze com perfil incompleto vê exatamente o que falta, e que não há mensalidade", () => {
    render(<QualificacaoDoPerfil role="bronze" perfil={{ ...QUALIFICADO, bio: "empresa empresa empresa", whatINeed: [] }} />);

    expect(screen.getByRole("heading", { name: "Membro Bronze: seu perfil está em qualificação" })).toBeInTheDocument();
    const itens = screen.getAllByRole("listitem").map(li => li.textContent);
    expect(itens).toEqual([
      "Apresentação: 1 de 6 palavras de conteúdo diferentes, e o texto ainda repete muito — acrescente coisas novas, com palavras diferentes",
      "Pelo menos um item em O que preciso",
    ]);
    expect(screen.getByText(/não têm mensalidade/)).toBeInTheDocument();
  });

  it("a apresentação recusada mostra a contagem da régua, não só o mínimo (revisão da #135, item 8)", () => {
    // 7 palavras escritas, 5 de conteúdo: a membra lia "pelo menos 6" e não entendia.
    const { rerender } = render(<QualificacaoDoPerfil role="bronze" perfil={{ ...QUALIFICADO, bio: "Consultora de marketing digital para pequenas empresas" }} />);
    expect(screen.getByRole("listitem")).toHaveTextContent("Apresentação: 5 de 6 palavras de conteúdo diferentes; palavras curtas como 'de' e 'para', e as repetidas, não contam");

    // Seis palavras diferentes, mas mais repetição que conteúdo: a recusa é por
    // repetição, e agora o texto diz isso — antes repetia "pelo menos 6 palavras"
    // para quem tinha escrito 18 (validação de 16/09 na #135).
    const repetitiva = "vendas vendas vendas marketing marketing marketing digital digital digital varejo varejo varejo moda moda moda luxo luxo luxo";
    rerender(<QualificacaoDoPerfil role="bronze" perfil={{ ...QUALIFICADO, bio: repetitiva }} />);
    expect(screen.getByRole("listitem")).toHaveTextContent("o texto repete muito as mesmas palavras");
    // O texto da repetição não pode reapresentar a contagem de palavras
    // DIFERENTES como se fossem elas que se repetem: era a contradição entre
    // os dois textos novos.
    expect(screen.getByRole("listitem")).not.toHaveTextContent("6 palavras de conteúdo, mas");

    // Campo vazio continua com o texto geral, que é o único que cabe ali.
    rerender(<QualificacaoDoPerfil role="bronze" perfil={{ ...QUALIFICADO, bio: "" }} />);
    expect(screen.getByRole("listitem")).toHaveTextContent("Uma apresentação com pelo menos 6 palavras que digam quem você é e o que faz");
  });

  it("quando faltam palavras E o texto se repete, a tela diz os dois motivos de uma vez", () => {
    // O caso do relato: 5 palavras diferentes em cinco frases quase iguais.
    // Dizendo só "5 de 6", quem escreve acrescenta uma palavra e leva uma
    // segunda recusa sem aviso (validação de 16/09 na #135, item 8).
    const doRelato = "Aulas de inglês. Aulas de inglês para crianças. Aulas de inglês para adultos. Aulas de inglês online. Aulas de inglês.";
    render(<QualificacaoDoPerfil role="bronze" perfil={{ ...QUALIFICADO, bio: doRelato }} />);

    const linha = screen.getByRole("listitem");
    expect(linha).toHaveTextContent("5 de 6 palavras de conteúdo diferentes");
    expect(linha).toHaveTextContent("ainda repete muito");
  });

  it("texto escrito que não conta nenhuma palavra mostra a contagem, não o texto geral", () => {
    // Dez palavras escritas, zero de conteúdo. O texto geral aqui é justamente
    // a recusa sem explicação que o item 8 condena.
    render(<QualificacaoDoPerfil role="bronze" perfil={{ ...QUALIFICADO, bio: "Sou eu, e é tudo o que tenho por aqui." }} />);

    const linha = screen.getByRole("listitem");
    expect(linha).toHaveTextContent("0 de 6 palavras de conteúdo diferentes");
    expect(linha).not.toHaveTextContent("Uma apresentação com pelo menos");
  });

  it("Bronze sem perfil nenhum vê as seis pendências", () => {
    render(<QualificacaoDoPerfil role="bronze" perfil={null} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
  });

  it("Bronze com perfil que já atende: sem lista, com o convite a salvar", () => {
    render(<QualificacaoDoPerfil role="bronze" perfil={QUALIFICADO} />);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText(/já atende aos critérios de Membro Prata/)).toBeInTheDocument();
  });

  it("o botão abre a edição; sem onCompletar (já editando), não há botão", () => {
    const onCompletar = vi.fn();
    const { rerender } = render(<QualificacaoDoPerfil role="bronze" perfil={null} onCompletar={onCompletar} />);
    fireEvent.click(screen.getByRole("button", { name: "Completar perfil" }));
    expect(onCompletar).toHaveBeenCalledTimes(1);

    rerender(<QualificacaoDoPerfil role="bronze" perfil={null} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("acompanha o idioma", async () => {
    await i18n.changeLanguage("en");
    render(<QualificacaoDoPerfil role="bronze" perfil={{ ...QUALIFICADO, city: "" }} />);
    expect(screen.getByRole("heading", { name: "Bronze Member: your profile is being qualified" })).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent("City");
  });

  it("o título tem tamanho próprio: sem ele, herda o tamanho global de h2 e engole o cartão", () => {
    // Visto a 375 px no Painel da Bronze (U3, 19/11): o título ocupava quatro
    // linhas em letra de manchete. O tamanho é o dos títulos de seção do Perfil.
    render(<QualificacaoDoPerfil role="bronze" perfil={{}} />);
    expect(screen.getByRole("heading", { name: "Membro Bronze: seu perfil está em qualificação" })).toHaveClass("text-base");
  });
});
