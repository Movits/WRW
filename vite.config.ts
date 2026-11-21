import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    // Fonte NUNCA vira `data:` URI. O Vite embute sozinho todo arquivo abaixo
    // de 4 kB, e o CSP do servidor (server/_core/csp.ts) aceita fonte só de
    // 'self' e de fonts.gstatic.com — então a fonte embutida chegava ao
    // navegador e era barrada, com um erro de CSP no console de TODA visita.
    // Quem trouxe a fonte foi o `streamdown`, que renderiza o texto do termo e
    // arrasta o KaTeX junto; uma das fontes do KaTeX é pequena o bastante para
    // ser embutida.
    //
    // A correção é aqui, e não no CSP: liberar `data:` em font-src resolveria o
    // erro afrouxando a política para todo o site. Devolver `false` obriga o
    // arquivo a ser servido de /assets, que é 'self' e já passa. `undefined`
    // deixa o resto dos arquivos com o comportamento padrão do Vite.
    assetsInlineLimit: (caminho: string) =>
      /\.(woff2?|ttf|otf|eot)$/i.test(caminho) ? false : undefined,
  },
  // O pdf.js (o leitor das páginas do documento, H12b, client/src/lib/leitor-de-pdf.ts)
  // só entra quando a aba das páginas abre, por import() dinâmico e pelo Worker:
  // a varredura do servidor de dev não o acha na subida, otimiza na primeira
  // abertura e RECARREGA a página, que volta para a aba Resumo (conferência de
  // tela de 20/11/2026). Listado aqui, ele é otimizado já na subida. O build de
  // produção não usa esta lista.
  optimizeDeps: {
    include: ["pdfjs-dist/legacy/build/pdf.mjs", "pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
  server: {
    host: true,
    allowedHosts: ["localhost", "127.0.0.1"],
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
