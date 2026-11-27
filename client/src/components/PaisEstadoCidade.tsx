import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ArquivoDeCidades } from "@shared/cidade";
import { FONTE_DOS_PAISES, FONTE_DOS_PAISES_URL } from "@shared/paises";
import CampoComBusca from "@/components/CampoComBusca";
import CreditoDeDados from "@/components/CreditoDeDados";
import { carregarCidadesDoPais, paisTemLista } from "@/lib/busca-de-cidades";
import {
  deduzirEstado,
  estadosDoPais,
  filtrarOpcoes,
  paisPedeEstado,
  rotuloDoPais,
  sugerirCidades,
  sugerirPaises,
} from "@/lib/cascata-de-local";

// País → estado → cidade em cascata, no cadastro (Onboarding) e no perfil
// (Profile). Decisão do Roberto (26/11), no lugar do campo único de cidade da
// #142: primeiro o país; depois, se o país tem estados ou províncias, o estado;
// depois a cidade daquele estado. A regra fica em client/src/lib/cascata-de-local.ts.
//
// O que vai para o banco não mudou: país em código de duas letras, cidade em
// texto. O estado é só o filtro (ver cascata-de-local.ts), e por isso vive aqui
// dentro e não no formulário.
//
// A lista de cidades é UM ARQUIVO POR PAÍS, que o Vite separa num pedaço próprio
// (import.meta.glob em busca-de-cidades.ts): o navegador baixa só o país
// escolhido, e só quando ele é escolhido.
//
// Trocar o país limpa o estado e a cidade: cidade brasileira gravada com país
// Portugal seria um endereço que não existe.

export interface LocalEscolhido {
  pais: string;
  cidade: string;
}

export interface PaisEstadoCidadeProps {
  pais: string;
  cidade: string;
  onChange: (local: LocalEscolhido) => void;
  rotuloDoPais: string;
  rotuloDaCidade: string;
  /** Placeholder da cidade de cada tela; sem ele, o genérico "Busque ou digite a cidade". */
  placeholderDaCidade?: string;
  classeDoCampo?: string;
  classeDoRotulo?: string;
  /** Classe da grade que segura os três campos, para cada tela manter o próprio visual. */
  classeDaGrade?: string;
}

export default function PaisEstadoCidade({
  pais,
  cidade,
  onChange,
  rotuloDoPais: rotuloDoCampoPais,
  rotuloDaCidade,
  placeholderDaCidade,
  classeDoCampo,
  classeDoRotulo,
  classeDaGrade = "grid grid-cols-1 gap-4 sm:grid-cols-3",
}: PaisEstadoCidadeProps) {
  const { t, i18n } = useTranslation();
  const idioma = i18n.language || "pt-BR";
  const rotuloDeOutro = t("onboarding.countries.other");

  const [arquivo, setArquivo] = useState<ArquivoDeCidades | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [estado, setEstado] = useState("");

  const temLista = paisTemLista(pais);

  // Baixa a lista do país escolhido. O estado é deduzido UMA vez, na chegada do
  // arquivo, a partir da cidade que já estava gravada (perfil antigo, rascunho).
  useEffect(() => {
    setArquivo(null);
    if (!temLista) {
      setCarregando(false);
      return;
    }
    let vivo = true;
    setCarregando(true);
    carregarCidadesDoPais(pais)
      .then(carregado => {
        if (!vivo) return;
        setArquivo(carregado);
        if (carregado && cidade)
          setEstado(atual => atual || deduzirEstado(carregado, cidade));
      })
      .finally(() => {
        if (vivo) setCarregando(false);
      });
    return () => {
      vivo = false;
    };
    // A cidade entra só na chegada do arquivo: deduzir de novo a cada tecla
    // trocaria o estado enquanto a pessoa digita.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pais, temLista]);

  const pedeEstado = paisPedeEstado(arquivo);
  const estados = useMemo(
    () => (arquivo && pedeEstado ? estadosDoPais(arquivo, idioma) : []),
    [arquivo, pedeEstado, idioma]
  );

  const filtrarPaises = useCallback(
    (consulta: string) => sugerirPaises(idioma, rotuloDeOutro, consulta),
    [idioma, rotuloDeOutro]
  );
  const filtrarEstados = useCallback(
    (consulta: string) => filtrarOpcoes(estados, consulta),
    [estados]
  );
  const filtrarCidades = useCallback(
    (consulta: string) =>
      arquivo
        ? sugerirCidades(arquivo, pedeEstado ? estado : "", consulta)
        : [],
    [arquivo, pedeEstado, estado]
  );

  // Cidade antiga sem estado deduzido continua editável e busca no país inteiro;
  // sem cidade nenhuma, a cascata pede o estado antes.
  const cidadeEsperaEstado = pedeEstado && !estado && !cidade;
  const dicaDaCidade = !pais
    ? t("local.escolhaOPais")
    : carregando
      ? t("local.carregando")
      : !temLista
        ? t("local.semLista")
        : cidadeEsperaEstado
          ? t("local.escolhaOEstado")
          : undefined;

  const rotuloDoEstadoEscolhido =
    estados.find(e => e.valor === estado)?.rotulo ?? "";

  return (
    <div className={classeDaGrade}>
      <CampoComBusca
        rotulo={rotuloDoCampoPais}
        valorExibido={rotuloDoPais(pais, idioma, rotuloDeOutro)}
        filtrar={filtrarPaises}
        onEscolher={opcao => {
          if (opcao.valor === pais) return;
          setEstado("");
          onChange({ pais: opcao.valor, cidade: "" });
        }}
        placeholder={t("local.paisPlaceholder")}
        textoSemResultado={t("local.semResultado")}
        classeDoCampo={classeDoCampo}
        classeDoRotulo={classeDoRotulo}
        rodape={
          <CreditoDeDados
            rotulo={t("local.creditoPaises")}
            fonte={FONTE_DOS_PAISES}
            fonteUrl={FONTE_DOS_PAISES_URL}
          />
        }
      />
      {pedeEstado && (
        <CampoComBusca
          rotulo={t("local.estado")}
          valorExibido={rotuloDoEstadoEscolhido}
          filtrar={filtrarEstados}
          onEscolher={opcao => {
            if (opcao.valor === estado) return;
            setEstado(opcao.valor);
            // A cidade de outro estado deixa de valer.
            if (cidade) onChange({ pais, cidade: "" });
          }}
          placeholder={t("local.estadoPlaceholder")}
          textoSemResultado={t("local.semResultado")}
          classeDoCampo={classeDoCampo}
          classeDoRotulo={classeDoRotulo}
        />
      )}
      <CampoComBusca
        livre
        rotulo={rotuloDaCidade}
        valorExibido={cidade}
        filtrar={filtrarCidades}
        onTexto={texto => onChange({ pais, cidade: texto })}
        onEscolher={opcao => onChange({ pais, cidade: opcao.valor })}
        disabled={!pais || cidadeEsperaEstado}
        dica={dicaDaCidade}
        placeholder={placeholderDaCidade || t("local.cidadePlaceholder")}
        textoSemResultado={t("local.semResultado")}
        classeDoCampo={classeDoCampo}
        classeDoRotulo={classeDoRotulo}
        rodape={
          arquivo?.fonte ? (
            <CreditoDeDados
              rotulo={t("local.creditoCidades")}
              fonte={arquivo.fonte}
              fonteUrl={arquivo.fonteUrl}
            />
          ) : null
        }
      />
    </div>
  );
}
