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
 */

export type EstadoDoGravador = "parado" | "pedindoMicrofone" | "gravando" | "pausado" | "finalizando";

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
   * ditado, a voz do contato, o envio único da reunião). Com isto, para e
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

/** O navegador pausa o MediaRecorder? (o Safari antigo não). */
export function pausaSuportada() {
  return typeof MediaRecorder !== "undefined" && typeof MediaRecorder.prototype?.pause === "function";
}

/** A trilha de áudio que o gravador grava ainda está viva? Sem como saber, sim. */
function microfoneVivo(gravador: MediaRecorder) {
  const trilhas = gravador.stream?.getAudioTracks?.();
  return !trilhas?.length || trilhas.some(trilha => trilha.readyState !== "ended");
}

const RESTRICOES_DO_MICROFONE: MediaStreamConstraints = {
  audio: { echoCancellation: { ideal: true }, noiseSuppression: { ideal: true }, autoGainControl: { ideal: true } },
  video: false,
};

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
  const abrirParte = useRef<((seq: number) => Parte) | null>(null);
  const fluxoGravado = useRef<MediaStream | null>(null);
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
    const atual = parte.current?.gravador;
    if (atual?.state !== "paused") return;
    // No iPhone, bloquear a tela durante a pausa encerra a trilha do microfone:
    // retomar gravaria silêncio. Encerra e entrega o que já foi gravado.
    if (!microfoneVivo(atual)) return parar();
    fecharPausa();
    atual.resume();
    mudarEstado("gravando");
  }

  function parar() {
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
    fluxoGravado.current = null;
    for (const atual of gravadores) {
      atual.onstop = null;
      if (atual.state !== "inactive") atual.stop();
    }
    pararTrilhas(microfone.current);
    microfone.current = null;
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
      const fluxo = fluxoDeFora ?? (aberto = await navigator.mediaDevices.getUserMedia(RESTRICOES_DO_MICROFONE));
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
          pararTrilhas(aberto);
          if (microfone.current === aberto) microfone.current = null;
          if (parte.current?.seq === seq) {
            parte.current = null;
            abrirParte.current = null;
            fluxoGravado.current = null;
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
      const abrir = (seq: number): Parte => {
        const novo = mimeType ? new MediaRecorder(fluxo, { mimeType, audioBitsPerSecond }) : new MediaRecorder(fluxo, { audioBitsPerSecond });
        const pedacos: Blob[] = [];
        const nova: Parte = { seq, gravador: novo, comecouEm: Date.now(), pausado: 0, paradaEm: 0, trocada: false, reabrir: false, encerrar: false };
        novo.ondataavailable = evento => { if (evento.data.size) pedacos.push(evento.data); };
        novo.onstop = () => {
          vivos.current.delete(novo);
          if (!vigente()) return;
          const blob = new Blob(pedacos, { type: novo.mimeType || "audio/webm" });
          // A parte termina quando o hook mandou parar, e não quando o navegador
          // acaba de fechar o arquivo: a seguinte já gravava desde a troca.
          const duracaoMs = (nova.paradaEm || Date.now()) - nova.comecouEm - nova.pausado;
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
        return nova;
      };
      pausaComecou.current = 0;
      pausadoNaGravacao.current = 0;
      limiteAvisado.current = false;
      parte.current = abrir(0);
      abrirParte.current = abrir;
      fluxoGravado.current = fluxo;
      microfone.current = aberto;
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
    const emCurso = agora === "gravando" || agora === "pausado" || agora === "finalizando";
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
      conferirATroca();
    }, RELOGIO_MS);
    return () => {
      window.clearInterval(relogio);
      // Pausada, parando ou fora da tela, o detector solta o fluxo; na volta à
      // gravação, a hora da troca o abre de novo.
      pararDeOuvir();
    };
  }, [estado]);

  return { estado, segundos, comecar, parar, descartar, pausar, continuar };
}
