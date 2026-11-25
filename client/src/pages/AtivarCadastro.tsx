import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "wouter";
import { Building2, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { ehErroDaEntidade } from "@shared/entidades";

/**
 * A ativação do cadastro importado (a base das associações, N3): quem recebeu
 * da entidade o link de uso único confere os dados da empresa, marca o que
 * está certo do que a entidade mandou, cria a conta e segue para o cadastro
 * (o Termo Geral e a maioridade ficam lá). Público, sem conta. O link errado,
 * vencido, usado, trocado ou de convênio encerrado diz só que não vale (o
 * servidor responde igual em todos).
 */
export default function AtivarCadastro() {
  const { t, i18n } = useTranslation();
  const { token = "" } = useParams<{ token: string }>();
  const ativacao = trpc.ativacaoDeCadastro.ver.useQuery({ token }, { retry: false, refetchOnWindowFocus: false });
  const [empresa, setEmpresa] = useState("");
  const [tenho, setTenho] = useState<string[]>([]);
  const [preciso, setPreciso] = useState<string[]>([]);
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [repetida, setRepetida] = useState("");
  const [erro, setErro] = useState<string | null>(null);

  // Tudo o que a entidade mandou vem marcado; a pessoa desmarca o que não está certo.
  useEffect(() => {
    if (!ativacao.data) return;
    setEmpresa(ativacao.data.empresa);
    setTenho(ativacao.data.tenho);
    setPreciso(ativacao.data.preciso);
  }, [ativacao.data]);

  const ativar = trpc.ativacaoDeCadastro.ativar.useMutation({
    // A sessão já veio no cookie: a página inteira recarrega no cadastro, como no login.
    onSuccess: () => { window.location.href = "/onboarding"; },
    onError: e => setErro(ehErroDaEntidade(e.message) ? t(`entidade.erros.${e.message}`) : mensagemDeErroParaTela(e, t)),
  });

  const data = (ms: number) => new Date(ms).toLocaleDateString(i18n.language);
  const alternar = (lista: string[], definir: (l: string[]) => void, item: string) =>
    definir(lista.includes(item) ? lista.filter(i => i !== item) : [...lista, item]);

  function enviar(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    if (senha.length < 8) { setErro(t("ativarCadastro.senhaCurta")); return; }
    if (senha !== repetida) { setErro(t("ativarCadastro.senhasDiferentes")); return; }
    ativar.mutate({ token, nome, email, senha, empresa, tenho, preciso });
  }

  const campo = "w-full rounded-xl bg-white/[0.04] border border-white/10 px-3 py-2.5 text-sm placeholder:text-white/35 focus:outline-none focus:border-[#c98f70]/60";

  return (
    <main className="min-h-screen text-white px-4 py-12 flex items-start justify-center">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-white/[0.03] p-5 md:p-6 space-y-5">
        <span className="mx-auto w-12 h-12 rounded-xl bg-white/[0.05] border border-white/10 flex items-center justify-center">
          <Building2 className="w-6 h-6 text-[#efcba8]" />
        </span>
        {ativacao.isLoading ? (
          <Loader2 className="mx-auto w-6 h-6 animate-spin text-white/50" aria-label={t("entidade.carregando")} />
        ) : ativacao.error && ativacao.error.data?.code !== "NOT_FOUND" ? (
          // Banco fora do ar é erro, nunca "link inválido".
          <ErroDeConsulta erro={ativacao.error} aoTentarDeNovo={() => void ativacao.refetch()} />
        ) : ativacao.data ? (
          <form onSubmit={enviar} className="space-y-5">
            <div className="text-center space-y-1">
              <h1 className="text-xl font-semibold break-words">{t("ativarCadastro.titulo", { empresa: ativacao.data.empresa })}</h1>
              <p className="text-sm text-[#efcba8] break-words">{t("ativarCadastro.daEntidade", { entidade: ativacao.data.entidade })}</p>
            </div>
            <p className="text-sm text-white/60">{t("ativarCadastro.explicacao")}</p>

            <label className="block space-y-1">
              <span className="text-sm text-white/70">{t("ativarCadastro.empresa")}</span>
              <input value={empresa} onChange={e => setEmpresa(e.target.value)} maxLength={200} className={campo} />
            </label>

            <fieldset className="space-y-3">
              <legend className="text-sm text-white/60">{t("ativarCadastro.confirme")}</legend>
              <ListaDeItens titulo={t("ativarCadastro.tenho")} itens={ativacao.data.tenho} marcados={tenho}
                vazio={t("ativarCadastro.nenhumItem")} aoAlternar={item => alternar(tenho, setTenho, item)} />
              <ListaDeItens titulo={t("ativarCadastro.preciso")} itens={ativacao.data.preciso} marcados={preciso}
                vazio={t("ativarCadastro.nenhumItem")} aoAlternar={item => alternar(preciso, setPreciso, item)} />
            </fieldset>

            <div className="space-y-3">
              <label className="block space-y-1">
                <span className="text-sm text-white/70">{t("ativarCadastro.seuNome")}</span>
                <input value={nome} onChange={e => setNome(e.target.value)} required minLength={2} maxLength={100} autoComplete="name" className={campo} />
              </label>
              <label className="block space-y-1">
                <span className="text-sm text-white/70">{t("ativarCadastro.email")}</span>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} required maxLength={320} autoComplete="email" dir="ltr" className={campo} />
              </label>
              <label className="block space-y-1">
                <span className="text-sm text-white/70">{t("ativarCadastro.senha")}</span>
                <input type="password" value={senha} onChange={e => setSenha(e.target.value)} required minLength={8} maxLength={200} autoComplete="new-password" className={campo} />
              </label>
              <label className="block space-y-1">
                <span className="text-sm text-white/70">{t("ativarCadastro.confirmarSenha")}</span>
                <input type="password" value={repetida} onChange={e => setRepetida(e.target.value)} required minLength={8} maxLength={200} autoComplete="new-password" className={campo} />
              </label>
            </div>

            {erro && <p role="alert" className="text-sm text-red-300">{erro}</p>}
            <button type="submit" disabled={ativar.isPending}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-[#c98f70] text-black px-4 py-2.5 text-sm font-medium disabled:opacity-40">
              {ativar.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              {ativar.isPending ? t("ativarCadastro.ativando") : t("ativarCadastro.ativar")}
            </button>
            <p className="text-xs text-white/45">{t("ativarCadastro.depois")}</p>
            <p className="text-xs text-white/45">{t("ativarCadastro.validoAte", { data: data(ativacao.data.expiraEm) })}</p>
          </form>
        ) : (
          <div className="text-center space-y-4">
            <h1 className="text-xl font-semibold">{t("ativarCadastro.invalidoTitulo")}</h1>
            <p role="alert" className="text-sm text-white/60">{t("ativarCadastro.invalido")}</p>
            <Link href="/" className="inline-block rounded-xl border border-white/15 px-4 py-2.5 text-sm">{t("ativarCadastro.inicio")}</Link>
          </div>
        )}
      </div>
    </main>
  );
}

function ListaDeItens({ titulo, itens, marcados, vazio, aoAlternar }: {
  titulo: string; itens: string[]; marcados: string[]; vazio: string; aoAlternar: (item: string) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{titulo}</p>
      {itens.length ? (
        <ul className="space-y-1.5">
          {itens.map(item => (
            <li key={item}>
              <label className="flex items-start gap-2 text-sm text-white/80 cursor-pointer">
                <input type="checkbox" checked={marcados.includes(item)} onChange={() => aoAlternar(item)} className="mt-0.5 accent-[#c98f70]" />
                <span className="break-words min-w-0">{item}</span>
              </label>
            </li>
          ))}
        </ul>
      ) : <p className="text-xs text-white/45">{vazio}</p>}
    </div>
  );
}
