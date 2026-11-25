/**
 * O perfil de voz da dona (H3d do desenho de 16/11; HN-24 da auditoria,
 * aprovado pelo Roberto em 24/11/2026). A dona grava um trecho curto da própria
 * voz, lendo o texto da tela, e as próximas reuniões que ela gravar já a
 * reconhecem: a fala dela sai com o nome dela, e não "Falante 1". O servidor
 * está em server/perfil-de-voz.ts; a tela, em
 * client/src/components/PerfilDeVoz.tsx.
 *
 * É dado biométrico (LGPD art. 11). Os textos do consentimento são os da Cris
 * (25/11/2026), com o nome atual da plataforma: a caixa nasce DESMARCADA e é
 * separada do aceite dos Termos; o registro guarda a data, a hora, a versão do
 * texto, o idioma e o texto exibido de cada consentimento e de cada revogação.
 */

/**
 * As versões do texto do consentimento (as chaves `perfilDeVoz.consent*`, nos
 * 10 idiomas). Mudou o que o texto diz, versão NOVA no fim da lista e troque a
 * VIGENTE: as anteriores seguem aceitas para a aba aberta antes do deploy, e o
 * registro guarda a que veio, com o texto.
 */
export const VERSOES_DO_TEXTO_DO_PERFIL_DE_VOZ = ["perfil-de-voz-2026-11-25"] as const;

export type VersaoDoTextoDoPerfilDeVoz = (typeof VERSOES_DO_TEXTO_DO_PERFIL_DE_VOZ)[number];

export const VERSAO_VIGENTE_DO_TEXTO_DO_PERFIL_DE_VOZ: VersaoDoTextoDoPerfilDeVoz = "perfil-de-voz-2026-11-25";

/** O teto do texto exibido que a tela manda para o registro (a caixa e o texto de apoio, em qualquer dos 10 idiomas). */
export const TEXTO_DO_CONSENTIMENTO_DE_VOZ_MAX = 2000;

/**
 * A gravação da amostra: de 10 a 60 s (a tela pede cerca de 30 s, lendo o
 * texto), e no máximo 1 MB. A amostra vai junto em CADA parte de reunião
 * transcrita, e a parte já chega a 16 MB: uma amostra pequena não aperta o
 * teto do pedido ao Gemini nem o custo (cerca de US$ 0,0007 por parte).
 */
export const DURACAO_MINIMA_DA_AMOSTRA_MS = 10_000;
export const DURACAO_MAXIMA_DA_AMOSTRA_MS = 60_000;
export const DURACAO_SUGERIDA_DA_AMOSTRA_S = 30;
export const TAMANHO_MAXIMO_DA_AMOSTRA = 1024 * 1024;

/** Os tipos de áudio da amostra: os que o gravador do navegador entrega (client/src/lib/formato-de-audio.ts). */
export const TIPOS_DA_AMOSTRA = ["audio/webm", "audio/ogg", "audio/wav", "audio/mp4"] as const;
export type TipoDaAmostra = (typeof TIPOS_DA_AMOSTRA)[number];

/**
 * Gravar (e regravar) a amostra: teto por dona, em memória como os outros
 * tetos dos routers. Cada gravação é um upload e uma exclusão no bucket.
 */
export const GRAVACOES_DA_AMOSTRA_POR_JANELA = 10;
export const JANELA_DA_AMOSTRA_MS = 60 * 60_000;

/**
 * O rótulo que a IA dá à voz da dona quando a amostra vai junto (a fila,
 * server/fila-de-transcricao.ts): sempre o primeiro, e as outras vozes começam
 * no segundo. A montagem liga esse rótulo à conta da dona (H3c), e a dona
 * corrige no "Quem é cada voz" se a IA errar.
 */
export const ROTULO_DA_VOZ_DA_DONA = "F1";

/**
 * As recusas, como CÓDIGO (a tela traduz):
 * - CONSENTIMENTO_PEDIDO: a primeira gravação sem a caixa marcada, ou com uma
 *   versão do texto que o servidor não conhece;
 * - AMOSTRA_INVALIDA: formato, tamanho ou duração fora do aceito;
 * - SEM_PERFIL: ouvir ou desligar sem perfil gravado;
 * - DEMAIS: o teto de gravações por hora;
 * - BUCKET: o armazenamento não confirmou a gravação ou a exclusão (nada mudou;
 *   a dona tenta de novo).
 */
export const RECUSAS_DO_PERFIL_DE_VOZ = {
  consentimentoPedido: "PERFIL_DE_VOZ_CONSENTIMENTO_PEDIDO",
  amostraInvalida: "PERFIL_DE_VOZ_AMOSTRA_INVALIDA",
  semPerfil: "PERFIL_DE_VOZ_SEM_PERFIL",
  demais: "PERFIL_DE_VOZ_DEMAIS",
  bucket: "PERFIL_DE_VOZ_BUCKET",
} as const;

export type CodigoDaRecusaDoPerfilDeVoz = (typeof RECUSAS_DO_PERFIL_DE_VOZ)[keyof typeof RECUSAS_DO_PERFIL_DE_VOZ];

/** O prefixo das chaves da amostra no bucket. Fora das regras do proxy /manus-storage: lá, o que não está listado é negado. */
export const PREFIXO_DO_PERFIL_DE_VOZ = "perfis-de-voz";
