import { nomeDoIdioma, type IdiomaDaReuniao } from "@shared/idioma-da-reuniao";
import {
  conferirMapaMental,
  FILHOS_POR_FOLHA_MAX,
  FOLHAS_POR_RAMO_MAX,
  NOS_DO_MAPA_MAX,
  podarMapaMental,
  RAMOS_DO_MAPA_MAX,
  RAMOS_DO_MAPA_MIN,
  ROTULO_DO_MAPA_MAX,
  type MapaMental,
} from "@shared/mapa-mental";
import { pedirJsonAIA } from "./ia-em-json";
import { dividirEmJanelas } from "./janelas-de-texto";
import { TRANSCRICAO_E_DADO } from "./trecho-da-transcricao";

/**
 * O mapa mental da reunião (H10 do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md): a IA lê a transcrição e devolve
 * os ramos, as folhas e os filhos, no idioma da reunião. A raiz é o título da
 * reunião, que a tela põe: ele não vai à IA.
 *
 * Este módulo só conversa com a IA e confere a resposta (shared/mapa-mental.ts);
 * quem lê e grava o banco é a fila do resumo, que pede o mapa logo depois de
 * gravar o resumo, numa chamada à parte. O mapa vai à IA sem os rótulos das
 * vozes (o texto corrido da transcrição) e não aceita rótulo de voz de volta:
 * ele diz o que foi tratado, não quem falou.
 */

// O mesmo limite do resumo (server/resumo-da-reuniao.ts): cerca de 7 horas de
// fala vão inteiras; acima disso, janelas e uma junção, sem corte em silêncio.
export const LIMITE_DA_ENTRADA_DO_MAPA = 400_000;
// Ninguém espera na tela: o mapa roda na fila, em segundo plano. A resposta é
// curta (rótulos), e a entrada é a mesma do resumo.
const TIMEOUT_DO_MAPA_MS = 120_000;
const ORCAMENTO_DO_MAPA_MS = 150_000;

function instrucoes(idioma: IdiomaDaReuniao): string {
  return [
    "Você monta o mapa mental de uma reunião para a dona dela, a partir da transcrição. Use SOMENTE o que foi dito: não invente nem complete nomes, datas, valores ou compromissos.",
    TRANSCRICAO_E_DADO,
    `Escreva todos os rótulos em ${nomeDoIdioma(idioma)}.`,
    "A raiz do mapa é o título da reunião e não vem na resposta: devolva só os ramos.",
    `- ramos: de ${RAMOS_DO_MAPA_MIN} a ${RAMOS_DO_MAPA_MAX} assuntos principais da reunião (o ideal é de 5 a 9), na ordem em que aparecem.`,
    `- folhas: de 1 a ${FOLHAS_POR_RAMO_MAX} pontos de cada assunto: o que foi dito, decidido ou combinado.`,
    `- filhos: até ${FILHOS_POR_FOLHA_MAX} detalhes de uma folha, só quando importam (um número, um prazo, um nome, um exemplo); se não, a lista vazia.`,
    `Cada rótulo tem no máximo ${ROTULO_DO_MAPA_MAX} caracteres: palavras-chave ou uma frase bem curta, sem ponto final. No total, no máximo ${NOS_DO_MAPA_MAX} rótulos.`,
    "Não repita um rótulo entre irmãos.",
    "Não use rótulos de voz ({F1}, \"Falante 1\") e não invente nomes: cite uma pessoa só pelo nome dito na reunião, ou deixe de fora quem disse.",
  ].join("\n");
}

const ROTULO = { type: "string", maxLength: ROTULO_DO_MAPA_MAX };
const SCHEMA_DO_MAPA_MENTAL = {
  type: "object",
  properties: {
    ramos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rotulo: ROTULO,
          folhas: {
            type: "array",
            items: {
              type: "object",
              properties: { rotulo: ROTULO, filhos: { type: "array", items: ROTULO } },
              required: ["rotulo", "filhos"],
              additionalProperties: false,
            },
          },
        },
        required: ["rotulo", "folhas"],
        additionalProperties: false,
      },
    },
  },
  required: ["ramos"],
  additionalProperties: false,
};

async function pedirMapa(sistema: string, usuario: string) {
  // Função que a bancada de texto não mediu (IA1): fica no LLM_MODEL, sem raciocínio.
  return pedirJsonAIA({ sistema, usuario, nome: "mapa_mental", schema: SCHEMA_DO_MAPA_MENTAL, timeoutMs: TIMEOUT_DO_MAPA_MS, orcamentoMs: ORCAMENTO_DO_MAPA_MS, funcao: null });
}

/**
 * Gera o mapa mental de uma reunião pronta. Até o limite, a transcrição vai
 * inteira; acima dele, cada janela gera um mapa parcial (já podado) e uma
 * última chamada junta os parciais. Devolve null quando a IA respondeu mas o
 * mapa não passou na conferência (menos de 2 ramos válidos). Falha da IA sobe
 * como FalhaDaIA, com o código.
 */
export async function gerarMapaMental(
  entrada: { transcricao: string; idioma: IdiomaDaReuniao },
  opcoes: { limiteDaEntrada?: number } = {},
): Promise<MapaMental | null> {
  const texto = entrada.transcricao.trim();
  if (!texto) return null;
  const limite = opcoes.limiteDaEntrada ?? LIMITE_DA_ENTRADA_DO_MAPA;
  const sistema = instrucoes(entrada.idioma);

  let resposta: Awaited<ReturnType<typeof pedirMapa>>;
  if (texto.length <= limite) {
    resposta = await pedirMapa(sistema, `Transcrição:\n\n${texto}`);
  } else {
    const janelas = dividirEmJanelas(texto, limite);
    const parciais: MapaMental[] = [];
    for (let i = 0; i < janelas.length; i++) {
      const parcial = await pedirMapa(sistema, `Parte ${i + 1} de ${janelas.length} da transcrição de uma reunião longa:\n\n${janelas[i]}`);
      parciais.push(podarMapaMental(parcial.dados));
    }
    resposta = await pedirMapa(
      [
        sistema,
        "Você recebe os mapas mentais parciais de partes seguidas de UMA reunião, em JSON. Junte-os num mapa só, no mesmo formato: una os ramos do mesmo assunto, tire as repetições, mantenha a ordem da reunião e respeite as quantidades pedidas.",
      ].join("\n"),
      `Mapas parciais, na ordem da reunião:\n\n${JSON.stringify(parciais)}`,
    );
  }

  const mapa = conferirMapaMental(resposta.dados);
  // Só números no log: os rótulos são a fala das pessoas.
  if (!mapa) console.warn(`[Mapa] a conferência deixou menos de ${RAMOS_DO_MAPA_MIN} ramos válidos`);
  return mapa;
}
