import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { NotificationBell } from "./NotificationBell";

/**
 * Os avisos do gravador no sino (H15): o lembrete da próxima ação, o da
 * reunião da agenda e o de reunião pronta saem no idioma de quem lê, pelo tipo
 * e pelos parâmetros, e tocar um aviso novo marca só ele como lido (os outros
 * continuam novos). O resto do sino em cada idioma está em
 * NotificationBell.i18n.test.tsx.
 */

const duble = vi.hoisted(() => {
  const lista: { data: unknown[] | undefined; isError: boolean; error: unknown } = { data: [], isError: false, error: null };
  const marcarUm = vi.fn();
  const marcarTodos = vi.fn();
  const trpc = {
    notifications: {
      list: { useQuery: () => ({ data: lista.data, isLoading: false, isError: lista.isError, error: lista.error, refetch: vi.fn() }) },
      markRead: { useMutation: () => ({ mutate: marcarUm, isPending: false }) },
      markAllRead: { useMutation: () => ({ mutate: marcarTodos, isPending: false }) },
    },
  };
  return { lista, marcarUm, marcarTodos, trpc };
});

vi.mock("@/lib/trpc", () => ({ trpc: duble.trpc }));
// O <Link> do wouter vira um <a> com o mesmo href: o teste lê para onde o aviso leva.
vi.mock("wouter", () => ({
  Link: ({ href, onClick, children }: { href: string; onClick?: () => void; children: React.ReactNode }) =>
    <a href={href} onClick={evento => { evento.preventDefault(); onClick?.(); }}>{children}</a>,
}));

const ACAO = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const AGENDA = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const REUNIAO = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
// O relógio fica em 16/11/2026: o prazo de 20/11/2026 sai sem o ano só dentro
// do ano corrente, e o resultado não pode mudar com a data de quem roda (a
// partir de 2027 o ano entraria no texto e o CI ficaria vermelho).
const AGORA = new Date(2026, 10, 16, 10).getTime();

const avisos = () => [
  {
    id: 1, type: "lembrete", title: "{F2} manda a proposta", body: null, actionUrl: `/proximas-acoes?acao=${ACAO}`, isRead: false,
    parametros: { origem: "acao", texto: "{F2} manda a proposta", prazo: "2026-11-20" }, createdAt: new Date(AGORA - 60_000),
  },
  {
    id: 2, type: "lembrete", title: "Com a Bia", body: null, actionUrl: `/gravar?agendada=${AGENDA}`, isRead: false,
    parametros: { origem: "agenda", titulo: "Com a Bia", inicioEm: Date.UTC(2026, 10, 20, 17), fuso: "America/Sao_Paulo" }, createdAt: new Date(AGORA - 120_000),
  },
  {
    id: 3, type: "reuniao_pronta", title: "Comitê de exportação", body: null, actionUrl: `/meetings/${REUNIAO}`, isRead: true,
    parametros: { titulo: "Comitê de exportação", resumo: "pronto" }, createdAt: new Date(AGORA - 180_000),
  },
];

function abrirSino() {
  render(<NotificationBell />);
  fireEvent.click(screen.getAllByRole("button")[0]);
}

beforeEach(() => {
  // Só o Date: os timers de verdade seguem para o React e a Testing Library.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AGORA);
  duble.lista.data = avisos();
  duble.lista.isError = false;
  duble.lista.error = null;
  duble.marcarUm.mockClear();
  duble.marcarTodos.mockClear();
});
afterEach(async () => {
  vi.useRealTimers();
  await i18n.changeLanguage("pt-BR");
});

describe("os avisos do gravador no sino (H15)", () => {
  it("em português: cada um pelo tipo, com o texto da origem embaixo e o link para ela", () => {
    abrirSino();
    expect(screen.getByText("Lembrete: próxima ação para 20 de nov.")).toBeInTheDocument();
    expect(screen.getByText("Falante 2 manda a proposta")).toBeInTheDocument();
    expect(screen.getByText(/^Lembrete de reunião: .*14:00/)).toBeInTheDocument();
    expect(screen.getByText("Com a Bia")).toBeInTheDocument();
    expect(screen.getByText("Sua reunião está pronta: transcrição e resumo")).toBeInTheDocument();
    // Os três avisos e, no rodapé, o "Ver todas".
    const links = screen.getAllByRole("link").map(link => link.getAttribute("href"));
    expect(links).toEqual([`/proximas-acoes?acao=${ACAO}`, `/gravar?agendada=${AGENDA}`, `/meetings/${REUNIAO}`, "/dashboard"]);
  });

  it("em inglês, sem sobrar português nos títulos (o texto da dona fica como ela escreveu)", async () => {
    await i18n.changeLanguage("en");
    abrirSino();
    expect(screen.getByText("Reminder: next action due Nov 20")).toBeInTheDocument();
    expect(screen.getByText("Speaker 2 manda a proposta")).toBeInTheDocument();
    expect(screen.getByText(/^Meeting reminder: /)).toBeInTheDocument();
    expect(screen.getByText("Your meeting is ready: transcript and summary")).toBeInTheDocument();
    expect(screen.queryByText(/Lembrete|Sua reunião/)).not.toBeInTheDocument();
  });

  it("tocar um aviso novo marca só ele como lido e fecha a lista; o já lido não chama nada", () => {
    abrirSino();
    fireEvent.click(screen.getByText("Falante 2 manda a proposta"));
    expect(duble.marcarUm).toHaveBeenCalledTimes(1);
    expect(duble.marcarUm).toHaveBeenCalledWith({ id: 1 });
    expect(duble.marcarTodos).not.toHaveBeenCalled();
    expect(screen.queryByText("Com a Bia")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button")[0]);
    fireEvent.click(screen.getByText("Comitê de exportação"));
    expect(duble.marcarUm).toHaveBeenCalledTimes(1);
  });

  it("o aviso sem link, novo: tocar marca lido e a lista fica aberta", () => {
    duble.lista.data = [{ id: 9, type: "system", title: "Aviso do sistema", body: "Corpo", actionUrl: null, isRead: false, parametros: null, createdAt: new Date() }];
    abrirSino();
    fireEvent.click(screen.getByText("Aviso do sistema"));
    expect(duble.marcarUm).toHaveBeenCalledWith({ id: 9 });
    expect(screen.getByText("Aviso do sistema")).toBeInTheDocument();
  });

  it("o aviso do gravador com o parâmetro estragado mostra o título guardado", () => {
    duble.lista.data = [{ id: 5, type: "lembrete", title: "Mandar o contrato", body: null, actionUrl: null, isRead: true, parametros: { origem: "acao" }, createdAt: new Date() }];
    abrirSino();
    expect(screen.getByText("Mandar o contrato")).toBeInTheDocument();
  });

  it("erro de consulta é erro, nunca 'nenhuma notificação'", () => {
    duble.lista.data = undefined;
    duble.lista.isError = true;
    duble.lista.error = { message: "Banco de dados indisponível", data: { code: "INTERNAL_SERVER_ERROR" } };
    abrirSino();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Nenhuma notificação ainda")).not.toBeInTheDocument();
  });
});
