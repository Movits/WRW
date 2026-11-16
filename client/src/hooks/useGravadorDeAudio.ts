import { useEffect, useRef, useState } from "react";
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
   */
  fatiaSegundos?: number;
  aoFecharParte?: (parte: AudioGravado & { seq: number; ultima: boolean }) => void;
  /** Microfone negado, ausente ou ocupado, ou o gravador recusado. Não chega a quem já saiu da tela. */
  aoFalhar?: (erro: unknown) => void;
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
  const gravador = useRef<MediaRecorder | null>(null);
  // Só o microfone que o hook abriu: o MediaStream de fora é de quem o entregou.
  const microfone = useRef<MediaStream | null>(null);
  const inicio = useRef(0);
  // Na gravação em partes: quando a parte atual começou, e se o stop em curso é
  // a troca de parte (e não o fim da gravação).
  const inicioDaParte = useRef(0);
  const trocandoDeParte = useRef(false);
  // O Parar que chega DURANTE a troca (o gravador da parte já parou e o da
  // seguinte ainda não abriu): vale como o fim, e a parte seguinte não abre.
  const pararNaTroca = useRef(false);
  // A pausa (G10): quando a atual começou (0 sem pausa), o tempo pausado da
  // gravação inteira e o da parte atual. O áudio pausado não existe no arquivo:
  // a duração entregue, o relógio e a troca de parte descontam a pausa.
  const pausaComecou = useRef(0);
  const pausadoNaGravacao = useRef(0);
  const pausadoNaParte = useRef(0);
  // Cada pedido de microfone leva um número. Sair da tela ou descartar troca o
  // número, e o microfone que o navegador entregar depois, para um pedido
  // velho, é solto na hora.
  const pedidoAtual = useRef(0);

  function mudarEstado(novo: EstadoDoGravador) {
    estadoAgora.current = novo;
    setEstado(novo);
  }

  // Do pedido do microfone ao fim do arquivo, o áudio só existe nesta aba: a
  // sessão fica ocupada (lib/sessao-ocupada.ts), e o Sair e o fechar da aba pedem
  // confirmação. O fim do arquivo, descartar, a falha e sair da tela liberam.
  useOcupacao("gravando", estado !== "parado");

  /** Fecha a pausa em curso, somando-a ao tempo pausado. */
  function fecharPausa() {
    if (!pausaComecou.current) return;
    const pausa = Date.now() - pausaComecou.current;
    pausaComecou.current = 0;
    pausadoNaGravacao.current += pausa;
    pausadoNaParte.current += pausa;
  }

  /** Pausa a gravação (G10): o microfone segue aberto, nada é gravado. */
  function pausar() {
    const atual = gravador.current;
    if (atual?.state !== "recording" || trocandoDeParte.current || typeof atual.pause !== "function") return;
    atual.pause();
    pausaComecou.current = Date.now();
    mudarEstado("pausado");
  }

  function continuar() {
    const atual = gravador.current;
    if (atual?.state !== "paused") return;
    // No iPhone, bloquear a tela durante a pausa encerra a trilha do microfone:
    // retomar gravaria silêncio. Encerra e entrega o que já foi gravado.
    if (!microfoneVivo(atual)) return parar();
    fecharPausa();
    atual.resume();
    mudarEstado("gravando");
  }

  function parar() {
    const atual = gravador.current;
    if (trocandoDeParte.current && atual) {
      pararNaTroca.current = true;
      mudarEstado("finalizando");
      return;
    }
    if (atual?.state !== "recording" && atual?.state !== "paused") return;
    fecharPausa();
    mudarEstado("finalizando");
    atual.stop();
  }

  /** Para sem entregar nada e solta o microfone. */
  function descartar() {
    pedidoAtual.current++;
    pausaComecou.current = 0;
    pausadoNaGravacao.current = 0;
    pausadoNaParte.current = 0;
    trocandoDeParte.current = false;
    pararNaTroca.current = false;
    const atual = gravador.current;
    gravador.current = null;
    if (atual) {
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
      // Uma parte: um MediaRecorder novo no mesmo fluxo, com os pedaços SÓ dela
      // (nenhum gravador empurra para a lista de outro). Na gravação de uma
      // parte só (o ditado, a voz), é o gravador de sempre.
      const abrirParte = (seq: number) => {
        const novo = mimeType ? new MediaRecorder(fluxo, { mimeType, audioBitsPerSecond }) : new MediaRecorder(fluxo, { audioBitsPerSecond });
        const pedacos: Blob[] = [];
        const parteComecouEm = Date.now();
        novo.ondataavailable = evento => { if (evento.data.size) pedacos.push(evento.data); };
        novo.onstop = () => {
          const blob = new Blob(pedacos, { type: novo.mimeType || "audio/webm" });
          const audio = { blob, mimeType: tipoParaOServidor(blob.type), duracaoMs: Date.now() - parteComecouEm - pausadoNaParte.current };
          // Troca de parte: a gravação continua, já na parte seguinte.
          if (trocandoDeParte.current && gravador.current === novo && !pararNaTroca.current) {
            trocandoDeParte.current = false;
            abrirParte(seq + 1);
            atuais.current.aoFecharParte?.({ ...audio, seq, ultima: false });
            return;
          }
          trocandoDeParte.current = false;
          pararNaTroca.current = false;
          pararTrilhas(aberto);
          if (microfone.current === aberto) microfone.current = null;
          if (gravador.current === novo) gravador.current = null;
          mudarEstado("parado");
          setSegundos(0);
          atuais.current.aoFecharParte?.({ ...audio, seq, ultima: true });
          // Fora do modo em partes, a duração é a da gravação inteira, como antes.
          atuais.current.aoTerminar(atuais.current.fatiaSegundos ? audio : { ...audio, duracaoMs: Date.now() - comecouEm - pausadoNaGravacao.current });
        };
        novo.start(FATIA_MS);
        gravador.current = novo;
        inicioDaParte.current = parteComecouEm;
        pausadoNaParte.current = 0;
      };
      pausaComecou.current = 0;
      pausadoNaGravacao.current = 0;
      abrirParte(0);
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
  // o microfone e não entrega nada. No StrictMode, que monta, desmonta e monta de
  // novo, isto roda sem nada gravando.
  useEffect(() => () => descartar(), []);

  useEffect(() => {
    if (estado === "pausado") {
      const vigia = window.setInterval(() => {
        if (pausaComecou.current && Date.now() - pausaComecou.current >= PAUSA_MAXIMA_MS) parar();
      }, RELOGIO_MS);
      return () => window.clearInterval(vigia);
    }
    if (estado !== "gravando") return;
    const relogio = window.setInterval(() => {
      const limite = atuais.current.limiteSegundos;
      const decorridos = Math.floor((Date.now() - inicio.current - pausadoNaGravacao.current) / 1000);
      setSegundos(Math.min(limite, decorridos));
      if (decorridos >= limite) return parar();
      const fatia = atuais.current.fatiaSegundos;
      const atual = gravador.current;
      if (fatia && atual?.state === "recording" && !trocandoDeParte.current && Date.now() - inicioDaParte.current - pausadoNaParte.current >= fatia * 1000) {
        trocandoDeParte.current = true;
        atual.stop();
      }
    }, RELOGIO_MS);
    return () => window.clearInterval(relogio);
  }, [estado]);

  return { estado, segundos, comecar, parar, descartar, pausar, continuar };
}
