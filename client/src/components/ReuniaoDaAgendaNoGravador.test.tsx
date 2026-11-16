import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReuniaoDaAgendaNoGravador } from "./ReuniaoDaAgendaNoGravador";

/**
 * A reunião da agenda no gravador (H16a), sozinha: preenche o título uma vez só
 * e só com o campo vazio, diz ao gravador qual reunião ligar (e nenhuma ao
 * sair), mostra o link da chamada e o convite, e avisa quando a reunião não
 * está mais na agenda ou a leitura falha.
 * O uso dentro do gravador está em pages/Meetings.agenda.test.tsx.
 */

const consulta = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: { agenda: { obter: { useQuery: (...a: unknown[]) => consulta.useQuery(...a) } } } }));

const ID = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";
const DA_AGENDA = {
  id: ID, titulo: "Conversa com a Bia", inicioEm: Date.UTC(2026, 10, 20, 17, 0), duracaoMinutos: 60, fuso: "America/Sao_Paulo",
  local: null, participantes: [], lembreteMinutos: 15, createdAt: 1, updatedAt: 2, gravacao: null,
};
const pronta = { data: DA_AGENDA, isLoading: false, isError: false, error: null };

beforeEach(() => {
  consulta.useQuery.mockReset().mockReturnValue(pronta);
});

describe("ReuniaoDaAgendaNoGravador", () => {
  it("com o campo vazio, preenche o título uma vez só, e diz ao gravador qual reunião ligar", () => {
    const preencher = vi.fn();
    const carregar = vi.fn();
    const { rerender } = render(<ReuniaoDaAgendaNoGravador id={ID} tituloAtual="" aoPreencherTitulo={preencher} aoCarregar={carregar}/>);
    expect(preencher).toHaveBeenCalledWith("Conversa com a Bia");
    expect(carregar).toHaveBeenLastCalledWith(ID);
    // A dona apagou o título depois: a consulta que volta não o preenche de novo.
    consulta.useQuery.mockReturnValue({ ...pronta, data: { ...DA_AGENDA } });
    rerender(<ReuniaoDaAgendaNoGravador id={ID} tituloAtual="" aoPreencherTitulo={preencher} aoCarregar={carregar}/>);
    expect(preencher).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("note")).toHaveTextContent("Da sua agenda:");
  });

  // Quem pede o link no meio da reunião o recebe sem a dona sair do gravador:
  // sair dele desmonta a página e descarta a gravação.
  it("o link da chamada e o convite pelo WhatsApp e pelo e-mail ficam no gravador, todos abrindo fora desta aba", () => {
    consulta.useQuery.mockReturnValue({ ...pronta, data: {
      ...DA_AGENDA, local: "https://meet.google.com/abc-defg-hij",
      participantes: [{ nome: "Ana", email: "ana@exemplo.com" }, { nome: "Bia", email: null }, { nome: null, email: "cris@exemplo.com" }],
    } });
    render(<ReuniaoDaAgendaNoGravador id={ID} tituloAtual="" aoPreencherTitulo={vi.fn()} aoCarregar={vi.fn()}/>);
    const chamada = screen.getByRole("link", { name: "https://meet.google.com/abc-defg-hij" });
    expect(chamada).toHaveAttribute("href", "https://meet.google.com/abc-defg-hij");
    expect(chamada).toHaveAttribute("target", "_blank");
    expect(chamada).toHaveAttribute("rel", "noopener noreferrer");
    const convite = screen.getByRole("group", { name: "Mandar o convite" });
    const whatsapp = within(convite).getByRole("link", { name: /WhatsApp/ });
    expect(whatsapp).toHaveAttribute("target", "_blank");
    const texto = new URL(whatsapp.getAttribute("href")!).searchParams.get("text")!;
    expect(texto).toContain("Convite para a reunião “Conversa com a Bia”");
    expect(texto).toContain("Onde: https://meet.google.com/abc-defg-hij");
    expect(texto).not.toContain("ana@exemplo.com");
    // O mailto em outra aba: nesta, com a gravação em curso, o navegador podia perguntar se a dona quer sair.
    const email = within(convite).getByRole("link", { name: /E-mail/ });
    expect(email).toHaveAttribute("target", "_blank");
    expect(email.getAttribute("href")!.startsWith("mailto:?bcc=ana@exemplo.com,cris@exemplo.com&")).toBe(true);
    expect(new URLSearchParams(email.getAttribute("href")!.slice("mailto:?".length)).get("subject")).toBe("Convite: Conversa com a Bia");
  });

  it("local que não é link sai como texto, nunca como href; sem local, só o convite", () => {
    consulta.useQuery.mockReturnValue({ ...pronta, data: { ...DA_AGENDA, local: "javascript:alert(1)" } });
    const { unmount } = render(<ReuniaoDaAgendaNoGravador id={ID} tituloAtual="" aoPreencherTitulo={vi.fn()} aoCarregar={vi.fn()}/>);
    expect(screen.getByText("javascript:alert(1)").tagName).toBe("P");
    expect(screen.getAllByRole("link").map(link => link.getAttribute("href"))).not.toContain("javascript:alert(1)");
    unmount();
    consulta.useQuery.mockReturnValue(pronta);
    render(<ReuniaoDaAgendaNoGravador id={ID} tituloAtual="" aoPreencherTitulo={vi.fn()} aoCarregar={vi.fn()}/>);
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(screen.getByRole("group", { name: "Mandar o convite" })).toBeInTheDocument();
  });

  it("com o título já escrito, não troca nada, mas liga a reunião", () => {
    const preencher = vi.fn();
    const carregar = vi.fn();
    render(<ReuniaoDaAgendaNoGravador id={ID} tituloAtual="Minha reunião" aoPreencherTitulo={preencher} aoCarregar={carregar}/>);
    expect(preencher).not.toHaveBeenCalled();
    expect(carregar).toHaveBeenLastCalledWith(ID);
  });

  it("ao sair da tela, o gravador não liga mais nada", () => {
    const carregar = vi.fn();
    const { unmount } = render(<ReuniaoDaAgendaNoGravador id={ID} tituloAtual="" aoPreencherTitulo={vi.fn()} aoCarregar={carregar}/>);
    unmount();
    expect(carregar).toHaveBeenLastCalledWith(null);
  });

  it("NOT_FOUND não se tenta de novo; outros erros, até duas vezes", () => {
    render(<ReuniaoDaAgendaNoGravador id={ID} tituloAtual="" aoPreencherTitulo={vi.fn()} aoCarregar={vi.fn()}/>);
    const { retry } = consulta.useQuery.mock.calls[0][1] as { retry: (n: number, erro: unknown) => boolean };
    expect(retry(0, { data: { code: "NOT_FOUND" } })).toBe(false);
    expect(retry(0, { data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(true);
    expect(retry(2, { data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(false);
  });

  it("sem a reunião (excluída ou de outra conta): o aviso, e nada a ligar", () => {
    consulta.useQuery.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: { data: { code: "NOT_FOUND" } } });
    const carregar = vi.fn();
    render(<ReuniaoDaAgendaNoGravador id={ID} tituloAtual="" aoPreencherTitulo={vi.fn()} aoCarregar={carregar}/>);
    expect(screen.getByRole("note")).toHaveTextContent("Esta reunião não está mais na sua agenda. A gravação segue sem ligação.");
    expect(carregar).not.toHaveBeenCalledWith(ID);
  });

  it("a leitura que falha por outro motivo também avisa", () => {
    consulta.useQuery.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: { data: { code: "INTERNAL_SERVER_ERROR" } } });
    render(<ReuniaoDaAgendaNoGravador id={ID} tituloAtual="" aoPreencherTitulo={vi.fn()} aoCarregar={vi.fn()}/>);
    expect(screen.getByRole("note")).toHaveTextContent("Não deu para ler a reunião da agenda. A gravação segue sem ligação.");
  });

  it("carregando, nada na tela", () => {
    consulta.useQuery.mockReturnValue({ data: undefined, isLoading: true, isError: false, error: null });
    const { container } = render(<ReuniaoDaAgendaNoGravador id={ID} tituloAtual="" aoPreencherTitulo={vi.fn()} aoCarregar={vi.fn()}/>);
    expect(container).toBeEmptyDOMElement();
  });
});
