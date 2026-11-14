import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Pedir de novo daqui a pouco. A tradução de uma reunião longa segue em segundo
 * plano no servidor (G8), que responde "em andamento" até ela estar guardada;
 * a tela pergunta de novo a cada `intervaloMs`.
 *
 * - `agendar()` liga `aguardando` e, passado o intervalo, soma 1 a `tentativa`
 *   (ponha `tentativa` nas dependências do efeito que faz o pedido);
 * - `parar()` desliga `aguardando` e cancela o pedido agendado;
 * - desmontar a tela, ou mudar a `chave` (outro idioma, outra reunião), cancela o
 *   agendado e desliga `aguardando`: o "em andamento" de um pedido não vale
 *   para o seguinte.
 */
export function useNovaTentativa(chave: string, intervaloMs = 5_000) {
  const [tentativa, setTentativa] = useState(0);
  const [aguardando, setAguardando] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Declarado antes do efeito da tela que faz o pedido: roda primeiro, e o
  // pedido do idioma novo já parte sem o aviso e sem o agendado do anterior.
  useEffect(() => {
    clearTimeout(timer.current);
    setAguardando(false);
  }, [chave]);
  const agendar = useCallback(() => {
    clearTimeout(timer.current);
    setAguardando(true);
    timer.current = setTimeout(() => setTentativa(n => n + 1), intervaloMs);
  }, [intervaloMs]);
  const parar = useCallback(() => {
    clearTimeout(timer.current);
    setAguardando(false);
  }, []);
  return { tentativa, aguardando, agendar, parar };
}
