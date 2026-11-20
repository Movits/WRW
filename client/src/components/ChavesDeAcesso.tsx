// As chaves de acesso da dona, no Perfil (A7 do desenho do gravador): entrar
// com Face ID, digital ou o bloqueio de tela, sem a senha. Aqui ela vê as
// chaves dos aparelhos dela, troca o nome, remove e ativa a deste aparelho.
//
// A seção só existe quando a função está disponível para este endereço (o
// `estado` da A6) e fora da casca das lojas, até a M1. A falha da lista é erro
// na tela (ErroDeConsulta), nunca "nenhuma chave".
//
// Ativar pede entrada recente (10 minutos, MINUTOS_PARA_CADASTRAR_CHAVE): depois
// disso o servidor responde CHAVE_REAUTENTICAR, e a seção pede a senha ali
// mesmo, entra de novo por `auth.login` e repete o pedido.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Fingerprint, KeyRound, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import {
  apelidoSugerido,
  avisarChavesQueValem,
  cadastrarAChave,
  codigoDoErroDaChave,
  ehCancelamento,
  ehChaveJaCadastrada,
  marcarConviteNoAparelho,
  mensagemDoErroDaChave,
  podeAtivarNesteAparelho,
  podeUsarChavesAqui,
} from "@/lib/chaves-de-acesso";
import { APELIDO_DA_CHAVE_MAX, CHAVES_POR_CONTA_MAX, ERRO_DA_CHAVE_DE_ACESSO } from "@shared/chaves-de-acesso";

const CLASSE_PRINCIPAL = "inline-flex items-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-50";
const CLASSE_SECUNDARIA = "inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm text-white/85 hover:bg-white/5 disabled:opacity-50";

/** A moldura das seções do Perfil (o `Section` de pages/Profile.tsx). */
function Moldura({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="chaves-de-acesso-titulo" className="bg-[#1b1714] border border-white/8 rounded-2xl overflow-hidden">
      <div className="px-6 pt-6 pb-4 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
            <Fingerprint size={16} aria-hidden="true" />
          </div>
          <div>
            <h2 id="chaves-de-acesso-titulo" className="text-white font-bold text-base leading-tight">{t("chavesDeAcesso.profile.title")}</h2>
            <p className="text-white/40 text-xs mt-0.5">{t("chavesDeAcesso.profile.subtitle")}</p>
          </div>
        </div>
      </div>
      <div className="p-6 space-y-4">{children}</div>
    </section>
  );
}

export function ChavesDeAcesso() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const [podeUsarChaves] = useState(() => podeUsarChavesAqui(window.navigator.userAgent));
  const estado = trpc.chavesDeAcesso.estado.useQuery(undefined, { enabled: podeUsarChaves, retry: false, refetchOnWindowFocus: false });
  const disponivel = podeUsarChaves && estado.data?.disponivel === true;
  const rpId = estado.data?.disponivel ? estado.data.rpId : null;
  const lista = trpc.chavesDeAcesso.listar.useQuery(undefined, { enabled: disponivel, retry: false, refetchOnWindowFocus: false });

  const [autenticadorProprio, setAutenticadorProprio] = useState(false);
  useEffect(() => {
    if (!podeUsarChaves) return;
    let ativo = true;
    void podeAtivarNesteAparelho().then(sim => ativo && setAutenticadorProprio(sim));
    return () => { ativo = false; };
  }, [podeUsarChaves]);

  const [renomeando, setRenomeando] = useState<{ id: string; apelido: string } | null>(null);
  const [removendo, setRemovendo] = useState<string | null>(null);
  const [ativando, setAtivando] = useState(false);
  const [pedindoSenha, setPedindoSenha] = useState(false);
  const [senha, setSenha] = useState("");

  const opcoesDeCadastro = trpc.chavesDeAcesso.opcoesDeCadastro.useMutation();
  const cadastrar = trpc.chavesDeAcesso.cadastrar.useMutation();
  const entrarDeNovo = trpc.auth.login.useMutation();
  const renomear = trpc.chavesDeAcesso.renomear.useMutation({
    onSuccess: () => {
      setRenomeando(null);
      toast.success(t("chavesDeAcesso.toast.renamed"));
      void utils.chavesDeAcesso.listar.invalidate();
    },
    onError: erro => toast.error(mensagemDoErroDaChave(erro, t)),
  });
  const remover = trpc.chavesDeAcesso.remover.useMutation({
    onError: erro => toast.error(mensagemDoErroDaChave(erro, t)),
  });

  const formatarData = (quando: number) => {
    try {
      return new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(new Date(quando));
    } catch {
      return new Date(quando).toLocaleDateString();
    }
  };

  /** Ativa a chave deste aparelho. Com CHAVE_REAUTENTICAR, pede a senha antes de repetir. */
  const ativar = async () => {
    if (ativando) return;
    setAtivando(true);
    try {
      const opcoes = await opcoesDeCadastro.mutateAsync();
      const resposta = await cadastrarAChave(opcoes);
      await cadastrar.mutateAsync({ resposta, apelido: apelidoSugerido(window.navigator.userAgent) });
      marcarConviteNoAparelho("ativada");
      setPedindoSenha(false);
      toast.success(t("chavesDeAcesso.toast.activated"));
      void utils.chavesDeAcesso.listar.invalidate();
    } catch (erro) {
      if (ehCancelamento(erro)) return;
      if (codigoDoErroDaChave(erro) === ERRO_DA_CHAVE_DE_ACESSO.reautenticar) {
        setPedindoSenha(true);
        return;
      }
      if (ehChaveJaCadastrada(erro)) marcarConviteNoAparelho("ativada");
      toast.error(mensagemDoErroDaChave(erro, t));
    } finally {
      setAtivando(false);
    }
  };

  /** A senha confirmada abre uma sessão nova (com o bloqueio por tentativas do login), e o cadastro se repete. */
  const confirmarSenhaEAtivar = async (evento: React.FormEvent) => {
    evento.preventDefault();
    if (!user?.email || !senha || entrarDeNovo.isPending) return;
    try {
      await entrarDeNovo.mutateAsync({ email: user.email, password: senha });
    } catch (erro) {
      // Senha errada (UNAUTHORIZED) tem a frase própria; o resto (muitas
      // tentativas, servidor fora do ar) segue a tradução de sempre. A frase do
      // servidor vem em português e não vai para a tela.
      const senhaErrada = (erro as { data?: { code?: string } } | null)?.data?.code === "UNAUTHORIZED";
      toast.error(senhaErrada ? t("chavesDeAcesso.profile.wrongPassword") : mensagemDoErroDaChave(erro, t));
      return;
    }
    setSenha("");
    setPedindoSenha(false);
    await ativar();
  };

  const confirmarRemocao = async (id: string) => {
    const chaves = lista.data ?? [];
    const removida = chaves.find(chave => chave.id === id);
    try {
      await remover.mutateAsync({ id });
    } catch {
      return;
    }
    setRemovendo(null);
    toast.success(t("chavesDeAcesso.toast.removed"));
    // O aparelho para de sugerir a chave removida (melhor esforço).
    if (rpId && removida) {
      const restantes = chaves.filter(chave => chave.id !== id).map(chave => chave.credencialId);
      void avisarChavesQueValem(rpId, removida.identificadorDaConta, restantes);
    }
    void utils.chavesDeAcesso.listar.invalidate();
  };

  if (!disponivel) return null;
  if (lista.isError) {
    return <Moldura><ErroDeConsulta erro={lista.error} aoTentarDeNovo={() => void lista.refetch()} /></Moldura>;
  }

  const chaves = lista.data ?? [];
  const noLimite = chaves.length >= CHAVES_POR_CONTA_MAX;

  return (
    <Moldura>
      {lista.isLoading ? (
        <p className="text-sm text-white/50">{t("chavesDeAcesso.profile.loading")}</p>
      ) : chaves.length === 0 ? (
        <p className="text-sm text-white/60">{t("chavesDeAcesso.profile.empty")}</p>
      ) : (
        <ul className="space-y-3">
          {chaves.map(chave => (
            <li key={chave.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
              {renomeando?.id === chave.id ? (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={evento => {
                    evento.preventDefault();
                    renomear.mutate({ id: chave.id, apelido: renomeando.apelido.trim() || null });
                  }}
                >
                  <label className="flex-1 min-w-[12rem] space-y-1">
                    <span className="block text-xs text-white/60">{t("chavesDeAcesso.profile.nameLabel")}</span>
                    <input
                      autoFocus
                      value={renomeando.apelido}
                      maxLength={APELIDO_DA_CHAVE_MAX}
                      onChange={evento => setRenomeando({ id: chave.id, apelido: evento.target.value })}
                      className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white"
                    />
                  </label>
                  <button type="submit" disabled={renomear.isPending} className={CLASSE_PRINCIPAL}>{t("chavesDeAcesso.profile.save")}</button>
                  <button type="button" onClick={() => setRenomeando(null)} className={CLASSE_SECUNDARIA}>{t("chavesDeAcesso.profile.cancel")}</button>
                </form>
              ) : (
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-semibold text-white break-words">
                      <KeyRound size={14} className="flex-shrink-0 text-amber-400" aria-hidden="true" />
                      {chave.apelido || t("chavesDeAcesso.profile.unnamed")}
                      {chave.sincronizada && (
                        <span className="rounded-full border border-white/15 px-2 py-0.5 text-[11px] font-normal text-white/60">
                          {t("chavesDeAcesso.profile.synced")}
                        </span>
                      )}
                    </p>
                    <p className="mt-1 text-xs text-white/50">
                      {t("chavesDeAcesso.profile.createdAt", { date: formatarData(chave.criadaEm) })}
                      {" · "}
                      {chave.ultimoUsoEm
                        ? t("chavesDeAcesso.profile.lastUsed", { date: formatarData(chave.ultimoUsoEm) })
                        : t("chavesDeAcesso.profile.neverUsed")}
                    </p>
                  </div>
                  {removendo !== chave.id && (
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => setRenomeando({ id: chave.id, apelido: chave.apelido ?? "" })} className={CLASSE_SECUNDARIA}>
                        <Pencil size={14} aria-hidden="true" /> {t("chavesDeAcesso.profile.rename")}
                      </button>
                      <button type="button" onClick={() => setRemovendo(chave.id)} className={CLASSE_SECUNDARIA}>
                        <Trash2 size={14} aria-hidden="true" /> {t("chavesDeAcesso.profile.remove")}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {removendo === chave.id && (
                <div className="space-y-2 rounded-xl border border-red-400/25 bg-red-500/[0.06] p-3">
                  <p id={`remover-chave-${chave.id}`} className="text-sm text-red-100/90">{t("chavesDeAcesso.profile.removeConfirm")}</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={remover.isPending}
                      onClick={() => void confirmarRemocao(chave.id)}
                      className="inline-flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-bold text-white hover:bg-red-400 disabled:opacity-50"
                    >
                      {remover.isPending ? t("chavesDeAcesso.profile.removing") : t("chavesDeAcesso.profile.removeYes")}
                    </button>
                    {/* Manter, a saída segura, recebe o foco, e a pergunta vai junto no anúncio. */}
                    <button
                      type="button"
                      autoFocus
                      aria-describedby={`remover-chave-${chave.id}`}
                      onClick={() => setRemovendo(null)}
                      className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/65 hover:bg-white/5"
                    >
                      {t("chavesDeAcesso.profile.removeNo")}
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs leading-relaxed text-white/40">{t("chavesDeAcesso.privacyNote")}</p>

      {pedindoSenha ? (
        <form onSubmit={evento => void confirmarSenhaEAtivar(evento)} className="space-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-sm text-white/80">{t("chavesDeAcesso.profile.reauthText")}</p>
          <label className="block space-y-1">
            <span className="block text-xs text-white/60">{t("chavesDeAcesso.profile.passwordLabel")}</span>
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={senha}
              onChange={evento => setSenha(evento.target.value)}
              className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={!senha || entrarDeNovo.isPending || ativando} className={CLASSE_PRINCIPAL}>
              {t("chavesDeAcesso.profile.reauthConfirm")}
            </button>
            <button type="button" onClick={() => { setPedindoSenha(false); setSenha(""); }} className={CLASSE_SECUNDARIA}>
              {t("chavesDeAcesso.profile.cancel")}
            </button>
          </div>
        </form>
      ) : (
        autenticadorProprio && (
          <div className="space-y-2">
            <button type="button" onClick={() => void ativar()} disabled={ativando || noLimite || lista.isLoading} className={CLASSE_PRINCIPAL}>
              <Fingerprint size={15} aria-hidden="true" />
              {ativando ? t("chavesDeAcesso.invite.activating") : t("chavesDeAcesso.invite.activate")}
            </button>
            {noLimite && (
              <p className="text-xs text-white/50">{t("chavesDeAcesso.profile.limitReached", { max: CHAVES_POR_CONTA_MAX })}</p>
            )}
          </div>
        )
      )}
    </Moldura>
  );
}
