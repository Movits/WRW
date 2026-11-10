import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import { spawnSync } from "child_process";
import { createServer } from "http";
import helmet from "helmet";
import compression from "compression";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { montarDiretivasCsp } from "./csp";
import { autenticarCron } from "./cron";
import { cleanupExpiredSessions, createAuditLog } from "../security";
import { corpoGrandeParaUploads } from "./corpo-grande-para-uploads";
import { criarDiagnosticoDoIp, criarLimiteDaApi, criarLimiteGeral } from "./limite-de-requisicoes";
import { linhaDosModelosDeIa } from "./modelos-de-ia";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

// ============================================================
// RATE LIMITERS
// ============================================================

// Por conta quando há sessão, pelo IP real quando não há; estáticos e a API
// fora do geral. Valores, chave e formato do 429 em limite-de-requisicoes.ts.
const globalLimiter = criarLimiteGeral();
const apiLimiter = criarLimiteDaApi();

// ============================================================
// MIDDLEWARE DE SEGURANÇA ADICIONAL
// ============================================================

// Remove headers que revelam tecnologia usada
function securityHeadersMiddleware(_req: Request, res: Response, next: NextFunction) {
  res.removeHeader("X-Powered-By");
  // Impede que a página seja carregada em iframes (proteção adicional ao helmet)
  res.setHeader("X-Frame-Options", "DENY");
  // Força HTTPS por 1 ano (HSTS)
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  // Impede MIME sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Controla informações de referrer
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // O microfone é necessário exclusivamente para a gravação privada de reuniões.
  // "self" impede concessão a iframes ou a origens externas; câmera e demais APIs seguem bloqueadas.
  res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=(), payment=()");
  next();
}

// Middleware anti-scan: bloqueia user-agents de scanners conhecidos
function antiScanMiddleware(req: Request, res: Response, next: NextFunction) {
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  const blockedAgents = [
    "sqlmap", "nikto", "nessus", "openvas", "masscan", "zgrab",
    "nmap", "metasploit", "burpsuite", "dirbuster", "gobuster",
    "wfuzz", "hydra", "medusa", "acunetix", "appscan", "w3af",
  ];
  if (blockedAgents.some(agent => ua.includes(agent))) {
    res.status(403).json({ error: "Acesso negado." });
    return;
  }
  next();
}

async function startServer() {
  // Os modelos de IA em uso, já depois da guarda do modelo concreto: um id
  // recusado aparece no log do boot, e não só na primeira chamada à IA. Sem a
  // chave, de propósito.
  console.log(linhaDosModelosDeIa());

  // Migrações no boot, ANTES de aceitar tráfego — só em produção. O deploy do
  // Render publica o código na hora, mas ninguém no time roda migração na mão:
  // a 0003 ficou dias pendente na produção, e a 0004 sem este passo derrubaria
  // toda a leitura de contatos (o drizzle nomeia as colunas nos selects).
  // Processo filho de propósito: migrar.mjs tem modo CLI idempotente com
  // código de saída honesto, e bundlá-lo no dist dispararia o guard de
  // "rodado direto" dele. Falhar aqui mata a subida: o Render mantém a versão
  // antiga no ar e o erro fica no log do deploy — servidor de pé com schema
  // errado é pior do que não subir. A instância é única; se duas correrem, o
  // PK de _migracoes faz a segunda falhar em vez de aplicar duas vezes. O
  // fluxo local de desenvolvimento não muda: pnpm db:migrate continua manual.
  if (process.env.NODE_ENV === "production" && process.env.DATABASE_URL) {
    const migracao = spawnSync(process.execPath, ["scripts/migrar.mjs"], {
      stdio: "inherit",
      env: process.env,
    });
    if (migracao.status !== 0) {
      console.error("[Boot] Migrações pendentes não aplicadas; abortando a subida.");
      process.exit(1);
    }
  }

  const app = express();
  const server = createServer(app);

  // Reuniões presas em "processing". Nenhuma requisição do processo anterior
  // sobreviveu ao restart (todo merge na main é deploy), então o que ficou
  // "Processando" por mais de 15 min não vai terminar nunca: vira 'failed'
  // com o código ERRO_INTERROMPIDO, que a tela traduz. Fica depois de
  // `const app = express()` e das migrações de propósito: o boot em produção
  // só pode tocar o banco com o schema já nivelado. Sem DATABASE_URL (dev sem
  // banco) pula; qualquer erro aqui é log, não aborta a subida — servidor de
  // pé com uma reunião presa é melhor do que servidor fora.
  //
  // Uma passada no boot e outra a cada 5 min: o endpoint de cron
  // (/api/scheduled/mark-interrupted-meetings, abaixo) não tem chamador desde
  // a saída do Manus, e uma reunião derrubada ENTRE deploys (proxy do Render
  // encerrando a requisição, exceção fora do try) ficaria presa até o
  // próximo restart — e a tela deixa excluir, mas a dona não deveria precisar.
  // `unref()`: o timer não segura o processo vivo num shutdown.
  if (process.env.DATABASE_URL) {
    const { marcarReunioesInterrompidas } = await import("../meeting-service");
    const varrerReunioesPresas = async (origem: string) => {
      try {
        const presas = await marcarReunioesInterrompidas();
        if (presas.encontradas) console.warn(`[${origem}] Reuniões interrompidas marcadas como falha: ${presas.marcadas} de ${presas.encontradas}.`);
      } catch (erro) {
        console.error(`[${origem}] Não foi possível varrer as reuniões presas em processamento:`, erro instanceof Error ? erro.message : erro);
      }
    };
    await varrerReunioesPresas("Boot");
    setInterval(() => { void varrerReunioesPresas("Varredura"); }, 5 * 60_000).unref();
  }

  // Confiar no proxy reverso (req.protocol decide o cookie `secure`). No Render
  // `req.ip` sai um proxy interno, não a visitante: o limite por IP usa o
  // CF-Connecting-IP (ver ip-da-cliente.ts). Não mexer sem medir os saltos.
  app.set("trust proxy", 1);

  // V-05: Headers de segurança HTTP via Helmet (CSP rigoroso). As diretivas
  // vivem em csp.ts; o script-src só afrouxa quando o Vite roda em middleware
  // (a mesma condição que escolhe setupVite lá embaixo). Sem NODE_ENV, ou em
  // produção, os arquivos estáticos de dist/public recebem a política estrita.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: montarDiretivasCsp(process.env.NODE_ENV === "development"),
        useDefaults: false,
      },
      crossOriginEmbedderPolicy: false, // Necessário para Vite HMR
      crossOriginOpenerPolicy: { policy: "same-origin" },
      crossOriginResourcePolicy: { policy: "same-origin" },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      },
      noSniff: true,
      xssFilter: true,
      hidePoweredBy: true,
    })
  );

  // Gzip nas respostas. O Render não comprime no proxy: sem isto, os ~900 KB
  // de JS+CSS viajavam crus para cada visitante.
  app.use(compression());

  // Headers de segurança adicionais
  app.use(securityHeadersMiddleware);

  // Anti-scan middleware
  app.use(antiScanMiddleware);

  // Rate limiting global
  app.use(globalLimiter);

  // Rate limiting específico para API tRPC — ANTES dos leitores de corpo: o
  // geral não conta /api/trpc, e um pedido excedente (ou com JSON malformado,
  // que o express.json recusa pelo caminho de erro e pularia qualquer
  // middleware posterior) seria lido inteiro, até 15 MB, antes do 429. A chave
  // só lê cabeçalhos. No Render, antes dele, uma linha de log (só contagens)
  // diz se o CF-Connecting-IP chega (ver ip-da-cliente.ts).
  if (process.env.RENDER === "true") app.use("/api/trpc", criarDiagnosticoDoIp());
  app.use("/api/trpc", apiLimiter);

  // Uploads dentro de um LOTE do tRPC ("/api/trpc/a,b"): os recortes por
  // caminho abaixo não casam com a lista; este middleware reconhece cada
  // procedimento da URL (ver server/_core/corpo-grande-para-uploads.ts).
  app.use(corpoGrandeParaUploads);

  // A gravação de reunião usa Base64 (até 10 MB de áudio, ~14 MB no JSON).
  // O limite ampliado é aplicado somente ao procedimento privado de reunião.
  app.use("/api/trpc/meetings.submitRecording", express.json({ limit: "15mb" }));

  // Mesmo caso para os anexos de contexto (fotos/PDF de até 10 MB em Base64):
  // sem este recorte, o limite global de 5 MB devolveria 413 para qualquer
  // arquivo acima de ~3,7 MB — antes de o tRPC sequer validar.
  app.use("/api/trpc/contexts.uploadMedia", express.json({ limit: "15mb" }));

  // Mesmo caso para foto e cartão de visita do contato (etapa 1, até 10 MB em
  // Base64 — MAX_CONTACT_IMAGE_BYTES em contact-media.ts): sem este recorte,
  // o limite global de 5 MB barrava qualquer arquivo acima de ~3,7 MB antes
  // de o tRPC sequer validar (quadro Notion, prazo 05/09).
  app.use("/api/trpc/network.uploadPhoto", express.json({ limit: "15mb" }));
  app.use("/api/trpc/network.uploadCard", express.json({ limit: "15mb" }));

  // Mesmo caso para o documento confidencial da Deal Room e o documento de
  // verificação do SIVC (até 10 MB em Base64 — MAX_DOCUMENTO_BYTES em
  // documento-base64.ts): eram os dois últimos uploads presos no limite
  // global de 5 MB (quadro Notion, prazo 08/09).
  app.use("/api/trpc/dealRoom.uploadDocument", express.json({ limit: "15mb" }));
  app.use("/api/trpc/sivc.uploadDocument", express.json({ limit: "15mb" }));

  // V-09: Limite reduzido para 5MB no restante da aplicação.
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ limit: "5mb", extended: true }));

  registerStorageProxy(app);

  // ============================================================
  // JOB PERIÓDICO: Limpeza de sessões expiradas
  // Endpoint: POST /api/scheduled/cleanup-sessions
  // Exige sessão de cron: JWT assinado com o JWT_SECRET, openId "cron_..."
  // e claim taskUid (ver autenticarCron e sdk.authenticateRequest). Nenhum
  // agendador externo está configurado hoje; o endpoint fica pronto para
  // quando houver.
  // ============================================================
  app.post("/api/scheduled/cleanup-sessions", async (req: Request, res: Response) => {
    const user = await autenticarCron(req, res);
    if (!user) return;
    try {
      const cleaned = await cleanupExpiredSessions();

      await createAuditLog({
        userId: null,
        action: "CRON_CLEANUP_SESSIONS",
        resource: "sessions",
        status: "success",
        riskLevel: "low",
        details: {
          cleanedCount: cleaned,
          taskUid: user.taskUid,
          triggeredAt: new Date().toISOString(),
        },
      }).catch(() => {});

      return res.json({ ok: true, cleaned, timestamp: new Date().toISOString() });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return res.status(500).json({
        error,
        context: { url: req.url },
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ============================================================
  // JOB PERIÓDICO: gravações de reunião que passaram dos 30 dias
  // Endpoint: POST /api/scheduled/cleanup-recordings
  // Mesma sessão de cron da limpeza de sessões.
  //
  // Existe porque a tela promete que o áudio "expira automaticamente após 30
  // dias" e essa promessa é sobre a voz de TODAS as participantes — que não
  // têm login e nunca vão abrir a página. Sem esta varredura, o descarte só
  // aconteceria quando a dona reabrisse a reunião, e o caso comum (nunca mais
  // voltar lá) deixaria o áudio no bucket para sempre.
  // ============================================================
  app.post("/api/scheduled/cleanup-recordings", async (req: Request, res: Response) => {
    const user = await autenticarCron(req, res);
    if (!user) return;
    try {
      const { limparGravacoesVencidas } = await import("../meeting-service");
      const resultado = await limparGravacoesVencidas();

      await createAuditLog({
        userId: null,
        action: "CRON_CLEANUP_RECORDINGS",
        resource: "meeting_recordings",
        status: "success",
        riskLevel: "low",
        details: { ...resultado, taskUid: user.taskUid, triggeredAt: new Date().toISOString() },
      }).catch(() => {});

      return res.json({ ok: true, ...resultado, timestamp: new Date().toISOString() });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return res.status(500).json({
        error,
        context: { url: req.url },
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ============================================================
  // JOB PERIÓDICO: reuniões presas em "processing"
  // Endpoint: POST /api/scheduled/mark-interrupted-meetings
  // Mesma sessão de cron das limpezas acima.
  //
  // O boot e o setInterval lá em cima já fazem esta varredura; o endpoint
  // fica ao lado das outras duas rotas de cron para o dia em que houver um
  // agendador externo (hoje nenhuma delas tem chamador).
  // ============================================================
  app.post("/api/scheduled/mark-interrupted-meetings", async (req: Request, res: Response) => {
    const user = await autenticarCron(req, res);
    if (!user) return;
    try {
      const { marcarReunioesInterrompidas } = await import("../meeting-service");
      const resultado = await marcarReunioesInterrompidas();

      await createAuditLog({
        userId: null,
        action: "CRON_MARK_INTERRUPTED_MEETINGS",
        resource: "meetings",
        status: "success",
        riskLevel: "low",
        details: { ...resultado, taskUid: user.taskUid, triggeredAt: new Date().toISOString() },
      }).catch(() => {});

      return res.json({ ok: true, ...resultado, timestamp: new Date().toISOString() });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return res.status(500).json({
        error,
        context: { url: req.url },
        timestamp: new Date().toISOString(),
      });
    }
  });

  // tRPC API (o limite dela está montado lá em cima, antes dos leitores de corpo)
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");

  // Em produção a porta é imposta pela plataforma (Railway, Render, Fly) e o
  // roteador só entrega tráfego nela. Cair para outra porta faria o container
  // subir "com sucesso" e não responder nada, então aqui falhar é melhor.
  const port =
    process.env.NODE_ENV === "production"
      ? preferredPort
      : await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
