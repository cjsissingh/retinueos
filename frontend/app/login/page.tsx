"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { safeLoginRedirect, setStoredPassword } from "@/lib/auth";
import { AuthFrame } from "@/components/auth-frame";

function LoginForm() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080";
      const res = await fetch(`${backendUrl}/personas`, { headers: { "X-Auth-Password": password } });
      if (!res.ok) {
        setError("That's not the password.");
        return;
      }
      setStoredPassword(password);
      router.push(safeLoginRedirect(searchParams.get("next")));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthFrame title="Welcome back" description="Your staff are waiting.">
      <form onSubmit={handleSubmit}>
        <label htmlFor="password" className="mb-2 block font-sans text-sm font-medium text-fg">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          className="mb-3 min-h-11 w-full rounded-button border border-border-strong bg-surface px-4 font-mono text-[15px] text-fg outline-none"
        />
        <button
          type="submit"
          disabled={submitting || !password}
          className="min-h-11 w-full rounded-button border-0 bg-accent px-4 font-sans text-sm font-medium text-accent-fg disabled:opacity-60"
        >
          {submitting ? "Checking…" : "Let me in"}
        </button>
        {error && (
          <p role="alert" className="m-0 mt-4 font-sans text-[13px] text-danger">
            {error}
          </p>
        )}
      </form>
    </AuthFrame>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-bg" />}>
      <LoginForm />
    </Suspense>
  );
}
