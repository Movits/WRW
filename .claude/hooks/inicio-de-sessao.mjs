// Início de sessão: o que o Claude (e a pessoa) precisam saber antes do
// primeiro comando. Roda no hook SessionStart (.claude/settings.json), em
// "startup" e "resume".
//
// Na nuvem (CLAUDE_CODE_REMOTE=true): instala as dependências quando faltam
// (o clone chega sem node_modules), busca a main e resume branch, atraso,
// árvore e carimbo.
//
// No computador da pessoa: NÃO usa rede (nada de git fetch, que no Windows
// pode abrir o gerenciador de credenciais). Lê o .env por conta própria e diz
// só a CLASSIFICAÇÃO do banco (local, remoto, Aiven), nunca o valor; avisa
// quando os testes ao vivo estão ligados e quando a branch é a main.
//
// A saída é JSON no formato do SessionStart: o resumo inteiro vai para o
// contexto do Claude (additionalContext) e as linhas "ATENÇÃO" também vão para
// a tela da pessoa (systemMessage). Para ler à mão: --texto.
//
// Sai sempre com código 0: um início de sessão nunca pode travar por causa
// deste script. Sem dependências: roda antes de existir node_modules.

import { spawnSync, execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ =
  process.env.CLAUDE_PROJECT_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOG_DO_INSTALL = path.join(
  os.tmpdir(),
  "inicio-de-sessao-pnpm-install.log"
);
const TETO_DO_INSTALL_MS = 240_000;
const TETO_DO_FETCH_MS = 15_000;

const LINHA_NUVEM =
  "Na nuvem: gh pr/gh issue dão 403 (use as ferramentas mcp__github__*); não há MySQL (o banco do zero fica com o CI).";
const LINHA_FINAL = "O Claude não aprova, não mescla nem toca produção por conta própria.";

// ------------------------------------------------------- funções puras -----

const HOSTS_LOCAIS = new Set([
  "localhost",
  "::1",
  "0.0.0.0",
  "host.docker.internal",
]);

// Extrai o host de uma URL de banco (mysql://usuario:senha@host:porta/banco).
// Não usa new URL: senha com "#", "/" ou "?" sem codificar confunde o parser e
// faria um banco remoto parecer local. O host é o que vem depois do último "@".
function hostDaUrl(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(url);
  if (!m) return null;
  const depoisDoArroba = m[1].slice(m[1].lastIndexOf("@") + 1);
  const h = /^(\[[^\]]*\]|[^:/?#\s]+)/.exec(depoisDoArroba);
  if (!h) return null;
  return (
    h[1]
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "")
      .toLowerCase() || null
  );
}

// 'ausente' | 'local' | 'aiven' | 'remoto' | 'invalido'
// Na dúvida, o lado seguro: qualquer menção ao Aiven classifica como Aiven, e
// um alarme a mais custa menos que um banco de produção sem aviso. Host sem
// ponto ("mysql", "db") é nome de serviço do Docker ou da rede local: local.
// host.docker.internal é a própria máquina vista de dentro de um contêiner.
export function classificarHost(url) {
  if (typeof url !== "string" || url.trim() === "") return "ausente";
  if (/aivencloud\.com/i.test(url)) return "aiven";
  const host = hostDaUrl(url.trim());
  if (!host) return "invalido";
  if (
    HOSTS_LOCAIS.has(host) ||
    host.endsWith(".localhost") ||
    /^127(\.\d{1,3}){3}$/.test(host) ||
    /^::ffff:127(\.\d{1,3}){3}$/.test(host) ||
    !/[.:]/.test(host)
  ) {
    return "local";
  }
  return "remoto";
}

// Parser mínimo de .env, com as mesmas regras do dotenv nos casos comuns:
// "export " opcional, valor entre aspas simples, duplas ou crases tomado como
// está, valor sem aspas cortado no primeiro "#" e aparado, linha vazia e
// comentário ignorados, e a última ocorrência da chave vence.
export function lerEnv(texto) {
  const env = {};
  if (typeof texto !== "string") return env;
  for (const linhaCrua of texto.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(linhaCrua);
    if (!m) continue;
    const [, chave, resto] = m;
    const aspa = resto[0];
    let valor;
    if (aspa === '"' || aspa === "'" || aspa === "`") {
      const fim = resto.indexOf(aspa, 1);
      valor = fim > 0 ? resto.slice(1, fim) : resto.split("#")[0].trim();
    } else {
      valor = resto.split("#")[0].trim();
    }
    env[chave] = valor;
  }
  return env;
}

const ROTULO = {
  ausente: "ausente",
  local: "local",
  aiven: "REMOTO (Aiven)",
  remoto: "REMOTO (fora desta máquina)",
  invalido:
    "ilegível (formato esperado: mysql://usuario:senha@host:porta/banco)",
};

// O valor que vale é o do ambiente quando existe (o dotenv não sobrescreve
// variável já definida); senão, o do .env. Devolve só classe e origem.
function efetiva(nome, doArquivo, doAmbiente) {
  if (doAmbiente[nome])
    return { classe: classificarHost(doAmbiente[nome]), origem: "do terminal" };
  return { classe: classificarHost(doArquivo[nome]), origem: "do .env" };
}

// Linhas sobre o banco no computador da pessoa. Nunca inclui valores: só o
// nome da variável, a classe e de onde ela veio.
export function avisosDoBanco(
  doArquivo = {},
  doAmbiente = {},
  existeEnv = true
) {
  const principal = efetiva("DATABASE_URL", doArquivo, doAmbiente);
  const testes = efetiva("DATABASE_URL_TESTES", doArquivo, doAmbiente);
  const remota = c => c === "aiven" || c === "remoto";
  const linhas = [];

  const partes = [];
  const efeitos = [];
  if (remota(principal.classe)) {
    partes.push(
      `DATABASE_URL (${principal.origem}) aponta para banco ${ROTULO[principal.classe]}`
    );
    // Os scripts .mjs de banco leem só o ambiente, não o .env.
    efeitos.push(
      principal.origem === "do terminal"
        ? "pnpm dev e os scripts de banco usariam esse banco"
        : "pnpm dev usaria esse banco"
    );
  }
  if (remota(testes.classe)) {
    partes.push(
      `DATABASE_URL_TESTES (${testes.origem}) aponta para banco ${ROTULO[testes.classe]}`
    );
    efeitos.push("pnpm test gravaria nele");
  }
  if (partes.length) {
    linhas.push(
      `ATENÇÃO: ${partes.join("; ")}. ${efeitos.join(" e ")}. Use um banco local.`
    );
  } else if (!existeEnv && principal.classe === "ausente") {
    linhas.push(
      "Banco: não há .env. Peça à pessoa para copiar o .env.example para .env e preencher (o Claude não lê nem escreve o .env; veja o README)."
    );
  } else {
    const sufixoTestes =
      testes.classe === "ausente" ? " (os testes de integração se pulam)" : "";
    linhas.push(
      `Banco: DATABASE_URL ${ROTULO[principal.classe]} · DATABASE_URL_TESTES ${ROTULO[testes.classe]}${sufixoTestes}.`
    );
  }

  const aoVivo =
    (doAmbiente.RUN_LIVE_CREDENTIAL_TESTS ||
      doArquivo.RUN_LIVE_CREDENTIAL_TESTS) === "true";
  if (aoVivo) {
    linhas.push(
      "ATENÇÃO: RUN_LIVE_CREDENTIAL_TESTS=true: pnpm test chama a API real do Gemini e gasta cota."
    );
  }
  return linhas;
}

// "há 5 min", "há 3 h", "há 2 dias".
export function descreverIdade(ms) {
  if (!(ms >= 0)) return "";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} dias`;
}

// Uma linha: onde a pessoa está em relação à main.
export function descreverGit({
  nuvem,
  branch,
  atras,
  afrente,
  sha,
  suja,
  fetchOk,
  idadeDoFetch,
}) {
  if (!branch)
    return `Sessão ${nuvem ? "na nuvem" : "local"} · não consegui ler o git.`;
  const ondeEsta =
    branch === "HEAD" ? "HEAD destacado (sem branch)" : `branch ${branch}`;
  let relacao;
  if (sha == null || atras == null || afrente == null) {
    relacao = "origin/main não encontrado (rode git fetch)";
  } else {
    relacao = `${atras} atrás / ${afrente} à frente de origin/main (${sha})`;
    if (!nuvem)
      relacao += `, desde o último fetch${idadeDoFetch ? ` (${idadeDoFetch})` : ""}`;
    else if (!fetchOk)
      relacao += ", o fetch falhou: números desde o último fetch";
  }
  const arvore =
    suja == null
      ? ""
      : suja
        ? " · árvore com mudanças não commitadas"
        : " · árvore limpa";
  return `Sessão ${nuvem ? "na nuvem" : "local"} · ${ondeEsta} · ${relacao}${arvore}.`;
}

// Instalar quando não há node_modules/.modules.yaml ou quando o pnpm-lock.yaml
// é mais novo que ele (troca de branch com dependência nova).
export function precisaInstalar({ mtimeModulos, mtimeLock }) {
  if (mtimeModulos == null) return true;
  return mtimeLock != null && mtimeLock > mtimeModulos;
}

// Junta as partes no resumo final (no máximo ~8 linhas).
export function montarAviso({
  nuvem,
  git,
  dependencias,
  banco = [],
  carimbo,
  skillsProntas,
}) {
  const linhas = [descreverGit({ nuvem, ...git })];
  if (git && git.branch === "main") {
    linhas.push(
      "ATENÇÃO: você está na main: crie uma branch antes de mudar arquivo (git switch -c feat/...)."
    );
  }
  if (dependencias) linhas.push(dependencias);
  if (!nuvem) linhas.push(...banco);
  if (carimbo) linhas.push(carimbo);
  if (nuvem) linhas.push(LINHA_NUVEM);
  linhas.push(
    skillsProntas
      ? `Para começar: /comecar-tarefa. Antes da PR: /abrir-pr. ${LINHA_FINAL}`
      : `Para começar e antes da PR: siga o "Fluxo de trabalho" do CLAUDE.md. ${LINHA_FINAL}`
  );
  return linhas;
}

// ------------------------------------------------------------- efeitos -----

function git(args, timeout = 5000) {
  try {
    return execFileSync("git", args, {
      cwd: RAIZ,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  } catch {
    return null;
  }
}

function mtime(arquivo) {
  try {
    return statSync(arquivo).mtimeMs;
  } catch {
    return null;
  }
}

function lerEstadoDoGit({ nuvem, fetchOk }) {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const sha = git(["rev-parse", "--short", "origin/main"]);
  let atras = null;
  let afrente = null;
  const contagem = sha
    ? git(["rev-list", "--left-right", "--count", "origin/main...HEAD"])
    : null;
  if (contagem) [atras, afrente] = contagem.split(/\s+/).map(Number);
  const status = git(["--no-optional-locks", "status", "--porcelain"]);
  let idadeDoFetch = "";
  if (!nuvem) {
    const caminho = git(["rev-parse", "--git-path", "FETCH_HEAD"]);
    const quando = caminho ? mtime(path.resolve(RAIZ, caminho)) : null;
    idadeDoFetch = quando
      ? descreverIdade(Date.now() - quando)
      : "nenhum fetch registrado";
  }
  return {
    branch,
    sha,
    atras,
    afrente,
    suja: status == null ? null : status !== "",
    fetchOk,
    idadeDoFetch,
  };
}

function instalarDependencias() {
  const modulos = mtime(path.join(RAIZ, "node_modules", ".modules.yaml"));
  const lock = mtime(path.join(RAIZ, "pnpm-lock.yaml"));
  if (!precisaInstalar({ mtimeModulos: modulos, mtimeLock: lock }))
    return "Dependências: já instaladas.";
  const inicio = Date.now();
  let fd;
  try {
    fd = openSync(LOG_DO_INSTALL, "w");
    const r = spawnSync(
      "pnpm",
      ["install", "--frozen-lockfile", "--prefer-offline"],
      {
        cwd: RAIZ,
        stdio: ["ignore", fd, fd],
        timeout: TETO_DO_INSTALL_MS,
        shell: process.platform === "win32",
      }
    );
    const segundos = Math.round((Date.now() - inicio) / 1000);
    if (r.status === 0)
      return `Dependências: instaladas em ${segundos} s (pnpm install --frozen-lockfile).`;
    const motivo = r.error
      ? r.error.code || r.error.message
      : r.signal
        ? `interrompido (${r.signal})`
        : `código ${r.status}`;
    return `ATENÇÃO: pnpm install falhou (${motivo}, ${segundos} s); veja ${LOG_DO_INSTALL}. Sem node_modules, check, test e build não rodam.`;
  } catch (erro) {
    return `ATENÇÃO: pnpm install não rodou (${erro.message}); veja ${LOG_DO_INSTALL}.`;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Dependências no computador da pessoa: só olha, não instala.
function conferirDependenciasLocais() {
  const modulos = mtime(path.join(RAIZ, "node_modules", ".modules.yaml"));
  const lock = mtime(path.join(RAIZ, "pnpm-lock.yaml"));
  if (!precisaInstalar({ mtimeModulos: modulos, mtimeLock: lock })) return null;
  return modulos == null
    ? "Dependências: não há node_modules; rode pnpm install."
    : "Dependências: o pnpm-lock.yaml mudou depois do último install; rode pnpm install.";
}

// Uma linha do carimbo (.claude/hooks/carimbo.mjs --status).
function lerCarimbo(skillsProntas) {
  const script = path.join(RAIZ, ".claude", "hooks", "carimbo.mjs");
  if (!existsSync(script)) return null;
  const r = spawnSync(process.execPath, [script, "--status"], {
    cwd: RAIZ,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  });
  const primeira = (r.stdout || "").split("\n")[0].trim();
  if (!primeira) return null;
  if (primeira.includes("INVÁLIDO")) {
    const como = skillsProntas ? " (o /comecar-tarefa faz isso)" : "";
    return `${primeira} Commit e push ficam travados até registrar a conferência${como}.`;
  }
  return primeira;
}

function lerBancoLocal() {
  const arquivo = path.join(RAIZ, ".env");
  const existeEnv = existsSync(arquivo);
  let doArquivo = {};
  if (existeEnv) {
    try {
      doArquivo = lerEnv(readFileSync(arquivo, "utf8"));
    } catch {
      doArquivo = {};
    }
  }
  return avisosDoBanco(doArquivo, process.env, existeEnv);
}

// Cada parte em try próprio: uma falha não apaga o resto do resumo.
function tentar(fn, reserva = null) {
  try {
    return fn();
  } catch {
    return reserva;
  }
}

function principal() {
  const nuvem = process.env.CLAUDE_CODE_REMOTE === "true";
  const skillsProntas = ["comecar-tarefa", "abrir-pr"].every(nome =>
    existsSync(path.join(RAIZ, ".claude", "skills", nome, "SKILL.md"))
  );

  let dependencias = null;
  let fetchOk = false;
  if (nuvem) {
    dependencias = tentar(
      instalarDependencias,
      "ATENÇÃO: a instalação das dependências falhou."
    );
    fetchOk =
      git(["fetch", "--quiet", "origin", "main"], TETO_DO_FETCH_MS) !== null;
  } else {
    dependencias = tentar(conferirDependenciasLocais);
  }

  const linhas = montarAviso({
    nuvem,
    git: tentar(() => lerEstadoDoGit({ nuvem, fetchOk }), {}),
    dependencias,
    banco: nuvem ? [] : tentar(lerBancoLocal, []),
    carimbo: tentar(() => lerCarimbo(skillsProntas)),
    skillsProntas,
  });

  if (process.argv.includes("--texto")) {
    process.stdout.write(linhas.join("\n") + "\n");
    return;
  }
  const saida = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: linhas.join("\n"),
    },
  };
  const atencao = linhas.filter(l => l.startsWith("ATENÇÃO"));
  if (atencao.length) saida.systemMessage = atencao.join("\n");
  process.stdout.write(JSON.stringify(saida) + "\n");
}

// Só executa quando chamado direto (node .claude/hooks/inicio-de-sessao.mjs);
// importado pelo teste, só expõe as funções puras.
function rodandoDireto() {
  try {
    if (!process.argv[1]) return false;
    const aqui = realpathSync(fileURLToPath(import.meta.url));
    const chamado = realpathSync(path.resolve(process.argv[1]));
    return process.platform === "win32"
      ? aqui.toLowerCase() === chamado.toLowerCase()
      : aqui === chamado;
  } catch {
    return false;
  }
}

if (rodandoDireto()) {
  try {
    principal();
  } catch (erro) {
    // Nunca derrubar o início da sessão; deixar rastro para quem rodar à mão.
    console.error(`inicio-de-sessao.mjs: ${erro.message}`);
  }
  process.exitCode = 0;
}
