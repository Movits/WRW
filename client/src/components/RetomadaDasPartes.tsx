import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { aoMudarOsDescartes, CHAVE_DOS_DESCARTES } from "@/lib/descartes-pendentes";
import { mensagemDaRecusaDaParte } from "@/lib/mensagem-de-erro";
import { aoMudarAsPartes } from "@/lib/partes-no-aparelho";
import {
  aoMudarOsFins, CHAVE_DOS_FINS, finsDa, partesPorEnviar, retomadaEmCurso, retomarPartesEFins, type ServidorDaGravacao,
} from "@/lib/retomada-das-partes";
import { useOcupacao } from "@/lib/sessao-ocupada";

/** De quanto em quanto tempo a retomada tenta de novo, enquanto houver parte ou fim da conta por enviar. */
export const NOVA_TENTATIVA_DAS_PARTES_MS = 30_000;

/**
 * O id do aviso da parte que o servidor recusou de vez: o mesmo aqui e na tela
 * de Reuniões, para a recusa seguinte trocar o texto em vez de empilhar avisos.
 */
export const ID_DO_AVISO_DA_PARTE_RECUSADA = "gravacao-parte-recusada";

/**
 * A retomada das partes da gravação e dos fins que o servidor não confirmou
 * (G13c), em toda tela logada: montada uma vez, no invólucro das telas
 * autenticadas (App.tsx, TelaAutenticada), ao lado da retomada dos descartes
 * (components/RetomadaDosDescartes.tsx), ela continua montada de uma tela
 * logada a outra. Antes só a tela de Reuniões retomava: a dona saía da tela
 * gravando (o que entrega a gravação, G13b), a última parte falhava por rede,
 * e nada tentava de novo até ela voltar a Reuniões; a ocupação do áudio por
 * enviar saía no desmonte, e fechar a aba não perguntava. Em 6 h, a varredura
 * de abandono do servidor fechava a reunião sem a última parte.
 *
 * Ao montar, conta o áudio da conta por enviar e faz uma volta da retomada da
 * conta logada (lib/retomada-das-partes.ts): as partes no aparelho, na ordem, e
 * depois os fins guardados. Enquanto sobrar parte ou fim da conta, tenta de
 * novo a cada 30 s; também quando não deu para saber (a conta fora do cache
 * por um instante, o aparelho bloqueado por outra aba), em vez de parar sem
 * aviso. Uma parte guardada ou apagada nesta aba, um fim guardado (nesta aba ou
 * em outra, pelo evento storage) e um descarte novo fazem a conta de novo.
 * Enquanto houver parte da conta no aparelho, a sessão fica ocupada
 * ("audio-nao-enviado"): o Sair, que apaga as partes do aparelho, e o fechar da
 * aba perguntam antes. As partes de outra conta e as da gravação descartada não
 * sobem nem ocupam.
 *
 * A tela de Reuniões faz a mesma retomada; com as duas montadas, a que chega
 * com a outra em curso pega carona nela, e a trava do navegador separa as
 * abas. A parte recusada de vez aqui avisa como lá, com o mesmo id; a da
 * gravação descartada no meio do envio não avisa (lib/retomada-das-partes.ts).
 */
export function RetomadaDasPartes() {
  const { t } = useTranslation();
  // O idioma de agora na hora do aviso, sem reiniciar a retomada quando ele muda.
  const traduzir = useRef(t);
  traduzir.current = t;
  const utils = trpc.useUtils();
  const [audioPorEnviar, setAudioPorEnviar] = useState(false);
  useOcupacao("audio-nao-enviado", audioPorEnviar);

  useEffect(() => {
    let montada = true;
    let relogio: number | undefined;
    // O que a última contagem que deu certo viu: com o aparelho ilegível por um
    // instante (outra aba bloqueando o IndexedDB), a sessão fica como estava.
    let pendente = false;
    let contagem: Promise<void> | null = null;
    let contarDeNovo = false;
    // A conta da sessão, do cache: o ProtectedRoute só desenha esta parte com ela carregada.
    const dona = () => utils.auth.me.getData()?.openId ?? null;
    const servidor: ServidorDaGravacao = {
      encerrarGravacao: (id, partes) => utils.client.meetings.encerrarGravacao.mutate({ meetingId: id, partes }),
      excluir: id => utils.client.meetings.delete.mutate({ meetingId: id }),
    };
    // O trecho recusado fica de fora da transcrição: a dona precisa saber, em
    // qualquer tela. O aviso fica até ser fechado, como em Reuniões.
    const avisarRecusa = (codigo?: string) => {
      toast.error(mensagemDaRecusaDaParte(codigo, traduzir.current), { id: ID_DO_AVISO_DA_PARTE_RECUSADA, duration: Infinity, closeButton: true });
    };

    // Uma tentativa marcada por vez, nunca duas em paralelo.
    const agendar = () => {
      if (!montada || relogio !== undefined) return;
      relogio = window.setTimeout(() => {
        relogio = undefined;
        void tentar();
      }, NOVA_TENTATIVA_DAS_PARTES_MS);
    };

    // Conta o áudio da conta por enviar: ocupa ou libera a sessão e, se sobrou
    // parte ou fim, marca a próxima tentativa.
    const contar = async () => {
      if (!montada) return;
      const quem = dona();
      if (quem === null) {
        // A conta fora do cache por um instante (invalidado no meio de uma
        // troca): nada ocupa a sessão em nome de ninguém, e a próxima tentativa
        // confere de novo. Nenhum evento a traria de volta sozinho.
        pendente = false;
        setAudioPorEnviar(false);
        agendar();
        return;
      }
      const partes = await partesPorEnviar(quem).catch(() => null);
      if (!montada) return;
      if (partes !== null) {
        pendente = partes > 0;
        setAudioPorEnviar(pendente);
      }
      // O aparelho ilegível (outra aba bloqueando o IndexedDB) não diz se
      // sobrou parte: a sessão fica como estava, e a próxima tentativa lê de
      // novo, em vez de parar até outra mudança.
      if (partes === null || pendente || finsDa(quem).length > 0) agendar();
    };
    // Uma contagem por vez: o que mudar no meio dela pede outra logo depois.
    const conferir = (): Promise<void> => {
      if (contagem) {
        contarDeNovo = true;
        return contagem;
      }
      contagem = (async () => {
        do {
          // Com a sessão já ocupada e uma volta da retomada em curso (desta
          // tela ou da de Reuniões), a contagem espera a volta: cada parte que
          // ela envia muda o aparelho e pediria outra contagem, e com a sessão
          // ocupada a contagem só poderia soltá-la, o que pode esperar. Com a
          // sessão livre conta na hora, para a parte nova ocupar sem esperar.
          const quem = dona();
          const volta = pendente && quem !== null ? retomadaEmCurso(quem) : undefined;
          if (volta) await volta;
          contarDeNovo = false;
          await contar();
        } while (contarDeNovo && montada);
      })().finally(() => {
        contagem = null;
      });
      return contagem;
    };
    const tentar = async () => {
      const quem = dona();
      if (quem !== null) await retomarPartesEFins(quem, { servidor, aoRecusar: (_parte, codigo) => avisarRecusa(codigo) });
      await conferir();
    };

    const pararDeOuvirAsPartes = aoMudarAsPartes(() => void conferir());
    const pararDeOuvirOsFins = aoMudarOsFins(() => void conferir());
    // A gravação descartada deixa de contar como áudio por enviar.
    const pararDeOuvirOsDescartes = aoMudarOsDescartes(() => void conferir());
    const aoMudarEmOutraAba = (evento: StorageEvent) => {
      if (evento.key === CHAVE_DOS_FINS || evento.key === CHAVE_DOS_DESCARTES || evento.key === null) void conferir();
    };
    window.addEventListener("storage", aoMudarEmOutraAba);
    // Conta antes da primeira volta: a sessão fica ocupada já ao montar, sem
    // esperar a volta terminar (numa rede lenta, ela leva minutos).
    void conferir().then(() => {
      if (montada) void tentar();
    });
    return () => {
      montada = false;
      window.clearTimeout(relogio);
      pararDeOuvirAsPartes();
      pararDeOuvirOsFins();
      pararDeOuvirOsDescartes();
      window.removeEventListener("storage", aoMudarEmOutraAba);
    };
  }, [utils]);

  return null;
}
