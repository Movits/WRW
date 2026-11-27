// Gera as listas de cidade de client/src/data/cidades/<CC>.json, que alimentam
// o campo de cidade do cadastro e do perfil.
//
// POR QUE UM GERADOR, E NÃO UMA LISTA ESCRITA À MÃO: são dezenas de milhares de
// cidades em 250 países, cada uma com nome em vários idiomas. Lista escrita à
// mão envelhece, tem erro de digitação e nunca cobre o mundo. Aqui os dados
// saem de fonte pública, o arquivo diz de onde veio, e refazer é um comando.
//
// DUAS FONTES, POR DESENHO:
//
//  --ibge   Brasil, a partir de client/src/data/municipios-br.json, que JÁ está
//           no repositório. Não baixa nada. O IBGE tem os 5.571 municípios, que
//           é a unidade que a brasileira espera escrever; o GeoNames tem 4.422
//           registros brasileiros com população ≥ 5.000 e mistura distrito com
//           município. (Ironia útil: a própria página de fontes do GeoNames diz
//           que o dado brasileiro vem do IBGE — trocar seria pegar a mesma
//           origem com perda.)
//
//  --entrada <pasta>   Resto do mundo, a partir do dump do GeoNames já baixado e
//           DESCOMPACTADO nessa pasta. "Resto do mundo" ao pé da letra: a rodada
//           sem --paises PULA o Brasil, para não trocar os 5.571 municípios do
//           IBGE pelos 4.422 registros do GeoNames sem ninguém pedir. Quem
//           quiser a versão do GeoNames precisa escrever --paises BR.
//           O script não baixa sozinho porque os
//           arquivos são .zip (o Node não lê zip sem dependência nova) e um
//           deles tem 195 MB: baixar a cada execução seria desperdício, e no CI
//           seria 200 MB por PR para um resultado que muda de mês em mês.
//
//           Baixe e descompacte antes (qualquer descompactador serve):
//             https://download.geonames.org/export/dump/cities5000.zip        (5,4 MB)
//             https://download.geonames.org/export/dump/alternateNamesV2.zip  (195 MB)
//             https://download.geonames.org/export/dump/admin1CodesASCII.txt  (148 KB)
//           A pasta precisa conter cities5000.txt (ou cities15000.txt, com
//           --cidades), alternateNamesV2.txt e, opcionalmente, admin1CodesASCII.txt.
//
// LICENÇA: os dados do GeoNames são CC BY 4.0 — uso comercial liberado, CRÉDITO
// VISÍVEL OBRIGATÓRIO. O crédito é automático: cada arquivo gerado carrega
// `fonte` e `fonteUrl` no cabeçalho, e PaisEstadoCidade mostra os dois como link
// embaixo do campo de cidade, nas telas de cadastro e de perfil. Gerar um país
// sem esses dois campos é publicar dado de terceiro sem creditar ninguém — por
// isso server/cidades-geradas.test.ts os exige em todo arquivo versionado. Ver
// docs/arquitetura/cidades.md. O dado do IBGE é público e também vai creditado.
//
// LIMITE DE TAMANHO: nome com mais de 100 caracteres é descartado e relatado —
// `user_profiles.city` é varchar(100), e sugerir o que o servidor recusaria
// seria entregar um erro de gravação a quem escolheu da lista.
//
// USO:
//   node scripts/gerar-cidades.mjs --ibge
//   node scripts/gerar-cidades.mjs --entrada ~/geonames
//   node scripts/gerar-cidades.mjs --entrada ~/geonames --paises DE,GB,PT --minimo 15000
//   node scripts/gerar-cidades.mjs --entrada ~/geonames --simular
//
// OPÇÕES:
//   --ibge              gera só o BR.json, a partir do arquivo do repositório.
//   --entrada <pasta>   pasta com o dump do GeoNames descompactado.
//   --paises A,B,C      só estes países (padrão: todos os que aparecerem, menos
//                       o BR; pedir "--paises BR" gera o Brasil pelo GeoNames,
//                       por cima do arquivo do IBGE).
//   --minimo <n>        população mínima da cidade (padrão: 5000).
//   --cidades <arq>     nome do arquivo de cidades dentro da pasta
//                       (padrão: cities5000.txt).
//   --simular           só relata o que geraria, com o peso por país; não escreve.
//
// Rode a partir da raiz do repositório. Não precisa de banco nem de .env.

import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  apelidoServe,
  lerLinhaDeAdmin1,
  lerLinhaDeApelido,
  lerLinhaDeCidade,
  LIMITE_DO_NOME,
  montarArquivoDePais,
  montarArquivoDoBrasil,
  montarChaveDeBusca,
  PAIS_DO_IBGE,
  paisSaiDoGeoNames,
} from "./cidades/montagem.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAIDA = path.join(RAIZ, "client", "src", "data", "cidades");
const MUNICIPIOS_BR = path.join(
  RAIZ,
  "client",
  "src",
  "data",
  "municipios-br.json"
);

/** Guardar 200 apelidos de Londres para usar 12 é desperdício de memória; corta na leitura. */
const APELIDOS_GUARDADOS_POR_CIDADE = 40;

// ── argumentos ──────────────────────────────────────────────────────────────

function lerArgumentos(argv) {
  const opcoes = {
    ibge: false,
    entrada: "",
    paises: null,
    minimo: 5000,
    cidades: "cities5000.txt",
    simular: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ibge") opcoes.ibge = true;
    else if (arg === "--simular") opcoes.simular = true;
    else if (arg === "--entrada") opcoes.entrada = argv[++i] || "";
    else if (arg === "--cidades") opcoes.cidades = argv[++i] || opcoes.cidades;
    else if (arg === "--minimo") opcoes.minimo = Number(argv[++i]) || 0;
    else if (arg === "--paises") {
      const lista = (argv[++i] || "")
        .split(",")
        .map(p => p.trim().toUpperCase())
        .filter(Boolean);
      opcoes.paises = lista.length ? new Set(lista) : null;
    } else if (arg === "--ajuda" || arg === "-h" || arg === "--help")
      opcoes.ajuda = true;
    else {
      console.error(`Opção desconhecida: ${arg}`);
      opcoes.ajuda = true;
    }
  }
  return opcoes;
}

function mostrarUso() {
  console.log(`
Gera client/src/data/cidades/<CC>.json.

  node scripts/gerar-cidades.mjs --ibge                 Brasil, do arquivo do repositório (não baixa nada)
  node scripts/gerar-cidades.mjs --entrada <pasta>      resto do mundo (sem o Brasil), do dump do GeoNames descompactado

Para o resto do mundo, baixe e descompacte antes, na mesma pasta:
  https://download.geonames.org/export/dump/cities5000.zip        (5,4 MB)
  https://download.geonames.org/export/dump/alternateNamesV2.zip  (195 MB)
  https://download.geonames.org/export/dump/admin1CodesASCII.txt  (148 KB)

Opções: --paises BR,PT,US  --minimo 5000  --cidades cities5000.txt  --simular
Dados do GeoNames em CC BY 4.0: o crédito vai no cabeçalho de cada arquivo
(fonte/fonteUrl) e aparece em tela embaixo do campo de cidade.
`);
}

// ── aviso comum: nome que não cabe no banco ─────────────────────────────────

/**
 * Nome descartado por passar de LIMITE_DO_NOME não pode sair em silêncio: a
 * cidade some da lista e ninguém saberia por quê. O relatório mostra os
 * primeiros e conta o resto.
 */
function avisarDescartadas(pais, descartadas) {
  if (!descartadas.length) return;
  console.warn(
    `  ${pais}: ${descartadas.length} nome(s) com mais de ${LIMITE_DO_NOME} caracteres descartado(s) — não caberiam em user_profiles.city (varchar(100)):`
  );
  for (const nome of descartadas.slice(0, 5))
    console.warn(`    ${nome.length} caracteres: ${nome}`);
  if (descartadas.length > 5)
    console.warn(`    ...e mais ${descartadas.length - 5}.`);
}

// ── Brasil, pelo arquivo do IBGE que já está no repositório ─────────────────

function gerarBrasil() {
  const bruto = JSON.parse(readFileSync(MUNICIPIOS_BR, "utf8"));
  const { arquivo, descartadas, foraDoFormato } = montarArquivoDoBrasil(bruto);

  if (foraDoFormato.length)
    console.warn(
      `  ${foraDoFormato.length} entrada(s) fora do formato "Nome (UF)" foram ignoradas.`
    );
  avisarDescartadas("BR", descartadas);

  return arquivo;
}

// ── resto do mundo, pelo dump do GeoNames ──────────────────────────────────

async function porLinha(arquivo, aoLer) {
  const leitor = createInterface({
    input: createReadStream(arquivo, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const linha of leitor) aoLer(linha);
}

async function gerarDoGeoNames(opcoes) {
  const arquivoDeCidades = path.join(opcoes.entrada, opcoes.cidades);
  const arquivoDeApelidos = path.join(opcoes.entrada, "alternateNamesV2.txt");
  const arquivoDeAdmins = path.join(opcoes.entrada, "admin1CodesASCII.txt");

  if (!existsSync(arquivoDeCidades)) {
    console.error(`Não achei ${arquivoDeCidades}.`);
    console.error(
      "Baixe cities5000.zip do GeoNames, descompacte e aponte --entrada para a pasta."
    );
    process.exit(1);
  }

  // 1) rótulo das divisões administrativas (opcional: sem ele a lista mostra o código)
  const rotulosDeAdmin = new Map();
  if (existsSync(arquivoDeAdmins)) {
    await porLinha(arquivoDeAdmins, linha => {
      const admin = lerLinhaDeAdmin1(linha);
      if (admin)
        rotulosDeAdmin.set(`${admin.pais}.${admin.codigo}`, admin.rotulo);
    });
    console.log(`  ${rotulosDeAdmin.size} divisões administrativas lidas.`);
  } else {
    console.warn(
      "  admin1CodesASCII.txt ausente: a lista vai mostrar o código da divisão, não o nome."
    );
  }

  // 2) cidades acima do corte de população, indexadas pelo id do GeoNames
  const porId = new Map();
  const porPais = new Map();
  await porLinha(arquivoDeCidades, linha => {
    const cidade = lerLinhaDeCidade(linha);
    if (!cidade) return;
    if (cidade.populacao < opcoes.minimo) return;
    // A rodada mundial pula o Brasil de propósito: o BR.json vem do IBGE e
    // sobrescrevê-lo aqui trocaria 5.571 municípios por 4.422 registros.
    if (!paisSaiDoGeoNames(cidade.pais, opcoes.paises)) return;
    const registro = { ...cidade, apelidos: [] };
    porId.set(cidade.id, registro);
    if (!porPais.has(cidade.pais)) porPais.set(cidade.pais, []);
    porPais.get(cidade.pais).push(registro);
  });
  console.log(
    `  ${porId.size} cidades com população ≥ ${opcoes.minimo} em ${porPais.size} países.`
  );
  if (!opcoes.paises)
    console.log(
      `  ${PAIS_DO_IBGE} ficou de fora: a lista brasileira vem do IBGE (node scripts/gerar-cidades.mjs --ibge).`
    );
  if (!porId.size) {
    console.error(
      "Nenhuma cidade passou no corte. Confira --minimo e --paises."
    );
    process.exit(1);
  }

  // 3) apelidos: 195 MB lidos em fluxo, guardando só o que interessa
  const anoDeHoje = new Date().getUTCFullYear();
  if (existsSync(arquivoDeApelidos)) {
    let guardados = 0;
    await porLinha(arquivoDeApelidos, linha => {
      const apelido = lerLinhaDeApelido(linha);
      if (!apelido) return;
      const cidade = porId.get(apelido.id);
      if (!cidade) return;
      if (cidade.apelidos.length >= APELIDOS_GUARDADOS_POR_CIDADE) return;
      if (!apelidoServe(apelido, anoDeHoje)) return;
      cidade.apelidos.push(apelido);
      guardados++;
    });
    console.log(`  ${guardados} nomes em outros idiomas guardados.`);
  } else {
    console.warn(
      `  ${arquivoDeApelidos} ausente: as cidades ficam SÓ com o nome local.`
    );
    console.warn(
      "  Sem ele, digitar 'Munich' não acha 'München'. Baixe alternateNamesV2.zip."
    );
  }

  // 4) um arquivo por país
  const arquivos = [];
  for (const [pais, cidades] of porPais) {
    const admins = {};
    for (const cidade of cidades) {
      if (!cidade.admin1) continue;
      const rotulo = rotulosDeAdmin.get(`${pais}.${cidade.admin1}`);
      admins[cidade.admin1] = rotulo || cidade.admin1;
    }
    const { arquivo, descartadas } = montarArquivoDePais({
      pais,
      // O crédito da CC BY 4.0 sai daqui para a tela: `fonte` e `fonteUrl` são
      // o que PaisEstadoCidade mostra embaixo do campo (ver docs/arquitetura/cidades.md).
      fonte: `GeoNames ${opcoes.cidades.replace(".txt", "")} (CC BY 4.0)`,
      fonteUrl: "https://www.geonames.org",
      ordem: "populacao-desc",
      admins,
      cidades: cidades.map(cidade => ({
        nome: cidade.nome,
        admin: cidade.admin1,
        populacao: cidade.populacao,
        chave: montarChaveDeBusca(
          {
            nome: cidade.nome,
            asciiname: cidade.asciiname,
            apelidos: cidade.apelidos,
          },
          anoDeHoje
        ),
      })),
    });
    avisarDescartadas(pais, descartadas);
    arquivos.push(arquivo);
  }
  return arquivos;
}

// ── escrita e relatório ────────────────────────────────────────────────────

function escrever(arquivos, simular) {
  if (!simular) mkdirSync(SAIDA, { recursive: true });
  let total = 0;
  const linhas = [];
  for (const arquivo of arquivos.sort((a, b) => a.pais.localeCompare(b.pais))) {
    const texto = JSON.stringify(arquivo) + "\n";
    const bytes = Buffer.byteLength(texto, "utf8");
    total += bytes;
    linhas.push(
      `  ${arquivo.pais}  ${String(arquivo.cidades.length).padStart(6)} cidades  ${String(Math.round(bytes / 1024)).padStart(5)} KB  (${arquivo.ordem})`
    );
    if (!simular)
      writeFileSync(path.join(SAIDA, `${arquivo.pais}.json`), texto, "utf8");
  }
  for (const linha of linhas) console.log(linha);
  console.log(
    `\n${arquivos.length} arquivo(s), ${Math.round(total / 1024)} KB no total${simular ? " (simulação: nada foi escrito)" : ""}.`
  );
  if (!simular) console.log(`Escritos em ${path.relative(RAIZ, SAIDA)}.`);
}

// ── comando ─────────────────────────────────────────────────────────────────

const opcoes = lerArgumentos(process.argv.slice(2));

if (opcoes.ajuda || (!opcoes.ibge && !opcoes.entrada)) {
  mostrarUso();
  process.exit(opcoes.ajuda ? 0 : 1);
}

if (opcoes.ibge) {
  console.log("Brasil, a partir de client/src/data/municipios-br.json:");
  escrever([gerarBrasil()], opcoes.simular);
} else {
  console.log(`GeoNames, a partir de ${opcoes.entrada}:`);
  const arquivos = await gerarDoGeoNames(opcoes);
  escrever(arquivos, opcoes.simular);
  console.log(
    "\nDados do GeoNames em CC BY 4.0: o crédito foi gravado no cabeçalho de cada arquivo"
  );
  console.log(
    "(fonte/fonteUrl) e PaisEstadoCidade o mostra embaixo do campo de cidade."
  );
}
