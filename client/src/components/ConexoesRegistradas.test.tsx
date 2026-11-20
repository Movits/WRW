import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ConexaoRegistrada, referenciaDaConexao, type ConexaoNaTela } from "./ConexoesRegistradas";

/**
 * Conexão registrada vista por quem participa (Meu Network Inteligente e perfil
 * do contato). O que se trava: descartar é irreversível no servidor
 * (avancarConexao recusa qualquer etapa depois do descarte de quem pede), então
 * o botão "Descartar" só abre a confirmação; a mutação sai no botão do diálogo.
 * Avançar para a próxima etapa continua num clique.
 */

type OpcoesDaMutacao = { onSuccess?: (resultado: { aguardandoOutroLado: boolean }) => void; onError?: () => void };

const duble = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  opcoes: {} as { onSuccess?: (resultado: { aguardandoOutroLado: boolean }) => void; onError?: () => void },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      networkInteligente: { conexoes: { invalidate: vi.fn() }, contato: { invalidate: vi.fn() } },
    }),
    networkInteligente: {
      avancarConexao: {
        useMutation: (opcoes: OpcoesDaMutacao) => {
          duble.opcoes = opcoes;
          return { mutate: duble.mutate, isPending: duble.isPending };
        },
      },
    },
  },
}));

const conexao = (extra: Partial<ConexaoNaTela> = {}): ConexaoNaTela => ({
  id: "c-1",
  origem: "PRIVATE_NETWORK_MATCH",
  itens: [{ tem: "Vinho", precisa: "Vinho", deCodigo: "NW-AAAAAA", paraCodigo: "NW-BBBBBB" }],
  status: "identificada",
  statusComissao: "sem_negocio",
  criadaEm: Date.UTC(2026, 8, 14),
  fechamentoConfirmadoPorMim: false,
  lados: [
    { lado: "a", tipo: "contato", contactId: null, codigoAnonimo: "NW-AAAAAA", meu: false, originador: false, statusComissaoOriginador: null },
    { lado: "b", tipo: "contato", contactId: null, codigoAnonimo: "NW-BBBBBB", meu: false, originador: false, statusComissaoOriginador: null },
  ],
  ...extra,
});

const renderizar = (c: ConexaoNaTela) => render(<ul><ConexaoRegistrada conexao={c} /></ul>);

beforeEach(() => {
  duble.mutate.mockClear();
  duble.isPending = false;
  duble.opcoes = {};
});

describe("Conexão registrada — descartar pede confirmação", () => {
  it("clicar em Descartar não descarta: abre o diálogo que avisa que não há volta", () => {
    renderizar(conexao());

    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));

    expect(duble.mutate).not.toHaveBeenCalled();
    const dialogo = screen.getByRole("dialog");
    expect(within(dialogo).getByText("Descartar esta conexão?")).toBeInTheDocument();
    expect(within(dialogo).getByText(/não pode ser desfeito/)).toBeInTheDocument();
  });

  it("cancelar fecha o diálogo sem gravar nada", () => {
    renderizar(conexao());

    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancelar" }));

    expect(duble.mutate).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("confirmar descarta esta conexão e o diálogo fecha quando o servidor aceita", () => {
    renderizar(conexao({ id: "c-negociacao", status: "negociacao" }));

    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));
    // O botão nomeia a conexão: quem descarta age sobre uma referência, não
    // sobre um cartão que parece igual ao de baixo.
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: `Descartar ${referenciaDaConexao("c-negociacao")}` }));

    expect(duble.mutate).toHaveBeenCalledTimes(1);
    expect(duble.mutate).toHaveBeenCalledWith({ conexaoId: "c-negociacao", etapa: "descartada" });

    act(() => duble.opcoes.onSuccess?.({ aguardandoOutroLado: false }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("avançar de etapa segue num clique, sem diálogo", () => {
    renderizar(conexao());

    fireEvent.click(screen.getByRole("button", { name: "Registrar apresentação" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(duble.mutate).toHaveBeenCalledWith({ conexaoId: "c-1", etapa: "apresentacao" });
  });

  it("conexão fechada ou já descartada não oferece Descartar", () => {
    const { unmount } = renderizar(conexao({ status: "fechada" }));
    expect(screen.queryByRole("button", { name: "Descartar" })).not.toBeInTheDocument();
    unmount();

    renderizar(conexao({ status: "descartada" }));
    expect(screen.queryByRole("button", { name: "Descartar" })).not.toBeInTheDocument();
  });
});

/**
 * Item 7 da revisão do Nicolas na #135: duas conexões entre membras viravam
 * dois cartões IDÊNTICOS — origem, status e data, e nada mais —, porque a
 * conexão entre membras não carrega item nenhum de propósito ("o que tenho" de
 * uma não aparece para a outra). A dona não tinha como saber qual era qual nem
 * por que existiam.
 */
describe("cartão sem itens mostra o motivo", () => {
  it("entre membras, a compatibilidade distingue um cartão do outro", () => {
    // A frase é montada AQUI, traduzida, e não vem do servidor: o motivo
    // gravado lá é português fixo, e este cartão é lido nos dez idiomas.
    renderizar(conexao({
      origem: "PLATFORM_MATCH",
      itens: [],
      pontuacao: 72,
      motivo: "MOTIVO CRU DO SERVIDOR: esta frase não pode chegar à tela.",
    }));

    expect(screen.getByText(
      "Sugerida pelo motor de perfis entre dois membros que tinham o termo do Smart Match aceito quando a conexão foi registrada: compatibilidade de 72%.",
    )).toBeInTheDocument();
    expect(screen.queryByText(/MOTIVO CRU DO SERVIDOR/)).not.toBeInTheDocument();
  });

  it("quando o outro lado tirou a autorização, o cartão diz isso em vez de ficar vazio", () => {
    renderizar(conexao({
      origem: "NETWORK_NETWORK_MATCH",
      itens: [],
      detalhesVisiveis: false,
      motivo: "frase em português que o servidor grava e a tela não usa aqui",
    }));

    expect(screen.getByText(/retirou a autoriza[çc][ãa]o/)).toBeInTheDocument();
  });

  it("com itens na tela, o motivo não repete o que já está escrito", () => {
    renderizar(conexao({
      itens: [{ tem: "Vinho", precisa: "Importador", deCodigo: null, paraCodigo: null }],
      motivo: "Motivo que não deve aparecer duas vezes.",
    }));

    expect(screen.queryByText(/não deve aparecer duas vezes/)).toBeNull();
  });
});

/**
 * A frase traduzida diz POR QUE a conexão existe, mas não diz QUAL delas é:
 * duas conexões da mesma rodada têm a mesma compatibilidade arredondada e o
 * mesmo minuto de registro. Quem descarta — e o descarte não volta atrás —
 * precisa de um campo que nunca empate, e que não revele quem é o outro lado.
 */
describe("entre membras, o que identifica a conexão antes do descarte", () => {
  const ladosDeMembras: ConexaoNaTela["lados"] = [
    { lado: "a", tipo: "membro", contactId: null, codigoAnonimo: null, meu: true, originador: false, statusComissaoOriginador: null },
    { lado: "b", tipo: "membro", contactId: null, codigoAnonimo: null, meu: false, originador: false, statusComissaoOriginador: null },
  ];
  const MESMA_RODADA = { pontuacao: 72, criadaEm: Date.UTC(2026, 8, 14, 15, 22) };
  const PAR_A = "0b3f0e4e-0000-4000-8000-0000000000a1";
  const PAR_B = "0b3f0e4e-0000-4000-8000-0000000000b2";
  const entreMembras = (extra: Partial<ConexaoNaTela> = {}) =>
    conexao({ origem: "PLATFORM_MATCH", itens: [], lados: ladosDeMembras, ...MESMA_RODADA, ...extra });

  afterEach(async () => {
    await i18n.changeLanguage("pt-BR");
  });

  it("o lado de quem olha não sai com o mesmo rótulo do lado alheio", () => {
    renderizar(entreMembras({ id: PAR_A }));

    expect(screen.getByText("Seu lado")).toBeInTheDocument();
    expect(screen.getByText("Membro da plataforma")).toBeInTheDocument();
  });

  it("dois pares da mesma rodada, com a mesma nota e o mesmo minuto, se separam pela referência", () => {
    render(
      <ul>
        <ConexaoRegistrada conexao={entreMembras({ id: PAR_A })} />
        <ConexaoRegistrada conexao={entreMembras({ id: PAR_B })} />
      </ul>,
    );

    const referencias = [referenciaDaConexao(PAR_A), referenciaDaConexao(PAR_B)];
    expect(new Set(referencias).size).toBe(2);
    for (const referencia of referencias) {
      expect(screen.getByText(`Referência ${referencia}`)).toBeInTheDocument();
    }
  });

  it("em japonês, a referência continua identificando o cartão", async () => {
    await i18n.changeLanguage("ja");
    renderizar(entreMembras({ id: PAR_A }));

    expect(screen.getByText(`参照番号 ${referenciaDaConexao(PAR_A)}`)).toBeInTheDocument();
  });

  it("a confirmação nomeia a conexão e avisa que o outro lado é anônimo", () => {
    renderizar(entreMembras({ id: PAR_A }));

    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));

    const dialogo = screen.getByRole("dialog");
    expect(within(dialogo).getByText("Entre membros da plataforma")).toBeInTheDocument();
    expect(within(dialogo).getByText(`Referência ${referenciaDaConexao(PAR_A)}`)).toBeInTheDocument();
    expect(within(dialogo).getByText(/O outro lado continua anônimo/)).toBeInTheDocument();
    expect(within(dialogo).getByRole("button", { name: `Descartar ${referenciaDaConexao(PAR_A)}` })).toBeInTheDocument();
    expect(duble.mutate).not.toHaveBeenCalled();
  });
});
