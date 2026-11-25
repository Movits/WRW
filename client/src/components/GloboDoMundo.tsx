import { useEffect, useRef } from "react";
import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { mesh } from "topojson-client";
import mundo from "world-atlas/countries-110m.json";
import {
  COREOGRAFIA,
  INCLINACAO_GRAUS,
  LATITUDE_DA_CAMERA_GRAUS,
  enquadramento,
  fracaoNaJanela,
  raioDaPracaEmPx,
  roteiroDaRede,
} from "@/lib/coreografia-do-globo";
import type { Ligacao, Praca } from "@/lib/pracas-do-globo";

/**
 * O planeta da WRW — a Rede viva: o Brasil no centro e as linhas saindo dele
 * para os continentes e, de cada continente, para os países.
 *
 * Tudo que se move aqui se move PELA ROLAGEM, e só por ela (a viagem está em
 * lib/coreografia-do-globo.ts): nada anima sozinho, então o planeta só é
 * redesenhado quando a rolagem ou o tamanho mudam.
 *
 * Por que 3D e não uma sequência de imagens: a rotação é contínua e pesa uma
 * geometria só, em vez de 60 a 120 quadros (3 a 5 MB). E o globo carrega
 * DADOS: as praças vêm do servidor, agregadas por país. Uma imagem seria
 * enfeite; isto é informação.
 *
 * As fronteiras vêm do Natural Earth (world-atlas, domínio público).
 */

const RAIO = 1;
// Ouro rosé do selo WMMW (#C98F70), a mesma paleta do aplicativo.
const OURO = new THREE.Color(0xc98f70);
const GRAU = Math.PI / 180;

// Onde a WRW faz negócio, de verdade: as praças chegam por props, do agregado
// por país das usuárias reais (stats.presencaPorPais, montado por
// montarPracasDoGlobo) — nunca por pessoa. Sem dado, sem praça: o planeta
// continua inteiro. Os padrões são constantes de módulo de propósito: um []
// inline nas props teria identidade nova a cada render da Home e, como estão
// nas deps do useEffect, derrubaria e reconstruiria a cena sem necessidade.
const SEM_PRACAS: Praca[] = [];
const SEM_LIGACOES: Ligacao[] = [];

function paraEsfera(lat: number, lon: number, raio = RAIO): THREE.Vector3 {
  const phi = (90 - lat) * GRAU;
  const theta = (lon + 180) * GRAU;
  return new THREE.Vector3(
    -raio * Math.sin(phi) * Math.cos(theta),
    raio * Math.cos(phi),
    raio * Math.sin(phi) * Math.sin(theta),
  );
}

/**
 * Qual longitude encara a câmera. Sai da geometria acima: um ponto do equador
 * fica em (-cos θ, 0, sen θ) com θ = lon + 180; girando o grupo em A, o z é
 * máximo quando θ + A = 90°. Logo, longitude de frente = -90° - A.
 *
 * Ter a fórmula em vez de tentativa e erro importa: o primeiro palpite punha a
 * Indonésia no centro quando eu queria o Brasil.
 */
export function anguloParaLongitude(longitude: number): number {
  return (-90 - longitude) * GRAU;
}

/**
 * A orientação do planeta com uma longitude de frente. A ordem ZXY é a do
 * protótipo aprovado: gira na longitude, depois inclina a câmera 8° acima do
 * equador, depois inclina o eixo na tela. Com a ordem padrão (XYZ) a inclinação
 * vinha ANTES do giro e o polo balançava conforme a rolagem.
 */
export function orientacaoDoPlaneta(lonCentro: number): THREE.Euler {
  return new THREE.Euler(
    LATITUDE_DA_CAMERA_GRAUS * GRAU,
    anguloParaLongitude(lonCentro),
    INCLINACAO_GRAUS * GRAU,
    "ZXY",
  );
}

/**
 * O céu: posições sorteadas UMA vez, com semente fixa. Sorteadas dentro do
 * efeito, cada reconstrução da cena (trocar a vista parada, chegar o dado)
 * mudava as estrelas de lugar.
 */
const POSICOES_DAS_ESTRELAS = (() => {
  const quantas = 420;
  let semente = 0x5eed;
  const sortear = () => {
    semente = (semente * 1664525 + 1013904223) >>> 0;
    return semente / 2 ** 32;
  };
  const posicoes = new Float32Array(quantas * 3);
  for (let i = 0; i < quantas; i++) {
    posicoes.set([(sortear() * 2 - 1) * 5, (sortear() * 2 - 1) * 4, -8 - sortear() * 4], i * 3);
  }
  return posicoes;
})();

/** Quantos trechos cada rota tem: o crescimento anda de trecho em trecho. */
const TRECHOS_DA_ROTA = 48;

/**
 * A rota entre duas praças: um arco pela superfície (interpolação esférica),
 * que sobe e volta. Diferente de uma Bézier entre os dois pontos, este arco
 * nunca entra no planeta — com a Bézier, as rotas longas (DF→Japão) passavam
 * por dentro da esfera e sumiam no meio.
 */
function arcoEntre(a: Praca, b: Praca, altura: number): number[] {
  const va = paraEsfera(a.lat, a.lon);
  const vb = paraEsfera(b.lat, b.lon);
  const angulo = va.angleTo(vb);
  const pontos: number[] = [];
  for (let i = 0; i <= TRECHOS_DA_ROTA; i++) {
    const t = i / TRECHOS_DA_ROTA;
    const direcao =
      angulo < 1e-6
        ? va.clone()
        : va
            .clone()
            .multiplyScalar(Math.sin((1 - t) * angulo) / Math.sin(angulo))
            .add(vb.clone().multiplyScalar(Math.sin(t * angulo) / Math.sin(angulo)));
    direcao.normalize().multiplyScalar(RAIO * 1.004 + Math.sin(Math.PI * t) * altura);
    pontos.push(direcao.x, direcao.y, direcao.z);
  }
  return pontos;
}

const VERTEX_NORMAL = `
  varying vec3 vNormal;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Oceano: quase preto no centro, acendendo numa borda dourada. É esse degradê
// que faz a esfera parecer um corpo com volume, e não um disco.
const FRAG_OCEANO = `
  varying vec3 vNormal;
  void main() {
    float frente = max(dot(vNormal, vec3(0.0, 0.0, 1.0)), 0.0);
    vec3 base = mix(vec3(0.050, 0.045, 0.040), vec3(0.129, 0.118, 0.106), frente);
    float borda = pow(1.0 - frente, 3.5);
    gl_FragColor = vec4(base + borda * vec3(0.79, 0.56, 0.44) * 0.55, 1.0);
  }
`;

// Atmosfera: casca maior desenhada pelo lado de dentro (BackSide) e somada à
// cena. Como só vemos o anel entre o raio do planeta e o da casca, o produto
// escalar ali vai de cerca de -0,6 (colado no planeta) a 0 (borda externa) — e
// a curva abaixo é decrescente nesse intervalo, que é o que faz o halo nascer
// grudado no planeta e apagar para fora.
const FRAG_ATMOSFERA = `
  varying vec3 vNormal;
  void main() {
    float intensidade = pow(max(0.55 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 0.0), 4.0);
    gl_FragColor = vec4(0.79, 0.56, 0.44, 1.0) * min(intensidade, 1.0) * 0.26;
  }
`;

type Props = {
  progresso: () => number;
  /**
   * Vista parada, para quem desligou o movimento (no botão da home ou pelo
   * `prefers-reduced-motion`): o planeta inteiro com o Brasil de frente e a
   * rede toda acesa, sem acompanhar a rolagem.
   */
  vistaParada?: boolean;
  /** Agregado por país (montarPracasDoGlobo) — nunca dado de uma pessoa. */
  pracas?: Praca[];
  /** [de, para, nível] com índices em `pracas`; índice inválido é ignorado. */
  ligacoes?: Ligacao[];
};

export default function GloboDoMundo({
  progresso,
  vistaParada = false,
  pracas = SEM_PRACAS,
  ligacoes = SEM_LIGACOES,
}: Props) {
  const hospedeiro = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const alvo = hospedeiro.current;
    if (!alvo) return;

    // Sem WebGL não há tela preta: o componente não desenha e o fundo da página
    // (a imagem bordada) continua valendo sozinho.
    const teste = document.createElement("canvas");
    if (!teste.getContext("webgl2") && !teste.getContext("webgl")) return;

    const cena = new THREE.Scene();
    // Câmera ORTOGRÁFICA, como no protótipo aprovado: com perspectiva, o zoom de
    // 2,8× sobre o Brasil deformava o litoral como uma lente.
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 40);
    camera.position.z = 10;

    const renderizador = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderizador.setClearColor(0x000000, 0);
    // Teto no devicePixelRatio: em tela 3x o custo por quadro triplica sem ganho
    // visível numa linha de um pixel.
    renderizador.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    alvo.appendChild(renderizador.domElement);

    const descartaveis: Array<{ dispose: () => void }> = [];
    const registrar = <T extends { dispose: () => void }>(x: T) => {
      descartaveis.push(x);
      return x;
    };

    const grupo = new THREE.Group();
    grupo.rotation.order = "ZXY";
    cena.add(grupo);

    // ── Estrelas ──────────────────────────────────────────────────────────
    // Ficam FORA do grupo e ATRÁS do planeta: o céu não acompanha a viagem. Com
    // a câmera ortográfica elas moram num plano ao fundo, espalhadas por uma
    // área maior que a de qualquer tela.
    const geometriaDasEstrelas = registrar(new THREE.BufferGeometry());
    geometriaDasEstrelas.setAttribute("position", new THREE.BufferAttribute(POSICOES_DAS_ESTRELAS, 3));
    cena.add(
      new THREE.Points(
        geometriaDasEstrelas,
        registrar(
          new THREE.PointsMaterial({ color: 0xffffff, size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0.5 }),
        ),
      ),
    );

    // ── Oceano e atmosfera ────────────────────────────────────────────────
    grupo.add(
      new THREE.Mesh(
        registrar(new THREE.SphereGeometry(RAIO * 0.995, 64, 64)),
        registrar(new THREE.ShaderMaterial({ vertexShader: VERTEX_NORMAL, fragmentShader: FRAG_OCEANO })),
      ),
    );
    // No GRUPO, não na cena: a atmosfera acompanha o planeta no deslocamento e
    // no zoom.
    grupo.add(
      new THREE.Mesh(
        registrar(new THREE.SphereGeometry(RAIO * 1.22, 48, 48)),
        registrar(
          new THREE.ShaderMaterial({
            vertexShader: VERTEX_NORMAL,
            fragmentShader: FRAG_ATMOSFERA,
            side: THREE.BackSide,
            blending: THREE.AdditiveBlending,
            transparent: true,
            depthWrite: false,
          }),
        ),
      ),
    );

    // ── Meridianos e paralelos ────────────────────────────────────────────
    // Baratos e decisivos: são eles que dizem ao olho "isto é um globo".
    const gradeVertices: number[] = [];
    const ponto = (lat: number, lon: number) => paraEsfera(lat, lon, RAIO * 1.0005);
    for (let lon = -180; lon < 180; lon += 20) {
      for (let lat = -90; lat < 90; lat += 4) {
        gradeVertices.push(...ponto(lat, lon).toArray(), ...ponto(lat + 4, lon).toArray());
      }
    }
    for (let lat = -60; lat <= 60; lat += 20) {
      for (let lon = -180; lon < 180; lon += 4) {
        gradeVertices.push(...ponto(lat, lon).toArray(), ...ponto(lat, lon + 4).toArray());
      }
    }
    const geometriaDaGrade = registrar(new THREE.BufferGeometry());
    geometriaDaGrade.setAttribute("position", new THREE.Float32BufferAttribute(gradeVertices, 3));
    grupo.add(
      new THREE.LineSegments(
        geometriaDaGrade,
        registrar(new THREE.LineBasicMaterial({ color: 0x4a3f36, transparent: true, opacity: 0.16 })),
      ),
    );

    // ── Litoral e divisas ─────────────────────────────────────────────────
    //
    // O `mesh` do topojson aceita um filtro que compara as DUAS faces vizinhas
    // de cada traço, e é ele que separa as duas coisas:
    //
    //   (a, b) => a === b   →  o traço só tem um país de um lado: é LITORAL
    //   (a, b) => a !== b   →  há país dos dois lados: é DIVISA INTERNA
    //
    // Assim cada traço existe uma vez só, e o litoral fica mais forte que as
    // divisas, que é o que faz o continente ter forma.
    const topologia = mundo as any;
    const paises = topologia.objects.countries;

    const construir = (linhas: number[][][], raio: number) => {
      const vertices: number[] = [];
      for (const linha of linhas) {
        for (let i = 0; i < linha.length - 1; i++) {
          vertices.push(
            ...paraEsfera(linha[i][1], linha[i][0], raio).toArray(),
            ...paraEsfera(linha[i + 1][1], linha[i + 1][0], raio).toArray(),
          );
        }
      }
      const g = registrar(new THREE.BufferGeometry());
      g.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
      return g;
    };

    const litoral = mesh(topologia, paises, (a: any, b: any) => a === b) as any;
    const internas = mesh(topologia, paises, (a: any, b: any) => a !== b) as any;

    grupo.add(
      new THREE.LineSegments(
        construir(litoral.coordinates, RAIO * 1.0015),
        registrar(new THREE.LineBasicMaterial({ color: OURO, transparent: true, opacity: 0.85 })),
      ),
    );
    grupo.add(
      new THREE.LineSegments(
        construir(internas.coordinates, RAIO * 1.001),
        registrar(new THREE.LineBasicMaterial({ color: OURO, transparent: true, opacity: 0.22 })),
      ),
    );

    // ── A rede: rotas e praças ────────────────────────────────────────────
    const roteiro = roteiroDaRede(pracas, ligacoes);

    // Linhas com espessura de verdade (Line2): a LineBasicMaterial desenha um
    // pixel de DISPOSITIVO, meio pixel numa tela 2x, e a rede sumia.
    const materialDoTronco = registrar(
      new LineMaterial({ color: 0xefcba8, linewidth: 1.5, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    const materialDoRamo = registrar(
      new LineMaterial({ color: 0xe3b18e, linewidth: 1, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    const rotas = roteiro.rotas.map(rota => {
      const geometria = registrar(new LineGeometry());
      const altura = rota.nivel === "tronco" ? 0.075 : 0.03;
      geometria.setPositions(arcoEntre(pracas[rota.de], pracas[rota.para], altura));
      const linha = new Line2(geometria, rota.nivel === "tronco" ? materialDoTronco : materialDoRamo);
      linha.visible = false;
      grupo.add(linha);
      return { linha, geometria, janela: rota.janela };
    });

    // Praças: núcleo e halo em esferas de raio 1, reescaladas a cada quadro
    // para terem o tamanho certo EM PIXELS — senão o zoom de 2,8× inflava os
    // pontos junto com o planeta.
    const geometriaDaEsfera = registrar(new THREE.SphereGeometry(1, 16, 12));
    const marcadores = pracas.map((praca, i) => {
      const nucleo = new THREE.Mesh(
        geometriaDaEsfera,
        registrar(new THREE.MeshBasicMaterial({ color: 0xefcba8, transparent: true })),
      );
      const halo = new THREE.Mesh(
        geometriaDaEsfera,
        registrar(new THREE.MeshBasicMaterial({ color: OURO, transparent: true, depthWrite: false })),
      );
      const posicao = paraEsfera(praca.lat, praca.lon, RAIO * 1.008);
      nucleo.position.copy(posicao);
      halo.position.copy(posicao);
      grupo.add(halo, nucleo);
      return { nucleo, halo, ...roteiro.pracas[i] };
    });

    // ── Enquadramento ─────────────────────────────────────────────────────
    // O meio do Brasil na orientação de partida: no pico, é ele que vai para o
    // lugar de repouso do planeta.
    const foco = paraEsfera(COREOGRAFIA.FOCO.lat, COREOGRAFIA.FOCO.lon).applyEuler(
      orientacaoDoPlaneta(COREOGRAFIA.LON_BRASIL),
    );
    const repouso = new THREE.Vector2();
    let pxPorUnidade = 1;

    const dimensionar = () => {
      const { clientWidth: l, clientHeight: a } = alvo;
      if (!l || !a) return false;
      // updateStyle ligado de propósito: com devicePixelRatio > 1 o canvas mede
      // l×a px CSS e desenha em alta densidade por dentro.
      renderizador.setSize(l, a);
      // Em tela larga o planeta fica à direita (62% da largura), liberando o
      // texto; em tela estreita, no meio, um pouco acima do centro. O raio em
      // repouso é uma fração do menor lado — o planeta inteiro cabe sempre,
      // atmosfera incluída.
      const largo = l / a > 1.2;
      pxPorUnidade = Math.min(l, a) * (largo ? 0.34 : 0.36);
      camera.left = -l / 2 / pxPorUnidade;
      camera.right = l / 2 / pxPorUnidade;
      camera.top = a / 2 / pxPorUnidade;
      camera.bottom = -a / 2 / pxPorUnidade;
      camera.updateProjectionMatrix();
      repouso.set(largo ? (0.12 * l) / pxPorUnidade : 0, largo ? 0 : (0.02 * a) / pxPorUnidade);
      materialDoTronco.resolution.set(l, a);
      materialDoRamo.resolution.set(l, a);
      return true;
    };

    const posicionar = (p: number) => {
      // Vista parada: o enquadramento da partida (o Brasil de frente) com a
      // rede inteira acesa.
      const { abertura, fechamento, lonCentro } = enquadramento(vistaParada ? 0 : p);
      const pRede = vistaParada ? 1 : p;

      grupo.rotation.copy(orientacaoDoPlaneta(lonCentro));
      grupo.scale.setScalar(abertura);
      // Com a câmera perto, o planeta ocupa a tela inteira e fica atrás dos
      // títulos: ele apaga um pouco para as letras continuarem na frente.
      renderizador.domElement.style.opacity = String(1 - 0.4 * fechamento);
      grupo.position.set(
        repouso.x - abertura * fechamento * foco.x,
        repouso.y - abertura * fechamento * foco.y,
        0,
      );

      for (const rota of rotas) {
        const fracao = fracaoNaJanela(pRede, rota.janela);
        rota.linha.visible = fracao > 0.002;
        rota.geometria.instanceCount = Math.max(1, Math.round(fracao * TRECHOS_DA_ROTA));
      }

      // Com o zoom, os pontos crescem um pouco (até 1,9×), não as 2,8× do planeta.
      const ampliacao = Math.min(1.9, Math.max(1, abertura));
      const unidadesPorPx = 1 / (pxPorUnidade * abertura);
      for (const m of marcadores) {
        const alfa = m.janela ? fracaoNaJanela(pRede, m.janela) * m.brilho : 1;
        const raio = raioDaPracaEmPx(m.papel, pRede) * ampliacao * unidadesPorPx;
        m.nucleo.visible = m.halo.visible = alfa > 0.002;
        m.nucleo.scale.setScalar(raio);
        m.halo.scale.setScalar(raio * 2.3);
        (m.nucleo.material as THREE.MeshBasicMaterial).opacity = alfa;
        (m.halo.material as THREE.MeshBasicMaterial).opacity = 0.28 * alfa;
      }
    };

    // ── Desenho sob demanda ───────────────────────────────────────────────
    // Um quadro quando a rolagem ou o tamanho mudam, e só. Depois de cada
    // evento o laço confere mais alguns quadros: o hook da Home mede a rolagem
    // no próprio requestAnimationFrame, que pode rodar depois deste — sem a
    // conferência, o planeta parava um passo atrás da página.
    let ultimo = Number.NaN;
    let sujo = true;
    let quadro = 0;
    let quadrosSemMudanca = 0;
    const desenhar = () => {
      quadro = 0;
      const p = vistaParada ? 0 : progresso();
      if (sujo || p !== ultimo) {
        sujo = false;
        ultimo = p;
        quadrosSemMudanca = 0;
        posicionar(p);
        renderizador.render(cena, camera);
      } else {
        quadrosSemMudanca++;
      }
      if (quadrosSemMudanca < 3) quadro = requestAnimationFrame(desenhar);
    };
    const agendar = () => {
      quadrosSemMudanca = 0;
      if (!quadro) quadro = requestAnimationFrame(desenhar);
    };

    // Redesenha assim que o contêiner muda de tamanho, atrelado ao
    // ResizeObserver (depois do setSize): o evento resize da janela disparava
    // ANTES do observer, o quadro saía com o tamanho velho e o setSize seguinte
    // limpava o canvas — planeta em branco ao girar o celular.
    const observador = new ResizeObserver(() => {
      if (!dimensionar()) return;
      sujo = true;
      if (quadro) cancelAnimationFrame(quadro);
      quadro = 0;
      desenhar();
    });
    observador.observe(alvo);
    if (dimensionar()) desenhar();

    window.addEventListener("scroll", agendar, { passive: true });

    return () => {
      window.removeEventListener("scroll", agendar);
      if (quadro) cancelAnimationFrame(quadro);
      observador.disconnect();
      for (const d of descartaveis) d.dispose();
      renderizador.dispose();
      if (renderizador.domElement.parentNode === alvo) alvo.removeChild(renderizador.domElement);
    };
  }, [progresso, vistaParada, pracas, ligacoes]);

  return <div ref={hospedeiro} className="w-full h-full" aria-hidden="true" />;
}
