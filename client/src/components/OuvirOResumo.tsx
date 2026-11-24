import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pause, Play, Square, Volume2 } from "lucide-react";
import { escolherVoz, falasCurtas, PRAZO_DAS_VOZES } from "@/lib/leitura-em-voz-alta";
import type { IdiomaFalado } from "@shared/idioma-da-reuniao";

/**
 * "Ouvir o resumo" (H19 do plano do gravador, item HN-46 do app de referência
 * da cliente): lê o resumo guardado com a voz do próprio aparelho, no idioma
 * em que a IA o escreveu, com pausar, continuar e parar. Não passa pelo
 * servidor nem pela IA: custo zero. Baixar o áudio fica para outra PR.
 *
 * Só a voz local do aparelho: a voz de rede do navegador (as "Google …" do
 * Chrome no computador, as "Online (Natural)" do Edge) mandaria o texto do
 * resumo a um servidor do Google ou da Microsoft, e ela fica de fora
 * (escolherVoz, em lib/leitura-em-voz-alta.ts).
 *
 * Sem voz local para o idioma, o botão fica desligado e explica (ler
 * português com a pronúncia do inglês não serve). Sem leitura em voz alta no
 * navegador, também.
 *
 * Pausar é cancelar e lembrar a fala em que parou; continuar a lê de novo
 * desde o começo dela. O pause() nativo não serve: no Chrome do Android ele
 * para de vez, e no Chrome do computador o resume() falha com as vozes do
 * Google depois de alguns segundos. As falas são curtas (lib/leitura-em-voz-
 * alta.ts), então voltar ao começo da fala é voltar ao começo da frase.
 *
 * Uma fala por vez com o navegador: a seguinte só vai quando a anterior
 * termina. No Chrome, o cancel() de qualquer aba (até de uma janela anônima)
 * interrompe a fala da vez de todas, e o navegador, depois do erro, segue com
 * a próxima fala da fila. Com a fila inteira entregue de uma vez, a voz
 * seguiria lendo atrás de uma tela que diz "pausada". Com uma fala só, a
 * interrupção vira pausa de verdade sem que esta tela chame o cancel(), que
 * no Chrome calaria também a voz de quem interrompeu.
 *
 * Um som por vez: começar a ler pausa a gravação que estiver tocando, e a
 * gravação que começa a tocar (o "▶ mm:ss", o player do rodapé) pausa a
 * leitura.
 */

type EstadoDaLeitura = "parada" | "lendo" | "pausada";

const sintese = () =>
  typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance === "function" ? speechSynthesis : null;

function useVozesDoAparelho() {
  const s = sintese();
  const [vozes, setVozes] = useState<SpeechSynthesisVoice[]>(() => s?.getVoices() ?? []);
  const [esperou, setEsperou] = useState(false);
  useEffect(() => {
    if (!s) return;
    const ler = () => setVozes(s.getVoices());
    ler();
    s.addEventListener?.("voiceschanged", ler);
    const prazo = window.setTimeout(() => { ler(); setEsperou(true); }, PRAZO_DAS_VOZES);
    return () => {
      s.removeEventListener?.("voiceschanged", ler);
      window.clearTimeout(prazo);
    };
  }, [s]);
  return { suportado: !!s, vozes, procurando: !!s && !vozes.length && !esperou };
}

// A gravação que estiver tocando na página (o player do rodapé) para quando a
// leitura começa.
function pausarAsGravacoes() {
  document.querySelectorAll<HTMLMediaElement>("audio, video").forEach(midia => {
    if (!midia.paused) midia.pause();
  });
}

// antesDeParar: chamado logo antes de a leitura ficar parada (pelo Parar, no
// fim ou na falha), enquanto o botão Parar ainda está na tela.
function useLeituraEmVozAlta(antesDeParar: () => void) {
  const [estado, setEstado] = useState<EstadoDaLeitura>("parada");
  const [falhou, setFalhou] = useState(false);
  const leitura = useRef<{ falas: string[]; voz: SpeechSynthesisVoice; indice: number } | null>(null);
  // Cada começar, pausar e parar abre uma vez nova. O fim ou o erro que chega
  // de uma fala de vez velha (o cancel() dispara um ou outro, conforme o
  // navegador) não mexe em nada.
  const vez = useRef(0);
  // A fala desta tela que está com o navegador: o Chrome perde os eventos de
  // uma fala que ninguém mais referencia.
  const naVez = useRef<SpeechSynthesisUtterance | null>(null);

  const soltar = () => {
    vez.current += 1;
    leitura.current = null;
    naVez.current = null;
  };
  // Só cancela a leitura que é desta tela: a voz de mais ninguém se cala.
  const encerrar = () => {
    const ativa = leitura.current !== null;
    soltar();
    if (ativa) sintese()?.cancel();
  };
  const ficarParada = () => {
    antesDeParar();
    setEstado("parada");
  };

  // Lê a partir da fala atual.indice, uma por vez: a seguinte só vai ao
  // navegador no fim da anterior.
  const enfileirar = () => {
    const s = sintese();
    const atual = leitura.current;
    if (!s || !atual) return;
    const minhaVez = ++vez.current;
    // A fala que falhou era a única desta tela com o navegador: nada a
    // cancelar, e a voz de mais ninguém se cala.
    const falhar = () => {
      soltar();
      ficarParada();
      setFalhou(true);
    };
    const falar = () => {
      const n = atual.indice;
      const fala = new SpeechSynthesisUtterance(atual.falas[n]);
      fala.voice = atual.voz;
      fala.lang = atual.voz.lang;
      fala.onend = () => {
        if (vez.current !== minhaVez) return;
        atual.indice = n + 1;
        if (atual.indice < atual.falas.length) return falar();
        soltar();
        ficarParada();
      };
      fala.onerror = evento => {
        if (vez.current !== minhaVez) return;
        // Outra página ou o próprio aparelho interrompeu a fala: fica
        // pausada, e o Continuar volta ao começo dela. Não há outra fala
        // desta tela na fila do navegador, então a voz para mesmo.
        if (evento.error === "interrupted" || evento.error === "canceled") {
          vez.current += 1;
          naVez.current = null;
          setEstado("pausada");
          return;
        }
        falhar();
      };
      naVez.current = fala;
      try {
        s.speak(fala);
      } catch {
        falhar();
      }
    };
    // Aba que foi para o fundo pode deixar a síntese pausada, e aí nada toca.
    if (s.paused) s.resume();
    falar();
  };

  const comecar = (falas: string[], voz: SpeechSynthesisVoice) => {
    encerrar();
    if (!falas.length) return;
    leitura.current = { falas, voz, indice: 0 };
    setFalhou(false);
    setEstado("lendo");
    pausarAsGravacoes();
    enfileirar();
  };
  const pausar = () => {
    if (!leitura.current) return;
    vez.current += 1;
    naVez.current = null;
    sintese()?.cancel();
    setEstado("pausada");
  };
  const continuar = () => {
    if (!leitura.current) return;
    setEstado("lendo");
    pausarAsGravacoes();
    enfileirar();
  };
  const parar = () => {
    encerrar();
    ficarParada();
  };

  // Sair da tela (ou da aba Resumo) cala a leitura; recarregar ou fechar a
  // página também, porque o Chrome segue falando depois de recarregar. A
  // página que volta do cache do navegador volta com o botão parado.
  useEffect(() => {
    window.addEventListener("pagehide", parar);
    return () => {
      window.removeEventListener("pagehide", parar);
      encerrar();
    };
  }, []);

  // A gravação que começa a tocar pausa a leitura. O "play" não sobe pela
  // árvore: só a captura no documento o vê.
  useEffect(() => {
    if (estado !== "lendo") return;
    document.addEventListener("play", pausar, true);
    return () => document.removeEventListener("play", pausar, true);
  }, [estado]);

  return { estado, falhou, comecar, pausar, continuar, parar };
}

// O nome do idioma no idioma da tela ("inglês", "English"). Só a base: a voz
// serve a qualquer região do idioma.
function nomeDoIdioma(idioma: IdiomaFalado, idiomaDaTela: string) {
  const base = idioma.split("-")[0];
  try {
    return new Intl.DisplayNames([idiomaDaTela], { type: "language" }).of(base) ?? base;
  } catch {
    return base;
  }
}

export function OuvirOResumo({ falas, idioma }: { falas: readonly string[]; idioma: IdiomaFalado }) {
  const { t, i18n } = useTranslation();
  const { suportado, vozes, procurando } = useVozesDoAparelho();
  const voz = escolherVoz(vozes, idioma);
  const principal = useRef<HTMLButtonElement>(null);
  const botaoParar = useRef<HTMLButtonElement>(null);
  // O Parar sai da tela quando a leitura para (por ele, no fim ou na falha):
  // o foco que estava nele volta ao botão principal, em vez de cair no começo
  // da página. O foco que está em outro lugar fica onde está.
  const devolverOFoco = useRef(false);
  const leitura = useLeituraEmVozAlta(() => {
    devolverOFoco.current = !!botaoParar.current && document.activeElement === botaoParar.current;
  });
  useLayoutEffect(() => {
    if (leitura.estado !== "parada" || !devolverOFoco.current) return;
    devolverOFoco.current = false;
    principal.current?.focus({ preventScroll: true });
  }, [leitura.estado]);
  const idDoAviso = useId();

  const aviso = !suportado
    ? t("meetings.summary.listenUnsupported")
    : !procurando && !voz
      ? t("meetings.summary.listenNoVoice", { idioma: nomeDoIdioma(idioma, i18n.resolvedLanguage ?? i18n.language) })
      : null;
  // Desligado, mas focável: o leitor de tela lê a explicação junto do botão.
  const desligado = leitura.estado === "parada" && !voz;
  const aoClicar = () => {
    if (leitura.estado === "lendo") return leitura.pausar();
    if (leitura.estado === "pausada") return leitura.continuar();
    if (voz) leitura.comecar(falas.flatMap(fala => falasCurtas(fala, idioma)), voz);
  };
  const [Icone, rotulo] = leitura.estado === "lendo" ? [Pause, t("meetings.summary.listenPause")]
    : leitura.estado === "pausada" ? [Play, t("meetings.summary.listenResume")]
    : [Volume2, t("meetings.summary.listen")];

  return <div className="flex flex-col items-start gap-1 sm:items-end">
    <div className="flex flex-wrap gap-2">
      {/* O mesmo botão vira Pausar e Continuar: o foco fica nele. */}
      <button ref={principal} type="button" onClick={aoClicar} aria-disabled={desligado || undefined} aria-describedby={aviso ? idDoAviso : undefined}
        className={`inline-flex items-center gap-2 rounded-lg border border-amber-300/40 px-3 py-1.5 text-sm font-semibold text-amber-100 ${desligado ? "cursor-not-allowed opacity-50" : "hover:bg-amber-300/10"}`}>
        <Icone size={15} aria-hidden/> {rotulo}
      </button>
      {leitura.estado !== "parada" && <button ref={botaoParar} type="button" onClick={leitura.parar}
        className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-1.5 text-sm text-white/70 hover:bg-white/5">
        <Square size={13} aria-hidden/> {t("meetings.summary.listenStop")}
      </button>}
    </div>
    {aviso && <p id={idDoAviso} className="max-w-xs text-xs text-white/50 sm:text-end">{aviso}</p>}
    {/* De onde vem o áudio, junto do botão (pedido da Cris de 23/11/2026). O
        texto dela, "áudio gerado pela IA da Google", não vale aqui: a voz é só
        a do próprio aparelho (escolherVoz), sem IA nem servidor. */}
    {!aviso && voz && <p className="max-w-xs text-xs text-white/50 sm:text-end">{t("meetings.summary.listenDeviceVoice")}</p>}
    {leitura.falhou && <p role="alert" className="max-w-xs text-xs text-red-200 sm:text-end">{t("meetings.summary.listenError")}</p>}
  </div>;
}
