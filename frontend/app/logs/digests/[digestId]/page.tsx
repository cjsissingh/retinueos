"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { DigestDetailView } from "@/components/digest-detail-view";
import { ApiClient, ApiError, type Digest, type Persona } from "@/lib/api-client";
import { getStoredPassword, handleUnauthorized } from "@/lib/auth";
import { PAGE_PAD } from "@/lib/touch-layout";

type LoadState = "loading" | "ready" | "error" | "not_found";

export default function DigestDetailPage() {
  const params = useParams<{ digestId: string }>();
  const router = useRouter();
  const [client] = useState(
    () => new ApiClient(process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080", getStoredPassword),
  );
  const [digest, setDigest] = useState<Digest | null>(null);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [state, setState] = useState<LoadState>("loading");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const row = await client.getDigest(params.digestId);
      const people = await client.listPersonas();
      setDigest(row);
      setPersona(people.find((p) => p.id === row.personaId) ?? null);
      setState("ready");
    } catch (err) {
      if (handleUnauthorized(err, router)) return;
      if (err instanceof ApiError && err.status === 404) {
        setState("not_found");
        return;
      }
      setState("error");
    }
  }, [client, params.digestId, router]);

  useEffect(() => {
    if (!getStoredPassword()) {
      router.push("/login");
      return;
    }
    load();
  }, [load, router]);

  if (state === "loading") {
    return (
      <main className={PAGE_PAD}>
        <p className="font-sans text-sm text-fg-muted">Loading…</p>
      </main>
    );
  }

  if (state === "not_found") {
    return (
      <main className={PAGE_PAD}>
        <EmptyState
          title="No such digest"
          description="It may have been an ID typo, or it's older than this install."
        />
      </main>
    );
  }

  if (state === "error" || !digest) {
    return (
      <main className={PAGE_PAD}>
        <ErrorState detail="GET /digests/:id failed. Nothing has been lost." onRetry={load} />
      </main>
    );
  }

  return <DigestDetailView digest={digest} persona={persona} />;
}
