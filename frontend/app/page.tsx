"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getStoredPassword } from "@/lib/auth";

// / becomes the entry ramp, not a screen of its own -- /today when
// signed in, /login otherwise. The password lives in localStorage
// (lib/auth.ts), so this has to be a client check, not a server redirect.
// AppShell's `signedOut` list still treats "/" as chromeless (app-shell.tsx)
// so this bounce never flashes the sidebar.
export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace(getStoredPassword() ? "/today" : "/login");
  }, [router]);

  return null;
}
