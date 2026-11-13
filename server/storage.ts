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
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, type GetObjectCommandOutput } from "@aws-sdk/client-s3";
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
  opcoes: { cacheControl?: string } = {},
): Promise<{ key: string; url: string }> {
  const config = getStorageConfig();
  const key = appendHashSuffix(normalizeKey(relKey));

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

/** Remove um objeto do bucket. Chave inexistente não é erro no protocolo S3. */
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

/**
 * Defesa em profundidade na hora de apagar do bucket: só sai objeto que está
 * no espaço da própria dona, sob o prefixo esperado (ex.: "contacts",
 * "contexts"). Um storagePath legado ou corrompido (a tabela veio do backup
 * do Manus) não pode virar a exclusão de uma chave arbitrária. Compartilhada
 * entre routers/contexts.ts e routers/network.ts — antes duplicada, uma
 * cópia por arquivo.
 */
export function chaveDoStorageDaDona(prefixo: string, openId: string, storagePath: string): string | null {
  const chave = normalizeKey(storagePath.replace(/^\/manus-storage\//, ""));
  return chave.startsWith(`${prefixo}/${openId}/`) ? chave : null;
}

/**
 * URL assinada de leitura, válida por 5 minutos. Curta de propósito: a URL em
 * si dispensa autenticação, então quanto menos tempo viver, menor a janela para
 * um link colado num chat continuar funcionando.
 */
/**
 * Prazo da URL assinada. Cinco minutos servem para abrir um documento ou uma
 * foto, mas NÃO para tocar uma gravação: o áudio de reunião chega a 10
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
 */
const SEGUNDOS_DA_URL_ASSINADA = 60 * 60;

export async function storageGetSignedUrl(relKey: string): Promise<string> {
  const config = getStorageConfig();
  const key = normalizeKey(relKey);
  return getSignedUrl(
    getClient(config),
    new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    { expiresIn: SEGUNDOS_DA_URL_ASSINADA },
  );
}
