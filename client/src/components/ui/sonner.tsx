import { useTranslation } from "react-i18next";
import { Toaster as Sonner, type ToasterProps } from "sonner";

// Tema fixo: o app é single-theme light (ThemeContext próprio, switchable=false).
// A versão anterior lia useTheme() do next-themes, cujo provider nunca é montado —
// o sonner caía em "system" e, com o SO em dark, pintava a descrição do toast
// quase branca sobre o popover branco do tema light.
const Toaster = ({ toastOptions, ...props }: ToasterProps) => {
  const { t } = useTranslation();
  return (
    <Sonner
      theme="light"
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      // O X dos avisos que só fecham na mão (o "parou sozinha" e o das 12 h da
      // gravação, G13a) é anunciado no idioma de quem lê; o padrão do sonner é
      // "Close toast", em inglês, em todos os idiomas.
      toastOptions={{ closeButtonAriaLabel: t("dashboard.close"), ...toastOptions }}
      {...props}
    />
  );
};

export { Toaster };
