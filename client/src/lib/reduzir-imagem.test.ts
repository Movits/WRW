import { describe, expect, it, vi } from "vitest";
import {
  calcularDestino,
  bytesDoDataUrl,
  tipoDeSaida,
  prepararImagemParaEnvio,
  LADO_MAXIMO_FOTO_DE_CONTATO,
  LADO_MAXIMO_CARTAO_DE_VISITA,
  QUALIDADE_DA_RECODIFICACAO,
  type AmbienteDeImagem,
  type ImagemAberta,
} from "./reduzir-imagem";

/**
 * A redução da imagem antes do envio (F12).
 *
 * O que estava errado: a foto do contato subia crua — 2 a 4 MB de câmera de
 * celular — para ser desenhada num avatar de 48 px, e cada abertura de tela
 * baixava tudo de novo. Com 1 GB de download por dia no Backblaze, isso é a
 * cota do dia inteiro em poucas usuárias.
 *
 * O que este teste tranca são as três regras que valem mais que os bytes
 * economizados: não ampliar, não piorar e NUNCA impedir o envio. As duas
 * primeiras são conta; a terceira é a que protege a usuária de um navegador
 * sem canvas ou de um arquivo que o decodificador não aceita.
 *
 * jsdom não tem canvas, então a parte que desenha é injetada (AmbienteDeImagem).
 * O que se prova aqui é a DECISÃO, não o desenho — o desenho foi conferido no
 * navegador, com número antes e depois, e está na PR.
 */

/** data: URL falsa que representa EXATAMENTE `bytes` bytes, com o preenchimento certo. */
const dataUrl = (tipo: string, bytes: number) => {
  const grupos = Math.ceil(bytes / 3);
  const sobra = bytes % 3;
  const preenchimento = sobra === 1 ? "==" : sobra === 2 ? "=" : "";
  const corpo = "A".repeat(grupos * 4 - preenchimento.length) + preenchimento;
  return `data:${tipo};base64,${corpo}`;
};

const arquivoFalso = (tipo: string, bytes = 1_000_000) =>
  ({ name: "foto.jpg", type: tipo, size: bytes }) as unknown as File;

type AmbienteFalso = AmbienteDeImagem & { desenhos: Array<{ largura: number; altura: number; tipo: string; qualidade: number }> };

function ambienteFalso(opcoes: {
  largura?: number;
  altura?: number;
  bytesOriginal?: number;
  bytesReduzida?: number;
  webp?: boolean;
  abrirFalha?: boolean;
  desenhoFalha?: boolean;
  leituraFalha?: boolean;
} = {}): AmbienteFalso {
  const {
    largura = 3000, altura = 4000,
    bytesOriginal = 3_000_000, bytesReduzida = 90_000,
    webp = true, abrirFalha = false, desenhoFalha = false, leituraFalha = false,
  } = opcoes;
  const desenhos: AmbienteFalso["desenhos"] = [];
  const fechar = vi.fn();
  const aberta: ImagemAberta = {
    largura, altura,
    async paraDataUrl(l, a, tipo, qualidade) {
      desenhos.push({ largura: l, altura: a, tipo, qualidade });
      if (desenhoFalha) return null;
      return dataUrl(tipo, bytesReduzida);
    },
    fechar,
  };
  return {
    desenhos,
    async abrir() {
      if (abrirFalha) return null;
      return aberta;
    },
    async lerDataUrl() {
      if (leituraFalha) throw new Error("não foi possível ler o arquivo");
      return dataUrl("image/jpeg", bytesOriginal);
    },
    suportaWebp: () => webp,
  };
}

describe("calcularDestino — proporção mantida, sem nunca ampliar", () => {
  it("foto de celular em pé cabe em 512 no lado maior", () => {
    expect(calcularDestino(3024, 4032, LADO_MAXIMO_FOTO_DE_CONTATO)).toEqual({ largura: 384, altura: 512 });
  });

  it("foto deitada usa a largura como lado maior", () => {
    expect(calcularDestino(4032, 3024, LADO_MAXIMO_FOTO_DE_CONTATO)).toEqual({ largura: 512, altura: 384 });
  });

  it("imagem MENOR que o teto passa do mesmo tamanho — ampliar só perderia qualidade e ganharia bytes", () => {
    expect(calcularDestino(200, 150, LADO_MAXIMO_FOTO_DE_CONTATO)).toEqual({ largura: 200, altura: 150 });
    expect(calcularDestino(900, 500, LADO_MAXIMO_CARTAO_DE_VISITA)).toEqual({ largura: 900, altura: 500 });
  });

  it("no teto exato não mexe", () => {
    expect(calcularDestino(512, 512, 512)).toEqual({ largura: 512, altura: 512 });
  });

  it("imagem muito alongada não vira lado zero", () => {
    const d = calcularDestino(5000, 3, LADO_MAXIMO_FOTO_DE_CONTATO);
    expect(d.largura).toBe(512);
    expect(d.altura).toBeGreaterThanOrEqual(1);
  });

  it("dimensão inválida devolve zero, e quem chama trata como 'não reduz'", () => {
    expect(calcularDestino(0, 100, 512)).toEqual({ largura: 0, altura: 0 });
    expect(calcularDestino(Number.NaN, 100, 512)).toEqual({ largura: 0, altura: 0 });
  });
});

describe("bytesDoDataUrl", () => {
  it("conta os bytes do arquivo, não os caracteres do base64", () => {
    // "AAAA" em base64 são 3 bytes; o cabeçalho data: não entra na conta.
    expect(bytesDoDataUrl("data:image/webp;base64,AAAA")).toBe(3);
    expect(bytesDoDataUrl("data:image/webp;base64,AAA=")).toBe(2);
    expect(bytesDoDataUrl("data:image/webp;base64,AA==")).toBe(1);
  });
});

describe("tipoDeSaida", () => {
  it("WebP quando o navegador codifica (comprime melhor e preserva transparência)", () => {
    expect(tipoDeSaida(true)).toBe("image/webp");
  });

  it("JPEG como reserva — o canvas do módulo pinta fundo branco antes, para PNG vazado não virar preto", () => {
    expect(tipoDeSaida(false)).toBe("image/jpeg");
  });
});

describe("prepararImagemParaEnvio", () => {
  it("foto de celular: reduz, troca o tipo e devolve os bytes do que vai subir", async () => {
    const ambiente = ambienteFalso({ largura: 3024, altura: 4032, bytesOriginal: 3_000_000, bytesReduzida: 90_000 });
    const r = await prepararImagemParaEnvio(arquivoFalso("image/jpeg"), LADO_MAXIMO_FOTO_DE_CONTATO, ambiente);

    expect(r.reduzida).toBe(true);
    expect(r.mimeType).toBe("image/webp");
    expect(r.bytes).toBe(90_000);
    expect(r.dataBase64.startsWith("data:image/webp;base64,")).toBe(true);
    expect(ambiente.desenhos).toEqual([
      { largura: 384, altura: 512, tipo: "image/webp", qualidade: QUALIDADE_DA_RECODIFICACAO },
    ]);
  });

  it("cartão de visita usa o teto grande — é texto para ler, não avatar", async () => {
    const ambiente = ambienteFalso({ largura: 4000, altura: 2400 });
    await prepararImagemParaEnvio(arquivoFalso("image/jpeg"), LADO_MAXIMO_CARTAO_DE_VISITA, ambiente);
    expect(ambiente.desenhos[0].largura).toBe(1600);
    expect(ambiente.desenhos[0].altura).toBe(960);
  });

  it("REGRA: não piora — recodificação maior que o original faz o original subir", async () => {
    // JPEG pequeno e já bem comprimido: recodificar engorda.
    const ambiente = ambienteFalso({ largura: 300, altura: 300, bytesOriginal: 20_000, bytesReduzida: 31_000 });
    const r = await prepararImagemParaEnvio(arquivoFalso("image/jpeg"), LADO_MAXIMO_FOTO_DE_CONTATO, ambiente);

    expect(r.reduzida).toBe(false);
    expect(r.mimeType).toBe("image/jpeg");
    expect(r.bytes).toBe(20_000);
  });

  it("REGRA: não impede o envio — sem canvas, sobe o original", async () => {
    const ambiente = ambienteFalso({ abrirFalha: true, bytesOriginal: 2_500_000 });
    const r = await prepararImagemParaEnvio(arquivoFalso("image/png"), LADO_MAXIMO_FOTO_DE_CONTATO, ambiente);

    expect(r.reduzida).toBe(false);
    expect(r.mimeType).toBe("image/png");
    expect(r.bytes).toBe(2_500_000);
  });

  it("REGRA: não impede o envio — canvas que não devolve nada também sobe o original", async () => {
    const ambiente = ambienteFalso({ desenhoFalha: true, bytesOriginal: 2_500_000 });
    const r = await prepararImagemParaEnvio(arquivoFalso("image/jpeg"), LADO_MAXIMO_FOTO_DE_CONTATO, ambiente);
    expect(r.reduzida).toBe(false);
    expect(r.bytes).toBe(2_500_000);
  });

  it("falha de LEITURA do arquivo continua sendo erro — é o que já barrava o envio antes", async () => {
    const ambiente = ambienteFalso({ leituraFalha: true });
    await expect(
      prepararImagemParaEnvio(arquivoFalso("image/jpeg"), LADO_MAXIMO_FOTO_DE_CONTATO, ambiente),
    ).rejects.toThrow();
  });

  it("libera o bitmap mesmo quando decide não reduzir — imagem aberta e não fechada vaza memória no celular", async () => {
    const ambiente = ambienteFalso({ largura: 300, altura: 300, bytesOriginal: 20_000, bytesReduzida: 31_000 });
    const aberta = await ambiente.abrir(arquivoFalso("image/jpeg"));
    await prepararImagemParaEnvio(arquivoFalso("image/jpeg"), LADO_MAXIMO_FOTO_DE_CONTATO, ambiente);
    expect(aberta?.fechar).toHaveBeenCalled();
  });
});
