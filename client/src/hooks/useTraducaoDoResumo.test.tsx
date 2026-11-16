import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useTraducaoDoResumo } from "./useTraducaoDoResumo";

/**
 * A tradução do resumo guardado na tela (H11): quando pedir, a quem (a rota da
 * dona ou a do link), o que fazer com "traduzindo", com o erro e com a resposta
 * que chega atrasada, e como os textos traduzidos entram no resumo. O tRPC é
 * dublê: cada mutate fica registrado com as opções, e o teste responde por elas.
 */
type Opcoes = { onSuccess: (resposta: unknown) => void; onError: (erro: unknown) => void };
const duble = vi.hoisted(() => ({
  daDona: { mutate: vi.fn() },
  doLink: { mutate: vi.fn() },
  utils: { meetings: { resumoGuardado: { invalidate: vi.fn() } }, reuniaoAberta: { resumoGuardado: { invalidate: vi.fn() } } },
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => duble.utils,
    meetings: { traduzirResumo: { useMutation: () => duble.daDona } },
    reuniaoAberta: { traduzirResumo: { useMutation: () => duble.doLink } },
  },
}));

const REUNIAO = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const itemDaDona = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id, section: "decision", position: 0, subject: null, text, assignee: null, due: null, excerpt: `trecho de ${id}`, startSeconds: 1, status: "pending", done: false, ...extra,
});
const resumoDaDona = (itens = [itemDaDona("a", "Renovar o contrato"), itemDaDona("b", "{F2} manda a proposta")], idioma: string | null = "pt-BR") =>
  ({ estado: "pronto", emoji: null, idioma, erro: null, itens }) as never;
const ultimoPedido = (m: { mutate: ReturnType<typeof vi.fn> }) => m.mutate.mock.calls.at(-1) as [Record<string, unknown>, Opcoes];
const textos = (resumo: unknown) => (resumo as { itens: Array<{ text: string }> }).itens.map(item => item.text);

beforeEach(() => {
  duble.daDona.mutate.mockReset();
  duble.doLink.mutate.mockReset();
  duble.utils.meetings.resumoGuardado.invalidate.mockReset();
  duble.utils.reuniaoAberta.resumoGuardado.invalidate.mockReset();
});
afterEach(async () => {
  vi.useRealTimers();
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

async function telaEm(idioma: string) {
  await act(async () => { await i18n.changeLanguage(idioma); });
}

describe("useTraducaoDoResumo — para a dona", () => {
  it("com a tela no idioma do resumo, não pede: o resumo é o original", () => {
    const { result } = renderHook(() => useTraducaoDoResumo({ meetingId: REUNIAO }, resumoDaDona()));
    expect(result.current.estado).toBe("original");
    expect(result.current.idioma).toBe("pt-BR");
    expect(result.current.idiomaOriginal).toBe("pt-BR");
    expect(duble.daDona.mutate).not.toHaveBeenCalled();
  });

  it("sem resumo pronto, ou sem itens, não há o que traduzir", async () => {
    await telaEm("en");
    const { result, rerender } = renderHook(({ resumo }) => useTraducaoDoResumo({ meetingId: REUNIAO }, resumo), {
      initialProps: { resumo: { estado: "gerando", emoji: null, idioma: null, erro: null, itens: [] } as never },
    });
    expect(result.current.estado).toBe("inativa");
    rerender({ resumo: resumoDaDona([]) });
    expect(result.current.estado).toBe("inativa");
    rerender({ resumo: undefined as never });
    expect(result.current.estado).toBe("inativa");
    expect(duble.daDona.mutate).not.toHaveBeenCalled();
  });

  it("com a tela em outro idioma, pede pela rota da dona e põe os textos traduzidos pelo id, com o estado de cada item vindo do resumo", async () => {
    await telaEm("en-US");
    const resumo = resumoDaDona([itemDaDona("a", "Renovar o contrato", { status: "confirmed" }), itemDaDona("b", "{F2} manda a proposta", { due: "sexta" }), itemDaDona("c", "Item novo")]);
    const { result } = renderHook(() => useTraducaoDoResumo({ meetingId: REUNIAO }, resumo));
    expect(result.current.estado).toBe("traduzindo");
    expect(duble.doLink.mutate).not.toHaveBeenCalled();
    const [entrada, { onSuccess }] = ultimoPedido(duble.daDona);
    expect(entrada).toEqual({ meetingId: REUNIAO, idioma: "en" });

    act(() => onSuccess({
      estado: "pronta", idioma: "en", mapa: { Prazos: "Deadlines" },
      itens: [{ id: "a", subject: null, text: "Renew the contract", due: null }, { id: "b", subject: null, text: "{F2} sends the proposal", due: "Friday" }],
    }));
    expect(result.current.estado).toBe("pronta");
    const aplicado = result.current.aplicar(resumo) as unknown as { itens: Array<{ id: string; text: string; due: string | null; status: string; excerpt: string }> };
    expect(aplicado.itens.map(i => [i.id, i.text, i.due, i.status])).toEqual([
      ["a", "Renew the contract", null, "confirmed"],
      ["b", "{F2} sends the proposal", "Friday", "pending"],
      // Sem tradução para ele: fica como está.
      ["c", "Item novo", null, "pending"],
    ]);
    expect(aplicado.itens[0].excerpt).toBe("trecho de a");
    expect(result.current.traduzirRotulo("Prazos")).toBe("Deadlines");
    expect(result.current.traduzirRotulo("Riscos")).toBe("Riscos");
    expect(result.current.traduzirRotulo("toString")).toBe("toString");
    expect(result.current.traduzirRotulo("__proto__")).toBe("__proto__");
  });

  it("'traduzindo': pergunta de novo a cada 5 s, até a tradução chegar", async () => {
    await telaEm("es");
    vi.useFakeTimers();
    const { result } = renderHook(() => useTraducaoDoResumo({ meetingId: REUNIAO }, resumoDaDona()));
    act(() => ultimoPedido(duble.daDona)[1].onSuccess({ estado: "traduzindo", idioma: "es" }));
    expect(duble.daDona.mutate).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(duble.daDona.mutate).toHaveBeenCalledTimes(2);
    expect(result.current.estado).toBe("traduzindo");
    act(() => ultimoPedido(duble.daDona)[1].onSuccess({ estado: "pronta", idioma: "es", mapa: {}, itens: [] }));
    expect(result.current.estado).toBe("pronta");
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(duble.daDona.mutate).toHaveBeenCalledTimes(2);
  });

  it("o erro para de perguntar e fica até 'tentar de novo'", async () => {
    await telaEm("de");
    vi.useFakeTimers();
    const { result } = renderHook(() => useTraducaoDoResumo({ meetingId: REUNIAO }, resumoDaDona()));
    const erro = { message: "A tradução do resumo não respondeu agora.", data: { code: "SERVICE_UNAVAILABLE" } };
    act(() => ultimoPedido(duble.daDona)[1].onError(erro));
    expect(result.current.estado).toBe("erro");
    expect(result.current.erro).toBe(erro);
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(duble.daDona.mutate).toHaveBeenCalledTimes(1);

    act(() => result.current.tentarDeNovo());
    expect(duble.daDona.mutate).toHaveBeenCalledTimes(2);
    expect(result.current.estado).toBe("traduzindo");
  });

  it("escolher o original para de traduzir; a resposta atrasada de um pedido velho é descartada", async () => {
    await telaEm("en");
    const { result } = renderHook(() => useTraducaoDoResumo({ meetingId: REUNIAO }, resumoDaDona()));
    const [, pedidoEmIngles] = ultimoPedido(duble.daDona);

    act(() => result.current.escolher("pt-BR"));
    expect(result.current.estado).toBe("original");
    act(() => pedidoEmIngles.onSuccess({ estado: "pronta", idioma: "en", mapa: {}, itens: [{ id: "a", subject: null, text: "Renew", due: null }] }));
    expect(result.current.estado).toBe("original");

    act(() => result.current.escolher("ja"));
    expect(ultimoPedido(duble.daDona)[0]).toEqual({ meetingId: REUNIAO, idioma: "ja" });
    // A resposta em inglês, de antes, não vale para o japonês.
    act(() => pedidoEmIngles.onSuccess({ estado: "pronta", idioma: "en", mapa: {}, itens: [{ id: "a", subject: null, text: "Renew", due: null }] }));
    expect(result.current.estado).toBe("traduzindo");
  });

  it("a resposta (ou o erro) de um pedido feito antes de o texto mudar é descartada, mesmo no mesmo idioma", async () => {
    await telaEm("en");
    const { result, rerender } = renderHook(({ resumo }) => useTraducaoDoResumo({ meetingId: REUNIAO }, resumo), { initialProps: { resumo: resumoDaDona() } });
    const [, antigo] = ultimoPedido(duble.daDona);
    const editado = resumoDaDona([itemDaDona("a", "Renovar o contrato por dois anos"), itemDaDona("b", "{F2} manda a proposta")]);
    rerender({ resumo: editado });
    expect(duble.daDona.mutate).toHaveBeenCalledTimes(2);

    act(() => antigo.onSuccess({ estado: "pronta", idioma: "en", mapa: {}, itens: [{ id: "a", subject: null, text: "Renew the contract", due: null }] }));
    act(() => antigo.onError({ data: { code: "SERVICE_UNAVAILABLE" } }));
    expect(result.current.estado).toBe("traduzindo");
    expect((result.current.aplicar(editado) as unknown as { itens: Array<{ text: string }> }).itens[0].text).toBe("Renovar o contrato por dois anos");
  });

  it("texto do resumo mudou: pede de novo e mostra o original até a resposta; decidir um item não pede", async () => {
    await telaEm("en");
    const { result, rerender } = renderHook(({ resumo }) => useTraducaoDoResumo({ meetingId: REUNIAO }, resumo), { initialProps: { resumo: resumoDaDona() } });
    act(() => ultimoPedido(duble.daDona)[1].onSuccess({ estado: "pronta", idioma: "en", mapa: {}, itens: [{ id: "a", subject: null, text: "Renew the contract", due: null }] }));
    expect(result.current.estado).toBe("pronta");

    rerender({ resumo: resumoDaDona([itemDaDona("a", "Renovar o contrato", { status: "confirmed" }), itemDaDona("b", "{F2} manda a proposta")]) });
    expect(duble.daDona.mutate).toHaveBeenCalledTimes(1);
    expect(result.current.estado).toBe("pronta");

    const editado = resumoDaDona([itemDaDona("a", "Renovar o contrato por dois anos"), itemDaDona("b", "{F2} manda a proposta")]);
    rerender({ resumo: editado });
    expect(duble.daDona.mutate).toHaveBeenCalledTimes(2);
    expect(result.current.estado).toBe("traduzindo");
    expect((result.current.aplicar(editado) as unknown as { itens: Array<{ text: string }> }).itens[0].text).toBe("Renovar o contrato por dois anos");
  });

  describe("o mapa mental que fica pronto depois do resumo (H10)", () => {
    const EM_INGLES = [{ id: "a", subject: null, text: "Renew the contract", due: null }];
    const montar = async () => {
      await telaEm("en");
      const resumo = resumoDaDona();
      const tela = renderHook(({ rotulos }) => useTraducaoDoResumo({ meetingId: REUNIAO }, resumo, rotulos), { initialProps: { rotulos: undefined as string[] | undefined } });
      act(() => ultimoPedido(duble.daDona)[1].onSuccess({ estado: "pronta", idioma: "en", mapa: {}, itens: EM_INGLES }));
      expect(tela.result.current.estado).toBe("pronta");
      return { ...tela, resumo };
    };

    it("o mapa que chega pede de novo; os itens seguem traduzidos até a resposta, e o mesmo mapa não pede outra vez", async () => {
      const { result, rerender, resumo } = await montar();

      rerender({ rotulos: ["Prazos", "Lojas"] });
      expect(duble.daDona.mutate).toHaveBeenCalledTimes(2);
      expect(ultimoPedido(duble.daDona)[0]).toEqual({ meetingId: REUNIAO, idioma: "en" });
      expect(result.current.estado).toBe("pronta");
      expect(textos(result.current.aplicar(resumo))[0]).toBe("Renew the contract");
      expect(result.current.traduzirRotulo("Prazos")).toBe("Prazos");

      act(() => ultimoPedido(duble.daDona)[1].onSuccess({ estado: "pronta", idioma: "en", mapa: { Prazos: "Deadlines", Lojas: "Stores" }, itens: EM_INGLES }));
      expect(result.current.traduzirRotulo("Prazos")).toBe("Deadlines");
      expect(result.current.traduzirRotulo("Lojas")).toBe("Stores");

      // Os mesmos rótulos, em outra ordem, repetidos ou num array novo.
      rerender({ rotulos: ["Lojas", "Prazos", "Lojas"] });
      expect(duble.daDona.mutate).toHaveBeenCalledTimes(2);
    });

    it("o pedido dos rótulos que falha mostra o erro com o resumo no original; 'Tentar de novo' volta à tradução enquanto pede", async () => {
      const { result, rerender, resumo } = await montar();
      rerender({ rotulos: ["Prazos"] });

      act(() => ultimoPedido(duble.daDona)[1].onError({ data: { code: "SERVICE_UNAVAILABLE" } }));
      expect(result.current.estado).toBe("erro");
      expect(textos(result.current.aplicar(resumo))[0]).toBe("Renovar o contrato");

      act(() => result.current.tentarDeNovo());
      expect(duble.daDona.mutate).toHaveBeenCalledTimes(3);
      expect(result.current.estado).toBe("pronta");
      expect(textos(result.current.aplicar(resumo))[0]).toBe("Renew the contract");
    });
  });

  it("'sem_resumo' do servidor (a reunião foi reprocessada): não fica em 'traduzindo', para de perguntar e relê o resumo", async () => {
    await telaEm("en");
    vi.useFakeTimers();
    const { result } = renderHook(() => useTraducaoDoResumo({ meetingId: REUNIAO }, resumoDaDona()));
    act(() => ultimoPedido(duble.daDona)[1].onSuccess({ estado: "sem_resumo", idioma: "en" }));
    expect(result.current.estado).toBe("inativa");
    expect(duble.utils.meetings.resumoGuardado.invalidate).toHaveBeenCalledWith({ meetingId: REUNIAO });
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(duble.daDona.mutate).toHaveBeenCalledTimes(1);
  });

  it("'original' do servidor (o resumo foi refeito no idioma pedido): mostra o original e relê; o resumo relido não pede de novo", async () => {
    await telaEm("en");
    const { result, rerender } = renderHook(({ resumo }) => useTraducaoDoResumo({ meetingId: REUNIAO }, resumo), { initialProps: { resumo: resumoDaDona() } });
    act(() => ultimoPedido(duble.daDona)[1].onSuccess({ estado: "original", idioma: "en" }));
    expect(result.current.estado).toBe("original");
    expect(duble.utils.meetings.resumoGuardado.invalidate).toHaveBeenCalledWith({ meetingId: REUNIAO });

    rerender({ resumo: resumoDaDona([itemDaDona("a2", "Renew the contract")], "en") });
    expect(result.current.estado).toBe("original");
    expect(duble.daDona.mutate).toHaveBeenCalledTimes(1);
  });
});

describe("useTraducaoDoResumo — pelo link", () => {
  const itemDoLink = (text: string, status = "pending") => ({ section: "action", subject: null, text, assignee: null, due: null, excerpt: "trecho", startSeconds: 2, status });
  const resumoDoLink = (itens = [itemDoLink("Enviar a proposta")]) => ({ estado: "pronto", emoji: null, idioma: "pt-BR", itens }) as never;

  it("pede pela rota do link, com o token, e o resumo traduzido entra inteiro", async () => {
    await telaEm("fr");
    const resumo = resumoDoLink();
    const { result } = renderHook(() => useTraducaoDoResumo({ token: TOKEN }, resumo));
    const [entrada, { onSuccess }] = ultimoPedido(duble.doLink);
    expect(entrada).toEqual({ token: TOKEN, idioma: "fr" });
    expect(duble.daDona.mutate).not.toHaveBeenCalled();
    act(() => onSuccess({ estado: "pronta", idioma: "fr", mapa: {}, itens: [itemDoLink("Envoyer la proposition")] }));
    expect((result.current.aplicar(resumo) as unknown as { itens: Array<{ text: string }> }).itens.map(i => i.text)).toEqual(["Envoyer la proposition"]);
  });

  it("pelo link, o estado do item também conta: a dona confirmou, a página pede de novo (sem IA, a tradução está guardada)", async () => {
    await telaEm("fr");
    const { rerender } = renderHook(({ resumo }) => useTraducaoDoResumo({ token: TOKEN }, resumo), { initialProps: { resumo: resumoDoLink() } });
    rerender({ resumo: resumoDoLink([itemDoLink("Enviar a proposta", "confirmed")]) });
    expect(duble.doLink.mutate).toHaveBeenCalledTimes(2);
  });

  it("pelo link, 'sem_resumo' (a dona refez o resumo) relê o resumo do link, que não relê sozinho", async () => {
    await telaEm("fr");
    const { result } = renderHook(() => useTraducaoDoResumo({ token: TOKEN }, resumoDoLink()));
    act(() => ultimoPedido(duble.doLink)[1].onSuccess({ estado: "sem_resumo", idioma: "fr" }));
    expect(result.current.estado).toBe("inativa");
    expect(duble.utils.reuniaoAberta.resumoGuardado.invalidate).toHaveBeenCalledWith({ token: TOKEN });
    expect(duble.utils.meetings.resumoGuardado.invalidate).not.toHaveBeenCalled();
  });
});
