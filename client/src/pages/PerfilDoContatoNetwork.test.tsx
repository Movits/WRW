import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import PerfilDoContatoNetwork from "./PerfilDoContatoNetwork";
import { PessoaSugeridaNaReuniao } from "@/components/PessoaSugeridaNaReuniao";

/**
 * Meu Network Inteligente — o perfil do contato (spec da Glenda de 14/09,
 * itens 6, 10, 13, 14, 20, 22 e 26) e a pessoa sugerida pela reunião.
 *
 * O que se trava:
 * - QUEM SOU mostra só nome, telefone, e-mail (e o tipo de pessoa), com
 *   FALTANDO no que falta e o alerta do pedido;
 * - o ID anônimo e o SIM/NÃO da rede global, com o que nunca sai escrito; a
 *   escolha chama o servidor com o id do contato;
 * - sugestões da IA: origem, confiança e trecho; confirmar (com o valor
 *   corrigido pela dona) e ignorar chamam o servidor — nada é gravado pela tela;
 * - completar por texto chama a interpretação; por voz, avisa que o áudio não
 *   é guardado;
 * - reuniões vinculadas e a linha do tempo;
 * - contato de outra dona (NOT_FOUND) é "não encontrado", não erro genérico;
 * - na reunião, o que a transcrição não sustentou aparece como FALTANDO.
 */

const duble = vi.hoisted(() => ({
  contato: vi.fn(),
  params: { id: "5" } as { id: string },
  mutacoes: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));
vi.mock("wouter", async importOriginal => ({ ...await importOriginal<typeof import("wouter")>(), useParams: () => duble.params }));
vi.mock("@/lib/trpc", () => {
  const mutacao = (nome: string) => ({
    useMutation: () => ({ mutate: (duble.mutacoes[nome] ??= vi.fn()), isPending: false }),
  });
  return {
    trpc: {
      useUtils: () => ({
        networkInteligente: {
          contato: { invalidate: vi.fn() }, resumo: { invalidate: vi.fn() }, conexoes: { invalidate: vi.fn() },
        },
      }),
      networkInteligente: {
        contato: { useQuery: (...args: unknown[]) => duble.contato(...args) },
        definirDisponibilidade: mutacao("definirDisponibilidade"),
        confirmarPendencia: mutacao("confirmarPendencia"),
        ignorarPendencia: mutacao("ignorarPendencia"),
        complementarPorTexto: mutacao("complementarPorTexto"),
        complementarPorVoz: mutacao("complementarPorVoz"),
        procurarNaRedeGlobal: mutacao("procurarNaRedeGlobal"),
        avancarConexao: mutacao("avancarConexao"),
      },
    },
  };
});

function perfil(parcial: Record<string, unknown> = {}) {
  return {
    contato: {
      id: 5,
      quemSou: { nome: "Maria Silva", telefone: null, email: "maria@farmabras.com.br", tipoPessoa: "juridica" },
      codigoAnonimo: "NW-7F29A4", disponivelRedeGlobal: false, disponibilidadeAlteradaEm: null, criadoEm: Date.UTC(2026, 0, 10),
    },
    tenho: [{ id: 1, label: "Distribuição de medicamentos", category: null }],
    preciso: [],
    faltando: ["telefone", "preciso"],
    pendencias: [
      { id: "p-1", contactId: 5, meetingId: "m-1", meetingSuggestionId: "s-1", origem: "reuniao", campo: "preciso", valor: "Fornecedores internacionais", categoria: null, trecho: "procurando novos fornecedores internacionais", confianca: 0.85, criadaEm: 1 },
    ],
    reunioes: [{ id: "m-1", titulo: "Café na feira", status: "ready", em: Date.UTC(2026, 8, 1), assuntos: ["Distribuição", "Fornecedores"] }],
    conexoes: { termoAceito: true, lista: [] },
    linhaDoTempo: [
      { tipo: "reuniao", em: Date.UTC(2026, 8, 1), meetingId: "m-1", titulo: "Café na feira", assuntos: [] },
      { tipo: "contato_criado", em: Date.UTC(2026, 0, 10) },
    ],
    ...parcial,
  };
}

const responde = (data: unknown) => duble.contato.mockReturnValue({ data, isLoading: false, isError: false, error: null, refetch: vi.fn() });

beforeEach(async () => {
  await i18n.changeLanguage("pt-BR");
  duble.params = { id: "5" };
  for (const m of Object.values(duble.mutacoes)) m.mockReset();
});

describe("perfil do contato — Quem Sou, Tenho, Preciso", () => {
  it("QUEM SOU só com nome, telefone, e-mail e tipo; o que falta aparece como FALTANDO, com o alerta", () => {
    responde(perfil());
    render(<PerfilDoContatoNetwork />);
    expect(duble.contato).toHaveBeenCalledWith({ contactId: 5 }, expect.anything());
    const quemSou = screen.getByRole("heading", { name: "Quem Sou" }).closest("section")!;
    expect(within(quemSou).getAllByRole("term").map(dt => dt.textContent)).toEqual(["Nome ou razão social", "Telefone", "E-mail", "Tipo de pessoa"]);
    expect(within(quemSou).getByText("— FALTANDO")).toBeInTheDocument();
    expect(within(quemSou).getByText("maria@farmabras.com.br")).toBeInTheDocument();
    expect(within(quemSou).getByText("Pessoa jurídica")).toBeInTheDocument();
    expect(screen.getByText("Faltam informações importantes para tornar este contato mais útil para o seu Network Inteligente.")).toBeInTheDocument();

    const tenho = screen.getByRole("heading", { name: "O Que Tenho" }).closest("section")!;
    expect(within(tenho).getByText("Distribuição de medicamentos")).toBeInTheDocument();
    const preciso = screen.getByRole("heading", { name: "O Que Preciso" }).closest("section")!;
    expect(within(preciso).getByText("— FALTANDO")).toBeInTheDocument();
  });

  it("ID anônimo e SIM/NÃO com padrão NÃO; escolher SIM chama o servidor para este contato", () => {
    responde(perfil());
    render(<PerfilDoContatoNetwork />);
    expect(screen.getByText("NW-7F29A4")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "NÃO" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "SIM" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/Nome, telefone, e-mail, áudio, transcrição e notas pessoais nunca são disponibilizados/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "SIM" }));
    expect(duble.mutacoes.definirDisponibilidade).toHaveBeenCalledWith({ contactId: 5, disponivel: true });
    // escolher de novo o que já está marcado não chama o servidor
    fireEvent.click(screen.getByRole("radio", { name: "NÃO" }));
    expect(duble.mutacoes.definirDisponibilidade).toHaveBeenCalledTimes(1);
  });
});

describe("perfil do contato — nada entra sem confirmação", () => {
  it("a sugestão mostra origem, confiança e trecho; confirmar envia o valor corrigido; ignorar envia o id", () => {
    responde(perfil());
    render(<PerfilDoContatoNetwork />);
    const sugestoes = screen.getByRole("heading", { name: "Sugestões da IA para confirmar" }).closest("section")!;
    expect(within(sugestoes).getByText("Da reunião")).toBeInTheDocument();
    expect(within(sugestoes).getByText("Confiança 85%")).toBeInTheDocument();
    expect(within(sugestoes).getByText("Trecho: “procurando novos fornecedores internacionais”")).toBeInTheDocument();

    fireEvent.change(within(sugestoes).getByDisplayValue("Fornecedores internacionais"), { target: { value: "Fornecedores na Índia" } });
    fireEvent.click(within(sugestoes).getByRole("button", { name: "Confirmar" }));
    expect(duble.mutacoes.confirmarPendencia).toHaveBeenCalledWith({ id: "p-1", valor: "Fornecedores na Índia" });

    fireEvent.click(within(sugestoes).getByRole("button", { name: "Ignorar" }));
    expect(duble.mutacoes.ignorarPendencia).toHaveBeenCalledWith({ id: "p-1" });
  });

  it("confirmar sem mudar o valor não manda valor: vale o que a IA propôs", () => {
    responde(perfil());
    render(<PerfilDoContatoNetwork />);
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(duble.mutacoes.confirmarPendencia).toHaveBeenCalledWith({ id: "p-1" });
  });

  it("completar por texto chama a interpretação; por voz, avisa que o áudio não é guardado", () => {
    responde(perfil());
    render(<PerfilDoContatoNetwork />);
    const completar = screen.getByRole("heading", { name: "Completar informações" }).closest("section")!;
    fireEvent.change(within(completar).getByPlaceholderText(/Escreva o que você sabe/), { target: { value: "O telefone dela é (11) 98765-4321." } });
    fireEvent.click(within(completar).getByRole("button", { name: "Interpretar" }));
    expect(duble.mutacoes.complementarPorTexto).toHaveBeenCalledWith({ contactId: 5, texto: "O telefone dela é (11) 98765-4321." });

    fireEvent.click(within(completar).getByRole("tab", { name: "Por voz" }));
    expect(within(completar).getByRole("button", { name: /Gravar áudio \(até 2 min\)/ })).toBeInTheDocument();
    expect(within(completar).getByText("O áudio não é guardado: ele é transcrito e descartado.")).toBeInTheDocument();
  });
});

describe("perfil do contato — completar por voz", () => {
  const trilhaParada = vi.fn();
  let gravadores: GravadorFalso[] = [];
  let pedirMicrofone: () => Promise<unknown>;

  class GravadorFalso {
    static isTypeSupported = (tipo: string) => tipo === "audio/webm;codecs=opus";
    mimeType: string;
    state: "inactive" | "recording" = "inactive";
    ondataavailable: ((evento: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(_fluxo: unknown, opcoes?: { mimeType?: string }) { this.mimeType = opcoes?.mimeType ?? ""; gravadores.push(this); }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["som"], { type: "audio/webm;codecs=opus" }) });
      this.onstop?.();
    }
  }

  const microfone = () => ({ getTracks: () => [{ stop: trilhaParada }] });

  beforeEach(() => {
    trilhaParada.mockReset();
    gravadores = [];
    pedirMicrofone = async () => microfone();
    vi.stubGlobal("MediaRecorder", GravadorFalso);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => pedirMicrofone() },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function comecarAGravar() {
    fireEvent.click(screen.getByRole("tab", { name: "Por voz" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Gravar áudio/ })); });
  }

  it("parar envia o áudio deste contato para interpretação", async () => {
    responde(perfil());
    render(<PerfilDoContatoNetwork />);
    await comecarAGravar();
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Parar e enviar/ })); });
    await waitFor(() => expect(duble.mutacoes.complementarPorVoz).toHaveBeenCalledTimes(1));
    expect(duble.mutacoes.complementarPorVoz).toHaveBeenCalledWith(expect.objectContaining({
      contactId: 5, mimeType: "audio/webm", audioBase64: expect.stringMatching(/^data:audio\/webm;codecs=opus;base64,/),
    }));
    expect(trilhaParada).toHaveBeenCalled();
  });

  it("o navegador que grava mp4 manda mp4 para interpretação", async () => {
    vi.stubGlobal("MediaRecorder", class extends GravadorFalso {
      static isTypeSupported = (tipo: string) => tipo === "audio/mp4;codecs=mp4a.40.2" || tipo === "audio/webm;codecs=opus";
    });
    responde(perfil());
    render(<PerfilDoContatoNetwork />);
    await comecarAGravar();
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Parar e enviar/ })); });
    await waitFor(() => expect(duble.mutacoes.complementarPorVoz).toHaveBeenCalledTimes(1));
    expect(gravadores[0].mimeType).toBe("audio/mp4;codecs=mp4a.40.2");
    expect(duble.mutacoes.complementarPorVoz).toHaveBeenCalledWith(expect.objectContaining({
      contactId: 5, mimeType: "audio/mp4", audioBase64: expect.stringMatching(/^data:audio\/mp4;codecs=mp4a\.40\.2;base64,/),
    }));
    expect(trilhaParada).toHaveBeenCalledTimes(1);
  });

  it("sair da tela gravando para o gravador e o microfone e NÃO envia o áudio", async () => {
    responde(perfil());
    const { unmount } = render(<PerfilDoContatoNetwork />);
    await comecarAGravar();
    expect(await screen.findByRole("button", { name: /Parar e enviar/ })).toBeInTheDocument();
    expect(gravadores).toHaveLength(1);

    await act(async () => {
      unmount();
      // tempo para a leitura do blob, que vem antes do envio
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    expect(gravadores[0].state).toBe("inactive");
    expect(trilhaParada).toHaveBeenCalled();
    expect(duble.mutacoes.complementarPorVoz).not.toHaveBeenCalled();
  });

  it("sair da tela enquanto o navegador pede o microfone: solta o microfone e não grava", async () => {
    let liberar!: (midia: unknown) => void;
    pedirMicrofone = () => new Promise(resolve => { liberar = resolve; });
    responde(perfil());
    const { unmount } = render(<PerfilDoContatoNetwork />);
    fireEvent.click(screen.getByRole("tab", { name: "Por voz" }));
    fireEvent.click(screen.getByRole("button", { name: /Gravar áudio/ }));
    unmount();
    await act(async () => { liberar(microfone()); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(gravadores).toHaveLength(0);
    expect(trilhaParada).toHaveBeenCalled();
    expect(duble.mutacoes.complementarPorVoz).not.toHaveBeenCalled();
  });

  it("duplo clique enquanto o navegador pede o microfone: um só pedido, um só gravador, um só envio", async () => {
    const pedidos: Array<(midia: unknown) => void> = [];
    pedirMicrofone = () => new Promise(resolve => { pedidos.push(resolve); });
    responde(perfil());
    render(<PerfilDoContatoNetwork />);
    fireEvent.click(screen.getByRole("tab", { name: "Por voz" }));
    const gravar = screen.getByRole("button", { name: /Gravar áudio/ });
    fireEvent.click(gravar);
    fireEvent.click(gravar);
    expect(gravar).toBeDisabled();
    expect(pedidos).toHaveLength(1);
    // Enquanto o navegador responde, não dá para trocar para "Por texto" e esconder a gravação.
    fireEvent.click(screen.getByRole("tab", { name: "Por texto" }));
    expect(screen.getByRole("tab", { name: "Por voz" })).toHaveAttribute("aria-selected", "true");

    await act(async () => { pedidos[0](microfone()); });
    expect(gravadores).toHaveLength(1);
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Parar e enviar/ })); });
    await waitFor(() => expect(duble.mutacoes.complementarPorVoz).toHaveBeenCalledTimes(1));
    expect(trilhaParada).toHaveBeenCalledTimes(1);
  });
});

describe("perfil do contato — reuniões, conexões e memória de relacionamento", () => {
  it("reuniões vinculadas com assuntos, e a linha do tempo privada", () => {
    responde(perfil());
    render(<PerfilDoContatoNetwork />);
    const reunioes = screen.getByRole("heading", { name: "Reuniões vinculadas" }).closest("section")!;
    expect(within(reunioes).getByText("Café na feira")).toBeInTheDocument();
    expect(within(reunioes).getByText("Assuntos: Distribuição, Fornecedores")).toBeInTheDocument();
    const linha = screen.getByRole("heading", { name: "Memória de relacionamento" }).closest("section")!;
    expect(within(linha).getByText("Reunião: Café na feira")).toBeInTheDocument();
    expect(within(linha).getByText("Contato cadastrado")).toBeInTheDocument();
  });

  it("sem o termo do Smart Match: sem conexões e sem busca na rede global", () => {
    responde(perfil({ conexoes: { termoAceito: false }, contato: { ...perfil().contato, disponivelRedeGlobal: true } }));
    render(<PerfilDoContatoNetwork />);
    expect(screen.getByText("Ative as Conexões Inteligentes para ver as conexões deste contato.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /rede global/ })).not.toBeInTheDocument();
  });

  it("disponibilizado e com o termo: procurar conexões deste contato na rede global", () => {
    responde(perfil({ contato: { ...perfil().contato, disponivelRedeGlobal: true } }));
    render(<PerfilDoContatoNetwork />);
    fireEvent.click(screen.getByRole("button", { name: "Procurar conexões deste contato na rede global" }));
    expect(duble.mutacoes.procurarNaRedeGlobal).toHaveBeenCalledWith({ contactId: 5 });
  });
});

describe("perfil do contato — não encontrado e erro", () => {
  it("contato de outra dona (NOT_FOUND): 'não encontrado', sem dado nenhum", () => {
    duble.contato.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: { message: "x", data: { code: "NOT_FOUND" } }, refetch: vi.fn() });
    render(<PerfilDoContatoNetwork />);
    expect(screen.getByRole("alert")).toHaveTextContent("Esse contato não foi encontrado na sua rede.");
  });

  it("id inválido na rota: 'não encontrado', e a consulta nem é habilitada", () => {
    duble.params = { id: "abc" };
    duble.contato.mockReturnValue({ data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() });
    render(<PerfilDoContatoNetwork />);
    expect(screen.getByRole("alert")).toHaveTextContent("Esse contato não foi encontrado na sua rede.");
    expect(duble.contato).toHaveBeenCalledWith({ contactId: Number.NaN }, expect.objectContaining({ enabled: false }));
  });
});

describe("a pessoa sugerida pela reunião", () => {
  const sugestao = { id: "s-1", fullName: "Maria Silva", jobTitle: null, company: "Farmabras", phone: null, email: "maria@farmabras.com.br", status: "pending", existingContactId: null };

  it("Quem Sou com FALTANDO no que a transcrição não sustentou, Tenho/Preciso sugeridos e o alerta", () => {
    render(<PessoaSugeridaNaReuniao sugestao={sugestao} pendencias={[
      { id: "p-1", meetingSuggestionId: "s-1", campo: "tenho", valor: "Distribuição de medicamentos", trecho: "distribuição de medicamentos" },
      { id: "p-2", meetingSuggestionId: "outra", campo: "preciso", valor: "Investidores", trecho: null },
    ]} />);
    expect(screen.getByText("Distribuição de medicamentos")).toBeInTheDocument();
    // a pendência de OUTRA pessoa da reunião não aparece aqui
    expect(screen.queryByText("Investidores")).not.toBeInTheDocument();
    expect(screen.getAllByText("FALTANDO")).toHaveLength(2); // telefone e O Que Preciso
    expect(screen.getByText("Faltam informações importantes para tornar este contato mais útil para o seu Network Inteligente.")).toBeInTheDocument();
    expect(screen.getByText(/ficam esperando a sua confirmação/)).toBeInTheDocument();
  });

  it("contato criado: leva ao perfil no Meu Network Inteligente", () => {
    render(<PessoaSugeridaNaReuniao sugestao={{ ...sugestao, status: "created", existingContactId: 42 }} pendencias={[]} />);
    expect(screen.getByRole("link", { name: "Revisar no Meu Network Inteligente" })).toHaveAttribute("href", "/meu-network-inteligente/contatos/42");
  });
});
