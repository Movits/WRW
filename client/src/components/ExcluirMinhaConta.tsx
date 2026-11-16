// Zona de risco do perfil: o caminho para a dona excluir a própria conta.
//
// A tela pede o e-mail e a senha porque o servidor exige os dois
// (server/routers/conta.ts); o texto do que sai do banco vem da lista de
// chaves i18n `conta.excluir.itemN`, uma linha por módulo, porque "excluir a
// conta" não diz à dona que a rede de contatos, as reuniões transcritas e as
// negociações vão embora com ela.
//
// `requisitosDaExclusao` é consultado ANTES de mostrar o formulário: conta sem
// senha e última administradora são recusas do servidor que a tela precisa
// antecipar, senão a dona digita tudo para ouvir "não".

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { AlertTriangle, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { liberarTodas } from "@/lib/sessao-ocupada";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

const ITENS = ["item1", "item2", "item3", "item4", "item5"] as const;

export function ExcluirMinhaConta() {
  const { t } = useTranslation();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [aberto, setAberto] = useState(false);
  const [confirmacao, setConfirmacao] = useState("");
  const [senha, setSenha] = useState("");

  const requisitos = trpc.conta.requisitosDaExclusao.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  const excluir = trpc.conta.excluirMinhaConta.useMutation({
    onSuccess: (resultado) => {
      setAberto(false);
      // A conta e as linhas SAÍRAM nos dois casos. O que pode ter sobrado é
      // objeto no bucket que o storage recusou apagar (`arquivosComFalha`), e
      // dizer "excluídos" nessa hora seria mentir para quem acabou de pedir que
      // tudo saísse — achado do Nicolas, 14/09. O aviso fica mais tempo na tela
      // porque a navegação para "/" acontece logo em seguida.
      if (resultado.arquivosComFalha > 0) {
        toast.warning(t("conta.excluir.sucessoComPendencias", { quantidade: resultado.arquivosComFalha }), {
          duration: 15000,
        });
      } else {
        toast.success(t("conta.excluir.sucesso"));
      }
      // As ocupações da sessão saem com a conta (lib/sessao-ocupada.ts), como
      // no logout do useAuth: o envio avulso que segue no ar não pode deixar a
      // aba deslogada ocupada, nem fazer o navegador perguntar ao fechá-la ou
      // no próximo login nela. O diálogo do Sair não entra: a exclusão já tem a
      // confirmação dela.
      liberarTodas();
      // A conta não existe mais: o cache em memória é a única coisa que ainda
      // a considera logada.
      utils.auth.me.setData(undefined, null);
      navigate("/");
    },
    onError: (erro) => toast.error(erro.message),
  });

  const bloqueada = requisitos.data?.ultimaAdministradora || requisitos.data?.temSenha === false;
  const podeEnviar = confirmacao.trim().length > 0 && senha.length > 0 && !excluir.isPending;

  const fechar = () => {
    if (excluir.isPending) return;
    setAberto(false);
    setConfirmacao("");
    setSenha("");
  };

  return (
    <div className="mt-8 rounded-2xl border border-red-500/25 bg-red-500/[0.04] p-5">
      <div className="flex items-start gap-3">
        <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-red-400" />
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-red-300">{t("conta.excluir.titulo")}</h3>
          <p className="mt-1 text-xs leading-relaxed text-white/50">{t("conta.excluir.descricao")}</p>

          {requisitos.data?.ultimaAdministradora && (
            <p className="mt-3 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] p-3 text-xs text-amber-300">
              {t("conta.excluir.ultimaAdministradora")}
            </p>
          )}
          {requisitos.data?.temSenha === false && (
            <p className="mt-3 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] p-3 text-xs text-amber-300">
              {t("conta.excluir.semSenha")}
            </p>
          )}

          <Button
            variant="outline"
            disabled={bloqueada}
            onClick={() => setAberto(true)}
            className="mt-4 gap-2 border-red-500/30 bg-transparent text-red-300 hover:bg-red-500/10 hover:text-red-200 disabled:opacity-40"
          >
            <Trash2 size={14} />
            {t("conta.excluir.botao")}
          </Button>
        </div>
      </div>

      <Dialog open={aberto} onOpenChange={(estado) => (estado ? setAberto(true) : fechar())}>
        <DialogContent className="border-red-400/30 bg-[#211e1b] text-white">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-400">
              <AlertTriangle size={16} /> {t("conta.excluir.dialogoTitulo")}
            </DialogTitle>
            <DialogDescription className="text-sm text-white/70">
              {t("conta.excluir.dialogoTexto")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <ul className="space-y-1.5 rounded-xl border border-red-400/20 bg-red-400/[0.06] p-4">
              {ITENS.map((item) => (
                <li key={item} className="flex gap-2 text-xs leading-relaxed text-white/70">
                  <span className="text-red-400">•</span>
                  {t(`conta.excluir.${item}`)}
                </li>
              ))}
            </ul>
            <p className="text-xs font-semibold text-red-300">{t("conta.excluir.semVolta")}</p>

            <div className="space-y-1.5">
              <label htmlFor="exclusao-confirmacao" className="text-xs text-white/50">
                {t("conta.excluir.labelConfirmacao", { valor: requisitos.data?.confirmacaoEsperada ?? "" })}
              </label>
              <Input
                id="exclusao-confirmacao"
                value={confirmacao}
                onChange={(evento) => setConfirmacao(evento.target.value)}
                autoComplete="off"
                className="border-white/15 bg-white/5 text-white"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="exclusao-senha" className="text-xs text-white/50">
                {t("conta.excluir.labelSenha")}
              </label>
              <Input
                id="exclusao-senha"
                type="password"
                value={senha}
                onChange={(evento) => setSenha(evento.target.value)}
                autoComplete="current-password"
                className="border-white/15 bg-white/5 text-white"
              />
            </div>
          </div>

          <DialogFooter className="mt-2">
            <Button
              variant="outline"
              onClick={fechar}
              className="border-white/20 bg-transparent text-white/60"
            >
              {t("conta.excluir.cancelar")}
            </Button>
            <Button
              disabled={!podeEnviar}
              onClick={() => excluir.mutate({ senha, confirmacao })}
              className="bg-red-500 font-bold text-white hover:bg-red-600 disabled:opacity-40"
            >
              {excluir.isPending ? t("conta.excluir.excluindo") : t("conta.excluir.confirmar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
