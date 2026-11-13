import { useEffect, useSyncExternalStore } from "react";

/**
 * Sessão ocupada (PR S do gravador, docs/arquitetura/gravador-de-reunioes.md).
 * Até o envio, o áudio gravado só existe na memória desta aba: o Sair da conta
 * (components/SairDaConta.tsx) e fechar ou recarregar a aba o perderiam. Quem
 * grava ou envia abre uma ocupação aqui; com alguma aberta, o Sair pede
 * confirmação e o navegador pergunta antes de fechar a aba (no computador; no
 * iPhone, não: ver pedirConfirmacaoAoFechar). Sair da conta, ou excluí-la, solta
 * o que sobrou (liberarTodas).
 *
 * Não há teto de tempo: ele só existia por causa do corte por inatividade, que
 * saiu com a sessão de 90 dias desde o último uso (#179). Nada aqui adia a ida
 * ao login de uma sessão revogada, mas ela troca de página, e com a sessão
 * ocupada o navegador pergunta também nela (ver pedirConfirmacaoAoFechar).
 */

/** Do mais importante ao menos importante: o diálogo do Sair fala do primeiro que estiver aberto. */
export const MOTIVOS_DA_OCUPACAO = ["gravando", "enviando", "audio-nao-enviado"] as const;
export type MotivoDaOcupacao = (typeof MOTIVOS_DA_OCUPACAO)[number];

export type EstadoDaSessaoOcupada =
  | { ocupada: false; motivo: null }
  | { ocupada: true; motivo: MotivoDaOcupacao };

const LIVRE: EstadoDaSessaoOcupada = { ocupada: false, motivo: null };

// Cada ocupação aberta tem um número: duas do mesmo motivo (o ditado e a
// reunião, por exemplo) são liberadas uma de cada vez.
const abertas = new Map<number, MotivoDaOcupacao>();
const ouvintes = new Set<() => void>();
let ultimoNumero = 0;
// O MESMO objeto enquanto o motivo principal não muda: o useSyncExternalStore
// compara por referência e redesenharia a cada leitura com um objeto novo.
let atual: EstadoDaSessaoOcupada = LIVRE;

function recalcular() {
  const presentes = new Set(abertas.values());
  const motivo = MOTIVOS_DA_OCUPACAO.find(m => presentes.has(m)) ?? null;
  if (motivo === atual.motivo) return;
  atual = motivo ? { ocupada: true, motivo } : LIVRE;
  for (const ouvinte of Array.from(ouvintes)) ouvinte();
}

/** Abre uma ocupação e devolve a função que a libera. Liberar de novo não faz nada. */
export function ocupar(motivo: MotivoDaOcupacao): () => void {
  const numero = ++ultimoNumero;
  abertas.set(numero, motivo);
  recalcular();
  return () => {
    if (abertas.delete(numero)) recalcular();
  };
}

/**
 * Solta todas as ocupações abertas. Quem chama é o fim da sessão nesta aba: o
 * logout do useAuth (no diálogo do Sair a dona já aceitou perder o áudio) e a
 * exclusão da conta (components/ExcluirMinhaConta.tsx, que tem a confirmação
 * dela). O envio avulso que segue no ar não pode deixar a aba deslogada
 * ocupada, nem fazer o navegador perguntar no login seguinte (o Login troca de
 * página ao entrar). O liberar que vier depois não reabre nada. A guarda de que
 * todo fim da sessão no navegador chama esta função está em
 * components/SairDaConta.test.tsx.
 */
export function liberarTodas() {
  if (abertas.size === 0) return;
  abertas.clear();
  recalcular();
}

export function sessaoOcupada(): boolean {
  return atual.ocupada;
}

/** O motivo principal agora (gravando > enviando > audio-nao-enviado), ou null com a sessão livre. */
export function motivoDaOcupacao(): MotivoDaOcupacao | null {
  return atual.motivo;
}

function lerEstado(): EstadoDaSessaoOcupada {
  return atual;
}

function assinar(ouvinte: () => void) {
  ouvintes.add(ouvinte);
  return () => {
    ouvintes.delete(ouvinte);
  };
}

/** O estado da sessão ocupada, para a tela redesenhar quando ele muda. */
export function useSessaoOcupada(): EstadoDaSessaoOcupada {
  return useSyncExternalStore(assinar, lerEstado, lerEstado);
}

/**
 * Ocupa a sessão enquanto `ativo` for true; libera ao virar false e ao
 * desmontar. É efeito comum, e não de layout, de propósito: o Suspense que
 * esconde a página sem desmontá-la limpa só os efeitos de layout, e a gravação
 * escondida continua (o gravador também só para no desmonte).
 */
export function useOcupacao(motivo: MotivoDaOcupacao, ativo: boolean) {
  useEffect(() => (ativo ? ocupar(motivo) : undefined), [motivo, ativo]);
}

/**
 * Fechar ou recarregar a aba com a sessão ocupada perde o áudio: o navegador
 * pede confirmação. O ouvinte só existe enquanto ela está ocupada, para não
 * atrapalhar a saída de quem não tem nada a perder.
 *
 * O beforeunload não distingue fechar a aba de uma troca de página feita pelo
 * próprio app. Com a sessão ocupada, o navegador pergunta também em duas, e
 * ficar não dá no mesmo nelas:
 *
 * - Na ida ao login de uma sessão revogada: o location.href do main.tsx, que
 *   qualquer consulta "não autenticada" dispara (a do sino, a cada 30 s). Quem
 *   escolhe ficar mantém a aba e o áudio; o servidor recusa tudo até ela entrar
 *   de novo (noutra aba, o cookie novo vale nesta), e a próxima consulta que
 *   falhar pergunta outra vez. No ProtectedRoute, as ocupações presas à página
 *   saem no desmonte, antes do redirecionamento: só um envio em curso pergunta,
 *   e quem fica vê a tela vazia até recarregar. Para a ida ao login passar sem
 *   pergunta, ela teria de desligar este ouvinte antes de navegar.
 * - No recarregar automático depois de um deploy (o vite:preloadError do
 *   main.tsx). Ele vem quando a aba pede um pedaço do app que ainda não
 *   baixou, como na primeira ida a uma tela: o Suspense segura a tela de antes
 *   montada enquanto a nova carrega, e as ocupações dela continuam abertas.
 *   Ali, ficar NÃO salva o áudio: o main.tsx já cancelou o erro do Vite (o
 *   preventDefault no vite:preloadError), o helper de preload entrega
 *   undefined ao lazy da tela nova, e o ErrorBoundary do App troca o app
 *   inteiro, o Toaster junto, pela tela de erro. A tela de antes desmonta: a
 *   gravação e o áudio por enviar se perdem com qualquer resposta (a mesma
 *   ida, sem deploy, já os perdia), e só um envio já no ar segue até o fim,
 *   sem o aviso do resultado. Tirar essa pergunta exige mudar o main.tsx; só
 *   deixar de recarregar não basta, porque a tela pedida continua sem código.
 *
 * Conte com a pergunta só no computador: no iPhone e no iPad o WebKit não
 * dispara o beforeunload (webkit.org/b/219102), e no celular fechar o app pelo
 * seletor de apps também não pergunta. No iPhone, fechar ou recarregar perde o
 * áudio sem aviso, até a cópia no aparelho da G9.
 */
function pedirConfirmacaoAoFechar(evento: BeforeUnloadEvent) {
  evento.preventDefault();
  // Chrome e Edge antes da versão 119 só perguntavam com o returnValue preenchido.
  evento.returnValue = true;
}

let confirmacaoAoFecharLigada = false;
assinar(() => {
  if (typeof window === "undefined" || atual.ocupada === confirmacaoAoFecharLigada) return;
  confirmacaoAoFecharLigada = atual.ocupada;
  if (confirmacaoAoFecharLigada) window.addEventListener("beforeunload", pedirConfirmacaoAoFechar);
  else window.removeEventListener("beforeunload", pedirConfirmacaoAoFechar);
});
