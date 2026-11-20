import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * Os tetos da reunião gravada em partes que valem ANTES do banco (G13a): a
 * duração de cada parte (até 12 min), a posição (até 200 partes) e o total do
 * encerrar. O banco é um dublê que só diz "cheguei": a recusa que vem antes
 * dele é a do teto, e o pedido que chega a ele passou pelo teto. A soma das
 * partes (até 12 h + 10 min) depende do banco e é provada, com os mesmos
 * tetos ponta a ponta, em fatias-de-reuniao.integracao.test.ts.
 */

class ChegouAoBanco extends Error {}
const exigirDb = vi.hoisted(() => vi.fn());
vi.mock("./db", async importOriginal => ({
  ...await importOriginal<typeof import("./db")>(),
  exigirDb: () => exigirDb(),
}));

const { DURACAO_MAXIMA_DA_PARTE_SEGUNDOS, encerrarGravacaoEmPartes, PARTES_NO_MAXIMO, RecusaDaParte, receberParte } = await import("./fatias-de-reuniao");

/** Um WAV mínimo de `segundos` (mono, 8 bits, 1 kHz): o servidor mede a duração pelo cabeçalho e pelos dados. */
function wav(segundos: number): Buffer {
  const dados = Buffer.alloc(Math.round(segundos * 1000), 128);
  const cabecalho = Buffer.alloc(44);
  cabecalho.write("RIFF", 0); cabecalho.writeUInt32LE(36 + dados.length, 4); cabecalho.write("WAVE", 8);
  cabecalho.write("fmt ", 12); cabecalho.writeUInt32LE(16, 16); cabecalho.writeUInt16LE(1, 20); cabecalho.writeUInt16LE(1, 22);
  cabecalho.writeUInt32LE(1000, 24); cabecalho.writeUInt32LE(1000, 28); cabecalho.writeUInt16LE(1, 32); cabecalho.writeUInt16LE(8, 34);
  cabecalho.write("data", 36); cabecalho.writeUInt32LE(dados.length, 40);
  return Buffer.concat([cabecalho, dados]);
}

/** O que aconteceu com o pedido: a recusa (o código) ou a passagem ao banco. */
async function desfecho(promessa: Promise<unknown>) {
  try {
    await promessa;
  } catch (erro) {
    if (erro instanceof ChegouAoBanco) return "chegou ao banco";
    if (erro instanceof RecusaDaParte) return erro.codigo;
    throw erro;
  }
  throw new Error("o dublê do banco devia ter parado o pedido");
}

const REUNIAO = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const parte = (seq: number, segundos: number) => receberParte({ ownerId: "dona-1", meetingId: REUNIAO, seq, mimeType: "audio/wav", bytes: wav(segundos) });

beforeEach(() => {
  exigirDb.mockReset();
  exigirDb.mockRejectedValue(new ChegouAoBanco());
});

describe("Reunião em partes — os tetos de antes do banco (G13a)", () => {
  it("a parte vai até 12 min (720 s): a aba em segundo plano atrasa a troca de parte", () => {
    expect(DURACAO_MAXIMA_DA_PARTE_SEGUNDOS).toBe(720);
  });

  it("a parte de 720 s passa pelo teto da parte; a de 721 s é LONGA_DEMAIS sem chegar ao banco", async () => {
    expect(await desfecho(parte(0, 720))).toBe("chegou ao banco");
    expect(await desfecho(parte(0, 721))).toBe("LONGA_DEMAIS");
    expect(exigirDb).toHaveBeenCalledTimes(1);
  });

  it("até 200 partes: a posição 199 passa; a 200 é POSICAO sem chegar ao banco", async () => {
    expect(PARTES_NO_MAXIMO).toBe(200);
    expect(await desfecho(parte(199, 1))).toBe("chegou ao banco");
    expect(await desfecho(parte(200, 1))).toBe("POSICAO");
    expect(exigirDb).toHaveBeenCalledTimes(1);
  });

  it("encerrar com 200 partes passa; com 201 é POSICAO sem chegar ao banco", async () => {
    expect(await desfecho(encerrarGravacaoEmPartes("dona-1", REUNIAO, 200))).toBe("chegou ao banco");
    expect(await desfecho(encerrarGravacaoEmPartes("dona-1", REUNIAO, 201))).toBe("POSICAO");
    expect(exigirDb).toHaveBeenCalledTimes(1);
  });
});
