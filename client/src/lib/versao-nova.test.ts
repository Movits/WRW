import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liberarTodas, ocupar } from "@/lib/sessao-ocupada";
import { _reiniciarParaTestes, MARCA_DO_RECARREGAMENTO, tratarChunkAntigo, type DependenciasDaVersaoNova } from "@/lib/versao-nova";

function armazenamentoEmMemoria() {
  const dados = new Map<string, string>();
  return {
    getItem: (chave: string) => dados.get(chave) ?? null,
    setItem: (chave: string, valor: string) => void dados.set(chave, valor),
  };
}

function montar(endereco = "https://wrwglobal.org/gravar") {
  const armazenamento = armazenamentoEmMemoria();
  const deps = {
    recarregar: vi.fn<() => void>(),
    avisar: vi.fn<() => void>(),
    dispensarAviso: vi.fn<() => void>(),
    enderecoAtual: () => endereco,
    armazenamento: (): Pick<Storage, "getItem" | "setItem"> => armazenamento,
  } satisfies DependenciasDaVersaoNova;
  return { deps, armazenamento };
}

function eventoDoVite() {
  return new Event("vite:preloadError", { cancelable: true });
}

beforeEach(() => {
  liberarTodas();
  _reiniciarParaTestes();
});
afterEach(() => {
  liberarTodas();
});

describe("chunk antigo depois de um deploy", () => {
  it("sessão livre: cancela o erro do Vite e recarrega na hora, sem aviso", () => {
    const { deps, armazenamento } = montar();
    const evento = eventoDoVite();
    tratarChunkAntigo(evento, deps);
    expect(evento.defaultPrevented).toBe(true);
    expect(deps.recarregar).toHaveBeenCalledTimes(1);
    expect(deps.avisar).not.toHaveBeenCalled();
    expect(armazenamento.getItem(MARCA_DO_RECARREGAMENTO)).toBe("https://wrwglobal.org/gravar");
  });

  it("sessão livre: no mesmo endereço já recarregado, não entra em laço", () => {
    const { deps, armazenamento } = montar();
    armazenamento.setItem(MARCA_DO_RECARREGAMENTO, "https://wrwglobal.org/gravar");
    const evento = eventoDoVite();
    tratarChunkAntigo(evento, deps);
    expect(deps.recarregar).not.toHaveBeenCalled();
    expect(evento.defaultPrevented).toBe(false);
  });

  it("sessionStorage bloqueado: recarrega assim mesmo", () => {
    const { deps } = montar();
    deps.armazenamento = () => {
      throw new Error("bloqueado");
    };
    tratarChunkAntigo(eventoDoVite(), deps);
    expect(deps.recarregar).toHaveBeenCalledTimes(1);
  });

  it.each(["gravando", "enviando", "audio-nao-enviado"] as const)(
    "sessão ocupada (%s): não recarrega nem cancela o erro, avisa uma vez e recarrega ao desocupar",
    motivo => {
      const liberar = ocupar(motivo);
      const { deps } = montar();
      const evento = eventoDoVite();
      tratarChunkAntigo(evento, deps);
      tratarChunkAntigo(eventoDoVite(), deps);
      expect(deps.recarregar).not.toHaveBeenCalled();
      expect(evento.defaultPrevented).toBe(false);
      expect(deps.avisar).toHaveBeenCalledTimes(1);

      liberar();
      expect(deps.recarregar).toHaveBeenCalledTimes(1);
      expect(deps.dispensarAviso).toHaveBeenCalledTimes(1);
    },
  );

  it("trocar de motivo sem desocupar (gravando → áudio por enviar → enviando) não recarrega", () => {
    const liberarGravacao = ocupar("gravando");
    const { deps } = montar();
    tratarChunkAntigo(eventoDoVite(), deps);

    const liberarAudio = ocupar("audio-nao-enviado");
    liberarGravacao();
    const liberarEnvio = ocupar("enviando");
    liberarAudio();
    expect(deps.recarregar).not.toHaveBeenCalled();

    liberarEnvio();
    expect(deps.recarregar).toHaveBeenCalledTimes(1);
  });

  it("depois de recarregar ao desocupar, para de ouvir: ocupar e liberar de novo não recarrega outra vez", () => {
    const liberar = ocupar("gravando");
    const { deps } = montar();
    tratarChunkAntigo(eventoDoVite(), deps);
    liberar();
    ocupar("gravando")();
    expect(deps.recarregar).toHaveBeenCalledTimes(1);
  });

  it("ao desocupar, respeita a marca: no endereço já recarregado, não recarrega de novo", () => {
    const liberar = ocupar("enviando");
    const { deps, armazenamento } = montar();
    tratarChunkAntigo(eventoDoVite(), deps);
    armazenamento.setItem(MARCA_DO_RECARREGAMENTO, "https://wrwglobal.org/gravar");
    liberar();
    expect(deps.recarregar).not.toHaveBeenCalled();
    // O aviso prometia atualizar: sem recarregar, ele sai da tela.
    expect(deps.dispensarAviso).toHaveBeenCalledTimes(1);
  });

  it("o fim da sessão (Sair ou excluir a conta, liberarTodas) desocupa sem recarregar e dispensa o aviso", () => {
    ocupar("audio-nao-enviado");
    const { deps } = montar();
    tratarChunkAntigo(eventoDoVite(), deps);
    liberarTodas();
    expect(deps.recarregar).not.toHaveBeenCalled();
    expect(deps.dispensarAviso).toHaveBeenCalledTimes(1);

    // A espera acabou: a próxima falha, com a sessão livre, recarrega na hora.
    tratarChunkAntigo(eventoDoVite(), deps);
    expect(deps.recarregar).toHaveBeenCalledTimes(1);
  });

  it("ao recarregar depois de desocupar, o navegador não pergunta: o beforeunload já saiu", () => {
    const liberar = ocupar("gravando");
    const { deps } = montar();
    let perguntaria: boolean | null = null;
    deps.recarregar.mockImplementation(() => {
      const evento = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(evento);
      perguntaria = evento.defaultPrevented;
    });
    tratarChunkAntigo(eventoDoVite(), deps);
    liberar();
    expect(deps.recarregar).toHaveBeenCalledTimes(1);
    expect(perguntaria).toBe(false);
  });
});
