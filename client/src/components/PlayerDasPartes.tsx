import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** Uma parte do áudio, no contrato `recording.partes` do servidor. */
export type ParteDoPlayer = { seq: number; url: string; mimeType: string; inicioSegundos: number; duracaoSegundos: number };

/** O que a transcrição usa para pular ao segundo de uma fala. */
export type ControleDoPlayer = { irPara: (segundo: number) => void };

/**
 * O player da reunião (D1 do desenho do gravador): toca as partes em sequência,
 * como uma gravação só — quem ouve não vê as partes. O envio único é uma parte
 * só, e aí é o player de sempre. `irPara(segundo)` acha a parte do segundo
 * (absoluto na reunião), troca para ela e começa a tocar dali.
 *
 * Sem onError o player falha MUDO (sessão vencida, limite de requisições,
 * storage fora do ar): `aoFalhar` deixa a tela explicar.
 */
export const PlayerDasPartes = forwardRef<ControleDoPlayer, { partes: ParteDoPlayer[]; aoFalhar?: () => void; aoCarregar?: () => void }>(
  function PlayerDasPartes({ partes, aoFalhar, aoCarregar }, ref) {
    const { t } = useTranslation();
    const audio = useRef<HTMLAudioElement | null>(null);
    const [indice, setIndice] = useState(0);
    // O ponto (em segundos dentro da parte) a aplicar quando a parte nova
    // carregar, e se ela deve tocar sozinha (a seguinte, ou um pulo).
    const pendente = useRef<{ dentro: number; tocar: boolean } | null>(null);

    useImperativeHandle(ref, () => ({
      irPara(segundo: number) {
        if (!partes.length) return;
        let alvo = partes.findIndex(p => segundo >= p.inicioSegundos && segundo < p.inicioSegundos + p.duracaoSegundos);
        if (alvo < 0) alvo = segundo < partes[0].inicioSegundos ? 0 : partes.length - 1;
        const dentro = Math.max(0, segundo - partes[alvo].inicioSegundos);
        if (alvo === indice && audio.current) {
          audio.current.currentTime = dentro;
          void audio.current.play().catch(() => {});
          return;
        }
        pendente.current = { dentro, tocar: true };
        setIndice(alvo);
      },
    }), [partes, indice]);

    if (!partes.length) return null;
    const atual = partes[Math.min(indice, partes.length - 1)];
    return (
      <audio
        ref={audio}
        key={atual.seq}
        controls
        preload="metadata"
        src={atual.url}
        className="w-full mt-4"
        data-parte={atual.seq}
        onError={() => aoFalhar?.()}
        onLoadedMetadata={() => {
          const p = pendente.current;
          pendente.current = null;
          if (p && audio.current) {
            audio.current.currentTime = p.dentro;
            // O navegador pode recusar tocar sem gesto: o player fica no ponto.
            if (p.tocar) void audio.current.play().catch(() => {});
          }
        }}
        onLoadedData={() => aoCarregar?.()}
        onEnded={() => {
          if (indice + 1 >= partes.length) return;
          pendente.current = { dentro: 0, tocar: true };
          setIndice(indice + 1);
        }}
      >
        {t("meetings.audioNotSupported")}
      </audio>
    );
  },
);
