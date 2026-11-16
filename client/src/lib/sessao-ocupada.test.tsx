import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { Suspense, use } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  liberarTodas, motivoDaOcupacao, ocupar, sessaoOcupada, useOcupacao, useSessaoOcupada, type MotivoDaOcupacao,
} from "./sessao-ocupada";

/**
 * A sessão ocupada (PR S do gravador): até o envio, o áudio gravado só existe
 * na memória da aba. Quem grava ou envia abre uma ocupação; com alguma aberta,
 * o Sair pede confirmação (components/SairDaConta.tsx) e fechar ou recarregar
 * a aba pede a do navegador (o beforeunload, conferido no fim deste arquivo).
 *
 * O registro é um só no app, o do módulo: cada teste libera o que abriu, e
 * todo teste começa conferindo que a sessão está livre.
 */

const abertas: Array<() => void> = [];
function abrir(motivo: MotivoDaOcupacao) {
  const liberar = ocupar(motivo);
  abertas.push(liberar);
  return liberar;
}

/** O navegador avisa antes de fechar a aba: devolve se a página pediu a confirmação. */
function fecharAba() {
  const evento = new Event("beforeunload", { cancelable: true });
  // O returnValue do Event comum do jsdom ignora o true que a página grava; o do
  // navegador o guarda, e o Chrome e o Edge antes da 119 só perguntam com ele.
  Object.defineProperty(evento, "returnValue", { value: "", writable: true });
  window.dispatchEvent(evento);
  // A página pede pelas duas formas, ou por nenhuma.
  expect(Boolean(evento.returnValue)).toBe(evento.defaultPrevented);
  return evento.defaultPrevented;
}

beforeEach(() => {
  expect(sessaoOcupada()).toBe(false);
});

afterEach(() => {
  // Desmonta antes: os hooks montados também liberam o que ocuparam.
  cleanup();
  for (const liberar of abertas.splice(0)) liberar();
  vi.restoreAllMocks();
});

describe("sessão ocupada — ocupar e liberar", () => {
  it("ocupar marca a sessão; a função devolvida libera, e liberar de novo não faz nada", () => {
    expect(motivoDaOcupacao()).toBeNull();
    const liberar = abrir("enviando");
    expect(sessaoOcupada()).toBe(true);
    expect(motivoDaOcupacao()).toBe("enviando");
    liberar();
    expect(sessaoOcupada()).toBe(false);
    expect(motivoDaOcupacao()).toBeNull();
    liberar();
    expect(sessaoOcupada()).toBe(false);
  });

  it("duas ocupações do mesmo motivo: liberar a mesma duas vezes não solta a outra", () => {
    // O ditado e a reunião gravando ao mesmo tempo, por exemplo.
    const primeira = abrir("gravando");
    const segunda = abrir("gravando");
    primeira();
    primeira();
    expect(sessaoOcupada()).toBe(true);
    expect(motivoDaOcupacao()).toBe("gravando");
    segunda();
    expect(sessaoOcupada()).toBe(false);
  });

  it("vários motivos ao mesmo tempo: vale o principal (gravando > enviando > audio-nao-enviado), não o mais recente", () => {
    const envio = abrir("enviando");
    abrir("audio-nao-enviado");
    expect(motivoDaOcupacao()).toBe("enviando");
    const gravacao = abrir("gravando");
    expect(motivoDaOcupacao()).toBe("gravando");
    envio();
    expect(motivoDaOcupacao()).toBe("gravando");
    gravacao();
    // Sobra o áudio por enviar: a sessão continua ocupada por ele.
    expect(sessaoOcupada()).toBe(true);
    expect(motivoDaOcupacao()).toBe("audio-nao-enviado");
  });

  it("liberarTodas (o logout) solta todas de uma vez; o liberar que chega depois não reabre nada", () => {
    const envio = abrir("enviando");
    abrir("audio-nao-enviado");
    const tela = renderHook(() => useOcupacao("gravando", true));
    expect(motivoDaOcupacao()).toBe("gravando");
    liberarTodas();
    expect(sessaoOcupada()).toBe(false);
    expect(motivoDaOcupacao()).toBeNull();
    // O fim do envio que estava no ar e o desmonte da tela chegam depois.
    envio();
    tela.unmount();
    expect(sessaoOcupada()).toBe(false);
    // Uma ocupação nova volta a valer, e o liberar antigo não a solta.
    abrir("gravando");
    envio();
    expect(motivoDaOcupacao()).toBe("gravando");
  });
});

describe("sessão ocupada — os hooks", () => {
  it("useSessaoOcupada redesenha a cada mudança e devolve o mesmo objeto enquanto o motivo principal não muda", () => {
    let desenhos = 0;
    const { result } = renderHook(() => { desenhos++; return useSessaoOcupada(); });
    expect(result.current).toEqual({ ocupada: false, motivo: null });

    let liberarGravacao: () => void = () => {};
    act(() => { liberarGravacao = abrir("gravando"); });
    expect(result.current).toEqual({ ocupada: true, motivo: "gravando" });

    // Uma ocupação de motivo menor não troca o principal: nada a redesenhar.
    const antes = result.current;
    const desenhosAntes = desenhos;
    act(() => { abrir("audio-nao-enviado"); });
    expect(result.current).toBe(antes);
    expect(desenhos).toBe(desenhosAntes);

    act(() => liberarGravacao());
    expect(result.current).toEqual({ ocupada: true, motivo: "audio-nao-enviado" });
  });

  it("useOcupacao ocupa enquanto ativo, libera ao virar false e ao desmontar", () => {
    const { rerender, unmount } = renderHook(({ ativo }) => useOcupacao("enviando", ativo), { initialProps: { ativo: false } });
    expect(sessaoOcupada()).toBe(false);
    rerender({ ativo: true });
    expect(motivoDaOcupacao()).toBe("enviando");
    // Redesenhar ativo não abre uma segunda ocupação (senão ela sobraria ao desligar).
    rerender({ ativo: true });
    rerender({ ativo: false });
    expect(sessaoOcupada()).toBe(false);
    rerender({ ativo: true });
    expect(motivoDaOcupacao()).toBe("enviando");
    unmount();
    expect(sessaoOcupada()).toBe(false);
  });

  it("escondida pelo Suspense sem desmontar (a ida a uma tela lazy), a ocupação continua", async () => {
    // O App esconde a página enquanto a próxima tela carrega e desfaz só os
    // efeitos de layout dela: a gravação escondida segue, e a ocupação também.
    // Com efeito de layout, ela sairia aqui com o áudio ainda na aba.
    const nunca = new Promise<never>(() => {});
    function TelaQueCarrega({ carregando }: { carregando: boolean }) {
      if (carregando) use(nunca);
      return null;
    }
    function Gravando() {
      useOcupacao("gravando", true);
      return <p>gravando</p>;
    }
    const tela = (carregando: boolean) => (
      <Suspense fallback={<p>carregando a tela</p>}>
        <Gravando />
        <TelaQueCarrega carregando={carregando} />
      </Suspense>
    );
    const { rerender } = render(tela(false));
    expect(motivoDaOcupacao()).toBe("gravando");
    await act(async () => { rerender(tela(true)); });
    expect(screen.getByText("carregando a tela")).toBeInTheDocument();
    expect(screen.getByText("gravando")).not.toBeVisible();
    expect(motivoDaOcupacao()).toBe("gravando");
  });

  it("dois componentes com o mesmo motivo: o desmonte de um não libera o do outro", () => {
    const um = renderHook(() => useOcupacao("audio-nao-enviado", true));
    const outro = renderHook(() => useOcupacao("audio-nao-enviado", true));
    um.unmount();
    expect(motivoDaOcupacao()).toBe("audio-nao-enviado");
    outro.unmount();
    expect(sessaoOcupada()).toBe(false);
  });
});

describe("sessão ocupada — fechar ou recarregar a aba", () => {
  it("com a sessão livre, fechar a aba não pergunta nada", () => {
    expect(fecharAba()).toBe(false);
  });

  it("ocupada, o navegador pergunta; liberada, para de perguntar", () => {
    const liberar = abrir("gravando");
    expect(fecharAba()).toBe(true);
    liberar();
    expect(fecharAba()).toBe(false);
  });

  it("pergunta com qualquer motivo, também com o áudio só esperando o envio", () => {
    for (const motivo of ["gravando", "enviando", "audio-nao-enviado"] as const) {
      const liberar = abrir(motivo);
      expect(fecharAba()).toBe(true);
      liberar();
    }
    expect(fecharAba()).toBe(false);
  });

  it("depois do liberarTodas do logout, fechar a aba deixa de perguntar", () => {
    abrir("enviando");
    abrir("gravando");
    expect(fecharAba()).toBe(true);
    liberarTodas();
    expect(fecharAba()).toBe(false);
  });

  it("o ouvinte só existe enquanto ocupada: entra uma vez ao ocupar e sai uma vez ao liberar a última", () => {
    const registrar = vi.spyOn(window, "addEventListener");
    const remover = vi.spyOn(window, "removeEventListener");
    const doFechar = (espiao: typeof registrar) => espiao.mock.calls.filter(([tipo]) => tipo === "beforeunload");

    const gravacao = abrir("gravando");
    const envio = abrir("enviando");
    expect(doFechar(registrar)).toHaveLength(1);
    gravacao();
    expect(doFechar(remover)).toHaveLength(0);
    envio();
    expect(doFechar(remover)).toHaveLength(1);
    // Sai o mesmo ouvinte que entrou.
    expect(doFechar(remover)[0][1]).toBe(doFechar(registrar)[0][1]);
  });
});
