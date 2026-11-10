import { useEffect, useRef, useState } from "react";
import { escolherMimeDeGravacao, tipoParaOServidor, type TipoDeAudioGravado } from "@/lib/formato-de-audio";

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

export type EstadoDoGravador = "parado" | "pedindoMicrofone" | "gravando" | "finalizando";

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
  /** Microfone negado, ausente ou ocupado, ou o gravador recusado. Não chega a quem já saiu da tela. */
  aoFalhar?: (erro: unknown) => void;
};

// Pedaços de 250 ms e o relógio a cada 500 ms, como os três faziam (a folga da
// duração medida no servidor, em server/meeting-service.ts, conta com os 500 ms).
const FATIA_MS = 250;
const RELOGIO_MS = 500;

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
  // Cada pedido de microfone leva um número. Sair da tela ou descartar troca o
  // número, e o microfone que o navegador entregar depois, para um pedido
  // velho, é solto na hora.
  const pedidoAtual = useRef(0);

  function mudarEstado(novo: EstadoDoGravador) {
    estadoAgora.current = novo;
    setEstado(novo);
  }

  function parar() {
    const atual = gravador.current;
    if (atual?.state !== "recording") return;
    mudarEstado("finalizando");
    atual.stop();
  }

  /** Para sem entregar nada e solta o microfone. */
  function descartar() {
    pedidoAtual.current++;
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
      const novo = mimeType ? new MediaRecorder(fluxo, { mimeType, audioBitsPerSecond }) : new MediaRecorder(fluxo, { audioBitsPerSecond });
      // Os pedaços são DESTA gravação: nenhum gravador empurra para a lista de outro.
      const pedacos: Blob[] = [];
      const comecouEm = Date.now();
      novo.ondataavailable = evento => { if (evento.data.size) pedacos.push(evento.data); };
      novo.onstop = () => {
        pararTrilhas(aberto);
        if (microfone.current === aberto) microfone.current = null;
        if (gravador.current === novo) gravador.current = null;
        const blob = new Blob(pedacos, { type: novo.mimeType || "audio/webm" });
        mudarEstado("parado");
        setSegundos(0);
        atuais.current.aoTerminar({ blob, mimeType: tipoParaOServidor(blob.type), duracaoMs: Date.now() - comecouEm });
      };
      novo.start(FATIA_MS);
      gravador.current = novo;
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
    if (estado !== "gravando") return;
    const relogio = window.setInterval(() => {
      const limite = atuais.current.limiteSegundos;
      const decorridos = Math.floor((Date.now() - inicio.current) / 1000);
      setSegundos(Math.min(limite, decorridos));
      if (decorridos >= limite) parar();
    }, RELOGIO_MS);
    return () => window.clearInterval(relogio);
  }, [estado]);

  return { estado, segundos, comecar, parar, descartar };
}
