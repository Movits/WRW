// Storage de arquivos sobre a API do S3 — que é um padrão de fato: AWS S3,
// Cloudflare R2, Backblaze B2 e MinIO falam todos o mesmo protocolo. A decisão
// de provedor (aberta na D6) não bloqueia este código: é só preencher as
// variáveis de ambiente.
//
//   STORAGE_BUCKET             nome do bucket (obrigatória)
//   STORAGE_ACCESS_KEY_ID      credencial (obrigatória)
//   STORAGE_SECRET_ACCESS_KEY  credencial (obrigatória)
//   STORAGE_ENDPOINT           só para R2/B2/MinIO (ex.: https://<conta>.r2.cloudflarestorage.com);
//                              vazia para a AWS
//   STORAGE_REGION             padrão: "auto" com endpoint próprio, "us-east-1" na AWS
//
// A versão anterior falava o protocolo do Forge/Manus, que saiu do ar — e a
// mensagem de erro dela mandava configurar BUILT_IN_FORGE_API_URL, a variável
// ERRADA, que ainda por cima é fallback do endpoint de LLM: seguir a mensagem
// não consertava o upload e apontava a IA para o host errado.
//
// As URLs devolvidas continuam no formato /manus-storage/{key}: é o caminho que
// está gravado no banco em todo documento existente, e a rota (storageProxy)
// agora exige sessão e posse antes de assinar o download.

import crypto from "node:crypto";
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectVersionsCommand,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

type StorageConfig = {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  region: string;
};

function getStorageConfig(): StorageConfig {
  const bucket = process.env.STORAGE_BUCKET ?? "";
  const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID ?? "";
  const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY ?? "";
  const endpoint = process.env.STORAGE_ENDPOINT ?? "";
  const region = process.env.STORAGE_REGION || (endpoint ? "auto" : "us-east-1");

  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Storage não configurado: defina STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID e " +
        "STORAGE_SECRET_ACCESS_KEY (e STORAGE_ENDPOINT se não for AWS S3).",
    );
  }

  return { bucket, accessKeyId, secretAccessKey, endpoint, region };
}

let clientePorConfig: { chave: string; cliente: S3Client } | null = null;

function getClient(config: StorageConfig): S3Client {
  const chave = `${config.endpoint}|${config.region}|${config.bucket}|${config.accessKeyId}`;
  if (clientePorConfig?.chave === chave) return clientePorConfig.cliente;
  const cliente = new S3Client({
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    ...(config.endpoint
      ? {
          endpoint: config.endpoint,
          // Endpoints próprios (R2/B2/MinIO) esperam o bucket no caminho, não
          // no subdomínio.
          forcePathStyle: true,
        }
      : {}),
  });
  clientePorConfig = { chave, cliente };
  return cliente;
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

/**
 * A chave do objeto no bucket a partir do que uma linha do banco guarda. Linha
 * legada (a tabela veio do backup do Manus) pode trazer o caminho do proxy,
 * "/manus-storage/<chave>", em vez da chave. Sem tirar esse prefixo, o HEAD, o
 * DELETE e a listagem do expurgo iriam para "manus-storage/meetings/...", que
 * não existe: tudo "daria certo", a linha sairia e a voz ficaria no bucket sem
 * ponteiro. Um lugar só, usado pela prova de posse (chaveDoStorageDaDona) e
 * pelo expurgo do áudio (storageApagarTodasAsVersoes), para as duas nunca
 * divergirem sobre qual é a chave.
 */
function chaveDoBucket(caminho: string): string {
  return normalizeKey(caminho.replace(/^\/manus-storage\//, ""));
}

// Sufixo aleatório para a chave nunca colidir com um upload anterior do mesmo
// nome — comportamento herdado da versão anterior, que os chamadores esperam.
function appendHashSuffix(relKey: string): string {
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  if (lastDot === -1) return `${relKey}_${hash}`;
  return `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}`;
}

/**
 * Cache-Control gravado NO OBJETO, para o bucket repeti-lo em toda resposta.
 *
 * É a metade que falta do reaproveitamento da URL assinada (storageProxy): a
 * URL ser a mesma só evita o download novo se o navegador puder guardar os
 * bytes. Sem este cabeçalho, o B2 responde com Last-Modified e ETag e o
 * navegador cai na heurística — que num arquivo recém-enviado dá validade
 * quase zero e revalida a cada abertura de tela.
 *
 * `private` é obrigatório: proxy ou CDN no meio do caminho NÃO pode guardar
 * arquivo de uma usuária. Os 50 minutos casam com a janela de reaproveitamento
 * da URL; passada ela, vem URL nova e o cache antigo deixa de ser consultado.
 */
export const CACHE_DE_ARQUIVO_PRIVADO = "private, max-age=3000";

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream",
  // A parte da reunião gravada em partes (server/fatias-de-reuniao.ts) grava a
  // linha que aponta para o objeto ANTES do upload: a chave tem de ser a que ela
  // já guardou, sem o sufixo aleatório. Quem pede a chave exata garante que ela
  // é única (a da parte leva o id da linha). O cacheControl vai gravado no
  // próprio objeto (ver CACHE_DE_ARQUIVO_PRIVADO, acima).
  opcoes: { chaveExata?: boolean; cacheControl?: string } = {},
): Promise<{ key: string; url: string }> {
  const config = getStorageConfig();
  const key = opcoes.chaveExata ? normalizeKey(relKey) : appendHashSuffix(normalizeKey(relKey));

  await getClient(config).send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: typeof data === "string" ? Buffer.from(data) : data,
      ContentType: contentType,
      ...(opcoes.cacheControl ? { CacheControl: opcoes.cacheControl } : {}),
    }),
  );

  return { key, url: `/manus-storage/${key}` };
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  return { key, url: `/manus-storage/${key}` };
}

/**
 * Remove um objeto do bucket. Chave inexistente não é erro no protocolo S3.
 *
 * Num bucket com versões (o B2 guarda versões por padrão), este DELETE sem
 * VersionId só põe um marcador por cima: o arquivo deixa de ser servido, mas a
 * versão continua guardada e cobrada. O áudio de reunião sai por
 * storageApagarTodasAsVersoes; os outros arquivos (fotos, contextos, Sala, SIVC)
 * seguem por aqui.
 */
export async function storageDelete(relKey: string): Promise<void> {
  const config = getStorageConfig();
  const key = normalizeKey(relKey);
  await getClient(config).send(
    new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
  );
}

/** O objeto não existe no bucket (NoSuchKey, ou só 404 em provedor que não manda o código). */
export class ObjetoAusenteNoStorageError extends Error {
  constructor(chave: string) {
    super(`Objeto ausente no storage: ${chave}`);
    this.name = "ObjetoAusenteNoStorageError";
  }
}

/** O objeto é maior que o limite de quem o pediu. */
export class ObjetoGrandeDemaisError extends Error {
  constructor(tamanho: number, limite: number) {
    super(`Objeto de ${tamanho} bytes acima do limite de ${limite} bytes.`);
    this.name = "ObjetoGrandeDemaisError";
  }
}

function ehObjetoAusente(erro: unknown): boolean {
  const e = erro as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } } | null | undefined;
  return e?.name === "NoSuchKey" || e?.Code === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

/**
 * O bucket negou a PERMISSÃO (AccessDenied, ou só 403 em provedor que não manda
 * o código). Não é falha de um arquivo: é a chave de acesso sem a capacidade que
 * a operação pede (no B2, o expurgo de versões precisa de listFiles e
 * deleteFiles), e tentar de novo não muda nada até alguém mexer no painel. Quem
 * apaga o áudio de reunião registra isso como erro do sistema, e não como o
 * aviso de um arquivo que ficou.
 */
export function ehAcessoNegadoNoBucket(erro: unknown): boolean {
  const e = erro as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } } | null | undefined;
  return e?.name === "AccessDenied" || e?.Code === "AccessDenied" || e?.$metadata?.httpStatusCode === 403;
}

/**
 * A chamada foi cortada pelo prazo: AbortSignal.timeout rejeita com
 * TimeoutError, e o SDK, conforme a versão do handler HTTP, relança o aborto
 * como AbortError. As duas querem dizer bucket que não respondeu a tempo.
 */
function ehPrazoEsgotado(erro: unknown): boolean {
  const nome = (erro as { name?: unknown } | null | undefined)?.name;
  return nome === "TimeoutError" || nome === "AbortError";
}

/** Prazo da leitura de bytes: 10 MB de um bucket saudável chegam em poucos segundos. */
const PRAZO_DA_LEITURA_MS = 30_000;

/**
 * Lê os BYTES de um objeto do bucket — hoje, para reprocessar uma reunião a
 * partir do áudio guardado. Diferente de storageGet, que só monta a URL do
 * proxy, e de storageGetSignedUrl, que entrega a leitura ao navegador.
 *
 * Com prazo: o S3Client é criado sem timeout, e um bucket travado prenderia o
 * reprocessamento em segundo plano até a varredura de interrompidas. Com teto
 * de tamanho: acima do limite o corpo nem é lido (sai pelo ContentLength), e o
 * tamanho é reconferido depois de ler, para provedor que não manda o cabeçalho.
 */
export async function storageGetBytes(relKey: string, limiteBytes: number, prazoMs = PRAZO_DA_LEITURA_MS): Promise<Buffer> {
  const config = getStorageConfig();
  const key = normalizeKey(relKey);
  let resposta: GetObjectCommandOutput;
  try {
    resposta = await getClient(config).send(
      new GetObjectCommand({ Bucket: config.bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(prazoMs) },
    );
  } catch (erro) {
    if (ehObjetoAusente(erro)) throw new ObjetoAusenteNoStorageError(key);
    throw erro;
  }
  const corpo = resposta.Body;
  if (typeof resposta.ContentLength === "number" && resposta.ContentLength > limiteBytes) {
    (corpo as { destroy?: () => void } | undefined)?.destroy?.();
    throw new ObjetoGrandeDemaisError(resposta.ContentLength, limiteBytes);
  }
  if (!corpo) throw new Error(`O storage devolveu o objeto sem conteúdo: ${key}`);
  const bytes = Buffer.from(await corpo.transformToByteArray());
  if (!bytes.length) throw new Error(`O storage devolveu o objeto sem conteúdo: ${key}`);
  if (bytes.length > limiteBytes) throw new ObjetoGrandeDemaisError(bytes.length, limiteBytes);
  return bytes;
}

/** Prazo de CADA chamada ao bucket no apagamento com todas as versões. */
const PRAZO_DE_CADA_CHAMADA_DO_EXPURGO_MS = 30_000;

/**
 * Quantos áudios de reunião saem do bucket AO MESMO TEMPO quando uma requisição
 * da tela espera por eles (a leitura da reunião vencida, a exclusão da reunião e
 * a da conta). Cada áudio custa 4 a 5 chamadas (HEAD, DELETE, listagem e um
 * DELETE por versão e por marcador), e uma reunião de 12 h tem 72 partes: um por
 * vez, a exclusão passava de um minuto. Todos juntos, seriam centenas de chamadas
 * simultâneas ao B2. A varredura, em segundo plano, segue um por vez.
 */
export const CONCORRENCIA_DO_EXPURGO_DO_AUDIO = 6;

/**
 * Apaga um objeto do bucket com TODAS as versões. Hoje, só o áudio de reunião
 * (a gravação do envio único e as partes da gravação em partes).
 *
 * O B2 guarda versões: o DeleteObject sem VersionId de storageDelete só põe um
 * marcador de exclusão por cima, o GET passa a dar 404 e a versão com o áudio
 * continua guardada e cobrada. Para a voz das participantes sair de verdade
 * quando a dona exclui a reunião ou a conta, cada versão
 * e cada marcador da chave saem pelo VersionId. Os outros arquivos seguem com
 * storageDelete.
 *
 * O DELETE simples vem primeiro, e o arquivo deixa de ser servido na hora,
 * mesmo que o resto falhe (chave sem permissão de listar, B2 fora). Falha na
 * listagem ou numa versão LANÇA: quem chama (a varredura, a leitura vencida, a
 * exclusão da reunião e a da conta) deixa a linha do áudio no banco, e a
 * próxima varredura tenta de novo. Versão que já não existe (outra instância
 * chegou antes) conta como apagada.
 *
 * O DELETE simples só vai se o arquivo ainda estiver visível. Num bucket com
 * versões, cada DELETE sem VersionId põe mais um marcador por cima, mesmo que o
 * atual já seja um marcador; com a listagem falhando, a varredura repetiria
 * isto a cada 5 min, e cada marcador acumulado vira mais uma chamada quando a
 * listagem voltar. Por isso um HEAD antes: 404 é chave já escondida, e o DELETE
 * simples é pulado. HEAD cortado pelo prazo LANÇA na hora: é bucket travado, e
 * o DELETE simples gastaria outro prazo inteiro para falhar igual. Qualquer
 * outro erro do HEAD (sem permissão, por exemplo) segue para o DELETE, como
 * sempre: tirar o arquivo do ar vem primeiro.
 *
 * Toda chamada tem prazo PRÓPRIO: o S3Client não tem timeout, e um bucket
 * travado prenderia a varredura. Um prazo só para a função inteira cortaria as
 * últimas versões de uma chave com muitas.
 *
 * Recebe a chave como a linha do banco a guarda e a normaliza aqui (ver
 * chaveDoBucket). Trazida da PR #134 do Nicolas.
 */
export async function storageApagarTodasAsVersoes(relKey: string, prazoMs = PRAZO_DE_CADA_CHAMADA_DO_EXPURGO_MS): Promise<void> {
  const config = getStorageConfig();
  const key = chaveDoBucket(relKey);
  const cliente = getClient(config);
  const comPrazo = () => ({ abortSignal: AbortSignal.timeout(prazoMs) });

  let visivel = true;
  try {
    await cliente.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }), comPrazo());
  } catch (erro) {
    if (ehPrazoEsgotado(erro)) throw erro;
    if (ehObjetoAusente(erro)) visivel = false;
  }
  if (visivel) await cliente.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }), comPrazo());

  // O Prefix também traz as chaves que só COMEÇAM igual (recording_abc.webm.bak,
  // por exemplo): sai só o que tem exatamente esta chave.
  const versoes: string[] = [];
  let KeyMarker: string | undefined;
  let VersionIdMarker: string | undefined;
  for (;;) {
    const pagina = await cliente.send(
      new ListObjectVersionsCommand({ Bucket: config.bucket, Prefix: key, KeyMarker, VersionIdMarker }),
      comPrazo(),
    );
    for (const item of [...(pagina.Versions ?? []), ...(pagina.DeleteMarkers ?? [])]) {
      if (item.Key === key && item.VersionId) versoes.push(item.VersionId);
    }
    // Sem marcador de continuação não há como pedir a próxima página: parar é
    // melhor que repetir a primeira para sempre.
    if (!pagina.IsTruncated || (!pagina.NextKeyMarker && !pagina.NextVersionIdMarker)) break;
    KeyMarker = pagina.NextKeyMarker;
    VersionIdMarker = pagina.NextVersionIdMarker;
  }

  for (const VersionId of versoes) {
    try {
      await cliente.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key, VersionId }), comPrazo());
    } catch (erro) {
      const codigo = erro as { name?: unknown; Code?: unknown } | null | undefined;
      const jaApagada = ehObjetoAusente(erro) || codigo?.name === "NoSuchVersion" || codigo?.Code === "NoSuchVersion";
      if (!jaApagada) throw erro;
    }
  }
}

/**
 * As chaves sob `prefixo` que estão ESCONDIDAS no bucket: a versão mais recente
 * de cada uma é um marcador de exclusão (o DELETE sem VersionId), e as versões
 * com o conteúdo continuam guardadas e cobradas por baixo. Em ordem, sem
 * repetição.
 *
 * Serve ao expurgo único do áudio de reunião que o DELETE antigo só escondeu
 * (scripts/expurgar-audio-escondido.ts): as linhas que apontavam para esses
 * objetos já saíram do banco, e só listando o bucket se acha o que ficou. Não
 * lista o bucket inteiro: o prefixo é obrigatório. Cada página tem prazo próprio,
 * como no expurgo.
 */
export async function storageListarChavesEscondidas(prefixo: string, prazoMs = PRAZO_DE_CADA_CHAMADA_DO_EXPURGO_MS): Promise<string[]> {
  const Prefix = normalizeKey(prefixo);
  if (!Prefix) throw new Error("Prefixo obrigatório: a listagem das chaves escondidas não varre o bucket inteiro.");
  const config = getStorageConfig();
  const cliente = getClient(config);
  const escondidas = new Set<string>();
  let KeyMarker: string | undefined;
  let VersionIdMarker: string | undefined;
  for (;;) {
    const pagina = await cliente.send(
      new ListObjectVersionsCommand({ Bucket: config.bucket, Prefix, KeyMarker, VersionIdMarker }),
      { abortSignal: AbortSignal.timeout(prazoMs) },
    );
    for (const marcador of pagina.DeleteMarkers ?? []) {
      if (marcador.IsLatest && marcador.Key) escondidas.add(marcador.Key);
    }
    if (!pagina.IsTruncated || (!pagina.NextKeyMarker && !pagina.NextVersionIdMarker)) break;
    KeyMarker = pagina.NextKeyMarker;
    VersionIdMarker = pagina.NextVersionIdMarker;
  }
  return Array.from(escondidas).sort();
}

/**
 * Defesa em profundidade na hora de apagar do bucket: só sai objeto que está
 * no espaço da própria dona, sob o prefixo esperado (ex.: "contacts",
 * "contexts"). Um storagePath legado ou corrompido (a tabela veio do backup
 * do Manus) não pode virar a exclusão de uma chave arbitrária. Compartilhada
 * entre routers/contexts.ts e routers/network.ts — antes duplicada, uma
 * cópia por arquivo.
 */
export function chaveDoStorageDaDona(prefixo: string, openId: string, storagePath: string): string | null {
  const chave = chaveDoBucket(storagePath);
  return chave.startsWith(`${prefixo}/${openId}/`) ? chave : null;
}

/**
 * Prazo da URL assinada de leitura. A URL em si dispensa autenticação, então o
 * prazo é a janela em que um link colado num chat continua abrindo. Ele já foi
 * de cinco minutos, que servem para abrir um documento ou uma foto, mas NÃO
 * para tocar uma gravação: o áudio de reunião chega a 10
 * minutos, e toda requisição nova depois do prazo — arrastar a barra, ou
 * pausar e retomar quando o navegador já fechou a conexão — bateria num 403
 * do bucket, deixando o player travado sem explicação. Uma hora cobre a
 * sessão de escuta inteira e continua muito abaixo de uma URL permanente.
 *
 * O prazo não decide quem lê: cada caminho confere antes de assinar. O proxy
 * /manus-storage/ (server/_core/storageProxy.ts) exige sessão e posse; a rota
 * do link aberto, /reuniao-aberta/{token}/audio (server/link-aberto-da-reuniao.ts),
 * confere só o token que a dona ligou, sem sessão. Mas o prazo É quanto tempo
 * uma URL já entregue continua abrindo: depois de a dona desligar o link, quem
 * já tinha a gravação carregada segue ouvindo até ela vencer. Quem mudar este
 * valor atualiza o "até 1 hora" de docs/arquitetura/decisoes-tomadas.md, de
 * docs/arquitetura/gravador-de-reunioes.md e do texto meetings.share.turnOffConfirm.
 * O cofre de URLs do proxy acompanha sozinho: a janela em que ele repete a mesma
 * URL (MS_DE_REUSO_DA_URL, em server/_core/storageProxy.ts) é calculada a partir
 * deste valor, para nunca entregar uma URL já vencida.
 */
export const SEGUNDOS_DA_URL_ASSINADA = 60 * 60;

export async function storageGetSignedUrl(relKey: string): Promise<string> {
  const config = getStorageConfig();
  const key = normalizeKey(relKey);
  return getSignedUrl(
    getClient(config),
    new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    { expiresIn: SEGUNDOS_DA_URL_ASSINADA },
  );
}
