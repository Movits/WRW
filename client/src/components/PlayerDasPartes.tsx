import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronsRight, Pause, Play, RotateCcw, RotateCw } from "lucide-react";
import { dentroDosTrechos, destinoDoPuloNosTrechos, pontoParaTocar, trechosParaTocar } from "@/lib/trechos-para-tocar";
import { mmss, type SegmentoDaTela } from "./TranscricaoPorFalante";

/** Uma parte do áudio, no contrato `recording.partes` do servidor. */
export type ParteDoPlayer = { seq: number; url: string; mimeType: string; inicioSegundos: number; duracaoSegundos: number };

/**
 * O que a transcrição usa para pular ao segundo de uma fala, e o "ouvir só
 * esta voz" (D2): `ouvirSoAVoz(voz)` toca só as falas dessa voz, a partir da
 * próxima fala dela; `ouvirSoAVoz(null)` volta a tocar todas, sem sair do lugar.
 */
export type ControleDoPlayer = { irPara: (segundo: number) => void; ouvirSoAVoz: (voz: string | null) => void };

/** As velocidades do botão, na ordem em que um toque passa de uma para a outra. */
export const VELOCIDADES = [1, 1.25, 1.5, 1.75, 2] as const;
/** Onde o navegador de quem ouve guarda a velocidade escolhida. */
export const CHAVE_DA_VELOCIDADE = "wrw:velocidade-do-player";
/** Onde o navegador de quem ouve guarda o "pular os silêncios" (D2). */
export const CHAVE_DOS_SILENCIOS = "wrw:pular-silencios";
/**
 * De quanto em quanto tempo, tocando só uma voz ou sem os silêncios, o player
 * confere se saiu do trecho (D2). O timeupdate do navegador chega a cada 250
 * ms: sozinho, deixaria ouvir um quarto de segundo da fala de outra pessoa.
 */
export const CONFERENCIA_DOS_TRECHOS_MS = 100;
/** Quanto os botões de voltar e de avançar pulam. */
const PULO_SEGUNDOS = 15;

/** Onde a reunião termina: o fim da última parte. */
export function fimDaReuniao(partes: ParteDoPlayer[]) {
  return partes.reduce((fim, p) => Math.max(fim, p.inicioSegundos + p.duracaoSegundos), 0);
}

/**
 * A parte que toca um segundo (absoluto na reunião) e o ponto dentro dela. Num
 * buraco entre partes (uma que não chegou ou venceu), começa na primeira que
 * vem depois dele; depois da última, fica na última.
 */
export function localizar(partes: ParteDoPlayer[], segundo: number) {
  let indice = partes.findIndex(p => segundo >= p.inicioSegundos && segundo < p.inicioSegundos + p.duracaoSegundos);
  if (indice < 0) {
    const seguinte = partes.findIndex(p => p.inicioSegundos > segundo);
    indice = seguinte >= 0 ? seguinte : partes.length - 1;
  }
  return { indice, dentro: Math.max(0, segundo - partes[indice].inicioSegundos) };
}

/**
 * Onde cai um pulo de `delta` segundos (os 15 s dos botões), contando só o
 * áudio que existe: o buraco entre partes não conta, como na reprodução
 * contínua, que o salta. Contando o buraco, voltar 15 s logo depois dele caía
 * no buraco, que leva ao começo da parte seguinte, e o botão não saía do lugar.
 */
export function destinoDoPulo(partes: ParteDoPlayer[], segundo: number, delta: number) {
  const totalDeAudio = partes.reduce((soma, p) => soma + p.duracaoSegundos, 0);
  // A posição em segundos de áudio: as partes anteriores inteiras mais o trecho
  // já ouvido desta (num buraco, o começo da parte seguinte).
  let posicao = totalDeAudio;
  let antes = 0;
  for (const p of partes) {
    if (segundo < p.inicioSegundos + p.duracaoSegundos) {
      posicao = antes + Math.max(0, segundo - p.inicioSegundos);
      break;
    }
    antes += p.duracaoSegundos;
  }
  let resto = Math.min(totalDeAudio, Math.max(0, posicao + delta));
  for (const p of partes) {
    if (resto < p.duracaoSegundos) return p.inicioSegundos + resto;
    resto -= p.duracaoSegundos;
  }
  return fimDaReuniao(partes);
}

/** Se o segundo cai num buraco entre partes (uma que não chegou ou venceu). */
function noBuraco(partes: ParteDoPlayer[], segundo: number) {
  return segundo < fimDaReuniao(partes) && !partes.some(p => segundo >= p.inicioSegundos && segundo < p.inicioSegundos + p.duracaoSegundos);
}

/** A parte que toca, pelo seq; a que saiu da lista (venceu) dá lugar à seguinte. */
function indiceDaParte(partes: ParteDoPlayer[], seq: number | null) {
  if (seq === null) return 0;
  const indice = partes.findIndex(p => p.seq === seq);
  if (indice >= 0) return indice;
  const seguinte = partes.findIndex(p => p.seq > seq);
  return seguinte >= 0 ? seguinte : Math.max(0, partes.length - 1);
}

/** A velocidade guardada neste navegador, se for uma das do botão. */
function velocidadeGuardada(): number {
  try {
    const guardada = Number(localStorage.getItem(CHAVE_DA_VELOCIDADE));
    if ((VELOCIDADES as readonly number[]).includes(guardada)) return guardada;
  } catch {
    // Navegador em modo privado ou com armazenamento bloqueado: começa em 1x.
  }
  return 1;
}

function guardarVelocidade(velocidade: number) {
  try {
    localStorage.setItem(CHAVE_DA_VELOCIDADE, String(velocidade));
  } catch {
    // Sem armazenamento: a velocidade vale só nesta visita.
  }
}

/** O "pular os silêncios" guardado neste navegador (D2); desligado por padrão. */
function silenciosGuardados(): boolean {
  try {
    return localStorage.getItem(CHAVE_DOS_SILENCIOS) === "1";
  } catch {
    // Navegador em modo privado ou com armazenamento bloqueado: começa desligado.
    return false;
  }
}

function guardarSilencios(pular: boolean) {
  try {
    localStorage.setItem(CHAVE_DOS_SILENCIOS, pular ? "1" : "0");
  } catch {
    // Sem armazenamento: a escolha vale só nesta visita.
  }
}

/** "1,5" em pt-BR e "1.5" em inglês, sempre com algarismos latinos, como os tempos da barra. */
function formatarVelocidade(velocidade: number, idioma: string) {
  try {
    return new Intl.NumberFormat(`${idioma}-u-nu-latn`, { maximumFractionDigits: 2 }).format(velocidade);
  } catch {
    return String(velocidade);
  }
}

/** O play() devolve uma promessa que o navegador pode recusar (sem gesto, src trocado no meio). */
function tocarO(audio: HTMLMediaElement, aoRecusar: (erro: unknown) => void) {
  try {
    Promise.resolve(audio.play()).catch(aoRecusar);
  } catch (erro) {
    aoRecusar(erro);
  }
}

// O foco aparece no ring e, no alto contraste do Windows (que apaga o
// box-shadow do ring), no outline transparente que o outline-hidden deixa e o
// sistema pinta; o outline-none o apagaria.
const BOTAO = "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-300";

function IconeDoPulo({ para }: { para: "tras" | "frente" }) {
  const Icone = para === "tras" ? RotateCcw : RotateCw;
  return (
    <span aria-hidden className="relative inline-flex items-center justify-center">
      <Icone size={26} strokeWidth={1.75}/>
      <span className="absolute text-[9px] font-bold leading-none">{PULO_SEGUNDOS}</span>
    </span>
  );
}

/**
 * O player da reunião (D1 do desenho do gravador; a barra única é a D1b): a
 * gravação em partes é só o jeito de enviar o áudio durante a reunião, e quem
 * ouve vê UMA gravação. Um único <audio> sem controles toca as partes em
 * sequência, e os controles daqui cobrem a reunião inteira: a linha do tempo
 * vai de 0 ao fim da última parte, o tempo na tela é absoluto, os 15 s e a
 * velocidade atravessam as partes. O envio único é uma parte só, no mesmo
 * contrato. `irPara(segundo)` acha a parte do segundo (absoluto na reunião),
 * troca para ela e começa a tocar dali.
 *
 * Sem onError o player falha MUDO (sessão vencida, limite de requisições,
 * storage fora do ar): `aoFalhar` deixa a tela explicar.
 *
 * Com as falas da transcrição (`falas`), o player sabe ouvir só uma voz e
 * pular os silêncios (D2; HN-26 e HN-79 do HiNoter): toca só os trechos de
 * lib/trechos-para-tocar.ts, salta de um ao seguinte e para depois do último.
 * A voz escolhida é da página (`soAVoz`), porque a transcrição a mostra e a
 * escolhe; o "pular os silêncios" é daqui, guardado no navegador de quem ouve,
 * como a velocidade.
 */
export const PlayerDasPartes = forwardRef<ControleDoPlayer, {
  partes: ParteDoPlayer[];
  aoFalhar?: () => void;
  aoCarregar?: () => void;
  className?: string;
  /** As falas com voz e tempo (a transcrição em partes): sem elas, nem a voz nem os silêncios se aplicam. */
  falas?: readonly SegmentoDaTela[];
  /** A voz que toca sozinha (D2); nula, todas. */
  soAVoz?: string | null;
  /** A voz escolhida mudou: pelo `ouvirSoAVoz` do controle ou pelo "▶" de um trecho de outra voz. */
  aoMudarSoAVoz?: (voz: string | null) => void;
}>(
  function PlayerDasPartes({ partes, aoFalhar, aoCarregar, className = "w-full", falas, soAVoz = null, aoMudarSoAVoz }, ref) {
    const { t, i18n } = useTranslation();
    const audio = useRef<HTMLAudioElement | null>(null);
    const deslizante = useRef<HTMLInputElement | null>(null);
    // A parte que toca, pelo seq e não pela posição na lista: a lista cresce
    // com a gravação ainda chegando e perde a parte que vence, e um índice
    // trocaria a parte debaixo de quem está ouvindo. O seq vale desde a
    // montagem: começando nulo, o player seguia a posição 0 da lista até a
    // primeira troca de parte, e uma parte de seq menor que chegasse atrasada
    // (o envio dela falhou e a retomada a mandou depois) trocava o áudio.
    const [seqAtual, setSeqAtual] = useState<number | null>(() => partes[0]?.seq ?? null);
    // O ponto dentro da parte (o currentTime), para o tempo absoluto na tela.
    const [noTrecho, setNoTrecho] = useState(0);
    // Se quem ouve quer o áudio tocando: segue ligado na troca de uma parte
    // para a seguinte, quando o <audio> para um instante.
    const [tocando, setTocando] = useState(false);
    const [velocidade, setVelocidade] = useState(velocidadeGuardada);
    // O valor do deslizante enquanto o dedo ou o mouse arrasta: o pulo só vem
    // ao soltar, para não carregar várias partes no meio do caminho.
    const [arrastando, setArrastando] = useState<number | null>(null);
    const valorArrastado = useRef<number | null>(null);
    const arrasteComPonteiro = useRef(false);
    // A duração que o navegador leu da parte que toca, quando passa da declarada.
    const [duracaoLida, setDuracaoLida] = useState<{ seq: number; segundos: number } | null>(null);
    // O ponto (em segundos dentro da parte) a aplicar quando a parte nova
    // carregar, e se ela deve tocar sozinha (a seguinte, ou um pulo).
    // `continua` diz que a troca é da reprodução contínua (o fim da parte
    // anterior, ou a que tocava e saiu da lista), e não um pedido de quem ouve:
    // só nela a parte que não carrega pula para a seguinte.
    const pendente = useRef<{ dentro: number; tocar: boolean; continua: boolean } | null>(null);
    // A última parte terminou: tocar de novo segue para a parte que chegou
    // depois (gravação ainda chegando) ou recomeça a reunião do início.
    const terminou = useRef(false);
    // A parte que não carregou e que a reprodução contínua pulou: o aviso da
    // tela fica até ela mesma carregar ou até quem ouve pedir outra parte. Sem
    // isso, o loadeddata da seguinte apagava o aviso, e o salto ficava sem
    // explicação.
    const falhou = useRef<number | null>(null);
    // O deslizante com o foco e o segundo que ele anunciou por último. Com o
    // foco nele e o áudio tocando, o texto para o leitor de tela fica nesse
    // segundo, e o valor visual segue andando: sem isso, o leitor de tela fala
    // o tempo a cada segundo por cima da reunião. É o que faz o player nativo
    // que estes controles substituem: o Chromium só atualiza o texto da linha
    // do tempo no foco, no play, na pausa e no pulo.
    const [focado, setFocado] = useState(false);
    const [anunciado, setAnunciado] = useState(0);
    // D2: pular os silêncios (guardado neste navegador) e os trechos que tocam:
    // os da voz escolhida ou, sem voz, os de todas as falas sem os silêncios.
    // Nulo: toca tudo.
    const [pularSilencios, setPularSilencios] = useState(silenciosGuardados);
    const temFalas = !!falas?.length;
    const trechos = useMemo(() => (temFalas ? trechosParaTocar(falas!, { voz: soAVoz, pularSilencios }) : null), [falas, temFalas, soAVoz, pularSilencios]);
    // A posição de agora, para o `ouvirSoAVoz` do controle achar a próxima fala da voz.
    const posicaoAgora = useRef(0);

    const indice = indiceDaParte(partes, seqAtual);
    const atual: ParteDoPlayer | undefined = partes[indice];
    const temPartes = partes.length > 0;

    function tocarAgora() {
      const elemento = audio.current;
      if (!elemento) return;
      setTocando(true);
      // AbortError é o src trocado no meio (outra parte): quem toca é a seguinte.
      tocarO(elemento, erro => { if ((erro as { name?: string } | null)?.name !== "AbortError") setTocando(false); });
    }

    function irPara(segundo: number, tocar: boolean) {
      if (!partes.length) return;
      terminou.current = false;
      const { indice: alvo, dentro } = localizar(partes, segundo);
      setNoTrecho(dentro);
      setAnunciado(partes[alvo].inicioSegundos + dentro);
      if (alvo === indice && audio.current) {
        // A parte ainda está carregando: o ponto vale quando ela carregar. Para
        // tocar, o play() sai já, no toque: o Safari do iPhone não carrega a
        // parte sem ele, e o loadedmetadata que aplica o ponto não chegaria.
        if (pendente.current) {
          pendente.current = { dentro, tocar, continua: false };
          if (tocar) tocarAgora();
          return;
        }
        audio.current.currentTime = dentro;
        if (tocar) tocarAgora();
        return;
      }
      // Outra parte, a pedido de quem ouve: o loadeddata dela apaga o aviso.
      falhou.current = null;
      pendente.current = { dentro, tocar, continua: false };
      if (tocar) setTocando(true);
      setSeqAtual(partes[alvo].seq);
    }

    useImperativeHandle(ref, () => ({
      irPara: (segundo: number) => {
        // O "▶" de um trecho de outra voz (no resumo, numa resposta) com "só
        // esta voz" ligado: quem pediu aquele ponto quer ouvi-lo, e o player
        // volta a tocar todas as vozes. Sem isto, ele saltaria para a próxima
        // fala da voz escolhida, longe do ponto pedido.
        if (soAVoz && trechos && !dentroDosTrechos(trechos, segundo)) aoMudarSoAVoz?.(null);
        irPara(segundo, true);
      },
      ouvirSoAVoz: (voz: string | null) => {
        aoMudarSoAVoz?.(voz);
        if (!voz) return;
        const daVoz = temFalas ? trechosParaTocar(falas!, { voz }) : null;
        if (!daVoz) return;
        // A próxima fala da voz a partir de onde o player está; depois da
        // última, a primeira.
        irPara(pontoParaTocar(daVoz, posicaoAgora.current) ?? daVoz[0].inicio, true);
      },
    }), [partes, indice, soAVoz, trechos, falas, temFalas, aoMudarSoAVoz]);

    // Trocou de parte para seguir tocando: o play() sai logo com o src novo. O
    // Safari do iPhone não carrega o áudio sem ele (ignora o preload), e o
    // loadedmetadata que aplica o ponto pedido não chegaria. Efeito de layout
    // para o play() do clique no "▶" sair ainda dentro do toque.
    const urlAtual = atual?.url;
    useLayoutEffect(() => {
      if (atual && atual.seq !== seqAtual) {
        // A lista começou vazia: a primeira parte que chega é a que toca.
        // Senão, a parte que tocava saiu da lista (venceu, ou a transcrição
        // dela desistiu): o src já é o da parte que vem depois, e o navegador
        // parou o áudio ao trocá-lo, sem disparar pause. Tocando, segue nela,
        // como a reprodução contínua salta o buraco; sem parte depois (o src
        // voltou a uma parte de antes), para. Sem isso, o botão ficava em
        // "Pausar" com o áudio mudo.
        setSeqAtual(atual.seq);
        if (seqAtual !== null) {
          const seguiu = atual.seq > seqAtual;
          setNoTrecho(0);
          setAnunciado(atual.inicioSegundos);
          pendente.current = { dentro: 0, tocar: tocando && seguiu, continua: true };
          if (tocando && !seguiu) setTocando(false);
        }
      }
      if (pendente.current?.tocar) tocarAgora();
    }, [urlAtual]);

    // O algoritmo de carga do <audio> volta playbackRate para defaultPlaybackRate
    // a cada src novo: as duas recebem a velocidade, aqui e a cada parte que
    // carrega (onLoadedMetadata).
    useEffect(() => {
      const elemento = audio.current;
      if (!elemento) return;
      elemento.defaultPlaybackRate = velocidade;
      elemento.playbackRate = velocidade;
    }, [velocidade, temPartes]);

    // D2: tocando só os trechos (uma voz, ou sem os silêncios), a posição é
    // conferida a cada CONFERENCIA_DOS_TRECHOS_MS, além de cada timeupdate. A
    // conferência é a do render mais recente: o relógio não recomeça a cada
    // render, e os trechos e a parte que toca são os de agora.
    const conferirAgora = useRef<() => void>(() => {});
    useEffect(() => { conferirAgora.current = conferirTrecho; });
    const comTrechos = !!trechos?.length;
    useEffect(() => {
      if (!tocando || !comTrechos) return;
      const relogio = window.setInterval(() => conferirAgora.current(), CONFERENCIA_DOS_TRECHOS_MS);
      return () => window.clearInterval(relogio);
    }, [tocando, comTrechos]);

    /**
     * Fora de um trecho, salta ao começo do seguinte; depois do último, para
     * ali, e o Tocar seguinte recomeça do primeiro. Com a troca de parte em
     * curso, espera: o <audio> ainda está no começo da parte nova.
     */
    function conferirTrecho() {
      const elemento = audio.current;
      if (!trechos?.length || !elemento || !atual || !tocando || pendente.current) return;
      const agora = atual.inicioSegundos + elemento.currentTime;
      const ponto = pontoParaTocar(trechos, agora);
      if (ponto === null) {
        terminou.current = true;
        setTocando(false);
        elemento.pause();
        return;
      }
      if (ponto > agora) irPara(ponto, true);
    }

    function confirmar(segundo: number) {
      setArrastando(null);
      irPara(segundo, tocando);
    }

    // Soltou o deslizante (fim do arraste, pelo dedo ou pelo mouse).
    function soltar() {
      if (!arrasteComPonteiro.current) return;
      arrasteComPonteiro.current = false;
      const valor = valorArrastado.current;
      valorArrastado.current = null;
      if (valor === null) setArrastando(null);
      else confirmar(valor);
    }

    // O "change" nativo é o soltar que todo navegador garante, também quando o
    // dedo sai de cima do controle; o React não o separa do "input".
    const soltarAgora = useRef(soltar);
    useEffect(() => { soltarAgora.current = soltar; });
    useEffect(() => {
      const elemento = deslizante.current;
      if (!elemento) return;
      const aoSoltar = () => soltarAgora.current();
      elemento.addEventListener("change", aoSoltar);
      return () => elemento.removeEventListener("change", aoSoltar);
    }, [temPartes]);

    if (!atual) return null;

    const fimDeclarado = fimDaReuniao(partes);
    const total = duracaoLida?.seq === atual.seq ? Math.max(fimDeclarado, atual.inicioSegundos + duracaoLida.segundos) : fimDeclarado;
    const posicao = Math.min(total, atual.inicioSegundos + noTrecho);
    posicaoAgora.current = posicao;
    const naTela = arrastando ?? posicao;
    const congelado = focado && tocando && arrastando === null;
    const noTextoDoDeslizante = congelado ? Math.min(total, anunciado) : naTela;
    const totalNaTela = mmss(total);
    const velocidadeNaTela = t("meetings.player.speedValue", { velocidade: formatarVelocidade(velocidade, i18n.resolvedLanguage ?? i18n.language) });

    function alternar() {
      const elemento = audio.current;
      if (!elemento) return;
      if (tocando) {
        if (pendente.current) pendente.current.tocar = false;
        setTocando(false);
        elemento.pause();
        return;
      }
      if (trechos?.length) {
        // D2: fora dos trechos, o Tocar vai ao começo do seguinte; parado no
        // fim, ou depois do último trecho, recomeça do primeiro.
        const ponto = terminou.current ? null : pontoParaTocar(trechos, posicao);
        if (ponto === null || ponto > posicao) {
          irPara(ponto ?? trechos[0].inicio, true);
          return;
        }
      } else if (terminou.current) {
        const seguinte = partes[indice + 1];
        irPara(seguinte ? seguinte.inicioSegundos : 0, true);
        return;
      }
      // A parte ainda carrega: toca quando carregar (e o play() aqui, no
      // toque, é o gesto que o celular exige).
      if (pendente.current) pendente.current.tocar = true;
      tocarAgora();
    }

    function trocarVelocidade() {
      const proxima = VELOCIDADES[(VELOCIDADES.indexOf(velocidade as (typeof VELOCIDADES)[number]) + 1) % VELOCIDADES.length];
      setVelocidade(proxima);
      guardarVelocidade(proxima);
    }

    function alternarSilencios() {
      const proximo = !pularSilencios;
      setPularSilencios(proximo);
      guardarSilencios(proximo);
    }

    // Os 15 s contam só o áudio que existe e, tocando só os trechos (D2), só o que toca.
    const pulo = (delta: number) => (trechos?.length ? destinoDoPuloNosTrechos(trechos, posicao, delta) : destinoDoPulo(partes, posicao, delta));

    return (
      <div className={className}>
        <audio
          ref={audio}
          preload="metadata"
          src={atual.url}
          aria-label={t("meetings.recordingHeading")}
          data-parte={atual.seq}
          onPlay={() => {
            // Voltou a tocar, também por fora da barra (tecla de mídia, botão
            // do fone, tela de bloqueio): não está mais parado no fim, e o
            // Tocar seguinte da barra continua daqui, em vez de pular para a
            // parte seguinte ou para o começo da reunião.
            terminou.current = false;
            // Começou a tocar com o foco no deslizante: ele anuncia o ponto de agora.
            if (!tocando) setAnunciado(posicao);
            setTocando(true);
          }}
          onPause={() => {
            // O fim de uma parte com outra depois não é pausa: segue na seguinte.
            if (audio.current?.ended && indice + 1 < partes.length) return;
            // Troca de parte em curso: o src novo para o áudio antes de a parte seguinte tocar.
            if (pendente.current?.tocar) return;
            setTocando(false);
          }}
          onTimeUpdate={() => {
            // Com a troca de parte pendente, o <audio> volta a 0 antes de ir ao ponto pedido.
            if (!pendente.current && audio.current) setNoTrecho(audio.current.currentTime);
            conferirTrecho();
          }}
          onError={() => {
            falhou.current = atual.seq;
            aoFalhar?.();
            // Parte do meio que não carrega: segue para a próxima, em vez de travar
            // a gravação inteira ali (o aviso da tela diz que algo não carregou).
            // Só na reprodução contínua: o pulo pedido por quem ouve (o ▶, o ?t,
            // o deslizante, os 15 s, o Tocar durante a carga) fica no ponto
            // pedido, com o aviso, em vez de tocar outro trecho.
            const seguinte = partes[indice + 1];
            if (pendente.current?.tocar && pendente.current.continua && seguinte) {
              pendente.current = { dentro: 0, tocar: true, continua: true };
              setNoTrecho(0);
              setSeqAtual(seguinte.seq);
              return;
            }
            pendente.current = null;
            setTocando(false);
          }}
          onLoadedMetadata={() => {
            const elemento = audio.current;
            if (!elemento) return;
            elemento.defaultPlaybackRate = velocidade;
            elemento.playbackRate = velocidade;
            if (Number.isFinite(elemento.duration) && elemento.duration > 0) setDuracaoLida({ seq: atual.seq, segundos: elemento.duration });
            const p = pendente.current;
            pendente.current = null;
            if (!p) return;
            elemento.currentTime = p.dentro;
            setNoTrecho(p.dentro);
            // O navegador pode recusar tocar sem gesto: o player fica no ponto.
            if (p.tocar) tocarAgora();
          }}
          onLoadedData={() => {
            // A seguinte, alcançada pelo pulo da parte que não carregou, não
            // apaga o aviso.
            if (falhou.current !== null && falhou.current !== atual.seq) return;
            falhou.current = null;
            aoCarregar?.();
          }}
          onEnded={() => {
            const seguinte = partes[indice + 1];
            if (!seguinte) {
              terminou.current = true;
              setTocando(false);
              return;
            }
            pendente.current = { dentro: 0, tocar: true, continua: true };
            setNoTrecho(0);
            setSeqAtual(seguinte.seq);
          }}
        >
          {t("meetings.audioNotSupported")}
        </audio>
        {/* Os controles não espelham em árabe: a linha do tempo de um áudio
            corre da esquerda para a direita em toda língua, como no player
            nativo que eles substituem. No celular, a linha do tempo fica em
            cima e os botões embaixo; de sm para cima, tudo numa linha só. */}
        <div dir="ltr" className="flex flex-wrap items-center gap-x-2 sm:flex-nowrap sm:gap-x-3">
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => irPara(pulo(-PULO_SEGUNDOS), tocando)}
              aria-label={t("meetings.player.rewind", { segundos: PULO_SEGUNDOS })} className={BOTAO}>
              <IconeDoPulo para="tras"/>
            </button>
            <button type="button" onClick={alternar} aria-label={tocando ? t("meetings.player.pause") : t("meetings.player.play")}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-amber-300 text-[#1a120c] transition-colors hover:bg-amber-200 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#16130f]">
              {tocando ? <Pause size={20} fill="currentColor" aria-hidden/> : <Play size={20} fill="currentColor" className="translate-x-px" aria-hidden/>}
            </button>
            <button type="button" onClick={() => irPara(pulo(PULO_SEGUNDOS), tocando)}
              aria-label={t("meetings.player.forward", { segundos: PULO_SEGUNDOS })} className={BOTAO}>
              <IconeDoPulo para="frente"/>
            </button>
          </div>
          <div className="flex min-w-0 basis-full items-center gap-2 max-sm:order-first sm:basis-auto sm:flex-1">
            {/* Os tempos repetem o que o deslizante anuncia (aria-valuetext). */}
            <span aria-hidden className="shrink-0 text-right text-xs tabular-nums text-white/75" style={{ minWidth: `${totalNaTela.length}ch` }}>{mmss(naTela)}</span>
            {/* Sem o atributo step, de propósito (o passo padrão do range já é
                1 s): com ele, o VoiceOver do iPhone e do Mac anda 1 s por
                gesto, e sem ele anda 5% da reunião, como o leitor de tela no
                Chrome. */}
            <input
              ref={deslizante}
              type="range"
              min={0}
              max={Math.max(1, Math.ceil(total))}
              value={Math.floor(naTela)}
              aria-label={t("meetings.player.position")}
              aria-valuetext={t("meetings.player.positionValue", { atual: mmss(noTextoDoDeslizante), total: totalNaTela })}
              onPointerDown={() => { arrasteComPonteiro.current = true; }}
              // Sem pointercancel: o navegador de toque pode cancelar o ponteiro
              // logo no começo do arraste do controle nativo, e aí cada passo
              // viraria um pulo. O fim do arraste chega pelo change nativo.
              onPointerUp={soltar}
              onFocus={() => {
                setFocado(true);
                setAnunciado(posicao);
              }}
              onBlur={() => {
                setFocado(false);
                soltar();
              }}
              onChange={evento => {
                const valor = Number(evento.currentTarget.value);
                if (!Number.isFinite(valor)) return;
                if (arrasteComPonteiro.current) {
                  valorArrastado.current = valor;
                  setArrastando(valor);
                  return;
                }
                // Teclado ou leitor de tela: cada passo já é a escolha confirmada.
                // O passo para trás que cai num buraco entre partes conta só o
                // áudio que existe, como os 15 s: sem isso, o buraco levava de
                // volta ao começo da parte seguinte, e a seta para a esquerda
                // logo depois dele não saía do lugar.
                confirmar(valor < posicao && noBuraco(partes, valor) ? destinoDoPulo(partes, posicao, valor - posicao) : valor);
              }}
              className="h-11 min-w-0 flex-1 cursor-pointer rounded-full accent-amber-300 [color-scheme:dark] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-300"
            />
            <span aria-hidden className="shrink-0 text-xs tabular-nums text-white/50">{totalNaTela}</span>
          </div>
          <div className="ms-auto flex shrink-0 items-center gap-1 sm:ms-0">
            {/* D2: pular os silêncios, só com as falas da transcrição (são elas que dizem onde há silêncio). */}
            {temFalas && <button type="button" onClick={alternarSilencios} aria-pressed={pularSilencios}
              aria-label={t("meetings.playback.skipSilence")} title={t("meetings.playback.skipSilence")}
              className={`${BOTAO} ${pularSilencios ? "bg-amber-300/20 text-amber-200" : ""}`}>
              <ChevronsRight size={22} strokeWidth={1.75} aria-hidden/>
            </button>}
            <button type="button" onClick={trocarVelocidade} aria-label={t("meetings.player.speed", { velocidade: velocidadeNaTela })}
              className="inline-flex h-11 min-w-11 shrink-0 items-center justify-center rounded-full px-2 text-sm font-semibold tabular-nums text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-300">
              {velocidadeNaTela}
            </button>
          </div>
        </div>
      </div>
    );
  },
);
