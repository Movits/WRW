import { useTranslation } from "react-i18next";
import { Link, useParams } from "wouter";
import { Building2, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";

/**
 * O convite de uma entidade ao app (a base das associações, N1): quem abriu
 * o link vê o nome da entidade e vai ao cadastro ou à entrada. Público, sem
 * conta. O link errado, trocado ou de convênio encerrado diz só que o convite
 * não vale (o servidor responde igual nos três casos).
 */
export default function ConviteDaEntidade() {
  const { t } = useTranslation();
  const { token = "" } = useParams<{ token: string }>();
  const convite = trpc.conviteDeEntidade.ver.useQuery({ token }, { retry: false });

  return (
    <main className="min-h-screen text-white px-4 py-12 flex items-start justify-center">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/[0.03] p-6 space-y-5 text-center">
        <span className="mx-auto w-12 h-12 rounded-xl bg-white/[0.05] border border-white/10 flex items-center justify-center">
          <Building2 className="w-6 h-6 text-[#efcba8]" />
        </span>
        {convite.isLoading ? (
          <Loader2 className="mx-auto w-6 h-6 animate-spin text-white/50" aria-label={t("entidade.carregando")} />
        ) : convite.error && convite.error.data?.code !== "NOT_FOUND" ? (
          // Banco fora do ar é erro, nunca "convite inválido".
          <ErroDeConsulta erro={convite.error} aoTentarDeNovo={() => void convite.refetch()} />
        ) : convite.data ? (
          <>
            <h1 className="text-xl font-semibold break-words">{t("conviteDaEntidade.titulo", { nome: convite.data.nome })}</h1>
            <p className="text-sm text-white/60">{t("conviteDaEntidade.explicacao")}</p>
            <div className="flex flex-col gap-2">
              <Link href="/register" className="rounded-xl bg-[#c98f70] text-black px-4 py-2.5 text-sm font-medium">{t("conviteDaEntidade.criarConta")}</Link>
              <Link href="/login" className="rounded-xl border border-white/15 px-4 py-2.5 text-sm">{t("conviteDaEntidade.jaTenho")}</Link>
            </div>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold">{t("conviteDaEntidade.invalidoTitulo")}</h1>
            <p role="alert" className="text-sm text-white/60">{t("conviteDaEntidade.invalido")}</p>
            <Link href="/" className="inline-block rounded-xl border border-white/15 px-4 py-2.5 text-sm">{t("conviteDaEntidade.inicio")}</Link>
          </>
        )}
      </div>
    </main>
  );
}
