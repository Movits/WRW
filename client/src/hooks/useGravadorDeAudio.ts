import { useEffect, useRef, useState } from "react";
import { abrirDetectorDePausa, type DetectorDePausa } from "@/lib/detector-de-pausa";
import { escolherMimeDeGravacao, tipoParaOServidor, type TipoDeAudioGravado } from "@/lib/formato-de-audio";
import { useOcupacao } from "@/lib/sessao-ocupada";

/**
 * O gravador de áudio das três telas que gravam: a reunião (pages/Meetings.tsx),
 * o ditado (components/BotaoDitarTexto.tsx) e a voz do contato
 * (components/NetworkInteligenteDoContato.tsx). Cada uma tinha o seu
 * MediaRecorder, e a reunião e a voz ainda pediam o webm/Opus que o Gemini
 * errava (#158).
 *
 * Abre o microfone, ou grava um MediaStream que vem de fora (o da aba de uma
 * reunião online, que continua de quem o abriu), escolhe o formato, conta o
 * tempo, para sozinho no limite e entrega o áudio em `aoTerminar`. Os avisos
 * ficam com quem chama, porque cada tela tem os seus textos.
 *
 * O microfone que cai (G17; HN-81 do HiNoter): na gravação em partes, com o
 * microfone que o hook abriu, a trilha que acaba no meio (o fone Bluetooth que
 * desligou, o microfone USB que saiu) não encerra mais a gravação. A parte em
 * curso fecha e sai como as outras, o estado vai a "semMicrofone" e o hook
 * tenta abrir um microfone de novo: na hora, a cada troca de aparelho
 * (devicechange) e a cada TENTATIVA_DO_MICROFONE_MS. Quando abre (o do próprio
 * aparelho, em geral, logo em seguida), a gravação segue numa parte nova. O
 * tempo sem microfone não é gravado e não conta no relógio, como a pausa; sem
 * microfone por ESPERA_PELO_MICROFONE_MAXIMA_MS, encerra e entrega. Fora das
 * partes (o ditado e a voz do contato; a reunião grava sempre em partes desde
 * a G14), a queda segue encerrando e entregando o que foi gravado: um arquivo
 * só não se emenda.
 */

export type EstadoDoGravador = "parado" | "pedindoMicrofone" | "gravando" | "pausado" | "semMicrofone" | "finalizando";

export type AudioGravado = {
  /** Só os pedaços desta gravação, com o tipo que o navegador gravou. */
  blob: Blob;
  /** O tipo que o servidor aceita. */
  mimeType: TipoDeAudioGravado;
  /** Do início ao fim, pelo relógio da página. Cada tela arredonda como o servidor dela confere. */
  duracaoMs: number;
};

export type OpcoesDoGravador = {
  limiteSegundos: number;
  bitsPorSegundo: number;
  /**
   * Como o microfone ouve (restricoesDoMicrofone): "voz" por padrão (o ditado e
   * a voz do contato); a gravação de reunião pede "reuniao", sem o
   * processamento que corta e faz chiar a voz que vem de longe no Android.
   */
  usoDoMicrofone?: UsoDoMicrofone;
  /**
   * Conferido quando o microfone chega: false solta o microfone, sem gravar nem
   * avisar. A reunião diz false quando a dona saiu do gravador com o pedido de
   * permissão ainda aberto.
   */
  podeGravar?: () => boolean;
  aoTerminar: (audio: AudioGravado) => void;
  /**
   * Gravação em partes (G9): a cada `fatiaSegundos` o gravador fecha a parte e
   * abre a seguinte no MESMO microfone, sem parar a gravação, e cada parte (um
   * arquivo válido por si) sai por `aoFecharParte`, a última com `ultima`. A
   * última também sai por `aoTerminar`, como antes.
   *
   * A emenda ainda deixa um buraco de dezenas de milissegundos. O gravador da
   * parte seguinte começa ANTES de o da atual parar, mas o stop() descarta o
   * fim que o codificador AAC ainda segurava. Medido só no Chrome, o buraco
   * ficou entre 10 e 58 ms, e num dos cenários as duas partes gravaram 153 ms
   * em comum. Por isso a troca espera uma pausa da fala, de uns 300 ms
   * (lib/detector-de-pausa.ts), por até ESPERA_PELA_PAUSA_MS depois de
   * `fatiaSegundos`: o buraco cai no silêncio, e a palavra não sai cortada
   * entre dois arquivos. Sem pausa, troca no fim dessa espera; sem como ouvir
   * (sem AudioContext, ou o contexto que não começa a rodar, como o suspenso
   * do iPhone), troca no tempo. Nesses casos, e com a aba em segundo plano
   * (ATRASO_MAXIMO_MS), o buraco pode cair no meio da fala. As partes saem
   * sempre na ordem da gravação.
   */
  fatiaSegundos?: number;
  aoFecharParte?: (parte: AudioGravado & { seq: number; ultima: boolean }) => void;
  /** Microfone negado, ausente ou ocupado, ou o gravador recusado. Não chega a quem já saiu da tela. */
  aoFalhar?: (erro: unknown) => void;
  /**
   * A gravação chegou a `limiteSegundos`, e o gravador já mandou parar (e
   * entregar, como sempre). Só para a tela avisar o porquê: a gravação em partes
   * diz que bateu nas 12 h (G13a). Chamado uma vez por gravação (G13b).
   */
  aoChegarAoLimite?: () => void;
  /**
   * Sair da tela (o desmonte) com a gravação em curso, gravando ou pausada. Sem
   * isto, o desmonte descarta: para, solta o microfone e não entrega nada (o
   * ditado e a voz do contato). Com isto, para e
   * entrega pelo mesmo caminho do Parar — a última parte sai por aoFecharParte e
   * por aoTerminar —, e `aoEntregarAoSair` avisa a tela. É a gravação em partes
   * (G13b): as partes anteriores já estão no servidor, e descartar perdia a
   * última e deixava a reunião "gravando" lá. A função é consultada na hora do
   * desmonte, e só com a gravação em curso: a tela diz ali se ainda entrega (no
   * Sair da conta, não).
   */
  entregarAoSair?: boolean | (() => boolean);
  /** O desmonte parou e entregou a gravação em curso (com `entregarAoSair`): só para a tela avisar. */
  aoEntregarAoSair?: () => void;
  /**
   * G17: o microfone caiu no meio da gravação em partes, e a gravação espera
   * outro ("semMicrofone"; na pausa, segue pausada até o Continuar). Só para a
   * tela avisar: o hook já fechou a parte e tenta abrir um microfone sozinho.
   */
  aoCairOMicrofone?: () => void;
  /** G17: um microfone abriu de novo, e a gravação seguiu numa parte nova. */
  aoVoltarOMicrofone?: () => void;
  /** G17: sem microfone por ESPERA_PELO_MICROFONE_MAXIMA_MS, a gravação encerrou e entregou o que gravou. */
  aoDesistirDoMicrofone?: () => void;
};

// Pedaços de 250 ms e o relógio a cada 500 ms, como os três faziam (a folga da
// duração medida no servidor, em server/meeting-service.ts, conta com os 500 ms).
const FATIA_MS = 250;
const RELOGIO_MS = 500;
/**
 * A pausa mais longa (G10): passou disso, a gravação encerra e entrega o que
 * gravou. Sem teto, uma pausa esquecida deixaria o microfone aceso e a sessão
 * ocupada (o Sair perguntando, o recarregar depois do deploy adiado) sem fim.
 */
export const PAUSA_MAXIMA_MS = 60 * 60 * 1000;
/**
 * Quanto a troca de parte espera por uma pausa da fala depois de
 * `fatiaSegundos`: sem pausa, a parte de 10 min fecha aos 620 s. O servidor
 * aceita parte de até 720 s (DURACAO_MAXIMA_DA_PARTE_SEGUNDOS, em
 * server/fatias-de-reuniao.ts), e a folga que sobra é a do tique atrasado da
 * aba em segundo plano.
 */
export const ESPERA_PELA_PAUSA_MS = 20_000;
/**
 * O detector de pausa abre um pouco antes da hora da troca, para o contexto de
 * áudio já estar rodando quando ela chegar. É também o prazo que o contexto
 * tem, desde a abertura, para começar a rodar: o Firefox o cria suspenso e só
 * o roda numa tarefa seguinte, como pede a especificação do Web Audio, e o
 * iPhone, sem um toque da dona, nunca. Dentro do prazo, o contexto que ainda
 * não roda não faz a troca sair no tempo: aberto já na hora ou depois dela (na
 * volta de uma pausa, no tique atrasado), ele cortaria a fala.
 */
export const PREPARO_DO_DETECTOR_MS = 2_000;
/** De quanto em quanto tempo o detector é consultado, da abertura à troca. */
export const ESCUTA_MS = 100;
/**
 * O tique que chega mais de 5 s depois do anterior é a aba em segundo plano,
 * com os timers espaçados pelo navegador (até um por minuto). Na hora da troca
 * ele troca na hora, como antes: esperar a pausa de tique em tique levaria a
 * parte para perto dos 720 s que o servidor aceita.
 */
export const ATRASO_MAXIMO_MS = 5_000;
/**
 * G17: sem microfone, de quanto em quanto tempo o hook tenta abrir um de novo,
 * além de cada troca de aparelho (devicechange, que nem todo navegador avisa).
 */
export const TENTATIVA_DO_MICROFONE_MS = 3_000;
/**
 * G17: a espera mais longa por um microfone, a mesma da pausa: passou dela, a
 * gravação encerra e entrega o que gravou, pelo mesmo motivo da pausa sem fim.
 */
export const ESPERA_PELO_MICROFONE_MAXIMA_MS = PAUSA_MAXIMA_MS;
/**
 * G17: a parte que fechou com a queda e gravou menos que isto não sai. Uma
 * parte sem áudio que se meça seria recusada pelo servidor, e a fila de lá só
 * transcreve uma parte depois da anterior: a posição que faltasse travaria a
 * transcrição das seguintes até o fim da gravação. A posição volta a ser livre
 * e vai para a parte que abre com o microfone que voltou.
 */
export const PARTE_MINIMA_DA_QUEDA_MS = 1_000;

/** O navegador pausa o MediaRecorder? (o Safari antigo não). */
export function pausaSuportada() {
  return typeof MediaRecorder !== "undefined" && typeof MediaRecorder.prototype?.pause === "function";
}

/** O fluxo tem alguma trilha de áudio viva? Sem como saber (sem trilhas, ou o navegador que não diz), sim. */
function fluxoVivo(fluxo: MediaStream | null | undefined) {
  const trilhas = fluxo?.getAudioTracks?.();
  return !trilhas?.length || trilhas.some(trilha => trilha.readyState !== "ended");
}

/** A trilha de áudio que o gravador grava ainda está viva? Sem como saber, sim. */
function microfoneVivo(gravador: MediaRecorder) {
  return fluxoVivo(gravador.stream);
}

/**
 * G17: há algum microfone na lista do navegador? Sem a lista (o navegador que
 * não a dá, ou a recusa), responde que sim, e o pedido do microfone decide. A
 * lista não pede permissão: sem microfone nenhum, o hook nem pede.
 */
async function haMicrofoneNaLista() {
  try {
    const lista = await navigator.mediaDevices?.enumerateDevices?.();
    return !Array.isArray(lista) || lista.some(aparelho => aparelho.kind === "audioinput");
  } catch {
    return true;
  }
}

/**
 * O que o site pede ao microfone. Há dois jeitos de ouvir:
 *
 * - "voz" (o ditado e a voz do contato): uma pessoa perto do aparelho, falando
 *   para ele. O cancelamento de eco, a redução de ruído e o ganho automático
 *   ajudam: tiram o barulho de fundo e igualam o volume de quem fala baixo.
 * - "reuniao" (o gravador de reunião): a sala inteira, gente longe do
 *   aparelho, às vezes uma chamada tocando no alto-falante de outro aparelho.
 *   No teste T51 (24/11, Moto g82 5G, Chrome e o APK da casca), com os três
 *   ligados o áudio saiu cortando e chiando o tempo todo, e o gravador do
 *   próprio celular gravou o mesmo som limpo. No Android, pedir o cancelamento
 *   de eco leva o Chrome a abrir o microfone no modo de chamada de voz, com o
 *   processamento do telefone: ele trata a voz que vem de longe, ou do
 *   alto-falante de outro aparelho, como eco ou ruído e a corta aos pedaços; e o
 *   ganho automático sobe o chiado de fundo nos silêncios. A gravação de
 *   reunião pede os três desligados, como o gravador nativo, e deixa a voz
 *   para a transcrição, que lida bem com volume baixo e ruído. Pede ainda um
 *   canal só (a fala não ganha nada em estéreo, e o arquivo fica menor) e NÃO
 *   pede taxa de amostragem: forçar uma taxa que o aparelho não tem faz o
 *   navegador reamostrar o áudio, e é mais um lugar para chiar.
 *
 * Tudo como "ideal", nunca "exact": o navegador que não sabe desligar um deles
 * grava assim mesmo, em vez de recusar o microfone.
 */
export type UsoDoMicrofone = "voz" | "reuniao";
export function restricoesDoMicrofone(uso: UsoDoMicrofone): MediaStreamConstraints {
  if (uso === "reuniao") {
    return {
      audio: { echoCancellation: { ideal: false }, noiseSuppression: { ideal: false }, autoGainControl: { ideal: false }, channelCount: { ideal: 1 } },
      video: false,
    };
  }
  return {
    audio: { echoCancellation: { ideal: true }, noiseSuppression: { ideal: true }, autoGainControl: { ideal: true } },
    video: false,
  };
}

/** O navegador grava? Com um MediaStream de fora, só o MediaRecorder importa. */
export function gravacaoDeAudioSuportada(comMicrofone = true) {
  if (typeof MediaRecorder === "undefined") return false;
  return !comMicrofone || (typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function");
}

function pararTrilhas(fluxo: MediaStream | null) {
  fluxo?.getTracks().forEach(trilha => trilha.stop());
}

/** Uma parte da gravação: o MediaRecorder dela e o tempo que ela conta. Sem partes, a gravação inteira é a parte 0. */
type Parte = {
  seq: number;
  gravador: MediaRecorder;
  comecouEm: number;
  /** O tempo pausado DESTA parte: a duração dela o desconta. */
  pausado: number;
  /** Quando o hook mandou parar (a troca ou o fim); 0 até lá, e no fim que o navegador deu por conta própria. */
  paradaEm: number;
  /** O stop foi a troca para a parte seguinte: esta não é a última. */
  trocada: boolean;
  /**
   * A troca sem o segundo gravador (o navegador recusou o da parte seguinte com
   * o desta ainda gravando): a seguinte abre quando esta terminar de fechar o
   * arquivo, como antes da emenda, com o intervalo de antes.
   */
  reabrir: boolean;
  /** O Parar chegou no meio dessa troca: esta é a última, e a seguinte não abre. */
  encerrar: boolean;
  /**
   * G17: a parte fechou porque o microfone caiu. Não é a última, não abre a
   * seguinte (a seguinte abre quando um microfone voltar) e só sai se gravou
   * PARTE_MINIMA_DA_QUEDA_MS.
   */
  caiu: boolean;
};

export function useGravadorDeAudio(opcoes: OpcoesDoGravador) {
  const [estado, setEstado] = useState<EstadoDoGravador>("parado");
  const [segundos, setSegundos] = useState(0);
  // As opções da última renderização: o fim chega minutos depois do começo, e
  // quem chama espera o idioma e o estado de agora, não os da hora do clique.
  const atuais = useRef(opcoes);
  atuais.current = opcoes;
  // O estado já na hora do clique. O da tela só muda na próxima renderização, e
  // o segundo clique de um duplo clique abria um segundo MediaRecorder e deixava
  // o primeiro com o microfone aceso.
  const estadoAgora = useRef<EstadoDoGravador>("parado");
  // A parte que grava agora (a última aberta). Logo depois de uma troca, a
  // anterior ainda fecha o arquivo: os gravadores que não entregaram o fim
  // ficam em `vivos`, para o Descartar calar todos.
  const parte = useRef<Parte | null>(null);
  const vivos = useRef(new Set<MediaRecorder>());
  // Abre a parte seguinte no fluxo da gravação em curso (lança se o navegador
  // recusar o gravador), e o fluxo, que o detector de pausa ouve.
  // Desde a G17, a parte pode abrir em outro fluxo: o microfone que voltou.
  const abrirParte = useRef<((seq: number, fluxo?: MediaStream) => Parte) | null>(null);
  const fluxoGravado = useRef<MediaStream | null>(null);
  // O mesmo fluxo, para a tela: a bolha da voz (components/BolhaDaVoz.tsx) ouve
  // o que está sendo gravado, e reabre o medidor quando o microfone volta (G17).
  // Muda sempre junto com o fluxoGravado, por trocarFluxoGravado.
  const [fluxoAoVivo, setFluxoAoVivo] = useState<MediaStream | null>(null);
  function trocarFluxoGravado(novo: MediaStream | null) {
    fluxoGravado.current = novo;
    setFluxoAoVivo(novo);
  }
  // Só o microfone que o hook abriu: o MediaStream de fora é de quem o entregou.
  const microfone = useRef<MediaStream | null>(null);
  const inicio = useRef(0);
  // A pausa (G10): quando a atual começou (0 sem pausa) e o tempo pausado da
  // gravação inteira; o da parte fica na parte. O áudio pausado não existe no
  // arquivo: a duração entregue, o relógio e a troca de parte descontam a pausa.
  const pausaComecou = useRef(0);
  const pausadoNaGravacao = useRef(0);
  // Cada pedido de microfone leva um número. Sair da tela ou descartar troca o
  // número, e o microfone que o navegador entregar depois, para um pedido
  // velho, é solto na hora.
  const pedidoAtual = useRef(0);
  // O aviso do limite (aoChegarAoLimite) já saiu nesta gravação. Se o parar()
  // sair cedo sem trocar de estado (o MediaRecorder que o navegador já deu como
  // inativo), o relógio segue batendo no limite a cada volta, e o aviso se
  // repetiria a cada 500 ms (G13b).
  const limiteAvisado = useRef(false);
  // O detector de pausa da troca de parte: undefined enquanto não abriu nesta
  // parte, null sem como ouvir, e quando abriu (o prazo do contexto para
  // começar a rodar conta daí). A escuta é o relógio que o consulta, e a última
  // conferência mede o atraso do tique.
  const detector = useRef<DetectorDePausa | null | undefined>(undefined);
  const detectorAbertoEm = useRef(0);
  const escuta = useRef(0);
  const ultimaConferencia = useRef(0);
  // G17, o microfone que cai. A posição da próxima parte (a que abre com o
  // microfone que voltou fica com a da parte que caiu, se ela não saiu); a
  // parte que caiu enquanto ainda fecha o arquivo; o microfone que voltou
  // antes de ela fechar, esperando a vez; o Encerrar que chegou nesse meio;
  // quando a espera começou (0 sem espera); o pedido de microfone em curso; e
  // se o navegador recusou o microfone (aí só o toque da dona tenta de novo:
  // tentar sozinho abriria o pedido de permissão em laço).
  const seqDaProxima = useRef(0);
  const parteQueCaiu = useRef<Parte | null>(null);
  const fluxoQueVoltou = useRef<MediaStream | null>(null);
  const encerrarDepoisDaQueda = useRef(false);
  const semMicrofoneDesde = useRef(0);
  const reabrindo = useRef(false);
  const bloqueado = useRef(false);
  const [microfoneBloqueado, setMicrofoneBloqueado] = useState(false);
  // Entrega a última parte, vazia, na posição dada: o fim da gravação que
  // acaba sem parte gravando (o Encerrar sem microfone). Da gravação em curso.
  const fecharSemParte = useRef<((seq: number) => void) | null>(null);
  // Tira os ouvintes de "ended" das trilhas do microfone em uso.
  const soltarOuvintes = useRef<(() => void) | null>(null);
  // A gravação em curso usa o microfone que o hook abriu (e não um fluxo de
  // fora): só ela pode esperar outro microfone quando ele cai.
  const microfoneDoHook = useRef(false);

  function mudarEstado(novo: EstadoDoGravador) {
    estadoAgora.current = novo;
    setEstado(novo);
  }

  // Do pedido do microfone ao fim do arquivo, o áudio só existe nesta aba: a
  // sessão fica ocupada (lib/sessao-ocupada.ts), e o Sair e o fechar da aba pedem
  // confirmação. O fim do arquivo, descartar, a falha e sair da tela liberam.
  useOcupacao("gravando", estado !== "parado");

  /** Fecha a pausa em curso, somando-a ao tempo pausado da gravação e da parte. */
  function fecharPausa() {
    if (!pausaComecou.current) return;
    const pausa = Date.now() - pausaComecou.current;
    pausaComecou.current = 0;
    pausadoNaGravacao.current += pausa;
    if (parte.current) parte.current.pausado += pausa;
  }

  /** Pausa a gravação (G10): o microfone segue aberto, nada é gravado. */
  function pausar() {
    const atual = parte.current?.gravador;
    if (atual?.state !== "recording" || typeof atual.pause !== "function") return;
    atual.pause();
    pausaComecou.current = Date.now();
    mudarEstado("pausado");
  }

  function continuar() {
    if (estadoAgora.current !== "pausado") return;
    const atual = parte.current;
    // G17: a parte fechou na pausa porque o microfone caiu. O Continuar abre um
    // microfone de novo, com o pedido ainda dentro do toque, e a gravação segue
    // numa parte nova.
    if (!atual) return podeEsperarOMicrofone() ? esperarOMicrofone(true) : parar();
    if (atual.gravador.state !== "paused") return;
    // No iPhone, bloquear a tela durante a pausa encerra a trilha do microfone:
    // retomar gravaria silêncio. Encerra e entrega o que já foi gravado. Em
    // partes, com o microfone que o hook abriu (G17), a parte fecha como na
    // queda, e o microfone abre de novo.
    if (!microfoneVivo(atual.gravador) || !fluxoVivo(microfone.current)) {
      if (!podeEsperarOMicrofone()) return parar();
      ficarSemMicrofone(atual);
      return esperarOMicrofone(true);
    }
    fecharPausa();
    atual.gravador.resume();
    mudarEstado("gravando");
  }

  function parar() {
    // G17: sem parte gravando (a espera por um microfone, ou a pausa em que ele
    // caiu), o fim sai pela parte vazia.
    if (estadoAgora.current === "semMicrofone" || (estadoAgora.current === "pausado" && !parte.current)) return encerrarSemParte();
    const atual = parte.current;
    // No meio da troca sem o segundo gravador (ver `reabrir`): a parte já parou,
    // e o fim do arquivo dela ainda vem. O Parar vale como o fim da gravação, e
    // a parte seguinte não abre.
    if (atual?.reabrir && atual.gravador.state === "inactive") {
      atual.encerrar = true;
      mudarEstado("finalizando");
      return;
    }
    if (atual?.gravador.state !== "recording" && atual?.gravador.state !== "paused") return;
    fecharPausa();
    mudarEstado("finalizando");
    // A parte anterior que ainda fecha o arquivo (o Parar logo depois de uma
    // troca) sai antes desta, que é a última.
    atual.paradaEm = Date.now();
    atual.gravador.stop();
  }

  /** Fecha o detector de pausa e a escuta dele. */
  function pararDeOuvir() {
    window.clearInterval(escuta.current);
    escuta.current = 0;
    detector.current?.fechar();
    detector.current = undefined;
  }

  /**
   * G17: a gravação em curso pode esperar outro microfone? Só em partes (um
   * arquivo só não se emenda) e com o microfone que o hook abriu (o fluxo de
   * fora é de quem o entregou, e só ele o abre de novo).
   */
  function podeEsperarOMicrofone() {
    return Boolean(atuais.current.fatiaSegundos) && microfoneDoHook.current;
  }

  /** Solta o microfone em uso: os ouvintes, as trilhas e o fluxo que as partes gravam. */
  function soltarOMicrofone() {
    soltarOuvintes.current?.();
    soltarOuvintes.current = null;
    pararTrilhas(microfone.current);
    microfone.current = null;
    trocarFluxoGravado(null);
  }

  /** G17: zera a espera pelo microfone (no começo, no fim e no descarte da gravação). */
  function limparEsperaDoMicrofone() {
    semMicrofoneDesde.current = 0;
    parteQueCaiu.current = null;
    pararTrilhas(fluxoQueVoltou.current);
    fluxoQueVoltou.current = null;
    encerrarDepoisDaQueda.current = false;
    bloqueado.current = false;
    setMicrofoneBloqueado(false);
  }

  /**
   * G17: ouve o "ended" das trilhas do microfone (o aparelho que saiu, a
   * permissão revogada). A trilha que o próprio hook para não dispara o evento.
   */
  function vigiarATrilha(fluxo: MediaStream) {
    soltarOuvintes.current?.();
    const trilhas = fluxo.getAudioTracks?.() ?? [];
    const aoAcabar = () => aoCairATrilha(fluxo);
    for (const trilha of trilhas) trilha.addEventListener?.("ended", aoAcabar);
    soltarOuvintes.current = () => {
      for (const trilha of trilhas) trilha.removeEventListener?.("ended", aoAcabar);
    };
  }

  /** G17: a trilha do microfone em uso acabou. Gravando ou pausada, em partes, a gravação passa a esperar outro microfone. */
  function aoCairATrilha(fluxo: MediaStream) {
    if (fluxo !== microfone.current || fluxoVivo(fluxo)) return;
    const agora = estadoAgora.current;
    if ((agora !== "gravando" && agora !== "pausado") || !podeEsperarOMicrofone()) return;
    ficarSemMicrofone(parte.current);
  }

  /**
   * G17: o microfone caiu. A parte em curso fecha como uma parte comum (não a
   * última) e o microfone que caiu é solto. Gravando, a gravação passa a
   * esperar outro ("semMicrofone"), com o relógio parado como na pausa;
   * pausada, segue pausada e sem parte, e o Continuar abre o microfone de novo.
   */
  function ficarSemMicrofone(atual: Parte | null) {
    const agora = Date.now();
    const gravando = estadoAgora.current === "gravando";
    pararDeOuvir();
    if (gravando) {
      // O tempo sem microfone não é gravado: conta como pausa, e o relógio para.
      pausaComecou.current = agora;
      semMicrofoneDesde.current = agora;
      mudarEstado("semMicrofone");
    }
    if (parte.current === atual) parte.current = null;
    if (atual && !atual.caiu) {
      // Na pausa, o tempo pausado até agora é desta parte; o da gravação segue
      // contando e entra no relógio quando a espera acabar.
      if (!gravando && pausaComecou.current) atual.pausado += agora - pausaComecou.current;
      atual.caiu = true;
      atual.trocada = true;
      if (!atual.paradaEm) atual.paradaEm = agora;
      parteQueCaiu.current = atual;
      // O fim do arquivo (o onstop) entrega a parte. O gravador que o
      // navegador já parou sozinho entrega o fim que estava por vir.
      if (atual.gravador.state !== "inactive") atual.gravador.stop();
    }
    soltarOMicrofone();
    atuais.current.aoCairOMicrofone?.();
  }

  /**
   * G17: começa a espera por um microfone a partir da pausa (o Continuar
   * depois de ele cair): a pausa da dona acaba, e a espera conta como pausa no
   * relógio. Com `porToque`, o pedido sai já, dentro do toque.
   */
  function esperarOMicrofone(porToque: boolean) {
    fecharPausa();
    const agora = Date.now();
    pausaComecou.current = agora;
    semMicrofoneDesde.current = agora;
    mudarEstado("semMicrofone");
    void pedirOMicrofone(porToque);
  }

  /**
   * G17: pede um microfone para a gravação que espera. Sem nenhum na lista do
   * navegador, nem pede; depois de uma recusa de permissão, só o toque da dona
   * pede de novo. O microfone que chega depois de a espera acabar (o Encerrar,
   * o Descartar, a saída da tela) é solto na hora.
   */
  async function pedirOMicrofone(porToque = false) {
    if (estadoAgora.current !== "semMicrofone" || reabrindo.current) return;
    if (!porToque && bloqueado.current) return;
    const pedido = pedidoAtual.current;
    const vigente = () => pedido === pedidoAtual.current && estadoAgora.current === "semMicrofone";
    reabrindo.current = true;
    let novo: MediaStream | null = null;
    try {
      // O toque pede direto: esperar a lista antes tiraria o pedido de dentro dele.
      if (!porToque && !(await haMicrofoneNaLista())) return;
      if (!vigente()) return;
      novo = await navigator.mediaDevices.getUserMedia(restricoesDoMicrofone(atuais.current.usoDoMicrofone ?? "voz"));
      if (!vigente() || !fluxoVivo(novo)) {
        pararTrilhas(novo);
        return;
      }
      bloqueado.current = false;
      setMicrofoneBloqueado(false);
      seguirComOMicrofone(novo);
    } catch (erro) {
      pararTrilhas(novo);
      const nome = (erro as { name?: string } | null)?.name;
      if (nome === "NotAllowedError" || nome === "SecurityError") {
        bloqueado.current = true;
        setMicrofoneBloqueado(true);
      }
    } finally {
      reabrindo.current = false;
    }
  }

  /**
   * G17: segue a gravação com o microfone que voltou, numa parte nova. Se a
   * parte que caiu ainda fecha o arquivo, o microfone espera por ela: a
   * posição da parte nova depende de a que caiu sair ou não.
   */
  function seguirComOMicrofone(novo: MediaStream) {
    const abrir = abrirParte.current;
    if (!abrir || estadoAgora.current !== "semMicrofone") return pararTrilhas(novo);
    if (parteQueCaiu.current) {
      pararTrilhas(fluxoQueVoltou.current);
      fluxoQueVoltou.current = novo;
      return;
    }
    let nova: Parte;
    try {
      nova = abrir(seqDaProxima.current, novo);
    } catch {
      // O navegador recusou o gravador no microfone novo: solta e segue esperando.
      pararTrilhas(novo);
      return;
    }
    microfone.current = novo;
    trocarFluxoGravado(novo);
    // A espera entra no relógio antes de a parte nova valer: ela não é desta parte.
    fecharPausa();
    parte.current = nova;
    semMicrofoneDesde.current = 0;
    vigiarATrilha(novo);
    mudarEstado("gravando");
    atuais.current.aoVoltarOMicrofone?.();
  }

  /** G17: a parte que caiu terminou de fechar o arquivo: sai o fim pedido nesse meio, ou segue o microfone que voltou. */
  function depoisDaQueda() {
    if (encerrarDepoisDaQueda.current) {
      encerrarDepoisDaQueda.current = false;
      fecharSemParte.current?.(seqDaProxima.current);
      return;
    }
    const voltou = fluxoQueVoltou.current;
    fluxoQueVoltou.current = null;
    if (voltou) seguirComOMicrofone(voltou);
  }

  /**
   * G17: o fim da gravação sem parte gravando: a última parte sai vazia, na
   * próxima posição, e o servidor conta só as partes que têm áudio
   * (useGravacaoEmPartes). Com a parte que caiu ainda fechando, o fim espera
   * por ela.
   */
  function encerrarSemParte() {
    fecharPausa();
    semMicrofoneDesde.current = 0;
    pararTrilhas(fluxoQueVoltou.current);
    fluxoQueVoltou.current = null;
    mudarEstado("finalizando");
    if (parteQueCaiu.current) {
      encerrarDepoisDaQueda.current = true;
      return;
    }
    fecharSemParte.current?.(seqDaProxima.current);
  }

  /**
   * A troca de parte: abre o gravador da parte seguinte no mesmo fluxo e só
   * então para o da atual. Mesmo assim fica entre as duas um buraco de dezenas
   * de milissegundos, o fim que o codificador segurava e o stop() descarta (ver
   * `fatiaSegundos`), e por isso conferirATroca espera a pausa da fala. A atual
   * entrega o arquivo quando o navegador termina de fechá-lo, já com a seguinte
   * gravando.
   */
  function trocarDeParte() {
    pararDeOuvir();
    const velha = parte.current;
    const abrir = abrirParte.current;
    if (!velha || !abrir || estadoAgora.current !== "gravando" || velha.gravador.state !== "recording") return;
    let nova: Parte;
    try {
      nova = abrir(velha.seq + 1);
    } catch {
      // O navegador recusou o gravador da parte seguinte com o desta ainda
      // gravando: troca como antes da emenda, abrindo a seguinte quando esta
      // terminar de fechar o arquivo (com o intervalo de antes), em vez de
      // encerrar a gravação. Recusado de novo (a trilha do microfone que acabou
      // de cair, por exemplo), esta é a última parte.
      velha.reabrir = true;
      velha.trocada = true;
      velha.paradaEm = Date.now();
      velha.gravador.stop();
      return;
    }
    parte.current = nova;
    velha.trocada = true;
    velha.paradaEm = Date.now();
    velha.gravador.stop();
  }

  /**
   * Confere se é hora de trocar de parte: no tique do relógio (a cada 500 ms)
   * e, com o detector aberto, na escuta (a cada 100 ms). O detector abre
   * PREPARO_DO_DETECTOR_MS antes de `fatiaSegundos` de parte (sem as pausas). A
   * partir daí a troca sai no primeiro trecho calmo; sem um, ao fim de
   * ESPERA_PELA_PAUSA_MS; com o tique muito atrasado (a aba em segundo plano),
   * na hora; sem como ouvir, na hora também, mas o contexto que ainda não roda
   * só conta como sem como ouvir PREPARO_DO_DETECTOR_MS depois de aberto.
   */
  function conferirATroca() {
    const agora = Date.now();
    const atraso = agora - ultimaConferencia.current;
    ultimaConferencia.current = agora;
    const fatia = atuais.current.fatiaSegundos;
    const atual = parte.current;
    if (!fatia || !atual || estadoAgora.current !== "gravando" || atual.gravador.state !== "recording") return;
    const hora = fatia * 1000;
    const tempo = agora - atual.comecouEm - atual.pausado;
    if (tempo < hora - PREPARO_DO_DETECTOR_MS) return;
    if (tempo >= hora && (tempo >= hora + ESPERA_PELA_PAUSA_MS || atraso > ATRASO_MAXIMO_MS)) return trocarDeParte();
    if (detector.current === undefined && fluxoGravado.current) {
      detector.current = abrirDetectorDePausa(fluxoGravado.current);
      detectorAbertoEm.current = agora;
      if (detector.current) escuta.current = window.setInterval(conferirATroca, ESCUTA_MS);
    }
    if (tempo < hora) return;
    const ouvido = detector.current;
    if (!ouvido) return trocarDeParte();
    if (ouvido.ouvindo()) {
      if (ouvido.calmo()) trocarDeParte();
      return;
    }
    // Não roda: o contexto recém-aberto (a volta de uma pausa, o tique que já
    // caiu depois da hora) ainda pode começar, e a troca espera; passado o
    // prazo, troca no tempo, como sem detector.
    if (agora - detectorAbertoEm.current >= PREPARO_DO_DETECTOR_MS) trocarDeParte();
  }

  /** Para sem entregar nada e solta o microfone. */
  function descartar() {
    pedidoAtual.current++;
    pararDeOuvir();
    pausaComecou.current = 0;
    pausadoNaGravacao.current = 0;
    // A parte atual e a anterior que ainda fecha o arquivo (o Descartar logo
    // depois de uma troca): nenhuma entrega nada.
    const gravadores = Array.from(vivos.current);
    vivos.current.clear();
    parte.current = null;
    abrirParte.current = null;
    fecharSemParte.current = null;
    for (const atual of gravadores) {
      atual.onstop = null;
      if (atual.state !== "inactive") atual.stop();
    }
    soltarOMicrofone();
    // A espera por um microfone (G17) acaba junto: o pedido em curso, que
    // mudou de número, solta o microfone que chegar.
    limparEsperaDoMicrofone();
    reabrindo.current = false;
    mudarEstado("parado");
    setSegundos(0);
  }

  /** Começa a gravar; com `fluxoDeFora`, grava ele em vez de abrir o microfone. Devolve se começou. */
  async function comecar(fluxoDeFora?: MediaStream): Promise<boolean> {
    if (estadoAgora.current !== "parado" || !gravacaoDeAudioSuportada(!fluxoDeFora)) return false;
    const pedido = ++pedidoAtual.current;
    const vigente = () => pedido === pedidoAtual.current;
    mudarEstado("pedindoMicrofone");
    let aberto: MediaStream | null = null;
    try {
      const fluxo = fluxoDeFora ?? (aberto = await navigator.mediaDevices.getUserMedia(restricoesDoMicrofone(atuais.current.usoDoMicrofone ?? "voz")));
      // Saiu da tela, ou do gravador, enquanto o navegador pedia o microfone: solta e não grava.
      if (!vigente() || !(atuais.current.podeGravar?.() ?? true)) {
        pararTrilhas(aberto);
        if (vigente()) mudarEstado("parado");
        return false;
      }
      const mimeType = escolherMimeDeGravacao(tipo => MediaRecorder.isTypeSupported(tipo));
      const audioBitsPerSecond = atuais.current.bitsPorSegundo;
      const comecouEm = Date.now();
      // As partes que já fecharam e esperam a vez: saem na ordem da gravação,
      // mesmo que o navegador entregue o fim de uma parte antes do da anterior
      // (as duas fecham juntas quando o Parar vem logo depois de uma troca).
      const prontas = new Map<number, { audio: AudioGravado; ultima: boolean }>();
      let proxima = 0;
      const entregar = () => {
        for (let pronta = prontas.get(proxima); pronta; pronta = prontas.get(proxima)) {
          prontas.delete(proxima);
          const seq = proxima++;
          if (!pronta.ultima) {
            atuais.current.aoFecharParte?.({ ...pronta.audio, seq, ultima: false });
            continue;
          }
          pararDeOuvir();
          // O microfone em uso: o que abriu no começo ou o que voltou depois
          // de uma queda (G17). O fluxo de fora não entra aqui: é de quem o entregou.
          soltarOuvintes.current?.();
          soltarOuvintes.current = null;
          pararTrilhas(microfone.current);
          microfone.current = null;
          limparEsperaDoMicrofone();
          // A última parte vazia do Encerrar sem microfone (G17) chega sem parte gravando.
          if (!parte.current || parte.current.seq === seq) {
            parte.current = null;
            abrirParte.current = null;
            trocarFluxoGravado(null);
          }
          mudarEstado("parado");
          setSegundos(0);
          atuais.current.aoFecharParte?.({ ...pronta.audio, seq, ultima: true });
          // Fora do modo em partes, a duração é a da gravação inteira, como antes.
          atuais.current.aoTerminar(atuais.current.fatiaSegundos ? pronta.audio : { ...pronta.audio, duracaoMs: Date.now() - comecouEm - pausadoNaGravacao.current });
          return;
        }
      };
      // Uma parte: um MediaRecorder novo no mesmo fluxo, com os pedaços SÓ dela
      // (nenhum gravador empurra para a lista de outro). Na gravação de uma
      // parte só (o ditado, a voz), é o gravador de sempre.
      // Desde a G17, no fluxo dado: o da gravação em curso por padrão, ou o
      // microfone que voltou depois de uma queda.
      const abrir = (seq: number, fluxoDaParte: MediaStream = fluxoGravado.current ?? fluxo): Parte => {
        const novo = mimeType ? new MediaRecorder(fluxoDaParte, { mimeType, audioBitsPerSecond }) : new MediaRecorder(fluxoDaParte, { audioBitsPerSecond });
        const pedacos: Blob[] = [];
        const nova: Parte = { seq, gravador: novo, comecouEm: Date.now(), pausado: 0, paradaEm: 0, trocada: false, reabrir: false, encerrar: false, caiu: false };
        novo.ondataavailable = evento => { if (evento.data.size) pedacos.push(evento.data); };
        novo.onstop = () => {
          vivos.current.delete(novo);
          if (!vigente()) return;
          const blob = new Blob(pedacos, { type: novo.mimeType || "audio/webm" });
          // G17: o navegador parou o gravador sozinho (o fim que o hook não
          // pediu) com a trilha do microfone morta: é a queda do microfone, e
          // não o fim da gravação. O "ended" da trilha pode chegar depois.
          const emCurso = estadoAgora.current === "gravando" || estadoAgora.current === "pausado";
          if (!nova.trocada && !nova.paradaEm && nova === parte.current && emCurso && podeEsperarOMicrofone()
            && fluxoDaParte === microfone.current && !fluxoVivo(fluxoDaParte)) ficarSemMicrofone(nova);
          // A parte termina quando o hook mandou parar, e não quando o navegador
          // acaba de fechar o arquivo: a seguinte já gravava desde a troca.
          const duracaoMs = (nova.paradaEm || Date.now()) - nova.comecouEm - nova.pausado;
          // G17: a parte que caiu sai como as outras, se gravou o bastante; se
          // não, a posição dela fica para a parte do microfone que voltar.
          if (nova.caiu) {
            if (parteQueCaiu.current === nova) parteQueCaiu.current = null;
            if (blob.size > 0 && duracaoMs >= PARTE_MINIMA_DA_QUEDA_MS) {
              prontas.set(seq, { audio: { blob, mimeType: tipoParaOServidor(blob.type), duracaoMs }, ultima: false });
              seqDaProxima.current = seq + 1;
            } else seqDaProxima.current = seq;
            entregar();
            depoisDaQueda();
            return;
          }
          // O fim que não veio de uma troca (o Parar, o limite ou o navegador
          // que parou sozinho) é o da gravação.
          let ultima = !nova.trocada;
          // A troca sem o segundo gravador: a seguinte só abre agora. O Parar que
          // chegou no meio, ou o gravador recusado de novo, fazem desta a última.
          if (nova.reabrir && !ultima) {
            if (nova.encerrar) ultima = true;
            else {
              try {
                parte.current = abrir(seq + 1);
              } catch {
                ultima = true;
              }
            }
          }
          prontas.set(seq, { audio: { blob, mimeType: tipoParaOServidor(blob.type), duracaoMs }, ultima });
          entregar();
        };
        novo.start(FATIA_MS);
        vivos.current.add(novo);
        seqDaProxima.current = seq + 1;
        return nova;
      };
      pausaComecou.current = 0;
      pausadoNaGravacao.current = 0;
      limiteAvisado.current = false;
      limparEsperaDoMicrofone();
      seqDaProxima.current = 0;
      microfoneDoHook.current = aberto !== null;
      parte.current = abrir(0, fluxo);
      abrirParte.current = abrir;
      trocarFluxoGravado(fluxo);
      microfone.current = aberto;
      // G17: a trilha do microfone que cai avisa (só a do microfone que o hook abriu).
      if (aberto) vigiarATrilha(aberto);
      // O fim sem parte gravando (o Encerrar sem microfone, G17): a última
      // parte sai vazia, pelo mesmo caminho das outras.
      fecharSemParte.current = seqDoFim => {
        const tipo = mimeType || "audio/webm";
        prontas.set(seqDoFim, { audio: { blob: new Blob([], { type: tipo }), mimeType: tipoParaOServidor(tipo), duracaoMs: 0 }, ultima: true });
        entregar();
      };
      inicio.current = comecouEm;
      setSegundos(0);
      mudarEstado("gravando");
      return true;
    } catch (erro) {
      pararTrilhas(aberto);
      if (!vigente()) return false;
      mudarEstado("parado");
      // Quem saiu do gravador não recebe aviso, nem fica com o problema guardado para a volta.
      if (atuais.current.podeGravar?.() ?? true) atuais.current.aoFalhar?.(erro);
      return false;
    }
  }

  // Saiu da tela gravando, ou com o pedido do microfone aberto: para o gravador e
  // o microfone e não entrega nada. Com entregarAoSair (a gravação em partes,
  // G13b), a gravação em curso para e entrega como no Parar: o fim do arquivo
  // chega depois do desmonte (o onstop do MediaRecorder, que também solta o
  // microfone), e quem recebe a última parte não depende da tela. O pedido do
  // microfone ainda aberto é descartado nos dois casos: nada foi gravado. No
  // StrictMode, que monta, desmonta e monta de novo, isto roda sem nada gravando.
  useEffect(() => () => {
    const agora = estadoAgora.current;
    const emCurso = agora === "gravando" || agora === "pausado" || agora === "semMicrofone" || agora === "finalizando";
    const entregar = atuais.current.entregarAoSair;
    if (emCurso && (typeof entregar === "function" ? entregar() : entregar)) {
      // O Parar já pedido (o Encerrar logo antes de sair): o fim que o
      // MediaRecorder ainda vai entregar sai como a última parte.
      if (agora === "finalizando") return;
      parar();
      // O parar() trocou o estado ("finalizando", ou já "parado" com o fim
      // entregue na hora): a gravação vai ser, ou já foi, entregue.
      if (estadoAgora.current !== agora) {
        atuais.current.aoEntregarAoSair?.();
        return;
      }
      // O parar() não teve o que parar (o MediaRecorder que o navegador já deu
      // como inativo): o descarte abaixo ao menos solta o microfone.
    }
    descartar();
  }, []);

  useEffect(() => {
    if (estado === "pausado") {
      const vigia = window.setInterval(() => {
        if (pausaComecou.current && Date.now() - pausaComecou.current >= PAUSA_MAXIMA_MS) parar();
      }, RELOGIO_MS);
      return () => window.clearInterval(vigia);
    }
    if (estado !== "gravando") return;
    // O atraso do tique conta a partir de agora: a pausa que acabou de terminar não é a aba em segundo plano.
    ultimaConferencia.current = Date.now();
    const relogio = window.setInterval(() => {
      const limite = atuais.current.limiteSegundos;
      const decorridos = Math.floor((Date.now() - inicio.current - pausadoNaGravacao.current) / 1000);
      setSegundos(Math.min(limite, decorridos));
      if (decorridos >= limite) {
        // Para primeiro e avisa uma vez só por gravação: o parar() que sai cedo
        // deixa o estado em "gravando", e este relógio volta aqui na próxima volta.
        parar();
        if (!limiteAvisado.current) {
          limiteAvisado.current = true;
          atuais.current.aoChegarAoLimite?.();
        }
        return;
      }
      // G17: o navegador que não avisa a trilha que acabou (sem o "ended") e
      // segue gravando silêncio. Fora das partes, aoCairATrilha não faz nada.
      if (microfone.current && !fluxoVivo(microfone.current)) aoCairATrilha(microfone.current);
      if (estadoAgora.current !== "gravando") return;
      conferirATroca();
    }, RELOGIO_MS);
    return () => {
      window.clearInterval(relogio);
      // Pausada, parando ou fora da tela, o detector solta o fluxo; na volta à
      // gravação, a hora da troca o abre de novo.
      pararDeOuvir();
    };
  }, [estado]);

  // G17: sem microfone, o hook pede um de novo na hora, a cada troca de
  // aparelho (devicechange), na volta à aba e a cada TENTATIVA_DO_MICROFONE_MS.
  // Passada a espera mais longa, encerra e entrega o que gravou.
  useEffect(() => {
    if (estado !== "semMicrofone") return;
    const tentar = () => { void pedirOMicrofone(); };
    const aparelhos = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    aparelhos?.addEventListener?.("devicechange", tentar);
    document.addEventListener("visibilitychange", tentar);
    const vigia = window.setInterval(() => {
      if (semMicrofoneDesde.current && Date.now() - semMicrofoneDesde.current >= ESPERA_PELO_MICROFONE_MAXIMA_MS) {
        parar();
        atuais.current.aoDesistirDoMicrofone?.();
        return;
      }
      tentar();
    }, TENTATIVA_DO_MICROFONE_MS);
    tentar();
    return () => {
      window.clearInterval(vigia);
      aparelhos?.removeEventListener?.("devicechange", tentar);
      document.removeEventListener("visibilitychange", tentar);
    };
  }, [estado]);

  return {
    estado, segundos, comecar, parar, descartar, pausar, continuar,
    /** G17: o "Tentar de novo" da tela, sem microfone: pede já, dentro do toque, mesmo depois de uma recusa. */
    tentarOMicrofone: () => { void pedirOMicrofone(true); },
    /** G17: o navegador recusou o microfone na espera; só o toque da dona pede de novo. */
    microfoneBloqueado,
    /** O fluxo que está sendo gravado, para a tela só ouvir (a bolha da voz); null parado. */
    fluxoAoVivo,
  };
}
