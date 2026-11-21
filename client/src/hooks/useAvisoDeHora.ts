import { useCallback, useEffect, useRef, useState } from "react";
import { AVISO_DE_HORA_SEGUNDOS, PRAZO_DO_AVISO_DE_HORA_MS } from "@shared/const";
import type { EstadoDoGravador } from "./useGravadorDeAudio";

/** De quanto em quanto tempo o prazo do aviso aberto é conferido no relógio de parede. */
export const CONFERENCIA_DO_PRAZO_MS = 1000;

export type OpcoesDoAvisoDeHora = {
  /** O estado do gravador: o aviso abre só gravando, e some com a gravação parada. */
  estado: EstadoDoGravador;
  /** Os segundos GRAVADOS: o relógio do gravador, que não anda na pausa. */
  segundos: number;
  /** Retoma a gravação pausada (o continuar do gravador). */
  retomar: () => void;
  /** O prazo venceu sem o OK. Chamado uma vez por aviso. */
  aoExpirar: () => void;
};

export type AvisoDeHora = {
  /** O aviso está na tela, esperando o OK. */
  aberto: boolean;
  /** Quantas horas cheias de gravação o aviso anuncia (1, 2...). */
  horas: number;
  /** O "Continuar gravando": fecha o aviso e, com a gravação pausada, a retoma. */
  continuar: () => void;
};

/**
 * O aviso de hora da gravação em partes (G13a, decisão do Roberto de
 * 15/11/2026): a gravação não tem mais o teto de 10 minutos, e a cada hora
 * cheia de gravação um aviso pede um OK. Sem o OK em 10 minutos, `aoExpirar`
 * para a gravação e entrega o que foi gravado, como o Encerrar.
 *
 * As horas são de GRAVAÇÃO: contam os segundos do relógio do gravador, que não
 * anda na pausa. O prazo é de RELÓGIO DE PAREDE (Date.now), conferido a cada
 * segundo: na aba em segundo plano o navegador espaça os timers, e o tique que
 * chega atrasado, já depois do prazo, também expira o aviso.
 *
 * Retomar a gravação pelo botão do próprio gravador, com o aviso na tela, vale
 * como o OK: os dois botões dizem "Continuar gravando", e o aviso que ficasse
 * aberto pararia a gravação de quem acabou de mandar seguir.
 */
export function useAvisoDeHora(opcoes: OpcoesDoAvisoDeHora): AvisoDeHora {
  const atuais = useRef(opcoes);
  atuais.current = opcoes;
  const [aviso, setAviso] = useState<{ horas: number; venceEm: number } | null>(null);
  // A última hora cheia que já abriu aviso nesta gravação.
  const horasAvisadas = useRef(0);
  const estadoAnterior = useRef(opcoes.estado);
  const { estado, segundos } = opcoes;

  useEffect(() => {
    const anterior = estadoAnterior.current;
    estadoAnterior.current = estado;
    // Sem microfone (G17), a gravação continua em curso, como na pausa: as horas
    // já avisadas valem, e o aviso aberto segue esperando o OK.
    if (estado !== "gravando" && estado !== "pausado" && estado !== "semMicrofone") {
      // Parada, ou fechando o arquivo: nada a confirmar, e a próxima gravação
      // conta as horas do zero.
      horasAvisadas.current = 0;
      setAviso(null);
      return;
    }
    if (anterior === "pausado" && estado === "gravando") setAviso(null);
    const horas = Math.floor(segundos / AVISO_DE_HORA_SEGUNDOS);
    if (estado === "gravando" && horas > horasAvisadas.current) {
      horasAvisadas.current = horas;
      const venceEm = Date.now() + PRAZO_DO_AVISO_DE_HORA_MS;
      // O aviso ainda aberto guarda o prazo dele: a hora seguinte só o alcança
      // aberto quando os tiques atrasaram (aba congelada, notebook que dormiu),
      // e o que já venceu não ganha mais 10 minutos.
      setAviso(atual => ({ horas, venceEm: atual?.venceEm ?? venceEm }));
    }
  }, [estado, segundos]);

  useEffect(() => {
    if (!aviso) return;
    const relogio = window.setInterval(() => {
      if (Date.now() < aviso.venceEm) return;
      // Uma vez só: o relógio sai antes de chamar quem para a gravação.
      window.clearInterval(relogio);
      setAviso(null);
      atuais.current.aoExpirar();
    }, CONFERENCIA_DO_PRAZO_MS);
    return () => window.clearInterval(relogio);
  }, [aviso]);

  const continuar = useCallback(() => {
    setAviso(null);
    if (atuais.current.estado === "pausado") atuais.current.retomar();
  }, []);

  return { aberto: aviso !== null, horas: aviso?.horas ?? 0, continuar };
}
