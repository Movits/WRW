// A tela de desenho do resumo (H4h; HN-33 no app de referência da cliente):
// desenhar ou escrever à mão com a caneta do iPad, o dedo ou o mouse, e guardar
// como imagem do resumo (os anexos da H4g). A parte que não depende do canvas
// mora aqui, para o teste provar a decisão sem navegador: quem desenha (a
// caneta afasta a palma da mão), a largura do traço pela pressão, o tamanho da
// imagem guardada e o desenho dos traços.

export type PontoDoTraco = { x: number; y: number; pressao: number };
/** `tipo`: o pointerType de quem desenhou (só a caneta varia a largura pela pressão). */
export type Traco = { cor: string; espessura: number; tipo: string; pontos: PontoDoTraco[] };

/** As cores da caneta: escuras o bastante para ler no fundo branco da folha. */
export const CORES_DA_CANETA = ["#1f1b16", "#1d4ed8", "#b91c1c", "#15803d"] as const;
/** As três espessuras, em pixels da folha. */
export const ESPESSURAS_DA_CANETA = [2, 4, 8] as const;
/** A folha é branca: o desenho guardado se lê em qualquer fundo, no app e no link. */
export const COR_DA_FOLHA = "#ffffff";

/**
 * Quem desenha. Depois que a caneta tocou a folha (o Apple Pencil chega como
 * `pen`), o toque do dedo deixa de desenhar: é a palma da mão apoiada na tela
 * do iPad enquanto se escreve. Sem caneta, o dedo e o mouse desenham.
 */
export function ponteiroDesenha(tipo: string, canetaJaUsada: boolean): boolean {
  if (tipo === "pen" || tipo === "mouse") return true;
  if (tipo === "touch") return !canetaJaUsada;
  return false;
}

/**
 * A largura do traço naquele ponto. Só a caneta informa pressão de verdade: o
 * mouse manda 0,5 com o botão apertado e o dedo, 0 ou 0,5, conforme o aparelho.
 * Por isso só a caneta (`pen`) varia, entre 60% e 140% da espessura escolhida.
 */
export function larguraDoPonto(espessura: number, pressao: number, tipo: string): number {
  if (tipo !== "pen" || !Number.isFinite(pressao) || pressao <= 0) return espessura;
  const p = Math.min(1, Math.max(0, pressao));
  return espessura * (0.6 + 0.8 * p);
}

/**
 * O tamanho da imagem guardada: a folha na tela vezes a densidade do aparelho
 * (o traço fica nítido na tela do iPad), sem passar de `ladoMaximo` no lado
 * maior (a régua das fotos do resumo). Nunca zero.
 */
export function tamanhoDaImagem(largura: number, altura: number, densidade: number, ladoMaximo: number): { largura: number; altura: number; escala: number } {
  const d = Number.isFinite(densidade) && densidade > 0 ? densidade : 1;
  const maior = Math.max(1, largura, altura) * d;
  const escala = d * Math.min(1, ladoMaximo / maior);
  return { largura: Math.max(1, Math.round(largura * escala)), altura: Math.max(1, Math.round(altura * escala)), escala };
}

/** O pincel que desenharTracos usa: o pedaço do CanvasRenderingContext2D que ela chama. */
export type Pincel = Pick<CanvasRenderingContext2D,
  "beginPath" | "moveTo" | "lineTo" | "stroke" | "arc" | "fill" | "fillRect"> & {
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
};

/** A folha em branco e os traços por cima, na escala pedida (1 na tela, a da imagem ao guardar). */
export function desenharTracos(pincel: Pincel, tracos: readonly Traco[], largura: number, altura: number, escala: number): void {
  pincel.fillStyle = COR_DA_FOLHA;
  pincel.fillRect(0, 0, largura, altura);
  pincel.lineCap = "round";
  pincel.lineJoin = "round";
  for (const traco of tracos) {
    pincel.strokeStyle = traco.cor;
    pincel.fillStyle = traco.cor;
    const [primeiro, ...resto] = traco.pontos;
    if (!primeiro) continue;
    if (!resto.length) {
      // Um toque só vira um ponto.
      pincel.beginPath();
      pincel.arc(primeiro.x * escala, primeiro.y * escala, (larguraDoPonto(traco.espessura, primeiro.pressao, traco.tipo) * escala) / 2, 0, Math.PI * 2);
      pincel.fill();
      continue;
    }
    // Um segmento por par de pontos: a largura acompanha a pressão de cada um.
    let anterior = primeiro;
    for (const ponto of resto) {
      pincel.beginPath();
      pincel.lineWidth = larguraDoPonto(traco.espessura, ponto.pressao, traco.tipo) * escala;
      pincel.moveTo(anterior.x * escala, anterior.y * escala);
      pincel.lineTo(ponto.x * escala, ponto.y * escala);
      pincel.stroke();
      anterior = ponto;
    }
  }
}
