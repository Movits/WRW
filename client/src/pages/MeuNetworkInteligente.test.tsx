import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import MeuNetworkInteligente from "./MeuNetworkInteligente";

/**
 * Meu Network Inteligente — o painel (pedido do Nicolas, 13/09/2026, e spec da
 * Glenda de 14/09, item 19).
 *
 * O que se trava:
 * - os números são os que o servidor manda, cada um levando à tela dele;
 * - sem o termo do Smart Match, matches internos E os indicadores do registro
 *   (rede global, intermediações, negócios, comissões) mostram traço e
 *   convite, nunca número; com o termo, os números do registro;
 * - minutos: usados no mês, guardados, limite por reunião e limite mensal;
 * - "Precisa de mais tempo? Amplie seus minutos de reunião." não é botão, link
 *   nem preço, e diz que a mensalidade depende de integração de pagamento;
 * - a conexão interna identificada dispara o alerta do pedido;
 * - a busca inteligente pergunta à Memória e leva ao perfil do contato; com o
 *   índice pela metade (pending/truncated), avisa que a busca ficou incompleta;
 * - contatos incompletos: o alerta, o que falta e o atalho para o perfil, onde
 *   se completa por texto ou voz;
 * - erro de consulta é erro, nunca "nenhum contato".
 *
 * O tRPC vira um dublê (molde de Meetings.test.tsx) e o AppHeader fica de fora.
 */

const duble = vi.hoisted(() => ({
  resumo: vi.fn(),
  minutos: vi.fn(),
  conexoes: vi.fn(),
  buscar: vi.fn(),
  resultadoDaBusca: undefined as unknown,
  procurar: vi.fn(),
  avancar: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      networkInteligente: { conexoes: { invalidate: vi.fn() }, contato: { invalidate: vi.fn() }, resumo: { invalidate: vi.fn() } },
    }),
    networkInteligente: {
      resumo: { useQuery: (...args: unknown[]) => duble.resumo(...args) },
      minutos: { useQuery: (...args: unknown[]) => duble.minutos(...args) },
      conexoes: { useQuery: (...args: unknown[]) => duble.conexoes(...args) },
      procurarNaRedeGlobal: { useMutation: () => ({ mutate: duble.procurar, isPending: false }) },
      avancarConexao: { useMutation: () => ({ mutate: duble.avancar, isPending: false }) },
    },
    memory: {
      search: { useMutation: () => ({ mutate: duble.buscar, isPending: false, data: duble.resultadoDaBusca }) },
    },
  },
}));

type Resumo = {
  reunioes: { total: number; transcritas: number; emAndamento: number; comFalha: number };
  minutos: { segundosEmReunioesGuardadas: number; limitePorReuniaoSegundos: number };
  contatos: { total: number; incompletos: number; disponibilizados: number; amostraIncompletos: { id: number; fullName: string; faltando: string[] }[] };
  matchesInternos: { termoAceito: true; novos: number; total: number } | { termoAceito: false };
};

const AMOSTRA = [
  { id: 12, fullName: "Bia Souza", faltando: ["telefone", "preciso"] },
  { id: 14, fullName: "Duda Lima", faltando: ["telefone", "email", "tenho"] },
  { id: 15, fullName: "Eva Rocha", faltando: ["telefone"] },
  { id: 16, fullName: "Fabi Reis", faltando: ["email"] },
  { id: 17, fullName: "Gil Prado", faltando: ["preciso"] },
];

function dados(parcial: Partial<Resumo> = {}): Resumo {
  return {
    reunioes: { total: 6, transcritas: 3, emAndamento: 1, comFalha: 2 },
    minutos: { segundosEmReunioesGuardadas: 1530, limitePorReuniaoSegundos: 600 },
    contatos: { total: 9, incompletos: 7, disponibilizados: 3, amostraIncompletos: AMOSTRA },
    matchesInternos: { termoAceito: true, novos: 2, total: 4 },
    ...parcial,
  };
}

const MINUTOS = {
  plano: "gratuito", limitePorReuniaoSegundos: 600, limiteMensalSegundos: null, usadosNoMesSegundos: 840, inicioDoMes: 0,
  ampliacao: { disponivel: false, dependeDe: "integracao_de_pagamento" },
};

const conexao = (parcial: Record<string, unknown> = {}) => ({
  id: "c-1", origem: "PRIVATE_NETWORK_MATCH", motivo: "NW-AAAAAA tem X, que NW-BBBBBB procura.",
  itens: [{ tem: "Distribuição de medicamentos", precisa: "Distribuidores", deCodigo: "NW-AAAAAA", paraCodigo: "NW-BBBBBB" }],
  pontuacao: 100, status: "identificada", apresentacaoEm: null, negociacaoEm: null, fechamentoEm: null, descartadaEm: null,
  statusComissao: "sem_negocio", criadaEm: Date.UTC(2026, 8, 14),
  lados: [
    { lado: "a", tipo: "contato", contactId: 11, codigoAnonimo: "NW-AAAAAA", meu: true, originador: false, statusComissaoOriginador: null },
    { lado: "b", tipo: "contato", contactId: 12, codigoAnonimo: "NW-BBBBBB", meu: true, originador: false, statusComissaoOriginador: null },
  ],
  ...parcial,
});

const CONTAGEM = { internas: 5, comRedeGlobal: 2, oportunidades: 6, intermediacoes: 3, negociosEmAndamento: 2, negociosConcluidos: 1, comissionamentos: 1 };

const refetch = vi.fn();
const consulta = (data: unknown) => ({ data, isLoading: false, isError: false, error: null, refetch });
function servidorResponde(resposta: Resumo, registro: unknown = { termoAceito: true, contagem: CONTAGEM, lista: [] }) {
  duble.resumo.mockReturnValue(consulta(resposta));
  duble.minutos.mockReturnValue(consulta(MINUTOS));
  duble.conexoes.mockReturnValue(consulta(registro));
}

/** O cartão de um indicador: o link, quando leva a algum lugar; senão, o bloco. */
function cartao(rotulo: string): HTMLElement {
  const elemento = screen.getByText(rotulo);
  return (elemento.closest("a") ?? elemento.parentElement!.parentElement!) as HTMLElement;
}

const MAIS_TEMPO = "Precisa de mais tempo? Amplie seus minutos de reunião.";
const ALERTA = "Faltam informações importantes para tornar este contato mais útil para o seu Network Inteligente.";

beforeEach(async () => {
  await i18n.changeLanguage("pt-BR");
  duble.resultadoDaBusca = undefined;
  duble.buscar.mockReset();
  duble.procurar.mockReset();
  duble.avancar.mockReset();
});

describe("Meu Network Inteligente — os números do servidor", () => {
  it("reuniões, contatos, incompletos e conexões internas, cada um levando à sua tela", () => {
    servidorResponde(dados());
    render(<MeuNetworkInteligente />);

    const reunioes = cartao("Minhas reuniões");
    expect(reunioes).toHaveAttribute("href", "/meetings");
    expect(within(reunioes).getByText("6")).toBeInTheDocument();
    expect(within(reunioes).getByText("Transcritas: 3")).toBeInTheDocument();

    const contatos = cartao("Meus contatos");
    expect(contatos).toHaveAttribute("href", "/network");
    expect(within(contatos).getByText("9")).toBeInTheDocument();

    expect(within(cartao("Informações incompletas")).getByText("7")).toBeInTheDocument();

    const matches = cartao("Conexões internas sugeridas");
    expect(matches).toHaveAttribute("href", "/intelligent-matches");
    expect(within(matches).getByText("4")).toBeInTheDocument();
    expect(within(matches).getByText("Novas: 2")).toBeInTheDocument();
  });

  it("com o termo: disponibilizados, rede global, oportunidades, intermediações, negócios e comissões vêm do registro", () => {
    servidorResponde(dados());
    render(<MeuNetworkInteligente />);
    expect(within(cartao("Contatos disponibilizados")).getByText("3")).toBeInTheDocument();
    expect(within(cartao("Conexões com a rede global")).getByText("2")).toBeInTheDocument();
    expect(within(cartao("Oportunidades encontradas")).getByText("6")).toBeInTheDocument();
    expect(within(cartao("Intermediações")).getByText("3")).toBeInTheDocument();
    expect(within(cartao("Negócios em andamento")).getByText("2")).toBeInTheDocument();
    expect(within(cartao("Negócios concluídos")).getByText("1")).toBeInTheDocument();
    expect(within(cartao("Comissionamentos")).getByText("1")).toBeInTheDocument();
    expect(within(cartao("Conexões internas registradas")).getByText("5")).toBeInTheDocument();
  });

  it("minutos: usados no mês, guardados, limite por reunião e sem limite mensal", () => {
    servidorResponde(dados());
    render(<MeuNetworkInteligente />);
    expect(within(screen.getByText("Utilizados neste mês").parentElement!).getByText("14 min")).toBeInTheDocument();
    // 1530 s = 25,5 min
    expect(screen.getByText("26 min")).toBeInTheDocument();
    expect(screen.getByText("10 min")).toBeInTheDocument();
    expect(screen.getByText("Limite gratuito por reunião")).toBeInTheDocument();
    expect(screen.getByText("Sem limite mensal")).toBeInTheDocument();
  });

  it("sem o termo do Smart Match: traço e convite nas conexões internas e no registro, nunca número", () => {
    servidorResponde(dados({ matchesInternos: { termoAceito: false } }), { termoAceito: false });
    render(<MeuNetworkInteligente />);
    const matches = cartao("Conexões internas sugeridas");
    expect(within(matches).getByText("—")).toBeInTheDocument();
    expect(within(matches).getByText("Ative as Conexões Inteligentes para ver")).toBeInTheDocument();
    expect(matches).toHaveAttribute("href", "/intelligent-matches");
    expect(within(matches).queryByText(/\d/)).not.toBeInTheDocument();
    for (const rotulo of ["Conexões com a rede global", "Intermediações", "Negócios em andamento", "Negócios concluídos", "Comissionamentos"]) {
      const bloco = cartao(rotulo);
      expect(within(bloco).getByText("—")).toBeInTheDocument();
      expect(within(bloco).queryByText(/\d/)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Procurar conexões na rede global" })).not.toBeInTheDocument();
  });
});

describe("Meu Network Inteligente — nada é simulado", () => {
  it("a chamada para ampliar minutos não é botão, link nem preço, e diz que depende de integração de pagamento", () => {
    servidorResponde(dados());
    render(<MeuNetworkInteligente />);
    const chamada = screen.getByText(MAIS_TEMPO);
    expect(chamada.closest("a")).toBeNull();
    expect(chamada.closest("button")).toBeNull();
    const caixa = chamada.parentElement!;
    expect(within(caixa).queryAllByRole("button")).toEqual([]);
    expect(within(caixa).queryAllByRole("link")).toEqual([]);
    expect(screen.getByText("A ampliação de minutos por mensalidade ainda não está disponível. Por enquanto, cada reunião pode ter até 10 minutos.")).toBeInTheDocument();
    expect(screen.getByText("A mensalidade depende de uma integração de pagamento que ainda não existe na plataforma. Nenhum valor é cobrado.")).toBeInTheDocument();
    expect(screen.queryByText(/R\$|US\$|€|por mês|\/mês/i)).not.toBeInTheDocument();
  });

  it("comissão é status: o aviso diz que nenhum percentual, valor ou cobrança é aplicado", () => {
    servidorResponde(dados(), { termoAceito: true, contagem: CONTAGEM, lista: [conexao({ status: "fechada", statusComissao: "a_apurar" })] });
    render(<MeuNetworkInteligente />);
    expect(screen.getByText(/Nenhum percentual, valor ou cobrança é aplicado automaticamente/)).toBeInTheDocument();
    expect(screen.getByText(/Comissão da plataforma: a apurar/)).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("gravar: o aviso de consentimento antes de gravar e o limite do servidor no atalho", () => {
    servidorResponde(dados());
    render(<MeuNetworkInteligente />);
    const aviso = screen.getByText("Antes de gravar, você é responsável por obter o consentimento de todas as pessoas participantes e por cumprir as regras de privacidade aplicáveis.");
    const atalho = aviso.closest("a")!;
    // O atalho de gravar abre o gravador direto; o indicador de reuniões segue na lista.
    expect(atalho).toHaveAttribute("href", "/gravar");
    expect(within(atalho).getByText("Até 10 minutos por reunião, com transcrição e sugestão dos contatos citados.")).toBeInTheDocument();
    expect(screen.getByText("Pesquisar meu network").closest("a")).toHaveAttribute("href", "/memory");
  });
});

describe("Meu Network Inteligente — conexões registradas e rede global", () => {
  it("conexão interna identificada: o alerta do pedido e o lado da dona leva ao perfil do contato", () => {
    servidorResponde(dados(), { termoAceito: true, contagem: CONTAGEM, lista: [conexao()] });
    render(<MeuNetworkInteligente />);
    expect(screen.getByText("Encontramos uma oportunidade dentro do seu próprio network.")).toBeInTheDocument();
    expect(screen.getByText("Dentro do seu network")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "NW-AAAAAA" })).toHaveAttribute("href", "/meu-network-inteligente/contatos/11");
    expect(screen.getByText("Tem: Distribuição de medicamentos · Precisa: Distribuidores")).toBeInTheDocument();
  });

  it("outro network aparece só pelo ID anônimo; a etapa seguinte é a única oferecida", () => {
    servidorResponde(dados(), {
      termoAceito: true, contagem: CONTAGEM,
      lista: [conexao({
        id: "c-2", origem: "NETWORK_NETWORK_MATCH", status: "apresentacao",
        lados: [
          { lado: "a", tipo: "contato", contactId: 11, codigoAnonimo: "NW-AAAAAA", meu: true, originador: true, statusComissaoOriginador: "sem_negocio" },
          { lado: "b", tipo: "contato", contactId: null, codigoAnonimo: "NW-ZZZZZZ", meu: false, originador: false, statusComissaoOriginador: null },
        ],
      })],
    });
    render(<MeuNetworkInteligente />);
    expect(screen.getByText("Contato de outro network (NW-ZZZZZZ)")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "NW-ZZZZZZ" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Registrar apresentação" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Registrar negociação" }));
    expect(duble.avancar).toHaveBeenCalledWith({ conexaoId: "c-2", etapa: "negociacao" });
    expect(screen.getByText(/Sua participação como originadora: sem negócio/)).toBeInTheDocument();
  });

  it("fechamento já confirmado pela dona: sem o botão de fechar de novo, com o aviso de que falta o outro lado", () => {
    servidorResponde(dados(), {
      termoAceito: true, contagem: CONTAGEM,
      lista: [conexao({ id: "c-3", origem: "NETWORK_NETWORK_MATCH", status: "negociacao", fechamentoConfirmadoPorMim: true })],
    });
    render(<MeuNetworkInteligente />);
    expect(screen.queryByRole("button", { name: "Registrar fechamento" })).not.toBeInTheDocument();
    expect(screen.getByText("Fechamento confirmado por você. Falta a confirmação do outro lado.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Descartar" })).toBeInTheDocument();
  });

  it("procurar na rede global chama o servidor; a explicação diz o que nunca sai", () => {
    servidorResponde(dados());
    render(<MeuNetworkInteligente />);
    expect(screen.getByText(/Nome, telefone, e-mail, áudio, transcrição e notas nunca saem/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Procurar conexões na rede global" }));
    expect(duble.procurar).toHaveBeenCalledTimes(1);
  });
});

describe("Meu Network Inteligente — busca inteligente", () => {
  it("pergunta à Memória e mostra a resposta com os contatos, que levam ao perfil", () => {
    servidorResponde(dados());
    duble.resultadoDaBusca = {
      answer: "A Bia procura distribuidores.",
      hits: [
        { id: "h1", sourceType: "contact", sourceId: "12", title: "Bia Souza", content: "", metadata: {}, score: 0.9 },
        { id: "h2", sourceType: "meeting", sourceId: "m-1", title: "Reunião", content: "", metadata: {}, score: 0.5 },
      ],
      pending: 0, truncated: 0,
    };
    render(<MeuNetworkInteligente />);
    fireEvent.change(screen.getByPlaceholderText("Ex.: Quem eu conheço que procura distribuidores?"), { target: { value: "Quem procura distribuidores?" } });
    fireEvent.click(screen.getByRole("button", { name: "Pesquisar" }));
    expect(duble.buscar).toHaveBeenCalledWith({ query: "Quem procura distribuidores?" });
    expect(screen.getByText("A Bia procura distribuidores.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Bia Souza/ })).toHaveAttribute("href", "/meu-network-inteligente/contatos/12");
    expect(screen.queryByRole("link", { name: /Reunião/ })).not.toBeInTheDocument();
    // Índice em dia: nenhum aviso de busca incompleta.
    expect(screen.queryByText(/registros na fila/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Registros fora da busca/)).not.toBeInTheDocument();
  });

  it("índice pela metade: 'nenhum contato' vem com os avisos de fila e de limite, nunca sozinho", () => {
    servidorResponde(dados());
    duble.resultadoDaBusca = { answer: "Não encontrei ninguém.", hits: [], pending: 4, truncated: 2 };
    render(<MeuNetworkInteligente />);
    expect(screen.getByText("Nenhum contato da sua rede apareceu para essa pergunta.")).toBeInTheDocument();
    expect(screen.getByText("Sua rede ainda está sendo indexada (registros na fila: 4). A resposta pode estar incompleta; pergunte de novo em instantes.")).toBeInTheDocument();
    expect(screen.getByText("Registros fora da busca: 2. Sua conta passou do limite de documentos da memória, e a busca não os enxerga.")).toBeInTheDocument();
  });

  it("só a fila, sem estouro de limite: um aviso só", () => {
    servidorResponde(dados());
    duble.resultadoDaBusca = { answer: "Não encontrei ninguém.", hits: [], pending: 1, truncated: 0 };
    render(<MeuNetworkInteligente />);
    expect(screen.getByText(/registros na fila: 1\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Registros fora da busca/)).not.toBeInTheDocument();
  });
});

describe("Meu Network Inteligente — contatos com informações faltando", () => {
  it("alerta do pedido, o que falta em cada contato e o atalho para o perfil dele", () => {
    servidorResponde(dados());
    render(<MeuNetworkInteligente />);
    expect(screen.getByText(ALERTA)).toBeInTheDocument();

    const bia = screen.getByText("Bia Souza").closest("li")!;
    expect(within(bia).getByText("Faltando: Telefone, O Que Preciso")).toBeInTheDocument();
    expect(within(bia).getByRole("link", { name: /Completar informações/ })).toHaveAttribute("href", "/meu-network-inteligente/contatos/12");

    const duda = screen.getByText("Duda Lima").closest("li")!;
    expect(within(duda).getByText("Faltando: Telefone, E-mail, O Que Tenho")).toBeInTheDocument();

    expect(screen.getByText(/Mostrando 5 de 7\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ver todos os contatos" })).toHaveAttribute("href", "/network");
  });

  it("todos completos: sem alerta, sem atalho de completar", () => {
    servidorResponde(dados({ contatos: { total: 9, incompletos: 0, disponibilizados: 0, amostraIncompletos: [] } }));
    render(<MeuNetworkInteligente />);
    expect(screen.getByText("Todos os seus contatos têm Quem Sou, O Que Tenho e O Que Preciso preenchidos.")).toBeInTheDocument();
    expect(screen.queryByText(ALERTA)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Completar informações/ })).not.toBeInTheDocument();
  });

  it("sem contatos: convite a gravar ou cadastrar, sem alerta", () => {
    servidorResponde(dados({ contatos: { total: 0, incompletos: 0, disponibilizados: 0, amostraIncompletos: [] } }));
    render(<MeuNetworkInteligente />);
    expect(screen.getByText("Você ainda não tem contatos. Grave uma reunião ou cadastre o primeiro contato.")).toBeInTheDocument();
    expect(screen.queryByText(ALERTA)).not.toBeInTheDocument();
  });

  it("amostra inteira: sem o 'Mostrando X de Y'", () => {
    servidorResponde(dados({ contatos: { total: 9, incompletos: 2, disponibilizados: 0, amostraIncompletos: AMOSTRA.slice(0, 2) } }));
    render(<MeuNetworkInteligente />);
    expect(screen.queryByText(/Mostrando/)).not.toBeInTheDocument();
  });
});

describe("Meu Network Inteligente — carregando e erro", () => {
  it("erro de consulta: mensagem do servidor e tentar de novo, sem nenhum número", () => {
    duble.minutos.mockReturnValue(consulta(MINUTOS));
    duble.conexoes.mockReturnValue(consulta({ termoAceito: false }));
    duble.resumo.mockReturnValue({
      data: undefined, isLoading: false, isError: true, refetch,
      error: { message: "Banco de dados indisponível. Tente de novo em instantes.", data: { code: "INTERNAL_SERVER_ERROR" } },
    });
    render(<MeuNetworkInteligente />);
    const alerta = screen.getByRole("alert");
    expect(within(alerta).getByText("Banco de dados indisponível. Tente de novo em instantes.")).toBeInTheDocument();
    fireEvent.click(within(alerta).getByRole("button"));
    expect(refetch).toHaveBeenCalled();
    expect(screen.queryByText("Minhas reuniões")).not.toBeInTheDocument();
    expect(screen.queryByText("Você ainda não tem contatos. Grave uma reunião ou cadastre o primeiro contato.")).not.toBeInTheDocument();
  });

  it("registro em erro: o erro aparece no lugar da lista, e os indicadores do registro não viram zero", () => {
    servidorResponde(dados());
    duble.conexoes.mockReturnValue({
      data: undefined, isLoading: false, isError: true, refetch,
      error: { message: "Banco de dados indisponível. Tente de novo em instantes.", data: { code: "INTERNAL_SERVER_ERROR" } },
    });
    render(<MeuNetworkInteligente />);
    expect(screen.getByRole("alert")).toHaveTextContent("Banco de dados indisponível");
    expect(within(cartao("Intermediações")).getByText("—")).toBeInTheDocument();
  });

  it("carregando: indicador de status, sem números nem estado vazio", () => {
    duble.minutos.mockReturnValue(consulta(undefined));
    duble.conexoes.mockReturnValue(consulta(undefined));
    duble.resumo.mockReturnValue({ data: undefined, isLoading: true, isError: false, error: null, refetch });
    render(<MeuNetworkInteligente />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByText("Minhas reuniões")).not.toBeInTheDocument();
  });

  it("em inglês, a tela inteira troca de idioma", async () => {
    await i18n.changeLanguage("en");
    servidorResponde(dados());
    render(<MeuNetworkInteligente />);
    expect(screen.getByText("Need more time? Expand your meeting minutes.")).toBeInTheDocument();
    expect(screen.getByText("Missing: Phone, What I Need")).toBeInTheDocument();
    expect(screen.getByText("Deals in progress")).toBeInTheDocument();
    for (const pt of ["Minhas reuniões", MAIS_TEMPO, ALERTA, "Completar informações", "Negócios em andamento"]) {
      expect(screen.queryByText(pt)).not.toBeInTheDocument();
    }
  });
});
