import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useTranslation } from "react-i18next";

export default function NotFound() {
  const [, navigate] = useLocation();
  const [visible, setVisible] = useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    setTimeout(() => setVisible(true), 50);
  }, []);

  return (
    <div className="min-h-screen bg-transparent text-white flex items-center justify-center px-6 overflow-hidden">
      {/* Background particles */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        {[...Array(15)].map((_, i) => (
          <div
            key={i}
            className="absolute rounded-full bg-[#c98f70]"
            style={{
              width: `${Math.random() * 3 + 1}px`,
              height: `${Math.random() * 3 + 1}px`,
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              opacity: Math.random() * 0.25 + 0.05,
              animation: `float ${Math.random() * 8 + 5}s ease-in-out infinite`,
              animationDelay: `${Math.random() * 5}s`,
            }}
          />
        ))}
      </div>

      <div
        className="relative max-w-md w-full text-center"
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? "translateY(0)" : "translateY(24px)",
          transition: "all 0.7s cubic-bezier(0.23,1,0.32,1)",
        }}
      >
        {/* Logo */}
        <Link href="/">
          <span className="inline-block text-2xl font-black tracking-tight mb-10 cursor-pointer text-white">MarquesaMatch</span>
        </Link>

        {/* 404 number */}
        <div className="relative mb-6">
          <div
            className="text-[10rem] font-black leading-none select-none"
            style={{
              background: "linear-gradient(135deg, rgba(201,143,112,0.15) 0%, rgba(201,143,112,0.05) 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            404
          </div>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-6xl">🧭</span>
          </div>
        </div>

        {/* Title */}
        <h1 className="text-2xl font-black mb-3">
          {t("errors.notFoundTitle", "Página não encontrada")}
        </h1>

        {/* Description */}
        <p className="text-white/40 mb-10 leading-relaxed">
          {t("errors.notFoundDesc", "Parece que você saiu do mapa. A página que você está procurando não existe ou foi movida.")}
        </p>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button
            onClick={() => navigate("/")}
            className="group relative bg-[#c98f70] hover:bg-[#b07a5c] text-[#151312] font-black px-7 py-3 rounded-xl text-sm transition-all duration-200 active:scale-95 shadow-xl shadow-[#c98f70]/20 overflow-hidden"
          >
            <span className="relative z-10">← {t("errors.backHome", "Voltar para o início")}</span>
            <div className="absolute inset-0 bg-white/20 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-500 skew-x-12" />
          </button>
          <button
            onClick={() => navigate("/dashboard")}
            className="border border-white/15 hover:border-[#c98f70]/40 text-white/60 hover:text-white px-7 py-3 rounded-xl text-sm transition-all duration-200"
          >
            {t("errors.goToDashboard", "Ir para o Dashboard")}
          </button>
        </div>

        {/* Hint */}
        <p className="text-white/20 text-xs mt-8">
          {t("errors.staleLink", "Se você chegou aqui por um link, pode ser que ele esteja desatualizado.")}
        </p>
      </div>

      <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-10px); }
        }
      `}</style>
    </div>
  );
}
