import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createServer as createViteServer } from "vite";
import viteConfig from "../../vite.config";

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

/**
 * O Cache-Control dos arquivos de dist/public fora de /assets, servidos pelo
 * segundo express.static de serveStatic. Sem valor, vale o max-age de 1 h.
 */
export function cacheDoEstatico(caminho: string): "no-cache" | undefined {
  if (caminho.endsWith(".html")) return "no-cache";
  // O manifest do app instalável (client/public/manifest.webmanifest) diz
  // onde o app abre e quais ícones ele usa. Com 1 h de cache, uma mudança
  // nele só chegaria uma hora depois a quem já abriu o site.
  if (caminho.endsWith(".webmanifest")) return "no-cache";
  // /brand e /images não levam hash no nome: um logo trocado com o mesmo
  // nome ficaria até 1 h velho no navegador de quem já abriu o site.
  // no-cache revalida pelo ETag a cada visita (304 quando não mudou, sem
  // baixar de novo); só os bundles em /assets merecem o cache de 1 ano.
  if (/[\\/](brand|images)[\\/]/.test(caminho)) return "no-cache";
  return undefined;
}

export function serveStatic(
  app: Express,
  // Só os testes passam a pasta (server/cabecalhos-dos-estaticos.test.ts):
  // eles servem uma pasta temporária, sem depender do build.
  distPath = process.env.NODE_ENV === "development"
    ? path.resolve(import.meta.dirname, "../..", "dist", "public")
    : path.resolve(import.meta.dirname, "public")
) {
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  // Os bundles em /assets levam hash de conteúdo no nome (index-DpIvNu2D.js):
  // podem ser cacheados para sempre. Sem isso, cada visita rebaixava ~900 KB
  // do servidor porque o express.static default manda max-age=0 e a CDN se
  // recusa a cachear. fallthrough:false garante que um hash inexistente vire
  // 404 em vez de receber o index.html com 200 (o navegador tentaria executar
  // HTML como JS).
  app.use(
    "/assets",
    express.static(path.join(distPath, "assets"), {
      immutable: true,
      maxAge: "1y",
      index: false,
      fallthrough: false,
    })
  );

  // Demais estáticos (favicon, /images): cache curto revalidável. index: false
  // impede o static de servir "/" com o header errado — o index.html só sai
  // pelo fallback abaixo, sempre com no-cache, para nunca prender as usuárias
  // numa versão antiga do app. O que sai sem cache está em cacheDoEstatico.
  app.use(
    express.static(distPath, {
      maxAge: "1h",
      index: false,
      setHeaders(res, filePath) {
        const cache = cacheDoEstatico(filePath);
        if (cache) res.setHeader("Cache-Control", cache);
      },
    })
  );

  // fall through to index.html if the file doesn't exist
  app.use("*", (_req, res) => {
    res.set("Cache-Control", "no-cache");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
