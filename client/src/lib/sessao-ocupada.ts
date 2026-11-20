import { useEffect, useSyncExternalStore } from "react";
import { apagarTodasAsPartes } from "./partes-no-aparelho";

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
 *
 * O último motivo não guarda áudio (G13b): é a gravação descartada cuja
 * exclusão no servidor ainda não terminou (lib/descartes-pendentes.ts). O risco
 * de sair é o contrário do dos outros: com a aba fechada nada tenta de novo, e
 * a varredura de abandono do servidor transcreveria o que a dona descartou. A
 * lista dos descartes fica no localStorage e sobrevive ao Sair; o recarregar
 * depois de um deploy (lib/versao-nova.ts) espera a exclusão terminar, como
 * espera os outros motivos.
 */

/** Do mais importante ao menos importante: o diálogo do Sair fala do primeiro que estiver aberto. */
export const MOTIVOS_DA_OCUPACAO = ["gravando", "enviando", "audio-nao-enviado", "descarte-pendente"] as const;
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
  // A cópia das partes da gravação no aparelho (G9) é voz de quem participou:
  // o fim da sessão nesta aba (Sair, excluir a conta) a apaga, mesmo sem nada
  // ocupado agora.
  void apagarTodasAsPartes().catch(() => {});
  // Os descartes de gravação que não terminaram (lib/descartes-pendentes.ts)
  // ficam guardados: são só ids, por dona, e a retomada os repete no próximo
  // login da mesma conta. A ocupação deles sai com as outras; o diálogo do Sair
  // já avisou que a gravação descartada podia seguir para a transcrição (G13b).
  if (abertas.size === 0) return;
  abertas.clear();
  liberandoPeloFimDaSessao = true;
  try {
    recalcular();
  } finally {
    liberandoPeloFimDaSessao = false;
  }
}

let liberandoPeloFimDaSessao = false;

/**
 * True só durante o aviso aos ouvintes disparado pelo liberarTodas (o fim da
 * sessão nesta aba). O recarregamento adiado de lib/versao-nova.ts usa isto
 * para não atropelar a ida ao login nem a saída da exclusão da conta.
 */
export function desocupadaPeloFimDaSessao(): boolean {
  return liberandoPeloFimDaSessao;
}

export function sessaoOcupada(): boolean {
  return atual.ocupada;
}

/** O motivo principal agora (gravando > enviando > audio-nao-enviado > descarte-pendente), ou null com a sessão livre. */
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

/**
 * Chama `ouvinte` sempre que o motivo principal muda (inclusive ao desocupar)
 * e devolve a função que para de ouvir. Quem usa fora da tela é o
 * recarregamento adiado depois de um deploy (lib/versao-nova.ts).
 */
export function aoMudarAOcupacao(ouvinte: () => void): () => void {
  return assinar(ouvinte);
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
 * O recarregar automático depois de um deploy (o vite:preloadError do main.tsx)
 * não entra nesta lista: com a sessão ocupada ele não recarrega, avisa e espera
 * a sessão desocupar (lib/versao-nova.ts). O pedaço do app que falhou continua
 * sem código: se era a tela pedida, o ErrorBoundary do App troca o app inteiro
 * pela tela de erro, a tela de antes desmonta e as ocupações presas a ela saem
 * (a mesma ida, sem deploy, já perdia a gravação); o recarregar vem então sem
 * pergunta, ou depois de um envio que ainda estava no ar.
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
