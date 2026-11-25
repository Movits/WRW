import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import PainelDaEntidade from "./PainelDaEntidade";

/**
 * O painel da entidade (a base das associações, N1), com o tRPC dublado:
 * a lista com código, nome e documento e a busca que vai ao servidor; a
 * planilha lida no aparelho e mandada em blocos (ensaio primeiro, importar
 * depois); a coluna proibida que recusa o arquivo; o convite com o texto
 * pronto; o link de ativação de cada empresa (N3) e a planilha dos links que
 * faltam; e o convênio inativo, que para importação e convite. Em árabe, a
 * tela traduz e o documento fica da esquerda para a direita.
 */
const duble = vi.hoisted(() => ({
  minha: vi.fn(), membros: vi.fn(), convite: vi.fn(),
  pedidos: vi.fn(), decidir: vi.fn(),
  iniciar: vi.fn(), bloco: vi.fn(), concluir: vi.fn(), contato: vi.fn(), gerar: vi.fn(), revogar: vi.fn(),
  links: vi.fn(), dataDosLinks: undefined as unknown,
  utils: { entidades: { membros: { invalidate: vi.fn() }, minha: { invalidate: vi.fn() }, convite: { invalidate: vi.fn() }, pedidos: { invalidate: vi.fn() } } },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/trpc", () => {
  const mutacao = (fn: ReturnType<typeof vi.fn>) => ({
    useMutation: () => ({ mutateAsync: fn, mutate: fn, isPending: false, data: undefined }),
  });
  return {
    trpc: {
      useUtils: () => duble.utils,
      entidades: {
        minha: { useQuery: () => duble.minha() },
        membros: { useQuery: (entrada: unknown) => duble.membros(entrada) },
        convite: { useQuery: () => duble.convite() },
        pedidos: { useQuery: (entrada: unknown) => duble.pedidos(entrada) },
        decidirPedido: mutacao(duble.decidir),
        iniciarImportacao: mutacao(duble.iniciar),
        importarBloco: mutacao(duble.bloco),
        concluirImportacao: mutacao(duble.concluir),
        contatoDoMembro: mutacao(duble.contato),
        gerarConvite: mutacao(duble.gerar),
        revogarConvite: mutacao(duble.revogar),
        gerarLinksDeAtivacao: { useMutation: () => ({ mutateAsync: duble.links, mutate: duble.links, isPending: false, data: duble.dataDosLinks }) },
      },
    },
  };
});

const consulta = (data: unknown) => ({ data, isLoading: false, error: null, refetch: vi.fn() });
const MINHA = {
  nome: "Associação Teste", tipo: "associacao", pais: "BR", documento: "cnpj", convenioVigente: true, convenioFim: null,
  disponivelPorPadrao: true, membros: { importados: 2, ativados: 0 },
};
const MEMBROS = {
  total: 2, pagina: 0, porPagina: 50,
  membros: [
    { id: 1, codigo: "NW-AB12CD", nome: "Empresa Um", documento: "11.222.333/0001-81", estado: "importado", uf: "SP", cnaePrincipal: null, disponivel: true, temContato: true },
    { id: 2, codigo: "NW-00FF11", nome: "Empresa Dois", documento: "12.ABC.345/01DE-35", estado: "importado", uf: null, cnaePrincipal: null, disponivel: true, temContato: false },
  ],
};

function arquivo(nome: string, texto: string) {
  const f = new File([texto], nome, { type: "text/csv" });
  // O jsdom não tem File.arrayBuffer em todas as versões.
  Object.defineProperty(f, "arrayBuffer", { value: async () => new TextEncoder().encode(texto).buffer });
  return f;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  duble.minha.mockReturnValue(consulta(MINHA));
  duble.membros.mockReturnValue(consulta(MEMBROS));
  duble.convite.mockReturnValue(consulta(null));
  duble.pedidos.mockReturnValue(consulta({ total: 0, abertos: 0, pagina: 0, porPagina: 30, pedidos: [] }));
  duble.iniciar.mockResolvedValue({ importacaoId: 7 });
  duble.bloco.mockImplementation(async ({ linhas }: { linhas: unknown[] }) => ({ processadas: linhas.length, criados: linhas.length, atualizados: 0, recusados: 0, comAviso: 0, problemas: [] }));
  duble.concluir.mockResolvedValue({});
});
afterEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  duble.dataDosLinks = undefined;
  await i18n.changeLanguage("pt-BR");
});

describe("PainelDaEntidade", () => {
  it("lista código, nome e documento; a busca espera a digitação e vai ao servidor", async () => {
    render(<PainelDaEntidade />);
    expect(screen.getByRole("heading", { name: "Associação Teste" })).toBeInTheDocument();
    expect(screen.getByText("NW-AB12CD")).toBeInTheDocument();
    expect(screen.getByText("11.222.333/0001-81")).toBeInTheDocument();
    expect(screen.getByText("Empresa Dois")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "dois" } });
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(duble.membros).toHaveBeenLastCalledWith({ busca: "dois", pagina: 0 });
  });

  it("o contato só aparece sob pedido, e só para quem tem contato guardado", () => {
    render(<PainelDaEntidade />);
    const botoes = screen.getAllByRole("button", { name: "Ver contato" });
    expect(botoes).toHaveLength(1);
    fireEvent.click(botoes[0]);
    expect(duble.contato).toHaveBeenCalledWith({ membroId: 1 });
  });

  it("a planilha: o ensaio manda as linhas mapeadas em bloco, e só depois dele a importação libera", async () => {
    render(<PainelDaEntidade />);
    const csv = "Razão Social;CNPJ;O que precisa;Observação\nEmpresa Um;11.222.333/0001-81;Embalagens;nota interna\n";
    fireEvent.change(document.getElementById("arquivo-da-entidade")!, { target: { files: [arquivo("base.csv", csv)] } });
    await screen.findByText("base.csv: 1 linhas");
    const importar = screen.getByRole("button", { name: "Importar" });
    expect(importar).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Conferir (ensaio)" }));
    await waitFor(() => expect(duble.concluir).toHaveBeenCalledWith({ importacaoId: 7 }));
    expect(duble.iniciar).toHaveBeenCalledWith(expect.objectContaining({ modo: "ensaio", totalLinhas: 1, arquivoSha256: expect.stringMatching(/^[0-9a-f]{64}$/) }));
    // A coluna desconhecida (a observação) não sai do aparelho.
    expect(duble.bloco).toHaveBeenCalledWith({ importacaoId: 7, inicio: 0, linhas: [{ nome: "Empresa Um", documento: "11.222.333/0001-81", o_que_precisa: "Embalagens" }] });
    await waitFor(() => expect(screen.getByRole("button", { name: "Importar" })).toBeEnabled());
    expect(screen.getByText(/Ensaio: 1 de 1 linhas · 1 novas/)).toBeInTheDocument();
  });

  it("coluna de CPF recusa o arquivo, sem chamar o servidor", async () => {
    render(<PainelDaEntidade />);
    fireEvent.change(document.getElementById("arquivo-da-entidade")!, { target: { files: [arquivo("base.csv", "cnpj;nome;CPF\n1;A;2\n")] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("CPF");
    expect(duble.iniciar).not.toHaveBeenCalled();
  });

  it("o convite mostra o link e o texto pronto para o WhatsApp", () => {
    duble.convite.mockReturnValue(consulta({ token: "tok_ABCDEFGHIJKLMNOPQRSTUVWX", geradoEm: 1 }));
    render(<PainelDaEntidade />);
    expect(screen.getByText(`${window.location.origin}/convite/tok_ABCDEFGHIJKLMNOPQRSTUVWX`)).toBeInTheDocument();
    const whatsapp = screen.getByRole("link", { name: "Mandar pelo WhatsApp" });
    expect(decodeURIComponent(whatsapp.getAttribute("href")!)).toContain("Associação Teste convida a sua empresa para o Marquesa Global Match");
  });

  it("convênio inativo: aviso, e importação e convite parados", () => {
    duble.minha.mockReturnValue(consulta({ ...MINHA, convenioVigente: false }));
    render(<PainelDaEntidade />);
    expect(screen.getByRole("status")).toHaveTextContent("não está ativo");
    expect(screen.getByRole("button", { name: "Gerar o link de convite" })).toBeDisabled();
    expect(document.getElementById("arquivo-da-entidade")).toBeDisabled();
  });

  it("conta sem entidade: a mensagem traduzida, sem a lista", () => {
    duble.minha.mockReturnValue({ data: undefined, isLoading: false, error: { message: "ENTIDADE_NAO_ENCONTRADA" }, refetch: vi.fn() });
    render(<PainelDaEntidade />);
    expect(screen.getByRole("alert")).toHaveTextContent("Esta conta não é de uma entidade.");
    expect(duble.membros).not.toHaveBeenCalled();
  });

  it("em árabe, a tela traduz e o documento fica da esquerda para a direita", async () => {
    await i18n.changeLanguage("ar");
    render(<PainelDaEntidade />);
    expect(screen.getByRole("heading", { name: "الأعضاء" })).toBeInTheDocument();
    expect(screen.getByText("11.222.333/0001-81")).toHaveAttribute("dir", "ltr");
  });

  it("N3: o link de ativação de uma empresa sai uma vez, com o aviso e o texto pronto para copiar", async () => {
    duble.dataDosLinks = { links: [{ membroId: 1, codigo: "NW-AB12CD", nome: "Empresa Um", referencia: null, token: "tok_ATIVACAOABCDEFGHIJKLMN", expiraEm: Date.UTC(2026, 11, 25, 12) }], proximo: null };
    const escrever = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: escrever }, configurable: true });
    render(<PainelDaEntidade />);
    // O dublê devolve o mesmo link às duas linhas: as duas o mostram.
    expect(screen.getAllByText(`${window.location.origin}/ativar/tok_ATIVACAOABCDEFGHIJKLMN`)).toHaveLength(2);
    expect(screen.getAllByText(/o link só aparece esta vez/)).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Copiar o texto" })[0]);
    await waitFor(() => expect(escrever).toHaveBeenCalled());
    expect(escrever.mock.calls[0][0]).toContain("A Associação Teste cadastrou a Empresa Um no Marquesa Global Match");
    expect(escrever.mock.calls[0][0]).toContain("/ativar/tok_ATIVACAOABCDEFGHIJKLMN");
  });

  it("N3: o botão de cada empresa importada gera o link dela; com link valendo, ele troca", () => {
    duble.membros.mockReturnValue(consulta({ ...MEMBROS, membros: [{ ...MEMBROS.membros[0], ativacaoValidaAte: Date.UTC(2026, 11, 25, 12) }, MEMBROS.membros[1]] }));
    render(<PainelDaEntidade />);
    expect(screen.getByRole("button", { name: "Trocar o link" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Link de ativação" }));
    expect(duble.links).toHaveBeenCalledWith({ membroIds: [2] });
  });

  it("N3: gerar os que faltam pede bloco a bloco pelo cursor e baixa a planilha montada no aparelho", async () => {
    duble.links
      .mockResolvedValueOnce({ links: [{ membroId: 1, codigo: "NW-AB12CD", nome: "Empresa \"Um\"", referencia: "=1+1", token: "tok_A_ABCDEFGHIJKLMNOPQRSTU", expiraEm: 1 }], proximo: 1 })
      .mockResolvedValueOnce({ links: [{ membroId: 2, codigo: "NW-00FF11", nome: "Empresa Dois", referencia: null, token: "tok_B_ABCDEFGHIJKLMNOPQRSTU", expiraEm: 1 }], proximo: null });
    let blob: Blob | null = null;
    const criar = vi.fn((b: Blob) => { blob = b; return "blob:x"; });
    Object.assign(URL, { createObjectURL: criar, revokeObjectURL: vi.fn() });
    const clique = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<PainelDaEntidade />);
    fireEvent.click(screen.getByRole("button", { name: "Gerar os links que faltam e baixar a planilha" }));
    await waitFor(() => expect(clique).toHaveBeenCalled());
    expect(duble.links.mock.calls).toEqual([[{ pendentesDepoisDoId: 0 }], [{ pendentesDepoisDoId: 1 }]]);
    const texto = await blob!.text();
    expect(texto).toContain("\"codigo\";\"nome\"");
    expect(texto).toContain("\"Empresa \"\"Um\"\"\"");
    // A fórmula no começo da célula vira texto.
    expect(texto).toContain("\"'=1+1\"");
    expect(texto).toContain(`${window.location.origin}/ativar/tok_B_ABCDEFGHIJKLMNOPQRSTU`);
    clique.mockRestore();
  });
});
