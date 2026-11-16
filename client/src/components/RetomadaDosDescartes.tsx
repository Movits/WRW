import { useEffect, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import {
  aoMudarOsDescartes, aoTerminarUmDescarte, CHAVE_DOS_DESCARTES, descartesDa, esperaOServidor, retomarDescartes,
} from "@/lib/descartes-pendentes";
import { useOcupacao } from "@/lib/sessao-ocupada";

/** De quanto em quanto tempo a retomada tenta de novo, enquanto houver descarte guardado. */
export const NOVA_TENTATIVA_DOS_DESCARTES_MS = 30_000;

/**
 * O id do aviso do descarte que não terminou: a tela de Reuniões o abre quando
 * a exclusão falha; quem vê a exclusão terminar o fecha (a tela, e esta
 * retomada, para o aviso não ficar mentindo depois de a dona sair de Reuniões).
 */
export const ID_DO_AVISO_DO_DESCARTE_PENDENTE = "gravacao-descarte-pendente";

/**
 * A retomada dos descartes de gravação que não terminaram (G13b), em toda tela
 * logada, e não só na de Reuniões: montada uma vez, no invólucro das telas
 * autenticadas (App.tsx, TelaAutenticada), ela continua montada de uma tela
 * logada a outra. Antes a exclusão que falhava só era repetida com Reuniões
 * aberta: a dona descartava, a rede caía, ela ia para outra tela, e em 6 h a
 * varredura de abandono transcrevia o que fora descartado.
 *
 * Ao montar, tenta os descartes guardados da conta (lib/descartes-pendentes.ts);
 * enquanto sobrar algum, tenta de novo a cada 30 s. Um descarte novo nesta aba
 * (o Descartar que falhou) ou em outra (o evento storage) ocupa a sessão na
 * hora e marca a próxima tentativa. Enquanto algum ainda espera a exclusão no
 * servidor, a sessão fica ocupada ("descarte-pendente"): o Sair e o fechar da
 * aba perguntam antes, porque com a aba fechada nada tenta de novo.
 *
 * A tela de Reuniões repete os mesmos descartes na retomada dela, antes de
 * reenviar as partes; as duas juntas não fazem mal: a exclusão repetida dá
 * NOT_FOUND, que é feito.
 */
export function RetomadaDosDescartes() {
  const utils = trpc.useUtils();
  const [esperandoOServidor, setEsperandoOServidor] = useState(false);
  useOcupacao("descarte-pendente", esperandoOServidor);

  useEffect(() => {
    let montada = true;
    let relogio: number | undefined;
    let tentando = false;
    // A conta da sessão, do cache: o ProtectedRoute só desenha esta parte com ela carregada.
    const dona = () => utils.auth.me.getData()?.openId ?? null;
    const excluirNoServidor = (id: string) => utils.client.meetings.delete.mutate({ meetingId: id });

    // Relê a lista: ocupa ou libera a sessão e, se sobrou descarte da conta,
    // marca a próxima tentativa (uma só, nunca duas em paralelo).
    const conferir = () => {
      if (!montada) return;
      const quem = dona();
      setEsperandoOServidor(quem !== null && esperaOServidor(quem));
      if (quem !== null && descartesDa(quem).length > 0 && relogio === undefined) {
        relogio = window.setTimeout(() => {
          relogio = undefined;
          void tentar();
        }, NOVA_TENTATIVA_DOS_DESCARTES_MS);
      }
    };
    const tentar = async () => {
      const quem = dona();
      if (quem !== null && !tentando) {
        tentando = true;
        try {
          await retomarDescartes(quem, excluirNoServidor);
        } finally {
          tentando = false;
        }
      }
      conferir();
    };

    const pararDeOuvirALista = aoMudarOsDescartes(conferir);
    // A exclusão que uma retomada concluiu: o aviso de que ela não tinha
    // terminado sai, mesmo com a dona já fora de Reuniões.
    const pararDeOuvirOFim = aoTerminarUmDescarte(() => toast.dismiss(ID_DO_AVISO_DO_DESCARTE_PENDENTE));
    const aoMudarEmOutraAba = (evento: StorageEvent) => {
      if (evento.key === CHAVE_DOS_DESCARTES || evento.key === null) conferir();
    };
    window.addEventListener("storage", aoMudarEmOutraAba);
    void tentar();
    return () => {
      montada = false;
      window.clearTimeout(relogio);
      pararDeOuvirALista();
      pararDeOuvirOFim();
      window.removeEventListener("storage", aoMudarEmOutraAba);
    };
  }, [utils]);

  return null;
}
