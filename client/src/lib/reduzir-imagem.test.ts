import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  calcularDestino,
  bytesDoDataUrl,
  tipoDeSaida,
  prepararImagemParaEnvio,
  lerArquivoComoDataUrl,
  ambienteDoNavegador,
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
 * sem canvas, de um arquivo que o decodificador não aceita e de um navegador
 * contra fingerprinting que devolve OUTRA imagem no lugar da leitura.
 *
 * jsdom não tem canvas, então a parte que desenha é injetada (AmbienteDeImagem).
 * O dublê se comporta como o navegador onde isso importa: desenhar um bitmap
 * já fechado LANÇA, e abrir ou desenhar podem lançar (não só devolver null).
 * O ambiente real (ambienteDoNavegador) é provado no fim, com o canvas e o
 * createImageBitmap dublados no protótipo. O desenho em si foi conferido no
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

type Evento = "abrir" | "desenhar" | "fechar";
type AmbienteFalso = AmbienteDeImagem & {
  desenhos: Array<{ largura: number; altura: number; tipo: string; qualidade: number }>;
  eventos: Evento[];
  fechar: ReturnType<typeof vi.fn>;
};

function ambienteFalso(opcoes: {
  largura?: number;
  altura?: number;
  bytesOriginal?: number;
  bytesReduzida?: number;
  webp?: boolean;
  abrirFalha?: boolean;
  abrirLanca?: boolean;
  desenhoFalha?: boolean;
  desenhoLanca?: boolean;
  leituraFalha?: boolean;
  leituraConfiavel?: boolean;
} = {}): AmbienteFalso {
  const {
    largura = 3000, altura = 4000,
    bytesOriginal = 3_000_000, bytesReduzida = 90_000,
    webp = true, abrirFalha = false, abrirLanca = false, desenhoFalha = false, desenhoLanca = false,
    leituraFalha = false, leituraConfiavel = true,
  } = opcoes;
  const desenhos: AmbienteFalso["desenhos"] = [];
  const eventos: Evento[] = [];
  let fechada = false;
  const fechar = vi.fn(() => {
    fechada = true;
    eventos.push("fechar");
  });
  const aberta: ImagemAberta = {
    largura, altura,
    async paraDataUrl(l, a, tipo, qualidade) {
      // Como no navegador: drawImage de um ImageBitmap já fechado lança.
      if (fechada) throw new DOMException("O bitmap já foi fechado.", "InvalidStateError");
      eventos.push("desenhar");
      desenhos.push({ largura: l, altura: a, tipo, qualidade });
      if (desenhoLanca) throw new DOMException("Sem memória para o canvas.", "UnknownError");
      if (desenhoFalha) return null;
      return dataUrl(tipo, bytesReduzida);
    },
    fechar,
  };
  return {
    desenhos,
    eventos,
    fechar,
    async abrir() {
      eventos.push("abrir");
      if (abrirLanca) throw new TypeError("The provided value 'from-image' is not a valid enum value of type ImageOrientation.");
      if (abrirFalha) return null;
      return aberta;
    },
    async lerDataUrl(arquivo) {
      if (leituraFalha) throw new Error("Não foi possível ler o arquivo.");
      return dataUrl(arquivo.type, bytesOriginal);
    },
    suportaWebp: () => webp,
    leituraConfiavel: () => leituraConfiavel,
  };
}

let aviso: MockInstance<typeof console.warn>;
beforeEach(() => {
  aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  aviso.mockRestore();
});

const AVISO = "[reduzir-imagem] enviando o original:";

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
    expect(r.dataBase64).toBe(dataUrl("image/webp", 90_000));
    expect(ambiente.desenhos).toEqual([
      { largura: 384, altura: 512, tipo: "image/webp", qualidade: QUALIDADE_DA_RECODIFICACAO },
    ]);
    expect(aviso).not.toHaveBeenCalled();
  });

  it("cartão de visita usa o teto grande — é texto para ler, não avatar", async () => {
    const ambiente = ambienteFalso({ largura: 4000, altura: 2400 });
    await prepararImagemParaEnvio(arquivoFalso("image/jpeg"), LADO_MAXIMO_CARTAO_DE_VISITA, ambiente);
    expect(ambiente.desenhos[0].largura).toBe(1600);
    expect(ambiente.desenhos[0].altura).toBe(960);
  });

  it("REGRA: não piora — recodificação maior que o original faz o ORIGINAL subir, sem aviso (é decisão, não falha)", async () => {
    // JPEG pequeno e já bem comprimido: recodificar engorda.
    const ambiente = ambienteFalso({ largura: 300, altura: 300, bytesOriginal: 20_000, bytesReduzida: 31_000 });
    const r = await prepararImagemParaEnvio(arquivoFalso("image/jpeg"), LADO_MAXIMO_FOTO_DE_CONTATO, ambiente);

    expect(r).toEqual({ dataBase64: dataUrl("image/jpeg", 20_000), mimeType: "image/jpeg", bytes: 20_000, reduzida: false });
    expect(aviso).not.toHaveBeenCalled();
  });

  it("REGRA: não impede o envio — sem canvas, sobe o original e o console diz por quê", async () => {
    const ambiente = ambienteFalso({ abrirFalha: true, bytesOriginal: 2_500_000 });
    const r = await prepararImagemParaEnvio(arquivoFalso("image/png"), LADO_MAXIMO_FOTO_DE_CONTATO, ambiente);

    expect(r).toEqual({ dataBase64: dataUrl("image/png", 2_500_000), mimeType: "image/png", bytes: 2_500_000, reduzida: false });
    expect(aviso).toHaveBeenCalledWith(`${AVISO} o navegador não abre a imagem para desenhar`);
  });

  it("REGRA: não impede o envio — canvas que não devolve nada também sobe o original", async () => {
    const ambiente = ambienteFalso({ desenhoFalha: true, bytesOriginal: 2_500_000 });
    const r = await prepararImagemParaEnvio(arquivoFalso("image/jpeg"), LADO_MAXIMO_FOTO_DE_CONTATO, ambiente);

    expect(r).toEqual({ dataBase64: dataUrl("image/jpeg", 2_500_000), mimeType: "image/jpeg", bytes: 2_500_000, reduzida: false });
    expect(aviso).toHaveBeenCalledWith(`${AVISO} o canvas não devolveu a imagem no tipo pedido`);
  });

  it("REGRA: canvas que devolve OUTRA imagem (placeholder contra fingerprinting) — sobe o original, sem nem abrir a foto", async () => {
    // Tor Browser, Mullvad, LibreWolf: toDataURL não lança, devolve um
    // placeholder de poucos KB, que passaria pela regra 2 no lugar da foto.
    const ambiente = ambienteFalso({ leituraConfiavel: false, bytesOriginal: 3_000_000, bytesReduzida: 2_000 });
    const r = await prepararImagemParaEnvio(arquivoFalso("image/jpeg"), LADO_MAXIMO_FOTO_DE_CONTATO, ambiente);

    expect(r).toEqual({ dataBase64: dataUrl("image/jpeg", 3_000_000), mimeType: "image/jpeg", bytes: 3_000_000, reduzida: false });
    expect(ambiente.eventos).toEqual([]);
    expect(aviso).toHaveBeenCalledWith(`${AVISO} o navegador bloqueia ou falseia a leitura do canvas`);
  });

  it("REGRA: abrir que LANÇA (motor que não conhece a opção, arquivo que não decodifica) — sobe o original", async () => {
    const ambiente = ambienteFalso({ abrirLanca: true, bytesOriginal: 2_500_000 });
    const r = await prepararImagemParaEnvio(arquivoFalso("image/jpeg"), LADO_MAXIMO_FOTO_DE_CONTATO, ambiente);

    expect(r).toEqual({ dataBase64: dataUrl("image/jpeg", 2_500_000), mimeType: "image/jpeg", bytes: 2_500_000, reduzida: false });
    expect(aviso).toHaveBeenCalledWith(`${AVISO} a redução falhou`, expect.any(TypeError));
  });

  it("REGRA: desenho que LANÇA (canvas sem memória) — sobe o original, e o bitmap é fechado assim mesmo", async () => {
    const ambiente = ambienteFalso({ desenhoLanca: true, bytesOriginal: 2_500_000 });
    const r = await prepararImagemParaEnvio(arquivoFalso("image/jpeg"), LADO_MAXIMO_FOTO_DE_CONTATO, ambiente);

    expect(r.reduzida).toBe(false);
    expect(r.dataBase64).toBe(dataUrl("image/jpeg", 2_500_000));
    expect(ambiente.fechar).toHaveBeenCalledTimes(1);
    expect(aviso).toHaveBeenCalledWith(`${AVISO} a redução falhou`, expect.any(DOMException));
  });

  it("falha de LEITURA do arquivo continua sendo erro, com a mensagem de sempre — é o que já barrava o envio antes", async () => {
    const ambiente = ambienteFalso({ leituraFalha: true });
    await expect(
      prepararImagemParaEnvio(arquivoFalso("image/jpeg"), LADO_MAXIMO_FOTO_DE_CONTATO, ambiente),
    ).rejects.toThrow("Não foi possível ler o arquivo.");
    expect(aviso).not.toHaveBeenCalled();
  });

  it("fecha o bitmap UMA vez e só DEPOIS de desenhar — fechar antes faria o navegador recusar todo desenho", async () => {
    const reduz = ambienteFalso();
    await prepararImagemParaEnvio(arquivoFalso("image/jpeg"), LADO_MAXIMO_FOTO_DE_CONTATO, reduz);
    expect(reduz.eventos).toEqual(["abrir", "desenhar", "fechar"]);
    expect(reduz.fechar).toHaveBeenCalledTimes(1);
  });

  it("libera o bitmap mesmo quando decide não reduzir — imagem aberta e não fechada vaza memória no celular", async () => {
    const naoPiora = ambienteFalso({ largura: 300, altura: 300, bytesOriginal: 20_000, bytesReduzida: 31_000 });
    await prepararImagemParaEnvio(arquivoFalso("image/jpeg"), LADO_MAXIMO_FOTO_DE_CONTATO, naoPiora);
    expect(naoPiora.eventos).toEqual(["abrir", "desenhar", "fechar"]);
    expect(naoPiora.fechar).toHaveBeenCalledTimes(1);
  });
});

describe("lerArquivoComoDataUrl — a leitura de verdade (FileReader do jsdom)", () => {
  it("devolve o data: URL com o tipo do arquivo", async () => {
    const arquivo = new File(["abc"], "proposta.pdf", { type: "application/pdf" });
    expect(await lerArquivoComoDataUrl(arquivo)).toBe("data:application/pdf;base64,YWJj");
  });
});

// ─── O ambiente real, com o canvas dublado no protótipo ──────────────────────

type PincelFalso = {
  fillStyle: string;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: string;
  fillRect: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  getImageData: ReturnType<typeof vi.fn>;
};

const LEITURA_FIEL = [255, 0, 0, 255, 0, 0, 255, 255];

describe("ambienteDoNavegador", () => {
  let canvases: HTMLCanvasElement[];
  let pincel: PincelFalso;

  function dublarCanvas(opcoes: {
    leitura?: () => number[];
    semContexto?: boolean;
    toDataURL?: (tipo?: string) => string;
  } = {}) {
    canvases = [];
    const leitura = opcoes.leitura ?? (() => LEITURA_FIEL);
    pincel = {
      fillStyle: "",
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: Uint8ClampedArray.from(leitura()) })),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      canvases.push(this);
      return (opcoes.semContexto ? null : pincel) as never;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
      opcoes.toDataURL ?? ((tipo?: string) => `data:${tipo};base64,AAAA`),
    );
  }

  const bitmap = () => ({ width: 3024, height: 4032, close: vi.fn() });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("abrir", () => {
    it("pede a orientação EXIF (from-image): a recodificação apaga o EXIF, e a foto em pé não pode ficar deitada", async () => {
      const criar = vi.fn(async () => bitmap());
      vi.stubGlobal("createImageBitmap", criar);
      const arquivo = new File(["x"], "foto.jpg", { type: "image/jpeg" });

      const aberta = await ambienteDoNavegador.abrir(arquivo);

      expect(criar).toHaveBeenCalledWith(arquivo, { imageOrientation: "from-image" });
      expect(aberta).toMatchObject({ largura: 3024, altura: 4032 });
    });

    it("sem createImageBitmap: null (sobe o original)", async () => {
      vi.stubGlobal("createImageBitmap", undefined);
      expect(await ambienteDoNavegador.abrir(new File(["x"], "foto.jpg", { type: "image/jpeg" }))).toBeNull();
    });

    it("motor que não conhece from-image LANÇA, e a foto sobe original — nunca deitada", async () => {
      dublarCanvas();
      vi.stubGlobal("createImageBitmap", vi.fn(async () => {
        throw new TypeError("The provided value 'from-image' is not a valid enum value of type ImageOrientation.");
      }));

      const r = await prepararImagemParaEnvio(new File([new Uint8Array(3000)], "foto.jpg", { type: "image/jpeg" }), LADO_MAXIMO_FOTO_DE_CONTATO);

      expect(r.reduzida).toBe(false);
      expect(r.mimeType).toBe("image/jpeg");
      expect(r.bytes).toBe(3000);
      expect(aviso).toHaveBeenCalledWith(`${AVISO} a redução falhou`, expect.any(TypeError));
    });
  });

  describe("paraDataUrl", () => {
    async function abrirFoto() {
      vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap()));
      return (await ambienteDoNavegador.abrir(new File(["x"], "foto.jpg", { type: "image/jpeg" })))!;
    }

    it("desenha no tamanho pedido, devolve o data: URL e LIBERA o canvas (teto de memória do Safari)", async () => {
      dublarCanvas({ toDataURL: tipo => `data:${tipo};base64,UklGRg==` });
      const aberta = await abrirFoto();

      expect(await aberta.paraDataUrl(384, 512, "image/webp", 0.8)).toBe("data:image/webp;base64,UklGRg==");
      expect(pincel.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 384, 512);
      expect(canvases).toHaveLength(1);
      expect(canvases[0].width).toBe(0);
      expect(canvases[0].height).toBe(0);
    });

    it("toDataURL que lança: o erro sobe (vira aviso e original lá em cima) e o canvas é liberado assim mesmo", async () => {
      dublarCanvas({ toDataURL: () => { throw new DOMException("Sem memória para o canvas.", "UnknownError"); } });
      const aberta = await abrirFoto();

      await expect(aberta.paraDataUrl(384, 512, "image/webp", 0.8)).rejects.toThrow("Sem memória para o canvas.");
      expect(canvases[0].width).toBe(0);
      expect(canvases[0].height).toBe(0);
    });

    it("navegador que não codifica o tipo pedido (devolve PNG em silêncio): null", async () => {
      dublarCanvas({ toDataURL: () => "data:image/png;base64,iVBORw==" });
      const aberta = await abrirFoto();
      expect(await aberta.paraDataUrl(384, 512, "image/webp", 0.8)).toBeNull();
    });
  });

  describe("leituraConfiavel — a prova de que o canvas devolve o que foi pintado", () => {
    it("leitura fiel: confiável, com o vermelho e o azul pintados nos dois pixels", () => {
      dublarCanvas();
      expect(ambienteDoNavegador.leituraConfiavel()).toBe(true);
      expect(pincel.fillRect).toHaveBeenCalledWith(0, 0, 1, 1);
      expect(pincel.fillRect).toHaveBeenCalledWith(1, 0, 1, 1);
      // O canvas da prova também é liberado.
      expect(canvases[0].width).toBe(0);
    });

    it("ruído de poucas unidades (Brave, Safari em navegação privada): continua confiável", () => {
      dublarCanvas({ leitura: () => [252, 3, 1, 255, 2, 0, 253, 254] });
      expect(ambienteDoNavegador.leituraConfiavel()).toBe(true);
    });

    it("placeholder do Firefox protegido — branco ou bytes aleatórios repetidos: NÃO confiável", () => {
      for (const leitura of [[255, 255, 255, 255, 255, 255, 255, 255], [37, 201, 88, 14, 37, 201, 88, 14], [0, 0, 0, 0, 0, 0, 0, 0]]) {
        dublarCanvas({ leitura: () => leitura });
        expect(ambienteDoNavegador.leituraConfiavel(), String(leitura)).toBe(false);
        vi.restoreAllMocks();
      }
    });

    it("leitura bloqueada às claras (getImageData lança) ou sem contexto 2D: NÃO confiável", () => {
      dublarCanvas({ leitura: () => { throw new DOMException("bloqueado", "SecurityError"); } });
      expect(ambienteDoNavegador.leituraConfiavel()).toBe(false);
      vi.restoreAllMocks();

      dublarCanvas({ semContexto: true });
      expect(ambienteDoNavegador.leituraConfiavel()).toBe(false);
    });

    it("de ponta a ponta: com o placeholder, prepararImagemParaEnvio sobe o original sem nem decodificar a foto", async () => {
      dublarCanvas({ leitura: () => [255, 255, 255, 255, 255, 255, 255, 255] });
      const criar = vi.fn(async () => bitmap());
      vi.stubGlobal("createImageBitmap", criar);

      const r = await prepararImagemParaEnvio(new File([new Uint8Array(5000)], "foto.jpg", { type: "image/jpeg" }), LADO_MAXIMO_FOTO_DE_CONTATO);

      expect(r.reduzida).toBe(false);
      expect(r.bytes).toBe(5000);
      expect(criar).not.toHaveBeenCalled();
      expect(aviso).toHaveBeenCalledWith(`${AVISO} o navegador bloqueia ou falseia a leitura do canvas`);
    });

    it("de ponta a ponta: com a leitura fiel, a foto é reduzida", async () => {
      dublarCanvas();
      vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap()));

      const r = await prepararImagemParaEnvio(new File([new Uint8Array(5000)], "foto.jpg", { type: "image/jpeg" }), LADO_MAXIMO_FOTO_DE_CONTATO);

      expect(r).toEqual({ dataBase64: "data:image/webp;base64,AAAA", mimeType: "image/webp", bytes: 3, reduzida: true });
      expect(pincel.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 384, 512);
      expect(aviso).not.toHaveBeenCalled();
    });
  });
});
