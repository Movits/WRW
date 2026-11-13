import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { motivoDaOcupacao, useSessaoOcupada, type MotivoDaOcupacao } from "@/lib/sessao-ocupada";

type Traduzir = (chave: string) => string;

// Cada ramo chama t() com a chave literal, para o teste das chaves usadas
// (server/i18n-chaves-usadas.test.ts) conferir que todas existem.
function textoDoMotivo(t: Traduzir, motivo: MotivoDaOcupacao) {
  switch (motivo) {
    case "gravando": return t("sessaoOcupada.sairGravando");
    case "enviando": return t("sessaoOcupada.sairEnviando");
    case "audio-nao-enviado": return t("sessaoOcupada.sairAudioNaoEnviado");
  }
}

/**
 * O Sair da conta de todas as telas: o do menu global (components/AppHeader.tsx,
 * que o Dashboard também usa) e o do painel administrativo. Com a sessão
 * ocupada (lib/sessao-ocupada.ts), sair perderia a gravação, o envio ou o áudio
 * ainda não enviado, que só existem nesta aba: antes do logout, um diálogo diz o
 * motivo, e "Continuar aqui" é o botão padrão, com o foco (o AlertDialog foca o
 * Cancel ao abrir, e o Esc também fica). Sem ocupação, sai direto, como antes.
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

  function pedirSaida() {
    // Lido na hora do clique, e não o da última renderização.
    const motivoAgora = motivoDaOcupacao();
    if (!motivoAgora) {
      sair();
      return;
    }
    setMotivoDoClique(motivoAgora);
    setAberto(true);
  }

  const dialogo = (
    <AlertDialog open={aberto} onOpenChange={setAberto}>
      <AlertDialogContent className="border-white/15 bg-[#211e1b] text-white">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("sessaoOcupada.sairTitulo")}</AlertDialogTitle>
          <AlertDialogDescription className="text-white/70">
            {textoDoMotivo(t, motivo)} {t("sessaoOcupada.sairPerdeOAudio")}
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
