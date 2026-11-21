// O Worker do leitor de PDF da tela (pdf.js, H12b; ver lib/leitor-de-pdf.ts).
// Importar o módulo do worker do pdf.js dentro de um Worker o liga sozinho: ele
// passa a responder às mensagens da página. É um Worker em módulo, carregado da
// mesma origem (a CSP não aceita blob:), e o Vite o empacota em arquivo próprio.
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
