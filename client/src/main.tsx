import { trpc } from "@/lib/trpc";
import { escutarPedidoDeInstalacao } from "@/lib/instalacao-do-app";
import { destinoPorSessaoVencida } from "@/lib/sessao-vencida";
import { tratarChunkAntigo } from "@/lib/versao-nova";
import { toast } from "sonner";
import i18n from "./i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import "./i18n"; // must be imported before App
import App from "./App";
import "./index.css";

const queryClient = new QueryClient();

// Chunk antigo depois de um deploy: recarrega uma vez, menos com a sessão
// ocupada (gravando, enviando ou com áudio por enviar), quando avisa e espera a
// sessão desocupar. As regras e o porquê estão em lib/versao-nova.ts, com teste.
window.addEventListener("vite:preloadError", event => {
  tratarChunkAntigo(event, {
    recarregar: () => window.location.reload(),
    enderecoAtual: () => window.location.href,
    armazenamento: () => window.sessionStorage,
    avisar: () => toast.info(i18n.t("sessaoOcupada.versaoNovaDepoisDoEnvio"), { id: "versao-nova", duration: Infinity }),
    dispensarAviso: () => toast.dismiss("versao-nova"),
  });
});

// O Chromium oferece a instalação do app uma vez por carga, às vezes antes de
// o gravador (carregado sob demanda) montar: a escuta começa aqui, e o pedido
// fica guardado para a dica do /gravar (lib/instalacao-do-app.ts).
escutarPedidoDeInstalacao();

// A sessão que vence no meio do uso volta à mesma tela depois do login; as
// regras (só o "não autenticada" do tRPC, nunca nas páginas públicas) estão em
// lib/sessao-vencida.ts, com teste.
const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (typeof window === "undefined") return;
  const destino = destinoPorSessaoVencida(error, window.location);
  if (destino) window.location.href = destino;
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Mutation Error]", error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
