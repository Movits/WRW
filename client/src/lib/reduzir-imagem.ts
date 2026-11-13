// Reduz a imagem NO NAVEGADOR, antes de subir.
//
// Hoje a foto do contato e o cartão de visita sobem crus: o formulário lê o
// arquivo com FileReader.readAsDataURL e manda os bytes como vieram. Uma foto
// de celular tem 2 a 4 MB, e a tela a exibe num avatar de 48 px — sobem
// megabytes para desenhar dezenas de pixels. Com os limites do Backblaze na
// conta gratuita (1 GB de download por dia), algo como sete usuárias ativas com
// fotos cruas consomem a cota do dia inteiro.
//
// O que este módulo faz: desenha o arquivo num canvas do tamanho de destino e
// recodifica em WebP (ou JPEG, onde o WebP não existe) com qualidade 0,8.
//
// Três regras que valem mais que o ganho de bytes:
//
//   1. NUNCA ampliar. Imagem menor que o teto passa sem redimensionar.
//   2. NUNCA piorar. Se a recodificação ficar maior que o original, o original
//      é que sobe — acontece com JPEG pequeno já bem comprimido.
//   3. NUNCA impedir o envio. Canvas bloqueado, formato que o navegador não
//      decodifica, arquivo corrompido: qualquer falha devolve o original e o
//      upload segue como antes. Reduzir é economia, não requisito.
//
// O teto de 10 MB do servidor continua onde está (server/contact-media.ts e
// server/contexto-media.ts): ele é o teto de abuso, não a régua de qualidade.

export type TipoDeImagem = "image/jpeg" | "image/png" | "image/webp";

/**
 * Foto de contato: o maior uso dela hoje é o avatar de 48 px e a prévia de
 * 96 px do formulário. 512 px no lado maior cobre os dois com folga para telas
 * de densidade 2x ou 3x, e ainda serve se algum dia a foto abrir em tamanho
 * maior no detalhe.
 */
export const LADO_MAXIMO_FOTO_DE_CONTATO = 512;

/**
 * Cartão de visita: aqui o conteúdo é TEXTO — nome, cargo, telefone, e-mail.
 * A dona vai ler esse texto na tela, então cortar demais destrói o arquivo em
 * vez de otimizá-lo. 1600 px no lado maior mantém um cartão legível (a régua
 * usada em digitalização de documento é ~200 ppp; um cartão de 9 cm dá cerca de
 * 700 px, e 1600 deixa margem para foto tirada de longe, com o cartão ocupando
 * só parte do quadro).
 */
export const LADO_MAXIMO_CARTAO_DE_VISITA = 1600;

/**
 * Mídia de contexto (Linha do Tempo): foto de evento, de crachá, de quadro
 * branco, de página de documento. Como no cartão, pode haver texto para ler —
 * então vale o mesmo teto do cartão, não o da foto de perfil.
 */
export const LADO_MAXIMO_MIDIA_DE_CONTEXTO = 1600;

/**
 * 0,8 é o ponto em que o artefato de compressão ainda não aparece em foto nem
 * em texto impresso, e o arquivo já cai para uma fração do original. Abaixo de
 * 0,7 o texto do cartão começa a esfarelar nas bordas das letras.
 */
export const QUALIDADE_DA_RECODIFICACAO = 0.8;

export type ImagemParaEnviar = {
  dataBase64: string;
  mimeType: TipoDeImagem;
  /** Bytes do arquivo que vai subir (não do JSON em base64). */
  bytes: number;
  /** Falso quando o original subiu como estava — por regra ou por falha. */
  reduzida: boolean;
};

/**
 * Tamanho de destino mantendo a proporção, sem nunca ampliar.
 * Arredonda para inteiro >= 1: canvas de 0 px não desenha nada.
 */
export function calcularDestino(
  largura: number,
  altura: number,
  ladoMaximo: number,
): { largura: number; altura: number } {
  if (!Number.isFinite(largura) || !Number.isFinite(altura) || largura <= 0 || altura <= 0) {
    return { largura: 0, altura: 0 };
  }
  const maior = Math.max(largura, altura);
  if (maior <= ladoMaximo) return { largura: Math.round(largura), altura: Math.round(altura) };
  const fator = ladoMaximo / maior;
  return {
    largura: Math.max(1, Math.round(largura * fator)),
    altura: Math.max(1, Math.round(altura * fator)),
  };
}

/**
 * WebP quando o navegador sabe codificar: comprime melhor que JPEG na mesma
 * qualidade e preserva transparência (cartão salvo como PNG com fundo vazado
 * viraria um retângulo preto em JPEG). Sem WebP, JPEG — e aí o fundo
 * transparente é pintado de branco antes de desenhar, o que é o menos pior.
 */
export function tipoDeSaida(suportaWebp: boolean): TipoDeImagem {
  return suportaWebp ? "image/webp" : "image/jpeg";
}

/** Bytes reais que um data: URL representa, sem materializar o buffer. */
export function bytesDoDataUrl(dataUrl: string): number {
  const virgula = dataUrl.indexOf(",");
  const base64 = virgula >= 0 ? dataUrl.slice(virgula + 1) : dataUrl;
  const preenchimento = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - preenchimento);
}

/** A imagem aberta e pronta para desenhar, com as dimensões que ela tem. */
export type ImagemAberta = {
  largura: number;
  altura: number;
  /** `null` quando o canvas não devolveu nada — tratado como "não reduz". */
  paraDataUrl(largura: number, altura: number, tipo: TipoDeImagem, qualidade: number): Promise<string | null>;
  fechar(): void;
};

/**
 * A parte que depende do navegador, isolada para o teste poder substituí-la:
 * jsdom não tem canvas, e o que importa provar é a decisão (reduzir, não
 * ampliar, não piorar, não bloquear), não o desenho em si.
 */
export type AmbienteDeImagem = {
  abrir(arquivo: File): Promise<ImagemAberta | null>;
  lerDataUrl(arquivo: File): Promise<string>;
  suportaWebp(): boolean;
};

/**
 * Lê o arquivo como data: URL — o formato que os procedimentos de upload
 * esperam. Exportada porque o que NÃO é imagem (o PDF da Linha do Tempo) sobe
 * sem passar pela redução e ainda precisa desta leitura.
 */
export function lerArquivoComoDataUrl(arquivo: File): Promise<string> {
  return lerDataUrlComFileReader(arquivo);
}

function lerDataUrlComFileReader(arquivo: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onerror = () => reject(new Error("Não foi possível ler o arquivo."));
    leitor.onload = () => {
      const conteudo = String(leitor.result ?? "");
      if (!conteudo) reject(new Error("Não foi possível ler o arquivo."));
      else resolve(conteudo);
    };
    leitor.readAsDataURL(arquivo);
  });
}

let webpSuportado: boolean | null = null;

export const ambienteDoNavegador: AmbienteDeImagem = {
  async abrir(arquivo) {
    if (typeof createImageBitmap !== "function") return null;
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(arquivo);
    } catch {
      return null;
    }
    return {
      largura: bitmap.width,
      altura: bitmap.height,
      async paraDataUrl(largura, altura, tipo, qualidade) {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = largura;
          canvas.height = altura;
          const pincel = canvas.getContext("2d");
          if (!pincel) return null;
          // JPEG não tem canal alfa: sem esta base branca, o transparente do
          // PNG sai preto.
          if (tipo === "image/jpeg") {
            pincel.fillStyle = "#ffffff";
            pincel.fillRect(0, 0, largura, altura);
          }
          pincel.imageSmoothingEnabled = true;
          pincel.imageSmoothingQuality = "high";
          pincel.drawImage(bitmap, 0, 0, largura, altura);
          const dataUrl = canvas.toDataURL(tipo, qualidade);
          // Navegador que não codifica o tipo pedido devolve PNG em silêncio;
          // um PNG de foto é maior que o original, e a regra 2 o descartaria —
          // mas é melhor dizer não aqui do que gastar memória à toa.
          return dataUrl.startsWith(`data:${tipo}`) ? dataUrl : null;
        } catch {
          return null;
        }
      },
      fechar() {
        bitmap.close?.();
      },
    };
  },
  lerDataUrl: lerDataUrlComFileReader,
  suportaWebp() {
    if (webpSuportado !== null) return webpSuportado;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      webpSuportado = canvas.toDataURL("image/webp").startsWith("data:image/webp");
    } catch {
      webpSuportado = false;
    }
    return webpSuportado;
  },
};

/**
 * Devolve o que deve subir: a versão reduzida, ou o original quando reduzir
 * não vale a pena ou não foi possível. Não lança por falha de redução — só
 * repassa o erro de LEITURA do arquivo, que já impedia o envio antes.
 */
export async function prepararImagemParaEnvio(
  arquivo: File,
  ladoMaximo: number,
  ambiente: AmbienteDeImagem = ambienteDoNavegador,
): Promise<ImagemParaEnviar> {
  const originalDataUrl = await ambiente.lerDataUrl(arquivo);
  const original: ImagemParaEnviar = {
    dataBase64: originalDataUrl,
    mimeType: arquivo.type as TipoDeImagem,
    bytes: bytesDoDataUrl(originalDataUrl),
    reduzida: false,
  };

  let aberta: ImagemAberta | null = null;
  try {
    aberta = await ambiente.abrir(arquivo);
    if (!aberta) return original;

    const destino = calcularDestino(aberta.largura, aberta.altura, ladoMaximo);
    if (!destino.largura || !destino.altura) return original;

    const tipo = tipoDeSaida(ambiente.suportaWebp());
    const reduzidaDataUrl = await aberta.paraDataUrl(
      destino.largura,
      destino.altura,
      tipo,
      QUALIDADE_DA_RECODIFICACAO,
    );
    if (!reduzidaDataUrl) return original;

    const bytes = bytesDoDataUrl(reduzidaDataUrl);
    // Regra 2: recodificar um JPEG pequeno costuma engordá-lo.
    if (bytes >= original.bytes) return original;

    return { dataBase64: reduzidaDataUrl, mimeType: tipo, bytes, reduzida: true };
  } catch {
    return original;
  } finally {
    aberta?.fechar();
  }
}
