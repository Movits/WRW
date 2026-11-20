// A trava do app: pedir o Face ID, a digital ou o bloqueio de tela do celular
// ao abrir o app e ao voltar para ele depois de um tempo em segundo plano
// (pedido da Glenda em 11/11/2026; cartão "App: pedir Face ID ao abrir como
// opção"). Desligada por padrão. A biometria nunca sai do celular: quem confere
// é o próprio sistema (expo-local-authentication), e a WRW não recebe nada.
//
// Aqui fica só o que não depende do React Native, para ser testado pela suíte
// da raiz (server/trava-do-app.test.ts): as regras de quando travar, de quando
// mostrar o aviso e o formato da conversa com o site (o Perfil liga e desliga
// a trava, só dentro do app).

/** Minutos em segundo plano depois dos quais o app pede o Face ID de novo. */
export const MINUTOS_PARA_TRAVAR_DE_NOVO = 10;

/** No cofre do celular (expo-secure-store): "ligada" quando a trava está ligada. */
export const CHAVE_DA_TRAVA = "wrw.trava";
/** No cofre do celular: o aviso depois do login já foi respondido (ligou ou "Agora não"). */
export const CHAVE_DO_AVISO = "wrw.trava.aviso";

/** Voltou ao app depois de tempo bastante em segundo plano para pedir o Face ID de novo. */
export function precisaTravarAoVoltar(saiuEm: number | null, agora: number): boolean {
  if (saiuEm === null) return false;
  return agora - saiuEm >= MINUTOS_PARA_TRAVAR_DE_NOVO * 60_000;
}

// As telas da área logada do site (client/src/App.tsx). O aviso só aparece
// nelas: é o sinal de que a pessoa já entrou na conta. O cadastro por concluir
// (/onboarding), o login, a página inicial e o link aberto ficam de fora.
const AREA_LOGADA = [
  "/gravar",
  "/meetings",
  "/agenda",
  "/proximas-acoes",
  "/profile",
  "/dashboard",
  "/network",
  "/contexts",
  "/memory",
  "/opportunities",
  "/connections",
  "/deal-room",
  "/verification",
  "/intelligent-matches",
  "/meu-network-inteligente",
];

/** O caminho da página é da área logada do site. */
export function ehAreaLogada(caminho: string): boolean {
  return AREA_LOGADA.some(raiz => caminho === raiz || caminho.startsWith(`${raiz}/`));
}

/**
 * O aviso "Abrir o app com Face ID ou digital?" cabe agora: a pessoa está na
 * área logada, o celular tem biometria ou bloqueio de tela cadastrado, a trava
 * está desligada e o aviso nunca foi respondido neste celular.
 */
export function avisoCabe(estado: { caminho: string; biometria: boolean; ligada: boolean; avisoRespondido: boolean }): boolean {
  return estado.biometria && !estado.ligada && !estado.avisoRespondido && ehAreaLogada(estado.caminho);
}

/** O texto que o sistema mostra no pedido do Face ID ou da digital, ao ligar e ao desligar. */
export const MOTIVO_PARA_LIGAR = "Ligar o Face ID ou a digital na WRW";
export const MOTIVO_PARA_DESLIGAR = "Desligar o Face ID ou a digital na WRW";

/**
 * Liga ou desliga a trava, sempre passando pela pessoa. Ao ligar, a conferência
 * prova que a biometria funciona neste celular. Ao desligar, prova que quem
 * desliga é a dona, e não alguém que pegou o celular com o app aberto (a trava
 * só volta depois de 10 minutos em segundo plano; revisão da #223). Sem o OK,
 * nada é gravado. Pedido igual ao estado atual não pede nada. Devolve se a
 * trava ficou ligada.
 */
export async function mudarATrava(
  pedido: { ligar: boolean; ligadaAgora: boolean },
  conferir: (motivo: string) => Promise<boolean>,
  gravar: (ligada: boolean) => Promise<void>,
): Promise<boolean> {
  if (pedido.ligar === pedido.ligadaAgora) return pedido.ligadaAgora;
  const ok = await conferir(pedido.ligar ? MOTIVO_PARA_LIGAR : MOTIVO_PARA_DESLIGAR);
  if (!ok) return pedido.ligadaAgora;
  await gravar(pedido.ligar);
  return pedido.ligar;
}

/** O que o site (o Perfil, dentro do app) pede ao app. */
export type PedidoDoSite = { tipo: "wrw:trava"; acao: "estado" | "ligar" | "desligar" };

/** Lê a mensagem do site; qualquer outra coisa é ignorada. */
export function lerPedidoDoSite(dado: unknown): PedidoDoSite | null {
  if (typeof dado !== "string" || dado.length > 200) return null;
  try {
    const objeto = JSON.parse(dado) as { tipo?: unknown; acao?: unknown };
    if (objeto?.tipo !== "wrw:trava") return null;
    if (objeto.acao !== "estado" && objeto.acao !== "ligar" && objeto.acao !== "desligar") return null;
    return { tipo: "wrw:trava", acao: objeto.acao };
  } catch {
    return null;
  }
}

/** O estado da trava que o app conta ao site. */
export type EstadoDaTrava = { disponivel: boolean; ligada: boolean };

/** O script que o app injeta na página para contar o estado ao site (o evento "wrw:trava"). */
export function scriptDoEstado(estado: EstadoDaTrava): string {
  const detalhe = JSON.stringify({ disponivel: Boolean(estado.disponivel), ligada: Boolean(estado.ligada) });
  return `window.dispatchEvent(new CustomEvent("wrw:trava", { detail: ${detalhe} })); true;`;
}
