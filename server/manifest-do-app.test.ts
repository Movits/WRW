import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ROTA_GRAVAR } from "@shared/rotas";
import { montarDiretivasCsp } from "./_core/csp";

/**
 * O APP INSTALÁVEL (PWA).
 *
 * O manifest (client/public/manifest.webmanifest) põe a WRW na tela inicial do
 * celular como app e a abre direto no gravador, o link que a cliente pediu
 * como primeira tela (20/10/2026). JSON não tem comentário, então as regras
 * dele ficam aqui:
 * - abre em /gravar, a rota de shared/rotas.ts que o App.tsx monta;
 * - leva só a marca: o manifest é estático e não se traduz, e qualquer outro
 *   texto (descrição, atalho) sairia num idioma só para as usuárias dos 10;
 * - cada ícone existe no disco com o tamanho que declara, e o "maskable" tem
 *   fundo inteiro e o desenho dentro do círculo de 80% que o Android recorta;
 * - não há service worker: nada guarda no aparelho um index.html velho.
 * O cabeçalho com que o servidor entrega o manifest está em
 * server/cabecalhos-dos-estaticos.test.ts.
 */

const RAIZ = fileURLToPath(new URL("../", import.meta.url));
const PUBLICO = join(RAIZ, "client", "public");

type Icone = { src: string; sizes: string; type: string; purpose?: string };
type Manifest = Record<string, unknown> & {
  icons: Icone[];
  background_color: string;
};

const manifest = JSON.parse(
  readFileSync(join(PUBLICO, "manifest.webmanifest"), "utf8")
) as Manifest;
const indexHtml = readFileSync(join(RAIZ, "client", "index.html"), "utf8");
const app = readFileSync(join(RAIZ, "client", "src", "App.tsx"), "utf8");

/** O content da <meta name="..."> do index.html. */
function meta(nome: string) {
  return indexHtml.match(
    new RegExp(`<meta\\s+name="${nome}"\\s+content="([^"]*)"`)
  )?.[1];
}

function finalidades(icone: Icone) {
  return (icone.purpose ?? "any").split(/\s+/);
}

/** Largura e altura do PNG, lidas do cabeçalho IHDR (bytes 16 a 23). */
function tamanhoDoPng(arquivo: Buffer) {
  expect(arquivo.toString("ascii", 1, 4)).toBe("PNG");
  expect(arquivo.toString("ascii", 12, 16)).toBe("IHDR");
  return `${arquivo.readUInt32BE(16)}x${arquivo.readUInt32BE(20)}`;
}

/**
 * Os pixels RGBA de um PNG de 8 bits por canal, sem entrelaçamento (o formato
 * dos ícones de client/public/brand): junta os blocos IDAT, descomprime e
 * desfaz o filtro de cada linha. Sem dependência nova, só o zlib do Node.
 */
function pixelsDoPng(arquivo: Buffer) {
  const largura = arquivo.readUInt32BE(16);
  const altura = arquivo.readUInt32BE(20);
  // Profundidade, tipo de cor e entrelaçamento: 8 bits, RGBA, nenhum.
  expect([arquivo[24], arquivo[25], arquivo[28]]).toEqual([8, 6, 0]);
  const blocos: Buffer[] = [];
  for (let pos = 8; pos < arquivo.length; ) {
    const tamanho = arquivo.readUInt32BE(pos);
    if (arquivo.toString("ascii", pos + 4, pos + 8) === "IDAT") {
      blocos.push(arquivo.subarray(pos + 8, pos + 8 + tamanho));
    }
    pos += 12 + tamanho;
  }
  const cru = inflateSync(Buffer.concat(blocos));
  const linha = largura * 4;
  const px = Buffer.alloc(altura * linha);
  for (let y = 0; y < altura; y++) {
    const filtro = cru[y * (linha + 1)];
    if (filtro > 4) throw new Error(`filtro de linha desconhecido: ${filtro}`);
    for (let x = 0; x < linha; x++) {
      const a = x >= 4 ? px[y * linha + x - 4] : 0;
      const b = y > 0 ? px[(y - 1) * linha + x] : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * linha + x - 4] : 0;
      let preditor = 0;
      if (filtro === 1) preditor = a;
      else if (filtro === 2) preditor = b;
      else if (filtro === 3) preditor = (a + b) >> 1;
      else if (filtro === 4) {
        const p = a + b - c;
        const [pa, pb, pc] = [
          Math.abs(p - a),
          Math.abs(p - b),
          Math.abs(p - c),
        ];
        preditor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * linha + x] = (cru[y * (linha + 1) + 1 + x] + preditor) & 255;
    }
  }
  return { largura, altura, px };
}

/** Arquivos de uma pasta e das subpastas. */
function arquivosDe(pasta: string): string[] {
  return readdirSync(pasta, { withFileTypes: true }).flatMap(entrada =>
    entrada.isDirectory()
      ? arquivosDe(join(pasta, entrada.name))
      : [join(pasta, entrada.name)]
  );
}

describe("o manifest do app instalável", () => {
  it("abre direto no gravador, numa rota que o App.tsx monta", () => {
    expect(manifest.start_url).toBe(ROTA_GRAVAR);
    expect(app).toContain(`<Route path="${ROTA_GRAVAR}">`);
  });

  it("é o site inteiro, em janela própria, com identidade fixa", () => {
    // id "/" não depende do start_url: mudar o endereço de abertura não cria
    // um segundo app no aparelho de quem já instalou.
    expect(manifest.id).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  it("leva só a marca, sem atalho nem texto para traduzir", () => {
    expect(manifest.short_name).toBe("WRW");
    expect(manifest.name).toBe(indexHtml.match(/<title>([^<]+)<\/title>/)?.[1]);
    for (const campo of [
      "shortcuts",
      "description",
      "screenshots",
      "categories",
    ]) {
      expect(manifest, campo).not.toHaveProperty(campo);
    }
  });

  it("usa a cor da marca, a mesma do theme-color do index.html", () => {
    expect(meta("theme-color")).toBe("#151312");
    expect(manifest.theme_color).toBe(meta("theme-color"));
    expect(manifest.background_color).toBe(meta("theme-color"));
  });

  it("cada ícone existe em client/public com o tamanho que declara", () => {
    for (const icone of manifest.icons) {
      const arquivo = join(PUBLICO, icone.src);
      expect(existsSync(arquivo), icone.src).toBe(true);
      expect(icone.type, icone.src).toBe("image/png");
      expect(tamanhoDoPng(readFileSync(arquivo)), icone.src).toBe(icone.sizes);
    }
    // O Chrome só oferece a instalação com um ícone de 192 e um de 512 px.
    const comuns = manifest.icons
      .filter(icone => finalidades(icone).includes("any"))
      .map(icone => icone.sizes);
    expect(comuns).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  });

  it("o ícone maskable tem fundo inteiro na cor do app e o desenho dentro do círculo de 80%", () => {
    const maskables = manifest.icons.filter(icone =>
      finalidades(icone).includes("maskable")
    );
    expect(maskables.length).toBeGreaterThan(0);
    const fundo = [1, 3, 5].map(i =>
      parseInt(manifest.background_color.slice(i, i + 2), 16)
    );
    for (const icone of maskables) {
      const { largura, altura, px } = pixelsDoPng(
        readFileSync(join(PUBLICO, icone.src))
      );
      // O Android recorta o ícone em círculo, gota ou quadrado arredondado e
      // só garante o círculo central de raio 40% do lado (a zona segura).
      // Fora dele tem de haver só fundo; pixel transparente viraria um buraco.
      const raioSeguro = 0.4 * largura;
      const [cx, cy] = [(largura - 1) / 2, (altura - 1) / 2];
      let transparentes = 0;
      let desenhoForaDaZona = 0;
      for (let y = 0; y < altura; y++) {
        for (let x = 0; x < largura; x++) {
          const i = (y * largura + x) * 4;
          if (px[i + 3] !== 255) transparentes++;
          if (Math.hypot(x - cx, y - cy) <= raioSeguro) continue;
          const diferenca = Math.max(
            ...fundo.map((canal, k) => Math.abs(px[i + k] - canal))
          );
          if (diferenca > 8) desenhoForaDaZona++;
        }
      }
      expect(transparentes, icone.src).toBe(0);
      expect(desenhoForaDaZona, icone.src).toBe(0);
    }
  });
});

describe("o index.html do app instalável", () => {
  it("liga o manifest e traz as metas da Apple", () => {
    expect(indexHtml).toMatch(
      /<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"\s*\/?>/
    );
    expect(meta("mobile-web-app-capable")).toBe("yes");
    expect(meta("apple-mobile-web-app-capable")).toBe("yes");
    expect(meta("apple-mobile-web-app-title")).toBe(manifest.short_name);
    // "black-translucent" poria a página por baixo do relógio do iPhone.
    expect(meta("apple-mobile-web-app-status-bar-style")).toBe("black");
    const iconeDaApple = indexHtml.match(
      /<link\s+rel="apple-touch-icon"[^>]*href="([^"]+)"/
    )?.[1];
    expect(iconeDaApple).toBeDefined();
    expect(existsSync(join(PUBLICO, iconeDaApple!))).toBe(true);
  });

  it("não registra service worker, nem há arquivo de service worker em client/public", () => {
    const codigo = arquivosDe(join(RAIZ, "client", "src")).filter(
      arquivo => /\.tsx?$/.test(arquivo) && !/\.test\.tsx?$/.test(arquivo)
    );
    expect(codigo.length).toBeGreaterThan(0);
    for (const arquivo of codigo) {
      expect(readFileSync(arquivo, "utf8"), arquivo).not.toMatch(
        /serviceWorker/
      );
    }
    expect(indexHtml).not.toMatch(/serviceWorker/);
    const publicos = arquivosDe(PUBLICO).map(arquivo =>
      arquivo.slice(PUBLICO.length)
    );
    expect(
      publicos.filter(arquivo =>
        /(sw|service-?worker)[^\\/]*\.js$/i.test(arquivo)
      )
    ).toEqual([]);
  });

  it("a CSP de produção já cobre o manifest e os ícones, sem diretiva nova", () => {
    const csp = montarDiretivasCsp(false);
    // Sem manifest-src, o navegador usa o default-src 'self'.
    expect(csp).not.toHaveProperty("manifestSrc");
    expect(csp.defaultSrc).toEqual(["'self'"]);
    expect(csp.imgSrc).toContain("'self'");
  });
});
