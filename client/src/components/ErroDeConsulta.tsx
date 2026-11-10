import { useTranslation } from "react-i18next";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";

/**
 * Estado de erro de uma consulta ao servidor (banco fora do ar, limite de
 * requisições, 500). As telas decidiam só por isLoading e pelo tamanho da
 * lista: a consulta falhava, `data` vinha undefined e a tela dizia "Sua rede
 * está vazia" com convite para cadastrar o primeiro contato — o contrário da
 * regra do servidor ("banco fora do ar é ERRO, nunca 'sem dados'") e um convite
 * a recadastrar e duplicar quando o banco voltasse.
 *
 * Recebe o ERRO, não a mensagem: é `mensagemDeErroParaTela` quem decide se o
 * texto é do servidor (envelope tRPC, já mascarado pelo errorFormatter) ou o
 * genérico traduzido (502 em HTML, rede fora).
 * Molde visual: o bloco de erro de RecommendedOpportunities (Dashboard).
 */
export function ErroDeConsulta({ erro, aoTentarDeNovo }: {
  erro?: unknown;
  aoTentarDeNovo?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="bg-[#1b1714] border border-white/8 rounded-2xl p-8 text-center">
      <div className="text-4xl mb-3">📡</div>
      <p className="text-white font-semibold text-sm">{t("errorBoundary.title")}</p>
      <p className="text-white/40 text-sm mt-1">{mensagemDeErroParaTela(erro, t)}</p>
      {aoTentarDeNovo && (
        <button type="button" onClick={aoTentarDeNovo}
          className="mt-4 px-5 py-2 rounded-xl text-xs font-semibold border border-[#c98f70]/30 text-[#c98f70] hover:bg-[#c98f70]/8 transition-colors">
          {t("errorBoundary.retryButton")}
        </button>
      )}
    </div>
  );
}
