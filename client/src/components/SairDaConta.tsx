import { useCallback, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { haAudioNoAparelhoParaOSair } from "@/lib/retomada-das-partes";
import { motivoDaOcupacao, useSessaoOcupada, type MotivoDaOcupacao } from "@/lib/sessao-ocupada";

type Traduzir = (chave: string) => string;

// O texto inteiro do diálogo para cada motivo. Cada ramo chama t() com a chave
// literal, para o teste das chaves usadas (server/i18n-chaves-usadas.test.ts)
// conferir que todas existem.
function textoDoMotivo(t: Traduzir, motivo: MotivoDaOcupacao) {
  switch (motivo) {
    case "gravando": return `${t("sessaoOcupada.sairGravando")} ${t("sessaoOcupada.sairPerdeOAudio")}`;
    case "enviando": return `${t("sessaoOcupada.sairEnviando")} ${t("sessaoOcupada.sairPerdeOAudio")}`;
    case "audio-nao-enviado": return `${t("sessaoOcupada.sairAudioNaoEnviado")} ${t("sessaoOcupada.sairPerdeOAudio")}`;
    // O descarte que não terminou (G13b) não guarda áudio a perder: o risco de
    // sair é o contrário, a gravação descartada seguir para a transcrição.
    case "descarte-pendente": return t("sessaoOcupada.sairDescartePendente");
  }
}

/**
 * O aviso de que o Sair não conseguiu revogar a sessão no servidor (banco fora
 * do ar, servidor sem resposta). Com a sessão de 90 dias (#179), um Sair que
 * falha calado deixaria a dona achar que saiu enquanto a sessão segue valendo
 * no servidor. O logout do useAuth relança esse erro; quem chama o Sair mostra
 * este aviso. Traduzido, como o diálogo, também no painel administrativo.
 */
export function useAvisoDeSairFalhou(): () => void {
  const { t } = useTranslation();
  return useCallback(() => {
    toast.error(t("sessaoOcupada.sairFalhou"));
  }, [t]);
}

/**
 * O Sair da conta de todas as telas: o do menu global (components/AppHeader.tsx,
 * que o Dashboard também usa) e o do painel administrativo. Com a sessão
 * ocupada (lib/sessao-ocupada.ts), sair perderia a gravação, o envio ou o áudio
 * ainda não enviado, que só existem nesta aba: antes do logout, um diálogo diz o
 * motivo, e "Continuar aqui" é o botão padrão, com o foco (o AlertDialog foca o
 * Cancel ao abrir, e o Esc também fica). Sem ocupação, sai direto, como antes.
 *
 * O registro em memória não basta: o Sair apaga as partes da gravação que
 * ficaram no aparelho (liberarTodas), e a contagem que as põe no registro pode
 * estar atrasada ou ter falhado (T19, iPhone em modo avião, 26/11/2026). Com o
 * registro livre, o clique pergunta ao aparelho (haAudioNoAparelhoParaOSair)
 * antes de sair; com parte lá, o diálogo do áudio não enviado abre.
 *
 * Devolve o pedido de saída, para o botão, e o diálogo, que quem usa desenha
 * FORA do menu que se fecha ao clicar: dentro dele, o diálogo sumiria junto.
 * A guarda de que toda saída passa por aqui está em SairDaConta.test.tsx.
 */
export function useSairDaConta(sair: () => void): { pedirSaida: () => void; dialogo: ReactNode } {
  const { t } = useTranslation();
  const sessao = useSessaoOcupada();
  const [aberto, setAberto] = useState(false);
  // O motivo da hora do clique. Não volta a null ao fechar: o texto não pode
  // sumir enquanto o diálogo ainda se desfaz na tela.
  const [motivoDoClique, setMotivoDoClique] = useState<MotivoDaOcupacao>("gravando");
  // Aberto, o texto acompanha a sessão: a gravação que para sozinha no limite
  // vira áudio por enviar. Se ela desocupa com o diálogo na tela (o envio que
  // termina), fica o motivo do clique, e nada sai sem a dona escolher.
  const motivo = sessao.motivo ?? motivoDoClique;

  // A conferência do aparelho em curso: o segundo toque não sai por ela.
  const conferindo = useRef(false);

  function perguntar(motivoAgora: MotivoDaOcupacao) {
    setMotivoDoClique(motivoAgora);
    setAberto(true);
  }

  function pedirSaida() {
    if (conferindo.current) return;
    // Lido na hora do clique, e não o da última renderização.
    const motivoAgora = motivoDaOcupacao();
    if (motivoAgora) return perguntar(motivoAgora);
    // Sem IndexedDB no navegador, nada ficou no aparelho: sai direto.
    if (typeof indexedDB === "undefined") return sair();
    conferindo.current = true;
    void haAudioNoAparelhoParaOSair().then(haAudio => {
      conferindo.current = false;
      // O registro pode ter mudado enquanto o aparelho respondia.
      const motivoDepois = motivoDaOcupacao();
      if (motivoDepois) return perguntar(motivoDepois);
      if (haAudio) return perguntar("audio-nao-enviado");
      sair();
    });
  }

  const dialogo = (
    <AlertDialog open={aberto} onOpenChange={setAberto}>
      <AlertDialogContent className="border-white/15 bg-[#211e1b] text-white">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("sessaoOcupada.sairTitulo")}</AlertDialogTitle>
          <AlertDialogDescription className="text-white/70">
            {textoDoMotivo(t, motivo)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="border-0 bg-[#c98f70] font-semibold text-[#1a120c] hover:bg-[#efcba8] hover:text-[#1a120c]">
            {t("sessaoOcupada.continuarAqui")}
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => sair()} className="border border-red-500/40 bg-transparent text-red-300 hover:bg-red-500/10 hover:text-red-200">
            {t("sessaoOcupada.sairMesmoAssim")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { pedirSaida, dialogo };
}
