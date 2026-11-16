import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Memory from "./Memory";

/**
 * O "Abrir fonte" da Memória leva ao detalhe da reunião (30/10/2026), inclusive
 * nos documentos indexados antes da mudança, que guardam o href da lista
 * (/meetings): a tela abre pelo metadata.meetingId. As outras fontes seguem o
 * href gravado.
 */

const duble = vi.hoisted(() => ({
  resultado: { answer: "Resposta.", pending: 0, truncated: 0, hits: [] as unknown[] },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ memory: { status: { invalidate: vi.fn() } } }),
    memory: {
      status: { useQuery: () => ({ data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() }) },
      reindex: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      search: { useMutation: () => ({ mutate: vi.fn(), isPending: false, data: duble.resultado }) },
    },
  },
}));

const fonte = (sourceType: string, metadata: Record<string, unknown>, title: string) => ({
  id: `${sourceType}-${title}`, sourceType, title, content: "Trecho.", score: 0.9, metadata,
});

beforeEach(() => {
  window.history.replaceState(null, "", "/memory");
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("Memória — Abrir fonte", () => {
  it("documento de reunião antigo, com o href da lista, abre o detalhe da reunião", () => {
    duble.resultado.hits = [fonte("meeting", { href: "/meetings", meetingId: "m-1", kind: "Reunião" }, "Reunião com a vinícola")];
    render(<Memory />);
    fireEvent.click(screen.getByRole("button", { name: /Abrir fonte/ }));
    expect(window.location.pathname).toBe("/meetings/m-1");
  });

  it("contato abre o href gravado", () => {
    duble.resultado.hits = [fonte("contact", { href: "/network", contactId: 3, kind: "Contato" }, "Ana")];
    render(<Memory />);
    fireEvent.click(screen.getByRole("button", { name: /Abrir fonte/ }));
    expect(window.location.pathname).toBe("/network");
  });

  it("fonte sem href nem reunião não mostra o botão", () => {
    duble.resultado.hits = [fonte("contact", {}, "Sem destino")];
    render(<Memory />);
    expect(screen.queryByRole("button", { name: /Abrir fonte/ })).not.toBeInTheDocument();
  });
});
