// Crédito da fonte de um dado de terceiro, em letra miúda embaixo do campo.
//
// Existe porque a licença dos dados do GeoNames (CC BY 4.0) libera o uso
// comercial e EXIGE crédito visível: a lista de países de shared/paises-gerados.ts
// aparece no cadastro e no perfil, e crédito
// copiado três vezes é crédito que some numa delas quando alguém mexe no
// layout. As cidades creditam pelo mesmo caminho, dentro de PaisEstadoCidade.
//
// O rótulo vem de fora ("Dados de países:", "Dados de cidades:") porque quem
// credita sabe o que está creditando; aqui só entra o nome e o link da fonte.

export interface CreditoDeDadosProps {
  /** Texto antes do nome da fonte, já traduzido. */
  rotulo: string;
  /** Nome da fonte, como o arquivo gerado o carimbou. */
  fonte: string;
  /** Endereço da fonte; sem ele o nome aparece sem link. */
  fonteUrl?: string;
  /** Classe do parágrafo, para cada tela manter o próprio visual. */
  className?: string;
}

export default function CreditoDeDados({
  rotulo,
  fonte,
  fonteUrl,
  className = "text-[11px] text-white/25 mt-1",
}: CreditoDeDadosProps) {
  if (!fonte) return null;
  return (
    <p className={className}>
      {rotulo}{" "}
      {fonteUrl ? (
        <a
          href={fonteUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="underline hover:text-white/40"
        >
          {fonte}
        </a>
      ) : (
        fonte
      )}
    </p>
  );
}
