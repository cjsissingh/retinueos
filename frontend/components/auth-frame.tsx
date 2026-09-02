import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";

export function AuthFrame({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-6 py-12 text-fg">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex items-center gap-3 text-accent">
          <BrandMark size={36} title="RetinueOS mark" />
          <span className="font-serif text-2xl text-fg">RetinueOS</span>
        </div>
        <h1 className="m-0 font-serif text-[36px] leading-[1.05] text-fg">{title}</h1>
        <p className="m-0 mt-3 font-sans text-sm leading-relaxed text-fg-muted">{description}</p>
        <div className="mt-7">{children}</div>
      </div>
    </main>
  );
}
