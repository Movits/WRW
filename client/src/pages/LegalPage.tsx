import { lazy, Suspense } from "react";
import { Link } from "wouter";
import { ArrowLeft, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { TIPOGRAFIA_DO_TERMO, textoDoTermoParaExibir } from "@/components/TermoGeralDeUso";
import { PoliticaDePrivacidade } from "@/components/PoliticaDePrivacidade";

// Páginas públicas de Privacidade e Termos, para onde o rodapé aponta.
//
// Até 15/09 as duas diziam que os textos "estão em elaboração com a assessoria
// jurídica". Isso deixou de ser verdade para os TERMOS quando o Termo Geral de
// Uso, Proteção de Dados e Intermediação Digital (Dr. Ronei, 14/09) virou a
// última etapa do cadastro: quem clicava no rodapé lia o contrário do que o
// cadastro mostra, e quem ainda não tem conta não tinha como ler o que vai
// aceitar. Agora /termos mostra o documento PUBLICADO, o mesmo texto e a mesma
// versão que o aceite registra, por um procedimento público que não devolve
// dado de usuária nenhuma (consent.termoGeralPublico).
//
// A Política de Privacidade dizia até 25/11/2026 que estava "sendo redigida".
// Desde então /privacidade mostra a política em documento próprio
// (components/PoliticaDePrivacidade.tsx): um texto provisório nosso, decidido
// pelo Roberto em 25/11, que vale até a Cris mandar o definitivo, porque o
// Google exige a política publicada para verificar o app. Não é versão de termo
// em document_versions (não tem aceite e não revoga nenhum).
//
// As duas telas seguem em pt-BR fixo, como o resto desta página sempre esteve
// (ver CLAUDE.md): o documento jurídico só existe em português, e traduzir a
// moldura em volta de um texto que não se traduz confundiria mais que ajudaria.

// Mesmo carregamento tardio do cadastro: o Streamdown traz KaTeX, Shiki e
// Mermaid, peso que só faz sentido baixar em quem abre o termo.
const Streamdown = lazy(() => import("streamdown").then(modulo => ({ default: modulo.Streamdown })));

function LegalShell({ title, children, largo = false }: { title: string; children: React.ReactNode; largo?: boolean }) {
  return (
    <div className="min-h-screen bg-[#151312] text-white antialiased">
      <nav className="border-b border-white/[0.05] px-6 py-4">
        <Link href="/">
          <span className="inline-flex items-center gap-2 text-white/50 hover:text-white transition-colors cursor-pointer text-sm">
            <ArrowLeft size={16} /> Voltar
          </span>
        </Link>
      </nav>
      <main className={`${largo ? "max-w-3xl" : "max-w-2xl"} mx-auto px-6 py-16`}>
        <h1 className="text-3xl font-extrabold mb-6">{title}</h1>
        <div className="space-y-4 text-white/60 text-sm leading-relaxed">{children}</div>
      </main>
    </div>
  );
}

export function PrivacyPage() {
  return (
    <LegalShell title="Política de Privacidade" largo>
      <PoliticaDePrivacidade />
    </LegalShell>
  );
}

export function TermsPage() {
  const termo = trpc.consent.termoGeralPublico.useQuery(undefined, {
    refetchOnWindowFocus: false,
    // Uma tentativa a mais e pronto. O padrão do React Query são três, com
    // espera crescente: numa falha de rede a página ficaria quase dez segundos
    // dizendo "carregando" antes de admitir que não conseguiu, e quem veio ler
    // o contrato merece o "tentar de novo" na mão mais cedo.
    retry: 1,
  });

  return (
    <LegalShell title="Termos de Uso" largo>
      {/* `isPending`, e não `isLoading`: no React Query 5 o `isLoading` é
          `isPending && isFetching`, então ele fica FALSO nos intervalos entre as
          tentativas de recarga. Com `isLoading` a página piscava "a versão
          vigente ainda não está publicada" enquanto a consulta ainda tentava —
          foi o que apareceu no primeiro smoke desta tela. */}
      {termo.isPending && !termo.isError && (
        <p className="flex items-center gap-2 text-white/40">
          <Loader2 size={14} className="animate-spin" /> Carregando o termo vigente...
        </p>
      )}

      {/* Banco fora do ar é ERRO, nunca "não há termo": dizer que o documento
          não foi publicado quando ele existe e a consulta é que falhou seria
          mentir para quem veio ler o contrato (ver "Acesso a dados" no
          CLAUDE.md). Por isso o erro tem ramo próprio, com "tentar de novo". */}
      {termo.isError && (
        <>
          <p>Não consegui carregar o termo agora.</p>
          <button type="button" onClick={() => void termo.refetch()}
            className="rounded-lg border border-white/20 px-3 py-1.5 text-xs text-white/70 hover:border-white/40 hover:text-white">
            Tentar de novo
          </button>
        </>
      )}

      {/* Sem versão publicada a página diz isso, em vez de mostrar um texto
          antigo escrito no código. */}
      {!termo.isPending && !termo.isError && !termo.data && (
        <>
          <p>
            O Termo Geral de Uso, Proteção de Dados e Intermediação Digital é o
            documento que rege a plataforma, e é aceito por toda usuária na
            última etapa do cadastro.
          </p>
          <p>
            A versão vigente ainda não está publicada nesta página. Se você
            precisa do texto agora, fale com a equipe da plataforma.
          </p>
        </>
      )}

      {termo.data && (
        <>
          <p className="text-white/40 text-xs">
            Versão {termo.data.version}, publicada em{" "}
            {new Date(termo.data.publishedAt).toLocaleDateString("pt-BR")}. É o
            mesmo texto que o cadastro apresenta para aceite.
          </p>
          <div lang="pt-BR" className={`pt-2 ${TIPOGRAFIA_DO_TERMO}`}>
            <Suspense fallback={<div className="whitespace-pre-wrap">{textoDoTermoParaExibir(termo.data.text)}</div>}>
              <Streamdown>{textoDoTermoParaExibir(termo.data.text)}</Streamdown>
            </Suspense>
          </div>
        </>
      )}
    </LegalShell>
  );
}
