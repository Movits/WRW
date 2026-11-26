/**
 * A forma da bolha da voz (components/BolhaDaVoz.tsx): um contorno fechado cujo
 * raio, em cada ângulo, é o raio de repouso deformado por quatro ondas. Em
 * silêncio (nível 0) a bolha é quase redonda e só respira; com a voz, cresce e
 * ondula mais quanto mais alto. As ondas andam com o tempo, mais rápido com a
 * voz, e por isso a bolha parece maleável. O desenho foi aprovado pelo Nicolas
 * em 24/11.
 */

/** [quantas voltas a onda dá no contorno, peso, velocidade]. */
const ONDAS: ReadonlyArray<readonly [number, number, number]> = [
  [2, 0.55, 0.7],
  [3, 0.35, -1.1],
  [5, 0.18, 1.7],
  [7, 0.09, -2.3],
];
/** A soma dos pesos: o maior desvio que as ondas juntas chegam a dar. */
const PESO_TOTAL = ONDAS.reduce((soma, [, peso]) => soma + peso, 0);

/** O respiro do silêncio: 2,5% do raio, num ciclo de uns 4 s. */
const RESPIRO = 0.025;
/** Quanto a voz no máximo aumenta o raio, e quanto ela no máximo deforma. */
const CRESCIMENTO = 0.32;
const DEFORMACAO = 0.16;

/** O raio no `angulo` (radianos), no instante `tempo` (segundos), com o `nivel` da voz (0 a 1). */
export function raioDaBolha(base: number, nivel: number, angulo: number, tempo: number): number {
  const n = Math.min(1.2, Math.max(0, nivel));
  let ondas = 0;
  for (const [voltas, peso, velocidade] of ONDAS) ondas += peso * Math.sin(voltas * angulo + velocidade * tempo * (0.6 + n));
  return base * (1 + RESPIRO * Math.sin(tempo * 1.6) + n * CRESCIMENTO + n * DEFORMACAO * ondas);
}

/** O maior raio que a bolha chega a ter com o `nivel` (para caber no desenho). */
export function raioMaximoDaBolha(base: number, nivel: number): number {
  const n = Math.min(1.2, Math.max(0, nivel));
  return base * (1 + RESPIRO + n * CRESCIMENTO + n * DEFORMACAO * PESO_TOTAL);
}

/** Os `quantos` pontos do contorno, em volta de (cx, cy). */
export function pontosDaBolha(cx: number, cy: number, base: number, nivel: number, tempo: number, quantos = 72): Array<[number, number]> {
  const pontos: Array<[number, number]> = [];
  for (let i = 0; i < quantos; i++) {
    const angulo = (i / quantos) * Math.PI * 2;
    const raio = raioDaBolha(base, nivel, angulo, tempo);
    pontos.push([cx + raio * Math.cos(angulo), cy + raio * Math.sin(angulo)]);
  }
  return pontos;
}
