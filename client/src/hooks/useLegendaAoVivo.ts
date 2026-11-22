import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  construtorDoReconhecimento, destinoDoErro, esperaParaReligar, juntarLinhas, lerResultados,
  REINICIOS_RAPIDOS_MAX, SESSAO_CURTA_MS, type FalhaDaLegenda, type ReconhecimentoDeVoz,
} from "@/lib/legenda-ao-vivo";

/**
 * O reconhecimento de voz do navegador por trás da legenda ao vivo (G15b; a
 * tela é components/LegendaAoVivo.tsx). Liga, religa quando o navegador
 * encerra a sessão sozinho (no silêncio, depois de um tempo, numa queda de
 * rede), pausa com a gravação e desliga.
 *
 * - `ativa`: a gravação está gravando. Pausada (G10) ou parada pelo aviso de
 *   hora, a legenda para de ouvir (o áudio deixa de ir ao serviço do
 *   navegador) e guarda o texto; na volta da gravação, volta a ouvir.
 * - `microfoneCaiu`: o microfone da gravação caiu (G17). A legenda desliga de
 *   vez, com o aviso, em vez de pausar: se foi ela que tomou o microfone, religá-
 *   la sozinha derrubaria a gravação de novo. A dona liga de novo se quiser.
 * - Sair da tela (o fim da gravação desmonta a legenda) desliga e esquece o
 *   texto: nada da legenda fica guardado.
 *
 * O texto: as linhas das sessões anteriores (confirmadas) e as finais da sessão
 * em curso, mais o provisório, que o navegador ainda reescreve. A memória da
 * aba guarda no máximo LINHAS_DA_LEGENDA_MAX linhas.
 */

export type EstadoDaLegenda = "desligada" | "ouvindo" | "pausada";

export function useLegendaAoVivo({ ativa, microfoneCaiu, etiqueta, separador }: {
  ativa: boolean;
  microfoneCaiu: boolean;
  /** A etiqueta BCP 47 do idioma em que a legenda ouve (lib/legenda-ao-vivo.ts, idiomaDaLegenda). */
  etiqueta: string;
  /** O que junta os trechos provisórios: espaço, ou nada no chinês e no japonês. */
  separador: string;
}) {
  const [ligada, setLigada] = useState(false);
  const [linhas, setLinhas] = useState<string[]>([]);
  const [provisorio, setProvisorio] = useState("");
  const [falha, setFalha] = useState<FalhaDaLegenda | null>(null);

  // O que os eventos do navegador leem fora do render.
  const querLigada = useRef(false);
  const ativaAgora = useRef(ativa);
  const etiquetaAgora = useRef(etiqueta);
  const separadorAgora = useRef(separador);
  etiquetaAgora.current = etiqueta;
  separadorAgora.current = separador;
  // O reconhecimento em curso: o evento de um que já não é este não mexe em nada.
  const reconhecimento = useRef<ReconhecimentoDeVoz | null>(null);
  const confirmadas = useRef<string[]>([]);
  const sessao = useRef({ inicio: 0, teveResultado: false, finais: [] as string[] });
  const falhasSeguidas = useRef(0);
  const relogio = useRef(0);
  // O navegador encerrou a sessão com a página escondida: religa quando ela voltar.
  const esperandoAPagina = useRef(false);
  // A legenda está na tela (o efeito de layout abaixo). A confirmação que volta
  // do servidor depois do fim da gravação não liga nada: o reconhecimento
  // aberto numa tela que já saiu ficaria ouvindo sem ninguém para soltá-lo.
  const montada = useRef(false);

  /** As finais da sessão que terminou passam a confirmadas; o provisório some. */
  const confirmarSessao = () => {
    confirmadas.current = juntarLinhas(confirmadas.current, sessao.current.finais);
    sessao.current = { ...sessao.current, finais: [] };
    setLinhas(confirmadas.current);
    setProvisorio("");
  };

  /** Solta o reconhecimento em curso sem que o fim dele religue nada. */
  const soltar = () => {
    window.clearTimeout(relogio.current);
    relogio.current = 0;
    esperandoAPagina.current = false;
    const atual = reconhecimento.current;
    reconhecimento.current = null;
    if (!atual) return;
    atual.onresult = null;
    atual.onerror = null;
    atual.onend = null;
    try {
      atual.abort();
    } catch {
      // Já parado: nada a soltar.
    }
  };

  const desligarDeVez = (motivo: FalhaDaLegenda | null) => {
    querLigada.current = false;
    soltar();
    confirmadas.current = [];
    sessao.current = { inicio: 0, teveResultado: false, finais: [] };
    setLinhas([]);
    setProvisorio("");
    setLigada(false);
    setFalha(motivo);
  };

  const podeOuvir = () => montada.current && querLigada.current && ativaAgora.current && reconhecimento.current === null;

  // Declarada antes de abrir, que a chama; abrir é function para as duas se
  // enxergarem.
  const agendar = (ms: number) => {
    window.clearTimeout(relogio.current);
    relogio.current = window.setTimeout(() => {
      relogio.current = 0;
      if (!podeOuvir()) return;
      if (document.visibilityState === "hidden") {
        esperandoAPagina.current = true;
        return;
      }
      abrir();
    }, ms);
  };

  function abrir() {
    const Construtor = construtorDoReconhecimento();
    let atual: ReconhecimentoDeVoz;
    try {
      if (!Construtor) throw new Error("sem reconhecimento");
      atual = new Construtor();
      atual.lang = etiquetaAgora.current;
      atual.continuous = true;
      atual.interimResults = true;
      atual.maxAlternatives = 1;
    } catch {
      desligarDeVez("naoResponde");
      return;
    }
    sessao.current = { inicio: Date.now(), teveResultado: false, finais: [] };
    atual.onresult = evento => {
      if (reconhecimento.current !== atual) return;
      const { finais, provisorio: agora } = lerResultados(evento.results, separadorAgora.current);
      sessao.current.finais = finais;
      if (finais.length || agora) sessao.current.teveResultado = true;
      setLinhas(juntarLinhas(confirmadas.current, finais));
      setProvisorio(agora);
    };
    atual.onerror = evento => {
      if (reconhecimento.current !== atual) return;
      const destino = destinoDoErro(evento.error);
      // "seguir": o fim da sessão vem logo depois e religa, contando a falha.
      if (destino.tipo === "desligar") desligarDeVez(destino.falha);
    };
    atual.onend = () => {
      if (reconhecimento.current !== atual) return;
      reconhecimento.current = null;
      confirmarSessao();
      if (!querLigada.current || !ativaAgora.current) return;
      // A página escondida (outra aba, o aparelho bloqueado): o navegador pode
      // não deixar ouvir. Religa quando ela voltar, sem contar falha.
      if (document.visibilityState === "hidden") {
        esperandoAPagina.current = true;
        return;
      }
      const curta = Date.now() - sessao.current.inicio < SESSAO_CURTA_MS && !sessao.current.teveResultado;
      falhasSeguidas.current = curta ? falhasSeguidas.current + 1 : 0;
      if (falhasSeguidas.current >= REINICIOS_RAPIDOS_MAX) {
        desligarDeVez("naoResponde");
        return;
      }
      agendar(esperaParaReligar(falhasSeguidas.current));
    };
    reconhecimento.current = atual;
    try {
      atual.start();
    } catch {
      // O navegador recusou o começo (outro reconhecimento ainda em curso):
      // conta como sessão curta e tenta de novo, até o limite.
      reconhecimento.current = null;
      falhasSeguidas.current += 1;
      if (falhasSeguidas.current >= REINICIOS_RAPIDOS_MAX) desligarDeVez("naoResponde");
      else agendar(esperaParaReligar(falhasSeguidas.current));
    }
  }

  // A gravação pausou ou voltou.
  useEffect(() => {
    ativaAgora.current = ativa;
    if (!querLigada.current) return;
    if (ativa) {
      falhasSeguidas.current = 0;
      if (podeOuvir()) abrir();
    } else {
      // Para de ouvir já; o texto da sessão fica.
      const atual = reconhecimento.current;
      soltar();
      if (atual) confirmarSessao();
    }
  }, [ativa]);

  // O microfone da gravação caiu: desliga de vez, com o aviso.
  useEffect(() => {
    if (microfoneCaiu && querLigada.current) desligarDeVez("microfoneDaGravacao");
  }, [microfoneCaiu]);

  // A página voltou a aparecer com a legenda esperando por ela.
  useEffect(() => {
    const aoMudar = () => {
      if (document.visibilityState !== "visible" || !esperandoAPagina.current) return;
      esperandoAPagina.current = false;
      falhasSeguidas.current = 0;
      if (podeOuvir()) abrir();
    };
    document.addEventListener("visibilitychange", aoMudar);
    return () => document.removeEventListener("visibilitychange", aoMudar);
  }, []);

  // Sair da tela solta o reconhecimento já, no commit (efeito de layout): o fim
  // da gravação desmonta a legenda, e a limpeza do efeito comum só viria depois
  // de o React terminar a troca de tela. E o Suspense do App, quando esconde a
  // página sem desmontá-la (a primeira ida a uma tela lazy), limpa só os efeitos
  // de layout. Na volta de um esconder, a legenda aparece desligada e sem texto.
  const escondida = useRef(false);
  useLayoutEffect(() => {
    montada.current = true;
    if (escondida.current) {
      escondida.current = false;
      desligarDeVez(null);
    }
    return () => {
      montada.current = false;
      escondida.current = true;
      querLigada.current = false;
      soltar();
    };
  }, []);

  /** Liga (a tela já tem a confirmação da dona). Com a gravação pausada, fica pausada até ela voltar. */
  const ligar = useCallback(() => {
    if (!montada.current || querLigada.current) return;
    querLigada.current = true;
    falhasSeguidas.current = 0;
    setFalha(null);
    setLigada(true);
    if (podeOuvir()) abrir();
  }, []);

  /** Desliga e esquece o texto. */
  const desligar = useCallback(() => desligarDeVez(null), []);

  const estado: EstadoDaLegenda = !ligada ? "desligada" : ativa ? "ouvindo" : "pausada";
  return { estado, linhas, provisorio, falha, ligar, desligar };
}
